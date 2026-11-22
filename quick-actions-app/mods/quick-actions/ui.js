// Small parts of the dialog: buttons, fields, rows, tokens.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Input, Textarea } from "gpui-base";
import { settings, props, shared, closeOverlay } from "herdr";

export const icon = (name) => `mods/quick-actions/${name}.svg`;
export const mono = () => settings()?.font_family ?? "JetBrains Mono";

/** A translucent theme color. */
export const tint = (color, alpha = "26") => (/^#[0-9a-f]{6}$/i.test(color || "") ? color + alpha : color);

export const baseName = (p) => String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(p ?? "");

/** A text button. kind: "primary" | "plain" | "danger". */
export function button(t, id, text, action, { kind = "plain", iconName = null, tip = null, disabled = false } = {}) {
  const primary = kind === "primary";
  const fg = disabled ? t.dim : primary ? t.solid_foreground : kind === "danger" ? t.blocked : t.foreground;
  let el = h_flex().id(id).h(28).px(11).gap(6).items_center().flex_none().rounded(7)
    .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
    .text_color(fg).text_size(12).font_medium();
  if (!disabled) el = el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => action(cx));
  else el = el.opacity(0.6);
  if (tip) el = el.tooltip(tip);
  if (iconName) el = el.child(svg(icon(iconName)).size(13).flex_none().text_color(fg));
  return text ? el.child(text) : el;
}

/**
 * The × at the right end of a header: it closes the dialog of this mod. Only in a dialog of the mod's own,
 * not in a panel dialog of the dock (its title row has its own ×).
 */
export function closeX(t) {
  const o = props()?.overlay;
  if (!o || shared("kanban.panelDialog")?.id === o) return null;
  return div().id("qa-close").size(26).flex_none().flex().items_center().justify_center().rounded(8).cursor_pointer()
    .hover((s) => s.bg(t.hover)).tooltip("Close")
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); closeOverlay(o); })
    .child(svg(icon("close")).size(13).text_color(t.muted));
}

/** A square icon button. */
export function iconButton(t, id, iconName, tip, action, color = null) {
  return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
    .hover((s) => s.bg(t.hover)).tooltip(tip)
    .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
    .child(svg(icon(iconName)).size(14).text_color(color ?? t.muted));
}

/** A switch with a label. */
export function toggle(t, id, label, on, flip, tip = null) {
  return h_flex().id(id).gap(8).items_center().cursor_pointer().flex_none()
    .when(Boolean(tip), (e) => e.tooltip(tip))
    .on_click((_e, cx) => flip(cx))
    .child(div().w(30).h(17).rounded(9).p(2).flex().bg(on ? t.accent : t.input).when(on, (e) => e.justify_end())
      .child(div().size(13).rounded(7).bg(on ? t.accent_foreground : t.foreground)))
    .child(div().text_size(12).text_color(t.foreground).child(label));
}

/** A single-line text field. */
export function field(t, state, { w = null, onKey = null } = {}) {
  let el = Input.new(state).h(30).px(9).rounded(7).border_1().border_color(t.input).bg(t.background)
    .text_size(12.3).text_color(t.foreground);
  el = w ? el.w(w).flex_none() : el.w_full();
  if (onKey) el = el.on_key_down(onKey);
  return el;
}

/** A multi-line text field. */
export function area(t, state, onKey = null) {
  let el = Textarea.new(state).w_full().px(9).py(6).rounded(7).border_1().border_color(t.input).bg(t.background)
    .text_size(12.3).text_color(t.foreground);
  if (onKey) el = el.on_key_down(onKey);
  return el;
}

/** A row of options in one frame; the chosen one is lit. options: [{ value, label, tip? }]. */
export function segmented(t, id, options, value, pick) {
  return h_flex().flex_none().flex_wrap().p(3).gap(2).rounded(8).bg(t.background).border_1().border_color(t.border)
    .children(options.map((o, i) => {
      const on = o.value === value;
      return h_flex().id(`${id}-${i}`).h(26).px(11).items_center().rounded(6).cursor_pointer().text_size(12)
        .bg(on ? t.raised : t.background).text_color(on ? t.foreground : t.muted)
        .when(on, (el) => el.font_semibold().border_1().border_color(t.input).shadow_sm())
        .hover((st) => st.text_color(t.foreground))
        .when(Boolean(o.tip), (el) => el.tooltip(o.tip))
        .on_click((_e, cx) => pick(o.value, cx))
        .child(String(o.label ?? o.value));
    }));
}

/** A settings row: the label and its hint at the left, the control at the right. */
export function formRow(t, label, hint, control, { error = null, last = false } = {}) {
  return h_flex().w_full().gap(20).py(14).items_start()
    .when(!last, (el) => el.border_b(1).border_color(t.border))
    .child(v_flex().w(200).flex_none().gap(3).pt(5)
      .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(label))
      .when(Boolean(hint), (el) => el.child(div().text_size(11.2).text_color(t.dim).child(hint))))
    .child(v_flex().flex_1().min_w(0).gap(6).items_start()
      .child(control)
      .when(Boolean(error), (el) => el.child(h_flex().gap(5).items_center().text_size(11.2).text_color(t.blocked)
        .child(svg(icon("alert")).size(12).flex_none().text_color(t.blocked)).child(error))));
}

/** A small token that can be clicked (the variables). */
export function token(t, id, text, tip, click) {
  return div().id(id).h(22).px(8).flex().items_center().rounded(6).cursor_pointer()
    .bg(tint(t.accent, "16")).text_color(t.accent).font_family(mono()).text_size(11)
    .hover((st) => st.bg(tint(t.accent, "2a")))
    .tooltip(tip)
    .on_click((_e, cx) => click(cx))
    .child(text);
}
