// Read-only Git helpers for Visual Review: repository discovery, commit log,
// contiguous selection resolution, numstat + hunk parsing, and per-file diffs.
import { exec, readTextFile } from "herdr";

export const READ = ["--no-optional-locks", "-c", "core.quotepath=false"];
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAIN_CANDIDATES = ["main", "master"];
const DIFF_BYTE_LIMIT = 4 * 1024 * 1024;

export const normPath = (p) => String(p || "").replace(/\\/g, "/").replace(/^\.\//, "");

export async function git(root, on, args, timeout = 30000) {
  return exec("git", [...READ, ...args], { cwd: root, on, timeout });
}

export async function resolveRepo(cwd, on) {
  const [top, head, branch, origin] = await Promise.all([
    git(cwd, on, ["rev-parse", "--show-toplevel"]),
    git(cwd, on, ["rev-parse", "--verify", "-q", "HEAD"]),
    git(cwd, on, ["symbolic-ref", "-q", "--short", "HEAD"]),
    git(cwd, on, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
  ]);
  if (top.code !== 0) return null;
  const root = top.stdout.trim();
  const candidates = origin.code === 0
    ? [origin.stdout.trim(), ...MAIN_CANDIDATES]
    : [...MAIN_CANDIDATES];
  let mainBranch = null;
  for (const c of candidates) {
    if (!c) continue;
    const ok = await git(root, on, ["rev-parse", "--verify", "-q", `${c}^{commit}`]);
    if (ok.code === 0) { mainBranch = c; break; }
  }
  return {
    root,
    on: on ?? null,
    head: head.code === 0 ? head.stdout.trim() : null,
    branch: branch.code === 0 ? branch.stdout.trim() : (head.code === 0 ? head.stdout.trim().slice(0, 7) : "HEAD"),
    mainBranch,
  };
}

export async function readCommits(root, on, { limit = 120, search = "" } = {}) {
  const fmt = "%H%x1f%h%x1f%P%x1f%at%x1f%an%x1f%D%x1f%s";
  const args = ["log", `--max-count=${limit}`, `--format=${fmt}`];
  const q = search.trim();
  if (q) args.push(`--grep=${q}`, "-i");
  const [log, status] = await Promise.all([
    git(root, on, args),
    git(root, on, ["status", "--porcelain=v1", "-uall"]),
  ]);
  const commits = [];
  if (log.code === 0 && log.stdout) {
    for (const line of log.stdout.split("\n")) {
      if (!line) continue;
      const [hash, short, parents, ts, author, refs, ...subj] = line.split("\x1f");
      if (!hash) continue;
      commits.push({
        hash,
        short: short || hash.slice(0, 7),
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        date: Number(ts) || 0,
        author: author || "",
        refs: refs ? refs.split(",").map((r) => r.trim()).filter(Boolean) : [],
        subject: subj.join("\x1f"),
      });
    }
  }
  const uncommittedLines = status.code === 0 ? status.stdout.split("\n").filter(Boolean) : [];
  return { commits, uncommittedCount: uncommittedLines.length };
}

/**
 * Resolves a CommitSelection into concrete git diff endpoints:
 * { mode, base, head, includeWorktree, label }
 */
export async function resolveSelection(repo, selection) {
  const { root, on } = repo;
  const mode = selection?.mode ?? "branch-base";

  if (mode === "uncommitted") {
    const base = repo.head || EMPTY_TREE;
    return { mode, base, head: null, includeWorktree: true, label: "Uncommitted changes" };
  }

  if (mode === "branch-base") {
    let base = null;
    let baseLabel = repo.mainBranch || "HEAD~1";
    if (repo.mainBranch && repo.head) {
      const mb = await git(root, on, ["merge-base", "HEAD", repo.mainBranch]);
      if (mb.code === 0 && mb.stdout.trim()) base = mb.stdout.trim();
    }
    if (!base && repo.head) {
      const p = await git(root, on, ["rev-parse", "--verify", "-q", "HEAD~1^{commit}"]);
      base = p.code === 0 ? p.stdout.trim() : EMPTY_TREE;
      baseLabel = p.code === 0 ? "HEAD~1" : "empty";
    }
    return {
      mode,
      base: base || EMPTY_TREE,
      head: null,
      includeWorktree: true,
      label: `${baseLabel}..${repo.branch}`,
    };
  }

  if (mode === "single" && selection.head) {
    const p = await git(root, on, ["rev-parse", "--verify", "-q", `${selection.head}^1^{commit}`]);
    const base = p.code === 0 ? p.stdout.trim() : EMPTY_TREE;
    return {
      mode,
      base,
      head: selection.head,
      includeWorktree: false,
      label: selection.label || selection.head.slice(0, 7),
    };
  }

  if (mode === "range" && selection.from && selection.to) {
    const p = await git(root, on, ["rev-parse", "--verify", "-q", `${selection.from}^1^{commit}`]);
    const base = p.code === 0 ? p.stdout.trim() : EMPTY_TREE;
    return {
      mode,
      base,
      head: selection.to,
      includeWorktree: false,
      label: selection.label || `${selection.from.slice(0, 7)}..${selection.to.slice(0, 7)}`,
    };
  }

  // Fallback to branch-base
  return resolveSelection(repo, { mode: "branch-base" });
}

const NUMSTAT_RE = /^(\d+|-)\t(\d+|-)\t(.*)$/s;

export function parseNumstat(stdout) {
  const fields = stdout.split("\0");
  const files = [];
  for (let i = 0; i < fields.length; i++) {
    const m = NUMSTAT_RE.exec(fields[i] ?? "");
    if (!m) continue;
    const added = m[1] === "-" ? null : Number(m[1]);
    const removed = m[2] === "-" ? null : Number(m[2]);
    const path = m[3];
    if (path) {
      files.push({ path: normPath(path), added, removed, isUntracked: false, status: "M" });
    } else {
      const oldPath = normPath(fields[i + 1] ?? "");
      const newPath = normPath(fields[i + 2] ?? "");
      i += 2;
      if (newPath) files.push({ path: newPath, oldPath, added, removed, isUntracked: false, status: "R" });
    }
  }
  return files;
}

export function parseNameStatus(stdout) {
  const map = new Map();
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i];
    if (!code) continue;
    const kind = code[0];
    if (kind === "R" || kind === "C") {
      const oldPath = normPath(fields[i + 1] ?? "");
      const newPath = normPath(fields[i + 2] ?? "");
      i += 2;
      if (newPath) map.set(newPath, { status: kind, oldPath });
    } else {
      const path = normPath(fields[i + 1] ?? "");
      i += 1;
      if (path) map.set(path, { status: kind });
    }
  }
  return map;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunks(stdout) {
  const map = new Map();
  let current = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      continue;
    }
    if (line.startsWith("+++ b/")) {
      current = normPath(line.slice(6));
      if (!map.has(current)) map.set(current, []);
      continue;
    }
    if (line.startsWith("+++ /dev/null") && !current) {
      continue;
    }
    if (line.startsWith("--- a/") && !current) {
      const candidate = normPath(line.slice(6));
      // Keep as fallback for deleted files (when +++ is /dev/null)
      current = candidate;
      if (!map.has(current)) map.set(current, []);
      continue;
    }
    if (line.startsWith("@@ ") && current) {
      const m = HUNK_RE.exec(line);
      if (m) {
        map.get(current).push({
          oldStart: Number(m[1]),
          oldCount: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newCount: m[4] === undefined ? 1 : Number(m[4]),
        });
      }
    }
  }
  return map;
}

export async function collectDiff(repo, resolved) {
  const { root, on } = repo;
  const rangeArgs = resolved.includeWorktree
    ? [resolved.base]
    : [resolved.base, resolved.head];

  const [numstat, nameStatus, diffU0, untracked] = await Promise.all([
    git(root, on, ["diff", "--numstat", "-z", "-M", ...rangeArgs]),
    git(root, on, ["diff", "--name-status", "-z", "-M", ...rangeArgs]),
    git(root, on, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "-M", ...rangeArgs], 60000),
    resolved.includeWorktree
      ? git(root, on, ["ls-files", "--others", "--exclude-standard", "-z"])
      : Promise.resolve({ code: 0, stdout: "" }),
  ]);

  if (numstat.code !== 0) {
    throw new Error(numstat.stderr?.trim() || "git diff failed");
  }

  const files = parseNumstat(numstat.stdout);
  const statuses = nameStatus.code === 0 ? parseNameStatus(nameStatus.stdout) : new Map();
  for (const f of files) {
    const info = statuses.get(f.path);
    if (info) {
      f.status = info.status;
      if (info.oldPath) f.oldPath = info.oldPath;
    }
  }

  const rawDiffCut = (diffU0.stdout?.length ?? 0) > DIFF_BYTE_LIMIT;
  const hunksByFile = diffU0.code === 0 && !rawDiffCut ? parseHunks(diffU0.stdout) : new Map();

  // Add untracked files when inspecting worktree
  if (resolved.includeWorktree && untracked.code === 0 && untracked.stdout) {
    const existing = new Set(files.map((f) => f.path));
    const paths = untracked.stdout.split("\0").map(normPath).filter((p) => p && !existing.has(p));
    for (const p of paths) {
      files.push({ path: p, added: null, removed: 0, isUntracked: true, status: "A" });
    }
  }

  return { files, hunksByFile, rawDiffCut };
}

export async function readFileContent(repo, ref, relPath) {
  const { root, on } = repo;
  if (!ref) {
    try {
      const full = `${root.replace(/\\/g, "/")}/${relPath}`;
      return await readTextFile(full, { on });
    } catch {
      return null;
    }
  }
  const r = await git(root, on, ["show", `${ref}:${relPath}`]);
  return r.code === 0 ? r.stdout : null;
}

export async function readFileDiff(repo, resolved, relPath, oldPath = null) {
  const { root, on } = repo;
  const rangeArgs = resolved.includeWorktree
    ? [resolved.base]
    : [resolved.base, resolved.head];
  const paths = oldPath && oldPath !== relPath ? [oldPath, relPath] : [relPath];
  const r = await git(root, on, ["diff", "-U3", "--no-color", "--no-ext-diff", "--no-textconv", "-M", ...rangeArgs, "--", ...paths]);
  if (r.code === 0 && r.stdout.trim()) return r.stdout;

  // Fallback for untracked files: show content as all-added unified diff
  if (resolved.includeWorktree) {
    const text = await readFileContent(repo, null, relPath);
    if (text != null) {
      const lines = text.split(/\r?\n/);
      const header = `--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n`;
      return header + lines.map((l) => `+${l}`).join("\n");
    }
  }
  return "";
}
