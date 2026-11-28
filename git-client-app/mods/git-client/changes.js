// The Changes tab: the files in conflict, staged and not staged, the diff of one of them with its
// hunks, and the commit box (amend, commit all, push after, AI message).
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, TextareaState, Textarea, h_resizable, resizable_panel } from "gpui-base";
import { exec, readTextFile, theme, notify, openOverlay, setShared } from "herdr";
import { READ, PATCH, parsePatch, hunkPatch, patchRows, newFileRows, menuFor, menuHeight, opPathArgs, opOf, OP_FILES, gitError, isImagePath, isSvgPath, parseUnmerged } from "./git.js";
import { perform, openDialog, openErrorDialog, atEvent } from "./act.js";
import { describeError } from "./errors.js";
import { icon } from "./menu.js";
import { DiffView, VIEW_KEY, currentView } from "./diffview.js";
import { ImageDiffView, sweepStagedImages } from "./imageview.js";
import { generateMessage } from "./ai.js";
import { emptySelection, isPicked, clickRow, clickCheckbox, selectAll, pruneSelection, selectedFiles, stepIndex } from "./selection.js";

const ROW = 26, TITLE = 28;
// Rows shown in one list: the lists are plain rows, not a virtual list.
const SHOWN = 300;
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
    this.staged = new Map(); this.unstaged = new Map(); this.op = null; this.opSides = null;
    this.sel = null; this.picked = emptySelection(); this.closed = false; this.patch = null; this.diffNote = null;
    this.diff = new DiffView(`gc-diff-${Math.random().toString(36).slice(2)}`);
    this.image = new ImageDiffView(`gc-img-${Math.random().toString(36).slice(2)}`);
    this.listScroll = ScrollHandle.new();
    this.imageAsText = false;
    cx.spawn(async () => { await sweepStagedImages(); });
    this.amend = false; this.all = false; this.push = false; this.hover = null;
    this.message = "";
    this.input = TextareaState.new({ placeholder: "Commit message", rows: 2 });
    this.input.set_auto_grow(2, 8);
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.input.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    // Ctrl+Enter (Cmd+Enter) commits; a plain Enter is a new line of the message.
    this.input.on("submit", (e, cx) => { if (e?.secondary) this.commit(cx); });
    this.input.on("focus", (_e, cx) => { this.host.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.host.typing = false; cx.notify(); });
  }

  files() { return this.host.history.files ?? []; }
  conflicts() { return this.files().filter((f) => f.conflict); }
  stagedFiles() { return this.files().filter((f) => f.staged); }
  unstagedFiles() { return this.files().filter((f) => f.unstaged); }
  listsBySide() { return { conflict: this.conflicts(), staged: this.stagedFiles(), unstaged: this.unstagedFiles() }; }

  // A new folder: nothing of the old one stays.
  resetFolder() {
    this.staged = new Map(); this.unstaged = new Map(); this.op = null; this.opSides = null; this.sel = null; this.picked = emptySelection(); this.closed = false;
    this.patch = null; this.diff.setRows([]); this.image.clear(); this.imageAsText = false; this.diffNote = null; this.amend = false; this.all = false;
    this.message = ""; this.input.set_value("");
  }

  dispose() { return this.image?.dispose?.(); }

  showingImage() {
    return Boolean(this.sel && isImagePath(this.sel.path) && !(isSvgPath(this.sel.path) && this.imageAsText));
  }

  // After every read of the repository: the counts, the operation in progress and the shown diff.
  reload(cx) {
    const h = this.host.history, root = h.root, on = h.on, context = h.context;
    if (context !== this.context) { this.context = context; this.resetFolder(); }
    // No cx.notify() here: reload can run inside a render (a new folder), and a render follows anyway.
    if (!root) return;
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
        this.opSides = this.op ? await this.loadOpSides(git, this.op, found) : null;
        if (stale()) return;
        this.picked = pruneSelection(this.picked, this.listsBySide());
        const files = this.files();
        if (this.sel && !files.some((f) => f.path === this.sel.path && this.sideOf(f, this.sel.side))) { this.sel = null; this.patch = null; this.diff.setRows([]); this.image.clear(); this.imageAsText = false; }
        // The first file shows until you pick another, as in Herdr's Changes panel.
        if (!this.sel && !this.closed) {
          const first = this.conflicts()[0] ? { f: this.conflicts()[0], side: "conflict" } : this.stagedFiles()[0] ? { f: this.stagedFiles()[0], side: "staged" }
            : this.unstagedFiles()[0] ? { f: this.unstagedFiles()[0], side: "unstaged" } : null;
          if (first) this.sel = { path: first.f.path, side: first.side };
        }
        if (this.sel) await this.loadDiff(cx, seq, true);
      } catch (e) { if (!stale()) this.diffNote = String(e?.message ?? e); }
      cx.notify();
    });
  }

  sideOf(f, side) { return side === "conflict" ? f.conflict : side === "staged" ? f.staged : f.unstaged; }

  async loadOpSides(git, op, found) {
    const theirsRef = { merge: "MERGE_HEAD", rebase: "REBASE_HEAD", "cherry-pick": "CHERRY_PICK_HEAD", revert: "REVERT_HEAD" }[op];
    const readSide = async (target, fallbackRef = null) => {
      if (!target) return { ref: fallbackRef, hash: null, subject: null };
      const [metaRes, nameRes] = await Promise.all([
        git(["show", "-s", "--format=%h%x1f%D%x1f%s", target]).catch(() => null),
        git(["name-rev", "--name-only", "--always", "--no-undefined", target]).catch(() => null),
      ]);
      if (!metaRes || metaRes.code !== 0) return { ref: fallbackRef, hash: null, subject: null };
      const [hash, dec, subject] = metaRes.stdout.trimEnd().split("\x1f");
      let local = null, tag = null, remote = null;
      for (const raw of (dec ?? "").split(", ").filter(Boolean)) {
        if (raw === "HEAD") continue;
        if (raw.startsWith("HEAD -> ")) { local ??= raw.slice(8); continue; }
        if (raw.startsWith("tag: ")) { tag ??= raw.slice(5); continue; }
        if (!raw.includes("/")) local ??= raw;
        else if (!raw.endsWith("/HEAD")) remote ??= raw;
      }
      const cleanName = nameRes?.code === 0
        ? nameRes.stdout.trim().replace(/^remotes\//, "").replace(/^tags\//, "")
        : null;
      const ref = fallbackRef ?? local ?? tag ?? remote ?? (cleanName && cleanName !== "undefined" && cleanName !== hash ? cleanName : null);
      return { ref, hash: hash || null, subject: (subject ?? "").trim() || null };
    };
    const [headBranchRes, ours] = await Promise.all([
      git(["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => null),
      readSide("HEAD"),
    ]);
    if (headBranchRes?.code === 0 && headBranchRes.stdout.trim()) ours.ref = headBranchRes.stdout.trim();
    const rebaseHead = op === "rebase" ? (found.rebase || found["rebase-apply"] || "").trim().replace(/^refs\/heads\//, "") : null;
    const theirs = await readSide(theirsRef, rebaseHead || null);
    return { ours, theirs };
  }

  async loadDiff(cx, seq = this.seq, keepCurrent = false) {
    const h = this.host.history, root = h.root, on = h.on, sel = this.sel;
    const file = this.files().find((f) => f.path === sel?.path);
    if (!file || !root) return;
    if (this.showingImage()) {
      this.patch = null; this.diff.setRows([]); this.diffNote = null;
      await this.image.load({ root, on, file, side: sel.side, keepCurrent });
      return;
    }
    this.image.clear();
    const git = (args) => exec("git", [...READ, "--literal-pathspecs", ...args], { cwd: root, on });
    let rows, patch = null, note = null;
    try {
      if (sel.side === "unstaged" && file.untracked) {
        rows = newFileRows(await readTextFile(`${root}/${file.path}`, { on }).catch(() => null));
      } else if (sel.side === "conflict") {
        const ls = await git(["ls-files", "--unmerged", "-z", "--", file.path]);
        const entry = ls.code === 0 ? parseUnmerged(ls.stdout).get(file.path) : null;
        const ours = entry?.[2], theirs = entry?.[3];
        if (ours?.mode === "160000" || theirs?.mode === "160000") {
          const subSubject = async (hash) => {
            if (!hash) return null;
            const res = await exec("git", [...READ, "show", "-s", "--format=%s", hash], { cwd: `${root}/${file.path}`, on }).catch(() => null);
            return res?.code === 0 ? res.stdout.trim() : null;
          };
          const [oursSubj, theirsSubj] = await Promise.all([subSubject(ours?.hash), subSubject(theirs?.hash)]);
          rows = [
            { kind: "@", text: "@@ Submodule conflict @@", hunk: -1 },
            ours
              ? { kind: "-", number: 1, text: `Subproject commit ${ours.hash}${oursSubj ? ` — ${oursSubj}` : ""}`, hunk: -1 }
              : { kind: "-", number: 1, text: "(deleted in ours)", hunk: -1 },
            theirs
              ? { kind: "+", number: 1, text: `Subproject commit ${theirs.hash}${theirsSubj ? ` — ${theirsSubj}` : ""}`, hunk: -1 }
              : { kind: "+", number: 1, text: "(deleted in theirs)", hunk: -1 },
          ];
        } else if (ours && theirs) {
          const r = await git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", `:2:${file.path}`, `:3:${file.path}`]);
          rows = patchRows(r.stdout);
          if (!rows) {
            const fallback = await git(["diff", "--no-color", "--no-ext-diff", "--", file.path]);
            rows = patchRows(fallback.stdout) ?? [{ kind: "", text: "No text diff (binary or identical sides)" }];
          }
        } else if (ours && !theirs) {
          const r = await git(["show", `:2:${file.path}`]);
          if (r.code !== 0 || r.stdout.includes("\0")) rows = [{ kind: "", text: "Deleted in theirs (binary or unreadable in ours)" }];
          else {
            const lines = r.stdout.replace(/\n$/, "").split("\n").slice(0, 3000);
            rows = [{ kind: "@", text: "@@ Deleted in theirs (kept in ours) @@", hunk: -1 },
              ...lines.map((l, i) => ({ kind: "-", number: i + 1, text: (l.length > 2000 ? l.slice(0, 2000) + "…" : l) || " ", hunk: -1 }))];
          }
        } else if (!ours && theirs) {
          const r = await git(["show", `:3:${file.path}`]);
          if (r.code !== 0 || r.stdout.includes("\0")) rows = [{ kind: "", text: "Deleted in ours (binary or unreadable in theirs)" }];
          else {
            const lines = r.stdout.replace(/\n$/, "").split("\n").slice(0, 3000);
            rows = [{ kind: "@", text: "@@ Deleted in ours (present in theirs) @@", hunk: -1 },
              ...lines.map((l, i) => ({ kind: "+", number: i + 1, text: (l.length > 2000 ? l.slice(0, 2000) + "…" : l) || " ", hunk: -1 }))];
          }
        } else {
          const r = await git(["diff", "--no-color", "--no-ext-diff", "--", file.path]);
          rows = patchRows(r.stdout) ?? [{ kind: "", text: "No text diff (a deleted or binary file in conflict)" }];
        }
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

  pick(f, side, e, cx) {
    const next = clickRow(this.picked, {
      path: f.path,
      side,
      list: this.listsBySide()[side],
      currentSel: this.sel,
      modifiers: e?.modifiers,
    });
    this.picked = next.state;
    this.closed = next.closed;
    const changed = next.open?.path !== this.sel?.path || next.open?.side !== this.sel?.side;
    if (changed) {
      this.sel = next.open;
      this.patch = null; this.diff.setRows([]); this.image.clear(); this.imageAsText = false; this.diffNote = null;
      if (this.sel) { const seq = this.seq; cx.spawn(async (cx) => { await this.loadDiff(cx, seq); cx.notify(); }); }
    }
    cx.notify();
  }

  toggleCheck(f, side, e, cx) {
    this.picked = clickCheckbox(this.picked, { path: f.path, side, list: this.listsBySide()[side], modifiers: e?.modifiers });
    cx.notify();
  }

  selectAllIn(side, cx) {
    if (!side) return;
    this.picked = selectAll(this.listsBySide()[side], side);
    cx.notify();
  }

  selectAllCurrent(cx) {
    const side = this.picked.side ?? this.sel?.side
      ?? (this.unstagedFiles().length ? "unstaged" : this.stagedFiles().length ? "staged" : this.conflicts().length ? "conflict" : null);
    this.selectAllIn(side, cx);
  }

  clearSelection(cx) {
    if (!this.picked.paths.size) return false;
    this.picked = emptySelection();
    cx.notify();
    return true;
  }

  escape(cx) { return this.clearSelection(cx); }

  sectionSpecs() {
    const conflicts = this.conflicts(), staged = this.stagedFiles(), unstaged = this.unstagedFiles();
    const list = [];
    if (conflicts.length > 0) list.push({ id: "conflicts", title: "Conflicts", files: conflicts, side: "conflict" });
    list.push({ id: "staged", title: "Staged", files: staged, side: "staged" });
    list.push({ id: "unstaged", title: "Changes", files: unstaged, side: "unstaged" });
    return list;
  }

  listNav() {
    const nav = [];
    let childIndex = 0;
    for (const s of this.sectionSpecs()) {
      childIndex++; // section heading
      const shown = s.files.slice(0, SHOWN);
      for (const file of shown) nav.push({ file, side: s.side, childIndex: childIndex++ });
      if (s.files.length > SHOWN) childIndex++; // overflow notice
    }
    return nav;
  }

  moveFile(step, cx) {
    const nav = this.listNav();
    if (!nav.length) return false;
    const cur = this.sel ? nav.findIndex((item) => item.file.path === this.sel.path && item.side === this.sel.side) : -1;
    const nextIdx = stepIndex(cur, nav.length, step);
    const target = nav[nextIdx];
    if (!target) return false;
    this.picked = emptySelection();
    this.closed = false;
    const changed = target.file.path !== this.sel?.path || target.side !== this.sel?.side;
    if (changed) {
      this.sel = { path: target.file.path, side: target.side };
      this.patch = null; this.diff.setRows([]); this.image.clear(); this.imageAsText = false; this.diffNote = null;
      const seq = this.seq;
      cx.spawn(async (cx) => { await this.loadDiff(cx, seq); cx.notify(); });
    }
    this.listScroll.scroll_to_item(target.childIndex === 1 && step < 0 ? 0 : target.childIndex);
    cx.notify();
    return true;
  }

  focusPath(path, cx) {
    const f = this.files().find((x) => x.path === path);
    if (!f) return false;
    const side = f.unstaged ? "unstaged" : f.staged ? "staged" : f.conflict ? "conflict" : null;
    if (!side) return false;
    this.sel = { path, side };
    this.closed = false;
    this.patch = null; this.diff.setRows([]); this.image.clear(); this.imageAsText = false; this.diffNote = null;
    const seq = this.seq;
    cx.spawn(async (cx) => { await this.loadDiff(cx, seq); cx.notify(); });
    cx.notify();
    return true;
  }

  setImageAsText(asText, cx) {
    if (this.imageAsText === asText || !this.sel) return;
    this.imageAsText = asText;
    this.patch = null; this.diff.setRows([]); this.diffNote = null;
    if (asText) this.image.clear();
    const seq = this.seq;
    cx.spawn(async (cx) => { await this.loadDiff(cx, seq); cx.notify(); });
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
  resolveConflict(side, paths, cx) {
    if (!paths.length) return;
    const label = side === "ours" ? (this.opSides?.ours?.ref ?? null) : (this.opSides?.theirs?.ref ?? null);
    this.run({ type: "resolveConflict", side, paths, label }, cx, { quiet: false });
  }
  discard(files, cx) {
    const paths = files.filter((f) => !f.untracked).map((f) => f.path), untracked = files.filter((f) => f.untracked).map((f) => f.path);
    if (paths.length || untracked.length) this.run({ type: "discard", paths, untracked }, cx);
  }

  fileMenu(f, side, e) {
    const ctx = this.ctx();
    if (!ctx) return;
    const menuCtx = { ...ctx, opSides: this.opSides };
    const lists = this.listsBySide();
    this.picked = pruneSelection(this.picked, lists);
    const selected = selectedFiles(this.picked, lists);
    if (isPicked(this.picked, side, f.path) && selected.length > 1) {
      const target = {
        kind: "files",
        side,
        files: selected.map((x) => ({ path: x.path, untracked: x.untracked, status: x.status, x: x.x })),
      };
      const items = menuFor(target, menuCtx);
      openOverlay({ mod: "git-client", kind: "popup", at: atEvent(e), width: 250, height: menuHeight(items), props: { role: "menu", target, ctx: menuCtx } });
      return;
    }
    const target = { kind: "file", side, file: { path: f.path, untracked: f.untracked, status: f.status, x: f.x } }, items = menuFor(target, menuCtx);
    openOverlay({ mod: "git-client", kind: "popup", at: atEvent(e), width: 240, height: menuHeight(items), props: { role: "menu", target, ctx: menuCtx } });
  }

  // A hunk of the shown diff: its menu (stage, unstage, discard).
  hunkMenu(row, e) {
    const ctx = this.ctx(), sel = this.sel;
    if (!ctx || !this.patch || !row || !(row.hunk >= 0) || !this.patch.hunks[row.hunk] || sel?.side === "conflict") return;
    const target = { kind: "hunk", side: sel.side, path: sel.path, hunk: row.hunk, patch: hunkPatch(this.patch, row.hunk) }, items = menuFor(target, ctx);
    openOverlay({ mod: "git-client", kind: "popup", at: atEvent(e), width: 220, height: menuHeight(items), props: { role: "menu", target, ctx } });
  }

  // The agent dialog, with the other side of the operation by name when git knows it.
  resolveWithAgent(cx) {
    const ctx = this.ctx(), op = this.op;
    if (!ctx || !op) return;
    const files = this.conflicts().map((f) => f.path);
    const head = { merge: "MERGE_HEAD", "cherry-pick": "CHERRY_PICK_HEAD", revert: "REVERT_HEAD", rebase: "REBASE_HEAD" }[op];
    cx.spawn(async () => {
      const r = await exec("git", [...READ, "name-rev", "--name-only", "--always", "--no-undefined", head], { cwd: ctx.root, on: ctx.on }).catch(() => null);
      const theirs = r?.code === 0 ? r.stdout.trim().replace(/^remotes\//, "") : null;
      openOverlay({ mod: "git-client", kind: "dialog", width: 640, height: 560, props: { role: "agent", ctx, op, files, theirs } });
    });
  }

  expand() {
    if (!this.sel) return;
    if (this.showingImage()) {
      const h = this.host.history, file = this.files().find((f) => f.path === this.sel.path);
      if (!h.root || !file) return;
      openOverlay({ mod: "git-client", kind: "dialog", width: 1100, height: 720,
        props: { role: "diff", title: this.sel.path, side: this.sel.side, image: { root: h.root, on: h.on, file, side: this.sel.side } } });
      return;
    }
    if (!this.diff.rows.length) return;
    openOverlay({ mod: "git-client", kind: "dialog", width: 1100, height: 720,
      props: { role: "diff", title: this.sel.path, side: this.sel.side, rows: this.diff.rows, sides: this.diffSides() } });
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
        openErrorDialog(describeError({ type: "aiMessage" }, String(e?.message ?? e)), this.ctx());
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
    const checked = isPicked(this.picked, side, f.path);
    const stat = side === "staged" ? this.staged.get(f.path) : side === "unstaged" ? this.unstaged.get(f.path) : null;
    const letter = side === "conflict" ? "U" : f.untracked ? "U" : side === "staged" ? f.x : f.y;
    const color = side === "conflict" ? t.ansi1 : f.untracked || letter === "A" ? t.ansi2 : letter === "D" ? t.ansi1 : t.blocked;
    const hovered = this.hover === key;
    return h_flex().id(`gc-f-${key}`).h(ROW).flex_none().pl(8).pr(6).gap(6).items_center().rounded(6).cursor_pointer()
      .when(checked, (e) => e.bg(t.accent + "22"))
      .when(!checked && open, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_hover((h, cx) => { const next = h ? key : this.hover === key ? null : this.hover; if (next !== this.hover) { this.hover = next; cx.notify(); } })
      .on_click((e, cx) => this.pick(f, side, e, cx))
      .on_mouse_down("right", (e, cx) => { cx.stop_propagation(); this.fileMenu(f, side, e); })
      .child(h_flex().id(`gc-fc-${key}`).size(16).flex_none().items_center().justify_center().cursor_pointer()
        .on_click((e, cx) => { cx.stop_propagation(); this.toggleCheck(f, side, e, cx); })
        .child(div().size(13).rounded(3).border_1().border_color(checked ? t.accent : t.input)
          .when(checked, (e) => e.bg(t.accent))
          .flex().items_center().justify_center()
          .when(checked, (e) => e.child(svg(icon("check")).size(9).text_color(t.accent_foreground)))))
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

  selectionBar(t, selected, side, total) {
    const n = selected.length;
    const sectionLabel = { unstaged: "changes", staged: "staged", conflict: "conflicts" }[side] ?? "";
    const allUntracked = side === "unstaged" && selected.every((f) => f.untracked);
    const chipBtn = (id, label, tone, onClick) => h_flex().id(id).h(22).px(8).flex_none().items_center().rounded(5).cursor_pointer()
      .text_size(11).font_medium()
      .bg(tone === "primary" ? t.solid : t.raised)
      .border_1().border_color(tone === "primary" ? t.solid : tone === "danger" ? t.ansi1 + "55" : t.border)
      .text_color(tone === "primary" ? t.solid_foreground : tone === "danger" ? t.ansi1 : t.foreground)
      .hover((s) => s.opacity(0.88))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(label);
    const linkBtn = (id, label, onClick) => div().id(id).px(5).py(2).rounded(4).cursor_pointer()
      .text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(label);
    return h_flex().id("gc-sel-bar").h(32).flex_none().px(10).gap(6).items_center()
      .bg(t.accent + "14").border_b(1).border_color(t.border)
      .child(div().flex_none().text_size(11.5).font_semibold().text_color(t.foreground).child(`${n} selected`))
      .child(div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(sectionLabel))
      .when(n < total, (el) => el.child(linkBtn("gc-sel-all", "All", (cx) => this.selectAllIn(side, cx))))
      .child(linkBtn("gc-sel-clear", "Clear", (cx) => this.clearSelection(cx)))
      .child(div().flex_1())
      .when(side === "unstaged", (el) => el
        .child(chipBtn("gc-sel-discard", allUntracked ? "Delete" : "Discard", "danger", (cx) => this.discard(selected, cx)))
        .child(chipBtn("gc-sel-stage", "Stage", "primary", (cx) => this.stage(selected.map((f) => f.path), cx))))
      .when(side === "staged", (el) => el
        .child(chipBtn("gc-sel-unstage", "Unstage", "default", (cx) => this.unstage(selected.map((f) => f.path), cx))))
      .when(side === "conflict", (el) => el
        .child(chipBtn("gc-sel-ours", "Keep ours", "default", (cx) => this.resolveConflict("ours", selected.map((f) => f.path), cx)))
        .child(chipBtn("gc-sel-theirs", "Accept theirs", "default", (cx) => this.resolveConflict("theirs", selected.map((f) => f.path), cx)))
        .child(chipBtn("gc-sel-resolve", "Mark resolved", "primary", (cx) => this.stage(selected.map((f) => f.path), cx))));
  }

  listEntries(t, actionsBySide) {
    const out = [];
    for (const { title, files, side } of this.sectionSpecs()) {
      out.push(h_flex().h(TITLE).flex_none().pl(10).pr(6).gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().font_semibold().child(title.toUpperCase())).child(div().child(String(files.length))).child(div().flex_1())
        .children(actionsBySide[side] ?? []));
      for (const f of files.slice(0, SHOWN)) out.push(this.fileRow(f, side, t));
      if (files.length > SHOWN) {
        out.push(div().h(ROW).flex_none().px(10).flex().items_center().text_size(11).text_color(t.dim)
          .child(`and ${files.length - SHOWN} more (the "all" buttons act on every file)`));
      }
    }
    return out;
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
      .when(conflicts > 0, (e) => e.child(button("gc-op-agent", "Resolve with agent", false, true, (cx) => this.resolveWithAgent(cx))))
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

  diffSides() {
    const sel = this.sel, h = this.host.history;
    if (!sel) return null;
    if (sel.side === "conflict") {
      return {
        left: {
          badge: "Ours",
          ref: this.opSides?.ours?.ref ?? h.current ?? "HEAD",
          hash: this.opSides?.ours?.hash ?? (h.head ? h.head.slice(0, 8) : null),
          subject: this.opSides?.ours?.subject ?? null,
          tone: "removed",
        },
        right: {
          badge: "Theirs",
          ref: this.opSides?.theirs?.ref ?? "Incoming",
          hash: this.opSides?.theirs?.hash ?? null,
          subject: this.opSides?.theirs?.subject ?? null,
          tone: "added",
        },
      };
    }
    if (sel.side === "staged") {
      const idx = h.head ? h.index.get(h.head) : undefined;
      const headCommit = idx !== undefined ? h.commits[idx] : null;
      return {
        left: {
          badge: "HEAD",
          ref: h.current ?? null,
          hash: h.head ? h.head.slice(0, 8) : null,
          subject: headCommit?.subject ?? null,
          tone: "removed",
        },
        right: { badge: "Staged", ref: "Index", hash: null, subject: null, tone: "added" },
      };
    }
    const file = this.files().find((f) => f.path === sel.path);
    return {
      left: file?.untracked
        ? { badge: "Empty", ref: null, hash: null, subject: "New untracked file", tone: "removed" }
        : { badge: "Staged", ref: "Index", hash: null, subject: null, tone: "removed" },
      right: { badge: "Working", ref: "Working tree", hash: null, subject: null, tone: "added" },
    };
  }

  conflictActionBar(t) {
    const sel = this.sel;
    if (sel?.side !== "conflict") return div();
    const ours = this.opSides?.ours, theirs = this.opSides?.theirs;
    const oursLabel = ours?.ref ? `Keep ours (${ours.ref})` : "Keep ours";
    const theirsLabel = theirs?.ref ? `Accept theirs (${theirs.ref})` : "Accept theirs";
    const btn = (id, label, color, tip, action) => h_flex().id(id).h(22).px(8).flex_none().items_center().rounded(5)
      .border_1().border_color(color ? color + "55" : t.border).bg(color ? color + "16" : t.raised)
      .text_size(11).font_medium().text_color(color ?? t.foreground).cursor_pointer().tooltip(tip)
      .hover((s) => s.bg(color ? color + "28" : t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => action(cx))
      .child(label);
    return h_flex().id("gc-conflict-actions").h(30).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border).bg(t.background)
      .child(btn("gc-keep-ours", oursLabel, t.ansi1,
        [ours?.ref ?? "Current branch (HEAD)", ours?.hash, ours?.subject].filter(Boolean).join(" · "),
        (cx) => this.resolveConflict("ours", [sel.path], cx)))
      .child(btn("gc-accept-theirs", theirsLabel, t.ansi2,
        [theirs?.ref ?? "Incoming branch", theirs?.hash, theirs?.subject].filter(Boolean).join(" · "),
        (cx) => this.resolveConflict("theirs", [sel.path], cx)))
      .child(div().flex_1())
      .child(btn("gc-mark-resolved", "Mark resolved", t.accent, "Stage the file as-is on disk",
        (cx) => this.stage([sel.path], cx)));
  }

  diffBar(t) {
    const sel = this.sel, view = currentView(), showImg = this.showingImage(), isSvg = Boolean(sel && isSvgPath(sel.path));
    const seg = (v, label) => div().id(`gc-view-${v}`).h_full().px(7).flex().items_center().rounded(4).text_size(11)
      .text_color(view === v ? t.foreground : t.muted).when(view === v, (e) => e.bg(t.selected))
      .when(view !== v, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))).on_click(() => setShared(VIEW_KEY, v)).child(label);
    const modeSeg = (asText, label) => div().id(`gc-svg-${asText ? "diff" : "img"}`).h_full().px(7).flex().items_center().rounded(4).text_size(11)
      .text_color(this.imageAsText === asText ? t.foreground : t.muted).when(this.imageAsText === asText, (e) => e.bg(t.selected))
      .when(this.imageAsText !== asText, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))).on_click((_e, cx) => this.setImageAsText(asText, cx)).child(label);
    const parts = sel ? sel.path.split("/") : [], name = parts.pop();
    return h_flex().h(32).flex_none().px(10).gap(8).items_center().border_t(1).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(sel ? t.foreground : t.dim).child(sel ? name : "No file"))
      .when(Boolean(sel), (e) => e.child(div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
        .child(sel.side === "staged" ? "staged" : sel.side === "conflict" ? "conflict" : "unstaged")))
      .when(isSvg, (e) => e.child(h_flex().flex_none().h(24).p(2).gap(2).rounded(6).border_1().border_color(t.border).child(modeSeg(false, "Image")).child(modeSeg(true, "Diff"))))
      .when(!showImg || this.image.hasPair(), (e) => e.child(h_flex().flex_none().h(24).p(2).gap(2).rounded(6).border_1().border_color(t.border).child(seg("unified", "Unified")).child(seg("split", "Split"))))
      .child(this.smallButton("gc-expand", "expand", showImg ? "Open the image in a wide dialog" : "Open the diff in a wide dialog", () => this.expand(), t));
  }

  render(t) {
    const conflicts = this.conflicts(), staged = this.stagedFiles(), unstaged = this.unstagedFiles(), h = this.host.history;
    const lists = { conflict: conflicts, staged, unstaged };
    const selected = selectedFiles(this.picked, lists);
    const selSide = selected.length ? this.picked.side : null;
    const totalInSide = selSide ? (lists[selSide]?.length ?? 0) : 0;
    const ready = Boolean(h.root);
    const shown = (n) => Math.min(n, SHOWN + 1);
    const lines = (conflicts.length ? shown(conflicts.length) + 1 : 0) + shown(staged.length) + shown(unstaged.length) + 2;
    const listHeight = Math.min(lines * ROW + 8, Math.max(TITLE * 2 + ROW * 2, (this.host.height ?? 600) * 0.38));
    const stageable = unstaged.map((f) => f.path);
    const sideLabel = this.sel?.side === "staged" ? "Unstage" : "Stage";
    const actionable = Boolean(this.patch) && this.sel?.side !== "conflict";
    return v_flex().id("gc-changes").flex_1().min_h(0).w_full()
      .when(Boolean(this.op), (e) => e.child(this.opBanner(t)))
      .when(!ready, (e) => e.child(div().p(12).text_color(t.dim).child(h.state === "norepo" ? "Not a git repository" : h.state === "nofolder" ? "No folder" : h.state === "error" ? h.error : "Loading changes…")))
      .when(ready && !this.files().length, (e) => e.child(div().p(12).text_color(t.dim).child("No uncommitted changes")))
      .when(ready && this.files().length > 0 && selected.length > 0, (e) => e.child(this.selectionBar(t, selected, selSide, totalInSide)))
      .when(ready && this.files().length > 0, (e) => e
        .child(v_flex().id("gc-lists").flex_none().h(listHeight).overflow_y_scrollbar().track_scroll(this.listScroll).px(4).py(4)
          .children(this.listEntries(t, {
            conflict: [],
            staged: staged.length ? [this.smallButton("gc-unstage-all", "minus", "Unstage all", (cx) => this.unstage(staged.map((f) => f.path), cx), t)] : [],
            unstaged: unstaged.length ? [this.smallButton("gc-discard-all", "trash", "Discard all", (cx) => this.discard(unstaged, cx), t, true),
              this.smallButton("gc-stage-all", "plus", "Stage all", (cx) => this.stage(stageable, cx), t)] : [],
          }))))
      .when(ready && this.files().length > 0, (e) => e.child(this.diffBar(t))
        .when(this.sel?.side === "conflict", (el) => el.child(this.conflictActionBar(t)))
        .child(this.showingImage() ? this.image.render() : this.diff.render({
          empty: this.diffNote ?? (this.sel ? "Loading diff…" : "Select a file to see its changes"),
          hunkLabel: (row) => (actionable && row.hunk >= 0 ? sideLabel : ""),
          onClick: (row, e) => { if (row?.kind === "@") this.hunkMenu(row, e); },
          onMenu: (row, e) => this.hunkMenu(row, e),
          sides: this.diffSides(),
        })))
      .when(ready && !this.files().length, (e) => e.child(div().flex_1()))
      .when(ready, (e) => e.child(this.commitBox(t)));
  }

  // Two-column layout for the wide Bottom Inspector: file lists + commit box on left, diff on right.
  renderWide(t) {
    const conflicts = this.conflicts(), staged = this.stagedFiles(), unstaged = this.unstagedFiles(), h = this.host.history;
    const lists = { conflict: conflicts, staged, unstaged };
    const selected = selectedFiles(this.picked, lists);
    const selSide = selected.length ? this.picked.side : null;
    const totalInSide = selSide ? (lists[selSide]?.length ?? 0) : 0;
    const ready = Boolean(h.root);
    const stageable = unstaged.map((f) => f.path);
    const sideLabel = this.sel?.side === "staged" ? "Unstage" : "Stage";
    const actionable = Boolean(this.patch) && this.sel?.side !== "conflict";

    if (!ready) {
      return v_flex().id("gc-changes-wide").flex_1().min_h(0).w_full()
        .child(div().p(12).text_color(t.dim).child(h.state === "norepo" ? "Not a git repository" : h.state === "nofolder" ? "No folder" : h.state === "error" ? h.error : "Loading changes…"));
    }

    const left = v_flex().id("gc-changes-left").size_full().min_h(0).border_r(1).border_color(t.border)
      .when(this.files().length > 0 && selected.length > 0, (e) => e.child(this.selectionBar(t, selected, selSide, totalInSide)))
      .when(!this.files().length, (e) => e.child(v_flex().flex_1().min_h(0).items_center().justify_center().p(12)
        .child(div().text_color(t.dim).child("No uncommitted changes"))))
      .when(this.files().length > 0, (e) => e.child(v_flex().id("gcw-lists").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.listScroll).px(4).py(4)
        .children(this.listEntries(t, {
          conflict: [],
          staged: staged.length ? [this.smallButton("gc-unstage-all", "minus", "Unstage all", (cx) => this.unstage(staged.map((f) => f.path), cx), t)] : [],
          unstaged: unstaged.length ? [this.smallButton("gc-discard-all", "trash", "Discard all", (cx) => this.discard(unstaged, cx), t, true),
            this.smallButton("gc-stage-all", "plus", "Stage all", (cx) => this.stage(stageable, cx), t)] : [],
        }))))
      .child(this.commitBox(t));

    const right = v_flex().id("gc-changes-right").size_full().min_h(0)
      .child(this.diffBar(t))
      .when(this.files().length > 0 && this.sel?.side === "conflict", (e) => e.child(this.conflictActionBar(t)))
      .when(!this.files().length, (e) => e.child(v_flex().flex_1().min_h(0).items_center().justify_center().text_color(t.dim).child("Working tree clean")))
      .when(this.files().length > 0, (e) => e.child(this.showingImage() ? this.image.render() : this.diff.render({
        empty: this.diffNote ?? (this.sel ? "Loading diff…" : "Select a file to see its changes"),
        hunkLabel: (row) => (actionable && row.hunk >= 0 ? sideLabel : ""),
        onClick: (row, e) => { if (row?.kind === "@") this.hunkMenu(row, e); },
        onMenu: (row, e) => this.hunkMenu(row, e),
        sides: this.diffSides(),
      })));

    return v_flex().id("gc-changes-wide").flex_1().min_h(0).w_full()
      .when(Boolean(this.op), (e) => e.child(this.opBanner(t)))
      .child(div().flex_1().min_h(0).w_full().child(
        h_resizable(this.host.changesSplitId).size_full()
          .on_resize((sizes) => this.host.saveInspectorLeftWidth(sizes?.[0]))
          .child(resizable_panel().size(this.host.inspectorLeftWidth()).size_range(240, 580).child(left))
          .child(resizable_panel().size_range(280).child(right))));
  }
}
