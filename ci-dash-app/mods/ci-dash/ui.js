// Shared visual pieces of the CI Dash mod: pills, section headers, the search
// box and the filter chips.
import { div, svg } from "gpui-kit";
import { h_flex, Input } from "gpui-base";
import { settings } from "herdr";

export const MOD = "ci-dash"; // folder name under ~/.config/herdr-app/mods
export const icon = (name) => `mods/${MOD}/${name}.svg`;

/** A translucent version of a theme color, for tinted pills. Non-hex colors pass through. */
export const tint = (color, alpha = "24") => (/^#[0-9a-f]{6}$/i.test(color || "") ? color + alpha : color);

const mono = () => settings().font_family ?? "JetBrains Mono";

/**
 * A small rounded label. `color` tints the background and colors the text;
 * without it the pill is neutral. `glyph` is a text mark, `symbol` an svg name.
 */
export function pill(t, { label, color, glyph, symbol, spin = false, code = false }) {
  const fg = color || t.muted;
  return h_flex().h(20).px(7).gap(4).flex_none().items_center().rounded(6).text_size(11)
    .bg(color ? tint(color) : t.raised).text_color(fg)
    .when(code, (e) => e.font_family(mono()))
    .when(Boolean(glyph), (e) => e.child(div().flex_none().child(glyph)))
    .when(Boolean(symbol) && !spin, (e) => e.child(svg(icon(symbol)).size(11).flex_none()))
    .when(spin, (e) => e.child(svg(icon("spinner")).size(11).flex_none().spin(900)))
    .child(div().truncate().child(label));
}

/** `NEEDS ATTENTION  2  ─────────`. `meta` is a dim note that shrinks first. */
export function section(t, label, count, color, meta = "") {
  return h_flex().flex_none().w_full().px(14).pt(14).pb(4).gap(8).items_center()
    .child(div().flex_none().text_size(11).font_semibold().text_color(color || t.muted).child(label))
    .child(div().flex_none().text_size(11).text_color(t.dim).child(String(count)))
    .when(Boolean(meta), (e) => e.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(meta)))
    .child(div().flex_1().min_w(8).h(1).bg(t.border));
}

/** A filter box with a magnifier, the typed text, and `right` (a count) at the end. */
export function searchBox(t, id, state, { right = "", onClear } = {}) {
  const typed = state.value().length > 0;
  return h_flex().id(id).h(36).flex_none().px(12).gap(8).items_center().rounded(10).bg(t.raised)
    .border_1().border_color(t.border).cursor_text()
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(svg(icon("search")).size(14).flex_none().text_color(t.dim))
    .child(Input.new(state).h_full().flex_1().min_w(0).text_size(12).text_color(t.foreground))
    .when(Boolean(right), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(right)))
    .when(typed && Boolean(onClear), (e) => e.child(div().id(`${id}-clear`).size(18).flex_none().flex().items_center().justify_center()
      .rounded(5).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClear(cx))
      .child(svg(icon("close")).size(11).text_color(t.muted))));
}

/** A selectable filter such as `Failed 2`. */
export function filterChip(t, id, label, count, active, onClick, color) {
  return h_flex().id(id).h(26).px(10).gap(6).flex_none().items_center().rounded(8).text_size(12).cursor_pointer()
    .bg(active ? t.raised : t.background).border_1().border_color(active ? t.border : t.background)
    .text_color(active ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => onClick(cx))
    .when(Boolean(color), (e) => e.child(div().size(6).rounded(3).flex_none().bg(color)))
    .child(label)
    .child(div().h(16).px(6).rounded(8).flex().items_center().text_size(10).bg(active ? t.hover : t.raised).text_color(t.dim).child(String(count)));
}
