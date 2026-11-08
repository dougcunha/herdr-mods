// The programs that the mod runs (git, gh, node, npx) and the clone of the Catalog.
//
// The mod keeps its own clone of the Catalog in <appHome>/cache/skill-bundles/<owner>/<name>
// and fetches it on a timer. A person can point the mod to a clone of their own instead
// (setting "skill-bundles.clone"): the mod then reads that working tree as it is, and installs
// from its branch when that branch is not the default one, as Install-Skills.ps1 does.
//
// The clone uses the person's own git settings (core.autocrlf): `npx skills` downloads with the
// same settings, so the folder hashes match the Lock.

import { exec, appHome, window, readTextFile } from "herdr";

const isWindows = () => window()?.platform === "windows";
const slash = (p) => String(p ?? "").replace(/\\/g, "/");

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

/** `npx` is `npx.cmd` on Windows; exec does not find a .cmd without its extension. */
export const npx = (args, cwd) => sh(isWindows() ? "npx.cmd" : "npx", ["--yes", ...args], { cwd });

/** The folder of this mod (the node helper is in it). */
export const modDir = () => `${slash(appHome())}/mods/skill-bundles`;

/** "owner/name" from a setting, or null. Accepts a GitHub URL too. */
export function repoSlug(value) {
  const s = String(value ?? "").trim().replace(/\.git$/i, "");
  const m = /(?:github\.com[:/])?([\w.-]+)\/([\w.-]+)$/i.exec(s);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Where the mod keeps its own clone of a Catalog. */
export const ownCloneDir = (slug) => `${slash(appHome())}/cache/skill-bundles/${slug}`;

/** The git root of a folder, or null. */
export async function gitRoot(folder) {
  if (!folder) return null;
  const r = await sh("git", ["-C", folder, "rev-parse", "--show-toplevel"]);
  return r.code === 0 ? slash(r.out.trim()) : null;
}

let ghReady = null; // a promise: true when `gh auth status` passes (asked once per mod load)

/** True when gh is installed and logged in. */
export function hasGh() {
  ghReady ??= sh("gh", ["auth", "status"]).then((r) => r.code === 0);
  return ghReady;
}

/**
 * Clones the Catalog into the mod's folder when it is not there. Uses gh when it is logged in,
 * else git with `gitUrl` (default: the SSH URL of GitHub). Returns null, or an error text.
 */
export async function ensureClone(slug, dir, gitUrl) {
  if ((await readTextFile(`${dir}/bundles.yaml`).catch(() => null)) !== null) return null;
  const head = await sh("git", ["-C", dir, "rev-parse", "--git-dir"]);
  if (head.code === 0) return `${dir} is a clone without bundles.yaml. Is ${slug} a Catalog?`;
  const r = (await hasGh()) && !gitUrl
    ? await sh("gh", ["repo", "clone", slug, dir])
    : await sh("git", ["clone", gitUrl || `git@github.com:${slug}.git`, dir]);
  if (r.code !== 0) return tail(r);
  if ((await readTextFile(`${dir}/bundles.yaml`).catch(() => null)) === null) return `${slug} has no bundles.yaml at its root.`;
  return null;
}

/** Brings the mod's own clone to the newest commit of its default branch. Returns null or an error. */
export async function updateOwnClone(dir) {
  const f = await sh("git", ["-C", dir, "fetch", "--quiet", "--prune", "origin"]);
  if (f.code !== 0) return tail(f);
  // origin/HEAD is set by the clone; a remote that changed its default branch needs it again.
  await sh("git", ["-C", dir, "remote", "set-head", "origin", "--auto"]);
  const r = await sh("git", ["-C", dir, "reset", "--hard", "--quiet", "origin/HEAD"]);
  return r.code === 0 ? null : tail(r);
}

/** Fetches the person's own clone. It does not change the working tree. Returns null or an error. */
export async function fetchOnly(dir) {
  const f = await sh("git", ["-C", dir, "fetch", "--quiet", "origin"]);
  return f.code === 0 ? null : tail(f);
}

/** The short commit of a clone's HEAD, or "". */
export async function headCommit(dir) {
  const r = await sh("git", ["-C", dir, "rev-parse", "--short", "HEAD"]);
  return r.code === 0 ? r.out.trim() : "";
}

/**
 * The branch to install from, for the person's own clone (Resolve-SkillsRef of the scripts):
 * { branch: null } for the default branch, { branch } for another pushed branch, or
 * { branch, problem } when the mod must not install (changes not committed, not pushed).
 */
export async function ownCloneRef(dir) {
  const cur = (await sh("git", ["-C", dir, "branch", "--show-current"])).out.trim();
  if (!cur) return { branch: null };
  const def = (await sh("git", ["-C", dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).out.trim().replace(/^origin\//, "");
  const dirty = (await sh("git", ["-C", dir, "status", "--porcelain"])).out.trim();
  if (dirty) return { branch: def && def === cur ? null : cur, problem: "dirty" };
  if (def && def === cur) {
    const ahead = await sh("git", ["-C", dir, "rev-list", "--count", "@{u}..HEAD"]);
    return Number(ahead.out.trim()) > 0 ? { branch: null, problem: "ahead" } : { branch: null };
  }
  const remote = await sh("git", ["-C", dir, "rev-parse", `refs/remotes/origin/${cur}`]);
  if (remote.code !== 0) return { branch: cur, problem: "unpushed" };
  const local = (await sh("git", ["-C", dir, "rev-parse", "HEAD"])).out.trim();
  return remote.out.trim() === local ? { branch: cur } : { branch: cur, problem: "ahead" };
}

/** Runs the node helper (probe.mjs) for a project. Returns its JSON, or { error }. */
export async function probe(project, clone, catalogRepo) {
  const r = await sh("node", [`${modDir()}/probe.mjs`, JSON.stringify({ project, clone, catalogRepo })]);
  if (r.code !== 0) return { error: tail(r) || "node failed" };
  try {
    return JSON.parse(r.out);
  } catch (e) {
    return { error: `probe.mjs: ${e}` };
  }
}
