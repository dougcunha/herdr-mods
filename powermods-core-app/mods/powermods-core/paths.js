// Paths, settings and git helpers of the core. No state: every function reads the settings
// (shared keys of kit.json) when it runs, so a change in the Settings tab of mods-hub applies at once.

import { exec, shared, home, window as appWindow } from "herdr";

export const KEY = {
  root: "powermods-core.worktreeRoot",
  files: "powermods-core.filesFolder",
  run: "powermods-core.run",
  trusted: "powermods-core.trusted",
  jobs: "powermods-core.jobs",
};
// spec-board had its own setting before the core. A value there is the root until the core has one.
const OLD_ROOT = "spec-board.worktreeRoot";
export const DEFAULT_ROOT = "~/.herdr/worktrees";
export const DEFAULT_FILES = "~/.herdr/worktree-files";

export const norm = (p) => String(p ?? "").trim().replace(/\\/g, "/").replace(/([^:/])\/+$/, "$1");
const winPath = (p) => /^[A-Za-z]:\//.test(norm(p));
/** True when a and b are the same folder (case does not count for a Windows path). */
export const samePath = (a, b) => {
  const x = norm(a), y = norm(b);
  return winPath(x) ? x.toLowerCase() === y.toLowerCase() : x === y;
};
/** True when `p` is `dir` or inside it. */
export const inside = (p, dir) => {
  const x = norm(p), y = norm(dir);
  if (!x || !y) return false;
  const [a, b] = winPath(y) ? [x.toLowerCase(), y.toLowerCase()] : [x, y];
  return a === b || a.startsWith(`${b}/`);
};
export const isWindows = () => { try { return appWindow().platform === "windows"; } catch { return false; } };
/** A folder name from a branch: feat/login → feat-login. */
export const slug = (branch) => String(branch ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
export const repoName = (main) => norm(main).split("/").filter(Boolean).pop() ?? "";

const text = (key) => { const v = shared(key); return typeof v === "string" && v.trim() ? v.trim() : ""; };
/** The root folder setting as the person wrote it (or the default). */
export const rootSetting = () => text(KEY.root) || text(OLD_ROOT) || DEFAULT_ROOT;
export const filesSetting = () => text(KEY.files) || DEFAULT_FILES;
/** The setup commands of the settings: 1 for each line, empty lines and # comments left out. */
export function globalCommands() {
  const v = shared(KEY.run);
  const lines = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\r?\n/) : [];
  return lines.map((l) => String(l).trim()).filter((l) => l && !l.startsWith("#"));
}

/** The home folder on a machine: this computer's from Herdr, another one's from its shell. Null when unknown. */
export async function homeOf(on) {
  if (!on) return norm(home()) || null;
  const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on }).catch(() => null);
  const h = r?.code === 0 ? r.stdout.trim() : "";
  return h.startsWith("/") ? h : null;
}

/**
 * The root folder of new worktrees on a machine. A value that starts with `~` is the home folder of that
 * machine. On another machine, an absolute value of this computer does not apply: the default root there.
 */
export function rootFor(on, homeDir) {
  let v = rootSetting();
  if (on && !v.startsWith("~")) v = DEFAULT_ROOT;
  return norm(v.replace(/^~(?=[\\/]|$)/, homeDir ?? ""));
}
/** The files folder on this computer, or null when the setting is empty. */
export function filesFolder() {
  return norm(filesSetting().replace(/^~(?=[\\/]|$)/, norm(home())));
}

/** Runs git. Never rejects: `ok` is false when git fails or cannot start. */
export async function git(cwd, args, on, timeout) {
  const r = await exec("git", args, { cwd, on: on ?? undefined, ...(timeout ? { timeout } : {}) })
    .catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
  return { ok: r.code === 0, out: r.stdout.trim(), err: (r.stderr || r.stdout || "").trim(), raw: r.stdout };
}

/** The main checkout of the repository that holds `folder` (a linked worktree gives its main one). Null: not git. */
export async function mainCheckout(folder, on) {
  const r = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!r.ok || !r.out) return null;
  const common = norm(r.out);
  if (common.endsWith("/.git")) return common.slice(0, -5);
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
  return top.ok ? norm(top.out) : null;
}

/** `git worktree list --porcelain` as [{ path, branch, head, detached, locked, prunable, main }]. */
export function parseWorktrees(raw) {
  const out = [];
  let w = null;
  for (const line of String(raw ?? "").replace(/\r/g, "").split("\n")) {
    if (line.startsWith("worktree ")) { w = { path: norm(line.slice(9)), branch: null, head: null, detached: false, locked: false, prunable: false }; out.push(w); continue; }
    if (!w) continue;
    if (line.startsWith("HEAD ")) w.head = line.slice(5).trim();
    else if (line.startsWith("branch ")) w.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
    else if (line === "detached") w.detached = true;
    else if (line.startsWith("locked")) w.locked = true;
    else if (line.startsWith("prunable")) w.prunable = true;
  }
  out.forEach((x, i) => { x.main = i === 0; });
  return out;
}

/** A short, stable hash of a text (FNV-1a, 32 bits). Enough to see that a file changed. */
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Text in single quotes for PowerShell. */
export const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
/** Text in single quotes for sh. */
export const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
