#!/usr/bin/env node
// link-skills.mjs: the skills of a project as links to a clone of a skill Catalog.
// One file, no dependencies. The words are the ones of CONTEXT.md of skill-bundles-app.
//
// A Catalog is a Git repository with a bundles.yaml at its root. A project names its Bundles
// in skills.yaml (the Manifest). This script makes, for each skill, one link in each agent
// folder of the project (.agents/skills, .claude/skills, .windsurf/skills) that points to the
// folder of the skill in the clone: a directory junction on Windows, a symbolic link on
// macOS and Linux. It hides the links from Git in .git/info/exclude. That block is also the
// record of the links that this script made: it never removes a link that is not in it.
//
// In a terminal (from a project, with this file in the clone of the Catalog):
//   node <clone>/link-skills.mjs [--project <dir>] [--clone <dir>] [--dry-run]
// It links the Missing skills, changes the Copies of `npx skills` to links and removes the
// Stale links. It does not change a Conflict. A skill of `sources:` from a repository that is
// not the Catalog links to a clone of that repository in --sources (cloned when it is not there).
//
// The skill-bundles mod of the Herdr app runs it with one JSON argument:
//   { op: "catalog", clone }                     → { catalog, skills }
//   { op: "read", project, clone, catalogRepo, sourcesRoot, manifestText }  → the state (see read())
//   { op: "apply", project, clone, catalogRepo, sourcesRoot, link, remove, replace, deleteLocal, extra, repos, dropGitignore }
//   { op: "source", sourcesRoot, repo }          → { dir, url, exists }: the clone of another repository
//   { op: "list", dir }                          → { skills: [{ name, desc }] } of a clone
//   { op: "details", clone }                     → { catalog, skills: [{ name, desc, bundles }], orphans }
//   { op: "curate", clone, createBundle, assign, unassign, deleteBundle, deleteSkill }
//                                                → { changed, errors }: changes bundles.yaml (see curate())
//                                                → { linked, removed, converted, backedUp, errors }
// It prints JSON on stdout.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// The agent folders of a project. Codex, Cursor, GitHub Copilot and OpenCode read .agents/skills.
const AGENT_DIRS = [".agents/skills", ".claude/skills", ".windsurf/skills"];
// Folders that an older version of this script linked into. Its links there are removed on the next change.
const RETIRED_DIRS = [".codex/skills"];
const BACKUP_DIR = ".agents/skills-backup";
const BLOCK_START = "# >>> skill-bundles links (link-skills.mjs writes this block)";
const BLOCK_END = "# <<< skill-bundles links";
const WINDOWS = process.platform === "win32";
const SAFE_NAME = /^(?!\.+$)[\w.-]+$/;
// Where the skill-bundles mod of the Herdr app keeps the clones of other repositories.
const DEFAULT_SOURCES = join(os.homedir(), ".config", "herdr-app", "cache", "skill-bundles", "sources");

const slashed = (p) => String(p).split("\\").join("/");
/** An error with a stable code. A tool in another language shows its own text for the code (see `problems` of apply and curate). */
const fault = (code, text) => Object.assign(new Error(text), { code });
const git = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
const tryGit = (dir, args) => { try { return git(dir, args).trim(); } catch { return null; } };

// ---- bundles.yaml and skills.yaml ------------------------------------------------------------
// The parsers read line by line, with the patterns of Read-BundlesCatalog and
// Read-ProjectManifest of the old PowerShell scripts of the Catalog (docs/adr/0001).

const uncomment = (line) => line.replace(/#.*$/, "");
const unquote = (s) => s.trim().replace(/^["']+|["']+$/g, "");

/** bundles.yaml: { repo, bundles: [[name, skills]], descriptions: { name: text } }. */
export function parseCatalog(text) {
  let repo = null;
  const bundles = new Map();
  const descriptions = {};
  let current = null;
  let inSkills = false;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = uncomment(raw);
    if (!line.trim()) continue;
    let m;
    if ((m = /^repo:\s*(.+?)\s*$/i.exec(line))) { repo = unquote(m[1]); continue; }
    if ((m = /^\s{2}([\w-]+):\s*$/i.exec(line))) { current = m[1]; bundles.set(current, []); inSkills = false; continue; }
    if ((m = /^\s*description:\s*(.+?)\s*$/i.exec(line))) { if (current) descriptions[current] = unquote(m[1]); inSkills = false; continue; }
    if (/^\s*skills:\s*$/i.test(line)) { inSkills = true; continue; }
    if (inSkills && current && (m = /^\s*-\s*(.+?)\s*$/i.exec(line))) bundles.get(current).push(unquote(m[1]));
  }
  return { repo, bundles: [...bundles], descriptions };
}

/**
 * skills.yaml: { bundles: string[], skills: string[], sources: [{ repo, skills: string[] }] }.
 * `skills:` lists skills of the Catalog that are not in a Bundle of the project; `sources:` lists
 * skills by repository (the Catalog too, in older files).
 */
export function parseManifest(text) {
  const bundles = [];
  const skills = [];
  const sources = [];
  const inline = (list, into) => { for (const item of list.split(",")) if (unquote(item)) into.push(unquote(item)); };
  let current = null;
  let section = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = uncomment(raw);
    if (!line.trim()) continue;
    let m;
    // A list on one line: `bundles: [core, dotnet]`.
    if ((m = /^(bundles|skills):\s*\[(.*)\]\s*$/i.exec(line))) { inline(m[2], m[1].toLowerCase() === "bundles" ? bundles : skills); section = null; continue; }
    if (/^bundles:\s*$/i.test(line)) { section = "bundles"; continue; }
    if (/^skills:\s*$/i.test(line)) { section = "skills"; continue; }
    if (/^sources:\s*$/i.test(line)) { section = "sources"; continue; }
    if (/^[A-Za-z_][\w-]*\s*:/.test(line)) { section = null; continue; } // another key at the top
    if (section === "bundles" && (m = /^\s*-\s*(.+?)\s*$/i.exec(line))) { bundles.push(unquote(m[1])); continue; }
    if (section === "skills" && (m = /^\s*-\s*(.+?)\s*$/i.exec(line))) { skills.push(unquote(m[1])); continue; }
    if (section === "sources") {
      if ((m = /^\s*-\s*repo:\s*(.+?)\s*$/i.exec(line))) { if (current) sources.push(current); current = { repo: unquote(m[1]), skills: [] }; continue; }
      if (/^\s*skills:\s*$/i.test(line)) continue;
      if (current && (m = /^\s*-\s*(.+?)\s*$/i.exec(line))) current.skills.push(unquote(m[1]));
    }
  }
  if (current) sources.push(current);
  return { bundles, skills, sources };
}

/** "owner/name" of a repository text (a GitHub URL too), in lower case, without "#branch" and ".git". */
function repoKey(value) {
  const s = String(value ?? "").trim().split("#")[0].replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = /(?:github\.com[:/])?([\w.-]+\/[\w.-]+)$/i.exec(s);
  return (m ? m[1] : s).toLowerCase();
}
const sameRepo = (a, b) => repoKey(a) === repoKey(b);

// ---- the clone -------------------------------------------------------------------------------

const SKIP = new Set([".git", "node_modules"]);

/** The folders with a SKILL.md under root, at most `depth` levels down. */
function skillFolders(root, depth, out = [], dir = root) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) out.push(dir);
  if (depth <= 0) return out;
  for (const e of entries) {
    if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".")) skillFolders(root, depth - 1, out, join(dir, e.name));
  }
  return out;
}

/** The skills of a clone: Map<name, folder>. */
function cloneSkills(clone) {
  const skills = new Map();
  for (const dir of skillFolders(clone, 4)) {
    if (dir !== clone && !skills.has(basename(dir))) skills.set(basename(dir), dir);
  }
  return skills;
}

/** The Catalog of a clone: { catalog, skills: Map<name, folder>, error }. */
function readClone(clone) {
  if (!clone) return { catalog: null, skills: new Map(), error: null };
  let text;
  try { text = fs.readFileSync(join(clone, "bundles.yaml"), "utf8"); } catch { return { catalog: null, skills: new Map(), error: `${slashed(clone)}/bundles.yaml was not found.` }; }
  return { catalog: parseCatalog(text), skills: cloneSkills(clone), error: null };
}

/**
 * The clone of a repository that is not the Catalog (a Source of another repository):
 * { dir, url, exists }. It is in `sourcesRoot`, in "<owner>/<name>" (a safe name for another URL).
 */
function sourceClone(sourcesRoot, repo) {
  // The text comes from a skills.yaml that another person can write. It goes to `git clone` and
  // into a path: no option (a leading "-"), no "." or ".." part, no space or shell character.
  const given = String(repo ?? "").trim().split("#")[0];
  if (!/^[\w.@:/~+-]+$/.test(given) || given.startsWith("-") || given.split(/[/:]/).some((part) => part === "." || part === ".." || part.startsWith("-"))) {
    return { dir: null, url: null, exists: false, error: `"${given}" is not a repository of skills (owner/name or a Git URL).` };
  }
  const key = repoKey(repo);
  const slug = /^[\w.-]+\/[\w.-]+$/.test(key);
  const dir = join(sourcesRoot, slug ? key : key.replace(/[^\w.-]+/g, "_"));
  const text = String(repo ?? "").trim().split("#")[0];
  const url = /^[\w.-]+\/[\w.-]+$/.test(text) ? `https://github.com/${text}.git` : text;
  return { dir, url, exists: fs.existsSync(join(dir, ".git")) };
}

/**
 * The clones that a project can link to: the Catalog and the clones of `sourcesRoot`.
 * `of(repo)` gives { dir, skills } of the clone of a repository, or null when it is not cloned.
 */
function clonesOf({ clone, catalogRepo, sourcesRoot }) {
  const { catalog, skills, error } = readClone(clone);
  // A bundles.yaml without `repo:` takes the name that the caller gives (the setting of the mod).
  if (catalog && !catalog.repo) catalog.repo = catalogRepo || null;
  const cache = new Map();
  const of = (repo) => {
    if (catalog && sameRepo(repo, catalog.repo)) return { dir: clone, skills };
    if (!sourcesRoot || !repo) return null;
    const key = repoKey(repo);
    if (!cache.has(key)) {
      const s = sourceClone(sourcesRoot, repo);
      cache.set(key, s.dir && s.exists ? { dir: s.dir, skills: cloneSkills(s.dir) } : null);
    }
    return cache.get(key);
  };
  return { catalog, error, of };
}

/** The repository of a folder in a clone: "owner/name" of its `origin`, or null. */
function repoOfFolder(folder) {
  const url = tryGit(folder, ["remote", "get-url", "origin"]);
  return url ? repoKey(url) : null;
}

/** The skills of a clone with the description of each SKILL.md: [{ name, desc }]. */
function listSkills(dir) {
  const out = [];
  for (const [name, folder] of cloneSkills(dir)) {
    let desc = "";
    try {
      const m = /^description:\s*(.+?)\s*$/im.exec(fs.readFileSync(join(folder, "SKILL.md"), "utf8").slice(0, 4000));
      if (m) desc = unquote(m[1]);
    } catch {}
    out.push({ name, desc });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- hashes of a skill folder (to know if a Copy of `npx skills` has changes) ------------------
// hashV2 is computeSkillFolderHash of the `skills` CLI 1.8 and later; hashV1 is the old one.

function files(base, skipDirs, skipFile, dir = base, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (!skipDirs.has(e.name)) files(base, skipDirs, skipFile, full, out); }
    else if (e.isFile() && e.name !== skipFile) out.push({ rel: slashed(relative(base, full)), content: fs.readFileSync(full) });
  }
  return out;
}

function hashV2(dir) {
  const toLf = (c) => (c.includes(0) || !c.includes("\r\n") ? c : Buffer.from(c.toString("latin1").replaceAll("\r\n", "\n"), "latin1"));
  const entries = files(dir, new Set([".git", "__pycache__", "__pypackages__"]), "metadata.json").map((f) => ({ path: Buffer.from(f.rel, "utf8"), content: toLf(f.content) }));
  entries.sort((a, b) => Buffer.compare(a.path, b.path));
  const hash = createHash("sha256");
  for (const { path, content } of entries) { hash.update(path); hash.update("\0"); hash.update(String(content.length)); hash.update("\0"); hash.update(content); }
  return hash.digest("hex");
}

function hashV1(dir) {
  const list = files(dir, SKIP, null).sort((a, b) => a.rel.localeCompare(b.rel));
  const hash = createHash("sha256");
  for (const f of list) { hash.update(f.rel); hash.update(f.content); }
  return hash.digest("hex");
}

/** True when a real skill folder has no changes of the person: it is the Lock version or the clone version. */
function unchanged(dir, lockEntry, target) {
  try {
    const now = hashV2(dir);
    const old = String(lockEntry?.computedHash ?? lockEntry?.skillFolderHash ?? "");
    if (old && (now === old || hashV1(dir) === old)) return true;
    return Boolean(target) && now === hashV2(target);
  } catch { return false; }
}

// ---- the project -----------------------------------------------------------------------------

const real = (p) => { try { const r = fs.realpathSync.native(p); return WINDOWS ? r.toLowerCase() : r; } catch { return null; } };
const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };

/** One entry of an agent folder: { kind: "none" | "link" | "dir" | "file", to: the real path of a link's target (null: broken) }. */
function entryAt(path) {
  const st = lstat(path);
  if (!st) return { kind: "none" };
  if (st.isSymbolicLink()) return { kind: "link", to: real(path) };
  return { kind: st.isDirectory() ? "dir" : "file" };
}

/** The path of .git/info/exclude (a worktree shares it with its repository), or null without Git. */
function excludePath(project) {
  const p = tryGit(project, ["rev-parse", "--git-path", "info/exclude"]);
  return p ? (isAbsolute(p) ? p : resolve(project, p)) : null;
}

/** The exclude block: { path, text, links: Set<"/.agents/skills/x">, extra: Set<name>, backup }. */
function readBlock(project) {
  const path = excludePath(project);
  const block = { path, text: "", links: new Set(), extra: new Set(), backup: false };
  if (!path) return block;
  try { block.text = fs.readFileSync(path, "utf8"); } catch {}
  let inside = false;
  for (const raw of block.text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === BLOCK_START) { inside = true; continue; }
    if (line === BLOCK_END) { inside = false; continue; }
    if (!inside || !line) continue;
    const extra = /^#\s*extra\s+(\S+)$/.exec(line);
    if (extra) block.extra.add(extra[1]);
    else if (line === `/${BACKUP_DIR}/`) block.backup = true;
    else if (!line.startsWith("#")) block.links.add(line);
  }
  return block;
}

function writeBlock(block) {
  if (!block.path) return;
  const nl = block.text.includes("\r\n") ? "\r\n" : "\n";
  const kept = [];
  let inside = false;
  for (const raw of block.text.split(/\r?\n/)) {
    if (raw.trim() === BLOCK_START) { inside = true; continue; }
    if (raw.trim() === BLOCK_END) { inside = false; continue; }
    if (!inside) kept.push(raw);
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  const lines = [...[...block.extra].sort().map((n) => `# extra ${n}`), ...[...block.links].sort(), ...(block.backup ? [`/${BACKUP_DIR}/`] : [])];
  const out = lines.length ? [...kept, ...(kept.length ? [""] : []), BLOCK_START, ...lines, BLOCK_END] : kept;
  const text = out.join(nl) + (out.length ? nl : "");
  if (text === block.text) return;
  fs.mkdirSync(dirname(block.path), { recursive: true });
  fs.writeFileSync(block.path, text);
  block.text = text;
}

const linkLine = (sub, name) => `/${sub}/${name}`;

/** The skill names that Git tracks under the agent folders of the project. */
function trackedNames(project) {
  const out = new Set();
  const list = tryGit(project, ["ls-files", "-z", "--", ...AGENT_DIRS]);
  for (const f of (list ?? "").split("\0")) {
    const name = f.split("/")[2];
    if (name) out.add(name);
  }
  return out;
}

const OLD_GITIGNORE_MARKER = "# Artefatos gerados por `npx skills add`";
const OLD_GITIGNORE_LINES = new Set([".agents/", ".claude/skills/", ".codex/skills/", "skills-lock.json"]);

/**
 * The state of a project.
 * Returns { platform, git, manifest, catalog, catalogError, unknown, rows, lockError, lockOther, oldGitignore }.
 * A row: { name, state, repo, from: [Bundle | "sources"], tracked }.
 *   state: "linked" | "missing" | "stale" | "copy" | "conflict" | "absent" | "unsupported" | "extra" | "local"
 */
function read({ project, clone, catalogRepo = null, sourcesRoot = null, manifestText = undefined }) {
  const result = { platform: process.platform, git: Boolean(excludePath(project)), manifest: null, catalog: null, catalogError: null, unknown: [], rows: [], lockError: null, lockOther: 0, oldGitignore: false, retired: 0 };
  const clones = clonesOf({ clone, catalogRepo, sourcesRoot });
  const { catalog, error } = clones;
  result.catalog = catalog;
  result.catalogError = error;
  const repo = catalog?.repo ?? "";

  // `manifestText`: the text of a skills.yaml that is not written yet (a preview of a change); null: no Manifest.
  if (manifestText !== undefined) result.manifest = manifestText === null ? null : parseManifest(manifestText);
  else try { result.manifest = parseManifest(fs.readFileSync(join(project, "skills.yaml"), "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  let lock = {};
  try { lock = JSON.parse(fs.readFileSync(join(project, "skills-lock.json"), "utf8")).skills ?? {}; } catch (e) { if (e.code !== "ENOENT") result.lockError = String(e.message ?? e); }
  try {
    const lines = fs.readFileSync(join(project, ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
    result.oldGitignore = lines.some((l) => l.startsWith(OLD_GITIGNORE_MARKER)) || [...OLD_GITIGNORE_LINES].every((l) => lines.includes(l));
  } catch {}

  const block = readBlock(project);
  const tracked = trackedNames(project);
  const cloneRoot = clone ? real(clone) : null;
  // The links of this tool in a folder that it no longer uses: the next change removes them.
  result.retired = [...block.links].filter((line) => RETIRED_DIRS.some((dir) => line.startsWith(`/${dir}/`)) && lstat(join(project, line))?.isSymbolicLink()).length;

  // What the Manifest asks for: Map<skill, { repo, from }>.
  const required = new Map();
  const want = (source, skill, from) => {
    const r = required.get(skill);
    if (r) { if (!r.from.includes(from)) r.from.push(from); } else required.set(skill, { repo: source, from: [from] });
  };
  if (result.manifest && catalog) {
    const bundles = new Map(catalog.bundles);
    for (const b of result.manifest.bundles) {
      if (!bundles.has(b)) { result.unknown.push(b); continue; }
      for (const s of bundles.get(b)) want(repo, s, b);
    }
  }
  if (catalog) for (const s of result.manifest?.skills ?? []) want(repo, s, "sources");
  for (const src of result.manifest?.sources ?? []) for (const s of src.skills) want(src.repo, s, "sources");

  // What is in the project: Map<name, [entry of each agent folder]>.
  const found = new Map();
  for (const [i, sub] of AGENT_DIRS.entries()) {
    let names = [];
    try { names = fs.readdirSync(join(project, sub)); } catch {}
    for (const name of names) {
      const e = entryAt(join(project, sub, name));
      if (e.kind === "file" || (e.kind === "dir" && !fs.existsSync(join(project, sub, name, "SKILL.md")))) continue;
      if (!found.has(name)) found.set(name, AGENT_DIRS.map(() => ({ kind: "none" })));
      e.own = e.kind === "link" && block.links.has(linkLine(sub, name));
      found.get(name)[i] = e;
    }
  }

  const none = AGENT_DIRS.map(() => ({ kind: "none" }));
  // The repository of a Lock entry. A wizard that installed from a folder of the Clone wrote that
  // folder as the source (type "local"): such a copy is a copy of the Catalog.
  const lockSource = (entry) => {
    if (!entry?.source) return null;
    if (entry.sourceType !== "local" || !cloneRoot) return entry.source;
    const at = real(resolve(project, entry.source));
    return at && (at === cloneRoot || at.startsWith(cloneRoot + sep)) ? repo : entry.source;
  };

  // The state of a skill, and the repository that it comes from: [state, repo].
  const stateOf = (name, wanted) => {
    const entries = found.get(name) ?? none;
    const hasDir = entries.some((e) => e.kind === "dir");
    if (wanted) {
      const from = clones.of(wanted.repo);
      if (!from) return [repo && sameRepo(wanted.repo, repo) ? "absent" : "unsupported", wanted.repo];
      const target = from.skills.get(name);
      const to = target ? real(target) : null;
      if (!to) return ["absent", wanted.repo];
      if (hasDir) return [lock[name] && !tracked.has(name) ? "copy" : "conflict", wanted.repo];
      if (entries.some((e) => e.kind === "link" && !e.own && e.to !== to)) return ["conflict", wanted.repo];
      return [entries.every((e) => e.kind === "link" && e.to === to) ? "linked" : "missing", wanted.repo];
    }
    if (hasDir) {
      const source = lockSource(lock[name]);
      if (!source) return ["local", ""];
      const from = clones.of(source);
      if (!from) return ["unsupported", source];
      return [from.skills.has(name) && !tracked.has(name) ? "copy" : "local", source];
    }
    const links = entries.filter((e) => e.kind === "link");
    if (links.some((e) => !e.own)) return ["local", ""];
    // An Extra skill: every link points to one skill folder that is still there.
    const to = links[0].to;
    const good = Boolean(to) && links.every((e) => e.to === to) && fs.existsSync(join(to, "SKILL.md"));
    // A target in the Clone of the Catalog is of the Catalog, also when the `origin` of that clone has another name.
    const inCatalog = good && cloneRoot && (to === cloneRoot || to.startsWith(cloneRoot + sep));
    const from = good && !inCatalog ? repoOfFolder(to) ?? repo : repo;
    // Without a Catalog to compare with, a link of this tool is never Stale: nothing is offered for removal.
    if (!catalog) return ["extra", from];
    return [good && (block.extra.has(name) || !result.manifest) ? "extra" : "stale", from];
  };

  for (const [name, w] of required) {
    const [state, from] = stateOf(name, w);
    result.rows.push({ name, state, repo: from, from: w.from, tracked: tracked.has(name) });
  }
  for (const name of [...found.keys()].sort()) {
    if (required.has(name)) continue;
    const [state, from] = stateOf(name, null);
    result.rows.push({ name, state, repo: from, from: [], tracked: tracked.has(name) });
  }
  result.lockOther = Object.values(lock).filter((e) => !clones.of(lockSource(e))).length;
  return result;
}

// ---- changes ---------------------------------------------------------------------------------

/** Removes a link (never what it points to). */
function unlink(path) {
  if (!lstat(path)?.isSymbolicLink()) throw fault("not_a_link", `${slashed(path)} is not a link.`);
  try { fs.unlinkSync(path); } catch { fs.rmdirSync(path); }
}

function makeLink(target, path) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.symlinkSync(target, path, WINDOWS ? "junction" : "dir");
}

/** Moves a real folder to the Backup. Returns the new path. */
function backup(project, path, name) {
  const dir = join(project, BACKUP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  let to = join(dir, name);
  for (let i = 2; fs.existsSync(to); i++) to = join(dir, `${name}-${i}`);
  fs.renameSync(path, to);
  return to;
}

/**
 * Changes a project. Each list has skill names; the script reads the state again and skips a
 * name whose state does not allow the change.
 *   link         Missing skills and Copies: make the links.
 *   remove       Stale and Extra skills: remove their links.
 *   replace      Conflicts: move the real folders to the Backup (remove foreign links), then link.
 *   deleteLocal  Local skills: delete their real folders, remove their links.
 *   extra        names that are Extra on purpose (kept when the Manifest does not ask for them).
 *   repos        { name: repository } for a new skill of `link` that is not of the Catalog.
 *   convert      true: change every Copy to a link, also the ones that `link` does not name.
 *   dropGitignore  true: remove the old block of `npx skills` from .gitignore.
 */
function apply(input) {
  const { project, clone, dryRun = false } = input;
  // errors: English texts. problems: the same errors as { code, name, text }, for a tool in another language.
  const done = { linked: [], removed: [], converted: [], backedUp: [], deleted: [], retired: [], errors: [], problems: [] };
  const state = read({ ...input, manifestText: undefined }); // a change works on the files as they are
  if (!state.git) throw new Error(`${slashed(project)} is not in a Git repository.`);
  const rows = new Map(state.rows.map((r) => [r.name, r]));
  const clones = clonesOf(input);
  // The folder of a skill in the clone of its repository: `repos` (a new skill), else the row, else the Catalog.
  const targetOf = (name) => clones.of(input.repos?.[name] ?? rows.get(name)?.repo ?? clones.catalog?.repo)?.skills.get(name);
  const block = readBlock(project);
  let lock = null;
  let lockText = null;
  try { lockText = fs.readFileSync(join(project, "skills-lock.json"), "utf8"); lock = JSON.parse(lockText); } catch {}
  const names = (list) => [...new Set(list ?? [])].filter((n) => SAFE_NAME.test(n));
  const report = (code, name, text) => { done.errors.push(`${name}: ${text}`); done.problems.push({ code, name, text }); };
  const attempt = (name, work) => { try { if (!dryRun) work(); return true; } catch (e) { report(e.code && !/^E[A-Z]+$/.test(e.code) ? e.code : "io", name, String(e.message ?? e)); return false; } };

  const linkOne = (name, force) => {
    const target = targetOf(name);
    if (!target) throw fault("not_in_clone", "the clone does not have this skill.");
    const to = real(target);
    const entry = lock?.skills?.[name];
    for (const sub of AGENT_DIRS) {
      const path = join(project, sub, name);
      const e = entryAt(path);
      if (e.kind === "link") {
        if (e.to === to) { block.links.add(linkLine(sub, name)); continue; }
        if (!force && !block.links.has(linkLine(sub, name)) && rows.get(name)?.state !== "copy") throw fault("foreign_link", `${sub}/${name} is a link that this tool did not make.`);
        unlink(path);
      }
    }
    // The links are gone first: an `npx skills` install links .claude/skills/x to .agents/skills/x.
    for (const sub of AGENT_DIRS) {
      const path = join(project, sub, name);
      const e = entryAt(path);
      if (e.kind === "dir") {
        if (!force && unchanged(path, entry, target)) fs.rmSync(path, { recursive: true, force: true });
        else { backup(project, path, name); block.backup = true; if (!done.backedUp.includes(name)) done.backedUp.push(name); }
      } else if (e.kind === "file") throw fault("is_file", `${sub}/${name} is a file.`);
      if (entryAt(path).kind === "none") makeLink(target, path);
      block.links.add(linkLine(sub, name));
    }
    if (entry) delete lock.skills[name];
  };

  const copies = input.convert === false ? [] : state.rows.filter((r) => r.state === "copy").map((r) => r.name);
  for (const name of names([...(input.link ?? []), ...copies])) {
    const st = rows.get(name)?.state;
    if (st !== "missing" && st !== "copy" && st !== "extra" && st !== "stale" && !(st === undefined && targetOf(name))) continue;
    if (!attempt(name, () => linkOne(name, false))) continue;
    (st === "copy" ? done.converted : done.linked).push(name);
    // A Copy that the Manifest does not ask for was installed on purpose: its link is an Extra skill.
    if (st === "copy" && !rows.get(name).from.length) block.extra.add(name);
  }
  for (const name of names(input.replace)) {
    if (rows.get(name)?.state !== "conflict") continue;
    if (attempt(name, () => linkOne(name, true))) done.linked.push(name);
  }
  for (const name of names(input.extra)) block.extra.add(name);
  for (const name of names(input.remove)) {
    const st = rows.get(name)?.state;
    if (st !== "stale" && st !== "extra") continue;
    const ok = attempt(name, () => {
      for (const sub of AGENT_DIRS) {
        const path = join(project, sub, name);
        if (block.links.has(linkLine(sub, name)) && entryAt(path).kind === "link") unlink(path);
        block.links.delete(linkLine(sub, name));
      }
      block.extra.delete(name);
    });
    if (ok) done.removed.push(name);
  }
  for (const name of names(input.deleteLocal)) {
    if (rows.get(name)?.state !== "local") continue;
    const ok = attempt(name, () => {
      for (const sub of AGENT_DIRS) {
        const path = join(project, sub, name);
        const e = entryAt(path);
        if (e.kind === "link") unlink(path);
        else if (e.kind === "dir") fs.rmSync(path, { recursive: true, force: true });
        block.links.delete(linkLine(sub, name));
      }
    });
    if (ok) done.deleted.push(name);
  }
  // The links of this tool in the folders that it no longer uses (.codex/skills).
  for (const line of [...block.links]) {
    const dir = RETIRED_DIRS.find((d) => line.startsWith(`/${d}/`));
    if (!dir) continue;
    const path = join(project, line);
    const ok = attempt(line, () => {
      if (lstat(path)?.isSymbolicLink()) unlink(path);
      block.links.delete(line);
      try { fs.rmdirSync(join(project, dir)); fs.rmdirSync(dirname(join(project, dir))); } catch {} // only when empty
    });
    if (ok) done.retired.push(line.slice(1));
  }
  if (dryRun) return done;

  // A name that the Manifest asks for is not Extra.
  for (const r of state.rows) if (r.from.length) block.extra.delete(r.name);
  writeBlock(block);

  // The Lock keeps only the skills that are still copies. An empty Lock is deleted (not a tracked one).
  if (lock && lockText !== null) {
    const path = join(project, "skills-lock.json");
    if (Object.keys(lock.skills ?? {}).length) {
      const text = JSON.stringify(lock, null, 2) + "\n";
      if (JSON.stringify(JSON.parse(lockText)) !== JSON.stringify(lock)) fs.writeFileSync(path, text);
    } else if (tryGit(project, ["ls-files", "--", "skills-lock.json"])) {
      report("lock_tracked", "skills-lock.json", "it is empty now, but Git tracks it. Delete it with git rm.");
    } else fs.rmSync(path, { force: true });
  }

  // The state file of an older terminal tool of a Catalog (.colibri-skills.json): the skills that are
  // links now leave it, and an empty file is deleted (with its lock file).
  const statePath = join(project, ".colibri-skills.json");
  try {
    const state0 = JSON.parse(fs.readFileSync(statePath, "utf8"));
    let changed = false;
    for (const name of [...done.linked, ...done.converted]) if (state0?.skills?.[name]) { delete state0.skills[name]; changed = true; }
    if (changed && Object.keys(state0.skills).length) fs.writeFileSync(statePath, JSON.stringify(state0, null, 2) + "\n");
    else if (changed && !tryGit(project, ["ls-files", "--", ".colibri-skills.json"])) { fs.rmSync(statePath, { force: true }); fs.rmSync(`${statePath}.lock`, { force: true }); }
  } catch {}

  if (input.dropGitignore) {
    const path = join(project, ".gitignore");
    try {
      const text = fs.readFileSync(path, "utf8");
      const nl = text.includes("\r\n") ? "\r\n" : "\n";
      const lines = text.split(/\r?\n/);
      const at = lines.findIndex((l) => l.trim().startsWith(OLD_GITIGNORE_MARKER));
      const kept = lines.filter((l, i) => !(OLD_GITIGNORE_LINES.has(l.trim()) || (at >= 0 && (i === at || (i === at + 1 && l.trim().startsWith("#"))))));
      while (kept.length > 1 && !kept[kept.length - 1].trim() && !kept[kept.length - 2].trim()) kept.pop();
      fs.writeFileSync(path, kept.join(nl));
    } catch (e) { report("io", ".gitignore", String(e.message ?? e)); }
  }
  return done;
}

// ---- the Catalog: which skill is in which Bundle -----------------------------------------------

const CATALOG_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * The skills of a clone for its curation: { catalog, skills: [{ name, desc, bundles }], orphans, error }.
 * An orphan is a skill folder that no Bundle lists.
 */
function catalogDetails(clone) {
  const { catalog, error } = readClone(clone);
  if (!catalog) return { catalog: null, skills: [], orphans: [], error };
  const skills = listSkills(clone).map((s) => ({ ...s, bundles: catalog.bundles.filter(([, names]) => names.includes(s.name)).map(([b]) => b) }));
  return { catalog, skills, orphans: skills.filter((s) => !s.bundles.length).map((s) => s.name), error: null };
}

/**
 * Changes bundles.yaml of a clone line by line, so that its comments and its order stay.
 *   createBundle  [{ name, description }]   a new Bundle at the end, with no skills
 *   assign        [{ skill, bundle }]       adds the skill to the Bundle
 *   unassign      [{ skill, bundle }]       takes the skill out of the Bundle
 *   deleteBundle  [name]                    removes the Bundle (not its skill folders; not core)
 *   deleteSkill   [name]                    deletes the skill folder and takes it out of every Bundle
 * It commits nothing: the person reviews the clone and commits.
 * Returns { changed, errors, problems } (see the top of the function).
 */
function curate(input) {
  const { clone } = input;
  // changed: [{ action, skill, bundle }] with action "create" | "assign" | "unassign" | "delete_bundle" | "delete_skill".
  // errors: English texts. problems: the same errors as { code, name, text }.
  const done = { changed: [], errors: [], problems: [] };
  const path = join(clone, "bundles.yaml");
  const before = fs.readFileSync(path, "utf8");
  const nl = before.includes("\r\n") ? "\r\n" : "\n";
  let lines = before.split(/\r?\n/);
  const skills = cloneSkills(clone);
  // A name goes into a pattern: only a valid Bundle name is looked for.
  const header = (name) => (CATALOG_NAME.test(name ?? "") ? lines.findIndex((l) => new RegExp(`^  ${name}:\\s*$`).test(uncomment(l))) : -1);
  // The lines of a Bundle: [its header, the line after its last one).
  const span = (at) => {
    let end = at + 1;
    while (end < lines.length && !/^ {0,2}\S/.test(lines[end])) end++;
    while (end > at + 1 && !lines[end - 1].trim()) end--; // the blank lines before the next Bundle stay
    return [at, end];
  };
  const skillsLine = (at, end) => { for (let i = at + 1; i < end; i++) if (/^\s*skills:/i.test(uncomment(lines[i]))) return i; return -1; };
  const items = (at, end) => { const out = []; const from = skillsLine(at, end); for (let i = from + 1; from >= 0 && i < end; i++) { const m = /^(\s*)-\s*(.+?)\s*$/.exec(uncomment(lines[i])); if (m) out.push({ i, name: unquote(m[2]), indent: m[1] }); } return out; };
  const fail = (code, name, text) => { done.errors.push(`${name}: ${text}`); done.problems.push({ code, name: String(name), text }); };

  for (const b of input.createBundle ?? []) {
    if (!CATALOG_NAME.test(b?.name ?? "")) { fail("bad_bundle_name", b?.name, 'a Bundle name has lower-case letters, digits, "-" and "_".'); continue; }
    if (header(b.name) >= 0) { fail("bundle_exists", b.name, "this Bundle is there already."); continue; }
    const description = String(b.description ?? "").replace(/[\r\n]+/g, " ").trim() || b.name;
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push("", `  ${b.name}:`, `    description: ${JSON.stringify(description)}`, "    skills: []", "");
    done.changed.push({ action: "create", bundle: b.name });
  }
  for (const a of input.assign ?? []) {
    const at = header(a?.bundle ?? "");
    if (at < 0) { fail("no_bundle", a?.bundle, "no such Bundle."); continue; }
    if (!skills.has(a.skill)) { fail("no_skill", a.skill, "the clone has no skill folder with this name."); continue; }
    const [, end] = span(at);
    const list = items(at, end);
    if (list.some((x) => x.name === a.skill)) continue;
    const from = skillsLine(at, end);
    if (from < 0) { fail("no_skills_line", a.bundle, 'no "skills:" line.'); continue; }
    if (list.length) lines.splice(list[list.length - 1].i + 1, 0, `${list[0].indent}- ${a.skill}`);
    else { lines[from] = lines[from].replace(/skills:.*$/i, "skills:"); lines.splice(from + 1, 0, `${/^\s*/.exec(lines[from])[0]}  - ${a.skill}`); }
    done.changed.push({ action: "assign", skill: a.skill, bundle: a.bundle });
  }
  const takeOut = (skill, bundle) => {
    const at = header(bundle);
    if (at < 0) return false;
    const [, end] = span(at);
    const list = items(at, end);
    const found = list.find((x) => x.name === skill);
    if (!found) return false;
    lines.splice(found.i, 1);
    // An empty block list is null in YAML: write an empty list.
    if (list.length === 1) { const from = skillsLine(at, end - 1); lines[from] = lines[from].replace(/skills:.*$/i, "skills: []"); }
    return true;
  };
  for (const u of input.unassign ?? []) if (takeOut(u?.skill, u?.bundle)) done.changed.push({ action: "unassign", skill: u.skill, bundle: u.bundle });
  for (const name of input.deleteBundle ?? []) {
    if (name === "core") { fail("core_stays", "core", "this Bundle is in every project and stays."); continue; }
    const at = header(name);
    if (at < 0) { fail("no_bundle", name, "no such Bundle."); continue; }
    const [, end] = span(at);
    lines.splice(at, end - at);
    while (at > 0 && at < lines.length && !lines[at - 1].trim() && !lines[at].trim()) lines.splice(at, 1);
    done.changed.push({ action: "delete_bundle", bundle: name });
  }
  for (const name of input.deleteSkill ?? []) {
    const folder = skills.get(name);
    if (!SAFE_NAME.test(name ?? "") || !folder) { fail("no_skill", name, "the clone has no skill folder with this name."); continue; }
    if (!lstat(folder)?.isDirectory() || lstat(folder).isSymbolicLink() || !real(folder)?.startsWith(real(clone) + sep)) { fail("not_plain_folder", name, "its folder is not a plain folder of the clone."); continue; }
    for (const [bundle] of parseCatalog(lines.join("\n")).bundles) takeOut(name, bundle);
    try { fs.rmSync(folder, { recursive: true, force: true }); done.changed.push({ action: "delete_skill", skill: name }); } catch (e) { fail("io", name, String(e.message ?? e)); }
  }
  const after = lines.join(nl);
  if (after !== before && !input.dryRun) fs.writeFileSync(path, after);
  return done;
}

// ---- entry -----------------------------------------------------------------------------------

function cli(args) {
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const here = dirname(fileURLToPath(import.meta.url));
  const clone = resolve(opt("--clone") ?? here);
  const start = resolve(opt("--project") ?? process.cwd());
  const project = tryGit(start, ["rev-parse", "--show-toplevel"]);
  const dryRun = args.includes("--dry-run");
  if (args.includes("--help") || args.includes("-h")) {
    console.log("node link-skills.mjs [--project <dir>] [--clone <dir>] [--sources <dir>] [--dry-run]\nLinks the skills of skills.yaml of a project to a clone of the skill Catalog.\n--sources: where the clones of other repositories (sources: in skills.yaml) are kept. Default: " + slashed(DEFAULT_SOURCES));
    return;
  }
  if (!project) { console.error(`${start} is not in a Git repository.`); process.exit(1); }
  const sourcesRoot = resolve(opt("--sources") ?? DEFAULT_SOURCES);
  let state = read({ project, clone, sourcesRoot });
  if (state.catalogError) { console.error(`${state.catalogError} Give the clone of the Catalog with --clone.`); process.exit(1); }
  // A Source of another repository: clone that repository once.
  const cloneErrors = [];
  for (const repo of new Set(state.rows.filter((r) => r.state === "unsupported" && r.from.length).map((r) => r.repo))) {
    const s = sourceClone(sourcesRoot, repo);
    if (!s.dir) { cloneErrors.push(s.error); continue; }
    console.log(`${dryRun ? "[dry run] " : ""}git clone ${s.url} ${slashed(s.dir)}`);
    if (dryRun) continue;
    try { fs.mkdirSync(dirname(s.dir), { recursive: true }); execFileSync("git", ["clone", "--quiet", "--", s.url, s.dir], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" }); }
    catch (e) { cloneErrors.push(`${repo}: ${String(e.stderr || e.message).trim().split("\n").pop()}`); }
  }
  state = read({ project, clone, sourcesRoot });
  const of = (st) => state.rows.filter((r) => r.state === st).map((r) => r.name);
  const done = apply({ project, clone, sourcesRoot, link: of("missing"), remove: of("stale"), dryRun });
  done.errors.push(...cloneErrors);
  const say = (label, list) => { if (list.length) console.log(`${label}: ${list.join(", ")}`); };
  console.log(`${dryRun ? "[dry run] " : ""}${slashed(project)} → ${slashed(clone)}`);
  if (!state.manifest) console.log("No skills.yaml: nothing to link.");
  say("Linked", done.linked);
  say("Copies changed to links", done.converted);
  say(`Moved to ${BACKUP_DIR}`, done.backedUp);
  say("Links removed", done.removed);
  say("Links removed from folders that are not used anymore", done.retired);
  say("Conflict (a folder of the project has this name; not changed)", of("conflict"));
  say("Not in the clone", of("absent"));
  say("From a repository that is not cloned", of("unsupported"));
  say("Errors", done.errors);
  if (!done.linked.length && !done.converted.length && !done.removed.length && !done.retired.length && !done.errors.length) console.log("Nothing to do.");
  if (done.errors.length) process.exit(1);
}

function main() {
  const last = process.argv[process.argv.length - 1] ?? "";
  if (!last.startsWith("{")) return cli(process.argv.slice(2));
  const input = JSON.parse(last);
  let out;
  if (input.op === "catalog") {
    const { catalog, skills, error } = readClone(input.clone);
    out = { catalog, skills: [...skills.keys()], error };
  } else if (input.op === "read") out = read(input);
  else if (input.op === "source") out = sourceClone(input.sourcesRoot, input.repo);
  else if (input.op === "list") out = { skills: listSkills(input.dir) };
  else if (input.op === "details") out = catalogDetails(input.clone);
  else if (input.op === "curate") out = curate(input);
  else if (input.op === "apply") out = apply(input);
  else throw new Error(`unknown op: ${input.op}`);
  process.stdout.write(JSON.stringify(out));
}

try { main(); } catch (e) {
  process.stderr.write(String(e?.message ?? e));
  process.exit(1);
}
