// The saved state of the mod, in shared state (shared.json): the folders,
// the list order, the repository list of each machine and the clones that
// started. Also the small part of the state of Repo Launcher that this mod
// reads and writes (its folders and its repository cache).

import { shared, setShared } from "herdr";
import { normalize, keyOf, isInside, expandHome } from "./sys.js";

export const MOD = "github-clone";

const SETTINGS = `${MOD}.settings`; // { roots: { [machine key]: folder }, rules: [{ machine, owner, folder }] }
const CACHE = `${MOD}.cache`; // { [machine key]: { login, repos, orgs, fetchedAt, error } }
const PENDING = `${MOD}.pending`; // [{ machine, path, at }]
export const ORDER = `${MOD}.order`; // "name" | "pushed" | "owner"

/** The key of a machine in the saved objects: "" for this computer. */
export const mkey = (machine) => machine ?? "";

export function settings() {
  const s = shared(SETTINGS) ?? {};
  return {
    roots: s.roots && typeof s.roots === "object" && !Array.isArray(s.roots) ? s.roots : {},
    rules: Array.isArray(s.rules) ? s.rules.filter((r) => r && typeof r === "object") : [],
  };
}

export function updateSettings(change) {
  const next = { ...settings(), ...(typeof change === "function" ? change(settings()) : change) };
  setShared(SETTINGS, next);
  return next;
}

/** The clone folder of a machine, as the person wrote it (it can start with `~`), or "". */
export const rootOf = (machine) => String(settings().roots[mkey(machine)] ?? "").trim();

export function setRoot(machine, folder) {
  updateSettings((s) => ({ roots: { ...s.roots, [mkey(machine)]: normalize(folder) } }));
}

/** The owner rules of a machine. */
export const rulesOf = (machine) => settings().rules.filter((r) => (r.machine ?? null) === (machine ?? null));

/** The folder for a clone of a repository of `owner` on `machine`: its rule, else the clone folder, else "". */
export function folderFor(machine, owner) {
  const o = String(owner ?? "").toLowerCase();
  const rule = rulesOf(machine).find((r) => String(r.owner ?? "").trim().toLowerCase() === o && String(r.folder ?? "").trim());
  return rule ? String(rule.folder).trim() : rootOf(machine);
}

const ORDERS = ["name", "pushed", "owner"];
export const order = () => (ORDERS.includes(shared(ORDER)) ? shared(ORDER) : "name");
export const setOrder = (value) => setShared(ORDER, value);

/** The saved list of a machine: `{ login, repos, orgs, fetchedAt, error }`, or null. */
export const cacheOf = (machine) => shared(CACHE)?.[mkey(machine)] ?? null;

export function setCacheOf(machine, value) {
  setShared(CACHE, { ...(shared(CACHE) ?? {}), [mkey(machine)]: value });
}

export const pending = () => (Array.isArray(shared(PENDING)) ? shared(PENDING) : []);
export const setPending = (list) => setShared(PENDING, list);

// ---------------------------------------------------------------------------
// Repo Launcher

const RL_SETTINGS = "repo-launcher.settings";
const RL_CACHE = "repo-launcher.cache";

/** The root folders of Repo Launcher on a machine. */
export function launcherRoots(machine) {
  const s = shared(RL_SETTINGS) ?? {};
  if (!machine) return Array.isArray(s.roots) ? s.roots : [];
  return (Array.isArray(s.remoteRoots) ? s.remoteRoots : []).filter((r) => r?.machine === machine).map((r) => r.path);
}

/** True when `folder` is inside a root folder of Repo Launcher on that machine. */
export function inLauncher(machine, folder, info) {
  if (!info) return true;
  const f = expandHome(folder, info);
  return launcherRoots(machine).some((root) => isInside(f, expandHome(root, info), info.fold));
}

/** Adds a root folder to Repo Launcher. Repo Launcher reads it at its next Refresh. */
export function addLauncherRoot(machine, folder) {
  const s = shared(RL_SETTINGS) ?? {};
  const path = normalize(folder);
  if (!machine) {
    const roots = Array.isArray(s.roots) ? s.roots : [];
    if (!roots.some((r) => keyOf(r, true) === keyOf(path, true))) setShared(RL_SETTINGS, { ...s, roots: [...roots, path] });
    return;
  }
  const remote = Array.isArray(s.remoteRoots) ? s.remoteRoots : [];
  if (!remote.some((r) => r.machine === machine && keyOf(r.path, true) === keyOf(path, true))) {
    setShared(RL_SETTINGS, { ...s, remoteRoots: [...remote, { machine, path }] });
  }
}

/**
 * Adds a new clone to the repository cache of Repo Launcher, so its search
 * finds it at once. `path`: full, `~` expanded. The entry gets the root
 * folder of Repo Launcher that holds it, else the folder of the clone.
 */
export function addLauncherRepo(machine, path, info) {
  const c = shared(RL_CACHE);
  const repos = Array.isArray(c?.repos) ? c.repos : [];
  const p = normalize(path);
  if (repos.some((r) => (r.machine ?? null) === (machine ?? null) && keyOf(r.path, info.fold) === keyOf(p, info.fold))) return;
  const root = launcherRoots(machine).find((r) => isInside(p, expandHome(r, info), info.fold)) ?? p.slice(0, p.lastIndexOf("/"));
  const name = p.split("/").pop();
  setShared(RL_CACHE, { repos: [], scannedAt: null, missing: [], machines: {}, ...(c ?? {}), repos: [...repos, { path: p, name, root: normalize(root), machine: machine ?? null }] });
}

/** Removes an entry that addLauncherRepo() made, when its clone failed. */
export function removeLauncherRepo(machine, path, fold) {
  const c = shared(RL_CACHE);
  if (!Array.isArray(c?.repos)) return;
  const k = keyOf(path, fold);
  const repos = c.repos.filter((r) => !((r.machine ?? null) === (machine ?? null) && keyOf(r.path, fold) === k));
  if (repos.length !== c.repos.length) setShared(RL_CACHE, { ...c, repos });
}
