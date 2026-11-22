// The files and the shared keys of the mod.
//
// data/quick-actions.json       { "actions": [ <action> ] }: the list. People can edit the file by
//                               hand; every copy reads it again when shared("quick-actions.rev") changes.
// data/quick-actions/runs/      the run files: the expanded script of a run of 2 or more lines, or of a
//                               script file. The mod keeps the last KEEP_RUNS.

import { appHome, readTextFile, writeTextFile, shared, setShared } from "herdr";
import * as fs from "fs/promises";

export const MOD = "quick-actions";
export const KEEP_RUNS = 20;

export const KEY = {
  lang: "herdr-mods.lang",
  disabled: "herdr-mods.disabled",
  rev: "quick-actions.rev", // changes when a copy saves the list
  target: "quick-actions.target", // { terminal, space, tab }: the last terminal that had the focus (the runner writes it)
  runner: "quick-actions.runner", // { at }: the runner is on the screen
};

const slash = (p) => String(p ?? "").replace(/\\/g, "/");
export const dataDir = () => `${slash(appHome())}/data`;
export const listPath = () => `${dataDir()}/quick-actions.json`;
export const runsDir = () => `${dataDir()}/quick-actions/runs`;

export const newId = (prefix = "") => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// The icons that an action can have (files of this mod).
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
    where: "terminal", // "terminal" (the focused terminal; a new tab when it is busy) | "tab" (always a new tab)
    confirm: false, // ask before the run
    filter: "", // folders and repository names, separated by commas; empty: everywhere
    pinned: false, // a button in the bar of the Dock and Kanban layouts (phase 2)
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
    where: a.where === "tab" ? "tab" : "terminal",
    confirm: a.confirm === true,
    filter: str(a.filter),
    pinned: a.pinned === true,
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

/** Writes a run file and deletes the oldest ones. Returns its path (forward slashes). */
export async function writeRunFile(name, ext, text) {
  const dir = runsDir();
  await ensureDir(dir);
  const slug = String(name || "action").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "action";
  const path = `${dir}/${Date.now().toString(36)}-${slug}.${ext}`;
  await fs.writeFile(path, String(text ?? ""));
  try {
    const files = (await fs.readdir(dir)).filter((f) => /^[0-9a-z]+-.+\.(ps1|sh)$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_RUNS))) await fs.unlink(`${dir}/${f}`).catch(() => null);
  } catch { /* the folder went away */ }
  return path;
}
