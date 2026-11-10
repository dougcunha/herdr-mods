import * as fs from "fs/promises";
import { exec, notify, setShared, openOverlay, appHome, run, panes, spaces } from "herdr";
import { dialogFor, dialogHeight, doneText } from "./git.js";
import { worktreePath, samePath } from "./refs.js";
import { executeAction } from "./execute.js";

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
};

// Runs an action's git commands in order, stopping at the first failure. Every
// copy of the panel reads the repository again after, whether or not its folder watch saw the change.
export async function perform(action, values, ctx, { toast = true, quiet = false } = {}) {
  try {
    const result = await executeAction(action, values, ctx, exec, io);
    if (!result.ok) {
      if (toast) notify({ title: "Couldn't do that", body: result.message, level: "error" });
      return result;
    }
    if (!quiet) notify({ title: doneText(action, values), level: "success", timeout: 3000 });
    if (action.type === "addWorktree" && values.open) {
      const name = String(values.name ?? "").trim();
      openWorktree(String(values.path ?? "").trim() || worktreePath(ctx.root, name), ctx.on, name);
    }
    return { ok: true };
  } catch (e) {
    const message = String(e?.message ?? e);
    if (toast) notify({ title: "Git didn't run", body: message, level: "error" });
    return { ok: false, message };
  } finally {
    setShared("git-client.changed", Date.now());
  }
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
