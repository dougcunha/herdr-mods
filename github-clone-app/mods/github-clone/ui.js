// Visual parts of GitHub Clone: icons, tiles, pills, key caps, chips,
// buttons, the switch and the highlighted text of a fuzzy match.
// Most of them come from Repo Launcher, so the 2 dialogs look alike.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { MOD } from "./store.js";
import { segments } from "./fuzzy.js";

export const icon = (name) => `mods/${MOD}/${name}.svg`;

/** A color with an alpha suffix (`"#rrggbb" + "aa"`). Other colors pass through. */
export const tint = (color, alpha = "24") => (/^#[0-9a-f]{6}$/i.test(color || "") ? color + alpha : color);

const PALETTE = ["#22a99a", "#e3814f", "#5b8def", "#8b7cf6", "#3fae6a", "#d9649a"];

function hash(text) {
  let h = 2166136261;
  for (const c of String(text)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** A stable color for a name. */
export const nameColor = (name) => PALETTE[hash(String(name).toLowerCase()) % PALETTE.length];

/** A rounded square with the first letter of `name`. */
export function letterTile(name, color, size = 30) {
  const letter = ([...String(name).replace(/^[._-]+/, "")][0] ?? "?").toUpperCase();
  return h_flex().size(size).flex_none().rounded(Math.round(size * 0.28)).items_center().justify_center()
    .bg(color).text_color("#ffffff").font_bold().text_size(Math.round(size * 0.44))
    .child(letter);
}

/** A small rounded label, tinted with `color`. */
export function pill(t, label, { color = null, symbol = null, spin = false, max = 0, tooltip = "" } = {}) {
  const fg = color ?? t.muted;
  return h_flex().h(20).px(7).gap(5).flex_none().items_center().rounded(10).text_size(11)
    .bg(color ? tint(color, "1f") : t.raised).text_color(fg)
    .when(Boolean(tooltip), (e) => e.id(`pill-${label}-${tooltip.length}`).tooltip(tooltip))
    .when(Boolean(symbol), (e) => e.child(spin
      ? svg(icon(symbol)).size(11).flex_none().text_color(fg).spin(900)
      : svg(icon(symbol)).size(11).flex_none().text_color(fg)))
    .child(max ? div().max_w(max).truncate().child(label) : label);
}

/** A key cap, such as `↵` or `Ctrl+M`. */
export function kbd(t, label) {
  return h_flex().h(18).min_w(18).px(5).flex_none().items_center().justify_center().rounded(5)
    .bg(t.raised).border_1().border_color(t.border).text_size(10.5).font_semibold().text_color(t.muted)
    .child(label);
}

/** A key cap with what it does. */
export function hint(t, keys, label) {
  return h_flex().gap(5).flex_none().items_center().text_size(11).text_color(t.dim)
    .children(keys.map((k) => kbd(t, k)))
    .child(label);
}

/** An on/off switch. The knob slides. */
export function toggle(t, id, on, onClick) {
  return div().id(id).relative().w(30).h(18).flex_none().rounded(9).cursor_pointer()
    .bg(on ? t.accent : t.input ?? t.border)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => onClick(cx))
    .child(div().id(`${id}-knob`).absolute().top(2).left(on ? 14 : 2).size(14).rounded(7)
      .bg("#ffffff").shadow_sm().transition("left", { duration: 140, easing: "ease-out" }));
}

/** A square button with an icon. `spin` turns the icon (refresh while it works). */
export function iconButton(t, id, name, onClick, { tooltip = "", spin = false, color = null, size = 30 } = {}) {
  const fg = color ?? t.muted;
  return h_flex().id(id).size(size).flex_none().items_center().justify_center().rounded(8).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => {
      cx.stop_propagation();
      onClick(cx);
    })
    .child(spin
      ? svg(icon("refresh")).size(15).text_color(t.accent).spin(1000)
      : svg(icon(name)).size(15).text_color(fg));
}

/** A text button. `primary` fills it with the accent color. `disabled` draws it dim and ignores clicks. */
export function button(t, id, label, onClick, { primary = false, symbol = null, disabled = false, spin = false } = {}) {
  const fg = primary ? (t.accent_foreground ?? "#ffffff") : t.foreground;
  return h_flex().id(id).h(30).px(12).gap(7).flex_none().items_center().rounded(8).text_size(12).font_semibold()
    .bg(primary ? t.accent : t.raised)
    .border_1().border_color(primary ? t.accent : t.border)
    .text_color(fg)
    .opacity(disabled ? 0.45 : 1)
    .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(primary ? tint(t.accent, "dd") : t.hover)))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => {
      cx.stop_propagation();
      if (!disabled) onClick(cx);
    })
    .when(Boolean(symbol), (e) => e.child(spin
      ? svg(icon("spinner")).size(13).text_color(fg).spin(900)
      : svg(icon(symbol)).size(13).text_color(fg)))
    .child(label);
}

/** A segmented control. An option can be `disabled` (drawn dim, no click). */
export function segmented(t, id, options, value, onPick) {
  return h_flex().id(id).h(28).p(3).gap(2).flex_none().items_center().rounded(8).bg(t.raised)
    .border_1().border_color(t.border)
    .children(options.map((o) => {
      const on = o.value === value;
      return h_flex().id(`${id}-${o.value || "local"}`).h_full().px(9).gap(5).items_center().rounded(5).text_size(11.5)
        .when(Boolean(o.tooltip), (e) => e.tooltip(o.tooltip))
        .when(on, (e) => e.bg(t.background).shadow_sm().text_color(t.foreground).font_semibold())
        .when(!on && !o.disabled, (e) => e.cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground)))
        .when(!on && Boolean(o.disabled), (e) => e.text_color(tint(t.dim, "88")))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { if (!o.disabled) onPick(o.value, cx); })
        .when(Boolean(o.symbol), (e) => e.child(svg(icon(o.symbol)).size(12)))
        .child(o.label);
    }));
}

/** A filter chip with a count. */
export function chip(t, id, label, on, onClick, { count = null, symbol = null, warn = false, tooltip = "" } = {}) {
  const color = warn ? t.blocked : t.accent;
  return h_flex().id(id).h(24).px(9).gap(6).flex_none().items_center().rounded(12).cursor_pointer().text_size(11.5)
    .bg(on ? tint(color, "2a") : t.raised)
    .border_1().border_color(on ? tint(color, "99") : t.border)
    .text_color(on ? t.foreground : warn ? t.blocked : t.muted)
    .when(!on, (e) => e.hover((s) => s.text_color(t.foreground)))
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => onClick(cx))
    .when(Boolean(symbol), (e) => e.child(svg(icon(symbol)).size(11).flex_none()))
    .child(div().max_w(150).truncate().when(on, (e) => e.font_semibold()).child(label))
    .when(count != null, (e) => e.child(div().text_size(10.5).text_color(t.dim).child(String(count))));
}

/** Text with the characters at `indices` drawn in `hit` and bold. */
export function highlighted(text, indices, { color, hit, size = 13, bold = false }) {
  const parts = segments(text, indices);
  return h_flex().flex_none().overflow_hidden().text_size(size).text_color(color).when(bold, (e) => e.font_semibold())
    .children(parts.map((p) => {
      const el = div().flex_none().child(p.text);
      return p.hit ? el.text_color(hit).font_bold() : el;
    }));
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", "4 mo ago", "3 y ago". */
export function ago(time) {
  if (!time) return "";
  const s = Math.max(0, (Date.now() - time) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)} d ago`;
  if (s < 86400 * 730) return `${Math.floor(s / (86400 * 30))} mo ago`;
  return `${Math.floor(s / (86400 * 365))} y ago`;
}

/** A card of the folders view. */
export function card(t, title, detail, body) {
  return v_flex().gap(10).p(14).flex_none().rounded(12).bg(t.background).border_1().border_color(t.border)
    .child(v_flex().gap(2)
      .child(div().text_size(13).font_semibold().child(title))
      .when(Boolean(detail), (e) => e.child(div().text_size(11.5).text_color(t.dim).child(detail))))
    .child(body);
}

/** A line with an icon: a warning, an error or a good state. */
export function notice(t, kind, text, action = null) {
  const color = kind === "ok" ? t.done ?? t.accent : kind === "info" ? t.muted : t.blocked;
  return h_flex().gap(8).items_center().min_h(26).text_size(11.5).text_color(kind === "info" ? t.dim : color)
    .child(svg(icon(kind === "ok" ? "check" : kind === "info" ? "folder" : "alert")).size(13).flex_none().text_color(color))
    .child(div().flex_1().min_w(0).child(text))
    .when(Boolean(action), (e) => e.child(action));
}

export { v_flex, h_flex };
