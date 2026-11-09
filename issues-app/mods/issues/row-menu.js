// The right-click menu of a row of the list: Move (Jira), Open in Jira / GitHub, Start agent, Copy key.
// The issues mod opens itself as this popup with props { dialog: "row", to, key, site, status, url,
// copy, jira, agent }. Move opens the Move menu (transition.js); Start agent goes back to the list
// that opened the menu (shared ROW_ACTION, with the id `to` of that copy): it has the repository and the page.
// The rows look like the kit's menus (space-deck, files-md-menu). ↑ ↓ move, Enter runs, Esc closes.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, openOverlay, theme, notify, setShared } from "herdr";
import { fs, icon, openUrl } from "./links.js";

export const ROW_ACTION = "issues.rowAction";

export class RowMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(40, () => { try { this.handle.focus(); } catch { /* the pointer still works */ } });
  }

  items() {
    const p = props() ?? {}, close = () => closeOverlay(p.overlay);
    return [
      p.jira && { id: "move", label: `Move · ${p.status || "?"}`, icon: "pending", run: () => {
        close();
        openOverlay({ mod: "issues", kind: "popup", width: 300, props: { dialog: "transition", site: p.site, key: p.key, status: p.status } });
      } },
      { id: "open", label: `Open in ${p.jira ? "Jira" : "GitHub"}`, icon: "external", run: () => { close(); openUrl(p.url); } },
      p.agent && { id: "agent", label: "Start agent", icon: "bot", run: () => { close(); setShared(ROW_ACTION, { to: p.to, key: p.key, action: "agent", at: Date.now() }); } },
      { id: "copy", label: "Copy key", icon: "copy", run: (cx) => {
        cx.write_to_clipboard(p.copy);
        notify({ title: `Copied ${p.copy}`, level: "success", timeout: 2000 });
        close();
      } },
    ].filter(Boolean);
  }

  render() {
    const t = theme(), items = this.items(), p = props() ?? {};
    return v_flex().id("row-menu").track_focus(this.handle).w_full().p(5).bg(t.popover).text_size(fs.meta).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % items.length;
        else if (e.key === "up") this.at = (this.at + items.length - 1) % items.length;
        else if (e.key === "enter") { items[this.at]?.run(cx); return; }
        else if (e.key === "escape") { closeOverlay(p.overlay); return; }
        else return;
        cx.notify();
      })
      .child(div().px(8).pt(3).pb(5).text_size(fs.tiny).text_color(t.dim).truncate().child(p.copy ?? ""))
      .children(items.map((x, n) => h_flex().id(`row-menu-${x.id}`).h(28).px(8).gap(9).rounded(7).items_center().cursor_pointer()
        .when(n === this.at, (e) => e.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => x.run(cx))
        .child(icon(x.icon, t.muted, 14))
        .child(div().flex_1().min_w(0).truncate().child(x.label))));
  }
}
