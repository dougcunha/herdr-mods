// Agent cards: the agents list as cards, each with a small robot that acts out
// the agent's status. Working types on a laptop, idle sleeps, blocked waves
// for attention, done jumps. A replacement for the shipped `agents` panel.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, spaces, run, theme, layout, setAgentOrder, nextCommand, shared, setShared,
  openOverlay, readTextFile, appHome } from "herdr";
import { stage } from "./robot.js";

// The mods-hub setting "Needs you first": the agents that need you go to the top,
// and the other cards go to the bottom of the panel, under a line.
const KEY_NEEDS_YOU = "agent-cards.needsYouFirst";
const needsYouFirst = () => shared(KEY_NEEDS_YOU) === true;
// True when the person turned tab-namer off in the mods-hub: the cards show no pencil then.
const namerOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes("tab-namer"); };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar rail goes by its width, as in the shipped `agents` mod.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const LABEL = { working: "Working", idle: "Sleeping", blocked: "Needs you", done: "Done" };

// A sub-agent without a pane is not in agents(): take its raw word, with error as
// blocked. It is never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// The pane that names a tab: its first agent, else its focused terminal, else its first terminal.
function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

// A tab nobody named takes the agent's own title when the title tells something.
function tabTitle(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class AgentCards extends View {
  init(_props, cx) {
    // When each agent last changed its status (ms). Done and idle count as one.
    this.changed = {};
    this.demo = false;
    this.demoPins = new Set(["demo-3"]);
    // Cards whose sub-agents are folded.
    this.folded = new Set();
    this.hovered = null;
    // The pencil of a card opens the tab-namer dialog, when that mod is installed.
    this.namer = false;
    const findNamer = (cx) => cx.spawn(async (cx) => {
      let found = false;
      try { found = Boolean(await readTextFile(`${appHome()}/mods/tab-namer/mod.json`)); } catch {}
      if (found !== this.namer) { this.namer = found; cx.notify(); }
    });
    findNamer(cx);
    cx.timer.every(60000, (cx) => findNamer(cx));
    cx.timer.every(30000, (cx) => cx.notify());
    // `herdr-app do agent-cards.demo` shows one example card for each status.
    // `agent-cards.needs-you` turns "Needs you first" on or off.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "demo") this.demo = !this.demo;
        if (c === "needs-you") setShared(KEY_NEEDS_YOU, !needsYouFirst());
        cx.notify();
      }
    });
  }

  demoCards(now) {
    const ago = (m) => now - m * 60000;
    return [
      ["blocked", "api-server", "Approve: run migrations?", 3],
      ["done", "web-app", "Fix the login redirect", 12],
      ["working", "herdr-mods", "Agent cards POC", 1],
      ["idle", "docs", "Release notes", 95],
    ].map(([status, space, tab, m], i) => {
      const address = `demo-${i}`;
      const a = { address, status, space_name: space, focused: i === 2, program: null, demo: true, pinned: this.demoPins.has(address) };
      this.changed[a.address] = { s: status, at: ago(m) };
      const kid = (n, name, st, depth, last) => ({ t: { address: `${address}-${n}`, name }, status: st, depth, last });
      const subs = i === 2
        ? [kid(1, "explore: find the panel", "working", 0, false), kid(2, "review: check the diff", "blocked", 0, false), kid(3, "test: run the check", "idle", 1, true), kid(4, "docs: notes", "working", 0, true)]
        : [];
      return { a, info: { name: space, detail: tab }, subs };
    }).sort((x, y) => (y.a.pinned ? 1 : 0) - (x.a.pinned ? 1 : 0));
  }

  // The header button that turns "Needs you first" on or off.
  needsYouButton(t, on) {
    return div()
      .id("ac-needs-you")
      .flex_none()
      .p(3)
      .rounded(5)
      .text_color(on ? t.blocked : t.dim)
      .when(on, (el) => el.bg(t.blocked + "22"))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(on ? t.blocked : t.foreground))
      .tooltip(on ? "Needs you first: on. Click to turn off." : "Needs you first: off. Click to put the agents that need you at the top.")
      .on_click((_e, cx) => {
        setShared(KEY_NEEDS_YOU, !on);
        cx.notify();
      })
      .child(svg("mods/agent-cards/needs-you.svg").size(13));
  }

  // Live sub-agents of `addr`, depth first.
  tree(all, addr, depth = 0) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => [
      { t: k, status: kidStatus(k, this.listed), depth, last: i === kids.length - 1 },
      ...this.tree(all, k.address, depth + 1),
    ]);
  }

  track(list, now) {
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s !== s) this.changed[a.address] = { s, at: now };
    }
  }

  pill(t, status) {
    const color = t[status] ?? t.dim;
    const text = div().text_size(10.5).font_semibold().text_color(color);
    return h_flex()
      .flex_none()
      .h(18)
      .px(7)
      .rounded(9)
      .items_center()
      .bg(color + "22")
      .child(status === "working"
        ? text.frames(["Working", "Working.", "Working..", "Working..."], 400).child("Working")
        : text.child(LABEL[status] ?? status));
  }

  // A small status mark for a sub-agent row.
  mark(t, status) {
    if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900);
    if (status === "blocked") return div().size(13).flex_none().rounded(4).bg(t.blocked + "26").text_size(10).font_bold()
      .text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(t[status] ?? t.dim);
  }

  // The pin button: shown while the pointer is on the card, or always when the card is pinned.
  pin(t, a) {
    return div()
      .id(`pin-${a.address}`)
      .flex_none()
      .p(2)
      .rounded(4)
      .text_color(a.pinned ? t.accent : t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(a.pinned ? "Unpin" : "Pin to the top")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (a.demo) this.demoPins.has(a.address) ? this.demoPins.delete(a.address) : this.demoPins.add(a.address);
        else run("terminal.pin", { terminal: a.address, pinned: !a.pinned });
        // The card moves away from under the pointer, and no hover-out comes.
        this.hovered = null;
        cx.notify();
      })
      .child(svg(`mods/workspace-chrome/${a.pinned && this.hovered === a.address ? "pin-off" : "pin"}.svg`).size(13));
  }

  // The pencil button: shown while the pointer is on the card. It opens the tab-namer dialog for the agent's tab.
  rename(t, a) {
    return div()
      .id(`rename-${a.address}`)
      .flex_none()
      .p(2)
      .rounded(4)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Rename the tab")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (!a.demo) openOverlay({ mod: "tab-namer", kind: "dialog", width: 460, props: { tab: a.tab, terminal: a.address } });
      })
      .child(svg("mods/agent-cards/pencil.svg").size(13));
  }

  // The sub-agents of a card: a header that folds them, then one row for each.
  subs(t, a, subs) {
    const open = !this.folded.has(a.address);
    const top = subs.reduce((m, s) => ((RANK[s.status] ?? 0) > (RANK[m] ?? 0) ? s.status : m), null);
    const header = h_flex()
      .id(`subs-${a.address}`)
      .h(22)
      .px(4)
      .gap(6)
      .rounded(6)
      .items_center()
      .text_size(11)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (open) this.folded.add(a.address);
        else this.folded.delete(a.address);
        cx.notify();
      })
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
      .child(div().flex_1().child(`${subs.length} sub-agent${subs.length === 1 ? "" : "s"}`))
      .when(!open && Boolean(top), (el) => el.child(this.mark(t, top)));
    const row = (s) => h_flex()
      .id(`sub-${s.t.address}`)
      .h(22)
      .pl(4 + s.depth * 14)
      .pr(4)
      .gap(6)
      .rounded(6)
      .items_center()
      .text_size(11.5)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (!a.demo) run("terminal.peek", { terminal: s.t.address });
      })
      .child(div().flex_none().text_color(t.input).child(s.last ? "└" : "├"))
      .when(Boolean(icon(s.t.program, 12, t.foreground)), (el) => el.child(icon(s.t.program, 12, t.foreground)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(s.t.name || s.t.template || s.t.program?.name || s.t.address))
      .child(this.mark(t, s.status));
    return v_flex().pt(4).mt(6).border_t(1).border_color(t.border)
      .child(header)
      .when(open, (el) => el.children(subs.map(row)));
  }

  card(t, a, info, now, subs = []) {
    const since = this.changed[a.address]?.at;
    const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
    const border = a.status === "blocked" ? t.blocked + "99" : a.focused ? t.accent : t.border;
    const hovered = this.hovered === a.address;
    return v_flex()
      .id(`card-${a.address}`)
      .flex_none()
      .p(8)
      .rounded(12)
      .bg(a.focused ? t.selected : t.surface)
      .border(1)
      .border_color(border)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => {
        if (on) this.hovered = a.address;
        else if (this.hovered === a.address) this.hovered = null;
        cx.notify();
      })
      .on_click(() => a.pane && run("pane.focus", { pane: a.pane }))
      .child(h_flex().gap(10).items_center()
        .child(stage(t, a.status))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(h_flex().gap(6).items_center()
            .when(Boolean(icon(a.program, 14, t.foreground)), (el) => el.child(icon(a.program, 14, t.foreground)))
            .child(div().flex_1().min_w(0).truncate().font_medium().text_color(a.status === "idle" ? t.muted : t.foreground).child(info.name))
            .when(Boolean(since) && !hovered, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - since))))
            .when(hovered && this.namer && !namerOff(), (el) => el.child(this.rename(t, a)))
            .when(hovered || a.pinned, (el) => el.child(this.pin(t, a))))
          .when(Boolean(info.detail), (el) => el.child(div().truncate().text_size(11.5).text_color(t.dim).child(info.detail)))
          .child(h_flex().gap(6).items_center()
            .child(this.pill(t, a.status))
            .when(Boolean(machine), (el) => el.child(div().text_size(10).text_color(t.dim).child(machine))))))
      .when(subs.length > 0, (el) => el.child(this.subs(t, a, subs)));
  }

  // The rail: a number and a status dot for each agent.
  railRow(t, a, i) {
    const color = t[a.status] ?? t.dim;
    return h_flex()
      .id(`rail-${a.address}`)
      .h(26)
      .px(8)
      .flex_none()
      .items_center()
      .gap(4)
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(div().flex_1().text_right().text_color(t.muted).child(String(i + 1)))
      .child(div().size(8).flex_none().rounded(4).bg(color)
        .when(a.status === "working" || a.status === "blocked", (el) => el.loop("opacity", { from: 0.3, to: 1, period: 900 })));
  }

  render(cx) {
    const t = theme();
    const now = Date.now();
    const list = [...agents()];
    this.track(list, now);
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    const subsOf = new Map(list.map((a) => [a.address, this.tree(all, a.address)]));
    // A card ranks by its most urgent status, its sub-agents included.
    const urgency = new Map(list.map((a) => [a.address, Math.max(RANK[a.status] ?? 0, ...subsOf.get(a.address).map((s) => RANK[s.status] ?? 0))]));
    const since = (a) => this.changed[a.address]?.at ?? 0;
    const first = needsYouFirst();
    const top = (a) => (first && a.status === "blocked" ? 1 : 0);
    list.sort((x, y) => top(y) - top(x) || (y.pinned ? 1 : 0) - (x.pinned ? 1 : 0) || urgency.get(y.address) - urgency.get(x.address) || since(y) - since(x) || y.seq - x.seq);
    setAgentOrder(list.map((a) => a.address));

    if (narrow()) {
      return v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
        .child(v_flex().id("ac-rail").flex_1().min_h(0).overflow_y_scrollbar().children(list.map((a, i) => this.railRow(t, a, i))));
    }

    // Each card reads its space as the name and its tab (or the agent's title) as the detail.
    const leads = leadPanes(panes());
    const tabs = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tabTitle(tab, leads.get(tab.id))]));
    const infoOf = (a) => {
      const tab = tabs.get(a.tab) ?? (a.title || a.program?.name || "");
      return { name: a.space_name || tab || a.address, detail: /^\d+$/.test(tab) ? a.program?.name ?? null : tab };
    };
    const busy = list.filter((a) => a.status !== "idle").length;
    const cards = this.demo ? this.demoCards(now) : list.map((a) => ({ a, info: infoOf(a), subs: subsOf.get(a.address) }));
    const draw = (c) => this.card(t, c.a, c.info, now, c.subs);
    // "Needs you first": the blocked cards at the top, a space that grows, a line,
    // and the other cards at the bottom of the panel.
    const body = !first ? cards.map(draw) : (() => {
      const needs = cards.filter((c) => c.a.status === "blocked");
      const rest = cards.filter((c) => c.a.status !== "blocked");
      return [
        ...needs.map(draw),
        div().id("ac-spacer").flex_1(),
        ...(needs.length && rest.length ? [h_flex().id("ac-divider").flex_none().mx(4).gap(8).items_center()
          .child(div().flex_1().h(1).bg(t.input))
          .child(div().flex_none().text_size(10.5).font_medium().text_color(t.dim).child("Other agents"))
          .child(div().flex_1().h(1).bg(t.input))] : []),
        ...rest.map(draw),
      ];
    })();

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().justify_between()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(11).text_color(this.demo ? t.accent : t.dim)
            .child(this.demo ? "Demo" : list.length ? `${busy} active · ${list.length}` : ""))
          .child(this.needsYouButton(t, first))))
      .when(cards.length === 0, (el) => el.child(div().px(16).text_size(12).text_color(t.dim)
        .child("No agents yet. Agents show up here when they report their status.")))
      .child(v_flex().id("ac-list").flex_1().min_h(0).px(10).pb(10).gap(8).overflow_y_scrollbar()
        .children(body));
  }
}
