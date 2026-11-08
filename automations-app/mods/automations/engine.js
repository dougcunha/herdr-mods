// The runner. Only 1 copy of the mod has an Engine: the status copy that holds the lease
// (see main.js). It reads the definitions, watches the triggers and runs the automations.
//
// A run: check -> pre-script -> agent -> post-script -> tab end, history, toast.
// Runs that wait for their agent are in shared(KEY.running), so that a new runner (after a
// reload of the mod, or another layout) finds them and waits for them too.

import { shared, setShared, agents, terminals, panes, spaces, run, hc, notify, knownAgents, readTextFile, writeTextFile, watchFolder, exec } from "herdr";
import * as S from "./store.js";
import * as Sh from "./shell.js";
import { nextDue } from "./schedule.js";

const { KEY } = S;
const SEC = 1000;
const MIN = 60 * SEC;
const MISSED_MS = 2 * MIN; // a due time older than this when the runner sees it was missed
const DEFS_EVERY = 30 * SEC; // read automations.json again (hand edits)
const GIT_EVERY = 30 * SEC;
const DEBOUNCE_MS = 5 * SEC; // files trigger
const QUIET_MS = 10 * SEC; // files/git: ignore changes this long after a run of the automation ends
const START_MS = 2 * MIN; // interactive: an agent that does not start working in this time failed
const OUT_MAX = 2000; // characters of a script output in the history index
const RESULT_MAX = 8 * 1024;

// Windows gives watched paths with the \\?\ prefix.
const plain = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\/\/\?\//, "");
const norm = (p) => plain(p).replace(/\/+$/, "").toLowerCase();
const inFolder = (path, folder) => { const p = norm(path); const f = norm(folder); return !!f && (p === f || p.startsWith(`${f}/`)); };
const clip = (s, n = OUT_MAX) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n)}…` : t; };
const pad = (n) => String(n).padStart(2, "0");
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** A glob ("src/**\/*.ts") as a RegExp on a path relative to the folder. */
function globRe(glob) {
  const parts = String(glob ?? "").split(/[,;]/).map((g) => g.trim()).filter(Boolean);
  if (!parts.length) return null;
  const one = (g) => g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`^(?:${parts.map(one).join("|")})$`, "i");
}

export class Engine {
  constructor(copy) {
    this.copy = copy;
    this.defs = [];
    this.defsText = null;
    this.defsAt = 0;
    this.defsRev = null;
    this.defsError = null;
    this.index = {}; // the history index
    this.indexText = null;
    this.statuses = new Map(); // agent address -> last status (agent trigger)
    this.watching = new Map(); // automation id -> folder that a loop watches
    this.pendingFiles = new Map(); // automation id -> { at, files: Set }
    this.gitSeen = new Map(); // automation id -> { head, branch }
    this.gitAt = 0;
    this.quiet = new Map(); // automation id -> ms until which files/git changes are ignored
    this.lastCheck = Date.now();
    this.local = new Map(); // runId -> in-memory run detail (vars, record)
    this.busy = new Set(); // runIds with a step in progress (do not poll them twice)
    this.ready = false;
  }

  // ---- shared state --------------------------------------------------------------------

  running() { return S.getShared(KEY.running, []).filter((r) => r && r.runId); }
  setRunning(list) { setShared(KEY.running, list); }
  patchRunning(runId, patch) { this.setRunning(this.running().map((r) => (r.runId === runId ? { ...r, ...patch } : r))); }
  dropRunning(runId) { this.setRunning(this.running().filter((r) => r.runId !== runId)); }
  state(id) { return S.getShared(KEY.state, {})[id] ?? {}; }
  setState(id, patch) { const all = S.getShared(KEY.state, {}); setShared(KEY.state, { ...all, [id]: { ...(all[id] ?? {}), ...patch } }); }

  // ---- start ---------------------------------------------------------------------------

  /** Starts as the runner. `since`: the last time a runner was alive (for missed schedules). */
  async boot(cx, since) {
    this.lastCheck = since ?? Date.now();
    await this.loadDefs(true);
    const r = await S.loadRuns();
    this.index = r.index;
    this.indexText = r.text;
    // Runs of an older runner: the ones that wait for an agent go on; the others stopped.
    for (const a of this.running()) {
      if (a.phase === "agent" && a.address) continue;
      this.dropRunning(a.runId);
      await this.saveRecord(a.automationId, { id: a.runId, status: "failed", reason: "Interrupted: the runner stopped.", end: Date.now() });
    }
    for (const a of agents()) this.statuses.set(a.address, a.status);
    this.ready = true;
  }

  async loadDefs(force) {
    const rev = shared(KEY.rev) ?? null;
    if (!force && rev === this.defsRev && Date.now() - this.defsAt < DEFS_EVERY) return;
    this.defsRev = rev;
    this.defsAt = Date.now();
    const d = await S.loadDefs();
    if (d.list == null) {
      if (this.defsError !== d.error) notify({ title: "Automations", body: d.error, level: "error", timeout: 8000 });
      this.defsError = d.error;
      return;
    }
    this.defsError = null;
    if (d.text === this.defsText && !force) return;
    this.defsText = d.text;
    this.defs = d.list;
  }

  def(id) { return this.defs.find((a) => a.id === id) ?? null; }

  // ---- the timer -----------------------------------------------------------------------

  /** Every 3 s, while this copy is the runner. */
  async tick(cx) {
    if (!this.ready) return;
    await this.loadDefs(false);
    const now = Date.now();
    await this.takeRequests(cx);
    this.checkSchedules(cx, now);
    this.observeAgents(cx);
    this.flushFiles(cx, now);
    this.ensureWatchers(cx);
    if (now - this.gitAt >= GIT_EVERY) { this.gitAt = now; this.pollGit(cx); }
    for (const r of this.running()) if (r.phase === "agent" && !this.busy.has(r.runId)) this.pollAgent(cx, r);
    this.lastCheck = now;
  }

  /** "Run now" from other copies (the dialog). */
  async takeRequests(cx) {
    const list = S.getShared(KEY.requests, []);
    if (!list.length) return;
    setShared(KEY.requests, []);
    // A new automation can be newer than the last read of the file.
    if (list.some((q) => !this.def(q.id))) await this.loadDefs(true);
    for (const q of list) {
      const a = this.def(q.id);
      if (a) this.fire(cx, a, "manual", {});
      else notify({ title: "Automations", body: `No automation with the id "${q.id}".`, level: "warning", timeout: 6000 });
    }
  }

  checkSchedules(cx, now) {
    for (const a of this.defs) {
      if (!a.enabled || a.trigger.type !== "schedule") continue;
      const st = this.state(a.id);
      const due = nextDue(a.trigger.schedule, this.lastCheck, st.lastFired ?? a.updatedAt);
      if (due == null || due > now) continue;
      const missed = now - due > MISSED_MS;
      this.setState(a.id, { lastFired: now });
      if (missed && !a.catchUp) continue;
      this.fire(cx, a, missed ? "schedule (missed)" : "schedule", {});
    }
  }

  /** Agent trigger: a change of status to done or blocked. Also called on render. */
  observeAgents(cx) {
    if (!this.ready) return;
    const labels = new Map(terminals().map((t) => [t.address, t.labels ?? {}]));
    const ours = new Set(this.running().map((r) => r.address).filter(Boolean));
    const live = new Set();
    for (const ag of agents()) {
      live.add(ag.address);
      const prev = this.statuses.get(ag.address);
      if (prev === ag.status) continue;
      this.statuses.set(ag.address, ag.status);
      if (prev === undefined || !["done", "blocked"].includes(ag.status)) continue;
      if (ours.has(ag.address) || labels.get(ag.address)?.automation) continue;
      const cwd = panes().find((p) => p.terminal === ag.address)?.cwd ?? "";
      for (const a of this.defs) {
        if (!a.enabled || a.trigger.type !== "agent") continue;
        const f = a.trigger.agent;
        if (!(f.statuses ?? []).includes(ag.status)) continue;
        if (!f.anyFolder && !inFolder(cwd, a.folder)) continue;
        const app = String(f.app ?? "").trim().toLowerCase();
        if (app && ![ag.app, ag.program?.key, ag.program?.name].some((x) => String(x ?? "").toLowerCase().includes(app))) continue;
        this.fire(cx, a, `agent ${ag.status}: ${ag.program?.name ?? ag.app ?? "agent"} in ${ag.space_name} / ${ag.tab_name}`, { agent_folder: cwd });
      }
    }
    for (const addr of [...this.statuses.keys()]) if (!live.has(addr)) this.statuses.delete(addr);
  }

  // ---- files and git -------------------------------------------------------------------

  isQuiet(a) {
    if (this.running().some((r) => r.automationId === a.id)) return true;
    return Date.now() < (this.quiet.get(a.id) ?? 0);
  }

  ensureWatchers(cx) {
    for (const a of this.defs) {
      if (!a.enabled || a.trigger.type !== "files" || !a.folder) continue;
      if (this.watching.get(a.id) === norm(a.folder)) continue;
      this.watching.set(a.id, norm(a.folder));
      this.watch(cx, a.id, a.folder);
    }
  }

  watch(cx, id, folder) {
    cx.spawn(async (cx) => {
      for (;;) {
        let paths;
        try { paths = await watchFolder(folder); } catch (e) {
          this.watching.delete(id);
          notify({ title: "Automations", body: `Cannot watch ${folder}: ${e?.message ?? e}`, level: "warning", timeout: 6000 });
          return;
        }
        const a = this.def(id);
        // The automation changed, was removed or turned off: this loop ends.
        if (!a || !a.enabled || a.trigger.type !== "files" || norm(a.folder) !== norm(folder) || this.watching.get(id) !== norm(folder) || !this.ready) {
          if (this.watching.get(id) === norm(folder) && (!a || a.trigger.type !== "files" || !a.enabled)) this.watching.delete(id);
          return;
        }
        if (this.isQuiet(a)) continue;
        const re = globRe(a.trigger.files.glob);
        const root = norm(folder);
        const rel = paths.map(plain).map((p) => (norm(p).startsWith(`${root}/`) ? p.slice(root.length + 1) : p))
          .filter((p) => !/(^|\/)\.git(\/|$)/.test(p));
        const hit = norm(paths[0] ?? "") === root ? rel : rel.filter((p) => !re || re.test(p));
        if (!hit.length && norm(paths[0] ?? "") !== root) continue;
        const pend = this.pendingFiles.get(id) ?? { at: 0, files: new Set() };
        for (const p of hit) pend.files.add(p);
        pend.at = Date.now();
        this.pendingFiles.set(id, pend);
        await cx.sleep(50);
      }
    });
  }

  flushFiles(cx, now) {
    for (const [id, pend] of this.pendingFiles) {
      if (now - pend.at < DEBOUNCE_MS) continue;
      this.pendingFiles.delete(id);
      const a = this.def(id);
      if (!a || this.isQuiet(a)) continue;
      const files = [...pend.files].slice(0, 200);
      this.fire(cx, a, `files changed (${pend.files.size})`, { files: files.join("\n") });
    }
  }

  pollGit(cx) {
    for (const a of this.defs) {
      if (!a.enabled || a.trigger.type !== "git" || !a.folder) continue;
      cx.spawn(async () => {
        const git = async (args) => { try { const r = await exec("git", args, { cwd: a.folder, timeout: 15000 }); return r.code === 0 ? r.stdout.trim() : null; } catch { return null; } };
        const head = await git(["rev-parse", "HEAD"]);
        const branch = await git(["branch", "--show-current"]);
        if (head == null) return;
        const prev = this.gitSeen.get(a.id);
        this.gitSeen.set(a.id, { head, branch });
        if (!prev || this.isQuiet(a)) return;
        const g = a.trigger.git;
        if (g.branch && branch !== prev.branch) this.fire(cx, a, `branch changed: ${prev.branch || "(detached)"} -> ${branch || "(detached)"}`, { commit: head, branch: branch ?? "" });
        else if (g.commit && head !== prev.head && branch === prev.branch) {
          const subject = await git(["log", "-1", "--format=%h %s"]);
          this.fire(cx, a, `new commit: ${subject ?? head.slice(0, 7)}`, { commit: head, branch: branch ?? "" });
        }
      });
    }
  }

  // ---- a run ---------------------------------------------------------------------------

  /** A trigger fired. Applies the overlap rule, then starts the run. */
  fire(cx, a, trigger, vars) {
    const active = this.running().filter((r) => r.automationId === a.id);
    if (active.length && a.overlap !== "parallel") {
      if (a.overlap === "queue") {
        setShared(KEY.queue, { ...S.getShared(KEY.queue, {}), [a.id]: { trigger, vars } });
        return;
      }
      const runId = S.newId("r");
      this.saveRecord(a.id, { id: runId, automation: a.name, trigger, start: Date.now(), end: Date.now(), status: "skipped", reason: "The last run is still running." });
      this.toast(a, "skipped", "The last run is still running.", runId);
      return;
    }
    const runId = S.newId("r");
    // Mark it at once: a second trigger in the same tick sees it.
    this.setRunning([...this.running(), { runId, automationId: a.id, phase: "start", started: Date.now() }]);
    cx.spawn(async (cx) => {
      try {
        await this.start(cx, a, runId, trigger, vars);
      } catch (e) {
        await this.end(cx, runId, "failed", `Error: ${e?.message ?? e}`);
      }
    });
  }

  vars(a, runId, trigger, extra) {
    const dir = S.runDir(runId);
    return {
      folder: a.folder,
      trigger,
      date: stamp(),
      files: "",
      commit: "",
      branch: "",
      pre: "",
      check: "",
      result_file: `${dir}/result.md`,
      run_dir: dir,
      run_id: runId,
      automation: a.name,
      ...extra,
    };
  }

  async start(cx, a, runId, trigger, extra) {
    const dir = S.runDir(runId);
    await S.ensureDir(dir);
    const vars = this.vars(a, runId, trigger, extra);
    const rec = { id: runId, automation: a.name, trigger, start: Date.now(), status: "running", mode: a.mode, agent: a.agent };
    this.local.set(runId, { a, vars, rec, dir });
    await this.saveRecord(a.id, rec);
    if (!a.folder) return this.end(cx, runId, "failed", "The automation has no folder.");

    // 1. Check: exit 0 runs, another code skips.
    if (a.check.cmd.trim()) {
      this.patchRunning(runId, { phase: "check" });
      const r = await Sh.runScript({ dir, name: "check", cmd: a.check.cmd, env: vars, folder: a.folder, timeout: a.check.timeout });
      await S.writeFile(`${dir}/check.out`, r.out);
      rec.check = { code: r.code, out: clip(r.out) };
      vars.check = r.out;
      if (r.code !== 0) return this.end(cx, runId, "skipped", r.out.split("\n")[0] || `The check gave exit code ${r.code}.`);
    }

    // 2. Pre-script: a failure cancels the run.
    if (a.pre.cmd.trim()) {
      this.patchRunning(runId, { phase: "pre" });
      const r = await Sh.runScript({ dir, name: "pre", cmd: a.pre.cmd, env: vars, folder: a.folder, timeout: a.pre.timeout });
      await S.writeFile(`${dir}/pre.out`, r.out);
      rec.pre = { code: r.code, out: clip(r.out) };
      if (r.code !== 0) return this.end(cx, runId, "failed", `The pre-script failed (exit code ${r.code}).`);
      vars.pre = r.out;
    }

    // 3. The agent.
    const prompt = String(a.prompt ?? "").replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    const agentList = await knownAgents().catch(() => []);
    const agent = agentList.find((x) => x.key === a.agent) ?? null;
    const labels = { automation: a.id, "automation-run": runId };
    const deadline = Date.now() + Math.max(1, Number(a.timeout) || 60) * MIN;
    if (a.mode === "interactive") {
      if (!agent) return this.end(cx, runId, "failed", `The agent "${a.agent}" is not in the list of agents.`);
      const argv = [...agent.run, ...Sh.splitArgs(a.args)];
      const before = new Set(terminals().map((t) => t.address));
      const space = this.spaceFor(a);
      if (space) run("tab.new", { space, folder: a.folder, argv, task: prompt, name: a.name || undefined });
      else run("space.new", { folder: a.folder, argv, task: prompt });
      let address = null;
      for (let i = 0; i < 40 && !address; i++) {
        await cx.sleep(250);
        address = terminals().find((t) => !before.has(t.address) && !String(t.address).includes("/"))?.address ?? null;
      }
      if (!address) return this.end(cx, runId, "failed", "The agent terminal did not start.");
      await hc(["label", address, `automation=${a.id}`, `automation-run=${runId}`]).catch(() => null);
      const turn = terminals().find((t) => t.address === address)?.turn ?? 0;
      rec.address = address;
      this.patchRunning(runId, { phase: "agent", mode: "interactive", address, turn, deadline, launched: Date.now(), sawWorking: false });
    } else {
      const key = a.command.trim() ? null : Sh.headlessKey(agent ?? { key: a.agent, run: [a.agent] });
      const address = await Sh.startHeadless({ dir, env: { ...vars, prompt }, folder: a.folder, key, command: a.command, args: a.args, prompt, labels });
      rec.address = address;
      this.patchRunning(runId, { phase: "agent", mode: "headless", address, deadline, launched: Date.now() });
    }
    await this.saveRecord(a.id, rec);
  }

  /** The space for an interactive run: the fixed one, else the one that works in the folder. */
  spaceFor(a) {
    const all = spaces();
    if (a.space && all.some((s) => s.id === a.space)) return a.space;
    const tabSpace = new Map(all.flatMap((s) => s.tabs.map((t) => [t.id, s.id])));
    const pane = panes().find((p) => p.cwd && norm(p.cwd) === norm(a.folder) && tabSpace.has(p.tab))
      ?? panes().find((p) => p.cwd && inFolder(p.cwd, a.folder) && tabSpace.has(p.tab));
    if (pane) return tabSpace.get(pane.tab);
    return all.find((s) => s.folder && norm(s.folder) === norm(a.folder))?.id ?? null;
  }

  /** Is the agent of a run done? */
  pollAgent(cx, r) {
    this.busy.add(r.runId);
    cx.spawn(async (cx) => {
      try {
        if (r.mode === "headless") {
          const info = await Sh.terminalInfo(r.address);
          if (!info || info.state === "finished") {
            const code = info?.exit_code ?? null;
            await hc(["rm", r.address]).catch(() => null);
            await this.finish(cx, r, code === 0 ? "ok" : "failed", code === 0 ? "" : `The agent gave exit code ${code ?? "?"}.`, code);
            return;
          }
        } else {
          const t = terminals().find((x) => x.address === r.address);
          if (!t || t.state === "finished") return await this.finish(cx, r, "failed", "The agent tab was closed.");
          const status = t.status ?? agents().find((x) => x.address === r.address)?.status;
          const worked = r.sawWorking || status === "working" || (t.turn ?? 0) > (r.turn ?? 0);
          if (worked && !r.sawWorking) this.patchRunning(r.runId, { sawWorking: true });
          if (status === "blocked" && !r.blockedAt) {
            this.patchRunning(r.runId, { blockedAt: Date.now() });
            const a = this.def(r.automationId);
            if (a && a.notify !== "never") notify({ title: `Automation: ${a.name}`, body: "The agent needs you.", level: "warning", timeout: 10000, action: { name: "agent.focus", args: { terminal: r.address } } });
          } else if (status !== "blocked" && r.blockedAt) this.patchRunning(r.runId, { blockedAt: null });
          if (worked && (status === "done" || status === "idle")) return await this.finish(cx, r, "ok", "");
          if (!worked && Date.now() - (r.launched ?? 0) > START_MS) return await this.finish(cx, r, "failed", "The agent did not start to work.");
        }
        if (Date.now() > (r.deadline ?? Infinity)) {
          if (r.mode === "headless") await hc(["kill", r.address]).catch(() => null);
          await this.finish(cx, r, "timed out", "The agent ran longer than the timeout.");
        }
      } catch (e) {
        await this.finish(cx, r, "failed", `Error: ${e?.message ?? e}`);
      } finally {
        this.busy.delete(r.runId);
      }
    });
  }

  /** The agent ended: result, post-script, tab end. */
  async finish(cx, r, status, reason, exitCode) {
    if (!this.running().some((x) => x.runId === r.runId && x.phase === "agent")) return;
    this.patchRunning(r.runId, { phase: "post" });
    const a = this.def(r.automationId) ?? S.normalize({ id: r.automationId, name: r.automationId });
    const dir = S.runDir(r.runId);
    const loc = this.local.get(r.runId) ?? { vars: this.vars(a, r.runId, "", {}), rec: { id: r.runId } };
    const { vars, rec } = loc;

    // The agent's text: its terminal (interactive) or its output file (headless).
    let agentText = "";
    if (r.mode === "interactive") agentText = await Sh.readTerminal(r.address, 200).catch(() => "");
    else agentText = await this.readBig(`${dir}/output.txt`);
    await S.writeFile(`${dir}/tail.txt`, Sh.tail(agentText, 200));

    let result = await S.runFile(r.runId, "result.md");
    if (status === "ok" && a.requireResult && !result.trim()) { status = "failed"; reason = "No result: the agent did not write the result file."; }
    rec.result = clip(result, RESULT_MAX);
    rec.exit = exitCode ?? null;

    let postOk = true;
    if (a.post.cmd.trim()) {
      const env = {
        ...vars,
        status,
        reason,
        result_file: `${dir}/result.md`,
        result: result.slice(0, RESULT_MAX),
        output_file: `${dir}/output.txt`,
        tail_file: `${dir}/tail.txt`,
        terminal: r.address ?? "",
      };
      const p = await Sh.runScript({ dir, name: "post", cmd: a.post.cmd, env, folder: a.folder || dir, timeout: a.post.timeout });
      await S.writeFile(`${dir}/post.out`, p.out);
      rec.post = { code: p.code, out: clip(p.out) };
      postOk = p.code === 0;
      if (!postOk && status === "ok") { status = "failed"; reason = `The post-script failed (exit code ${p.code}).`; }
    }

    if (r.mode === "interactive" && (a.tabEnd === "close" || (a.tabEnd === "close-ok" && status === "ok" && postOk))) {
      const tab = panes().find((p) => p.terminal === r.address)?.tab;
      if (tab) run("tab.close", { id: tab, confirmed: true });
    }
    await this.end(cx, r.runId, status, reason);
  }

  /** Reads a file that can be larger than readTextFile takes: the last 200 lines. */
  async readBig(path) {
    try {
      const text = await readTextFile(path);
      if (text != null) return text;
    } catch { /* too large */ }
    try {
      const r = Sh.isWin()
        ? await exec("pwsh", ["-NoProfile", "-Command", `Get-Content -Tail 200 -LiteralPath '${path.replace(/'/g, "''")}'`], { timeout: 15000 })
        : await exec("tail", ["-n", "200", path], { timeout: 15000 });
      return r.stdout;
    } catch {
      return "";
    }
  }

  /** The run ended (any phase). */
  async end(cx, runId, status, reason) {
    const entry = this.running().find((x) => x.runId === runId);
    const automationId = entry?.automationId ?? this.local.get(runId)?.a?.id;
    this.dropRunning(runId);
    const loc = this.local.get(runId);
    this.local.delete(runId);
    if (!automationId) return;
    this.quiet.set(automationId, Date.now() + QUIET_MS);
    const rec = { ...(loc?.rec ?? { id: runId }), status, reason, end: Date.now() };
    await this.saveRecord(automationId, rec);
    const a = this.def(automationId);
    if (a) this.toast(a, status, reason, runId);
    // A queued trigger runs now.
    const queue = S.getShared(KEY.queue, {});
    const q = queue[automationId];
    if (q && a && !this.running().some((x) => x.automationId === automationId)) {
      const rest = { ...queue };
      delete rest[automationId];
      setShared(KEY.queue, rest);
      this.fire(cx, a, q.trigger, q.vars ?? {});
    }
  }

  toast(a, status, reason, runId) {
    const n = a.notify;
    if (n === "never") return;
    const show = status === "failed" || status === "timed out" || n === "all" || (n === "skips" && status === "skipped");
    if (!show) return;
    setShared(KEY.focus, { automation: a.id, run: runId });
    const level = status === "ok" ? "success" : status === "skipped" ? "info" : "error";
    notify({ title: `Automation: ${a.name || "(no name)"}`, body: `${status}${reason ? `: ${reason}` : ""}`, level, timeout: 8000, action: { name: "mod.open", args: { name: S.MOD } } });
  }

  // ---- history -------------------------------------------------------------------------

  /** Adds or replaces a run summary in the history index, keeps the last 50, writes the file. */
  async saveRecord(automationId, rec) {
    this.writing = (this.writing ?? Promise.resolve()).then(() => this.writeRecord(automationId, rec)).catch(() => null);
    return this.writing;
  }

  async writeRecord(automationId, rec) {
    for (let i = 0; i < 3; i++) {
      const cur = await S.loadRuns();
      const index = cur.index;
      const list = Array.isArray(index[automationId]) ? index[automationId] : [];
      const at = list.findIndex((x) => x.id === rec.id);
      const next = at >= 0 ? list.map((x, j) => (j === at ? { ...x, ...rec } : x)) : [rec, ...list];
      const dropped = next.slice(S.KEEP_RUNS);
      index[automationId] = next.slice(0, S.KEEP_RUNS);
      // Remove the history of automations that are gone (not while their runs are listed).
      const known = new Set(this.defs.map((a) => a.id));
      const gone = Object.keys(index).filter((id) => this.defs.length && !known.has(id) && id !== automationId);
      for (const id of gone) { dropped.push(...(index[id] ?? [])); delete index[id]; }
      try {
        await S.ensureDir(S.dataDir());
        await writeTextFile(S.runsPath(), `${JSON.stringify(index)}\n`, cur.text);
        this.index = index;
        setShared(KEY.runsRev, Date.now());
        for (const d of dropped) if (d?.id) await S.removeRunDir(d.id);
        return;
      } catch {
        // Another write came first: read again.
      }
    }
  }
}
