// The target terminal, its context (the values of the variables), the expansion of a script and
// the filter of an action.
//
// The target terminal is the terminal that has the focus. While a dialog or a mod pane has the
// focus, it is the last terminal that had it in the same space (the runner keeps it in
// shared("quick-actions.target")), else a terminal of the shown tab.

import { exec, focused, panes, terminals, spaces, shared, home, window } from "herdr";
import { KEY } from "./store.js";

export const VARIABLES = [
  ["folder", "The folder of the terminal"],
  ["repo", "The root folder of its git repository (empty outside a repository)"],
  ["repo_name", "The name of that repository folder"],
  ["branch", "The git branch of the terminal"],
  ["space", "The name of the space"],
  ["tab", "The name of the tab"],
  ["terminal", "The address of the terminal (t7, wsl/t7)"],
  ["machine", "The machine of the space: local for this computer"],
  ["home", "The home folder of that machine"],
  ["date", "The date: YYYY-MM-DD"],
  ["time", "The time: HH:MM"],
];
const NAMES = new Set(VARIABLES.map((v) => v[0]));
const VAR_RE = /\{([a-z_]+)\}/g;

// PowerShell also takes ‘ ’ ‚ ‛ as single quotes: each one is doubled too, else a value could close the literal.
export const psq = (s) => `'${String(s ?? "").replace(/['‘’‚‛]/g, (c) => c + c)}'`;
export const shq = (s) => `'${String(s ?? "").replace(/'/g, `'\\''`)}'`;

/** The names of the known variables that a text uses. */
export const usedVars = (text) => new Set([...String(text ?? "").matchAll(VAR_RE)].map((m) => m[1]).filter((n) => NAMES.has(n)));

// {ask:Label} or {ask:Label=default}: the person gives the value before the run.
const ASK_RE = /\{ask:([^{}=\n]+?)(?:=([^{}\n]*))?\}/g;
// A {name} or an {ask:Label=default}, for expand().
const TOKEN_RE = /\{(?:([a-z_]+)|ask:([^{}=\n]+?)(?:=([^{}\n]*))?)\}/g;

/** The questions of a script: [{ label, def }], in the order of the text, each label once. */
export function asksOf(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text ?? "").matchAll(ASK_RE)) {
    const label = m[1].trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, def: m[2] ?? "" });
  }
  return out;
}

/**
 * The text with each known {name} as 1 quoted literal for the shell. Other {…} stay as they are.
 * `answers` ({ label: value }) fill the {ask:…}; without answers (a preview), the default or <Label> shows.
 */
export function expand(text, values, shell, answers = null) {
  const q = shell === "ps" ? psq : shq;
  // 1 pass for {name} and {ask:…}: a value never goes through the replace again, so a value with
  // "{ask:…}" in it (a folder, a space name) stays inside its quotes.
  return String(text ?? "").replace(TOKEN_RE, (m, name, label, def) => {
    if (name !== undefined) return NAMES.has(name) ? q(values[name] ?? "") : m;
    const key = label.trim();
    if (answers) return q(answers[key] ?? def ?? "");
    return q(def ?? `<${key}>`);
  });
}

// A path with forward slashes and no slash at the end ("/" and "C:/" keep theirs).
function slash(path) {
  const p = String(path ?? "").trim().replace(/\\/g, "/");
  return p === "/" || /^[A-Za-z]:\/$/.test(p) ? p : p.replace(/\/+$/, "");
}
const baseName = (p) => slash(p).split("/").pop() ?? "";
const isWin = () => window()?.platform === "windows";

/** The target terminal now: { terminal, space, tab }, or { terminal: null, space, tab } when the space has no terminal, or null. */
export function currentTarget() {
  const f = focused();
  if (f?.terminal) return { terminal: f.terminal, space: f.space, tab: f.tab };
  const live = new Set(terminals().map((x) => x.address));
  const kept = shared(KEY.target);
  if (kept?.terminal && live.has(kept.terminal) && (!f?.space || kept.space === f.space)) return kept;
  if (f?.tab) {
    const p = panes().find((x) => x.tab === f.tab && x.terminal && x.focused) ?? panes().find((x) => x.tab === f.tab && x.terminal);
    if (p) return { terminal: p.terminal, space: f.space, tab: f.tab };
  }
  return f?.space ? { terminal: null, space: f.space, tab: f.tab ?? null } : null;
}

// What the mod knows of other machines: { windows, home }.
const machineInfos = new Map();

/** The system of a machine (null: this computer): { windows, home }. */
export async function machineInfo(on) {
  if (!on) return { windows: isWin(), home: slash(home()) };
  if (machineInfos.has(on)) return machineInfos.get(on);
  let info = null;
  try {
    const r = await exec("sh", ["-c", 'uname -s; printf "%s\\n" "$HOME"'], { on, timeout: 15000 });
    const [uname, h] = r.stdout.split("\n").map((s) => s.trim());
    if (r.code === 0 && uname && !/^(MINGW|MSYS|CYGWIN)/i.test(uname)) info = { windows: false, home: slash(h) };
  } catch { /* not a Unix machine */ }
  if (!info) {
    try {
      const r = await exec("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$HOME"], { on, timeout: 15000 });
      if (r.code === 0 && r.stdout.trim()) info = { windows: true, home: slash(r.stdout.trim()) };
    } catch { /* no PowerShell */ }
  }
  info ??= { windows: false, home: "~" };
  machineInfos.set(on, info);
  return info;
}

const POSIX = ["bash", "zsh", "sh", "dash", "ksh", "fish"];

/** The shell of a program name: "ps", or the name of a POSIX shell, or null. */
export function shellOf(name) {
  const n = String(name ?? "").toLowerCase().replace(/\.exe$/, "").split(/[\\/]/).pop();
  if (n === "pwsh" || n === "powershell") return "ps";
  return POSIX.includes(n) ? n : null;
}

/** The quoting family of a shell: "ps" or "sh". */
export const family = (shell) => (shell === "ps" ? "ps" : "sh");

/** The repository root of a folder, or "". */
async function repoRoot(folder, machine) {
  if (!folder) return "";
  try {
    const r = await exec("git", ["-C", folder, "rev-parse", "--show-toplevel"], { on: machine ?? undefined, timeout: 8000 });
    return r.code === 0 ? slash(r.stdout.trim()) : "";
  } catch {
    return "";
  }
}

/** The branch of a folder, or "". */
async function branchOf(folder, machine) {
  if (!folder) return "";
  try {
    const r = await exec("git", ["-C", folder, "branch", "--show-current"], { on: machine ?? undefined, timeout: 8000 });
    return r.code === 0 ? r.stdout.trim() : "";
  } catch {
    return "";
  }
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * The context of a target: where it is, if its terminal is busy, its shell and the values of the
 * variables in `need` (a Set of names; the git values run git only when needed).
 * { target, machine, windows, folder, busy, busyWith, shell, values }.
 * `probe: false` skips the check for a running command on Windows (the bar filter does not need it).
 */
export async function context(target, need = new Set(VARIABLES.map((v) => v[0])), { probe = true } = {}) {
  const sp = spaces().find((s) => s.id === target.space) ?? null;
  const tab = sp?.tabs?.find((x) => x.id === target.tab) ?? null;
  const machine = sp?.machine ?? null;
  const info = await machineInfo(machine);
  const term = target.terminal ? terminals().find((x) => x.address === target.terminal) ?? null : null;
  const pane = target.terminal ? panes().find((p) => p.terminal === target.terminal) ?? null : null;
  const f = focused();
  const rawFolder = (f?.terminal && f.terminal === target.terminal && f.cwd) || pane?.cwd || term?.foreground?.cwd || term?.cwd || sp?.folder || "";
  const folder = slash(rawFolder);
  const program = term?.program ?? pane?.program ?? null;
  // Free: the program of the terminal now is a shell (no command runs, no agent, no editor).
  let busy = !target.terminal || !program?.shell;
  let busyWith = busy && target.terminal ? program?.name ?? "" : "";
  // On Windows, Herdr reports the shell also while a command of it runs (npm, git, vim): a child
  // process of the shell tells it.
  if (probe && !busy && info.windows && term?.pid) {
    const kids = await childNames(term.pid, machine);
    if (kids.length) { busy = true; busyWith = kids[0].replace(/\.exe$/i, ""); }
  }
  const shell = shellOf(term?.foreground?.name) ?? shellOf(program?.name) ?? (info.windows ? "ps" : "sh");
  const native = (p) => (info.windows ? p.replace(/\//g, "\\") : p);
  const now = new Date();
  const values = {
    folder: native(folder),
    space: sp?.name ?? "",
    tab: tab?.name ?? "",
    terminal: target.terminal ?? "",
    machine: machine ?? "local",
    home: native(info.home),
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    repo: "",
    repo_name: "",
    branch: pane?.branch ?? "",
  };
  if (need.has("repo") || need.has("repo_name")) {
    const root = await repoRoot(folder, machine);
    values.repo = native(root);
    values.repo_name = baseName(root);
  }
  if (need.has("branch") && !values.branch) values.branch = await branchOf(folder, machine);
  return { target, machine, windows: info.windows, folder, busy, busyWith, shell, values };
}

/**
 * The names of the child processes of the shell of a terminal on a Windows machine (not the console hosts).
 * A launcher (a scoop shim) can start the real PowerShell as its only child: then the children of that
 * PowerShell count (up to 3 levels).
 */
async function childNames(pid, machine) {
  const script = [
    `$p = ${Number(pid)}`,
    "$kids = @()",
    "for ($i = 0; $i -lt 3; $i++) {",
    "  $kids = @(Get-CimInstance Win32_Process -Filter \"ParentProcessId=$p\" | Where-Object { $_.Name -notin 'conhost.exe','OpenConsole.exe' })",
    "  if ($kids.Count -eq 1 -and $kids[0].Name -in 'pwsh.exe','powershell.exe') { $p = $kids[0].ProcessId; continue }",
    "  break",
    "}",
    "@($kids | ForEach-Object Name) -join ','",
  ].join("\n");
  for (const ps of ["pwsh", "powershell"]) {
    try {
      const r = await exec(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { on: machine ?? undefined, timeout: 10000 });
      if (r.code === 0) return r.stdout.trim().split(",").map((s) => s.trim()).filter(Boolean);
    } catch { /* try the next PowerShell */ }
  }
  return [];
}

// ---- the filter -----------------------------------------------------------------------------

/** The parts of a filter text. */
export const filterParts = (text) => String(text ?? "").split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);

/** A part with a slash, a backslash or a drive is a folder; else it is a repository name. */
const isFolderPart = (p) => /[\\/]|^[A-Za-z]:|^~/.test(p);

/** True when the filter needs the repository name. */
export const filterNeedsRepo = (text) => filterParts(text).some((p) => !isFolderPart(p));

const globRe = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, "[^/]")}$`, "i");

/**
 * True when the action can run in this context. A folder part matches the folder and every folder
 * inside it (`*` and `**` work too); a name part matches the name of the repository (`*` works).
 */
export function filterMatches(text, ctx) {
  const parts = filterParts(text);
  if (!parts.length) return true;
  const folder = slash(ctx.folder).toLowerCase();
  const homeDir = slash(ctx.values?.home ?? "").toLowerCase();
  for (const raw of parts) {
    if (isFolderPart(raw)) {
      let p = slash(raw).toLowerCase();
      if (p === "~" || p.startsWith("~/")) p = homeDir + p.slice(1);
      if (p.includes("*") || p.includes("?")) {
        const re = globRe(p);
        // The folder or one of its parents matches.
        let f = folder;
        for (;;) {
          if (re.test(f)) return true;
          const i = f.lastIndexOf("/");
          if (i <= 0) break;
          f = f.slice(0, i);
        }
      } else if (folder === p || folder.startsWith(p.endsWith("/") ? p : `${p}/`)) return true;
    } else {
      const name = String(ctx.values?.repo_name ?? "").toLowerCase();
      if (name && globRe(raw.toLowerCase()).test(name)) return true;
    }
  }
  return false;
}
