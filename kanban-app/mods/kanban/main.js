// Kanban for the Herdr app: every agent is a card in a column by status.
// One mod, two parts chosen by props.part:
//   "bar"   the top bar: search, column toggles, view switch, window buttons.
//   "board" the columns with the cards.
//   "panel-title" the title row of a panel dialog (the bar opens it, see openDialog).
//   "group-menu" the menu of a group button of the panel group, a popup (the bar opens it, see openGroup).
//   "clone-menu" the menu of the duplicate button of a card, a popup (the board opens it, see openClone).
//   "gear-menu" the menu of the gear button: Herdr's settings, Bar buttons or Herdr Mods, a popup (the bar opens it, see openGear).
//   "buttons-menu" the editor of the order and the visibility of the panel buttons, a popup (the bar opens it, see openButtons).
// The parts share their state through shared(): hidden columns, search text, scope.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import { agents, spaces, panes, focused, layout, layouts, window, theme, props, shared, setShared, run, openOverlay, closeOverlay,
  setAgentOrder, appHome, home, terminals, readTextFile, watchFolder, notify, nextCommand, hc, knownAgents } from "herdr";
import * as fs from "fs/promises";
import { icon, tint, iconButton, columnChip, segmented, searchBox, pill, button, panelButton, panelGlyph, buttonGroup, divider, stop } from "./ui.js";
import { WaitingTracker } from "./waiting.js";

const KEY_LANG = "herdr-mods.lang"; // the language of the whole kit, set in the mods-hub; absent: props.lang
const KEY_HIDDEN = "kanban.hidden"; // ids of the hidden columns
const KEY_WAITING = "kanban.waiting"; // "on" | "off"; absent: props.waiting (on unless it is false)
const KEY_DISMISSED = "kanban.waiting.dismissed"; // { "<terminal>": turn }: cards the person sent back to Done/Idle, for that turn
const KEY_QUERY = "kanban.query"; // the search text
const KEY_SCOPE = "kanban.scope"; // "all" | "space"
const KEY_WIDTH = "kanban.width"; // widest a column may be, in px; absent: columns share the board
const KEY_ORDER = "kanban.order"; // ids of the columns, left to right; absent: the order of COLUMNS
const KEY_DENSITY = "kanban.density"; // "auto" | "compact" | "normal"; absent: auto
const KEY_CARDS = "kanban.cards"; // "auto" | "summary" | "full"; absent: auto (summary while the board is compact)
const KEY_PANEL_OPEN = "kanban.panelOpen"; // "auto" | "side" | "dialog"; absent: auto. Shared with the Dock bar (tabs-dock)
const KEY_PANEL_DIALOG = "kanban.panelDialog"; // { id, panel }: the panel dialog that is open now; null: none
// Where the panel buttons open their panel. The button in the bar goes auto -> side -> dialog -> auto.
// Auto opens a dialog when the bar is narrower than PANEL_NARROW px (a small monitor), else the side panel.
const PANEL_OPENS = ["auto", "side", "dialog"];
const PANEL_NARROW = 1600;
const DIALOG_TITLE = 36; // px: the title row of a panel dialog
// The dialogs opened since the app started. shared() is saved to disk, so after a restart KEY_PANEL_DIALOG can
// name a dialog that is gone: the bar trusts it only when its id is here. On globalThis, not in the module:
// a layout switch starts a new copy of the bar with a new module, and the dialog stays open.
const liveDialogs = () => (globalThis.__kanbanPanelDialogs ??= new Set());
// The mods that the person turned off in the mods-hub: a list of mod folder names. The same key and the same rules
// as in mods/tabs-dock. The bar shows no button of an entry whose mod is off, hides the blocks of an off mod in its
// layout, and shows Herdr's own mod in a block of an off replacement mod (ORIGINALS). It undoes only what it did.
const KEY_OFF = "herdr-mods.disabled";
const ORIGINALS = { "space-deck": "spaces", "files-md": "files", "git-client": "changes" };
const offMods = () => { const v = shared(KEY_OFF); return new Set(Array.isArray(v) ? v.filter((n) => typeof n === "string") : []); };
// The mod of a panels.json entry: its `mod`, the mod of a "<mod>.<command>" or of a mod.open command.
const entryMod = (e) => e.mod ?? (e.run === "mod.open" ? e.args?.name : String(e.run ?? "").includes(".") ? String(e.run).split(".")[0] : null);
// Steps of the width control. null = Auto: the columns share the whole board.
const WIDTHS = [150, 180, 220, 260, 320, 400, null];
const MIN_COLUMN = 150; // narrowest a column may be before the board scrolls
const MIN_COLUMN_COMPACT = 120; // the same, in compact density
const GAP = 12, GAP_COMPACT = 8; // between the columns

// Density. The button in the bar goes auto -> compact -> normal -> auto.
// Auto makes each part compact by its own width (on_size_change, the same px as .w()):
// the bar below BAR_WIDE, the board below COLUMN_WIDE for each visible column.
// The density is shared with the Dock bar (tabs-dock): it has the same button and reads the same key.
const DENSITIES = ["auto", "compact", "normal"];
// Card view. The button in the bar goes auto -> summary -> full -> auto.
const CARD_VIEWS = ["auto", "summary", "full"];
const BAR_WIDE = 1800;
const LABELS_WIDE = 2250; // from this bar width the panel buttons show their names, not only icons
const COLUMN_WIDE = 220;
// The right end of the bar: the same values as in tabs-dock, so it does not move when the layout changes.
const BAR_RIGHT = 10; // padding after the window buttons
const RIGHT_GAP = 6; // between the panel group, the layout switch and the window buttons
// In compact density the columns of a group share one place, one under the other, at the place of
// the first of them in the column order. Waiting goes under Working, Idle under Done.
const GROUPS = [["working", "waiting"], ["done", "idle"]];
// "Waiting" is not a status the Herdr app reports: the mod derives it for a Claude Code agent that shows
// as Done or Idle while background subagents or shell commands still run (see waiting.js). It has no theme color of its own.
const WAITING = "waiting";
const statusColor = (t, status) => (status === WAITING ? t.ansi5 || t.accent : t[status] ?? t.idle);

// The shell under the board: one core terminal with this name, outside every tab, shown by a
// layout block { "terminal": "<address>" } with the id SHELL_ID. The bar adds the block the first time.
const SHELL_NAME = "kanban-shell";
const SHELL_ID = "shell";

// The side panel of the layout (node "panel", stack "panel-body"): Herdr's own Files and Changes mods.
const PANELS = [
  { id: "files", label: "Files", icon: icon("files") },
  { id: "changes", label: "Changes", icon: icon("changes"), group: "git" },
];
// The groups of panel buttons: the panels with the same `group` share one button, and a click on it opens a menu
// with the full name of each panel. A group that is not here uses its id as its name and the icon of its first panel.
// The same as GROUPS in mods/tabs-dock.
const PANEL_GROUPS = { git: { label: "Git", icon: icon("git") } };
const MENU_W = 220, MENU_PAD = 5, MENU_HEAD = 26, MENU_ROW = 32; // px: the menu of a group button
const CLONE_W = 270; // px: the menu of the duplicate button of a card
const EDIT_W = 280, EDIT_FOOT = 38; // px: the editor of the bar buttons (its width and its Reset row)

// The order of the panel buttons and the buttons that the bar hides, shared with the Dock bar (the same key and the
// same rules as in mods/tabs-dock): { order: [button id], hidden: [button id] }. A button id is the id of a panel or
// an entry, or "group-<group>" for a group button. The buttons that are not in `order` (a new entry of panels.json)
// come after the others, in the order of the file. Absent: the order of the file, no button hidden.
const KEY_BUTTONS = "kanban.barButtons";
const buttonId = (it) => (it.members ? `group-${it.group}` : it.id);
function barButtons() {
  const v = shared(KEY_BUTTONS), list = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === "string") : []);
  return { order: list(v?.order), hidden: list(v?.hidden) };
}
// The items (anything with an `id`) in the order of `order`; the others after them, in their own order.
function arrange(items, order) {
  const rank = new Map(order.map((id, i) => [id, i]));
  return items.map((it, i) => ({ it, i, r: rank.get(it.id) ?? order.length + i })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.it);
}

// The duplicate of an agent starts a new session: these flags continue an old one, so the clone drops them
// (with their value, when they have one). The same lists as `drop` in the agent-resume hook.
// An agent that is not here drops only --resume and --continue.
const SESSION_FLAGS = {
  claude: ["--resume", "-r", "--continue", "-c", "--session-id", "--fork-session", "--from-pr"],
  agy: ["--continue", "-c", "--conversation"],
  opencode: ["--continue", "-c", "--session", "-s"],
  codex: ["--last"],
};
const SESSION_DEFAULT = ["--resume", "--continue"];

/** The arguments of `agent` without the flags that continue a session. `codex resume <id>` loses "resume" and the id. */
function freshArgs(agent, args) {
  const drop = new Set(SESSION_FLAGS[agent] ?? SESSION_DEFAULT);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i], next = args[i + 1];
    const value = next !== undefined && !next.startsWith("-");
    if (agent === "codex" && i === 0 && (tok === "resume" || tok === "fork")) { if (value) i++; continue; }
    if (drop.has(tok.split("=")[0])) { if (!tok.includes("=") && value) i++; continue; }
    out.push(tok);
  }
  return out;
}

/** The argv that starts a new session of the agent in terminal `address`, or null when it is not known.
 *  First the labels of the agent-resume mod: resume.agent (the command) and resume.args (the flags it started
 *  with). The terminal's own argv is the shell the agent runs in, so it cannot tell. Else the command of the
 *  program in the list of known agents, with no arguments. */
async function cloneArgv(address, programKey, machine) {
  let labels = {};
  try { labels = JSON.parse((await hc(["get", address, "--json"]))?.stdout ?? "")?.labels ?? {}; } catch {}
  const agent = String(labels["resume.agent"] ?? "");
  if (/^[\w.-]+$/.test(agent)) return [agent, ...freshArgs(agent, String(labels["resume.args"] ?? "").split(/\s+/).filter(Boolean))];
  let list = [];
  try { list = await knownAgents({ on: machine ?? null }); } catch {}
  const known = list.find((k) => k.key === programKey && Array.isArray(k.run) && k.run.length);
  return known ? [known.run[0], ...freshArgs(known.key, known.run.slice(1))] : null;
}

// The default order: needs you, working, waiting, done, idle. The arrows in a column header change it,
// and shared(KEY_ORDER) keeps the new order.
const COLUMNS = [
  { id: "blocked", symbol: "bell" },
  { id: "working", symbol: "zap" },
  { id: WAITING, symbol: "hourglass" },
  { id: "done", symbol: "check" },
  { id: "idle", symbol: "moon" },
];

const STR = {
  en: {
    title: "Agents", search: "Search agents…",
    idle: "Idle", blocked: "Needs you", working: "Working", done: "Done", waiting: "Waiting",
    subagents: (n) => (n === 1 ? "1 subagent" : `${n} subagents`),
    commands: (n) => (n === 1 ? "1 command" : `${n} commands`),
    waitingOn: "Waiting column on: agents that wait for subagents or background commands get their own column. Click to turn it off.",
    waitingOff: "Waiting column off: those agents show as Done or Idle. Click to turn it on.",
    notWaiting: "Not waiting: show it as Done or Idle",
    agents: (n) => (n === 1 ? "1 agent" : `${n} agents`), needYou: "{n} need you",
    scopeAll: "All spaces", scopeSpace: "This space",
    scopeAllTip: "Showing every space. Click to show only the current space.",
    scopeSpaceTip: "Showing only the current space. Click to show every space.",
    board: "Board", terminals: "Terminals", boardTip: "Show the board", terminalsTip: "Show the terminals of the current space",
    detailOn: "Hide the terminal panel", detailOff: "Show the terminal panel", agentLabel: "Agent", shellLabel: "Shell",
    newAgent: "New agent", hide: "Hide this column", showCol: "Show {name}", hideCol: "Hide {name}",
    emptyCol: "No agents here", emptyColSearch: "No match",
    allHidden: "All columns are hidden", allHiddenHint: "Show a column to see its agents.", showAll: "Show all columns",
    none: "No agents yet", noneHint: "Start an agent with the New agent button. It appears here as a card, and moves between columns when its status changes.",
    pin: "Pin to the top of its column", unpin: "Unpin", open: "Open in its tab",
    now: "just now", min: "{n} min ago", hour: "{n} h ago", day: "{n} d ago",
    gearTitle: "Settings", gearHerdr: "Herdr settings", gearMods: "Herdr Mods",
    gearButtons: "Bar buttons", buttonsTitle: "Bar buttons (top of the list = left)", moveUp: "Move up", moveDown: "Move down",
    hideButton: "Hide in the bar", showButton: "Show in the bar", resetButtons: "Reset",
    newTab: "New tab", settingsTip: "Open the settings", backTip: "Switch to the {name} layout", layoutHere: "Shown now: the {name} layout", panelTip: "Show or hide {name}",
    auto: "Auto", widthTip: "Column width: {w}. Use − and + to change it.",
    toAuto: "Set Auto: the columns share the whole board",
    widthAutoTip: "Click the value to go back to Auto.",
    narrower: "Narrower columns", wider: "Wider columns",
    moveLeft: "Move this column left", moveRight: "Move this column right",
    shellOn: "Hide the shell under the board", shellOff: "Show a shell under the board",
    density_auto: "Auto", density_compact: "Compact", density_normal: "Normal",
    densityNow: "{mode} (compact now)", densityNowNormal: "{mode} (normal now)",
    densityTip: "Density: {mode}. Click to switch to {next}.",
    cards_auto: "Auto", cards_summary: "Summary", cards_full: "Full",
    cardsAuto: "Auto (summary in compact density)",
    cardsTip: "Cards: {mode}. Click to switch to {next}.",
    opens_auto: "Auto", opens_side: "Side panel", opens_dialog: "Dialog",
    opensNowDialog: "{mode} (dialog now)", opensNowSide: "{mode} (side panel now)",
    opensTip: "Panels open in: {mode}. Click to switch to {next}.",
    toSide: "Open in the side panel", toTab: "Open in a tab", closeDialog: "Close",
    rename: "Rename the tab", duplicate: "Duplicate this agent", cloneHere: "Duplicate in this space", cloneWorktree: "Duplicate in a new worktree…",
    cloneTitle: "Duplicate {name}", cloneFail: "Kanban: duplicate", noCommand: "The command of this agent is not known.",
  },
  pt: {
    title: "Agentes", search: "Buscar agentes…",
    idle: "Ociosos", blocked: "Precisam de você", working: "Trabalhando", done: "Concluídos", waiting: "Aguardando",
    subagents: (n) => (n === 1 ? "1 subagente" : `${n} subagentes`),
    commands: (n) => (n === 1 ? "1 comando" : `${n} comandos`),
    waitingOn: "Coluna Aguardando ligada: agentes que esperam subagentes ou comandos em segundo plano ganham uma coluna própria. Clique para desligar.",
    waitingOff: "Coluna Aguardando desligada: esses agentes aparecem como Concluídos ou Ociosos. Clique para ligar.",
    notWaiting: "Não está esperando: mostrar como Concluído ou Ocioso",
    agents: (n) => (n === 1 ? "1 agente" : `${n} agentes`), needYou: "{n} precisam de você",
    scopeAll: "Todos os espaços", scopeSpace: "Este espaço",
    scopeAllTip: "Mostrando todos os espaços. Clique para mostrar só o espaço atual.",
    scopeSpaceTip: "Mostrando só o espaço atual. Clique para mostrar todos os espaços.",
    board: "Quadro", terminals: "Terminais", boardTip: "Mostrar o quadro", terminalsTip: "Mostrar os terminais do espaço atual",
    detailOn: "Ocultar o painel do terminal", detailOff: "Mostrar o painel do terminal", agentLabel: "Agente", shellLabel: "Shell",
    newAgent: "Novo agente", hide: "Ocultar esta coluna", showCol: "Mostrar {name}", hideCol: "Ocultar {name}",
    emptyCol: "Nenhum agente aqui", emptyColSearch: "Nada encontrado",
    allHidden: "Todas as colunas estão ocultas", allHiddenHint: "Mostre uma coluna para ver os agentes dela.", showAll: "Mostrar todas as colunas",
    none: "Nenhum agente ainda", noneHint: "Inicie um agente com o botão Novo agente. Ele aparece aqui como um cartão e muda de coluna quando o status muda.",
    pin: "Fixar no topo da coluna", unpin: "Desafixar", open: "Abrir na aba dele",
    now: "agora", min: "há {n} min", hour: "há {n} h", day: "há {n} d",
    gearTitle: "Configurações", gearHerdr: "Configurações do Herdr", gearMods: "Herdr Mods",
    gearButtons: "Botões da barra", buttonsTitle: "Botões da barra (topo da lista = esquerda)", moveUp: "Mover para cima",
    moveDown: "Mover para baixo", hideButton: "Ocultar na barra", showButton: "Mostrar na barra", resetButtons: "Restaurar",
    newTab: "Nova aba", settingsTip: "Abrir as configurações", backTip: "Trocar para o layout {name}", layoutHere: "Layout atual: {name}", panelTip: "Mostrar ou ocultar {name}",
    auto: "Auto", widthTip: "Largura da coluna: {w}. Use − e + para mudar.",
    toAuto: "Voltar para Auto: as colunas dividem o quadro todo",
    widthAutoTip: "Clique no valor para voltar para Auto.",
    narrower: "Colunas mais estreitas", wider: "Colunas mais largas",
    moveLeft: "Mover esta coluna para a esquerda", moveRight: "Mover esta coluna para a direita",
    shellOn: "Ocultar o shell abaixo do quadro", shellOff: "Mostrar um shell abaixo do quadro",
    density_auto: "Auto", density_compact: "Compacta", density_normal: "Normal",
    densityNow: "{mode} (compacta agora)", densityNowNormal: "{mode} (normal agora)",
    densityTip: "Densidade: {mode}. Clique para mudar para {next}.",
    cards_auto: "Auto", cards_summary: "Resumido", cards_full: "Completo",
    cardsAuto: "Auto (resumido na densidade compacta)",
    cardsTip: "Cartões: {mode}. Clique para mudar para {next}.",
    opens_auto: "Auto", opens_side: "Painel lateral", opens_dialog: "Diálogo",
    opensNowDialog: "{mode} (diálogo agora)", opensNowSide: "{mode} (painel lateral agora)",
    opensTip: "Os painéis abrem em: {mode}. Clique para mudar para {next}.",
    toSide: "Abrir no painel lateral", toTab: "Abrir numa aba", closeDialog: "Fechar",
    rename: "Renomear a tab", duplicate: "Duplicar este agente", cloneHere: "Duplicar neste espaço", cloneWorktree: "Duplicar num novo worktree…",
    cloneTitle: "Duplicar {name}", cloneFail: "Kanban: duplicar", noCommand: "O comando deste agente não é conhecido.",
  },
};

// The buttons of dock/panels.json (the same file the Dock layout reads). Entry:
//   { id, label, icon, mod, props?, opens?: "panel" | "tab" | "command", name?, run?, args?, group? }
//   "panel" (default): a block of the side panel, added to this layout by this bar.
//   "tab": a tab per space with `mod` as its only pane.
//   "command": runs a Herdr command (`run`, `args`).
//   group: the entries with the same group share one button (see PANEL_GROUPS). "git" puts it with Changes.
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
// The node that shows and hides the side panel: the column "panel" around the stack "panel-body". When a block
// leaves the layout (the shell under the board, when its terminal ends), Herdr removes each column that keeps only
// one child, and "panel" is one of them. Then the stack itself is the panel.
const sidePanel = (root) => find(root, "panel") ?? find(root, "panel-body");
// The name of a layout file as a button label: "main-dock" -> "Main dock".
const layoutLabel = (name) => { const s = String(name).replace(/[-_]+/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); };
// The panel buttons in the order of the bar, with the entries of a group put together: an item stays as it is,
// and the first entry of a group becomes { group, members: [entry, ...] } in its place. The same as in mods/tabs-dock.
function foldGroups(items) {
  const out = [], seen = new Map();
  for (const it of items) {
    if (!it.group) { out.push(it); continue; }
    let g = seen.get(it.group);
    if (!g) { g = { group: it.group, members: [] }; seen.set(it.group, g); out.push(g); }
    g.members.push(it);
  }
  return out;
}
const base = (p) =>String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";

export default class Kanban extends View {
  init(given, cx) {
    // Read props once and keep them: props() in a later callback can answer for another copy.
    this.props = (given && Object.keys(given).length ? given : props()) || {};
    this.part = ["bar", "panel-title", "group-menu", "clone-menu", "gear-menu", "buttons-menu"].includes(this.props.part) ? this.props.part : "board";
    if (["panel-title", "group-menu", "clone-menu", "gear-menu", "buttons-menu"].includes(this.part)) {
      this.overlay = this.props.overlay ?? props()?.overlay;
      if (this.part === "panel-title") this.takeKeys(cx);
      return;
    }
    // Which Claude Code agents wait for subagents. Both parts run one: they count the cards too.
    const minutes = Number(this.props.waitingMinutes);
    this.tracker = new WaitingTracker({ hc, home, dirs: this.props.claudeDirs, ttlMs: minutes > 0 ? minutes * 60000 : undefined });
    this.waitSig = null;
    this.waitBusy = false;
    // The pencil of a card opens the tab-namer dialog, when that mod is installed.
    this.namer = false;
    const findNamer = (cx) => cx.spawn(async (cx) => {
      let found = false;
      try { found = Boolean(await readTextFile(`${appHome()}/mods/tab-namer/mod.json`)); } catch {}
      if (found !== this.namer) { this.namer = found; cx.notify(); }
    });
    findNamer(cx);
    cx.timer.every(60000, (cx) => findNamer(cx));
    if (this.part === "bar") {
      this.query = InputState.new({ placeholder: this.s("search"), value: String(shared(KEY_QUERY) ?? "") });
      this.query.on("change", () => setShared(KEY_QUERY, this.query.value()));
      this.entries = []; // the buttons of dock/panels.json
      this.groups = new Map(); // group id -> its panels, from the last render: the menu of a group button lists them
      this.loaded = false;
      this.version = 0;
      this.lastTry = null;
      this.injected = new Set();
      try { this.injected = new Set(JSON.parse(localStorage.getItem("kanban.injected") ?? "[]")); } catch {}
      // The blocks that this bar hid or swapped for an off mod: { "<layout>|<block id>": "<mod>" }.
      this.kitOff = {};
      try { this.kitOff = JSON.parse(localStorage.getItem("kanban.kitOff") ?? "{}") ?? {}; } catch {}
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
      // "kanban.panel-open" steps where the panels open, as the button does. "kanban.panel-<id>" opens or
      // closes the panel <id> (files, changes, or an id of dock/panels.json), as its button does.
      // "kanban.group-<id>" opens the menu of a group button (kanban.group-git). "kanban.gear" does what the
      // gear button does. "kanban.buttons" opens the editor of the bar buttons.
      cx.spawn(async (cx) => {
        for (;;) {
          const cmd = String(await nextCommand());
          if (cmd === "panel-open") this.stepPanelOpen();
          else if (cmd === "gear") this.openGear();
          else if (cmd === "buttons") this.openButtons();
          else if (cmd.startsWith("group-")) this.openGroup(cmd.slice(6));
          else if (cmd.startsWith("panel-")) this.togglePanel(cmd.slice(6));
          cx.notify();
        }
      });
    } else {
      cx.timer.every(30000, (cx) => cx.notify()); // keeps "3 min ago" fresh
    }
    // The subagents run on their own: look again now and then at the agents known to wait, so a
    // limit of time or a lost session cannot keep a card here for good.
    cx.timer.every(30000, (cx) => {
      if (this.waitingOn() && this.tracker.waits.size) this.syncWaiting(cx, true);
    });
  }

  /** The language: the kit setting `herdr-mods.lang` when it is set, else the `lang` prop, else English. */
  get lang() {
    const kit = shared(KEY_LANG);
    return STR[kit] ? kit : STR[this.props?.lang] ? this.props.lang : "en";
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

  /** All the columns, left to right. Waiting is one of them only while the feature is on. A saved order
   *  keeps only known ids; a column it does not list goes right after the column that comes before it
   *  in COLUMNS (so Waiting lands under Working for a person who saved an order before it existed). */
  columns() {
    const known = COLUMNS.filter((c) => c.id !== WAITING || this.waitingOn());
    const saved = shared(KEY_ORDER);
    const order = Array.isArray(saved) ? saved.filter((id, i) => known.some((c) => c.id === id) && saved.indexOf(id) === i) : [];
    known.forEach((c, i) => {
      if (order.includes(c.id)) return;
      const before = known.slice(0, i).reverse().find((p) => order.includes(p.id));
      order.splice(before ? order.indexOf(before.id) + 1 : 0, 0, c.id);
    });
    return order.map((id) => known.find((c) => c.id === id));
  }

  // ---- agents that wait for subagents --------------------------------------------

  /** The Waiting column: on unless the person turned it off (the button in the bar, saved in
   *  shared) or the layout says `"waiting": false` in the props of the block. Off, every agent shows as
   *  its Herdr status says and the mod reads no transcript. */
  waitingOn() {
    const v = shared(KEY_WAITING);
    return v === "on" || v === "off" ? v === "on" : this.props.waiting !== false;
  }

  toggleWaiting() { setShared(KEY_WAITING, this.waitingOn() ? "off" : "on"); }

  /** The agents with the status the board shows: a Claude Code agent that is Done or Idle while its
   *  subagents run gets "waiting" and `wait` ({ count, items }). The answer counts only for the turn
   *  it was read in: when the agent works again it is stale and the card goes back at once. A hidden
   *  Waiting column counts as off, so the card stays in Done or Idle and does not leave the board. */
  withWaiting(list) {
    if (!this.waitingOn() || this.hidden().has(WAITING) || !this.tracker.waits.size) return list;
    const turns = new Map(terminals().map((x) => [x.address, x.turn]));
    const dismissed = shared(KEY_DISMISSED) ?? {};
    return list.map((a) => {
      const w = a.status === "done" || a.status === "idle" ? this.tracker.waits.get(a.address) : null;
      return w && w.turn === turns.get(a.address) && dismissed[a.address] !== w.turn ? { ...a, status: WAITING, wait: w } : a;
    });
  }

  /** The person says this agent does not wait (Claude Code can leave a finished subagent marked as
   *  waiting): the card goes back to Done or Idle until the agent takes another turn. */
  dismissWaiting(a) {
    setShared(KEY_DISMISSED, { ...(shared(KEY_DISMISSED) ?? {}), [a.address]: a.wait.turn });
  }

  /** Looks at the Claude Code agents that show as Done or Idle, when one of them changed turn. It runs
   *  off the render and asks for another one when the answer changes. `again`: read the transcripts
   *  of the agents known to wait once more, even if their turn is the same (the timer does). */
  syncWaiting(cx, again = false) {
    if (!this.waitingOn()) { this.waitSig = null; return; }
    const turns = new Map(terminals().map((x) => [x.address, x.turn]));
    const candidates = agents().filter((a) => a.app === "claude-code" && (a.status === "done" || a.status === "idle"))
      .map((a) => ({ address: a.address, turn: turns.get(a.address), cwd: panes().find((p) => p.pane === a.pane)?.cwd ?? null }));
    const sig = candidates.map((c) => `${c.address}:${c.turn}`).join("|");
    if (sig === this.waitSig && !again) return;
    if (this.waitBusy) { this.waitSig = null; return; } // look again on the next render
    this.waitSig = sig;
    this.waitBusy = true;
    const recheck = again ? new Set(this.tracker.waits.keys()) : new Set();
    cx.spawn(async (cx) => {
      let changed = false;
      try { changed = await this.tracker.refresh(candidates, Date.now(), recheck); } catch {}
      this.waitBusy = false;
      if (changed) cx.notify();
      if (this.waitSig === null) this.syncWaiting(cx); // an agent changed turn while this one read
    });
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
    const scoped = this.withWaiting(this.scope() === "space" ? agents().filter((a) => a.space === space) : agents());
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
            : raw.group !== undefined && !ID.test(String(raw.group)) ? `"${raw.id}": bad group "${raw.group}" (use a-z, 0-9, -)`
            : null;
          if (why) { problem = problem ?? why; continue; }
          seen.add(raw.id);
          entries.push({ id: raw.id, label: raw.label, icon: raw.icon, mod: raw.mod, props: raw.props, group: raw.group,
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
    if (!missing.length && !stale.length) return false;
    const key = `${shared("layout")}|${this.version}|${[...offMods()].sort().join(",")}`;
    if (key === this.lastTry) return false;
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
    return true;
  }

  /** The entries of panels.json whose mod is on. */
  liveEntries() {
    const off = offMods();
    return off.size ? this.entries.filter((e) => !off.has(entryMod(e))) : this.entries;
  }

  /** Makes the layout follow the mods that are on (the same as reconcile in mods/tabs-dock). A block of a mod
   *  that is off (shared KEY_OFF) is hidden; a block of an off replacement mod shows Herdr's own mod (ORIGINALS).
   *  When the mod is on again, the bar shows the block again, or puts the mod back. A side panel that shows a
   *  hidden block closes. One attempt for each layout and wanted change, as in inject(). */
  reconcile(root) {
    const name = shared("layout"), off = offMods();
    const tree = JSON.parse(JSON.stringify(root));
    let changed = false;
    const walk = (node) => {
      for (const child of node?.children ?? []) walk(child);
      const mod = node?.content?.mod, key = `${name}|${node?.id}`;
      if (!node?.id || typeof mod !== "string") return;
      const mine = this.kitOff[key];
      if (mine && !off.has(mine)) {
        // The mod is on again: undo what this bar did (only when the block is still as the bar left it).
        if (ORIGINALS[mine] && mod === ORIGINALS[mine]) { node.content = { ...node.content, mod: mine }; changed = true; }
        else if (!ORIGINALS[mine] && mod === mine && node.hidden) { delete node.hidden; changed = true; }
        delete this.kitOff[key];
      } else if (off.has(mod)) {
        if (ORIGINALS[mod]) node.content = { ...node.content, mod: ORIGINALS[mod] };
        else if (!node.hidden) node.hidden = true;
        else return;
        this.kitOff[key] = mod;
        changed = true;
      }
    };
    walk(tree);
    const panel = sidePanel(tree), body = find(tree, "panel-body");
    if (panel && !panel.hidden && (body?.children ?? []).some((c) => c.id === body.active && c.hidden)) { panel.hidden = true; changed = true; }
    try { localStorage.setItem("kanban.kitOff", JSON.stringify(this.kitOff)); } catch {}
    if (!changed) { this.reconcileTry = null; return; }
    const attempt = `${name}|${JSON.stringify(tree)}`;
    if (attempt === this.reconcileTry) return;
    this.reconcileTry = attempt;
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

  /** Opens the panel `id` in the side panel or in a dialog (see panelOpen), or closes it when it already shows
   *  there. A click on another panel button closes the open dialog first. A tab entry of dock/panels.json
   *  (Insights) opens in a dialog too, else in its tab. */
  togglePanel(id) {
    const live = this.liveEntries();
    // A key of a panel whose mod is off does nothing.
    if (live.length < this.entries.length && this.entries.some((e) => e.id === id) && !live.some((e) => e.id === id)) return;
    const command = live.find((e) => e.id === id && e.opens === "command");
    if (command) return this.runEntry(command); // a command of a group menu
    const root = layout(), panel = sidePanel(root), body = find(root, "panel-body");
    const tab = live.find((e) => e.id === id && e.opens === "tab");
    const node = (body?.children ?? []).find((c) => c.id === id && !c.hidden);
    if (!tab && (!panel || !node)) return;
    const open = shared(KEY_PANEL_DIALOG);
    if (open?.id) {
      closeOverlay(open.id);
      setShared(KEY_PANEL_DIALOG, null);
      if (open.panel === id && liveDialogs().has(open.id)) return;
    }
    // A panel that shows in the side panel now (also one moved there from a dialog) closes, in every mode.
    if (node && panel && !panel.hidden && body.active === id) return run("layout.hide", { id: panel.id });
    if (this.dialogNow()) return this.openDialog(id, tab ? { mod: tab.mod, ...(tab.props ? { props: tab.props } : {}) } : node.content, tab);
    if (tab) return this.runEntry(tab);
    if (!panel.hidden && body.active === id) run("layout.hide", { id: panel.id });
    else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: panel.id }); }
  }

  panelOpen() {
    const v = shared(KEY_PANEL_OPEN);
    return PANEL_OPENS.includes(v) ? v : "auto";
  }

  stepPanelOpen() {
    const i = PANEL_OPENS.indexOf(this.panelOpen());
    setShared(KEY_PANEL_OPEN, PANEL_OPENS[(i + 1) % PANEL_OPENS.length]);
  }

  /** True when a panel button opens a dialog now: always in Dialog, below PANEL_NARROW px of bar in Auto. */
  dialogNow() {
    const v = this.panelOpen();
    return v === "dialog" || (v === "auto" && typeof this.barW === "number" && this.barW < PANEL_NARROW);
  }

  /** Opens the panel `id` in a dialog: a title row (this mod, part "panel-title") over `content`, the same mod
   *  and props as in the side panel (or in the tab, for a `tab` entry). The dialog holds a layout, so the panel
   *  gets a real block, as in the side panel. Its own copy starts fresh. */
  openDialog(id, content, tab = null) {
    if (!content?.mod) return;
    const entry = [...PANELS, ...this.entries].find((e) => e.id === id);
    const title = { part: "panel-title", panel: id, label: entry?.label ?? id, icon: entry?.icon ?? "", lang: this.lang,
      ...(tab ? { tab: { mod: tab.mod, name: tab.name } } : {}) };
    const overlay = openOverlay({
      kind: "dialog", width: 0.82, height: 0.85,
      layout: { type: "column", children: [
        { id: "panel-dialog-title", type: "block", size: { px: DIALOG_TITLE }, content: { mod: "kanban", props: title } },
        { id: `panel-dialog-${id}`, type: "block", content },
      ] },
    });
    liveDialogs().add(overlay);
    setShared(KEY_PANEL_DIALOG, { id: overlay, panel: id });
  }

  /** The panel that shows in a dialog now, or null. */
  dialogPanel() {
    const open = shared(KEY_PANEL_DIALOG);
    return open?.id && liveDialogs().has(open.id) ? open.panel : null;
  }

  /** The title row of a panel dialog: the icon and name of the panel, a button that moves it to the side
   *  panel (to its tab, for a tab entry) and a close button. Esc and a click beside the dialog close it too. */
  panelTitle(t) {
    const p = this.props;
    const path = String(p.icon || "");
    const glyph = !path ? div().size(14) : path.endsWith(".svg") ? svg(path).size(14).text_color(t.accent) : image(path).size(14);
    const move = p.tab
      ? iconButton(t, "kb-dlg-tab", "open", () => this.dialogToSide(), { tooltip: this.s("toTab"), size: 26, glyph: 14 })
      : iconButton(t, "kb-dlg-side", "panel", () => this.dialogToSide(), { tooltip: this.s("toSide"), size: 26, glyph: 14 });
    return h_flex().id("kb-dlg-title").size_full().pl(14).pr(8).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.closeDialog(); } })
      .child(glyph.flex_none())
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(String(p.label ?? "")))
      .child(move)
      .child(iconButton(t, "kb-dlg-close", "close", () => this.closeDialog(), { tooltip: this.s("closeDialog"), size: 26, glyph: 13 }));
  }

  closeDialog() {
    const id = this.overlay ?? shared(KEY_PANEL_DIALOG)?.id;
    if (id) closeOverlay(id);
  }

  // The title row of a panel dialog takes the keyboard when the dialog opens. Else the terminal
  // behind the dialog keeps it and gets Esc. The panel in the dialog can take the keyboard later
  // (a filter field after 40 ms), so this runs at once and once more after 10 ms.
  takeKeys(cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(10, () => this.handle.focus());
  }

  /** The name and the icon of a group button. */
  groupInfo(group) {
    const known = PANEL_GROUPS[group], first = this.groups.get(group)?.[0];
    return { label: known?.label ?? layoutLabel(group), icon: known?.icon ?? first?.icon ?? "" };
  }

  /** Opens the menu of a group button at the pointer: one row per panel of the group, with its full name. The rows
   *  come from the last render (lit = open now). A popup is as tall as its content, so the height is set here. */
  openGroup(group) {
    const members = this.groups?.get(group);
    if (!members?.length) return;
    const info = this.groupInfo(group);
    openOverlay({
      mod: "kanban", kind: "popup", width: MENU_W, height: MENU_PAD * 2 + MENU_HEAD + members.length * MENU_ROW,
      props: { part: "group-menu", lang: this.lang, title: info.label, items: members.map((m) => ({ id: m.id, label: m.label, icon: m.icon, on: m.on })) },
    });
  }

  /** The menu of a group button: the name of the group, then one row per panel (icon, full name, a tick while it is
   *  open). A click closes the menu and sends the panel to the bar ("kanban.panel-<id>"), as a click on its button does. */
  groupMenu(t) {
    const p = this.props, items = Array.isArray(p.items) ? p.items : [];
    const row = (it) => h_flex().id(`kb-gm-${it.id}`).w_full().h(MENU_ROW).px(10).gap(10).flex_none().items_center().rounded(6).cursor_pointer()
      .text_size(13).text_color(it.on ? t.accent : t.foreground)
      .when(it.on, (e) => e.bg(tint(t.accent, "1a")))
      .hover((s) => s.bg(it.on ? tint(t.accent, "33") : t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); this.pick(it.id); })
      .child(panelGlyph(it.icon, 15, it.on ? t.accent : t.muted))
      .child(div().flex_1().min_w(0).truncate().child(String(it.label ?? it.id)))
      .when(it.on, (e) => e.child(svg(icon("tick")).size(13).flex_none().text_color(t.accent)));
    return v_flex().id("kb-gm-root").w_full().p(MENU_PAD)
      .child(h_flex().w_full().h(MENU_HEAD).px(10).flex_none().items_center().text_size(11).font_semibold().text_color(t.dim).child(String(p.title ?? "")))
      .children(items.map(row));
  }

  pick(id) {
    run(`kanban.panel-${id}`);
    if (this.overlay) closeOverlay(this.overlay);
  }

  /** The gear button opens a menu: Herdr's settings, the editor of the bar buttons and, with the mods-hub
   *  installed, the Herdr Mods dialog. */
  openGear() {
    const open = (hub) => openOverlay({ mod: "kanban", kind: "popup", width: MENU_W,
      height: MENU_PAD * 2 + MENU_HEAD + (hub ? 3 : 2) * MENU_ROW, props: { part: "gear-menu", lang: this.lang, hub } });
    readTextFile(`${appHome()}/mods/mods-hub/mod.json`).then((text) => open(text != null), () => open(false));
  }

  /** Opens the editor of the bar buttons: one row per button of the panel group (a group button is one row), from
   *  the last render. A popup is as tall as its content, so the height is set here. */
  openButtons() {
    const items = this.buttonItems ?? [];
    if (!items.length) return;
    openOverlay({ mod: "kanban", kind: "popup", width: EDIT_W, height: MENU_PAD * 2 + MENU_HEAD + items.length * MENU_ROW + EDIT_FOOT,
      props: { part: "buttons-menu", lang: this.lang, items } });
  }

  /** The editor of the bar buttons: one row per button (icon, name, up, down, show or hide) in the order of the bar,
   *  and a Reset row. It reads and writes the shared key, so both bars change at once and the popup stays open.
   *  The same as buttonsMenu in mods/tabs-dock. */
  buttonsMenu(t) {
    const items = Array.isArray(this.props.items) ? this.props.items : [];
    const prefs = barButtons(), rows = arrange(items, prefs.order), hidden = new Set(prefs.hidden);
    const save = (next) => setShared(KEY_BUTTONS, { order: prefs.order, hidden: prefs.hidden, ...next });
    const move = (i, step) => {
      const list = rows.map((r) => r.id), j = i + step;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      save({ order: list });
    };
    const flip = (id) => save({ hidden: hidden.has(id) ? prefs.hidden.filter((x) => x !== id) : [...prefs.hidden, id] });
    const tool = (id, name, tip, fn, enabled = true) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6)
      .tooltip(tip)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); fn(); }))
      .child(svg(icon(name)).size(14).text_color(enabled ? t.muted : t.border));
    const row = (it, i) => {
      const off = hidden.has(it.id);
      return h_flex().id(`kb-bm-${it.id}`).w_full().h(MENU_ROW).pl(10).pr(2).gap(8).flex_none().items_center().rounded(6)
        .text_size(13).text_color(off ? t.dim : t.foreground).hover((s) => s.bg(tint(t.foreground, "0a")))
        .child(panelGlyph(it.icon, 15, off ? t.dim : t.muted))
        .child(div().flex_1().min_w(0).truncate().child(String(it.label ?? it.id)))
        .child(tool(`kb-bm-up-${it.id}`, "chevron-up", this.s("moveUp"), () => move(i, -1), i > 0))
        .child(tool(`kb-bm-down-${it.id}`, "chevron-down", this.s("moveDown"), () => move(i, 1), i < rows.length - 1))
        .child(tool(`kb-bm-eye-${it.id}`, off ? "eye-off" : "eye", this.s(off ? "showButton" : "hideButton"), () => flip(it.id)));
    };
    const changed = prefs.order.length > 0 || prefs.hidden.length > 0;
    return v_flex().id("kb-bm-root").w_full().p(MENU_PAD)
      .child(h_flex().w_full().h(MENU_HEAD).px(10).flex_none().items_center().text_size(11).font_semibold().text_color(t.dim).child(this.s("buttonsTitle")))
      .children(rows.map(row))
      .child(h_flex().w_full().h(EDIT_FOOT).px(6).pt(6).flex_none().items_center().justify_end().border_t(1).border_color(t.border)
        .child(h_flex().id("kb-bm-reset").h(24).px(10).flex_none().items_center().rounded(6).text_size(12)
          .border_1().border_color(t.border).text_color(changed ? t.foreground : t.dim)
          .when(changed, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); setShared(KEY_BUTTONS, null); }))
          .child(this.s("resetButtons"))));
  }

  /** The menu of the gear button. "Herdr Mods" opens the dialog on its Settings tab (the tab that the
   *  mods-hub keeps in shared("mods-hub").tab). mod.open toggles: an open dialog closes. "Bar buttons" asks the bar
   *  for the editor ("kanban.buttons"): the bar knows the buttons. */
  gearMenu(t) {
    const go = (fn) => { fn(); if (this.overlay) closeOverlay(this.overlay); };
    const row = (id, symbol, label, fn) => h_flex().id(`kb-gear-${id}`).w_full().h(MENU_ROW).px(10).gap(10).flex_none().items_center().rounded(6)
      .cursor_pointer().text_size(13).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); go(fn); })
      .child(svg(icon(symbol)).size(15).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(label));
    return v_flex().id("kb-gear-root").w_full().p(MENU_PAD)
      .child(h_flex().w_full().h(MENU_HEAD).px(10).flex_none().items_center().text_size(11).font_semibold().text_color(t.dim).child(this.s("gearTitle")))
      .child(row("herdr", "settings", this.s("gearHerdr"), () => run("app.settings")))
      .child(row("buttons", "buttons", this.s("gearButtons"), () => run("kanban.buttons")))
      .when(this.props.hub !== false, (e) => e.child(row("mods", "mods", this.s("gearMods"), () => {
        setShared("mods-hub", { ...(shared("mods-hub") ?? {}), tab: "settings" });
        run("mod.open", { name: "mods-hub" });
      })));
  }

  /** Opens the menu of the duplicate button of a card at the pointer: duplicate in the same space, or in a new worktree. */
  openClone(a) {
    const name = a.space_name || a.program?.name || a.app || "Agent";
    openOverlay({
      mod: "kanban", kind: "popup", width: CLONE_W, height: MENU_PAD * 2 + MENU_HEAD + 2 * MENU_ROW,
      props: { part: "clone-menu", lang: this.lang, title: this.s("cloneTitle", { name }), address: a.address },
    });
  }

  /** The menu of the duplicate button. A row starts a new session of the same agent, with the same flags and no
   *  session flag (see cloneArgv): in a new tab of the same space and folder, or in a new worktree of the repository
   *  (Herdr's worktree dialog asks for the branch and opens a new space with the agent in its first tab). */
  cloneMenu(t) {
    const p = this.props;
    const row = (id, symbol, label, where) => h_flex().id(`kb-cm-${id}`).w_full().h(MENU_ROW).px(10).gap(10).flex_none().items_center().rounded(6)
      .text_size(13).text_color(this.cloneBusy ? t.dim : t.foreground)
      .when(!this.cloneBusy, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { cx.stop_propagation(); this.clone(where, cx); })
      .child(svg(icon(symbol)).size(15).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(label));
    return v_flex().id("kb-cm-root").w_full().p(MENU_PAD)
      .child(h_flex().w_full().h(MENU_HEAD).px(10).flex_none().items_center().text_size(11).font_semibold().text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(String(p.title ?? ""))))
      .child(row("here", "copy", this.s("cloneHere"), "here"))
      .child(row("worktree", "branch", this.s("cloneWorktree"), "worktree"));
  }

  /** Duplicates the agent of props.address. `where`: "here" (a new tab of its space) or "worktree". */
  clone(where, cx) {
    if (this.cloneBusy) return;
    const a = agents().find((x) => x.address === this.props.address);
    if (!a) { this.closeDialog(); return; }
    const space = spaces().find((s) => s.id === a.space);
    const folder = panes().find((x) => x.pane === a.pane)?.cwd || space?.folder || undefined;
    this.cloneBusy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      let argv = null;
      try { argv = await cloneArgv(a.address, a.program?.key, space?.machine); } catch {}
      this.cloneBusy = false;
      // Act first, then close: this copy of the mod ends with its popup.
      if (!argv) notify({ title: this.s("cloneFail"), body: this.s("noCommand"), level: "error", timeout: 6000 });
      else if (where === "worktree") openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: a.space, folder, action: "new", argv } });
      else run("tab.new", { space: a.space, argv, ...(folder ? { folder } : {}) });
      this.closeDialog();
    });
  }

  dialogToSide() {
    this.closeDialog();
    const tab = this.props.tab;
    if (tab?.mod) {
      showTab(tab.mod, tab.name);
      if (find(layout(), "view")) run("layout.select", { stack: "view", child: "tabs-view" }); // the Terminals view of the Kanban layout
      return;
    }
    const panel = sidePanel(layout());
    run("layout.select", { stack: "panel-body", child: this.props.panel });
    if (panel) run("layout.show", { id: panel.id });
  }

  /** Herdr calls this when the block goes. For the title row of a dialog: the dialog closed (the close
   *  button, Esc or a click beside it), so the bar stops showing its button as lit. */
  async close() {
    if (this.part !== "panel-title") return;
    liveDialogs().delete(this.overlay);
    const open = shared(KEY_PANEL_DIALOG);
    if (open?.id && open.id === this.overlay) setShared(KEY_PANEL_DIALOG, null);
  }

  openInTab(a) {
    run("space.select", { id: a.space });
    run("tab.select", { id: a.tab });
    run("pane.focus", { terminal: a.address });
    run("layout.select", { stack: "view", child: "tabs-view" });
  }

  /** The layout the switch offers to go back to: the one the person came from (saved by the dock
   *  bar or by this bar), else props.back, else "main", else the first other layout. */
  back() {
    const names = layouts(), here = shared("layout");
    return [shared("layout.previous"), this.props.back, "main", ...names]
      .find((n) => typeof n === "string" && n !== here && names.includes(n)) ?? null;
  }

  switchLayout(name) {
    if (name === shared("layout")) return;
    setShared("layout.previous", shared("layout")); // so the other layout can come back here
    run("layout.switch", { name });
  }

  /** The layouts of the switch at the right end of the bar, in the order the Dock bar draws them:
   *  the layout to go back to, then the layout.switch commands of dock/panels.json, then the shown
   *  layout if no entry names it. Each item: { name, label, symbol }. */
  layoutItems() {
    const names = layouts(), here = shared("layout"), back = this.back(), items = [];
    const add = (name, label, symbol) => {
      if (typeof name === "string" && names.includes(name) && !items.some((i) => i.name === name)) items.push({ name, label, symbol });
    };
    if (back) add(back, layoutLabel(back), icon("layout-main"));
    for (const e of this.liveEntries()) if (e.opens === "command" && e.run === "layout.switch") add(e.args?.name, e.label, e.icon);
    add(here, layoutLabel(here), icon("board"));
    return items;
  }

  /** The layout switch: one button per layout, the shown one lit. Empty with fewer than 2 layouts. */
  layoutSwitch(t, iconOnly) {
    const items = this.layoutItems(), here = shared("layout");
    if (items.length < 2) return [];
    return [buttonGroup(t, items.map((it) => panelButton(t, `kb-layout-${it.name}`, it.symbol, it.label, it.name === here,
      () => this.switchLayout(it.name), this.s(it.name === here ? "layoutHere" : "backTip", { name: it.label }), iconOnly)))];
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
    const color = statusColor(t, a.status);
    if (a.status === "working") return svg(icon("spinner")).size(15).flex_none().text_color(color).spin(900);
    if (a.status === WAITING) return svg(icon("hourglass")).size(15).flex_none().text_color(color).loop("opacity", { from: 0.4, to: 1, period: 1800 });
    if (a.status === "blocked") return svg(icon("bell")).size(15).flex_none().text_color(color).loop("opacity", { from: 0.3, to: 1, period: 1100 });
    if (a.status === "done") return svg(icon("check")).size(15).flex_none().text_color(color);
    return svg(icon("moon")).size(14).flex_none().text_color(t.dim);
  }

  /** A card of 2 lines: the program icon, the space and the status mark, then the title, with no
   *  age so the title has room. The icon tells the program, so the space names the card. While the
   *  pointer is on the card, the pin and open buttons show at the end of the title line. */
  summaryCard(a, t) {
    const color = statusColor(t, a.status);
    const pane = panes().find((p) => p.pane === a.pane);
    const selected = a.focused || focused()?.agent === a.address;
    const hot = a.status === "blocked";
    const name = a.program?.name || a.app || "Agent";
    const { text: title } = this.cardTitle(a, name);
    const head = a.space_name || name;
    // A waiting agent says what it waits for, in place of its title.
    const line = a.wait ? this.waitText(a)
      : title && title !== name ? title : [name, pane?.branch].filter(Boolean).join(" · ");
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
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_bold().text_color(t.foreground).child(head))
        .when(a.pinned && !over, (e) => e.child(svg(icon("pin")).size(11).flex_none().text_color(t.accent)))
        .child(this.mark(a, t)))
      .child(h_flex().h(20).gap(4).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(line))
        .when(over, (e) => e
          .when(Boolean(a.wait), (e) => e.child(small("notwait", "check", () => this.dismissWaiting(a), this.s("notWaiting"))))
          .when(this.namer && !offMods().has("tab-namer"), (e) => e.child(small("rename", "pencil", () => this.openNamer(a), this.s("rename"))))
          .child(small("clone", "copy", () => this.openClone(a), this.s("duplicate")))
          .child(small("pin", "pin", () => run("terminal.pin", { terminal: a.address, pinned: !a.pinned }), this.s(a.pinned ? "unpin" : "pin"), a.pinned))
          .child(small("open", "open", () => this.openInTab(a), this.s("open")))));
  }

  /** The title of a card: the name of its tab when a person named the tab (not a number, not the
   *  program name that the launcher gives), else the agent's own title. `named` tells which. */
  cardTitle(a, programName) {
    const tabName = String(a.tab_name ?? "").trim();
    const named = Boolean(tabName) && !/^\d+$/.test(tabName) && tabName !== programName;
    return named ? { text: tabName, named, agentTitle: (a.title || "").trim() } : { text: (a.title || "").trim(), named };
  }

  /** The tab-namer dialog for the tab of this agent. */
  openNamer(a) {
    openOverlay({ mod: "tab-namer", kind: "dialog", width: 460, props: { tab: a.tab, terminal: a.address, lang: this.lang } });
  }

  /** "2 subagents", "1 subagent · 1 command", or "1 command · Run the tests" when there is only one job
   *  and it has a description. */
  waitText(a) {
    const shells = a.wait.items.filter((p) => p.kind === "shell").length;
    const parts = [];
    if (a.wait.count - shells > 0) parts.push(this.s("subagents", a.wait.count - shells));
    if (shells > 0) parts.push(this.s("commands", shells));
    const first = a.wait.items[0]?.description;
    if (first && a.wait.count === 1) parts.push(first);
    return parts.join(" · ");
  }

  card(a, t, compact = false) {
    const color = statusColor(t, a.status);
    const pane = panes().find((p) => p.pane === a.pane);
    const tab = spaces().find((p) => p.id === a.space)?.tabs.find((x) => x.id === a.tab);
    const since = a.status === "working" ? tab?.working_since ?? tab?.changed_at : tab?.changed_at;
    const selected = a.focused || focused()?.agent === a.address;
    const hot = a.status === "blocked";
    const name = a.program?.name || a.app || "Agent";
    // A tab that a person named gives the card its title (the agent's own title goes to the tooltip).
    const { text: title, named, agentTitle } = this.cardTitle(a, name);
    const branch = pane?.branch || null;
    const folder = base(pane?.cwd);

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
        // The space names the card: most agents run the same program, and the icon tells it anyway.
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(compact ? 14 : 15).font_bold().text_color(t.foreground).child(a.space_name || name))
          .when(Boolean(a.space_name), (e) => e.child(div().truncate().text_size(11).text_color(t.dim).child(name))))
        .child(this.mark(a, t)))
      .when(Boolean(title) && title !== name, (e) => e.child(
        div().id(`title-${a.address}`).max_h(34).overflow_hidden().text_size(12)
          .text_color(named ? t.foreground : t.muted)
          .when(named && Boolean(agentTitle) && agentTitle !== title, (el) => el.tooltip(agentTitle))
          .child(title)))
      .child(h_flex().flex_wrap().gap(5).items_center()
        .when(Boolean(a.wait), (e) => e.child(pill(t, { label: this.waitText(a), symbol: "hourglass", color })))
        .when(Boolean(branch), (e) => e.child(pill(t, { label: branch, symbol: "branch", code: true })))
        // No pill that repeats the head of the card (the space, the program) or the branch.
        .when(Boolean(folder) && folder !== branch && folder !== a.space_name, (e) => e.child(pill(t, { label: folder, symbol: "folder" }))))
      .child(h_flex().h(22).gap(2).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.age(since)))
        .when(Boolean(a.wait), (e) => e.child(iconButton(t, `notwait-${a.address}`, "check", () => this.dismissWaiting(a),
          { tooltip: this.s("notWaiting"), size: 22, glyph: 12, color: t.dim })))
        .when(this.namer && !offMods().has("tab-namer"), (e) => e.child(iconButton(t, `rename-${a.address}`, "pencil", () => this.openNamer(a),
          { tooltip: this.s("rename"), size: 22, glyph: 12, color: t.dim })))
        .child(iconButton(t, `clone-${a.address}`, "copy", () => this.openClone(a),
          { tooltip: this.s("duplicate"), size: 22, glyph: 12, color: t.dim }))
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
    const color = statusColor(t, c.id);
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
    // Places in the row: one column each. In compact density the columns of a group (Working with
    // Waiting, Done with Idle) share one place, one under the other, at the place of the first of
    // them in the order.
    const places = [];
    for (const c of cols) {
      const group = compact ? GROUPS.find((g) => g.includes(c.id)) : null;
      const pair = group ? places.find((p) => group.includes(p[0].id)) : null;
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

  /** The buttons of the side panel and of dock/panels.json: Files and Changes, then the entries of the file
   *  in the order listed (side panels and tabs), then its commands. The layout.switch commands are not here:
   *  they are in the layout switch. Empty when the layout has no `panel-body`. `iconOnly`: the names go to
   *  the tooltips. Call it once per render: it also adds the blocks of the file to the layout. */
  panelItems(t, iconOnly = false) {
    const root = layout(), panel = sidePanel(root), body = find(root, "panel-body");
    if (!panel || !body) return [];
    // The entries that may use the panel stack: not the id of any other node of the layout.
    const taken = ids(root);
    for (const c of body.children ?? []) taken.delete(c.id);
    const live = this.liveEntries();
    const usable = live.filter((e) => e.opens !== "command" && !taken.has(e.id) && !PANELS.some((p) => p.id === e.id));
    // One layout edit for each render: the off mods wait for the panel edit.
    const injecting = this.loaded ? this.inject(root, body, usable.filter((e) => e.opens === "panel")) : false;
    if (!injecting) this.reconcile(root);
    // A panel dialog that shows a mod that is now off closes.
    const openDialog = shared(KEY_PANEL_DIALOG);
    if (openDialog?.id && liveDialogs().has(openDialog.id)) {
      const entry = this.entries.find((e) => e.id === openDialog.panel);
      if (entry && offMods().has(entryMod(entry))) { closeOverlay(openDialog.id); setShared(KEY_PANEL_DIALOG, null); }
    }
    const present = new Set((body.children ?? []).map((c) => c.id));
    const inDialog = this.dialogPanel();
    const lit = (id) => (!panel.hidden && body.active === id) || inDialog === id;
    const tip = (name) => this.s("panelTip", { name });
    // The panels of a group share one button, in the place of the first one; its menu lists them.
    const items = [
      ...PANELS.filter((p) => present.has(p.id)).map((p) => ({ ...p, key: `kb-panel-${p.id}`, on: lit(p.id), tip: tip(p.label) })),
      ...usable.filter((e) => e.opens === "tab" || present.has(e.id)).map((e) => e.opens === "tab"
        ? { ...e, key: `kb-tab-open-${e.id}`, on: inDialog === e.id, tip: "" }
        : { ...e, key: `kb-panel-${e.id}`, on: lit(e.id), tip: tip(e.label) }),
      ...live.filter((e) => e.opens === "command" && e.run !== "layout.switch").map((e) => ({ ...e, key: `kb-cmd-${e.id}`, on: false, tip: "" })),
    ];
    // The person's order and hidden buttons (KEY_BUTTONS) apply to the folded buttons: a group moves as one button.
    // The group menus and the keys still reach a hidden button.
    const prefs = barButtons(), off = new Set(prefs.hidden);
    const folded = arrange(foldGroups(items).map((it) => ({ ...it, id: buttonId(it), entryId: it.id })), prefs.order);
    this.groups = new Map(folded.filter((it) => it.members).map((g) => [g.group, g.members]));
    this.buttonItems = folded.map((it) => (it.members ? { id: it.id, ...this.groupInfo(it.group) } : { id: it.id, label: it.label, icon: it.icon }));
    const shownItems = folded.filter((it) => !off.has(it.id));
    if (!folded.length) return [];
    return [
      this.panelOpenButton(t), ...(shownItems.length ? [divider(t, true)] : []),
      ...shownItems.map((it) => {
        if (!it.members) return panelButton(t, it.key, it.icon, it.label, it.on, () => this.togglePanel(it.entryId), it.tip, iconOnly);
        const info = this.groupInfo(it.group);
        return panelButton(t, `kb-group-${it.group}`, info.icon, info.label, it.members.some((m) => m.on), () => this.openGroup(it.group),
          `${info.label}: ${it.members.map((m) => m.label).join(", ")}`, iconOnly, false, true);
      }),
    ];
  }

  /** The two blocks of the board view: the terminal of the selected agent (right) and the shell (under the board). */
  regionButtons(t, iconOnly) {
    const detail = this.detailHidden();
    return [
      panelButton(t, "kb-detail", icon("panel"), this.s("agentLabel"), !detail, () => run("layout.toggle", { id: "detail" }),
        this.s(detail ? "detailOff" : "detailOn"), iconOnly),
      panelButton(t, "kb-shell", icon(this.shellBusy ? "spinner" : "panel-bottom"), this.s("shellLabel"), this.shellShown(),
        (cx) => this.toggleShell(cx), this.s(this.shellShown() ? "shellOn" : "shellOff"), iconOnly, Boolean(this.shellBusy)),
    ];
  }

  /** The value in the width control. With a width set, it is a button that sets Auto again. */
  widthValue(t, cap) {
    const cell = div().w(34).h(24).flex_none().flex().items_center().justify_center().rounded(7).text_size(11).text_color(t.muted);
    if (cap === null) return cell.child(this.s("auto"));
    return cell.id("kb-width-auto").tooltip(this.s("toAuto")).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); setShared(KEY_WIDTH, null); })
      .child(String(cap));
  }

  /** [width icon] [−] 260 [+]: how wide a column may be. Auto lets the columns share the whole board. */
  widthControl(t) {
    const cap = this.maxWidth();
    const atMin = cap === WIDTHS[0], atMax = cap === null;
    return h_flex().flex_none().gap(1).items_center()
      .tooltip(cap === null ? this.s("widthTip", { w: this.s("auto") }) : `${this.s("widthTip", { w: `${cap} px` })} ${this.s("widthAutoTip")}`)
      .child(div().w(22).flex_none().flex().items_center().justify_center().child(svg(icon("width")).size(14).text_color(t.dim)))
      .child(iconButton(t, "kb-narrower", "minus", () => this.stepWidth(-1),
        { tooltip: this.s("narrower"), size: 24, glyph: 13, color: atMin ? t.dim : t.muted }))
      .child(this.widthValue(t, cap))
      .child(iconButton(t, "kb-wider", "plus", () => this.stepWidth(1),
        { tooltip: this.s("wider"), size: 24, glyph: 13, color: atMax ? t.dim : t.muted }));
  }

  /** How the board looks, in one group: column width, density and card view. */
  displayGroup(t, compactNow) {
    return buttonGroup(t, [this.widthControl(t), divider(t, true), this.densityButton(t, compactNow), this.cardsButton(t)]);
  }

  /** The density button: lit while the board and bar are compact. The tooltip names the mode and the next one. */
  densityButton(t, compactNow) {
    const d = this.density();
    const next = DENSITIES[(DENSITIES.indexOf(d) + 1) % DENSITIES.length];
    const name = (x) => this.s(`density_${x}`);
    const mode = d === "auto" ? this.s(compactNow ? "densityNow" : "densityNowNormal", { mode: name(d) }) : name(d);
    return iconButton(t, "kb-density", "density", () => this.stepDensity(),
      { active: compactNow, size: 26, tooltip: this.s("densityTip", { mode, next: name(next) }) });
  }

  /** Where the panel buttons open their panel: lit while they open a dialog. The tooltip names the mode and the next one. */
  panelOpenButton(t) {
    const v = this.panelOpen(), now = this.dialogNow();
    const next = PANEL_OPENS[(PANEL_OPENS.indexOf(v) + 1) % PANEL_OPENS.length];
    const name = (x) => this.s(`opens_${x}`);
    const mode = v === "auto" ? this.s(now ? "opensNowDialog" : "opensNowSide", { mode: name(v) }) : name(v);
    return iconButton(t, "kb-panel-open", "dialog", () => this.stepPanelOpen(),
      { active: now, size: 26, glyph: 14, tooltip: this.s("opensTip", { mode, next: name(next) }) });
  }

  /** The card view button: lit while the cards are set to summary. */
  cardsButton(t) {
    const v = this.cardView();
    const next = CARD_VIEWS[(CARD_VIEWS.indexOf(v) + 1) % CARD_VIEWS.length];
    const name = (x) => this.s(`cards_${x}`);
    return iconButton(t, "kb-cards", "cards", () => this.stepCardView(),
      { active: v === "summary", size: 26, tooltip: this.s("cardsTip", { mode: v === "auto" ? this.s("cardsAuto") : name(v), next: name(next) }) });
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
    const compact = this.compact(this.barW, BAR_WIDE);
    const count = need ? `${this.s("agents", all.length)} · ${this.s("needYou", { n: need })}` : this.s("agents", all.length);

    // The bar reads left to right: what to see (Board / Terminals) | what to show (search, scope, columns)
    // | how it looks (width, density, cards) | the agent and shell blocks | Settings | New agent | the right end.
    // The right end is the same as in the Dock bar (tabs-dock), in the same place and size, so a layout
    // switch does not move it: the panel group (Files, Changes, dock entries), the layout switch, the window
    // buttons. In compact density the columns and the look group share one row that scrolls sideways.
    // The panel buttons and the layout switch: names in Normal density, icons in Compact; in Auto, names
    // from LABELS_WIDE px. tabs-dock reads the same density with the same rule, so the right ends match.
    const d = this.density();
    const iconOnly = d === "normal" ? false : d === "compact" ? true : !(this.barW >= LABELS_WIDE);
    const panels = this.panelItems(t, iconOnly); // once per render: it also adds the file's blocks to the layout
    const regions = onBoard ? this.regionButtons(t, iconOnly) : [];
    const regionGroup = regions.length ? [buttonGroup(t, regions)] : [];
    const panelGroup = panels.length ? [buttonGroup(t, panels)] : [];
    const right = h_flex().flex_none().gap(RIGHT_GAP).items_center()
      .children(panelGroup)
      .children(this.layoutSwitch(t, iconOnly))
      .when(w?.buttons, (e) => e.child(h_flex().flex_none().gap(2).items_center()
        .child(wbtn("kb-min", win ? svg(icon("win-min")).size(16) : "−", () => run("window.minimize")))
        .child(wbtn("kb-max", win ? svg(icon(w.maximized ? "win-restore" : "win-max")).size(16) : "□", () => run("window.maximize")))
        .child(wbtn("kb-close", win ? svg(icon("win-close")).size(16) : svg(icon("close")).size(13), () => run("window.close")))));
    const settingsButton = iconButton(t, "kb-settings", "settings", () => this.openGear(),
      { size: 28, tooltip: this.s("settingsTip") });
    const newAgent = button(t, "kb-new", this.s("newAgent"), () => this.newAgent(), { primary: true, symbol: "bot", iconOnly: compact });
    const chips = this.columns().map((c) => {
      const on = !hidden.has(c.id), name = this.s(c.id);
      return columnChip(t, `kb-chip-${c.id}`, {
        label: name, color: statusColor(t, c.id), on, compact,
        count: this.visible().filter((a) => a.status === c.id).length,
        tooltip: this.s(on ? "hideCol" : "showCol", { name }),
      }, () => this.toggleColumn(c.id));
    });
    const columnTools = [
      ...chips,
      iconButton(t, "kb-waiting", "hourglass", () => this.toggleWaiting(),
        { active: this.waitingOn(), tooltip: this.s(this.waitingOn() ? "waitingOn" : "waitingOff") }),
    ];
    const search = h_flex().flex_none().gap(4).items_center()
      .child(searchBox(t, "kb-search", this.query, {
        width: compact ? 150 : 220,
        onClear: () => { this.query.set_value(""); setShared(KEY_QUERY, ""); },
      }))
      .child(iconButton(t, "kb-scope", "filter", () => setShared(KEY_SCOPE, this.scope() === "space" ? "all" : "space"),
        { active: this.scope() === "space", size: 32, tooltip: this.s(this.scope() === "space" ? "scopeSpaceTip" : "scopeAllTip") }));
    // The controls of the board view share one row that scrolls sideways when the bar is too narrow (Normal
    // density on a small monitor). New agent and the right end stay outside it, so they always show.
    const scroller = (children) => h_flex().id("kb-strip").flex_1().min_w(0).gap(compact ? 6 : 10).items_center().overflow_x_scrollbar().children(children);

    // With the sidebar hidden, the macOS window buttons sit over the start of the bar: leave them room.
    const lights = w?.platform === "macos" && find(layout(), "sidebar")?.hidden ? 76 : 0;
    return h_flex().id("kb-bar").size_full().min_w(0).pl(lights > 0 ? lights : compact ? 10 : 14).pr(BAR_RIGHT).gap(compact ? 6 : 10).items_center()
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
      .child(divider(t))
      .when(onBoard, (e) => e.child(scroller([search, ...columnTools, this.displayGroup(t, compact), ...regionGroup])))
      .when(!onBoard, (e) => e.child(this.tabStrip(t)))
      .child(settingsButton)
      .child(divider(t))
      .child(newAgent)
      .child(right);
  }

  render(cx) {
    const t = theme();
    if (this.part === "panel-title") return this.panelTitle(t);
    if (this.part === "group-menu") return this.groupMenu(t);
    if (this.part === "clone-menu") return this.cloneMenu(t);
    if (this.part === "gear-menu") return this.gearMenu(t);
    if (this.part === "buttons-menu") return this.buttonsMenu(t);
    this.syncWaiting(cx);
    if (this.part === "bar") return this.bar(t);
    return v_flex().id("kanban").size_full().min_h(0).min_w(0).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => {
        const w = Math.round(size.width);
        if (w !== this.boardW) { this.boardW = w; cx.notify(); }
      })
      .child(this.board(t));
  }
}
