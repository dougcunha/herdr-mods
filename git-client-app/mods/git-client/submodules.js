// The Submodules tab: each submodule with its commit and state (ok, modified, out of sync, not
// initialized, conflict). A click (or a right-click) opens its menu; the bar updates, syncs or adds.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, openOverlay } from "herdr";
import { READ, menuFor, menuHeight } from "./git.js";
import { submoduleStatusArgs, gitmodulesArgs, parseSubmodules, parseSubmoduleStatus, parseRevListCounts, submoduleBranchState } from "./refs.js";
import { perform, openDialog, atEvent } from "./act.js";
import { icon } from "./menu.js";

const ROW = 38;

export class Submodules {
  constructor(host) { this.host = host; }

  init() { this.list = null; this.error = null; this.dirty = true; this.loadingPhase2 = false; }

  // Two-phase snapshot: Phase 1 renders the submodule list immediately from parent state;
  // Phase 2 runs one `git status --branch` per initialized submodule in bounded batches.
  reload(cx, force = false) {
    const h = this.host.history;
    if (h.context !== this.context) { this.context = h.context; this.list = null; this.error = null; this.loadingPhase2 = false; }
    const visible = force || this.host.tab === "submodules" || this.host.isWide?.();
    if (!visible) { this.dirty = true; return; }
    if (!h.root) return;
    this.dirty = false;
    const root = h.root, on = h.on, seq = this.seq = (this.seq ?? 0) + 1;
    const git = (args, cwd = root) => exec("git", [...READ, ...args], { cwd, on, timeout: 60000 });
    cx.spawn(async (cx) => {
      try {
        const [status, config] = await Promise.all([git(submoduleStatusArgs()), git(gitmodulesArgs())]);
        if (this.seq !== seq) return;
        if (status.code !== 0) throw new Error(status.stderr.trim().split("\n").pop());
        const list = parseSubmodules(status.stdout, config.code === 0 ? config.stdout : "");
        this.list = list; this.error = null;
        const todo = list.slice(0, 20).filter((s) => s.state !== "uninitialized");
        this.loadingPhase2 = todo.length > 0;
        cx.notify();
        for (let n = 0; n < todo.length; n += 6) {
          await Promise.all(todo.slice(n, n + 6).map(async (s) => {
            const r = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal", "--branch"], `${root}/${s.path}`).catch(() => null);
            if (r?.code !== 0) return;
            const st = parseSubmoduleStatus(r.stdout);
            s.changes = st.changes;
            s.currentBranch = st.detached ? null : st.branch;
            s.detached = st.detached;
            s.upstream = st.upstream;
            s.ahead = st.ahead;
            s.behind = st.behind;
            s.gone = st.gone;
            s.branchRef = st.upstream;
            if (!st.upstream && !st.unborn) {
              const candidate = st.detached ? s.branch : st.branch;
              if (candidate) {
                const rv = await git(["rev-list", "--left-right", "--count", `HEAD...refs/remotes/origin/${candidate}`], `${root}/${s.path}`).catch(() => null);
                const counts = rv?.code === 0 ? parseRevListCounts(rv.stdout) : null;
                if (counts) {
                  s.ahead = counts.ahead;
                  s.behind = counts.behind;
                  s.branchRef = `origin/${candidate}`;
                }
              } else if (st.detached) {
                const sym = await git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], `${root}/${s.path}`).catch(() => null);
                const ref = sym?.code === 0 ? sym.stdout.trim() : "";
                if (ref) {
                  const rv = await git(["rev-list", "--left-right", "--count", `HEAD...refs/remotes/${ref}`], `${root}/${s.path}`).catch(() => null);
                  const counts = rv?.code === 0 ? parseRevListCounts(rv.stdout) : null;
                  if (counts) {
                    s.ahead = counts.ahead;
                    s.behind = counts.behind;
                    s.branchRef = ref;
                  }
                }
              }
            }
            s.branchChecked = true;
          }));
          if (this.seq !== seq) return;
        }
        this.loadingPhase2 = false;
      } catch (e) {
        if (this.seq === seq) { this.error = String(e?.message ?? e); this.loadingPhase2 = false; }
      }
      cx.notify();
    });
  }

  pendingSummary() {
    let dirty = 0, outOfSync = 0, conflict = 0, uninitialized = 0, ahead = 0, behind = 0, gone = 0;
    for (const s of this.list ?? []) {
      if ((s.changes ?? 0) > 0) dirty++;
      if (s.state === "out of sync") outOfSync++;
      if (s.state === "conflict") conflict++;
      if (s.state === "uninitialized") uninitialized++;
      if ((s.ahead ?? 0) > 0) ahead++;
      if ((s.behind ?? 0) > 0) behind++;
      if (s.gone) gone++;
    }
    return { dirty, outOfSync, conflict, uninitialized, ahead, behind, gone };
  }

  menu(s, e) {
    const ctx = this.host.ctx();
    if (!ctx) return;
    const target = { kind: "submodule", submodule: s }, items = menuFor(target, ctx);
    openOverlay({ mod: "git-client", kind: "popup", at: atEvent(e), width: 268, height: menuHeight(items), props: { role: "menu", target, ctx } });
  }

  run(action, cx) {
    const ctx = this.host.ctx();
    if (!ctx || openDialog(action, ctx)) return;
    this.busy = action.type;
    cx.spawn(async (cx) => { await perform(action, {}, ctx); this.busy = null; this.reload(cx, true); cx.notify(); });
    cx.notify();
  }

  button(id, text, glyph, action, t) {
    const busy = Boolean(this.busy);
    return h_flex().id(id).h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(11.5).border_1().border_color(t.border).bg(t.raised)
      .text_color(busy ? t.dim : t.foreground).when(!busy, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { if (!busy) action(cx); })
      .child(svg(icon(glyph)).size(12)).child(text);
  }

  render(t) {
    const h = this.host.history, list = this.list;
    if (!h.root) return v_flex().flex_1().child(div().p(12).text_color(t.dim).child(h.state === "norepo" ? "Not a git repository" : "Loading…"));
    const color = { ok: t.ansi2, "out of sync": t.blocked, uninitialized: t.dim, conflict: t.ansi1 };
    const has = Boolean(list?.length);
    return v_flex().id("gc-submodules").flex_1().min_h(0).w_full()
      .child(h_flex().h(40).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim)
          .child(!list ? "" : list.length ? `${list.length} submodule${list.length === 1 ? "" : "s"}` : "No submodules"))
        .when(has, (e) => e
          .child(this.button("gsm-fetch", this.busy === "submoduleFetch" ? "Fetching…" : "Fetch", "cloud-down", (cx) => this.run({ type: "submoduleFetch" }, cx), t))
          .child(this.button("gsm-update", this.busy === "submoduleUpdate" ? "Updating…" : "Update all", "fetch", (cx) => this.run({ type: "submoduleUpdate" }, cx), t))
          .child(this.button("gsm-sync", "Sync", "refresh", (cx) => this.run({ type: "submoduleSync" }, cx), t)))
        .child(this.button("gsm-add", "Add…", "plus", (cx) => this.run({ type: "submoduleAdd" }, cx), t)))
      .when(Boolean(this.error), (e) => e.child(div().p(10).text_size(12).text_color(t.ansi1).child(this.error)))
      .when(!list && !this.error, (e) => e.child(div().p(12).text_color(t.dim).child("Loading submodules…")))
      .when(list?.length === 0, (e) => e.child(div().p(12).text_size(12).text_color(t.dim).child("This repository has no submodules. Add… clones a repository into a folder of this one.")))
      .when(has, (e) => e.child(v_flex().id("gsm-list").flex_1().min_h(0).overflow_y_scrollbar().px(4).py(4)
        .children(list.map((s, i) => {
          const modified = s.changes > 0, bs = submoduleBranchState(s);
          const dotColor = s.state === "conflict" ? t.ansi1
            : s.state === "uninitialized" ? t.dim
            : (bs?.kind === "behind" || bs?.kind === "diverged" || bs?.kind === "gone") ? t.ansi1
            : modified ? t.blocked
            : (bs?.kind === "latest" || bs?.kind === "ahead") ? t.ansi2
            : s.state === "out of sync" ? t.blocked
            : s.state === "ok" ? t.ansi2
            : t.dim;
          const branchLabel = s.currentBranch ? s.currentBranch : s.detached ? "detached" : s.branch ? `branch ${s.branch}` : null;
          const pill = (text, fg, bg = null, tip = null, glyph = null) => {
            const el = h_flex().flex_none().px(5).py(1).gap(3).items_center().rounded(4).text_size(10.5).text_color(fg)
              .when(Boolean(bg), (e) => e.bg(bg))
              .when(!bg, (e) => e.border_1().border_color(fg + "44"))
              .when(Boolean(glyph), (e) => e.child(svg(icon(glyph)).size(9).flex_none()))
              .child(text);
            return tip ? el.tooltip(tip) : el;
          };
          return h_flex().id(`gsm-${i}`).h(ROW).flex_none().px(10).gap(8).items_center().rounded(6).cursor_pointer().hover((st) => st.bg(t.hover))
            // A click event has no position: the menu opens at the spot of the press.
            .on_mouse_down("left", (ev) => { this.press = ev; })
            .on_click(() => this.menu(s, this.press))
            .on_mouse_down("right", (ev, cx) => { cx.stop_propagation(); this.menu(s, ev); })
            .child(div().size(8).flex_none().rounded(4).bg(dotColor))
            .child(v_flex().flex_1().min_w(0)
              .child(div().truncate().child(s.path))
              .child(div().truncate().text_size(10.5).text_color(t.dim).child([s.hash.slice(0, 8), branchLabel, s.describe].filter(Boolean).join(" · "))))
            .when(bs?.kind === "latest", (r) => r.child(pill("latest", t.ansi2, t.ansi2 + "1c", `At latest commit of ${bs.ref}`, "check")))
            .when(bs?.kind === "ahead" || bs?.kind === "diverged", (r) => r.child(pill(`↑${bs.ahead}`, t.ansi2, t.ansi2 + "1c", `${bs.ahead} commit(s) ahead of ${bs.ref}`)))
            .when(bs?.kind === "behind" || bs?.kind === "diverged", (r) => r.child(pill(`↓${bs.behind}`, t.ansi1, t.ansi1 + "1c", `${bs.behind} commit(s) behind ${bs.ref}`)))
            .when(bs?.kind === "gone", (r) => r.child(pill("gone", t.ansi1, t.ansi1 + "1c", `Upstream ${bs.ref ?? "branch"} is gone`)))
            .when(bs?.kind === "local", (r) => r.child(pill("local", t.dim, null, "No remote tracking branch")))
            .when(modified, (r) => r.child(pill(`${s.changes} changed`, t.blocked, t.blocked + "1c", `${s.changes} uncommitted change(s)`)))
            .when(s.state === "out of sync", (r) => r.child(pill("pointer", t.blocked, t.blocked + "1c", "Pointer changed in parent repository — stage and commit to record this commit")))
            .when(s.state === "conflict", (r) => r.child(pill("conflict", t.ansi1, t.ansi1 + "1c")))
            .when(s.state === "uninitialized", (r) => r.child(pill("uninitialized", t.dim)))
            .when(s.state === "ok" && !bs, (r) => r.child(div().flex_none().text_size(11).text_color(color[s.state] ?? t.dim).child(s.state)));
        }))));
  }
}
