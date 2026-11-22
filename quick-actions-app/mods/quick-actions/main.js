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
import { theme, props, shared, setShared, closeOverlay, openOverlay, nextCommand, run, notify, focused, checking, window } from "herdr";
import * as S from "./store.js";
import { currentTarget, context } from "./vars.js";
import { runAction, prepare, fail } from "./run.js";
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
    if (checking()) return;
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
  }

  async runById(cx, id) {
    if (this.busy) return;
    const target = currentTarget();
    const { list, error } = await S.loadList();
    const a = (list ?? []).find((x) => x.id === id);
    if (!a) { fail(id, error ?? `No action has the id ${id}.`); return; }
    if (a.confirm) {
      openOverlay({ mod: MOD, kind: "dialog", width: 640, height: 340, props: { confirm: a.id, target } });
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
    this.search = InputState.new({ placeholder: "Search the actions" });
    this.search.on("change", (_e, cx) => { this.selected = 0; cx.notify(); });
    this.view = this.props.confirm ? "confirm" : "list";
    this.refresh(cx);
    if (this.target) context(this.target, new Set(["repo_name"])).then((c) => { this.ctx = c; cx.notify(); }).catch(() => {});
    if (checking()) return;
    cx.timer.every(1000, (cx) => { if (!kitOff()) this.refresh(cx); });
    cx.timer.every(400, (cx) => { if (!kitOff()) this.updatePreview(cx); });
    // `herdr-app do quick-actions.<command>` drives an open dialog (tests).
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const a = (id) => this.shownList().find((x) => x.id === id);
        if (c === "new") this.edit(cx, null);
        else if (c.startsWith("edit-") && a(c.slice(5))) this.edit(cx, a(c.slice(5)));
        else if (c === "list") this.back(cx);
        else if (c === "save" && this.view === "edit") this.save(cx);
        else if (c === "demo") { this.demo = !this.demo; this.selected = 0; cx.notify(); }
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
    }
    cx.notify();
  }

  /** The preview of the form or of the question: prepare() again when the draft changes. */
  updatePreview(cx) {
    const a = this.view === "edit" && this.draft ? this.collect() : this.view === "confirm" ? this.confirmAction : null;
    if (!a) return;
    const key = JSON.stringify([a.source, a.script, a.file, a.filter, a.where]);
    if (key === this.previewKey) return;
    this.previewKey = key;
    prepare(a, this.target).then((p) => { if (this.previewKey === key) { this.preview = p; cx.notify(); } }).catch(() => {});
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

  runNow(cx, a) {
    if (this.running || this.demo || !allowed(this, a)) return;
    if (a.confirm) {
      this.confirmAction = a;
      this.preview = null;
      this.previewKey = null;
      this.view = "confirm";
      this.handle.focus();
      cx.notify();
      return;
    }
    this.exec(cx, a);
  }

  confirmRun(cx) {
    if (this.confirmAction && this.preview && !this.preview.error) this.exec(cx, this.confirmAction);
  }

  async exec(cx, a) {
    this.running = a.id;
    cx.notify();
    const address = await runAction(cx, a, this.target);
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

  /** Back to the list, without saving. */
  back(cx) {
    this.view = "list";
    this.draft = null;
    this.confirmAction = null;
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
