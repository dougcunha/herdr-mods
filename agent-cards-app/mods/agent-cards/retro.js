// The "retro" style: an 8-bit robot on a small CRT screen.
// The stage is a grid of 16 x 16 cells of 4 px. Motion goes in hard steps:
// a pixel that turns on and off is a full-block glyph with `frames`, so no
// timer redraws the mod.

import { div } from "gpui-kit";
import { settings } from "herdr";

const P = 4;
const SIZE = 64;

const mono = () => settings()?.font_family || "monospace";

// A pixel block: x, y, w and h are in cells.
const px = (x, y, w, h, color) => div().absolute().left(x * P).top(y * P).w(w * P).h(h * P).bg(color);

// A pixel block that turns on and off in steps. `seq` is a list of 0 and 1,
// one for each frame. All blocks with the same `seq` length and `ms` stay in step.
function flick(x, y, w, h, color, seq, ms) {
  const size = Math.max(w, h) * P * 2.6;
  return div().absolute().left(x * P).top(y * P).w(w * P).h(h * P).overflow_hidden()
    .flex().items_center().justify_center()
    .child(div().flex_none().font_family(mono()).text_size(size).text_color(color)
      .frames(seq.map((on) => (on ? "█" : " ")), ms)
      .child(seq[0] ? "█" : " "));
}

// Text in the mono font at a fixed spot, with optional frames.
function glyph(x, y, size, color, frames, ms) {
  const el = div().absolute().left(x).top(y).font_family(mono()).font_bold().text_size(size).text_color(color);
  return frames ? el.frames(frames, ms).child(frames[0]) : el.child("");
}

// The head and the body. `eyes` are the parts in the face.
function bot(t, shell, eyes, tip) {
  return [
    px(7, 2, 2, 1, shell),
    tip,
    px(3, 3, 10, 6, shell),
    px(4, 4, 8, 4, t.background),
    ...eyes,
    px(5, 9, 6, 3, shell),
    px(6, 10, 4, 1, t.background),
  ];
}

// Two square eyes that blink.
const blinkEyes = (t, c) => [
  px(5, 5, 2, 2, c), px(9, 5, 2, 2, c),
  flick(5, 5, 2, 2, t.background, [0, 0, 0, 0, 0, 0, 0, 1], 160),
  flick(9, 5, 2, 2, t.background, [0, 0, 0, 0, 0, 0, 0, 1], 160),
];

function working(t, shell) {
  const c = t.working;
  const N = 12;
  // A loading bar: the cells fill one by one, then the bar starts again.
  const bar = Array.from({ length: 10 }, (_, i) =>
    flick(3 + i, 14, 1, 1, c, Array.from({ length: N }, (_, f) => (f > i ? 1 : 0)), 140));
  return [
    ...bot(t, shell, blinkEyes(t, c), flick(7, 1, 2, 1, c, [1, 0], 280)),
    // The hands go up and down in turn: the robot types.
    flick(2, 9, 2, 1, shell, [1, 0], 180), flick(2, 10, 2, 1, shell, [0, 1], 180),
    flick(12, 9, 2, 1, shell, [0, 1], 180), flick(12, 10, 2, 1, shell, [1, 0], 180),
    px(1, 11, 14, 1, t.dim),
    px(2, 13, 12, 1, c + "33"), px(2, 15, 12, 1, c + "33"), px(2, 14, 1, 1, c + "33"), px(13, 14, 1, 1, c + "33"),
    ...bar,
  ];
}

function idle(t, shell) {
  const c = t.idle ?? t.dim;
  const z = (x, y, size, seq) => glyph(x, y, size, t.muted, seq.map((on) => (on ? "z" : " ")), 700);
  return [
    ...bot(t, shell, [px(5, 6, 2, 1, c), px(9, 6, 2, 1, c)], px(7, 1, 2, 1, t.dim)),
    px(2, 12, 12, 1, t.border),
    // The z marks go up one by one.
    z(46, 16, 8, [1, 1, 1, 0]),
    z(50, 8, 10, [0, 1, 1, 0]),
    z(55, -1, 12, [0, 0, 1, 0]),
  ];
}

function blocked(t, shell) {
  const c = t.blocked;
  const wave = [1, 0];
  return [
    ...bot(t, shell, [px(5, 5, 2, 3, c), px(9, 5, 2, 3, c)], flick(7, 1, 2, 1, c, [1, 0], 200)),
    // One arm waves: up, then to the side.
    flick(13, 4, 1, 4, shell, wave, 260),
    flick(11, 9, 3, 1, shell, wave.map((v) => 1 - v), 260),
    px(2, 12, 12, 1, t.border),
    // A pixel "!" that blinks.
    flick(1, 2, 1, 5, c, [1, 1, 0], 220),
    flick(1, 8, 1, 1, c, [1, 1, 0], 220),
  ];
}

function done(t, shell) {
  const c = t.done;
  // "^" eyes: 3 pixels each.
  const hat = (x) => [px(x, 6, 1, 1, c), px(x + 1, 5, 1, 1, c), px(x + 2, 6, 1, 1, c)];
  // A sparkle: a pixel "+" that shows in its turn.
  const spark = (x, y, color, seq) => [
    flick(x, y, 1, 1, color, seq, 180),
    flick(x - 1, y + 1, 3, 1, color, seq, 180),
    flick(x, y + 2, 1, 1, color, seq, 180),
  ];
  return [
    ...bot(t, shell, [...hat(4), ...hat(9)], px(7, 1, 2, 1, c)),
    // Both arms up.
    px(1, 4, 1, 4, shell), px(14, 4, 1, 4, shell),
    px(2, 12, 12, 1, t.border),
    ...spark(1, 0, t.ansi3 ?? c, [1, 0, 0, 0]),
    ...spark(14, 1, t.ansi5 ?? c, [0, 1, 0, 0]),
    ...spark(1, 13, t.ansi6 ?? c, [0, 0, 1, 0]),
    ...spark(14, 12, t.ansi2 ?? c, [0, 0, 0, 1]),
  ];
}

// Thin dark lines over the whole screen, as on an old monitor.
const scanlines = () => Array.from({ length: SIZE / 2 }, (_, i) =>
  div().absolute().left(0).top(i * 2 + 1).w(SIZE).h(1).bg("#00000026"));

export function retroStage(t, status) {
  const shell = t.muted;
  const scene = { working, idle, blocked, done }[status] ?? idle;
  const c = t[status] ?? t.dim;
  return div()
    .relative()
    .flex_none()
    .w(SIZE)
    .h(SIZE)
    .rounded(3)
    .bg(t.background)
    .border(1)
    .border_color(c + "66")
    .overflow_hidden()
    .children([div().absolute().left(0).top(0).w(SIZE).h(SIZE).bg(c + "14"), ...scene(t, shell), ...scanlines()]);
}
