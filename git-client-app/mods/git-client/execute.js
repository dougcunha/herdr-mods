// Action execution is separate from the UI so context checks can be tested
// against disposable repositories. exec has Herdr's (program, argv, options) shape.
// io: { writePatch(text) → path, remove(path) }, for hunk patches in a local repository.
import { READ, commandsFor, gitError } from "./git.js";

// Staging, remotes, worktrees and stashes don't move the checked-out branch: no HEAD check.
const STAGING = new Set(["stage", "unstage", "discard", "stageHunk", "unstageHunk", "discardHunk",
  "fetchRemote", "addRemote", "renameRemote", "setRemoteUrl", "removeRemote", "addWorktree", "removeWorktree", "lockWorktree", "unlockWorktree",
  "pruneWorktrees", "stashApply", "stashPop", "stashDrop",
  "submoduleUpdate", "submoduleUpdateRemote", "submoduleSync", "submoduleAdd", "submoduleRemove"]);
const HUNK = { stageHunk: ["--cached"], unstageHunk: ["--cached", "-R"], discardHunk: ["-R"] };

export async function executeAction(action, values, ctx, exec, io = null) {
  const git = (args) => exec("git", args, { cwd: ctx.root, on: ctx.on });
  if (HUNK[action.type]) return applyPatch(action.patch, HUNK[action.type], ctx, exec, io);
  const commands = commandsFor(action, values, ctx);
  // A dialog/menu describes this snapshot, not whatever HEAD happens to be
  // when the user confirms it. Fetch does not operate on the current branch.
  if (action.type !== "fetch" && !STAGING.has(action.type)) {
    const head = await git([...READ, "rev-parse", "--verify", "-q", "HEAD"]);
    const branch = await git([...READ, "symbolic-ref", "-q", "--short", "HEAD"]);
    // Exit 1 means unborn HEAD or detached HEAD, respectively. Other failures
    // are not empty states and must not authorize a mutation.
    if (![0, 1].includes(head.code) || ![0, 1].includes(branch.code)) {
      return { ok: false, message: "Cannot verify the repository state. Close this action and refresh the panel." };
    }
    const actualHead = head.code === 0 ? head.stdout.trim() : null;
    const actualBranch = branch.code === 0 ? branch.stdout.trim() : null;
    if (actualHead !== ctx.head || actualBranch !== ctx.current) {
      return { ok: false, stale: true, message: "The repository's branch or HEAD changed. Close this action, refresh the panel, and review it again." };
    }
  }
  // Staging everything would mark unresolved conflicts resolved and commit their markers.
  if (action.type === "commit" && values.all) {
    const unmerged = await git([...READ, "ls-files", "--unmerged"]);
    if (unmerged.code !== 0 || unmerged.stdout.trim()) {
      return { ok: false, message: "There are unresolved merge conflicts. Resolve them first, or turn off \"Commit all\"." };
    }
  }
  // Git has no transaction spanning these commands and other terminals. This
  // preflight detects an already changed context; it cannot lock out future edits.
  for (const args of commands) {
    const result = await git(args);
    if (result.code !== 0) return { ok: false, message: gitError(result) };
  }
  return { ok: true };
}

// One hunk with `git apply`. exec takes no input, so the patch goes through a file here, and
// through an argument of `sh -c` on another machine (a Unix one).
async function applyPatch(patch, flags, ctx, exec, io) {
  if (typeof patch !== "string" || !patch.startsWith("diff --git ") || !patch.endsWith("\n")) return { ok: false, message: "Invalid patch" };
  const args = ["apply", "--whitespace=nowarn", ...flags];
  let result;
  if (ctx.on) {
    result = await exec("sh", ["-c", `printf '%s' "$1" | git ${args.join(" ")} -`, "sh", patch], { cwd: ctx.root, on: ctx.on });
  } else {
    if (!io) return { ok: false, message: "Cannot write the patch" };
    const file = await io.writePatch(patch);
    try { result = await exec("git", [...args, file], { cwd: ctx.root }); }
    finally { await io.remove(file); }
  }
  if (result.code !== 0) return { ok: false, message: `${gitError(result)}\nIf the file changed after the diff was read, refresh and try again.` };
  return { ok: true };
}
