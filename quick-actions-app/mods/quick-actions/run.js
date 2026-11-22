// A run of an action: the script with the values of the target terminal, then the line that the
// terminal gets. See docs/quick-actions-plan.md.
//
// - The target terminal is free (its program is a shell): the mod clears a draft at the prompt
//   (Esc in PowerShell, Ctrl+U in the other shells) and sends the line with `hc send`.
// - The target terminal is busy, there is no terminal, or the action says "New tab": a new tab
//   in the same space and folder gets the line when its shell is ready.
// - A script of 1 line in the shell of the terminal goes as that line. Any other script (2 or more
//   lines, a script file, another shell, Python, Node.js) goes into a run file, and the terminal gets
//   1 line that runs it. On another machine, `hc put` copies the run file there first (a script file
//   stays on this computer).

import { hc, run, notify, terminals, readTextFile, home } from "herdr";
import { context, expand, usedVars, filterMatches, filterNeedsRepo, filterParts, asksOf, psq, shq, windowsTools } from "./vars.js";
import { writeRunFile, SHELL_LABEL } from "./store.js";
import { jobKey, jobOf, isRunning, addJob, startTerminal, timeoutMin } from "./jobs.js";

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

const extOf = (file) => /\.([a-z0-9]+)$/i.exec(String(file ?? ""))?.[1]?.toLowerCase() ?? "";

/** The shell that a script file asks for by its extension, or null. */
export function fileShell(file) {
  const ext = extOf(file);
  if (ext === "ps1") return "ps";
  if (ext === "sh" || ext === "bash") return "bash";
  if (ext === "zsh") return "zsh";
  if (ext === "py") return "python";
  if (ext === "js" || ext === "mjs" || ext === "cjs") return "node";
  return null;
}

/** The text of the script of an action: { text } or { error, info? }. A missing file is info, not a fault. */
export async function scriptText(a) {
  if (a.source !== "file") return { text: a.script };
  const path = expandHome(a.file);
  if (!path) return { error: "No script file yet. Write its path, or click Write with an agent…", info: true };
  const text = await readTextFile(path).catch(() => null);
  if (text == null) return { error: `The file ${a.file} does not exist yet. Click Write with an agent…, or write the path of a file that exists.`, info: true, missing: true };
  return { text };
}

/** The extension of the run file of a script. */
function runExt(a, shell) {
  if (shell === "ps") return "ps1";
  if (shell === "python") return "py";
  if (shell === "node") return a.source === "file" && ["mjs", "cjs"].includes(extOf(a.file)) ? extOf(a.file) : "js";
  return "sh";
}

/**
 * The function that makes the line for a run file (path => line). It checks first that the program is
 * there: Git Bash and Python on a Windows machine (the `bash` of the PATH can be the one of WSL, and
 * `python3` can be the Microsoft Store link).
 */
async function runnerFor(p) {
  const { ctx, shell, term } = p;
  const where = ctx.machine ?? "this computer";
  if (term === "ps") {
    const call = (words) => (path) => `& ${words.map(psq).join(" ")} ${psq(path)}`;
    if (shell === "ps") return (path) => `& ${psq(ctx.windows ? path.replace(/\//g, "\\") : path)}`;
    if (shell === "node") return call(["node"]);
    if (!ctx.windows) return call([shell === "python" ? "python3" : shell === "sh" ? "sh" : shell]);
    const tools = await windowsTools(ctx.machine);
    if (shell === "python") {
      if (!tools.python) throw new Error(`Python was not found on ${where}.`);
      return call(tools.python === "py" ? ["py", "-3"] : [tools.python]);
    }
    if (!tools.bash) throw new Error(`Git Bash was not found on ${where}. Install Git for Windows.`);
    return call([tools.bash]);
  }
  // A POSIX terminal.
  if (shell === "ps") return (path) => `pwsh -NoProfile -File ${shq(path)}`;
  if (shell === "python") return (path) => `python3 ${shq(path)}`;
  if (shell === "node") return (path) => `node ${shq(path)}`;
  const prog = shell === "sh" ? term : shell;
  return (path) => `${prog} ${shq(path)}`;
}

/**
 * Everything that a run needs, without side effects:
 * { ctx, useTab, term, shell, expanded, oneLine, asks, error?, info?, filtered? }. `answers` fill the {ask:…} questions.
 * `term`: the shell of the terminal that gets the line; `shell`: the language of the script.
 */
export async function prepare(a, target, answers = null) {
  if (!target) return { error: "No space is shown." };
  const src = await scriptText(a);
  if (src.error) return { error: src.error, info: src.info, missing: src.missing };
  if (!String(src.text ?? "").trim()) return { error: "The script is empty.", info: true };
  const need = usedVars(src.text);
  if (filterNeedsRepo(a.filter)) need.add("repo_name");
  // A background run needs no free terminal: no check of the program in the terminal.
  const background = a.where === "background";
  const ctx = await context(target, need, { probe: !background });
  if (!filterMatches(a.filter, ctx)) return { ctx, error: `This action runs only in: ${filterParts(a.filter).join(", ")}.`, filtered: true };
  const useTab = !background && (a.where === "tab" || ctx.busy);
  // A new tab and a background run start the default shell of the machine: PowerShell on Windows.
  const term = background || useTab ? (ctx.windows ? "ps" : "sh") : ctx.shell;
  // The shell of the action, else the extension of the file, else the shell of the terminal.
  const shell = (a.shell && a.shell !== "auto" ? a.shell : null) ?? (a.source === "file" ? fileShell(a.file) : null) ?? term;
  const expanded = expand(src.text, ctx.values, shell, answers).trim();
  // Only a line in the language of the terminal can go as it is. A background run always uses a file.
  const oneLine = !background && a.source !== "file" && shell === term && !/\r?\n/.test(expanded);
  return { ctx, background, useTab, term, shell, expanded, oneLine, asks: asksOf(src.text) };
}

/** Opens a tab in the space of the context and returns the address of its terminal. */
async function openTab(cx, ctx, name) {
  const space = ctx.target.space;
  // Only a terminal of the target space: a background terminal (an Automations run) has no space label.
  // A space on another machine has the id "<machine>/<id>"; its label there has no machine.
  const inSpace = (x) => {
    const l = x.labels?.["herdr.space"];
    return Boolean(l) && (l === space || String(space).endsWith(`/${l}`));
  };
  const before = new Set(terminals().map((x) => x.address));
  run("tab.new", { space, folder: ctx.folder || undefined, name: name || undefined, focus: true });
  for (let i = 0; i < 70; i++) {
    await wait(cx, 150);
    const fresh = terminals().find((x) => !before.has(x.address) && inSpace(x));
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

/** Copies a local file to the machine of a terminal (`hc put`) and returns its path there. */
async function putFile(address, local) {
  const r = await hc(["put", "--json", address, local]);
  let path = null;
  try { path = JSON.parse(r.stdout)?.path ?? null; } catch { path = null; }
  if (r.code !== 0 || !path) throw new Error(`Cannot copy the script to the machine of ${address}: ${(r.stderr || r.stdout || "").trim()}`);
  return String(path).replace(/\\/g, "/");
}

/**
 * The program and arguments of a background run of a script file. PowerShell ends with 0 after a
 * program that failed, so a short command gives the exit code of the last program (or 1 after an error).
 */
async function backgroundArgv(p, path) {
  const { ctx, shell } = p;
  const where = ctx.machine ?? "this computer";
  if (shell === "ps") {
    const file = ctx.windows ? path.replace(/\//g, "\\") : path;
    const cmd = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; & ${psq(file)}; if ($LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $?) { exit 1 }`;
    return ["pwsh", "-NoProfile", ...(ctx.windows ? ["-ExecutionPolicy", "Bypass"] : []), "-Command", cmd];
  }
  if (shell === "node") return ["node", path];
  if (!ctx.windows) return [shell === "python" ? "python3" : shell, path];
  const tools = await windowsTools(ctx.machine);
  if (shell === "python") {
    if (!tools.python) throw new Error(`Python was not found on ${where}.`);
    return tools.python === "py" ? ["py", "-3", path] : [tools.python, path];
  }
  if (!tools.bash) throw new Error(`Git Bash was not found on ${where}. Install Git for Windows.`);
  return [tools.bash, path];
}

/** Starts a background run: a terminal of herdr-core that is not on the screen, in the folder of the target. */
async function startBackground(a, p) {
  if (isRunning(jobOf("run", a.id))) throw new Error("It still runs in the background. Open Quick Actions to see it or stop it.");
  const { ctx } = p;
  let path = await writeRunFile(a.name, runExt(a, p.shell), `${p.expanded}\n`);
  if (ctx.machine) {
    // `hc put` needs a terminal on that machine.
    if (!ctx.target.terminal) throw new Error(`A background run on ${ctx.machine} needs a terminal in the space.`);
    path = await putFile(ctx.target.terminal, path);
  }
  const argv = await backgroundArgv(p, path);
  const address = await startTerminal({
    argv,
    cwd: ctx.values.folder || ctx.values.home || undefined,
    on: ctx.machine ?? undefined,
    labels: { "quick-actions": a.id },
  });
  addJob(jobKey("run", a.id), { kind: "run", action: a.id, name: a.name, address, machine: ctx.machine ?? null });
  notify({ title: `Quick action: ${a.name}`, body: `Runs in the background${ctx.machine ? ` on ${ctx.machine}` : ""}. A toast shows when it ends.`, level: "info", timeout: 4000 });
  return address;
}

/**
 * Runs an action for a target. Returns { address, background } (the terminal that got the line, or the
 * background terminal), or null.
 */
export async function runAction(cx, a, target, answers = null) {
  const p = await prepare(a, target, answers);
  if (p.error) { fail(a.name, p.error); return null; }
  const { ctx } = p;
  if (p.background) {
    try {
      return { address: await startBackground(a, p), background: true };
    } catch (e) {
      fail(a.name, String(e?.message ?? e));
      return null;
    }
  }
  try {
    // The program of the run file first: no new tab when it is not there.
    const lineOf = p.oneLine ? null : await runnerFor(p);
    let address = ctx.target.terminal;
    if (p.useTab) {
      address = await openTab(cx, ctx, a.name);
      await waitPrompt(cx, address);
    } else {
      // A draft at the prompt would go before the line.
      await hc(["keys", address, p.term === "ps" ? "esc" : "ctrl+u"]);
    }
    let line = p.expanded;
    if (lineOf) {
      let path = await writeRunFile(a.name, runExt(a, p.shell), `${p.expanded}\n`);
      // A terminal on another machine: `hc put` copies the run file to that machine.
      if (ctx.machine) path = await putFile(address, path);
      line = lineOf(path);
    }
    const r = await hc(["send", address, line]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim() || "hc send failed");
    run("pane.focus", { terminal: address });
    return { address, background: false };
  } catch (e) {
    fail(a.name, String(e?.message ?? e));
    return null;
  }
}

/** A short text that says where and how the action runs (the preview). */
export function howText(p) {
  if (!p || p.error) return "";
  if (p.background) {
    const on = p.ctx.machine ? ` on ${p.ctx.machine}` : "";
    return `In the background${on}, in ${p.ctx.folder || "~"}: a ${SHELL_LABEL[p.shell] ?? p.shell} script. It stops after ${timeoutMin()} min.`;
  }
  const where = p.useTab
    ? (p.ctx.busy && p.ctx.target.terminal ? `A new tab (the terminal runs ${p.ctx.busyWith || "a program"})` : "A new tab")
    : `The terminal ${p.ctx.target.terminal}`;
  const how = p.oneLine ? "gets this line" : `gets 1 line that runs a file with this ${SHELL_LABEL[p.shell] ?? p.shell} script`;
  return `${where} in ${p.ctx.folder || "~"} ${how}.`;
}
