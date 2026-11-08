// skill-bundles: the state of the agent skills of the focused project, and the actions that
// change them. It reads a Catalog (a repository with bundles.yaml), the project's Manifest
// (skills.yaml) and Lock (skills-lock.json), and runs `npx skills` to install or remove.
// The words are the ones of CONTEXT.md.
//
// Roles (props.part):
//   (none)    the panel: a Dock panel (dock/panels.json) or a pane.
//   "status"  the status bar item. A click opens the panel in a dialog.
//   "dialog"  the panel in a dialog (the status item and the command skill-bundles.open).
//
// Every copy reads on its own (a node run of probe.mjs takes about 0.2 s). The fetch of the
// Catalog and the running action are shared() keys, so that 2 copies do not do them twice.

import { View } from "gpui-kit";
import { InputState } from "gpui-base";
import { theme, props, shared, setShared, focused, spaces, panes, readTextFile, writeTextFile, notify, run, openOverlay, nextCommand, settings } from "herdr";
import * as C from "./catalog.js";
import { parseCatalog, parseManifest, formatManifest, resolveManifest, sameRepo, withSource, withoutSource, withGitignoreBlock, orderBundles } from "./manifest.js";
import { buildRows, groupRows, pending } from "./status.js";
import { STR, fill } from "./text.js";
import { panelView, statusView } from "./view.js";

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
};
const DEFAULT_MINUTES = 15;
const CHECK_MS = 60 * 1000; // the timer: read the project again, and fetch when due
// The copy that runs a job renews its time on the CHECK_MS timer. A job that is not renewed
// for this long is from a copy that stopped (a reload of the mod in the middle of it).
const JOB_STALE_MS = 150 * 1000;

let lastCwd = null;

/** Where the focused work is: { cwd, machine }. As in ci-dash: the pane, the tab, the space. */
function location() {
  const f = focused();
  const space = spaces().find((s) => s.id === f?.space) || spaces().find((s) => s.active);
  const all = panes();
  const pane = f?.pane ? all.find((p) => p.pane === f.pane) : null;
  const inTab = all.find((p) => p.tab === f?.tab && p.cwd)?.cwd;
  const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const inSpace = all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd;
  const cwd = pane?.cwd || f?.cwd || inTab || inSpace || lastCwd || space?.folder || null;
  if (pane?.cwd || f?.cwd || inTab || inSpace) lastCwd = cwd;
  return { cwd, machine: space?.machine ?? null };
}

const baseName = (p) => String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
const errorText = (e) => String(e?.message ?? e);

// One clone at a time for each folder, when 2 copies start together.
const cloning = new Map();
function cloneOnce(slug, dir, gitUrl) {
  if (!cloning.has(dir)) cloning.set(dir, C.ensureClone(slug, dir, gitUrl).finally(() => cloning.delete(dir)));
  return cloning.get(dir);
}

export default class SkillBundles extends View {
  init(given, cx) {
    // Read props once: props() in a later callback can answer for another copy.
    this.props = (given && Object.keys(given).length ? given : props()) || {};
    this.part = this.props.part ?? "panel";
    this.cat = { state: "loading" }; // see loadCatalog
    this.proj = { state: "loading" }; // see loadProject
    this.mode = "list"; // "list" | "bundles" | "add"
    this.pick = new Set(); // the Bundles chosen in the "bundles" mode and the start view
    this.persist = false; // "Keep in skills.yaml" of the "add" mode
    this.error = null; // { text } of the last failed action of this copy
    this.locKey = null;
    this.settingsKey = null;
    this.changedAt = shared(KEY.changed)?.at ?? 0;
    this.keys = cx.focus_handle();
    if (this.part !== "status") {
      this.query = InputState.new({ placeholder: this.str.search });
      this.query.on("change", (_e, cx) => cx.notify());
    }
    cx.timer.every(CHECK_MS, (cx) => {
      if (this.running) setShared(KEY.job, { ...(shared(KEY.job) ?? {}), at: Date.now() });
      this.reload(cx, false);
    });
    // "skill-bundles.open" (a key, or herdr-app do) opens the panel as a dialog. Only the status
    // copy listens: a command reaches every shown copy, so more listeners open more dialogs.
    // The panel copies listen for "sync" (Update all) and "fetch" (fetch the Catalog now). With
    // a panel and a dialog shown, both get the command: the shared job lets only one act.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (this.part === "status") { if (c === "open") this.openDialog(); continue; }
        if (c === "fetch") this.reload(cx, true);
        if (c === "sync" && this.proj.state === "ready" && this.proj.manifest && this.cat.state === "ready") this.syncAll(cx);
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
        if (this.cat.state === "ready") this.proj = { state: "error", error: errorText(e) };
        else this.cat = { state: "error", slug: this.cat.slug, error: errorText(e) };
      } finally {
        this.reading = false;
      }
      cx.notify();
      if (this.again) { const { force: f } = this.again; this.again = null; this.reload(cx, f); }
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
      fetchError = own ? await C.fetchOnly(dir) : await C.updateOwnClone(dir);
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
   * this.proj: { state: "none" } | { state: "remote", machine } | { state: "ready", root, name,
   * manifestText, manifest, probe, rows, groups, counts, unknown } | { state: "error", error }
   */
  async loadProject() {
    const loc = location();
    if (loc.machine) { this.proj = { state: "remote", machine: loc.machine }; return; }
    const root = await C.gitRoot(loc.cwd);
    if (!root) { this.proj = { state: "none" }; return; }
    const manifestText = await readTextFile(`${root}/skills.yaml`).catch(() => null);
    const manifest = manifestText === null ? null : parseManifest(manifestText);
    const catalog = this.cat.state === "ready" ? this.cat.catalog : null;
    const probe = await C.probe(root, catalog ? this.cat.dir : null, catalog?.repo ?? null);
    const { rows, unknown, counts } = buildRows({ manifest, catalog, probe: probe.error ? null : probe });
    // Another project: the Bundle choice and the mode of the old one do not apply.
    if (this.proj.root !== root) { this.pick = new Set(); this.mode = "list"; this.error = null; }
    this.proj = {
      state: "ready", root, name: baseName(root), manifestText, manifest, probe,
      rows, groups: groupRows(rows, manifest), counts, unknown,
    };
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

  /** The package for `npx skills add`: the Catalog at the branch of the person's own clone. */
  pkg(repo) {
    const catalog = this.cat.catalog;
    return catalog && this.cat.ref?.branch && sameRepo(repo, catalog.repo) ? `${catalog.repo}#${this.cat.ref.branch}` : repo;
  }

  /** Runs one action for the project, then reads again and posts a toast with what changed. */
  act(cx, label, work) {
    if (this.job() || this.proj.state !== "ready") return;
    const project = this.proj;
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
        notify({ title: fill(this.str.doneTitle, { project: project.name }), body: fill(this.str.doneBody, { updated, added, removed }), timeout: 5000 });
        this.mode = "list";
      }
      cx.notify();
    });
  }

  /** `npx skills add` for each repository: [{ repo, skills }]. */
  async install(root, groups) {
    const blocked = this.installBlock();
    if (blocked) throw new Error(blocked);
    for (const g of groups) {
      if (!g.skills.length) continue;
      setShared(KEY.job, { ...(shared(KEY.job) ?? {}), label: fill(this.str.busyInstall, { n: g.skills.length }), at: Date.now() });
      const r = await C.npx(["skills", "add", this.pkg(g.repo), "-s", ...g.skills, "-y"], root);
      if (r.code !== 0) throw new Error(C.tail(r) || `npx skills add ${g.repo}`);
    }
  }

  async uninstall(root, names) {
    if (!names.length) return;
    const r = await C.npx(["skills", "remove", ...names, "-y"], root);
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
    await writeTextFile(`${project.root}/skills.yaml`, formatManifest(manifest), project.manifestText);
  }

  /** Update all: installs every skill of the Manifest (missing and outdated), as Install-Skills.ps1. */
  syncAll(cx) {
    this.act(cx, this.str.syncAll, async (p) => this.install(p.root, this.required(p.manifest).groups));
  }

  installOne(cx, row) {
    this.act(cx, fill(this.str.busyInstall, { n: 1 }), async (p) => this.install(p.root, [{ repo: row.repo, skills: [row.name] }]));
  }

  removeExtra(cx, row) {
    this.act(cx, fill(this.str.busyRemove, { list: row.name }), async (p) => this.uninstall(p.root, [row.name]));
  }

  keepExtra(cx, row) {
    this.act(cx, this.str.busyWrite, async (p) => this.writeManifest(p, withSource(p.manifest, row.repo || this.cat.catalog.repo, [row.name])));
  }

  dropSource(cx, row) {
    this.act(cx, fill(this.str.busyRemove, { list: row.name }), async (p) => {
      const next = withoutSource(p.manifest, row.name);
      await this.writeManifest(p, next);
      if (!this.required(next).names.has(row.name)) await this.uninstall(p.root, [row.name]);
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
      await this.install(p.root, after.groups);
      const installed = new Set(Object.keys(p.probe?.lock ?? {}));
      await this.uninstall(p.root, [...before].filter((n) => !after.names.has(n) && installed.has(n)));
    });
  }

  /** The start view: writes skills.yaml and the .gitignore block, then installs. */
  start(cx) {
    const bundles = orderBundles([...this.pick]);
    this.act(cx, this.str.busyWrite, async (p) => {
      const manifest = { bundles, sources: [] };
      await writeTextFile(`${p.root}/skills.yaml`, formatManifest(manifest), null);
      const gitignore = await readTextFile(`${p.root}/.gitignore`).catch(() => null);
      const next = withGitignoreBlock(gitignore);
      if (next !== null) await writeTextFile(`${p.root}/.gitignore`, next, gitignore);
      await this.install(p.root, this.required(manifest).groups);
    });
  }

  /** Add skill: installs one skill of the Catalog, and keeps it in sources: when asked. */
  addSkill(cx, name) {
    const persist = this.persist;
    const repo = this.cat.catalog.repo;
    this.act(cx, fill(this.str.busyInstall, { n: 1 }), async (p) => {
      await this.install(p.root, [{ repo, skills: [name] }]);
      if (persist) await this.writeManifest(p, withSource(p.manifest, repo, [name]));
    });
  }

  // ---- views ------------------------------------------------------------------------------

  openDialog() {
    openOverlay({ mod: MOD, kind: "dialog", width: 620, height: 680, props: { part: "dialog", lang: this.lang } });
  }

  /** Opens the Settings tab of the mods-hub dialog (its tab is kept in its shared state). */
  openSettings() {
    setShared("mods-hub", { ...(shared("mods-hub") ?? {}), tab: "settings" });
    run("mod.open", { name: "mods-hub" });
  }

  setMode(mode, cx) {
    this.mode = mode;
    this.error = null;
    if (mode === "bundles") this.pick = new Set(this.proj.manifest?.bundles ?? ["core"]);
    if (mode === "add") { this.persist = false; this.query?.set_value?.(""); }
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
      filter: String(this.query?.value?.() ?? "").trim().toLowerCase(),
      pending: p.state === "ready" ? pending(p.counts) : 0,
      blocked: this.installBlock(),
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
        dropSource: (row, cx) => this.dropSource(cx, row),
        applyBundles: (cx) => this.applyBundles(cx),
        start: (cx) => this.start(cx),
        addSkill: (name, cx) => this.addSkill(cx, name),
        open: () => this.openDialog(),
        startPick: (cx) => { if (!this.pick.size) this.pick = new Set(["core"]); cx.notify(); },
      },
    };
  }

  render(cx) {
    this.watchChanges(cx);
    const t = theme();
    const m = this.model();
    if (this.part === "status") return statusView(t, m);
    if (m.proj.state === "ready" && !m.proj.manifest && !this.pick.size) this.pick = new Set(["core"]);
    return panelView(t, m, this.keys, settings());
  }
}
