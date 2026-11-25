// UI building blocks for Keybinds: physical-style keycaps, badges, buttons, and segmented pills.

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { settings, props, closeOverlay } from "herdr";
import { chordTokens, prettyChord } from "./model.js";

export const icon = (name) => `mods/keybinds/${name}.svg`;
export const mono = () => settings()?.font_family ?? "JetBrains Mono";
export const tint = (color, alpha = "24") => (/^#[0-9a-f]{6}$/i.test(color || "") ? color + alpha : color);

/** Close × button for the dialog header. */
export function closeX(t, onClose = null) {
  const o = props()?.overlay;
  if (!o && !onClose) return null;
  return div().id("kb-close").size(26).flex_none().flex().items_center().justify_center().rounded(7).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .tooltip("Close (Esc)")
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => {
      cx.stop_propagation();
      if (onClose) onClose(cx);
      else if (o) closeOverlay(o);
    })
    .child(svg(icon("close")).size(13).text_color(t.muted));
}

/** Styled button. kind: "plain" | "primary" | "danger" | "ghost". */
export function button(t, id, label, onClick, { kind = "plain", iconName = null, tip = null, disabled = false, h = 26 } = {}) {
  const primary = kind === "primary";
  const danger = kind === "danger";
  const ghost = kind === "ghost";
  const fg = disabled ? t.dim : primary ? t.solid_foreground : danger ? t.blocked : t.foreground;
  const bg = disabled && primary ? t.raised : primary ? t.solid : danger ? tint(t.blocked, "18") : ghost ? "#00000000" : t.raised;
  const border = disabled && primary ? t.border : primary ? t.solid : danger ? tint(t.blocked, "55") : ghost ? "#00000000" : t.input;

  let el = h_flex().id(id).h(h).px(label ? 10 : 6).gap(6).items_center().justify_center().flex_none().rounded(7)
    .border_1().border_color(border).bg(bg).text_color(fg).text_size(12).font_medium();
  if (!disabled) {
    el = el.cursor_pointer().hover((s) => (primary ? s.opacity(0.88) : s.bg(danger ? tint(t.blocked, "2c") : t.hover)));
    el = el.on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); });
  } else {
    el = el.opacity(0.5);
  }
  if (tip) el = el.tooltip(tip);
  if (iconName) el = el.child(svg(icon(iconName)).size(13).flex_none().text_color(fg));
  if (label) el = el.child(label);
  return el;
}

/** Small tinted status or section pill. */
export function badge(t, label, color, { id = null, tip = null } = {}) {
  let el = h_flex().h(19).px(7).flex_none().items_center().rounded(5).text_size(10.5).font_medium()
    .bg(tint(color, "1f")).border_1().border_color(tint(color, "44")).text_color(color)
    .child(label);
  if (id) el = el.id(id);
  if (tip) el = el.tooltip(tip);
  return el;
}

/** Segmented control pill bar. */
export function segmented(t, id, options, value, onPick) {
  return h_flex().flex_none().flex_wrap().p(2).gap(2).rounded(8).bg(t.background).border_1().border_color(t.border)
    .children(options.map((o, i) => {
      const on = o.value === value;
      return h_flex().id(`${id}-${i}`).h(25).px(10).items_center().rounded(6).cursor_pointer().text_size(12)
        .bg(on ? t.raised : t.background).text_color(on ? t.foreground : t.muted)
        .when(on, (el) => el.font_semibold().border_1().border_color(t.input))
        .hover((st) => st.text_color(t.foreground))
        .when(Boolean(o.tip), (el) => el.tooltip(o.tip))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); onPick(o.value, cx); })
        .child(String(o.label ?? o.value));
    }));
}

/** Renders physical-style keycaps for a chord, with click-to-rebind and optional × remove button. */
export function keycapGroup(t, { id, chord, platform, recording = false, onEdit, onRemove, onCancel }) {
  if (recording) {
    return h_flex().id(id).h(26).px(9).gap(6).flex_none().items_center().rounded(7)
      .bg(tint(t.accent, "20")).border_1().border_color(t.accent)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(svg(icon("record")).size(12).flex_none().text_color(t.accent))
      .child(div().text_size(11.5).font_semibold().text_color(t.accent).child("Press keys…"))
      .child(div().id(`${id}-cancel`).h(18).px(5).flex().items_center().rounded(4).cursor_pointer()
        .text_size(10.5).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); onCancel?.(cx); })
        .child("Cancel"));
  }

  const tokens = chordTokens(chord, platform);
  const label = prettyChord(chord, platform);
  const caps = h_flex().id(`${id}-edit`).h(26).px(4).gap(3).items_center().rounded(7).cursor_pointer()
    .bg(t.background).border_1().border_color(t.border)
    .hover((s) => s.border_color(t.accent).bg(t.hover))
    .tooltip(`Click to rebind ${label}`)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); onEdit?.(cx); })
    .children(tokens.map((tok) => (
      tok === "then"
        ? div().px(2).text_size(10).text_color(t.dim).child("→")
        : div().h(19).px(5).flex().items_center().justify_center().rounded(4)
          .bg(t.raised).border_1().border_b(2).border_color(t.input)
          .font_family(mono()).text_size(10.8).font_semibold().text_color(t.foreground)
          .child(tok)
    )));

  if (!onRemove) return caps;
  return h_flex().gap(2).flex_none().items_center()
    .child(caps)
    .child(div().id(`${id}-rm`).size(20).flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(t.dim).hover((s) => s.bg(tint(t.blocked, "22")).text_color(t.blocked))
      .tooltip(`Remove ${label}`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onRemove(cx); })
      .child(svg(icon("close")).size(11)));
}

/** Compact single keycap pill for read-only displays (like headers or conflict banners). */
export function staticKeycaps(t, chord, platform) {
  const tokens = chordTokens(chord, platform);
  return h_flex().gap(3).flex_none().items_center()
    .children(tokens.map((tok) => (
      tok === "then"
        ? div().px(1).text_size(10).text_color(t.dim).child("→")
        : div().h(20).px(6).flex().items_center().justify_center().rounded(4)
          .bg(t.raised).border_1().border_b(2).border_color(t.input)
          .font_family(mono()).text_size(11).font_semibold().text_color(t.foreground)
          .child(tok)
    )));
}
