// Visual parts of the Repo Launcher: icons, tiles, pills, key caps, the
// switch and the highlighted text of a fuzzy match.

import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { shared } from "herdr";
import { MOD } from "./store.js";
import { segments } from "./fuzzy.js";

export const icon = (name) => `mods/${MOD}/${name}.svg`;

/** The color of a favorite. */
export const GOLD = "#f5a524";

/** A color with an alpha suffix (`"#rrggbb" + "aa"`). Other colors pass through. */
export const tint = (color, alpha = "24") => (/^#[0-9a-f]{6}$/i.test(color || "") ? color + alpha : color);

// The tile colors of the Spaces sidebar (picker's MARK), so a repository and
// its space share one color.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const PALETTE = Object.values(MARK);

function hash(text) {
  let h = 2166136261;
  for (const c of String(text)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** The color of a space, as the Spaces sidebar draws it. */
export function spaceColor(t, space) {
  if (!space) return null;
  if (space.name === "~") return t.dim;
  const c = shared("space.colors")?.[space.id];
  if (!c) return PALETTE[hash(space.id) % PALETTE.length];
  return c.startsWith("#") ? c : (MARK[c] ?? t[c] ?? PALETTE[0]);
}

/** A stable color for a repository name. */
export const repoColor = (name) => PALETTE[hash(name.toLowerCase()) % PALETTE.length];

/** A rounded square with the first letter of `name`. */
export function letterTile(name, color, size = 30) {
  const letter = ([...String(name).replace(/^[._-]+/, "")][0] ?? "?").toUpperCase();
  return h_flex().size(size).flex_none().rounded(Math.round(size * 0.28)).items_center().justify_center()
    .bg(color).text_color("#ffffff").font_bold().text_size(Math.round(size * 0.44))
    .child(letter);
}

/** The tile of a program from knownAgents() or panes(): its icon on its tile color. */
export function programTile(t, program, size = 30) {
  const glyph = Math.round(size * 0.56);
  const drawn = !program?.icon
    ? svg(icon("terminal")).size(glyph).text_color(t.foreground)
    : program.tint
      ? svg(program.icon).size(glyph).text_color(program.color ?? "#ffffff")
      : image(program.icon).size(glyph);
  return h_flex().size(size).flex_none().rounded(Math.round(size * 0.28)).items_center().justify_center()
    .bg(program?.tile ?? t.raised).border_1().border_color(tint("#ffffff", "14"))
    .child(drawn);
}

/** A small rounded label, tinted with `color`. */
export function pill(t, label, { color = null, symbol = null, spin = false, dot = null, max = 0 } = {}) {
  const fg = color ?? t.muted;
  return h_flex().h(20).px(7).gap(5).flex_none().items_center().rounded(10).text_size(11)
    .bg(color ? tint(color, "1f") : t.raised).text_color(fg)
    .when(Boolean(dot), (e) => e.child(div().size(6).flex_none().rounded(3).bg(dot)))
    .when(Boolean(symbol), (e) => e.child(spin
      ? svg(icon(symbol)).size(11).flex_none().text_color(fg).spin(900)
      : svg(icon(symbol)).size(11).flex_none()))
    .child(max ? div().max_w(max).truncate().child(label) : label);
}

/** A key cap, such as `↵` or `Ctrl+S`. */
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
export function iconButton(t, id, name, onClick, { tooltip = "", active = false, spin = false, color = null, size = 30 } = {}) {
  const fg = color ?? (active ? t.accent : t.muted);
  return h_flex().id(id).size(size).flex_none().items_center().justify_center().rounded(8).cursor_pointer()
    .when(active, (e) => e.bg(tint(t.accent, "1f")))
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

/** A text button. `primary` fills it with the accent color. */
export function button(t, id, label, onClick, { primary = false, symbol = null, danger = false } = {}) {
  const fg = primary ? (t.accent_foreground ?? "#ffffff") : danger ? t.blocked : t.foreground;
  return h_flex().id(id).h(30).px(12).gap(7).flex_none().items_center().rounded(8).text_size(12).font_semibold()
    .cursor_pointer()
    .bg(primary ? t.accent : t.raised)
    .border_1().border_color(primary ? t.accent : t.border)
    .text_color(fg)
    .hover((s) => s.bg(primary ? tint(t.accent, "dd") : t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => {
      cx.stop_propagation();
      onClick(cx);
    })
    .when(Boolean(symbol), (e) => e.child(svg(icon(symbol)).size(13).text_color(fg)))
    .child(label);
}

/** One choice of a segmented control. */
export function segmented(t, id, options, value, onPick) {
  return h_flex().id(id).h(30).p(3).gap(2).flex_none().items_center().rounded(9).bg(t.raised)
    .border_1().border_color(t.border)
    .children(options.map((o) => {
      const on = o.value === value;
      return h_flex().id(`${id}-${o.value}`).h_full().px(10).gap(6).items_center().rounded(6).text_size(11.5)
        .cursor_pointer()
        .when(on, (e) => e.bg(t.background).shadow_sm().text_color(t.foreground).font_semibold())
        .when(!on, (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
        .on_click((_e, cx) => onPick(o.value, cx))
        .when(Boolean(o.symbol), (e) => e.child(svg(icon(o.symbol)).size(12)))
        .child(o.label);
    }));
}

/**
 * Text with the characters at `indices` drawn in `hit` and bold.
 * `limit`: draw only the first `limit` characters (the rest is cut).
 */
export function highlighted(text, indices, { color, hit, size = 13, bold = false }) {
  const parts = segments(text, indices);
  return h_flex().min_w(0).overflow_hidden().text_size(size).text_color(color).when(bold, (e) => e.font_semibold())
    .children(parts.map((p) => {
      const el = div().flex_none().child(p.text);
      return p.hit ? el.text_color(hit).font_bold() : el;
    }));
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function ago(time) {
  if (!time) return "never";
  const s = Math.max(0, (Date.now() - time) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** A section title in a list or in the settings. */
export function sectionTitle(t, label, { symbol = null, color = null, count = null } = {}) {
  return h_flex().h_full().px(14).pt(8).gap(7).items_center().text_size(10.5).font_bold()
    .text_color(color ?? t.dim)
    .when(Boolean(symbol), (e) => e.child(svg(icon(symbol)).size(11).text_color(color ?? t.dim)))
    .child(label.toUpperCase())
    .when(count != null, (e) => e.child(div().text_color(t.dim).font_normal().child(String(count))));
}

export { v_flex, h_flex };
