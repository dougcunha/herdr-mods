// The programs that the mod runs (git, gh, node) and the Clone of the Catalog.
//
// The Clone is the only place with the skill files: a project gets links to it (see
// link-skills.mjs and docs/adr/0002). The mod keeps a clone of the Catalog in
// <appHome>/cache/skill-bundles/<owner>/<name> and brings it to the remote on a timer. A
// person can point the mod to a clone of their own instead (setting "skill-bundles.clone"):
// the mod then pulls it (fast-forward only) on the same timer, when it has no changes.
//
// A project in a space on another machine has its clones on that machine: a link must point
// to a folder of the same computer. Every function here takes `on`, the machine (null: this
// computer), and place(on) gives the folders of the mod there.

import { exec, appHome, window, readTextFile } from "herdr";
import { machineInfo, writeFileOn } from "./remote.js";

const isWindows = () => window()?.platform === "windows";
const slash = (p) => String(p ?? "").replace(/\\/g, "/");

/** A path with the separators of the platform, for a folder of space.new. */
export const native = (p) => (isWindows() ? slash(p).replace(/\//g, "\\") : slash(p));

/** Runs a program. Never throws: a program that cannot start gives code -1. */
export async function sh(cmd, args, opts = {}) {
  try {
    const r = await exec(cmd, args, opts);
    return { code: r.code, out: String(r.stdout ?? ""), err: String(r.stderr ?? "") };
  } catch (e) {
    return { code: -1, out: "", err: String(e?.message ?? e) };
  }
}

/** The last lines of a failed run, for a message. */
export function tail(r, lines = 6) {
  const text = `${r.err}\n${r.out}`.trim();
  return text.split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join("\n");
}

/** exec options on the machine `on` (null: this computer). */
const at = (on, opts = {}) => (on ? { ...opts, on } : opts);

/** The folder of this mod (the link script is in it). */
export const modDir = () => `${slash(appHome())}/mods/skill-bundles`;

const readOn = (path, on) => (on ? readTextFile(path, { on }) : readTextFile(path));

const places = new Map(); // machine → a promise of its place

/**
 * The folders of the mod on the machine `on` (null: this computer):
 * { on, appHome, cache, sourcesRoot, script, shared }.
 *   cache        where the mod keeps its clone of a Catalog: `${cache}/<owner>/<name>`
 *   sourcesRoot  the clones of the repositories that are not the Catalog
 *   script       link-skills.mjs. On another machine, the mod writes its copy into the cache there
 *                (once for each load of the mod, when the file there has another text).
 *   shared       the settings of the Herdr app of that machine (shared.json), {} when it has none
 */
export const forgetPlace = (on = null) => places.delete(on ?? "");

export function place(on = null) {
  const key = on ?? "";
  if (!places.has(key)) {
    const work = (async () => {
      const home = on ? `${(await machineInfo(on)).home}/.config/herdr-app` : slash(appHome());
      const cache = `${home}/cache/skill-bundles`;
      const p = { on, appHome: home, cache, sourcesRoot: `${cache}/sources`, script: `${modDir()}/link-skills.mjs`, shared: {} };
      if (!on) return p;
      p.script = `${cache}/link-skills.mjs`;
      const text = await readTextFile(`${modDir()}/link-skills.mjs`);
      if ((await readOn(p.script, on).catch(() => null)) !== text) {
        const made = await sh("node", ["-e", "require('fs').mkdirSync(process.argv[1], { recursive: true })", cache], { on });
        if (made.code !== 0) throw new Error(tail(made) || `node does not run on ${on}`);
        await writeFileOn(on, p.script, text);
        // 2 copies of the mod can write at the same time: the file must be whole before a run.
        if ((await readOn(p.script, on).catch(() => null)) !== text) throw new Error(`Could not write link-skills.mjs on ${on}. Try again.`);
      }
      try { p.shared = JSON.parse(await readOn(`${home}/shared.json`, on)) ?? {}; } catch {}
      return p;
    })();
    // A failed start (the machine was not reachable) is tried again on the next read.
    work.catch(() => places.delete(key));
    places.set(key, work);
  }
  return places.get(key);
}

/** "owner/name" from a setting, or null. Accepts a GitHub URL too. */
export function repoSlug(value) {
  const s = String(value ?? "").trim().replace(/\.git$/i, "");
  const m = /(?:github\.com[:/])?([\w.-]+)\/([\w.-]+)$/i.exec(s);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The git root of a folder on the machine `on` (null: this computer), or null. */
export async function gitRoot(folder, on = null) {
  if (!folder) return null;
  const r = await sh("git", ["-C", folder, "rev-parse", "--show-toplevel"], at(on));
  if (r.code === -1 && on) throw new Error(r.err || `${on} cannot be reached`);
  return r.code === 0 ? slash(r.out.trim()) : null;
}

const ghReady = new Map(); // machine → a promise: true when `gh auth status` passes (asked once per mod load)

/** True when gh is installed and logged in on the machine. */
export function hasGh(on = null) {
  const key = on ?? "";
  if (!ghReady.has(key)) ghReady.set(key, sh("gh", ["auth", "status"], at(on)).then((r) => r.code === 0));
  return ghReady.get(key);
}

/**
 * Clones the Catalog into the mod's folder when it is not there. Uses gh when it is logged in,
 * else git with `gitUrl` (default: the SSH URL of GitHub). Returns null, or an error text.
 */
export async function ensureClone(slug, dir, gitUrl, on = null) {
  if ((await readOn(`${dir}/bundles.yaml`, on).catch(() => null)) !== null) return null;
  const head = await sh("git", ["-C", dir, "rev-parse", "--git-dir"], at(on));
  if (head.code === 0) return `${dir} is a clone without bundles.yaml. Is ${slug} a Catalog?`;
  const r = (await hasGh(on)) && !gitUrl
    ? await sh("gh", ["repo", "clone", slug, dir], at(on))
    : await sh("git", ["clone", gitUrl || `git@github.com:${slug}.git`, dir], at(on));
  if (r.code !== 0) return tail(r);
  if ((await readOn(`${dir}/bundles.yaml`, on).catch(() => null)) === null) return `${slug} has no bundles.yaml at its root.`;
  return null;
}

/** Brings the mod's own clone to the newest commit of its default branch. Returns null or an error. */
export async function updateOwnClone(dir, on = null) {
  const f = await sh("git", ["-C", dir, "fetch", "--quiet", "--prune", "origin"], at(on));
  if (f.code !== 0) return tail(f);
  // origin/HEAD is set by the clone; a remote that changed its default branch needs it again.
  await sh("git", ["-C", dir, "remote", "set-head", "origin", "--auto"], at(on));
  const r = await sh("git", ["-C", dir, "reset", "--hard", "--quiet", "origin/HEAD"], at(on));
  return r.code === 0 ? null : tail(r);
}

/**
 * Fetches the person's own clone and brings its branch to the remote (fast-forward only). A
 * clone with changes that are not committed, or a branch with no upstream, is only fetched.
 * Returns null or an error.
 */
export async function pullOwnClone(dir, on = null) {
  const f = await sh("git", ["-C", dir, "fetch", "--quiet", "origin"], at(on));
  if (f.code !== 0) return tail(f);
  if ((await sh("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no"], at(on))).out.trim()) return null;
  const up = await sh("git", ["-C", dir, "rev-parse", "--abbrev-ref", "@{u}"], at(on));
  if (up.code !== 0) return null;
  const behind = await sh("git", ["-C", dir, "rev-list", "--count", "HEAD..@{u}"], at(on));
  if (!(Number(behind.out.trim()) > 0)) return null;
  const m = await sh("git", ["-C", dir, "merge", "--ff-only", "--quiet", "@{u}"], at(on));
  return m.code === 0 ? null : tail(m);
}

/** The short commit of a clone's HEAD, or "". */
export async function headCommit(dir, on = null) {
  const r = await sh("git", ["-C", dir, "rev-parse", "--short", "HEAD"], at(on));
  return r.code === 0 ? r.out.trim() : "";
}

/**
 * The state of the person's own clone: { branch, current, problem }. `branch` is set when the
 * clone is not on its default branch. `problem` says why the mod cannot pull it: "dirty"
 * (changes that are not committed), "ahead" or "unpushed" (not on the remote), "diverged".
 * The projects see the clone as it is, so a problem does not stop the links.
 */
export async function ownCloneRef(dir, on = null) {
  const cur = (await sh("git", ["-C", dir, "branch", "--show-current"], at(on))).out.trim();
  if (!cur) return { branch: null };
  const def = (await sh("git", ["-C", dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], at(on))).out.trim().replace(/^origin\//, "");
  const branch = def && def === cur ? null : cur;
  const dirty = (await sh("git", ["-C", dir, "status", "--porcelain"], at(on))).out.trim();
  if (dirty) return { branch, current: cur, problem: "dirty" };
  const remote = await sh("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${cur}`], at(on));
  if (remote.code !== 0) return branch ? { branch, current: cur, problem: "unpushed" } : { branch, current: cur };
  const count = await sh("git", ["-C", dir, "rev-list", "--left-right", "--count", `HEAD...refs/remotes/origin/${cur}`], at(on));
  const [ahead, behind] = count.out.trim().split(/\s+/).map(Number);
  if (ahead > 0) return { branch, current: cur, problem: behind > 0 ? "diverged" : "ahead" };
  return { branch, current: cur };
}

/**
 * The fixes of a clone problem (ownCloneRef), as git arguments. `current` is the branch of the
 * clone. Each fix runs in the clone folder.
 */
export const CLONE_FIXES = {
  stash: () => [["stash", "push", "--include-untracked", "-m", "skill-bundles: before the update of the Catalog"]],
  discard: () => [["reset", "--hard", "--quiet"], ["clean", "-fd", "--quiet"]],
  push: () => [["push", "--quiet"]],
  pushBranch: (current) => [["push", "--quiet", "-u", "origin", current]],
  reset: (current) => [["reset", "--hard", "--quiet", `refs/remotes/origin/${current}`]],
};

/** Runs a fix of CLONE_FIXES in the clone. Returns null or an error. */
export async function fixClone(dir, fix, current, on = null) {
  for (const args of CLONE_FIXES[fix](current)) {
    const r = await sh("git", ["-C", dir, ...args], at(on));
    if (r.code !== 0) return tail(r) || `git ${args.join(" ")}`;
  }
  return null;
}

/** A repository of skills: owner/name, or a Git URL. No spaces and no shell characters. */
export const validRepo = (text) => /^[\w.@:/#~+-]+$/.test(String(text ?? "")) && /[\w]/.test(String(text ?? ""));

/**
 * The clone of a repository that is not the Catalog, in the sources cache. Clones it when it
 * is not there (gh for owner/name when it is logged in, else git). Returns { dir, error }.
 */
export async function ensureSource(repo, on = null) {
  const s = await linkScript({ op: "source", sourcesRoot: (await place(on)).sourcesRoot, repo }, on);
  if (s.error) return { dir: null, error: s.error };
  if (!s.dir) return { dir: null, error: "not a repository" };
  if (s.exists) return { dir: slash(s.dir), error: null };
  const name = String(repo).trim().split("#")[0];
  const r = /^[\w.-]+\/[\w.-]+$/.test(name) && (await hasGh(on))
    ? await sh("gh", ["repo", "clone", name, s.dir], at(on, { timeout: 300000 }))
    : await sh("git", ["clone", "--quiet", "--", s.url, s.dir], at(on, { timeout: 300000 }));
  return r.code === 0 ? { dir: slash(s.dir), error: null } : { dir: null, error: tail(r) || `git clone ${s.url}` };
}

/**
 * Fetches a source clone and counts the commits of its remote that it does not have yet.
 * It does not change the files of the clone: updateOwnClone() does, when the person asks.
 * Returns { behind, error }.
 */
export async function sourceBehind(dir, on = null) {
  const f = await sh("git", ["-C", dir, "fetch", "--quiet", "--prune", "origin"], at(on, { timeout: 120000 }));
  if (f.code !== 0) return { behind: 0, error: tail(f) };
  await sh("git", ["-C", dir, "remote", "set-head", "origin", "--auto"], at(on));
  const n = await sh("git", ["-C", dir, "rev-list", "--count", "HEAD..origin/HEAD"], at(on));
  return { behind: Number(n.out.trim()) || 0, error: null };
}

/**
 * Runs link-skills.mjs with one JSON input (see the top of that file) on the machine `on`.
 * Returns its JSON, or { error }.
 */
export async function linkScript(input, on = null) {
  let script;
  try { script = (await place(on)).script; } catch (e) { return { error: String(e?.message ?? e) }; }
  const r = await sh("node", [script, JSON.stringify(input)], at(on, { timeout: 120000 }));
  if (r.code !== 0) return { error: tail(r) || "node failed (is Node.js installed?)" };
  try {
    return JSON.parse(r.out);
  } catch (e) {
    return { error: `link-skills.mjs: ${e}` };
  }
}
