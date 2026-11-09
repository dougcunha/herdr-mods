// The Node helper of the skill-bundles mod. The mod runs it with `node probe.mjs <json>`.
// The mod runtime has no SHA-256 and reads files only as text, so the hashes are made here.
//
// Input (argv[2], JSON): { project, clone, catalogRepo }
// Output (stdout, JSON):
//   lock        the "skills" object of <project>/skills-lock.json ({} when there is none)
//   lockError   the reason when the Lock is not valid JSON, else null
//   dirs        the skill folders of the project (.agents/skills, .claude/skills) with a SKILL.md
//   hashes      { skill: hash | null } for each Lock entry of the Catalog: the hash of its
//               folder in the clone, made in the same way as the Lock hash (null: not found)
//
// The hash is the one of computeSkillFolderHash in the `skills` CLI: SHA-256 of each file's
// path (relative, with "/") and bytes, sorted with localeCompare, without .git and
// node_modules. A Lock hash of 40 hex digits is a git tree hash: compare with
// `git rev-parse HEAD:<folder>`.
//
// Line endings: `npx skills` installs through git, so a text file gets the line endings of a
// git checkout (CRLF with core.autocrlf=true). A file of the clone that a tool wrote with other
// line endings is clean for git but has other bytes, and would show as outdated. So the hash
// reads each text file of the clone with the line endings that a checkout would give it
// (see checkoutEol).

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
function checkoutEol(clone) {
  const out = new Map();
  let autocrlf = "";
  try { autocrlf = execFileSync("git", ["-C", clone, "config", "--get", "core.autocrlf"], { encoding: "utf8" }).trim().toLowerCase(); } catch {}
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

/** The hash of a skill folder. With `eol` and `clone`, text files get their checkout line endings. */
async function folderHash(dir, clone, eol) {
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
  const { project, clone, catalogRepo } = JSON.parse(process.argv[2] ?? "{}");
  const result = { lock: {}, lockError: null, dirs: [], hashes: {} };

  try {
    const text = await readFile(join(project, "skills-lock.json"), "utf8");
    result.lock = JSON.parse(text).skills ?? {};
  } catch (e) {
    if (e.code !== "ENOENT") result.lockError = String(e.message ?? e);
  }

  const names = new Set();
  for (const sub of [[".agents", "skills"], [".claude", "skills"]]) {
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
        eol ??= checkoutEol(clone);
        result.hashes[name] = await folderHash(dir, clone, eol);
      }
    }
  }

  process.stdout.write(JSON.stringify(result));
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e));
  process.exit(1);
});
