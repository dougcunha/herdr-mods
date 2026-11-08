import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, nextCommand, shared, setShared, props, closeOverlay } from "herdr";

// The mods-hub can turn this mod off (shared "herdr-mods.disabled", a list of mod names). Then the mod draws
// nothing, closes its dialog and skips its timed work. The bars hide its blocks and buttons.
const kitOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes("changes-split"); };
const offView = () => { const o = props()?.overlay; if (o) closeOverlay(o); return div(); };

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

// Puts the old file on the left and the new file on the right. A run of "-" lines and the run of
// "+" lines after it share rows; the shorter run gets empty cells. Context lines show on both sides.
function splitRows(lines) {
  const rows = [];
  let old = 0, next = 0, removed = [], added = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push({ left: removed[i] ?? null, right: added[i] ?? null });
    removed = []; added = [];
  };
  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { flush(); old = +match[1]; next = +match[2]; rows.push({ kind: "@", text: line }); continue; }
    const kind = line[0], text = line.slice(1) || " ";
    if (kind === "-") removed.push({ kind, number: old++, text });
    else if (kind === "+") added.push({ kind, number: next++, text });
    else if (kind === " ") { flush(); rows.push({ left: { kind, number: old++, text }, right: { kind, number: next++, text } }); }
    else { flush(); rows.push({ kind: "", text: line }); }
  }
  flush();
  return rows;
}

// Cuts a line into pieces of at most `width` characters, so a long line wraps inside its half.
function wrap(text, width) {
  const pieces = [];
  for (let i = 0; i < text.length; i += width) pieces.push(text.slice(i, i + width));
  return pieces.length ? pieces : [" "];
}

// The view is one shared value, so every copy of the panel (side panel, dialog, other layouts) shows the same.
const VIEW_KEY = "changes-split.view";
const currentView = () => shared(VIEW_KEY) === "split" ? "split" : "unified";
const CHAR = 7; // px of 1 character of the 11 px diff font, rounded up

// The dialog that shows this panel: its own overlay, or the dock's panel dialog; null in the side panel.
const dialogId = () => props()?.overlay ?? shared("kanban.panelDialog")?.id ?? null;

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.split = []; this.diffWidth = 0; this.diffArea = 0; this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => kitOff() || this.refresh(cx));
    // "changes-split.split", ".unified" and ".toggle" set the view, as the switch in the header does.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = String(await nextCommand());
        if (command === "split" || command === "unified") this.setView(command, cx);
        else if (command === "toggle") this.setView(currentView() === "split" ? "unified" : "split", cx);
      }
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.split = splitRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  // Split has no horizontal scroll: each half gets half of the visible width, and a long line wraps
  // into more rows of 20 px. The result is kept until the lines or the width change.
  splitLayout() {
    const half = ((this.diffArea || 600) - 1) / 2;
    const width = Math.max(8, Math.floor((half - 46) / CHAR)); // 30 px numbers, 10 px gap, 6 px margin
    if (this.wrapped?.rows !== this.split || this.wrapped.width !== width) {
      const items = this.split.map((row) => {
        if ("text" in row) return { row, lines: 1 };
        const left = row.left ? wrap(row.left.text, width) : [], right = row.right ? wrap(row.right.text, width) : [];
        return { row, left, right, lines: Math.max(left.length, right.length, 1) };
      });
      this.wrapped = { rows: this.split, width, items, sizes: items.map((item) => item.lines * 20) };
    }
    return this.wrapped;
  }

  setView(view, cx) {
    if (currentView() !== view) setShared(VIEW_KEY, view); // re-renders every copy
    cx.notify();
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  splitCell(cell, pieces, t) {
    return h_flex().flex_1().min_w(0).h_full().items_start().gap(10)
      .when(!cell, (e) => e.bg(t.foreground + "08"))
      .when(cell?.kind === "+", (e) => e.bg(t.ansi2 + "18")).when(cell?.kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(h_flex().w(30).h(20).flex_none().justify_end().text_color(t.dim).child(cell ? String(cell.number) : ""))
      .child(v_flex().flex_1().min_w(0).children(pieces.map((piece) => h_flex().h(20).flex_none().min_w(0).child(div().flex_1().min_w(0).truncate().child(piece)))));
  }

  splitRow({ row, left, right, lines }, t) {
    if ("text" in row) return this.diffRow(row, t);
    return h_flex().w_full().h(lines * 20).flex_none()
      .child(this.splitCell(row.left, left, t))
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(this.splitCell(row.right, right, t));
  }

  viewToggle(t, current) {
    return h_flex().flex_none().h(24).p(2).gap(2).rounded(6).border_1().border_color(t.border)
      .children([["unified", "Unified"], ["split", "Split"]].map(([view, label]) => {
        const active = current === view;
        return div().id(`changes-view-${view}`).h_full().px(7).flex().items_center().rounded(4).text_size(11)
          .text_color(active ? t.foreground : t.muted).when(active, (e) => e.bg(t.selected))
          .when(!active, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => this.setView(view, cx)).child(label);
      }));
  }

  render(cx) {
    if (kitOff()) return offView();
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const view = currentView(), split = view === "split", layout = split ? this.splitLayout() : null, rows = split ? layout.items : this.rows;
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      // In a dialog, a click in the panel gives it the keyboard (the commit field stops its own
      // mouse down): else no part of the dialog has it after the click, and Esc does nothing.
      .on_mouse_down("left", () => { if (dialogId()) this.handle.focus(); })
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        const dialog = dialogId();
        if (!this.typing) { if (!dialog) return; closeOverlay(dialog); cx.stop_propagation(); return; }
        // An empty message in a dialog: Esc closes the dialog (the field keeps Esc from Herdr).
        // Else Esc leaves the field, and the next Esc closes the dialog.
        if (!this.input.value().trim() && dialog) closeOverlay(dialog);
        else { this.typing = false; this.handle.focus(); cx.notify(); }
        cx.stop_propagation();
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1()).child(this.viewToggle(t, view)).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .child(v_flex().id("changes-list").flex_none().h(Math.min(200, Math.max(44, this.files.length * 28 + 12))).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().id("changes-diff-area").flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        // on_size_change reports the width with the app zoom applied; w() and the text use unzoomed px.
        .on_size_change((size, cx) => {
          const zoom = Number(settings()?.zoom) > 0 ? Number(settings().zoom) : 1, width = Math.round(size.width / zoom);
          if (width !== this.diffArea) { this.diffArea = width; if (currentView() === "split") cx.notify(); }
        })
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(split ? 0 : this.diffWidth).h_full().child(v_virtual_list("changes-diff", rows.length, split ? layout.sizes : 20, (i) => String(i),
            (range) => rows.slice(range.start, range.end).map((row) => split ? this.splitRow(row, t) : this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
