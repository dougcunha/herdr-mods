// The worktree service of the core: create, remove, list, locate.
//
// Other mods call it through globalThis.powermods.worktree (see api.js and DESIGN.md). `create` and `remove`
// go into a queue: a status copy of the core takes them on its timer (`pump`) and runs them with its own `cx`
// (sleeps, waits). `list`, `locate`, `pathFor` and `preview` run at once in the caller.
//
// The queue and the running jobs live on globalThis, so a reload of the core keeps them.

import { run, spaces, panes, notify, hc, openOverlay, shared, setShared, home, exec } from "herdr";
import { KEY, norm, samePath, inside, slug, repoName, rootSetting, rootFor, homeOf, windowsOn, git, mainCheckout, parseWorktrees } from "./paths.js";
import { repoConfig, trusted, trustValue, copyFilesFolder, copyIgnored, commandsOf, writeRunner, readStatus, removeRunner } from "./setup.js";

export const STATE = (globalThis.__powermodsCore ??= { queue: [], jobs: new Map(), beat: 0, seq: 0 });

export const MISSING = "PowerMods Core is not running in this layout. Show the Main dock or the Kanban layout: their status row runs it. See https://github.com/dougcunha/herdr-mods/tree/main/powermods-core-app";
const STALE_MS = 30000; // a job whose runner did not move for this long has lost its copy of the core
const KEEP_JOBS = 15;
const MAX_LOG = 8000;

export const alive = () => Date.now() - STATE.beat < 5000;
const newId = () => `${Date.now().toString(36)}${(STATE.seq++).toString(36)}`;

// ---- the record that the dialog and the status item show (shared, so every copy sees it) ----------------

export const jobs = () => { const v = shared(KEY.jobs); return Array.isArray(v) ? v : []; };
function record(j, patch) {
  const list = jobs();
  const i = list.findIndex((x) => x.id === j.id);
  const next = { ...(i >= 0 ? list[i] : { id: j.id, kind: j.kind, at: Date.now() }), ...patch };
  if (typeof next.log === "string" && next.log.length > MAX_LOG) next.log = next.log.slice(-MAX_LOG);
  const rest = list.filter((x) => x.id !== j.id);
  setShared(KEY.jobs, [next, ...rest].slice(0, KEEP_JOBS));
}
export const clearJobs = () => setShared(KEY.jobs, jobs().filter((x) => x.state === "setup" || x.state === "git" || x.state === "copy" || x.state === "trust"));

// ---- the queue ------------------------------------------------------------------------------------------

function enqueue(kind, req) {
  if (!alive()) return Promise.reject(new Error(MISSING));
  let job;
  const started = new Promise((resolve, reject) => { job = { id: newId(), kind, req: req ?? {}, resolve, reject, settled: false, beat: Date.now() }; });
  job.done = new Promise((resolve) => { job.finish = resolve; });
  STATE.queue.push(job);
  return started;
}
function settle(j, value) {
  if (j.settled) return;
  j.settled = true;
  j.resolve(value);
}
function fail(j, e, toast = false) {
  const message = String(e?.message ?? e);
  record(j, { state: "failed", error: message, ended: Date.now() });
  if (!j.settled) { j.settled = true; j.reject(new Error(message)); }
  else if (toast) notify({ title: `Worktree ${j.kind === "remove" ? "remove" : "setup"} stopped`, body: message, level: "error", timeout: 10000 });
  j.finish?.({ ok: false, error: message });
}

// Each status copy has an id and a heartbeat (STATE.copies). A job belongs to the copy that runs it. A job is
// lost only when its copy stopped beating (a layout switch, a reload): a slow git command is not a lost job.
const ownerGone = (j) => Date.now() - (STATE.copies[j.owner] ?? 0) > STALE_MS;
STATE.copies ??= {};

/** Runs the queue: called by every status copy of the core on its timer, with the id of that copy. */
export function pump(cx, copy) {
  STATE.beat = Date.now();
  STATE.copies[copy] = Date.now();
  for (const j of [...STATE.jobs.values()]) {
    if (!ownerGone(j)) continue;
    if (j.wait) {
      // The setup runs on in its tab: this copy waits for it and starts the agent.
      j.owner = copy;
      cx.spawn(async (cx) => {
        try { await waitSetup(cx, j, copy); } catch (e) { fail(j, e, true); } finally { if (j.owner === copy) STATE.jobs.delete(j.id); }
      });
    } else {
      STATE.jobs.delete(j.id);
      fail(j, "The core stopped during the work (a layout switch or a reload). Check the worktree by hand.", true);
    }
  }
  while (STATE.queue.length) {
    const j = STATE.queue.shift();
    j.owner = copy;
    STATE.jobs.set(j.id, j);
    cx.spawn(async (cx) => {
      try {
        if (j.kind === "create") await runCreate(cx, j, copy);
        else await runRemove(cx, j);
      } catch (e) {
        fail(j, e, true);
      } finally {
        if (j.owner === copy) STATE.jobs.delete(j.id);
      }
    });
  }
}
/** A status copy went away: its jobs can move to another copy at once. */
export const leave = (copy) => { delete STATE.copies[copy]; };

// ---- the API ------------------------------------------------------------------------------------------

/**
 * Creates a worktree, runs its setup and opens a space in it. Resolves when the space is open:
 * { path, spaceId, copied, setup: "none" | "running", done } (`done` resolves when the setup ends:
 * { ok, error? }). Rejects with a message for the person.
 *
 * req: { repo, branch, base?, on?, path?, name?, select?, prepare?, agent? }
 *   repo     a folder inside the repository
 *   branch   the branch: an existing one is used, one only on origin is tracked, else a new one from `base`
 *   base     the start of a new branch (default HEAD)
 *   on       the machine (a space's `machine`), null for this computer
 *   path     a folder typed by the person, in place of the central folder
 *   name     the name of the new space (default: the agent's tab, else the branch)
 *   select   false: show the space that was shown before (default true)
 *   prepare  async ({ path, main, on }) => void: runs after the copy, before the setup
 *   agent    { argv, task?, tab? } or async ({ path, main, on }) => that: started after the setup
 */
export const create = (req) => enqueue("create", req);
/** Removes a worktree: { repo, path, on?, force?, closeSpace? (default true) }. Resolves with { path }. */
export const remove = (req) => enqueue("remove", req);

/** The worktrees of a repository: [{ path, branch, head, detached, locked, prunable, main, central }]. */
export async function list({ repo, on = null } = {}) {
  const main = await mainCheckout(repo, on);
  if (!main) throw new Error("Not a git repository.");
  const r = await git(main, ["worktree", "list", "--porcelain"], on);
  if (!r.ok) throw new Error(r.err || "git worktree list failed.");
  const root = rootFor(on, await homeOf(on));
  return parseWorktrees(r.raw).map((w) => ({ ...w, central: !w.main && inside(w.path, root) }));
}

/** The folder of a new worktree: <root>/<repository>/<branch as a folder name>. */
export async function pathFor({ repo, branch, on = null }) {
  const main = await mainCheckout(repo, on);
  if (!main) throw new Error("Not a git repository.");
  return `${rootFor(on, await homeOf(on))}/${repoName(main)}/${slug(branch)}`;
}
/** The same folder as text for people, at once (the root as the Settings say it, with ~). */
export const preview = ({ repo, branch }) => `${norm(rootSetting())}/${repoName(repo) || "<repository>"}/${slug(branch) || "<branch>"}`;

/**
 * Where a folder is in the central folder of worktrees: { repo, leaf } (the repository's folder name, and the
 * rest of the path), or null. Also finds ~/.herdr/worktrees (Herdr's own folder, the default) on any machine.
 */
export function locate(folder, on = null) {
  const f = norm(folder);
  if (!f) return null;
  const parts = (rest) => { const p = rest.split("/").filter(Boolean); return p.length >= 2 ? { repo: p[0], leaf: p.slice(1).join("/") } : null; };
  if (!on) {
    const root = rootFor(null, norm(home()));
    if (root && inside(f, root) && !samePath(f, root)) { const hit = parts(f.slice(root.length + 1)); if (hit) return hit; }
  }
  const seg = f.split("/");
  const at = seg.lastIndexOf("worktrees");
  if (at >= 1 && seg[at - 1] === ".herdr") return parts(seg.slice(at + 1).join("/"));
  return null;
}

// ---- create ----------------------------------------------------------------------------------------

async function newSpace(cx, j, before, path) {
  for (let i = 0; i < 60; i++) {
    await cx.sleep(250);
    j.beat = Date.now();
    const made = spaces().filter((s) => !before.has(s.id));
    const hit = made.find((s) => samePath(s.folder, path)) ?? made[0];
    if (hit) return hit;
  }
  return null;
}

async function askTrust(cx, j, info) {
  j.trust = undefined;
  j.trustInfo = info;
  openOverlay({ mod: "powermods-core", kind: "dialog", width: 620, height: 460, props: { part: "trust", job: j.id } });
  const until = Date.now() + 30 * 60000;
  while (j.trust === undefined && Date.now() < until) { await cx.sleep(300); j.beat = Date.now(); }
  return j.trust === true;
}

async function runCreate(cx, j, copy) {
  const r = j.req, on = r.on ?? null;
  const branch = String(r.branch ?? "").trim();
  if (!r.repo || !branch) throw new Error("The core needs a repository and a branch.");
  record(j, { state: "git", branch, on });
  const main = await mainCheckout(r.repo, on);
  if (!main) throw new Error("Not a git repository.");
  if (!(await git(main, ["check-ref-format", "--branch", branch], on)).ok) throw new Error(`"${branch}" is not a valid branch name.`);
  const homeDir = await homeOf(on);
  if (!homeDir && !r.path) throw new Error("Cannot find the home folder on that machine.");
  const path = r.path ? norm(r.path) : `${rootFor(on, homeDir)}/${repoName(main)}/${slug(branch)}`;
  record(j, { repo: repoName(main), main, path });

  const exists = (await git(main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], on)).ok;
  const remote = !exists && (await git(main, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], on)).ok;
  if (exists) {
    const used = parseWorktrees((await git(main, ["worktree", "list", "--porcelain"], on)).raw).map((w) => w.branch);
    if (used.includes(branch)) throw new Error(`${branch} is checked out in another worktree: pick another name.`);
  }
  // An existing branch is used; one only on origin starts from there and tracks it; else a new one from base.
  const add = exists ? ["worktree", "add", path, branch]
    : remote && !r.base ? ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`]
    : ["worktree", "add", "-b", branch, path, r.base || "HEAD"];
  // Windows: the worktree folder is deeper than the main checkout, so a long file name can pass MAX_PATH
  // (260). Turn on long paths for the repository (worktrees share its config) unless the person set it.
  if ((await windowsOn(on)) && !(await git(main, ["config", "--get", "core.longpaths"], on)).out) await git(main, ["config", "core.longpaths", "true"], on);
  const made = await git(main, add, on, 600000);
  j.beat = Date.now();
  if (!made.ok) {
    // A failed checkout leaves a registered worktree and a new branch: remove them, so a retry starts clean.
    await git(main, ["worktree", "remove", "--force", path], on);
    await git(main, ["worktree", "prune"], on);
    if (!exists) await git(main, ["branch", "-D", branch], on);
    throw new Error(made.err || "git worktree add failed.");
  }

  record(j, { state: "copy" });
  let copied = on ? 0 : await copyFilesFolder(path);
  const cfg = await repoConfig(path, on);
  copied += await copyIgnored(main, path, on, cfg.copy);
  j.beat = Date.now();
  if (r.prepare) await r.prepare({ path, main, on });

  let useRepo = cfg.run.length > 0;
  if (useRepo && !trusted(main, on, cfg.run)) {
    record(j, { state: "trust" });
    useRepo = await askTrust(cx, j, { main, on, commands: cfg.run, repo: repoName(main) });
    if (useRepo) {
      const t = trustValue(main, on, cfg.run);
      setShared(KEY.trusted, { ...(shared(KEY.trusted) ?? {}), [t.key]: t.value });
    }
  }
  const commands = commandsOf(cfg.run, useRepo);
  const agent = typeof r.agent === "function" ? await r.agent({ path, main, on }) : r.agent ?? null;
  const name = String(r.name ?? agent?.tab ?? branch).slice(0, 40);
  const before = new Set(spaces().map((s) => s.id));
  const shown = spaces().find((s) => s.active)?.id ?? null;
  const notes = [cfg.error, useRepo || !cfg.run.length ? null : "The commands of .herdr/worktree.json were skipped."].filter(Boolean);

  if (!commands.length) {
    run("space.new", { name, folder: path, machine: on ?? "", ...(agent?.argv ? { tab: agent.tab, argv: agent.argv, task: agent.task } : {}) });
    const sp = await newSpace(cx, j, before, path);
    if (r.select === false && shown) run("space.select", { id: shown });
    record(j, { state: "done", copied, log: notes.join("\n") || "No setup commands.", spaceId: sp?.id ?? null, ended: Date.now() });
    settle(j, { path, spaceId: sp?.id ?? null, copied, setup: "none", done: j.done });
    j.finish({ ok: true });
    return;
  }

  record(j, { state: "setup", copied, commands });
  const runner = await writeRunner(j.id, path, on, commands);
  run("space.new", { name, folder: path, machine: on ?? "", tab: "setup", argv: runner.argv });
  const sp = await newSpace(cx, j, before, path);
  if (!sp) throw new Error("The new space did not open.");
  if (r.select === false && shown) run("space.select", { id: shown });
  const setupTab = sp.tabs[0]?.id ?? null;
  record(j, { spaceId: sp.id });
  // Everything that the wait needs is on the job, so another status copy can take the wait over (pump).
  j.wait = { runner, spaceId: sp.id, setupTab, agent, path, on, branch, notes };
  settle(j, { path, spaceId: sp.id, copied, setup: "running", done: j.done });
  await waitSetup(cx, j, copy);
}

/** Waits for the exit code of the setup, then starts the agent (code 0) or reports the failure. */
async function waitSetup(cx, j, copy) {
  const { runner, spaceId, setupTab, agent, path, on, branch, notes } = j.wait;
  let code = null;
  for (;;) {
    await cx.sleep(1000);
    if (j.owner !== copy) return; // another copy took the job over
    code = await readStatus(runner.status, on);
    if (code != null) break;
    const s = spaces().find((x) => x.id === spaceId);
    if (!s || !s.tabs.some((t) => t.id === setupTab)) { code = "closed"; break; }
  }
  j.wait = null;
  const sp = { id: spaceId };
  const terminal = panes().find((p) => p.tab === setupTab)?.terminal ?? null;
  const out = terminal ? await hc(["read", terminal, "--lines", "300"]).catch(() => null) : null;
  const log = [...notes, (out?.stdout ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim()].filter(Boolean).join("\n");
  await removeRunner(runner.files, on);

  if (code === 0) {
    // The new tab first: closing the last tab of a space closes the space.
    run("tab.new", { space: sp.id, folder: path, ...(agent?.argv ? { name: agent.tab, argv: agent.argv, task: agent.task } : {}) });
    await cx.sleep(500);
    if (setupTab) run("tab.close", { id: setupTab, confirmed: true });
    record(j, { state: "done", log, ended: Date.now() });
    j.finish({ ok: true });
    return;
  }
  const error = code === "closed" ? "The setup tab was closed before the setup ended." : `A setup command failed (exit code ${code}).`;
  record(j, { state: "failed", error, log, ended: Date.now() });
  notify({ title: `Worktree setup failed · ${branch}`, body: `${error}${agent?.argv ? " The agent did not start." : ""}`, level: "error", timeout: 10000, action: { name: "space.select", args: { id: sp.id } } });
  j.finish({ ok: false, error });
}

// ---- remove ----------------------------------------------------------------------------------------

// Git for Windows does not delete a junction (the links of `npx skills` in .claude/skills) and still
// exits with 0, so the folder stays with only links and empty folders in it. Delete such a folder.
// `rm -rf` deletes a link, not the folder that it points to. A folder with a file in it stays.
const LEFTOVER = 'test -e "$1" || exit 0; f=$(find "$1" -type f -print -quit 2>/dev/null); '
  + 'if [ -n "$f" ]; then echo "file:$f"; exit 0; fi; rm -rf "$1" && echo removed';

async function removeLeftover(path, on) {
  const r = await exec("sh", ["-c", LEFTOVER, "sh", path], { on: on ?? undefined }).catch(() => null);
  const out = (r?.stdout ?? "").trim();
  if (out === "removed") return "Git left links in the folder: the core deleted the folder.";
  if (out.startsWith("file:")) return `Git left files in the folder. Delete it yourself: ${path}`;
  return "";
}

async function runRemove(cx, j) {
  const r = j.req, on = r.on ?? null;
  const path = norm(r.path);
  if (!path) throw new Error("The core needs the folder of the worktree.");
  record(j, { state: "git", path, on, branch: r.branch ?? null });
  const main = (r.repo && await mainCheckout(r.repo, on)) || await mainCheckout(path, on);
  if (!main) throw new Error("Cannot find the repository of this worktree.");
  record(j, { repo: repoName(main), main });
  if (samePath(main, path)) throw new Error("This is the main checkout, not a worktree.");
  const all = parseWorktrees((await git(main, ["worktree", "list", "--porcelain"], on)).raw);
  const w = all.find((x) => samePath(x.path, path));
  if (!w) throw new Error(`${path} is not a worktree of ${repoName(main)}.`);

  // Git refuses these without force: say so before a space (and its agent) closes for nothing.
  if (!r.force && !w.prunable) {
    if (w.locked) throw new Error("The worktree is locked. Unlock it first, or remove it with force.");
    const st = await git(path, ["status", "--porcelain"], on);
    if (st.ok && st.out) throw new Error("The worktree has changes or new files. Commit or stash them first, or remove it with force.");
  }
  if (r.closeSpace !== false && !w.prunable) {
    // A space that works only in this folder closes; a space with a terminal elsewhere stays.
    const ids = spaces().filter((s) => (s.machine ?? null) === on).filter((s) => {
      const own = panes().filter((p) => s.tabs.some((t) => t.id === p.tab) && p.terminal);
      return own.length ? own.every((p) => inside(p.cwd, path)) : inside(s.folder, path);
    }).map((s) => s.id);
    for (const id of ids) run("space.close", { id, confirmed: true });
    if (ids.length) { await cx.sleep(1500); j.beat = Date.now(); }
  }
  const res = w.prunable ? await git(main, ["worktree", "prune"], on)
    : await git(main, ["worktree", "remove", ...(r.force ? ["--force"] : []), path], on, 300000);
  if (!res.ok) {
    const busy = /permission denied|device or resource busy|being used by another process/i.test(res.err);
    throw new Error(busy ? `A program still uses the folder (a terminal in it?). Close it and try again. Git: ${res.err}` : res.err || "git worktree remove failed.");
  }
  const leftover = w.prunable ? "" : await removeLeftover(path, on);
  record(j, { state: "done", ended: Date.now(), log: w.prunable ? "The folder was gone: git worktree prune." : leftover });
  settle(j, { path });
  j.finish({ ok: true });
}
