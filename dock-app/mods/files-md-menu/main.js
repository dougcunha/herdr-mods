// The right-click menu of the Files panel (files-md). It is a dumb list: files-md builds the items
// and passes them as props; each item is a row with a label and one or more of these actions:
//   icon: "name"                     mods/files-md-menu/<name>.svg, drawn in the muted color
//   copy: "text"                     writes the text to the clipboard
//   share: ["key", value]            writes a shared value (setShared)
//   exec: ["program", ["arg", ...]]  runs a program on this computer, or on `on` when set
//   cmds: [["command", {args}], ...] runs Herdr app commands in order
// Two items show a second step in the popup before the actions run:
//   ask: { title, value, select: [start, end] }  a text field; Enter runs the actions with the text.
//        In exec, "{{value}}" in an argument becomes the text, "{{value:ps}}" the text as a PowerShell string.
//   confirm: { title, button }                   a question; Enter or the button runs the actions.
// ↑/↓ move, Enter runs, Esc closes. An item with sep: true has a divider above it.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, run, exec, notify, theme, setShared, window } from "herdr";

const psQuote = s => "'" + s.replaceAll("'", "''") + "'";

// A file name must not be empty, ".", "..", or hold a folder separator (and on Windows, other reserved signs).
function badName(name) {
  if (!name.trim()) return "Type a name";
  if (name === "." || name === "..") return "This name is not allowed";
  if (name.includes("/") || name.includes("\0")) return "A name cannot contain /";
  if (window()?.platform === "windows" && !props()?.on && /[\\:*?"<>|]/.test(name)) return 'A name cannot contain \\ : * ? " < > |';
  return null;
}

export default class FilesMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.step = null; // the item that shows its ask or confirm step
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(i, cx) {
    const items = props()?.items ?? [], it = items[i];
    if (!it) return;
    if (it.ask || it.confirm) { this.open(it, cx); return; }
    this.act(it, null, cx);
  }

  open(it, cx) {
    this.step = it; this.problem = null;
    if (it.ask) {
      this.input = InputState.new({ value: it.ask.value ?? "" });
      this.input.on("submit", (_e, cx) => this.submit(cx));
      this.input.on("change", (_e, cx) => { if (this.problem) { this.problem = null; cx.notify(); } });
      const [start, end] = it.ask.select ?? [0, (it.ask.value ?? "").length];
      this.input.set_selected_range({ start, end });
      // The menu row had the keyboard; give it to the field after it is on the screen.
      this.input.focus();
      cx.timer.after(40, cx => { this.input?.focus(); cx.notify(); });
    }
    cx.notify();
  }

  submit(cx) {
    const it = this.step;
    if (!it) return;
    if (it.ask) {
      const value = this.input.value();
      const problem = badName(value);
      if (problem) { this.problem = problem; cx.notify(); return; }
      if (value === it.ask.value) { closeOverlay(props()?.overlay); return; }
      this.act(it, value, cx);
    } else this.act(it, null, cx);
  }

  act(it, value, cx) {
    const fill = s => typeof s !== "string" || value === null ? s : s.replaceAll("{{value:ps}}", psQuote(value)).replaceAll("{{value}}", value);
    // The clipboard needs this handler's cx, so write before the popup (and the cx) goes away.
    if (typeof it.copy === "string") cx.write_to_clipboard(it.copy);
    if (it.share) setShared(it.share[0], it.share[1]);
    if (it.exec) {
      const on = it.on ?? undefined;
      // Explorer exits with code 1 even when it worked, so only other programs report a failure.
      exec(it.exec[0], (it.exec[1] ?? []).map(fill), on ? { on } : undefined)
        .then(r => {
          if (r.code !== 0 && it.exec[0] !== "explorer") notify({ title: it.label, body: (r.stderr || r.stdout || "The program failed").trim().slice(0, 300), level: "error" });
          else if (r.code === 0) for (const [name, args] of it.done ?? []) run(name, args ?? {});
        })
        .catch(e => notify({ title: it.label, body: String(e?.message ?? e).slice(0, 300), level: "error" }));
    }
    closeOverlay(props()?.overlay);
    for (const [name, args] of it.cmds ?? []) run(name, args ?? {});
  }

  renderStep(t) {
    const it = this.step, button = (id, label, color, fn) => div().id(id).px(10).py(4).rounded(6).cursor_pointer().text_size(12)
      .text_color(color).hover(s => s.bg(t.hover)).on_click((_e, cx) => fn(cx)).child(label);
    return v_flex().gap(8).p(6)
      .child(div().text_size(12).font_semibold().text_color(t.foreground).child(it.ask?.title ?? it.confirm.title))
      .when(Boolean(it.ask), el => el
        .child(div().id("files-menu-field").h(30).px(8).flex().items_center().rounded(7).border_1().border_color(this.problem ? t.ansi1 : t.accent)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).w_full().h_full().text_size(12.8).text_color(t.foreground)))
        .when(Boolean(this.problem), el => el.child(div().text_size(11).text_color(t.ansi1).child(this.problem))))
      .child(h_flex().gap(4).justify_end()
        .child(button("files-menu-cancel", "Cancel", t.muted, () => closeOverlay(props()?.overlay)))
        .child(button("files-menu-ok", it.ask ? "OK" : it.confirm.button ?? "OK", it.danger ? t.ansi1 : t.accent, cx => this.submit(cx))));
  }

  render(cx) {
    const t = theme(), items = props()?.items ?? [];
    return v_flex().id("files-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (this.step) {
          // The text field handles its own keys and its Enter (submit). It keeps Esc from Herdr: close here.
          if (e.key === "escape") { cx.stop_propagation(); closeOverlay(props()?.overlay); return; }
          if (e.key === "enter" && !this.step.ask) this.submit(cx);
          return;
        }
        if (!items.length) return;
        if (e.key === "down") this.at = (this.at + 1) % items.length;
        else if (e.key === "up") this.at = (this.at + items.length - 1) % items.length;
        else if (e.key === "enter") { this.choose(this.at, cx); return; }
        else if (e.key === "escape") { closeOverlay(props()?.overlay); return; }
        else return;
        cx.notify();
      })
      .when(Boolean(this.step), el => el.child(this.renderStep(t)))
      .when(!this.step, el => el.children(items.map((it, i) => v_flex()
        .when(Boolean(it.sep) && i > 0, el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`files-menu-${i}`).h(31).px(10).rounded(7).items_center().text_color(it.danger ? t.ansi1 : t.foreground)
          .when(i === this.at, el => el.bg(t.selected))
          .hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.choose(i, cx))
          .gap(9)
          .child(it.icon ? svg(`mods/files-md-menu/${it.icon}.svg`).size(14).flex_none().text_color(it.danger ? t.ansi1 : t.muted) : div().w(14).flex_none())
          .child(div().flex_1().min_w(0).truncate().child(it.label))))));
  }
}
