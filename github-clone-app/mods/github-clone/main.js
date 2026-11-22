// GitHub Clone: a dialog that lists the GitHub repositories of the account
// of a machine and clones one into a folder of that machine.
//
// Three views:
//   list    - the machine picker, the owner chips, the fuzzy search and the repositories
//   step    - the clone step of 1 repository: folder, branch, shallow (step.js)
//   folders - the clone folder of each machine and the owner rules (folders.js)
//
// The list of each machine comes from the `gh` of that machine, and the
// clone runs there, in a visible terminal of a new space. The mod only
// clones: Repo Launcher opens repositories.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, closeOverlay, notify, spaces, run, shared, machines, settings as appSettings, nextCommand, checking, appHome } from "herdr";
import * as fs from "fs/promises";
import { matchRepo } from "./fuzzy.js";
import { fetchAccount, GhError } from "./gh.js";
import { machineInfo, probeFolders, expandHome, keyOf, repoOfUrl, pathExists, openUrl, repoUrl } from "./sys.js";
import { mkey, cacheOf, setCacheOf, order, setOrder, folderFor, rootOf, rulesOf, pending, setPending, removeLauncherRepo } from "./store.js";
import { icon, tint, nameColor, letterTile, pill, kbd, hint, iconButton, button, segmented, chip, highlighted, ago, notice } from "./ui.js";
import { stepMethods } from "./step.js";
import { folderMethods } from "./folders.js";
import { DEMO } from "./demo.js";
import { memory, machineList, machineLabel, ROW_H, HEAD_H, FOOT_H } from "./common.js";

// The mods-hub can turn this mod off (shared "herdr-mods.disabled", a list of mod names). Then the mod draws
// nothing and closes its dialog. The bars hide its buttons.
const kitOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes("github-clone"); };
const offView = () => { const o = props()?.overlay; if (o) closeOverlay(o); return div(); };

const STALE_MS = 15 * 60 * 1000; // a list older than this is read again in the background
const RETRY_MS = 60 * 1000; // a failed read is tried again after this, when the dialog opens
const PROBE_MS = 15 * 1000; // the clone folders are listed again after this
const PENDING_MS = 2 * 60 * 1000; // a clone whose folder is still missing after this failed
const ORDERS = [
  { value: "name", label: "Name", tooltip: "owner/name, A to Z" },
  { value: "pushed", label: "Last push", tooltip: "The repositories with recent work first" },
  { value: "owner", label: "Owner", tooltip: "Your repositories first, then each organization" },
];

export default class GitHubClone extends View {
  init(_props, cx) {
    this.view = "list";
    this.filter = "";
    this.at = 0;
    this.owner = "all";
    this.archived = false;
    this.scrollTop = 0;
    this.follow = true;
    this.size = null;
    this.handle = cx.focus_handle();
    // A copy of the dialog stops its tasks when it closes, so a read that
    // was in progress is no longer in progress.
    memory.loading = {};
    memory.probing = {};

    const active = spaces().find((s) => s.active);
    const list = machineList();
    const start = list.find((m) => m.name === (active?.machine ?? null) && !m.disabled);
    this.machine = start ? start.name : null;

    this.query = InputState.new({ placeholder: "Search owner/name…" });
    this.query.on("change", (_e, cx) => {
      this.filter = this.query.value();
      this.at = 0;
      this.scrollTop = 0;
      this.follow = true;
      cx.notify();
    });
    this.query.on("submit", (_e, cx) => this.choose(this.selectedRow()?.repo, cx));
    this.query.focus();
    cx.timer.after(400, () => { if (this.view === "list") this.query.focus(); });

    this.initStep(cx);
    this.initFolders(cx);

    if (checking()) return;
    cx.spawn(async (cx) => {
      try { memory.launcherInstalled = await fs.exists(`${appHome()}/mods/repo-launcher/mod.json`); } catch {}
      cx.notify();
    });
    this.ensureFresh(this.machine, cx);
    this.probe(this.machine, cx);
    this.cleanPending(cx);
    // Commands for tests and for the preview: `herdr-app do github-clone.<name>`.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "demo") memory.demo = !memory.demo;
        else if (c === "folders") this.openFolders(cx);
        else if (c === "list") this.back(cx);
        else if (c === "refresh") this.refresh(this.machine, cx, { loud: true });
        else if (c === "machine") this.cycleMachine(cx);
        else if (c === "step") this.choose(this.selectedRow()?.repo, cx);
        else if (c === "clone" && this.view === "step") this.launchClone(cx);
        else if (c === "owner") this.cycleOwner(cx);
        else if (c === "web") { const repo = this.view === "step" ? this.step?.repo : this.selectedRow()?.repo; if (repo) openUrl(repoUrl(repo.full)); }
        else if (c === "down" || c === "up") this.onKey({ key: c, modifiers: {} }, { stop_propagation() {}, notify() {} });
        cx.notify();
      }
    });
  }

  close() {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  focusRoot(cx) {
    this.handle.focus();
    cx.timer.after(40, () => this.handle.focus());
  }

  focusQuery(cx) {
    this.query.focus();
    cx.timer.after(40, () => this.query.focus());
  }

  // ---------------------------------------------------------------------------
  // Data

  /** The saved list of the shown machine (or the demo list). */
  account(machine = this.machine) {
    return memory.demo ? DEMO.account : cacheOf(machine);
  }

  isLoading(machine = this.machine) {
    return !memory.demo && Boolean(memory.loading[mkey(machine)]);
  }

  /** Reads the list again when it is missing, old, or failed a while ago. */
  ensureFresh(machine, cx) {
    const c = cacheOf(machine);
    const now = Date.now();
    if (!c || (c.error ? now - (c.checkedAt ?? 0) > RETRY_MS : now - (c.fetchedAt ?? 0) > STALE_MS)) this.refresh(machine, cx);
  }

  /** Reads the account, the repositories and the organizations of a machine. */
  refresh(machine, cx, { loud = false } = {}) {
    const k = mkey(machine);
    if (memory.loading[k]) return;
    memory.loading[k] = Date.now();
    cx.spawn(async (cx) => {
      const prev = cacheOf(machine);
      try {
        if (machine && machines().find((m) => m.name === machine)?.layout === "unavailable") {
          throw new GhError("offline", `${machine} cannot be reached now`);
        }
        const account = await fetchAccount(machine);
        setCacheOf(machine, { ...account, fetchedAt: Date.now(), error: null });
        if (loud) notify({ title: "Repositories updated", body: `${account.repos.length} repositories of ${account.login} on ${machineLabel(machine)}`, level: "success", timeout: 3000 });
      } catch (e) {
        setCacheOf(machine, {
          login: prev?.login ?? "", repos: prev?.repos ?? [], orgs: prev?.orgs ?? [], fetchedAt: prev?.fetchedAt ?? 0,
          error: { kind: e?.kind ?? "error", message: String(e?.message ?? e) }, checkedAt: Date.now(),
        });
      } finally {
        delete memory.loading[k];
      }
      cx.notify();
    });
    cx.notify();
  }

  /** The folders where the clones of a machine go (its clone folder and its owner rule folders). */
  cloneFolders(machine) {
    const list = [rootOf(machine), ...rulesOf(machine).map((r) => String(r.folder ?? "").trim())].filter(Boolean);
    return [...new Set(list)];
  }

  /** Lists the clone folders of a machine, to mark the repositories that are cloned there. */
  probe(machine, cx, { force = false } = {}) {
    const k = mkey(machine);
    const last = memory.probes[k];
    if (memory.probing[k] || (!force && last && Date.now() - last.at < PROBE_MS)) return;
    const folders = this.cloneFolders(machine);
    if (!folders.length) {
      delete memory.probes[k];
      return;
    }
    if (machine && machines().find((m) => m.name === machine)?.layout === "unavailable") return;
    memory.probing[k] = true;
    cx.spawn(async (cx) => {
      try {
        const info = await machineInfo(machine);
        const full = folders.map((f) => expandHome(f, info));
        const result = await probeFolders(machine, info, full);
        memory.probes[k] = { at: Date.now(), info, ...result };
      } catch {
        // No marks for this machine: the clone step checks its folder anyway.
      } finally {
        delete memory.probing[k];
      }
      cx.notify();
    });
  }

  /**
   * "cloned" when the destination folder of the repository holds it,
   * "used" when the folder exists with something else, else null.
   */
  repoStatus(repo, machine = this.machine) {
    if (memory.demo) return DEMO.status[repo.full] ?? null;
    const folder = folderFor(machine, repo.owner);
    const p = memory.probes[mkey(machine)];
    if (!folder || !p) return null;
    const map = p.byFolder.get(keyOf(expandHome(folder, p.info), p.info.fold));
    const entry = map?.get(keyOf(repo.name, p.info.fold));
    if (!entry) return null;
    return entry.git && repoOfUrl(entry.url) === repo.full.toLowerCase() ? "cloned" : "used";
  }

  /**
   * The clones that started earlier added an entry to the cache of Repo
   * Launcher. A clone whose folder is still missing after 2 minutes failed or
   * was stopped: its entry goes.
   */
  cleanPending(cx) {
    const list = pending();
    if (!list.length) return;
    cx.spawn(async (cx) => {
      const keep = [];
      for (const item of list) {
        const machine = item.machine ?? null;
        try {
          if (machine && machines().find((m) => m.name === machine)?.layout !== "ready") { keep.push(item); continue; }
          const info = await machineInfo(machine);
          if (await pathExists(machine, info, item.path)) continue;
          if (Date.now() - (item.at ?? 0) < PENDING_MS) { keep.push(item); continue; }
          removeLauncherRepo(machine, item.path, info.fold);
        } catch {
          keep.push(item);
        }
      }
      // Clones can start while this runs: keep the ones that are new.
      const now = pending();
      const seen = new Set(list.map((x) => `${x.machine ?? ""}|${x.path}`));
      setPending([...keep, ...now.filter((x) => !seen.has(`${x.machine ?? ""}|${x.path}`))]);
      cx.notify();
    });
  }

  // ---------------------------------------------------------------------------
  // The list

  setMachine(machine, cx) {
    if (machine === this.machine) return;
    this.machine = machine;
    this.owner = "all";
    this.at = 0;
    this.scrollTop = 0;
    this.follow = true;
    if (!checking()) {
      this.ensureFresh(machine, cx);
      this.probe(machine, cx);
    }
    this.focusQuery(cx);
    cx.notify();
  }

  cycleMachine(cx) {
    const list = machineList().filter((m) => !m.disabled);
    if (list.length < 2) return;
    const i = list.findIndex((m) => m.name === this.machine);
    this.setMachine(list[(i + 1) % list.length].name, cx);
  }

  setOwner(owner, cx) {
    this.owner = owner;
    this.at = 0;
    this.scrollTop = 0;
    this.follow = true;
    this.focusQuery(cx);
    cx.notify();
  }

  cycleOwner(cx) {
    const list = ["all", ...this.owners().map((o) => o.owner)];
    this.setOwner(list[(list.indexOf(this.owner) + 1) % list.length] ?? "all", cx);
  }

  /** The repositories that the archived switch lets through. */
  baseRepos() {
    const repos = this.account()?.repos ?? [];
    return this.archived ? repos : repos.filter((r) => !r.archived);
  }

  /**
   * The owner chips: the account first, then the other owners of the list,
   * then the organizations with no repository in the list (`warn`: the token
   * may need SSO authorization for them).
   */
  owners() {
    const c = this.account();
    if (!c) return [];
    const counts = new Map();
    for (const r of this.baseRepos()) counts.set(r.owner, (counts.get(r.owner) ?? 0) + 1);
    const out = [];
    if (c.login) out.push({ owner: c.login, count: counts.get(c.login) ?? 0, user: true });
    const others = [...counts.keys()].filter((o) => o !== c.login).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    for (const o of others) out.push({ owner: o, count: counts.get(o) });
    const known = new Set([c.login, ...others].map((o) => String(o).toLowerCase()));
    for (const org of c.orgs ?? []) {
      if (!known.has(org.toLowerCase())) out.push({ owner: org, count: 0, warn: true });
    }
    return out;
  }

  /** The rows of the list: `{ repo, match, status }`, filtered and sorted. */
  rows() {
    const c = this.account();
    let repos = this.baseRepos();
    if (this.owner !== "all") repos = repos.filter((r) => r.owner.toLowerCase() === this.owner.toLowerCase());
    const q = this.filter.trim();
    if (q) {
      const hits = [];
      for (const repo of repos) {
        const match = matchRepo(q, repo.name, repo.owner);
        if (match) hits.push({ repo, match });
      }
      hits.sort((a, b) => b.match.score - a.match.score || a.repo.full.localeCompare(b.repo.full));
      return hits.map((h) => ({ ...h, status: this.repoStatus(h.repo) }));
    }
    const byName = (a, b) => a.full.toLowerCase().localeCompare(b.full.toLowerCase());
    const sorted = [...repos];
    const o = order();
    if (o === "pushed") sorted.sort((a, b) => (b.pushed ?? 0) - (a.pushed ?? 0) || byName(a, b));
    else if (o === "owner") {
      const login = String(c?.login ?? "").toLowerCase();
      sorted.sort((a, b) => (Number(b.owner.toLowerCase() === login) - Number(a.owner.toLowerCase() === login))
        || a.owner.toLowerCase().localeCompare(b.owner.toLowerCase()) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    } else sorted.sort(byName);
    return sorted.map((repo) => ({ repo, match: null, status: this.repoStatus(repo) }));
  }

  selectedRow(rows = this.rows()) {
    return rows[Math.min(this.at, rows.length - 1)] ?? null;
  }

  choose(repo, cx) {
    if (!repo) return;
    this.enterStep(repo, cx);
  }

  back(cx) {
    const from = this.view;
    this.view = "list";
    if (from === "folders" && !checking()) this.probe(this.machine, cx, { force: true });
    this.focusQuery(cx);
    cx.notify();
  }

  /** Opens a terminal on the machine that runs `gh auth login`. */
  login(machine, cx) {
    run("space.new", { machine: machine ?? "", argv: ["gh", "auth", "login"] });
    this.close();
  }

  // ---------------------------------------------------------------------------
  // Keys

  onKey(e, cx) {
    const k = e.key;
    const m = e.modifiers ?? {};
    const ctrl = m.control || m.platform;
    if (this.view === "step") return this.stepKey(e, cx);
    if (this.view === "folders") {
      // A focused text field keeps Esc from Herdr: go back here.
      if (k === "escape") { cx.stop_propagation(); this.back(cx); }
      return;
    }
    // The list view. A focused search field keeps Esc from Herdr: close here.
    if (k === "escape") { cx.stop_propagation(); return this.close(); }
    const rows = this.rows();
    if (k === "down" || k === "up") {
      if (!rows.length) return;
      this.at = (this.at + (k === "down" ? 1 : rows.length - 1)) % rows.length;
      this.follow = true;
    } else if (k === "pagedown" || k === "pageup") {
      if (!rows.length) return;
      this.at = Math.max(0, Math.min(rows.length - 1, this.at + (k === "pagedown" ? 8 : -8)));
      this.follow = true;
    } else if (ctrl && k === "r") {
      this.refresh(this.machine, cx, { loud: true });
      this.probe(this.machine, cx, { force: true });
    } else if (ctrl && k === "m") {
      cx.stop_propagation();
      return this.cycleMachine(cx);
    } else if (ctrl && k === "o") {
      const repo = this.selectedRow(rows)?.repo;
      if (repo) openUrl(repoUrl(repo.full));
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ---------------------------------------------------------------------------
  // Drawing

  render() {
    if (kitOff()) return offView();
    const t = theme();
    const body = this.view === "step" ? this.renderStep(t)
      : this.view === "folders" ? this.renderFolders(t)
      : this.renderList(t);
    return v_flex().id("github-clone").size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      // In a dialog, a click outside the text fields gives the keyboard to
      // the dialog, so Esc still reaches it.
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(body);
  }

  /** The height of the dialog in layout pixels. */
  height() {
    const zoom = Number(appSettings().zoom) || 1;
    return this.size ? this.size.height / zoom : 640;
  }

  header(t, title, subtitle, { leading, trailing = [] }) {
    return h_flex().h(HEAD_H).flex_none().px(16).gap(12).items_center().border_b(1).border_color(t.border)
      .child(leading)
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(15).font_semibold().truncate().child(title))
        .when(Boolean(subtitle), (e) => e.child(div().text_size(11.5).text_color(t.dim).truncate().child(subtitle))))
      .children(trailing)
      .when(Boolean(props()?.overlay), (e) => e.child(iconButton(t, "gc-close", "close", () => this.close(), { tooltip: "Close", size: 26 })));
  }

  brandTile(t) {
    return h_flex().size(34).flex_none().rounded(10).items_center().justify_center().bg(t.accent)
      .child(svg(icon("github")).size(18).text_color(t.accent_foreground ?? "#ffffff"));
  }

  /** An input box with an icon. */
  inputBox(t, state, { symbol = null, focus = false, mono = false } = {}) {
    const font = appSettings().font_family ?? "JetBrains Mono";
    return h_flex().h(34).flex_1().min_w(0).px(10).gap(8).items_center().rounded(8).bg(t.background)
      .border_1().border_color(focus ? tint(t.accent, "99") : t.border)
      // A text field takes its own clicks: the dialog does not take the keyboard from it.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .when(Boolean(symbol), (e) => e.child(svg(icon(symbol)).size(14).flex_none().text_color(t.dim)))
      .child(Input.new(state).flex_1().h_full().text_size(12.5).when(mono, (e) => e.font_family(font)));
  }

  machinePicker(t) {
    const list = machineList();
    if (list.length < 2) return null;
    return h_flex().flex_none().items_center().gap(6)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(kbd(t, "Ctrl+M"))
      .child(segmented(t, "gc-machine", list.map((m) => ({
        value: mkey(m.name), label: m.name ? m.label : "This computer", symbol: m.name ? "server" : null, disabled: m.disabled,
        tooltip: m.disabled ? `${m.label} cannot be reached now` : `The gh account of ${m.name ? m.label : "this computer"}: its repositories, cloned there`,
      })), mkey(this.machine), (v, cx) => this.setMachine(v || null, cx)));
  }

  renderList(t) {
    const c = this.account();
    const loading = this.isLoading();
    const rows = this.rows();
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const sel = rows[this.at]?.repo ?? null;
    const visible = this.baseRepos().length;
    const where = machineLabel(this.machine);
    const subtitle = c?.login ? `${c.login} on ${where} · ${visible} repositor${visible === 1 ? "y" : "ies"}`
      : loading ? `Reading the account on ${where}…` : `The gh account of ${where}`;

    const head = this.header(t, "Clone a repository", subtitle, {
      leading: this.brandTile(t),
      trailing: [
        iconButton(t, "gc-refresh", "refresh", (cx) => { this.refresh(this.machine, cx, { loud: true }); this.probe(this.machine, cx, { force: true }); },
          { tooltip: "Read the list again (Ctrl+R)", spin: loading }),
        iconButton(t, "gc-folders", "settings", (cx) => this.openFolders(cx), { tooltip: "Clone folders" }),
      ],
    });

    const picker = this.machinePicker(t);
    const search = h_flex().mx(16).mt(12).h(40).flex_none().px(12).gap(10).items_center().rounded(10)
      .bg(t.background).border_1().border_color(tint(t.accent, "99"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(svg(icon("search")).size(15).text_color(t.accent))
      .child(Input.new(this.query).flex_1().h_full().text_size(13.5).text_color(t.foreground))
      .when(Boolean(this.filter), (e) => e.child(div().text_size(11).text_color(t.dim).child(`${rows.length} match${rows.length === 1 ? "" : "es"}`)))
      .when(Boolean(picker), (e) => e.child(picker));

    const owners = this.owners();
    const chips = h_flex().mx(16).mt(10).flex_none().gap(10).items_start()
      .child(h_flex().flex_1().min_w(0).flex_wrap().gap(6)
        .when(owners.length > 0, (e) => e
          .child(chip(t, "gc-owner-all", "All", this.owner === "all", (cx) => this.setOwner("all", cx), { count: visible }))
          .children(owners.map((o) => chip(t, `gc-owner-${o.owner}`, o.owner, this.owner === o.owner, (cx) => this.setOwner(o.owner, cx), {
            count: o.count, symbol: o.user ? "user" : "users", warn: o.warn,
            tooltip: o.warn ? "No repositories in the list: the gh token may need SSO authorization for this organization" : "",
          }))))
        .child(chip(t, "gc-archived", "Archived", this.archived, (cx) => { this.archived = !this.archived; this.at = 0; this.focusQuery(cx); cx.notify(); },
          { symbol: "archive", tooltip: this.archived ? "Hide the archived repositories" : "Show the archived repositories" })))
      .child(segmented(t, "gc-order", ORDERS, order(), (v, cx) => { setOrder(v); this.at = 0; this.scrollTop = 0; this.focusQuery(cx); cx.notify(); }));

    const error = c?.error;
    const banner = error && c.repos?.length ? h_flex().mx(16).mt(8).px(10).py(4).flex_none().rounded(8).bg(tint(t.blocked, "14"))
      .child(notice(t, "warn", `Could not read the list again: ${error.message}. The list is from ${ago(c.fetchedAt) || "before"}.`,
        error.kind === "login" ? button(t, "gc-login-banner", "Log in…", (cx) => this.login(this.machine, cx), { symbol: "login" }) : null)) : null;

    // The list fills what the other parts leave.
    const listH = Math.max(120, this.height() - HEAD_H - FOOT_H - 52 - 34 - (banner ? 40 : 0) - 14);
    let content;
    if (!c && loading) content = this.emptyState(t, null, `Reading your repositories on ${where}…`, "gh lists every repository that the account owns, works on or sees in its organizations.", null, listH);
    else if (error && !c?.repos?.length) content = this.errorState(t, error, listH);
    else if (!c) content = this.emptyState(t, "github", "No list yet", "", button(t, "gc-read", "Read the list", (cx) => this.refresh(this.machine, cx), { symbol: "refresh", primary: true }), listH);
    else if (!rows.length && this.owner !== "all" && owners.find((o) => o.owner === this.owner)?.warn) {
      content = this.emptyState(t, "users", `No repositories of ${this.owner}`,
        "The gh token may need SSO authorization for this organization. Run gh auth refresh, or authorize the token on the SSO page of the organization. Then click Refresh.", null, listH);
    } else if (!rows.length && this.filter.trim()) content = this.emptyState(t, "search", `No repository matches “${this.filter.trim()}”`, "Try fewer letters, another owner, or the Archived chip.", null, listH);
    else if (!rows.length) content = this.emptyState(t, "github", "No repositories", this.archived ? "" : "The archived repositories are hidden: click Archived to show them.", null, listH);
    else {
      const selIndex = rows.findIndex((r) => r.repo === sel);
      content = this.scrollList(t, rows, ROW_H, listH, selIndex, (r, i) => this.repoRow(t, r, i === selIndex, i));
    }

    const footer = h_flex().h(FOOT_H).flex_none().px(16).gap(14).items_center().border_t(1).border_color(t.border).bg(t.chrome ?? t.popover)
      .child(hint(t, ["↑", "↓"], "move"))
      .child(hint(t, ["↵"], "clone"))
      .when(machineList().length > 1, (e) => e.child(hint(t, ["Ctrl+M"], "machine")))
      .child(hint(t, ["Ctrl+R"], "refresh"))
      .child(hint(t, ["Ctrl+O"], "GitHub"))
      .child(div().flex_1())
      .child(div().text_size(11).text_color(t.dim).child(memory.demo ? "Demo data" : loading ? "Reading…" : c?.fetchedAt ? `Read ${ago(c.fetchedAt)}` : ""));

    return v_flex().size_full().min_h(0)
      .child(head)
      .child(search)
      .child(chips)
      .when(Boolean(banner), (e) => e.child(banner))
      .child(div().mt(8).flex_1().min_h(0).overflow_hidden().child(content))
      .child(footer);
  }

  errorState(t, error, h) {
    const where = machineLabel(this.machine);
    const refresh = button(t, "gc-retry", "Refresh", (cx) => this.refresh(this.machine, cx, { loud: true }), { symbol: "refresh" });
    if (error.kind === "nogh") return this.emptyState(t, "github", `gh is not installed on ${where}`, "Install the GitHub CLI from https://cli.github.com and run gh auth login. Then click Refresh.", refresh, h);
    if (error.kind === "login") {
      return this.emptyState(t, "login", `gh is not logged in on ${where}`, "Log in with gh auth login. The button opens a terminal on that machine for it. Then click Refresh.",
        h_flex().gap(8).child(button(t, "gc-login", "Log in…", (cx) => this.login(this.machine, cx), { primary: true, symbol: "login" })).child(refresh), h);
    }
    if (error.kind === "offline") return this.emptyState(t, "server", `${where} cannot be reached now`, "Pick another machine, or try again when it is back.", refresh, h);
    return this.emptyState(t, "alert", "Could not read the repositories", error.message, refresh, h);
  }

  emptyState(t, symbol, title, detail, action, h) {
    return v_flex().h(h).w_full().items_center().justify_center().gap(10).p(28)
      .child(h_flex().size(54).rounded(27).items_center().justify_center().bg(tint(t.accent, "1a"))
        .child(symbol
          ? svg(icon(symbol)).size(24).text_color(t.accent)
          : svg(icon("spinner")).size(24).text_color(t.accent).spin(900)))
      .child(div().mt(4).text_size(14).font_semibold().child(title))
      .when(Boolean(detail), (e) => e.child(div().max_w(520).text_size(12).text_color(t.dim).child(detail)))
      .when(Boolean(action), (e) => e.child(div().mt(8).child(action)));
  }

  /**
   * A list that draws only the rows in view. Rows sit at fixed offsets; the
   * wheel moves them, and while `follow` is on the list moves just enough to
   * show the selected row.
   */
  scrollList(t, items, rowH, height, focus, draw) {
    const total = items.length * rowH;
    const h = Math.min(height, total);
    const max = Math.max(0, total - h);
    let top = this.scrollTop;
    if (this.follow && focus >= 0) {
      if (focus * rowH < top) top = focus * rowH;
      if ((focus + 1) * rowH > top + h) top = (focus + 1) * rowH - h;
    }
    top = Math.max(0, Math.min(top, max));
    this.scrollTop = top;
    const first = Math.floor(top / rowH);
    const last = Math.min(items.length - 1, Math.ceil((top + h) / rowH));
    const rows = [];
    for (let i = first; i <= last; i++) {
      rows.push(div().absolute().left(0).right(0).top(i * rowH - top).h(rowH).child(draw(items[i], i)));
    }
    const thumb = total > h ? Math.max(24, (h * h) / total) : 0;
    return div().id("gc-scroll").relative().w_full().h(h).flex_none().overflow_hidden()
      .on_scroll_wheel((e, cx) => {
        this.follow = false;
        this.scrollTop = Math.max(0, Math.min(this.scrollTop - e.delta.y, max));
        cx.notify();
      })
      .children(rows)
      .when(thumb > 0, (el) => el.child(div().absolute().right(3).w(4).rounded(2).bg(tint(t.foreground, "33"))
        .top(max ? ((h - thumb) * top) / max : 0).h(thumb)));
  }

  statusPill(t, status, repo) {
    if (status === "cloned") return pill(t, "cloned", { color: t.done ?? t.accent, symbol: "check", tooltip: `Cloned in ${folderFor(this.machine, repo.owner)}` });
    if (status === "used") return pill(t, "folder in use", { color: t.blocked, symbol: "alert", tooltip: "The destination folder exists and holds something else" });
    return null;
  }

  repoRow(t, r, selected, index) {
    const { repo, match, status } = r;
    const statusEl = this.statusPill(t, status, repo);
    return h_flex().id(`gc-row-${repo.full}`).h(ROW_H).px(8).flex_none()
      .child(h_flex().size_full().px(10).gap(12).items_center().rounded(10).cursor_pointer()
        .border_1().border_color(selected ? tint(t.accent, "80") : "#00000000")
        .bg(selected ? tint(t.accent, "1c") : "#00000000")
        .when(!selected, (e) => e.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => {
          this.at = index;
          this.choose(repo, cx);
        })
        .child(letterTile(repo.name, nameColor(repo.name), 32))
        .child(v_flex().flex_1().min_w(0).gap(2).justify_center()
          .child(h_flex().min_w(0).gap(6).items_center().overflow_hidden()
            .child(h_flex().flex_none().items_center()
              .child(highlighted(repo.owner, match?.path, { color: t.muted, hit: t.accent, size: 12.5 }))
              .child(div().text_size(12.5).text_color(t.dim).child("/"))
              .child(highlighted(repo.name, match?.name, { color: t.foreground, hit: t.accent, size: 13.5, bold: true })))
            .when(repo.private, (e) => e.child(svg(icon("lock")).size(12).flex_none().text_color(t.dim)))
            .when(repo.fork, (e) => e.child(svg(icon("fork")).size(12).flex_none().text_color(t.dim)))
            .when(repo.archived, (e) => e.child(svg(icon("archive")).size(12).flex_none().text_color(t.dim)))
            .when(Boolean(statusEl), (e) => e.child(statusEl)))
          .when(Boolean(repo.desc), (e) => e.child(div().text_size(11).text_color(t.dim).truncate().child(repo.desc))))
        .child(v_flex().flex_none().items_end().gap(2)
          .child(div().text_size(11).text_color(t.muted).child(repo.lang || ""))
          .child(div().text_size(10.5).text_color(t.dim).child(ago(repo.pushed))))
        .when(selected, (e) => e
          .child(iconButton(t, `gc-web-${repo.full}`, "external", () => openUrl(repoUrl(repo.full)), { tooltip: "Open on GitHub (Ctrl+O)", size: 26 }))
          .child(kbd(t, "↵"))));
  }
}

Object.assign(GitHubClone.prototype, stepMethods, folderMethods);
