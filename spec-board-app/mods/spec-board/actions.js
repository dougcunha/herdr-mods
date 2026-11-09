// What the Spec Board does on disk and in Herdr: start an agent with an SDD
// skill, make a git worktree, copy a spec into it, and move a spec to the trash.

import { spaces, panes, agents, run, shared, home, knownAgents, readTextFile, exec, hc } from "herdr";
import { git, powershell, psQuote, native, join, norm, inside, isWin } from "./data.js";

// The preferences (mods-hub Settings tab, kit.json). Read on every use.
export const KEY = {
  agent: "spec-board.agent",
  prompt: "spec-board.prompt",
  triage: "spec-board.triageSkills",
  flow: "spec-board.flowSkills",
  worktreeRoot: "spec-board.worktreeRoot",
  branchPrefix: "spec-board.branchPrefix",
  sort: "spec-board.sort",
  showDone: "spec-board.showDone",
};
const text = (key, fallback) => {
  const v = shared(key);
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
};
export const agentKey = () => text(KEY.agent, "claude");
export const promptTemplate = () => text(KEY.prompt, "/{skill} {args}");
export const branchPrefix = () => {
  const v = shared(KEY.branchPrefix);
  return typeof v === "string" ? v.trim() : "feat/";
};
export const worktreeRoot = () => norm(text(KEY.worktreeRoot, join(home(), ".herdr/worktrees")).replace(/^~(?=[\\/]|$)/, home()));
const names = (key, fallback) => text(key, fallback).split(/[\s,;]+/).filter(Boolean);
export const triageNames = () => names(KEY.triage, "sdd-triar");
export const flowNames = () => names(KEY.flow, "sdd-orquestrar-fluxo");

/**
 * The first name of `candidates` that is installed as a skill for the
 * repository (`.claude/skills`, `.agents/skills`) or for the person
 * (`~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills`). With none, the first name.
 */
export async function resolveSkill(candidates, repoRoot) {
  const dirs = [
    join(repoRoot, ".claude/skills"), join(repoRoot, ".agents/skills"),
    join(home(), ".claude/skills"), join(home(), ".agents/skills"), join(home(), ".codex/skills"),
  ];
  for (const name of candidates) {
    for (const dir of dirs) {
      const found = await readTextFile(join(dir, name, "SKILL.md")).catch(() => null);
      if (found != null) return name;
    }
  }
  return candidates[0];
}

/** The message for the agent, from the template: `{skill}` and `{args}`. */
export function promptFor(skill, args) {
  return promptTemplate().replace(/\{skill\}/g, skill).replace(/\{args\}/g, args).trim();
}

/** `text` as one argument in double quotes, for a skill's argument line. */
export const quoteArg = (s) => `"${String(s).replace(/\s+/g, " ").trim().replace(/"/g, "'")}"`;

/** The argv of the chosen agent: its `run` from knownAgents(), else its key as a program. */
export async function agentArgv() {
  const key = agentKey();
  const list = await knownAgents().catch(() => []);
  const a = list.find((x) => x.key === key) ?? list.find((x) => x.name?.toLowerCase() === key.toLowerCase());
  return a?.run?.length ? a.run : [key];
}

/**
 * The open space of this computer that works in `folder`: a space with a
 * terminal whose live folder is in it, the shown space first.
 */
export function spaceFor(folder) {
  const tabs = new Map();
  for (const p of panes()) if (p.terminal && inside(p.cwd, folder)) tabs.set(p.tab, (tabs.get(p.tab) ?? 0) + 1);
  const hits = spaces()
    .filter((s) => s.machine == null)
    .map((s) => ({ s, n: s.tabs.reduce((sum, t) => sum + (tabs.get(t.id) ?? 0), 0) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => (Number(b.s.active) - Number(a.s.active)) || (b.n - a.n));
  return hits[0]?.s ?? null;
}

/**
 * Starts the agent in `folder` with `prompt` as its first message: a new tab
 * in the space that works there, else a new space. Returns "tab" or "space".
 */
export async function launch(folder, prompt, name) {
  const argv = await agentArgv();
  const space = spaceFor(folder);
  if (space) {
    run("space.select", { id: space.id });
    run("tab.new", { space: space.id, folder: native(folder), argv, task: prompt, ...(name ? { name } : {}) });
    return "tab";
  }
  run("space.new", { folder: native(folder), argv, task: prompt, ...(name ? { tab: name } : {}) });
  return "space";
}

/**
 * The open session of the chosen agent that can take a message in `folder`:
 * an agent of this computer that is idle (or done) and whose live folder is in
 * `folder`. The most recent one first. Null when there is none.
 */
export function openSession(folder) {
  const key = agentKey().toLowerCase();
  const local = new Set(spaces().filter((s) => s.machine == null).map((s) => s.id));
  const cwd = new Map(panes().map((p) => [p.pane, p.cwd]));
  const hits = agents().filter((a) => (a.status === "idle" || a.status === "done") && local.has(a.space)
    && (a.program?.key?.toLowerCase() === key || a.program?.name?.toLowerCase() === key)
    && inside(cwd.get(a.pane), folder));
  return hits.sort((a, b) => b.seq - a.seq)[0] ?? null;
}

/** Sends `prompt` to the open session `agent` (`hc send`) and shows its terminal. */
export async function sendToSession(agent, prompt) {
  const r = await hc(["send", agent.address, prompt]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim());
  run("agent.focus", { terminal: agent.address });
}

/** A branch name from free text: "Add login with Google" → "feat/add-login-with-google". */
export function branchFrom(textOrSlug, words = 4) {
  const slug = String(textOrSlug).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, words).join("-");
  return slug ? `${branchPrefix()}${slug}` : "";
}

/** Rejects with a message when `branch` is not a valid git branch name. */
export async function checkBranch(repoPath, branch) {
  if (!branch.trim()) throw new Error("empty");
  await git(repoPath, ["check-ref-format", "--branch", branch.trim()]);
}

/** Where a new worktree of `repoName` for `branch` goes. */
export const worktreePath = (repoName, branch) => join(worktreeRoot(), repoName, branch);

/**
 * Makes a worktree for `branch` from the checkout at `from`: a new branch
 * from its HEAD, or the branch that already exists. Returns its path.
 */
export async function makeWorktree(from, repoName, branch) {
  const path = worktreePath(repoName, branch);
  const exists = await git(from, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
  await git(from, exists ? ["worktree", "add", native(path), branch] : ["worktree", "add", "-b", branch, native(path)]);
  return path;
}

/**
 * Whether the spec folder is in the last commit as it is now:
 * "committed", "changed" (tracked, with changes) or "untracked".
 */
export async function commitState(spec) {
  const rel = `tasks/${spec.dir}`;
  const tracked = (await git(spec.where.path, ["ls-files", "--", rel]).catch(() => "")).trim();
  if (!tracked) return "untracked";
  const dirty = (await git(spec.where.path, ["status", "--porcelain", "--", rel]).catch(() => "")).trim();
  return dirty ? "changed" : "committed";
}

/** True when git tracks a file of the spec folder. */
export async function isTracked(spec) {
  return Boolean((await git(spec.where.path, ["ls-files", "--", `tasks/${spec.dir}`]).catch(() => "")).trim());
}

/** Copies the spec folder into `tasks/` of the worktree at `to`. */
export async function copySpec(spec, to) {
  const dest = join(to, "tasks", spec.dir);
  if (isWin()) {
    await powershell(`$d=${psQuote(native(dest))}; New-Item -ItemType Directory -Force -Path (Split-Path -Parent $d) | Out-Null; `
      + `Copy-Item -LiteralPath ${psQuote(native(spec.path))} -Destination $d -Recurse -Force`);
    return dest;
  }
  const r = await exec("sh", ["-c", 'mkdir -p "$(dirname "$2")" && cp -R "$1" "$2"', "sh", spec.path, dest]);
  if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
  return dest;
}

/** Moves a folder to the trash (Recycle Bin on Windows; `gio trash` on Linux, else `rm -rf`). */
export async function trash(path) {
  if (isWin()) {
    await powershell("Add-Type -AssemblyName Microsoft.VisualBasic; "
      + `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(${psQuote(native(path))}, 'OnlyErrorDialogs', 'SendToRecycleBin')`);
    return;
  }
  const r = await exec("sh", ["-c", 'gio trash "$1" 2>/dev/null || rm -rf "$1"', "sh", path]);
  if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
}
