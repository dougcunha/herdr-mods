// The Git panel: the tabs, the branch bar (fetch, pull, push) and the tab that shows. The History
// tab reads the repository (one watcher, one timer) and tells the Changes tab after every read.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, h_resizable, v_resizable, resizable_panel } from "gpui-base";
import { spaces, panes, focused, exec, theme, settings, props, shared, setShared, closeOverlay, nextCommand, notify } from "herdr";
import { READ } from "./git.js";
import { perform, openDialog } from "./act.js";
import { icon } from "./menu.js";
import { History } from "./history.js";
import { Changes } from "./changes.js";
import { Branches } from "./branches.js";
import { Stash } from "./stash.js";
import { FileView } from "./fileview.js";
import { Submodules } from "./submodules.js";
import { Sidebar } from "./sidebar.js";

// The mods-hub can turn this mod off (shared "herdr-mods.disabled", a list of mod names). Then the mod draws
// nothing, closes its dialog and skips its timed work. The bars hide its blocks and buttons.
const kitOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes("git-client"); };
const offView = () => { const o = props()?.overlay; if (o) closeOverlay(o); return div(); };

// A folder on another machine: a server icon and the machine name, in a hue that no agent status uses.
// (The same chip as in the tabs-dock and kanban bars.)
const machineChip = (t, machine) => {
  const color = t.ansi5 || t.accent;
  const tint = /^#[0-9a-f]{6}$/i.test(color || "") ? (a) => color + a : () => color;
  return h_flex().id("machine-chip").h(20).px(7).gap(4).flex_none().max_w(140).items_center().rounded(6).text_size(11).font_semibold()
    .bg(tint("26")).border_1().border_color(tint("66")).text_color(color)
    .tooltip(`On ${machine}`)
    .child(svg("mods/workspace-chrome/server.svg").size(11).flex_none())
    .child(div().truncate().child(machine));
};
// The dialog that shows this panel: its own overlay, or the dock's panel dialog; null in the side panel.
const dialogId = () => props()?.overlay ?? shared("kanban.panelDialog")?.id ?? null;
// A dialog of this mod's own (not a panel dialog of the dock, whose title row has its own ×): the tab bar shows an ×.
const ownDialog = () => { const o = props()?.overlay; return o && shared("kanban.panelDialog")?.id !== o ? o : null; };

const TABS = [
  { id: "changes", label: "Changes", icon: "changes" },
  { id: "history", label: "History", icon: "history" },
  { id: "branches", label: "Branches", icon: "branch" },
  { id: "stash", label: "Stash", icon: "stash" },
  { id: "submodules", label: "Submodules", icon: "package" },
];
// Preferences of the Settings tab of PowerMods.
const pullMode = () => (["config", "ff-only", "rebase", "merge"].includes(shared("git-client.pull")) ? shared("git-client.pull") : "config");
const prune = () => shared("git-client.prune") !== false;
const NARROW = 420, WIDE = 820;
const KEY_SIDEBAR_W = "git-client.sidebarWidth";
const KEY_CHANGES_H = "git-client.changesHeight";
const KEY_INSP_LEFT_W = "git-client.inspectorLeftWidth";

export class Client {
  init(cx) {
    this.folder = props()?.folder ?? null;
    this.tab = TABS.some((t) => t.id === props()?.tab) ? props().tab : "changes";
    this.isModal = Boolean(props()?.modal || props()?.overlay || shared("kanban.panelDialog")?.panel === "changes");
    this.typing = false; this.width = 400; this.height = 600;
    this.refreshing = false;
    this.inspector = null; this.inspectorGen = 0; this.inspectorAutoSet = false; this.pendingSubFocus = null;
    const uid = Math.random().toString(36).slice(2);
    this.wideSplitId = `gc-wide-${uid}`;
    this.inspectorSplitId = `gc-insp-${uid}`;
    this.changesSplitId = `gc-chg-${uid}`;
    this.stashSplitId = `gc-sta-${uid}`;
    this.handle = cx.focus_handle();
    // The Unified / Split choice of changes-split, once, so the Settings tab shows the same.
    const old = shared("changes-split.view");
    if (shared("git-client.view") == null && (old === "split" || old === "unified")) setShared("git-client.view", old);
    this.seenShow = shared("git-client.show")?.at;
    this.history = new History(this); this.changes = new Changes(this);
    this.branches = new Branches(this); this.stash = new Stash(this); this.fileView = new FileView(this);
    this.submodules = new Submodules(this); this.sidebar = new Sidebar(this);
    // Submodules opened in the client, the last one shown; Back goes to the one before.
    this.subs = [];
    this.changes.init(cx); this.branches.init(cx); this.stash.init(cx); this.submodules.init(cx); this.sidebar.init(cx); this.history.init(cx);
    if (this.isModal) {
      cx.timer.after(50, () => { if (!this.isTyping()) this.handle.focus(); });
    }
    // git-client.<tab>, .commit, .fetch, .pull, .push, .refresh, .split, .unified, .toggle.
    cx.spawn(async (cx) => {
      for (;;) { const c = String(await nextCommand()); if (!kitOff()) this.command(c, cx); cx.notify(); }
    });
  }

  isWide() { return this.width >= WIDE; }
  isTyping() { return Boolean(this.typing || this.history.typing || this.branches.typing || this.sidebar.typing); }

  sidebarWidth() {
    const w = Number(shared(KEY_SIDEBAR_W));
    return Number.isFinite(w) && w >= 200 ? Math.min(440, Math.round(w)) : 268;
  }
  saveSidebarWidth(px) {
    if (Number.isFinite(px) && px >= 200) setShared(KEY_SIDEBAR_W, Math.min(440, Math.round(px)));
  }

  inspectorLeftWidth() {
    const w = Number(shared(KEY_INSP_LEFT_W));
    return Number.isFinite(w) && w >= 220 ? Math.min(580, Math.round(w)) : 330;
  }
  saveInspectorLeftWidth(px) {
    if (Number.isFinite(px) && px >= 220) setShared(KEY_INSP_LEFT_W, Math.min(580, Math.round(px)));
  }

  inspectorHeight() {
    const avail = Math.max(240, this.height - 40);
    if (this.inspector === "changes") {
      const h = Number(shared(KEY_CHANGES_H));
      return Number.isFinite(h) && h >= 180 ? Math.min(avail - 120, Math.round(h)) : Math.max(200, Math.round(avail * 0.52));
    }
    const h = Number(shared("git-client.detailsHeight"));
    return Number.isFinite(h) && h >= 150 ? Math.min(avail - 120, Math.round(h)) : Math.max(160, Math.round(avail * 0.42));
  }
  saveInspectorHeight(px) {
    if (!this.inspector || !Number.isFinite(px) || px < 150) return;
    if (this.inspector === "changes") setShared(KEY_CHANGES_H, Math.round(px));
    else setShared("git-client.detailsHeight", Math.round(px));
  }

  openInspector(kind, cx) {
    const wasOpen = Boolean(this.inspector), wasChanges = this.inspector === "changes", nextChanges = kind === "changes";
    this.inspector = kind;
    this.inspectorAutoSet = true;
    if (!wasOpen || wasChanges !== nextChanges) this.inspectorGen++;
    cx.notify();
  }

  closeInspector(cx) {
    if (!this.inspector) return;
    this.inspector = null;
    if (this.history.selected) { this.history.selected = null; this.history.details = null; this.history.diff = null; }
    cx.notify();
  }

  off() { return kitOff(); }
  async close() { await this.changes?.dispose?.(); }

  // The repository of the panel: props.folder (a pane), else the focused pane's folder and machine.
  location() {
    const sub = this.subs[this.subs.length - 1];
    if (sub) return { cwd: sub.cwd, on: sub.on };
    if (this.folder) return { cwd: this.folder, on: null };
    const space = spaces().find((s) => s.active), f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
    return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
  }

  ctx() { return this.history.ctx; }
  onRead(cx, target = "full") {
    this.changes.reload(cx);
    if (target === "full" || target === "stash") this.stash.reload(cx);
    if (target === "full") this.branches.reload(cx, this.isWide());
    if (target === "full" || target === "submodules") this.submodules.reload(cx, this.isWide());
    if (this.history.context !== this.lastAutoContext) {
      this.lastAutoContext = this.history.context;
      this.inspectorAutoSet = false;
    }
    const repoReady = this.history.state === "ready" || this.history.state === "empty";
    if (this.isWide() && repoReady) {
      if (this.pendingSubFocus && this.history.files.some((f) => f.path === this.pendingSubFocus)) {
        const path = this.pendingSubFocus;
        this.pendingSubFocus = null;
        this.inspectorAutoSet = true;
        this.openInspector("changes", cx);
        this.changes.focusPath(path, cx);
      } else if (!this.inspectorAutoSet) {
        this.inspectorAutoSet = true;
        if (this.history.files.length > 0) this.openInspector("changes", cx);
        else if (this.inspector === "changes") this.inspector = null;
      }
    }
  }

  enterSubmodule(sub, cx) {
    const h = this.history;
    if (!h.root) return;
    const parentLabel = this.subs.length
      ? this.subs[this.subs.length - 1].name
      : (h.root.replace(/\\/g, "/").split("/").pop() || "repo");
    this.subs.push({ cwd: `${h.root}/${sub.path}`, on: h.on ?? null, name: sub.path, parentRoot: h.root, parentLabel });
    this.inspector = null; this.inspectorAutoSet = false; this.fileView.close();
    this.history.refresh(cx, true, { target: "full" });
    cx.notify();
  }

  backTo(index, cx) {
    if (!this.subs.length) return;
    const popped = index < 0 ? this.subs[0] : this.subs[index + 1];
    this.subs = index < 0 ? [] : this.subs.slice(0, index + 1);
    this.pendingSubFocus = popped?.name ?? null;
    this.inspector = null; this.inspectorAutoSet = false; this.fileView.close();
    this.history.refresh(cx, true, { target: "full" });
    cx.notify();
  }

  // Back from a submodule to the repository that holds it.
  back(cx) { this.backTo(this.subs.length - 2, cx); }

  refreshAll(cx) {
    this.history.refresh(cx, true, { target: "full" });
    if (this.isWide()) {
      this.branches.reload(cx, true, { loadWorktrees: this.sidebar.open.worktrees });
      this.stash.reload(cx);
      this.submodules.reload(cx, true);
    }
    cx.notify();
  }

  fetchAndRefresh(cx) { this.fetch(cx); }

  setTab(tab, cx) {
    if (!TABS.some((t) => t.id === tab)) return;
    this.tab = tab; this.fileView.close();
    if (this.isWide()) {
      if (tab === "changes") this.openInspector("changes", cx);
      else if (tab === "history") this.closeInspector(cx);
      else if (tab === "branches") { this.sidebar.open = { ...this.sidebar.open, local: true }; }
      else if (tab === "stash") { this.sidebar.open = { ...this.sidebar.open, stash: true }; }
      else if (tab === "submodules") { this.sidebar.open = { ...this.sidebar.open, submodules: true }; }
      cx.notify();
      return;
    }
    if (tab === "branches" && this.branches.dirty) this.branches.reload(cx, true);
    if (tab === "stash") this.stash.reload(cx);
    if (tab === "submodules" && this.submodules.dirty) this.submodules.reload(cx, true);
    cx.notify();
  }

  command(c, cx) {
    if (TABS.some((t) => t.id === c)) this.setTab(c, cx);
    else if (c === "fetch") this.fetch(cx);
    else if (c === "pull") this.pull(cx);
    else if (c === "push") this.push(cx);
    else if (c === "refresh") this.refreshAll(cx);
    else if (c === "commit") { this.setTab("changes", cx); this.changes.command(c, cx); }
    else this.changes.command(c, cx);
  }

  // ---- fetch, pull, push

  remoteFor(info, remotes) {
    const up = info.upstream ? remotes.find((r) => info.upstream.startsWith(`${r}/`)) : null;
    return up ?? (remotes.includes("origin") ? "origin" : remotes[0] ?? null);
  }

  act(name, action, values, ctx, cx) {
    if (this.busy) return;
    this.busy = name;
    cx.spawn(async (cx) => { await perform(action, values, ctx); this.busy = null; cx.notify(); });
    cx.notify();
  }

  fetch(cx) { const ctx = this.ctx(); if (ctx?.remotes.length) this.act("fetch", { type: "fetch" }, { prune: prune() }, ctx, cx); }

  forcePush() {
    const ctx = this.ctx();
    if (ctx?.current && ctx.remotes.length) openDialog({ type: "forcePush", name: ctx.current }, ctx);
  }

  pull(cx) {
    const ctx = this.ctx(), info = this.history.branchInfo;
    if (!ctx) return;
    if (!info.upstream || info.gone) { notify({ title: "Nothing to pull from", body: `${ctx.current ?? "HEAD"} has no upstream branch. Push it first.`, level: "warning" }); return; }
    this.act("pull", { type: "pull", upstream: info.upstream }, { mode: pullMode() }, ctx, cx);
  }

  push(cx) {
    if (this.busy) return;
    this.busy = "push"; cx.notify();
    cx.spawn(async (cx) => { await this.pushNow(cx); this.busy = null; cx.notify(); });
  }

  // Pushes the current branch; sets its upstream when it has none. HEAD is read again: a commit may have just moved it.
  async pushNow(cx) {
    const h = this.history, ctx = this.ctx();
    if (!h.root || !ctx) return;
    const git = (args) => exec("git", [...READ, ...args], { cwd: h.root, on: h.on });
    const [head, branch] = await Promise.all([git(["rev-parse", "--verify", "-q", "HEAD"]), git(["symbolic-ref", "-q", "--short", "HEAD"])]);
    const current = branch.code === 0 ? branch.stdout.trim() : null;
    if (!current) { notify({ title: "Nothing to push", body: "You're on a detached HEAD. Create a branch first.", level: "warning" }); return; }
    const remote = this.remoteFor(h.branchInfo, ctx.remotes);
    if (!remote) { notify({ title: "No remote", body: "This repository has no remote to push to.", level: "warning" }); return; }
    await perform({ type: "push", name: current }, { remote, upstream: !h.branchInfo.upstream || h.branchInfo.gone },
      { ...ctx, head: head.code === 0 ? head.stdout.trim() : null, current });
    cx.notify();
  }

  // ---- drawing

  iconButton(id, glyph, text, tip, enabled, action, t) {
    return h_flex().id(id).h(26).px(text ? 7 : 5).gap(5).flex_none().items_center().rounded(6).text_size(11.5)
      .text_color(enabled ? t.muted : t.dim).tooltip(tip)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { if (enabled) action(cx); })
      .child(svg(icon(glyph)).size(14).flex_none()).when(Boolean(text), (e) => e.child(text));
  }

  tabBar(t) {
    const narrow = this.width < NARROW, files = this.history.files?.length ?? 0;
    const counts = { changes: files, stash: this.stash.list.length };
    return h_flex().h(40).flex_none().px(8).gap(2).items_center().border_b(1).border_color(t.border)
      .children(TABS.map((tab) => {
        const on = this.tab === tab.id, n = counts[tab.id];
        return h_flex().id(`gc-tab-${tab.id}`).h(30).px(narrow ? 8 : 10).gap(6).flex_none().items_center().rounded(7).cursor_pointer()
          .text_size(12.5).text_color(on ? t.foreground : t.muted).when(on, (e) => e.bg(t.selected).font_semibold())
          .when(!on, (e) => e.hover((s) => s.bg(t.hover).text_color(t.foreground)))
          .when(narrow, (e) => e.tooltip(tab.label))
          .on_click((_e, cx) => this.setTab(tab.id, cx))
          .child(svg(icon(tab.icon)).size(14).flex_none())
          .when(!narrow, (e) => e.child(tab.label))
          .when(Boolean(n), (e) => e.child(div().px(5).rounded(8).bg(on ? t.background : t.raised).text_size(10.5).text_color(t.muted).child(String(n))));
      }))
      .child(div().flex_1())
      .child(this.iconButton("gc-refresh", "refresh", null, "Refresh", this.history.state !== "nofolder", (cx) => this.history.refresh(cx), t))
      .when(Boolean(ownDialog()), (e) => e.child(this.iconButton("gc-close", "x", null, "Close", true, () => closeOverlay(ownDialog()), t)));
  }

  branchBar(t) {
    const h = this.history, info = h.branchInfo ?? {}, ctx = this.ctx(), remotes = ctx?.remotes ?? [];
    if (!h.root) return div();
    const where = h.current ?? (h.head ? `detached at ${h.head.slice(0, 8)}` : info.branch ?? "no commits");
    const busy = this.busy, canPull = Boolean(info.upstream) && !info.gone, canPush = remotes.length > 0 && Boolean(h.current);
    const sub = this.subs[this.subs.length - 1];
    return h_flex().h(34).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
      // In a submodule: Back to the repository that holds it, and the submodule's name.
      .when(Boolean(sub), (e) => e.child(h_flex().id("gc-sub-back").h(22).pl(2).pr(7).gap(3).flex_none().items_center().rounded(6).cursor_pointer()
          .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Back to the repository that holds this submodule")
          .on_click((_e, cx) => this.back(cx)).child(svg(icon("back")).size(13)).child(div().text_size(11.5).child("Back")))
        .child(h_flex().h(22).px(7).gap(5).flex_none().max_w(160).items_center().rounded(6).bg(t.raised).text_color(t.foreground)
          .child(svg(icon("package")).size(12).flex_none()).child(div().min_w(0).truncate().text_size(11.5).child(sub.name))))
      .when(Boolean(h.on), (e) => e.child(machineChip(t, h.on)))
      .child(h_flex().h(22).px(7).gap(5).min_w(0).items_center().rounded(6).bg(t.accent + "26").text_color(t.accent)
        .tooltip(info.upstream ? `${where} → ${info.upstream}${info.gone ? " (gone)" : ""}` : `${where} (no upstream)`)
        .child(svg(icon(h.current ? "branch" : "commit")).size(12).flex_none()).child(div().min_w(0).truncate().text_size(11.5).font_semibold().child(where)))
      .when(info.ahead > 0, (e) => e.child(div().flex_none().text_size(11.5).text_color(t.ansi2).child(`↑${info.ahead}`)))
      .when(info.behind > 0, (e) => e.child(div().flex_none().text_size(11.5).text_color(t.ansi1).child(`↓${info.behind}`)))
      .when(info.gone, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child("gone")))
      .child(div().flex_1())
      .when(remotes.length > 0, (e) => e
        .child(this.iconButton("gc-fetch", "cloud-down", busy === "fetch" ? "…" : null, "Fetch all remotes", !busy, (cx) => this.fetch(cx), t))
        .child(this.iconButton("gc-pull", "pull", busy === "pull" ? "…" : info.behind ? String(info.behind) : null, canPull ? `Pull ${info.upstream} (fast-forward only)` : "No upstream to pull from", canPull && !busy, (cx) => this.pull(cx), t))
        .child(this.iconButton("gc-push", "push-line", busy === "push" ? "…" : info.ahead ? String(info.ahead) : null, `${info.upstream && !info.gone ? `Push to ${info.upstream}` : "Push and set the upstream"}. Right-click: force push (with lease)`, canPush && !busy, (cx) => this.push(cx), t)
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); if (canPush && !busy) this.forcePush(); })));
  }

  // Unified top toolbar for the wide/modal workspace: breadcrumb, machine chip, current branch, and git actions.
  wideBar(t) {
    const h = this.history, info = h.branchInfo ?? {}, ctx = this.ctx(), remotes = ctx?.remotes ?? [];
    const where = h.current ?? (h.head ? `detached at ${h.head.slice(0, 8)}` : info.branch ?? "no commits");
    const busy = this.busy, canPull = Boolean(info.upstream) && !info.gone, canPush = remotes.length > 0 && Boolean(h.current);
    const rootName = this.subs.length
      ? this.subs[0].parentLabel
      : (h.root ? h.root.replace(/\\/g, "/").split("/").pop() : "Repository");

    const crumb = (id, label, onClick, isLast) => h_flex().id(id).h(24).px(7).gap(4).flex_none().items_center().rounded(6)
      .text_size(12).when(isLast, (e) => e.font_semibold().text_color(t.foreground))
      .when(!isLast, (e) => e.text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick))
      .child(div().max_w(180).truncate().child(label));

    return h_flex().id("gc-wide-bar").h(40).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .when(this.subs.length > 0, (e) => e.child(this.iconButton("gc-sub-back", "back", "Back", "Back to parent repository", true, (cx) => this.back(cx), t)))
      .child(crumb("gc-bc-root", rootName, (_e, cx) => this.backTo(-1, cx), this.subs.length === 0))
      .children(this.subs.flatMap((s, i) => [
        div().flex_none().text_size(11).text_color(t.dim).child("›"),
        crumb(`gc-bc-${i}`, s.name, (_e, cx) => this.backTo(i, cx), i === this.subs.length - 1),
      ]))
      .when(Boolean(h.on), (e) => e.child(machineChip(t, h.on)))
      .when(Boolean(h.root), (e) => e
        .child(h_flex().h(22).px(7).gap(5).min_w(0).items_center().rounded(6).bg(t.accent + "26").text_color(t.accent)
          .tooltip(info.upstream ? `${where} → ${info.upstream}${info.gone ? " (gone)" : ""}` : `${where} (no upstream)`)
          .child(svg(icon(h.current ? "branch" : "commit")).size(12).flex_none())
          .child(div().min_w(0).truncate().text_size(11.5).font_semibold().child(where)))
        .when(info.ahead > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.ansi2).child(`↑${info.ahead}`)))
        .when(info.behind > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.ansi1).child(`↓${info.behind}`)))
        .when(info.gone, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child("gone"))))
      .child(div().flex_1())
      .when(remotes.length > 0, (e) => e
        .child(this.iconButton("gc-fetch", "cloud-down", busy === "fetch" ? "…" : "Fetch", "Fetch all remotes (Shift+F5)", !busy, (cx) => this.fetchAndRefresh(cx), t))
        .child(this.iconButton("gc-pull", "pull", busy === "pull" ? "…" : info.behind ? `Pull ${info.behind}` : "Pull", canPull ? `Pull ${info.upstream}` : "No upstream to pull from", canPull && !busy, (cx) => this.pull(cx), t))
        .child(this.iconButton("gc-push", "push-line", busy === "push" ? "…" : info.ahead ? `Push ${info.ahead}` : "Push", `${info.upstream && !info.gone ? `Push to ${info.upstream}` : "Push and set the upstream"}. Right-click: force push (with lease)`, canPush && !busy, (cx) => this.push(cx), t)
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); if (canPush && !busy) this.forcePush(); })))
      .child(this.iconButton("gc-refresh", "refresh", this.refreshing ? "…" : "Refresh", "Refresh repository (F5)", h.state !== "nofolder", (cx) => this.refreshAll(cx), t))
      .when(Boolean(ownDialog()), (e) => e.child(this.iconButton("gc-close", "x", null, "Close", true, () => closeOverlay(ownDialog()), t)));
  }

  inspectorHeader(t) {
    const map = {
      changes: { icon: "changes", title: "Working Tree Changes" },
      commit: { icon: "commit", title: this.history.selected ? `Commit ${this.history.selected.slice(0, 8)}` : "Commit Details" },
      stash: { icon: "stash", title: this.stash.sel ? `Stash ${this.stash.sel.ref}` : "Stash Details" },
    };
    const info = map[this.inspector] ?? { icon: "changes", title: "Inspector" };
    return h_flex().h(28).flex_none().px(10).gap(6).items_center().bg(t.chrome).border_t(1).border_b(1).border_color(t.border)
      .child(svg(icon(info.icon)).size(12).flex_none().text_color(t.accent))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_semibold().text_color(t.foreground).child(info.title))
      .child(this.iconButton("gc-insp-close", "x", null, "Close bottom panel", true, (cx) => this.closeInspector(cx), t));
  }

  renderWide(t, cx) {
    const mono = settings().font_family ?? "JetBrains Mono";
    const open = Boolean(this.inspector);
    const body = this.inspector === "changes" ? this.changes.renderWide(t)
      : this.inspector === "commit" ? this.history.detailsPaneWide(t, mono)
      : this.inspector === "stash" ? this.stash.renderWide(t)
      : div();
    return div().id("gc-wide-body").flex_1().min_h(0).w_full().child(
      h_resizable(this.wideSplitId).size_full()
        .on_resize((sizes) => this.saveSidebarWidth(sizes?.[0]))
        .child(resizable_panel().size(this.sidebarWidth()).size_range(200, 440).child(this.sidebar.render(t, cx)))
        .child(resizable_panel().size_range(400).child(
          div().size_full().min_h(0).child(
            v_resizable(`${this.inspectorSplitId}-${this.inspectorGen}`).size_full()
              .on_resize((sizes) => this.saveInspectorHeight(sizes?.[1]))
              .child(resizable_panel().size_range(120).child(this.history.renderGraph(cx)))
              .child(resizable_panel().visible(open).size(this.inspectorHeight()).size_range(150)
                .child(open ? v_flex().size_full().min_h(0).child(this.inspectorHeader(t)).child(body) : div()))))));
  }

  render(cx) {
    if (kitOff()) return offView();
    // The signal first: a submodule changes the location, and sync() then reads it.
    const show = shared("git-client.show");
    if (show?.at && show.at !== this.seenShow) {
      this.seenShow = show.at;
      if (show.sub?.cwd) {
        const parentLabel = this.subs.length ? this.subs[this.subs.length - 1].name : (this.history.root?.replace(/\\/g, "/").split("/").pop() || "repo");
        this.subs.push({ ...show.sub, parentLabel });
        this.inspector = null; this.inspectorAutoSet = false; this.tab = "changes"; this.fileView.close();
      }
      else if (show.file && this.history.root) { this.fileView.open(show.file, show.mode, cx); this.fileView.context = this.history.context; }
      else if (TABS.some((t) => t.id === show.tab)) {
        if (this.isWide()) this.setTab(show.tab, cx);
        else { this.tab = show.tab; this.fileView.close(); }
      }
    }
    this.history.sync(cx);
    // Another repository: the file of the view is not there.
    if (this.fileView.path && this.fileView.context !== this.history.context) this.fileView.close();
    const t = theme(), wide = this.isWide();
    return v_flex().id("git-client").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(12.5).track_focus(this.handle)
      // In a dialog, a click in the panel gives it the keyboard (text fields stop their own mouse down):
      // else no part of the dialog has it after the click, and Esc does nothing.
      .on_mouse_down("left", () => { if (dialogId()) this.handle.focus(); })
      .on_size_change((size, cx) => {
        const zoom = Number(settings()?.zoom) > 0 ? Number(settings().zoom) : 1;
        const width = Math.round(size.width / zoom), height = Math.round(size.height / zoom);
        if (width !== this.width || height !== this.height) {
          const wasWide = this.isWide();
          this.width = width; this.height = height;
          if (!wasWide && this.isWide()) this.onRead(cx, "full");
          cx.notify();
        }
      })
      .on_key_down((e, cx) => {
        if (String(e.key).toLowerCase() === "f5" && !e.modifiers?.control && !e.modifiers?.platform && !e.modifiers?.alt) {
          if (e.modifiers?.shift) this.fetchAndRefresh(cx);
          else this.refreshAll(cx);
          cx.stop_propagation();
          return;
        }
        if ((e.key === "a" || e.key === "A") && (e.modifiers?.control || e.modifiers?.platform) && !e.modifiers?.shift && !e.modifiers?.alt
            && !this.fileView.path) {
          if ((wide ? this.inspector === "changes" : this.tab === "changes") && !this.typing) {
            this.changes.selectAllCurrent(cx);
            cx.stop_propagation();
            return;
          }
          if (!wide && this.tab === "branches" && !this.branches.typing) {
            this.branches.selectAllCurrent(cx);
            cx.stop_propagation();
            return;
          }
        }
        if (e.key !== "escape") return;
        const dialog = dialogId();
        // A text field has the keyboard: Esc leaves it. In a dialog, an empty field closes the dialog.
        if (this.typing) {
          if (!this.changes.message.trim() && dialog) closeOverlay(dialog);
          else { this.typing = false; if (dialog) this.handle.focus(); else this.changes.input.blur(); cx.notify(); }
        } else if (this.history.typing) {
          if (this.history.search.value().trim()) this.history.clearSearch(cx);
          else if (dialog) closeOverlay(dialog);
          else { this.history.typing = false; this.history.search.blur(); }
          cx.notify();
        } else if (this.branches.typing) {
          if (this.branches.search.value()) { this.branches.search.set_value(""); this.branches.text = ""; }
          else if (dialog) closeOverlay(dialog);
          else { this.branches.typing = false; this.branches.search.blur(); }
          cx.notify();
        } else if (this.sidebar.typing) {
          if (this.sidebar.search.value()) this.sidebar.clearSearch(cx);
          else if (dialog) closeOverlay(dialog);
          else { this.sidebar.typing = false; this.sidebar.search.blur(); }
          cx.notify();
        } else if (this.fileView.path) {
          this.fileView.close(); cx.notify();
        } else if (wide) {
          if (this.history.filter) this.history.clearSearch(cx);
          else if (this.history.branchFilter) this.history.setBranchFilter(null, cx);
          else if (this.history.branchNotice) { this.history.branchNotice = null; cx.notify(); }
          else if (this.changes.escape(cx)) { /* cleared multi-file selection */ }
          else if (this.branches.escape(cx)) { /* cleared multi-branch selection */ }
          else if (dialog) closeOverlay(dialog);
          else return;
        } else if (this.tab === "changes" && this.changes.escape(cx)) {
          // cleared multi-file selection
        } else if (this.tab === "branches" && this.branches.escape(cx)) {
          // cleared multi-branch selection
        } else if (this.tab === "stash" && this.stash.sel) {
          this.stash.clear(); cx.notify();
        } else if (this.tab === "history" && this.history.escape(cx)) {
          // closed a diff, the details or the search
        } else if (dialog) closeOverlay(dialog);
        else return;
        cx.stop_propagation();
      })
      .when(wide, (e) => e.child(this.wideBar(t))
        .when(Boolean(this.fileView.path), (el) => el.child(this.fileView.render(t, cx)))
        .when(!this.fileView.path, (el) => el.child(this.renderWide(t, cx))))
      .when(!wide, (e) => e.child(this.tabBar(t)).child(this.branchBar(t))
        .when(Boolean(this.fileView.path), (el) => el.child(this.fileView.render(t, cx)))
        .when(!this.fileView.path && this.tab === "changes", (el) => el.child(this.changes.render(t)))
        .when(!this.fileView.path && this.tab === "history", (el) => el.child(this.history.render(cx)))
        .when(!this.fileView.path && this.tab === "branches", (el) => el.child(this.branches.render(t)))
        .when(!this.fileView.path && this.tab === "stash", (el) => el.child(this.stash.render(t)))
        .when(!this.fileView.path && this.tab === "submodules", (el) => el.child(this.submodules.render(t))));
  }
}
