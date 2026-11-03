// Shared visual pieces of the Git Dash mod: pills, chips, the search box and buttons.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { settings } from "herdr";

export const MOD = "git-dash"; // folder name under ~/.config/herdr-app/mods
export const icon = (name) => `mods/${MOD}/${name}.svg`;

/** A translucent version of a theme color, for tinted pills. Non-hex colors pass through. */
export const tint = (color, alpha = "24") => (/^#[0-9a-f]{6}$/i.test(color || "") ? color + alpha : color);

const mono = () => settings().font_family ?? "JetBrains Mono";
export { mono };

/** A small rounded label. `color` tints the background and the text; `symbol` is an svg name. */
export function pill(t, { label, color, symbol, code = false }) {
  const fg = color || t.muted;
  return h_flex().h(20).px(7).gap(4).flex_none().items_center().rounded(6).text_size(11)
    .bg(color ? tint(color) : tint(t.foreground, "1a")).text_color(fg)
    .when(code, (e) => e.font_family(mono()))
    .when(Boolean(symbol), (e) => e.child(svg(icon(symbol)).size(11).flex_none()))
    .child(div().truncate().child(label));
}

/** A filter box with a magnifier, the typed text, and `right` (a count) at the end. */
export function searchBox(t, id, state, { right = "", onClear } = {}) {
  const typed = state.value().length > 0;
  return h_flex().id(id).h(34).flex_none().px(12).gap(8).items_center().rounded(10).bg(t.raised)
    .border_1().border_color(t.border).cursor_text()
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(svg(icon("search")).size(14).flex_none().text_color(t.dim))
    .child(Input.new(state).h_full().flex_1().min_w(0).text_size(12).text_color(t.foreground))
    .when(Boolean(right), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(right)))
    .when(typed && Boolean(onClear), (e) => e.child(div().id(`${id}-clear`).size(18).flex_none().flex().items_center().justify_center()
      .rounded(5).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClear(cx))
      .child(svg(icon("close")).size(11).text_color(t.muted))));
}

/** A centered spinner with a title and an optional hint, for loading states. */
export function busy(t, title, detail = "") {
  return v_flex().flex_1().min_h(0).items_center().justify_center().gap(10).p(24)
    .child(svg(icon("spinner")).size(22).flex_none().text_color(t.accent).spin(900))
    .child(div().text_size(13).text_color(t.foreground).child(title))
    .when(Boolean(detail), (e) => e.child(div().max_w(280).truncate().text_size(11).text_color(t.dim).child(detail)));
}

/** A selectable filter such as `Pending 5`. */
export function filterChip(t, id, label, count, active, onClick, color) {
  return h_flex().id(id).h(26).px(10).gap(6).flex_none().items_center().rounded(8).text_size(12).cursor_pointer()
    .bg(active ? t.raised : t.background).border_1().border_color(active ? t.border : t.background)
    .text_color(active ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => onClick(cx))
    .when(Boolean(color), (e) => e.child(div().size(6).rounded(3).flex_none().bg(color)))
    .child(label)
    .child(div().h(16).px(6).rounded(8).flex().items_center().text_size(10).bg(active ? t.hover : t.raised).text_color(t.dim).child(String(count)));
}

/** A square button that holds an icon. `spin` swaps the icon for a spinner; `tooltip` is the hover label. */
export function iconButton(t, id, name, onClick, { active = false, disabled = false, spin = false, tooltip = "" } = {}) {
  const color = disabled ? t.dim : active || spin ? t.accent : t.muted;
  return div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(7)
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip))
    .when(active, (e) => e.bg(tint(t.accent, "26")))
    .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(active ? tint(t.accent, "33") : t.hover)).on_click((_e, cx) => onClick(cx)))
    .child(spin
      ? svg(icon("spinner")).size(15).text_color(color).spin(900)
      : svg(icon(name)).size(15).text_color(color));
}

/**
 * A small text button for a card. It stops the click, so the card under it
 * does not open or close. `tone`: "primary" (accent), "danger" (red) or none.
 */
export function smallButton(t, id, label, onClick, { tone = "", disabled = false, symbol = "", tooltip = "" } = {}) {
  const color = disabled ? t.dim : tone === "danger" ? t.ansi1 : tone === "primary" ? t.accent : t.muted;
  const filled = Boolean(tone) && !disabled;
  return h_flex().id(id).h(24).px(9).gap(5).flex_none().items_center().rounded(6).text_size(11).font_semibold()
    .border_1().border_color(filled ? color : t.border).bg(filled ? tint(color, "1f") : t.background).text_color(color)
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip))
    .on_click((_e, cx) => { cx.stop_propagation(); if (!disabled) onClick(cx); })
    .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(filled ? tint(color, "33") : t.hover)))
    .when(Boolean(symbol), (e) => e.child(svg(icon(symbol)).size(12).flex_none()))
    .child(label);
}

/** A text button. */
export function button(t, id, label, onClick, { primary = false } = {}) {
  return div().id(id).h(30).px(14).flex_none().flex().items_center().rounded(8).text_size(12)
    .border_1().border_color(primary ? t.accent : t.border)
    .bg(primary ? tint(t.accent, "26") : t.background)
    .text_color(primary ? t.accent : t.muted).font_semibold()
    .cursor_pointer().hover((s) => s.bg(primary ? tint(t.accent, "40") : t.hover))
    .on_click((_e, cx) => onClick(cx))
    .child(label);
}
