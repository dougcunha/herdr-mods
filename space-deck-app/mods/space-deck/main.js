// Space Deck: a Spaces sidebar with cards or a list. Each space has an icon,
// a color and a note (kept by the folder of its repo, so they come back when
// the space opens again). Pinned spaces stay on top. A card shows the agents,
// tabs, terminals, git status, folder and last activity of the space. Under a
// space, one row for each terminal shows its agent status and closes it. The +
// opens repo-launcher when it is installed. Recent closed spaces open again
// with one click.
//
// The same mod draws its popups: props().part names the popup (overlays.js).
//
// Commands (herdr-app do space-deck.<command>): view, needs-you, demo, and for the
// shown space: icon, note, pin, menu, agent.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, run, theme, shared, setShared, props, nextCommand, readTextFile, appHome, home, closeOverlay } from "herdr";
import { Git } from "./git.js";
import { rows, sections, recentRows, needsYou } from "./model.js";
import { KEYS, item, pins, pinAt, unpin, view, cardField, gitEvery, needsYouFirst, recentCount, terminalsMode, touch, fillOf, PALETTE } from "./store.js";
import { overlayFor, popup, programIcon, tile } from "./overlays.js";
import { demoModel } from "./demo.js";

// The mods-hub can turn this mod off (shared "herdr-mods.disabled", a list of mod names). Then the mod draws
// nothing, closes its dialog and skips its timed work. The bars hide its blocks and buttons.
const kitOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes("space-deck"); };
const offView = () => { const o = props()?.overlay; if (o) closeOverlay(o); return div(); };

const MOD = "space-deck";
const ICON = (name) => `mods/${MOD}/${name}.svg`;

/** "now", "5m", "3h", "2d". */
function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** A folder for people: "~" for home, and only the last 2 parts. */
function shortFolder(folder) {
  let f = String(folder || "").replace(/\\/g, "/");
  const h = String(home() || "").replace(/\\/g, "/");
  if (h && f.toLowerCase().startsWith(h.toLowerCase())) f = `~${f.slice(h.length)}`;
  const parts = f.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : f;
}

/** The icon, color and note of a row (the demo brings its own). */
const deco = (r) => r.deco ?? item(r.key);

const base = (folder) => String(folder || "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || folder;

// The words for the status of an agent in a terminal row.
const STATUS_WORD = { working: "working", blocked: "needs you", done: "done", idle: "idle" };

/** The name of a terminal row: its title without the leading marks, else its program. */
const termName = (p) => String(p.title ?? "").replace(/^[^\p{L}\p{N}~/\\]+/u, "").trim() || p.program?.name || p.app || "shell";

export default class SpaceDeck extends View {
  init(_props, cx) {
    this.part = overlayFor(props()?.part);
    if (this.part) {
      this.part.init(cx);
      return;
    }
    this.deck = new Deck();
    this.deck.init(cx);
  }

  render(cx) {
    if (kitOff()) return offView();
    return (this.part ?? this.deck).render(cx);
  }
}

class Deck {
  init(cx) {
    this.git = new Git();
    this.width = 240;
    this.hover = null; // the row under the pointer
    this.pressed = null; // { id, key, section } of the row pressed for a drag
    this.over = null; // { id, key, section } of the row under a drag
    this.sig = {}; // space id -> the statuses of its agents at the last render
    this.activeId = null;
    this.view = null; // view.json (recent spaces)
    this.launcher = false; // repo-launcher is installed
    this.demo = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]")); // machines, and "recent"
    if (!localStorage.getItem("folded")) this.folded.add("recent");
    this.termHover = null; // the terminal row under the pointer
    // Space key -> true (terminals shown) or false (hidden), when the person clicked the toggle of the space.
    try { this.termOpen = JSON.parse(localStorage.getItem("termOpen") ?? "{}") ?? {}; } catch { this.termOpen = {}; }
    this.refreshFiles(cx);
    cx.timer.every(10000, (cx) => kitOff() || this.refreshFiles(cx));
    cx.timer.every(1000, (cx) => kitOff() || this.tick(cx));
    cx.timer.every(30000, (cx) => kitOff() || cx.notify()); // the "5m" times
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "view") setShared(KEYS.view, view() === "card" ? "list" : "card");
        else if (c === "needs-you") setShared(KEYS.needsYouFirst, !needsYouFirst());
        else if (c === "demo") this.demo = !this.demo;
        else this.onShown(c);
        cx.notify();
      }
    });
  }

  // The commands that act on the shown space: icon, note, pin, menu, agent.
  onShown(c) {
    const r = this.list.find((x) => x.active);
    if (!r) return;
    const at = { space: r.id, key: r.key, name: r.name, folder: r.folder, machine: r.machine };
    if (c === "icon") popup("picker", at, 300, 380);
    else if (c === "note") popup("note", at, 300, 120);
    else if (c === "pin") pins().includes(r.key) ? unpin(r.key) : pinAt(r.key);
    else if (c === "menu") this.menu(r);
    else if (c === "agent") this.newAgent(r);
  }

  // view.json (recent spaces) and whether repo-launcher is installed.
  refreshFiles(cx) {
    cx.spawn(async (cx) => {
      const root = appHome();
      try { this.view = JSON.parse((await readTextFile(`${root}/view.json`)) ?? "null"); } catch { /* keep the last one */ }
      try { this.launcher = Boolean(await readTextFile(`${root}/mods/repo-launcher/mod.json`)); } catch { this.launcher = false; }
      cx.notify();
    });
  }

  tick(cx) {
    if (this.demo) return;
    this.git.due(this.list.map((r) => r.where), gitEvery() * 1000, cx);
  }

  get list() {
    return this.rowsCache ?? [];
  }

  // Activity: an agent of a space changed status, or the shown space changed.
  // Herdr's colors: a space without one gets the color used least, as in the
  // native sidebar, and a color chosen here goes to `space.colors` too.
  sync(all, cx) {
    for (const r of all) {
      const sig = r.agents.map((a) => `${a.address}:${a.status}`).join(",");
      if (this.sig[r.id] !== undefined && this.sig[r.id] !== sig) {
        touch(r.key);
        this.git.soon(r.where, cx);
      }
      this.sig[r.id] = sig;
    }
    const active = all.find((r) => r.active);
    if (active && active.id !== this.activeId) {
      if (this.activeId !== null) touch(active.key);
      this.activeId = active.id;
    }
    const stored = shared(KEYS.colors) ?? {};
    const ids = new Set(all.map((r) => r.id));
    const next = Object.fromEntries(Object.entries(stored).filter(([id]) => ids.has(id)));
    let changed = Object.keys(next).length !== Object.keys(stored).length;
    for (const r of all) {
      const mine = item(r.key).color;
      if (mine && next[r.id] !== mine) { next[r.id] = mine; changed = true; }
      if (next[r.id] || r.name === "~") continue;
      const uses = (c) => Object.values(next).filter((v) => v === c).length;
      next[r.id] = PALETTE.slice(0, 6).reduce((best, c) => (uses(c) < uses(best) ? c : best));
      changed = true;
    }
    if (changed) setShared(KEYS.colors, next);
  }

  colorOf(r, t) {
    return fillOf(deco(r).color ?? (shared(KEYS.colors) ?? {})[r.id] ?? "ansi6", t);
  }

  select(r) {
    if (this.demo || !r.id) return;
    run("space.select", { id: r.id });
  }

  menu(r) {
    if (this.demo) return;
    popup("menu", { space: r.id, key: r.key, name: r.name, folder: r.folder, machine: r.machine }, 210, 220);
  }

  newAgent(r) {
    if (this.demo) return;
    popup("agents", { space: r.id, folder: r.folder, machine: r.machine }, 240, 300);
  }

  /** True when repo-launcher is installed and not turned off in the mods-hub. */
  launcherOn() {
    const off = shared("herdr-mods.disabled");
    return this.launcher && !(Array.isArray(off) && off.includes("repo-launcher"));
  }

  plus() {
    if (this.launcherOn()) run("mod.open", { name: "repo-launcher" });
    else popup("plus", {}, 220, 90);
  }

  fold(name, cx) {
    this.folded.has(name) ? this.folded.delete(name) : this.folded.add(name);
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
    cx.notify();
  }

  // ---- terminals of a space ----

  /** True when the space shows its terminal rows. */
  termsShown(r) {
    const mode = terminalsMode();
    if (mode === "off" || !r.terminals?.length) return false;
    const mine = this.termOpen[r.key];
    return typeof mine === "boolean" ? mine : mode === "all" || r.active;
  }

  toggleTerms(r, cx) {
    this.termOpen[r.key] = !this.termsShown(r);
    localStorage.setItem("termOpen", JSON.stringify(this.termOpen));
    cx.notify();
  }

  // The toggle on a space: a terminal icon, the count and a chevron.
  termToggle(r, section, t) {
    if (terminalsMode() === "off" || !r.terminals?.length) return null;
    const open = this.termsShown(r);
    return h_flex().id(`terms-${section}-${r.id}`).h(20).px(4).gap(3).flex_none().items_center().rounded(5)
      .text_size(11).text_color(open ? t.muted : t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(open ? "Hide the terminals" : "Show the terminals")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggleTerms(r, cx); })
      .child(svg(`mods/${MOD}/icons/terminal.svg`).size(11).flex_none())
      .child(div().child(String(r.terminals.length)))
      .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(10).flex_none());
  }

  // The status of the agent in a terminal: a dot and a word. A shell has none.
  termStatus(p, t) {
    if (!p.status) return null;
    const color = p.status === "idle" ? t.dim : t[p.status] ?? t.unknown;
    const dot = p.status === "idle"
      ? div().size(6).flex_none().rounded(3).border(1).border_color(color)
      : div().size(6).flex_none().rounded(3).bg(color);
    return h_flex().flex_none().gap(4).items_center().text_size(10.5).text_color(color)
      .child(needsYou(p.status) || p.status === "working" ? dot.loop("opacity", { from: 0.35, to: 1, period: 1200 }) : dot)
      .child(div().child(STATUS_WORD[p.status] ?? p.status));
  }

  // One row for a terminal: a click shows it, the X closes its pane.
  termRow(r, p, section, t) {
    const id = `${section}-${p.terminal}`;
    const hovered = this.termHover === id;
    const name = termName(p);
    const where = p.cwd ? shortFolder(p.cwd) : "";
    const icon = p.program?.icon ? programIcon(p.program, 12, t.muted) : svg(`mods/${MOD}/icons/terminal.svg`).size(12).flex_none().text_color(t.dim);
    return h_flex().id(`term-${id}`).h(24).pl(6).pr(2).gap(6).flex_none().items_center().rounded(6)
      .when(p.focused && r.active, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .tooltip([name, p.app && p.status ? `${p.app}: ${STATUS_WORD[p.status] ?? p.status}` : null, where].filter(Boolean).join("\n"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); if (!this.demo) run("pane.focus", { pane: p.pane }); })
      .on_hover((h, cx) => {
        const next = h ? id : this.termHover === id ? null : this.termHover;
        if (next !== this.termHover) { this.termHover = next; cx.notify(); }
      })
      .child(icon)
      .child(div().flex_1().min_w(0).truncate().text_size(12)
        .text_color(p.focused && r.active ? t.foreground : t.muted).child(name))
      .child(hovered && !this.demo
        ? this.smallButton(`term-close-${id}`, "x", "Close the terminal", t, () => run("pane.close", { pane: p.pane }))
        : this.termStatus(p, t) ?? div());
  }

  termRows(r, section, t) {
    return this.termsShown(r) ? r.terminals.map((p) => this.termRow(r, p, section, t)) : [];
  }

  // ---- drag and drop ----

  // A drop is allowed in the Pinned section (pin or reorder), from Pinned to
  // a machine (unpin), and inside one machine (space.move).
  canDrop(from, to) {
    if (!from || !to || from.id === to.id) return false;
    if (to.section === "pin" || from.section === "pin") return true;
    return from.section === to.section;
  }

  drop(from, to) {
    if (to.section === "pin") {
      const list = pins().filter((k) => k !== from.key);
      const at = list.indexOf(to.key);
      const fromAt = pins().indexOf(from.key);
      const toAt = pins().indexOf(to.key);
      pinAt(from.key, at < 0 ? null : fromAt >= 0 && fromAt < toAt ? at + 1 : at);
    } else if (from.section === "pin") {
      unpin(from.key);
    } else {
      const index = spaces().findIndex((s) => s.id === to.id);
      if (index !== -1) run("space.move", { id: from.id, index: index + 1 });
    }
  }

  // The events of a row: a click selects, a drag moves, a right click opens the menu.
  draggable(el, r, section) {
    const me = { id: r.id, key: r.key, section };
    return el
      .on_mouse_down("left", () => { this.pressed = me; this.over = me; })
      .on_mouse_move((_e, cx) => {
        if (!this.pressed) return;
        const over = this.canDrop(this.pressed, me) ? me : null;
        if (this.over?.id !== over?.id || this.over?.section !== over?.section) { this.over = over; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from && over && over.id === me.id && over.section === me.section && from.id !== me.id) {
          if (!this.demo) this.drop(from, me);
        } else if (from?.id === me.id) this.select(r);
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(r))
      .on_hover((h, cx) => {
        const next = h ? `${section}:${r.id}` : this.hover === `${section}:${r.id}` ? null : this.hover;
        if (next !== this.hover) { this.hover = next; cx.notify(); }
      });
  }

  dropLine(el, r, section, t) {
    const target = this.over && this.pressed && this.over.id === r.id && this.over.section === section && this.pressed.id !== r.id;
    if (!target) return el;
    const order = section === "pin" ? pins() : spaces().map((s) => s.id);
    const a = order.indexOf(section === "pin" ? this.pressed.key : this.pressed.id);
    const b = order.indexOf(section === "pin" ? r.key : r.id);
    const below = a !== -1 && a < b;
    return el.child(div().absolute().left(4).right(4).h(2).rounded(1).bg(t.accent).when(below, (l) => l.bottom(0)).when(!below, (l) => l.top(0)));
  }

  // ---- parts of a row ----

  // A small button on a row (it does not start a drag or select the row).
  smallButton(id, icon, tip, t, onClick) {
    return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
      .child(svg(ICON(icon)).size(13));
  }

  statusDot(status, t, size = 7) {
    if (!status || status === "idle") return null;
    const dot = div().size(size).flex_none().rounded(size / 2).bg(t[status] ?? t.unknown);
    return needsYou(status) ? dot.loop("opacity", { from: 0.35, to: 1, period: 1200 }) : dot;
  }

  // On hover: New agent and Close. Else: the status of the space.
  tail(r, section, t) {
    const hovered = this.hover === `${section}:${r.id}`;
    if (hovered && !this.demo) {
      return h_flex().flex_none().gap(1)
        .child(this.smallButton(`agent-${section}-${r.id}`, "bot", "New agent", t, () => this.newAgent(r)))
        .child(this.smallButton(`close-${section}-${r.id}`, "x", "Close space", t, () => run("space.close", { id: r.id })));
    }
    return h_flex().flex_none().gap(4).items_center()
      .when(pins().includes(r.key) && section !== "pin", (el) => el.child(svg(ICON("pin")).size(11).text_color(t.dim)))
      .child(this.statusDot(r.status, t) ?? div());
  }

  gitText(g, t, compact) {
    if (!g) return null;
    const raw = g.branch ?? "detached";
    return h_flex().min_w(0).gap(5).items_center().text_size(11.5).text_color(t.dim)
      .child(svg(ICON("git-branch")).size(11).flex_none())
      .child(div().min_w(0).truncate().child(raw))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`↑${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`↓${g.behind}`)))
      .when(g.changed > 0, (el) => el.child(div().flex_none().text_color(t.ansi3).child(compact ? `●${g.changed}` : `● ${g.changed}`)));
  }

  card(r, section, t) {
    const it = deco(r);
    const urgent = needsYou(r.status);
    const lines = [];
    if (cardField("folder")) {
      lines.push(h_flex().gap(5).min_w(0).items_center().text_size(11.5).text_color(t.dim)
        .child(svg(`mods/${MOD}/icons/${r.machine ? "server" : "folder"}.svg`).size(11).flex_none())
        .child(div().min_w(0).truncate().child(shortFolder(r.folder)))
        .when(Boolean(r.machine), (el) => el.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10.5).child(r.machine))));
    }
    if (cardField("git") && r.git) lines.push(this.gitText(r.git, t, false));
    const meta = [];
    if (cardField("tabs")) meta.push(`${r.tabs} ${r.tabs === 1 ? "tab" : "tabs"} · ${r.terms} ${r.terms === 1 ? "terminal" : "terminals"}`);
    if (cardField("activity") && r.activity) meta.push(ago(r.activity));
    if (meta.length) {
      lines.push(h_flex().gap(5).items_center().text_size(11).text_color(t.dim)
        .when(cardField("activity") && Boolean(r.activity), (el) => el.child(svg(ICON("history")).size(11).flex_none()))
        .child(div().min_w(0).truncate().child(meta.join(" · "))));
    }
    if (cardField("agents") && r.agents.length) {
      const shown = r.agents.slice(0, 6);
      lines.push(h_flex().gap(4).flex_wrap().items_center()
        .children(shown.map((a, i) => h_flex().id(`ag-${r.id}-${i}`).h(20).px(5).gap(4).items_center().rounded(5)
          .bg(t.raised).border(1).border_color(needsYou(a.status) ? t[a.status] : t.border)
          .tooltip(`${a.name}: ${a.status}`)
          .child(programIcon(a.program, 12, t.muted))
          .child(div().size(6).rounded(3).bg(t[a.status] ?? t.unknown))))
        .when(r.agents.length > shown.length, (el) => el.child(div().text_size(11).text_color(t.dim).child(`+${r.agents.length - shown.length}`))));
    }
    if (cardField("note") && it.note) {
      lines.push(h_flex().gap(5).items_start().text_size(11.5).text_color(t.muted)
        .child(svg(ICON("sticky-note")).size(11).mt(2).flex_none())
        .child(div().min_w(0).italic().child(it.note)));
    }
    const box = v_flex()
      .relative()
      .id(`card-${section}-${r.id}`)
      .mx(2)
      .p(8)
      .gap(5)
      .flex_none()
      .rounded(9)
      .border(1)
      .border_color(urgent ? t[r.status] : r.active ? t.accent : t.border)
      .bg(r.active ? t.selected : t.surface)
      .when(!r.active, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed?.id === r.id && this.over?.id !== r.id, (el) => el.opacity(0.5))
      .when(Boolean(r.tree), (el) => el.ml(16))
      .child(h_flex().gap(8).items_center()
        .child(tile(it, r.name, this.colorOf(r, t), 22))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().font_medium().text_color(t.foreground).child(r.name))
          .when(Boolean(r.parent), (el) => el.child(div().truncate().text_size(10.5).text_color(t.dim).child(`worktree of ${r.parent}`))))
        .child(this.termToggle(r, section, t) ?? div())
        .child(this.tail(r, section, t)))
      .children(lines)
      .when(this.termsShown(r), (el) => el.child(v_flex().pt(4).gap(1).border_t(1).border_color(t.border)
        .children(this.termRows(r, section, t))));
    return this.dropLine(this.draggable(box, r, section), r, section, t);
  }

  listRow(r, section, t) {
    const it = deco(r);
    const g = r.git;
    const box = h_flex()
      .relative()
      .id(`row-${section}-${r.id}`)
      .h(30)
      .px(8)
      .gap(8)
      .flex_none()
      .items_center()
      .rounded(8)
      .when(r.active, (el) => el.bg(t.selected))
      .when(!r.active, (el) => el.hover((s) => s.bg(t.hover)))
      .when(needsYou(r.status), (el) => el.border(1).border_color(t[r.status]))
      .when(this.pressed?.id === r.id && this.over?.id !== r.id, (el) => el.opacity(0.5))
      .when(Boolean(r.tree), (el) => el.pl(14).child(div().flex_none().text_color(t.dim).child(r.tree)))
      .child(tile(it, r.name, this.colorOf(r, t), 18))
      .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.foreground).child(r.name))
      .child(h_flex().flex_1().min_w(0).justify_end()
        .when(Boolean(g) && cardField("git"), (el) => el.child(this.gitText(g, t, true))))
      .child(this.termToggle(r, section, t) ?? div())
      .child(this.tail(r, section, t));
    return this.dropLine(this.draggable(box, r, section), r, section, t);
  }

  rail(r, t) {
    const it = deco(r);
    return v_flex().id(`rail-${r.id}`).relative().h(34).flex_none().items_center().justify_center().rounded(7)
      .when(r.active, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .tooltip(r.name)
      .on_click(() => this.select(r))
      .on_mouse_down("right", () => this.menu(r))
      .child(tile(it, r.name, this.colorOf(r, t), 22))
      .when(Boolean(r.status) && r.status !== "idle", (el) => el.child(div().absolute().top(3).right(4).child(this.statusDot(r.status, t, 7))));
  }

  head(id, label, t, { icon, folded, onClick, extra } = {}) {
    return h_flex().id(id).h(26).mt(4).flex_none().px(8).gap(7).items_center().text_size(11).text_color(t.dim)
      .rounded(6)
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick))
      .when(Boolean(icon), (el) => el.child(svg(icon).size(12).flex_none()))
      .child(div().flex_1().truncate().child(label))
      .when(Boolean(extra), (el) => el.child(extra))
      .when(folded !== undefined, (el) => el.child(svg(ICON(folded ? "chevron-right" : "chevron-down")).size(11).flex_none()));
  }

  recent(list, t) {
    const folded = this.folded.has("recent");
    const out = [this.head("recent-head", `Recent · ${list.length}`, t, { icon: ICON("history"), folded, onClick: (_e, cx) => this.fold("recent", cx) })];
    if (folded) return out;
    for (const [i, r] of list.entries()) {
      const it = deco(r);
      const name = r.name || base(r.folder);
      out.push(h_flex().id(`recent-${i}`).h(28).px(8).gap(8).flex_none().items_center().rounded(7)
        .hover((s) => s.bg(t.hover))
        .tooltip(r.folder)
        .on_click(() => { if (!this.demo) run("space.new", { folder: r.folder, machine: "", ...(r.name ? { name: r.name } : {}) }); })
        .child(div().opacity(0.6).child(tile(it, name, fillOf(it.color ?? "#7d8796", t), 16)))
        .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.muted).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(shortFolder(r.folder))));
    }
    return out;
  }

  body(model, t) {
    const narrow = this.width < 160;
    const cards = view() === "card";
    // In the list, the terminal rows of a space go under its row, indented.
    const listed = (r, section) => {
      const terms = this.termRows(r, section, t);
      if (!terms.length) return [this.listRow(r, section, t)];
      return [this.listRow(r, section, t), v_flex().flex_none().ml(r.tree ? 34 : 20).gap(1).children(terms)];
    };
    const draw = (r, section) => (narrow ? [this.rail(r, t)] : cards ? [this.card(r, section, t)] : listed(r, section));
    const out = [];
    if (model.pinned.length) {
      if (!narrow) out.push(this.head("pinned-head", "Pinned", t, { icon: ICON("pin") }));
      out.push(...model.pinned.flatMap((r) => draw(r, "pin")));
      if (narrow) out.push(div().h(1).mx(8).my(4).flex_none().bg(t.border));
    }
    for (const g of model.groups) {
      const section = `m:${g.machine ?? ""}`;
      if (model.remote) {
        const folded = this.folded.has(section);
        if (!narrow) {
          out.push(this.head(`machine-${g.machine ?? "local"}`, g.machine ?? "This computer", t, {
            icon: `mods/workspace-chrome/${g.machine ? "server" : "monitor"}.svg`,
            folded,
            onClick: (_e, cx) => this.fold(section, cx),
          }));
        }
        if (folded && !narrow) continue;
      } else if (model.pinned.length && g.rows.length && !narrow) {
        out.push(this.head("spaces-head", "Spaces", t, {}));
      }
      out.push(...g.rows.flatMap((r) => draw(r, section)));
    }
    if (!narrow && model.recent.length) out.push(...this.recent(model.recent, t));
    return out;
  }

  headerButton(id, icon, tip, t, onClick, on = false) {
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(on ? t.foreground : t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .on_click(onClick)
      .child(svg(ICON(icon)).size(14));
  }

  render(cx) {
    const t = theme();
    let model;
    if (this.demo) {
      model = demoModel();
    } else {
      const all = rows(this.git);
      this.rowsCache = all;
      this.sync(all, cx);
      model = { ...sections(all), recent: recentRows(this.view, all, recentCount()) };
    }
    const narrow = this.width < 160;
    const cards = view() === "card";
    return v_flex()
      .id("space-deck")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(13)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); }
      })
      .child(h_flex().h(31).flex_none().pl(narrow ? 0 : 16).pr(narrow ? 0 : 8).gap(2).items_center()
        .when(narrow, (el) => el.justify_center())
        .when(!narrow, (el) => el.child(div().flex_1().text_size(11.5).text_color(t.dim).child(this.demo ? "Spaces · demo" : "Spaces"))
          .child(this.headerButton("deck-view", cards ? "list" : "layout-grid", cards ? "Show as a list" : "Show as cards", t,
            () => setShared(KEYS.view, cards ? "list" : "card"))))
        .child(this.headerButton("deck-plus", "plus", this.launcherOn() ? "Open a repository (repo-launcher)" : "New space", t, () => this.plus())))
      .child(v_flex()
        .id("deck-body")
        .flex_1()
        .min_h(0)
        .px(narrow ? 4 : 8)
        .pb(14)
        .gap(cards && !narrow ? 6 : 1)
        .overflow_y_scrollbar()
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.over = null; cx.notify(); })
        .children(this.body(model, t)));
  }
}
