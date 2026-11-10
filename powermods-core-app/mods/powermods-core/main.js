// PowerMods Core: shared services for the mods of the herdr-mods kit. The first service manages git
// worktrees: 1 root folder for every worktree, and 1 setup (files to copy, commands to run) for each new one.
// See DESIGN.md in the herdr-mods repository.
//
// Roles (props.part):
//   "status"  the status bar item. It keeps the core loaded, puts the API on globalThis and runs the queue.
//   "trust"   the dialog that asks before the commands of a repository's .herdr/worktree.json run.
//   (none)    the dialog (mod.open:powermods-core, a click on the status item): the last worktrees and the
//             setup commands of the Settings.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { theme, props, shared, setShared, closeOverlay, run, nextCommand } from "herdr";
import { register } from "./api.js";
import { STATE, pump, leave, jobs, clearJobs } from "./worktree.js";
import { KEY, rootSetting, filesSetting, globalCommands } from "./paths.js";

const MOD = "powermods-core";
const ICON = "mods/powermods-core/worktree.svg";
const RUNNING = new Set(["git", "copy", "trust", "setup"]);
const STATE_TEXT = { git: "git worktree add", copy: "copying files", trust: "waiting for your answer", setup: "setup running", done: "done", failed: "failed" };
const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };

// Example jobs for `powermods-core.demo` (screenshots): no real folder or name.
const demoJobs = () => {
  const now = Date.now(), home = "~/.herdr/worktrees/notes-app";
  return [
    { id: "d1", kind: "create", state: "setup", branch: "feat/search-notes", repo: "notes-app", path: `${home}/feat-search-notes`, copied: 3, at: now - 40000 },
    { id: "d2", kind: "create", state: "done", branch: "agent/NOTES-42-export-pdf", repo: "notes-app", path: `${home}/agent-NOTES-42-export-pdf`, copied: 2, at: now - 26 * 60000,
      log: "[1/3] npx skills add acme/agent-skills --yes\nInstalled 4 skills.\n\n[2/3] npm ci\nadded 812 packages in 21s\n\n[3/3] npm run db:seed\nSeeded 120 notes.\n\nSetup done." },
    { id: "d3", kind: "create", state: "failed", branch: "fix/sync-conflict", repo: "notes-app", path: `${home}/fix-sync-conflict`, copied: 2, at: now - 3 * 3600000, error: "A setup command failed (exit code 1)." },
    { id: "d4", kind: "remove", state: "done", branch: "feat/tags", repo: "notes-app", path: `${home}/feat-tags`, at: now - 26 * 3600000 },
  ];
};

export default class PowerModsCore extends View {
  init(given, cx) {
    // Read props once: props() in a later callback can answer for another copy.
    this.props = (given && Object.keys(given).length ? given : props()) || {};
    this.part = ["status", "trust"].includes(this.props.part) ? this.props.part : "dialog";
    register();
    this.handle = cx.focus_handle();

    if (this.part === "status") {
      this.copy = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      pump(cx, this.copy);
      cx.timer.every(500, (cx) => pump(cx, this.copy));
      // `herdr-app do powermods-core.open` opens the dialog (for tests from the shell).
      cx.spawn(async () => { for (;;) { const c = await nextCommand(); if (c === "open") run("mod.open", { name: MOD }); } });
      return;
    }
    if (this.part === "trust") {
      this.job = STATE.jobs.get(this.props.job) ?? null;
      cx.timer.after(40, () => this.handle.focus());
      // Answered in another way, or the job is gone: the question closes.
      cx.timer.every(500, () => { if (!this.job || this.job.trust !== undefined || !STATE.jobs.has(this.job.id)) this.closeDialog(); });
      return;
    }
    this.tab = "worktrees";
    this.open = null;
    this.commands = TextareaState.new({ value: globalCommands().join("\n"), rows: 8, placeholder: "npx skills add owner/repo --yes\nnpm install" });
    this.commands.on("change", (_e, cx) => { this.dirty = true; cx.notify(); });
    this.dirty = false;
    this.demo = false;
    // `herdr-app do powermods-core.demo` shows example worktrees (run it again for yours); `.setup` and
    // `.worktrees` show a tab.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "demo") { this.demo = !this.demo; this.open = this.demo ? "d2" : null; }
        else if (c === "setup" || c === "worktrees") this.tab = c;
        cx.notify();
      }
    });
    cx.timer.every(1000, (cx) => cx.notify());
    cx.timer.after(40, () => this.handle.focus());
  }

  /** A trust dialog closed without an answer (Esc, a click beside it): the commands do not run. */
  async close() {
    if (this.part === "trust" && this.job && this.job.trust === undefined) this.job.trust = false;
    if (this.part === "status") leave(this.copy);
  }

  closeDialog() { const o = this.props.overlay ?? props()?.overlay; if (o) closeOverlay(o); }

  answer(yes) {
    if (this.job) this.job.trust = yes;
    this.closeDialog();
  }

  saveCommands(cx) {
    const lines = this.commands.value().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    setShared(KEY.run, lines.length ? lines : null);
    this.dirty = false;
    cx.notify();
  }

  render() {
    const t = theme();
    if (this.part === "status") return this.statusView(t);
    if (this.part === "trust") return this.trustView(t);
    return this.dialogView(t);
  }

  // ---- views ----------------------------------------------------------------------------------------

  statusView(t) {
    const running = jobs().filter((j) => RUNNING.has(j.state));
    const failed = jobs().find((j) => j.state === "failed" && Date.now() - (j.ended ?? j.at) < 10 * 60000);
    const color = running.length ? t.working : failed ? t.blocked : t.dim;
    const label = running.length ? `${running.length} setup${running.length > 1 ? "s" : ""}` : "worktrees";
    const tip = running.length ? `PowerMods Core: ${running.map((j) => `${j.branch ?? "?"} (${STATE_TEXT[j.state]})`).join(", ")}. Click to open.`
      : failed ? `PowerMods Core: the setup of ${failed.branch ?? "a worktree"} failed. Click to open.`
      : "PowerMods Core: the worktrees of the kit. Click to open.";
    return h_flex().id("pmc-status").size_full().pr(8).items_center().justify_end()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8)
      .child(h_flex().id("pmc-open").h(20).px(6).gap(5).items_center().rounded(5).cursor_pointer()
        .text_color(color)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(tip)
        .on_click(() => run("mod.open", { name: MOD }))
        .child(svg(ICON).size(12))
        .child(div().child(label)));
  }

  trustView(t) {
    const info = this.job?.trustInfo;
    const keys = (e, cx) => { if (e.key === "escape") { this.answer(false); cx.stop_propagation(); } if (e.key === "enter") { this.answer(true); cx.stop_propagation(); } };
    const root = v_flex().id("pmc-trust").size_full().bg(t.popover).text_color(t.foreground).text_size(12.5)
      .track_focus(this.handle).on_key_down(keys);
    if (!info) {
      return root.p(16).gap(10).child(div().child("This question is no longer open."))
        .child(h_flex().child(this.button(t, "pmc-close", "Close", () => this.closeDialog())));
    }
    return root
      .child(v_flex().flex_none().gap(3).px(16).pt(14).pb(12).border_b_1().border_color(t.border)
        .child(div().font_semibold().text_size(14).child("Run the setup commands of this repository?"))
        .child(div().text_size(11.5).text_color(t.muted).child(`${info.repo}${info.on ? ` on ${info.on}` : ""} · .herdr/worktree.json`)))
      .child(v_flex().id("pmc-trust-body").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).gap(10)
        .child(div().text_color(t.muted).child("These commands come from the repository, so another person can have written them. They run in the new worktree with your account. Read them before you say yes."))
        .child(v_flex().gap(4).p(10).rounded(6).bg(t.surface).border_1().border_color(t.border).font_family("Menlo").text_size(11.5)
          .children(info.commands.map((c, i) => div().id(`pmc-cmd-${i}`).child(`$ ${c}`))))
        .child(div().text_size(11.5).text_color(t.dim).child("Yes: the core keeps your answer until this file changes. No: the worktree opens without these commands.")))
      .child(h_flex().flex_none().px(16).py(10).gap(8).items_center().border_t_1().border_color(t.border).bg(t.surface)
        .child(div().flex_1().text_size(11.5).text_color(t.dim).child("Enter runs · Esc skips"))
        .child(this.button(t, "pmc-no", "Skip them", () => this.answer(false)))
        .child(this.button(t, "pmc-yes", "Run them", () => this.answer(true), true)));
  }

  dialogView(t) {
    const tabs = [["worktrees", "Worktrees"], ["setup", "Setup"]];
    return v_flex().id("pmc-dialog").size_full().bg(t.popover).text_color(t.foreground).text_size(12.5)
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.closeDialog(); cx.stop_propagation(); } })
      .child(h_flex().flex_none().gap(10).px(16).pt(14).pb(10).items_center().border_b_1().border_color(t.border)
        .child(div().text_color(t.accent).child(svg(ICON).size(16)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().font_semibold().text_size(14).child("PowerMods Core"))
          .child(div().text_size(11.5).text_color(t.muted).child("The worktrees that the kit makes, and their setup.")))
        .child(h_flex().gap(4).children(tabs.map(([id, label]) => div().id(`pmc-tab-${id}`).px(10).py(4).rounded(6).cursor_pointer()
          .text_color(this.tab === id ? t.foreground : t.muted).when(this.tab === id, (e) => e.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.tab = id; cx.notify(); })
          .child(label)))))
      .child(this.tab === "setup" ? this.setupView(t) : this.worktreesView(t));
  }

  worktreesView(t) {
    const list = this.demo ? demoJobs() : jobs();
    const color = (s) => (RUNNING.has(s) ? t.working : s === "failed" ? t.blocked : t.done);
    return v_flex().id("pmc-jobs").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).gap(8)
      .when(!list.length, (e) => e.child(div().text_color(t.dim).child("No worktree yet. Issues, PRs, Spec Board and the Git panel make worktrees through the core.")))
      .children(list.map((j) => {
        const open = this.open === j.id;
        return v_flex().id(`pmc-job-${j.id}`).gap(6).p(10).rounded(8).border_1().border_color(open ? t.accent : t.border)
          .child(h_flex().id(`pmc-job-head-${j.id}`).gap(8).items_center().cursor_pointer()
            .on_click((_e, cx) => { this.open = open ? null : j.id; cx.notify(); })
            .child(div().size(8).flex_none().rounded(4).bg(color(j.state)))
            .child(div().flex_none().font_semibold().child(`${j.kind === "remove" ? "Remove · " : ""}${j.branch ?? j.path ?? "?"}`))
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(j.repo ?? ""))
            .child(div().flex_none().text_size(11.5).text_color(color(j.state)).child(STATE_TEXT[j.state] ?? j.state))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(j.at))))
          .when(Boolean(j.path), (e) => e.child(div().text_size(11.5).text_color(t.muted).truncate().child(`${j.path}${j.on ? ` · on ${j.on}` : ""}${j.copied ? ` · ${j.copied} file${j.copied > 1 ? "s" : ""} copied` : ""}`)))
          .when(Boolean(j.error), (e) => e.child(div().text_size(11.5).text_color(t.blocked).child(j.error)))
          .when(open && Boolean(j.log), (e) => e.child(div().id(`pmc-log-${j.id}`).max_h(240).overflow_y_scrollbar().p(8).rounded(6).bg(t.background)
            .font_family("Menlo").text_size(11).text_color(t.muted).child(j.log)))
          .when(open && Boolean(j.spaceId) && j.kind !== "remove", (e) => e.child(h_flex().child(this.button(t, `pmc-space-${j.id}`, "Show the space", () => run("space.select", { id: j.spaceId })))));
      }))
      .when(list.length > 0 && !this.demo, (e) => e.child(h_flex().pt(4).child(this.button(t, "pmc-clear", "Clear the finished ones", (cx) => { clearJobs(); cx.notify(); }))));
  }

  setupView(t) {
    return v_flex().id("pmc-setup").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).gap(12)
      .child(v_flex().gap(4)
        .child(div().font_semibold().child("Folders"))
        .child(div().text_size(11.5).text_color(t.muted).child(`Worktrees: ${this.demo ? "~/.herdr/worktrees" : rootSetting()}/<repository>/<branch>`))
        .child(div().text_size(11.5).text_color(t.muted).child(`Files for every worktree (this computer): ${this.demo ? "~/.herdr/worktree-files" : filesSetting()}`))
        .child(div().text_size(11.5).text_color(t.dim).child("Change them in the Settings tab of PowerMods (section powermods-core).")))
      .child(v_flex().gap(4)
        .child(div().font_semibold().child("Commands for every new worktree"))
        .child(div().text_size(11.5).text_color(t.dim).child("1 command for each line. They run in a \"setup\" tab of the new space (PowerShell on Windows, sh elsewhere), before the commands of the repository's .herdr/worktree.json. A line that starts with # is a comment."))
        .child(div().h(170).px(8).py(5).rounded(6).border_1().border_color(t.input).bg(t.background).font_family("Menlo").text_size(11.5).child(Textarea.new(this.commands)))
        .child(h_flex().gap(8).items_center()
          .child(this.button(t, "pmc-save", this.dirty ? "Save" : "Saved", (cx) => this.saveCommands(cx), this.dirty))
          .when(this.dirty, (e) => e.child(div().text_size(11.5).text_color(t.ansi3).child("Not saved")))))
      .child(v_flex().gap(4)
        .child(div().font_semibold().child("The setup of a repository"))
        .child(div().text_size(11.5).text_color(t.muted).font_family("Menlo").child('.herdr/worktree.json: { "copy": [".env"], "run": ["npm install"], "runWindows": ["npm install"] }'))
        .child(div().text_size(11.5).text_color(t.dim).child("copy: git-ignored files of the main checkout (globs; .worktreeinclude works too). run: its commands; the core asks you before they run, and again when the file changes.")));
  }

  button(t, id, text, onClick, primary = false) {
    return div().id(id).px(10).py(5).rounded(6).cursor_pointer().text_size(12)
      .when(primary, (e) => e.bg(t.solid).text_color(t.solid_foreground))
      .when(!primary, (e) => e.border_1().border_color(t.border).hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => onClick(cx))
      .child(text);
  }
}
