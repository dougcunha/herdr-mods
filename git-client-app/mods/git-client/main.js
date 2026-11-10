import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, theme, closeOverlay, setShared } from "herdr";
import { Client } from "./client.js";
import { Menu, icon } from "./menu.js";
import { Dialog } from "./dialog.js";
import { DiffView, VIEW_KEY, currentView } from "./diffview.js";
import { AgentDialog } from "./agent.js";

// The wide diff of the Changes tab (its Expand button), opened with props { role: "diff", title, side, rows }.
class DiffDialog {
  init(cx) {
    const p = props();
    this.view = new DiffView(`gc-wide-${Math.random().toString(36).slice(2)}`);
    this.view.setRows(p.rows ?? []);
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  render() {
    const t = theme(), p = props(), view = currentView();
    const seg = (v, label) => div().id(`gcw-view-${v}`).h_full().px(8).flex().items_center().rounded(4).text_size(11.5)
      .text_color(view === v ? t.foreground : t.muted).when(view === v, (e) => e.bg(t.selected))
      .when(view !== v, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))).on_click(() => setShared(VIEW_KEY, v)).child(label);
    return v_flex().id("git-client-diff").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .child(h_flex().h(42).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
        .child(svg(icon("changes")).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(p.title ?? "Diff"))
        .child(div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10.5).text_color(t.muted).child(p.side ?? ""))
        .child(h_flex().flex_none().h(26).p(2).gap(2).rounded(6).border_1().border_color(t.border).child(seg("unified", "Unified")).child(seg("split", "Split")))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("Esc")))
      .child(this.view.render({ empty: "No changes" }));
  }
}

// One mod, several roles: the panel (a block, a dialog or a pane), and over the window the
// right-click menu, the dialogs its actions ask first and the wide diff (props.role).
export default class GitClient extends View {
  init(_props, cx) {
    const role = props()?.role;
    this.part = role === "menu" ? new Menu() : role === "dialog" ? new Dialog() : role === "diff" ? new DiffDialog()
      : role === "agent" ? new AgentDialog() : new Client();
    this.part.init(cx);
  }

  render(cx) { return this.part.render(cx); }
}
