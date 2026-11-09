// The Changes tab: the files in conflict, staged and not staged, the diff of one of them with its
// hunks, and the commit box (amend, commit all, push after, AI message).
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { exec, readTextFile, theme, notify, openOverlay, setShared } from "herdr";
import { READ, PATCH, parsePatch, hunkPatch, patchRows, newFileRows, menuFor, menuHeight, opPathArgs, opOf, OP_FILES, gitError } from "./git.js";
import { perform, openDialog } from "./act.js";
import { icon } from "./menu.js";
import { DiffView, VIEW_KEY, currentView } from "./diffview.js";
import { generateMessage } from "./ai.js";

const ROW = 26, TITLE = 28;
const OP_NAMES = { merge: "Merge", rebase: "Rebase", "cherry-pick": "Cherry-pick", revert: "Revert" };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// numstat -z: "add\tdel\tpath\0" per file.
function parseNumstat(text) {
  const out = new Map();
  for (const entry of String(text ?? "").split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (!parts.length) continue;
    out.set(parts.join("\t"), { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" });
  }
  return out;
}

export class Changes {
  constructor(host) { this.host = host; }

  init(cx) {
    this.staged = new Map(); this.unstaged = new Map(); this.op = null;
    this.sel = null; this.closed = false; this.patch = null; this.diffNote = null;
    this.diff = new DiffView(`gc-diff-${Math.random().toString(36).slice(2)}`);
    this.amend = false; this.all = false; this.push = false; this.hover = null;
    this.message = "";
    this.input = TextareaState.new({ placeholder: "Commit message", rows: 2 });
    this.input.set_auto_grow(2, 8);
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.input.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.host.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.host.typing = false; cx.notify(); });
  }

  files() { return this.host.history.files ?? []; }
  conflicts() { return this.files().filter((f) => f.conflict); }
  stagedFiles() { return this.files().filter((f) => f.staged); }
  unstagedFiles() { return this.files().filter((f) => f.unstaged); }

  // A new folder: nothing of the old one stays.
  resetFolder() {
    this.staged = new Map(); this.unstaged = new Map(); this.op = null; this.sel = null; this.closed = false;
    this.patch = null; this.diff.setRows([]); this.diffNote = null; this.amend = false; this.all = false;
    this.message = ""; this.input.set_value("");
  }

  // After every read of the repository: the counts, the operation in progress and the shown diff.
  reload(cx) {
    const h = this.host.history, root = h.root, on = h.on, context = h.context;
    if (context !== this.context) { this.context = context; this.resetFolder(); }
    if (!root) { cx.notify(); return; }
    const seq = this.seq = (this.seq ?? 0) + 1, stale = () => this.seq !== seq || this.host.history.context !== context;
    const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
    cx.spawn(async (cx) => {
      try {
        const [staged, unstaged, paths] = await Promise.all([
          git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), git(["diff", "--numstat", "-z", "--no-renames"]), git(opPathArgs())]);
        if (stale()) return;
        this.staged = parseNumstat(staged.stdout); this.unstaged = parseNumstat(unstaged.stdout);
        // The files under .git that say which operation is in progress.
        const keys = Object.keys(OP_FILES), list = paths.stdout.split("\n").map((p) => p.trim()).filter(Boolean);
        const found = {};
        if (paths.code === 0 && list.length === keys.length) {
          await Promise.all(keys.map(async (k, i) => {
            const p = /^([a-zA-Z]:)?[\\/]/.test(list[i]) ? list[i] : `${root}/${list[i]}`;
            found[k] = await readTextFile(p, { on }).catch(() => null);
          }));
        }
        if (stale()) return;
        this.op = opOf(found);
        const files = this.files();
        if (this.sel && !files.some((f) => f.path === this.sel.path && this.sideOf(f, this.sel.side))) { this.sel = null; this.patch = null; this.diff.setRows([]); }
        // The first file shows until you pick another, as in Herdr's Changes panel.
        if (!this.sel && !this.closed) {
          const first = this.conflicts()[0] ? { f: this.conflicts()[0], side: "conflict" } : this.stagedFiles()[0] ? { f: this.stagedFiles()[0], side: "staged" }
            : this.unstagedFiles()[0] ? { f: this.unstagedFiles()[0], side: "unstaged" } : null;
          if (first) this.sel = { path: first.f.path, side: first.side };
        }
        if (this.sel) await this.loadDiff(cx, seq);
      } catch (e) { if (!stale()) this.diffNote = String(e?.message ?? e); }
      cx.notify();
    });
  }

  sideOf(f, side) { return side === "conflict" ? f.conflict : side === "staged" ? f.staged : f.unstaged; }

  async loadDiff(cx, seq = this.seq) {
    const h = this.host.history, root = h.root, on = h.on, sel = this.sel;
    const file = this.files().find((f) => f.path === sel?.path);
    if (!file || !root) return;
    const git = (args) => exec("git", [...READ, "--literal-pathspecs", ...args], { cwd: root, on });
    let rows, patch = null, note = null;
    try {
      if (sel.side === "unstaged" && file.untracked) {
        rows = newFileRows(await readTextFile(`${root}/${file.path}`, { on }).catch(() => null));
      } else if (sel.side === "conflict") {
        const r = await git(["diff", "--no-color", "--no-ext-diff", "--", file.path]);
        rows = patchRows(r.stdout) ?? [{ kind: "", text: "No text diff (a deleted or binary file in conflict)" }];
      } else {
        const r = await git([...PATCH, ...(sel.side === "staged" ? ["--cached"] : []), "--", file.path]);
        if (r.code !== 0) throw new Error(gitError(r));
        patch = parsePatch(r.stdout);
        const stat = (sel.side === "staged" ? this.staged : this.unstaged).get(file.path);
        rows = patchRows(r.stdout) ?? [{ kind: "", text: stat?.binary ? "Binary file changed" : file.status === "D" ? "File deleted" : "No text changes (mode or whitespace only)" }];
      }
    } catch (e) { rows = []; note = `Can't show this diff: ${e?.message ?? e}`; }
    if (this.seq !== seq || this.sel !== sel) return;
    this.patch = patch; this.diff.setRows(rows); this.diffNote = note;
  }

  pick(f, side, cx) {
    const same = this.sel?.path === f.path && this.sel?.side === side;
    this.sel = same ? null : { path: f.path, side }; this.closed = same;
    this.patch = null; this.diff.setRows([]); this.diffNote = null;
    if (this.sel) { const seq = this.seq; cx.spawn(async (cx) => { await this.loadDiff(cx, seq); cx.notify(); }); }
    cx.notify();
  }

  // ---- actions

  ctx() { return this.host.ctx(); }

  run(action, cx, opts = { quiet: true }) {
    const ctx = this.ctx();
    if (!ctx) return;
    if (openDialog(action, ctx)) return;
    this.busy = action.type;
    cx.spawn(async (cx) => { await perform(action, {}, ctx, opts); this.busy = null; cx.notify(); });
    cx.notify();
  }

  stage(paths, cx) { if (paths.length) this.run({ type: "stage", paths }, cx); }
  unstage(paths, cx) { if (paths.length) this.run({ type: "unstage", paths, unborn: !this.host.history.head }, cx); }
  discard(files, cx) {
    const paths = files.filter((f) => !f.untracked).map((f) => f.path), untracked = files.filter((f) => f.untracked).map((f) => f.path);
    if (paths.length || untracked.length) this.run({ type: "discard", paths, untracked }, cx);
  }

  fileMenu(f, side, cx) {
    const ctx = this.ctx();
    if (!ctx) return;
    const target = { kind: "file", side, file: { path: f.path, untracked: f.untracked, status: f.status } }, items = menuFor(target, ctx);
    openOverlay({ mod: "git-client", kind: "popup", at: "pointer", width: 240, height: menuHeight(items), props: { role: "menu", target, ctx } });
  }

  // A hunk of the shown diff: its menu (stage, unstage, discard).
  hunkMenu(row) {
    const ctx = this.ctx(), sel = this.sel;
    if (!ctx || !this.patch || !row || !(row.hunk >= 0) || !this.patch.hunks[row.hunk] || sel?.side === "conflict") return;
    const target = { kind: "hunk", side: sel.side, path: sel.path, hunk: row.hunk, patch: hunkPatch(this.patch, row.hunk) }, items = menuFor(target, ctx);
    openOverlay({ mod: "git-client", kind: "popup", at: "pointer", width: 220, height: menuHeight(items), props: { role: "menu", target, ctx } });
  }

  expand() {
    if (!this.sel || !this.diff.rows.length) return;
    openOverlay({ mod: "git-client", kind: "dialog", width: 1100, height: 720,
      props: { role: "diff", title: this.sel.path, side: this.sel.side, rows: this.diff.rows } });
  }

  toggleAmend(cx) {
    this.amend = !this.amend;
    const h = this.host.history;
    // An empty field gets the message of the last commit, to change it.
    if (this.amend && !this.message.trim() && h.root && h.head) {
      cx.spawn(async (cx) => {
        const r = await exec("git", [...READ, "log", "-1", "--format=%B"], { cwd: h.root, on: h.on });
        if (r.code === 0 && this.amend && !this.message.trim()) { this.message = r.stdout.trim(); this.input.set_value(this.message); }
        cx.notify();
      });
    }
    cx.notify();
  }

  canCommit() {
    const h = this.host.history;
    if (!this.message.trim() || !h.root || this.busy || this.committing || !this.ctx()) return false;
    if (this.amend) return Boolean(h.head);
    if (this.all) return this.files().length > 0 && !this.conflicts().length;
    return this.stagedFiles().length > 0;
  }

  commitLabel() {
    if (this.committing) return "Committing…";
    const n = this.all ? this.files().length : this.stagedFiles().length;
    const base = this.amend ? "Amend" : this.all ? "Commit all" : n ? `Commit ${plural(n, "file")}` : "Commit";
    return this.push ? `${base} & push` : base;
  }

  commit(cx) {
    if (!this.canCommit()) return;
    const ctx = this.ctx(), values = { message: this.message.trim(), amend: this.amend, all: this.all }, push = this.push;
    this.committing = true;
    cx.spawn(async (cx) => {
      const done = await perform({ type: "commit" }, values, ctx, { toast: true });
      if (done.ok) {
        this.message = ""; this.input.set_value(""); this.amend = false; this.all = false;
        if (push) await this.host.pushNow(cx);
      }
      this.committing = false; cx.notify();
    });
    cx.notify();
  }

  generate(cx) {
    const h = this.host.history;
    if (!h.root || this.generating) return;
    this.generating = true;
    cx.spawn(async (cx) => {
      try {
        const message = await generateMessage({ root: h.root, on: h.on, all: this.all });
        this.message = message; this.input.set_value(message);
      } catch (e) {
        notify({ title: "No AI message", body: String(e?.message ?? e), level: "error" });
      }
      this.generating = false; cx.notify();
    });
    cx.notify();
  }

  command(c, cx) {
    if (c === "commit") this.commit(cx);
    else if (c === "split" || c === "unified") setShared(VIEW_KEY, c);
    else if (c === "toggle") setShared(VIEW_KEY, currentView() === "split" ? "unified" : "split");
  }

  // ---- drawing

  smallButton(id, glyph, tip, action, t, danger = false) {
    return h_flex().id(id).size(22).flex_none().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(danger ? t.ansi1 : t.muted).hover((s) => s.bg(t.hover).text_color(danger ? t.ansi1 : t.foreground))
      .tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(svg(icon(glyph)).size(13));
  }

  fileRow(f, side, t) {
    const parts = f.path.split("/"), name = parts.pop(), key = `${side}:${f.path}`, open = this.sel?.path === f.path && this.sel?.side === side;
    const stat = side === "staged" ? this.staged.get(f.path) : side === "unstaged" ? this.unstaged.get(f.path) : null;
    const letter = side === "conflict" ? "U" : f.untracked ? "U" : side === "staged" ? f.x : f.y;
    const color = side === "conflict" ? t.ansi1 : f.untracked || letter === "A" ? t.ansi2 : letter === "D" ? t.ansi1 : t.blocked;
    const hovered = this.hover === key;
    return h_flex().id(`gc-f-${key}`).h(ROW).flex_none().pl(10).pr(6).gap(8).items_center().rounded(6).cursor_pointer()
      .when(open, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_hover((h, cx) => { const next = h ? key : this.hover === key ? null : this.hover; if (next !== this.hover) { this.hover = next; cx.notify(); } })
      .on_click((_e, cx) => this.pick(f, side, cx))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.fileMenu(f, side, cx); })
      .child(div().w(12).flex_none().text_size(11).text_color(color).child(f.untracked && side !== "conflict" ? "?" : letter))
      .child(h_flex().flex_1().min_w(0).child(div().min_w(0).flex_none().max_w(220).truncate().child(name))
        .child(div().pl(6).flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/"))))
      .when(!hovered && Boolean(stat), (e) => e
        .when(stat.add > 0, (el) => el.child(div().text_size(11).text_color(t.ansi2).child(`+${stat.add}`)))
        .when(stat.del > 0, (el) => el.child(div().text_size(11).text_color(t.ansi1).child(`−${stat.del}`))))
      .when(hovered, (e) => e.child(h_flex().flex_none().gap(2)
        .when(side === "unstaged", (el) => el
          .child(this.smallButton(`gc-fd-${key}`, "trash", f.untracked ? "Delete file" : "Discard changes", (cx) => this.discard([f], cx), t, true))
          .child(this.smallButton(`gc-fs-${key}`, "plus", "Stage", (cx) => this.stage([f.path], cx), t)))
        .when(side === "staged", (el) => el.child(this.smallButton(`gc-fu-${key}`, "minus", "Unstage", (cx) => this.unstage([f.path], cx), t)))
        .when(side === "conflict", (el) => el.child(this.smallButton(`gc-fr-${key}`, "check", "Mark resolved (stage)", (cx) => this.stage([f.path], cx), t)))));
  }

  section(id, title, files, side, t, actions) {
    return v_flex().flex_none()
      .child(h_flex().h(TITLE).flex_none().pl(10).pr(6).gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().font_semibold().child(title.toUpperCase())).child(div().child(String(files.length))).child(div().flex_1())
        .children(actions))
      .children(files.map((f) => this.fileRow(f, side, t)));
  }

  opBanner(t) {
    const conflicts = this.conflicts().length, name = OP_NAMES[this.op] ?? this.op;
    const button = (id, text, primary, enabled, action) => h_flex().id(id).h(24).px(10).flex_none().items_center().rounded(6).text_size(11.5)
      .bg(primary && enabled ? t.solid : t.raised).text_color(primary && enabled ? t.solid_foreground : enabled ? t.foreground : t.dim)
      .border_1().border_color(primary && enabled ? t.solid : t.border)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88))).on_click((_e, cx) => { if (enabled) action(cx); }).child(text);
    return h_flex().flex_none().mx(8).mt(8).px(10).py(8).gap(8).items_center().rounded(8).border_1().border_color(conflicts ? t.ansi1 : t.blocked).bg((conflicts ? t.ansi1 : t.blocked) + "14")
      .child(svg(icon("alert")).size(14).flex_none().text_color(conflicts ? t.ansi1 : t.blocked))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(12).font_semibold().truncate().child(`${name} in progress`))
        .child(div().text_size(11).text_color(t.muted).truncate().child(conflicts ? `${plural(conflicts, "file")} in conflict. Fix them, then stage them.` : "No conflicts left. Continue to finish it.")))
      .child(button("gc-op-abort", "Abort", false, true, (cx) => this.run({ type: "abortOp", op: this.op }, cx, { quiet: false })))
      .child(button("gc-op-continue", "Continue", true, !conflicts, (cx) => this.run({ type: "continueOp", op: this.op }, cx, { quiet: false })));
  }

  toggle(id, label, on, action, t) {
    return h_flex().id(id).h(22).px(4).gap(5).flex_none().items_center().rounded(5).cursor_pointer().text_size(11.5).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => action(cx))
      .child(div().size(13).flex_none().rounded(3).border_1().border_color(on ? t.accent : t.input).when(on, (e) => e.bg(t.accent)).flex().items_center().justify_center()
        .when(on, (e) => e.child(svg(icon("check")).size(10).text_color(t.accent_foreground))))
      .child(label);
  }

  commitBox(t) {
    const enabled = this.canCommit(), typing = this.host.typing;
    return v_flex().flex_none().p(8).gap(6).border_t(1).border_color(t.border)
      .child(div().id("gc-message").w_full().px(8).py(6).rounded(8).border_1().border_color(typing ? t.accent : t.border).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.input).w_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().gap(4).items_center().flex_wrap()
        .child(this.toggle("gc-amend", "Amend", this.amend, (cx) => this.toggleAmend(cx), t))
        .child(this.toggle("gc-all", "Commit all", this.all, (cx) => { this.all = !this.all; cx.notify(); }, t))
        .child(this.toggle("gc-push", "Push", this.push, (cx) => { this.push = !this.push; cx.notify(); }, t))
        .child(div().flex_1())
        .child(h_flex().id("gc-generate").h(28).px(8).gap(5).flex_none().items_center().rounded(7).border_1().border_color(t.border).text_size(11.5)
          .text_color(this.generating ? t.dim : t.foreground).tooltip("Write the message with AI, from the staged changes")
          .when(!this.generating, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => this.generate(cx))
          .child(svg(icon("sparkles")).size(13).text_color(t.accent)).child(this.generating ? "Writing…" : "AI"))
        .child(h_flex().id("gc-commit").h(28).px(12).flex_none().items_center().rounded(7).text_size(12)
          .bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim)
          .when(enabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88))).on_click((_e, cx) => this.commit(cx))
          .child(this.commitLabel())));
  }

  diffBar(t) {
    const sel = this.sel, view = currentView();
    const seg = (v, label) => div().id(`gc-view-${v}`).h_full().px(7).flex().items_center().rounded(4).text_size(11)
      .text_color(view === v ? t.foreground : t.muted).when(view === v, (e) => e.bg(t.selected))
      .when(view !== v, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))).on_click(() => setShared(VIEW_KEY, v)).child(label);
    const parts = sel ? sel.path.split("/") : [], name = parts.pop();
    return h_flex().h(32).flex_none().px(10).gap(8).items_center().border_t(1).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(sel ? t.foreground : t.dim).child(sel ? name : "No file"))
      .when(Boolean(sel), (e) => e.child(div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
        .child(sel.side === "staged" ? "staged" : sel.side === "conflict" ? "conflict" : "unstaged")))
      .child(h_flex().flex_none().h(24).p(2).gap(2).rounded(6).border_1().border_color(t.border).child(seg("unified", "Unified")).child(seg("split", "Split")))
      .child(this.smallButton("gc-expand", "expand", "Open the diff in a wide dialog", () => this.expand(), t));
  }

  render(t) {
    const conflicts = this.conflicts(), staged = this.stagedFiles(), unstaged = this.unstagedFiles(), h = this.host.history;
    const ready = Boolean(h.root);
    const lines = (conflicts.length ? conflicts.length + 1 : 0) + staged.length + unstaged.length + 2;
    const listHeight = Math.min(lines * ROW + 8, Math.max(TITLE * 2 + ROW * 2, (this.host.height ?? 600) * 0.38));
    const stageable = unstaged.map((f) => f.path);
    const sideLabel = this.sel?.side === "staged" ? "Unstage" : "Stage";
    const actionable = Boolean(this.patch) && this.sel?.side !== "conflict";
    return v_flex().id("gc-changes").flex_1().min_h(0).w_full()
      .when(Boolean(this.op), (e) => e.child(this.opBanner(t)))
      .when(!ready, (e) => e.child(div().p(12).text_color(t.dim).child(h.state === "norepo" ? "Not a git repository" : h.state === "nofolder" ? "No folder" : h.state === "error" ? h.error : "Loading changes…")))
      .when(ready && !this.files().length, (e) => e.child(div().p(12).text_color(t.dim).child("No uncommitted changes")))
      .when(ready && this.files().length > 0, (e) => e
        .child(v_flex().id("gc-lists").flex_none().h(listHeight).overflow_y_scrollbar().px(4).py(4)
          .when(conflicts.length > 0, (el) => el.child(this.section("conflicts", "Conflicts", conflicts, "conflict", t, [])))
          .child(this.section("staged", "Staged", staged, "staged", t,
            staged.length ? [this.smallButton("gc-unstage-all", "minus", "Unstage all", (cx) => this.unstage(staged.map((f) => f.path), cx), t)] : []))
          .child(this.section("unstaged", "Changes", unstaged, "unstaged", t,
            unstaged.length ? [this.smallButton("gc-discard-all", "trash", "Discard all", (cx) => this.discard(unstaged, cx), t, true),
              this.smallButton("gc-stage-all", "plus", "Stage all", (cx) => this.stage(stageable, cx), t)] : []))))
      .when(ready && this.files().length > 0, (e) => e.child(this.diffBar(t))
        .child(this.diff.render({
          empty: this.diffNote ?? (this.sel ? "Loading diff…" : "Select a file to see its changes"),
          hunkLabel: (row) => (actionable && row.hunk >= 0 ? sideLabel : ""),
          onClick: (row) => { if (row?.kind === "@") this.hunkMenu(row); },
          onMenu: (row) => this.hunkMenu(row),
        })))
      .when(ready && !this.files().length, (e) => e.child(div().flex_1()))
      .when(ready, (e) => e.child(this.commitBox(t)));
  }
}
