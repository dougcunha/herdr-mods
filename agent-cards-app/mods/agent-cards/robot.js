// A small robot drawn with divs, one scene for each agent status.
// All motion is native (`loop`, `frames`, `spin`): no timer redraws the mod.

import { div, svg } from "gpui-kit";
import { retroStage } from "./retro.js";
import { modernStage } from "./modern.js";
import { mainframeStage } from "./mainframe.js";
import { sheepStage } from "./sheep.js";

export const STAGE = 64;

// An element at a fixed spot in the stage.
const at = (el, x, y) => el.absolute().left(x).top(y);
// A box at a fixed spot.
const box = (x, y, w, h, color, r = 0) => at(div().w(w).h(h).rounded(r).bg(color), x, y);
// A box that moves up and down between y1 and y2.
const bob = (x, y1, y2, w, h, color, r, period, easing = "ease-in-out") =>
  div().absolute().left(x).w(w).h(h).rounded(r).bg(color).loop("top", { from: y1, to: y2, period, easing });

// The head: antenna, shell, face plate and eyes. `dy` moves the whole head down.
function head(t, s, eyes, bulb) {
  return [
    box(31, 7, 2, 8, s.shell),
    bulb,
    box(16, 14, 32, 24, s.shell, 8),
    box(19, 17, 26, 18, t.background, 5),
    ...eyes,
  ];
}

// Two round eyes in the status color.
const roundEyes = (y, size, color) => [box(32 - 5 - size, y, size, size, color, size / 2), box(32 + 5, y, size, size, color, size / 2)];
// Two closed eyes: short lines.
const closedEyes = (y, color) => [box(23, y, 7, 2, color, 1), box(34, y, 7, 2, color, 1)];

// The head group: every part of the head moves with it.
function headGroup(parts, motion) {
  const g = div().absolute().left(0).w(STAGE).h(STAGE).children(parts);
  return motion ? g.loop("top", motion) : g.top(0);
}

function working(t, s) {
  const c = t.working;
  return [
    headGroup(head(t, s, roundEyes(26, 5, c), box(29, 3, 6, 6, c, 3).loop("opacity", { from: 0.35, to: 1, period: 500 })),
      { from: 0, to: 1.5, period: 520 }),
    // The back of a laptop hides the body.
    box(12, 40, 40, 18, t.input, 4),
    box(30, 47, 4, 4, c, 2).loop("opacity", { from: 0.3, to: 0.9, period: 1400 }),
    // The hands type on the keys.
    bob(8, 44, 47, 6, 5, s.shell, 3, 260),
    bob(50, 47, 44, 6, 5, s.shell, 3, 300),
    box(6, 58, 52, 3, t.dim, 1),
    at(svg("mods/agent-cards/gear.svg").size(13).text_color(c).spin(1600), 47, 1),
  ];
}

function idle(t, s) {
  const c = t.idle ?? t.dim;
  const z = (x, size, period, from, to) =>
    div().absolute().left(x).text_size(size).font_bold().text_color(t.muted)
      .loop("top", { from, to, period, easing: "linear" })
      .child(div().loop("opacity", { from: 0, to: 0.9, period: period / 2 }).child("z"));
  return [
    headGroup(head(t, s, closedEyes(27, c), box(29, 3, 6, 6, t.dim, 3).opacity(0.5)),
      { from: 1, to: 3, period: 3200 }),
    box(19, 41, 26, 16, s.shell, 6),
    box(10, 57, 44, 4, t.border, 2),
    z(50, 9, 2600, 16, 4),
    z(55, 11, 3100, 10, -4),
    z(45, 8, 3700, 4, -8),
  ];
}

function blocked(t, s) {
  const c = t.blocked;
  return [
    headGroup(head(t, s, roundEyes(23, 7, c), box(29, 3, 6, 6, c, 3).loop("opacity", { from: 0.2, to: 1, period: 400 })), null)
      .loop("left", { from: -1, to: 1, period: 260, easing: "linear" }),
    box(19, 41, 26, 16, s.shell, 6),
    // One arm waves for attention.
    bob(46, 28, 33, 5, 14, s.shell, 3, 520),
    box(10, 57, 44, 4, t.border, 2),
    at(div().w(15).h(15).rounded(5).bg(c).flex().items_center().justify_center()
      .text_size(11).font_bold().text_color(t.background).child("!"), 2, 4)
      .loop("opacity", { from: 0.35, to: 1, period: 900 }),
  ];
}

function done(t, s) {
  const c = t.done;
  const happy = (x) => at(div().text_size(11).font_bold().text_color(c).child("^"), x, 22);
  const spark = (x, color, period, from, to) =>
    div().absolute().left(x).w(4).h(4).rounded(1).bg(color)
      .loop("top", { from, to, period, easing: "ease-out" });
  const robot = div().absolute().left(0).w(STAGE).h(STAGE)
    .loop("top", { from: 0, to: -5, period: 700, easing: "ease-out" })
    .children([...head(t, s, [happy(24), happy(35)], box(29, 3, 6, 6, c, 3)), box(19, 41, 26, 14, s.shell, 6)]);
  return [
    robot,
    box(10, 57, 44, 4, t.border, 2),
    spark(4, t.ansi3 ?? c, 900, 20, 8),
    spark(56, t.ansi5 ?? c, 1100, 16, 4),
    spark(9, t.ansi6 ?? c, 1300, 6, 0),
    spark(52, t.ansi2 ?? c, 800, 30, 22),
    at(div().text_size(10).text_color(c).frames(["✦", "✧", "★", "✧"], 220).child("✦"), 50, 0),
  ];
}

function waiting(t, s) {
  const c = t.waiting ?? t.dim;
  // The eyes look from side to side: the robot watches its background jobs.
  const eyes = div().absolute().top(0).w(STAGE).h(STAGE).loop("left", { from: -2, to: 2, period: 1800 }).children(roundEyes(26, 5, c));
  return [
    headGroup(head(t, s, [eyes], box(29, 3, 6, 6, c, 3).loop("opacity", { from: 0.35, to: 1, period: 1800 })),
      { from: 0, to: 1, period: 2400 }),
    box(19, 41, 26, 16, s.shell, 6),
    box(10, 57, 44, 4, t.border, 2),
    at(svg("mods/agent-cards/hourglass.svg").size(14).text_color(c).loop("opacity", { from: 0.4, to: 1, period: 1800 }), 47, 2),
  ];
}

// The animation styles. "robot" is the first style; the others are in their own files.
export const STYLES = ["robot", "retro", "modern", "mainframe", "sheep"];

// The stage: a tinted square with the scene of the status, in the given style.
export function stage(t, status, style = "robot") {
  if (style === "retro") return retroStage(t, status);
  if (style === "modern") return modernStage(t, status);
  if (style === "mainframe") return mainframeStage(t, status);
  if (style === "sheep") return sheepStage(t, status);
  return robotStage(t, status);
}

function robotStage(t, status, size = STAGE) {
  const s = { shell: t.muted };
  const scene = { working, idle, blocked, done, waiting }[status] ?? idle;
  const tint = t[status] ?? t.dim;
  return div()
    .relative()
    .flex_none()
    .w(size)
    .h(size)
    .rounded(10)
    .bg(tint + "1f")
    .overflow_hidden()
    .children(scene(t, s));
}
