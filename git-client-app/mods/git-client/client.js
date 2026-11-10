// The Git panel: the tabs, the branch bar (fetch, pull, push) and the tab that shows. The History
// tab reads the repository (one watcher, one timer) and tells the Changes tab after every read.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, theme, settings, props, shared, setShared, closeOverlay, nextCommand, notify } from "herdr";
import { READ } from "./git.js";
import { perform, openDialog } from "./act.js";
import { icon } from "./menu.js";
import { History } from "./history.js";
import { Changes } from "./changes.js";
import { Branches } from "./branches.js";
import { Stash } from "./stash.js";

// The mods-hub can turn this mod off (shared "herdr-mods.disabled", a list of mod names). Then the mod draws
// nothing, closes its dialog and skips its timed work. The bars hide its blocks and buttons.
const kitOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes("git-client"); };
const offView = () => { const o = props()?.overlay; if (o) closeOverlay(o); return div(); };
// The dialog that shows this panel: its own overlay, or the dock's panel dialog; null in the side panel.
const dialogId = () => props()?.overlay ?? shared("kanban.panelDialog")?.id ?? null;

const TABS = [
  { id: "changes", label: "Changes", icon: "changes" },
  { id: "history", label: "History", icon: "history" },
  { id: "branches", label: "Branches", icon: "branch" },
  { id: "stash", label: "Stash", icon: "stash" },
];
// Preferences of the Settings tab of Herdr Mods.
const pullMode = () => (["config", "ff-only", "rebase", "merge"].includes(shared("git-client.pull")) ? shared("git-client.pull") : "config");
const prune = () => shared("git-client.prune") !== false;
const NARROW = 420;

export class Client {
  init(cx) {
    this.folder = props()?.folder ?? null;
    this.tab = TABS.some((t) => t.id === props()?.tab) ? props().tab : "changes";
    this.typing = false; this.width = 400; this.height = 600;
    this.handle = cx.focus_handle();
    // The Unified / Split choice of changes-split, once, so the Settings tab shows the same.
    const old = shared("changes-split.view");
    if (shared("git-client.view") == null && (old === "split" || old === "unified")) setShared("git-client.view", old);
    this.seenShow = shared("git-client.show")?.at;
    this.history = new History(this); this.changes = new Changes(this);
    this.branches = new Branches(this); this.stash = new Stash(this);
    this.changes.init(cx); this.branches.init(cx); this.stash.init(cx); this.history.init(cx);
    // git-client.<tab>, .commit, .fetch, .pull, .push, .refresh, .split, .unified, .toggle.
    cx.spawn(async (cx) => {
      for (;;) { const c = String(await nextCommand()); if (!kitOff()) this.command(c, cx); cx.notify(); }
    });
  }

  off() { return kitOff(); }

  // The repository of the panel: props.folder (a pane), else the focused pane's folder and machine.
  location() {
    if (this.folder) return { cwd: this.folder, on: null };
    const space = spaces().find((s) => s.active), f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
    return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
  }

  ctx() { return this.history.ctx; }
  onRead(cx) { this.changes.reload(cx); this.branches.reload(cx); this.stash.reload(cx); }
  setTab(tab, cx) {
    if (!TABS.some((t) => t.id === tab)) return;
    this.tab = tab;
    if (tab === "branches" && this.branches.dirty) this.branches.reload(cx, true);
    if (tab === "stash") this.stash.reload(cx);
    cx.notify();
  }

  command(c, cx) {
    if (TABS.some((t) => t.id === c)) this.setTab(c, cx);
    else if (c === "fetch") this.fetch(cx);
    else if (c === "pull") this.pull(cx);
    else if (c === "push") this.push(cx);
    else if (c === "refresh") this.history.refresh(cx);
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
      .child(this.iconButton("gc-refresh", "refresh", null, "Refresh", this.history.state !== "nofolder", (cx) => this.history.refresh(cx), t));
  }

  branchBar(t) {
    const h = this.history, info = h.branchInfo ?? {}, ctx = this.ctx(), remotes = ctx?.remotes ?? [];
    if (!h.root) return div();
    const where = h.current ?? (h.head ? `detached at ${h.head.slice(0, 8)}` : info.branch ?? "no commits");
    const busy = this.busy, canPull = Boolean(info.upstream) && !info.gone, canPush = remotes.length > 0 && Boolean(h.current);
    return h_flex().h(34).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
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

  render(cx) {
    if (kitOff()) return offView();
    this.history.sync(cx);
    const show = shared("git-client.show");
    if (show?.at && show.at !== this.seenShow) { this.seenShow = show.at; if (TABS.some((t) => t.id === show.tab)) this.tab = show.tab; }
    const t = theme();
    return v_flex().id("git-client").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(12.5).track_focus(this.handle)
      // In a dialog, a click in the panel gives it the keyboard (text fields stop their own mouse down):
      // else no part of the dialog has it after the click, and Esc does nothing.
      .on_mouse_down("left", () => { if (dialogId()) this.handle.focus(); })
      .on_size_change((size, cx) => {
        const zoom = Number(settings()?.zoom) > 0 ? Number(settings().zoom) : 1;
        const width = Math.round(size.width / zoom), height = Math.round(size.height / zoom);
        if (width !== this.width || height !== this.height) { this.width = width; this.height = height; cx.notify(); }
      })
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        const dialog = dialogId();
        // A text field has the keyboard: Esc leaves it. In a dialog, an empty field closes the dialog.
        if (this.typing) {
          if (!this.changes.message.trim() && dialog) closeOverlay(dialog);
          else { this.typing = false; this.handle.focus(); cx.notify(); }
        } else if (this.history.typing) {
          if (this.history.search.value().trim()) this.history.clearSearch(cx);
          else if (dialog) closeOverlay(dialog);
          else { this.history.typing = false; this.handle.focus(); }
          cx.notify();
        } else if (this.branches.typing) {
          if (this.branches.search.value()) { this.branches.search.set_value(""); this.branches.text = ""; }
          else if (dialog) closeOverlay(dialog);
          else { this.branches.typing = false; this.handle.focus(); }
          cx.notify();
        } else if (this.tab === "stash" && this.stash.sel) {
          this.stash.clear(); cx.notify();
        } else if (this.tab === "history" && this.history.escape(cx)) {
          // closed a diff, the details or the search
        } else if (dialog) closeOverlay(dialog);
        else return;
        cx.stop_propagation();
      })
      .child(this.tabBar(t))
      .child(this.branchBar(t))
      .when(this.tab === "changes", (e) => e.child(this.changes.render(t)))
      .when(this.tab === "history", (e) => e.child(this.history.render(cx)))
      .when(this.tab === "branches", (e) => e.child(this.branches.render(t)))
      .when(this.tab === "stash", (e) => e.child(this.stash.render(t)));
  }
}
