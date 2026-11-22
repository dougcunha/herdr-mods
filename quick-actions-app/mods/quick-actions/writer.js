// "New with an agent…" and "Edit with an agent…" of the form: an agent writes the script file of an
// action from a description. The action is saved first (source "file"), then the agent starts in the
// folder of the file, with the task below: in a new tab of the shown space, or in a new space on this
// computer when the shown space is on another machine (the file is on this computer). See docs/quick-actions-plan.md.

import { exec, run, notify, shared, setShared, home, window, spaces, terminals } from "herdr";
import { KEY } from "./store.js";
import { VARIABLES, psq } from "./vars.js";
import { expandHome, fileShell } from "./run.js";
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

/**
 * The path of the script file that the agent writes: the file of the action, else <script folder>/<name>.<ext>
 * (with the id of the action when another action of `list` uses that file).
 */
export function writerPath(d, list = []) {
  if (d.file.trim()) return expandHome(d.file);
  const base = `${scriptDir()}/${slug(d.name)}`;
  const ext = { ps: "ps1", bash: "sh", python: "py", node: "js" }[d.shell] ?? (isWin() ? "ps1" : "sh");
  const used = (p) => list.some((x) => x.id !== d.id && x.file && expandHome(x.file).toLowerCase() === p.toLowerCase());
  return used(`${base}.${ext}`) ? `${base}-${d.id}.${ext}` : `${base}.${ext}`;
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
const LANGUAGE = {
  ps: "a PowerShell 7 (pwsh) script",
  bash: "a bash script",
  zsh: "a zsh script",
  python: "a Python 3 script (only the standard library, unless the task names a package)",
  node: "a Node.js script (only the built-in modules, unless the task names a package)",
};

// The rules of each language: how a value is written, how to join it with more text, how to stop on an error.
const RULES = {
  ps: [
    "- Each value becomes 1 PowerShell literal in quotes, so write a variable without quotes: cd {repo}, not cd \"{repo}\".",
    "- To join a value and more text, use Join-Path {repo} 'dist' ({repo}\\dist gives 2 words). Put $ErrorActionPreference = 'Stop' at the top. After each program, check $LASTEXITCODE and stop on an error.",
  ],
  bash: [
    "- Each value becomes 1 shell literal in quotes, so write a variable without quotes: cd {repo}, not cd \"{repo}\". {repo}/dist works.",
    "- Put set -euo pipefail at the top.",
  ],
  python: [
    "- Each value becomes 1 Python string literal, so write a variable without quotes: repo = {repo}, not repo = \"{repo}\".",
    "- Use os.path.join({repo}, \"dist\") to join a value and more text. Run programs with subprocess.run([...], check=True). Use sys.exit(1) on an error.",
  ],
  node: [
    "- Each value becomes 1 JavaScript string literal, so write a variable without quotes: const repo = {repo}; not const repo = \"{repo}\";.",
    "- Use path.join({repo}, \"dist\") to join a value and more text. Run programs with child_process.execFileSync(cmd, args, { stdio: \"inherit\" }). Set process.exitCode = 1 on an error.",
  ],
};

/** The first message to the agent. The extension of the file gives the language. */
export function writerTask(mode, path, what) {
  const lang = fileShell(path) ?? "bash";
  return [
    mode === "edit"
      ? `Change the script in this file for the Quick Actions mod of the Herdr app: ${path}`
      : `Write a script for the Quick Actions mod of the Herdr app, and save it as this file: ${path}`,
    `It is ${LANGUAGE[lang] ?? LANGUAGE.bash}.`,
    mode === "edit" ? `What must change: ${what}` : `What the script must do: ${what}`,
    "",
    "Variables: before each run, Quick Actions replaces these words in the text of the file:",
    ...VARIABLES.map(([n, tip]) => `- {${n}}: ${tip}`),
    "- {ask:Label} or {ask:Label=default}: Quick Actions asks the person for a value before the run (Label is the text of the question).",
    "",
    "Rules:",
    "- Write only this file. Do not run the script, and do not change other files.",
    "- The script runs in a terminal of the person, in the folder of that terminal.",
    ...(RULES[lang] ?? RULES.bash),
    "- Write a variable only where a value can go, and nowhere else: not inside a string, a comment, an f-string or a ${...} of a template string. Put the value in a name first, then use the name.",
    "- Other text in braces stays as it is.",
    "- Print a short line before each step.",
  ].join("\n");
}

const wait = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));

/**
 * Starts the agent in the folder of the file, on this computer: the script file is on this computer.
 * A local `space` gets a new tab; a space on another machine (or none) gives a new space on this computer.
 * `agent`: an entry of knownAgents(). Throws an Error with a message for the person when no terminal starts.
 */
export async function startWriter(cx, { mode, path, what, agent, space, name }) {
  const folder = dirOf(path);
  await makeDir(folder);
  setShared(KEY.agent, agent.key);
  const start = agentStart(agent.run, writerTask(mode, path, what));
  const tabName = `Script: ${name}`.slice(0, 40);
  const local = Boolean(space) && spaces().some((s) => s.id === space && !s.machine);
  const before = new Set(terminals().map((x) => x.address));
  if (local) run("tab.new", { space, folder, name: tabName, focus: true, ...start });
  else run("space.new", { machine: "", folder, name: tabName, focus: true, ...start });
  // run() gives no result: a new terminal on this computer shows that the tab started.
  let started = false;
  for (let i = 0; i < 40 && !started; i++) {
    await wait(cx, 150);
    started = terminals().some((x) => !before.has(x.address) && !x.address.includes("/"));
  }
  if (!started) throw new Error(`The terminal of the agent did not start in ${shortPath(folder)}.`);
  notify({
    title: "Quick Actions",
    body: `${agent.name} writes ${shortPath(path)}${local ? "" : " in a new space on this computer"}. Run the action when it is done.`,
    level: "info",
    timeout: 7000,
  });
}
