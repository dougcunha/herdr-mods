// Small parts of the dialog: buttons, chips, fields, sections.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Input, Textarea } from "gpui-base";
import { settings } from "herdr";

export const icon = (name) => `mods/automations/${name}.svg`;
export const mono = () => settings()?.font_family ?? "JetBrains Mono";

/** A translucent theme color for pills. */
export const tint = (color, alpha = "26") => (/^#[0-9a-f]{6}$/i.test(color || "") ? color + alpha : color);

// ok is green (ansi2): the theme's `done` color is blue in some themes.
export const STATUS_COLOR = (t, s) => ({ ok: t.ansi2 ?? t.done, failed: t.blocked, "timed out": t.blocked, skipped: t.dim, running: t.working })[s] ?? t.dim;

/** A text button. kind: "primary" | "plain" | "danger". */
export function button(t, id, text, action, { kind = "plain", iconName = null, tip = null, disabled = false } = {}) {
  const primary = kind === "primary";
  const fg = disabled ? t.dim : primary ? t.solid_foreground : kind === "danger" ? t.blocked : t.foreground;
  let el = h_flex().id(id).h(28).px(11).gap(6).items_center().flex_none().rounded(7)
    .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
    .text_color(fg).text_size(12).font_medium();
  if (!disabled) el = el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => action(cx));
  if (tip) el = el.tooltip(tip);
  if (iconName) el = el.child(svg(icon(iconName)).size(13).flex_none().text_color(fg));
  return text ? el.child(text) : el;
}

/** A square icon button. */
export function iconButton(t, id, iconName, tip, action, color = null) {
  return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
    .hover((s) => s.bg(t.hover)).tooltip(tip)
    .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
    .child(svg(icon(iconName)).size(14).text_color(color ?? t.muted));
}

/** A row of choices. options: [{ value, label }]. multi: `current` is a list. */
export function chips(t, id, options, current, pick, { multi = false } = {}) {
  return h_flex().w_full().flex_wrap().gap(6).children(options.map((o, i) => {
    const on = multi ? (current ?? []).includes(o.value) : current === o.value;
    return h_flex().id(`${id}-${i}`).h(26).px(10).items_center().rounded(13).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.input).bg(on ? tint(t.accent, "22") : t.raised)
      .text_size(12).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover))
      .when(Boolean(o.tip), (e) => e.tooltip(o.tip))
      .on_click((_e, cx) => pick(o.value, cx))
      .child(o.label);
  }));
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

/** A label, the control, and a hint below. */
export function labeled(t, label, control, hint = null, error = null) {
  return v_flex().gap(5).w_full()
    .child(div().text_size(11.5).font_medium().text_color(t.muted).child(label))
    .child(control)
    .when(Boolean(error || hint), (e) => e.child(div().text_size(11).text_color(error ? t.blocked : t.dim).child(error || hint)));
}

/** A titled group of fields. */
export function section(t, title, ...children) {
  return v_flex().gap(12).w_full().p(14).rounded(10).border_1().border_color(t.border).bg(t.surface)
    .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(title))
    .children(children.filter(Boolean));
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

/** The tab bar of the form. tabs: [{ key, label, icon, error }]. */
export function tabBar(t, tabs, current, pick) {
  return h_flex().w_full().px(12).gap(2).flex_none().border_b(1).border_color(t.border)
    .children(tabs.map((tb) => {
      const on = tb.key === current;
      return h_flex().id(`au-tab-${tb.key}`).h(38).px(12).gap(7).items_center().cursor_pointer().text_size(12.5)
        .border_b(2).border_color(on ? t.accent : t.popover)
        .text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_semibold())
        .hover((st) => st.text_color(t.foreground))
        .on_click((_e, cx) => pick(tb.key, cx))
        .child(svg(icon(tb.icon)).size(14).flex_none().text_color(on ? t.accent : t.dim))
        .child(tb.label)
        .when(Boolean(tb.error), (el) => el.child(div().size(6).rounded(3).bg(t.blocked)));
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

/** A card to pick one of a few big options (the trigger types). */
export function choiceCard(t, id, { label, text, iconName }, on, pick) {
  return v_flex().id(id).flex_1().min_w(120).gap(6).p(12).rounded(10).cursor_pointer()
    .border_1().border_color(on ? t.accent : t.border).bg(on ? tint(t.accent, "14") : t.surface)
    .hover((st) => st.border_color(on ? t.accent : t.input))
    .on_click((_e, cx) => pick(cx))
    .child(div().size(28).rounded(8).flex().items_center().justify_center().bg(on ? tint(t.accent, "26") : t.raised)
      .child(svg(icon(iconName)).size(15).text_color(on ? t.accent : t.muted)))
    .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(label))
    .child(div().text_size(11).text_color(t.dim).child(text));
}

/** A step of the run: a number, a title, a text and the fields. */
export function stepCard(t, n, title, text, body, active) {
  return h_flex().w_full().gap(14).items_start().p(14).rounded(10).border_1().border_color(active ? t.input : t.border).bg(t.surface)
    .child(div().size(26).flex_none().rounded(13).flex().items_center().justify_center().text_size(12).font_semibold()
      .bg(active ? t.accent : t.raised).text_color(active ? t.accent_foreground : t.muted).child(String(n)))
    .child(v_flex().flex_1().min_w(0).gap(8)
      .child(v_flex().gap(2)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child(title))
        .child(div().text_size(11.2).text_color(t.dim).child(text)))
      .child(body));
}

/** A small token that can be clicked (the prompt variables). */
export function token(t, id, text, tip, click) {
  return div().id(id).h(22).px(8).flex().items_center().rounded(6).cursor_pointer()
    .bg(tint(t.accent, "16")).text_color(t.accent).font_family(mono()).text_size(11)
    .hover((st) => st.bg(tint(t.accent, "2a")))
    .tooltip(tip)
    .on_click((_e, cx) => click(cx))
    .child(text);
}

/** A status pill. */
export function pill(t, status) {
  const c = STATUS_COLOR(t, status);
  return div().flex_none().px(7).h(18).flex().items_center().rounded(9).bg(tint(c, "26")).text_color(c).text_size(10.5).font_medium().child(status);
}

/** A block of program output. */
export function outputBlock(t, id, title, text, maxH = 220) {
  return v_flex().gap(4).w_full()
    .child(div().text_size(11).font_medium().text_color(t.muted).child(title))
    .child(div().id(id).w_full().max_h(maxH).overflow_y_scrollbar().p(8).rounded(7).bg(t.background).border_1().border_color(t.border)
      .font_family(mono()).text_size(11).text_color(t.foreground).whitespace_normal()
      .child(String(text || "").trim() || "(empty)"));
}

export const baseName = (p) => String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(p ?? "");

export function duration(ms) {
  if (ms == null || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
