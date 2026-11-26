// Left accordion sidebar for the wide/modal Git client: pinned Changes item, Local & Remote
// branches (with pending ↑/↓/gone/local/merged badges and quick hover actions), Stash,
// Submodules (with inline branch switch & pull actions), and collapsible Tags, Remotes, Worktrees.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec } from "herdr";
import { splitUpstream } from "./git.js";
import { ago, samePath } from "./refs.js";
import { perform, openDialog } from "./act.js";
import { icon } from "./menu.js";
import { isBranchPicked, selectedBranches } from "./selection.js";

const ROW = 26, SUB_ROW = 40, TITLE = 28, SHOWN = 200;

export class Sidebar {
  constructor(host) { this.host = host; }

  init() {
    this.open = { local: true, remote: true, stash: true, submodules: true, tags: false, remotes: false, worktrees: false };
    this.hover = null;
    this.typing = false;
    this.text = "";
    this.search = InputState.new({ placeholder: "Filter branches, stashes, submodules…" });
    this.search.on("change", (_e, cx) => { this.text = this.search.value().trim().toLowerCase(); cx.notify(); });
    this.search.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
  }

  match(s) { return !this.text || String(s ?? "").toLowerCase().includes(this.text); }

  clearSearch(cx) {
    this.search.set_value("");
    this.text = "";
    cx.notify();
  }

  smallButton(id, glyph, tip, action, t, accent = false) {
    return h_flex().id(id).size(20).flex_none().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(accent ? t.accent : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(svg(icon(glyph)).size(12));
  }

  pill(text, color, bg = null, tip = null) {
    const el = div().flex_none().px(4).rounded(4).text_size(10).text_color(color)
      .when(Boolean(bg), (e) => e.bg(bg))
      .when(!bg, (e) => e.border_1().border_color(color + "44"))
      .child(text);
    return tip ? el.tooltip(tip) : el;
  }

  changesRow(t, cx) {
    const files = this.host.history.files ?? [];
    const conflicts = files.filter((f) => f.conflict).length;
    const staged = files.filter((f) => f.staged).length;
    const unstaged = files.filter((f) => f.unstaged).length;
    const active = this.host.inspector === "changes";
    return h_flex().id("gsb-changes-row").h(34).flex_none().mx(6).mt(6).mb(4).px(8).gap(8).items_center().rounded(7).cursor_pointer()
      .border_1().border_color(active ? t.accent : conflicts ? t.ansi1 + "66" : t.border)
      .bg(active ? t.selected : files.length ? t.raised : t.background)
      .hover((s) => s.bg(active ? t.selected : t.hover))
      .on_click((_e, cx) => this.host.openInspector("changes", cx))
      .child(svg(icon("changes")).size(14).flex_none().text_color(conflicts ? t.ansi1 : files.length ? t.accent : t.ansi2))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().child("Changes"))
      .when(files.length === 0, (e) => e.child(this.pill("Clean", t.ansi2, t.ansi2 + "22")))
      .when(conflicts > 0, (e) => e.child(this.pill(`${conflicts}!`, t.ansi1, t.ansi1 + "22", `${conflicts} conflict${conflicts === 1 ? "" : "s"}`)))
      .when(staged > 0, (e) => e.child(this.pill(`+${staged}`, t.ansi2, t.ansi2 + "22", `${staged} staged`)))
      .when(unstaged > 0, (e) => e.child(this.pill(`${unstaged}`, t.blocked, t.blocked + "22", `${unstaged} unstaged`)));
  }

  sectionHeader(id, title, count, t, summary = null, actions = [], onToggle = null) {
    const open = Boolean(this.open[id]);
    return h_flex().id(`gsb-h-${id}`).h(TITLE).flex_none().pl(8).pr(6).gap(5).items_center().cursor_pointer()
      .text_size(11).text_color(t.dim).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        const next = !open;
        this.open = { ...this.open, [id]: next };
        onToggle?.(next, cx);
        cx.notify();
      })
      .child(div().w(10).flex_none().child(open ? "▾" : "▸"))
      .child(div().font_semibold().child(title.toUpperCase()))
      .child(div().flex_none().child(String(count)))
      .when(Boolean(summary), (e) => e.child(summary))
      .child(div().flex_1())
      .children(actions);
  }

  localSummary(branches, t) {
    const s = branches.pendingSummary();
    if (!s.totalAhead && !s.totalBehind && !s.goneBranches && !s.localOnlyBranches) return null;
    return h_flex().flex_none().gap(4).items_center()
      .when(s.totalAhead > 0, (e) => e.child(this.pill(`↑${s.totalAhead}`, t.ansi2, t.ansi2 + "20", `${s.aheadBranches} branch(es) ahead`)))
      .when(s.totalBehind > 0, (e) => e.child(this.pill(`↓${s.totalBehind}`, t.ansi1, t.ansi1 + "20", `${s.behindBranches} branch(es) behind`)))
      .when(s.goneBranches > 0, (e) => e.child(this.pill(`${s.goneBranches} gone`, t.ansi1, t.ansi1 + "20")))
      .when(s.localOnlyBranches > 0, (e) => e.child(this.pill(`${s.localOnlyBranches} local`, t.muted, null, `${s.localOnlyBranches} branch(es) without upstream`)));
  }

  submoduleSummary(subs, t) {
    const s = subs.pendingSummary();
    if (!s.dirty && !s.outOfSync && !s.conflict && !s.uninitialized && !s.ahead && !s.behind) return null;
    return h_flex().flex_none().gap(4).items_center()
      .when(s.conflict > 0, (e) => e.child(this.pill(`${s.conflict}!`, t.ansi1, t.ansi1 + "20", "Submodule conflict")))
      .when(s.dirty > 0, (e) => e.child(this.pill(`${s.dirty} dirty`, t.blocked, t.blocked + "20", `${s.dirty} submodule(s) with uncommitted changes`)))
      .when(s.outOfSync > 0, (e) => e.child(this.pill(`${s.outOfSync} sync`, t.blocked, t.blocked + "20", `${s.outOfSync} submodule(s) at another commit than recorded`)))
      .when(s.ahead > 0, (e) => e.child(this.pill(`↑${s.ahead}`, t.ansi2, t.ansi2 + "20")))
      .when(s.behind > 0, (e) => e.child(this.pill(`↓${s.behind}`, t.ansi1, t.ansi1 + "20")));
  }

  localRow(b, i, t, ctx, branches) {
    const h = this.host.history;
    const key = `local:${b.name}`;
    const hovered = this.hover === key;
    const checked = !b.current && isBranchPicked(branches.picked, "local", b.name);
    const highlighted = h.highlightHash === b.hash;
    const up = b.upstream && !b.gone && ctx?.remotes?.length ? splitUpstream(b.upstream, ctx.remotes) : null;
    const canPull = Boolean(b.current && up && b.behind > 0);
    const canFF = Boolean(!b.current && up && b.behind > 0);
    const canPush = Boolean(ctx?.remotes?.length && (b.ahead > 0 || (!b.upstream && !b.gone)));
    const tip = [b.name, b.upstream ? `→ ${b.upstream}` : "local only (no upstream)", b.gone ? "upstream gone" : null].filter(Boolean).join(" · ");

    return h_flex().id(`gsb-l-${i}`).h(ROW).flex_none().pl(8).pr(6).gap(5).items_center().rounded(6).cursor_pointer()
      .when(checked, (e) => e.bg(t.accent + "22"))
      .when(!checked && highlighted, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .tooltip(tip)
      .on_hover((on, cx) => { const next = on ? key : this.hover === key ? null : this.hover; if (next !== this.hover) { this.hover = next; cx.notify(); } })
      .on_click((e, cx) => {
        if (!b.current && (e?.modifiers?.control || e?.modifiers?.platform || e?.modifiers?.shift)) {
          branches.toggleCheck("local", b.name, e, cx);
          return;
        }
        if (!b.current && e?.click_count >= 2 && ctx) {
          cx.spawn(async () => { await perform({ type: "checkout", name: b.name }, {}, ctx); });
          return;
        }
        h.scrollToCommit(b.hash, b.name, cx);
      })
      .on_mouse_down("right", (e, cx) => { cx.stop_propagation(); branches.menu({ kind: "branch", name: b.name, upstream: b.upstream, gone: b.gone }, e); })
      .child(!b.current
        ? h_flex().id(`gsb-lc-${i}`).size(15).flex_none().items_center().justify_center().cursor_pointer()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((ev, cx) => { cx.stop_propagation(); branches.toggleCheck("local", b.name, ev, cx); })
          .child(div().size(12).rounded(3).border_1().border_color(checked ? t.accent : t.input)
            .when(checked, (el) => el.bg(t.accent)).flex().items_center().justify_center()
            .when(checked, (el) => el.child(svg(icon("check")).size(8).text_color(t.accent_foreground))))
        : div().size(15).flex_none())
      .child(svg(icon(b.current ? "check" : "branch")).size(12).flex_none().text_color(b.current ? t.accent : t.muted))
      .child(div().flex_1().min_w(0).truncate().when(b.current, (e) => e.font_semibold().text_color(t.foreground)).child(b.name))
      .when(b.ahead > 0, (e) => e.child(this.pill(`↑${b.ahead}`, t.ansi2, t.ansi2 + "1c")))
      .when(b.behind > 0, (e) => e.child(this.pill(`↓${b.behind}`, t.ansi1, t.ansi1 + "1c")))
      .when(b.gone, (e) => e.child(this.pill("gone", t.ansi1, t.ansi1 + "1c")))
      .when(!b.upstream && !b.gone, (e) => e.child(this.pill("local", t.dim)))
      .when((b.mergedInto?.length ?? 0) > 0, (e) => e.child(this.pill("merged", t.ansi2, t.ansi2 + "1c", `Merged into ${b.mergedInto.slice(0, 4).join(", ")}`)))
      .when(hovered && (canPull || canFF || canPush), (e) => e.child(h_flex().flex_none().gap(2)
        .when(canPull, (el) => el.child(this.smallButton(`gsb-lp-${i}`, "pull", `Pull from ${b.upstream}`, (cx) => this.host.pull(cx), t, true)))
        .when(canFF, (el) => el.child(this.smallButton(`gsb-lf-${i}`, "cloud-down", `Fast-forward ${b.name} from ${b.upstream}`, (cx) => {
          cx.spawn(async () => { await perform({ type: "fetchBranch", name: b.name, ...up }, {}, ctx); });
        }, t, true)))
        .when(canPush, (el) => el.child(this.smallButton(`gsb-lps-${i}`, "push-line", b.upstream ? `Push ${b.name}` : `Publish ${b.name}`, (cx) => {
          if (b.current) this.host.push(cx);
          else openDialog({ type: "push", name: b.name }, ctx);
        }, t, true)))))
      .when(!hovered, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child(ago(b.time))));
  }

  remoteRow(b, i, t, ctx, branches) {
    const h = this.host.history;
    const checked = isBranchPicked(branches.picked, "remote", b.name);
    const highlighted = h.highlightHash === b.hash;
    return h_flex().id(`gsb-r-${i}`).h(ROW).flex_none().pl(8).pr(6).gap(5).items_center().rounded(6).cursor_pointer()
      .when(checked, (e) => e.bg(t.accent + "22"))
      .when(!checked && highlighted, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((e, cx) => {
        if (e?.modifiers?.control || e?.modifiers?.platform || e?.modifiers?.shift) {
          branches.toggleCheck("remote", b.name, e, cx);
          return;
        }
        if (e?.click_count >= 2 && ctx) {
          const localExists = (branches.data?.local ?? []).some((l) => l.name === b.branch);
          if (localExists) cx.spawn(async () => { await perform({ type: "checkout", name: b.branch }, {}, ctx); });
          else openDialog({ type: "checkoutRemote", name: b.name, remote: b.remote, branch: b.branch }, ctx);
          return;
        }
        h.scrollToCommit(b.hash, b.name, cx);
      })
      .on_mouse_down("right", (e, cx) => { cx.stop_propagation(); branches.menu({ kind: "remote", name: b.name }, e); })
      .child(h_flex().id(`gsb-rc-${i}`).size(15).flex_none().items_center().justify_center().cursor_pointer()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((ev, cx) => { cx.stop_propagation(); branches.toggleCheck("remote", b.name, ev, cx); })
        .child(div().size(12).rounded(3).border_1().border_color(checked ? t.accent : t.input)
          .when(checked, (el) => el.bg(t.accent)).flex().items_center().justify_center()
          .when(checked, (el) => el.child(svg(icon("check")).size(8).text_color(t.accent_foreground)))))
      .child(svg(icon("cloud")).size(12).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(b.branch))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(ago(b.time)));
  }

  submoduleRow(s, i, t, subs) {
    const key = `sub:${s.path}`, hovered = this.hover === key;
    const ready = s.state !== "uninitialized", modified = (s.changes ?? 0) > 0;
    const color = { ok: t.ansi2, "out of sync": t.blocked, uninitialized: t.dim, conflict: t.ansi1 };
    const dotColor = modified && s.state === "ok" ? t.blocked : (color[s.state] ?? t.dim);
    const branchText = s.currentBranch ? s.currentBranch : s.detached ? "detached" : s.branch ? `(${s.branch})` : "uninitialized";
    const metaText = [branchText, s.hash.slice(0, 7)].filter(Boolean).join(" · ");

    return h_flex().id(`gsb-sm-${i}`).h(SUB_ROW).flex_none().pl(10).pr(6).gap(7).items_center().rounded(6).cursor_pointer()
      .hover((st) => st.bg(t.hover))
      .tooltip(ready ? `Click to open ${s.path}. Right-click for actions.` : `Uninitialized submodule (${s.path}). Click or right-click to initialize.`)
      .on_hover((on, cx) => { const next = on ? key : this.hover === key ? null : this.hover; if (next !== this.hover) { this.hover = next; cx.notify(); } })
      .on_mouse_down("left", (ev) => { this.press = ev; })
      .on_click((_e, cx) => {
        if (ready) this.host.enterSubmodule(s, cx);
        else subs.menu(s, this.press);
      })
      .on_mouse_down("right", (ev, cx) => { cx.stop_propagation(); subs.menu(s, ev); })
      .child(div().size(8).flex_none().rounded(4).bg(dotColor))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(s.path)))
        .child(div().truncate().text_size(10.5).text_color(s.detached ? t.blocked : t.dim).child(metaText)))
      .when((s.ahead ?? 0) > 0, (e) => e.child(this.pill(`↑${s.ahead}`, t.ansi2, t.ansi2 + "1c")))
      .when((s.behind ?? 0) > 0, (e) => e.child(this.pill(`↓${s.behind}`, t.ansi1, t.ansi1 + "1c")))
      .when(modified, (e) => e.child(this.pill(`${s.changes}`, t.blocked, t.blocked + "1c", `${s.changes} changed file(s)`)))
      .when(s.state === "out of sync", (e) => e.child(this.pill("sync", t.blocked, t.blocked + "1c", "Submodule HEAD differs from recorded commit")))
      .when(s.state === "conflict" || s.state === "uninitialized", (e) => e.child(this.pill(s.state === "conflict" ? "conflict" : "uninit", color[s.state])))
      .when(hovered && ready && s.state !== "conflict", (e) => e.child(h_flex().flex_none().gap(2)
        .child(this.smallButton(`gsb-smp-${i}`, "pull", "Pull / update current branch", (cx) => subs.run({
          type: "submodulePull", path: s.path, name: s.path, branch: s.currentBranch ?? null, upstream: s.upstream ?? null,
        }, cx), t, true))
        .child(this.smallButton(`gsb-smb-${i}`, "branch", "Switch branch…", (cx) => subs.run({
          type: "submoduleChooseBranch", path: s.path, name: s.path, currentBranch: s.currentBranch ?? null, configuredBranch: s.branch ?? null, nested: Boolean(s.nested),
        }, cx), t, true))));
  }

  render(t, cx) {
    const h = this.host.history, branches = this.host.branches, stash = this.host.stash, subs = this.host.submodules;
    const ctx = this.host.ctx(), d = branches.data;
    const local = (d?.local ?? []).filter((b) => this.match(b.name));
    const remote = (d?.remote ?? []).filter((b) => this.match(b.name));
    const tags = (d?.tags ?? []).filter((b) => this.match(b.name));
    const remotes = (d?.remotes ?? []).filter((r) => this.match(r.name) || this.match(r.url));
    const worktrees = (d?.worktrees ?? []).filter((w) => this.match(w.branch) || this.match(w.path));
    const stashes = (stash.list ?? []).filter((s) => this.match(s.message) || this.match(s.branch) || this.match(s.ref));
    const subList = (subs.list ?? []).filter((s) => this.match(s.path) || this.match(s.currentBranch) || this.match(s.branch));

    const sel = d ? selectedBranches(branches.picked, d) : { local: [], remote: [] };
    const visLocal = local.filter((b) => !b.current);
    let lastRemote = null;

    return v_flex().id("gc-sidebar").size_full().min_h(0).bg(t.chrome).border_r(1).border_color(t.border)
      // Filter input
      .child(h_flex().h(36).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
        .child(h_flex().id("gsb-search").flex_1().min_w(0).h(25).px(8).gap(6).items_center().rounded(6).border_1()
          .border_color(this.typing ? t.accent : t.border).bg(t.background).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(svg(icon("search")).size(12).flex_none().text_color(t.dim))
          .child(Input.new(this.search).flex_1().min_w(0).h_full().text_size(11.5).text_color(t.foreground))
          .when(Boolean(this.text), (e) => e.child(this.smallButton("gsb-search-clear", "x", "Clear filter", (cx) => this.clearSearch(cx), t)))))
      // Pinned Changes item
      .child(this.changesRow(t, cx))
      .when(sel.local.length + sel.remote.length > 0, (e) => e.child(branches.selectionBar(t, sel, visLocal, remote)))
      // Scrollable accordion sections
      .child(v_flex().id("gsb-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(4).pb(8)
        // Local branches
        .child(this.sectionHeader("local", "Local", local.length, t, this.localSummary(branches, t), [
          this.smallButton("gsb-new-branch", "plus", "New branch from HEAD", () => branches.dialog({ type: "newBranch", base: "HEAD", what: h.current ?? "HEAD" }), t),
        ]))
        .when(this.open.local, (el) => el
          .when(!d && !branches.error, (e) => e.child(div().px(14).py(4).text_size(11).text_color(t.dim).child("Loading…")))
          .children(local.slice(0, SHOWN).map((b, i) => this.localRow(b, i, t, ctx, branches)))
          .children(branches.more(local.length, t)))
        // Remote branches
        .child(this.sectionHeader("remote", "Remote", remote.length, t))
        .when(this.open.remote, (el) => el
          .children(remote.slice(0, SHOWN).flatMap((b, i) => {
            const rows = [];
            if (b.remote !== lastRemote) {
              lastRemote = b.remote;
              rows.push(div().h(20).flex_none().pl(22).flex().items_center().text_size(10.5).text_color(t.dim).child(b.remote));
            }
            rows.push(this.remoteRow(b, i, t, ctx, branches));
            return rows;
          }))
          .children(branches.more(remote.length, t)))
        // Stashes
        .child(this.sectionHeader("stash", "Stash", stashes.length, t, null,
          (h.files?.length ?? 0) > 0 ? [this.smallButton("gsb-new-stash", "plus", "New stash…", (cx) => stash.run({ type: "stash" }, cx), t)] : []))
        .when(this.open.stash, (el) => el
          .when(stashes.length === 0, (e) => e.child(div().px(22).py(4).text_size(11).text_color(t.dim).child("No stashes")))
          .children(stashes.map((s) => {
            const on = this.host.inspector === "stash" && stash.sel?.hash === s.hash;
            return h_flex().id(`gsb-st-${s.hash}`).h(ROW).flex_none().pl(14).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
              .when(on, (r) => r.bg(t.selected)).hover((st) => st.bg(t.hover))
              .on_click((_e, cx) => { stash.pick(s, cx, { keepSelected: true }); this.host.openInspector("stash", cx); })
              .on_mouse_down("right", (e, cx) => { cx.stop_propagation(); stash.menu(s, e); })
              .child(svg(icon("stash")).size(12).flex_none().text_color(on ? t.accent : t.muted))
              .child(div().flex_1().min_w(0).truncate().text_size(12).child(s.message || "(no message)"))
              .child(div().flex_none().text_size(10.5).text_color(t.dim).child(ago(s.time)));
          })))
        // Submodules
        .child(this.sectionHeader("submodules", "Submodules", subList.length, t, this.submoduleSummary(subs, t), [
          ...(subList.length > 0 ? [this.smallButton("gsb-sub-update", "fetch", "Update all submodules", (cx) => subs.run({ type: "submoduleUpdate" }, cx), t)] : []),
          this.smallButton("gsb-sub-add", "plus", "Add submodule…", (cx) => subs.run({ type: "submoduleAdd" }, cx), t),
        ]))
        .when(this.open.submodules, (el) => el
          .when(!subs.list && !subs.error, (e) => e.child(div().px(14).py(4).text_size(11).text_color(t.dim).child("Loading…")))
          .when(Boolean(subs.error), (e) => e.child(div().px(14).py(4).text_size(11).text_color(t.ansi1).child(subs.error)))
          .when(subs.list && subList.length === 0, (e) => e.child(div().px(22).py(4).text_size(11).text_color(t.dim).child("No submodules")))
          .children(subList.map((s, i) => this.submoduleRow(s, i, t, subs))))
        // Tags (collapsed by default)
        .child(this.sectionHeader("tags", "Tags", tags.length, t, null, [
          this.smallButton("gsb-new-tag", "plus", "New tag at HEAD", () => branches.dialog({ type: "newTag", base: "HEAD", what: h.current ?? "HEAD" }), t),
        ]))
        .when(this.open.tags, (el) => el
          .children(tags.slice(0, SHOWN).map((b, i) => h_flex().id(`gsb-t-${i}`).h(ROW).flex_none().pl(16).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => h.scrollToCommit(b.hash, b.name, cx))
            .on_mouse_down("right", (e, cx) => { cx.stop_propagation(); branches.menu({ kind: "tag", name: b.name }, e); })
            .child(svg(icon("tag")).size(12).flex_none().text_color(t.ansi3))
            .child(div().flex_1().min_w(0).truncate().child(b.name))
            .child(div().flex_none().text_size(10.5).text_color(t.dim).child(ago(b.time)))))
          .children(branches.more(tags.length, t)))
        // Remotes (collapsed by default)
        .child(this.sectionHeader("remotes", "Remotes", remotes.length, t, null, [
          this.smallButton("gsb-add-remote", "plus", "Add remote", () => branches.dialog({ type: "addRemote" }), t),
        ]))
        .when(this.open.remotes, (el) => el
          .children(remotes.map((r, i) => h_flex().id(`gsb-rm-${i}`).h(ROW).flex_none().pl(16).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_mouse_down("right", (e, cx) => { cx.stop_propagation(); branches.menu({ kind: "remoteConfig", remote: r }, e); })
            .child(svg(icon("cloud")).size(12).flex_none().text_color(t.accent))
            .child(div().flex_none().child(r.name))
            .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(r.url)))))
        // Worktrees (collapsed by default; lazy-loaded on expand)
        .child(this.sectionHeader("worktrees", "Worktrees", branches.worktreesLoaded ? worktrees.length : "·", t, null, [
          this.smallButton("gsb-prune", "x", "Prune missing worktrees", (cx) => branches.prune(cx), t),
          this.smallButton("gsb-add-wt", "plus", "New worktree", () => branches.dialog({
            type: "addWorktree", local: d?.local ?? null, remote: d?.remote ?? null, worktrees: d?.worktrees ?? null,
          }), t),
        ], (next, cx) => { if (next) branches.ensureWorktrees(cx); }))
        .when(this.open.worktrees, (el) => el
          .when(branches.worktreesLoading, (e) => e.child(div().px(14).py(4).text_size(11).text_color(t.dim).child("Loading worktrees…")))
          .children(worktrees.map((w, i) => {
            const here = samePath(w.path, h.root);
            return h_flex().id(`gsb-w-${i}`).h(ROW).flex_none().pl(16).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .tooltip(w.path)
              .on_mouse_down("right", (e, cx) => { cx.stop_propagation(); branches.menu({ kind: "worktree", worktree: w, current: here }, e); })
              .child(svg(icon("folder")).size(12).flex_none().text_color(here ? t.accent : t.muted))
              .child(div().flex_1().min_w(0).truncate().child(w.branch ?? (w.bare ? "bare" : "detached")))
              .when(w.changes > 0, (r) => r.child(this.pill(String(w.changes), t.blocked, t.blocked + "20")))
              .when(here, (r) => r.child(this.pill("here", t.accent, t.accent + "20")))
              .when(w.prunable, (r) => r.child(this.pill("gone", t.ansi1)));
          }))));
  }
}
