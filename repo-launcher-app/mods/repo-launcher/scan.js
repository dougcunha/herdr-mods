// Finds Git repositories under the root folders, and the accounts of the
// agents that support more than one (Claude Code and Codex).
//
// A mod can list folders only inside the home folder (fs/promises), so the
// repository search runs as a program: PowerShell on Windows, `find` on
// macOS and Linux.

import { exec, home, readTextFile, window } from "herdr";
import * as fs from "fs/promises";

/** How many folder levels under a root the search opens. */
export const DEPTH = 3;
/** The search stops after this many repositories in one root. */
export const MAX_REPOS = 2000;

// Folders that the search never opens: big, and they hold no repositories.
const SKIP = [
  "node_modules", ".venv", "venv", "__pycache__", "bin", "obj", "dist", "build",
  "target", "packages", ".idea", ".vs", ".vscode", ".gradle", ".next", ".cache",
  ".git", "vendor", "Pods", "DerivedData",
];

export const isWindows = () => window()?.platform === "windows";

/** A path with forward slashes and no slash at the end. */
export function normalize(path) {
  return String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

/** The key that compares two paths: case-insensitive on Windows and macOS. */
export function pathKey(path) {
  const p = normalize(path);
  return window()?.platform === "linux" ? p : p.toLowerCase();
}

/** True when `path` is `folder` or inside it. */
export function isInside(path, folder) {
  if (!path || !folder) return false;
  const p = pathKey(path);
  const f = pathKey(folder);
  return p === f || p.startsWith(f + "/");
}

/**
 * A path for people: native slashes, and `~` for the home folder.
 * `info`: the machine of the path (from machineInfo()); null is this computer.
 */
export function displayPath(path, info = null) {
  const p = normalize(path);
  const h = normalize(info ? info.home : home());
  const short = h && pathKey(p) === pathKey(h) ? "~" : h && isInside(p, h) ? "~" + p.slice(h.length) : p;
  return (info ? info.windows : isWindows()) ? short.replace(/\//g, "\\") : short;
}

/** The key of a repository or a root on a machine: the path, after `machine|` for another machine. */
export function placeId(machine, path) {
  return machine ? `${machine}|${normalize(path)}` : normalize(path);
}

// What the launcher knows of each other machine: { windows, home, ps }.
const infos = new Map();

/**
 * The system of a machine: `{ windows, home, ps }` (`ps`: the PowerShell to
 * run on Windows). Null `on` is this computer. A Windows machine with Git Bash
 * also has `sh`, so `uname` tells the two apart. Rejects when no shell runs there.
 */
export async function machineInfo(on) {
  if (!on) return { windows: isWindows(), home: normalize(home()), ps: isWindows() ? await powershell() : null };
  if (infos.has(on)) return infos.get(on);
  let info = null;
  try {
    const r = await exec("sh", ["-c", 'uname -s; printf "%s\\n" "$HOME"'], { on, timeout: 20000 });
    const [uname, h] = r.stdout.split("\n").map((s) => s.trim());
    if (r.code === 0 && uname && !/^(MINGW|MSYS|CYGWIN)/i.test(uname)) info = { windows: false, home: normalize(h), ps: null };
  } catch {}
  if (!info) {
    for (const ps of ["pwsh", "powershell"]) {
      try {
        const r = await exec(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$HOME"], { on, timeout: 20000 });
        if (r.code === 0 && r.stdout.trim()) {
          info = { windows: true, home: normalize(r.stdout.trim()), ps };
          break;
        }
      } catch {}
    }
  }
  if (!info) throw new Error(`Could not run a shell on ${on}`);
  infos.set(on, info);
  return info;
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Breadth-first: a folder with `.git` (a folder or a file, for worktrees and
// submodules) is a repository, and the search does not go into it.
const PS_SCAN = (roots, depth) => `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$skip = @{}
foreach ($n in @(${SKIP.map(psQuote).join(",")})) { $skip[$n] = $true }
foreach ($root in @(${roots.map(psQuote).join(",")})) {
  $start = $root
  if ($start -eq '~' -or $start -like '~/*' -or $start -like '~\\*') { $start = $HOME + $start.Substring(1) }
  if (-not [IO.Directory]::Exists($start)) { [Console]::Out.WriteLine("!missing\`t" + $root); continue }
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@([IO.Path]::GetFullPath($start), 0))
  $count = 0
  while ($queue.Count -gt 0 -and $count -lt ${MAX_REPOS}) {
    $item = $queue.Dequeue(); $dir = $item[0]; $level = $item[1]
    $subs = New-Object System.Collections.ArrayList
    $isRepo = $false
    try {
      foreach ($e in ([IO.DirectoryInfo]$dir).EnumerateFileSystemInfos()) {
        if ($e.Name -eq '.git') { $isRepo = $true; break }
        if ($level -lt ${depth} -and $e -is [IO.DirectoryInfo] -and -not $skip.ContainsKey($e.Name) -and -not ($e.Attributes -band [IO.FileAttributes]::ReparsePoint)) { [void]$subs.Add($e.FullName) }
      }
    } catch { continue }
    if ($isRepo) { [Console]::Out.WriteLine("repo\`t" + $root + "\`t" + $dir); $count++; continue }
    foreach ($s in $subs) { $queue.Enqueue(@($s, $level + 1)) }
  }
}
`;

// `find` goes into repositories too, so mod code drops nested ones after.
const SH_SCAN = `
depth="$1"; shift
prune=""
for n in ${SKIP.filter((n) => n !== ".git").join(" ")}; do prune="$prune -o -name $n"; done
for root in "$@"; do
  start="$root"
  case "$root" in "~"|"~/"*) start="$HOME\${root#"~"}" ;; esac
  if [ ! -d "$start" ]; then printf '!missing\\t%s\\n' "$root"; continue; fi
  find "$start" -mindepth 0 -maxdepth "$depth" \\( -false $prune \\) -prune -o -name .git -print 2>/dev/null | head -n ${MAX_REPOS} | while IFS= read -r g; do
    printf 'repo\\t%s\\t%s\\n' "$root" "$(dirname "$g")"
  done
done
`;

/** Runs PowerShell 7 if it is installed, else Windows PowerShell. */
let psProgram = null;
export async function powershell() {
  if (psProgram) return psProgram;
  try {
    const r = await exec("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"]);
    psProgram = r.code === 0 ? "pwsh" : "powershell";
  } catch {
    psProgram = "powershell";
  }
  return psProgram;
}

/**
 * The repositories under `roots`, on the machine `on` (null: this computer).
 * `info`: that machine's machineInfo().
 * Resolves with `{ repos: [{ path, name, root, machine }], missing: [root] }`.
 * Rejects when the search program cannot run.
 */
export async function findRepos(roots, { on = null, info } = {}) {
  if (roots.length === 0) return { repos: [], missing: [] };
  const opts = { on, timeout: 120000 };
  const r = info.windows
    ? await exec(info.ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PS_SCAN(roots, DEPTH)], opts)
    : await exec("sh", ["-c", SH_SCAN, "sh", String(DEPTH + 1), ...roots], opts);
  if (r.code !== 0 && !r.stdout.trim()) {
    throw new Error(r.stderr.trim().split("\n")[0] || "The repository search failed");
  }
  const missing = [];
  const found = new Map();
  for (const raw of r.stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const [kind, root, dir] = line.split("\t");
    if (kind === "!missing") missing.push(normalize(root));
    if (kind !== "repo" || !dir) continue;
    const path = normalize(dir);
    if (!found.has(pathKey(path))) found.set(pathKey(path), { path, root: normalize(root) });
  }
  // Drop a repository inside another one (a submodule, a vendored copy).
  const all = [...found.values()].sort((a, b) => a.path.length - b.path.length);
  const kept = [];
  for (const repo of all) {
    if (!kept.some((k) => isInside(repo.path, k.path))) kept.push(repo);
  }
  const repos = kept
    .map((repo) => ({ ...repo, machine: on ?? null, name: repo.path.split("/").pop() || repo.path }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return { repos, missing };
}

// ---------------------------------------------------------------------------
// Accounts

/**
 * The agents that can run with another account, and the environment
 * variable that selects the account's folder.
 */
export const ACCOUNT_AGENTS = {
  claude: { env: "CLAUDE_CONFIG_DIR", folder: ".claude", prefix: ".claude" },
  codex: { env: "CODEX_HOME", folder: ".codex", prefix: ".codex" },
};

const join = (...parts) => parts.map((p, i) => (i === 0 ? normalize(p) : String(p).replace(/^[\\/]+|[\\/]+$/g, ""))).join("/");

function findEmail(text) {
  const m = /"emailAddress"\s*:\s*"([^"]+)"/.exec(text ?? "");
  return m ? m[1] : null;
}

// base64url, for the payload of the token in Codex's auth.json.
function decodeBase64Url(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const c of s.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")) {
    const v = alphabet.indexOf(c);
    if (v < 0) continue;
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  try {
    return decodeURIComponent(escape(out));
  } catch {
    return out;
  }
}

async function claudeEmail(dir, isDefault) {
  const files = isDefault ? [join(home(), ".claude.json"), join(dir, ".claude.json")] : [join(dir, ".claude.json")];
  for (const f of files) {
    try {
      const email = findEmail(await readTextFile(f));
      if (email) return email;
    } catch {}
  }
  return null;
}

async function codexEmail(dir) {
  try {
    const auth = JSON.parse((await readTextFile(join(dir, "auth.json"))) ?? "{}");
    const token = auth?.tokens?.id_token;
    if (!token) return null;
    const payload = JSON.parse(decodeBase64Url(token.split(".")[1] ?? ""));
    return payload?.email ?? null;
  } catch {
    return null;
  }
}

/** True when a folder looks like the account folder of `agent`. */
async function isAccountFolder(agent, dir, isDefault) {
  const marks = agent === "claude"
    ? [".credentials.json", ".claude.json", "settings.json", "projects"]
    : ["auth.json", "config.toml", "sessions"];
  if (isDefault) return true;
  for (const m of marks) {
    try {
      if (await fs.exists(join(dir, m))) return true;
    } catch {}
  }
  return false;
}

/**
 * The accounts found in the home folder: `~/.claude` and `~/.claude-*`,
 * `~/.codex` and `~/.codex-*`.
 * Resolves with `[{ agent, dir, label, email, isDefault, detected: true }]`.
 */
export async function detectAccounts() {
  let entries = [];
  try {
    entries = await fs.readdir(home(), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const [agent, spec] of Object.entries(ACCOUNT_AGENTS)) {
    const names = entries
      .filter((e) => e.isDirectory() && (e.name === spec.folder || new RegExp(`^\\${spec.prefix}[-_.].+`).test(e.name)))
      .map((e) => e.name)
      .filter((n) => !/(bak|backup|old|tmp)/i.test(n.slice(spec.prefix.length)));
    for (const name of names) {
      const dir = join(home(), name);
      const isDefault = name === spec.folder;
      if (!(await isAccountFolder(agent, dir, isDefault))) continue;
      const email = agent === "claude" ? await claudeEmail(dir, isDefault) : await codexEmail(dir);
      const suffix = name.slice(spec.prefix.length).replace(/^[-_.]/, "");
      out.push({ agent, dir, label: isDefault ? "default" : suffix, email, isDefault, detected: true });
    }
  }
  return out.sort((a, b) => (b.isDefault - a.isDefault) || a.label.localeCompare(b.label));
}

/** Reads the e-mail of an account folder that a person added. */
export async function accountEmail(agent, dir) {
  return agent === "claude" ? claudeEmail(dir, false) : codexEmail(dir);
}
