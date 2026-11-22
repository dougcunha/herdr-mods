// A run of an action: the script with the values of the target terminal, then the line that the
// terminal gets. See docs/quick-actions-plan.md.
//
// - The target terminal is free (its program is a shell): the mod clears a draft at the prompt
//   (Esc in PowerShell, Ctrl+U in the other shells) and sends the line with `hc send`.
// - The target terminal is busy, there is no terminal, or the action says "New tab": a new tab
//   in the same space and folder gets the line when its shell is ready.
// - A script of 1 line goes as that line. A script of 2 or more lines and a script file go into
//   a run file, and the terminal gets 1 line that runs it.

import { hc, run, notify, terminals, readTextFile, home } from "herdr";
import { context, expand, usedVars, filterMatches, filterNeedsRepo, filterParts, family, psq, shq } from "./vars.js";
import { writeRunFile } from "./store.js";

const wait = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));

export function fail(name, body) {
  notify({ title: `Quick action: ${name || "(no name)"}`, body, level: "error", timeout: 8000 });
}

/** A path with `~` as the home folder of this computer. */
export function expandHome(path) {
  const p = String(path ?? "").trim().replace(/\\/g, "/");
  if (p === "~") return home().replace(/\\/g, "/");
  if (p.startsWith("~/")) return home().replace(/\\/g, "/") + p.slice(1);
  return p;
}

/** The shell that a script file asks for by its extension, or null. */
function fileShell(file) {
  const ext = /\.([a-z0-9]+)$/i.exec(String(file ?? ""))?.[1]?.toLowerCase();
  if (ext === "ps1") return "ps";
  if (ext === "sh" || ext === "bash") return "bash";
  if (ext === "zsh") return "zsh";
  return null;
}

/** The text of the script of an action: { text } or { error }. */
export async function scriptText(a) {
  if (a.source !== "file") return { text: a.script };
  const path = expandHome(a.file);
  if (!path) return { error: "The action has no script file." };
  const text = await readTextFile(path).catch(() => null);
  if (text == null) return { error: `Cannot read the script file: ${a.file}` };
  return { text };
}

/** The line that runs a run file. `script`: the shell of the script; `term`: the shell of the terminal. */
function runLine(script, term, path, windows) {
  const native = windows ? path.replace(/\//g, "\\") : path;
  if (script === "ps") return term === "ps" ? `& ${psq(native)}` : `pwsh -NoProfile -File ${shq(native)}`;
  const prog = script === "sh" ? (term === "ps" ? "bash" : term) : script;
  return term === "ps" ? `& ${prog} ${psq(native)}` : `${prog} ${shq(native)}`;
}

/**
 * Everything that a run needs, without side effects:
 * { ctx, useTab, term, shell, expanded, oneLine, error?, filtered? }.
 * `term`: the shell of the terminal that gets the line; `shell`: the shell of the script.
 */
export async function prepare(a, target) {
  if (!target) return { error: "No space is shown." };
  const src = await scriptText(a);
  if (src.error) return { error: src.error };
  if (!String(src.text ?? "").trim()) return { error: "The script is empty.", info: true };
  const need = usedVars(src.text);
  if (filterNeedsRepo(a.filter)) need.add("repo_name");
  const ctx = await context(target, need);
  if (!filterMatches(a.filter, ctx)) return { ctx, error: `This action runs only in: ${filterParts(a.filter).join(", ")}.`, filtered: true };
  const useTab = a.where === "tab" || ctx.busy;
  // A new tab starts the default shell of the machine: PowerShell on Windows.
  const term = useTab ? (ctx.windows ? "ps" : "sh") : ctx.shell;
  const shell = (a.source === "file" ? fileShell(a.file) : null) ?? term;
  const expanded = expand(src.text, ctx.values, family(shell)).trim();
  const oneLine = a.source !== "file" && !/\r?\n/.test(expanded);
  return { ctx, useTab, term, shell, expanded, oneLine };
}

/** Opens a tab in the space of the context and returns the address of its terminal. */
async function openTab(cx, ctx, name) {
  const before = new Set(terminals().map((x) => x.address));
  run("tab.new", { space: ctx.target.space, folder: ctx.folder || undefined, name: name || undefined, focus: true });
  for (let i = 0; i < 70; i++) {
    await wait(cx, 150);
    const fresh = terminals().find((x) => !before.has(x.address));
    if (fresh) return fresh.address;
  }
  throw new Error("The terminal of the new tab did not start.");
}

/** Waits until the shell of a new terminal draws its prompt (the screen stops changing), at most about 12 s. */
async function waitPrompt(cx, address) {
  let prev = null;
  for (let i = 0; i < 50; i++) {
    await wait(cx, 150);
    let text = "";
    try {
      const r = await hc(["read", address, "--lines", "30"]);
      text = r.code === 0 ? r.stdout.trim() : "";
    } catch { /* not ready */ }
    if (text && text === prev) return;
    prev = text;
  }
}

/** Runs an action for a target. Returns the address of the terminal that got the line, or null. */
export async function runAction(cx, a, target) {
  const p = await prepare(a, target);
  if (p.error) { fail(a.name, p.error); return null; }
  const { ctx } = p;
  try {
    let line = p.expanded;
    if (!p.oneLine) {
      if (ctx.machine) throw new Error(`The space is on ${ctx.machine}. Scripts of 2 or more lines and script files run only on this computer.`);
      const path = await writeRunFile(a.name, p.shell === "ps" ? "ps1" : "sh", `${p.expanded}\n`);
      line = runLine(p.shell, p.term, path, ctx.windows);
    }
    let address = ctx.target.terminal;
    if (p.useTab) {
      address = await openTab(cx, ctx, a.name);
      await waitPrompt(cx, address);
    } else {
      // A draft at the prompt would go before the line.
      await hc(["keys", address, p.term === "ps" ? "esc" : "ctrl+u"]);
    }
    const r = await hc(["send", address, line]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim() || "hc send failed");
    run("pane.focus", { terminal: address });
    return address;
  } catch (e) {
    fail(a.name, String(e?.message ?? e));
    return null;
  }
}

/** A short text that says where and how the action runs (the preview). */
export function howText(p) {
  if (!p || p.error) return "";
  const where = p.useTab
    ? (p.ctx.busy && p.ctx.target.terminal ? `A new tab (the terminal runs ${p.ctx.busyWith || "a program"})` : "A new tab")
    : `The terminal ${p.ctx.target.terminal}`;
  const how = p.oneLine ? "gets this line" : "gets 1 line that runs a file with this script";
  return `${where} in ${p.ctx.folder || "~"} ${how}.`;
}

