#!/usr/bin/env node
// Prints the hashes of the mod files of this repository as JSON:
// { "<mod>": { "<path in the mod folder>": "<hash>" } }
//
// The setup prompt runs it on the clone and writes the result for the
// installed mods to the `files` field of ~/.config/herdr-app/data/herdr-mods-setup.json.
// The mods-hub mod compares the installed files with these hashes.
//
// Usage: node tools/record-hashes.mjs [repository folder]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const { hashText, ignoredFile, binaryFile } = await import(
  pathToFileURL(join(repo, "mods-hub-app", "mods", "mods-hub", "hash.js")).href
);

/** The files under `dir`, as paths with forward slashes relative to `dir`. */
function files(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (ignoredFile(rel)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full, rel));
    else if (!binaryFile(rel)) out.push(rel);
  }
  return out;
}

const result = {};
for (const app of readdirSync(repo).filter((n) => n.endsWith("-app")).sort()) {
  const mods = join(repo, app, "mods");
  let names;
  try { names = readdirSync(mods); } catch { continue; }
  for (const mod of names.sort()) {
    const dir = join(mods, mod);
    if (!statSync(dir).isDirectory()) continue;
    result[mod] = {};
    for (const rel of files(dir)) result[mod][rel] = hashText(readFileSync(join(dir, rel), "utf8"));
  }
}
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
