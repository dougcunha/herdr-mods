// The `key` field of the Settings tab: the keys of keys.json that run an
// action, and a new key for it. The same logic as the shortcut of
// repo-launcher (store.js), with the action as a parameter.

import { keys, appHome, readTextFile, writeTextFile, window } from "herdr";

const slashes = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");

/** The keys of the global section that run `action`, as keys.json spells them ("ctrl-p"). */
export function boundKeys(action) {
  return keys()
    .filter((k) => k.section === "global" && k.action === action)
    .map((k) => k.keys.trim())
    .filter(Boolean);
}

/** The action that `chord` runs now in the global section, if any. */
export function actionOf(chord) {
  return keys().find((k) => k.section === "global" && k.keys.trim() === chord)?.action ?? null;
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

/** The chord of a key event, as keys.json spells it, or null for a lone modifier or a plain key. */
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
 * Binds `chord` to `action` in the global section of keys.json, and removes
 * every other key of that action (also the macOS key). A key that another
 * action uses is replaced only when `replace` is true; otherwise this
 * rejects with `taken:<action>`.
 */
export async function bindKey(action, chord, replace = false) {
  const path = `${slashes(appHome())}/keys.json`;
  const before = await readTextFile(path);
  const data = before ? JSON.parse(before) : {};
  const global = { ...(data.global ?? {}) };
  if (global[chord] && global[chord] !== action && !replace) throw new Error(`taken:${global[chord]}`);
  for (const [k, a] of Object.entries(global)) {
    if (a === action) delete global[k];
  }
  global[chord] = action;
  data.global = global;
  await writeTextFile(path, JSON.stringify(data, null, 2) + "\n", before);
}
