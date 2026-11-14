// skill-bundles: the state of the agent skills of the focused project, and the actions that
// change them. It reads a Catalog (a repository with bundles.yaml), the project's Manifest
// (skills.yaml) and Lock (skills-lock.json), and runs `npx skills` to install or remove.
// A project without a Manifest shows the skills of its Lock, by repository; `npx skills check`
// finds their updates and `npx skills update` installs them. It needs no Catalog.
// The words are the ones of CONTEXT.md.
//
// Roles (props.part):
//   (none)    the panel: a Dock panel (dock/panels.json) or a pane.
//   "status"  the status bar item. A click opens the panel in a dialog.
//   "dialog"  the panel in a dialog (the status item and the command skill-bundles.open).
//
// Every copy reads on its own (a node run of probe.mjs takes about 0.2 s). The fetch of the
// Catalog and the running action are shared() keys, so that 2 copies do not do them twice.

import { View, div } from "gpui-kit";
import { InputState } from "gpui-base";
import { theme, props, shared, setShared, focused, spaces, panes, readTextFile, notify, run, openOverlay, nextCommand, settings, closeOverlay, knownAgents } from "herdr";
import * as C from "./catalog.js";
import { writeFileOn } from "./remote.js";
import { parseCatalog, parseManifest, formatManifest, resolveManifest, sameRepo, withSource, withoutSource, withGitignoreBlock, orderBundles } from "./manifest.js";
import { buildRows, groupRows, pending, lockHash } from "./status.js";
import { STR, fill } from "./text.js";
import { panelView, statusView } from "./view.js";

// The mods-hub can turn this mod off (shared "herdr-mods.disabled", a list of mod names). Then the mod draws
// nothing, closes its dialog and skips its timed work. The bars hide its blocks and buttons.
const kitOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes("skill-bundles"); };
const offView = () => { const o = props()?.overlay; if (o) closeOverlay(o); return div(); };

const MOD = "skill-bundles";
const KEY = {
  lang: "herdr-mods.lang", // the kit language, set in mods-hub
  catalog: "skill-bundles.catalog", // "owner/name" of the Catalog
  clone: "skill-bundles.clone", // optional: the person's own clone of the Catalog
  gitUrl: "skill-bundles.gitUrl", // optional: the URL for `git clone` (default: GitHub SSH)
  minutes: "skill-bundles.fetchMinutes", // minutes between 2 fetches of the Catalog
  fetched: "skill-bundles.fetchedAt", // { "<clone dir>": time of the last fetch }
  job: "skill-bundles.job", // { project, label, at } while an action runs, else null
  changed: "skill-bundles.changed", // { project, at }: an action ended; copies read again
  offerUpdate: "skill-bundles.offerUpdate", // false: no toast that offers to update Outdated skills
  offered: "skill-bundles.offered", // { "<machine>|<root>": signature }: the offers already shown
  offerNow: "skill-bundles.offerNow", // the last offer: { root, machine, host, name, groups, plain, at }
  // The last `npx skills check` of each project without a Manifest:
  // { "<machine>|<root>": { at, outdated: { skill: Lock hash at that time }, failed: [repository], error } }
  checks: "skill-bundles.checks",
};
const DEFAULT_MINUTES = 15;
const CHECK_MS = 60 * 1000; // the timer: read the project again, and fetch when due
// The copy that runs a job renews its time on the CHECK_MS timer. A job that is not renewed
// for this long is from a copy that stopped (a reload of the mod in the middle of it).
const JOB_STALE_MS = 150 * 1000;

const lastCwd = new Map(); // machine ("" for this computer) → the last folder of a terminal there

/** Where the focused work is: { cwd, machine }. As in ci-dash: the pane, the tab, the space. */
function location() {
  const f = focused();
  const space = spaces().find((s) => s.id === f?.space) || spaces().find((s) => s.active);
  const all = panes();
  const pane = f?.pane ? all.find((p) => p.pane === f.pane) : null;
  const inTab = all.find((p) => p.tab === f?.tab && p.cwd)?.cwd;
  const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const inSpace = all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd;
  const machine = space?.machine ?? null;
  const cwd = pane?.cwd || f?.cwd || inTab || inSpace || lastCwd.get(machine ?? "") || space?.folder || null;
  if (pane?.cwd || f?.cwd || inTab || inSpace) lastCwd.set(machine ?? "", cwd);
  return { cwd, machine };
}

const baseName = (p) => String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
const errorText = (e) => String(e?.message ?? e);

// One clone at a time for each folder, when 2 copies start together.
const cloning = new Map();
function cloneOnce(slug, dir, gitUrl) {
  if (!cloning.has(dir)) cloning.set(dir, C.ensureClone(slug, dir, gitUrl).finally(() => cloning.delete(dir)));
  return cloning.get(dir);
}

// One `npx skills check` at a time for each project ("<machine>|<root>"), in all copies.
const checking = new Map();
const whereOf = (p) => `${p.machine ?? ""}|${p.root}`;

export default class SkillBundles extends View {
  init(given, cx) {
    // Read props once: props() in a later callback can answer for another copy.
    this.props = (given && Object.keys(given).length ? given : props()) || {};
    this.part = this.props.part ?? "panel";
    this.cat = { state: "loading" }; // see loadCatalog
    this.proj = { state: "loading" }; // see loadProject
    this.mode = "list"; // "list" | "bundles" | "add" | "repo"
    this.pick = new Set(); // the Bundles chosen in the "bundles" mode and the start view
    this.persist = false; // "Keep in skills.yaml" of the "add" mode
    this.error = null; // { text } of the last failed action of this copy
    this.locKey = null;
    this.settingsKey = null;
    this.changedAt = shared(KEY.changed)?.at ?? 0;
    this.keys = cx.focus_handle();
    this.confirm = null; // { fix, until }: a dangerous action waits for a second click (see armed)
    this.collapsed = new Set(); // the keys of the folded groups of the list (UI state of this copy)
    try { this.collapsed = new Set(JSON.parse(localStorage.getItem("collapsed") ?? "[]")); } catch {}
    this.agents = []; // the installed agents, most picked first, for "Commit and push with an agent"
    if (this.part !== "status") {
      this.query = InputState.new({ placeholder: this.str.search });
      this.query.on("change", (_e, cx) => cx.notify());
      // The "repo" mode: a repository to install a skill from, and the skills that it offers.
      this.repoInput = InputState.new({ placeholder: this.str.repoPlaceholder });
      this.repoList = null; // { repo, state: "loading" | "ready" | "error", skills: [{ name, desc }], error }
      cx.spawn(async (cx) => {
        try { this.agents = (await knownAgents()).filter((a) => a.installed && a.run?.length); } catch {}
        cx.notify();
      });
    }
    cx.timer.every(CHECK_MS, (cx) => {
      if (kitOff()) return;
      if (this.running) setShared(KEY.job, { ...(shared(KEY.job) ?? {}), at: Date.now() });
      // The status copy reads at once. A panel copy only asks for a read: render() does it, and
      // Herdr does not draw a hidden copy, so a hidden panel runs no git until it shows again.
      if (this.part === "status") this.reload(cx, false);
      else { this.due = true; cx.notify(); }
    });
    // "skill-bundles.open" (a key, or herdr-app do) opens the panel as a dialog. Only the status
    // copy listens: a command reaches every shown copy, so more listeners open more dialogs.
    // The panel copies listen for "sync" (Update all) and "fetch" (fetch the Catalog now). With
    // a panel and a dialog shown, both get the command: the shared job lets only one act.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        // "update-offered": a click on the toast of offerUpdate(). Every shown copy gets it; the
        // shared job lets only one act.
        if (c === "update-offered") { this.updateOffered(cx); continue; }
        if (this.part === "status") { if (c === "open") this.openDialog(); continue; }
        if (c === "fetch") this.reload(cx, true);
        if (c === "add" && this.proj.state === "ready") this.setMode("repo", cx);
        if (c === "sync" && this.proj.state === "ready" && (!this.proj.manifest || this.cat.state === "ready")) this.syncAll(cx);
      }
    });
  }

  get lang() {
    const kit = shared(KEY.lang);
    return STR[kit] ? kit : STR[this.props.lang] ? this.props.lang : "en";
  }

  get str() {
    return STR[this.lang];
  }

  // ---- reading ----------------------------------------------------------------------------

  /** Reads the Catalog (and fetches it when due or forced), then the project. */
  reload(cx, force) {
    if (this.reading) { this.again = { force: force || this.again?.force }; return; }
    this.reading = true;
    cx.spawn(async (cx) => {
      try {
        await this.loadCatalog(cx, force);
        await this.loadProject();
      } catch (e) {
        if (this.cat.state === "ready" || this.cat.state === "unset") this.proj = { state: "error", error: errorText(e) };
        else this.cat = { state: "error", slug: this.cat.slug, error: errorText(e) };
      } finally {
        this.reading = false;
      }
      cx.notify();
      this.checkUpdates(cx, force);
      if (this.again) { const { force: f } = this.again; this.again = null; this.reload(cx, f); }
    });
  }

  /**
   * A project without a Manifest: runs `npx skills check` there when the last check is older
   * than the fetch interval (or `force`). The check downloads each repository of the Lock, so it
   * runs in the background. Its result goes to KEY.checks, and every copy reads the project again.
   */
  checkUpdates(cx, force) {
    const p = this.proj;
    if (p.state !== "ready" || p.manifest || this.job()) return;
    const lock = p.probe?.lock ?? {};
    if (!Object.values(lock).some((e) => e?.sourceType)) return;
    const where = whereOf(p);
    const minutes = Number(shared(KEY.minutes)) > 0 ? Number(shared(KEY.minutes)) : DEFAULT_MINUTES;
    const last = (shared(KEY.checks) ?? {})[where];
    if (checking.has(where) || (!force && last && Date.now() - last.at < minutes * 60 * 1000)) return;
    const work = C.checkUpdates(p.root, p.host).finally(() => checking.delete(where));
    checking.set(where, work);
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await work;
      const outdated = {};
      for (const name of r.names) if (lock[name]) outdated[name] = lockHash(lock[name]);
      setShared(KEY.checks, { ...(shared(KEY.checks) ?? {}), [where]: { at: Date.now(), outdated, failed: r.failed, error: r.error } });
      setShared(KEY.changed, { project: p.root, at: Date.now() });
      cx.notify();
    });
  }

  /** Reads only the project (a new focus, or an action ended). */
  reloadProject(cx) {
    if (this.reading) { this.again ??= { force: false }; return; }
    this.reading = true;
    cx.spawn(async (cx) => {
      try { await this.loadProject(); } catch (e) { this.proj = { state: "error", error: errorText(e) }; }
      finally { this.reading = false; }
      cx.notify();
      this.checkUpdates(cx, false);
      if (this.again) { const { force } = this.again; this.again = null; this.reload(cx, force); }
    });
  }

  /**
   * this.cat: { state: "unset" } | { state: "cloning", slug } | { state: "error", slug, error } |
   * { state: "ready", slug, dir, own, catalog, commit, ref, fetchError }
   */
  async loadCatalog(cx, force) {
    const slug = C.repoSlug(shared(KEY.catalog));
    if (!slug) { this.cat = { state: "unset" }; return; }
    const own = String(shared(KEY.clone) ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    const dir = own || C.ownCloneDir(slug);
    const previous = this.cat.dir === dir ? this.cat : null;
    if (!own) {
      const there = (await readTextFile(`${dir}/bundles.yaml`).catch(() => null)) !== null;
      if (!there) { this.cat = { state: "cloning", slug }; cx.notify(); }
      const error = await cloneOnce(slug, dir, String(shared(KEY.gitUrl) ?? "").trim());
      if (error) { this.cat = { state: "error", slug, error }; return; }
    }
    let fetchError = previous?.fetchError ?? null;
    const minutes = Number(shared(KEY.minutes)) > 0 ? Number(shared(KEY.minutes)) : DEFAULT_MINUTES;
    const times = shared(KEY.fetched) ?? {};
    if (force || Date.now() - (times[dir] ?? 0) > minutes * 60 * 1000) {
      setShared(KEY.fetched, { ...times, [dir]: Date.now() });
      if (force) { this.cat = { ...(previous ?? { state: "loading" }), fetching: true }; cx.notify(); }
      fetchError = own ? await C.pullOwnClone(dir) : await C.updateOwnClone(dir);
    }
    const text = await readTextFile(`${dir}/bundles.yaml`).catch(() => null);
    if (text === null) { this.cat = { state: "error", slug, error: `${dir}/bundles.yaml was not found.` }; return; }
    const catalog = parseCatalog(text);
    if (!catalog.repo) catalog.repo = slug;
    this.cat = {
      state: "ready", slug, dir, own: Boolean(own), catalog, fetchError,
      commit: await C.headCommit(dir),
      ref: own ? await C.ownCloneRef(dir) : { branch: null },
    };
  }

  /**
   * this.proj: { state: "none" } | { state: "ready", root, name, machine, host,
   * manifestText, manifest, probe, rows, groups, counts, unknown } | { state: "error", error }
   * `machine`: the project's machine (null: this computer). Its files and `npx skills` are read
   * and run there; the Catalog clone stays on this computer. `host`: { on, windows } for npx.
   */
  async loadProject() {
    const loc = location();
    const on = loc.machine;
    const root = await C.gitRoot(loc.cwd, on);
    if (!root) { this.proj = { state: "none" }; return; }
    const manifestText = await (on ? readTextFile(`${root}/skills.yaml`, { on }) : readTextFile(`${root}/skills.yaml`)).catch(() => null);
    const manifest = manifestText === null ? null : parseManifest(manifestText);
    const catalog = this.cat.state === "ready" ? this.cat.catalog : null;
    const probe = await C.probe(root, catalog ? this.cat.dir : null, catalog?.repo ?? null, on);
    const host = on ? { on, windows: probe.platform ? probe.platform === "win32" : /^[A-Za-z]:/.test(root) } : null;
    const check = (shared(KEY.checks) ?? {})[whereOf({ machine: on, root })] ?? null;
    const { rows, unknown, counts } = buildRows({ manifest, catalog, probe: probe.error ? null : probe, check });
    // Another project: the Bundle choice and the mode of the old one do not apply.
    if (this.proj.root !== root || this.proj.machine !== on) { this.pick = new Set(); this.mode = "list"; this.error = null; }
    this.proj = {
      state: "ready", root, name: on ? `${baseName(root)} · ${on}` : baseName(root), machine: on, host, manifestText, manifest, probe,
      rows, groups: groupRows(rows, manifest), counts, unknown, check,
    };
    this.offerUpdate();
  }

  // ---- the update offer -------------------------------------------------------------------

  /**
   * When the project has Outdated skills, posts a toast once that offers to update them. A click
   * on the toast runs "skill-bundles.update-offered". The shared key KEY.offered keeps the
   * signature of each offer (the names of the Outdated skills), so 2 copies and later reads do
   * not show the same offer again. A new set of Outdated skills gives a new offer.
   */
  offerUpdate() {
    const p = this.proj;
    if (shared(KEY.offerUpdate) === false || p.state !== "ready") return;
    // With a Manifest, the update installs from the Catalog. Without one, `npx skills update` does it.
    if (p.manifest && (this.cat.state !== "ready" || this.installBlock())) return;
    if (this.job()) return;
    const outdated = (p.rows ?? []).filter((r) => r.state === "outdated");
    const where = `${p.machine ?? ""}|${p.root}`;
    const offered = shared(KEY.offered) ?? {};
    if (!outdated.length) {
      // All up to date: forget the old offer, so the same skills give a new offer later.
      if (offered[where]) { const { [where]: _gone, ...rest } = offered; setShared(KEY.offered, rest); }
      return;
    }
    const names = outdated.map((r) => r.name).sort();
    const signature = names.join(",");
    if (offered[where] === signature) return;
    setShared(KEY.offered, { ...offered, [where]: signature });
    const byRepo = new Map();
    for (const r of outdated) {
      if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
      byRepo.get(r.repo).push(r.name);
    }
    setShared(KEY.offerNow, {
      root: p.root, machine: p.machine, host: p.host, name: p.name, at: Date.now(), plain: !p.manifest,
      groups: [...byRepo].map(([repo, skills]) => ({ repo, skills })),
    });
    const s = this.str;
    const list = names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
    notify({
      title: fill(s.offerTitle, { n: names.length, project: p.name }),
      body: fill(s.offerBody, { list }),
      level: "warning",
      timeout: 20000,
      action: { name: `${MOD}.update-offered` },
    });
  }

  /** A click on the toast of offerUpdate(): installs the Outdated skills of that offer. */
  updateOffered(cx) {
    const o = shared(KEY.offerNow);
    if (!o?.root || !o.groups?.length || (!o.plain && this.cat.state !== "ready")) return;
    const project = { state: "ready", root: o.root, machine: o.machine ?? null, host: o.host ?? null, name: o.name };
    const n = o.groups.reduce((sum, g) => sum + g.skills.length, 0);
    const work = o.plain ? (p) => this.updateNames(p, o.groups.flatMap((g) => g.skills)) : (p) => this.install(p, o.groups);
    this.act(cx, fill(o.plain ? this.str.busyUpdate : this.str.busyInstall, { n }), work, fill(this.str.offerDone, { n }), project);
  }

  /**
   * Reads again when the focus moves to another folder, a setting changes or an action ends.
   * It runs in render, where cx.notify() is not allowed: the read starts on a timer.
   */
  watchChanges(cx) {
    const loc = location();
    const locKey = `${loc.machine ?? ""}|${loc.cwd ?? ""}`;
    const settingsKey = [shared(KEY.catalog), shared(KEY.clone), shared(KEY.gitUrl)].map((v) => String(v ?? "")).join("|");
    const changed = shared(KEY.changed)?.at ?? 0;
    if (settingsKey !== this.settingsKey) {
      this.settingsKey = settingsKey;
      this.locKey = locKey;
      cx.timer.after(1, (cx) => this.reload(cx, false));
    } else if (locKey !== this.locKey || changed !== this.changedAt) {
      this.locKey = locKey;
      this.changedAt = changed;
      cx.timer.after(1, (cx) => this.reloadProject(cx));
    }
  }

  // ---- actions ----------------------------------------------------------------------------

  /** The running action, if it is not stale. */
  job() {
    const j = shared(KEY.job);
    return j && Date.now() - (j.at ?? 0) < JOB_STALE_MS ? j : null;
  }

  /** Why the mod must not install now (the person's own clone), or null. */
  installBlock() {
    const ref = this.cat.ref;
    if (!ref?.problem) return null;
    return fill(this.str[`problem_${ref.problem}`], { branch: ref.branch ?? "" });
  }

  /**
   * The fixes for a problem of the person's own clone (ownCloneRef): [{ id, label, tip, kind, run }].
   * A clone with a problem is not pulled and must not be installed from.
   */
  cloneFixes() {
    const ref = this.cat.ref;
    if (!this.cat.own || !ref?.problem) return [];
    const s = this.str;
    const waiting = this.waiting();
    const git = (id, kind) => ({
      id, kind,
      label: waiting === id ? s.confirmAgain : s[`fix_${id}`],
      tip: fill(s[`fix_${id}Tip`], { branch: ref.current ?? "" }),
      run: (cx) => this.fixClone(cx, id, kind === "danger"),
    });
    const list = [];
    if (ref.problem === "dirty") list.push(git("stash", "primary"), git("discard", "danger"));
    if (ref.problem === "ahead") list.push(git("push", "primary"));
    if (ref.problem === "unpushed") list.push(git("pushBranch", "primary"));
    if (ref.problem === "diverged") list.push(git("reset", "danger"));
    if (ref.problem === "dirty" || ref.problem === "diverged") {
      const agent = this.agents[0];
      list.push({
        id: "agent", kind: "plain",
        label: agent ? fill(s.fix_agent, { agent: agent.name }) : s.fix_terminal,
        tip: agent ? s.fix_agentTip : s.fix_terminalTip,
        run: () => this.agentFix(agent),
      });
    }
    list.push({ id: "useMod", kind: "plain", label: s.fix_useMod, tip: s.fix_useModTip, run: () => setShared(KEY.clone, "") });
    return list;
  }

  /** The key of the action that waits for a second click, or null. */
  waiting() {
    return this.confirm && this.confirm.until > Date.now() ? this.confirm.fix : null;
  }

  /**
   * A dangerous action asks for a second click within 5 s. Returns true on the second click;
   * on the first one, the button shows "Click again to confirm".
   */
  armed(cx, key) {
    if (this.waiting() === key) { this.confirm = null; return true; }
    this.confirm = { fix: key, until: Date.now() + 5000 };
    cx.notify();
    cx.timer.after(5100, (cx) => cx.notify()); // the button shows its own label again
    return false;
  }

  /** Runs a git fix in the person's own clone, then fetches and reads again. */
  fixClone(cx, fix, danger) {
    if (this.job() || this.cat.state !== "ready") return;
    if (danger && !this.armed(cx, fix)) return;
    const { dir, ref } = this.cat;
    setShared(KEY.job, { project: null, label: this.str.busyFix, at: Date.now() });
    this.running = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let failed = null;
      try { failed = await C.fixClone(dir, fix, ref?.current ?? ""); } catch (e) { failed = errorText(e); }
      this.running = false;
      setShared(KEY.job, null);
      if (failed) this.error = { text: failed };
      cx.notify();
      this.reload(cx, true);
    });
  }

  /** Opens a new space in the clone with an agent that commits and pushes (or a plain terminal). */
  agentFix(agent) {
    const folder = C.native(this.cat.dir);
    const task = "This folder is a Git clone of a skill Catalog. Commit the changes that are not committed, with a clear message. Then bring in the new commits of the remote with git pull --rebase, and push. Ask me before you discard a change.";
    run("space.new", { name: "Catalog clone", folder, machine: "", ...(agent ? { argv: agent.run, task } : {}) });
  }

  /** The package for `npx skills add`: the Catalog at the branch of the person's own clone. */
  pkg(repo) {
    const catalog = this.cat.catalog;
    return catalog && this.cat.ref?.branch && sameRepo(repo, catalog.repo) ? `${catalog.repo}#${this.cat.ref.branch}` : repo;
  }

  /** Runs one action for the project, then reads again and posts a toast with what changed. */
  act(cx, label, work, doneBody = null, project = this.proj) {
    if (this.job() || project.state !== "ready") return;
    const before = project.probe?.lock ?? {};
    setShared(KEY.job, { project: project.root, label, at: Date.now() });
    this.running = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let failed = null;
      try {
        await work(project);
      } catch (e) {
        failed = errorText(e);
      }
      this.running = false;
      setShared(KEY.job, null);
      try { await this.loadProject(); } catch (e) { failed ??= errorText(e); }
      this.changedAt = Date.now();
      setShared(KEY.changed, { project: project.root, at: this.changedAt });
      if (failed) {
        this.error = { text: failed };
        notify({ title: fill(this.str.doneTitle, { project: project.name }), body: `${this.str.failed}: ${failed.split("\n").pop()}`, level: "error", timeout: 8000 });
      } else {
        const after = this.proj.probe?.lock ?? {};
        const added = Object.keys(after).filter((k) => !before[k]).length;
        const removed = Object.keys(before).filter((k) => !after[k]).length;
        const updated = Object.keys(after).filter((k) => before[k] && (before[k].computedHash ?? "") !== (after[k].computedHash ?? "")).length;
        notify({ title: fill(this.str.doneTitle, { project: project.name }), body: doneBody ?? fill(this.str.doneBody, { updated, added, removed }), timeout: 5000 });
        this.mode = "list";
      }
      cx.notify();
    });
  }

  /** `npx skills add` for each repository: [{ repo, skills }], in project `p` (on its machine). */
  async install(p, groups) {
    // A problem of the person's own clone stops only an install from the Catalog.
    const blocked = this.installBlock();
    for (const g of groups) {
      if (!g.skills.length) continue;
      if (blocked && sameRepo(g.repo, this.cat.catalog?.repo)) throw new Error(blocked);
      setShared(KEY.job, { ...(shared(KEY.job) ?? {}), label: fill(this.str.busyInstall, { n: g.skills.length }), at: Date.now() });
      const r = await C.npx(["skills", "add", this.pkg(g.repo), "-s", ...g.skills, "-y"], p.root, p.host);
      if (r.code !== 0) throw new Error(C.tail(r) || `npx skills add ${g.repo}`);
    }
  }

  /**
   * `npx skills update <names> -p -y` in a project without a Manifest. The names are given:
   * without them, the command also installs the skills of the Lock that are not in the project.
   */
  async updateNames(p, names) {
    if (!names.length) return;
    const r = await C.npx(["skills", "update", ...names, "-p", "-y"], p.root, p.host);
    if (r.code !== 0) throw new Error(C.tail(r) || "npx skills update");
  }

  /** Updates the Outdated rows of a project without a Manifest. */
  updatePlain(cx, rows) {
    const names = rows.filter((r) => r.state === "outdated").map((r) => r.name);
    if (!names.length) return;
    this.act(cx, fill(this.str.busyUpdate, { n: names.length }), async (p) => this.updateNames(p, names));
  }

  async uninstall(p, names) {
    if (!names.length) return;
    const r = await C.npx(["skills", "remove", ...names, "-y"], p.root, p.host);
    if (r.code !== 0) throw new Error(C.tail(r) || "npx skills remove");
  }

  /** The skills of a Manifest, grouped by repository, for install(). */
  required(manifest) {
    const { required } = resolveManifest(manifest, this.cat.catalog);
    const byRepo = new Map();
    for (const [name, { repo }] of required) {
      if (!byRepo.has(repo)) byRepo.set(repo, []);
      byRepo.get(repo).push(name);
    }
    return { names: new Set(required.keys()), groups: [...byRepo].map(([repo, skills]) => ({ repo, skills })) };
  }

  async writeManifest(project, manifest) {
    await writeFileOn(project.machine, `${project.root}/skills.yaml`, formatManifest(manifest), project.manifestText);
  }

  /**
   * Update all: installs only the skills that differ (Missing and Outdated), grouped by
   * repository, as a click on Install or Update of each row. Up-to-date skills are not touched.
   */
  syncAll(cx) {
    if (!this.proj.manifest) return this.updatePlain(cx, this.proj.rows ?? []);
    const byRepo = new Map();
    for (const r of this.proj.rows ?? []) {
      if (r.state !== "missing" && r.state !== "outdated") continue;
      if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
      byRepo.get(r.repo).push(r.name);
    }
    if (!byRepo.size) return;
    const groups = [...byRepo].map(([repo, skills]) => ({ repo, skills }));
    this.act(cx, this.str.syncAll, async (p) => this.install(p, groups));
  }

  installOne(cx, row) {
    if (row.plain && row.state === "outdated") return this.updatePlain(cx, [row]);
    this.act(cx, fill(this.str.busyInstall, { n: 1 }), async (p) => this.install(p, [{ repo: row.repo, skills: [row.name] }]));
  }

  removeExtra(cx, row) {
    this.act(cx, fill(this.str.busyRemove, { list: row.name }), async (p) => this.uninstall(p, [row.name]));
  }

  /**
   * Deletes a Local skill (a folder with a SKILL.md and no Lock entry) from .agents/skills and
   * .claude/skills. It asks for a second click: the folder does not go to the trash.
   */
  removeLocal(cx, row) {
    if (row.state !== "local" || !/^[\w.-]+$/.test(row.name) || /^\.+$/.test(row.name)) return;
    if (this.job() || !this.armed(cx, `local:${row.name}`)) return;
    this.act(cx, fill(this.str.busyRemove, { list: row.name }), async (p) => {
      for (const sub of [".agents/skills", ".claude/skills"]) {
        const error = await C.removeFolder(`${p.root}/${sub}/${row.name}`, p.machine);
        if (error) throw new Error(error);
      }
    }, fill(this.str.localRemoved, { name: row.name }));
  }

  // ---- batch actions on a group of the list --------------------------------------------------

  /** The rows of a group (by its key "<kind>:<key>") in the current project. */
  groupRowsOf(key) {
    return this.proj.groups?.find((g) => `${g.kind}:${g.key}` === key)?.rows ?? [];
  }

  /** Installs the Missing and Outdated skills of a group, grouped by repository. */
  updateGroup(cx, key) {
    if (!this.proj.manifest) return this.updatePlain(cx, this.groupRowsOf(key));
    const byRepo = new Map();
    for (const r of this.groupRowsOf(key)) {
      if (r.state !== "missing" && r.state !== "outdated") continue;
      if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
      byRepo.get(r.repo).push(r.name);
    }
    if (!byRepo.size) return;
    const groups = [...byRepo].map(([repo, skills]) => ({ repo, skills }));
    this.act(cx, fill(this.str.busyInstall, { n: groups.reduce((n, g) => n + g.skills.length, 0) }), async (p) => this.install(p, groups));
  }

  /** Keep all: adds every Extra skill to sources: in skills.yaml, in one write. */
  keepAllExtra(cx) {
    const rows = this.groupRowsOf("extra:extra");
    if (!rows.length || !this.proj.manifest) return;
    this.act(cx, this.str.busyWrite, async (p) => {
      let next = p.manifest;
      for (const r of rows) next = withSource(next, r.repo || this.cat.catalog.repo, [r.name]);
      await this.writeManifest(p, next);
    });
  }

  /** Remove all: uninstalls every Extra skill with one `npx skills remove`. Asks for a second click. */
  removeAllExtra(cx) {
    const names = this.groupRowsOf("extra:extra").map((r) => r.name);
    if (!names.length || this.job() || !this.armed(cx, "all:extra")) return;
    this.act(cx, fill(this.str.busyRemove, { list: names.join(", ") }), async (p) => this.uninstall(p, names));
  }

  /** Remove all: deletes the folders of every Local skill. Asks for a second click. */
  removeAllLocal(cx) {
    const names = this.groupRowsOf("local:local").map((r) => r.name).filter((n) => /^[\w.-]+$/.test(n) && !/^\.+$/.test(n));
    if (!names.length || this.job() || !this.armed(cx, "all:local")) return;
    this.act(cx, fill(this.str.busyRemove, { list: names.join(", ") }), async (p) => {
      for (const name of names) {
        for (const sub of [".agents/skills", ".claude/skills"]) {
          const error = await C.removeFolder(`${p.root}/${sub}/${name}`, p.machine);
          if (error) throw new Error(error);
        }
      }
    }, fill(this.str.localRemovedAll, { n: names.length }));
  }

  /** Folds or unfolds a group of the list. The choice stays in this copy (localStorage). */
  toggleGroup(key, cx) {
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    try { localStorage.setItem("collapsed", JSON.stringify([...this.collapsed])); } catch {}
    cx.notify();
  }

  keepExtra(cx, row) {
    this.act(cx, this.str.busyWrite, async (p) => this.writeManifest(p, withSource(p.manifest, row.repo || this.cat.catalog.repo, [row.name])));
  }

  dropSource(cx, row) {
    this.act(cx, fill(this.str.busyRemove, { list: row.name }), async (p) => {
      const next = withoutSource(p.manifest, row.name);
      await this.writeManifest(p, next);
      if (!this.required(next).names.has(row.name)) await this.uninstall(p, [row.name]);
    });
  }

  /** Saves the chosen Bundles, installs the new skills and removes the skills that left. */
  applyBundles(cx) {
    const bundles = orderBundles([...this.pick]);
    this.act(cx, this.str.busyWrite, async (p) => {
      const next = { bundles, sources: p.manifest.sources };
      const before = this.required(p.manifest).names;
      const after = this.required(next);
      await this.writeManifest(p, next);
      await this.install(p, after.groups);
      const installed = new Set(Object.keys(p.probe?.lock ?? {}));
      await this.uninstall(p, [...before].filter((n) => !after.names.has(n) && installed.has(n)));
    });
  }

  /** The start view: writes skills.yaml and the .gitignore block, then installs. */
  start(cx) {
    const bundles = orderBundles([...this.pick]);
    this.act(cx, this.str.busyWrite, async (p) => {
      const manifest = { bundles, sources: [] };
      await writeFileOn(p.machine, `${p.root}/skills.yaml`, formatManifest(manifest), null);
      const path = `${p.root}/.gitignore`;
      const gitignore = await (p.machine ? readTextFile(path, { on: p.machine }) : readTextFile(path)).catch(() => null);
      const next = withGitignoreBlock(gitignore);
      if (next !== null) await writeFileOn(p.machine, path, next, gitignore);
      await this.install(p, this.required(manifest).groups);
    });
  }

  /** Add skill: installs one skill of the Catalog, and keeps it in sources: when asked. */
  addSkill(cx, name) {
    const persist = this.persist;
    const repo = this.cat.catalog.repo;
    this.act(cx, fill(this.str.busyInstall, { n: 1 }), async (p) => {
      await this.install(p, [{ repo, skills: [name] }]);
      if (persist) await this.writeManifest(p, withSource(p.manifest, repo, [name]));
    });
  }

  /** The "repo" mode: reads the skills of the repository in the field (`npx skills add <repo> --list`). */
  listRepo(cx) {
    const repo = String(this.repoInput?.value?.() ?? "").trim();
    const p = this.proj;
    if (!repo || p.state !== "ready" || this.repoList?.state === "loading") return;
    if (!C.validRepo(repo)) { this.repoList = { repo, state: "error", skills: [], error: this.str.repoInvalid }; cx.notify(); return; }
    this.repoList = { repo, state: "loading", skills: [] };
    this.query?.set_value?.("");
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await C.listRepo(repo, p.root, p.host);
      // Another repository was asked in the meantime: this answer is old.
      if (this.repoList?.repo !== repo) return;
      this.repoList = r.error ? { repo, state: "error", skills: [], error: r.error } : { repo, state: "ready", skills: r.skills };
      cx.notify();
    });
  }

  /** The "repo" mode: installs one skill of the listed repository, and keeps it in sources: when asked. */
  addFromRepo(cx, name) {
    const repo = this.repoList?.repo;
    if (!repo) return;
    const persist = this.persist && Boolean(this.proj.manifest);
    this.act(cx, fill(this.str.busyInstall, { n: 1 }), async (p) => {
      await this.install(p, [{ repo, skills: [name] }]);
      if (persist) await this.writeManifest(p, withSource(p.manifest, repo, [name]));
    });
  }

  // ---- views ------------------------------------------------------------------------------

  openDialog() {
    openOverlay({ mod: MOD, kind: "dialog", width: 620, height: 680, props: { part: "dialog", lang: this.lang } });
  }

  /** Opens the Settings tab of the mods-hub dialog on the section of this mod (both are kept in its shared state). */
  openSettings() {
    setShared("mods-hub", { ...(shared("mods-hub") ?? {}), tab: "settings", section: MOD });
    run("mod.open", { name: "mods-hub" });
  }

  setMode(mode, cx) {
    this.mode = mode;
    this.error = null;
    // As Configure-Skills.ps1: only the Bundles of the Catalog are kept; an unknown one drops on save.
    if (mode === "bundles") this.pick = new Set((this.proj.manifest?.bundles ?? ["core"]).filter((b) => this.cat.catalog?.bundles.has(b)));
    if (mode === "add" || mode === "repo") { this.persist = false; this.query?.set_value?.(""); }
    cx.notify();
  }

  togglePick(name, cx) {
    if (name === "core") return;
    if (this.pick.has(name)) this.pick.delete(name);
    else this.pick.add(name);
    cx.notify();
  }

  model() {
    const p = this.proj;
    return {
      str: this.str,
      lang: this.lang,
      part: this.part,
      cat: this.cat,
      proj: p,
      job: this.job(),
      error: this.error,
      mode: this.mode,
      pick: this.pick,
      persist: this.persist,
      query: this.query,
      repoInput: this.repoInput,
      repoList: this.repoList,
      filter: String(this.query?.value?.() ?? "").trim().toLowerCase(),
      // Without a Manifest, only an Outdated skill asks for action: the Lock is the list.
      plain: p.state === "ready" && !p.manifest,
      checking: p.state === "ready" && checking.has(whereOf(p)),
      pending: p.state !== "ready" ? 0 : p.manifest ? pending(p.counts) : p.counts.outdated,
      blocked: this.installBlock(),
      fixes: this.cloneFixes(),
      waiting: this.waiting(),
      collapsed: this.collapsed,
      settingSlug: C.repoSlug(shared(KEY.catalog)),
      a: {
        reload: (cx) => this.reload(cx, true),
        settings: () => this.openSettings(),
        mode: (m, cx) => this.setMode(m, cx),
        toggle: (name, cx) => this.togglePick(name, cx),
        persist: (cx) => { this.persist = !this.persist; cx.notify(); },
        dismiss: (cx) => { this.error = null; cx.notify(); },
        syncAll: (cx) => this.syncAll(cx),
        installOne: (row, cx) => this.installOne(cx, row),
        removeExtra: (row, cx) => this.removeExtra(cx, row),
        keepExtra: (row, cx) => this.keepExtra(cx, row),
        removeLocal: (row, cx) => this.removeLocal(cx, row),
        toggleGroup: (key, cx) => this.toggleGroup(key, cx),
        updateGroup: (key, cx) => this.updateGroup(cx, key),
        keepAllExtra: (cx) => this.keepAllExtra(cx),
        removeAllExtra: (cx) => this.removeAllExtra(cx),
        removeAllLocal: (cx) => this.removeAllLocal(cx),
        dropSource: (row, cx) => this.dropSource(cx, row),
        applyBundles: (cx) => this.applyBundles(cx),
        start: (cx) => this.start(cx),
        addSkill: (name, cx) => this.addSkill(cx, name),
        listRepo: (cx) => this.listRepo(cx),
        addFromRepo: (name, cx) => this.addFromRepo(cx, name),
        open: () => this.openDialog(),
        startPick: (cx) => { if (!this.pick.size) this.pick = new Set(["core"]); cx.notify(); },
      },
    };
  }

  render(cx) {
    if (kitOff()) return offView();
    if (this.due) { this.due = false; this.reload(cx, false); }
    this.watchChanges(cx);
    const t = theme();
    const m = this.model();
    if (this.part === "status") return statusView(t, m);
    if (m.proj.state === "ready" && !m.proj.manifest && !this.pick.size) this.pick = new Set(["core"]);
    return panelView(t, m, this.keys, settings());
  }
}
