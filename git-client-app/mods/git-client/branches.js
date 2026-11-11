// The Branches tab: sections Local, Remote, Tags, Remotes and Worktrees. A click (or a right-click)
// on a row opens its menu; the "+" of a section makes a new one.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, openOverlay } from "herdr";
import { READ, menuFor, menuHeight } from "./git.js";
import { refsArgs, parseRefs, parseRemotes, parseWorktrees, samePath, ago } from "./refs.js";
import { perform, openDialog, atEvent } from "./act.js";
import { icon } from "./menu.js";

const ROW = 26, TITLE = 30, SHOWN = 200;
const SECTIONS = [
  { id: "local", title: "Local" }, { id: "remote", title: "Remote" }, { id: "tags", title: "Tags" },
  { id: "remotes", title: "Remotes" }, { id: "worktrees", title: "Worktrees" },
];

export class Branches {
  constructor(host) { this.host = host; }

  init() {
    this.data = null; this.error = null; this.dirty = true;
    this.open = { local: true, remote: false, tags: false, remotes: true, worktrees: true };
    this.search = InputState.new({ placeholder: "Filter branches and tags" });
    this.search.on("change", (_e, cx) => { this.text = this.search.value().trim().toLowerCase(); cx.notify(); });
    this.search.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.text = "";
  }

  // After a read of the repository: read now when the tab shows, else when it shows next.
  reload(cx, force = false) {
    const h = this.host.history;
    if (h.context !== this.context) { this.context = h.context; this.data = null; this.error = null; }
    if (!force && this.host.tab !== "branches") { this.dirty = true; return; }
    if (!h.root) return;
    this.dirty = false;
    const root = h.root, on = h.on, context = h.context, seq = this.seq = (this.seq ?? 0) + 1;
    const git = (args, cwd = root) => exec("git", [...READ, ...args], { cwd, on });
    cx.spawn(async (cx) => {
      try {
        const [refs, remotes, worktrees] = await Promise.all([git(refsArgs()), git(["remote", "-v"]), git(["worktree", "list", "--porcelain"])]);
        if (this.seq !== seq || this.host.history.context !== context) return;
        if (refs.code !== 0) throw new Error(refs.stderr.trim());
        const data = { ...parseRefs(refs.stdout), remotes: parseRemotes(remotes.stdout), worktrees: parseWorktrees(worktrees.stdout) };
        // Changed files of each worktree (the first 20): one status each, on its machine.
        await Promise.all(data.worktrees.slice(0, 20).map(async (w) => {
          if (w.bare || w.prunable) return;
          const r = await git(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], w.path).catch(() => null);
          w.changes = r?.code === 0 ? r.stdout.split("\0").filter(Boolean).length : null;
        }));
        if (this.seq !== seq) return;
        this.data = data; this.error = null;
      } catch (e) { if (this.seq === seq) this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  ctx() { return this.host.ctx(); }

  menu(target, e) {
    const ctx = this.ctx();
    if (!ctx) return;
    const items = menuFor(target, ctx);
    openOverlay({ mod: "git-client", kind: "popup", at: atEvent(e), width: 268, height: menuHeight(items), props: { role: "menu", target, ctx } });
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

  row(id, glyph, glyphColor, name, detail, right, target, t, extra = null) {
    return h_flex().id(id).h(ROW).flex_none().pl(24).pr(10).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      // A click event has no position: the menu opens at the spot of the press.
      .on_mouse_down("left", (e) => { this.press = e; })
      .on_click(() => this.menu(target, this.press))
      .on_mouse_down("right", (e, cx) => { cx.stop_propagation(); this.menu(target, e); })
      .child(svg(icon(glyph)).size(12).flex_none().text_color(glyphColor))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().flex_none().max_w(240).min_w(0).truncate().child(name))
        .when(Boolean(detail), (e) => e.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(detail))))
      .when(Boolean(extra), (e) => e.child(extra))
      .when(Boolean(right), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(right)));
  }

  more(n, t) { return n > SHOWN ? [div().h(ROW).flex_none().pl(24).flex().items_center().text_size(11).text_color(t.dim).child(`and ${n - SHOWN} more: filter to find them`)] : []; }

  render(t) {
    const h = this.host.history, d = this.data;
    if (!h.root) return v_flex().flex_1().child(div().p(12).text_color(t.dim).child(h.state === "norepo" ? "Not a git repository" : "Loading…"));
    const match = (s) => !this.text || s.toLowerCase().includes(this.text);
    const local = (d?.local ?? []).filter((b) => match(b.name)), remote = (d?.remote ?? []).filter((b) => match(b.name)), tags = (d?.tags ?? []).filter((b) => match(b.name));
    const remotes = d?.remotes ?? [], worktrees = d?.worktrees ?? [], open = this.open;
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
      .when(Boolean(d), (e) => e.child(v_flex().id("gb-list").flex_1().min_h(0).overflow_y_scrollbar().px(4).py(4)
        // Local
        .child(this.header(SECTIONS[0], local.length, t, [this.smallButton("gb-new-branch", "plus", "New branch from HEAD", () => this.dialog({ type: "newBranch", base: "HEAD", what: h.current ?? "HEAD" }), t)]))
        .when(open.local, (el) => el.children(local.slice(0, SHOWN).map((b, i) => this.row(`gb-l-${i}`, b.current ? "check" : "branch", b.current ? t.accent : t.muted,
          b.name, b.upstream ? `→ ${b.upstream}` : "", ago(b.time), { kind: "branch", name: b.name, upstream: b.upstream, gone: b.gone }, t,
          track(b) ? div().flex_none().text_size(11).text_color(b.gone || b.behind ? t.ansi1 : t.ansi2).child(track(b)) : null)
          .when(b.current, (r) => r.font_semibold()))).children(this.more(local.length, t)))
        // Remote, grouped by remote
        .child(this.header(SECTIONS[1], remote.length, t))
        .when(open.remote, (el) => el.children(remote.slice(0, SHOWN).flatMap((b, i) => {
          const rows = [];
          if (b.remote !== lastRemote) { lastRemote = b.remote; rows.push(div().h(22).flex_none().pl(24).flex().items_center().text_size(10.5).text_color(t.dim).child(b.remote)); }
          rows.push(this.row(`gb-r-${i}`, "cloud", t.muted, b.branch, "", ago(b.time), { kind: "remote", name: b.name }, t));
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
          this.smallButton("gb-add-worktree", "plus", "New worktree", () => this.dialog({ type: "addWorktree" }), t)]))
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
