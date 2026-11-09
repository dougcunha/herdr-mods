// Automations: run a coding agent with a prompt in a folder when a trigger fires (a schedule,
// a button, an agent status, a file change, a git change). A check script can skip the run; a
// pre-script and a post-script run before and after the agent.
//
// Roles (props.part):
//   "status"  the status bar item. It is also the runner: 1 status copy holds the lease
//             shared("automations.leader") and runs the automations (engine.js).
//   (none)    the dialog (mod.open:automations, a click on the status item) or a Dock panel.
//
// See docs/automations-plan.md in the herdr-mods repository.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, TextareaState } from "gpui-base";
import { theme, props, shared, setShared, closeOverlay, nextCommand, run, knownAgents, pickFolder, notify, agents } from "herdr";
import * as S from "./store.js";
import { Engine } from "./engine.js";
import { nextDue, whenText } from "./schedule.js";
import { editView as formView, errors as formErrors, TABS } from "./form.js";
import { listView as listPage } from "./list.js";
import * as U from "./ui.js";

const { KEY, MOD } = S;
const BEAT_MS = 2000; // the timer of the status copies
const LEASE_MS = 15000; // the runner renews its lease this often
const STALE_MS = 45000; // a lease older than this is free

// The mods-hub can turn this mod off (shared "herdr-mods.disabled", a list of mod names). Then the mod draws
// nothing, closes its dialog and skips its timed work. The bars hide its blocks and buttons.
const kitOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes("automations"); };
const offView = () => { const o = props()?.overlay; if (o) closeOverlay(o); return div(); };

// A save of the mod reloads every copy, and the old copies stop at once. A lease of an older
// build is free, so the new runner does not wait STALE_MS.
const BUILD = S.newId("b");

const dialogId = () => props()?.overlay ?? shared("kanban.panelDialog")?.id ?? null;
const leaseAlive = () => { const l = shared(KEY.leader); return !!l && Date.now() - (l.at ?? 0) < STALE_MS; };
const leaseFree = (l, now) => !l || now - (l.at ?? 0) > STALE_MS || l.build !== BUILD;

export default class Automations extends View {
  init(given, cx) {
    // Read props once: props() in a later callback can answer for another copy.
    this.props = (given && Object.keys(given).length ? given : props()) || {};
    this.part = this.props.part === "status" ? "status" : "dialog";
    this.copy = S.newId("c");
    this.engine = null;
    this.handle = cx.focus_handle();

    if (this.part === "status") {
      cx.timer.every(BEAT_MS, (cx) => { if (!kitOff()) this.beat(cx); });
      cx.spawn(async () => {
        for (;;) {
          const c = await nextCommand();
          // Commands reach every shown copy, and 1 layout shows 1 status copy: it acts. The
          // runner (maybe this copy) takes the request on its next beat.
          if (c === "open") run("mod.open", { name: MOD });
          if (c.startsWith("run-")) this.requestRun(c.slice(4));
        }
      });
      return;
    }

    // The dialog.
    this.view = "list"; // "list" | "edit" | "history"
    this.defs = [];
    this.defsError = null;
    this.index = {};
    this.agentList = [];
    this.confirmDelete = null;
    this.openRun = null; // { id, files }
    this.historyOf = null;
    this.draft = null;
    this.formError = "";
    this.loadedRev = undefined;
    this.loadedRunsRev = undefined;
    knownAgents().then((list) => { this.agentList = list ?? []; cx.notify(); }).catch(() => {});
    const focus = shared(KEY.focus);
    if (focus?.automation) {
      setShared(KEY.focus, null);
      this.historyOf = focus.automation;
      this.view = "history";
      if (focus.run) this.toggleRun(cx, focus.run);
    }
    cx.timer.every(1000, (cx) => { if (!kitOff()) this.refresh(cx); });
    this.refresh(cx);
    // `herdr-app do automations.new | edit-<id> | history-<id>` shows a view of an open dialog.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const a = (id) => this.defs.find((x) => x.id === id);
        if (c === "new") this.edit(cx, null);
        else if (c.startsWith("edit-") && a(c.slice(5))) this.edit(cx, a(c.slice(5)));
        else if (c.startsWith("history-")) { this.historyOf = c.slice(8); this.openRun = null; this.view = "history"; cx.notify(); }
        else if (c.startsWith("detail-")) this.toggleRun(cx, c.slice(7));
        else if (c === "list") { this.view = "list"; this.draft = null; cx.notify(); }
        else if (c === "save" && this.view === "edit") this.save(cx);
        else if (c.startsWith("tab-") && this.view === "edit") { this.tab = c.slice(4); cx.notify(); }
      }
    });
    cx.timer.after(40, () => this.handle.focus());
  }

  /** Called when this copy goes away (a reload, another layout): free the lease at once. */
  async close() {
    if (this.engine && shared(KEY.leader)?.copy === this.copy) setShared(KEY.leader, null);
    if (this.engine) this.engine.ready = false;
  }

  // ---- the runner (status copies) -----------------------------------------------------------

  async beat(cx) {
    if (this.beating) return;
    this.beating = true;
    try {
      const l = shared(KEY.leader);
      const now = Date.now();
      if (!this.engine) {
        if (this.claimed) {
          // The second beat after the claim: still ours, so no other copy claimed at the same time.
          this.claimed = false;
          if (l?.copy !== this.copy) return;
          this.engine = new Engine(this.copy);
          this.leaseAt = now;
          setShared(KEY.leader, { copy: this.copy, build: BUILD, at: now });
          await this.engine.boot(cx, this.since);
          cx.notify();
          return;
        }
        if (leaseFree(l, now)) {
          this.since = l?.at ?? null;
          this.claimed = true;
          setShared(KEY.leader, { copy: this.copy, build: BUILD, at: now });
        }
        return;
      }
      if (l && l.copy !== this.copy) {
        // Another copy took the lease (this one was too slow): stop.
        this.engine.ready = false;
        this.engine = null;
        cx.notify();
        return;
      }
      if (now - this.leaseAt >= LEASE_MS) {
        this.leaseAt = now;
        setShared(KEY.leader, { copy: this.copy, build: BUILD, at: now });
      }
      await this.engine.tick(cx);
    } catch (e) {
      console.log(`automations: ${e?.message ?? e}`);
    } finally {
      this.beating = false;
    }
  }

  requestRun(id) {
    setShared(KEY.requests, [...S.getShared(KEY.requests, []), { id, at: Date.now() }]);
  }

  // ---- the dialog: data -------------------------------------------------------------------

  refresh(cx) {
    const rev = shared(KEY.rev) ?? null;
    const runsRev = shared(KEY.runsRev) ?? null;
    if (rev !== this.loadedRev) {
      this.loadedRev = rev;
      S.loadDefs().then((d) => {
        this.defsError = d.list == null ? d.error : null;
        if (d.list) this.defs = d.list;
        cx.notify();
      });
    }
    if (runsRev !== this.loadedRunsRev) {
      this.loadedRunsRev = runsRev;
      S.loadRuns().then((r) => { this.index = r.index; cx.notify(); });
    }
  }

  async change(cx, fn) {
    try {
      this.defs = await S.updateDefs(fn);
      this.loadedRev = shared(KEY.rev);
    } catch (e) {
      notify({ title: "Automations", body: `Cannot save: ${e?.message ?? e}`, level: "error", timeout: 8000 });
    }
    cx.notify();
  }

  runNow(cx, a) {
    if (!leaseAlive()) {
      notify({ title: "Automations", body: "No runner. Add the Automations status bar item to the layout.", level: "warning", timeout: 8000 });
      return;
    }
    this.requestRun(a.id);
    notify({ title: `Automation: ${a.name}`, body: "Started.", level: "info", timeout: 3000 });
  }

  close_() {
    const id = dialogId();
    if (id) closeOverlay(id);
  }

  key(e, cx) {
    if (e.key !== "escape") return;
    if (this.view !== "list") { this.view = "list"; this.openRun = null; this.draft = null; cx.notify(); }
    else this.close_();
    cx.stop_propagation();
  }

  // ---- the dialog: editing ----------------------------------------------------------------

  edit(cx, a) {
    const d = S.normalize(a ? JSON.parse(JSON.stringify(a)) : { ...S.blank(), agent: this.agentList.find((x) => x.installed)?.key ?? "claude" });
    this.draft = d;
    this.isNew = !a;
    this.tab = "general";
    this.showErrors = false; // errors show after the first Save
    const inp = (value, placeholder = "") => {
      const s = InputState.new({ value: String(value ?? ""), placeholder });
      s.on("change", (_e, cx) => cx.notify());
      return s;
    };
    const sc = d.trigger.schedule;
    this.f = {
      name: inp(d.name, "Example: Nightly review"),
      folder: inp(d.folder, "Example: D:/repos/my-project"),
      args: inp(d.args, "Example: --model sonnet"),
      command: inp(d.command, "Empty: the built-in command"),
      timeout: inp(d.timeout, "60"),
      minutes: inp(sc.minutes, "60"),
      time: inp(sc.time, "09:00"),
      cron: inp(sc.cron, "0 9 * * 1-5"),
      glob: inp(d.trigger.files.glob, "Example: src/**/*.ts, *.md"),
      app: inp(d.trigger.agent.app, "Example: claude"),
      checkT: inp(d.check.timeout, "60"),
      preT: inp(d.pre.timeout, "60"),
      postT: inp(d.post.timeout, "60"),
    };
    // Each script has 2 fields: the path of a file and the inline text. Its kind picks one.
    const EXAMPLES = {
      check: ["scripts/check.ps1", "git diff --quiet HEAD@{1} HEAD"],
      pre: ["scripts/context.ps1", "git log -5 --oneline"],
      post: ["scripts/publish.ps1", "Copy-Item $env:HERDR_AUTO_RESULT_FILE docs/review.md"],
    };
    this.scriptFields = {};
    for (const k of ["check", "pre", "post"]) {
      const s = d[k];
      const [file, inline] = EXAMPLES[k];
      const area = TextareaState.new({ value: s.kind === "inline" ? s.cmd : "", placeholder: `Example:\n${inline}`, rows: 5 });
      area.on("change", (_e, cx) => cx.notify());
      this.scriptFields[k] = { file: inp(s.kind === "file" ? s.cmd : "", `Example: ${file}`), inline: area };
    }
    this.prompt = TextareaState.new({ value: d.prompt, placeholder: "Example: Review the last commit. Write the review as Markdown to {result_file}.", rows: 14 });
    this.prompt.on("change", (_e, cx) => cx.notify());
    this.view = "edit";
    cx.notify();
  }

  /** The draft with the values of the fields. */
  collect() {
    const d = JSON.parse(JSON.stringify(this.draft));
    const v = (k) => this.f[k].value().trim();
    const num = (k, def) => { const n = Number(v(k)); return Number.isFinite(n) && n > 0 ? n : def; };
    d.name = v("name");
    d.folder = v("folder").replace(/\\/g, "/");
    d.args = v("args");
    d.command = v("command");
    d.timeout = num("timeout", 60);
    d.prompt = this.prompt.value();
    d.trigger.schedule.minutes = num("minutes", 60);
    d.trigger.schedule.time = v("time");
    d.trigger.schedule.cron = v("cron");
    d.trigger.files.glob = v("glob");
    d.trigger.agent.app = v("app");
    for (const k of ["check", "pre", "post"]) {
      const kind = this.draft[k].kind;
      const sf = this.scriptFields[k];
      const cmd = kind === "file" ? sf.file.value().trim() : kind === "inline" ? sf.inline.value().replace(/\s+$/, "") : "";
      d[k] = { kind: cmd.trim() ? kind : "none", cmd: cmd.trim() ? cmd : "", timeout: Math.min(600, num(`${k}T`, 60)) };
    }
    return d;
  }

  async save(cx) {
    const d = this.collect();
    const errs = formErrors(d);
    if (Object.keys(errs).length) {
      // Show the errors, and go to the first tab that has one.
      this.showErrors = true;
      if (!errs[this.tab]) this.tab = TABS.find((x) => errs[x.key])?.key ?? this.tab;
      cx.notify();
      return;
    }
    d.updatedAt = Date.now();
    await this.change(cx, (list) => (list.some((x) => x.id === d.id) ? list.map((x) => (x.id === d.id ? d : x)) : [...list, d]));
    this.view = "list";
    this.draft = null;
    cx.notify();
  }

  set(cx, fn) { fn(this.draft); cx.notify(); }

  /** Leaves the form without saving. */
  back(cx) { this.view = "list"; this.draft = null; cx.notify(); }

  pick(cx) {
    pickFolder({ prompt: "Use folder" }).then((p) => { if (p) { this.f.folder.set_value(p.replace(/\\/g, "/")); cx.notify(); } });
  }

  // ---- the dialog: history ----------------------------------------------------------------

  toggleRun(cx, runId) {
    if (this.openRun?.id === runId) { this.openRun = null; cx.notify(); return; }
    this.openRun = { id: runId, files: null };
    cx.notify();
    Promise.all(["check.out", "pre.out", "post.out", "result.md", "tail.txt"].map((n) => S.runFile(runId, n))).then(([check, pre, post, result, tail]) => {
      if (this.openRun?.id === runId) { this.openRun.files = { check, pre, post, result, tail }; cx.notify(); }
    });
  }

  // ---- views -------------------------------------------------------------------------------

  render() {
    if (kitOff()) return offView();
    const t = theme();
    if (this.part === "status") return this.statusView(t);
    let body;
    if (this.view === "edit" && this.draft) body = this.editView(t);
    else if (this.view === "history") body = this.historyView(t);
    else body = this.listView(t);
    return v_flex().id("automations").size_full().min_h(0).bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle)
      .on_mouse_down("left", () => { if (dialogId()) this.handle.focus(); })
      .on_key_down((e, cx) => this.key(e, cx))
      .child(body);
  }

  statusView(t) {
    const running = S.getShared(KEY.running, []);
    const leader = shared(KEY.leader);
    const runner = !!this.engine;
    let text = "automations";
    let color = t.dim;
    let tip = runner ? "Automations: this copy runs them. Click to open." : leaseAlive() ? "Automations. Click to open." : "Automations: no runner yet.";
    if (running.length) { text = `${running.length} running`; color = t.working; }
    else if (runner && this.engine.defs.length) {
      const next = this.engine.defs.filter((a) => a.enabled && a.trigger.type === "schedule")
        .map((a) => nextDue(a.trigger.schedule, Date.now(), this.engine.state(a.id).lastFired ?? a.updatedAt)).filter((x) => x != null).sort((x, y) => x - y)[0];
      if (next != null) tip = `Next scheduled run: ${whenText(next)}`;
    }
    void leader;
    return h_flex().id("automations-status").size_full().pr(10).items_center().justify_end()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8)
      .child(h_flex().id("au-open").h(20).px(6).gap(6).items_center().rounded(5).cursor_pointer()
        .text_color(color)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(tip)
        .on_click(() => run("mod.open", { name: MOD }))
        .child(running.length ? svg(U.icon("spinner")).size(12).spin(900) : svg(U.icon("zap")).size(12))
        .child(text));
  }

  header(t, title, left = null, right = []) {
    return h_flex().w_full().h(52).px(16).gap(10).items_center().flex_none().border_b(1).border_color(t.border)
      .when(Boolean(left), (e) => e.child(left))
      .child(div().flex_1().min_w(0).text_size(15).font_semibold().truncate().child(title))
      .children(right);
  }

  listView(t) {
    const notice = this.defsError ?? (!leaseAlive() ? "No runner: add the Automations status bar item to this layout. Without it, nothing runs." : null);
    return listPage(this, t, notice);
  }

  showHistory(cx, id) { this.historyOf = id; this.openRun = null; this.view = "history"; cx.notify(); }

  editView(t) {
    return formView(this, t);
  }

  historyView(t) {
    const a = this.defs.find((x) => x.id === this.historyOf);
    const runs = this.index[this.historyOf] ?? [];
    const back = U.iconButton(t, "au-hback", "back", "Back (Esc)", (cx) => { this.view = "list"; this.openRun = null; cx.notify(); });
    const right = a ? [U.button(t, "au-hrun", "Run now", (cx) => this.runNow(cx, a), { iconName: "play" })] : [];
    const live = new Set(agents().map((x) => x.address));
    const rows = runs.map((r, i) => {
      const open = this.openRun?.id === r.id;
      const files = open ? this.openRun.files : null;
      const head = h_flex().id(`au-run-row-${i}`).w_full().gap(10).items_center().cursor_pointer()
        .on_click((_e, cx) => this.toggleRun(cx, r.id))
        .child(U.pill(t, r.status))
        .child(div().flex_none().text_size(12).text_color(t.foreground).child(whenText(r.start)))
        .child(div().flex_none().text_size(11.5).text_color(t.dim).child(U.duration((r.end ?? Date.now()) - r.start)))
        .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.dim).truncate().child(r.trigger ?? ""));
      let detail = null;
      if (open) {
        detail = v_flex().gap(10).pt(10)
          .when(Boolean(r.reason), (e) => e.child(div().text_size(12).text_color(t.foreground).child(r.reason)))
          .when(Boolean(r.address && live.has(r.address)), (e) => e.child(h_flex().child(U.button(t, `au-term-${i}`, "Show the agent", () => run("agent.focus", { terminal: r.address }), { iconName: "terminal" }))))
          .child(files == null ? div().text_size(11.5).text_color(t.dim).child("Reading…") : v_flex().gap(10)
            .when(Boolean(files.check), (e) => e.child(U.outputBlock(t, `au-o-c-${i}`, `Check (exit ${r.check?.code ?? "?"})`, files.check, 120)))
            .when(Boolean(files.pre), (e) => e.child(U.outputBlock(t, `au-o-p-${i}`, `Pre-script (exit ${r.pre?.code ?? "?"})`, files.pre, 120)))
            .when(Boolean(files.result), (e) => e.child(U.outputBlock(t, `au-o-r-${i}`, "Result (result.md)", files.result, 200)))
            .when(Boolean(files.tail), (e) => e.child(U.outputBlock(t, `au-o-t-${i}`, "Agent (last lines)", files.tail, 260)))
            .when(Boolean(files.post), (e) => e.child(U.outputBlock(t, `au-o-q-${i}`, `Post-script (exit ${r.post?.code ?? "?"})`, files.post, 120))));
      }
      return v_flex().id(`au-run-${i}`).w_full().px(12).py(9).rounded(8).border_1().border_color(open ? t.input : t.border).bg(t.surface)
        .child(head).when(Boolean(detail), (e) => e.child(detail));
    });
    return v_flex().size_full().min_h(0)
      .child(this.header(t, `History: ${a?.name ?? "(deleted)"}`, back, right))
      .child(runs.length
        ? v_flex().id("au-hist").flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(6).children(rows)
        : v_flex().flex_1().items_center().justify_center().text_size(12.5).text_color(t.dim).child("No runs yet."));
  }
}
