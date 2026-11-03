// Shared logic of agent-resume: the config, the labels and the resume command.
// The status bar copy (the scanner) and the panel copy both use this module.

import { terminals, hc, shared, setShared } from "herdr";

export const CONFIG_KEY = "agent-resume.config";
const DEFAULTS = { enabled: true, settleMs: 4000, toast: true };
export const SETTLE_MIN_MS = 1000;
export const SETTLE_MAX_MS = 30000;

export const SHELLS = new Set([
  "pwsh", "pwsh.exe", "powershell", "powershell.exe", "cmd", "cmd.exe",
  "bash", "bash.exe", "zsh", "fish", "sh", "dash", "nu", "nu.exe",
]);

export function config() {
  const c = shared(CONFIG_KEY);
  return { ...DEFAULTS, ...(c && typeof c === "object" ? c : {}) };
}

export function setConfig(patch) {
  setShared(CONFIG_KEY, { ...config(), ...patch });
}

// Live terminals that have a recorded Claude session.
export function labeled() {
  return terminals().filter((t) => t.state === "live" && t.labels?.["claude.session"]);
}

// The full terminal record (with pid and foreground), or null.
export async function inspect(address) {
  const r = await hc(["get", address, "--json"]);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// The state of one recorded session:
//   active  - an agent runs in the terminal now
//   failed  - the mod typed the resume command, and no agent started
//   waiting - the shell is new (other pid): the next scan resumes it
//   stopped - Claude ended in the same shell without /exit
export function sessionState(info) {
  const l = info?.labels ?? {};
  if (info?.status) return "active";
  if (l["claude.tried"] && l["claude.tried"] === l["claude.session"]) return "failed";
  if (info && String(info.pid) !== l["claude.pid"]) return "waiting";
  return "stopped";
}

// The command to type, or null if a label has unsafe characters.
export function resumeCommand(labels) {
  const sid = labels?.["claude.session"] ?? "";
  if (!/^[A-Za-z0-9-]+$/.test(sid)) return null;
  const flags = (labels["claude.args"] ?? "").trim();
  if (!/^[\w.:/\\= -]*$/.test(flags)) return null;
  return ["claude", flags, "--resume", sid].filter(Boolean).join(" ");
}

// Types the resume command in the terminal. It never types into a running agent
// or into a program that is not a shell. Returns true when it typed.
export async function resumeNow(address) {
  const info = await inspect(address);
  if (!info || info.state !== "live" || info.status) return false;
  const fg = (info.foreground?.name ?? "").toLowerCase();
  if (!SHELLS.has(fg)) return false;
  const command = resumeCommand(info.labels);
  if (!command) return false;
  const mark = await hc(["label", address, `claude.tried=${info.labels["claude.session"]}`]);
  if (mark.code !== 0) return false;
  const sent = await hc(["send", address, command]);
  return sent.code === 0;
}

// Removes the labels: the mod stops to monitor this terminal.
export async function forget(address) {
  const r = await hc(["label", address, "claude.session=", "claude.pid=", "claude.args=", "claude.tried="]);
  return r.code === 0;
}
