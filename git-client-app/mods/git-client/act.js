import * as fs from "fs/promises";
import { exec, notify, setShared, openOverlay, appHome } from "herdr";
import { dialogFor, dialogHeight, doneText } from "./git.js";
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

// Asks every copy of the panel to show a tab (a menu or a dialog has no panel of its own).
export function showTab(tab) {
  setShared("git-client.show", { tab, at: Date.now() });
}
