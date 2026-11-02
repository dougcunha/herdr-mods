import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings, appHome, readTextFile, watchFolder, nextCommand, notify } from "herdr";
import * as fs from "fs/promises";

// The dock: the tab bar draws one button per entry of dock/panels.json, and adds
// the side panel of each entry to the layout by itself. A new button is one new
// entry in that file: no clone of the tab bar, no edit of the layout.
//
// Entry: { id, label, icon, mod, props?, opens?: "panel" | "tab", name? }
//   opens "panel" (default): a block of the side panel, `mod` with `props`.
//   opens "tab": a tab per space with `mod` as its only pane (focus it, or make it).

const BUILTIN = [
  { id: "files", label: "Files", icon: "mods/files/file.svg" },
  { id: "changes", label: "Changes", icon: "mods/changes/changes.svg" },
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
  init(_props, cx) {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.entries = [];
    this.injected = new Set(JSON.parse(localStorage.getItem("injected") ?? "[]"));
    this.version = 0;
    this.lastTry = null;
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
    // Keys open a panel as its button does: "ctrl-alt-g": "tabs-dock.graph" in keys.json.
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
          const why = !raw || typeof raw !== "object" ? "not an object"
            : !ID.test(String(raw.id)) ? `bad id "${raw.id}" (use a-z, 0-9, -)`
            : seen.has(raw.id) ? `id "${raw.id}" twice`
            : typeof raw.label !== "string" || !raw.label ? `"${raw.id}" has no label`
            : typeof raw.icon !== "string" || !raw.icon ? `"${raw.id}" has no icon`
            : typeof raw.mod !== "string" || !mods.has(raw.mod) ? `"${raw.id}": mod "${raw.mod}" is not in mods/`
            : null;
          if (why) { problem = problem ?? why; continue; }
          seen.add(raw.id);
          entries.push({ id: raw.id, label: raw.label, icon: raw.icon, mod: raw.mod, props: raw.props,
            opens: raw.opens === "tab" ? "tab" : "panel", name: typeof raw.name === "string" ? raw.name : raw.label });
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

  toggle(id) {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (!panel || !body?.children?.some(c => c.id === id)) {
      const entry = this.entries.find(e => e.id === id && e.opens === "tab");
      if (entry) showTab(entry.mod, entry.name);
      return;
    }
    if (!panel.hidden && body.active === id) run("layout.hide", { id: "panel" });
    else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
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
    const wanted = this.entries.filter(e => !taken.has(e.id) && !BUILTIN.some(b => b.id === e.id));
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

    const panelButton = (b) => {
      const on = panel && !panel.hidden && body?.active === b.id;
      return h_flex().id(`panel-${b.id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => this.toggle(b.id))
        .child(b.icon.endsWith(".svg") ? svg(b.icon).size(14) : image(b.icon).size(14)).child(b.label);
    };
    const tabButton = (e) => h_flex().id(`tab-open-${e.id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).bg(t.chrome).text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
      .on_click(() => showTab(e.mod, e.name))
      .child(e.icon.endsWith(".svg") ? svg(e.icon).size(14) : image(e.icon).size(14)).child(e.label);
    // Buttons keep the order of the file; panel and tab entries mix as listed.
    const dynamic = wanted.filter(e => e.opens === "tab" || present.has(e.id));
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .children(builtins.map(panelButton))
      .children(dynamic.map(e => (e.opens === "tab" ? tabButton(e) : panelButton(e))))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-dock/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-dock/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-dock/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
