// Turns kit mods off and on. The list of off mods is the shared key "herdr-mods.disabled" (mod folder names).
// The bars of the kit (tabs-dock, kanban) read it: they show no button of an off mod, hide its blocks in their
// layout and show Herdr's own mod in place of an off replacement mod (files-md, changes-split, space-deck). Each
// kit mod reads it too: while it is off, it draws nothing, closes its dialog and skips its timed work.
// Nothing is deleted: a mod that is on again shows its blocks and buttons again.

import { shared, setShared } from "herdr";

export const KEY_OFF = "herdr-mods.disabled";

/** The mods that cannot be turned off: they draw the bars of the layouts and this dialog. */
const FIXED = new Set(["mods-hub", "tabs-dock", "kanban"]);

/**
 * Mods with their own on/off setting: the switch writes that key, not the list. `off` is the value that turns
 * the mod off. agent-cards: tabs-dock shows Herdr's own agents list when the key is false.
 */
const OWN = { "agent-cards": { key: "agent-cards.enabled", off: false } };

/** The list of off mods. */
export function offList() {
  const v = shared(KEY_OFF);
  return Array.isArray(v) ? v.filter((n) => typeof n === "string") : [];
}

/** True when the Mods tab shows a switch for mod `m` (a row of scanMods). */
export function canTurnOff(m) {
  return m.origin === "kit" && !FIXED.has(m.name) && !m.partOf;
}

/** True when mod `m` is on. */
export function isOn(m) {
  const own = OWN[m.name];
  if (own) return shared(own.key) !== own.off;
  return !offList().includes(m.partOf || m.name);
}

/**
 * Turns mod `m` on or off. `mods` (all rows of scanMods) gives the parts of `m` (kit.json "partOf"), which go
 * on and off with it.
 */
export function setOn(m, on, mods) {
  const own = OWN[m.name];
  if (own) {
    setShared(own.key, on ? null : own.off);
    return;
  }
  const names = [m.name, ...mods.filter((x) => x.partOf === m.name).map((x) => x.name)];
  const list = offList().filter((n) => !names.includes(n));
  setShared(KEY_OFF, on ? (list.length ? list : null) : [...list, ...names]);
}
