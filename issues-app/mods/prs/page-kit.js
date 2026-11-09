// The parts an issue or pull request page is built from, laid out like GitHub's own pages:
// a header that stays put (position, actions, big title, state badge, byline), optional tabs,
// a conversation timeline with a sidebar of properties (one column when narrow), and a
// footer with the keys. Source: the repository's shared/, copied into each mod.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { fs, icon, avatar, AGENT_STATUS, button, tint, iconButton } from "./links.js";

// From this width the sidebar sits beside the conversation; narrower, its sections wrap above it.
export const PAGE_WIDE = 700;

export function kit(t) {
  const k = {};
  k.kbd = (text, on = false) => div().px(4).rounded(4).border_1().border_b_2().border_color(on ? t.foreground + "55" : t.border)
    .text_size(fs.tiny - 1).text_color(on ? t.background : t.muted).child(text);
  // The kit's button (links.js). `primary`: the page's main action. Its key shows in the page footer, not
  // on the button (`o.hint` is ignored). The press must not drag the window.
  k.button = (id, label, onClick, o = {}) => button(t, id, label, onClick, { kind: o.primary ? "primary" : "plain", icon: o.icon })
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation());
  // ↑ and ↓ of a page dialog: small buttons of the kit.
  k.arrow = (id, glyph, onClick, enabled) => button(t, id, glyph, onClick, { small: true, disabled: !enabled });
  // A state as GitHub shows it: a filled, rounded badge with an icon.
  k.badge = (label, color, iconName) => h_flex().flex_none().gap(5).items_center().px(10).py(2).rounded_full().bg(color)
    .text_color(t.background).text_size(fs.meta).font_semibold()
    .when(Boolean(iconName), (e) => e.child(icon(iconName, t.background, 13))).child(label);
  k.pill = (text, fg) => div().flex_none().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(fs.tiny).text_color(fg ?? t.muted).child(text);
  k.label = (text) => div().flex_none().px(8).rounded_full().border_1().border_color(t.ansi3 + "88").bg(t.ansi3 + "1f").text_size(fs.tiny).text_color(t.foreground).child(text);
  k.code = (text) => div().flex_none().px(6).rounded(5).bg(t.surface).text_size(fs.meta).text_color(t.accent).font_family("Menlo").child(text);
  // A property in the sidebar: a small heading (with an optional count on the right) and its value.
  k.section = (title, body, extra) => v_flex().gap(5).min_w(0)
    .child(h_flex().text_size(fs.tiny).font_semibold().text_color(t.muted).child(div().flex_1().child(title)).when(Boolean(extra), (e) => e.child(extra)))
    .child(body);
  k.person = (name, label = name) => h_flex().gap(6).items_center().min_w(0).text_size(fs.meta)
    .child(avatar(name, t, 20)).child(div().min_w(0).truncate().child(label ?? "Nobody"));
  // One entry of the timeline: initials in the left column, a box with a header bar.
  k.card = (id, who, verb, at, body) => h_flex().id(id).gap(10).items_start()
    .child(avatar(who, t, 28))
    .child(v_flex().flex_1().min_w(0).rounded(8).border_1().border_color(t.border).overflow_hidden()
      .child(h_flex().gap(6).items_center().px(10).py(5).bg(t.surface).border_b_1().border_color(t.border).text_size(fs.meta).text_color(t.muted)
        .child(div().font_semibold().text_color(t.foreground).child(who ?? "?")).child(verb).child(div().text_color(t.dim).child(at)))
      .child(div().px(12).py(10).child(body)));
  // A small event between the cards: who did what, when.
  k.event = (id, who, text, at, color) => h_flex().id(id).gap(6).items_center().pl(38).text_size(fs.meta).text_color(t.muted)
    .child(div().w(8).h(8).rounded(4).flex_none().bg(color ?? t.border))
    .child(avatar(who, t, 16)).child(div().font_semibold().text_color(t.foreground).child(who ?? "?"))
    .child(div().min_w(0).truncate().child(text)).child(div().flex_none().text_color(t.dim).child(at));
  // A fact under the title (priority, points, sprint): a tinted pill with an icon. `strong`: filled in its color.
  k.chip = (iconName, text, color = t.muted, strong = false) => h_flex().flex_none().gap(5).items_center().h(22).px(8).rounded_full()
    .border_1().border_color(tint(color, strong ? "99" : "55")).bg(tint(color, strong ? "33" : "14"))
    .text_size(fs.meta).text_color(strong ? color : t.foreground).when(strong, (e) => e.font_semibold())
    .when(Boolean(iconName), (e) => e.child(icon(iconName, color, 12))).child(text);
  // A small tag of a list (a version, a component).
  k.tag = (text, color = t.muted) => div().flex_none().px(7).py(1).rounded(5).bg(tint(color, "1f")).text_size(fs.tiny).text_color(color === t.muted ? t.foreground : color).child(text);
  // The Details card of the sidebar: rows of [label, value, icon?]; a falsy row is left out.
  // `fold` ({ open, toggle(cx) }, optional): a click on the title collapses or expands the rows.
  k.facts = (title, rows, fold) => v_flex().w_full().min_w(0).rounded(10).border_1().border_color(t.border).bg(t.surface).overflow_hidden()
    .child(h_flex().id(`facts-${title}`).px(12).pt(9).pb(fold && !fold.open ? 9 : 7).gap(6).items_center().text_size(fs.tiny).font_semibold().text_color(t.muted)
      .when(Boolean(fold), (e) => e.cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => fold.toggle(cx)))
      .child(div().flex_1().child(title))
      .when(Boolean(fold), (e) => e.child(icon(fold.open ? "chevron-down" : "chevron-right", t.dim, 13))))
    .children(fold && !fold.open ? [] : rows.filter(Boolean).map(([label, value, iconName]) => h_flex().min_h(32).px(12).py(5).gap(8).items_center().border_t_1().border_color(t.border)
      .child(h_flex().w(92).flex_none().gap(6).items_center().text_size(fs.tiny).text_color(t.muted)
        .child(iconName ? icon(iconName, t.dim, 12) : div().w(12).flex_none()).child(div().truncate().child(label)))
      .child(div().flex_1().min_w(0).text_size(fs.meta).child(value))));
  // A block of text (the description, a refinement): a rounded panel.
  k.panel = (id, body) => div().id(id).w_full().px(16).py(14).rounded(10).border_1().border_color(t.border).child(body);
  k.tabs = (current, list, pick) => h_flex().flex_none().gap(2).px(14).border_b_1().border_color(t.border).text_size(fs.meta)
    .children(list.map(([id, label, count]) => h_flex().id(`tab-${id}`).gap(6).items_center().px(10).py(7).cursor_pointer()
      .border_b_2().border_color(id === current ? t.accent : t.background)
      .text_color(id === current ? t.foreground : t.muted).when(id === current, (e) => e.font_semibold())
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => pick(id, cx))
      .child(label).when(count != null, (e) => e.child(div().px(6).rounded_full().bg(t.selected).text_size(fs.tiny).text_color(t.muted).child(String(count))))));
  // Agent spaces working on this item (links.js agentSpaces), each with its status and Go to space.
  // `go(id)`: goes to that space (and closes the page dialog when the page is one).
  k.agents = (list, go) => (list?.length ? k.section("Agent", v_flex().gap(6).children(list.map((a, n) => {
    const [label, c] = AGENT_STATUS[a.status] ?? AGENT_STATUS.idle;
    return h_flex().id(`agent-row-${n}`).gap(6).items_center().min_w(0).text_size(fs.meta)
      .child(div().size(8).flex_none().rounded_full().bg(t[c]))
      .child(v_flex().flex_1().min_w(0).child(div().truncate().child(a.name)).child(div().text_size(fs.tiny).text_color(t[c]).child(`${label} · ${a.mode === "work" ? "agent" : a.mode}`)))
      .child(button(t, `go-${n}`, "Go", () => go(a.id), { small: true }));
  }))) : null);
  k.footer = (keys) => h_flex().flex_none().flex_wrap().gap(14).px(14).py(6).border_t_1().border_color(t.border).bg(t.surface).text_size(fs.tiny).text_color(t.muted)
    .children(keys.map(([ks, text]) => h_flex().gap(4).items_center().children(ks.map((x) => k.kbd(x))).child(text)));
  return k;
}

// The whole page. `p`: { id, t, wide, nav, actions, title, key, status (a row under the title),
// tabs, main (children), side (sections), footer }. The header and footer stay put; the
// conversation and the sidebar scroll on their own.
export function pageLayout(p) {
  const t = p.t;
  const header = v_flex().flex_none().gap(8).px(16).pt(12).pb(10).border_b_1().border_color(t.border)
    .child(h_flex().gap(6).items_center().pr(28).child(p.nav ?? div()).child(div().flex_1()).children(p.actions))
    .child(h_flex().gap(8).items_baseline().min_w(0)
      .child(div().min_w(0).font_semibold().text_size(fs.title + 5).line_height(1.3).child(p.title))
      .child(div().flex_none().text_size(fs.title + 3).text_color(t.dim).child(p.key))
      // `copy(cx)` (optional): a button that copies the key.
      .when(Boolean(p.copy), (e) => e.child(div().flex_none().self_center().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(iconButton(t, `${p.id}-copy-key`, "copy", (cx) => p.copy(cx), { tooltip: "Copy key", size: 24 })))))
    .child(p.status);
  const main = v_flex().gap(12).children(p.main);
  // A side entry ["full", element] (the Details card) takes the whole width when the page is narrow.
  const isFull = (s) => Array.isArray(s) && s[0] === "full";
  const side = p.side.filter(Boolean);
  const full = side.filter(isFull).map((s) => s[1]), small = side.filter((s) => !isFull(s));
  const body = p.wide
    ? h_flex().flex_1().min_h(0).items_start()
      .child(v_flex().id(`${p.id}-main`).flex_1().min_w(0).h_full().overflow_y_scrollbar().px(16).py(14).child(main))
      .child(v_flex().id(`${p.id}-side`).w(260).flex_none().h_full().overflow_y_scrollbar().px(14).py(12).gap(14).border_l_1().border_color(t.border).children(side.map((s) => (isFull(s) ? s[1] : s))))
    : v_flex().id(`${p.id}-main`).flex_1().min_h(0).overflow_y_scrollbar().px(16).py(14).gap(14)
      .children(full)
      .when(small.length > 0, (e) => e.child(h_flex().flex_wrap().gap_x(20).gap_y(12).pb(12).border_b_1().border_color(t.border)
        .children(small.map((s) => div().w(190).child(s)))))
      .child(main);
  return v_flex().id(p.id).size_full().min_h(0).bg(t.background)
    .child(header).when(Boolean(p.tabs), (e) => e.child(p.tabs)).child(body)
    .when(Boolean(p.footer), (e) => e.child(p.footer));
}
