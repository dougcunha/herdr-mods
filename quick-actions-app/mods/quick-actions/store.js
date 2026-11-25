// The files and the shared keys of the mod.
//
// data/quick-actions.json       { "actions": [ <action> ] }: the list. People can edit the file by
//                               hand; every copy reads it again when shared("quick-actions.rev") changes.
// data/quick-actions/runs/      the run files: the expanded script of a run of 2 or more lines, or of a
//                               script file. The mod keeps the last KEEP_RUNS.
// data/quick-actions/run-log.json  the steps of the last KEEP_LOG runs, with their times and errors: it
//                               tells why a run did nothing.

import { appHome, readTextFile, writeTextFile, shared, setShared, keys, window } from "herdr";
import * as fs from "fs/promises";

export const MOD = "quick-actions";
export const KEEP_RUNS = 20;
export const KEEP_LOG = 15;

export const KEY = {
  lang: "herdr-mods.lang",
  disabled: "herdr-mods.disabled",
  rev: "quick-actions.rev", // changes when a copy saves the list
  target: "quick-actions.target", // { terminal, space, tab }: the last terminal that had the focus (the runner writes it)
  runner: "quick-actions.runner", // { at }: the runner is on the screen
  scriptDir: "quick-actions.scriptDir", // a setting: the folder of the scripts that an agent writes
  agent: "quick-actions.agent", // the agent that wrote the last script (the choice of the form)
  writerWhere: "quick-actions.writerWhere", // "tab" | "background": where the last script agent ran (the choice of the form)
  jobs: "quick-actions.jobs", // { "<kind>:<action id>": job }: the last background run and agent of each action (jobs.js)
  lease: "quick-actions.lease", // { owner, at }: the runner copy that checks the background jobs
  timeout: "quick-actions.timeoutMin", // a setting: the minutes before a background job is stopped
  hidden: "dock.hiddenEntries", // { "<mod>": [ <panels.json id> ] }: the bars of Dock and Kanban leave out these buttons
};

export const panelsPath = () => `${slash(appHome())}/dock/panels.json`;
export const panelId = (a) => `qa-${a.id}`;

// The pinned actions and the Actions entry (id "quick-actions") share 1 button of the bars: the group
// "quick-actions". Its menu shows Actions (it opens the list), a line (the section "pinned"), then the actions.
const GROUP = "quick-actions";
const OPEN_ID = "quick-actions";

/** The panels.json entry of a pinned action. */
const panelEntry = (a) => ({
  id: panelId(a), label: a.name || "Action", icon: `mods/quick-actions/${a.icon}.svg`, opens: "command", run: `quick-actions.run-${a.id}`,
  group: GROUP, section: "pinned",
});

/**
 * The Actions entry is always in the group: with no pinned action, the bars draw a group of 1 command as a plain
 * button (it opens the list at once), with the same button id.
 */
const openEntry = (e) => (e.group === GROUP ? e : { ...e, group: GROUP });

/**
 * Makes the `qa-<id>` entries of dock/panels.json match the pinned actions: an entry keeps its place, a new one
 * goes at the end, the entry of an action that is not pinned goes away. The Actions entry (id "quick-actions")
 * is always in their group. Other entries do not change. No file (no Dock layout): nothing.
 * Returns true when it wrote the file.
 */
export async function syncPanels(list) {
  for (let i = 0; i < 3; i++) {
    const text = await readTextFile(panelsPath());
    if (text == null) return false;
    let json;
    try { json = JSON.parse(text); } catch { throw new Error("dock/panels.json is not valid JSON."); }
    const panels = Array.isArray(json?.panels) ? json.panels : [];
    const want = new Map(list.filter((a) => a.pinned).map((a) => [panelId(a), panelEntry(a)]));
    const next = [];
    for (const e of panels) {
      const own = typeof e?.id === "string" && e.id.startsWith("qa-");
      if (e?.id === OPEN_ID) next.push(openEntry(e));
      else if (!own) next.push(e);
      else if (want.has(e.id)) { next.push(want.get(e.id)); want.delete(e.id); }
    }
    next.push(...want.values());
    const out = `${JSON.stringify({ ...json, panels: next }, null, 2)}\n`;
    if (out === text || JSON.stringify(next) === JSON.stringify(panels)) return false;
    try {
      await writeTextFile(panelsPath(), out, text);
      return true;
    } catch (e) {
      if (i === 2) throw e;
    }
  }
  return false;
}

/** Writes the panels.json ids of this mod that the bars must leave out (only when they changed). */
export function setHidden(ids) {
  const cur = shared(KEY.hidden);
  const all = cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {};
  const mine = Array.isArray(all[MOD]) ? all[MOD] : [];
  if (mine.length === ids.length && mine.every((x, i) => x === ids[i])) return;
  setShared(KEY.hidden, { ...all, [MOD]: ids });
}

const slash = (p) => String(p ?? "").replace(/\\/g, "/");
export const dataDir = () => `${slash(appHome())}/data`;
export const listPath = () => `${dataDir()}/quick-actions.json`;
export const runsDir = () => `${dataDir()}/quick-actions/runs`;
export const runLogPath = () => `${dataDir()}/quick-actions/run-log.json`;

export const newId = (prefix = "") => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// The icons that an action can have (files of this mod).
// The shells of an action. "auto": the shell of the terminal; for a script file, its extension.
export const SHELLS = ["auto", "ps", "bash", "python", "node"];
export const SHELL_LABEL = { auto: "Auto", ps: "PowerShell", bash: "bash", zsh: "zsh", sh: "sh", fish: "fish", dash: "dash", ksh: "ksh", python: "Python", node: "Node.js" };

export const ICONS = ["zap", "play", "terminal", "refresh", "download", "package", "git-branch", "sparkles", "code", "gear", "globe", "server", "file-terminal", "folder", "trash"];

/** A new action with every field. */
export function blank() {
  return {
    id: newId("q"),
    name: "",
    icon: "zap",
    source: "inline", // "inline" (script is the text) | "file" (file is the path of a script)
    script: "",
    file: "",
    where: "terminal", // "terminal" (the focused terminal; a new tab when it is busy) | "tab" (always a new tab) | "background" (no terminal on the screen)
    confirm: false, // ask before the run
    filter: "", // folders and repository names, separated by commas; empty: everywhere
    pinned: false, // an item of the Actions menu in the bar of the Dock and Kanban layouts
    shell: "auto", // see SHELLS
    updatedAt: Date.now(),
  };
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : "");

/** Fills the missing fields of an action from blank(). */
export function normalize(a) {
  const b = blank();
  if (!isObj(a)) return b;
  return {
    ...b,
    ...a,
    id: typeof a.id === "string" && /^[a-z0-9-]{1,24}$/.test(a.id) ? a.id : b.id,
    name: str(a.name),
    icon: ICONS.includes(a.icon) ? a.icon : "zap",
    source: a.source === "file" ? "file" : "inline",
    script: str(a.script),
    file: str(a.file),
    where: a.where === "tab" || a.where === "background" ? a.where : "terminal",
    confirm: a.confirm === true,
    filter: str(a.filter),
    pinned: a.pinned === true,
    shell: SHELLS.includes(a.shell) ? a.shell : "auto",
  };
}

export async function ensureDir(dir) {
  try { await fs.mkdir(dir, { recursive: true }); } catch { /* it exists */ }
}

/** Reads the list: { list, text }. A broken file gives { list: null, error }. */
export async function loadList() {
  const text = await readTextFile(listPath());
  if (text == null) return { list: [], text: null };
  let json;
  try { json = JSON.parse(text); } catch (e) { return { list: null, text, error: `quick-actions.json: ${e?.message ?? e}` }; }
  const raw = Array.isArray(json?.actions) ? json.actions : [];
  return { list: raw.map(normalize), text };
}

/** Changes the list with `change(list) => list`, on the newest file. Returns the new list. */
export async function updateList(change) {
  await ensureDir(dataDir());
  for (let i = 0; i < 3; i++) {
    const cur = await loadList();
    if (cur.list == null) throw new Error(cur.error);
    const list = change(cur.list.map((a) => ({ ...a })));
    const text = `${JSON.stringify({ actions: list }, null, 2)}\n`;
    try {
      await writeTextFile(listPath(), text, cur.text);
      setShared(KEY.rev, Date.now());
      return list;
    } catch (e) {
      if (i === 2) throw e;
    }
  }
  return null;
}

/** The mods-hub turned this mod off. */
export const kitOff = () => { const v = shared(KEY.disabled); return Array.isArray(v) && v.includes(MOD); };

/** True when the Keybinds mod is not turned off in PowerMods. */
export const keybindsEnabled = () => {
  const v = shared(KEY.disabled);
  return !(Array.isArray(v) && v.includes("keybinds"));
};

/** Formats a chord like "ctrl-shift-1" for the current OS. */
export function prettyKeyChord(chord) {
  const mac = window()?.platform === "macos";
  const modNames = mac
    ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", command: "⌘", platform: "⌘", super: "⌘", win: "⌘" }
    : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", command: "Super", platform: "Super", super: "Super", win: "Super" };
  return String(chord ?? "").trim().split(/\s+/).map((stroke) => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const mods = parts.map((m) => modNames[m.toLowerCase()] ?? m);
    const k = key && key.length === 1 ? key.toUpperCase() : key ? key[0].toUpperCase() + key.slice(1) : "";
    return [...mods, k].filter(Boolean).join(mac ? "" : "+");
  }).join(" ");
}

/** Bound shortcuts for a Quick Action (`quick-actions.run-<id>`), respecting Keybinds' macOS filter. */
export function actionShortcuts(actionId) {
  const target = `quick-actions.run-${actionId}`;
  const mac = window()?.platform === "macos";
  const showMac = shared("keybinds.showMac") === true;
  return (keys() ?? [])
    .filter((k) => k.action === target)
    .map((k) => String(k.keys ?? "").trim())
    .filter((c) => {
      if (!c) return false;
      if (!mac && !showMac && /(^|[- ])(cmd|command|platform|super|win)-/i.test(c)) return false;
      return true;
    })
    .map((c) => ({ raw: c, label: prettyKeyChord(c) }));
}

/** Adds the entry of a run to the run log, which keeps the last KEEP_LOG runs. A fault of the log stops nothing. */
export async function logRun(entry) {
  try {
    let list = [];
    try { list = JSON.parse((await readTextFile(runLogPath())) ?? "[]"); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    list.push(entry);
    await ensureDir(`${dataDir()}/quick-actions`);
    await fs.writeFile(runLogPath(), `${JSON.stringify(list.slice(-KEEP_LOG), null, 2)}\n`);
  } catch { /* only a log */ }
}

/** Writes a run file and deletes the oldest ones. Returns its path (forward slashes). */
export async function writeRunFile(name, ext, text) {
  const dir = runsDir();
  await ensureDir(dir);
  const slug = String(name || "action").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "action";
  const path = `${dir}/${Date.now().toString(36)}-${slug}.${ext}`;
  // A BOM: Windows PowerShell 5.1 reads a .ps1 without it in the code page of the system (accents break).
  await fs.writeFile(path, (ext === "ps1" ? "\uFEFF" : "") + String(text ?? ""));
  try {
    const files = (await fs.readdir(dir)).filter((f) => /^[0-9a-z]+-.+\.(ps1|sh|py|js|mjs|cjs)$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_RUNS))) await fs.unlink(`${dir}/${f}`).catch(() => null);
  } catch { /* the folder went away */ }
  return path;
}
