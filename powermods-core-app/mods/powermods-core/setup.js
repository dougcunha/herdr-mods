// The setup of a new worktree: the files to copy and the commands to run.
//
// 1. The files of the files folder (Settings; this computer only) go into the worktree.
// 2. The git-ignored files of the main checkout that `.herdr/worktree.json` "copy" or `.worktreeinclude` name.
// 3. The commands of the Settings, then the commands of `.herdr/worktree.json` ("run", or "runWindows" on
//    a Windows machine, this one or another). They run in a "setup" tab of the new space: a runner script writes the exit code to a status file.
// No copy writes over a file that exists in the worktree.

import * as fs from "fs/promises";
import { exec, readTextFile, writeTextFile, appHome, shared } from "herdr";
import { KEY, norm, git, hash, psq, shq, isWindows, windowsOn, filesFolder, homeOf, globalCommands } from "./paths.js";

const MAX_FILES = 500;

/** `.herdr/worktree.json` of a checkout: { copy, run, text } (empty lists when the file is missing or broken). */
export async function repoConfig(folder, on) {
  const raw = await readTextFile(`${folder}/.herdr/worktree.json`, { on: on ?? undefined }).catch(() => null);
  if (!raw) return { copy: [], run: [], text: "", error: null };
  try {
    const j = JSON.parse(raw);
    const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
    // A Windows machine (this one or another) runs "runWindows" when the file has it.
    const run = Array.isArray(j.runWindows) && (await windowsOn(on)) ? list(j.runWindows) : list(j.run);
    return { copy: list(j.copy), run, text: raw, error: null };
  } catch (e) {
    return { copy: [], run: [], text: raw, error: `.herdr/worktree.json is not valid JSON: ${e?.message ?? e}` };
  }
}

/** The approval key of a repository's commands: the machine and the main checkout. */
const trustKey = (main, on) => `${on ?? "local"}:${norm(main).toLowerCase()}`;
/** True when the person approved exactly these commands for this repository. */
export function trusted(main, on, commands) {
  const all = shared(KEY.trusted);
  return Boolean(all && typeof all === "object" && all[trustKey(main, on)] === hash(JSON.stringify(commands)));
}
export function trustValue(main, on, commands) {
  return { key: trustKey(main, on), value: hash(JSON.stringify(commands)) };
}

/** Copies every file of the files folder into the worktree (this computer only). Returns how many. */
export async function copyFilesFolder(path) {
  const src = filesFolder();
  if (!src) return 0;
  if (isWindows()) {
    const script = `$s=${psq(src)}; $d=${psq(path)}; $n=0
if (Test-Path -LiteralPath $s -PathType Container) {
  $base = (Resolve-Path -LiteralPath $s).Path.TrimEnd('\\')
  Get-ChildItem -LiteralPath $s -Recurse -File -Force | ForEach-Object {
    $t = Join-Path $d $_.FullName.Substring($base.Length).TrimStart('\\')
    if (-not (Test-Path -LiteralPath $t)) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $t) | Out-Null; Copy-Item -LiteralPath $_.FullName -Destination $t; $n++ }
  }
}
$n`;
    const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 120000 }).catch(() => null);
    return Number.parseInt(r?.stdout ?? "0", 10) || 0;
  }
  const r = await exec("sh", ["-c", '[ -d "$1" ] || { echo 0; exit 0; }; cd "$1" && find . -type f | while IFS= read -r f; do t="$2/$f"; [ -e "$t" ] && continue; mkdir -p "$(dirname "$t")" && cp -p "$f" "$t" && echo x; done | wc -l', "sh", src, path], { timeout: 120000 }).catch(() => null);
  return Number.parseInt((r?.stdout ?? "0").trim(), 10) || 0;
}

/**
 * Copies the git-ignored files of the main checkout that `patterns` (globs of .herdr/worktree.json "copy") or
 * `.worktreeinclude` name. Returns how many.
 */
export async function copyIgnored(main, path, on, patterns) {
  const include = await readTextFile(`${main}/.worktreeinclude`, { on: on ?? undefined }).catch(() => null);
  if (!patterns.length && include == null) return 0;
  const args = ["ls-files", "-z", "--others", "--ignored", ...patterns.flatMap((p) => ["-x", p]), ...(include != null ? ["--exclude-from=.worktreeinclude"] : [])];
  // -z: names come NUL-separated and unquoted. `raw`, not `out`: a trim would cut a leading space of the first name.
  const list = await git(main, args, on);
  if (!list.ok || !list.raw) return 0;
  const files = list.raw.split("\0").filter((f) => f && !f.split("/").includes("..")).slice(0, MAX_FILES);
  if (!files.length) return 0;
  if (!on && isWindows()) {
    const script = `$m=${psq(main)}; $p=${psq(path)}; $n=0
foreach ($f in @(${files.map(psq).join(",")})) {
  $d = Join-Path $p $f
  if (Test-Path -LiteralPath $d) { continue }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $d) | Out-Null
  Copy-Item -LiteralPath (Join-Path $m $f) -Destination $d; $n++
}
$n`;
    const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 120000 }).catch(() => null);
    return Number.parseInt(r?.stdout ?? "0", 10) || 0;
  }
  const r = await exec("sh", ["-c", 'm="$1"; p="$2"; shift 2; n=0; for f; do [ -e "$p/$f" ] && continue; mkdir -p "$(dirname "$p/$f")" && cp -p "$m/$f" "$p/$f" && n=$((n+1)); done; echo $n', "sh", main, path, ...files], { on: on ?? undefined, timeout: 120000 }).catch(() => null);
  return Number.parseInt((r?.stdout ?? "0").trim(), 10) || 0;
}

/** The commands of the setup: the Settings first, then the repository's (when the person approved them). */
export function commandsOf(repoRun, useRepo) {
  return [...globalCommands(), ...(useRepo ? repoRun : [])];
}

function psRunner(path, status, commands) {
  return `$ErrorActionPreference = 'Continue'
$status = ${psq(status)}
Set-Location -LiteralPath ${psq(path)}
$commands = @(
${commands.map(psq).join(",\n")}
)
$n = 0
foreach ($c in $commands) {
  $n++
  Write-Host ""
  Write-Host "[$n/$($commands.Count)] $c" -ForegroundColor Cyan
  $global:LASTEXITCODE = 0
  try { Invoke-Expression $c; $ok = $? } catch { Write-Host $_ -ForegroundColor Red; $ok = $false }
  $code = $LASTEXITCODE
  if (-not $ok -and -not $code) { $code = 1 }
  if ($code) {
    Set-Content -LiteralPath $status -Value "$code" -Encoding ascii
    Write-Host ""
    Write-Host "Setup failed (exit code $code): $c" -ForegroundColor Red
    exit $code
  }
}
Set-Content -LiteralPath $status -Value '0' -Encoding ascii
Write-Host ""
Write-Host "Setup done." -ForegroundColor Green
`;
}

function shRunner(path, status, commands) {
  return `#!/bin/sh
S=${shq(status)}
cd ${shq(path)} || { echo 1 > "$S"; exit 1; }
n=0
total=${commands.length}
step() {
  n=$((n+1))
  printf '\\n\\033[36m[%s/%s] %s\\033[0m\\n' "$n" "$total" "$1"
  sh -c "$1"
  c=$?
  if [ "$c" -ne 0 ]; then
    echo "$c" > "$S"
    printf '\\n\\033[31mSetup failed (exit code %s): %s\\033[0m\\n' "$c" "$1"
    exit "$c"
  fi
}
${commands.map((c) => `step ${shq(c)}`).join("\n")}
echo 0 > "$S"
printf '\\n\\033[32mSetup done.\\033[0m\\n'
`;
}

/**
 * Writes the runner script of a setup. Returns { argv, status, files } : the argv of the "setup" tab, the
 * status file that gets the exit code, and the files to delete after.
 */
export async function writeRunner(id, path, on, commands) {
  // A Windows machine runs the commands in PowerShell, also another one: the commands of the Settings are
  // PowerShell commands there (Install-Skills), and sh does not know them (exit code 127).
  const win = await windowsOn(on);
  let base = `${norm(appHome())}/data/powermods-core`;
  if (on) {
    const h = await homeOf(on);
    if (!h) throw new Error("Cannot find the home folder on that machine.");
    base = `${h}/.herdr/powermods-core`;
  }
  const script = `${base}/setup-${id}.${win ? "ps1" : "sh"}`, status = `${base}/setup-${id}.status`;
  const text = win ? psRunner(path, status, commands) : shRunner(path, status, commands);
  if (!on && win) {
    await fs.mkdir(base, { recursive: true }).catch(() => {});
    await writeTextFile(script, text, null);
  } else {
    const r = await exec("sh", ["-c", 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1"', "sh", script, text], { on: on ?? undefined });
    if (r.code !== 0) throw new Error(`Cannot write the setup script: ${(r.stderr || r.stdout).trim()}`);
  }
  // -NoExit: the setup terminal stays after the script. On another Windows machine, Herdr runs the argv in a
  // wrapper that fails after the program (exit code 127): the terminal ended, the setup tab closed, and with
  // it the space, before the agent tab opened. The core closes the setup tab when the agent tab is there.
  const argv = win ? ["pwsh", "-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] : ["sh", script];
  return { argv, status, files: [script, status] };
}

/** The exit code in a status file, or null while the setup runs. */
export async function readStatus(status, on) {
  const raw = await readTextFile(status, { on: on ?? undefined }).catch(() => null);
  if (raw == null || !raw.trim()) return null;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : 1;
}

/** Deletes the runner files. */
export async function removeRunner(files, on) {
  if (!on && isWindows()) { for (const f of files) await fs.unlink(f).catch(() => {}); return; }
  await exec("sh", ["-c", 'rm -f "$@"', "sh", ...files], { on: on ?? undefined }).catch(() => null);
}
