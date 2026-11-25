// Persistence and environment discovery for Keybinds:
// atomic keys.json reads/writes, keys.error polling, Quick Actions discovery,
// installed mod titles, and shared preferences.

import { appHome, readTextFile, writeTextFile, shared, setShared } from "herdr";
import * as fs from "fs/promises";
import { parseDocument, serializeDocument } from "./model.js";

export const MOD = "keybinds";

const slashes = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");

export const keysPath = () => `${slashes(appHome())}/keys.json`;
export const keysErrorPath = () => `${slashes(appHome())}/keys.error`;
export const quickActionsPath = () => `${slashes(appHome())}/data/quick-actions.json`;
export const modsDir = () => `${slashes(appHome())}/mods`;

/** True when PowerMods disabled this mod. */
export function kitOff() {
  const v = shared("herdr-mods.disabled");
  return Array.isArray(v) && v.includes(MOD);
}

/** Whether macOS-specific cmd-* bindings should be visible on non-macOS platforms. */
export function showMacPref() {
  return shared("keybinds.showMac") === true;
}

export function setShowMacPref(val) {
  setShared("keybinds.showMac", Boolean(val));
}

/** Reads keys.json and returns { raw, sections, parseError }. */
export async function loadKeysFile() {
  const raw = await readTextFile(keysPath());
  const { sections, parseError } = parseDocument(raw);
  return { raw, sections, parseError };
}

/** Writes keys.json atomically and notifies other mods that shortcuts changed. */
export async function saveKeysFile(sections, expectedRaw) {
  const nextRaw = serializeDocument(sections);
  await writeTextFile(keysPath(), nextRaw, expectedRaw);
  const hub = shared("mods-hub");
  setShared("mods-hub", { ...(hub && typeof hub === "object" ? hub : {}), keysChanged: Date.now() });
  setShared("keybinds.changed", Date.now());
  return { raw: nextRaw };
}

/** Writes raw JSON text directly (for Undo / Redo / Restore original). */
export async function saveRawKeysText(nextRaw, expectedRaw) {
  await writeTextFile(keysPath(), nextRaw, expectedRaw);
  const hub = shared("mods-hub");
  setShared("mods-hub", { ...(hub && typeof hub === "object" ? hub : {}), keysChanged: Date.now() });
  setShared("keybinds.changed", Date.now());
  return { raw: nextRaw };
}

/** Reads ~/.config/herdr-app/keys.error written by Herdr when a keys.json entry is rejected. */
export async function readKeysError() {
  try {
    const text = await readTextFile(keysErrorPath());
    const trimmed = String(text ?? "").trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/** Loads Quick Actions from data/quick-actions.json when the quick-actions mod is installed and enabled. */
export async function loadQuickActions() {
  const disabled = shared("herdr-mods.disabled");
  if (Array.isArray(disabled) && disabled.includes("quick-actions")) return [];
  const modJson = await readTextFile(`${modsDir()}/quick-actions/mod.json`).catch(() => null);
  if (modJson == null) return [];
  const text = await readTextFile(quickActionsPath()).catch(() => null);
  if (!text) return [];
  try {
    const json = JSON.parse(text);
    const list = Array.isArray(json?.actions) ? json.actions : [];
    return list
      .filter((a) => a && typeof a.id === "string" && a.id.trim())
      .map((a) => ({
        id: String(a.id),
        name: String(a.name ?? ""),
        icon: String(a.icon ?? "zap"),
        where: String(a.where ?? "terminal"),
        filter: String(a.filter ?? ""),
      }));
  } catch {
    return [];
  }
}

/** Discovers installed mods and their display titles from each mod's mod.json. */
export async function loadInstalledMods() {
  const names = [];
  const titles = {};
  let entries = [];
  try {
    entries = await fs.readdir(modsDir());
  } catch {
    return { names, titles };
  }
  for (const name of entries.sort()) {
    if (name.startsWith(".")) continue;
    const raw = await readTextFile(`${modsDir()}/${name}/mod.json`).catch(() => null);
    if (raw == null) continue;
    names.push(name);
    try {
      const json = JSON.parse(raw);
      if (json?.title) titles[name] = String(json.title);
    } catch { /* ignore malformed mod.json */ }
  }
  return { names, titles };
}
