// The AI commit message: asks a small model (Claude Code or Codex) for a message from the staged diff.
// The call runs on the machine of the repository. Settings: shared("git-client.ai"), set in the
// Settings tab of Herdr Mods (kit.json).
import { exec, knownAgents, shared } from "herdr";
import { READ, messagePrompt, cleanMessage, gitError } from "./git.js";

export const AI_KEY = "git-client.ai";
const DEFAULT_MODEL = { claude: "haiku", codex: "gpt-6-luna" };
// Characters of diff in the prompt: the whole prompt is one argument. A `.cmd` shim on Windows takes
// 8,191 characters in all, so stay well under it (as tab-namer does).
const DIFF_LIMIT = 6000;

export function aiSettings() {
  const s = shared(AI_KEY), o = s && typeof s === "object" ? s : {};
  return {
    provider: ["claude", "codex"].includes(o.provider) ? o.provider : "auto",
    model: typeof o.model === "string" ? o.model.trim() : "",
    format: ["repo", "conventional", "free"].includes(o.format) ? o.format : "repo",
    instructions: typeof o.instructions === "string" ? o.instructions.trim().slice(0, 1000) : "",
  };
}

const installed = new Map(); // machine → { at, ids }
async function engine(on) {
  const s = aiSettings();
  let provider = s.provider;
  if (provider === "auto") {
    const where = on ?? "", known = installed.get(where);
    let ids = known && Date.now() - known.at < 60000 ? known.ids : null;
    if (!ids) {
      ids = new Set();
      try { for (const a of await knownAgents({ on })) if (a.installed) ids.add(String(a.key ?? "").toLowerCase()); } catch {}
      installed.set(where, { at: Date.now(), ids });
    }
    const has = (k) => [...ids].some((id) => id === k || id.startsWith(k));
    provider = has("claude") ? "claude" : has("codex") ? "codex" : null;
  }
  return provider ? { provider, model: s.model || DEFAULT_MODEL[provider] } : null;
}

/** A message for the staged changes (or all changes with `all`). Resolves with the text, or throws an Error. */
export async function generateMessage({ root, on, all }) {
  const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
  const scope = all ? ["HEAD"] : ["--cached"];
  const [stat, diff, log] = await Promise.all([
    git(["diff", ...scope, "--stat", "--no-color"]),
    git(["diff", ...scope, "--no-color", "--no-ext-diff", "--no-textconv", "-U2"]),
    git(["log", "-n20", "--format=%s"]),
  ]);
  if (diff.code !== 0) throw new Error(gitError(diff));
  if (!diff.stdout.trim()) throw new Error(all ? "There are no changes." : "Nothing is staged. Stage some changes, or turn on Commit all.");
  const eng = await engine(on);
  if (!eng) throw new Error("Claude Code or Codex is not installed.");
  const s = aiSettings();
  const text = diff.stdout.length > DIFF_LIMIT ? `${diff.stdout.slice(0, DIFF_LIMIT)}\n… (diff cut)` : diff.stdout;
  const prompt = messagePrompt({ diff: text, stat: stat.stdout, subjects: log.code === 0 ? log.stdout.split("\n").filter(Boolean) : [], format: s.format, instructions: s.instructions });
  const r = eng.provider === "claude"
    // --no-session-persistence: the call is not a session in the history. --tools "": text only.
    ? await exec("claude", ["-p", prompt, "--model", eng.model, "--no-session-persistence", "--tools", ""], { cwd: root, on, timeout: 120000 })
    : await exec("codex", ["exec", "-m", eng.model, "--skip-git-repo-check", "--ephemeral", "-s", "read-only", prompt], { cwd: root, on, timeout: 120000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit code ${r.code}`).trim().split("\n").pop().slice(0, 200));
  // Codex prints its log on stderr and the answer on stdout.
  const message = cleanMessage(r.stdout);
  if (!message) throw new Error("The model gave no message.");
  return message;
}
