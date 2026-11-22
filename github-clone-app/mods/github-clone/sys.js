// The machines: their system, their paths and the small programs that the
// mod runs there (list the clone folders, check a path, make a folder).
//
// A mod can list folders only inside the home folder of this computer, so
// these checks run as programs: PowerShell on Windows, `sh` elsewhere. On
// another machine they run through herdr-core (`exec` with `on`).

import { exec, home, window } from "herdr";

export const isWindows = () => window()?.platform === "windows";

/** A path with forward slashes and no slash at the end ("/" and "C:/" keep theirs). */
export function normalize(path) {
  const p = String(path ?? "").trim().replace(/\\/g, "/");
  if (p === "/" || /^[A-Za-z]:\/$/.test(p)) return p;
  return p.replace(/\/+$/, "");
}

/** The key that compares 2 paths or 2 names: case-insensitive when `fold`. */
export const keyOf = (text, fold) => (fold ? normalize(text).toLowerCase() : normalize(text));

/** True when `path` is `folder` or inside it. */
export function isInside(path, folder, fold) {
  if (!path || !folder) return false;
  const p = keyOf(path, fold);
  const f = keyOf(folder, fold);
  return p === f || p.startsWith(f.endsWith("/") ? f : f + "/");
}

/** `~` or `~/x` with the home folder of the machine (`info` from machineInfo()). */
export function expandHome(path, info) {
  const p = normalize(path);
  if (p === "~") return normalize(info.home);
  if (p.startsWith("~/")) return normalize(info.home) + p.slice(1);
  return p;
}

export const joinPath = (folder, name) => {
  const f = normalize(folder);
  return f.endsWith("/") ? f + name : `${f}/${name}`;
};

export function parentOf(path) {
  const p = normalize(path);
  const i = p.lastIndexOf("/");
  if (i < 0) return "";
  if (i === 0) return "/";
  return /^[A-Za-z]:$/.test(p.slice(0, i)) ? p.slice(0, i + 1) : p.slice(0, i);
}

export const baseName = (path) => normalize(path).split("/").pop() ?? "";

/** A full path: `/x`, `C:/x`, `//server/x` or `~/x`. */
export const isFullPath = (path) => /^(\/|[A-Za-z]:\/|~(\/|$))/.test(normalize(path));

/** A path for people: native slashes, and `~` for the home folder of the machine. */
export function displayPath(path, info) {
  const p = normalize(path);
  if (!info) return p;
  const h = normalize(info.home);
  const short = h && keyOf(p, info.fold) === keyOf(h, info.fold) ? "~"
    : h && isInside(p, h, info.fold) ? "~" + p.slice(h.length) : p;
  return info.windows ? short.replace(/\//g, "\\") : short;
}

/** A path with the slashes of the machine. */
export const nativePath = (path, info) => (info?.windows ? normalize(path).replace(/\//g, "\\") : normalize(path));

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

// What the mod knows of each machine: { windows, home, ps, fold }.
const infos = new Map();

/** The machineInfo() of a machine when it is known already, else null (this computer is always known). */
export function knownInfo(on) {
  if (!on) return { windows: isWindows(), home: normalize(home()), ps: psProgram ?? "pwsh", fold: window()?.platform !== "linux" };
  return infos.get(on) ?? null;
}

/**
 * The system of a machine: `{ windows, home, ps, fold }`. `ps`: the
 * PowerShell to run on Windows. `fold`: paths ignore case (Windows, macOS).
 * Null `on` is this computer. A Windows machine with Git Bash also has `sh`,
 * so `uname` tells the two apart. Rejects when no shell runs there.
 */
export async function machineInfo(on) {
  if (!on) return { ...knownInfo(null), ps: isWindows() ? await powershell() : null };
  if (infos.has(on)) return infos.get(on);
  let info = null;
  try {
    const r = await exec("sh", ["-c", 'uname -s; printf "%s\\n" "$HOME"'], { on, timeout: 20000 });
    const [uname, h] = r.stdout.split("\n").map((s) => s.trim());
    if (r.code === 0 && uname && !/^(MINGW|MSYS|CYGWIN)/i.test(uname)) info = { windows: false, home: normalize(h), ps: null, fold: /^Darwin/i.test(uname) };
  } catch {}
  if (!info) {
    for (const ps of ["pwsh", "powershell"]) {
      try {
        const r = await exec(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$HOME"], { on, timeout: 20000 });
        if (r.code === 0 && r.stdout.trim()) {
          info = { windows: true, home: normalize(r.stdout.trim()), ps, fold: true };
          break;
        }
      } catch {}
    }
  }
  if (!info) throw new Error(`Could not run a shell on ${on}`);
  infos.set(on, info);
  return info;
}

// PowerShell also takes the curly quotes ‘ ’ ‚ ‛ as single quotes: they are doubled too.
export const psQuote = (s) => `'${String(s).replace(/['\u2018-\u201B]/g, "$&$&")}'`;
export const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** Runs a PowerShell script on Windows or an `sh` script elsewhere, with `args`. */
async function script(on, info, { ps, sh }, args, timeout = 30000) {
  if (info.windows) {
    const body = `$ErrorActionPreference = 'Continue'\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$argv = @(${args.map(psQuote).join(",")})\n${ps}`;
    return exec(info.ps ?? "pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", body], { on: on ?? undefined, timeout });
  }
  return exec("sh", ["-c", sh, "sh", ...args], { on: on ?? undefined, timeout });
}

// Lists each folder: every subfolder, if it holds a Git repository, and its `origin` URL.
const PROBE_PS = `
foreach ($f in $argv) {
  if (-not [IO.Directory]::Exists($f)) { [Console]::Out.WriteLine("!missing\`t" + $f); continue }
  try { $dirs = ([IO.DirectoryInfo]$f).EnumerateDirectories() } catch { continue }
  foreach ($d in $dirs) {
    $git = 0; $url = ''
    $cfg = [IO.Path]::Combine($d.FullName, '.git', 'config')
    if ([IO.File]::Exists($cfg)) {
      $git = 1
      try { $m = [regex]::Match([IO.File]::ReadAllText($cfg), '(?ms)^\\[remote "origin"\\][^\\[]*?^\\s*url\\s*=\\s*(\\S+)'); if ($m.Success) { $url = $m.Groups[1].Value } } catch {}
    } elseif ([IO.File]::Exists([IO.Path]::Combine($d.FullName, '.git'))) { $git = 1 }
    [Console]::Out.WriteLine("dir\`t" + $f + "\`t" + $d.Name + "\`t" + $git + "\`t" + $url)
  }
}
`;
const PROBE_SH = `
for f in "$@"; do
  if [ ! -d "$f" ]; then printf '!missing\\t%s\\n' "$f"; continue; fi
  for d in "$f"/*; do
    [ -d "$d" ] || continue
    n=$(basename "$d"); git=0; url=""
    if [ -f "$d/.git/config" ]; then
      git=1; url=$(git config -f "$d/.git/config" --get remote.origin.url 2>/dev/null)
    elif [ -e "$d/.git" ]; then git=1; fi
    printf 'dir\\t%s\\t%s\\t%s\\t%s\\n' "$f" "$n" "$git" "$url"
  done
done
`;

/**
 * The subfolders of each folder (full paths, `~` expanded) on a machine.
 * Resolves with `{ byFolder: Map(keyOf(folder) -> Map(keyOf(name) -> { name, git, url })), missing: [folder] }`.
 */
export async function probeFolders(on, info, folders) {
  const byFolder = new Map();
  const missing = [];
  if (!folders.length) return { byFolder, missing };
  const r = await script(on, info, { ps: PROBE_PS, sh: PROBE_SH }, folders, 60000);
  for (const raw of r.stdout.split("\n")) {
    const [kind, folder, name, git, url] = raw.replace(/\r$/, "").split("\t");
    if (kind === "!missing") missing.push(normalize(folder));
    if (kind !== "dir" || !name) continue;
    const k = keyOf(folder, info.fold);
    if (!byFolder.has(k)) byFolder.set(k, new Map());
    byFolder.get(k).set(keyOf(name, info.fold), { name, git: git === "1", url: url ?? "" });
  }
  for (const f of folders) if (!byFolder.has(keyOf(f, info.fold)) && !missing.includes(normalize(f))) byFolder.set(keyOf(f, info.fold), new Map());
  return { byFolder, missing };
}

/** True when `path` (full, `~` expanded) exists on the machine. */
export async function pathExists(on, info, path) {
  const r = await script(on, info, {
    ps: "if (Test-Path -LiteralPath $argv[0]) { 'yes' } else { 'no' }",
    sh: 'if [ -e "$1" ]; then echo yes; else echo no; fi',
  }, [nativePath(path, info)]);
  const out = r.stdout.trim();
  if (out !== "yes" && out !== "no") throw new Error(r.stderr.trim().split("\n")[0] || "Could not check the folder");
  return out === "yes";
}

/** Makes a folder and its parents on the machine. */
export async function makeDir(on, info, path) {
  const r = await script(on, info, {
    ps: "New-Item -ItemType Directory -Force -Path $argv[0] | Out-Null; if (Test-Path -LiteralPath $argv[0]) { 'ok' }",
    sh: 'mkdir -p "$1" && echo ok',
  }, [nativePath(path, info)]);
  if (r.stdout.trim() !== "ok") throw new Error(r.stderr.trim().split("\n")[0] || `Could not make ${path}`);
}

/**
 * The line that the clone terminal runs. The shell goes into the new folder
 * only when the clone ends without an error. Windows PowerShell 5.1 has no
 * `&&`, so Windows gets `; if ($?) { … }`.
 */
export function cloneLine(info, full, dest, { branch = "", shallow = false } = {}) {
  const path = nativePath(dest, info);
  const q = info.windows ? psQuote : shQuote;
  // The submodules are cloned with the repository (no effect on a repository without them).
  const extra = ["--recurse-submodules"];
  if (branch) extra.push("--branch", q(branch));
  // A shallow clone makes shallow submodules too.
  if (shallow) extra.push("--depth", "1", "--shallow-submodules");
  // A quoted '--' always reaches gh, also from PowerShell.
  const tail = ` ${q("--")} ${extra.join(" ")}`;
  const clone = `gh repo clone ${q(full)} ${q(path)}${tail}`;
  return info.windows ? `${clone}; if ($?) { Set-Location -LiteralPath ${q(path)} }` : `${clone} && cd ${q(path)}`;
}

/** Opens a web page in the browser of this computer (only https URLs reach the system opener). */
export function openUrl(url) {
  if (!/^https:\/\/[^\s]+$/i.test(url ?? "")) return;
  const os = window()?.platform;
  const [cmd, args] = os === "windows" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : os === "linux" ? ["xdg-open", [url]] : ["open", [url]];
  exec(cmd, args).catch(() => null);
}

/** The GitHub page of a repository. */
export const repoUrl = (full) => `https://github.com/${full}`;

/** `owner/name` of a GitHub URL (`git@github.com:o/n.git`, `https://github.com/o/n`), lower case, or "". */
export function repoOfUrl(url) {
  const m = /[:/]([^/:]+)\/([^/]+?)(\.git)?\/?$/.exec(String(url ?? "").trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : "";
}
