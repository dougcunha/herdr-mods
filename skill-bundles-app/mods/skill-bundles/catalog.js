// The programs that the mod runs (git, gh, node, npx) and the clone of the Catalog.
//
// The mod keeps its own clone of the Catalog in <appHome>/cache/skill-bundles/<owner>/<name>
// and fetches it on a timer. A person can point the mod to a clone of their own instead
// (setting "skill-bundles.clone"): the mod then pulls it (fast-forward only) on the same timer,
// reads its working tree, and installs from its branch when that branch is not the default one,
// as Install-Skills.ps1 does. A clone that it cannot pull gets a problem and fixes (ownCloneRef).
//
// The clone uses the person's own git settings (core.autocrlf): `npx skills` downloads with the
// same settings, so the folder hashes match the Lock.

import { exec, appHome, window, readTextFile, writeTextFile } from "herdr";

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

/**
 * `npx` is `npx.cmd` on Windows; exec does not find a .cmd without its extension.
 * `host`: { on, windows } of the project's machine (null: this computer).
 */
export const npx = (args, cwd, host = null) =>
  sh((host ? host.windows : isWindows()) ? "npx.cmd" : "npx", ["--yes", ...args], at(host?.on, { cwd, timeout: 300000 }));

/**
 * `npx skills check` in a project: the installed skills that have a newer version in their
 * repository. It writes nothing. The command has no JSON output, so this reads its lines:
 * "↑ <skill> has an update", and for a repository that it could not read "✗ Cannot update
 * <repo>: …" or "✗ Failed to check for deleted skills from <repo>".
 * Returns { names, failed, error }: `error` is a text when the command did not run.
 */
export async function checkUpdates(root, host = null) {
  const r = await npx(["skills", "check", "-p"], root, host);
  const text = `${r.out}\n${r.err}`.replace(/\x1b\[[0-9;]*m/g, "");
  const names = [];
  const failed = [];
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = /^\s*\S+\s+(.+?)\s+has an update\s*$/.exec(line))) names.push(m[1]);
    else if ((m = /Cannot update (.+?): /.exec(line)) || (m = /Failed to check for deleted skills from (.+?)\s*$/.exec(line))) failed.push(m[1]);
  }
  const ran = /Checking|up to date|No project skills/i.test(text);
  return { names, failed, error: r.code === -1 || !ran ? tail(r) || "npx skills check" : null };
}

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

/** The git root of a folder on the machine `on` (null: this computer), or null. */
export async function gitRoot(folder, on = null) {
  if (!folder) return null;
  const r = await sh("git", ["-C", folder, "rev-parse", "--show-toplevel"], at(on));
  if (r.code === -1 && on) throw new Error(r.err || `${on} cannot be reached`);
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

/**
 * Fetches the person's own clone and brings its branch to the remote (fast-forward only), so
 * the hashes match what `npx skills add` installs. A clone with changes that are not committed,
 * or a branch with no upstream, is only fetched. Returns null or an error.
 */
export async function pullOwnClone(dir) {
  const f = await sh("git", ["-C", dir, "fetch", "--quiet", "origin"]);
  if (f.code !== 0) return tail(f);
  if ((await sh("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no"])).out.trim()) return null;
  const up = await sh("git", ["-C", dir, "rev-parse", "--abbrev-ref", "@{u}"]);
  if (up.code !== 0) return null;
  const behind = await sh("git", ["-C", dir, "rev-list", "--count", "HEAD..@{u}"]);
  if (!(Number(behind.out.trim()) > 0)) return null;
  const m = await sh("git", ["-C", dir, "merge", "--ff-only", "--quiet", "@{u}"]);
  return m.code === 0 ? null : tail(m);
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
  const branch = def && def === cur ? null : cur;
  const dirty = (await sh("git", ["-C", dir, "status", "--porcelain"])).out.trim();
  if (dirty) return { branch, current: cur, problem: "dirty" };
  const remote = await sh("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${cur}`]);
  if (remote.code !== 0) return branch ? { branch, current: cur, problem: "unpushed" } : { branch, current: cur };
  const count = await sh("git", ["-C", dir, "rev-list", "--left-right", "--count", `HEAD...refs/remotes/origin/${cur}`]);
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

/** Deletes a folder (or a link to a folder) and all in it, with node, on the machine `on`. Returns null or an error. */
export async function removeFolder(path, on = null) {
  const r = await sh("node", ["-e", "require('fs').rmSync(process.argv[1], { recursive: true, force: true })", path], at(on));
  return r.code === 0 ? null : tail(r) || `could not delete ${path}`;
}

/** Runs a fix of CLONE_FIXES in the clone. Returns null or an error. */
export async function fixClone(dir, fix, current) {
  for (const args of CLONE_FIXES[fix](current)) {
    const r = await sh("git", ["-C", dir, ...args]);
    if (r.code !== 0) return tail(r) || `git ${args.join(" ")}`;
  }
  return null;
}

const parse = (r) => {
  if (r.code !== 0) return { error: tail(r) || "node failed" };
  try {
    return JSON.parse(r.out);
  } catch (e) {
    return { error: `probe.mjs: ${e}` };
  }
};

/**
 * Runs the node helper (probe.mjs) for a project. Returns its JSON, or { error }.
 * `on`: the project's machine. The helper runs there for the Lock and the skill folders
 * (node must be installed there), and here for the hashes of the Catalog clone.
 */
export async function probe(project, clone, catalogRepo, on = null) {
  if (!on) return parse(await sh("node", [`${modDir()}/probe.mjs`, JSON.stringify({ project, clone, catalogRepo })]));
  const code = await readTextFile(`${modDir()}/probe.mjs`);
  if (!code) return { error: "probe.mjs was not found" };
  const there = parse(await sh("node", ["--input-type=module", "-e", code, JSON.stringify({ project })], { on, timeout: 60000 }));
  if (there.error || !clone || !Object.keys(there.lock ?? {}).length) return there;
  // The Lock goes to the helper here in a file: a command line on Windows is short.
  // 2 copies of the mod (status item, panel, dialog) can write the same Lock at the same time.
  const dir = `${slash(appHome())}/cache/skill-bundles`;
  const lockFile = `${dir}/remote-lock.json`;
  const want = JSON.stringify(there.lock);
  for (let i = 0; i < 3; i++) {
    const old = await readTextFile(lockFile).catch(() => null);
    if (old === want) break;
    try {
      await writeTextFile(lockFile, want, old);
      break;
    } catch (e) {
      if (i === 0 && old === null) await sh("node", ["-e", "require('fs').mkdirSync(process.argv[1], { recursive: true })", dir]);
      else if (i === 2) return { ...there, error: `remote-lock.json: ${e?.message ?? e}` };
    }
  }
  // `npx skills` installs on that machine with its git settings: the hashes use its core.autocrlf.
  const here = parse(await sh("node", [`${modDir()}/probe.mjs`, JSON.stringify({ project: null, clone, catalogRepo, lockFile, autocrlf: there.autocrlf ?? "" })]));
  return here.error ? { ...there, error: here.error } : { ...there, hashes: here.hashes };
}
