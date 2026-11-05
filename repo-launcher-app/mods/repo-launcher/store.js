// The mod's saved state. Settings and the repository cache live in shared
// state (shared.json), so the list shows on the first frame of the popup
// without a file read.

import { shared, setShared, keys, appHome, readTextFile, writeTextFile, window } from "herdr";
import { normalize, pathKey } from "./scan.js";

export const MOD = "repo-launcher";
export const OPEN_ACTION = `mod.open:${MOD}`;

const SETTINGS = `${MOD}.settings`;
const CACHE = `${MOD}.cache`;
const SHORTCUT_STAMP = `${MOD}.shortcut-changed`;

const DEFAULTS = {
  roots: [],
  favorites: [],
  reuse: true,
  reuseMode: "tab", // "tab" | "split" | "go"
  args: {}, // agent key -> extra arguments
  accounts: [], // accounts a person added: { agent, dir, label }
  recent: {}, // path key -> time the repository was last opened
};

export function settings() {
  return { ...DEFAULTS, ...(shared(SETTINGS) ?? {}) };
}

export function updateSettings(change) {
  const next = { ...settings(), ...(typeof change === "function" ? change(settings()) : change) };
  setShared(SETTINGS, next);
  return next;
}

/** `{ repos: [{ path, name, root }], scannedAt, missing }`. */
export function cache() {
  return { repos: [], scannedAt: null, missing: [], ...(shared(CACHE) ?? {}) };
}

export function setCache(value) {
  setShared(CACHE, value);
}

export function isFavorite(path) {
  const key = pathKey(path);
  return settings().favorites.some((f) => pathKey(f) === key);
}

export function toggleFavorite(path) {
  const key = pathKey(path);
  updateSettings((s) => ({
    favorites: s.favorites.some((f) => pathKey(f) === key)
      ? s.favorites.filter((f) => pathKey(f) !== key)
      : [...s.favorites, normalize(path)],
  }));
}

export function markOpened(path) {
  updateSettings((s) => {
    // Keep the 50 most recent.
    const entries = Object.entries({ ...s.recent, [pathKey(path)]: Date.now() })
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50);
    return { recent: Object.fromEntries(entries) };
  });
}

export function lastOpened(path) {
  return settings().recent[pathKey(path)] ?? 0;
}

// ---------------------------------------------------------------------------
// The shortcut

/** The keys bound to open this mod, as keys.json spells them ("ctrl-p"). */
export function boundKeys() {
  return keys()
    .filter((k) => k.section === "global" && k.action === OPEN_ACTION)
    .map((k) => k.keys.trim())
    .filter(Boolean);
}

/** A key chord for people: "ctrl-shift-p" -> "Ctrl+Shift+P" (or "⌃⇧P" on macOS). */
export function prettyKeys(chord) {
  if (!chord) return "";
  const mac = window()?.platform === "macos";
  const names = mac
    ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" }
    : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd", platform: "cmd", control: "ctrl" };
  return chord.trim().split(/\s+/).map((stroke) => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") {
      key = "-";
      parts.pop();
    }
    const held = new Set(parts.map((m) => alias[m.toLowerCase()] ?? m.toLowerCase()));
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
    return [...Object.keys(names).filter((m) => held.has(m)).map((m) => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

/** The chord of a key event, as keys.json spells it, or null for a lone modifier. */
export function chordOf(event) {
  const key = event.key;
  if (!key || ["control", "shift", "alt", "platform", "function", "meta", "super", "cmd"].includes(key)) return null;
  const m = event.modifiers ?? {};
  const mods = [];
  if (m.control) mods.push("ctrl");
  if (m.alt) mods.push("alt");
  if (m.shift) mods.push("shift");
  if (m.platform) mods.push("cmd");
  if (mods.length === 0 && !/^f\d+$/.test(key)) return null; // a plain key would type text
  return [...mods, key.toLowerCase()].join("-");
}

/**
 * Tells the other mods that the shortcut changed. A change of keys.json does
 * not redraw the mods, but a change of shared state redraws all of them, so
 * the status bar item reads `keys()` again and shows the new keys.
 */
export function announceShortcut() {
  setShared(SHORTCUT_STAMP, Date.now());
}

/** The action that `chord` runs now in the global section, if any. */
export function actionOf(chord) {
  return keys().find((k) => k.section === "global" && k.keys.trim() === chord)?.action ?? null;
}

/**
 * Binds `chord` to open this mod, in the global section of keys.json.
 * Removes the old keys of this mod. A key that another action uses is
 * replaced only when `replace` is true.
 */
export async function bindShortcut(chord, replace = false) {
  const path = `${normalize(appHome())}/keys.json`;
  const before = await readTextFile(path);
  const data = before ? JSON.parse(before) : {};
  const global = { ...(data.global ?? {}) };
  if (global[chord] && global[chord] !== OPEN_ACTION && !replace) {
    throw new Error(`taken:${global[chord]}`);
  }
  for (const [k, action] of Object.entries(global)) {
    if (action === OPEN_ACTION) delete global[k];
  }
  global[chord] = OPEN_ACTION;
  data.global = global;
  await writeTextFile(path, JSON.stringify(data, null, 2) + "\n", before);
}
