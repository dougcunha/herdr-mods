// The "sheep" style: a fluffy little sheep, seen from the side, facing right.
// It jumps the fence when working, sleeps in a nightcap when idle, bleats when
// it needs you, bounces with hearts when done and chews grass while it waits.
// All motion is native (`loop`, `frames`): no timer redraws the mod.

import { div, svg } from "gpui-kit";
import { shared } from "herdr";

const SIZE = 64;

// The colors of the sheep stay the same in every theme: wool is always cream.
const WOOL = "#f8f4ec";
const SHADE = "#d6ccbe"; // the rim of the wool, so it reads on a light card too
const FACE = "#5a4a4e";
const EAR = "#4a3c40";
const PUPIL = "#1d1719";
const BLUSH = "#ff9db5";
const NOSE = "#2a2124";

// An element at a fixed spot.
const at = (el, x, y) => el.absolute().left(x).top(y);
// A box at a fixed spot.
const box = (x, y, w, h, color, r = 0) => at(div().w(w).h(h).rounded(r).bg(color), x, y);
// A circle: its top-left corner and its size.
const dot = (x, y, d, color) => box(x, y, d, d, color, d / 2);

// The puffs of wool of the body and of the top of the head: [x, y, size].
const BODY = [[2, 9, 13], [8, 3, 14], [16, 1, 15], [24, 3, 14], [28, 9, 12], [5, 14, 13], [14, 15, 13], [22, 14, 13]];
const TUFT = [[30, 3, 8], [35, 1, 8], [39, 4, 7]];

// Wool: a rim of every puff first, then the puffs, so only the outer edge shows.
const wool = (puffs) => [
  ...puffs.map(([x, y, d]) => dot(x - 1, y - 1, d + 2, SHADE)),
  ...puffs.map(([x, y, d]) => dot(x, y, d, WOOL)),
];

// The eyes, in the coordinates of the sheep.
function eyes(kind) {
  if (kind === "closed") return [box(37.5, 13, 5, 1.6, "#efe6e8", 1)];
  if (kind === "happy") return [at(div().text_size(9).font_bold().text_color("#ffffff").child("^"), 38, 8)];
  if (kind === "wide") return [dot(37.5, 10, 5.5, "#ffffff"), dot(39.5, 11.5, 2.8, PUPIL)];
  if (kind === "look") return [
    dot(38, 11, 4.5, "#ffffff"),
    div().absolute().top(12.2).w(2.4).h(2.4).rounded(1.2).bg(PUPIL).loop("left", { from: 38.3, to: 40.3, period: 1800 }),
  ];
  return [dot(38, 11, 4.5, "#ffffff"), dot(39.8, 12.2, 2.4, PUPIL)];
}

// The legs, in the coordinates of the sheep, under the body.
function legs(kind) {
  const leg = (x, h) => box(x, 24, 3.5, h, FACE, 1.5);
  // Trotting: the front and the back legs lift in turn.
  const trot = (x, from, to) => div().absolute().left(x).top(24).w(3.5).rounded(1.5).bg(FACE)
    .loop("height", { from, to, period: 300 });
  if (kind === "none") return [box(11, 24, 6, 3, FACE, 1.5), box(25, 24, 6, 3, FACE, 1.5)];
  if (kind === "tuck") return [leg(9, 5), leg(15, 4), leg(24, 4), leg(30, 5)];
  if (kind === "trot") return [trot(9, 8, 5), trot(15, 5, 8), trot(24, 8, 5), trot(30, 5, 8)];
  return [leg(9, 8), leg(15, 8), leg(24, 8), leg(30, 8)];
}

// The whole sheep, in its own coordinates (46 x 32): x 0 is the tail, y 0 the top of the wool.
function sheep({ eye = "open", leg = "stand", mouth = [], cap = null } = {}) {
  return [
    ...legs(leg),
    ...wool([[-1, 9, 8]]), // the tail
    ...wool(BODY),
    box(7, 8, 26, 17, WOOL, 8),
    box(27, 9, 8, 5, EAR, 2.5), // the ear, behind the head
    box(31, 6, 14, 16, FACE, 7),
    ...wool(TUFT),
    ...eyes(eye),
    dot(40.5, 16, 4, BLUSH + "99"),
    box(43.5, 17.5, 2, 1.4, NOSE, 0.7),
    ...mouth,
    ...(cap ? [box(32, -2, 12, 5, cap, 2.5), box(27, -1, 6, 3, cap, 1.5), dot(24.5, -1.5, 4.5, WOOL)] : []),
  ];
}

// The sheep at a spot of the stage. `motion` moves it: [property, loop policy] pairs.
function place(parts, x, y, motion = []) {
  let g = div().absolute().left(x).top(y).w(48).h(36).children(parts);
  for (const [prop, policy] of motion) g = g.loop(prop, policy);
  return g;
}

const ground = (t) => box(5, 52, 54, 3, t.border, 1.5);
const green = (t) => t.ansi2 ?? "#7bbf6a";

function working(t) {
  const c = t.working;
  const post = (x) => box(x, 40, 3, 13, t.muted, 1);
  const rail = (y) => box(21, y, 22, 2.5, t.muted, 1.2);
  // Dust in the status color, where the hooves leave the ground: in step with the jump.
  const dust = (x, y, d) => dot(x, y, d, c).loop("opacity", { from: 0.85, to: 0, period: 700, easing: "ease-out" });
  return [
    post(24), post(38), rail(43), rail(48),
    dust(4, 47, 5), dust(9, 49.5, 3.5), dust(51, 48, 4),
    // Over the fence, again and again: up fast, a float at the top, then down.
    place(sheep({ leg: "tuck" }), 9, 12, [["top", { from: 12, to: 1, period: 700, easing: "ease-out" }]]),
    ground(t),
  ];
}

function idle(t) {
  // The nightcap: blue, so it shows on the grey of idle.
  const c = t.ansi4 ?? t.accent;
  const z = (x, size, period, from, to) =>
    div().absolute().left(x).text_size(size).font_bold().text_color(t.muted)
      .loop("top", { from, to, period, easing: "linear" })
      .child(div().loop("opacity", { from: 0, to: 0.9, period: period / 2 }).child("z"));
  return [
    // Lying down, breathing slowly, in a nightcap.
    place(sheep({ eye: "closed", leg: "none", cap: c }), 6, 24, [["top", { from: 24, to: 25.5, period: 3200 }]]),
    ground(t),
    z(51, 9, 2600, 20, 8),
    z(55, 11, 3100, 13, 0),
    z(47, 8, 3700, 6, -6),
  ];
}

function blocked(t) {
  const c = t.blocked;
  // The bleat in the language of the kit: "mé!" in Portuguese, "baa!" in English.
  const bleat = shared("herdr-mods.lang") === "pt" ? "mé!" : "baa!";
  return [
    // It bleats for attention and shakes.
    place(sheep({ eye: "wide", mouth: [dot(41.5, 16.5, 3.4, "#ff7a95")] }), 8, 20,
      [["left", { from: 7, to: 9, period: 260, easing: "linear" }]]),
    ground(t),
    at(div().h(14).px(5).rounded(7).bg(c).flex().items_center().justify_center()
      .text_size(10).font_bold().text_color(t.background).child(bleat), 2, 2)
      .loop("opacity", { from: 0.45, to: 1, period: 900 }),
    dot(19, 16, 3.5, c), dot(23, 19.5, 2.2, c),
  ];
}

function done(t) {
  const c = t.done;
  const glyph = (x, y, color, list, ms) => at(div().text_size(10).text_color(color).frames(list, ms).child(list[0]), x, y);
  return [
    // Happy little bounces in place.
    place(sheep({ eye: "happy" }), 8, 20, [["top", { from: 20, to: 15, period: 760, easing: "ease-out" }]]),
    ground(t),
    glyph(2, 4, BLUSH, ["♥", " ", "♥", "♥"], 260),
    glyph(54, 18, t.ansi3 ?? c, ["✦", "✧", "★", "✧"], 220),
    glyph(4, 30, t.ansi6 ?? c, [" ", "✧", "✦", " "], 240),
    glyph(54, 38, c, ["♥", "♥", " ", "♥"], 300),
  ];
}

function waiting(t) {
  const c = t.waiting ?? t.dim;
  const g = green(t);
  // A blade of grass in the mouth: it gets shorter and longer as it chews.
  const blade = div().absolute().left(44).top(18).h(1.6).rounded(0.8).bg(g).loop("width", { from: 6, to: 3, period: 500 });
  const tuft = (x) => [box(x, 48, 1.6, 4, g, 0.8), box(x + 2.5, 47, 1.6, 5, g, 0.8), box(x + 5, 48.5, 1.6, 3.5, g, 0.8)];
  return [
    place(sheep({ eye: "look", mouth: [blade] }), 6, 20, [["top", { from: 20, to: 20.8, period: 1000 }]]),
    ...tuft(52), ...tuft(2),
    ground(t),
    at(svg("mods/agent-cards/hourglass.svg").size(14).text_color(c).loop("opacity", { from: 0.4, to: 1, period: 1800 }), 48, 2),
  ];
}

export function sheepStage(t, status) {
  const scene = { working, idle, blocked, done, waiting }[status] ?? idle;
  const tint = t[status] ?? t.dim;
  return div()
    .relative()
    .flex_none()
    .w(SIZE)
    .h(SIZE)
    .rounded(10)
    .bg(tint + "1f")
    .overflow_hidden()
    .children(scene(t));
}
