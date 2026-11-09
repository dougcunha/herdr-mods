// The "modern" style: a soft orb in the status color, with rings that turn,
// breathe or ripple. All motion is native (`loop`, `spin`): no timer redraws the mod.

import { div, svg } from "gpui-kit";

const SIZE = 64;
const C = SIZE / 2;

// A circle with its center at (C, C) that grows from d1 to d2 and back.
// The size and the position use the same period and easing, so the circle stays centered.
const orb = (d1, d2, period) => div().absolute().rounded(d2)
  .loop("width", { from: d1, to: d2, period })
  .loop("height", { from: d1, to: d2, period })
  .loop("left", { from: C - d1 / 2, to: C - d2 / 2, period })
  .loop("top", { from: C - d1 / 2, to: C - d2 / 2, period });

// A circle at rest, with its center at (C, C).
const disc = (d) => div().absolute().left(C - d / 2).top(C - d / 2).w(d).h(d).rounded(d / 2);

// A ring of the shipped spinner, with its center at (C, C).
const arc = (d, color, period) => svg("mods/workspace-chrome/spinner.svg").absolute().left(C - d / 2).top(C - d / 2)
  .size(d).text_color(color).spin(period);

function working(t) {
  const c = t.working;
  return [
    orb(30, 40, 1600).bg(c + "1c"),
    arc(46, c, 1100),
    arc(32, c + "88", 1700),
    orb(12, 16, 1600).bg(c),
  ];
}

function idle(t) {
  const c = t.idle ?? t.dim;
  return [
    disc(30).border(1.5).border_color(c + "55"),
    orb(10, 15, 4200).bg(c).loop("opacity", { from: 0.35, to: 0.8, period: 4200 }),
  ];
}

function blocked(t) {
  const c = t.blocked;
  return [
    orb(26, 56, 1300).border(2).border_color(c).loop("opacity", { from: 0.9, to: 0, period: 1300 }),
    orb(26, 30, 650).bg(c).flex().items_center().justify_center()
      .text_size(15).font_bold().text_color(t.background).child("!"),
  ];
}

function done(t) {
  const c = t.done;
  // Small dots that fly out from the orb and fade.
  const dot = (dx, dy, color, period) => div().absolute().w(4).h(4).rounded(2).bg(color)
    .loop("left", { from: C - 2 + dx * 12, to: C - 2 + dx * 27, period, easing: "ease-out" })
    .loop("top", { from: C - 2 + dy * 12, to: C - 2 + dy * 27, period, easing: "ease-out" })
    .loop("opacity", { from: 1, to: 0, period, easing: "ease-out" });
  const d = Math.SQRT1_2;
  return [
    disc(36).bg(c + "1c"),
    dot(1, 0, t.ansi3 ?? c, 1400),
    dot(-1, 0, t.ansi5 ?? c, 1400),
    dot(0, -1, t.ansi6 ?? c, 1600),
    dot(d, d, t.ansi2 ?? c, 1600),
    dot(-d, d, c, 1500),
    dot(d, -d, c, 1500),
    orb(24, 27, 900).bg(c).flex().items_center().justify_center()
      .child(svg("mods/workspace-chrome/check.svg").size(14).text_color(t.background)),
  ];
}

export function modernStage(t, status) {
  const scene = { working, idle, blocked, done }[status] ?? idle;
  const c = t[status] ?? t.dim;
  return div()
    .relative()
    .flex_none()
    .w(SIZE)
    .h(SIZE)
    .rounded(16)
    .bg(c + "12")
    .border(1)
    .border_color(c + "26")
    .overflow_hidden()
    .children(scene(t));
}
