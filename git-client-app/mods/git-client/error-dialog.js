// Full, scrollable Git error dialog, opened with props { role: "error", error, ctx }.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, settings } from "herdr";
import { icon } from "./menu.js";
import { openWorktree } from "./act.js";

export class ErrorDialog {
  init(cx) {
    this.copied = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    // Re-focus after a closing popup menu hands focus back.
    cx.timer.after(60, () => this.handle.focus());
  }

  copyText(err) {
    const parts = [err.title || "Git command failed", "", err.summary];
    if (err.hint) parts.push("", err.hint);
    if (err.detail) parts.push("", "Git output:", err.detail);
    return parts.join("\n");
  }

  render() {
    const t = theme(), p = props(), err = p.error ?? {}, ctx = p.ctx;
    const mono = settings().font_family ?? "JetBrains Mono";
    const button = (id, label, glyph, primary, onClick) => h_flex().id(id).h(32).px(12).gap(6).flex_none().items_center()
      .rounded(8).border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((st) => st.opacity(0.88)).on_click(onClick)
      .when(Boolean(glyph), (el) => el.child(svg(icon(glyph)).size(13).flex_none()))
      .child(label);

    return v_flex().id("git-client-error").track_focus(this.handle).size_full().min_h(0).p(18)
      .bg(t.popover).text_color(t.foreground).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "escape" || e.key === "enter") {
          closeOverlay(p.overlay);
          cx.stop_propagation();
        }
      })
      .child(h_flex().flex_none().gap(8).items_center()
        .child(svg(icon("alert")).size(16).flex_none().text_color(t.ansi1))
        .child(div().flex_1().min_w(0).text_size(15).font_semibold().child(err.title || "Git command failed"))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().flex_none().w_full().min_w(0).pt(10).text_size(13).text_color(t.foreground).child(err.summary || "The Git command failed."))
      .when(Boolean(err.hint), (el) => el.child(div().flex_none().w_full().min_w(0).mt(10).px(10).py(8).rounded(8)
        .bg(t.raised).border_1().border_color(t.border).text_size(12).text_color(t.muted).child(err.hint)))
      .when(Boolean(err.detail), (el) => el
        .child(div().flex_none().pt(12).pb(5).text_size(11).font_medium().text_color(t.dim).child("Git output"))
        .child(v_flex().id("ge-detail").flex_1().min_h(64).w_full().min_w(0).px(10).py(8).gap(2).rounded(8)
          .border_1().border_color(t.border).bg(t.background).overflow_y_scrollbar()
          .children(err.detail.split("\n").map((line) =>
            div().w_full().min_w(0).font_family(mono).text_size(11.5).text_color(t.muted).child(line || " ")))))
      .when(!err.detail, (el) => el.child(div().flex_1()))
      .child(h_flex().flex_none().pt(14).gap(8).items_center()
        .child(button("ge-copy", this.copied ? "Copied" : "Copy details", this.copied ? "check" : "copy", false, (_e, cx) => {
          cx.write_to_clipboard(this.copyText(err));
          this.copied = true;
          cx.notify();
          cx.timer.after(1800, () => { this.copied = false; cx.notify(); });
        }))
        .child(div().flex_1())
        .when(Boolean(err.worktree), (el) => el.child(button("ge-open-wt", "Open worktree", "folder", false, () => {
          openWorktree(err.worktree, ctx?.on);
          closeOverlay(p.overlay);
        })))
        .child(button("ge-close", "Close", null, true, () => closeOverlay(p.overlay))));
  }
}
