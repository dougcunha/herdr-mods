// Submodule branch switcher dialog, opened with props { role: "submoduleBranch", action, ctx }.
// Loads local and cached remote branches immediately without network, offers an on-demand
// Fetch button, checks out real local tracking branches safely, and optionally updates .gitmodules.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, exec, theme } from "herdr";
import { describeError } from "./errors.js";
import { perform, openErrorDialog } from "./act.js";
import { listSubmoduleLocalAndRemoteBranches } from "./execute.js";
import { icon } from "./menu.js";

const MAX_SHOWN = 200;

export class SubmoduleBranchDialog {
  init(cx) {
    const { action, ctx } = props();
    this.action = action;
    this.ctx = ctx;
    this.selected = action.currentBranch || action.configuredBranch || null;
    this.updateGitmodules = false;
    this.filter = "";
    this.focused = true;
    this.loading = true;
    this.fetching = false;
    this.busy = false;
    this.error = null;
    this.data = null;

    this.filterInput = InputState.new({ value: "", placeholder: "Filter local and remote branches…" });
    this.filterInput.on("change", (_e, cx) => { this.filter = this.filterInput.value().trim().toLowerCase(); cx.notify(); });
    this.filterInput.on("submit", (_e, cx) => this.confirm(cx));
    this.filterInput.on("focus", (_e, cx) => { this.focused = true; cx.notify(); });
    this.filterInput.on("blur", (_e, cx) => { this.focused = false; cx.notify(); });

    this.handle = cx.focus_handle();
    this.filterInput.focus();
    cx.timer.after(60, () => this.filterInput.focus());

    this.load(cx, false);
  }

  load(cx, withFetch = false) {
    if (withFetch) {
      if (this.fetching || this.busy) return;
      this.fetching = true;
    } else {
      this.loading = true;
    }
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const data = await listSubmoduleLocalAndRemoteBranches(this.action.path, this.ctx, exec, { fetch: withFetch });
        this.data = data;
        if (!this.selected || !data.branches.includes(this.selected)) {
          this.selected = data.current || data.branches[0] || null;
        }
      } catch (e) {
        this.error = describeError(this.action, String(e?.message ?? e));
      } finally {
        this.loading = false;
        this.fetching = false;
        cx.notify();
      }
    });
  }

  confirm(cx) {
    if (this.busy || this.loading || this.fetching || !this.selected) return;
    const { overlay } = props();
    const action = {
      ...this.action,
      remote: this.data?.remote ?? null,
      branches: this.data?.branches ?? [this.selected],
      remoteBranches: this.data?.remoteBranches ?? [],
    };
    const values = { branch: this.selected, updateGitmodules: Boolean(this.updateGitmodules) };
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const result = await perform(action, values, this.ctx, { toast: false });
      this.busy = false;
      if (result.ok) closeOverlay(overlay);
      else {
        this.error = result.error ?? describeError(action, result.message, values);
        cx.notify();
      }
    });
  }

  render() {
    const t = theme(), p = props(), a = this.action, d = this.data;
    const localSet = new Set(d?.local ?? []);
    const remoteSet = new Set(d?.remoteBranches ?? []);
    const branches = (d?.branches ?? []).filter((b) => !this.filter || b.toLowerCase().includes(this.filter));
    const canConfirm = Boolean(this.selected) && !this.loading && !this.fetching && !this.busy;

    const button = (id, text, primary, enabled, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(primary && enabled ? t.solid : t.input)
      .bg(primary && enabled ? t.solid : t.raised)
      .text_color(primary && enabled ? t.solid_foreground : enabled ? t.foreground : t.dim)
      .text_size(12.5).font_medium()
      .when(enabled, (e) => e.cursor_pointer().hover((st) => st.opacity(0.88)).on_click(action))
      .child(text);

    const pill = (text, color, bg = null) => div().flex_none().px(5).py(1).rounded(4)
      .when(Boolean(bg), (e) => e.bg(bg))
      .when(!bg, (e) => e.border_1().border_color(t.border))
      .text_size(10).text_color(color).child(text);

    const subtitle = [
      a.path,
      d?.current ? `on ${d.current}` : a.currentBranch ? `on ${a.currentBranch}` : "detached HEAD",
      a.configuredBranch ? `.gitmodules: ${a.configuredBranch}` : null,
    ].filter(Boolean).join(" · ");

    return v_flex().id("git-client-sub-branch").track_focus(this.handle).size_full().min_h(0).p(18)
      .bg(t.popover).text_color(t.foreground).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(p.overlay);
        else if (e.key === "enter" && !this.focused) this.confirm(cx);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().flex_none().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("Switch submodule branch"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().flex_none().pt(4).truncate().text_size(11.5).text_color(t.muted).child(subtitle))
      .child(h_flex().flex_none().pt(12).gap(6).items_center()
        .child(h_flex().id("gsb-filter").flex_1().min_w(0).h(32).px(9).gap(6).items_center().rounded(8).border_1()
          .border_color(this.focused ? t.accent : t.border).bg(t.background).cursor_text()
          .child(svg(icon("search")).size(12).flex_none().text_color(t.dim))
          .child(Input.new(this.filterInput).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground)))
        .child(h_flex().id("gsb-fetch").h(32).px(10).gap(5).flex_none().items_center().rounded(8).border_1().border_color(t.border)
          .bg(t.raised).text_size(12).text_color(this.fetching || !d?.remote ? t.dim : t.foreground)
          .tooltip(d?.remote ? `Fetch branches from ${d.remote}` : "No remote configured")
          .when(!this.fetching && !this.busy && Boolean(d?.remote), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.load(cx, true)))
          .child(svg(icon("cloud-down")).size(13).flex_none())
          .child(this.fetching ? "Fetching…" : "Fetch")))
      .child(v_flex().id("gsb-list").h(224).w_full().flex_none().mt(10).p(4).gap(2).rounded(8).border_1().border_color(t.border)
        .bg(t.background).overflow_y_scrollbar()
        .when(this.loading, (l) => l.child(div().p(10).text_size(12).text_color(t.dim).child("Loading branches…")))
        .when(!this.loading && branches.length === 0, (l) => l.child(div().p(10).text_size(12).text_color(t.dim)
          .child(d?.branches?.length ? "No matching branches" : "No branches found. Click Fetch to load remote branches.")))
        .children(branches.slice(0, MAX_SHOWN).map((b, i) => {
          const on = this.selected === b, isCurrent = d?.current === b, isLocal = localSet.has(b), isRemote = remoteSet.has(b);
          return h_flex().id(`gsb-b-${i}`).h(30).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
            .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
            .on_click((e, cx) => {
              if (this.busy) return;
              this.selected = b;
              this.error = null;
              if (e.click_count >= 2) this.confirm(cx);
              else cx.notify();
            })
            .child(div().size(12).flex_none().rounded(6).border_1().border_color(on ? t.accent : t.input)
              .flex().items_center().justify_center()
              .when(on, (e) => e.child(div().size(6).rounded(3).bg(t.accent))))
            .child(svg(icon(isLocal ? "branch" : "cloud")).size(12).flex_none().text_color(isCurrent ? t.accent : t.muted))
            .child(div().flex_1().min_w(0).truncate().text_size(12.2).when(isCurrent, (e) => e.font_semibold()).child(b))
            .when(isCurrent, (e) => e.child(pill("current", t.accent, t.accent + "22")))
            .when(isLocal && !isCurrent, (e) => e.child(pill("local", t.muted)))
            .when(isRemote, (e) => e.child(pill(d?.remote ?? "remote", t.dim)));
        })))
      .when(!a.nested, (el) => el.child(h_flex().id("gsb-gitmodules").pt(12).gap(9).items_center().cursor_pointer()
        .on_click((_e, cx) => { this.updateGitmodules = !this.updateGitmodules; cx.notify(); })
        .child(div().size(15).flex_none().rounded(4).border_1().border_color(this.updateGitmodules ? t.accent : t.input)
          .when(this.updateGitmodules, (e) => e.bg(t.accent)).flex().items_center().justify_center()
          .when(this.updateGitmodules, (e) => e.child(svg(icon("check")).size(11).text_color(t.accent_foreground))))
        .child(div().text_size(12).text_color(t.foreground).child("Also update .gitmodules tracked branch"))))
      .when(Boolean(this.error), (el) => el.child(v_flex().id("gsb-error").w_full().min_w(0).mt(10).p(8).gap(3).rounded(8)
        .bg(t.ansi1 + "14").border_1().border_color(t.ansi1 + "44")
        .child(div().w_full().min_w(0).text_size(11.5).text_color(t.ansi1).child(this.error.summary))
        .when(Boolean(this.error.detail), (box) => box.child(div().id("gsb-error-more").pt(2).text_size(11).font_medium().text_color(t.accent).cursor_pointer()
          .hover((s) => s.opacity(0.85)).on_click(() => openErrorDialog(this.error, this.ctx)).child("Full output…")))))
      .child(div().flex_1())
      .child(h_flex().flex_none().pt(12).gap(8).justify_end()
        .child(button("gsb-cancel", "Cancel", false, !this.busy, () => closeOverlay(p.overlay)))
        .child(button("gsb-ok", this.busy ? "Switching…" : "Switch branch", true, canConfirm, (_e, cx) => this.confirm(cx))));
  }
}
