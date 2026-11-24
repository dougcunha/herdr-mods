// New Worktree dialog, opened with props { role: "worktree", action, ctx }.
// Lets the user either create a new branch (from HEAD or any local/remote branch)
// or open an existing local or remote branch in a new worktree via PowerMods Core.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, exec, theme } from "herdr";
import { READ } from "./git.js";
import { refsArgs, parseRefs, parseWorktrees } from "./refs.js";
import { describeError } from "./errors.js";
import { perform, openErrorDialog } from "./act.js";
import { maybeWorktrees } from "./core.js";
import { icon } from "./menu.js";
import { worktreeBranchOptions, worktreeRequest } from "./worktree-pick.js";

const MAX_SHOWN = 150;

export class WorktreeDialog {
  init(cx) {
    const { action, ctx } = props();
    this.action = action;
    this.mode = "new";
    this.scope = "all";
    this.baseRef = "HEAD";
    this.pickedId = null;
    this.open = true;
    this.busy = false;
    this.error = null;
    this.focused = "name";
    this.filter = "";
    this.branchName = "";
    this.folder = "";

    this.nameInput = InputState.new({ value: "", placeholder: "e.g. feat/my-feature" });
    this.nameInput.on("change", (_e, cx) => { this.branchName = this.nameInput.value(); this.error = null; cx.notify(); });
    this.nameInput.on("submit", (_e, cx) => this.confirm(cx));
    this.nameInput.on("focus", (_e, cx) => { this.focused = "name"; cx.notify(); });
    this.nameInput.on("blur", (_e, cx) => { if (this.focused === "name") this.focused = null; cx.notify(); });

    this.filterInput = InputState.new({ value: "", placeholder: "Filter local and remote branches…" });
    this.filterInput.on("change", (_e, cx) => { this.filter = this.filterInput.value().trim().toLowerCase(); cx.notify(); });
    this.filterInput.on("focus", (_e, cx) => { this.focused = "filter"; cx.notify(); });
    this.filterInput.on("blur", (_e, cx) => { if (this.focused === "filter") this.focused = null; cx.notify(); });

    this.folderInput = InputState.new({ value: "", placeholder: "" });
    this.folderInput.on("change", (_e, cx) => { this.folder = this.folderInput.value(); this.error = null; cx.notify(); });
    this.folderInput.on("submit", (_e, cx) => this.confirm(cx));
    this.folderInput.on("focus", (_e, cx) => { this.focused = "folder"; cx.notify(); });
    this.folderInput.on("blur", (_e, cx) => { if (this.focused === "folder") this.focused = null; cx.notify(); });

    this.handle = cx.focus_handle();
    this.nameInput.focus();
    cx.timer.after(60, () => { if (this.mode === "new") this.nameInput.focus(); });
    cx.timer.after(400, () => { if (this.mode === "new" && !this.focused) this.nameInput.focus(); });

    this.data = action?.local ? { local: action.local, remote: action.remote ?? [], worktrees: action.worktrees ?? [] } : null;
    this.loading = !this.data && Boolean(ctx?.root);
    if (!this.data && ctx?.root) {
      const git = (args) => exec("git", [...READ, ...args], { cwd: ctx.root, on: ctx.on });
      cx.spawn(async (cx) => {
        try {
          const [refs, wts] = await Promise.all([git(refsArgs()), git(["worktree", "list", "--porcelain"])]);
          if (refs.code === 0) {
            const parsed = parseRefs(refs.stdout);
            this.data = { local: parsed.local, remote: parsed.remote, worktrees: parseWorktrees(wts.stdout) };
          }
        } catch {
          // Leave empty list if git fails; user can still type a new branch name.
        } finally {
          this.loading = false;
          cx.notify();
        }
      });
    }
  }

  options() {
    return worktreeBranchOptions(this.data ?? {});
  }

  setMode(mode, cx) {
    if (this.mode === mode || this.busy) return;
    this.mode = mode;
    this.scope = "all";
    this.error = null;
    this.filter = "";
    this.filterInput.set_value("");
    if (mode === "new") this.nameInput.focus();
    else this.filterInput.focus();
    cx.notify();
  }

  confirm(cx) {
    if (this.busy) return;
    const { ctx, overlay } = props();
    const opts = this.options();
    const pickedExisting = opts.existing.find((x) => x.id === this.pickedId) ?? null;
    const req = worktreeRequest({
      mode: this.mode,
      branchName: this.branchName,
      baseRef: this.baseRef,
      pickedExisting,
      folder: this.folder,
      open: this.open,
      localNames: opts.localNames,
    });
    if (!req.ok) {
      this.error = { title: "Check the fields", summary: req.error, hint: null, detail: "", worktree: null };
      cx.notify();
      return;
    }
    this.busy = true;
    this.error = null;
    cx.spawn(async (cx) => {
      const result = await perform(this.action, req.values, ctx, { toast: false });
      this.busy = false;
      if (result.ok) closeOverlay(overlay);
      else {
        this.error = result.error ?? describeError(this.action, result.message, req.values);
        cx.notify();
      }
    });
    cx.notify();
  }

  render() {
    const t = theme(), p = props(), ctx = p.ctx;
    const opts = this.options();
    const pickedExisting = opts.existing.find((x) => x.id === this.pickedId) ?? null;
    const matchScope = (k) => this.scope === "all" || k === this.scope || k === "head";
    const matchText = (s) => !this.filter || s.toLowerCase().includes(this.filter);
    const bases = opts.bases.filter((b) => matchScope(b.kind) && matchText(b.label));
    const existing = opts.existing.filter((b) => matchScope(b.kind) && matchText(b.name));

    const previewBranch = this.mode === "existing" ? (pickedExisting?.branch ?? "<branch>") : (this.branchName.trim() || "<branch>");
    const previewPath = maybeWorktrees()?.preview({ repo: ctx?.root ?? "repo", branch: previewBranch }) ?? "(PowerMods Core is not running)";

    const tab = (id, value, label) => h_flex().id(id).flex_1().h(26).items_center().justify_center().rounded(6).cursor_pointer()
      .text_size(12).font_medium()
      .when(this.mode === value, (e) => e.bg(t.selected).text_color(t.foreground))
      .when(this.mode !== value, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => this.setMode(value, cx))
      .child(label);

    const scopePill = (value, label) => div().id(`gwt-scope-${value}`).px(7).py(2).rounded(5).cursor_pointer().text_size(11)
      .when(this.scope === value, (e) => e.bg(t.selected).text_color(t.foreground).font_medium())
      .when(this.scope !== value, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { this.scope = value; cx.notify(); })
      .child(label);

    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((st) => st.opacity(0.88)).on_click(action).child(text);

    const filterBox = () => h_flex().id("gwt-filter").h(28).px(8).gap(6).items_center().rounded(7).border_1()
      .border_color(this.focused === "filter" ? t.accent : t.border).bg(t.background).cursor_text()
      .child(svg(icon("search")).size(12).flex_none().text_color(t.dim))
      .child(Input.new(this.filterInput).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground));

    const branchRow = ({ id, selected, disabled, glyph, title, badge, note, onClick }) =>
      h_flex().id(id).h(28).flex_none().px(8).gap(8).items_center().rounded(6)
        .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
        .when(selected, (e) => e.bg(t.selected))
        .when(disabled, (e) => e.opacity(0.5))
        .when(Boolean(note), (e) => e.tooltip(note))
        .on_click((_e, cx) => { if (!disabled && !this.busy) onClick(cx); })
        .child(div().size(12).flex_none().rounded(6).border_1().border_color(selected ? t.accent : t.input)
          .flex().items_center().justify_center()
          .when(selected, (e) => e.child(div().size(6).rounded(3).bg(t.accent))))
        .child(svg(icon(glyph)).size(12).flex_none().text_color(selected ? t.accent : t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(title))
        .child(div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(disabled ? t.ansi1 : t.dim).child(badge));

    return v_flex().id("git-client-worktree").track_focus(this.handle).size_full().min_h(0).p(18)
      .bg(t.popover).text_color(t.foreground).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(p.overlay);
        else if (e.key === "enter" && this.focused !== "filter") this.confirm(cx);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().flex_none().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("New worktree"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(h_flex().flex_none().mt(10).p(3).gap(3).rounded(8).bg(t.background).border_1().border_color(t.border)
        .child(tab("gwt-mode-new", "new", "New branch"))
        .child(tab("gwt-mode-existing", "existing", "Existing branch")))
      .child(v_flex().id("gwt-body").flex_1().min_h(0).pt(10)
        .when(this.mode === "new", (el) => el
          .child(div().pb(5).text_size(11.5).text_color(t.dim).child("Branch name"))
          .child(Input.new(this.nameInput).h(34).px(10).rounded(8).border_1()
            .border_color(this.focused === "name" ? t.accent : t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
          .child(h_flex().pt(10).pb(5).gap(6).items_center()
            .child(div().text_size(11.5).text_color(t.dim).child("Start from"))
            .child(div().max_w(180).truncate().px(6).py(1).rounded(4).bg(t.raised).border_1().border_color(t.border)
              .text_size(11).text_color(t.accent).child(this.baseRef))
            .child(div().flex_1())
            .child(scopePill("all", "All")).child(scopePill("local", "Local")).child(scopePill("remote", "Remote")))
          .child(filterBox())
          .child(v_flex().id("gwt-bases").h(118).w_full().flex_none().mt(6).p(4).gap(2).rounded(8).border_1().border_color(t.border).bg(t.background).overflow_y_scrollbar()
            .when(this.loading, (l) => l.child(div().p(8).text_size(11.5).text_color(t.dim).child("Loading branches…")))
            .when(!this.loading && bases.length === 0, (l) => l.child(div().p(8).text_size(11.5).text_color(t.dim).child("No matching branches")))
            .children(bases.slice(0, MAX_SHOWN).map((b, i) => branchRow({
              id: `gwt-b-${i}`,
              selected: this.baseRef === b.ref,
              disabled: false,
              glyph: b.kind === "remote" ? "cloud" : b.kind === "head" ? "commit" : "branch",
              title: b.label,
              badge: b.badge,
              note: null,
              onClick: (cx) => { this.baseRef = b.ref; this.error = null; cx.notify(); },
            })))))
        .when(this.mode === "existing", (el) => el
          .child(h_flex().pb(5).gap(6).items_center()
            .child(div().text_size(11.5).text_color(t.dim).child("Branch"))
            .child(div().flex_1())
            .child(scopePill("all", "All")).child(scopePill("local", "Local")).child(scopePill("remote", "Remote")))
          .child(filterBox())
          .child(v_flex().id("gwt-existing").h(178).w_full().flex_none().mt(6).p(4).gap(2).rounded(8).border_1().border_color(t.border).bg(t.background).overflow_y_scrollbar()
            .when(this.loading, (l) => l.child(div().p(8).text_size(11.5).text_color(t.dim).child("Loading branches…")))
            .when(!this.loading && existing.length === 0, (l) => l.child(div().p(8).text_size(11.5).text_color(t.dim).child("No matching branches")))
            .children(existing.slice(0, MAX_SHOWN).map((b, i) => branchRow({
              id: `gwt-e-${i}`,
              selected: this.pickedId === b.id,
              disabled: b.disabled,
              glyph: b.kind === "remote" ? "cloud" : "branch",
              title: b.name,
              badge: b.badge,
              note: b.note,
              onClick: (cx) => { this.pickedId = b.id; this.error = null; cx.notify(); },
            }))))
          .when(Boolean(pickedExisting), (el2) => el2.child(div().pt(6).w_full().min_w(0).text_size(11.5).text_color(t.muted).child(pickedExisting.note))))
        .child(div().pt(10).pb(5).text_size(11.5).text_color(t.dim).child("Folder (optional)"))
        .child(Input.new(this.folderInput).h(34).px(10).rounded(8).border_1()
          .border_color(this.focused === "folder" ? t.accent : t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
        .child(div().pt(4).w_full().min_w(0).truncate().text_size(11).text_color(t.dim).tooltip(previewPath).child(`Empty: ${previewPath}`))
        .child(h_flex().id("gwt-open").pt(10).gap(9).items_center().cursor_pointer()
          .on_click((_e, cx) => { this.open = !this.open; cx.notify(); })
          .child(div().size(15).flex_none().rounded(4).border_1().border_color(this.open ? t.accent : t.input)
            .when(this.open, (e) => e.bg(t.accent)).flex().items_center().justify_center()
            .when(this.open, (e) => e.child(svg(icon("check")).size(11).text_color(t.accent_foreground))))
          .child(div().text_color(t.foreground).child("Switch to the new space")))
        .when(Boolean(this.error), (el) => el.child(v_flex().id("gwt-error").w_full().min_w(0).mt(10).p(8).gap(3).rounded(8)
          .bg(t.ansi1 + "14").border_1().border_color(t.ansi1 + "44")
          .child(div().w_full().min_w(0).text_size(12).text_color(t.ansi1).child(this.error.summary))
          .when(Boolean(this.error.hint), (b) => b.child(div().w_full().min_w(0).text_size(11).text_color(t.muted).child(this.error.hint)))
          .when(Boolean(this.error.detail), (b) => b.child(div().id("gwt-error-more").pt(2).text_size(11).font_medium().text_color(t.accent).cursor_pointer()
            .hover((s) => s.opacity(0.85)).on_click(() => openErrorDialog(this.error, ctx)).child("Full output…"))))))
      .child(h_flex().flex_none().pt(12).gap(8).justify_end()
        .child(button("gwt-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("gwt-ok", this.busy ? "Working…" : "Create", true, (_e, cx) => this.confirm(cx))));
  }
}
