// Visual pieces of the Kanban mod: icon buttons, chips, a segmented control and the search box.
import { div, svg, image } from "gpui-kit";
import { h_flex, Input } from "gpui-base";
import { settings } from "herdr";

export const MOD = "kanban"; // folder name under ~/.config/herdr-app/mods
export const icon = (name) => `mods/${MOD}/${name}.svg`;

/** A translucent version of a theme color. Non-hex colors pass through. */
export const tint = (color, alpha = "24") => (/^#[0-9a-f]{6}$/i.test(color || "") ? color + alpha : color);

export const mono = () => settings().font_family ?? "JetBrains Mono";

const stop = (_e, cx) => cx.stop_propagation();

/** A square button that holds an icon. */
export function iconButton(t, id, name, onClick, { active = false, color, tooltip = "", size = 28, glyph = 15 } = {}) {
  const fg = color || (active ? t.accent : t.muted);
  return div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(8)
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip))
    .when(active, (e) => e.bg(tint(t.accent, "26")))
    .cursor_pointer().hover((s) => s.bg(active ? tint(t.accent, "40") : t.hover))
    .on_mouse_down("left", stop)
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
    .child(svg(icon(name)).size(glyph).text_color(fg));
}

/** A column toggle in the top bar: a colored dot, the name and the card count.
 *  `compact`: no name (the tooltip has it). */
export function columnChip(t, id, { label, color, count, on, tooltip, compact = false }, onClick) {
  return h_flex().id(id).h(28).px(compact ? 8 : 11).gap(compact ? 5 : 7).flex_none().items_center().rounded(14).text_size(12).cursor_pointer()
    .border_1().border_color(on ? tint(color, "66") : t.border)
    .when(on, (e) => e.bg(tint(color, "1c")))
    .text_color(on ? t.foreground : t.dim)
    .hover((s) => s.bg(on ? tint(color, "30") : t.hover))
    .tooltip(tooltip)
    .on_mouse_down("left", stop)
    .on_click((_e, cx) => onClick(cx))
    .child(div().size(7).rounded(4).flex_none().when(on, (e) => e.bg(color)).when(!on, (e) => e.border_1().border_color(t.dim)))
    .when(!compact, (e) => e.child(div().when(!on, (e) => e.line_through()).child(label)))
    .child(div().h(16).px(6).rounded(8).flex().items_center().text_size(10).font_semibold()
      .bg(on ? tint(color, "33") : tint(t.foreground, "14")).text_color(on ? color : t.dim).child(String(count)));
}

/** A pill-shaped switch between a few views. Items: { id, label, symbol, active, tooltip, onClick }.
 *  An item with no label shows only its icon. */
export function segmented(t, items) {
  return h_flex().h(32).flex_none().p(3).gap(2).items_center().rounded(10)
    .bg(tint(t.foreground, "0f")).border_1().border_color(t.border)
    .children(items.map((it) =>
      h_flex().id(it.id).h(24).px(it.label ? 9 : 6).gap(6).items_center().rounded(7).text_size(12).cursor_pointer()
        .when(Boolean(it.tooltip), (e) => e.tooltip(it.tooltip))
        .when(it.active, (e) => e.bg(t.raised).border_1().border_color(t.border).text_color(t.foreground))
        .when(!it.active, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover)))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => it.onClick(cx))
        .child(svg(icon(it.symbol)).size(13).flex_none().text_color(it.active ? t.accent : t.dim))
        .when(Boolean(it.label), (e) => e.child(it.label))));
}

/** A filter box with a magnifier and a clear button. */
export function searchBox(t, id, state, { width = 220, onClear } = {}) {
  const typed = state.value().length > 0;
  return h_flex().id(id).h(32).w(width).flex_none().px(10).gap(8).items_center().rounded(10)
    .bg(tint(t.foreground, "0f")).border_1().border_color(t.border).cursor_text()
    .on_mouse_down("left", stop)
    .child(svg(icon("search")).size(14).flex_none().text_color(t.dim))
    .child(Input.new(state).h_full().flex_1().min_w(0).text_size(12).text_color(t.foreground))
    .when(typed && Boolean(onClear), (e) => e.child(div().id(`${id}-clear`).size(18).flex_none().flex().items_center().justify_center()
      .rounded(5).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClear(cx))
      .child(svg(icon("close")).size(11).text_color(t.muted))));
}

/** A small rounded label with an optional icon. */
export function pill(t, { label, symbol, code = false, color }) {
  return h_flex().h(20).px(7).gap(4).flex_grow(0).flex_shrink(1).min_w(0).max_w(160).items_center().rounded(6).text_size(11)
    .bg(color ? tint(color, "20") : tint(t.foreground, "12")).text_color(color || t.muted)
    .when(code, (e) => e.font_family(mono()))
    .when(Boolean(symbol), (e) => e.child(svg(icon(symbol)).size(11).flex_none()))
    .child(div().truncate().child(label));
}

/** A button for a side panel, a tab or a command: an icon (a path in the Herdr home: `.svg` is tinted,
 *  anything else is a picture) and a name. Lit while `on`. `iconOnly`: no name (the tooltip has it). */
export function panelButton(t, id, symbolPath, label, on, onClick, tooltip = "", iconOnly = false, spin = false) {
  const tip = tooltip || (iconOnly ? label : "");
  const glyph = String(symbolPath).endsWith(".svg") ? svg(symbolPath).size(14).flex_none() : image(symbolPath).size(14).flex_none();
  return h_flex().id(id).h(26).px(iconOnly ? 6 : 9).gap(6).flex_none().items_center().rounded(7).text_size(12).cursor_pointer()
    .when(Boolean(tip), (e) => e.tooltip(tip))
    .when(on, (e) => e.bg(tint(t.accent, "26")).text_color(t.accent))
    .when(!on, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover)))
    .on_mouse_down("left", stop)
    .on_click((_e, cx) => onClick(cx))
    .child(spin ? glyph.spin(900) : glyph)
    .when(!iconOnly, (e) => e.child(label));
}

/** A rounded group that holds several buttons. */
export function buttonGroup(t, children) {
  return h_flex().h(32).flex_none().px(3).gap(2).items_center().rounded(10)
    .bg(tint(t.foreground, "0f")).border_1().border_color(t.border)
    .children(children);
}

/** A thin vertical line. Between the sections of the bar, or inside a group (`inner`: shorter). */
export function divider(t, inner = false) {
  return div().w(1).h(inner ? 14 : 20).mx(inner ? 2 : 0).flex_none().bg(tint(t.foreground, "26"));
}

/** A text button. `iconOnly` (with a `symbol`): no label (the tooltip has it). */
export function button(t, id, label, onClick, { primary = false, symbol, tooltip = "", iconOnly = false } = {}) {
  const bare = iconOnly && Boolean(symbol);
  const tip = tooltip || (bare ? label : "");
  return h_flex().id(id).h(32).px(bare ? 9 : 14).gap(7).flex_none().max_w(200).items_center().rounded(9).text_size(12).font_semibold()
    .when(Boolean(tip), (e) => e.tooltip(tip))
    .border_1().border_color(primary ? t.accent : t.border)
    .bg(primary ? tint(t.accent, "26") : tint(t.foreground, "0f"))
    .text_color(primary ? t.accent : t.muted)
    .cursor_pointer().hover((s) => s.bg(primary ? tint(t.accent, "40") : t.hover))
    .on_mouse_down("left", stop)
    .on_click((_e, cx) => onClick(cx))
    .when(Boolean(symbol), (e) => e.child(svg(icon(symbol)).size(14).flex_none()))
    .when(!bare, (e) => e.child(div().truncate().child(label)));
}

export { stop };
