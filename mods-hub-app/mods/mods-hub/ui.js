// Small controls of the Settings tab: a switch, a segmented control, a stepper,
// a text button and key caps.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";

/** A color with an alpha suffix (`"#rrggbb" + "aa"`). Other colors pass through. */
export const tint = (color, alpha = "24") => (/^#[0-9a-f]{6}$/i.test(color || "") ? color + alpha : color);

/** A 34×18 switch. */
export function toggle(t, id, on, onClick) {
  return div().id(id).flex_none().w(34).h(18).rounded(9).p(2).cursor_pointer()
    .bg(on ? t.accent : t.input)
    .on_click((_e, cx) => onClick(cx))
    .child(h_flex().size_full().when(on, (el) => el.justify_end())
      .child(div().size(14).rounded(7).bg(on ? t.accent_foreground : t.muted)));
}

/** A row of options; the chosen one is lit. `options`: [{ value, label }]. */
export function segmented(t, id, options, value, onPick) {
  return h_flex().flex_none().flex_wrap().p(2).gap(2).rounded(7).bg(t.background).border_1().border_color(t.border)
    .children(options.map((o, i) => {
      const on = o.value === value;
      return h_flex().id(`${id}-${i}`).h(22).px(9).items_center().rounded(5).cursor_pointer().text_size(12)
        .bg(on ? tint(t.accent, "2e") : t.background).text_color(on ? t.accent : t.muted)
        .when(on, (el) => el.font_semibold())
        .hover((st) => st.bg(on ? tint(t.accent, "40") : t.hover))
        .on_click((_e, cx) => onPick(o.value, cx))
        .child(String(o.label ?? o.value));
    }));
}

/** − value + */
export function stepper(t, id, label, onDown, onUp) {
  const button = (key, text, fn) => div().id(`${id}-${key}`).size(22).rounded(5).flex().items_center().justify_center()
    .cursor_pointer().border_1().border_color(t.border).text_color(t.muted)
    .hover((st) => st.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => fn(cx))
    .child(text);
  return h_flex().flex_none().gap(6).items_center()
    .child(button("down", "−", onDown))
    .child(div().min_w(44).flex().justify_center().text_size(12.5).child(label))
    .child(button("up", "+", onUp));
}

/** A 24 px text button. `tone`: "primary", "danger" or none. */
export function textButton(t, id, label, onClick, { tone = "" } = {}) {
  const color = tone === "danger" ? t.blocked : tone === "primary" ? t.accent : t.foreground;
  return h_flex().id(id).h(24).px(10).flex_none().items_center().rounded(6).cursor_pointer().text_size(12)
    .border_1().border_color(tone ? color : t.border).text_color(color)
    .bg(tone ? tint(color, "1f") : t.popover)
    .hover((st) => st.bg(tone ? tint(color, "33") : t.hover))
    .on_click((_e, cx) => onClick(cx))
    .child(label);
}

/** A key cap: "Ctrl+P". */
export function kbd(t, label) {
  return div().h(20).px(6).flex().items_center().rounded(5).text_size(11.5).font_semibold()
    .bg(t.raised).border_1().border_color(t.border).text_color(t.foreground).child(label);
}
