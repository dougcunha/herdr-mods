// Kanban for the Herdr app: every agent is a card in a column by status.
// One mod, two parts chosen by props.part:
//   "bar"   the top bar: search, column toggles, view switch, window buttons.
//   "board" the columns with the cards.
// The two parts share their state through shared(): hidden columns, search text, scope.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import { agents, spaces, panes, focused, layout, layouts, window, theme, props, shared, setShared, run, openOverlay, setAgentOrder } from "herdr";
import { icon, tint, iconButton, columnChip, segmented, searchBox, pill, button, stop } from "./ui.js";

const KEY_HIDDEN = "kanban.hidden"; // ids of the hidden columns
const KEY_QUERY = "kanban.query"; // the search text
const KEY_SCOPE = "kanban.scope"; // "all" | "space"

// The order the person asked for: idle, needs you, working, done.
const COLUMNS = [
  { id: "idle", symbol: "moon" },
  { id: "blocked", symbol: "bell" },
  { id: "working", symbol: "zap" },
  { id: "done", symbol: "check" },
];

const STR = {
  en: {
    title: "Agents", search: "Search agents…",
    idle: "Idle", blocked: "Needs you", working: "Working", done: "Done",
    agents: (n) => (n === 1 ? "1 agent" : `${n} agents`), needYou: "{n} need you",
    scopeAll: "All spaces", scopeSpace: "This space",
    scopeAllTip: "Showing every space. Click to show only the current space.",
    scopeSpaceTip: "Showing only the current space. Click to show every space.",
    board: "Board", terminals: "Terminals", boardTip: "Show the board", terminalsTip: "Show the terminals of the current space",
    detailOn: "Hide the terminal panel", detailOff: "Show the terminal panel",
    newAgent: "New agent", hide: "Hide this column", showCol: "Show {name}", hideCol: "Hide {name}",
    emptyCol: "No agents here", emptyColSearch: "No match",
    allHidden: "All columns are hidden", allHiddenHint: "Show a column to see its agents.", showAll: "Show all columns",
    none: "No agents yet", noneHint: "Start an agent with the New agent button. It appears here as a card, and moves between columns when its status changes.",
    pin: "Pin to the top of its column", unpin: "Unpin", open: "Open in its tab",
    now: "just now", min: "{n} min ago", hour: "{n} h ago", day: "{n} d ago",
    newTab: "New tab", backTip: "Switch to the {name} layout",
  },
  pt: {
    title: "Agentes", search: "Buscar agentes…",
    idle: "Ociosos", blocked: "Precisam de você", working: "Trabalhando", done: "Concluídos",
    agents: (n) => (n === 1 ? "1 agente" : `${n} agentes`), needYou: "{n} precisam de você",
    scopeAll: "Todos os espaços", scopeSpace: "Este espaço",
    scopeAllTip: "Mostrando todos os espaços. Clique para mostrar só o espaço atual.",
    scopeSpaceTip: "Mostrando só o espaço atual. Clique para mostrar todos os espaços.",
    board: "Quadro", terminals: "Terminais", boardTip: "Mostrar o quadro", terminalsTip: "Mostrar os terminais do espaço atual",
    detailOn: "Ocultar o painel do terminal", detailOff: "Mostrar o painel do terminal",
    newAgent: "Novo agente", hide: "Ocultar esta coluna", showCol: "Mostrar {name}", hideCol: "Ocultar {name}",
    emptyCol: "Nenhum agente aqui", emptyColSearch: "Nada encontrado",
    allHidden: "Todas as colunas estão ocultas", allHiddenHint: "Mostre uma coluna para ver os agentes dela.", showAll: "Mostrar todas as colunas",
    none: "Nenhum agente ainda", noneHint: "Inicie um agente com o botão Novo agente. Ele aparece aqui como um cartão e muda de coluna quando o status muda.",
    pin: "Fixar no topo da coluna", unpin: "Desafixar", open: "Abrir na aba dele",
    now: "agora", min: "há {n} min", hour: "há {n} h", day: "há {n} d",
    newTab: "Nova aba", backTip: "Trocar para o layout {name}",
  },
};

const fill = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? ""));
const find = (node, id) => {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
};
const base = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";

export default class Kanban extends View {
  init(given, cx) {
    // Read props once and keep them: props() in a later callback can answer for another copy.
    this.props = (given && Object.keys(given).length ? given : props()) || {};
    this.part = this.props.part === "bar" ? "bar" : "board";
    this.lang = STR[this.props.lang] ? this.props.lang : "en";
    if (this.part === "bar") {
      this.query = InputState.new({ placeholder: this.s("search"), value: String(shared(KEY_QUERY) ?? "") });
      this.query.on("change", () => setShared(KEY_QUERY, this.query.value()));
    } else {
      cx.timer.every(30000, (cx) => cx.notify()); // keeps "3 min ago" fresh
    }
  }

  s(key, vars) {
    const v = STR[this.lang][key] ?? key;
    return typeof v === "function" ? v(vars) : fill(v, vars);
  }

  // ---- state ---------------------------------------------------------------

  hidden() {
    const list = shared(KEY_HIDDEN);
    return new Set(Array.isArray(list) ? list : []);
  }

  toggleColumn(id) {
    const set = this.hidden();
    if (set.has(id)) set.delete(id); else set.add(id);
    setShared(KEY_HIDDEN, [...set]);
  }

  scope() { return shared(KEY_SCOPE) === "space" ? "space" : "all"; }

  /** Agents after the scope and the search text. */
  visible() {
    const q = String(shared(KEY_QUERY) ?? "").trim().toLowerCase();
    const space = spaces().find((p) => p.active)?.id;
    const scoped = this.scope() === "space" ? agents().filter((a) => a.space === space) : agents();
    if (!q) return scoped;
    return scoped.filter((a) => {
      const pane = panes().find((p) => p.pane === a.pane);
      return `${a.title} ${a.program?.name} ${a.space_name} ${a.tab_name} ${pane?.branch ?? ""}`.toLowerCase().includes(q);
    });
  }

  /** The stack child that shows now ("board-view" or "tabs-view"). */
  view() { return find(layout(), "view")?.active ?? "board-view"; }
  detailHidden() { return Boolean(find(layout(), "detail")?.hidden); }

  age(ms) {
    if (!ms) return "";
    const m = Math.floor((Date.now() - ms) / 60000);
    if (m < 1) return this.s("now");
    if (m < 60) return this.s("min", { n: m });
    const h = Math.floor(m / 60);
    return h < 24 ? this.s("hour", { n: h }) : this.s("day", { n: Math.floor(h / 24) });
  }

  // ---- actions -------------------------------------------------------------

  select(a) {
    run("agent.focus", { terminal: a.address });
    if (this.detailHidden()) run("layout.show", { id: "detail" });
  }

  openInTab(a) {
    run("space.select", { id: a.space });
    run("tab.select", { id: a.tab });
    run("pane.focus", { terminal: a.address });
    run("layout.select", { stack: "view", child: "tabs-view" });
  }

  /** The layout the back button goes to: the one the person came from (saved by the dock
   *  button or by this button), else props.back, else "main", else the first other layout. */
  back() {
    const names = layouts(), here = shared("layout");
    return [shared("layout.previous"), this.props.back, "main", ...names]
      .find((n) => typeof n === "string" && n !== here && names.includes(n)) ?? null;
  }

  goBack(name) {
    setShared("layout.previous", shared("layout")); // so the other layout can come back here
    run("layout.switch", { name });
  }

  newAgent() { openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }); }

  // ---- the board -------------------------------------------------------------

  glyph(a, t) {
    const prog = a.program ?? {};
    const tile = prog.tile || tint(t.foreground, "14");
    const inner = prog.icon
      ? (prog.tint ? svg(prog.icon).size(15).text_color(prog.color || t.foreground) : image(prog.icon).size(17))
      : svg(icon("bot")).size(15).text_color(t.muted);
    return div().size(28).rounded(9).flex_none().flex().items_center().justify_center().bg(tile).child(inner);
  }

  /** The status mark at the right of a card: it moves for working and for needs you. */
  mark(a, t) {
    const color = t[a.status] ?? t.idle;
    if (a.status === "working") return svg(icon("spinner")).size(15).flex_none().text_color(color).spin(900);
    if (a.status === "blocked") return svg(icon("bell")).size(15).flex_none().text_color(color).loop("opacity", { from: 0.3, to: 1, period: 1100 });
    if (a.status === "done") return svg(icon("check")).size(15).flex_none().text_color(color);
    return svg(icon("moon")).size(14).flex_none().text_color(t.dim);
  }

  card(a, t) {
    const color = t[a.status] ?? t.idle;
    const pane = panes().find((p) => p.pane === a.pane);
    const tab = spaces().find((p) => p.id === a.space)?.tabs.find((x) => x.id === a.tab);
    const since = a.status === "working" ? tab?.working_since ?? tab?.changed_at : tab?.changed_at;
    const selected = a.focused || focused()?.agent === a.address;
    const hot = a.status === "blocked";
    const name = a.program?.name || a.app || "Agent";
    const title = (a.title || "").trim();
    const branch = pane?.branch || null;
    const folder = base(pane?.cwd);
    const tabLabel = /^\d+$/.test(String(a.tab_name)) ? "" : a.tab_name;

    return v_flex().id(`card-${a.address}`).w_full().flex_none().p(12).gap(9).rounded(12).cursor_pointer()
      .bg(selected ? t.raised : t.background)
      .border_1().border_color(selected ? t.accent : hot ? tint(color, "99") : t.border)
      .when(selected || hot, (e) => e.shadow_md())
      .hover((s) => s.bg(t.raised))
      .on_click(() => this.select(a))
      .when(a.status === "working", (e) => e.child(
        div().h(2).w_full().rounded(1).bg(color).loop("opacity", { from: 0.2, to: 1, period: 1400 })))
      .child(h_flex().gap(9).items_center()
        .child(this.glyph(a, t))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(name))
          .child(div().truncate().text_size(11).text_color(t.dim).child(a.space_name)))
        .child(this.mark(a, t)))
      .when(Boolean(title) && title !== name, (e) => e.child(
        div().max_h(34).overflow_hidden().text_size(12).text_color(t.muted).child(title)))
      .child(h_flex().flex_wrap().gap(5).items_center()
        .when(Boolean(branch), (e) => e.child(pill(t, { label: branch, symbol: "branch", code: true })))
        .when(Boolean(folder) && folder !== branch, (e) => e.child(pill(t, { label: folder, symbol: "folder" })))
        .when(Boolean(tabLabel), (e) => e.child(pill(t, { label: tabLabel, symbol: "terminal" }))))
      .child(h_flex().h(22).gap(2).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.age(since)))
        .child(iconButton(t, `pin-${a.address}`, "pin", () => run("terminal.pin", { terminal: a.address, pinned: !a.pinned }),
          { active: a.pinned, tooltip: this.s(a.pinned ? "unpin" : "pin"), size: 22, glyph: 12, color: a.pinned ? t.accent : t.dim }))
        .child(iconButton(t, `open-${a.address}`, "open", () => this.openInTab(a),
          { tooltip: this.s("open"), size: 22, glyph: 12, color: t.dim })));
  }

  column(c, list, t, searching) {
    const color = t[c.id] ?? t.idle;
    const urgent = c.id === "blocked" && list.length > 0;
    const tile = div().size(26).rounded(8).flex_none().flex().items_center().justify_center().bg(tint(color, "26"))
      .child(svg(icon(c.symbol)).size(14).text_color(color));
    return v_flex().id(`col-${c.id}`).flex_1().h_full().min_w(236).min_h(0).rounded(16).overflow_hidden()
      .border_1().border_color(urgent ? tint(color, "66") : tint(color, "26")).bg(tint(color, "0d"))
      .child(h_flex().h(48).flex_none().px(12).gap(9).items_center()
        .child(urgent ? tile.loop("opacity", { from: 0.55, to: 1, period: 1200 }) : tile)
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(this.s(c.id)))
        .child(div().h(20).px(8).rounded(10).flex().items_center().text_size(11).font_semibold()
          .bg(tint(color, "26")).text_color(color).child(String(list.length)))
        .child(iconButton(t, `hide-${c.id}`, "eye-off", () => this.toggleColumn(c.id), { tooltip: this.s("hide"), size: 24, glyph: 14, color: t.dim })))
      .child(v_flex().id(`scroll-${c.id}`).flex_1().min_h(0).overflow_y_scrollbar().px(10).pb(10).gap(10)
        .children(list.map((a) => this.card(a, t)))
        .when(list.length === 0, (e) => e.child(
          v_flex().h(96).flex_none().items_center().justify_center().gap(8).rounded(12)
            .border_1().border_dashed().border_color(tint(color, "44"))
            .child(svg(icon(c.symbol)).size(18).text_color(tint(color, "88")))
            .child(div().text_size(12).text_color(t.dim).child(this.s(searching ? "emptyColSearch" : "emptyCol"))))));
  }

  emptyState(t, title, hint, action) {
    return v_flex().size_full().items_center().justify_center().gap(12).p(24)
      .child(div().size(52).rounded(16).flex().items_center().justify_center().bg(tint(t.accent, "1f"))
        .child(svg(icon("board")).size(26).text_color(t.accent)))
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(title))
      .child(div().max_w(380).text_size(12).text_color(t.dim).text_center().child(hint))
      .child(action);
  }

  board(t) {
    const hidden = this.hidden();
    const all = agents();
    const searching = String(shared(KEY_QUERY) ?? "").trim().length > 0;
    if (!all.length) {
      return this.emptyState(t, this.s("none"), this.s("noneHint"),
        button(t, "kb-new", this.s("newAgent"), () => this.newAgent(), { primary: true, symbol: "plus" }));
    }
    const shown = this.visible();
    const byStatus = (id) => shown.filter((a) => a.status === id)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.seq - a.seq);
    const cols = COLUMNS.filter((c) => !hidden.has(c.id));
    // agent.next and agent.prev walk the cards in the order they show.
    setAgentOrder(cols.flatMap((c) => byStatus(c.id)).map((a) => a.address));
    if (!cols.length) {
      return this.emptyState(t, this.s("allHidden"), this.s("allHiddenHint"),
        button(t, "kb-show-all", this.s("showAll"), () => setShared(KEY_HIDDEN, []), { primary: true, symbol: "eye" }));
    }
    return h_flex().id("kb-columns").size_full().min_h(0).gap(12).overflow_x_scrollbar()
      .children(cols.map((c) => this.column(c, byStatus(c.id), t, searching)));
  }

  // ---- the top bar -------------------------------------------------------------

  tabStrip(t) {
    const space = spaces().find((p) => p.active);
    const pills = (space?.tabs ?? []).map((tab) => {
      const program = panes().find((p) => p.tab === tab.id && p.program?.agent)?.program ?? panes().find((p) => p.tab === tab.id)?.program;
      const name = /^tb\d+$/.test(tab.name) ? program?.name ?? "Terminal" : tab.name;
      return h_flex().id(`kb-tab-${tab.id}`).h(28).px(10).gap(7).flex_none().items_center().rounded(8).text_size(12).cursor_pointer()
        .border_1().border_color(tab.active ? t.border : t.chrome).bg(tab.active ? t.raised : t.chrome)
        .text_color(tab.active ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", stop)
        .on_click(() => run("tab.select", { id: tab.id }))
        .when(Boolean(program?.icon), (e) => e.child(program.tint ? svg(program.icon).size(13).text_color(t.muted) : image(program.icon).size(13)))
        .child(div().max_w(160).truncate().child(name))
        .when(tab.status === "working", (e) => e.child(svg(icon("spinner")).size(11).flex_none().text_color(t.working).spin(900)))
        .when(tab.status === "blocked" || tab.status === "done", (e) => e.child(div().size(6).rounded(3).bg(t[tab.status])));
    });
    return h_flex().id("kb-tabs").flex_1().min_w(0).h_full().gap(4).items_center().overflow_x_scrollbar()
      .children(pills)
      .child(iconButton(t, "kb-tab-new", "plus", () => run("tab.new"), { tooltip: this.s("newTab"), size: 26, glyph: 13 }));
  }

  bar(t) {
    const hidden = this.hidden();
    const all = agents();
    const need = all.filter((a) => a.status === "blocked").length;
    const view = this.view();
    const w = window();
    const wbtn = (id, glyph, action) => div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(7)
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
      .on_click(action).child(glyph);
    const win = w?.platform === "windows";
    const onBoard = view !== "tabs-view";
    const back = this.back();

    return h_flex().size_full().min_w(0).px(14).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().size(28).rounded(9).flex_none().flex().items_center().justify_center().bg(tint(t.accent, "26"))
        .child(svg(icon("board")).size(15).text_color(t.accent)))
      .child(v_flex().flex_none()
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child(this.s("title")))
        .child(div().text_size(11).text_color(need ? t.blocked : t.dim)
          .child(need ? `${this.s("agents", all.length)} · ${this.s("needYou", { n: need })}` : this.s("agents", all.length))))
      .child(segmented(t, [
        { id: "kb-view-board", label: this.s("board"), symbol: "board", active: onBoard, tooltip: this.s("boardTip"),
          onClick: () => run("layout.select", { stack: "view", child: "board-view" }) },
        { id: "kb-view-tabs", label: this.s("terminals"), symbol: "terminal", active: !onBoard, tooltip: this.s("terminalsTip"),
          onClick: () => run("layout.select", { stack: "view", child: "tabs-view" }) },
      ]))
      .when(onBoard, (e) => e
        .child(searchBox(t, "kb-search", this.query, {
          onClear: () => { this.query.set_value(""); setShared(KEY_QUERY, ""); },
        }))
        .child(h_flex().flex_1().min_w(0).gap(6).items_center().overflow_x_scrollbar()
          .children(COLUMNS.map((c) => {
            const on = !hidden.has(c.id), name = this.s(c.id);
            return columnChip(t, `kb-chip-${c.id}`, {
              label: name, color: t[c.id] ?? t.idle, on,
              count: this.visible().filter((a) => a.status === c.id).length,
              tooltip: this.s(on ? "hideCol" : "showCol", { name }),
            }, () => this.toggleColumn(c.id));
          })))
        .child(iconButton(t, "kb-scope", "layers", () => setShared(KEY_SCOPE, this.scope() === "space" ? "all" : "space"),
          { active: this.scope() === "space", tooltip: this.s(this.scope() === "space" ? "scopeSpaceTip" : "scopeAllTip") }))
        .child(iconButton(t, "kb-detail", "panel", () => run("layout.toggle", { id: "detail" }),
          { active: !this.detailHidden(), tooltip: this.s(this.detailHidden() ? "detailOff" : "detailOn") })))
      .when(!onBoard, (e) => e.child(this.tabStrip(t)))
      .when(Boolean(back), (e) => e.child(button(t, "kb-back", back, () => this.goBack(back),
        { symbol: "swap", tooltip: this.s("backTip", { name: back }) })))
      .child(button(t, "kb-new", this.s("newAgent"), () => this.newAgent(), { primary: true, symbol: "plus" }))
      .when(w?.buttons, (e) => e
        .child(wbtn("kb-min", win ? svg(icon("win-min")).size(16) : "−", () => run("window.minimize")))
        .child(wbtn("kb-max", win ? svg(icon(w.maximized ? "win-restore" : "win-max")).size(16) : "□", () => run("window.maximize")))
        .child(wbtn("kb-close", win ? svg(icon("win-close")).size(16) : svg(icon("close")).size(13), () => run("window.close"))));
  }

  render(_cx) {
    const t = theme();
    if (this.part === "bar") return this.bar(t);
    return v_flex().id("kanban").size_full().min_h(0).min_w(0).text_color(t.foreground).text_size(13).child(this.board(t));
  }
}
