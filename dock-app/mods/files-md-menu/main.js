// The right-click menu of the Files panel (files-md). It is a dumb list: files-md builds the items
// and passes them as props; each item is a row with a label and one or more of these actions:
//   icon: "name"                     mods/files-md-menu/<name>.svg, drawn in the muted color
//   copy: "text"                   writes the text to the clipboard
//   exec: ["program", ["arg", ...]]  runs a program on this computer
//   cmds: [["command", {args}], ...] runs Herdr app commands in order
// ↑/↓ move, Enter runs, Esc closes. An item with sep: true has a divider above it.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, exec, notify, theme } from "herdr";

export default class FilesMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(i, cx) {
    const items = props()?.items ?? [], it = items[i];
    if (!it) return;
    // The clipboard needs this handler's cx, so write before the popup (and the cx) goes away.
    if (typeof it.copy === "string") cx.write_to_clipboard(it.copy);
    if (it.exec) {
      // Explorer exits with code 1 even when it worked, so only other programs report a failure.
      exec(it.exec[0], it.exec[1] ?? [])
        .then(r => { if (r.code !== 0 && it.exec[0] !== "explorer") notify({ title: it.label, body: (r.stderr || "The program failed").trim().slice(0, 300), level: "error" }); })
        .catch(e => notify({ title: it.label, body: String(e?.message ?? e).slice(0, 300), level: "error" }));
    }
    closeOverlay(props()?.overlay);
    for (const [name, args] of it.cmds ?? []) run(name, args ?? {});
  }

  render(cx) {
    const t = theme(), items = props()?.items ?? [];
    return v_flex().id("files-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (!items.length) return;
        if (e.key === "down") this.at = (this.at + 1) % items.length;
        else if (e.key === "up") this.at = (this.at + items.length - 1) % items.length;
        else if (e.key === "enter") { this.choose(this.at, cx); return; }
        else if (e.key === "escape") { closeOverlay(props()?.overlay); return; }
        else return;
        cx.notify();
      })
      .children(items.map((it, i) => v_flex()
        .when(Boolean(it.sep) && i > 0, el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`files-menu-${i}`).h(31).px(10).rounded(7).items_center().text_color(t.foreground)
          .when(i === this.at, el => el.bg(t.selected))
          .hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.choose(i, cx))
          .gap(9)
          .child(it.icon ? svg(`mods/files-md-menu/${it.icon}.svg`).size(14).flex_none().text_color(t.muted) : div().w(14).flex_none())
          .child(div().flex_1().min_w(0).truncate().child(it.label)))));
  }
}
