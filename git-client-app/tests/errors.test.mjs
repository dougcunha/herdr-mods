import assert from "node:assert/strict";
import { describeError, failTitle, errorDialogHeight } from "../mods/git-client/errors.js";
import { gitError } from "../mods/git-client/git.js";

// ---- Exact error reported by the user: fetchBranch when branch is checked out in another worktree
{
  const raw = "fatal: refusing to fetch into branch 'refs/heads/master' checked out at 'D:/Projetos/dconnect'";
  const err = describeError({ type: "fetchBranch", name: "master", remote: "origin", branch: "master" }, raw);
  assert.equal(err.title, "Couldn't update master");
  assert.match(err.summary, /Branch master is checked out in another worktree \(D:\/Projetos\/dconnect\)/);
  assert.match(err.hint ?? "", /Open that worktree.*origin\/master/);
  assert.equal(err.detail, raw);
  assert.equal(err.worktree, "D:/Projetos/dconnect");
}

// ---- Worktree checked out variants (checkout / deleteBranch)
{
  const raw = "fatal: 'feat/x' is already used by worktree at 'D:/MyProjects/wt'";
  const err = describeError({ type: "checkout", name: "feat/x" }, raw);
  assert.equal(err.title, "Branch is open in another worktree");
  assert.equal(err.worktree, "D:/MyProjects/wt");
  assert.match(err.summary, /feat\/x.*D:\/MyProjects\/wt/);

  const delRaw = "error: cannot delete branch 'feat/x' used by worktree at 'D:/MyProjects/wt'";
  const delErr = describeError({ type: "deleteBranch", name: "feat/x" }, delRaw);
  assert.equal(delErr.title, "Couldn't delete feat/x");
  assert.equal(delErr.worktree, "D:/MyProjects/wt");
}

// ---- Non-fast-forward on fetchBranch
{
  const raw = "! [rejected]        lag        -> lag  (non-fast-forward)";
  const err = describeError({ type: "fetchBranch", name: "lag", remote: "origin", branch: "lag" }, raw);
  assert.equal(err.title, "Couldn't fast-forward lag");
  assert.match(err.summary, /local commits/);
  assert.match(err.hint ?? "", /Check out lag/);
}

// ---- Divergent pull
{
  const err = describeError({ type: "pull", upstream: "origin/main" }, "fatal: Not possible to fast-forward, aborting.");
  assert.equal(err.title, "Couldn't fast-forward");
  assert.match(err.hint ?? "", /Pull setting/);
}

// ---- Force push with lease blocked
{
  const err = describeError({ type: "forcePush", name: "feat" }, "! [rejected] feat -> feat (stale info)");
  assert.equal(err.title, "Force push was blocked");
  assert.match(err.summary, /force-with-lease/);
}

// ---- Push rejected
{
  const err = describeError({ type: "push", name: "main" }, "! [rejected] main -> main (fetch first)\nerror: failed to push some refs");
  assert.equal(err.title, "Push was rejected");
  assert.match(err.hint ?? "", /Pull the remote changes/);
}

// ---- Uncommitted changes in the way
{
  const err = describeError({ type: "checkout", name: "main" }, "error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit your changes or stash them before you switch branches.");
  assert.equal(err.title, "Uncommitted changes are in the way");
  assert.match(err.hint ?? "", /Commit or stash/);
}

// ---- Merge conflicts
{
  const err = describeError({ type: "merge", ref: "main" }, "Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.");
  assert.equal(err.title, "Stopped on merge conflicts");
  assert.match(err.hint ?? "", /Changes tab/);
}

// ---- Branch not fully merged
{
  const err = describeError({ type: "deleteBranch", name: "topic" }, "error: The branch 'topic' is not fully merged.");
  assert.equal(err.title, "Branch is not fully merged");
  assert.match(err.summary, /topic/);
  assert.match(err.hint ?? "", /Force delete/);
}

// ---- Name already exists
{
  const err = describeError({ type: "newBranch" }, "fatal: a branch named 'foo' already exists");
  assert.equal(err.title, "Name already exists");
  assert.match(err.summary, /foo/);
}

// ---- Authentication failure
{
  const err = describeError({ type: "fetch" }, "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.");
  assert.equal(err.title, "Authentication failed");
  assert.match(err.hint ?? "", /SSH key/);
}

// ---- Network failure
{
  const err = describeError({ type: "fetch" }, "fatal: unable to access 'https://example.com/repo.git/': Could not resolve host: example.com");
  assert.equal(err.title, "Couldn't reach the remote");
}

// ---- Lock file
{
  const err = describeError({ type: "commit" }, "fatal: Unable to create '/repo/.git/index.lock': File exists.");
  assert.equal(err.title, "Repository is locked");
}

// ---- Worktree has uncommitted changes
{
  const err = describeError({ type: "removeWorktree", path: "/tmp/wt" }, "fatal: '/tmp/wt' contains modified or untracked files, use --force to delete it");
  assert.equal(err.title, "Worktree has uncommitted changes");
}

// ---- Nothing to commit
{
  const err = describeError({ type: "commit" }, "On branch main\nnothing to commit, working tree clean");
  assert.equal(err.title, "Nothing to commit");
}

// ---- Fallback strips fatal:/error: and avoids duplicating plain single-line preflight messages
{
  const err = describeError({ type: "merge", ref: "main" }, "fatal: bad revision 'nope'");
  assert.equal(err.title, "Couldn't merge");
  assert.equal(err.summary, "Bad revision 'nope'");
  assert.equal(err.detail, "fatal: bad revision 'nope'");
  assert.equal(err.worktree, null);

  const preflight = describeError({ type: "commit" }, "There are unresolved merge conflicts. Resolve them first.");
  assert.equal(preflight.summary, "There are unresolved merge conflicts. Resolve them first.");
  assert.equal(preflight.detail, "", "plain sentence is not duplicated in detail");
}

// ---- failTitle coverage
assert.equal(failTitle({ type: "aiMessage" }), "Couldn't generate a commit message");
assert.equal(failTitle({ type: "commit" }, { amend: true }), "Couldn't amend commit");
assert.equal(failTitle(null), "Git command failed");

// ---- gitError combines stderr + stdout, normalizes CRLF, strips hints, keeps up to 40 lines
{
  const out = gitError({
    code: 1,
    stderr: "hint: use --force\r\nfatal: error one\r\n",
    stdout: "CONFLICT (content): Merge conflict in a.txt\n",
  });
  assert.equal(out, "fatal: error one\nCONFLICT (content): Merge conflict in a.txt");

  const many = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  const capped = gitError({ code: 1, stderr: many, stdout: "" });
  assert.match(capped, /^… \(10 earlier lines omitted\)\nline 11\n/);
  assert.ok(capped.endsWith("line 50"));
}

// ---- errorDialogHeight clamping
{
  const small = errorDialogHeight({ summary: "Short error.", hint: null, detail: "" });
  const huge = errorDialogHeight({
    summary: "A ".repeat(200),
    hint: "B ".repeat(200),
    detail: Array.from({ length: 40 }, () => "line of output").join("\n"),
  });
  assert.ok(small >= 210 && small <= 480);
  assert.equal(huge, 480);
}

console.log("errors ok");
