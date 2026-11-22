// "New with an agent…" and "Edit with an agent…" of the form: an agent writes the script file of an
// action from a description. The action is saved first (source "file"), then the agent starts in a new
// tab of the shown space, in the folder of the file, with the task below. See docs/quick-actions-plan.md.

import { exec, run, notify, shared, setShared, home, window } from "herdr";
import { KEY } from "./store.js";
import { VARIABLES, psq } from "./vars.js";
import { expandHome } from "./run.js";
import { agentStart } from "./core.js";
import * as fs from "fs/promises";

const isWin = () => window()?.platform === "windows";
const slash = (p) => String(p ?? "").replace(/\\/g, "/");

export const DEFAULT_DIR = "~/.config/herdr-app/data/quick-actions/scripts";

/** The folder of the new script files (the setting, else the default), with `~` expanded. */
export const scriptDir = () => expandHome(String(shared(KEY.scriptDir) ?? "").trim() || DEFAULT_DIR).replace(/\/+$/, "");

/** A path for people: `~` for the home folder. */
export function shortPath(path) {
  const p = slash(path);
  const h = slash(home()).replace(/\/+$/, "");
  return p.toLowerCase().startsWith(`${h.toLowerCase()}/`) ? `~${p.slice(h.length)}` : p;
}

const dirOf = (path) => slash(path).replace(/\/[^/]*$/, "") || ".";
const slug = (name) => String(name || "action").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "action";

/** The path of the script file that the agent writes: the file of the action, else <script folder>/<name>.<ext>. */
export function writerPath(d) {
  if (d.file.trim()) return expandHome(d.file);
  return `${scriptDir()}/${slug(d.name)}.${isWin() ? "ps1" : "sh"}`;
}

/** Makes a folder and its parents. `fs` works only inside the home folder; elsewhere a shell makes it. */
async function makeDir(dir) {
  try { await fs.mkdir(dir, { recursive: true }); return; } catch { /* outside the home folder */ }
  try {
    if (isWin()) await exec("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `New-Item -ItemType Directory -Force -Path ${psq(dir)} | Out-Null`], { timeout: 15000 });
    else await exec("mkdir", ["-p", dir], { timeout: 15000 });
  } catch { /* the tab shows the error */ }
}

/** The first message to the agent. */
export function writerTask(mode, path, what) {
  const ps = /\.ps1$/i.test(path);
  const vars = VARIABLES.map(([n, tip]) => `{${n}} (${tip.toLowerCase()})`).join(", ");
  return [
    mode === "edit"
      ? `Change the script in this file for the Quick Actions mod of the Herdr app: ${path}`
      : `Write a script for the Quick Actions mod of the Herdr app, and save it as this file: ${path}`,
    `It is a ${ps ? "PowerShell 7 (pwsh)" : "POSIX sh"} script.`,
    mode === "edit" ? `What must change: ${what}` : `What the script must do: ${what}`,
    "",
    "Rules:",
    "- Write only this file. Do not run the script, and do not change other files.",
    "- The script runs in a terminal of the person, in the folder of that terminal.",
    `- Before the run, Quick Actions replaces these variables in the text. Each value becomes 1 quoted literal for the shell, so write a variable without quotes: cd {repo}, not cd "{repo}". The variables: ${vars}.`,
    "- {ask:Label} or {ask:Label=default}: Quick Actions asks the person for this value before the run. The value is a quoted literal too.",
    ps
      ? "- To join a value and more text, use Join-Path {repo} 'dist' ({repo}\\dist gives 2 words). Put $ErrorActionPreference = 'Stop' at the top. After each program, check $LASTEXITCODE and stop on an error."
      : "- Put set -e at the top.",
    "- Other text in braces stays as it is.",
    "- Print a short line before each step.",
  ].join("\n");
}

/**
 * Starts the agent: a tab in the space `space` (null: a new space), in the folder of the file.
 * `agent`: an entry of knownAgents(). Returns false when it could not start.
 */
export async function startWriter({ mode, path, what, agent, space, name }) {
  const folder = dirOf(path);
  await makeDir(folder);
  setShared(KEY.agent, agent.key);
  const start = agentStart(agent.run, writerTask(mode, path, what));
  const tabName = `Script: ${name}`.slice(0, 40);
  if (space) run("tab.new", { space, folder, name: tabName, focus: true, ...start });
  else run("space.new", { folder, name: tabName, ...start });
  notify({ title: "Quick Actions", body: `${agent.name} writes ${shortPath(path)}. Run the action when it is done.`, level: "info", timeout: 7000 });
  return true;
}
