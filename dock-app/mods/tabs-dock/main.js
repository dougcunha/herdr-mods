import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, closeOverlay, theme, window, shared, setShared, layout, layouts, settings, props, appHome, readTextFile, watchFolder, nextCommand, notify } from "herdr";
import * as fs from "fs/promises";

// The dock: the tab bar draws one button per entry of dock/panels.json, and adds
// the side panel of each entry to the layout by itself. A new button is one new
// entry in that file: no clone of the tab bar, no edit of the layout.
//
// Entry: { id, label, icon, mod, props?, opens?: "panel" | "tab", name?, group? }
//   opens "panel" (default): a block of the side panel, `mod` with `props`.
//   opens "tab": a tab per space with `mod` as its only pane (focus it, or make it).
//   opens "command": a button that runs a Herdr command: { run: "layout.switch", args: { name: "kanban" } }.
//     A layout.switch first saves the shown layout in shared("layout.previous"), so the
//     target layout can offer a button back (the Kanban layout does).
//   group: the entries with the same group share one button in the bar. A click on it opens a menu with the
//     full name of each entry. Changes is in the "git" group: { "id": "graph", ..., "group": "git" } joins it.
//
// The right end of the bar is the same as in the Kanban bar (mods/kanban), in the same place and
// size, so a layout switch does not move it: the panel group, the layout switch (this layout, then
// the layout.switch entries, the shown one lit) and the window buttons. Below LABELS_WIDE px the
// buttons show only their icons, and the names go to the tooltips.
//
// A panel button (side panel or tab entry) opens its panel in the side panel (a tab entry: in its tab) or in a
// dialog. The first button of the panel group sets where: Auto, Side panel or Dialog. Auto opens a dialog when
// the window is narrower than PANEL_NARROW px. The setting and the open dialog are shared with the Kanban bar.
// This mod has more parts: props.part "panel-title" (the title row of a panel dialog), props.part "group-menu"
// (the menu of a group button, a popup) and props.part "gear-menu" (the menu of the gear button, a popup).

const LABELS_WIDE = 2250; // the same as in mods/kanban: from this bar width the buttons show their names
const BAR_RIGHT = 10; // padding after the window buttons, the same as in mods/kanban
const RIGHT_GAP = 6; // between the panel group, the layout switch and the window buttons

// The density of the buttons, shared with the Kanban bar (the same key and the same button):
// "normal" shows the names, "compact" only the icons, "auto" (or absent) the names from LABELS_WIDE px.
const KEY_LANG = "herdr-mods.lang"; // the language of the whole kit, set in the mods-hub; absent: props.lang
const KEY_DENSITY = "kanban.density";
const DENSITIES = ["auto", "compact", "normal"];

// Where the panel buttons open their panel, shared with the Kanban bar (the same keys and values as in mods/kanban).
const KEY_PANEL_OPEN = "kanban.panelOpen"; // "auto" | "side" | "dialog"; absent: auto
const KEY_PANEL_DIALOG = "kanban.panelDialog"; // { id, panel }: the panel dialog that is open now; null: none
const PANEL_OPENS = ["auto", "side", "dialog"];
const PANEL_NARROW = 1600; // px of window: below it, Auto opens a dialog
const DIALOG_TITLE = 36; // px: the title row of a panel dialog
// The dialogs opened since the app started. shared() is saved to disk, so after a restart KEY_PANEL_DIALOG can
// name a dialog that is gone: the bar trusts it only when its id is here. The same registry as in mods/kanban.
const liveDialogs = () => (globalThis.__kanbanPanelDialogs ??= new Set());

// The groups of panel buttons. A group that is not here uses its id as its name and the icon of its first entry.
const GROUPS = { git: { label: "Git", icon: "mods/tabs-dock/git.svg" } };
const MENU_W = 220, MENU_PAD = 5, MENU_HEAD = 26, MENU_ROW = 32; // px: the menu of a group button

const STR = {
  en: { gearTip: "Settings", gearTitle: "Settings", gearHerdr: "Herdr settings", gearMods: "Herdr Mods",
    newTab: "New tab", panelTip: "Show or hide {name}", switchTip: "Switch to the {name} layout", layoutHere: "Shown now: the {name} layout",
    density_auto: "Auto", density_compact: "Compact", density_normal: "Normal",
    densityNow: "{mode} (compact now)", densityNowNormal: "{mode} (normal now)",
    densityTip: "Density: {mode}. Click to switch to {next}.",
    opens_auto: "Auto", opens_side: "Side panel", opens_dialog: "Dialog",
    opensNowDialog: "{mode} (dialog now)", opensNowSide: "{mode} (side panel now)",
    opensTip: "Panels open in: {mode}. Click to switch to {next}.",
    toSide: "Open in the side panel", toTab: "Open in a tab", closeDialog: "Close" },
  pt: { gearTip: "Configurações", gearTitle: "Configurações", gearHerdr: "Configurações do Herdr", gearMods: "Herdr Mods",
    newTab: "Nova aba", panelTip: "Mostrar ou ocultar {name}", switchTip: "Trocar para o layout {name}", layoutHere: "Layout atual: {name}",
    density_auto: "Auto", density_compact: "Compacta", density_normal: "Normal",
    densityNow: "{mode} (compacta agora)", densityNowNormal: "{mode} (normal agora)",
    densityTip: "Densidade: {mode}. Clique para mudar para {next}.",
    opens_auto: "Auto", opens_side: "Painel lateral", opens_dialog: "Diálogo",
    opensNowDialog: "{mode} (diálogo agora)", opensNowSide: "{mode} (painel lateral agora)",
    opensTip: "Os painéis abrem em: {mode}. Clique para mudar para {next}.",
    toSide: "Abrir no painel lateral", toTab: "Abrir numa aba", closeDialog: "Fechar" },
};

// A translucent version of a theme color. Non-hex colors pass through. (The same as in mods/kanban/ui.js.)
const tint = (color, alpha = "24") => (/^#[0-9a-f]{6}$/i.test(color || "") ? color + alpha : color);
// The name of a layout file as a button label: "main-dock" -> "Main dock".
const layoutLabel = (name) => { const s = String(name).replace(/[-_]+/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); };

// A button for a side panel, a tab, a command or a layout: an icon (`.svg` is tinted, anything else is a
// picture) and a name. Lit while `on`. `iconOnly`: no name (the tooltip has it). `menu`: a small arrow after the
// name, for a button that opens a menu. The same as panelButton in mods/kanban/ui.js: the two bars must draw these
// buttons alike.
function panelButton(t, id, symbolPath, label, on, onClick, tooltip = "", iconOnly = false, menu = false) {
  const tip = tooltip || (iconOnly ? label : "");
  const glyph = String(symbolPath).endsWith(".svg") ? svg(symbolPath).size(14).flex_none() : image(symbolPath).size(14).flex_none();
  return h_flex().id(id).h(26).px(iconOnly ? 6 : 9).gap(6).flex_none().items_center().rounded(7).text_size(12).cursor_pointer()
    .when(Boolean(tip), (e) => e.tooltip(tip))
    .when(on, (e) => e.bg(tint(t.accent, "26")).text_color(t.accent))
    .when(!on, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover)))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => onClick(cx))
    .child(glyph)
    .when(!iconOnly, (e) => e.child(label))
    .when(menu, (e) => e.gap(iconOnly ? 2 : 5).child(svg("mods/tabs-dock/chevron-down.svg").size(10).flex_none().text_color(on ? t.accent : t.dim)));
}

// An icon of a panel: `.svg` is tinted with `color`, anything else is a picture.
const panelGlyph = (path, size, color) => String(path).endsWith(".svg") ? svg(path).size(size).flex_none().text_color(color) : image(path).size(size).flex_none();

// The panel buttons in the order of the bar, with the entries of a group put together: an item stays as it is,
// and the first entry of a group becomes { group, members: [entry, ...] } in its place.
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

// A rounded group that holds several buttons. The same as buttonGroup in mods/kanban/ui.js.
const buttonGroup = (t, children) => h_flex().h(32).flex_none().px(3).gap(2).items_center().rounded(10)
  .bg(tint(t.foreground, "0f")).border_1().border_color(t.border).children(children);

// A thin vertical line inside a group. The same as divider(t, true) in mods/kanban/ui.js.
const innerDivider = (t) => div().w(1).h(14).mx(2).flex_none().bg(tint(t.foreground, "26"));

// A square button that holds an icon of this mod. The same as iconButton in mods/kanban/ui.js.
function iconButton(t, id, name, onClick, { active = false, tooltip = "", size = 26, glyph = 14 } = {}) {
  return div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(8)
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip))
    .when(active, (e) => e.bg(tint(t.accent, "26")))
    .cursor_pointer().hover((s) => s.bg(active ? tint(t.accent, "40") : t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
    .child(svg(`mods/tabs-dock/${name}.svg`).size(glyph).text_color(active ? t.accent : t.muted));
}

const BUILTIN = [
  { id: "files", label: "Files", icon: "mods/tabs-dock/files.svg" },
  { id: "changes", label: "Changes", icon: "mods/tabs-dock/changes.svg", group: "git" },
];
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function ids(node, out = new Set()) {
  if (node?.id) out.add(node.id);
  for (const child of node?.children ?? []) ids(child, out);
  return out;
}

// One tab per space for this mod: focus it if it exists, otherwise create it.
function showTab(mod, name) {
  const active = spaces().find(p => p.active);
  const tabIds = new Set(active?.tabs.map(tab => tab.id) ?? []);
  const open = panes().find(pane => pane.mod === mod && tabIds.has(pane.tab));
  if (open) {
    const zoomed = panes().find(pane => pane.tab === open.tab && pane.zoomed);
    if (zoomed && zoomed.pane !== open.pane) run("pane.zoom", { pane: zoomed.pane });
    return run("pane.focus", { pane: open.pane });
  }
  return run("tab.new", { name, mod });
}

export default class Tabs extends View {
  init(given, cx) {
    // Read props once: props() in a later callback can answer for another copy.
    const p = (given && Object.keys(given).length ? given : props()) || {};
    this.props = p;
    this.part = ["panel-title", "group-menu", "gear-menu"].includes(p.part) ? p.part : "bar";
    if (this.part !== "bar") {
      this.overlay = p.overlay ?? props()?.overlay;
      if (this.part === "panel-title") {
        // The title row takes the keyboard when the dialog opens. Else the terminal behind the dialog
        // keeps it and gets Esc. The panel in the dialog can take the keyboard later (a filter field
        // after 40 ms), so this runs at once and once more after 10 ms.
        this.handle = cx.focus_handle();
        this.handle.focus();
        cx.timer.after(10, () => this.handle.focus());
      }
      return;
    }
    this.barW = undefined; // the width of the bar, from on_size_change
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.entries = [];
    this.injected = new Set(JSON.parse(localStorage.getItem("injected") ?? "[]"));
    this.version = 0;
    this.lastTry = null;
    this.groups = new Map(); // group id -> its entries, from the last render: the menu of a group button lists them
    const dir = `${appHome()}/dock`;
    cx.spawn(async (cx) => {
      try { await fs.mkdir(dir, { recursive: true }); } catch {}
      await this.load(cx);
      // The file is the whole interface: a save shows up in the bar at once.
      for (;;) {
        try { await watchFolder(dir); } catch { return; }
        await this.load(cx);
      }
    });
    // Keys open a panel as its button does: "ctrl-alt-g": "tabs-dock.graph" in keys.json. "tabs-dock.group-git"
    // opens the menu of the Git button.
    cx.spawn(async (cx) => { for (;;) { this.toggle(await nextCommand()); cx.notify(); } });
  }

  // Reads dock/panels.json. A missing file is an empty list. A broken file keeps the last good list.
  async load(cx) {
    let problem = null;
    try {
      const text = await readTextFile(`${appHome()}/dock/panels.json`);
      if (text !== null) {
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
      } else this.entries = [];
    } catch (e) {
      problem = `panels.json: ${e?.message ?? e}`;
    }
    this.version++;
    if (problem && problem !== this.problem) notify({ title: "Dock: panels.json", body: problem, level: "error", timeout: 6000 });
    this.problem = problem;
    cx.notify();
  }

  /** The language: the kit setting `herdr-mods.lang` when it is set, else the `lang` prop, else English. */
  get lang() {
    const kit = shared(KEY_LANG);
    return STR[kit] ? kit : STR[this.props?.lang] ? this.props.lang : "en";
  }

  s(key, vars = {}) {
    return (STR[this.lang][key] ?? key).replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? ""));
  }

  // A command button. Switching layout records where the person came from.
  runEntry(entry) {
    if (entry.run === "layout.switch") {
      if (entry.args?.name === shared("layout")) return;
      setShared("layout.previous", shared("layout"));
    }
    run(entry.run, entry.args ?? {});
  }

  // The layouts of the switch: the shown layout, then the layout.switch entries in the file's order.
  // The Kanban bar draws the same list (there, the first item is the layout to go back to).
  layoutItems() {
    const names = layouts(), here = shared("layout"), items = [];
    const add = (name, label, symbol, entry) => {
      if (typeof name === "string" && names.includes(name) && !items.some(i => i.name === name)) items.push({ name, label, symbol, entry });
    };
    add(here, layoutLabel(here), "mods/tabs-dock/layout-main.svg", { id: "layout-here", run: "layout.switch", args: { name: here } });
    for (const e of this.entries) if (e.opens === "command" && e.run === "layout.switch") add(e.args?.name, e.label, e.icon, e);
    return items;
  }

  toggle(id) {
    // "tabs-dock.density" steps the density, as the density button does.
    if (id === "density") {
      const d = DENSITIES.includes(shared(KEY_DENSITY)) ? shared(KEY_DENSITY) : "auto";
      return setShared(KEY_DENSITY, DENSITIES[(DENSITIES.indexOf(d) + 1) % DENSITIES.length]);
    }
    // "tabs-dock.panel-open" steps where the panels open, as the first button of the panel group does.
    if (id === "panel-open") return this.stepPanelOpen();
    // "tabs-dock.group-<id>" opens the menu of a group button, as a click on it does.
    if (String(id).startsWith("group-")) return this.openGroup(String(id).slice(6));
    // "tabs-dock.gear" does what the gear button does.
    if (id === "gear") return this.openGear();
    const command =this.entries.find(e => e.id === id && e.opens === "command");
    if (command) return this.runEntry(command);
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    const node = panel ? (body?.children ?? []).find(c => c.id === id) : null;
    const tab = node ? null : this.entries.find(e => e.id === id && e.opens === "tab");
    if (!node && !tab) return;
    // A click on any panel button closes the open dialog first; a click on the button of that dialog only closes it.
    const open = shared(KEY_PANEL_DIALOG);
    if (open?.id) {
      closeOverlay(open.id);
      setShared(KEY_PANEL_DIALOG, null);
      if (open.panel === id && liveDialogs().has(open.id)) return;
    }
    if (this.dialogNow()) return this.openDialog(id, tab ? { mod: tab.mod, ...(tab.props ? { props: tab.props } : {}) } : node.content, tab);
    if (tab) return showTab(tab.mod, tab.name);
    if (!panel.hidden && body.active === id) run("layout.hide", { id: "panel" });
    else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
  }

  panelOpen() {
    const v = shared(KEY_PANEL_OPEN);
    return PANEL_OPENS.includes(v) ? v : "auto";
  }

  stepPanelOpen() {
    setShared(KEY_PANEL_OPEN, PANEL_OPENS[(PANEL_OPENS.indexOf(this.panelOpen()) + 1) % PANEL_OPENS.length]);
  }

  // True when a panel button opens a dialog now: always in Dialog; in Auto, when the window is narrower than
  // PANEL_NARROW px. The window is this bar and the sidebar beside it (the Kanban bar is the whole window wide).
  dialogNow() {
    const v = this.panelOpen();
    if (v !== "auto") return v === "dialog";
    if (typeof this.barW !== "number") return false;
    const sidebar = find(layout(), "sidebar");
    return this.barW + (sidebar && !sidebar.hidden ? sidebar.size?.px ?? 0 : 0) < PANEL_NARROW;
  }

  // Opens the panel `id` in a dialog: a title row (this mod, part "panel-title") over `content`, the same mod and
  // props as in the side panel (or in the tab, for a `tab` entry). The same as openDialog in mods/kanban.
  openDialog(id, content, tab = null) {
    if (!content?.mod) return;
    const entry = [...BUILTIN, ...this.entries].find(e => e.id === id);
    const title = { part: "panel-title", panel: id, label: entry?.label ?? id, icon: entry?.icon ?? "", lang: this.lang,
      ...(tab ? { tab: { mod: tab.mod, name: tab.name } } : {}) };
    const overlay = openOverlay({
      kind: "dialog", width: 0.82, height: 0.85,
      layout: { type: "column", children: [
        { id: "panel-dialog-title", type: "block", size: { px: DIALOG_TITLE }, content: { mod: "tabs-dock", props: title } },
        { id: `panel-dialog-${id}`, type: "block", content },
      ] },
    });
    liveDialogs().add(overlay);
    setShared(KEY_PANEL_DIALOG, { id: overlay, panel: id });
  }

  // The panel that shows in a dialog now, or null.
  dialogPanel() {
    const open = shared(KEY_PANEL_DIALOG);
    return open?.id && liveDialogs().has(open.id) ? open.panel : null;
  }

  // The title row of a panel dialog: the icon and name of the panel, a button that moves it to the side panel
  // (to its tab, for a tab entry) and a close button. The same as panelTitle in mods/kanban.
  panelTitle(t) {
    const p = this.props;
    const path = String(p.icon || "");
    const glyph = !path ? div().size(14) : path.endsWith(".svg") ? svg(path).size(14).text_color(t.accent) : image(path).size(14);
    const move = p.tab
      ? iconButton(t, "dlg-tab", "open", () => this.dialogToSide(), { tooltip: this.s("toTab") })
      : iconButton(t, "dlg-side", "panel", () => this.dialogToSide(), { tooltip: this.s("toSide") });
    return h_flex().id("dlg-title").size_full().pl(14).pr(8).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.closeDialog(); } })
      .child(glyph.flex_none())
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(String(p.label ?? "")))
      .child(move)
      .child(iconButton(t, "dlg-close", "close", () => this.closeDialog(), { tooltip: this.s("closeDialog"), glyph: 13 }));
  }

  closeDialog() {
    const id = this.overlay ?? shared(KEY_PANEL_DIALOG)?.id;
    if (id) closeOverlay(id);
  }

  // The name and the icon of a group button.
  groupInfo(group) {
    const known = GROUPS[group], first = this.groups.get(group)?.[0];
    return { label: known?.label ?? layoutLabel(group), icon: known?.icon ?? first?.icon ?? "" };
  }

  // Opens the menu of a group button at the pointer: one row per entry of the group, with its full name. The rows
  // come from the last render (lit = open now). A popup is as tall as its content, so the height is set here.
  openGroup(group) {
    const members = this.groups.get(group);
    if (!members?.length) return;
    const info = this.groupInfo(group);
    openOverlay({
      mod: "tabs-dock", kind: "popup", width: MENU_W, height: MENU_PAD * 2 + MENU_HEAD + members.length * MENU_ROW,
      props: { part: "group-menu", lang: this.lang, title: info.label, items: members.map(m => ({ id: m.id, label: m.label, icon: m.icon, on: m.on })) },
    });
  }

  // The menu of a group button: the name of the group, then one row per entry (icon, full name, a tick while it is
  // open). A click closes the menu and sends the entry to the bar ("tabs-dock.<id>"), as a click on its button does.
  groupMenu(t) {
    const p = this.props, items = Array.isArray(p.items) ? p.items : [];
    const row = (it) => h_flex().id(`gm-${it.id}`).w_full().h(MENU_ROW).px(10).gap(10).flex_none().items_center().rounded(6).cursor_pointer()
      .text_size(13).text_color(it.on ? t.accent : t.foreground)
      .when(it.on, (e) => e.bg(tint(t.accent, "1a")))
      .hover((s) => s.bg(it.on ? tint(t.accent, "33") : t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); this.pick(it.id); })
      .child(panelGlyph(it.icon, 15, it.on ? t.accent : t.muted))
      .child(div().flex_1().min_w(0).truncate().child(String(it.label ?? it.id)))
      .when(it.on, (e) => e.child(svg("mods/tabs-dock/tick.svg").size(13).flex_none().text_color(t.accent)));
    return v_flex().id("gm-root").w_full().p(MENU_PAD)
      .child(h_flex().w_full().h(MENU_HEAD).px(10).flex_none().items_center().text_size(11).font_semibold().text_color(t.dim).child(String(p.title ?? "")))
      .children(items.map(row));
  }

  pick(id) {
    run(`tabs-dock.${id}`);
    if (this.overlay) closeOverlay(this.overlay);
  }

  // The gear button. With the mods-hub installed, it opens a menu: Herdr's settings or the Herdr Mods dialog.
  // Without it, it opens Herdr's settings, as before.
  openGear() {
    const settingsOnly = () => run("app.settings");
    readTextFile(`${appHome()}/mods/mods-hub/mod.json`).then((text) => {
      if (text == null) return settingsOnly();
      openOverlay({ mod: "tabs-dock", kind: "popup", width: MENU_W, height: MENU_PAD * 2 + MENU_HEAD + 2 * MENU_ROW,
        props: { part: "gear-menu", lang: this.lang } });
    }, settingsOnly);
  }

  // The menu of the gear button. "Herdr Mods" opens the dialog on its Settings tab (the tab that the
  // mods-hub keeps in shared("mods-hub").tab). mod.open toggles: an open dialog closes.
  gearMenu(t) {
    const go = (fn) => { fn(); if (this.overlay) closeOverlay(this.overlay); };
    const row = (id, icon, label, fn) => h_flex().id(`gear-${id}`).w_full().h(MENU_ROW).px(10).gap(10).flex_none().items_center().rounded(6)
      .cursor_pointer().text_size(13).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); go(fn); })
      .child(svg(`mods/tabs-dock/${icon}.svg`).size(15).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(label));
    return v_flex().id("gear-root").w_full().p(MENU_PAD)
      .child(h_flex().w_full().h(MENU_HEAD).px(10).flex_none().items_center().text_size(11).font_semibold().text_color(t.dim).child(this.s("gearTitle")))
      .child(row("herdr", "settings", this.s("gearHerdr"), () => run("app.settings")))
      .child(row("mods", "mods", this.s("gearMods"), () => {
        setShared("mods-hub", { ...(shared("mods-hub") ?? {}), tab: "settings" });
        run("mod.open", { name: "mods-hub" });
      }));
  }

  dialogToSide() {
    this.closeDialog();
    const tab = this.props.tab;
    if (tab?.mod) return showTab(tab.mod, tab.name);
    const root = layout(), panel = find(root, "panel") ?? find(root, "panel-body");
    run("layout.select", { stack: "panel-body", child: this.props.panel });
    if (panel) run("layout.show", { id: panel.id });
  }

  // Herdr calls this when the block goes. For the title row of a dialog: the dialog closed (the close button,
  // Esc or a click beside it), so the bars stop showing its button as lit.
  async close() {
    if (this.part !== "panel-title") return;
    liveDialogs().delete(this.overlay);
    const open = shared(KEY_PANEL_DIALOG);
    if (open?.id && open.id === this.overlay) setShared(KEY_PANEL_DIALOG, null);
  }

  // Adds the blocks the file asks for to the panel stack, and takes away the ones
  // this bar added before that the file no longer lists. One attempt per file
  // version and layout: a layout that refuses the edit (a shipped one) is not retried.
  inject(root, body, wanted) {
    const keep = new Set(wanted.map(e => e.id));
    const missing = wanted.filter(e => !body.children.some(c => c.id === e.id));
    const stale = body.children.filter(c => this.injected.has(c.id) && !keep.has(c.id));
    if (!missing.length && !stale.length) { this.since = null; return false; }
    const key = `${shared("layout")}|${this.version}`;
    if (key === this.lastTry) return false;
    this.lastTry = key; this.since = Date.now();
    const tree = JSON.parse(JSON.stringify(root)), target = find(tree, "panel-body");
    target.children = target.children.filter(c => !stale.some(s => s.id === c.id));
    if (stale.some(s => s.id === target.active)) target.active = "files";
    for (const e of missing) target.children.push({ id: e.id, type: "block", content: { mod: e.mod, ...(e.props ? { props: e.props } : {}) } });
    // The layout file keeps no marker on a block, so the bar remembers which ones it added.
    for (const s of stale) this.injected.delete(s.id);
    for (const e of missing) this.injected.add(e.id);
    localStorage.setItem("injected", JSON.stringify([...this.injected]));
    run("layout.set", { layout: tree });
    return true;
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    if (this.part === "panel-title") return this.panelTitle(t);
    if (this.part === "group-menu") return this.groupMenu(t);
    if (this.part === "gear-menu") return this.gearMenu(t);
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");

    // The entries that may use the panel stack: not the id of any other node of the layout.
    const taken = ids(root);
    for (const c of body?.children ?? []) taken.delete(c.id);
    const wanted = this.entries.filter(e => e.opens !== "command" && !taken.has(e.id) && !BUILTIN.some(b => b.id === e.id));
    const commands = this.entries.filter(e => e.opens === "command");
    const panelEntries = wanted.filter(e => e.opens === "panel");
    const injecting = panel && body ? this.inject(root, body, panelEntries) : false;

    // Files and Changes follow the welcome's choice (they are in the layout).
    const present = new Set((body?.children ?? []).map(c => c.id));
    const chosen = shared("workspace.panels") ?? ["files", "changes"];
    const builtins = BUILTIN.filter(b => present.has(b.id) && chosen.includes(b.id));
    const panelButtons = [...builtins, ...panelEntries.filter(e => present.has(e.id))];
    // While the panels of the file are being added, a saved choice such as "graph" is not lost.
    const waiting = injecting || (this.since && Date.now() - this.since < 3000 && panelEntries.some(e => !present.has(e.id)));
    if (!waiting) this.syncPanel(space, panel, body, panelButtons.map(b => b.id));

    const density = DENSITIES.includes(shared(KEY_DENSITY)) ? shared(KEY_DENSITY) : "auto";
    const iconOnly = density === "normal" ? false : density === "compact" ? true : !(this.barW >= LABELS_WIDE);
    // The density button, the same as in the Kanban bar: lit while the buttons are compact. It is left of
    // the right end, so the right end keeps the same place as in the Kanban bar.
    const nextDensity = DENSITIES[(DENSITIES.indexOf(density) + 1) % DENSITIES.length];
    const densityName = (x) => this.s(`density_${x}`);
    const densityMode = density === "auto" ? this.s(iconOnly ? "densityNow" : "densityNowNormal", { mode: densityName(density) }) : densityName(density);
    const densityButton = div().id("density").size(26).flex_none().flex().items_center().justify_center().rounded(8).cursor_pointer()
      .tooltip(this.s("densityTip", { mode: densityMode, next: densityName(nextDensity) }))
      .when(iconOnly, el => el.bg(tint(t.accent, "26")))
      .hover(s => s.bg(iconOnly ? tint(t.accent, "40") : t.hover))
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); setShared(KEY_DENSITY, nextDensity); })
      .child(svg("mods/tabs-dock/density.svg").size(15).text_color(iconOnly ? t.accent : t.muted));
    const gearButton = div().id("gear").size(26).flex_none().flex().items_center().justify_center().rounded(8).cursor_pointer()
      .tooltip(this.s("gearTip"))
      .hover(s => s.bg(t.hover))
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); this.openGear(); })
      .child(svg("mods/tabs-dock/settings.svg").size(15).text_color(t.muted));
    const inDialog = this.dialogPanel();
    const lit = (id) => Boolean(panel && !panel.hidden && body?.active === id) || inDialog === id;
    const tip = (name) => this.s("panelTip", { name });
    // Where the panels open: lit while they open a dialog. The same button as in the Kanban bar.
    const opens = this.panelOpen(), dialogNow = this.dialogNow();
    const nextOpens = PANEL_OPENS[(PANEL_OPENS.indexOf(opens) + 1) % PANEL_OPENS.length];
    const opensName = (x) => this.s(`opens_${x}`);
    const opensMode = opens === "auto" ? this.s(dialogNow ? "opensNowDialog" : "opensNowSide", { mode: opensName(opens) }) : opensName(opens);
    const opensButton = iconButton(t, "panel-open", "dialog", () => this.stepPanelOpen(),
      { active: dialogNow, tooltip: this.s("opensTip", { mode: opensMode, next: opensName(nextOpens) }) });
    // Buttons keep the order of the file; panel and tab entries mix as listed. Other commands come last.
    // The layout.switch commands are in the layout switch.
    // The entries of a group share one button, in the place of the first one; its menu lists them.
    const dynamic = wanted.filter(e => e.opens === "tab" || present.has(e.id));
    const items = [
      ...builtins.map(b => ({ ...b, key: `panel-${b.id}`, on: lit(b.id), tip: tip(b.label) })),
      ...dynamic.map(e => e.opens === "tab"
        ? { ...e, key: `tab-open-${e.id}`, on: inDialog === e.id, tip: "" }
        : { ...e, key: `panel-${e.id}`, on: lit(e.id), tip: tip(e.label) }),
      ...commands.filter(e => e.run !== "layout.switch").map(e => ({ ...e, key: `cmd-${e.id}`, on: false, tip: "" })),
    ];
    const folded = foldGroups(items);
    this.groups = new Map(folded.filter(it => it.members).map(g => [g.group, g.members]));
    const panelItems = folded.map(it => {
      if (!it.members) return panelButton(t, it.key, it.icon, it.label, it.on, () => this.toggle(it.id), it.tip, iconOnly);
      const info = this.groupInfo(it.group);
      return panelButton(t, `group-${it.group}`, info.icon, info.label, it.members.some(m => m.on), () => this.openGroup(it.group),
        `${info.label}: ${it.members.map(m => m.label).join(", ")}`, iconOnly, true);
    });
    const here = shared("layout"), targets = this.layoutItems();
    const layoutSwitch = targets.length < 2 ? [] : [buttonGroup(t, targets.map(it =>
      panelButton(t, `layout-${it.name}`, it.symbol, it.label, it.name === here, () => this.runEntry(it.entry),
        this.s(it.name === here ? "layoutHere" : "switchTip", { name: it.label }), iconOnly)))];
    const wbtn = (id, glyph, action) => div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(7)
      .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).on_click(action).child(glyph);
    const win = w?.platform === "windows";
    const right = h_flex().flex_none().gap(RIGHT_GAP).items_center()
      .when(panelItems.length > 0, el => el.child(buttonGroup(t, [opensButton, innerDivider(t), ...panelItems])))
      .children(layoutSwitch)
      .when(w?.buttons, el => el.child(h_flex().flex_none().gap(2).items_center()
        .child(wbtn("minimize", win ? svg("mods/tabs-dock/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(wbtn("maximize", win ? svg(`mods/tabs-dock/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(wbtn("close-window", win ? svg("mods/tabs-dock/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close")))));
    return h_flex().size_full().min_w(0).pl(lightsPadding).pr(BAR_RIGHT).gap(6).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_size_change((size, cx) => {
        const width = Math.round(size.width);
        if (width !== this.barW) { this.barW = width; cx.notify(); }
      })
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })).tooltip(this.s("newTab")))
      .child(buttonGroup(t, [densityButton, gearButton]))
      .child(right);
  }
}
