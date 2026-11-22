// Quick Actions: named scripts that run in the terminal of the active space, with 1 click or 1 key.
//
// Roles (props.part):
//   "status"  the status bar item. It is also the runner: a key or a bar button sends
//             `quick-actions.run-<id>`, and only a shown copy of the mod gets it. It keeps the last
//             terminal that had the focus in shared("quick-actions.target").
//   (none)    the dialog (mod.open:quick-actions, a click on the status item): the list and the form.
//             With props { confirm: <id>, target }: the question before a run (opened by the runner).
//
// See docs/quick-actions-plan.md in the herdr-mods repository.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, TextareaState } from "gpui-base";
import { theme, props, shared, setShared, closeOverlay, openOverlay, nextCommand, run, notify, focused, panes, checking, window, knownAgents } from "herdr";
import { startWriter, writerPath, shortPath } from "./writer.js";
import * as S from "./store.js";
import { currentTarget, context, filterMatches, filterNeedsRepo, asksOf } from "./vars.js";
import { runAction, prepare, fail, scriptText } from "./run.js";
import { listView, visible, allowed } from "./list.js";
import { editView, confirmView, errors } from "./form.js";
import { DEMO, DEMO_CTX } from "./demo.js";
import * as U from "./ui.js";

const { KEY, MOD } = S;
const BEAT_MS = 500; // the runner looks at the focus this often
const ALIVE_MS = 20000; // the runner says that it is on the screen this often
const STALE_MS = 60000; // after this time without a sign, there is no runner

// The mods-hub can turn this mod off (shared "herdr-mods.disabled", a list of mod names). Then the mod draws
// nothing, closes its dialog and skips its timed work. The bars hide its blocks and buttons.
const kitOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes(MOD); };
const offView = () => { const o = props()?.overlay; if (o) closeOverlay(o); return div(); };

const runnerAlive = () => Date.now() - (shared(KEY.runner)?.at ?? 0) < STALE_MS;
const isWin = () => window()?.platform === "windows";

export default class QuickActions extends View {
  init(given, cx) {
    // Read props once: props() in a later callback can answer for another copy.
    this.props = (given && Object.keys(given).length ? given : props()) || {};
    this.part = this.props.part === "status" ? "status" : "dialog";
    this.handle = cx.focus_handle();
    if (this.part === "status") return this.initStatus(cx);
    this.initDialog(cx);
  }

  // ---- the runner (status copy) -------------------------------------------------------------

  initStatus(cx) {
    this.busy = false;
    this.aliveAt = 0;
    this.list = []; // the actions, for the filter of the bar buttons
    this.listRev = undefined;
    this.whereKey = null; // where the filter of the bar buttons was last checked
    this.hiding = false;
    if (checking()) return;
    // The bar buttons follow the list, also after a change of the file by hand.
    S.loadList().then((d) => (d.list ? S.syncPanels(d.list) : null)).catch((e) => console.log(`quick-actions: ${e?.message ?? e}`));
    cx.timer.every(BEAT_MS, () => { if (!kitOff()) this.beat(); });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (kitOff()) continue;
        if (c === "open") run("mod.open", { name: MOD });
        else if (c.startsWith("run-")) this.runById(cx, c.slice(4));
      }
    });
  }

  /** Keeps the last terminal that had the focus, and says that the runner is on the screen. */
  beat() {
    const f = focused();
    if (f?.terminal) {
      const k = shared(KEY.target);
      if (!k || k.terminal !== f.terminal || k.space !== f.space || k.tab !== f.tab) setShared(KEY.target, { terminal: f.terminal, space: f.space, tab: f.tab });
    }
    const now = Date.now();
    if (now - this.aliveAt >= ALIVE_MS) { this.aliveAt = now; setShared(KEY.runner, { at: now }); }
    const rev = shared(KEY.rev) ?? null;
    if (rev !== this.listRev) {
      this.listRev = rev;
      S.loadList().then((d) => { if (d.list) { this.list = d.list; this.whereKey = null; } });
    }
    this.updateHidden();
  }

  /**
   * The bar buttons of the pinned actions whose filter leaves out the target terminal go into
   * shared("dock.hiddenEntries"): the bars of Dock and Kanban do not draw them. Checked again when the target,
   * its folder or the list changes.
   */
  updateHidden() {
    const pinned = this.list.filter((a) => a.pinned && a.filter.trim());
    const target = pinned.length ? currentTarget() : null;
    if (!target) { S.setHidden([]); this.whereKey = null; return; }
    const f = focused();
    const cwd = (f?.terminal && f.terminal === target.terminal && f.cwd) || panes().find((p) => p.terminal === target.terminal)?.cwd || "";
    const key = JSON.stringify([target.terminal, target.space, cwd, pinned.map((a) => `${a.id} ${a.filter}`)]);
    if (key === this.whereKey || this.hiding) return;
    this.whereKey = key;
    this.hiding = true;
    const need = new Set(pinned.some((a) => filterNeedsRepo(a.filter)) ? ["repo_name"] : []);
    context(target, need, { probe: false })
      .then((ctx) => S.setHidden(pinned.filter((a) => !filterMatches(a.filter, ctx)).map(S.panelId)))
      .catch(() => {})
      .finally(() => { this.hiding = false; });
  }

  async runById(cx, id) {
    if (this.busy) return;
    const target = currentTarget();
    const { list, error } = await S.loadList();
    const a = (list ?? []).find((x) => x.id === id);
    if (!a) { fail(id, error ?? `No action has the id ${id}.`); return; }
    // The question shows the script, and a field for each {ask:…}.
    const src = await scriptText(a);
    const asks = src.text ? asksOf(src.text) : [];
    if (a.confirm || asks.length) {
      openOverlay({ mod: MOD, kind: "dialog", width: 640, height: 340 + asks.length * 58, props: { confirm: a.id, target } });
      return;
    }
    this.busy = true;
    cx.notify();
    try { await runAction(cx, a, target); } finally { this.busy = false; cx.notify(); }
  }

  statusView(t) {
    return h_flex().id("qa-status").size_full().items_center().justify_center()
      .bg(t.chrome).border_t(1).border_color(t.border)
      .child(div().id("qa-open").size(22).flex().items_center().justify_center().rounded(5).cursor_pointer()
        .text_color(this.busy ? t.working : t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Quick Actions: click to open the list")
        .on_click(() => run("mod.open", { name: MOD }))
        .child(svg(U.icon("actions")).size(13)));
  }

  // ---- the dialog: data -------------------------------------------------------------------

  initDialog(cx) {
    this.list = [];
    this.listError = null;
    this.loadedRev = undefined;
    this.demo = false;
    this.selected = 0;
    this.running = null; // the id of the action that runs from this dialog
    this.confirmDelete = null;
    this.draft = null;
    this.preview = null; // the result of prepare() for the form or the question
    this.previewKey = null;
    // The target terminal now: this dialog runs the actions there.
    this.target = this.props.target ?? currentTarget();
    this.ctx = null;
    this.demoCtx = DEMO_CTX;
    this.loaded = false;
    this.agentList = []; // knownAgents(), for "with an agent" in the form
    knownAgents().then((list) => { this.agentList = list ?? []; cx.notify(); }).catch(() => {});
    this.search = InputState.new({ placeholder: "Search the actions" });
    this.search.on("change", (_e, cx) => { this.selected = 0; cx.notify(); });
    this.view = this.props.confirm ? "confirm" : "list";
    this.refresh(cx);
    if (this.target) context(this.target, new Set(["repo_name"])).then((c) => { this.ctx = c; cx.notify(); }).catch(() => {});
    if (checking()) return;
    cx.timer.every(1000, (cx) => { if (!kitOff()) this.refresh(cx); });
    cx.timer.every(400, (cx) => { if (!kitOff()) this.updatePreview(cx); });
    // `herdr-app do quick-actions.<command>` drives an open dialog (tests): new, edit-<id>, list, save, demo, pin-<id>, up, down, enter.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const a = (id) => this.shownList().find((x) => x.id === id);
        if (c === "new") this.edit(cx, null);
        else if (c.startsWith("edit-") && a(c.slice(5))) this.edit(cx, a(c.slice(5)));
        else if (c === "list") this.back(cx);
        else if (c === "save" && this.view === "edit") this.save(cx);
        else if (c === "demo") { this.demo = !this.demo; this.selected = 0; cx.notify(); }
        else if (c.startsWith("pin-") && a(c.slice(4))) this.pin(cx, a(c.slice(4)));
        else if (c === "down" || c === "up") this.move(cx, c === "down" ? 1 : -1);
        else if (c === "enter") { if (this.view === "list") this.runSelected(cx); else if (this.view === "confirm") this.confirmRun(cx); }
      }
    });
    cx.timer.after(40, () => (this.view === "confirm" ? this.handle.focus() : this.search.focus()));
  }

  shownList() { return this.demo ? DEMO : this.list; }

  refresh(cx) {
    const rev = shared(KEY.rev) ?? null;
    if (rev === this.loadedRev) return;
    this.loadedRev = rev;
    S.loadList().then((d) => {
      this.listError = d.list == null ? d.error : null;
      if (d.list) this.list = d.list;
      this.loaded = true;
      if (this.view === "confirm" && !this.confirmAction) this.confirmAction = this.list.find((x) => x.id === this.props.confirm) ?? null;
      cx.notify();
    });
  }

  async change(cx, fn) {
    if (this.demo) return;
    try {
      this.list = await S.updateList(fn);
      this.loadedRev = shared(KEY.rev);
    } catch (e) {
      notify({ title: "Quick Actions", body: `Cannot save: ${e?.message ?? e}`, level: "error", timeout: 8000 });
      cx.notify();
      return;
    }
    // The bar buttons of the pinned actions (dock/panels.json).
    try {
      await S.syncPanels(this.list);
    } catch (e) {
      notify({ title: "Quick Actions", body: `Cannot change the bar buttons: ${e?.message ?? e}`, level: "error", timeout: 8000 });
    }
    cx.notify();
  }

  /** Pins an action to the bar of the Dock and Kanban layouts, or takes it away. */
  pin(cx, a) {
    this.change(cx, (l) => l.map((x) => (x.id === a.id ? { ...x, pinned: !x.pinned, updatedAt: Date.now() } : x)));
  }

  /** The preview of the form or of the question: prepare() again when the draft changes. */
  updatePreview(cx) {
    const a = this.view === "edit" && this.draft ? this.collect() : this.view === "confirm" ? this.confirmAction : null;
    if (!a) return;
    // A script file can change on disk (an agent writes it): its text is read again every 2 s.
    if (a.source === "file" && Date.now() - (this.fileReadAt ?? 0) > 2000) {
      this.fileReadAt = Date.now();
      const path = a.file;
      scriptText(a).then((s) => {
        const text = s.text ?? null;
        if (path === a.file && text !== this.fileText) { this.fileText = text; cx.notify(); }
      });
    }
    const answers = this.view === "confirm" ? this.answers() : null;
    const key = JSON.stringify([a.source, a.script, a.file, a.filter, a.where, answers, a.source === "file" ? this.fileText : null]);
    if (key === this.previewKey) return;
    this.previewKey = key;
    prepare(a, this.target, answers).then((p) => {
      if (this.previewKey !== key) return;
      this.preview = p;
      if (this.view === "confirm" && !this.askFields && p.asks) this.buildAsks(cx, p.asks);
      cx.notify();
    }).catch(() => {});
  }

  close_() {
    const id = this.props.overlay ?? shared("kanban.panelDialog")?.id ?? null;
    if (id) closeOverlay(id);
  }

  // ---- the dialog: runs -------------------------------------------------------------------

  runSelected(cx) {
    const a = visible(this)[this.selected];
    if (a) this.runNow(cx, a);
  }

  async runNow(cx, a) {
    if (this.running || this.demo || !allowed(this, a)) return;
    const src = await scriptText(a);
    if (a.confirm || (src.text && asksOf(src.text).length)) {
      this.confirmAction = a;
      this.askFields = null;
      this.preview = null;
      this.previewKey = null;
      this.view = "confirm";
      this.handle.focus();
      cx.notify();
      return;
    }
    this.exec(cx, a);
  }

  /** The fields of the {ask:…} questions of the question view, with their defaults. */
  buildAsks(cx, asks) {
    this.askFields = asks.map((q) => {
      const state = InputState.new({ value: q.def, placeholder: q.label });
      state.on("change", (_e, cx) => cx.notify());
      return { ...q, state };
    });
    if (this.askFields.length) cx.timer.after(40, () => this.askFields?.[0]?.state.focus());
    cx.notify();
  }

  /** The answers of the question view: { label: value }, or null without questions. */
  answers() {
    return this.askFields?.length ? Object.fromEntries(this.askFields.map((f) => [f.label, f.state.value()])) : null;
  }

  /** Enter in a field of a question runs; Esc goes back (the field has the keyboard, so the mod gets Esc). */
  askKey(e, cx) {
    if (e.key === "enter") { this.confirmRun(cx); cx.stop_propagation(); }
    else if (e.key === "escape") { if (this.props.confirm) this.close_(); else this.back(cx); cx.stop_propagation(); }
  }

  confirmRun(cx) {
    if (this.confirmAction && this.preview && !this.preview.error) this.exec(cx, this.confirmAction, this.answers());
  }

  async exec(cx, a, answers = null) {
    this.running = a.id;
    cx.notify();
    const address = await runAction(cx, a, this.target, answers);
    this.running = null;
    if (address) {
      this.close_();
      run("pane.focus", { terminal: address });
    }
    cx.notify();
  }

  move(cx, by) {
    const n = visible(this).length;
    if (!n) return;
    this.selected = (this.selected + by + n) % n;
    cx.notify();
  }

  /** A click on a row takes the keyboard from the search field: give it back. */
  keepKeys() { this.search.focus(); }

  searchKey(e, cx) {
    if (e.key === "escape") { this.close_(); cx.stop_propagation(); }
    else if (e.key === "down" || e.key === "up") { this.move(cx, e.key === "down" ? 1 : -1); cx.stop_propagation(); }
    else if (e.key === "enter") { this.runSelected(cx); cx.stop_propagation(); }
  }

  key(e, cx) {
    if (this.view === "confirm" && e.key === "enter") { this.confirmRun(cx); cx.stop_propagation(); return; }
    if (e.key === "escape") {
      if (this.view === "edit") this.back(cx);
      else if (this.view === "confirm" && !this.props.confirm) this.back(cx);
      else this.close_();
      cx.stop_propagation();
    }
  }

  async addExamples(cx) {
    const sync = { ...S.blank(), name: "Sync the repository", icon: "refresh", script: "git pull --ff-only" };
    const update = {
      ...S.blank(),
      id: S.newId("q") + "b",
      name: "Update and install",
      icon: "download",
      confirm: true,
      script: isWin() ? "Set-Location {repo}\ngit pull --ff-only\nif ($?) { npm install }" : "cd {repo}\ngit pull --ff-only && npm install",
    };
    await this.change(cx, (l) => [...l, sync, update]);
  }

  // ---- the dialog: editing ----------------------------------------------------------------

  edit(cx, a) {
    const d = S.normalize(a ? JSON.parse(JSON.stringify(a)) : S.blank());
    this.draft = d;
    this.isNew = !a;
    this.showErrors = false; // errors show after the first Save
    const inp = (value, placeholder) => {
      const s = InputState.new({ value: String(value ?? ""), placeholder });
      s.on("change", (_e, cx) => cx.notify());
      return s;
    };
    this.f = {
      name: inp(d.name, "Example: Sync the repository"),
      file: inp(d.file, isWin() ? "Example: ~/scripts/sync.ps1" : "Example: ~/scripts/sync.sh"),
      filter: inp(d.filter, "Example: D:/MyProjects, herdr-mods"),
    };
    this.script = TextareaState.new({
      value: d.script,
      placeholder: isWin() ? "Example:\ngit pull --ff-only\nif ($?) { npm install }" : "Example:\ngit pull --ff-only && npm install",
      rows: 7,
    });
    this.script.on("change", (_e, cx) => cx.notify());
    this.preview = null;
    this.previewKey = null;
    this.fileText = undefined;
    this.fileReadAt = 0;
    this.writer = null; // the "with an agent" panel of the form
    this.view = "edit";
    cx.timer.after(40, () => this.f.name.focus());
    cx.notify();
  }

  /** The draft with the values of the fields. */
  collect() {
    const d = { ...this.draft };
    d.name = this.f.name.value().trim();
    d.file = this.f.file.value().trim();
    d.filter = this.f.filter.value().trim();
    d.script = this.script.value().replace(/\s+$/, "");
    return d;
  }

  /** A click on a control of the form: the change, then the keyboard to the dialog (Esc works). */
  set(cx, fn) {
    fn(this.draft);
    this.handle.focus();
    cx.notify();
  }

  fieldKey(e, cx) {
    if (e.key === "escape") { this.back(cx); cx.stop_propagation(); }
  }

  async save(cx) {
    if (this.demo) { this.back(cx); return; }
    const d = this.collect();
    if (Object.keys(errors(d)).length) { this.showErrors = true; cx.notify(); return; }
    d.updatedAt = Date.now();
    await this.change(cx, (list) => (list.some((x) => x.id === d.id) ? list.map((x) => (x.id === d.id ? d : x)) : [...list, d]));
    this.back(cx);
  }

  /** Opens the "with an agent" panel of the form. mode: "new" | "edit". */
  openWriter(cx, mode) {
    const desc = TextareaState.new({
      value: "",
      placeholder: mode === "edit" ? "Example: also run the tests after the install" : "Example: pull the branch, then install the npm packages and the plugins of the repository",
      rows: 4,
    });
    desc.on("change", (_e, cx) => cx.notify());
    const installed = this.agentList.filter((x) => x.installed);
    const last = shared(KEY.agent);
    this.writer = { mode, desc, agent: installed.some((x) => x.key === last) ? last : installed[0]?.key ?? null, error: "" };
    cx.timer.after(40, () => desc.focus());
    cx.notify();
  }

  /** Saves the action with its script file, starts the agent that writes the file, and closes the dialog. */
  async runWriter(cx) {
    const w = this.writer;
    if (!w || this.demo) return;
    const d = this.collect();
    const what = w.desc.value().trim();
    const agent = this.agentList.find((x) => x.key === w.agent && x.installed);
    w.error = !d.name ? "Write a name for the action first." : !what ? "Write what the script must do." : !agent ? "Choose an agent." : "";
    if (w.error) { cx.notify(); return; }
    const path = writerPath(d);
    d.source = "file";
    d.file = shortPath(path);
    d.updatedAt = Date.now();
    await this.change(cx, (list) => (list.some((x) => x.id === d.id) ? list.map((x) => (x.id === d.id ? d : x)) : [...list, d]));
    await startWriter({ mode: w.mode, path, what, agent, space: this.target?.space ?? null, name: d.name });
    this.close_();
  }

  /** Back to the list, without saving. */
  back(cx) {
    this.view = "list";
    this.draft = null;
    this.confirmAction = null;
    this.askFields = null;
    this.fileText = undefined;
    this.preview = null;
    this.previewKey = null;
    cx.timer.after(40, () => this.search.focus());
    cx.notify();
  }

  // ---- views -------------------------------------------------------------------------------

  render() {
    if (kitOff()) return offView();
    const t = theme();
    if (this.part === "status") return this.statusView(t);
    let body;
    if (this.view === "edit" && this.draft) body = editView(this, t);
    else if (this.view === "confirm") body = confirmView(this, t);
    else {
      const notice = this.listError ?? (!this.demo && !runnerAlive()
        ? "The Quick Actions item is not in the status bar of this layout. Keys and bar buttons run actions only with it." : null);
      body = listView(this, t, notice);
    }
    return v_flex().id("quick-actions").size_full().min_h(0).bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(body);
  }
}
