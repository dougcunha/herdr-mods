// A short list to pick from, for the popups of this mod (the fields of a Move, the Fix version menu).
// A popup is as tall as its content and does not draw a virtual list, so this draws a window of
// rows at fixed height: the wheel moves the first shown row. The view that owns the list keeps
// `top` (the first row shown) and `chosen` (a Set of ids).

import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { fs, icon } from "./links.js";

export const ROW = 26, SHOWN = 7;

// The first row to show after a wheel step (`delta` > 0 scrolls up, as in the picker mod).
export const scrolled = (top, delta, count) => Math.max(0, Math.min(top - Math.sign(delta || 0), Math.max(0, count - SHOWN)));

// items: [{ id, name, note? }]. multi: a check box (many) or a dot (one). toggle(id, cx), wheel(delta, shown, cx).
// search (optional, an InputState): a text box over the list; the rows are the items whose name has that
// text. The owner sets top to 0 when the text changes (see filterBox). A pick stays when its row is hidden.
export function chooseList(t, { id, items: all, chosen, multi, top, toggle, wheel, search }) {
  const q = (search?.value() ?? "").trim().toLowerCase();
  const items = q ? all.filter((x) => x.name.toLowerCase().includes(q)) : all;
  const first = Math.max(0, Math.min(top ?? 0, Math.max(0, items.length - SHOWN)));
  const mark = (on) => (multi
    ? div().size(14).flex_none().rounded(4).border_1().border_color(on ? t.accent : t.border).bg(on ? t.accent + "33" : t.background)
      .flex().items_center().justify_center().when(on, (e) => e.child(icon("check", t.accent, 11)))
    : div().size(14).flex_none().rounded_full().border_1().border_color(on ? t.accent : t.border).flex().items_center().justify_center()
      .when(on, (e) => e.child(div().size(7).rounded_full().bg(t.accent))));
  const list = v_flex().id(id).w_full().h(Math.max(1, Math.min(items.length, SHOWN)) * ROW + 6).p(3).flex_none().overflow_hidden()
    .rounded(7).border_1().border_color(t.border).bg(t.background)
    .on_scroll_wheel((e, cx) => wheel(e.delta.y, items.length, cx))
    .children(items.slice(first, first + SHOWN).map((x) => h_flex().id(`${id}-${x.id}`).w_full().h(ROW).px(6).gap(7).flex_none().items_center().rounded(5)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => toggle(x.id, cx))
      .child(mark(chosen.has(x.id)))
      .child(div().flex_1().min_w(0).truncate().text_size(fs.meta).child(x.name))
      .when(Boolean(x.note), (e) => e.child(div().flex_none().text_size(fs.tiny).text_color(t.dim).child(x.note)))))
    .when(items.length === 0, (e) => e.child(div().px(6).py(4).text_size(fs.meta).text_color(t.dim).child("Nothing matches.")));
  return v_flex().w_full().gap(5)
    .when(Boolean(search), (e) => e.child(filterBox(t, search)))
    .child(list)
    .when(items.length > SHOWN, (e) => e.child(div().px(4).text_size(fs.tiny).text_color(t.dim).child(`${first + 1}–${Math.min(items.length, first + SHOWN)} of ${items.length} · scroll`)));
}

// The text box of a chooseList.
export function filterBox(t, search) {
  return div().px(8).py(4).rounded(6).border_1().border_color(t.input).bg(t.background).child(Input.new(search));
}
