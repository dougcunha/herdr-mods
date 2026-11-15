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
//
// A project in a space on another machine (`hc machine ls`) has its links, its Clone and its
// Source clones on that machine. The settings come from the Herdr app there (shared.json),
// and a setting that it does not have comes from this computer. this.on is that machine.

import { View, div } from "gpui-kit";
import { InputState } from "gpui-base";
import { theme, props, shared, setShared, focused, spaces, panes, readTextFile, notify, run, openOverlay, nextCommand, settings, closeOverlay, knownAgents } from "herdr";
import * as C from "./catalog.js";
import { writeFileOn } from "./remote.js";
import { formatManifest, sameRepo, withSource, withSkills, withoutSource, orderBundles } from "./manifest.js";
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
  clone: "skill-bundles.clone", // optional: the person's own clone of the default Catalog
  clones: "skill-bundles.clones", // [{ name: "owner/name", folder }]: the person's own clones, by Catalog
  // { "<machine>|<root>": "owner/name" }: the Catalog chosen for a project that has no skills.yaml yet
  choice: "skill-bundles.choice",
  gitUrl: "skill-bundles.gitUrl", // optional: the URL for `git clone` (default: GitHub SSH)
  minutes: "skill-bundles.fetchMinutes", // minutes between 2 fetches of the Catalog
  fetched: "skill-bundles.fetchedAt", // { "<clone dir>" | "<machine>|<clone dir>": time of the last fetch }
  job: "skill-bundles.job", // { project, label, at } while an action runs, else null
  changed: "skill-bundles.changed", // { project, at }: an action ended; copies read again
  offerUpdate: "skill-bundles.offerUpdate", // false: no toast that offers to make and remove links
  offered: "skill-bundles.offered", // { "<machine>|<root>": signature }: the offers already shown
  offerNow: "skill-bundles.offerNow", // the last offer: { root, machine, name, link, remove, at }
  // The clones of the repositories that are not the Catalog: { "<machine>|<repo in lower case>": { at, dir, behind, error } }
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

/** True when 2 Catalog names ("owner/name") are the same. Null and "" are the same: no Catalog. */
const sameSlug = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const projectKey = (machine, root) => `${machine ?? ""}|${root}`;

const baseName = (p) => String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
const errorText = (e) => String(e?.message ?? e);

// One clone at a time for each folder, when 2 copies start together.
const cloning = new Map();
function cloneOnce(slug, dir, gitUrl, on = null) {
  const key = `${on ?? ""}|${dir}`;
  if (!cloning.has(key)) cloning.set(key, C.ensureClone(slug, dir, gitUrl, on).finally(() => cloning.delete(key)));
  return cloning.get(key);
}

// One clone or fetch at a time for each repository that is not the Catalog, in all copies of this window.
const sourcing = new Map();
const repoId = (repo) => String(repo ?? "").split("#")[0].toLowerCase();
/** The key of the clone of a repository on a machine, for KEY.sources and `sourcing`. */
const sourceId = (on, repo) => `${on ?? ""}|${repoId(repo)}`;

export default class SkillBundles extends View {
  init(given, cx) {
    // Read props once: props() in a later callback can answer for another copy.
    this.props = (given && Object.keys(given).length ? given : props()) || {};
    this.part = this.props.part ?? "panel";
    this.cat = { state: "loading" }; // see loadCatalog
    this.on = null; // the machine of this.cat and this.place (null: this computer)
    this.want = null; // the Catalog of the focused project ("owner/name"), when it is not the default one
    this.defaultSlug = null; // the default Catalog of the machine this.on (the setting)
    this.place = null; // the folders of the mod on that machine (C.place)
    this.proj = { state: "loading" }; // see loadProject
    this.mode = "list"; // "list" | "bundles" | "add" | "repo" | "catalog"
    // The "catalog" mode (the curation of the Clone): its skills with their Bundles, the skill
    // whose Bundles are edited, and the Bundles chosen for it.
    this.cur = { details: null, skill: null, pick: new Set(), orphans: false };
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
      this.bundleName = InputState.new({ placeholder: this.str.newBundleName });
      this.bundleDesc = InputState.new({ placeholder: this.str.newBundleDesc });
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
        if (c === "catalog" && this.cat.state === "ready") this.setMode("catalog", cx);
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
    const sourcesRoot = this.place?.sourcesRoot ?? null;
    return this.cat.state === "ready" ? { clone: this.cat.dir, catalogRepo: this.cat.catalog.repo, catalogAs: this.cat.slug, sourcesRoot } : { clone: null, sourcesRoot };
  }

  // ---- reading ----------------------------------------------------------------------------

  /** Reads the Catalog (and fetches it when due or forced), then the project. */
  reload(cx, force) {
    if (this.reading) { this.again = { force: force || this.again?.force }; return; }
    this.reading = true;
    cx.spawn(async (cx) => {
      try {
        await this.loadCatalog(cx, force);
        await this.loadProject(cx);
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
    const catalog = repoId(p.catalogRepo);
    const minutes = Number(shared(KEY.minutes)) > 0 ? Number(shared(KEY.minutes)) : DEFAULT_MINUTES;
    const repos = new Map();
    for (const r of p.rows) {
      if (!r.repo || r.state === "local" || repoId(r.repo) === catalog) continue;
      const id = repoId(r.repo);
      repos.set(id, { repo: r.repo, missing: (repos.get(id)?.missing ?? false) || r.state === "unsupported" });
    }
    const on = p.machine;
    for (const [name, { repo, missing }] of repos) {
      const id = sourceId(on, name);
      if (sourcing.has(id) || (missing && this.srcErrors[id])) continue;
      const last = (shared(KEY.sources) ?? {})[id];
      if (!missing && !force && last && Date.now() - (last.at ?? 0) < minutes * 60 * 1000) continue;
      const work = (async () => {
        const s = await C.ensureSource(repo, on);
        if (s.error) return { error: s.error, cloned: false };
        const b = await C.sourceBehind(s.dir, on);
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
    const on = this.on;
    const id = sourceId(on, repo);
    const dir = (shared(KEY.sources) ?? {})[id]?.dir;
    if (!dir || this.job()) return;
    setShared(KEY.job, { project: null, label: fill(this.str.busySource, { repo }), at: Date.now() });
    this.running = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let failed = null;
      try { failed = await C.updateOwnClone(dir, on); } catch (e) { failed = errorText(e); }
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
      // The focus moved to a space of another machine: the Catalog is the one of that machine.
      try { if ((location().machine ?? null) !== this.on) await this.loadCatalog(cx, false); await this.loadProject(cx); } catch (e) { this.proj = { state: "error", error: errorText(e) }; }
      finally { this.reading = false; }
      cx.notify();
      this.syncSources(cx, false);
      if (this.again) { const { force } = this.again; this.again = null; this.reload(cx, force); }
    });
  }

  /**
   * this.cat: { state: "unset" } | { state: "cloning", slug } | { state: "error", slug, error } |
   * { state: "ready", slug, dir, own, catalog, commit, ref, fetchError }
   * It is the Catalog of the machine of the focused space (this.on). There, a setting comes from
   * the shared.json of that machine, else from this computer; "Your own clone" only from there.
   * catalog: { repo, bundles: Map<name, skills>, descriptions: Map<name, text>, skills: [every skill of the Clone] }
   */
  async loadCatalog(cx, force) {
    const on = location().machine ?? null;
    if (on !== this.on) this.cat = { state: "loading" };
    this.on = on;
    this.place = null;
    // The refresh button reads the settings of the other machine again.
    if (force && on) C.forgetPlace(on);
    this.place = await C.place(on);
    const there = this.place.shared;
    const setting = (key) => { const v = String(there[key] ?? "").trim(); return v || String(shared(key) ?? "").trim(); };
    // The Catalog of the focused project (loadProject sets this.want), else the default one of the machine.
    const def = C.repoSlug(setting(KEY.catalog));
    this.defaultSlug = def;
    const slug = this.want ?? def;
    if (!slug) { this.cat = { state: "unset" }; return; }
    if (!sameSlug(this.cat.slug, slug)) this.cat = { state: "loading" };
    // The person's own clone: the row of the table for this Catalog, else the old setting (the default Catalog only).
    const isDefault = sameSlug(slug, def);
    const table = on ? there[KEY.clones] : shared(KEY.clones);
    const row = (Array.isArray(table) ? table : []).find((r) => r && sameSlug(C.repoSlug(r.name), slug) && String(r.folder ?? "").trim());
    const old = isDefault ? (on ? there[KEY.clone] : shared(KEY.clone)) : "";
    const own = String(row?.folder ?? old ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    const dir = own || `${this.place.cache}/${slug}`;
    const previous = this.cat.dir === dir ? this.cat : null;
    if (!own) {
      const here = (await (on ? readTextFile(`${dir}/bundles.yaml`, { on }) : readTextFile(`${dir}/bundles.yaml`)).catch(() => null)) !== null;
      if (!here) { this.cat = { state: "cloning", slug }; cx.notify(); }
      // "Clone URL" is the URL of the default Catalog.
      const error = await cloneOnce(slug, dir, isDefault ? setting(KEY.gitUrl) : "", on);
      if (error) { this.cat = { state: "error", slug, error }; return; }
    }
    let fetchError = previous?.fetchError ?? null;
    const minutes = Number(shared(KEY.minutes)) > 0 ? Number(shared(KEY.minutes)) : DEFAULT_MINUTES;
    const times = shared(KEY.fetched) ?? {};
    const fetchKey = on ? `${on}|${dir}` : dir;
    if (force || Date.now() - (times[fetchKey] ?? 0) > minutes * 60 * 1000) {
      setShared(KEY.fetched, { ...times, [fetchKey]: Date.now() });
      if (force) { this.cat = { ...(previous ?? { state: "loading" }), fetching: true }; cx.notify(); }
      fetchError = own ? await C.pullOwnClone(dir, on) : await C.updateOwnClone(dir, on);
    }
    const read = await C.linkScript({ op: "catalog", clone: dir }, on);
    if (read.error || !read.catalog) { this.cat = { state: "error", slug, error: read.error ?? `${dir}/bundles.yaml was not found.` }; return; }
    const catalog = {
      repo: read.catalog.repo || slug,
      bundles: new Map(read.catalog.bundles),
      descriptions: new Map(Object.entries(read.catalog.descriptions ?? {})),
      skills: read.skills ?? [],
    };
    this.cat = {
      state: "ready", slug, dir, own: Boolean(own), catalog, fetchError,
      commit: await C.headCommit(dir, on),
      ref: own ? await C.ownCloneRef(dir, on) : { branch: null },
    };
  }

  /**
   * this.proj: { state: "none" } | { state: "remote", name } | { state: "error", error } |
   * { state: "ready", root, name, manifestText, manifest, rows, groups, counts, unknown, info }
   * `info` is what link-skills.mjs read: { git, lockError, lockOther, oldGitignore, catalogError }.
   * A project on another machine is not supported yet (phase 3 of docs/adr/0002): a link must
   * point to a folder of the same computer.
   */
  async loadProject(cx) {
    const loc = location();
    const root = await C.gitRoot(loc.cwd, loc.machine);
    if (!root) { this.proj = { state: "none" }; return; }
    const on = loc.machine ?? null;
    // The Catalog of another machine is in this.cat: the next read brings the one of this project.
    if (on !== this.on) { this.proj = { state: "loading" }; return; }
    const manifestText = await (on ? readTextFile(`${root}/skills.yaml`, { on }) : readTextFile(`${root}/skills.yaml`)).catch(() => null);
    let info = await C.linkScript({ op: "read", project: root, ...this.cloneInput() }, on);
    if (info.error) { this.proj = { state: "error", error: info.error }; return; }
    // The Catalog of the project: `catalog:` of its skills.yaml, else the one chosen for it in the
    // Bundle picker (no skills.yaml yet), else the default one. this.cat is of another Catalog:
    // nothing of this read is shown or offered. The Catalog of the project loads, and the read runs again.
    const invalid = info.catalogProblem?.code === "catalog_invalid";
    const named = !invalid && info.manifest?.catalog ? C.repoSlug(info.manifest.catalog) : null;
    const chosen = info.manifest ? null : C.repoSlug((shared(KEY.choice) ?? {})[projectKey(on, root)]);
    const want = named ?? chosen;
    if (!invalid && !sameSlug(want ?? this.defaultSlug, this.cat.slug)) {
      this.want = want;
      await this.loadCatalog(cx, false);
      if (this.on !== on) { this.proj = { state: "loading" }; return; }
      info = await C.linkScript({ op: "read", project: root, ...this.cloneInput() }, on);
      if (info.error) { this.proj = { state: "error", error: info.error }; return; }
    }
    if (info.catalogProblem) {
      this.proj = { state: "error", error: fill(this.str[invalid ? "catalogInvalid" : "catalogOther"], { catalog: info.catalogProblem.wanted }) };
      return;
    }
    // Another project: the Bundle choice and the mode of the old one do not apply.
    if (this.proj.root !== root || this.proj.machine !== on) { this.pick = new Set(); this.mode = "list"; this.error = null; }
    const rows = info.rows ?? [];
    this.proj = {
      state: "ready", root, machine: on, name: on ? `${baseName(root)} · ${on}` : baseName(root), manifestText, manifest: info.manifest ?? null,
      rows, groups: groupRows(rows, info.manifest, this.cat.catalog?.repo ?? ""), counts: countRows(rows), unknown: info.unknown ?? [], info,
      // The clones that this project was read with. A change uses them, not the ones of a later focus.
      clones: this.cloneInput(), catalogRepo: this.cat.catalog?.repo ?? "", catalogSlug: this.cat.state === "ready" ? this.cat.slug : null,
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
    const retired = p.info?.retired ?? 0; // links in a folder that the mod no longer uses (.codex/skills)
    const offered = shared(KEY.offered) ?? {};
    const where = `${p.machine ?? ""}|${p.root}`;
    if (!link.length && !remove.length && !retired) {
      // Nothing to do: forget the old offer, so the same skills give a new offer later.
      if (offered[where]) { const { [where]: _gone, ...rest } = offered; setShared(KEY.offered, rest); }
      return;
    }
    const signature = `${link.join(",")}|${remove.join(",")}|${retired}`;
    if (offered[where] === signature) return;
    setShared(KEY.offered, { ...offered, [where]: signature });
    setShared(KEY.offerNow, { root: p.root, machine: p.machine, name: p.name, link, remove, retired, clones: p.clones, at: Date.now() });
    const names = [...link, ...remove, ...(retired ? [".codex/skills"] : [])];
    const list = names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
    notify({
      title: fill(this.str.offerTitle, { project: p.name }),
      body: fill(this.str.offerBody, { create: link.length, remove: remove.length + retired, list }),
      level: "warning",
      timeout: 20000,
      action: { name: `${MOD}.update-offered` },
    });
  }

  /** A click on the toast of offerLinks(): makes and removes the links of that offer. */
  applyOffered(cx) {
    const o = shared(KEY.offerNow);
    // The clones of this copy are the ones of this.on: an offer of another machine waits for a copy that shows it.
    if (!o?.root || (o.machine ?? null) !== this.on || !((o.link?.length ?? 0) + (o.remove?.length ?? 0) + (o.retired ?? 0))) return;
    // The offer was read with the clones of its project: the focus can be on a project of another Catalog now.
    if (!o.clones?.clone && !o.clones?.sourcesRoot) return;
    const project = { state: "ready", root: o.root, machine: o.machine ?? null, name: o.name, clones: o.clones };
    this.act(cx, this.str.busyLink, (p) => this.apply(p, { link: o.link, remove: o.remove }), project);
  }

  /**
   * Reads again when the focus moves to another folder, a setting changes or an action ends.
   * It runs in render, where cx.notify() is not allowed: the read starts on a timer.
   */
  watchChanges(cx) {
    const loc = location();
    const locKey = `${loc.machine ?? ""}|${loc.cwd ?? ""}`;
    const settingsKey = [shared(KEY.catalog), shared(KEY.clone), shared(KEY.gitUrl), JSON.stringify(shared(KEY.clones) ?? null), JSON.stringify(shared(KEY.choice) ?? null)].map((v) => String(v ?? "")).join("|");
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
    const on = this.on;
    setShared(KEY.job, { project: null, label: this.str.busyFix, at: Date.now() });
    this.running = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let failed = null;
      try { failed = await C.fixClone(dir, fix, ref?.current ?? "", on); } catch (e) { failed = errorText(e); }
      this.running = false;
      setShared(KEY.job, null);
      if (failed) this.error = { text: failed };
      cx.notify();
      this.reload(cx, true);
    });
  }

  /** Opens a new space in the clone with an agent that commits and pushes (or a plain terminal). */
  agentFix(agent) {
    const folder = this.on ? this.cat.dir : C.native(this.cat.dir);
    const task = "This folder is a Git clone of a skill Catalog. Commit the changes that are not committed, with a clear message. Then bring in the new commits of the remote with git pull --rebase, and push. Ask me before you discard a change.";
    run("space.new", { name: "Catalog clone", folder, machine: this.on ?? "", ...(agent ? { argv: agent.run, task } : {}) });
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
    this.done = { linked: [], removed: [], converted: [], backedUp: [], deleted: [], retired: [], errors: [] };
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
      try { await this.loadProject(cx); } catch (e) { failed ??= errorText(e); }
      this.changedAt = Date.now();
      setShared(KEY.changed, { project: project.root, at: this.changedAt });
      const s = this.str;
      const title = fill(s.doneTitle, { project: project.name });
      if (failed) {
        this.error = { text: failed };
        notify({ title, body: `${s.failed}: ${failed.split("\n").pop()}`, level: "error", timeout: 8000 });
      } else {
        const parts = [
          [done.linked.length + done.converted.length, s.doneLinked], [done.removed.length + done.retired.length, s.doneRemoved],
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
    if ((p.machine ?? null) !== this.on) throw new Error(this.str.otherMachine);
    const r = await C.linkScript({ op: "apply", project: p.root, ...(p.clones ?? this.cloneInput()), ...input }, this.on);
    if (r.error) throw new Error(r.error);
    for (const k of Object.keys(this.done)) this.done[k].push(...(r[k] ?? []));
    return r;
  }

  /** The state of the project `p` now (after a write of the Manifest): the rows of link-skills.mjs. */
  async rowsNow(p) {
    const info = await C.linkScript({ op: "read", project: p.root, ...(p.clones ?? this.cloneInput()) }, this.on);
    if (info.error) throw new Error(info.error);
    return info.rows ?? [];
  }

  async writeManifest(project, manifest) {
    await writeFileOn(project.machine ?? null, `${project.root}/skills.yaml`, formatManifest(manifest), project.manifestText);
  }

  /** Link all: makes the Missing links, changes the Copies to links and removes the Stale links. */
  syncAll(cx) {
    const rows = this.proj.rows ?? [];
    const link = toLink(rows);
    const remove = toRemove(rows);
    // Every apply also removes the links of the folders that the mod no longer uses.
    if (!link.length && !remove.length && !this.proj.info?.retired) return;
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
      for (const r of rows) next = this.kept(next, r, p);
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

  /** The Manifest with a skill kept: in `skills:` for the Catalog, in `sources:` for another repository. */
  kept(manifest, row, p = this.proj) {
    const catalog = p.catalogRepo;
    return catalog && sameRepo(row.repo, catalog) ? withSkills(manifest, [row.name]) : withSource(manifest, row.repo, [row.name]);
  }

  /** Keep: adds an Extra skill to skills.yaml. */
  keepExtra(cx, row) {
    if (!this.proj.manifest || !row.repo) return;
    this.act(cx, this.str.busyWrite, async (p) => {
      await this.writeManifest(p, this.kept(p.manifest, row, p));
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
      // `catalog:` stays when the file has it. A new file gets it when the Catalog is not the default one of the machine.
      const catalog = p.manifest?.catalog ?? (p.catalogSlug && !sameSlug(p.catalogSlug, this.defaultSlug) ? p.catalogSlug : null);
      await this.writeManifest(p, { catalog, bundles, skills: p.manifest?.skills ?? [], sources: p.manifest?.sources ?? [] });
      this.forgetChoice(p);
      const rows = await this.rowsNow(p);
      await this.apply(p, { link: toLink(rows), remove: toRemove(rows).filter((n) => !extra.includes(n)), extra });
    });
  }

  /** The Catalogs that this machine knows: the default one and the ones of the table of own clones. */
  knownCatalogs() {
    const table = this.on ? this.place?.shared?.[KEY.clones] : shared(KEY.clones);
    const names = [this.defaultSlug, ...(Array.isArray(table) ? table : []).map((r) => C.repoSlug(r?.name))].filter(Boolean);
    return names.filter((n, i) => names.findIndex((x) => sameSlug(x, n)) === i);
  }

  /** The Bundle picker of a project without skills.yaml: the Catalog that its Bundles come from. Every copy reads the project again. */
  chooseCatalog(slug, cx) {
    const p = this.proj;
    if (p.state !== "ready" || p.manifest || this.job() || sameSlug(slug, this.cat.slug)) return;
    const all = { ...(shared(KEY.choice) ?? {}) };
    if (sameSlug(slug, this.defaultSlug)) delete all[projectKey(p.machine, p.root)];
    else all[projectKey(p.machine, p.root)] = slug;
    this.pick = new Set(["core"]);
    setShared(KEY.choice, all);
    cx.notify();
  }

  /** The choice of chooseCatalog() is not needed anymore: skills.yaml names the Catalog now. */
  forgetChoice(p) {
    const all = shared(KEY.choice) ?? {};
    const key = projectKey(p.machine, p.root);
    if (!(key in all)) return;
    const { [key]: _gone, ...rest } = all;
    setShared(KEY.choice, rest);
  }

  /** Add skill: links one skill of the Clone. It goes to sources: when asked, else it is an Extra skill. */
  addSkill(cx, name) {
    const persist = this.persist && Boolean(this.proj.manifest);
    this.act(cx, this.str.busyLink, async (p) => {
      if (persist) await this.writeManifest(p, withSkills(p.manifest, [name]));
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
      const on = this.on;
      const s = await C.ensureSource(repo, on);
      const r = s.error ? { error: s.error } : await C.linkScript({ op: "list", dir: s.dir }, on);
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

  // ---- the curation of the Catalog ---------------------------------------------------------

  /** Reads the skills of the Clone with their Bundles, for the "catalog" mode. */
  loadDetails(cx) {
    if (this.cat.state !== "ready") return;
    const { dir } = this.cat;
    const on = this.on;
    cx.spawn(async (cx) => {
      const d = await C.linkScript({ op: "details", clone: dir }, on);
      if (this.cat.dir !== dir) return;
      this.cur.details = d.error ? { skills: [], orphans: [], error: d.error } : d;
      cx.notify();
    });
  }

  /**
   * Changes bundles.yaml (or deletes a skill folder) in the person's own clone. The mod commits
   * nothing: the line under the header then says that the clone has changes, with its buttons.
   * A clone of the mod's cache is not changed: the next fetch would discard the change.
   */
  curate(cx, input, after = null) {
    if (this.job() || this.cat.state !== "ready") return;
    if (!this.cat.own) { this.error = { text: this.str.curateOwnOnly }; cx.notify(); return; }
    const { dir } = this.cat;
    const on = this.on;
    setShared(KEY.job, { project: null, label: this.str.busyCurate, at: Date.now() });
    this.running = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let failed = null;
      try {
        const r = await C.linkScript({ op: "curate", clone: dir, ...input }, on);
        failed = r.error ?? (r.errors?.length ? r.errors.join("\n") : null);
      } catch (e) { failed = errorText(e); }
      this.running = false;
      setShared(KEY.job, null);
      if (failed) this.error = { text: failed };
      else after?.();
      // Every copy reads the Catalog again: a Bundle has other skills now.
      setShared(KEY.changed, { project: this.proj.root ?? null, at: Date.now() });
      cx.notify();
      this.loadDetails(cx);
      this.reload(cx, false);
    });
  }

  /** Opens (or closes, with null) the Bundles of one skill of the Clone. */
  curateSkill(name, cx) {
    const skill = this.cur.details?.skills.find((s) => s.name === name) ?? null;
    this.cur.skill = skill?.name ?? null;
    this.cur.pick = new Set(skill?.bundles ?? []);
    this.error = null;
    cx.notify();
  }

  /** Saves the Bundles chosen for the skill of the "catalog" mode. */
  saveSkillBundles(cx) {
    const skill = this.cur.details?.skills.find((s) => s.name === this.cur.skill);
    if (!skill) return;
    const assign = [...this.cur.pick].filter((b) => !skill.bundles.includes(b)).map((bundle) => ({ skill: skill.name, bundle }));
    const unassign = skill.bundles.filter((b) => !this.cur.pick.has(b)).map((bundle) => ({ skill: skill.name, bundle }));
    if (!assign.length && !unassign.length) { this.cur.skill = null; cx.notify(); return; }
    this.curate(cx, { assign, unassign }, () => { this.cur.skill = null; });
  }

  /** Creates the Bundle of the 2 fields, and chooses it for the skill that is open. */
  createBundle(cx) {
    const name = String(this.bundleName?.value?.() ?? "").trim();
    const description = String(this.bundleDesc?.value?.() ?? "").trim();
    if (!name) return;
    this.curate(cx, { createBundle: [{ name, description }] }, () => {
      if (this.cur.skill) this.cur.pick.add(name);
      this.bundleName.set_value("");
      this.bundleDesc.set_value("");
    });
  }

  /** Deletes a Bundle (not its skills) or a skill folder of the Clone. Asks for a second click. */
  curateDelete(cx, kind, name) {
    if (this.job() || !this.armed(cx, `${kind}:${name}`)) return;
    this.curate(cx, kind === "bundle" ? { deleteBundle: [name] } : { deleteSkill: [name] });
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
    if (mode === "add" || mode === "repo" || mode === "catalog") { this.persist = false; this.query?.set_value?.(""); }
    if (mode === "catalog") { this.cur.skill = null; this.loadDetails(cx); }
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
      cur: this.cur,
      bundleName: this.bundleName,
      bundleDesc: this.bundleDesc,
      repoList: this.repoList,
      hasCatalog: this.cat.state === "ready",
      sources: shared(KEY.sources) ?? {},
      sourcing: new Set(sourcing.keys()),
      srcErrors: this.srcErrors,
      srcId: (repo) => sourceId(this.on, repo),
      filter: String(this.query?.value?.() ?? "").trim().toLowerCase(),
      plain: ready && !p.manifest, // no Manifest: the links of the project are Extra skills
      linkable: this.linkable(),
      work: ready ? toLink(p.rows).length + toRemove(p.rows).length + (p.info?.retired ?? 0) : 0,
      pending: ready ? pending(p.counts) : 0,
      cloneNote: this.cloneNote(),
      fixes: this.cloneFixes(),
      waiting: this.waiting(),
      collapsed: this.collapsed,
      settingSlug: this.cat.slug ?? null, // the name by which the mod found the Catalog (the setting, or catalog: of skills.yaml)
      // The Bundle picker of a project without skills.yaml offers these Catalogs, when there is more than one.
      catalogs: ready && !p.manifest ? this.knownCatalogs() : [],
      a: {
        reload: (cx) => this.reload(cx, true),
        settings: () => this.openSettings(),
        mode: (m, cx) => this.setMode(m, cx),
        toggle: (name, cx) => this.togglePick(name, cx),
        chooseCatalog: (slug, cx) => this.chooseCatalog(slug, cx),
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
        curateSkill: (name, cx) => this.curateSkill(name, cx),
        curatePick: (bundle, cx) => { if (this.cur.pick.has(bundle)) this.cur.pick.delete(bundle); else this.cur.pick.add(bundle); cx.notify(); },
        curateSave: (cx) => this.saveSkillBundles(cx),
        curateOrphans: (cx) => { this.cur.orphans = !this.cur.orphans; cx.notify(); },
        createBundle: (cx) => this.createBundle(cx),
        curateDelete: (kind, name, cx) => this.curateDelete(cx, kind, name),
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
