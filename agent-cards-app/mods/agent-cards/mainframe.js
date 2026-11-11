// The "mainframe" style: the computer room of the first computers.
// A tape drive (2 reels and a read head) on top, a row of panel lamps, and a
// punched card in the reader at the bottom.
// All motion is native (`loop`, `frames`, `spin`): no timer redraws the mod.
// A lamp or a hole that turns on and off is a full-block glyph with `frames`,
// as in the retro style, so it changes in hard steps.

import { div, svg } from "gpui-kit";
import { settings } from "herdr";

const SIZE = 64;

// The colors of the paper card, of its holes and of the magnetic tape.
// They stay the same in every theme: a punched card is always buff.
const CARD = "#e6d8a8";
const HOLE = "#3b3226";
const TAPE = "#8a5a32";

const mono = () => settings()?.font_family || "monospace";

// A box at a fixed spot, in px.
const box = (x, y, w, h, color, r = 0) => div().absolute().left(x).top(y).w(w).h(h).rounded(r).bg(color);

// A box that turns on and off in steps. `seq` is a list of 0 and 1, one for
// each frame. All boxes with the same `seq` length and `ms` stay in step.
function flick(x, y, w, h, color, seq, ms) {
  const size = Math.max(w, h) * 2.6;
  return div().absolute().left(x).top(y).w(w).h(h).overflow_hidden()
    .flex().items_center().justify_center()
    .child(div().flex_none().font_family(mono()).text_size(size).text_color(color)
      .frames(seq.map((on) => (on ? "█" : " ")), ms)
      .child(seq[0] ? "█" : " "));
}

// ---- The tape drive -------------------------------------------------------

// The 2 reels: their centers, and the size of a reel.
const REELS = [{ x: 16, y: 14 }, { x: 48, y: 14 }];
const REEL = 22;

// The tape wound on a reel: a brown disc behind it, seen through its windows.
// With `to`, the disc grows or shrinks: the tape goes from one reel to the other.
function pack(c, d, to, period) {
  const disc = div().flex_none().bg(TAPE).rounded(Math.max(d, to ?? d));
  // A box of the reel's size centers the disc, so only its size moves:
  // loops of the position and of the size do not stay in step.
  return div().absolute().left(c.x - REEL / 2).top(c.y - REEL / 2).w(REEL).h(REEL)
    .flex().items_center().justify_center()
    .child(to == null ? disc.w(d).h(d)
      : disc.loop("width", { from: d, to, period }).loop("height", { from: d, to, period }));
}

// A reel. With `ms`, it turns once every `ms`.
function reel(c, color, ms) {
  const el = svg("mods/agent-cards/reel.svg").absolute().left(c.x - REEL / 2).top(c.y - REEL / 2).size(REEL).text_color(color);
  return ms ? el.spin(ms) : el;
}

// The drive: the tape packs, the tape between the reels, the read head and the
// reels. `packs` is [left, right] as [size, size to] (or [size]); `ms` turns the reels.
function drive(t, { packs = [[16], [16]], ms = 0, head = t.muted } = {}) {
  const shell = t.muted;
  return [
    ...REELS.map((c, i) => pack(c, packs[i][0], packs[i][1], packs[i][2] ?? 6000)),
    box(REELS[0].x, 24, REELS[1].x - REELS[0].x, 1, TAPE),
    box(28, 21, 8, 5, head, 1),
    ...REELS.map((c) => reel(c, shell, ms)),
    box(3, 28, SIZE - 6, 1, t.border),
  ];
}

// ---- The panel lamps ------------------------------------------------------

const LAMPS = 7;
const lampX = (i) => 11 + i * 7;
const LAMP_Y = 31;

// The lamps, all off.
const lampsOff = (c) => Array.from({ length: LAMPS }, (_, i) => box(lampX(i), LAMP_Y, 3, 3, c + "30"));

// The lamps, each one turning on and off with its own list of frames.
const lamps = (c, seqs, ms) => [
  ...lampsOff(c),
  ...seqs.map((seq, i) => flick(lampX(i), LAMP_Y, 3, 3, c, seq, ms)),
];

// A light that runs from left to right along the lamps.
const chase = () => Array.from({ length: LAMPS }, (_, i) => Array.from({ length: LAMPS }, (_, f) => (f === i ? 1 : 0)));

// ---- The punched card -----------------------------------------------------

// The columns and rows of the holes, in px.
const COLS = 9;
const colX = (i) => 14 + i * 4;
const ROWS = [42, 46, 50, 54];
// The rows punched in each column: 2 rows, picked so that the card looks coded.
const punched = (i) => [...new Set([(i * 3) % 4, (i * 5 + 1) % 4])];

// The card at (x, y), and the holes of its first `cols` columns.
function card(x, y, cols) {
  const dy = y - 38;
  const dx = x - 10;
  return [
    svg("mods/agent-cards/card.svg").absolute().left(x).top(y).w(44).h(20).text_color(CARD),
    ...Array.from({ length: cols }, (_, i) => punched(i).map((r) => box(colX(i) + dx, ROWS[r] + dy, 2, 2, HOLE))).flat(),
  ];
}

// The holes punched one column at a time, then a new card: a keypunch.
function punching(ms) {
  const N = COLS + 3;
  return Array.from({ length: COLS }, (_, i) =>
    punched(i).map((r) => flick(colX(i), ROWS[r], 2, 2, HOLE, Array.from({ length: N }, (_, f) => (f > i ? 1 : 0)), ms))).flat();
}

// The slot of the card reader, under the card.
const reader = (t) => box(4, 58, SIZE - 8, 3, t.dim, 1);

// ---- The scenes -----------------------------------------------------------

function working(t) {
  const c = t.working;
  // Each lamp blinks with its own pattern: the machine computes.
  const seqs = [[1, 0, 1, 1, 0, 0], [0, 1, 1, 0, 1, 0], [1, 1, 0, 0, 0, 1], [0, 0, 1, 0, 1, 1],
    [1, 0, 0, 1, 1, 0], [0, 1, 0, 1, 0, 1], [1, 1, 1, 0, 0, 0]];
  return [
    // The tape goes from the left reel to the right reel, and back.
    ...drive(t, { packs: [[20, 12], [12, 20]], ms: 1100, head: c }),
    ...lamps(c, seqs, 170),
    ...card(10, 38, 0),
    ...punching(150),
    reader(t),
  ];
}

function idle(t) {
  const c = t.idle ?? t.dim;
  const z = (x, size, period, from, to) =>
    div().absolute().left(x).text_size(size).font_bold().text_color(t.muted)
      .loop("top", { from, to, period, easing: "linear" })
      .child(div().loop("opacity", { from: 0, to: 0.9, period: period / 2 }).child("z"));
  return [
    // The reels stand still. Only the power lamp glows, slowly.
    ...drive(t),
    ...lampsOff(c),
    box(lampX(0), LAMP_Y, 3, 3, c).loop("opacity", { from: 0.25, to: 1, period: 3200 }),
    ...card(10, 38, COLS),
    reader(t),
    // The "z" letters rise between the reels.
    z(29, 7, 2600, 18, 6),
    z(31, 9, 3100, 14, 0),
  ];
}

function blocked(t) {
  const c = t.blocked;
  // The card is stuck half out of the reader and shakes: the operator must come.
  const jam = div().absolute().top(0).w(SIZE).h(SIZE)
    .loop("left", { from: -1, to: 1, period: 220, easing: "linear" })
    .children(card(10, 35, 5));
  return [
    ...drive(t),
    // All the lamps blink at the same time.
    ...lamps(c, Array.from({ length: LAMPS }, () => [1, 0]), 260),
    jam,
    reader(t),
    box(26, 2, 12, 12, c, 4).flex().items_center().justify_center()
      .text_size(10).font_bold().text_color(t.background).child("!")
      .loop("opacity", { from: 0.35, to: 1, period: 900 }),
  ];
}

function done(t) {
  const c = t.done;
  // The finished card jumps out of the reader, with all its holes.
  const out = div().absolute().left(0).w(SIZE).h(SIZE)
    .loop("top", { from: 0, to: -4, period: 700, easing: "ease-out" })
    .children(card(10, 38, COLS));
  const spark = (x, y, color, ms) => div().absolute().left(x).top(y).text_size(8).text_color(color)
    .frames(["✦", "✧", "★", "✧"], ms).child("✦");
  return [
    // The tape rewinds fast, and a light runs along the lamps.
    ...drive(t, { ms: 450, head: c }),
    ...lamps(c, chase(), 110),
    out,
    reader(t),
    spark(1, 37, t.ansi3 ?? c, 220),
    spark(56, 41, t.ansi5 ?? c, 260),
    spark(29, 2, t.ansi6 ?? c, 240),
  ];
}

function waiting(t) {
  const c = t.waiting ?? t.dim;
  return [
    // The tape creeps on slowly, and a slow light runs along the lamps:
    // the jobs of the batch run in the background.
    ...drive(t, { ms: 4200 }),
    ...lamps(c, chase(), 450),
    ...card(10, 38, 4),
    reader(t),
    svg("mods/agent-cards/hourglass.svg").absolute().left(26).top(3).size(12).text_color(c)
      .loop("opacity", { from: 0.4, to: 1, period: 1800 }),
  ];
}

export function mainframeStage(t, status) {
  const scene = { working, idle, blocked, done, waiting }[status] ?? idle;
  const c = t[status] ?? t.dim;
  return div()
    .relative()
    .flex_none()
    .w(SIZE)
    .h(SIZE)
    .rounded(4)
    .bg(t.background)
    .border(1)
    .border_color(c + "66")
    .overflow_hidden()
    .children([div().absolute().left(0).top(0).w(SIZE).h(SIZE).bg(c + "14"), ...scene(t)]);
}
