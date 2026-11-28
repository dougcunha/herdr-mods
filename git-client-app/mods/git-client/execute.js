// Action execution is separate from the UI so context checks can be tested
// against disposable repositories. exec has Herdr's (program, argv, options) shape.
// io: { writePatch(text) → path, remove(path) }, for hunk patches in a local repository,
// and appendLine(file, line), for the ignore files of a local repository.
import { READ, commandsFor, gitError, ignoreLine, ignoreChoices, parseUnmerged } from "./git.js";
import { describeError } from "./errors.js";

const fail = (action, raw, values) => {
  const error = describeError(action, raw, values);
  return { ok: false, message: error.summary, error };
};

// Staging, remotes, worktrees and stashes don't move the checked-out branch: no HEAD check.
const STAGING = new Set(["stage", "unstage", "discard", "ignore", "ignoreMany", "untrack", "untrackMany", "stageHunk", "unstageHunk", "discardHunk",
  "resolveConflict",
  "fetchRemote", "addRemote", "renameRemote", "setRemoteUrl", "removeRemote", "addWorktree", "removeWorktree", "lockWorktree", "unlockWorktree",
  "pruneWorktrees", "stashApply", "stashPop", "stashDrop",
  "submoduleUpdate", "submoduleUpdateRemote", "submoduleSync", "submoduleAdd", "submoduleRemove", "submodulePull", "submoduleFetch"]);
const HUNK = { stageHunk: ["--cached"], unstageHunk: ["--cached", "-R"], discardHunk: ["-R"] };

export async function executeAction(action, values, ctx, exec, io = null) {
  const git = (args) => exec("git", args, { cwd: ctx.root, on: ctx.on });
  if (action.type === "resolveConflict") return resolveConflict(action, ctx, exec);
  if (action.type === "submoduleChooseBranch") return updateSubmoduleBranch(action, values, ctx, exec);
  if (action.type === "submodulePull") return pullSubmodule(action, ctx, exec);
  if (action.type === "submoduleFetch") return fetchSubmodules(action, values, ctx, exec);
  if (HUNK[action.type]) return applyPatch(action.patch, HUNK[action.type], ctx, exec, io);
  if (action.type === "ignore") {
    // Only a line that the dialog offers for this file: a value never names an other path.
    const pick = typeof action.path === "string" && action.path ? ignoreChoices(action.path).find((c) => c.value === values.what) : null;
    if (!pick) return { ok: false, message: "Invalid choice" };
    return addIgnore(pick.line, values.local ? "exclude" : "gitignore", ctx, exec, io);
  }
  if (action.type === "ignoreMany") {
    if (!["gitignore", "exclude"].includes(values.where)) return { ok: false, message: "Invalid ignore file" };
    if (!Array.isArray(action.paths) || !action.paths.length || action.paths.some((p) => typeof p !== "string" || !p || p.includes("\0"))) {
      return { ok: false, message: "Invalid path" };
    }
    for (const p of action.paths) {
      const added = await addIgnore(ignoreLine(p), values.where, ctx, exec, io);
      if (!added.ok) return added;
    }
    return { ok: true };
  }
  if ((action.type === "untrack" || action.type === "untrackMany") && !["gitignore", "exclude"].includes(values.where)) return { ok: false, message: "Invalid ignore file" };
  let effectiveAction = action;
  if (action.type === "deleteBranches" && Array.isArray(action.local) && action.local.length > 0) {
    const existing = await git([...READ, "for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    if (existing.code === 0) {
      const live = new Set(existing.stdout.split(/\r?\n/).filter(Boolean));
      effectiveAction = { ...action, local: action.local.filter((n) => live.has(n)) };
      if (effectiveAction.local.length === 0 && !(effectiveAction.remote?.length > 0)) return { ok: true };
    }
  }
  const commands = commandsFor(effectiveAction, values, ctx);
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
    if (result.code !== 0) return fail(action, gitError(result), values);
  }
  if (action.type === "untrack") {
    const added = await addIgnore(ignoreLine(action.path), values.where, ctx, exec, io);
    if (!added.ok) return { ok: false, message: `Git stopped tracking ${action.path}, but the ignore file did not change.\n${added.message}` };
  }
  if (action.type === "untrackMany") {
    for (const p of action.paths) {
      const added = await addIgnore(ignoreLine(p), values.where, ctx, exec, io);
      if (!added.ok) return { ok: false, message: `Git stopped tracking the selected files, but the ignore file did not update cleanly.\n${added.message}` };
    }
  }
  return { ok: true };
}

async function submoduleGit(ctx, path, exec) {
  if (typeof path !== "string" || !path || /[\\\0]|^\/|(?:^|\/)\.\.?(?:\/|$)/.test(path)) {
    throw new Error("Invalid submodule path.");
  }
  const git = (args) => exec("git", args, { cwd: `${ctx.root}/${path}`, on: ctx.on, timeout: 60000 });
  // Git can otherwise fall back to the parent when the submodule is deinitialized.
  const root = await git(["rev-parse", "--show-prefix", "--show-superproject-working-tree"]);
  const [prefix, parent] = (root.stdout ?? "").split(/\r?\n/);
  if (root.code !== 0 || prefix || !parent) throw new Error("Initialize the submodule before updating it.");
  return git;
}

async function submoduleRemotes(git) {
  const result = await git(["remote"]);
  if (result.code !== 0) throw new Error(gitError(result));
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

export async function listSubmoduleBranches(path, ctx, exec) {
  const git = await submoduleGit(ctx, path, exec);
  const remotes = await submoduleRemotes(git);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (!remote) throw new Error("The submodule has no remote.");
  const result = await git(["ls-remote", "--heads", "--", remote]);
  if (result.code !== 0) throw new Error(gitError(result));
  const branches = result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^[0-9a-f]+\trefs\/heads\/(.+)$/.exec(line);
    return match ? [match[1]] : [];
  });
  if (!branches.length) throw new Error(`No branches found on ${remote}.`);
  return { remote, branches };
}

// Fast local + cached remote branch listing for the Submodule Branch Picker.
// Runs without network unless fetch=true is explicitly requested.
export async function listSubmoduleLocalAndRemoteBranches(path, ctx, exec, { fetch = false } = {}) {
  const git = await submoduleGit(ctx, path, exec);
  const remotes = await submoduleRemotes(git);
  const remote = remotes.includes("origin") ? "origin" : remotes[0] ?? null;
  if (fetch && remote) {
    const fetched = await git(["fetch", "--prune", "--no-recurse-submodules", "--", remote]);
    if (fetched.code !== 0) throw new Error(gitError(fetched));
  }
  const [refsRes, headRes] = await Promise.all([
    git([...READ, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]),
    git([...READ, "symbolic-ref", "-q", "--short", "HEAD"]),
  ]);
  if (refsRes.code !== 0) throw new Error(gitError(refsRes));
  const current = headRes.code === 0 ? headRes.stdout.trim() || null : null;
  const local = [];
  const remoteBranches = [];
  for (const line of refsRes.stdout.split(/\r?\n/)) {
    const ref = line.trim();
    if (!ref) continue;
    if (ref.startsWith("refs/heads/")) {
      local.push(ref.slice(11));
    } else if (ref.startsWith("refs/remotes/")) {
      const full = ref.slice(13);
      const slash = full.indexOf("/");
      if (slash < 0 || full.endsWith("/HEAD")) continue;
      const rName = full.slice(0, slash), bName = full.slice(slash + 1);
      if (!remote || rName === remote) remoteBranches.push(bName);
    }
  }
  const seen = new Set();
  const branches = [];
  const add = (name) => { if (name && !seen.has(name)) { seen.add(name); branches.push(name); } };
  if (current) add(current);
  for (const b of local) add(b);
  for (const b of remoteBranches) add(b);
  return { remote, current, local, remoteBranches, branches };
}

// Safe submodule branch switch: checks out existing local branches + --ff-only (never overwriting
// unpushed local commits with switch -C), or creates a real local tracking branch for remote-only ones.
async function updateSubmoduleBranch(action, values, ctx, exec) {
  const branch = typeof values === "string" ? values : values?.branch;
  const updateGitmodules = typeof values === "object" && Boolean(values?.updateGitmodules);
  const allowed = action.branches;
  if (!branch || (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(branch))) {
    return { ok: false, message: "Pick a branch." };
  }
  const git = await submoduleGit(ctx, action.path, exec);
  const check = await git(["check-ref-format", `refs/heads/${branch}`]);
  if (check.code !== 0) return { ok: false, message: "Invalid branch name." };

  const remotes = await submoduleRemotes(git);
  const remote = action.remote && remotes.includes(action.remote) ? action.remote
    : remotes.includes("origin") ? "origin" : remotes[0] ?? null;

  const hasLocal = (await git([...READ, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  if (hasLocal) {
    const switched = await git(["switch", "--no-recurse-submodules", "--no-overwrite-ignore", branch, "--"]);
    if (switched.code !== 0) return fail(action, gitError(switched), values);
    if (remote) {
      const source = `refs/heads/${branch}`, target = `refs/remotes/${remote}/${branch}`;
      const knownRemote = !Array.isArray(action.remoteBranches) || action.remoteBranches.includes(branch);
      if (knownRemote) {
        await git(["fetch", "--no-tags", "--no-recurse-submodules", "--refmap=", "--", remote, `+${source}:${target}`]).catch(() => null);
      }
      const hasRemoteRef = (await git([...READ, "show-ref", "--verify", "--quiet", target])).code === 0;
      if (hasRemoteRef) {
        const merged = await git(["merge", "--ff-only", `${remote}/${branch}`]);
        if (merged.code !== 0) {
          return {
            ok: false,
            message: `Switched to local branch '${branch}', but it has diverged from '${remote}/${branch}'. Open the submodule to merge or rebase.`,
          };
        }
      }
    }
  } else {
    if (!remote) return { ok: false, message: `Branch '${branch}' was not found locally and the submodule has no remote.` };
    const source = `refs/heads/${branch}`, target = `refs/remotes/${remote}/${branch}`;
    const fetched = await git(["fetch", "--no-tags", "--no-recurse-submodules", "--refmap=", "--", remote, `+${source}:${target}`]);
    if (fetched.code !== 0) return fail(action, gitError(fetched), values);
    const switched = await git(["switch", "-c", branch, "--track", `${remote}/${branch}`, "--no-recurse-submodules", "--no-overwrite-ignore"]);
    if (switched.code !== 0) return fail(action, gitError(switched), values);
  }

  if (updateGitmodules && !action.nested) {
    const setBranch = await exec("git", ["submodule", "set-branch", "--branch", branch, "--", action.path], { cwd: ctx.root, on: ctx.on });
    if (setBranch.code !== 0) return fail(action, gitError(setBranch), values);
  }
  return { ok: true };
}

async function pullSubmodule(action, ctx, exec) {
  const git = await submoduleGit(ctx, action.path, exec);
  const headBranch = await git([...READ, "symbolic-ref", "-q", "--short", "HEAD"]);
  if (headBranch.code === 0 && headBranch.stdout.trim()) {
    const current = headBranch.stdout.trim();
    const up = await git([...READ, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (up.code !== 0) {
      return { ok: false, message: `Branch '${current}' in ${action.path} has no upstream configured.` };
    }
    const pulled = await git(["pull", "--ff-only", "--no-recurse-submodules", "--quiet"]);
    return pulled.code === 0 ? { ok: true } : fail(action, gitError(pulled));
  }
  const updated = await exec("git", ["submodule", "update", "--init", "--remote", "--recursive", "--", action.path], { cwd: ctx.root, on: ctx.on, timeout: 60000 });
  return updated.code === 0 ? { ok: true } : fail(action, gitError(updated));
}

async function fetchSubmodules(action, values, ctx, exec) {
  const pruneArgs = values?.prune === false ? [] : ["--prune"];
  if (action.path) {
    const git = await submoduleGit(ctx, action.path, exec);
    const remotes = await submoduleRemotes(git);
    if (!remotes.length) return { ok: false, message: `Submodule ${action.path} has no remote.` };
    const res = await git(["fetch", "--all", ...pruneArgs, "--no-recurse-submodules"]);
    return res.code === 0 ? { ok: true } : fail(action, gitError(res), values);
  }
  const status = await exec("git", [...READ, "submodule", "status", "--recursive"], { cwd: ctx.root, on: ctx.on, timeout: 60000 });
  if (status.code !== 0) return fail(action, gitError(status), values);
  const paths = String(status.stdout ?? "").split(/\r?\n/).map((line) => {
    const m = /^([ +U])[0-9a-f]{40,64} (.+?)(?: \((.*)\))?$/.exec(line);
    return m ? m[2] : null;
  }).filter(Boolean);
  const errors = [];
  for (let i = 0; i < paths.length; i += 4) {
    await Promise.all(paths.slice(i, i + 4).map(async (p) => {
      if (typeof p !== "string" || !p || /[\\\0]|^\/|(?:^|\/)\.\.?(?:\/|$)/.test(p)) {
        errors.push(`${p}: Invalid submodule path.`);
        return;
      }
      const r = await exec("git", ["fetch", "--all", ...pruneArgs, "--no-recurse-submodules"], { cwd: `${ctx.root}/${p}`, on: ctx.on, timeout: 60000 });
      if (r.code !== 0) errors.push(`${p}: ${gitError(r)}`);
    }));
  }
  if (errors.length) return fail(action, errors.join("\n"), values);
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
  if (result.code !== 0) {
    const type = flags.includes("-R") ? (flags.includes("--cached") ? "unstageHunk" : "discardHunk") : "stageHunk";
    return fail({ type }, `${gitError(result)}\nIf the file changed after the diff was read, refresh and try again.`);
  }
  return { ok: true };
}

// Adds a line to the .gitignore at the top of the work tree, or to the exclude file
// of the repository (its own for a worktree: git says where). A line that is already there stays once.
async function addIgnore(line, where, ctx, exec, io) {
  let file = `${ctx.root}/.gitignore`;
  if (where === "exclude") {
    const r = await exec("git", [...READ, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { cwd: ctx.root, on: ctx.on });
    if (r.code !== 0 || !r.stdout.trim()) return { ok: false, message: gitError(r) || "Cannot find the exclude file" };
    file = r.stdout.trim();
  }
  if (ctx.on) {
    // Makes the folder, ends an unfinished last line, and adds the line when it is not there.
    const script = 'mkdir -p "$(dirname "$1")" && touch "$1" && { grep -qxF -- "$2" "$1" || { [ -s "$1" ] && [ -n "$(tail -c1 "$1")" ] && echo >> "$1"; printf "%s\\n" "$2" >> "$1"; }; }';
    const r = await exec("sh", ["-c", script, "sh", file, line], { cwd: ctx.root, on: ctx.on });
    return r.code === 0 ? { ok: true } : { ok: false, message: gitError(r) || `Cannot write ${file}` };
  }
  if (!io?.appendLine) return { ok: false, message: `Cannot write ${file}` };
  try { await io.appendLine(file, line); } catch (e) { return { ok: false, message: `Cannot write ${file}: ${e?.message ?? e}` }; }
  return { ok: true };
}

async function resolveConflict(action, ctx, exec) {
  if (action.side !== "ours" && action.side !== "theirs") return { ok: false, message: "Invalid conflict side" };
  const paths = Array.isArray(action.paths) ? action.paths : [];
  if (!paths.length || paths.some((p) => typeof p !== "string" || !p || p.includes("\0"))) {
    return { ok: false, message: "Invalid path" };
  }
  const git = (args) => exec("git", args, { cwd: ctx.root, on: ctx.on });
  const ls = await git([...READ, "--literal-pathspecs", "ls-files", "--unmerged", "-z", "--", ...paths]);
  if (ls.code !== 0) return fail(action, gitError(ls));
  const unmerged = parseUnmerged(ls.stdout);
  const stage = action.side === "ours" ? 2 : 3;
  for (const p of paths) {
    const entry = unmerged.get(p);
    if (!entry) {
      if (paths.length === 1) return { ok: false, message: `${p} is no longer in conflict. Refresh and try again.` };
      continue;
    }
    const chosen = entry[stage];
    if (!chosen) {
      const rm = await git(["--literal-pathspecs", "rm", "-f", "--", p]);
      if (rm.code !== 0) return fail(action, gitError(rm));
    } else if (chosen.mode === "160000") {
      // Submodule gitlink conflicts resolve directly in the index without touching the submodule worktree.
      const upd = await git(["update-index", "--cacheinfo", `160000,${chosen.hash},${p}`]);
      if (upd.code !== 0) return fail(action, gitError(upd));
    } else {
      const co = await git(["--literal-pathspecs", "checkout", `--${action.side}`, "--", p]);
      if (co.code !== 0) return fail(action, gitError(co));
      const add = await git(["--literal-pathspecs", "add", "--", p]);
      if (add.code !== 0) return fail(action, gitError(add));
    }
  }
  return { ok: true };
}
