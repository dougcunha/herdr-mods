// The Submodules tab: each submodule with its commit and state (ok, modified, out of sync, not
// initialized, conflict). A click (or a right-click) opens its menu; the bar updates, syncs or adds.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, openOverlay } from "herdr";
import { READ, menuFor, menuHeight } from "./git.js";
import { submoduleStatusArgs, gitmodulesArgs, parseSubmodules } from "./refs.js";
import { perform, openDialog, atEvent } from "./act.js";
import { icon } from "./menu.js";

const ROW = 32;

export class Submodules {
  constructor(host) { this.host = host; }

  init() { this.list = null; this.error = null; this.dirty = true; }

  reload(cx, force = false) {
    const h = this.host.history;
    if (h.context !== this.context) { this.context = h.context; this.list = null; this.error = null; }
    if (!force && this.host.tab !== "submodules") { this.dirty = true; return; }
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
        // Changed files in each submodule that is checked out (the first 20).
        await Promise.all(list.slice(0, 20).map(async (s) => {
          if (s.state === "uninitialized") return;
          const r = await git(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], `${root}/${s.path}`).catch(() => null);
          s.changes = r?.code === 0 ? r.stdout.split("\0").filter(Boolean).length : null;
        }));
        if (this.seq !== seq) return;
        this.list = list; this.error = null;
      } catch (e) { if (this.seq === seq) this.error = String(e?.message ?? e); }
      cx.notify();
    });
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
          .child(this.button("gsm-update", this.busy === "submoduleUpdate" ? "Updating…" : "Update all", "fetch", (cx) => this.run({ type: "submoduleUpdate" }, cx), t))
          .child(this.button("gsm-sync", "Sync", "refresh", (cx) => this.run({ type: "submoduleSync" }, cx), t)))
        .child(this.button("gsm-add", "Add…", "plus", (cx) => this.run({ type: "submoduleAdd" }, cx), t)))
      .when(Boolean(this.error), (e) => e.child(div().p(10).text_size(12).text_color(t.ansi1).child(this.error)))
      .when(!list && !this.error, (e) => e.child(div().p(12).text_color(t.dim).child("Loading submodules…")))
      .when(list?.length === 0, (e) => e.child(div().p(12).text_size(12).text_color(t.dim).child("This repository has no submodules. Add… clones a repository into a folder of this one.")))
      .when(has, (e) => e.child(v_flex().id("gsm-list").flex_1().min_h(0).overflow_y_scrollbar().px(4).py(4)
        .children(list.map((s, i) => {
          const modified = s.changes > 0, state = modified && s.state === "ok" ? "modified" : s.state;
          return h_flex().id(`gsm-${i}`).h(ROW).flex_none().px(10).gap(8).items_center().rounded(6).cursor_pointer().hover((st) => st.bg(t.hover))
            // A click event has no position: the menu opens at the spot of the press.
            .on_mouse_down("left", (ev) => { this.press = ev; })
            .on_click(() => this.menu(s, this.press))
            .on_mouse_down("right", (ev, cx) => { cx.stop_propagation(); this.menu(s, ev); })
            .child(div().size(8).flex_none().rounded(4).bg(modified && s.state === "ok" ? t.blocked : color[s.state] ?? t.dim))
            .child(v_flex().flex_1().min_w(0)
              .child(div().truncate().child(s.path))
              .child(div().truncate().text_size(10.5).text_color(t.dim).child([s.hash.slice(0, 8), s.describe, s.branch ? `branch ${s.branch}` : null].filter(Boolean).join(" · "))))
            .when(modified, (r) => r.child(div().flex_none().text_size(11).text_color(t.blocked).child(`${s.changes} changed`)))
            .child(div().flex_none().text_size(11).text_color(color[s.state] ?? t.dim).child(state));
        }))));
  }
}
