// A diff, Unified or Split, in a virtual list: the diff of the Changes tab and of its Expand dialog.
// Based on the Changes Split mod of herdr-mods (a copy of Herdr's Changes panel, 0.1.12).
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { theme, settings, shared } from "herdr";
import { splitRows } from "./git.js";

// The view is one shared value, so every copy (side panel, dialog, other layouts) shows the same.
// Not set yet: the choice of the Changes Split mod, as a first value.
export const VIEW_KEY = "git-client.view";
export const WS_KEY = "git-client.ignoreWhitespace";
export const currentView = () => (shared(VIEW_KEY) ?? shared("changes-split.view")) === "split" ? "split" : "unified";
export const ignoreWhitespace = () => Boolean(shared(WS_KEY));
const CHAR = 7; // px of 1 character of the 11 px diff font, rounded up
const ROW = 20;

// Cuts a line into pieces of at most `width` characters, so a long line wraps inside its half.
function wrap(text, width) {
  const pieces = [];
  for (let i = 0; i < text.length; i += width) pieces.push(text.slice(i, i + width));
  return pieces.length ? pieces : [" "];
}

export class DiffView {
  // id: a unique name for the list and its scrollbar. hunkLabel(row) → text on a hunk row, or "".
  constructor(id) { this.id = id; this.rows = []; this.split = []; this.width = 300; this.area = 0; }

  setRows(rows) {
    this.rows = rows ?? [];
    this.split = splitRows(this.rows);
    this.width = Math.max(300, ...this.rows.map((r) => r.text.length * CHAR + 50));
    this.wrapped = null;
  }

  // Split has no sideways scroll: each half gets half of the width, and a long line wraps into more
  // rows. The result is kept until the rows or the width change.
  splitLayout() {
    const half = ((this.area || 600) - 1) / 2;
    const width = Math.max(8, Math.floor((half - 46) / CHAR)); // 30 px numbers, 10 px gap, 6 px margin
    if (this.wrapped?.rows !== this.split || this.wrapped.width !== width) {
      const items = this.split.map((row) => {
        if ("text" in row) return { row, lines: 1 };
        const left = row.left ? wrap(row.left.text, width) : [], right = row.right ? wrap(row.right.text, width) : [];
        return { row, left, right, lines: Math.max(left.length, right.length, 1) };
      });
      this.wrapped = { rows: this.split, width, items, sizes: items.map((item) => item.lines * ROW) };
    }
    return this.wrapped;
  }

  // The row (of this.rows, or of the split rows) behind a list key.
  rowAt(key) {
    const i = Number(key);
    return currentView() === "split" ? this.splitLayout().items[i]?.row : this.rows[i];
  }

  hunkRow(row, t, label) {
    return h_flex().w_full().h(ROW).flex_none().px(12).gap(8).items_center().bg(t.raised).text_color(t.dim)
      .when(Boolean(label), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
      .child(div().flex_1().min_w(0).truncate().child(row.text))
      .when(Boolean(label), (e) => e.child(div().flex_none().px(6).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(label)));
  }

  line({ kind, number, text }, t) {
    return h_flex().w_full().h(ROW).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  cell(cell, pieces, t) {
    return h_flex().flex_1().min_w(0).h_full().items_start().gap(10)
      .when(!cell, (e) => e.bg(t.foreground + "08"))
      .when(cell?.kind === "+", (e) => e.bg(t.ansi2 + "18")).when(cell?.kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(h_flex().w(30).h(ROW).flex_none().justify_end().text_color(t.dim).child(cell ? String(cell.number) : ""))
      .child(v_flex().flex_1().min_w(0).children(pieces.map((piece) => h_flex().h(ROW).flex_none().min_w(0).child(div().flex_1().min_w(0).truncate().child(piece)))));
  }

  sideBanner(sides, t) {
    if (!sides || (!sides.left && !sides.right)) return null;
    const mono = settings().font_family ?? "JetBrains Mono";
    const renderSide = (side, fallbackTone) => {
      if (!side) return div().flex_1().min_w(0);
      const tone = side.tone ?? fallbackTone;
      const color = tone === "removed" ? t.ansi1 : tone === "added" ? t.ansi2 : t.accent;
      const tip = [side.badge, side.ref, side.hash, side.subject].filter(Boolean).join(" · ");
      return h_flex().flex_1().min_w(0).gap(6).items_center().overflow_hidden().tooltip(tip)
        .when(Boolean(side.badge), (e) => e.child(h_flex().flex_none().h(16).px(5).items_center().rounded(4)
          .bg(color + "24").border_1().border_color(color + "66").text_size(10).font_semibold().text_color(color)
          .child(side.badge)))
        .when(Boolean(side.ref), (e) => e.child(div().flex_none().max_w(160).truncate().text_size(11).font_semibold().text_color(t.foreground).child(side.ref)))
        .when(Boolean(side.hash), (e) => e.child(div().flex_none().font_family(mono).text_size(10.5).text_color(t.accent).child(side.hash)))
        .when(Boolean(side.subject), (e) => e.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(side.subject)));
    };
    if (currentView() === "split") {
      return h_flex().h(26).flex_none().border_b(1).border_color(t.border).bg(t.chrome)
        .child(h_flex().flex_1().min_w(0).h_full().px(8).items_center().child(renderSide(sides.left, "removed")))
        .child(div().w(1).h_full().flex_none().bg(t.border))
        .child(h_flex().flex_1().min_w(0).h_full().px(8).items_center().child(renderSide(sides.right, "added")));
    }
    return h_flex().h(26).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(renderSide(sides.left, "removed"))
      .child(div().flex_none().text_size(11).text_color(t.dim).child("→"))
      .child(renderSide(sides.right, "added"));
  }

  // onClick(row, event, cx) / onMenu(row, event, cx): a click and a right-click on a row.
  render({ empty = null, hunkLabel = () => "", onClick = null, onMenu = null, sides = null } = {}) {
    const t = theme(), split = currentView() === "split", layout = split ? this.splitLayout() : null;
    const items = split ? layout.items : this.rows;
    const draw = (item) => {
      if (split) {
        if ("text" in item.row) return item.row.kind === "@" ? this.hunkRow(item.row, t, hunkLabel(item.row)) : this.line(item.row, t);
        return h_flex().w_full().h(item.lines * ROW).flex_none()
          .child(this.cell(item.row.left, item.left, t)).child(div().w(1).h_full().flex_none().bg(t.border)).child(this.cell(item.row.right, item.right, t));
      }
      return item.kind === "@" ? this.hunkRow(item, t, hunkLabel(item)) : this.line(item, t);
    };
    const banner = this.sideBanner(sides, t);
    const area = div().id(`${this.id}-area`).flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
      // on_size_change reports the width with the app zoom applied; w() and the text use unzoomed px.
      // The spot of the last press: a list's item click has no position, and a menu opens there.
      .on_mouse_down("left", (e) => { this.press = e; })
      .on_size_change((size, cx) => {
        const zoom = Number(settings()?.zoom) > 0 ? Number(settings().zoom) : 1, width = Math.round(size.width / zoom);
        if (width !== this.area) { this.area = width; if (currentView() === "split") cx.notify(); }
      })
      .when(!this.rows.length && Boolean(empty), (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child(empty)))
      .when(this.rows.length > 0, (e) => e
        .child(div().id(`${this.id}-x`).size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(split ? 0 : this.width).h_full().child(v_virtual_list(this.id, items.length, split ? layout.sizes : ROW, (i) => String(i),
            (range) => items.slice(range.start, range.end).map(draw))
            // Rows of a virtual list can't hold their own handlers: the list reports the row's key.
            .on_item_click((key, cx) => onClick?.(this.rowAt(key), this.press, cx))
            .on_item_secondary_click((key, ev, cx) => onMenu?.(this.rowAt(key), ev, cx))
            .size_full())))
        .child(Scrollbar.vertical(this.id).viewport_from_layout().absolute().inset_0()));
    return banner ? v_flex().flex_1().min_h(0).child(banner).child(area) : area;
  }
}
