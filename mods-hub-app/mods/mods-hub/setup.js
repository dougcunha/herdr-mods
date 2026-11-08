// The version check of PowerMods: the SETUP-PROMPT.md on GitHub, the
// record that the last run of the prompt wrote, and the state that every
// copy of this mod shares.

import { appHome, readTextFile, writeTextFile, shared, setShared } from "herdr";

export const MOD = "mods-hub";
/** The name of this mod before version 5 of the setup. Its shared state is read once. */
const OLD_MOD = "mods-update";
export const REPO = "https://github.com/dougcunha/herdr-mods";
const RAW = "https://raw.githubusercontent.com/dougcunha/herdr-mods/main";
export const SOURCE = `${RAW}/SETUP-PROMPT.md`;
/** The release notes of version `n`: `whats-new/<n>.md`. */
export const notesUrl = (n) => `${RAW}/whats-new/${n}.md`;
/** The README of an app folder of the repository (`git-dash-app`). */
export const readmeUrl = (app) => `${RAW}/${app}/README.md`;

/** The most versions that the "What's new" tab shows. */
export const MAX_NOTES = 10;

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
 * Downloads the release notes of version `n` (`whats-new/<n>.md`).
 * Resolves with the markdown text, or null when the file does not exist (404).
 * Rejects on a network error or another HTTP status.
 */
export async function downloadNotes(n) {
  const res = await fetch(notesUrl(n));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const text = String(await res.text()).replace(/\r\n/g, "\n").trim();
  return text || null;
}

/**
 * The versions that the "What's new" tab shows, newest first: the versions
 * after the last run here, up to the version on GitHub (at most MAX_NOTES).
 * When this machine has the newest version, only that version.
 */
export function noteVersions(local, remote) {
  if (remote == null || remote < 1) return [];
  const first = Math.max(local < remote ? local + 1 : remote, remote - MAX_NOTES + 1, 1);
  const out = [];
  for (let n = remote; n >= first; n--) out.push(n);
  return out;
}

/**
 * The version of the last run of the prompt on this machine: the `version`
 * of `data/herdr-mods-setup.json`. 0 when the file or the field is missing.
 */
export async function installedVersion() {
  const v = Number((await readRecord())?.version ?? 0);
  return Number.isFinite(v) ? v : 0;
}

/**
 * The record of the last setup run, `data/herdr-mods-setup.json`:
 * `{ repo, commit, version, date, items: {name: app folder}, files: {mod: {path: hash}} }`.
 * Null when the file is missing or is not valid JSON.
 */
export async function readRecord() {
  try {
    const text = await readTextFile(recordPath());
    const record = text ? JSON.parse(text.replace(/^﻿/, "")) : null;
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}

/**
 * Downloads the README of an app folder. Resolves with the markdown text, or
 * null on 404. Rejects on a network error or another HTTP status.
 */
export async function downloadReadme(app) {
  const res = await fetch(readmeUrl(app));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return String(await res.text()).replace(/\r\n/g, "\n");
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
 * `skipped` (a version that the person chose to skip), `notified`
 * (the last version that got a toast), `tab` (the last tab that the person
 * clicked) and `newsSeen` (the last version whose notes the dialog showed).
 * Before the first write, the state of the old `mods-update` mod is used.
 */
export const state = () => shared(MOD) ?? shared(OLD_MOD) ?? {};
export const setState = (patch) => setShared(MOD, { ...state(), ...patch });

/** True when GitHub has a version newer than the last run here and the person did not skip it. */
export function updateAvailable(local) {
  const { remote, skipped } = state();
  return remote != null && remote > local && remote !== skipped;
}
