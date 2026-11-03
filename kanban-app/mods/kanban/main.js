// Kanban for the Herdr app: every agent is a card in a column by status.
// One mod, two parts chosen by props.part:
//   "bar"   the top bar: search, column toggles, view switch, window buttons.
//   "board" the columns with the cards.
// The two parts share their state through shared(): hidden columns, search text, scope.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import { agents, spaces, panes, focused, layout, layouts, window, theme, props, shared, setShared, run, openOverlay, setAgentOrder,
  appHome, readTextFile, watchFolder, notify, hc } from "herdr";
import * as fs from "fs/promises";
import { icon, tint, iconButton, columnChip, segmented, searchBox, pill, button, panelButton, buttonGroup, stop } from "./ui.js";

const KEY_HIDDEN = "kanban.hidden"; // ids of the hidden columns
const KEY_QUERY = "kanban.query"; // the search text
const KEY_SCOPE = "kanban.scope"; // "all" | "space"
const KEY_WIDTH = "kanban.width"; // widest a column may be, in px; absent: columns share the board
const KEY_ORDER = "kanban.order"; // ids of the columns, left to right; absent: the order of COLUMNS
const KEY_DENSITY = "kanban.density"; // "auto" | "compact" | "normal"; absent: auto
const KEY_CARDS = "kanban.cards"; // "auto" | "summary" | "full"; absent: auto (summary while the board is compact)
// Steps of the width control. null = Auto: the columns share the whole board.
const WIDTHS = [150, 180, 220, 260, 320, 400, null];
const MIN_COLUMN = 150; // narrowest a column may be before the board scrolls
const MIN_COLUMN_COMPACT = 120; // the same, in compact density
const GAP = 12, GAP_COMPACT = 8; // between the columns

// Density. The button in the bar goes auto -> compact -> normal -> auto.
// Auto makes each part compact by its own width (on_size_change, the same px as .w()):
// the bar below BAR_WIDE, the board below COLUMN_WIDE for each visible column.
const DENSITIES = ["auto", "compact", "normal"];
// Card view. The button in the bar goes auto -> summary -> full -> auto.
const CARD_VIEWS = ["auto", "summary", "full"];
const BAR_WIDE = 1650;
const COLUMN_WIDE = 220;
// In compact density these 2 columns share one place, one under the other.
const STACKED = ["done", "idle"];

// The shell under the board: one core terminal with this name, outside every tab, shown by a
// layout block { "terminal": "<address>" } with the id SHELL_ID. The bar adds the block the first time.
const SHELL_NAME = "kanban-shell";
const SHELL_ID = "shell";

// The side panel of the layout (node "panel", stack "panel-body"): Herdr's own Files and Changes mods.
const PANELS = [
  { id: "files", label: "Files", icon: "mods/files/file.svg" },
  { id: "changes", label: "Changes", icon: "mods/changes/changes.svg" },
];

// The default order: needs you, working, done, idle. The arrows in a column header change it,
// and shared(KEY_ORDER) keeps the new order.
const COLUMNS = [
  { id: "blocked", symbol: "bell" },
  { id: "working", symbol: "zap" },
  { id: "done", symbol: "check" },
  { id: "idle", symbol: "moon" },
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
    newTab: "New tab", backTip: "Switch to the {name} layout", panelTip: "Show or hide {name}",
    auto: "Auto", widthTip: "Column width: {w}. Use − and + to change it.",
    narrower: "Narrower columns", wider: "Wider columns",
    moveLeft: "Move this column left", moveRight: "Move this column right",
    shellOn: "Hide the shell under the board", shellOff: "Show a shell under the board",
    density_auto: "Auto", density_compact: "Compact", density_normal: "Normal",
    densityNow: "{mode} (compact now)", densityNowNormal: "{mode} (normal now)",
    densityTip: "Density: {mode}. Click to switch to {next}.",
    cards_auto: "Auto", cards_summary: "Summary", cards_full: "Full",
    cardsAuto: "Auto (summary in compact density)",
    cardsTip: "Cards: {mode}. Click to switch to {next}.",
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
    newTab: "Nova aba", backTip: "Trocar para o layout {name}", panelTip: "Mostrar ou ocultar {name}",
    auto: "Auto", widthTip: "Largura da coluna: {w}. Use − e + para mudar.",
    narrower: "Colunas mais estreitas", wider: "Colunas mais largas",
    moveLeft: "Mover esta coluna para a esquerda", moveRight: "Mover esta coluna para a direita",
    shellOn: "Ocultar o shell abaixo do quadro", shellOff: "Mostrar um shell abaixo do quadro",
    density_auto: "Auto", density_compact: "Compacta", density_normal: "Normal",
    densityNow: "{mode} (compacta agora)", densityNowNormal: "{mode} (normal agora)",
    densityTip: "Densidade: {mode}. Clique para mudar para {next}.",
    cards_auto: "Auto", cards_summary: "Resumido", cards_full: "Completo",
    cardsAuto: "Auto (resumido na densidade compacta)",
    cardsTip: "Cartões: {mode}. Clique para mudar para {next}.",
  },
};

// The buttons of dock/panels.json (the same file the Dock layout reads). Entry:
//   { id, label, icon, mod, props?, opens?: "panel" | "tab" | "command", name?, run?, args? }
//   "panel" (default): a block of the side panel, added to this layout by this bar.
//   "tab": a tab per space with `mod` as its only pane.
//   "command": runs a Herdr command (`run`, `args`).
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ids = (node, out = new Set()) => {
  if (node?.id) out.add(node.id);
  for (const child of node?.children ?? []) ids(child, out);
  return out;
};

// One tab per space for this mod: focus it if it exists, otherwise create it.
function showTab(mod, name) {
  const active = spaces().find((p) => p.active);
  const tabIds = new Set(active?.tabs.map((tab) => tab.id) ?? []);
  const open = panes().find((pane) => pane.mod === mod && tabIds.has(pane.tab));
  if (open) {
    const zoomed = panes().find((pane) => pane.tab === open.tab && pane.zoomed);
    if (zoomed && zoomed.pane !== open.pane) run("pane.zoom", { pane: zoomed.pane });
    return run("pane.focus", { pane: open.pane });
  }
  return run("tab.new", { name, mod });
}

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
      this.entries = []; // the buttons of dock/panels.json
      this.loaded = false;
      this.version = 0;
      this.lastTry = null;
      this.injected = new Set();
      try { this.injected = new Set(JSON.parse(localStorage.getItem("kanban.injected") ?? "[]")); } catch {}
      const dir = `${appHome()}/dock`;
      cx.spawn(async (cx) => {
        try { await fs.mkdir(dir, { recursive: true }); } catch {}
        await this.loadEntries(cx);
        // The file is the whole interface: a save shows up in the bar at once.
        for (;;) {
          try { await watchFolder(dir); } catch { return; }
          await this.loadEntries(cx);
        }
      });
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

  /** All the columns, left to right. A saved order keeps only known ids; a column it does not list goes at the end. */
  columns() {
    const saved = shared(KEY_ORDER);
    const ids = Array.isArray(saved) ? saved.filter((id, i) => COLUMNS.some((c) => c.id === id) && saved.indexOf(id) === i) : [];
    return [...ids.map((id) => COLUMNS.find((c) => c.id === id)), ...COLUMNS.filter((c) => !ids.includes(c.id))];
  }

  /** The visible column next to `id` in direction `dir` (-1 left, +1 right), or null at the edge. */
  neighbor(id, dir) {
    const hidden = this.hidden();
    const shown = this.columns().filter((c) => !hidden.has(c.id));
    return shown[shown.findIndex((c) => c.id === id) + dir]?.id ?? null;
  }

  /** Swaps column `id` with the visible column next to it. Hidden columns keep their place. */
  moveColumn(id, dir) {
    const other = this.neighbor(id, dir);
    if (!other) return;
    const order = this.columns().map((c) => c.id);
    const a = order.indexOf(id), b = order.indexOf(other);
    [order[a], order[b]] = [order[b], order[a]];
    setShared(KEY_ORDER, order);
  }

  scope() { return shared(KEY_SCOPE) === "space" ? "space" : "all"; }

  /** The widest a column may be (px), or null for Auto. */
  maxWidth() {
    const w = shared(KEY_WIDTH);
    return typeof w === "number" && w >= MIN_COLUMN ? w : null;
  }

  /** Moves the width control one step: -1 narrower, +1 wider. Auto is the widest step. */
  stepWidth(dir) {
    const now = WIDTHS.indexOf(this.maxWidth());
    const next = Math.min(WIDTHS.length - 1, Math.max(0, (now < 0 ? WIDTHS.length - 1 : now) + dir));
    setShared(KEY_WIDTH, WIDTHS[next]);
  }

  density() {
    const d = shared(KEY_DENSITY);
    return DENSITIES.includes(d) ? d : "auto";
  }

  stepDensity() {
    const i = DENSITIES.indexOf(this.density());
    setShared(KEY_DENSITY, DENSITIES[(i + 1) % DENSITIES.length]);
  }

  cardView() {
    const v = shared(KEY_CARDS);
    return CARD_VIEWS.includes(v) ? v : "auto";
  }

  stepCardView() {
    const i = CARD_VIEWS.indexOf(this.cardView());
    setShared(KEY_CARDS, CARD_VIEWS[(i + 1) % CARD_VIEWS.length]);
  }

  /** True when the cards show summarized. Auto follows the density of the board. */
  summary(boardCompact) {
    const v = this.cardView();
    return v === "auto" ? boardCompact : v === "summary";
  }

  /** True when this part shows compact. `width`: what on_size_change gave (undefined before the
   *  first layout; the same px as .w() and .gap()). `wide`: the width below which Auto is compact. */
  compact(width, wide) {
    const d = this.density();
    if (d !== "auto") return d === "compact";
    return typeof width === "number" && width < wide;
  }

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
  shellShown() { const node = find(layout(), SHELL_ID); return Boolean(node && !node.hidden); }

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

  /** Reads dock/panels.json. A missing file is an empty list. A broken file keeps the last good list. */
  async loadEntries(cx) {
    let problem = null;
    try {
      const text = await readTextFile(`${appHome()}/dock/panels.json`);
      if (text === null) this.entries = [];
      else {
        const mods = new Set(await fs.readdir(`${appHome()}/mods`));
        const list = JSON.parse(text)?.panels;
        if (!Array.isArray(list)) throw new Error('expected {"panels": [...]}');
        const seen = new Set(), entries = [];
        for (const raw of list) {
          const command = raw?.opens === "command";
          const why = !raw || typeof raw !== "object" ? "not an object"
            : !ID.test(String(raw.id)) ? `bad id "${raw.id}" (use a-z, 0-9, -)`
            : seen.has(raw.id) ? `id "${raw.id}" twice`
            : typeof raw.label !== "string" || !raw.label ? `"${raw.id}" has no label`
            : typeof raw.icon !== "string" || !raw.icon ? `"${raw.id}" has no icon`
            : command && (typeof raw.run !== "string" || !raw.run) ? `"${raw.id}" has no run`
            : !command && (typeof raw.mod !== "string" || !mods.has(raw.mod)) ? `"${raw.id}": mod "${raw.mod}" is not in mods/`
            : null;
          if (why) { problem = problem ?? why; continue; }
          seen.add(raw.id);
          entries.push({ id: raw.id, label: raw.label, icon: raw.icon, mod: raw.mod, props: raw.props,
            run: command ? raw.run : undefined, args: command && raw.args && typeof raw.args === "object" ? raw.args : {},
            opens: command ? "command" : raw.opens === "tab" ? "tab" : "panel", name: typeof raw.name === "string" ? raw.name : raw.label });
        }
        this.entries = entries;
      }
    } catch (e) {
      problem = `panels.json: ${e?.message ?? e}`;
    }
    this.loaded = true;
    this.version++;
    if (problem && problem !== this.problem) notify({ title: "Kanban: panels.json", body: problem, level: "error", timeout: 6000 });
    this.problem = problem;
    cx.notify();
  }

  /** Adds the blocks the file asks for to the side panel stack, and takes away the ones this bar
   *  added before that the file no longer lists. One attempt per file version and layout. */
  inject(root, body, wanted) {
    const keep = new Set(wanted.map((e) => e.id));
    const missing = wanted.filter((e) => !body.children.some((c) => c.id === e.id));
    const stale = body.children.filter((c) => this.injected.has(c.id) && !keep.has(c.id));
    if (!missing.length && !stale.length) return;
    const key = `${shared("layout")}|${this.version}`;
    if (key === this.lastTry) return;
    this.lastTry = key;
    const tree = JSON.parse(JSON.stringify(root)), target = find(tree, "panel-body");
    target.children = target.children.filter((c) => !stale.some((s) => s.id === c.id));
    if (stale.some((s) => s.id === target.active)) target.active = "files";
    for (const e of missing) target.children.push({ id: e.id, type: "block", content: { mod: e.mod, ...(e.props ? { props: e.props } : {}) } });
    // The layout file keeps no marker on a block, so the bar remembers which ones it added.
    for (const s of stale) this.injected.delete(s.id);
    for (const e of missing) this.injected.add(e.id);
    try { localStorage.setItem("kanban.injected", JSON.stringify([...this.injected])); } catch {}
    run("layout.set", { layout: tree });
  }

  /** A button of dock/panels.json that is not a side panel: a tab or a command. */
  runEntry(entry) {
    if (entry.opens === "tab") {
      showTab(entry.mod, entry.name);
      run("layout.select", { stack: "view", child: "tabs-view" }); // the tab shows in the Terminals view
      return;
    }
    if (entry.run === "layout.switch") setShared("layout.previous", shared("layout"));
    run(entry.run, entry.args ?? {});
  }

  /** Opens the side panel on `id`, or closes it when it already shows that one. */
  togglePanel(id) {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (!panel || !body) return;
    if (!panel.hidden && body.active === id) run("layout.hide", { id: "panel" });
    else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
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

  // ---- the shell under the board ----------------------------------------------

  /** The address of the live kanban-shell terminal. Starts it when it is absent or finished:
   *  the default shell of this computer (or props.shell, an argv list), in the folder of the active space. */
  async ensureShell() {
    const json = (r) => { try { return JSON.parse(r?.stdout ?? ""); } catch { return null; } };
    const info = json(await hc(["get", SHELL_NAME, "--json"]));
    if (info?.state === "live" && info.address) return info.address;
    if (info?.address) await hc(["rm", SHELL_NAME]); // a finished terminal keeps its name until removed
    const space = spaces().find((p) => p.active);
    const args = ["run", "--bg", "--json", "--keep", "--no-parent", "--name", SHELL_NAME, "--label", "kanban.shell=1"];
    if (space?.folder && !space.machine) args.push("--cwd", space.folder);
    const argv = Array.isArray(this.props.shell) ? this.props.shell.map(String) : [];
    if (argv.length) args.push("--", ...argv);
    const r = await hc(args);
    const out = json(r);
    if (!out?.address) throw new Error(out?.error?.message || r?.stderr || "hc run gave no address");
    return out.address;
  }

  /** Puts the shell block under the board, or points the block at a new address, with layout.set. */
  placeShell(address) {
    const tree = JSON.parse(JSON.stringify(layout()));
    const node = find(tree, SHELL_ID);
    if (node) {
      node.content = { terminal: address };
      delete node.hidden;
    } else {
      const view = find(tree, "board-view");
      const i = view?.children?.findIndex((c) => c.id === "board") ?? -1;
      if (i < 0) throw new Error('the layout has no "board" block in "board-view"');
      view.children[i] = { id: "board-main", type: "column", gap: 12, min: 160, children: [view.children[i], {
        id: SHELL_ID, type: "block", content: { terminal: address }, size: { px: 300 }, min: 120, max: 4000,
        background: "background", border: { width: 1, color: "border" }, radius: 14,
      }] };
    }
    run("layout.set", { layout: tree });
  }

  /** Hides the shell, or shows it: a live kanban-shell first, a new one when it ended. */
  toggleShell(cx) {
    if (this.shellBusy) return;
    if (this.shellShown()) { run("layout.hide", { id: SHELL_ID }); return; }
    this.shellBusy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const address = await this.ensureShell();
        if (find(layout(), SHELL_ID)?.content?.terminal === address) run("layout.show", { id: SHELL_ID });
        else this.placeShell(address);
      } catch (e) {
        notify({ title: "Kanban: shell", body: String(e?.message ?? e), level: "error", timeout: 6000 });
      }
      this.shellBusy = false;
      cx.notify();
    });
  }

  newAgent() { openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }); }

  // ---- the board -------------------------------------------------------------

  glyph(a, t, compact = false) {
    const prog = a.program ?? {};
    const tile = prog.tile || tint(t.foreground, "14");
    const inner = prog.icon
      ? (prog.tint ? svg(prog.icon).size(compact ? 13 : 15).text_color(prog.color || t.foreground) : image(prog.icon).size(compact ? 15 : 17))
      : svg(icon("bot")).size(compact ? 13 : 15).text_color(t.muted);
    return div().size(compact ? 24 : 28).rounded(compact ? 8 : 9).flex_none().flex().items_center().justify_center().bg(tile).child(inner);
  }

  /** The status mark at the right of a card: it moves for working and for needs you. */
  mark(a, t) {
    const color = t[a.status] ?? t.idle;
    if (a.status === "working") return svg(icon("spinner")).size(15).flex_none().text_color(color).spin(900);
    if (a.status === "blocked") return svg(icon("bell")).size(15).flex_none().text_color(color).loop("opacity", { from: 0.3, to: 1, period: 1100 });
    if (a.status === "done") return svg(icon("check")).size(15).flex_none().text_color(color);
    return svg(icon("moon")).size(14).flex_none().text_color(t.dim);
  }

  /** A card of 2 lines: the program icon, the space and the status mark, then the title, with no
   *  age so the title has room. The icon tells the program, so the space names the card. While the
   *  pointer is on the card, the pin and open buttons show at the end of the title line. */
  summaryCard(a, t) {
    const color = t[a.status] ?? t.idle;
    const pane = panes().find((p) => p.pane === a.pane);
    const selected = a.focused || focused()?.agent === a.address;
    const hot = a.status === "blocked";
    const name = a.program?.name || a.app || "Agent";
    const title = (a.title || "").trim();
    const head = a.space_name || name;
    const line = title && title !== name ? title : [name, pane?.branch].filter(Boolean).join(" · ");
    const over = this.hoverCard === a.address;
    const small = (id, symbol, action, tooltip, active = false) => iconButton(t, `${id}-${a.address}`, symbol, action,
      { active, tooltip, size: 20, glyph: 11, color: active ? t.accent : t.dim });

    return v_flex().id(`card-${a.address}`).w_full().flex_none().px(9).py(7).gap(4).rounded(9).cursor_pointer()
      .bg(selected ? t.raised : t.background)
      .border_1().border_color(selected ? t.accent : hot ? tint(color, "99") : t.border)
      .when(selected || hot, (e) => e.shadow_md())
      .hover((s) => s.bg(t.raised))
      .on_hover((hovered, cx) => {
        const next = hovered ? a.address : this.hoverCard === a.address ? null : this.hoverCard;
        if (next !== this.hoverCard) { this.hoverCard = next; cx.notify(); }
      })
      .on_click(() => this.select(a))
      .child(h_flex().gap(7).items_center()
        .child(this.glyph(a, t, true).size(20).rounded(6))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(head))
        .when(a.pinned && !over, (e) => e.child(svg(icon("pin")).size(11).flex_none().text_color(t.accent)))
        .child(this.mark(a, t)))
      .child(h_flex().h(20).gap(4).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(line))
        .when(over, (e) => e
          .child(small("pin", "pin", () => run("terminal.pin", { terminal: a.address, pinned: !a.pinned }), this.s(a.pinned ? "unpin" : "pin"), a.pinned))
          .child(small("open", "open", () => this.openInTab(a), this.s("open")))));
  }

  card(a, t, compact = false) {
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

    return v_flex().id(`card-${a.address}`).w_full().flex_none().p(compact ? 9 : 12).gap(compact ? 7 : 9).rounded(compact ? 10 : 12).cursor_pointer()
      .bg(selected ? t.raised : t.background)
      .border_1().border_color(selected ? t.accent : hot ? tint(color, "99") : t.border)
      .when(selected || hot, (e) => e.shadow_md())
      .hover((s) => s.bg(t.raised))
      .on_click(() => this.select(a))
      .when(a.status === "working", (e) => e.child(
        div().h(2).w_full().rounded(1).bg(color).loop("opacity", { from: 0.2, to: 1, period: 1400 })))
      .child(h_flex().gap(compact ? 7 : 9).items_center()
        .child(this.glyph(a, t, compact))
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

  /** An arrow in a column header that moves the column one place left (-1) or right (+1). Dim at the edge. */
  moveButton(t, c, dir, compact = false) {
    const can = this.neighbor(c.id, dir) !== null;
    return iconButton(t, `move-${dir < 0 ? "left" : "right"}-${c.id}`, dir < 0 ? "chevron-left" : "chevron-right",
      () => this.moveColumn(c.id, dir),
      { tooltip: can ? this.s(dir < 0 ? "moveLeft" : "moveRight") : "", size: compact ? 20 : 24, glyph: compact ? 12 : 14, color: can ? t.muted : tint(t.dim, "55") });
  }

  /** The width rules of one place in the row of columns. `fixed`: the board scrolls sideways, so the
   *  place has the minimum width and does not grow. */
  sized(el, compact, fixed) {
    const min = compact ? MIN_COLUMN_COMPACT : MIN_COLUMN, cap = this.maxWidth();
    return fixed ? el.flex_none().w(min) : el.flex_1().min_w(min).when(cap !== null, (e) => e.max_w(cap));
  }

  /** One status column. `compact`: smaller header and cards. `fixed`: see sized().
   *  `stacked`: the column shares its place with another column, one under the other. */
  column(c, list, t, searching, { compact = false, fixed = false, stacked = false, summary = false } = {}) {
    const color = t[c.id] ?? t.idle;
    const urgent = c.id === "blocked" && list.length > 0;
    const tile = div().size(compact ? 22 : 26).rounded(compact ? 7 : 8).flex_none().flex().items_center().justify_center().bg(tint(color, "26"))
      .child(svg(icon(c.symbol)).size(compact ? 12 : 14).text_color(color));
    const btn = compact ? 20 : 24;
    // Compact: the arrows and the eye show only while the pointer is on the header, so the name has room.
    const tools = !compact || this.hoverCol === c.id;
    const box = v_flex().id(`col-${c.id}`).min_h(0).rounded(compact ? 12 : 16).overflow_hidden();
    return (stacked ? box.w_full().flex_1() : this.sized(box.h_full(), compact, fixed))
      .border_1().border_color(urgent ? tint(color, "66") : tint(color, "26")).bg(tint(color, "0d"))
      .child(h_flex().id(`head-${c.id}`).h(compact ? 40 : 48).flex_none().px(compact ? 8 : 12).gap(compact ? 4 : 9).items_center()
        .when(compact, (e) => e.on_hover((hovered, cx) => {
          const next = hovered ? c.id : this.hoverCol === c.id ? null : this.hoverCol;
          if (next !== this.hoverCol) { this.hoverCol = next; cx.notify(); }
        }))
        .child(urgent ? tile.loop("opacity", { from: 0.55, to: 1, period: 1200 }) : tile)
        .child(div().flex_1().min_w(0).truncate().text_size(compact ? 12 : 13).font_semibold().text_color(t.foreground).child(this.s(c.id)))
        .child(div().h(20).px(compact ? 6 : 8).flex_none().rounded(10).flex().items_center().text_size(11).font_semibold()
          .bg(tint(color, "26")).text_color(color).child(String(list.length)))
        .when(tools, (e) => e
          .child(this.moveButton(t, c, -1, compact))
          .child(this.moveButton(t, c, 1, compact))
          .child(iconButton(t, `hide-${c.id}`, "eye-off", () => this.toggleColumn(c.id), { tooltip: this.s("hide"), size: btn, glyph: compact ? 12 : 14, color: t.dim }))))
      .child(v_flex().id(`scroll-${c.id}`).flex_1().min_h(0).overflow_y_scrollbar().px(compact ? 7 : 10).pb(compact ? 7 : 10).gap(summary ? 6 : compact ? 7 : 10)
        .children(list.map((a) => (summary ? this.summaryCard(a, t) : this.card(a, t, compact))))
        .when(list.length === 0, (e) => e.child(
          v_flex().h(compact ? 64 : 96).flex_none().items_center().justify_center().gap(compact ? 4 : 8).rounded(12)
            .border_1().border_dashed().border_color(tint(color, "44"))
            .child(svg(icon(c.symbol)).size(18).text_color(tint(color, "88")))
            .child(div().px(8).text_center().text_size(12).text_color(t.dim).child(this.s(searching ? "emptyColSearch" : "emptyCol"))))));
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
    const cols = this.columns().filter((c) => !hidden.has(c.id));
    // agent.next and agent.prev walk the cards in the order they show.
    setAgentOrder(cols.flatMap((c) => byStatus(c.id)).map((a) => a.address));
    if (!cols.length) {
      return this.emptyState(t, this.s("allHidden"), this.s("allHiddenHint"),
        button(t, "kb-show-all", this.s("showAll"), () => setShared(KEY_HIDDEN, []), { primary: true, symbol: "eye" }));
    }
    const compact = this.compact(this.boardW, cols.length * COLUMN_WIDE + (cols.length - 1) * GAP);
    // Places in the row: one column each. In compact density Done and Idle share one place, one
    // under the other, at the place of the first of the two in the order.
    const places = [];
    for (const c of cols) {
      const pair = compact && STACKED.includes(c.id) ? places.find((p) => p.length === 1 && STACKED.includes(p[0].id)) : null;
      if (pair) pair.push(c); else places.push([c]);
    }
    // A row that scrolls sideways lays its children out at their content width, so the columns
    // would not share the board. Scroll only when the places do not fit at their minimum width,
    // and then give each place exactly that width.
    const n = places.length;
    const min = compact ? MIN_COLUMN_COMPACT : MIN_COLUMN, gap = compact ? GAP_COMPACT : GAP;
    const fixed = typeof this.boardW === "number" && this.boardW < n * min + (n - 1) * gap;
    const opts = { compact, fixed, summary: this.summary(compact) };
    return h_flex().id("kb-columns").size_full().min_h(0).gap(gap)
      .when(fixed, (e) => e.overflow_x_scrollbar())
      .children(places.map((p) => p.length === 1
        ? this.column(p[0], byStatus(p[0].id), t, searching, opts)
        : this.sized(v_flex().id(`place-${p[0].id}`).h_full().min_h(0).gap(gap), compact, fixed)
          .children(p.map((c) => this.column(c, byStatus(c.id), t, searching, { ...opts, stacked: true })))));
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

  /** The buttons of the side panel and of dock/panels.json, in one group: Files and Changes, then the
   *  entries of the file in the order listed (side panels and tabs), then its commands. Empty when the
   *  layout has no `panel`. `compact`: icons only, the names go to the tooltips. */
  panelButtons(t, compact = false) {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (!panel || !body) return [];
    // The entries that may use the panel stack: not the id of any other node of the layout.
    const taken = ids(root);
    for (const c of body.children ?? []) taken.delete(c.id);
    const usable = this.entries.filter((e) => e.opens !== "command" && !taken.has(e.id) && !PANELS.some((p) => p.id === e.id));
    if (this.loaded) this.inject(root, body, usable.filter((e) => e.opens === "panel"));
    const present = new Set((body.children ?? []).map((c) => c.id));
    const lit = (id) => !panel.hidden && body.active === id;
    const tip = (name) => this.s("panelTip", { name });
    const buttons = [
      ...PANELS.filter((p) => present.has(p.id)).map((p) =>
        panelButton(t, `kb-panel-${p.id}`, p.icon, p.label, lit(p.id), () => this.togglePanel(p.id), tip(p.label), compact)),
      ...usable.filter((e) => e.opens === "tab" || present.has(e.id)).map((e) => e.opens === "tab"
        ? panelButton(t, `kb-tab-open-${e.id}`, e.icon, e.label, false, () => this.runEntry(e), "", compact)
        : panelButton(t, `kb-panel-${e.id}`, e.icon, e.label, lit(e.id), () => this.togglePanel(e.id), tip(e.label), compact)),
      // A command that switches to the layout shown now would do nothing: leave it out.
      ...this.entries.filter((e) => e.opens === "command" && !(e.run === "layout.switch" && e.args?.name === shared("layout")))
        .map((e) => panelButton(t, `kb-cmd-${e.id}`, e.icon, e.label, false, () => this.runEntry(e), "", compact)),
    ];
    return buttons.length ? [buttonGroup(t, buttons)] : [];
  }

  /** [−] 260 [+]: how wide a column may be. Auto lets the columns share the whole board. */
  widthControl(t) {
    const cap = this.maxWidth();
    const atMin = cap === WIDTHS[0], atMax = cap === null;
    return h_flex().h(32).flex_none().px(3).gap(1).items_center().rounded(10)
      .bg(tint(t.foreground, "0f")).border_1().border_color(t.border)
      .tooltip(this.s("widthTip", { w: cap === null ? this.s("auto") : `${cap} px` }))
      .child(iconButton(t, "kb-narrower", "minus", () => this.stepWidth(-1),
        { tooltip: this.s("narrower"), size: 24, glyph: 13, color: atMin ? t.dim : t.muted }))
      .child(div().w(34).flex_none().text_center().text_size(11).text_color(t.muted).child(cap === null ? this.s("auto") : String(cap)))
      .child(iconButton(t, "kb-wider", "plus", () => this.stepWidth(1),
        { tooltip: this.s("wider"), size: 24, glyph: 13, color: atMax ? t.dim : t.muted }));
  }

  /** The density button: lit while the board and bar are compact. The tooltip names the mode and the next one. */
  densityButton(t, compactNow) {
    const d = this.density();
    const next = DENSITIES[(DENSITIES.indexOf(d) + 1) % DENSITIES.length];
    const name = (x) => this.s(`density_${x}`);
    const mode = d === "auto" ? this.s(compactNow ? "densityNow" : "densityNowNormal", { mode: name(d) }) : name(d);
    return iconButton(t, "kb-density", "shrink", () => this.stepDensity(),
      { active: compactNow, tooltip: this.s("densityTip", { mode, next: name(next) }) });
  }

  /** The card view button: lit while the cards are set to summary. */
  cardsButton(t) {
    const v = this.cardView();
    const next = CARD_VIEWS[(CARD_VIEWS.indexOf(v) + 1) % CARD_VIEWS.length];
    const name = (x) => this.s(`cards_${x}`);
    return iconButton(t, "kb-cards", "list", () => this.stepCardView(),
      { active: v === "summary", tooltip: this.s("cardsTip", { mode: v === "auto" ? this.s("cardsAuto") : name(v), next: name(next) }) });
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
    const compact = this.compact(this.barW, BAR_WIDE);
    const count = need ? `${this.s("agents", all.length)} · ${this.s("needYou", { n: need })}` : this.s("agents", all.length);

    // The controls of the board view. In compact density they share one row that scrolls sideways
    // with the panel buttons, so the buttons at the right end of the bar always show.
    const chips = this.columns().map((c) => {
      const on = !hidden.has(c.id), name = this.s(c.id);
      return columnChip(t, `kb-chip-${c.id}`, {
        label: name, color: t[c.id] ?? t.idle, on, compact,
        count: this.visible().filter((a) => a.status === c.id).length,
        tooltip: this.s(on ? "hideCol" : "showCol", { name }),
      }, () => this.toggleColumn(c.id));
    });
    const tools = [
      iconButton(t, "kb-scope", "layers", () => setShared(KEY_SCOPE, this.scope() === "space" ? "all" : "space"),
        { active: this.scope() === "space", tooltip: this.s(this.scope() === "space" ? "scopeSpaceTip" : "scopeAllTip") }),
      this.widthControl(t),
      this.densityButton(t, compact),
      this.cardsButton(t),
      iconButton(t, "kb-shell", this.shellBusy ? "spinner" : "panel-bottom", (cx) => this.toggleShell(cx),
        { active: this.shellShown(), tooltip: this.s(this.shellShown() ? "shellOn" : "shellOff") }),
      iconButton(t, "kb-detail", "panel", () => run("layout.toggle", { id: "detail" }),
        { active: !this.detailHidden(), tooltip: this.s(this.detailHidden() ? "detailOff" : "detailOn") }),
    ];
    const scroller = (children) => h_flex().id("kb-strip").flex_1().min_w(0).gap(6).items_center().overflow_x_scrollbar().children(children);

    return h_flex().id("kb-bar").size_full().min_w(0).px(compact ? 10 : 14).gap(compact ? 6 : 10).items_center()
      .bg(t.chrome).border_b(1).border_color(t.border)
      .on_size_change((size, cx) => {
        const width = Math.round(size.width);
        if (width !== this.barW) { this.barW = width; cx.notify(); }
      })
      .child(div().id("kb-logo").size(28).rounded(9).flex_none().flex().items_center().justify_center().bg(tint(t.accent, "26"))
        .when(compact, (e) => e.tooltip(`${this.s("title")} · ${count}`))
        .child(svg(icon("board")).size(15).text_color(need && compact ? t.blocked : t.accent)))
      .when(!compact, (e) => e.child(v_flex().flex_none()
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child(this.s("title")))
        .child(div().text_size(11).text_color(need ? t.blocked : t.dim).child(count))))
      .child(segmented(t, [
        { id: "kb-view-board", label: compact ? "" : this.s("board"), symbol: "board", active: onBoard, tooltip: this.s("boardTip"),
          onClick: () => run("layout.select", { stack: "view", child: "board-view" }) },
        { id: "kb-view-tabs", label: compact ? "" : this.s("terminals"), symbol: "terminal", active: !onBoard, tooltip: this.s("terminalsTip"),
          onClick: () => run("layout.select", { stack: "view", child: "tabs-view" }) },
      ]))
      .when(onBoard, (e) => e
        .child(searchBox(t, "kb-search", this.query, {
          width: compact ? 150 : 220,
          onClear: () => { this.query.set_value(""); setShared(KEY_QUERY, ""); },
        }))
        .when(compact, (e) => e.child(scroller([...chips, ...tools, ...this.panelButtons(t, true)])))
        .when(!compact, (e) => e.child(scroller(chips)).children(tools)))
      .when(!onBoard, (e) => e.child(this.tabStrip(t)))
      .when(!onBoard || !compact, (e) => e.children(this.panelButtons(t, compact)))
      .when(Boolean(back), (e) => e.child(button(t, "kb-back", back, () => this.goBack(back),
        { symbol: "swap", tooltip: this.s("backTip", { name: back }), iconOnly: compact })))
      .child(button(t, "kb-new", this.s("newAgent"), () => this.newAgent(), { primary: true, symbol: "plus", iconOnly: compact }))
      .when(w?.buttons, (e) => e
        .child(wbtn("kb-min", win ? svg(icon("win-min")).size(16) : "−", () => run("window.minimize")))
        .child(wbtn("kb-max", win ? svg(icon(w.maximized ? "win-restore" : "win-max")).size(16) : "□", () => run("window.maximize")))
        .child(wbtn("kb-close", win ? svg(icon("win-close")).size(16) : svg(icon("close")).size(13), () => run("window.close"))));
  }

  render(_cx) {
    const t = theme();
    if (this.part === "bar") return this.bar(t);
    return v_flex().id("kanban").size_full().min_h(0).min_w(0).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => {
        const w = Math.round(size.width);
        if (w !== this.boardW) { this.boardW = w; cx.notify(); }
      })
      .child(this.board(t));
  }
}
