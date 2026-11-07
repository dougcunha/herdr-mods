#!/usr/bin/env node
// Records the version of an installed third-party mod for the update check of
// the mods-hub mod.
//
// It compares the installed folder with every commit of a clone of the mod's
// repository that changed the mod folder, and picks the commit with the fewest
// different files (the newest one on a tie). A file that the setup patched
// (an Esc patch) or that the person changed counts as different; it does not
// stop the match.
//
// The entry:
//   { repo, path, commit, date, title, differs: [paths], files: { path: hash }, recorded }
// commit/date/title: the commit that matched (the last commit that changed the
// mod folder in that version). differs: the files that are not the same as in
// that commit. files: the hashes of the installed files now (hash.js), so the
// mods-hub shows the files that change after this run.
//
// Usage:
//   node tools/record-third-party.mjs --name <mod> --clone <folder> [--write]
// --clone: a clone of the repository with its history (`git clone --filter=blob:none <url>`).
// --write: put the entry in `third.<mod>` of data/herdr-mods-setup.json. Run it
// after the setup writes that file. Without --write it prints the entry.
// The Herdr home is $HERDR_APP_HOME, else ~/.config/herdr-app.

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hub = join(repoRoot, "mods-hub-app", "mods", "mods-hub");
const { hashText, ignoredFile, binaryFile } = await import(pathToFileURL(join(hub, "hash.js")).href);
const { THIRD_PARTY, thirdIgnored } = await import(pathToFileURL(join(hub, "third.js")).href);

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const name = arg("--name"), clone = arg("--clone"), write = args.includes("--write");
const fail = (text) => { process.stderr.write(text + "\n"); process.exit(1); };
if (!name || !clone) fail("Usage: node tools/record-third-party.mjs --name <mod> --clone <folder> [--write]");
const mod = THIRD_PARTY[name];
if (!mod) fail(`Unknown third-party mod: ${name}. Known: ${Object.keys(THIRD_PARTY).join(", ")}`);

const appHome = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
const installed = join(appHome, "mods", name);
if (!existsSync(installed)) fail(`Not installed: ${installed}`);

const git = (...a) => execFileSync("git", ["-C", clone, ...a], { encoding: "utf8", maxBuffer: 1 << 26 });
const compared = (rel) => !ignoredFile(rel) && !binaryFile(rel) && !thirdIgnored(name, rel);

/** The files under `dir`, as paths with forward slashes relative to `dir`. */
function files(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...files(full, rel));
    else if (compared(rel)) out.push(rel);
  }
  return out;
}

// Git's hash of a file, from its bytes as they are and with CRLF made LF (a clone on Windows can have either).
const blob = (buf) => createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
const local = new Map(files(installed).map((rel) => {
  const buf = readFileSync(join(installed, rel));
  const lf = Buffer.from(buf.toString("binary").replace(/\r\n/g, "\n"), "binary");
  return [rel, new Set([blob(buf), blob(lf)])];
}));

const commits = git("log", "--format=%H%x09%cI%x09%s", "--", mod.path).trim().split("\n").filter(Boolean)
  .map((line) => { const [sha, date, ...title] = line.split("\t"); return { sha, date, title: title.join("\t") }; });
if (!commits.length) fail(`No commit of ${clone} changes ${mod.path}. Is it a clone of ${mod.repo} with its history?`);

let best = null;
for (const c of commits) {
  const tree = new Map();
  for (const line of git("ls-tree", "-r", c.sha, "--", `${mod.path}/`).split("\n").filter(Boolean)) {
    const [meta, path] = line.split("\t");
    const rel = path.slice(mod.path.length + 1);
    if (meta.split(" ")[1] === "blob" && compared(rel)) tree.set(rel, meta.split(" ")[2]);
  }
  const differs = new Set();
  for (const [rel, hashes] of local) if (!hashes.has(tree.get(rel))) differs.add(rel);
  for (const rel of tree.keys()) if (!local.has(rel)) differs.add(rel);
  if (!best || differs.size < best.differs.size) best = { ...c, differs };
  if (!differs.size) break;
}

const entry = {
  repo: mod.repo,
  path: mod.path,
  commit: best.sha,
  date: best.date,
  title: best.title,
  differs: [...best.differs].sort(),
  files: Object.fromEntries([...local.keys()].map((rel) => [rel, hashText(readFileSync(join(installed, rel), "utf8"))])),
  recorded: new Date().toISOString(),
};

if (!write) {
  process.stdout.write(JSON.stringify(entry, null, 2) + "\n");
} else {
  const file = join(appHome, "data", "herdr-mods-setup.json");
  let record = {};
  if (existsSync(file)) {
    try { record = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { fail(`Not valid JSON: ${file}`); }
  } else mkdirSync(dirname(file), { recursive: true });
  record.third = { ...(record.third ?? {}), [name]: entry };
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`${name}: ${entry.commit.slice(0, 7)} ${entry.date} (${entry.differs.length} file(s) differ${entry.differs.length ? `: ${entry.differs.join(", ")}` : ""})\n`);
}
