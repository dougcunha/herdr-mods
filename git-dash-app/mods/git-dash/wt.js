// The Worktrees tab of Git Dash: every linked worktree of the repositories of
// Git Dash and Repo Launcher, with its state and its actions.
import { exec, shared } from "herdr";
import { findBase, listWorktrees, samePath, mapLimit } from "./git.js";
import { worktrees } from "./core.js";

const git = (cwd, args) =>
  exec("git", ["--no-optional-locks", "-c", "core.quotepath=false", ...args], { cwd });
const HEADS = "refs/heads/";
const WORKERS = 12;
const DAY = 24 * 60 * 60;
export const OLD_DAYS = 14; // a worktree without a commit for this many days is "old"

/**
 * The folders that can hold a repository with worktrees: the repositories of
 * the Repo Launcher cache on this computer, and the given paths (the cards of
 * Git Dash). A missing or broken cache gives nothing.
 */
export function candidates(extra = []) {
  const cache = shared("repo-launcher.cache");
  const fromLauncher = Array.isArray(cache?.repos)
    ? cache.repos.filter((r) => r && r.machine == null && typeof r.path === "string").map((r) => r.path)
    : [];
  const out = [], seen = new Set();
  for (const p of [...fromLauncher, ...extra]) {
    if (p && !seen.has(samePath(p))) { seen.add(samePath(p)); out.push(p); }
  }
  return out;
}

/** True when the Repo Launcher cache has repositories of this computer. */
export const launcherHasRepos = () => candidates().length > 0;

/**
 * The main checkouts of `paths`, each once: `[{ main, list }]`, where `list`
 * is the output of listWorktrees() (the main checkout first). Only a main
 * checkout with 1 or more linked worktrees is returned.
 */
export async function findMains(paths, onProgress = () => {}) {
  const mains = new Map();
  await mapLimit(paths, WORKERS, async (p) => {
    const list = await listWorktrees(p).catch(() => []);
    onProgress();
    if (list.length < 2) return;
    const k = samePath(list[0].path);
    if (!mains.has(k)) mains.set(k, { main: list[0].path, list });
  });
  return [...mains.values()];
}

/** Counts of a `git status --porcelain=v2 --branch` output. */
function readStatus(out) {
  const s = { head: "", upstream: "", ahead: 0, behind: 0, hasAb: false, staged: 0, modified: 0, untracked: 0, conflicts: 0 };
  for (const line of out.split("\n")) {
    if (line.startsWith("# ")) {
      const p = line.trim().split(" ");
      if (p[1] === "branch.head") s.head = p[2];
      else if (p[1] === "branch.upstream") s.upstream = p[2];
      else if (p[1] === "branch.ab") { s.hasAb = true; s.ahead = parseInt(p[2], 10) || 0; s.behind = Math.abs(parseInt(p[3], 10)) || 0; }
      continue;
    }
    const kind = line[0];
    if (kind === "1" || kind === "2") {
      if (line[2] !== ".") s.staged += 1;
      if (line[3] !== ".") s.modified += 1;
    } else if (kind === "u") s.conflicts += 1;
    else if (kind === "?") s.untracked += 1;
  }
  return s;
}

const STATUS = ["status", "--porcelain=v2", "--branch", "--ignore-submodules=dirty", "--untracked-files=normal"];

/** True when the branch has a sign of work: an upstream, or a reflog with more than its creation. */
async function hasHistory(repo, branch, upstream) {
  if (upstream) return true;
  const rl = await git(repo, ["reflog", "show", "--format=%gs", `${HEADS}${branch}`]);
  const entries = rl.code === 0 ? rl.stdout.split(/\r?\n/).filter(Boolean) : [];
  return entries.length > 0 && !entries.every((e) => e.startsWith("branch: Created from"));
}

/** Reads one linked worktree. Never rejects: a failure goes in `error`. */
async function readWorktree(g, w) {
  const branch = w.branch.startsWith(HEADS) ? w.branch.slice(HEADS.length) : "";
  const row = {
    key: samePath(w.path), path: w.path, main: g.main, branch, locked: w.locked, prunable: w.prunable,
    staged: 0, modified: 0, untracked: 0, conflicts: 0, upstream: "", ahead: 0, behind: 0, hasAb: false,
    baseAhead: 0, baseBehind: 0, merged: false, remoteMerged: false, remoteSha: "", last: 0, error: null,
  };
  if (w.prunable) return row;
  try {
    const st = await git(w.path, STATUS);
    if (st.code !== 0) { row.error = st.stderr.trim().split("\n").pop() || `git status: exit ${st.code}`; return row; }
    Object.assign(row, readStatus(st.stdout));
    delete row.head;
    const lg = await git(w.path, ["log", "-1", "--format=%ct", "HEAD"]);
    row.last = lg.code === 0 ? parseInt(lg.stdout.trim(), 10) || 0 : 0;
    if (g.base) {
      const c = await git(w.path, ["rev-list", "--left-right", "--count", `${g.target}...HEAD`]);
      if (c.code === 0) {
        const [behind, ahead] = c.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
        row.baseBehind = behind; row.baseAhead = ahead;
      }
      // Merged: no commit outside the base, and the branch did some work (a new branch has no commit of its own either).
      if (branch && row.baseAhead === 0 && branch !== g.base.local) row.merged = await hasHistory(g.main, branch, row.upstream);
      if (row.merged && row.upstream && row.hasAb) {
        const up = await git(w.path, ["merge-base", "--is-ancestor", "@{upstream}", g.base.ref]);
        row.remoteMerged = up.code === 0;
        const sha = await git(w.path, ["rev-parse", "@{upstream}"]);
        row.remoteSha = sha.code === 0 ? sha.stdout.trim() : "";
        if (!row.remoteSha) row.remoteMerged = false;
      }
    }
  } catch (e) {
    row.error = String(e?.message || e);
  }
  return row;
}

/** Reads a main checkout and its linked worktrees: `{ main, name, base, mainBranch, mainDirty, mainBusy, rows }`. */
export async function readGroup({ main, list }) {
  const g = { main, name: main.replace(/[\\/]+$/, "").split(/[\\/]/).pop(), base: null, target: "", mainBranch: "", mainDirty: false, mainBusy: false, rows: [] };
  g.base = await findBase(main).catch(() => null);
  // The target: the local base branch when it exists (a local merge counts before its push), else the base.
  if (g.base) {
    const local = g.base.local && await git(main, ["rev-parse", "--verify", "--quiet", `${HEADS}${g.base.local}`]);
    g.target = local && local.code === 0 ? `${HEADS}${g.base.local}` : g.base.ref;
  }
  const st = await git(main, STATUS);
  if (st.code === 0) {
    const s = readStatus(st.stdout);
    g.mainBranch = s.head;
    g.mainDirty = Boolean(s.staged || s.modified || s.conflicts);
    const mh = await git(main, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    g.mainBusy = mh.code === 0 || s.conflicts > 0 || s.head === "(detached)";
  } else {
    g.mainBusy = true;
  }
  g.rows = [];
  for (const w of list.slice(1)) g.rows.push(await readWorktree(g, w));
  return g;
}

/** Reads one main checkout again (after an action). Null when it has no linked worktree now. */
export async function rereadGroup(main) {
  const list = await listWorktrees(main).catch(() => []);
  if (list.length < 2) return null;
  return readGroup({ main: list[0].path, list });
}

export const dirty = (w) => Boolean(w.staged || w.modified || w.untracked || w.conflicts);
export const isOld = (w, now = Date.now() / 1000) => Boolean(w.last) && now - w.last > OLD_DAYS * DAY;

// ---- actions ---------------------------------------------------------------
//
// A step is `{ cwd, argv }` (a program run with exec), or `{ core: { repo,
// path, force } }` (a worktree remove by PowerMods Core, which also closes a
// space that works only in that folder). `undo` (optional, argv) runs in the
// same folder when the step fails, for example `git merge --abort`.

const gitStep = (cwd, ...args) => ({ cwd, argv: ["git", ...args] });
const removeStep = (w, force = false) => ({ core: { repo: w.main, path: w.path, force } });

/**
 * What a row can do. Each action is `{ id, steps, tone, warn? }`, or
 * `{ id, blocked }` when it must wait. `warn` is a text key for the confirmation.
 */
export function rowActions(g, w) {
  const out = [];
  if (w.prunable) {
    out.push({ id: "prune", tone: "danger", steps: [removeStep(w)] });
    if (w.branch) out.push({ id: "pruneDelete", tone: "danger", warn: "warnPrune", steps: [removeStep(w), gitStep(w.main, "branch", "-D", w.branch)] });
    return out;
  }
  if (w.error) return [{ id: "remove", tone: "danger", steps: [removeStep(w)] }];

  // Remove: Git refuses a dirty or locked worktree; a dirty one gets a force remove too.
  if (w.locked) out.push({ id: "remove", blocked: "locked" });
  else if (dirty(w)) out.push({ id: "forceRemove", tone: "danger", warn: "warnForce", steps: [removeStep(w, true)] });
  else out.push({ id: "remove", tone: "danger", warn: "warnSpace", steps: [removeStep(w)] });

  // Remove and delete the branch.
  if (w.branch && !w.locked && !dirty(w)) {
    if (w.merged && g.base) {
      const steps = [gitStep(w.main, "merge-base", "--is-ancestor", `${HEADS}${w.branch}`, g.target), removeStep(w)];
      if (w.remoteMerged) {
        const [remote, ...rest] = w.upstream.split("/");
        // --force-with-lease stops the delete when the remote branch moved after the last fetch.
        steps.push(gitStep(w.main, "push", remote, "--delete", rest.join("/"), `--force-with-lease=${HEADS}${rest.join("/")}:${w.remoteSha}`));
      }
      steps.push(gitStep(w.main, "branch", "-D", w.branch));
      out.push({ id: w.remoteMerged ? "removeDeleteBoth" : "removeDelete", tone: "danger", warn: "warnSpace", steps });
    } else {
      out.push({ id: "removeDelete", tone: "danger", warn: w.baseAhead ? "warnUnmerged" : "warnSpace", steps: [removeStep(w), gitStep(w.main, "branch", "-D", w.branch)] });
    }
  }

  // Merge into the base, in the main checkout. Never switches a branch for the person.
  if (w.branch && g.base && w.baseAhead > 0) {
    const blocked = !g.base.local ? "noBase"
      : g.mainBusy ? "mainBusy"
      : g.mainBranch !== g.base.local ? "mainBranch"
      : g.mainDirty ? "mainDirty"
      : dirty(w) ? "dirty"
      : "";
    out.push(blocked ? { id: "merge", blocked }
      : { id: "merge", tone: "primary", steps: [{ ...gitStep(g.main, "merge", "--no-edit", w.branch), undo: ["git", "merge", "--abort"] }] });
  }

  // A pull request: push the branch when needed, then open the PR page (or the page of the PR that exists).
  if (w.branch && w.baseAhead > 0) {
    const steps = [];
    if (!w.upstream || !w.hasAb) steps.push(gitStep(w.path, "push", "-u", "origin", w.branch));
    else if (w.ahead > 0 && w.behind === 0) steps.push(gitStep(w.path, "push"));
    steps.push({ cwd: w.path, argv: ["gh", "pr", "view", w.branch, "--web"], orElse: ["gh", "pr", "create", "--web", "--head", w.branch] });
    out.push(w.ahead > 0 && w.behind > 0 ? { id: "pr", blocked: "diverged" } : { id: "pr", tone: "primary", steps });
  }
  return out;
}

const quote = (a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a);

/** The text of a step, for the confirmation. */
export function showStep(s) {
  if (s.core) return `${s.core.force ? "force-remove" : "remove"} worktree ${s.core.path}  (PowerMods Core)`;
  const text = s.argv.map(quote).join(" ");
  return s.orElse ? `${text}  ||  ${s.orElse.map(quote).join(" ")}` : text;
}

/**
 * Runs the steps one after the other and stops at the first failure. Never
 * rejects. On a failure, `undo` of that step runs. `failed`: the failed step,
 * so it can run again in a terminal.
 */
export async function runActionSteps(steps) {
  let out = "";
  for (const s of steps) {
    let res;
    if (s.core) {
      res = await worktrees().remove({ repo: s.core.repo, path: s.core.path, force: s.core.force, closeSpace: true })
        .then(() => ({ code: 0, stdout: "", stderr: "" }), (e) => ({ code: 1, stdout: "", stderr: String(e?.message || e) }));
    } else {
      const go = (argv) => exec(argv[0], argv.slice(1), { cwd: s.cwd, timeout: 120000 })
        .catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message || e) }));
      res = await go(s.argv);
      if (res.code !== 0 && s.orElse) res = await go(s.orElse);
      if (res.code !== 0 && s.undo) {
        const u = await go(s.undo);
        res = { ...res, stderr: `${res.stderr}\n${showStep({ argv: s.undo })}: ${u.code === 0 ? "ok" : `exit ${u.code}`}` };
      }
    }
    out = `${res.stdout}\n${res.stderr}`.trim();
    if (res.code !== 0) return { ok: false, out: out || `${showStep(s)}: exit ${res.code}`, failed: s };
  }
  return { ok: true, out };
}
