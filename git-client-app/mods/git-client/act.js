import * as fs from "fs/promises";
import { exec, notify, readTextFile, writeTextFile, setShared, openOverlay, appHome, run, panes, spaces } from "herdr";
import { dialogFor, dialogHeight, doneText } from "./git.js";
import { samePath } from "./refs.js";
import { executeAction } from "./execute.js";
import { worktrees } from "./core.js";

// Hunk patches of a local repository go through a file under the app's data folder.
const io = {
  async writePatch(text) {
    const dir = `${appHome()}/data/git-client`;
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const file = `${dir}/hunk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.patch`;
    await fs.writeFile(file, text);
    return file;
  },
  async remove(file) { await fs.unlink(file).catch(() => {}); },
  // Adds the line of an ignore file when it is not there. An unfinished last line ends first.
  async appendLine(file, line) {
    const text = await readTextFile(file).catch(() => null);
    if (text != null && text.split(/\r?\n/).includes(line)) return;
    const base = text ?? "", eol = base.includes("\r\n") ? "\r\n" : "\n";
    await writeTextFile(file, `${base}${base && !base.endsWith("\n") ? eol : ""}${line}${eol}`, text);
  },
};

// Runs an action's git commands in order, stopping at the first failure. Every
// copy of the panel reads the repository again after, whether or not its folder watch saw the change.
export async function perform(action, values, ctx, { toast = true, quiet = false } = {}) {
  try {
    if (action.type === "addWorktree" || action.type === "removeWorktree") return await viaCore(action, values, ctx, { quiet });
    const result = await executeAction(action, values, ctx, exec, io);
    if (!result.ok) {
      if (toast) notify({ title: "Couldn't do that", body: result.message, level: "error" });
      return result;
    }
    if (!quiet) notify({ title: doneText(action, values), level: "success", timeout: 3000 });
    return { ok: true };
  } catch (e) {
    const message = String(e?.message ?? e);
    if (toast) notify({ title: "Git didn't run", body: message, level: "error" });
    return { ok: false, message };
  } finally {
    setShared("git-client.changed", Date.now());
  }
}

// New and Remove worktree go through PowerMods Core: its folder (Settings), its setup (files to copy, commands
// in a "setup" tab), a new space. Remove also closes the spaces that work only in that folder.
async function viaCore(action, values, ctx, { quiet }) {
  const wt = worktrees();
  if (action.type === "removeWorktree") {
    await wt.remove({ repo: ctx.root, path: action.path, on: ctx.on ?? null, force: Boolean(values.force), branch: action.branch });
    if (!quiet) notify({ title: doneText(action, values), level: "success", timeout: 3000 });
    return { ok: true };
  }
  const name = String(values.name ?? "").trim();
  const r = await wt.create({ repo: ctx.root, branch: name, on: ctx.on ?? null, path: String(values.path ?? "").trim() || undefined, select: values.open !== false, name });
  if (!quiet) notify({ title: r.setup === "running" ? `Setting up the worktree of ${name}` : doneText(action, values), body: r.path, level: "success", timeout: 3000 });
  return { ok: true };
}

// Opens the action's dialog; false when it has none and should run at once.
export function openDialog(action, ctx) {
  const spec = dialogFor(action, ctx);
  if (!spec) return false;
  openOverlay({ mod: "git-client", kind: "dialog", width: 420, height: dialogHeight(spec), props: { role: "dialog", action, ctx } });
  return true;
}

// A worktree in Herdr: the space whose terminal is in that folder, else a new space there.
export function openWorktree(path, on, name = null) {
  const pane = panes().find((p) => p.cwd && samePath(p.cwd, path));
  const space = pane ? spaces().find((s) => s.tabs.some((t) => t.id === pane.tab) && (s.machine ?? null) === (on ?? null)) : null;
  if (space) { run("space.select", { id: space.id }); return; }
  run("space.new", { folder: path, machine: on ?? "", ...(name ? { name } : {}) });
}

// Where a popup menu opens: the spot of the click. "pointer" is the last spot that the layout saw,
// so in a dialog (the dock's panel dialog) it is wrong.
export function atEvent(e) {
  const p = e?.position;
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : "pointer";
}

// Asks every copy of the panel to show a tab (a menu or a dialog has no panel of its own).
export function showTab(tab) {
  setShared("git-client.show", { tab, at: Date.now() });
}

// Asks every copy to show a submodule (a path from the repository's top folder) in place of its repository.
export function showSubmodule(root, path, on) {
  setShared("git-client.show", { sub: { cwd: `${root}/${path}`, on: on ?? null, name: path }, at: Date.now() });
}

// Asks every copy to show the history or the blame of a file (a path from the repository's top folder).
export function showFile(path, mode) {
  setShared("git-client.show", { file: path, mode, at: Date.now() });
}
