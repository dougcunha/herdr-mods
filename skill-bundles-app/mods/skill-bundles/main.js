// skill-bundles: the agent skills of the focused project, as links to the Clone of a skill
// Catalog (a repository with bundles.yaml). The Clone is the only place with the skill files
// and with version control: a project has one link for each skill in each agent folder. The
// mod reads the project's Manifest (skills.yaml) and runs link-skills.mjs, which finds the
// state of each skill and makes or removes the links. See docs/adr/0002.
// The words are the ones of CONTEXT.md.
//
// Roles (props.part):
//   (none)    the panel: a Dock panel (dock/panels.json) or a pane.
//   "status"  the status bar item. A click opens the panel in a dialog.
//   "dialog"  the panel in a dialog (the status item and the command skill-bundles.open).
//
// Every copy reads on its own (a node run of link-skills.mjs takes about 0.2 s). The fetch of
// the Catalog and the running action are shared() keys, so that 2 copies do not do them twice.
// A read writes nothing in a project: only a click makes, changes or removes a link.

import { View, div } from "gpui-kit";
import { InputState } from "gpui-base";
import { theme, props, shared, setShared, focused, spaces, panes, readTextFile, writeTextFile, notify, run, openOverlay, nextCommand, settings, closeOverlay, knownAgents } from "herdr";
import * as C from "./catalog.js";
import { formatManifest, withSource, withoutSource, orderBundles } from "./manifest.js";
import { groupRows, countRows, pending, toLink, toRemove } from "./status.js";
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
  offerUpdate: "skill-bundles.offerUpdate", // false: no toast that offers to make and remove links
  offered: "skill-bundles.offered", // { "<root>": signature }: the offers already shown
  offerNow: "skill-bundles.offerNow", // the last offer: { root, name, link, remove, at }
  // The clones of the repositories that are not the Catalog: { "<repo in lower case>": { at, dir, behind, error } }
  sources: "skill-bundles.sources",
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

// One clone or fetch at a time for each repository that is not the Catalog, in all copies of this window.
const sourcing = new Map();
const repoId = (repo) => String(repo ?? "").split("#")[0].toLowerCase();

export default class SkillBundles extends View {
  init(given, cx) {
    // Read props once: props() in a later callback can answer for another copy.
    this.props = (given && Object.keys(given).length ? given : props()) || {};
    this.part = this.props.part ?? "panel";
    this.cat = { state: "loading" }; // see loadCatalog
    this.proj = { state: "loading" }; // see loadProject
    this.mode = "list"; // "list" | "bundles" | "add" | "repo"
    this.srcErrors = {}; // { "<repo>": text }: a repository that could not be cloned
    this.pick = new Set(); // the Bundles chosen in the "bundles" mode
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
      // The "repo" mode: a repository to link a skill from, and the skills that it has.
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
    // The panel copies listen for "sync" (Link all) and "fetch" (fetch the Catalog now). With
    // a panel and a dialog shown, both get the command: the shared job lets only one act.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        // "update-offered": a click on the toast of offerLinks(). Every shown copy gets it; the
        // shared job lets only one act.
        if (c === "update-offered") { this.applyOffered(cx); continue; }
        if (this.part === "status") { if (c === "open") this.openDialog(); continue; }
        if (c === "fetch") this.reload(cx, true);
        if (c === "add" && this.linkable()) this.setMode(this.cat.state === "ready" ? "add" : "repo", cx);
        if (c === "sync" && this.linkable()) this.syncAll(cx);
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

  /** True when the mod can make links: a project on this computer. Bundles also need the Catalog. */
  linkable() {
    return this.proj.state === "ready";
  }

  /** The clones for link-skills.mjs: the Clone of the Catalog (and its name, for a bundles.yaml without `repo:`) and the sources cache. */
  cloneInput() {
    const sourcesRoot = C.sourcesRoot();
    return this.cat.state === "ready" ? { clone: this.cat.dir, catalogRepo: this.cat.catalog.repo, sourcesRoot } : { clone: null, sourcesRoot };
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
      this.syncSources(cx, force);
      if (this.again) { const { force: f } = this.again; this.again = null; this.reload(cx, f); }
    });
  }

  /**
   * The repositories of the project that are not the Catalog: clones the ones that are not in
   * the sources cache, and fetches the others when the last fetch is older than the interval
   * (or `force`). A fetch only counts the new commits: the person updates a clone with a button.
   */
  syncSources(cx, force) {
    const p = this.proj;
    if (p.state !== "ready") return;
    if (force) this.srcErrors = {};
    const catalog = repoId(this.cat.catalog?.repo);
    const minutes = Number(shared(KEY.minutes)) > 0 ? Number(shared(KEY.minutes)) : DEFAULT_MINUTES;
    const repos = new Map();
    for (const r of p.rows) {
      if (!r.repo || r.state === "local" || repoId(r.repo) === catalog) continue;
      const id = repoId(r.repo);
      repos.set(id, { repo: r.repo, missing: (repos.get(id)?.missing ?? false) || r.state === "unsupported" });
    }
    for (const [id, { repo, missing }] of repos) {
      if (sourcing.has(id) || (missing && this.srcErrors[id])) continue;
      const last = (shared(KEY.sources) ?? {})[id];
      if (!missing && !force && last && Date.now() - (last.at ?? 0) < minutes * 60 * 1000) continue;
      const work = (async () => {
        const s = await C.ensureSource(repo);
        if (s.error) return { error: s.error, cloned: false };
        const b = await C.sourceBehind(s.dir);
        return { dir: s.dir, behind: b.behind, error: b.error, cloned: missing };
      })().finally(() => sourcing.delete(id));
      sourcing.set(id, work);
      cx.notify();
      cx.spawn(async (cx) => {
        const r = await work;
        if (!r.dir) this.srcErrors[id] = r.error;
        else setShared(KEY.sources, { ...(shared(KEY.sources) ?? {}), [id]: { at: Date.now(), dir: r.dir, behind: r.behind, error: r.error } });
        // A new clone changes the state of its skills: every copy reads the project again.
        if (r.cloned) setShared(KEY.changed, { project: p.root, at: Date.now() });
        cx.notify();
      });
    }
  }

  /** Update on a repository group: brings the clone of that repository to its remote. Every project sees the new version. */
  updateSource(cx, repo) {
    const id = repoId(repo);
    const dir = (shared(KEY.sources) ?? {})[id]?.dir;
    if (!dir || this.job()) return;
    setShared(KEY.job, { project: null, label: fill(this.str.busySource, { repo }), at: Date.now() });
    this.running = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let failed = null;
      try { failed = await C.updateOwnClone(dir); } catch (e) { failed = errorText(e); }
      this.running = false;
      setShared(KEY.job, null);
      if (failed) this.error = { text: failed };
      else setShared(KEY.sources, { ...(shared(KEY.sources) ?? {}), [id]: { at: Date.now(), dir, behind: 0, error: null } });
      setShared(KEY.changed, { project: this.proj.root ?? null, at: Date.now() });
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
      this.syncSources(cx, false);
      if (this.again) { const { force } = this.again; this.again = null; this.reload(cx, force); }
    });
  }

  /**
   * this.cat: { state: "unset" } | { state: "cloning", slug } | { state: "error", slug, error } |
   * { state: "ready", slug, dir, own, catalog, commit, ref, fetchError }
   * catalog: { repo, bundles: Map<name, skills>, descriptions: Map<name, text>, skills: [every skill of the Clone] }
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
    const read = await C.linkScript({ op: "catalog", clone: dir });
    if (read.error || !read.catalog) { this.cat = { state: "error", slug, error: read.error ?? `${dir}/bundles.yaml was not found.` }; return; }
    const catalog = {
      repo: read.catalog.repo || slug,
      bundles: new Map(read.catalog.bundles),
      descriptions: new Map(Object.entries(read.catalog.descriptions ?? {})),
      skills: read.skills ?? [],
    };
    this.cat = {
      state: "ready", slug, dir, own: Boolean(own), catalog, fetchError,
      commit: await C.headCommit(dir),
      ref: own ? await C.ownCloneRef(dir) : { branch: null },
    };
  }

  /**
   * this.proj: { state: "none" } | { state: "remote", name } | { state: "error", error } |
   * { state: "ready", root, name, manifestText, manifest, rows, groups, counts, unknown, info }
   * `info` is what link-skills.mjs read: { git, lockError, lockOther, oldGitignore, catalogError }.
   * A project on another machine is not supported yet (phase 3 of docs/adr/0002): a link must
   * point to a folder of the same computer.
   */
  async loadProject() {
    const loc = location();
    const root = await C.gitRoot(loc.cwd, loc.machine);
    if (!root) { this.proj = { state: "none" }; return; }
    if (loc.machine) { this.proj = { state: "remote", name: `${baseName(root)} · ${loc.machine}` }; return; }
    const manifestText = await readTextFile(`${root}/skills.yaml`).catch(() => null);
    const info = await C.linkScript({ op: "read", project: root, ...this.cloneInput() });
    if (info.error) { this.proj = { state: "error", error: info.error }; return; }
    // Another project: the Bundle choice and the mode of the old one do not apply.
    if (this.proj.root !== root) { this.pick = new Set(); this.mode = "list"; this.error = null; }
    const rows = info.rows ?? [];
    this.proj = {
      state: "ready", root, name: baseName(root), manifestText, manifest: info.manifest ?? null,
      rows, groups: groupRows(rows, info.manifest, this.cat.catalog?.repo ?? ""), counts: countRows(rows), unknown: info.unknown ?? [], info,
    };
    this.offerLinks();
  }

  // ---- the offer --------------------------------------------------------------------------

  /**
   * When the project has links to make (Missing skills, Copies) or to remove (Stale links),
   * posts a toast once that offers to do it. A click on the toast runs
   * "skill-bundles.update-offered". The shared key KEY.offered keeps the signature of each
   * offer, so 2 copies and later reads do not show the same offer again.
   */
  offerLinks() {
    const p = this.proj;
    if (shared(KEY.offerUpdate) === false || !this.linkable() || this.job()) return;
    const link = toLink(p.rows).sort();
    const remove = toRemove(p.rows).sort();
    const offered = shared(KEY.offered) ?? {};
    if (!link.length && !remove.length) {
      // Nothing to do: forget the old offer, so the same skills give a new offer later.
      if (offered[p.root]) { const { [p.root]: _gone, ...rest } = offered; setShared(KEY.offered, rest); }
      return;
    }
    const signature = `${link.join(",")}|${remove.join(",")}`;
    if (offered[p.root] === signature) return;
    setShared(KEY.offered, { ...offered, [p.root]: signature });
    setShared(KEY.offerNow, { root: p.root, name: p.name, link, remove, at: Date.now() });
    const names = [...link, ...remove];
    const list = names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
    notify({
      title: fill(this.str.offerTitle, { project: p.name }),
      body: fill(this.str.offerBody, { create: link.length, remove: remove.length, list }),
      level: "warning",
      timeout: 20000,
      action: { name: `${MOD}.update-offered` },
    });
  }

  /** A click on the toast of offerLinks(): makes and removes the links of that offer. */
  applyOffered(cx) {
    const o = shared(KEY.offerNow);
    if (!o?.root || !((o.link?.length ?? 0) + (o.remove?.length ?? 0))) return;
    const project = { state: "ready", root: o.root, name: o.name };
    this.act(cx, this.str.busyLink, (p) => this.apply(p, { link: o.link, remove: o.remove }), project);
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

  // ---- the person's own clone -------------------------------------------------------------

  /** The running action, if it is not stale. */
  job() {
    const j = shared(KEY.job);
    return j && Date.now() - (j.at ?? 0) < JOB_STALE_MS ? j : null;
  }

  /** What the person must know about their own clone (it does not stop the links), or null. */
  cloneNote() {
    const ref = this.cat.ref;
    if (!ref?.problem) return null;
    return fill(this.str[`problem_${ref.problem}`], { branch: ref.current ?? "" });
  }

  /** The fixes for a problem of the person's own clone (ownCloneRef): [{ id, label, tip, kind, run }]. */
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
    if (ref.problem === "dirty") list.push(git("stash", "plain"), git("discard", "danger"));
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

  // ---- actions ----------------------------------------------------------------------------

  /**
   * Runs one action for the project, then reads again and posts a toast with what changed.
   * `work(project)` calls this.apply() (once or more); the toast shows the sum of its results.
   */
  act(cx, label, work, project = this.proj) {
    if (this.job() || project.state !== "ready") return;
    setShared(KEY.job, { project: project.root, label, at: Date.now() });
    this.running = true;
    this.error = null;
    this.done = { linked: [], removed: [], converted: [], backedUp: [], deleted: [], errors: [] };
    cx.notify();
    cx.spawn(async (cx) => {
      let failed = null;
      try {
        await work(project);
      } catch (e) {
        failed = errorText(e);
      }
      const done = this.done;
      if (!failed && done.errors.length) failed = done.errors.join("\n");
      this.running = false;
      setShared(KEY.job, null);
      try { await this.loadProject(); } catch (e) { failed ??= errorText(e); }
      this.changedAt = Date.now();
      setShared(KEY.changed, { project: project.root, at: this.changedAt });
      const s = this.str;
      const title = fill(s.doneTitle, { project: project.name });
      if (failed) {
        this.error = { text: failed };
        notify({ title, body: `${s.failed}: ${failed.split("\n").pop()}`, level: "error", timeout: 8000 });
      } else {
        const parts = [
          [done.linked.length + done.converted.length, s.doneLinked], [done.removed.length, s.doneRemoved],
          [done.deleted.length, s.doneDeleted], [done.backedUp.length, s.doneBackedUp],
        ].filter(([n]) => n > 0).map(([n, text]) => fill(text, { n }));
        notify({ title, body: parts.join(" ") || s.doneSaved, timeout: done.backedUp.length ? 9000 : 5000 });
        this.mode = "list";
      }
      cx.notify();
    });
  }

  /**
   * Runs link-skills.mjs "apply" in the project `p` (see the top of that file for `input`).
   * It also changes every Copy of the project to a link. Adds the result to the toast of act().
   */
  async apply(p, input = {}) {
    const r = await C.linkScript({ op: "apply", project: p.root, ...this.cloneInput(), ...input });
    if (r.error) throw new Error(r.error);
    for (const k of Object.keys(this.done)) this.done[k].push(...(r[k] ?? []));
    return r;
  }

  /** The state of the project `p` now (after a write of the Manifest): the rows of link-skills.mjs. */
  async rowsNow(p) {
    const info = await C.linkScript({ op: "read", project: p.root, ...this.cloneInput() });
    if (info.error) throw new Error(info.error);
    return info.rows ?? [];
  }

  async writeManifest(project, manifest) {
    await writeTextFile(`${project.root}/skills.yaml`, formatManifest(manifest), project.manifestText);
  }

  /** Link all: makes the Missing links, changes the Copies to links and removes the Stale links. */
  syncAll(cx) {
    const rows = this.proj.rows ?? [];
    const link = toLink(rows);
    const remove = toRemove(rows);
    if (!link.length && !remove.length) return;
    this.act(cx, this.str.busyLink, (p) => this.apply(p, { link, remove }));
  }

  linkOne(cx, row) {
    this.act(cx, this.str.busyLink, (p) => this.apply(p, { link: [row.name] }));
  }

  /** Removes the links of an Extra or a Stale skill. */
  removeLinks(cx, row) {
    this.act(cx, fill(this.str.busyRemove, { list: row.name }), (p) => this.apply(p, { remove: [row.name] }));
  }

  /** Replace by link: moves the real folder of a Conflict to the Backup and links the skill. Asks for a second click. */
  replace(cx, row) {
    if (row.state !== "conflict" || this.job() || !this.armed(cx, `replace:${row.name}`)) return;
    this.act(cx, this.str.busyLink, (p) => this.apply(p, { replace: [row.name] }));
  }

  /**
   * Deletes a Local skill: its real folders, or its links (never what a link points to).
   * It asks for a second click: a folder does not go to the trash.
   */
  removeLocal(cx, row) {
    if (row.state !== "local" || this.job() || !this.armed(cx, `local:${row.name}`)) return;
    this.act(cx, fill(this.str.busyRemove, { list: row.name }), (p) => this.apply(p, { deleteLocal: [row.name] }));
  }

  /** Removes the old block of `npx skills` from the committed .gitignore. */
  dropGitignore(cx) {
    this.act(cx, this.str.busyGitignore, (p) => this.apply(p, { dropGitignore: true }));
  }

  // ---- batch actions on a group of the list --------------------------------------------------

  /** The rows of a group (by its key "<kind>:<key>") in the current project. */
  groupRowsOf(key) {
    return this.proj.groups?.find((g) => `${g.kind}:${g.key}` === key)?.rows ?? [];
  }

  /** Makes the Missing links (and changes the Copies) of a group. */
  linkGroup(cx, key) {
    const link = toLink(this.groupRowsOf(key));
    if (!link.length) return;
    this.act(cx, this.str.busyLink, (p) => this.apply(p, { link }));
  }

  /** Keep all: adds every Extra skill to sources: in skills.yaml, in one write. */
  keepAllExtra(cx) {
    const rows = this.groupRowsOf("extra:extra").filter((r) => r.repo);
    if (!rows.length || !this.proj.manifest) return;
    this.act(cx, this.str.busyWrite, async (p) => {
      let next = p.manifest;
      for (const r of rows) next = withSource(next, r.repo, [r.name]);
      await this.writeManifest(p, next);
      await this.apply(p, { link: rows.map((r) => r.name) });
    });
  }

  /** Remove all: removes the links of every skill of the Extra or the Stale group. Extra asks for a second click. */
  removeAllLinks(cx, kind) {
    const names = this.groupRowsOf(`${kind}:${kind}`).filter((r) => r.state === "extra" || r.state === "stale").map((r) => r.name);
    if (!names.length || this.job() || (kind === "extra" && !this.armed(cx, "all:extra"))) return;
    this.act(cx, fill(this.str.busyRemove, { list: names.join(", ") }), (p) => this.apply(p, { remove: names }));
  }

  /** Remove all: deletes every Local skill. Asks for a second click. */
  removeAllLocal(cx) {
    const names = this.groupRowsOf("local:local").map((r) => r.name);
    if (!names.length || this.job() || !this.armed(cx, "all:local")) return;
    this.act(cx, fill(this.str.busyRemove, { list: names.join(", ") }), (p) => this.apply(p, { deleteLocal: names }));
  }

  /** Folds or unfolds a group of the list. The choice stays in this copy (localStorage). */
  toggleGroup(key, cx) {
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    try { localStorage.setItem("collapsed", JSON.stringify([...this.collapsed])); } catch {}
    cx.notify();
  }

  /** Keep: adds an Extra skill to sources: in skills.yaml. */
  keepExtra(cx, row) {
    if (!this.proj.manifest || !row.repo) return;
    this.act(cx, this.str.busyWrite, async (p) => {
      await this.writeManifest(p, withSource(p.manifest, row.repo, [row.name]));
      await this.apply(p, { link: [row.name] });
    });
  }

  /** Remove on a Source: takes the skill out of sources:, and removes its links when no Bundle asks for it. */
  dropSource(cx, row) {
    this.act(cx, fill(this.str.busyRemove, { list: row.name }), async (p) => {
      await this.writeManifest(p, withoutSource(p.manifest, row.name));
      // Without the Source, the skill is Stale (or Extra, when it was added as one before).
      const now = (await this.rowsNow(p)).find((r) => r.name === row.name);
      if (now && (now.state === "stale" || now.state === "extra")) await this.apply(p, { remove: [row.name] });
    });
  }

  /**
   * Bundles: writes skills.yaml with the chosen Bundles (a new one when the project has none),
   * then makes the links of the new skills and removes the links of the skills that left.
   */
  applyBundles(cx) {
    const bundles = orderBundles([...this.pick]);
    this.act(cx, this.str.busyWrite, async (p) => {
      // A project without a Manifest keeps its links: they are Extra skills on purpose.
      const extra = p.manifest ? [] : (p.rows ?? []).filter((r) => r.state === "extra").map((r) => r.name);
      await this.writeManifest(p, { bundles, sources: p.manifest?.sources ?? [] });
      const rows = await this.rowsNow(p);
      await this.apply(p, { link: toLink(rows), remove: toRemove(rows).filter((n) => !extra.includes(n)), extra });
    });
  }

  /** Add skill: links one skill of the Clone. It goes to sources: when asked, else it is an Extra skill. */
  addSkill(cx, name) {
    const persist = this.persist && Boolean(this.proj.manifest);
    this.act(cx, this.str.busyLink, async (p) => {
      if (persist) await this.writeManifest(p, withSource(p.manifest, this.cat.catalog.repo, [name]));
      await this.apply(p, persist ? { link: [name] } : { link: [name], extra: [name] });
    });
  }

  /** The "repo" mode: clones the repository of the field (when it is not in the sources cache) and reads its skills. */
  listRepo(cx) {
    const repo = String(this.repoInput?.value?.() ?? "").trim();
    if (!repo || this.proj.state !== "ready" || this.repoList?.state === "loading") return;
    if (!C.validRepo(repo)) { this.repoList = { repo, state: "error", skills: [], error: this.str.repoInvalid }; cx.notify(); return; }
    this.repoList = { repo, state: "loading", skills: [] };
    this.query?.set_value?.("");
    cx.notify();
    cx.spawn(async (cx) => {
      const s = await C.ensureSource(repo);
      const r = s.error ? { error: s.error } : await C.linkScript({ op: "list", dir: s.dir });
      // Another repository was asked in the meantime: this answer is old.
      if (this.repoList?.repo !== repo) return;
      this.repoList = r.error ? { repo, state: "error", skills: [], error: r.error } : { repo, state: "ready", skills: r.skills ?? [] };
      cx.notify();
    });
  }

  /** The "repo" mode: links one skill of the listed repository. It goes to sources: when asked, else it is an Extra skill. */
  addFromRepo(cx, name) {
    const repo = this.repoList?.repo;
    if (!repo) return;
    const persist = this.persist && Boolean(this.proj.manifest);
    this.act(cx, this.str.busyLink, async (p) => {
      if (persist) await this.writeManifest(p, withSource(p.manifest, repo, [name]));
      await this.apply(p, { link: [name], repos: { [name]: repo }, ...(persist ? {} : { extra: [name] }) });
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
    // Only the Bundles of the Catalog are kept; an unknown one drops on save.
    if (mode === "bundles") this.pick = new Set((this.proj.manifest?.bundles ?? ["core"]).filter((b) => b === "core" || this.cat.catalog?.bundles.has(b)));
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
    const ready = p.state === "ready";
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
      hasCatalog: this.cat.state === "ready",
      sources: shared(KEY.sources) ?? {},
      sourcing: new Set(sourcing.keys()),
      srcErrors: this.srcErrors,
      filter: String(this.query?.value?.() ?? "").trim().toLowerCase(),
      plain: ready && !p.manifest, // no Manifest: the links of the project are Extra skills
      linkable: this.linkable(),
      work: ready ? toLink(p.rows).length + toRemove(p.rows).length : 0,
      pending: ready ? pending(p.counts) : 0,
      cloneNote: this.cloneNote(),
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
        linkOne: (row, cx) => this.linkOne(cx, row),
        removeLinks: (row, cx) => this.removeLinks(cx, row),
        replace: (row, cx) => this.replace(cx, row),
        keepExtra: (row, cx) => this.keepExtra(cx, row),
        removeLocal: (row, cx) => this.removeLocal(cx, row),
        toggleGroup: (key, cx) => this.toggleGroup(key, cx),
        linkGroup: (key, cx) => this.linkGroup(cx, key),
        keepAllExtra: (cx) => this.keepAllExtra(cx),
        removeAllLinks: (kind, cx) => this.removeAllLinks(cx, kind),
        removeAllLocal: (cx) => this.removeAllLocal(cx),
        dropSource: (row, cx) => this.dropSource(cx, row),
        applyBundles: (cx) => this.applyBundles(cx),
        addSkill: (name, cx) => this.addSkill(cx, name),
        listRepo: (cx) => this.listRepo(cx),
        addFromRepo: (name, cx) => this.addFromRepo(cx, name),
        updateSource: (repo, cx) => this.updateSource(cx, repo),
        dropGitignore: (cx) => this.dropGitignore(cx),
        open: () => this.openDialog(),
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
    return panelView(t, m, this.keys, settings());
  }
}
