// The version check of the Herdr mods: the SETUP-PROMPT.md on GitHub, the
// record that the last run of the prompt wrote, and the state that every
// copy of this mod shares.

import { appHome, readTextFile, writeTextFile, shared, setShared } from "herdr";

export const MOD = "mods-update";
export const REPO = "https://github.com/dougcunha/herdr-mods";
export const SOURCE = "https://raw.githubusercontent.com/dougcunha/herdr-mods/main/SETUP-PROMPT.md";

/** How often a copy downloads SETUP-PROMPT.md again. */
export const CHECK_EVERY = 6 * 60 * 60 * 1000;

const VERSION = /<!--\s*herdr-mods-setup-version:\s*(\d+)\s*-->/;
const START = "<!-- prompt-start -->";
const END = "<!-- prompt-end -->";

export const icon = (name) => `mods/${MOD}/${name}.svg`;

/** A path with forward slashes, for text that an agent reads. */
const slashes = (p) => String(p).replace(/\\/g, "/");

export const recordPath = () => `${slashes(appHome())}/data/herdr-mods-setup.json`;
export const promptPath = () => `${slashes(appHome())}/data/herdr-mods-setup-prompt.md`;

/**
 * Reads SETUP-PROMPT.md. `version`: the number in the
 * `<!-- herdr-mods-setup-version: N -->` line (null if the line is missing).
 * `prompt`: the text between `<!-- prompt-start -->` and
 * `<!-- prompt-end -->`, without the code fence around it (null if a marker
 * is missing).
 */
export function parseSetup(text) {
  const t = String(text ?? "").replace(/\r\n/g, "\n");
  const m = t.match(VERSION);
  const version = m ? Number(m[1]) : null;
  const start = t.indexOf(START);
  const end = start < 0 ? -1 : t.indexOf(END, start + START.length);
  if (start < 0 || end < 0) return { version, prompt: null };
  const lines = t.slice(start + START.length, end).trim().split("\n");
  const fence = lines[0]?.match(/^(`{3,}|~{3,})/)?.[1];
  if (fence) {
    lines.shift();
    if (lines.length && lines[lines.length - 1].trim() === fence) lines.pop();
  }
  const prompt = lines.join("\n").trim();
  return { version, prompt: prompt ? prompt + "\n" : null };
}

/** Downloads SETUP-PROMPT.md and reads it. Rejects on a network error or a bad file. */
export async function download() {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const setup = parseSetup(await res.text());
  if (setup.version == null) throw new Error("SETUP-PROMPT.md has no version line");
  return setup;
}

/**
 * The version of the last run of the prompt on this machine: the `version`
 * of `data/herdr-mods-setup.json`. 0 when the file or the field is missing.
 */
export async function installedVersion() {
  try {
    const text = await readTextFile(recordPath());
    const v = text ? Number(JSON.parse(text).version) : 0;
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/** Writes the prompt to `data/herdr-mods-setup-prompt.md` and returns the path. */
export async function writePrompt(prompt) {
  const path = promptPath();
  const old = await readTextFile(path);
  await writeTextFile(path, prompt, old);
  return path;
}

/**
 * The state that every copy shares:
 * `remote` (the version on GitHub), `checkedAt` (ms), `error`,
 * `skipped` (a version that the person chose to skip) and `notified`
 * (the last version that got a toast).
 */
export const state = () => shared(MOD) ?? {};
export const setState = (patch) => setShared(MOD, { ...state(), ...patch });

/** True when GitHub has a version newer than the last run here and the person did not skip it. */
export function updateAvailable(local) {
  const { remote, skipped } = state();
  return remote != null && remote > local && remote !== skipped;
}
