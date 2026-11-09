// Scripts and the headless agent. `exec` has no environment option, so each script of a run is
// a small file in the run folder: it sets the HERDR_AUTO_* variables, goes to the folder of the
// automation and runs the command. Windows: pwsh. Elsewhere: bash, or sh without bash.

import { exec, hc, window } from "herdr";
import { writeFile } from "./store.js";

export const isWin = () => window()?.platform === "windows";

const psq = (s) => `'${String(s ?? "").replace(/'/g, "''")}'`;
const shq = (s) => `'${String(s ?? "").replace(/'/g, `'\\''`)}'`;
export const quote = (s) => (isWin() ? psq(s) : shq(s));

/** Splits a command line into words. Quotes ("a b", 'a b') keep spaces. */
export function splitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(text ?? "")))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** HERDR_AUTO_<NAME> lines for the shell. */
function envLines(env) {
  return Object.entries(env).map(([k, v]) => {
    const name = `HERDR_AUTO_${k.toUpperCase()}`;
    return isWin() ? `$env:${name} = ${psq(v)}` : `export ${name}=${shq(v)}`;
  }).join("\n");
}

const EXT_RUNNER = { py: "python", js: "node", mjs: "node" };

/**
 * The shell line for a script. kind "inline": the text runs as it is. kind "file": the text is
 * the path of a script, which runs with its program. No kind (old data): a single word with an
 * extension is a file.
 */
function commandLine(cmd, kind) {
  const text = String(cmd ?? "").trim();
  if (kind === "inline") return text;
  const m = /^(?:"([^"]+)"|'([^']+)'|(\S+))$/.exec(text);
  const file = kind === "file" ? (m ? (m[1] ?? m[2] ?? m[3]) : text) : m ? (m[1] ?? m[2] ?? m[3]) : null;
  const ext = file ? (/\.([a-z0-9]+)$/i.exec(file)?.[1] ?? "").toLowerCase() : "";
  if (!file) return text;
  if (!ext) return kind === "file" ? (isWin() ? `& ${psq(file)}` : quote(file)) : text;
  // Not Windows: the wrapper runs in bash when bash exists, so $BASH is its path; else sh.
  if (ext === "sh" || ext === "bash") return isWin() ? `bash ${quote(file)}` : `"\${BASH:-sh}" ${quote(file)}`;
  // Linux and macOS often have only python3.
  if (ext === "py" && !isWin()) return `"$(command -v python3 || echo python)" ${quote(file)}`;
  if (EXT_RUNNER[ext]) return `${EXT_RUNNER[ext]} ${quote(file)}`;
  if (ext === "ps1") return isWin() ? `& ${psq(file)}` : `pwsh -NoProfile -File ${shq(file)}`;
  return isWin() ? `& ${psq(file)}` : text;
}

/** Writes the file of a script and returns the argv that runs it. */
async function scriptFile(dir, name, body, env, folder) {
  if (isWin()) {
    const path = `${dir}/${name}.ps1`;
    await writeFile(path, [
      "$ErrorActionPreference = 'Continue'",
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
      envLines(env),
      `Set-Location -LiteralPath ${psq(folder)}`,
      "$global:LASTEXITCODE = 0",
      body,
      "if ($LASTEXITCODE) { exit $LASTEXITCODE }",
      "if (-not $?) { exit 1 }",
      "exit 0",
      "",
    ].join("\n"));
    return ["pwsh", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path]];
  }
  const path = `${dir}/${name}.sh`;
  await writeFile(path, [envLines(env), `cd ${shq(folder)} || exit 1`, body, ""].join("\n"));
  // bash when it exists (inline scripts can use bash), else sh (for example Alpine).
  return ["sh", ["-c", 'if command -v bash >/dev/null 2>&1; then exec bash "$1"; else exec sh "$1"; fi', "sh", path]];
}

/**
 * Runs a check, pre or post script. Returns { code, out }. A script that cannot start, or that
 * runs longer than its timeout (seconds, max 600), gives code -1.
 */
export async function runScript({ dir, name, cmd, kind, env, folder, timeout }) {
  const [prog, args] = await scriptFile(dir, name, commandLine(cmd, kind), env, folder);
  const ms = Math.min(600, Math.max(1, Number(timeout) || 60)) * 1000;
  try {
    const r = await exec(prog, args, { cwd: folder, timeout: ms });
    const out = [r.stdout, r.stderr].filter((s) => s && s.trim()).join("\n").trim();
    return { code: r.code, out };
  } catch (e) {
    const text = String(e?.message ?? e);
    return { code: -1, out: /time/i.test(text) ? `Timed out after ${ms / 1000} s.` : text };
  }
}

// The built-in headless command of each agent. {prompt} is the prompt; {run_dir} the run folder.
const HEADLESS = {
  claude: ["claude", "-p", "{prompt}", "--add-dir", "{run_dir}"],
  codex: ["codex", "exec", "--skip-git-repo-check", "{prompt}"],
  gemini: ["gemini", "-p", "{prompt}"],
  opencode: ["opencode", "run", "{prompt}"],
  copilot: ["copilot", "-p", "{prompt}"],
};

/** The built-in key for an agent: its program key, else the name of its program. */
export function headlessKey(agent) {
  if (!agent) return null;
  if (HEADLESS[agent.key]) return agent.key;
  const prog = String(agent.run?.[0] ?? "").replace(/\.(exe|cmd|ps1)$/i, "").split(/[\\/]/).pop();
  return HEADLESS[prog] ? prog : null;
}

export const builtinCommand = (key) => (HEADLESS[key] ? HEADLESS[key].map((w) => (/\s/.test(w) ? `"${w}"` : w)).join(" ") : "");

/** The shell line of the headless agent (without the output redirect). */
function headlessLine({ key, command, args, promptFile, dir }) {
  const promptVar = isWin() ? "$prompt" : '"$prompt"';
  const fill = (s) => s.replace(/\{prompt\}/g, promptVar).replace(/\{prompt_file\}/g, quote(promptFile)).replace(/\{run_dir\}/g, quote(dir));
  const extra = splitArgs(args).map(quote).join(" ");
  if (String(command ?? "").trim()) return `${fill(command.trim())}${extra ? ` ${extra}` : ""}`;
  const words = HEADLESS[key];
  if (!words) return null;
  const parts = words.map((w) => (w === "{prompt}" ? promptVar : w === "{run_dir}" ? quote(dir) : quote(w)));
  const [prog, ...rest] = parts;
  return `${isWin() ? `& ${prog}` : prog} ${rest.join(" ")}${extra ? ` ${extra}` : ""}`;
}

/**
 * Starts the headless agent in a background terminal of herdr-core. Its stdout and stderr go
 * to output.txt. Returns the terminal address.
 */
export async function startHeadless({ dir, env, folder, key, command, args, prompt, labels }) {
  const promptFile = `${dir}/prompt.md`;
  await writeFile(promptFile, prompt);
  const line = headlessLine({ key, command, args, promptFile, dir });
  if (!line) throw new Error("This agent has no built-in headless command. Write a custom command.");
  const out = `${dir}/output.txt`;
  const body = isWin()
    ? `$prompt = Get-Content -Raw -LiteralPath ${psq(promptFile)}\n& { ${line} } *> ${psq(out)}`
    : `prompt=$(cat ${shq(promptFile)})\n${line} > ${shq(out)} 2>&1`;
  const [prog, argv] = await scriptFile(dir, "agent", isWin() ? body : `${body}\nexit $?`, env, folder);
  const labelArgs = Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
  const r = await hc(["run", "--bg", "--json", "--no-parent", ...labelArgs, "--cwd", folder, "--", prog, ...argv]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "hc run failed").trim());
  let address = null;
  try { address = JSON.parse(r.stdout)?.address ?? null; } catch { address = null; }
  if (!address) address = /\b((?:[\w-]+\/)?t[0-9a-z]+)\b/.exec(r.stdout)?.[1] ?? null;
  if (!address) throw new Error(`hc run gave no terminal: ${r.stdout.trim()}`);
  return address;
}

/** The state of a core terminal: { state, exit_code, status, turn } or null. */
export async function terminalInfo(address) {
  const r = await hc(["get", address, "--json"]);
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    return j?.terminal ?? j;
  } catch {
    return null;
  }
}

/** The last `lines` lines of a terminal's screen and history. */
export async function readTerminal(address, lines = 200) {
  const r = await hc(["read", address, "--lines", String(lines)]);
  return r.code === 0 ? r.stdout : "";
}

/** The last `lines` lines of a text. */
export const tail = (text, lines = 200) => String(text ?? "").split(/\r?\n/).slice(-lines).join("\n");
