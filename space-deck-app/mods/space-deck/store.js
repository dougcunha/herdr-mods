// What Space Deck keeps in shared() and how it names a space.
//
// A space gets a key from where it works: "<machine>|<folder>", with the
// top folder of its git repo when it is in one, else its live folder. The key
// stays the same when the space closes and opens again, so its icon, color,
// note and pin come back. Herdr gives a new id to a space that opens again.

import { shared, setShared, window } from "herdr";

export const KEYS = {
  spaces: "space-deck.spaces", // { [key]: { icon?, emoji?, color?, note?, activeAt? } }
  pins: "space-deck.pins", // [key], in the order of the Pinned section
  view: "space-deck.view", // "card" | "list"
  card: "space-deck.card", // { agents, tabs, git, folder, activity, note }: false hides a field
  gitEvery: "space-deck.gitEvery", // seconds
  needsYouFirst: "space-deck.needsYouFirst",
  recentCount: "space-deck.recentCount",
  colors: "space.colors", // Herdr's own: { [space id]: color }, read by the native mods
};

const isWindows = () => window().platform === "windows";

/** A folder in one form, to compare it: forward slashes, no trailing slash, lower case on Windows. */
export function normFolder(p) {
  const s = String(p || "").trim().replace(/\\/g, "/").replace(/([^:/])\/+$/, "$1");
  return isWindows() ? s.toLowerCase() : s;
}

export const keyOf = (machine, folder) => `${machine ?? ""}|${normFolder(folder)}`;

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

export function items() {
  const v = shared(KEYS.spaces);
  return isObject(v) ? v : {};
}

export const item = (key) => items()[key] ?? {};

/** Merges `patch` into the item of `key`. A null or "" value removes that field. */
export function setItem(key, patch) {
  const all = { ...items() };
  const next = { ...(all[key] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") delete next[k];
    else next[k] = v;
  }
  if (Object.keys(next).length) all[key] = next;
  else delete all[key];
  setShared(KEYS.spaces, all);
}

export function pins() {
  const v = shared(KEYS.pins);
  return Array.isArray(v) ? v.filter((k) => typeof k === "string") : [];
}

export const setPins = (list) => setShared(KEYS.pins, [...new Set(list)]);

/** Pins `key` at `index` (the end when no index), or moves it there. */
export function pinAt(key, index = null) {
  const list = pins().filter((k) => k !== key);
  list.splice(index === null ? list.length : Math.max(0, Math.min(index, list.length)), 0, key);
  setPins(list);
}

export const unpin = (key) => setPins(pins().filter((k) => k !== key));

export const view = () => (shared(KEYS.view) === "list" ? "list" : "card");

/** A card field is on unless the setting says false. */
export function cardField(name) {
  const v = shared(KEYS.card);
  return !(isObject(v) && v[name] === false);
}

export function gitEvery() {
  const n = Number(shared(KEYS.gitEvery));
  return Number.isFinite(n) && n > 0 ? Math.min(120, Math.max(5, n)) : 15;
}

export const needsYouFirst = () => shared(KEYS.needsYouFirst) === true;

export function recentCount() {
  const v = shared(KEYS.recentCount);
  const n = Number(v);
  return v != null && Number.isFinite(n) ? Math.min(20, Math.max(0, Math.round(n))) : 5;
}

/** Records activity of the space with `key` now (or at `at`), when it is newer than the stored time. */
export function touch(key, at = Date.now()) {
  if (!key) return;
  const old = item(key).activeAt ?? 0;
  if (at > old + 1000) setItem(key, { activeAt: at });
}

// The colors that a space can have. The names are the ones of Herdr's native
// Spaces sidebar, so `space.colors` means the same in both mods.
export const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
export const PALETTE = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1", "#e0b341", "#7d8796"];

/** The color to draw for a stored color name or hex value. */
export const fillOf = (color, t) => (String(color).startsWith("#") ? color : (MARK[color] ?? t[color] ?? MARK.ansi6));
