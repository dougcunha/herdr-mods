// The Stash tab: the stashes, newest first. A click on one shows its files and the diff of a file,
// with Apply, Pop and Drop. "New stash" stashes the uncommitted changes.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, openOverlay } from "herdr";
import { READ, menuFor, menuHeight, patchRows } from "./git.js";
import { stashListArgs, parseStashes, stashShowArgs, splitFiles, ago } from "./refs.js";
import { perform, openDialog, atEvent } from "./act.js";
import { icon } from "./menu.js";
import { DiffView } from "./diffview.js";

const ROW = 30, FILE = 24;

export class Stash {
  constructor(host) { this.host = host; }

  init() {
    this.list = []; this.sel = null; this.files = null; this.file = null; this.error = null;
    this.diff = new DiffView(`gc-stash-${Math.random().toString(36).slice(2)}`);
  }

  // After every read of the repository: the list is one quick call (its count shows on the tab).
  reload(cx) {
    const h = this.host.history;
    if (h.context !== this.context) { this.context = h.context; this.list = []; this.clear(); }
    if (!h.root) return;
    const root = h.root, on = h.on, context = h.context, seq = this.seq = (this.seq ?? 0) + 1;
    cx.spawn(async (cx) => {
      const r = await exec("git", [...READ, ...stashListArgs()], { cwd: root, on }).catch(() => null);
      if (this.seq !== seq || this.host.history.context !== context) return;
      this.list = r?.code === 0 ? parseStashes(r.stdout) : [];
      // A stash is known by its hash: stash@{0} names another one after a new stash.
      if (this.sel && !this.list.some((s) => s.hash === this.sel.hash)) this.clear();
      else if (this.sel) this.sel = this.list.find((s) => s.hash === this.sel.hash);
      cx.notify();
    });
  }

  clear() { this.sel = null; this.files = null; this.file = null; this.diff.setRows([]); }

  pick(s, cx) {
    if (this.sel?.hash === s.hash) { this.clear(); cx.notify(); return; }
    this.sel = s; this.files = null; this.file = null; this.diff.setRows([]);
    const h = this.host.history, hash = s.hash;
    cx.spawn(async (cx) => {
      const git = (args) => exec("git", [...READ, ...args], { cwd: h.root, on: h.on });
      // --include-untracked needs git 2.32: an older git shows the tracked files only.
      let r = await git(stashShowArgs(s.ref));
      if (r.code !== 0) r = await git(stashShowArgs(s.ref, false));
      if (this.sel?.hash !== hash) return;
      this.files = r.code === 0 ? splitFiles(r.stdout) : [];
      this.error = r.code === 0 ? null : r.stderr.trim();
      if (this.files.length) this.show(this.files[0]);
      cx.notify();
    });
    cx.notify();
  }

  show(f) { this.file = f.path; this.diff.setRows(patchRows(f.text) ?? [{ kind: "", text: "Binary file" }]); }

  run(action, cx) {
    const ctx = this.host.ctx();
    if (!ctx || openDialog(action, ctx)) return;
    this.busy = action.type;
    cx.spawn(async (cx) => { await perform(action, {}, ctx); this.busy = null; cx.notify(); });
    cx.notify();
  }

  menu(s, e) {
    const ctx = this.host.ctx();
    if (!ctx) return;
    const target = { kind: "stash", stash: { ref: s.ref, message: s.message } }, items = menuFor(target, ctx);
    openOverlay({ mod: "git-client", kind: "popup", at: atEvent(e), width: 240, height: menuHeight(items), props: { role: "menu", target, ctx } });
  }

  button(id, text, glyph, primary, danger, action, t) {
    const busy = Boolean(this.busy);
    return h_flex().id(id).h(26).px(9).gap(5).flex_none().items_center().rounded(6).text_size(11.5).border_1()
      .border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : danger ? t.ansi1 : t.foreground)
      .when(!busy, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)))
      .on_click((_e, cx) => { if (!busy) action(cx); })
      .child(svg(icon(glyph)).size(12)).child(text);
  }

  render(t) {
    const h = this.host.history, list = this.list, s = this.sel;
    if (!h.root) return v_flex().flex_1().child(div().p(12).text_color(t.dim).child(h.state === "norepo" ? "Not a git repository" : "Loading…"));
    const changes = h.files?.length ?? 0;
    const listHeight = Math.min(list.length * ROW + 8, Math.max(ROW * 3, (this.host.height ?? 600) * 0.3));
    return v_flex().id("gc-stash").flex_1().min_h(0).w_full()
      .child(h_flex().h(40).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(11.5).text_color(t.dim).child(list.length ? `${list.length} stash${list.length === 1 ? "" : "es"}` : "No stashes"))
        .child(changes ? this.button("gs-new", "New stash…", "stash", false, false, (cx) => this.run({ type: "stash" }, cx), t) : div()))
      .when(list.length > 0, (e) => e.child(v_flex().id("gs-list").flex_none().h(listHeight).overflow_y_scrollbar().px(4).py(4)
        .children(list.map((x) => h_flex().id(`gs-${x.hash}`).h(ROW).flex_none().px(10).gap(8).items_center().rounded(6).cursor_pointer()
          .when(s?.hash === x.hash, (el) => el.bg(t.selected)).hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => this.pick(x, cx))
          .on_mouse_down("right", (e, cx) => { cx.stop_propagation(); this.menu(x, e); })
          .child(svg(icon("stash")).size(12).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(x.message || "(no message)"))
          .when(Boolean(x.branch), (el) => el.child(div().flex_none().max_w(120).truncate().text_size(11).text_color(t.dim).child(x.branch)))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(x.time)))))))
      .when(Boolean(s), (e) => e
        .child(h_flex().h(40).flex_none().px(10).gap(6).items_center().border_t(1).border_b(1).border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_semibold().child(s.ref))
          .child(this.button("gs-apply", "Apply", "check", false, false, (cx) => this.run({ type: "stashApply", ref: s.ref }, cx), t))
          .child(this.button("gs-pop", "Pop", "stash", true, false, (cx) => this.run({ type: "stashPop", ref: s.ref }, cx), t))
          .child(this.button("gs-drop", "Drop…", "trash", false, true, (cx) => this.run({ type: "stashDrop", ref: s.ref, message: s.message }, cx), t)))
        .when(Boolean(this.error), (el) => el.child(div().px(10).py(6).text_size(11.5).text_color(t.ansi1).child(this.error)))
        .when(!this.files, (el) => el.child(div().p(10).text_color(t.dim).child("Loading files…")))
        .when(Boolean(this.files), (el) => el
          .child(v_flex().id("gs-files").flex_none().max_h(FILE * 6 + 8).overflow_y_scrollbar().px(4).py(4)
            .children(this.files.map((f, i) => {
              const parts = f.path.split("/"), name = parts.pop();
              const c = f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : t.blocked;
              return h_flex().id(`gsf-${i}`).h(FILE).flex_none().px(10).gap(8).items_center().rounded(6).cursor_pointer()
                .when(this.file === f.path, (r) => r.bg(t.selected)).hover((st) => st.bg(t.hover))
                .on_click((_e, cx) => { this.show(f); cx.notify(); })
                .child(div().w(12).flex_none().text_size(11).text_color(c).child(f.status))
                .child(h_flex().flex_1().min_w(0).child(div().flex_none().max_w(220).truncate().child(name))
                  .child(div().pl(6).flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/"))))
                .when(f.add > 0, (r) => r.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
                .when(f.del > 0, (r) => r.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
            })))
          .child(div().h(1).flex_none().bg(t.border))
          .child(this.diff.render({ empty: this.files.length ? "Select a file" : "No changes" }))))
      .when(!s, (e) => e.child(div().flex_1()));
  }
}
