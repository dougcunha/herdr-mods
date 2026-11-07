// The Mods tab: reads ~/.config/herdr-app/mods/, tells where each mod comes
// from, and compares the files of the kit mods with the hashes of the last
// setup run.

import { appHome, readTextFile } from "herdr";
import * as fs from "fs/promises";
import { hashText, ignoredFile, binaryFile } from "./hash.js";

/** The third-party mods that SETUP-PROMPT.md installs, with their repositories. */
export const THIRD_PARTY = {
  "git-graph": "https://github.com/rabeeh-ta/herdr-git-graph",
  "markdown-reader": "https://github.com/kissmikijr/herdr-markdown-reader",
  "markdown-reader-pane": "https://github.com/kissmikijr/herdr-markdown-reader",
  insights: "https://github.com/GaganSD/coding-agent-toolkit/tree/main/herdr-insights",
};

const slashes = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");
export const modsDir = () => `${slashes(appHome())}/mods`;

async function readJson(path) {
  try {
    const text = await readTextFile(path);
    return text ? JSON.parse(text.replace(/^﻿/, "")) : null;
  } catch {
    return null;
  }
}

/** The entries of a folder: `[{ name, dir }]`. An unreadable folder gives []. */
async function entries(dir) {
  let list;
  try {
    list = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of list) {
    if (typeof e === "string") {
      // No file types: a folder is an entry that readdir can read.
      let isDir = false;
      try { await fs.readdir(`${dir}/${e}`); isDir = true; } catch { /* a file */ }
      out.push({ name: e, dir: isDir });
    } else {
      out.push({ name: e.name, dir: e.isDirectory() });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The text files under `dir`, as paths with forward slashes, without the files that Herdr writes. */
async function listFiles(dir, prefix = "") {
  const out = [];
  for (const e of await entries(dir)) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (ignoredFile(rel)) continue;
    if (e.dir) out.push(...await listFiles(`${dir}/${e.name}`, rel));
    else if (!binaryFile(rel)) out.push(rel);
  }
  return out;
}

/**
 * The mods of `mods/`, sorted by name. Each is
 * `{ name, title, origin, app, description, readme, errors: [{file, text}] }`.
 * `origin`: "kit" (the mod has a kit.json, or the setup record lists it),
 * "herdr" (Herdr installed it: installed.json), "third" (a third-party mod of
 * the setup prompt) or "manual".
 */
export async function scanMods(record) {
  const home = slashes(appHome());
  const shipped = (await readJson(`${home}/installed.json`)) ?? {};
  const items = record?.items ?? {};
  const folders = (await entries(modsDir())).filter((e) => e.dir && !e.name.startsWith("."));
  const mods = await Promise.all(folders.map(async ({ name }) => {
    const dir = `${modsDir()}/${name}`;
    const [mod, kit, top] = await Promise.all([readJson(`${dir}/mod.json`), readJson(`${dir}/kit.json`), entries(dir)]);
    const errors = await Promise.all(top.filter((e) => !e.dir && e.name.endsWith(".error")).map(async (e) => {
      const text = (await readTextFile(`${dir}/${e.name}`).catch(() => "")) ?? "";
      return { file: e.name, text: String(text).trim().slice(0, 600) };
    }));
    const item = typeof items[name] === "string" ? items[name] : "";
    const origin = kit || item.endsWith("-app") ? "kit"
      : shipped[name] ? "herdr"
      : THIRD_PARTY[name] ? "third"
      : "manual";
    return {
      name,
      title: typeof mod?.title === "string" && mod.title ? mod.title : "",
      origin,
      app: (typeof kit?.app === "string" && kit.app) || (item.endsWith("-app") ? item : ""),
      description: typeof kit?.description === "string" ? kit.description : "",
      readme: (typeof kit?.readme === "string" && kit.readme) || THIRD_PARTY[name] || "",
      errors,
    };
  }));
  return mods.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Compares the files of mod `name` with `recorded` (`{path: hash}` from the
 * record). Resolves with `{ changed, missing, added }` (lists of paths), or
 * null when there is nothing to compare with.
 */
export async function checkChanges(name, recorded) {
  if (!recorded || typeof recorded !== "object" || !Object.keys(recorded).length) return null;
  const dir = `${modsDir()}/${name}`;
  const files = await listFiles(dir);
  const here = new Set(files);
  const changed = [], missing = [];
  for (const [path, hash] of Object.entries(recorded)) {
    if (!here.has(path)) { missing.push(path); continue; }
    const text = await readTextFile(`${dir}/${path}`).catch(() => null);
    if (text == null || hashText(text) !== hash) changed.push(path);
  }
  const added = files.filter((p) => !(p in recorded));
  return { changed, missing, added };
}
