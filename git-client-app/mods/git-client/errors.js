// Clear, human-readable descriptions of Git failures for the error dialog and inline dialog callouts.
// Pure module (no herdr/gpui-kit imports) so unit tests can import it directly in Node.

const stripRefsPrefix = (name) => String(name ?? "").replace(/^refs\/heads\//, "");

export function failTitle(action, values = {}) {
  switch (action?.type) {
    case "fetchBranch": return `Couldn't update ${action.name}`;
    case "fetch":
    case "fetchRemote": return action.name ? `Couldn't fetch ${action.name}` : "Couldn't fetch";
    case "pull": return `Couldn't pull${action.upstream ? ` ${action.upstream}` : ""}`;
    case "push": return `Couldn't push${action.name ? ` ${action.name}` : ""}`;
    case "forcePush": return `Couldn't force push${action.name ? ` ${action.name}` : ""}`;
    case "pushTag": return `Couldn't push tag ${action.name}`;
    case "checkout":
    case "checkoutRemote":
    case "checkoutCommit": return `Couldn't check out ${action.name ?? action.short ?? "branch"}`;
    case "commit": return values.amend ? "Couldn't amend commit" : "Couldn't commit";
    case "merge": return "Couldn't merge";
    case "rebase": return "Couldn't rebase";
    case "cherryPick": return "Couldn't cherry-pick";
    case "revert": return "Couldn't revert";
    case "reset":
    case "resetUncommitted": return "Couldn't reset";
    case "deleteBranch":
    case "deleteRemoteBranch": return `Couldn't delete ${action.name ?? action.branch ?? "branch"}`;
    case "deleteBranches": return "Couldn't delete branches";
    case "renameBranch": return `Couldn't rename ${action.name ?? "branch"}`;
    case "newBranch":
    case "createBranch": return "Couldn't create branch";
    case "newTag":
    case "addTag":
    case "deleteTag": return "Couldn't update tag";
    case "setUpstream": return `Couldn't set upstream for ${action.name}`;
    case "stash": return "Couldn't stash";
    case "stashApply": return "Couldn't apply stash";
    case "stashPop": return "Couldn't pop stash";
    case "stashDrop": return "Couldn't drop stash";
    case "addWorktree": return "Couldn't create worktree";
    case "removeWorktree": return "Couldn't remove worktree";
    case "lockWorktree": return "Couldn't lock worktree";
    case "unlockWorktree": return "Couldn't unlock worktree";
    case "pruneWorktrees": return "Couldn't prune worktrees";
    case "submoduleUpdate":
    case "submoduleUpdateRemote":
    case "submoduleChooseBranch": return `Couldn't update ${action.path || "submodules"}`;
    case "submoduleSync": return `Couldn't sync ${action.path || "submodules"}`;
    case "submoduleAdd": return "Couldn't add submodule";
    case "submoduleRemove": return `Couldn't remove ${action.path}`;
    case "stage":
    case "stageHunk": return "Couldn't stage";
    case "unstage":
    case "unstageHunk": return "Couldn't unstage";
    case "discard":
    case "discardHunk": return "Couldn't discard changes";
    case "ignore":
    case "ignoreMany": return "Couldn't update ignore file";
    case "untrack": return "Couldn't stop tracking file";
    case "untrackMany": return "Couldn't stop tracking files";
    case "continueOp": return `Couldn't continue ${action.op}`;
    case "abortOp": return `Couldn't abort ${action.op}`;
    case "addRemote":
    case "renameRemote":
    case "setRemoteUrl":
    case "removeRemote": return "Couldn't update remote";
    case "aiMessage": return "Couldn't generate a commit message";
    default: return "Git command failed";
  }
}

function worktreeCheckedOutMatch(text) {
  return /refusing to fetch into branch '([^']+)' checked out at '([^']+)'/i.exec(text)
    ?? /cannot (?:delete|use|check out|checkout) branch '([^']+)' (?:used by worktree|checked out) at '([^']+)'/i.exec(text)
    ?? /'([^']+)' is already (?:checked out|used by worktree) at '([^']+)'/i.exec(text);
}

function cleanFirstLine(text) {
  const first = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const stripped = first.replace(/^(?:fatal|error):\s*/i, "");
  return stripped ? stripped[0].toUpperCase() + stripped.slice(1) : "";
}

export function describeError(action, raw, values = {}) {
  const cleaned = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  const make = (title, summary, hint = null, worktree = null) => ({
    title,
    summary,
    hint,
    detail: cleaned && cleaned !== summary ? cleaned : "",
    worktree,
  });

  if (!cleaned) {
    return make(failTitle(action, values), "The Git command failed without any output.");
  }

  // 1. Branch checked out in another worktree
  const wtMatch = worktreeCheckedOutMatch(cleaned);
  if (wtMatch) {
    const branch = stripRefsPrefix(wtMatch[1]);
    const path = wtMatch[2];
    if (action?.type === "fetchBranch") {
      return make(
        `Couldn't update ${branch}`,
        `Branch ${branch} is checked out in another worktree (${path}). Git refuses to update a branch while another worktree has it open.`,
        `Open that worktree and pull there instead, or merge/rebase directly from ${action.remote}/${action.branch} in the Remote section.`,
        path,
      );
    }
    if (action?.type === "deleteBranch" || action?.type === "deleteBranches") {
      return make(
        `Couldn't delete ${branch}`,
        `Branch ${branch} is checked out in another worktree (${path}).`,
        "Open that worktree and switch it to another branch, or remove the worktree first.",
        path,
      );
    }
    return make(
      "Branch is open in another worktree",
      `Branch ${branch} is already checked out at ${path}. Git does not allow two worktrees on the same branch.`,
      `Open that worktree instead, or create a new branch from ${branch}.`,
      path,
    );
  }

  // 2. Non-fast-forward on fetchBranch
  if (action?.type === "fetchBranch" && /\[rejected\]|non-fast-forward/i.test(cleaned)) {
    return make(
      `Couldn't fast-forward ${action.name}`,
      `Branch ${action.name} has local commits that ${action.remote}/${action.branch} does not have, so Git cannot fast-forward it without a checkout.`,
      `Check out ${action.name} and pull (with merge or rebase) to combine the commits.`,
    );
  }

  // 3. Divergent / non-fast-forward pull
  if (/Not possible to fast-forward|divergent branches/i.test(cleaned)) {
    return make(
      "Couldn't fast-forward",
      "Your local branch and its upstream have diverged, so a fast-forward pull cannot combine them automatically.",
      "Change the Pull setting in PowerMods Settings (Rebase or Merge), or merge/rebase from the remote branch in the Branches tab.",
    );
  }

  // 4. Force push with lease blocked
  if (/stale info/i.test(cleaned) || (action?.type === "forcePush" && /fetch first|\[rejected\]/i.test(cleaned))) {
    return make(
      "Force push was blocked",
      "The remote branch changed after your last fetch, so --force-with-lease stopped to avoid overwriting those commits.",
      "Fetch first, inspect the new commits, and try again if you still want to overwrite them.",
    );
  }

  // 5. Push rejected (remote ahead)
  if (/Updates were rejected|\[rejected\][\s\S]*(?:non-fast-forward|fetch first)/i.test(cleaned)) {
    return make(
      "Push was rejected",
      "The remote branch has commits that you do not have locally.",
      "Pull the remote changes first (or fetch and rebase), then push again.",
    );
  }

  // 6. Local changes would be overwritten
  if (/local changes to the following files would be overwritten|untracked working tree files would be overwritten|Please commit your changes or stash them|cannot pull.*unstaged changes|cannot rebase.*unstaged changes/i.test(cleaned)) {
    return make(
      "Uncommitted changes are in the way",
      "You have uncommitted changes in the working tree that would be overwritten by this operation.",
      "Commit or stash your changes first, then try again.",
    );
  }

  // 7. Merge / rebase / cherry-pick / revert / stash conflicts
  if (/CONFLICT \(|Automatic merge failed|Merge conflict in|could not apply |Resolve all conflicts/i.test(cleaned)) {
    return make(
      "Stopped on merge conflicts",
      "Git could not combine the changes automatically because the same lines changed on both sides.",
      "Open the Changes tab to resolve the conflicted files (manually or with an agent), then continue or abort.",
    );
  }

  // 8. Unmerged branch on delete
  const unmerged = /branch '([^']+)' is not fully merged/i.exec(cleaned);
  if (unmerged) {
    return make(
      "Branch is not fully merged",
      `Branch ${unmerged[1]} has commits that have not been merged into the current branch.`,
      'Tick "Force delete" if you are sure you want to delete it anyway.',
    );
  }

  // 9. Branch or tag already exists
  const exists = /(?:branch|tag) named '([^']+)' already exists|tag '([^']+)' already exists/i.exec(cleaned);
  if (exists) {
    const name = exists[1] ?? exists[2];
    return make(
      "Name already exists",
      `A branch or tag named ${name} already exists in this repository.`,
      "Choose a different name and try again.",
    );
  }

  // 10. Authentication / permission failure
  if (/Permission denied \(publickey\)|Authentication failed|could not read Username|Repository not found|access rights|HTTP Basic: Access denied/i.test(cleaned)) {
    return make(
      "Authentication failed",
      "Git could not authenticate with the remote server.",
      "Check your SSH key, credential helper, or access permissions for this repository.",
    );
  }

  // 11. Network / unreachable remote
  if (/Could not resolve host|Failed to connect|Connection timed out|unable to access/i.test(cleaned)) {
    return make(
      "Couldn't reach the remote",
      "Git could not connect to the remote server.",
      "Check your internet connection, VPN, or remote URL and try again.",
    );
  }

  // 12. Repository lock file
  if (/Unable to create '([^']+\.lock)': File exists/i.test(cleaned)) {
    return make(
      "Repository is locked",
      "Another Git process is running, or an earlier one crashed and left a lock file behind.",
      "Wait for the other Git command to finish. If none is running, remove the lock file shown below.",
    );
  }

  // 13. Worktree has uncommitted files
  if (/contains modified or untracked files/i.test(cleaned)) {
    return make(
      "Worktree has uncommitted changes",
      "This worktree contains modified or untracked files, so Git refused to remove it.",
      'Commit or move those files first, or tick "Force" to discard them.',
    );
  }

  // 14. Nothing to commit
  if (/nothing to commit|no changes added to commit/i.test(cleaned)) {
    return make(
      "Nothing to commit",
      "There are no staged changes to commit.",
      'Stage at least one file, or turn on "Commit all".',
    );
  }

  // 15. Fallback
  const summary = cleanFirstLine(cleaned) || cleaned;
  return make(failTitle(action, values), summary, null, null);
}

export function errorDialogHeight(err) {
  const summaryLines = Math.max(1, Math.ceil((err?.summary?.length ?? 40) / 58));
  const hintHeight = err?.hint ? Math.ceil(err.hint.length / 54) * 18 + 26 : 0;
  let detailHeight = 0;
  if (err?.detail) {
    const rawLines = err.detail.split("\n");
    const wrapped = rawLines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 60)), 0);
    detailHeight = 28 + Math.min(180, Math.max(68, wrapped * 17 + 18));
  }
  const raw = 136 + summaryLines * 19 + hintHeight + detailHeight;
  return Math.max(210, Math.min(480, Math.ceil(raw)));
}
