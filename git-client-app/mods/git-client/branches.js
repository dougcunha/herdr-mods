// The Branches tab: sections Local, Remote, Tags, Remotes and Worktrees. Right-click on a row
// opens its menu; left-clicking a selectable branch (or its checkbox) toggles its selection.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, openOverlay } from "herdr";
import { READ, menuFor, menuHeight } from "./git.js";
import { refsArgs, mergedRefsArgs, defaultBranchTarget, computeMergedMap, parseRefs, parseRemotes, parseWorktrees, samePath, ago } from "./refs.js";
import { perform, openDialog, atEvent } from "./act.js";
import { icon } from "./menu.js";
import {
  emptyBranchSelection,
  isBranchPicked,
  toggleBranch,
  selectBranches,
  pruneBranchSelection,
  selectedBranches,
} from "./selection.js";

const ROW = 26, TITLE = 30, SHOWN = 200;
const SECTIONS = [
  { id: "local", title: "Local" }, { id: "remote", title: "Remote" }, { id: "tags", title: "Tags" },
  { id: "remotes", title: "Remotes" }, { id: "worktrees", title: "Worktrees" },
];

export class Branches {
  constructor(host) { this.host = host; }

  init() {
    this.data = null; this.error = null; this.dirty = true; this.picked = emptyBranchSelection();
    this.worktreesLoaded = false; this.worktreesLoading = false;
    this.open = { local: true, remote: false, tags: false, remotes: true, worktrees: true };
    this.search = InputState.new({ placeholder: "Filter branches and tags" });
    this.search.on("change", (_e, cx) => { this.text = this.search.value().trim().toLowerCase(); cx.notify(); });
    this.search.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.text = "";
  }

  // After a read of the repository: read now when the tab shows (or in wide mode), else when it shows next.
  reload(cx, force = false, { loadWorktrees = false } = {}) {
    const h = this.host.history;
    if (h.context !== this.context) {
      this.context = h.context; this.data = null; this.error = null; this.picked = emptyBranchSelection();
      this.worktreesLoaded = false; this.worktreesLoading = false;
    }
    const visible = force || this.host.tab === "branches" || this.host.isWide?.();
    if (!visible) { this.dirty = true; return; }
    if (!h.root) return;
    this.dirty = false;
    const root = h.root, on = h.on, context = h.context, seq = this.seq = (this.seq ?? 0) + 1;
    const wantWorktrees = Boolean(loadWorktrees || (!this.host.isModal && this.open.worktrees) || (this.host.isModal && this.worktreesLoaded));
    const git = (args, cwd = root) => exec("git", [...READ, ...args], { cwd, on });
    cx.spawn(async (cx) => {
      try {
        const [refs, remotes, worktreesRes] = await Promise.all([
          git(refsArgs()),
          git(["remote", "-v"]),
          wantWorktrees ? git(["worktree", "list", "--porcelain"]) : null,
        ]);
        if (this.seq !== seq || this.host.history.context !== context) return;
        if (refs.code !== 0) throw new Error(refs.stderr.trim());
        const parsed = parseRefs(refs.stdout);
        const targetRefs = ["HEAD"];
        const def = defaultBranchTarget(parsed.local, parsed.remote);
        if (def) targetRefs.push(def);
        const mergedResults = await Promise.all(targetRefs.map(async (target) => {
          const r = await git(mergedRefsArgs(target)).catch(() => null);
          return { target, merged: r?.code === 0 ? new Set(r.stdout.split(/\r?\n/).filter(Boolean)) : new Set() };
        }));
        if (this.seq !== seq || this.host.history.context !== context) return;
        const mergedMap = computeMergedMap(parsed.local, h.current, mergedResults);
        for (const b of parsed.local) {
          const holders = mergedMap.get(b.name);
          if (holders) b.mergedInto = holders;
        }
        const worktrees = worktreesRes ? parseWorktrees(worktreesRes.stdout) : (this.data?.worktrees ?? []);
        if (worktreesRes) {
          await Promise.all(worktrees.slice(0, 20).map(async (w) => {
            if (w.bare || w.prunable) return;
            const r = await git(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], w.path).catch(() => null);
            w.changes = r?.code === 0 ? r.stdout.split("\0").filter(Boolean).length : null;
          }));
          if (this.seq !== seq) return;
          this.worktreesLoaded = true;
        }
        const data = { ...parsed, remotes: parseRemotes(remotes.stdout), worktrees };
        this.data = data; this.error = null;
        this.picked = pruneBranchSelection(this.picked, data);
      } catch (e) { if (this.seq === seq) this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  ensureWorktrees(cx) {
    const h = this.host.history;
    if (this.worktreesLoaded || this.worktreesLoading || !h.root) return;
    const root = h.root, on = h.on, context = h.context;
    this.worktreesLoading = true;
    cx.notify();
    const git = (args, cwd = root) => exec("git", [...READ, ...args], { cwd, on });
    cx.spawn(async (cx) => {
      try {
        const res = await git(["worktree", "list", "--porcelain"]);
        if (this.host.history.context !== context) return;
        if (res.code === 0) {
          const worktrees = parseWorktrees(res.stdout);
          await Promise.all(worktrees.slice(0, 20).map(async (w) => {
            if (w.bare || w.prunable) return;
            const r = await git(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], w.path).catch(() => null);
            w.changes = r?.code === 0 ? r.stdout.split("\0").filter(Boolean).length : null;
          }));
          if (this.host.history.context !== context) return;
          this.data = { ...(this.data ?? { local: [], remote: [], tags: [], remotes: [] }), worktrees };
          this.worktreesLoaded = true;
        }
      } finally {
        if (this.host.history.context === context) this.worktreesLoading = false;
        cx.notify();
      }
    });
  }

  pendingSummary() {
    let aheadBranches = 0, behindBranches = 0, totalAhead = 0, totalBehind = 0, goneBranches = 0, localOnlyBranches = 0;
    for (const b of this.data?.local ?? []) {
      if (b.ahead > 0) { aheadBranches++; totalAhead += b.ahead; }
      if (b.behind > 0) { behindBranches++; totalBehind += b.behind; }
      if (b.gone) goneBranches++;
      if (!b.upstream && !b.gone) localOnlyBranches++;
    }
    return { aheadBranches, behindBranches, totalAhead, totalBehind, goneBranches, localOnlyBranches };
  }

  ctx() { return this.host.ctx(); }

  visible(kind) {
    const match = (s) => !this.text || s.toLowerCase().includes(this.text);
    if (kind === "local") return (this.data?.local ?? []).filter((b) => !b.current && match(b.name));
    if (kind === "remote") return (this.data?.remote ?? []).filter((b) => match(b.name));
    return [];
  }

  toggleCheck(kind, name, e, cx) {
    this.picked = toggleBranch(this.picked, { kind, name, list: this.visible(kind), modifiers: e?.modifiers });
    cx.notify();
  }

  selectAllKind(kind, cx) {
    if (kind !== "local" && kind !== "remote") return;
    this.picked = selectBranches(this.picked, kind, this.visible(kind));
    cx.notify();
  }

  selectAllCurrent(cx) {
    const hasL = this.picked.local.size > 0, hasR = this.picked.remote.size > 0;
    const visL = this.visible("local"), visR = this.visible("remote");
    const kind = hasL && !hasR ? "local"
      : hasR && !hasL ? "remote"
      : this.open.local && visL.length ? "local"
      : this.open.remote && visR.length ? "remote"
      : visL.length ? "local" : visR.length ? "remote" : null;
    if (kind) this.selectAllKind(kind, cx);
  }

  clearSelection(cx) {
    if (this.picked.local.size + this.picked.remote.size === 0) return false;
    this.picked = emptyBranchSelection();
    cx.notify();
    return true;
  }

  escape(cx) { return this.clearSelection(cx); }

  deleteSelected() {
    if (!this.data) return;
    const sel = selectedBranches(this.picked, this.data);
    if (sel.local.length + sel.remote.length === 0) return;
    this.dialog({
      type: "deleteBranches",
      local: sel.local.map((b) => b.name),
      remote: sel.remote.map((b) => ({ name: b.name, remote: b.remote, branch: b.branch })),
    });
  }

  menu(target, e) {
    const ctx = this.ctx();
    if (!ctx) return;
    let menuTarget = target;
    if ((target.kind === "branch" || target.kind === "remote") && this.data) {
      this.picked = pruneBranchSelection(this.picked, this.data);
      const sel = selectedBranches(this.picked, this.data);
      const kind = target.kind === "branch" ? "local" : "remote";
      if (sel.local.length + sel.remote.length > 1 && isBranchPicked(this.picked, kind, target.name)) {
        menuTarget = {
          kind: "branches",
          local: sel.local.map((b) => b.name),
          remote: sel.remote.map((b) => ({ name: b.name, remote: b.remote, branch: b.branch })),
        };
      }
    }
    const items = menuFor(menuTarget, ctx);
    openOverlay({ mod: "git-client", kind: "popup", at: atEvent(e), width: 268, height: menuHeight(items), props: { role: "menu", target: menuTarget, ctx } });
  }

  dialog(action) { const ctx = this.ctx(); if (ctx) openDialog(action, ctx); }

  prune(cx) {
    const ctx = this.ctx();
    if (ctx) cx.spawn(async () => { await perform({ type: "pruneWorktrees" }, {}, ctx); });
  }

  // ---- drawing

  smallButton(id, glyph, tip, action, t) {
    return h_flex().id(id).size(22).flex_none().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(svg(icon(glyph)).size(13));
  }

  header(s, count, t, actions = []) {
    const open = this.open[s.id];
    return h_flex().id(`gb-h-${s.id}`).h(TITLE).flex_none().pl(8).pr(6).gap(6).items_center().cursor_pointer().text_size(11).text_color(t.dim)
      .hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { this.open = { ...this.open, [s.id]: !open }; cx.notify(); })
      .child(div().w(10).flex_none().child(open ? "▾" : "▸"))
      .child(div().font_semibold().child(s.title.toUpperCase())).child(div().child(String(count))).child(div().flex_1())
      .children(actions);
  }

  row(id, glyph, glyphColor, name, detail, right, target, t, extra = null, pick = null) {
    const checked = Boolean(pick?.selectable && isBranchPicked(this.picked, pick.kind, pick.name));
    return h_flex().id(id).h(ROW).flex_none().pl(pick ? 10 : 24).pr(10).gap(pick ? 6 : 8).items_center().rounded(6).cursor_pointer()
      .when(checked, (e) => e.bg(t.accent + "22"))
      .hover((s) => s.bg(t.hover))
      .on_click((e, cx) => {
        if (pick?.selectable) this.toggleCheck(pick.kind, pick.name, e, cx);
      })
      .on_mouse_down("right", (e, cx) => { cx.stop_propagation(); this.menu(target, e); })
      .when(Boolean(pick), (e) => pick.selectable
        ? e.child(h_flex().id(`gb-c-${pick.kind}-${pick.name}`).size(16).flex_none().items_center().justify_center().cursor_pointer()
          .on_click((ev, cx) => { cx.stop_propagation(); this.toggleCheck(pick.kind, pick.name, ev, cx); })
          .child(div().size(13).rounded(3).border_1().border_color(checked ? t.accent : t.input)
            .when(checked, (el) => el.bg(t.accent))
            .flex().items_center().justify_center()
            .when(checked, (el) => el.child(svg(icon("check")).size(9).text_color(t.accent_foreground)))))
        : e.child(div().size(16).flex_none()))
      .child(svg(icon(glyph)).size(12).flex_none().text_color(glyphColor))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().min_w(0).truncate().when(!detail, (e) => e.flex_1()).child(name))
        .when(Boolean(detail), (e) => e.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(detail))))
      .when(Boolean(extra), (e) => e.child(extra))
      .when(Boolean(right), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(right)));
  }

  selectionBar(t, sel, visLocal, visRemote) {
    const l = sel.local.length, r = sel.remote.length, n = l + r;
    const onlyL = l > 0 && r === 0, onlyR = r > 0 && l === 0;
    const scope = onlyL ? "local" : onlyR ? "remote" : `${l} local · ${r} remote`;
    const canAll = (onlyL && l < visLocal.length) || (onlyR && r < visRemote.length);
    const linkBtn = (id, label, onClick) => div().id(id).px(5).py(2).rounded(4).cursor_pointer()
      .text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(label);
    return h_flex().id("gb-sel-bar").h(32).flex_none().px(10).gap(6).items_center()
      .bg(t.accent + "14").border_b(1).border_color(t.border)
      .child(div().flex_none().text_size(11.5).font_semibold().text_color(t.foreground).child(`${n} selected`))
      .child(div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(scope))
      .when(canAll, (el) => el.child(linkBtn("gb-sel-all", "All", (cx) => this.selectAllKind(onlyL ? "local" : "remote", cx))))
      .child(linkBtn("gb-sel-clear", "Clear", (cx) => this.clearSelection(cx)))
      .child(div().flex_1())
      .child(h_flex().id("gb-sel-delete").h(22).px(8).gap(4).flex_none().items_center().rounded(5).cursor_pointer()
        .text_size(11).font_medium().bg(t.raised).border_1().border_color(t.ansi1 + "55").text_color(t.ansi1)
        .hover((s) => s.opacity(0.88))
        .on_click((_e, cx) => { cx.stop_propagation(); this.deleteSelected(); })
        .child(svg(icon("trash")).size(11).flex_none())
        .child("Delete"));
  }

  // The ahead/behind count and, for a branch that another branch already holds, a "merged" badge:
  // its commits are not alone, so deleting it loses nothing.
  badges(b, i, track, t) {
    const into = b.mergedInto ?? [];
    if (!track && !into.length) return null;
    return h_flex().flex_none().gap(8).items_center()
      .when(Boolean(track), (e) => e.child(div().flex_none().text_size(11).text_color(b.gone || b.behind ? t.ansi1 : t.ansi2).child(track)))
      .when(into.length > 0, (e) => e.child(h_flex().id(`gb-merged-${i}`).flex_none().gap(3).items_center().px(4).rounded(4).text_size(10.5)
        .bg(t.ansi2 + "26").text_color(t.ansi2)
        .tooltip(`Merged into ${into.slice(0, 5).join(", ")}${into.length > 5 ? ` and ${into.length - 5} more` : ""}. Its commits are in another branch, so you can delete it without losing anything.`)
        .child(svg(icon("check")).size(10).flex_none())
        .child("merged")));
  }

  more(n, t) { return n > SHOWN ? [div().h(ROW).flex_none().pl(24).flex().items_center().text_size(11).text_color(t.dim).child(`and ${n - SHOWN} more: filter to find them`)] : []; }

  render(t) {
    const h = this.host.history, d = this.data;
    if (!h.root) return v_flex().flex_1().child(div().p(12).text_color(t.dim).child(h.state === "norepo" ? "Not a git repository" : "Loading…"));
    const match = (s) => !this.text || s.toLowerCase().includes(this.text);
    const local = (d?.local ?? []).filter((b) => match(b.name)), remote = (d?.remote ?? []).filter((b) => match(b.name)), tags = (d?.tags ?? []).filter((b) => match(b.name));
    const remotes = d?.remotes ?? [], worktrees = d?.worktrees ?? [], open = this.open;
    const sel = d ? selectedBranches(this.picked, d) : { local: [], remote: [] };
    const visLocal = local.filter((b) => !b.current);
    const track = (b) => [b.ahead ? `↑${b.ahead}` : "", b.behind ? `↓${b.behind}` : "", b.gone ? "gone" : ""].filter(Boolean).join(" ");
    let lastRemote = null;
    return v_flex().id("gc-branches").flex_1().min_h(0).w_full()
      .child(h_flex().h(36).flex_none().px(10).items_center().border_b(1).border_color(t.border)
        .child(h_flex().id("gb-search").flex_1().min_w(0).h(26).px(8).gap(6).items_center().rounded(7).border_1()
          .border_color(this.typing ? t.accent : t.border).bg(t.background).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(svg(icon("search")).size(12).flex_none().text_color(t.dim))
          .child(Input.new(this.search).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground))))
      .when(Boolean(this.error), (e) => e.child(div().p(10).text_size(12).text_color(t.ansi1).child(this.error)))
      .when(!d && !this.error, (e) => e.child(div().p(12).text_color(t.dim).child("Loading branches…")))
      .when(Boolean(d) && sel.local.length + sel.remote.length > 0, (e) => e.child(this.selectionBar(t, sel, visLocal, remote)))
      .when(Boolean(d), (e) => e.child(v_flex().id("gb-list").flex_1().min_h(0).overflow_y_scrollbar().px(4).py(4)
        // Local
        .child(this.header(SECTIONS[0], local.length, t, [this.smallButton("gb-new-branch", "plus", "New branch from HEAD", () => this.dialog({ type: "newBranch", base: "HEAD", what: h.current ?? "HEAD" }), t)]))
        .when(open.local, (el) => el.children(local.slice(0, SHOWN).map((b, i) => this.row(`gb-l-${i}`, b.current ? "check" : "branch", b.current ? t.accent : t.muted,
          b.name, b.upstream ? `→ ${b.upstream}` : "", ago(b.time), { kind: "branch", name: b.name, upstream: b.upstream, gone: b.gone }, t,
          this.badges(b, i, track(b), t), { kind: "local", name: b.name, selectable: !b.current })
          .when(b.current, (r) => r.font_semibold()))).children(this.more(local.length, t)))
        // Remote, grouped by remote
        .child(this.header(SECTIONS[1], remote.length, t))
        .when(open.remote, (el) => el.children(remote.slice(0, SHOWN).flatMap((b, i) => {
          const rows = [];
          if (b.remote !== lastRemote) { lastRemote = b.remote; rows.push(div().h(22).flex_none().pl(24).flex().items_center().text_size(10.5).text_color(t.dim).child(b.remote)); }
          rows.push(this.row(`gb-r-${i}`, "cloud", t.muted, b.branch, "", ago(b.time), { kind: "remote", name: b.name }, t, null, { kind: "remote", name: b.name, selectable: true }));
          return rows;
        })).children(this.more(remote.length, t)))
        // Tags
        .child(this.header(SECTIONS[2], tags.length, t, [this.smallButton("gb-new-tag", "plus", "New tag at HEAD", () => this.dialog({ type: "newTag", base: "HEAD", what: h.current ?? "HEAD" }), t)]))
        .when(open.tags, (el) => el.children(tags.slice(0, SHOWN).map((b, i) => this.row(`gb-t-${i}`, "tag", t.ansi3, b.name, b.subject, ago(b.time), { kind: "tag", name: b.name }, t)))
          .children(this.more(tags.length, t)))
        // Remotes
        .child(this.header(SECTIONS[3], remotes.length, t, [this.smallButton("gb-add-remote", "plus", "Add remote", () => this.dialog({ type: "addRemote" }), t)]))
        .when(open.remotes, (el) => el.children(remotes.map((r, i) => this.row(`gb-rm-${i}`, "cloud", t.accent, r.name, r.url, "", { kind: "remoteConfig", remote: r }, t))))
        // Worktrees
        .child(this.header(SECTIONS[4], worktrees.length, t, [
          this.smallButton("gb-prune", "x", "Prune: forget the worktrees whose folder is gone", (cx) => this.prune(cx), t),
          this.smallButton("gb-add-worktree", "plus", "New worktree", () => this.dialog({
            type: "addWorktree",
            local: d?.local ?? null,
            remote: d?.remote ?? null,
            worktrees: d?.worktrees ?? null,
          }), t)]))
        .when(open.worktrees, (el) => el.children(worktrees.map((w, i) => {
          const here = samePath(w.path, h.root);
          const badges = h_flex().flex_none().gap(4).items_center().text_size(10.5)
            .when(w.changes > 0, (e) => e.child(h_flex().gap(3).items_center().text_color(t.blocked).child(div().size(6).rounded(3).bg(t.blocked)).child(String(w.changes))))
            .when(w.main, (e) => e.child(div().px(4).rounded(4).border_1().border_color(t.border).text_color(t.muted).child("main")))
            .when(here, (e) => e.child(div().px(4).rounded(4).bg(t.accent + "26").text_color(t.accent).child("here")))
            .when(w.locked, (e) => e.child(div().px(4).rounded(4).border_1().border_color(t.border).text_color(t.muted).child("locked")))
            .when(w.prunable, (e) => e.child(div().px(4).rounded(4).text_color(t.ansi1).child("gone")));
          return this.row(`gb-w-${i}`, "folder", here ? t.accent : t.muted, w.branch ?? (w.bare ? "bare" : "detached"), w.path, "", { kind: "worktree", worktree: w, current: here }, t, badges);
        })))));
  }
}
