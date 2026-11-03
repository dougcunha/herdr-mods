// Git side of the Git Dash mod: finds repositories under a folder and reads
// their pending work. Port of git-pendencias.py.
import { exec, home } from "herdr";

// A mod may read files only inside the Herdr home, so the folder search runs
// as a program (`exec`): PowerShell on Windows, `find` and `sh` elsewhere.

// Folders that are never opened during the search: big, and they hold no repositories.
const SKIP = [
  "node_modules", ".venv", "venv", "__pycache__", "bin", "obj", "dist", "build",
  "target", "packages", ".idea", ".vs", ".vscode", ".gradle", ".next", ".cache",
];

// A file in the Git folder that proves an operation is running.
const OPERATIONS = {
  MERGE_HEAD: "merge",
  "rebase-merge": "rebase",
  "rebase-apply": "rebase",
  CHERRY_PICK_HEAD: "cherry-pick",
  REVERT_HEAD: "revert",
  BISECT_LOG: "bisect",
};

export const MAX_REPOS = 400;

const isWin = () => /^[A-Za-z]:[\\/]/.test(home());
const slash = (p) => p.replace(/\\/g, "/");

const PS_SCAN = (root, depth) => `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = '${root.replace(/'/g, "''")}'
$depth = ${depth}
$max = ${MAX_REPOS}
$skip = @{}
foreach ($n in '${SKIP.join("','")}') { $skip[$n] = $true }
$marks = '${Object.keys(OPERATIONS).join("','")}'.Split(',')
if (-not [IO.Directory]::Exists($root)) { [Console]::Error.WriteLine("Folder not found: $root"); exit 2 }
$stack = New-Object System.Collections.Stack
$stack.Push(@([IO.Path]::GetFullPath($root), 0))
$count = 0
while ($stack.Count -gt 0 -and $count -lt $max) {
  $item = $stack.Pop(); $dir = $item[0]; $level = $item[1]
  $subs = @(); $git = $null
  try {
    foreach ($e in ([IO.DirectoryInfo]$dir).EnumerateFileSystemInfos()) {
      if ($e.Name -eq '.git') { $git = $e; continue }
      if ($level -lt $depth -and $e -is [IO.DirectoryInfo] -and -not $skip.ContainsKey($e.Name) -and -not ($e.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $subs += $e.FullName }
    }
  } catch { if ($level -eq 0) { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }; continue }
  if ($git) {
    $gitdir = $null
    if ($git -is [IO.DirectoryInfo]) { $gitdir = $git.FullName }
    else {
      try {
        $line = ([IO.File]::ReadAllText($git.FullName)).Trim()
        if ($line.StartsWith('gitdir:')) { $gitdir = [IO.Path]::GetFullPath([IO.Path]::Combine($dir, $line.Substring(7).Trim())) }
      } catch {}
    }
    $found = @()
    if ($gitdir) { foreach ($m in $marks) { if (Test-Path -LiteralPath (Join-Path $gitdir $m)) { $found += $m } } }
    [Console]::Out.WriteLine($dir + "\`t" + ($found -join ','))
    $count++
  }
  $next = $level + 1
  foreach ($s in $subs) { $stack.Push(@($s, $next)) }
}
`;

const SH_SCAN = `
prune=""
for n in ${SKIP.join(" ")}; do prune="$prune -o -name $n"; done
find "$1" -maxdepth "$2" \\( -false $prune \\) -prune -o -name .git -prune -print 2>/dev/null | head -n ${MAX_REPOS} | while IFS= read -r g; do
  d=$(dirname "$g"); o=""
  if [ -d "$g" ]; then for f in ${Object.keys(OPERATIONS).join(" ")}; do [ -e "$g/$f" ] && o="$o,$f"; done; fi
  printf '%s\\t%s\\n' "$d" "\${o#,}"
done
`;

/** Runs `fn` over `items` with at most `limit` calls at once. */
export async function mapLimit(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/**
 * The folders under `root` (down to `depth` levels) that hold a `.git` folder or file,
 * each with the Git operations it is in the middle of. Rejects when the root is unreadable.
 */
export async function findRepos(root, depth) {
  const r = isWin()
    ? await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", PS_SCAN(root, depth)])
    : await exec("sh", ["-c", SH_SCAN, "sh", root, String(depth + 1)]);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || `Could not read ${root}`);
  const repos = [];
  for (const line of r.stdout.split("\n")) {
    const [path, marks = ""] = line.replace(/\r$/, "").split("\t");
    if (!path) continue;
    const ops = [...new Set(marks.split(",").filter(Boolean).map((m) => OPERATIONS[m]))];
    repos.push({ path, operations: ops });
  }
  return repos.sort((a, b) => a.path.localeCompare(b.path));
}

/** The text after the first `n` spaces of `line` (a path can hold spaces). */
function after(line, n) {
  let at = -1;
  for (let i = 0; i < n; i++) {
    at = line.indexOf(" ", at + 1);
    if (at < 0) return "";
  }
  return line.slice(at + 1);
}

const git = (cwd, args) =>
  exec("git", ["--no-optional-locks", "-c", "core.quotepath=false", ...args], { cwd });

/**
 * Reads one repository. Never rejects: a failure goes in `error`.
 * Counts follow git-pendencias.py: `unpushed` are commits in no remote.
 */
export async function analyze({ path: repo, operations }, root, { fetch = false } = {}) {
  const rel = slash(repo.slice(root.replace(/[\\/]+$/, "").length)).replace(/^\//, "");
  const r = {
    path: repo,
    name: rel || repo.split(/[\\/]/).pop(),
    branch: "", upstream: "", ahead: 0, behind: 0, hasAb: false, remotes: [],
    unpushed: 0, byBranch: {}, stash: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0,
    operations: [...operations], notes: [], files: [], error: null,
  };
  try {
    if (fetch) {
      const f = await git(repo, ["fetch", "--all", "--prune", "--quiet"]).catch(() => null);
      if (!f || f.code !== 0) r.notes.push({ id: "fetchFailed" });
    }

    const st = await git(repo, [
      "status", "--porcelain=v2", "--branch", "--show-stash",
      "--ignore-submodules=dirty", "--untracked-files=normal",
    ]);
    if (st.code !== 0) {
      r.error = st.stderr.trim().split("\n").pop() || `git status exited with code ${st.code}`;
      return r;
    }

    let initial = false, hasAb = false;
    for (const line of st.stdout.split("\n")) {
      if (!line) continue;
      if (line.startsWith("# ")) {
        const p = line.split(" ");
        switch (p[1]) {
          case "branch.oid": initial = p[2] === "(initial)"; break;
          case "branch.head": r.branch = p[2]; break;
          case "branch.upstream": r.upstream = p[2]; break;
          case "branch.ab":
            hasAb = true;
            r.ahead = parseInt(p[2], 10) || 0;
            r.behind = Math.abs(parseInt(p[3], 10)) || 0;
            break;
          case "stash": r.stash = parseInt(p[2], 10) || 0; break;
        }
        continue;
      }
      const kind = line[0];
      if (kind === "1" || kind === "2") {
        const xy = line.slice(2, 4);
        if (xy[0] !== ".") r.staged += 1;
        if (xy[1] !== ".") r.modified += 1;
        let path = after(line, kind === "1" ? 8 : 9);
        if (kind === "2") path = path.split("\t")[0];
        r.files.push({ state: xy.replace(/\./g, " "), path });
      } else if (kind === "u") {
        r.conflicts += 1;
        r.files.push({ state: "UU", path: after(line, 10) });
      } else if (kind === "?") {
        r.untracked += 1;
        r.files.push({ state: "??", path: line.slice(2) });
      }
    }

    const detached = r.branch === "(detached)";
    if (detached) r.branch = "(detached HEAD)";
    const onBranch = !r.branch.startsWith("(");

    // A repository with a tracking branch has a remote. Otherwise ask Git.
    let remote = Boolean(r.upstream);
    if (!remote) {
      const rm = await git(repo, ["remote"]);
      if (rm.code === 0) r.remotes = rm.stdout.split(/\s+/).filter(Boolean);
      remote = rm.code === 0 ? r.remotes.length > 0 : true;
    }
    r.hasAb = hasAb;

    if (!remote) {
      r.notes.push({ id: "noRemote" });
    } else if (!initial) {
      // Commits of every local branch (and HEAD) that no remote branch has, by branch.
      const lg = await git(repo, ["log", "--branches", "HEAD", "--not", "--remotes", "--source", "--format=%S"]);
      if (lg.code === 0) {
        for (const ref of lg.stdout.split(/\s+/).filter(Boolean)) {
          let name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
          if (name === "HEAD" && onBranch) name = r.branch;
          r.byBranch[name] = (r.byBranch[name] || 0) + 1;
        }
        r.unpushed = Object.values(r.byBranch).reduce((a, b) => a + b, 0);
      } else {
        r.notes.push({ id: "logFailed" });
      }
    }

    if (r.upstream && !hasAb && onBranch) r.notes.push({ id: "upstreamGone" });
    else if (remote && !r.upstream && onBranch && r.byBranch[r.branch]) r.notes.push({ id: "noUpstream" });
    if (!onBranch && r.byBranch.HEAD) r.notes.push({ id: "detachedCommits", n: r.byBranch.HEAD });
    if (r.ahead > (r.byBranch[r.branch] || 0)) r.notes.push({ id: "aheadOfUpstream", n: r.ahead });
    const others = Object.entries(r.byBranch).filter(([k]) => k !== r.branch && k !== "HEAD").sort((a, b) => b[1] - a[1]);
    if (others.length) r.notes.push({ id: "otherBranches", text: others.map(([k, v]) => `${k} (${v})`).join(", ") });
  } catch (e) {
    r.error = String(e?.message || e);
  }
  return r;
}

/** True when the repository has something to do. */
export function pending(r) {
  return Boolean(
    r.unpushed || r.stash || r.staged || r.modified || r.untracked || r.conflicts || r.operations.length
    || r.notes.some((n) => n.id === "noRemote" || n.id === "aheadOfUpstream"),
  );
}

/**
 * What the panel can do for a repository.
 * `auto`: safe fixes the panel runs after a confirmation. Each has `id` and,
 * except `commit` (its steps need a message), the Git `steps` to run.
 * `manual`: problems that need a person; the panel only opens a terminal.
 * A fix is safe when Git refuses on its own instead of losing work:
 * `push` only when the branch is not behind, `pull` only as `--ff-only`.
 */
export function fixes(r) {
  const auto = [], manual = [];
  if (r.error) return { auto, manual: ["error"] };
  if (r.conflicts) manual.push("conflicts");
  if (r.operations.length) manual.push("operation");
  const onBranch = Boolean(r.branch) && !r.branch.startsWith("(");
  if (!onBranch) manual.push("detached");
  if (!manual.length) {
    if (r.staged || r.modified || r.untracked) auto.push({ id: "commit" });
    if (r.upstream && r.hasAb) {
      if (r.ahead && r.behind) manual.push("diverged");
      else if (r.ahead) auto.push({ id: "push", steps: [["push"]] });
      else if (r.behind) auto.push({ id: "pull", steps: [["pull", "--ff-only"]] });
    } else if (r.upstream) {
      manual.push("upstreamGone");
    } else if (r.byBranch[r.branch]) {
      const remote = r.remotes.includes("origin") ? "origin" : r.remotes.length === 1 ? r.remotes[0] : "";
      if (remote) auto.push({ id: "publish", remote, steps: [["push", "-u", remote, r.branch]] });
      else manual.push("manyRemotes");
    }
  }
  if (r.notes.some((n) => n.id === "noRemote")) manual.push("noRemote");
  if (r.stash) manual.push("stash");
  if (r.notes.some((n) => n.id === "otherBranches")) manual.push("otherBranches");
  return { auto, manual };
}

/** The Git steps of a commit. `mode`: "staged", "tracked" (git add -u) or "all" (git add -A). */
export function commitSteps(mode, message) {
  const add = mode === "all" ? [["add", "-A"]] : mode === "tracked" ? [["add", "-u"]] : [];
  return [...add, ["commit", "-m", message]];
}

/** The command line of one step, for the confirmation text. */
export const show = (step) => ["git", ...step.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a))].join(" ");

/**
 * Runs `steps` in `repo`, one after the other, and stops at the first failure.
 * Never rejects. `failed` is the step that failed, so it can run again in a terminal.
 * `exec` gives Git no input and stops it after 30 s: a password prompt fails here.
 */
export async function runSteps(repo, steps) {
  let out = "";
  for (const step of steps) {
    const res = await exec("git", ["-c", "core.quotepath=false", ...step], { cwd: repo })
      .catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message || e) }));
    out = `${res.stdout}\n${res.stderr}`.trim();
    if (res.code !== 0) return { ok: false, out: out || `${show(step)}: exit ${res.code}`, failed: step };
  }
  return { ok: true, out };
}

/** Higher is more urgent. */
export function severity(r) {
  if (r.conflicts || r.operations.length) return 5;
  if (r.unpushed) return 4;
  if (r.staged || r.modified) return 3;
  if (r.untracked) return 2;
  if (r.stash) return 1;
  return 0;
}
