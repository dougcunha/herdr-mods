// The Mods tab: reads ~/.config/herdr-app/mods/, tells where each mod comes
// from, compares the files of the kit and third-party mods with the hashes of
// the last setup run, and asks GitHub (once a day) for the last commit of each
// installed third-party mod.

import { appHome, readTextFile } from "herdr";
import * as fs from "fs/promises";
import { hashText, ignoredFile, binaryFile } from "./hash.js";
import { cleanFields } from "./fields.js";
import { THIRD_PARTY, thirdUrl, thirdIgnored } from "./third.js";
import { state, setState } from "./setup.js";

export { THIRD_PARTY };

/** How often the third-party mods are checked on GitHub. */
export const THIRD_EVERY = 24 * 60 * 60 * 1000;

/**
 * The last commit that changed the folder of third-party mod `name` on the
 * default branch: `{ sha, date, title }`. 1 call to GitHub's public API, with
 * no token and nothing about the person. Rejects on a network or HTTP error.
 */
export async function latestCommit(name) {
  const m = THIRD_PARTY[name];
  const res = await fetch(`https://api.github.com/repos/${m.repo}/commits?path=${encodeURIComponent(m.path)}&per_page=1`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "herdr-mods-hub" },
  });
  if (res.status === 403 || res.status === 429) throw new Error("GitHub's rate limit; the next check tries again");
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const c = (await res.json())?.[0];
  if (!c?.sha) throw new Error("GitHub has no commit for this folder");
  return { sha: c.sha, date: c.commit?.committer?.date ?? c.commit?.author?.date ?? "", title: String(c.commit?.message ?? "").split("\n")[0] };
}

/**
 * Asks GitHub for the last commit of each installed third-party mod in `names`,
 * when the last check is older than THIRD_EVERY (or `force`). The result is in
 * the shared state `third`: `{ checkedAt, latest: {name: commit}, errors: {name: text} }`,
 * so every copy of the mod (status rows, dialog) reads 1 check. An error keeps
 * the last commit that is known. Resolves with true when it asked GitHub.
 */
export async function checkThird(names, force) {
  const now = Date.now(), third = state().third ?? {};
  if (!names.length) return false;
  if (!force && now - (third.checkedAt ?? 0) < THIRD_EVERY) return false;
  // Another copy started a check less than 1 minute ago: use its result.
  if (now - (third.startedAt ?? 0) < 60 * 1000) return false;
  setState({ third: { ...third, startedAt: now } });
  const latest = { ...(third.latest ?? {}) }, errors = {};
  await Promise.all(names.map(async (name) => {
    try { latest[name] = await latestCommit(name); }
    catch (e) { errors[name] = String(e?.message ?? e); }
  }));
  setState({ third: { checkedAt: Date.now(), startedAt: 0, latest, errors } });
  return true;
}

/** The names of the third-party mods that are installed (their folder has a mod.json). */
export async function installedThird() {
  const names = await Promise.all(Object.keys(THIRD_PARTY).map(async (n) =>
    (await readTextFile(`${modsDir()}/${n}/mod.json`).catch(() => null)) != null ? n : null));
  return names.filter(Boolean);
}

/**
 * The update state of third-party mod `name`: "unrecorded" (the setup did not
 * record its version), "unknown" (GitHub was not asked yet, or failed),
 * "update" (GitHub has a newer commit for its folder) or "current".
 */
export function thirdStatus(name, record) {
  const rec = record?.third?.[name], latest = state().third?.latest?.[name];
  if (!rec?.commit) return "unrecorded";
  if (!latest?.sha) return "unknown";
  if (latest.sha === rec.commit) return "current";
  return Date.parse(latest.date) > Date.parse(rec.date) ? "update" : "current";
}

/** The GitHub page that compares the recorded version of `name` with the newest. */
export function compareUrl(name, record) {
  const m = THIRD_PARTY[name], rec = record?.third?.[name], latest = state().third?.latest?.[name];
  return m && rec?.commit && latest?.sha ? `https://github.com/${m.repo}/compare/${rec.commit.slice(0, 12)}...${latest.sha.slice(0, 12)}` : "";
}

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
 * `{ name, title, origin, app, description, readme, settings, errors: [{file, text}] }`.
 * `settings`: the valid fields of the `settings` list of kit.json (see fields.js).
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
      readme: (typeof kit?.readme === "string" && kit.readme) || thirdUrl(name),
      settings: cleanFields(kit?.settings),
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
  // A file that the setup writes for this machine (insights' runtime.json) is never compared.
  const files = (await listFiles(dir)).filter((p) => !thirdIgnored(name, p));
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
