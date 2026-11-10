// The Node helper of the skill-bundles mod. The mod runs it with `node probe.mjs <json>`.
// The mod runtime has no SHA-256 and reads files only as text, so the hashes are made here.
//
// Input (the last argument, JSON): { project, clone, catalogRepo, lockFile, autocrlf }
//   For a project on another machine, the mod runs this code there with
//   `node --input-type=module -e <code> <json>` (project only), then here with
//   `lockFile` (the Lock that it read there) and the clone.
// Output (stdout, JSON):
//   platform    process.platform of the machine that ran it
//   autocrlf    core.autocrlf in the project ("" when not set), with a project only
//   lock        the "skills" object of <project>/skills-lock.json ({} when there is none)
//   lockError   the reason when the Lock is not valid JSON, else null
//   dirs        the skill folders of the project (.agents/skills, .claude/skills) with a SKILL.md
//   hashes      { skill: hash | null } for each Lock entry of the Catalog: the hash of its
//               folder in the clone, made in the same way as the Lock hash (null: not found)
//
// The hash is the one of computeSkillFolderHash in the `skills` CLI. The CLI has 2 versions of
// it, and a Lock can have a hash of each version. The helper makes the hash of the current
// version first, and the hash of the old version only when the first one is not the Lock hash.
//
// Current version (skills 1.8 and later, hashV2): for each file, SHA-256 of its path (relative,
// with "/"), "\0", its length, "\0" and its bytes with CRLF changed to LF (not for a file with a
// 0 byte). The paths are sorted by their UTF-8 bytes. The hash skips metadata.json files and
// the .git, __pycache__ and __pypackages__ folders.
//
// Old version (hashV1): SHA-256 of each file's path and bytes, sorted with localeCompare,
// without .git and node_modules. `npx skills` installs through git, so a text file gets the
// line endings of a git checkout (CRLF with core.autocrlf=true). A file of the clone that a
// tool wrote with other line endings is clean for git but has other bytes. So hashV1 reads each
// text file of the clone with the line endings that a checkout would give it (see checkoutEol).
//
// A Lock hash of 40 hex digits is a git tree hash: compare with `git rev-parse HEAD:<folder>`.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

const SKIP = new Set([".git", "node_modules"]);

const slashed = (p) => p.split("\\").join("/");

/**
 * The line endings that a git checkout of the clone gives each text file:
 * Map<lower-case path relative to the clone, "crlf" | "lf">. Only files that git stores with
 * LF (i/lf) are in it: git does not convert the others, so their bytes are read as they are.
 * Empty when the clone is not a git repository.
 */
function checkoutEol(clone, given) {
  const out = new Map();
  let autocrlf = typeof given === "string" ? given : "";
  if (typeof given !== "string") {
    try { autocrlf = execFileSync("git", ["-C", clone, "config", "--get", "core.autocrlf"], { encoding: "utf8" }).trim().toLowerCase(); } catch {}
  }
  let list = "";
  try { list = execFileSync("git", ["-C", clone, "ls-files", "--eol", "-z"], { encoding: "utf8", maxBuffer: 64 << 20 }); } catch { return out; }
  for (const line of list.split("\0")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    // "i/lf w/crlf attr/text=auto eol=crlf": the attributes can be more than 1 word.
    const [index, , ...rest] = line.slice(0, tab).trim().split(/\s+/);
    if (index !== "i/lf") continue;
    const attrs = rest.join(" ").replace(/^attr\//, "").split(" ");
    const path = slashed(line.slice(tab + 1)).toLowerCase();
    if (attrs.includes("eol=crlf")) out.set(path, "crlf");
    else if (attrs.includes("eol=lf")) out.set(path, "lf");
    else if (attrs.includes("-text")) continue;
    else if (autocrlf === "true") out.set(path, "crlf");
  }
  return out;
}

/** The bytes with the line endings `eol` ("crlf" | "lf"). latin1 keeps every byte as it is. */
function withEol(content, eol) {
  const lf = content.toString("latin1").replace(/\r\n/g, "\n");
  return Buffer.from(eol === "crlf" ? lf.replace(/\n/g, "\r\n") : lf, "latin1");
}

async function collect(base, dir, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map(async (e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) await collect(base, full, out);
    } else if (e.isFile()) {
      out.push({ full, rel: slashed(relative(base, full)), content: await readFile(full) });
    }
  }));
}

const SKIP_V2_DIRS = new Set([".git", "__pycache__", "__pypackages__"]);

async function collectV2(base, dir, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map(async (e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_V2_DIRS.has(e.name)) await collectV2(base, full, out);
    } else if (e.isFile() && e.name !== "metadata.json") {
      out.push({ rel: slashed(relative(base, full)), content: await readFile(full) });
    }
  }));
}

/** CRLF to LF, as the `skills` CLI does. A file with a 0 byte stays as it is. */
function toLf(content) {
  if (content.includes(0) || !content.includes("\r\n")) return content;
  return Buffer.from(content.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
}

/** The hash of a skill folder, current version of the `skills` CLI. */
async function hashV2(dir) {
  const files = [];
  await collectV2(dir, dir, files);
  const entries = files.map((f) => ({ path: Buffer.from(f.rel, "utf8"), content: toLf(f.content) }));
  entries.sort((a, b) => Buffer.compare(a.path, b.path));
  const hash = createHash("sha256");
  for (const { path, content } of entries) {
    hash.update(path);
    hash.update("\0");
    hash.update(String(content.length));
    hash.update("\0");
    hash.update(content);
  }
  return hash.digest("hex");
}

/** The hash of a skill folder, old version. With `eol` and `clone`, text files get their checkout line endings. */
async function hashV1(dir, clone, eol) {
  const files = [];
  await collect(dir, dir, files);
  if (eol?.size) {
    for (const f of files) {
      const want = eol.get(slashed(relative(clone, f.full)).toLowerCase());
      if (want) f.content = withEol(f.content, want);
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(f.rel);
    hash.update(f.content);
  }
  return hash.digest("hex");
}

/** The folders with a SKILL.md under root, at most `depth` levels down. */
async function skillFolders(root, depth, out = [], dir = root) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) out.push(dir);
  if (depth <= 0) return out;
  for (const e of entries) {
    if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".")) await skillFolders(root, depth - 1, out, join(dir, e.name));
  }
  return out;
}

const sameRepo = (a, b) => String(a ?? "").split("#")[0].toLowerCase() === String(b ?? "").split("#")[0].toLowerCase();

async function main() {
  const { project, clone, catalogRepo, lockFile, autocrlf } = JSON.parse(process.argv[process.argv.length - 1] ?? "{}");
  const result = { platform: process.platform, lock: {}, lockError: null, dirs: [], hashes: {} };
  if (project) {
    // The core.autocrlf that `npx skills` uses on this machine (for a hash pass on another machine).
    try { result.autocrlf = execFileSync("git", ["-C", project, "config", "--get", "core.autocrlf"], { encoding: "utf8" }).trim().toLowerCase(); } catch { result.autocrlf = ""; }
  }

  if (lockFile) {
    result.lock = JSON.parse(await readFile(lockFile, "utf8")) ?? {};
  } else if (project) {
    try {
      const text = await readFile(join(project, "skills-lock.json"), "utf8");
      result.lock = JSON.parse(text).skills ?? {};
    } catch (e) {
      if (e.code !== "ENOENT") result.lockError = String(e.message ?? e);
    }
  }

  const names = new Set();
  for (const sub of project ? [[".agents", "skills"], [".claude", "skills"]] : []) {
    const dir = join(project, ...sub);
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      if ((e.isDirectory() || e.isSymbolicLink()) && existsSync(join(dir, e.name, "SKILL.md"))) names.add(e.name);
    }
  }
  result.dirs = [...names].sort();

  if (clone && existsSync(clone)) {
    // The Lock path ("skills/x/SKILL.md") can differ in case from the clone ("SKILLS/x").
    const byPath = new Map();
    const byName = new Map();
    let eol; // checkoutEol(clone), made at the first folder hash
    for (const dir of await skillFolders(clone, 4)) {
      const rel = relative(clone, dir).split("\\").join("/");
      byPath.set(rel.toLowerCase(), dir);
      if (!byName.has(basename(dir).toLowerCase())) byName.set(basename(dir).toLowerCase(), dir);
    }
    for (const [name, entry] of Object.entries(result.lock)) {
      if (!sameRepo(entry.source, catalogRepo)) continue;
      const key = entry.skillPath ? dirname(String(entry.skillPath)).split("\\").join("/").toLowerCase() : "";
      const dir = byPath.get(key) ?? byName.get(name.toLowerCase());
      if (!dir) { result.hashes[name] = null; continue; }
      const old = String(entry.computedHash ?? entry.skillFolderHash ?? "");
      if (/^[0-9a-f]{40}$/i.test(old)) {
        const rel = relative(clone, dir).split("\\").join("/");
        try {
          result.hashes[name] = execFileSync("git", ["-C", clone, "rev-parse", `HEAD:${rel}`], { encoding: "utf8" }).trim();
        } catch { result.hashes[name] = null; }
      } else {
        // The current version first. An old Lock hash gets the old version.
        const now = await hashV2(dir);
        if (now === old) { result.hashes[name] = now; continue; }
        eol ??= checkoutEol(clone, autocrlf);
        const before = await hashV1(dir, clone, eol);
        result.hashes[name] = before === old ? before : now;
      }
    }
  }

  process.stdout.write(JSON.stringify(result));
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e));
  process.exit(1);
});
