import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as G from "../mods/git-client/git.js";
import * as R from "../mods/git-client/refs.js";
import { failTitle } from "../mods/git-client/errors.js";
import { executeAction } from "../mods/git-client/execute.js";

// ---- Performance helpers: parseShowRef, sameBranchInfo, shouldReloadDependents, shouldAcceptChangeEvent, classifyRefresh
{
  const h1 = "a".repeat(40), h2 = "b".repeat(40);
  assert.deepEqual(G.parseShowRef(`${h1} HEAD\n${h1} refs/heads/main\n${h2} refs/heads/feat/x\n`), {
    head: h1,
    branches: ["main", "feat/x"],
  });
  assert.deepEqual(G.parseShowRef(""), { head: null, branches: [] });
  assert.deepEqual(G.parseShowRef(`${h1} HEAD\n`), { head: h1, branches: [] });

  const b1 = { branch: "main", upstream: "origin/main", ahead: 1, behind: 0, gone: false, detached: false, unborn: false };
  assert.equal(G.sameBranchInfo(b1, { ...b1 }), true);
  assert.equal(G.sameBranchInfo(b1, { ...b1, ahead: 2 }), false);
  assert.equal(G.sameBranchInfo(b1, null), false);

  assert.equal(G.shouldReloadDependents({ changed: false, force: false, target: "full", firstLoad: false, isError: false }), false);
  assert.equal(G.shouldReloadDependents({ changed: true, force: false, target: "full", firstLoad: false, isError: false }), true);
  assert.equal(G.shouldReloadDependents({ changed: false, force: true, target: "full", firstLoad: false, isError: false }), true);
  assert.equal(G.shouldReloadDependents({ changed: false, force: false, target: "stash", firstLoad: false, isError: false }), true);
  assert.equal(G.shouldReloadDependents({ changed: false, force: false, target: "submodules", firstLoad: false, isError: false }), true);
  assert.equal(G.shouldReloadDependents({ changed: false, force: false, target: "full", firstLoad: true, isError: false }), true);
  assert.equal(G.shouldReloadDependents({ changed: false, force: false, target: "full", firstLoad: false, isError: true }), true);

  assert.equal(G.shouldAcceptChangeEvent({ at: 1 }, { root: "D:/repo", on: null }), true);
  assert.equal(G.shouldAcceptChangeEvent({ at: 1, root: "D:\\repo", on: null }, { root: "D:/repo/", on: null }), true);
  assert.equal(G.shouldAcceptChangeEvent({ at: 1, root: "D:/other", on: null }, { root: "D:/repo", on: null }), false);
  assert.equal(G.shouldAcceptChangeEvent({ at: 1, root: "D:/repo", on: "devbox" }, { root: "D:/repo", on: null }), false);

  assert.equal(R.classifyRefresh("stashFiles"), "stash");
  assert.equal(R.classifyRefresh("stashBranch"), "full");
  assert.equal(R.classifyRefresh("checkoutFile"), "status");
}

// ---- Pickaxe search (code:) & ignore-whitespace diff args
{
  assert.deepEqual(G.parseFilter('code:"myFunc(" author:alice path:src/app.js fix'), {
    text: "fix",
    author: "alice",
    path: "src/app.js",
    code: "myFunc(",
    hash: null,
  });
  assert.deepEqual(G.parseFilter("code:-flag"), {
    text: "",
    author: "",
    path: "",
    code: "-flag",
    hash: null,
  });

  const args = G.logArgs({ all: true, remotes: false, limit: 50, filter: G.parseFilter("code:-flag") });
  assert.ok(args.includes("-S-flag"));

  const c1 = { hash: "1".repeat(40), parents: ["0".repeat(40)] };
  assert.ok(G.diffArgs(c1, "a.txt", { ignoreWhitespace: true }).includes("-w"));
  assert.ok(!G.diffArgs(c1, "a.txt", { ignoreWhitespace: false }).includes("-w"));
  assert.ok(G.compareDiffArgs("1".repeat(40), "2".repeat(40), "a.txt", { ignoreWhitespace: true }).includes("-w"));
}

// ---- Menus, dialogs, commands, doneText, failTitle for new GitKraken/Fork features
{
  const h1 = "1".repeat(40), h2 = "2".repeat(40);
  const ctx = { current: "main", head: h2, branches: ["main", "feat"], remotes: ["origin"], on: null };

  const headMenu = G.menuFor({ kind: "commit", commit: { hash: h2, subject: "head", parents: [h1] } }, ctx).map((i) => i.label);
  assert.ok(headMenu.includes("Edit commit message…"));
  assert.ok(headMenu.includes("Undo commit (keep staged)…"));

  const oldMenu = G.menuFor({ kind: "commit", commit: { hash: h1, subject: "old", parents: [] } }, ctx).map((i) => i.label);
  assert.ok(!oldMenu.includes("Edit commit message…"));
  assert.ok(!oldMenu.includes("Undo commit (keep staged)…"));

  const pullMenu = G.menuFor({ kind: "pullModes", upstream: "origin/main" }, ctx);
  assert.deepEqual(pullMenu.map((i) => i.action.mode), ["ff-only", "rebase", "merge", "config"]);

  const cfMenu = G.menuFor({ kind: "commitFile", hash: h1, path: "a.txt", status: "M" }, ctx).filter((i) => !i.separator).map((i) => i.label);
  assert.deepEqual(cfMenu, [`Restore version from ${h1.slice(0, 8)}…`, "File history", "Blame", "Open file", "Copy path"]);
  const cfDel = G.menuFor({ kind: "commitFile", hash: h1, path: "gone.txt", status: "D" }, ctx).filter((i) => !i.separator).map((i) => i.label);
  assert.deepEqual(cfDel, ["File history", "Copy path"]);

  const brMenu = G.menuFor({ kind: "branch", name: "feat", upstream: null, gone: false }, ctx).map((i) => i.label);
  assert.ok(brMenu.includes("Filter graph to this branch"));

  const rewordDlg = G.dialogFor({ type: "reword", hash: h2, short: h2.slice(0, 8), subject: "old subj" }, ctx);
  assert.equal(rewordDlg.inputs[0].multiline, true);
  assert.ok(G.dialogHeight(rewordDlg) > G.dialogHeight(G.dialogFor({ type: "renameBranch", name: "feat" }, ctx)));

  assert.deepEqual(G.commandsFor({ type: "merge", ref: "feat", what: "branch feat" }, { squash: true, noff: true }, ctx), [["merge", "--squash", "feat"]]);
  assert.equal(G.doneText({ type: "merge", what: "branch feat" }, { squash: true }), "Squashed branch feat (staged, not committed)");
  assert.deepEqual(G.commandsFor({ type: "cherryPick", hash: h1, short: "11111111", merge: false }, { noCommit: true }, ctx), [["cherry-pick", "--no-commit", h1]]);
  assert.deepEqual(G.commandsFor({ type: "revert", hash: h1, short: "11111111", merge: false }, { noCommit: true }, ctx), [["revert", "--no-commit", h1]]);
  assert.deepEqual(G.commandsFor({ type: "stash" }, { untracked: true, keepIndex: true, message: "wip" }, ctx), [["stash", "push", "--include-untracked", "--keep-index", "-m", "wip"]]);
  assert.deepEqual(G.commandsFor({ type: "stashFiles", paths: ["a.txt"] }, { message: "only a" }, ctx), [["--literal-pathspecs", "stash", "push", "--include-untracked", "-m", "only a", "--", "a.txt"]]);
  assert.deepEqual(G.commandsFor({ type: "stashBranch", ref: "stash@{0}" }, { name: "from-stash" }, ctx), [["stash", "branch", "from-stash", "stash@{0}"]]);
  assert.deepEqual(G.commandsFor({ type: "skipOp", op: "rebase" }, {}, ctx), [["rebase", "--skip"]]);
  assert.throws(() => G.commandsFor({ type: "skipOp", op: "merge" }, {}, ctx), /Unknown operation/);
  assert.deepEqual(G.commandsFor({ type: "checkoutFile", hash: h1, short: "11111111", path: "a.txt" }, {}, ctx), [["--literal-pathspecs", "checkout", h1, "--", "a.txt"]]);

  assert.equal(failTitle({ type: "reword" }), "Couldn't update commit message");
  assert.equal(failTitle({ type: "undoCommit" }), "Couldn't undo commit");
  assert.equal(failTitle({ type: "stashFiles" }), "Couldn't stash");
  assert.equal(failTitle({ type: "stashBranch" }), "Couldn't create branch from stash");
  assert.equal(failTitle({ type: "skipOp", op: "rebase" }), "Couldn't skip commit in rebase");
  assert.equal(failTitle({ type: "checkoutFile" }), "Couldn't restore file");
}

// ---- Disposable repo integration tests
{
  const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" };
  const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const git = (cwd, args) => { const r = spawnSync("git", args, { cwd, env, encoding: "utf8" }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
  const exec = (cmd, args, o) => Promise.resolve(spawnSync(cmd, args, { cwd: o.cwd, env, encoding: "utf8" })).then((r) => ({ code: r.status, stdout: r.stdout, stderr: r.stderr }));
  const dir = mkdtempSync(join(tmpdir(), "herdr-git-feat-"));
  const repo = join(dir, "repo");

  // Unborn repo check for show-ref
  sh(dir, "init", "-q", "-b", "main", repo);
  sh(repo, "config", "core.autocrlf", "false");
  const unbornRef = git(repo, ["show-ref", "--head", "--heads"]);
  assert.deepEqual(G.parseShowRef(unbornRef.stdout), { head: null, branches: [] });

  writeFileSync(join(repo, "a.txt"), "v1\n");
  writeFileSync(join(repo, "b.txt"), "b1\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "initial");
  const c1 = git(repo, ["rev-parse", "HEAD"]).stdout.trim();

  writeFileSync(join(repo, "a.txt"), "v2 -needle-\n");
  sh(repo, "add", "a.txt");
  sh(repo, "commit", "-qm", "add needle");
  const c2 = git(repo, ["rev-parse", "HEAD"]).stdout.trim();

  const ctx = () => ({
    root: repo,
    on: null,
    current: git(repo, ["symbolic-ref", "-q", "--short", "HEAD"]).stdout.trim() || null,
    head: git(repo, ["rev-parse", "HEAD"]).stdout.trim(),
    branches: ["main"],
    remotes: [],
  });
  const run = async (action, values = {}) => {
    const r = await executeAction(action, values, ctx(), exec, null);
    assert.ok(r.ok, r.message);
    return r;
  };

  // show-ref --head --heads matches rev-parse HEAD + branches
  const sr = G.parseShowRef(git(repo, ["show-ref", "--head", "--heads"]).stdout);
  assert.equal(sr.head, c2);
  assert.deepEqual(sr.branches, ["main"]);

  // Pickaxe code: search including leading dash
  const pickaxe = git(repo, G.logArgs({ all: true, remotes: false, limit: 10, filter: G.parseFilter("code:-needle-") }));
  assert.equal(G.parseLog(pickaxe.stdout).length, 1);
  assert.equal(G.parseLog(pickaxe.stdout)[0].hash, c2);

  // Reword HEAD without committing unrelated staged files
  writeFileSync(join(repo, "b.txt"), "staged-b\n");
  sh(repo, "add", "b.txt");
  await run({ type: "reword", hash: c2, short: c2.slice(0, 8), subject: "add needle" }, { message: "reworded title\n\nwith body" });
  assert.equal(git(repo, ["log", "-1", "--format=%B"]).stdout.trim(), "reworded title\n\nwith body");
  assert.deepEqual(G.parseStatus(git(repo, [...G.READ, ...G.STATUS]).stdout).map((f) => [f.path, f.staged]), [["b.txt", true]]);
  sh(repo, "reset", "-q", "HEAD", "--", "b.txt");
  sh(repo, "checkout", "--", "b.txt");

  // Undo commit (keep changes staged)
  const headBeforeUndo = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  await run({ type: "undoCommit", hash: headBeforeUndo, parent: c1, short: headBeforeUndo.slice(0, 8) });
  assert.equal(git(repo, ["rev-parse", "HEAD"]).stdout.trim(), c1);
  assert.deepEqual(G.parseStatus(git(repo, [...G.READ, ...G.STATUS]).stdout).map((f) => [f.path, f.staged]), [["a.txt", true]]);
  sh(repo, "commit", "-qm", "re-commit v2");
  const c2b = git(repo, ["rev-parse", "HEAD"]).stdout.trim();

  // checkoutFile restores older file content into worktree
  await run({ type: "checkoutFile", hash: c1, short: c1.slice(0, 8), path: "a.txt" });
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "v1\n");
  sh(repo, "checkout", "HEAD", "--", "a.txt");

  // Stash selected files (leaves other modified files intact)
  writeFileSync(join(repo, "a.txt"), "mod-a\n");
  writeFileSync(join(repo, "b.txt"), "mod-b\n");
  await run({ type: "stashFiles", paths: ["a.txt"] }, { message: "just a" });
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "v2 -needle-\n");
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "mod-b\n");
  sh(repo, "checkout", "--", "b.txt");

  // Create branch from stash
  await run({ type: "stashBranch", ref: "stash@{0}" }, { name: "from-stash" });
  assert.equal(ctx().current, "from-stash");
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "mod-a\n");
  sh(repo, "checkout", "--", "a.txt");
  sh(repo, "checkout", "-q", "main");
  sh(repo, "branch", "-D", "from-stash");

  // Stash with --keep-index
  writeFileSync(join(repo, "a.txt"), "staged-a\n");
  sh(repo, "add", "a.txt");
  writeFileSync(join(repo, "b.txt"), "unstaged-b\n");
  await run({ type: "stash" }, { untracked: true, keepIndex: true, message: "keep idx" });
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "b1\n");
  assert.deepEqual(G.parseStatus(git(repo, [...G.READ, ...G.STATUS]).stdout).map((f) => [f.path, f.staged]), [["a.txt", true]]);
  sh(repo, "reset", "-q", "--hard", "HEAD");
  sh(repo, "stash", "drop", "-q");

  // Feature branch for squash merge, cherry-pick --no-commit, revert --no-commit, and skipOp
  sh(repo, "checkout", "-qb", "feat");
  writeFileSync(join(repo, "feat.txt"), "f1\n");
  sh(repo, "add", "feat.txt");
  sh(repo, "commit", "-qm", "feat 1");
  const f1 = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  writeFileSync(join(repo, "feat2.txt"), "f2\n");
  sh(repo, "add", "feat2.txt");
  sh(repo, "commit", "-qm", "feat 2");

  sh(repo, "checkout", "-q", "main");
  await run({ type: "merge", ref: "feat", what: "branch feat" }, { squash: true });
  assert.equal(git(repo, ["rev-parse", "HEAD"]).stdout.trim(), c2b, "squash merge does not commit");
  assert.deepEqual(G.parseStatus(git(repo, [...G.READ, ...G.STATUS]).stdout).map((f) => [f.path, f.staged]).sort(), [["feat.txt", true], ["feat2.txt", true]]);
  sh(repo, "reset", "-q", "--hard", "HEAD");

  await run({ type: "cherryPick", hash: f1, short: f1.slice(0, 8), merge: false }, { noCommit: true });
  assert.equal(git(repo, ["rev-parse", "HEAD"]).stdout.trim(), c2b, "cherry-pick --no-commit leaves staged");
  assert.deepEqual(G.parseStatus(git(repo, [...G.READ, ...G.STATUS]).stdout).map((f) => [f.path, f.staged]), [["feat.txt", true]]);
  sh(repo, "commit", "-qm", "cherry feat1");
  const cpHash = git(repo, ["rev-parse", "HEAD"]).stdout.trim();

  await run({ type: "revert", hash: cpHash, short: cpHash.slice(0, 8), merge: false }, { noCommit: true });
  assert.equal(git(repo, ["rev-parse", "HEAD"]).stdout.trim(), cpHash, "revert --no-commit leaves staged");
  assert.deepEqual(G.parseStatus(git(repo, [...G.READ, ...G.STATUS]).stdout).map((f) => [f.path, f.staged, f.status]), [["feat.txt", true, "D"]]);
  sh(repo, "reset", "-q", "--hard", "HEAD");

  // Conflict during cherry-pick + skipOp
  sh(repo, "checkout", "-q", "feat");
  writeFileSync(join(repo, "a.txt"), "feat-conflict\n");
  sh(repo, "commit", "-qam", "feat conflict");
  const conflictCommit = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  sh(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, "a.txt"), "main-conflict\n");
  sh(repo, "commit", "-qam", "main conflict");
  const cpFail = git(repo, ["cherry-pick", conflictCommit]);
  assert.notEqual(cpFail.code, 0, "cherry-pick stops on conflict");
  await run({ type: "skipOp", op: "cherry-pick" });
  assert.equal(git(repo, ["rev-parse", "--verify", "-q", "CHERRY_PICK_HEAD"]).code, 1, "skip cleared operation");

  rmSync(dir, { recursive: true, force: true });
}

console.log("perf and features ok");
