// The history and the blame of one file: a view over the tabs, with Back. History lists the commits that
// changed the file (following renames) and shows the diff of the file in one of them. Blame shows each line
// with its commit; a click on a line shows that commit in History.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, theme, settings } from "herdr";
import { READ, patchRows } from "./git.js";
import { fileLogArgs, parseFileLog, blameArgs, parseBlame, ago } from "./refs.js";
import { icon } from "./menu.js";
import { DiffView } from "./diffview.js";

const ROW = 30, LINE = 20;

export class FileView {
  constructor(host) {
    this.host = host; this.path = null;
    this.id = `gc-file-${Math.random().toString(36).slice(2)}`;
    this.diff = new DiffView(`${this.id}-diff`);
  }

  open(path, mode, cx) {
    this.path = path; this.mode = mode === "blame" ? "blame" : "history";
    this.log = null; this.blame = null; this.sel = null; this.error = null; this.diff.setRows([]);
    this.load(cx);
  }

  close() { this.path = null; }

  setMode(mode, cx) { this.mode = mode; this.load(cx); cx.notify(); }

  load(cx) {
    const h = this.host.history, path = this.path, mode = this.mode;
    if (!h.root || !path) return;
    if ((mode === "history" && this.log) || (mode === "blame" && this.blame)) return;
    const git = (args) => exec("git", [...READ, "-c", "core.quotePath=false", ...args], { cwd: h.root, on: h.on, timeout: 60000 });
    cx.spawn(async (cx) => {
      try {
        const r = await git(mode === "blame" ? blameArgs(path) : fileLogArgs(path));
        if (this.path !== path) return;
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop());
        if (mode === "blame") this.blame = parseBlame(r.stdout);
        else {
          this.log = parseFileLog(r.stdout);
          // A blame line asked for its commit before the log was in; else the newest.
          const first = this.log.find((c) => c.hash === this.want) ?? this.log[0];
          this.want = null;
          if (first) this.pick(first, cx);
        }
      } catch (e) { if (this.path === path) this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  pick(c, cx) {
    this.sel = c.hash; this.diff.setRows([]);
    const h = this.host.history, path = c.path ?? this.path, hash = c.hash;
    cx.spawn(async (cx) => {
      const r = await exec("git", [...READ, "show", "--format=", "--no-color", "--no-ext-diff", "--no-textconv", hash, "--", path], { cwd: h.root, on: h.on });
      if (this.sel !== hash) return;
      this.diff.setRows(r.code === 0 ? (patchRows(r.stdout) ?? [{ kind: "", text: "No text changes" }]) : [{ kind: "", text: r.stderr.trim() }]);
      cx.notify();
    });
    cx.notify();
  }

  // A blame line: its commit in History.
  showCommit(hash, cx) {
    if (/^0+$/.test(hash)) return;
    this.mode = "history";
    const go = (cx) => { const c = this.log?.find((x) => x.hash === hash); if (c) this.pick(c, cx); };
    if (this.log) go(cx);
    else {
      this.want = hash;
      this.load(cx);
    }
    cx.notify();
  }

  render(t, cx) {
    const mono = settings().font_family ?? "JetBrains Mono", parts = (this.path ?? "").split("/"), name = parts.pop();
    const seg = (m, label) => div().id(`gf-mode-${m}`).h_full().px(8).flex().items_center().rounded(4).text_size(11.5)
      .text_color(this.mode === m ? t.foreground : t.muted).when(this.mode === m, (e) => e.bg(t.selected))
      .when(this.mode !== m, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))).on_click((_e, cx) => this.setMode(m, cx)).child(label);
    const head = h_flex().h(36).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border)
      .child(h_flex().id("gf-back").h(26).pl(4).pr(8).gap(4).flex_none().items_center().rounded(6).cursor_pointer().text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.close(); cx.notify(); })
        .child(svg(icon("back")).size(14)).child("Back"))
      .child(div().id("gf-name").flex_1().min_w(0).truncate().font_semibold().tooltip(this.path ?? "").child(name))
      .child(h_flex().flex_none().h(26).p(2).gap(2).rounded(6).border_1().border_color(t.border).child(seg("history", "History")).child(seg("blame", "Blame")));
    const body = v_flex().flex_1().min_h(0);
    if (this.error) return v_flex().id("gc-file").flex_1().min_h(0).child(head).child(div().p(12).text_size(12).text_color(t.ansi1).child(this.error));
    if (this.mode === "blame") {
      const rows = this.blame;
      return v_flex().id("gc-file").flex_1().min_h(0).child(head).child(!rows ? div().p(12).text_color(t.dim).child("Loading blame…")
        : body.relative().font_family(mono).text_size(11)
          .child(v_virtual_list(`${this.id}-blame`, rows.length, LINE, (i) => String(i), (range) => rows.slice(range.start, range.end).map((r) =>
            h_flex().w_full().h(LINE).flex_none().gap(8).hover((s) => s.bg(t.hover)).when(r.first, (e) => e.border_t(1).border_color(t.border))
              .child(h_flex().w(190).flex_none().px(8).gap(6).overflow_hidden().text_color(t.dim)
                .when(r.first, (e) => e.child(div().flex_none().text_color(r.uncommitted ? t.blocked : t.accent).child(r.uncommitted ? "uncommitted" : r.hash.slice(0, 7)))
                  .child(div().flex_1().min_w(0).truncate().child(r.uncommitted ? "" : r.author)).child(div().flex_none().child(r.uncommitted ? "" : ago(r.time)))))
              .child(div().w(36).flex_none().text_right().text_color(t.dim).child(String(r.number)))
              .child(div().flex_1().min_w(0).truncate().child(r.text))))
            .on_item_click((key, cx) => { const r = rows[Number(key)]; if (r) this.showCommit(r.hash, cx); })
            .size_full())
          .child(Scrollbar.vertical(`${this.id}-blame`).viewport_from_layout().absolute().inset_0()));
    }
    const log = this.log;
    const listHeight = Math.min((log?.length ?? 0) * ROW + 8, Math.max(ROW * 4, (this.host.height ?? 600) * 0.35));
    return v_flex().id("gc-file").flex_1().min_h(0).child(head)
      .when(!log, (e) => e.child(div().p(12).text_color(t.dim).child("Loading history…")))
      .when(Boolean(log) && !log?.length, (e) => e.child(div().p(12).text_color(t.dim).child("No commits changed this file yet.")))
      .when(Boolean(log?.length), (e) => e
        .child(v_flex().id("gf-log").flex_none().h(listHeight).overflow_y_scrollbar().px(4).py(4)
          .children(log.map((c) => h_flex().id(`gfl-${c.hash}`).h(ROW).flex_none().px(10).gap(8).items_center().rounded(6).cursor_pointer()
            .when(this.sel === c.hash, (r) => r.bg(t.selected)).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.pick(c, cx))
            .child(div().flex_none().font_family(mono).text_size(11).text_color(t.accent).child(c.hash.slice(0, 7)))
            .child(div().flex_1().min_w(0).truncate().child(c.subject))
            .when(Boolean(c.path && c.path !== this.path), (r) => r.child(div().flex_none().max_w(140).truncate().text_size(11).text_color(t.dim).child(`as ${c.path}`)))
            .child(div().flex_none().max_w(110).truncate().text_size(11).text_color(t.muted).child(c.author))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(c.time))))))
        .child(div().h(1).flex_none().bg(t.border))
        .child(this.diff.render({ empty: "Select a commit" })));
  }
}
