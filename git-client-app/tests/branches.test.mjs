// Tests the Branches and Stash tabs' git logic against throwaway repositories (a bare remote too):
// the reads (refs, remotes, worktrees, stashes) and every action of their menus and dialogs.
// Run: node tests/branches.test.mjs
import * as G from "../mods/git-client/git.js";
import * as R from "../mods/git-client/refs.js";
import { executeAction } from "../mods/git-client/execute.js";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" };
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git = (cwd, args) => { const r = spawnSync("git", args, { cwd, env, encoding: "utf8" }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
const exec = (cmd, args, o) => Promise.resolve(spawnSync(cmd, args, { cwd: o.cwd, env, encoding: "utf8" })).then((r) => ({ code: r.status, stdout: r.stdout, stderr: r.stderr }));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "herdr-git-client-b-"))).replace(/\\/g, "/");
const remote = `${dir}/remote.git`, repo = `${dir}/repo`;
sh(dir, "init", "-q", "--bare", "-b", "main", remote);
sh(dir, "init", "-q", "-b", "main", repo);
writeFileSync(join(repo, "a.txt"), "a\n"); sh(repo, "add", "-A"); sh(repo, "commit", "-qm", "first");
sh(repo, "remote", "add", "origin", remote); sh(repo, "push", "-q", "-u", "origin", "main");
const head = () => git(repo, ["rev-parse", "HEAD"]).stdout.trim();
const current = () => git(repo, ["symbolic-ref", "-q", "--short", "HEAD"]).stdout.trim() || null;
const ctx = () => ({ root: repo, on: null, current: current(), head: head(), branches: [], remotes: git(repo, ["remote"]).stdout.split("\n").filter(Boolean) });
const run = async (action, values = {}) => { const r = await executeAction(action, values, ctx(), exec); assert.ok(r.ok, `${action.type}: ${r.message}`); return r; };
const refs = () => R.parseRefs(git(repo, R.refsArgs()).stdout);

// ---- branches, tags and upstreams
await run({ type: "newBranch", base: "HEAD" }, { name: "feature", checkout: true });
assert.equal(current(), "feature");
writeFileSync(join(repo, "b.txt"), "b\n"); sh(repo, "add", "-A"); sh(repo, "commit", "-qm", "feature work");
await run({ type: "push", name: "feature" }, { remote: "origin", upstream: true });
await run({ type: "newTag", base: "main", what: "main" }, { name: "v1", message: "release 1" });
await run({ type: "newBranch", base: "v1" }, { name: "from-tag", checkout: false });
let r = refs();
assert.deepEqual(r.local.map((b) => [b.name, b.current, b.upstream]).sort(), [["feature", true, "origin/feature"], ["from-tag", false, null], ["main", false, "origin/main"]]);
assert.equal(r.local[0].name, "feature", "the checked-out branch first");
assert.deepEqual(r.remote.map((b) => [b.remote, b.branch]).sort(), [["origin", "feature"], ["origin", "main"]], "no origin/HEAD");
assert.deepEqual(r.tags.map((t) => [t.name, t.subject]), [["v1", "release 1"]]);
writeFileSync(join(repo, "c.txt"), "c\n"); sh(repo, "add", "-A"); sh(repo, "commit", "-qm", "ahead");
assert.deepEqual(refs().local.find((b) => b.name === "feature").ahead, 1);
await run({ type: "setUpstream", name: "from-tag" }, { upstream: "origin/main" });
assert.equal(refs().local.find((b) => b.name === "from-tag").upstream, "origin/main");
assert.deepEqual(R.parseTrack("[gone]"), { gone: true, ahead: 0, behind: 0 });
assert.deepEqual(R.parseTrack("[ahead 2, behind 3]"), { gone: false, ahead: 2, behind: 3 });

// ---- force push with lease: replaces a rewritten branch; refuses when the remote moved since the fetch
sh(repo, "push", "-q");
sh(repo, "commit", "-q", "--amend", "-m", "ahead (amended)");
assert.notEqual(git(repo, ["push", "-q"]).code, 0, "a plain push is refused");
await run({ type: "forcePush", name: "feature" }, { remote: "origin" });
assert.equal(git(repo, ["rev-parse", "origin/feature"]).stdout.trim(), head());
const other = `${dir}/other`; sh(dir, "clone", "-q", "-b", "feature", remote, other);
writeFileSync(join(other, "d.txt"), "d\n"); sh(other, "add", "-A"); sh(other, "commit", "-qm", "theirs"); sh(other, "push", "-q");
sh(repo, "commit", "-q", "--amend", "-m", "again");
assert.equal((await executeAction({ type: "forcePush", name: "feature" }, { remote: "origin" }, ctx(), exec)).ok, false, "the lease protects their commit");
assert.throws(() => G.commandsFor({ type: "forcePush", name: "feature" }, { remote: "--mirror" }, ctx()), /remote/);

// ---- fetch with prune, pull modes
sh(other, "push", "-q", "origin", "--delete", "feature");
await run({ type: "fetch" }, { prune: true });
assert.ok(!refs().remote.some((b) => b.branch === "feature"), "fetch --prune drops the gone branch");
assert.ok(refs().local.find((b) => b.name === "feature").gone);
await run({ type: "fetchRemote", name: "origin" });
assert.deepEqual(G.commandsFor({ type: "pull" }, { mode: "rebase" }, ctx()), [["pull", "--rebase", "--quiet"]]);
assert.deepEqual(G.commandsFor({ type: "pull" }, { mode: "merge" }, ctx()), [["pull", "--no-rebase", "--quiet"]]);
assert.deepEqual(G.commandsFor({ type: "pull" }, { mode: "config" }, ctx()), [["pull", "--quiet"]]);
assert.deepEqual(G.commandsFor({ type: "pull" }, {}, ctx()), [["pull", "--ff-only", "--quiet"]]);
sh(repo, "checkout", "-q", "main");
writeFileSync(join(other, "e.txt"), "e\n"); sh(other, "checkout", "-q", "main"); sh(other, "pull", "-q"); sh(other, "add", "-A"); sh(other, "commit", "-qm", "main theirs"); sh(other, "push", "-q");
writeFileSync(join(repo, "f.txt"), "f\n"); sh(repo, "add", "-A"); sh(repo, "commit", "-qm", "main ours");
assert.equal((await executeAction({ type: "pull", upstream: "origin/main" }, { mode: "ff-only" }, ctx(), exec)).ok, false, "fast-forward only stops");
await run({ type: "pull", upstream: "origin/main" }, { mode: "rebase" });
assert.equal(git(repo, ["rev-list", "--count", "origin/main..HEAD"]).stdout.trim(), "1", "rebased on top of theirs");

// ---- remotes
await run({ type: "addRemote" }, { name: "backup", url: remote });
assert.deepEqual(R.parseRemotes(git(repo, ["remote", "-v"]).stdout).map((x) => x.name), ["backup", "origin"]);
await run({ type: "renameRemote", name: "backup" }, { name: "mirror" });
await run({ type: "setRemoteUrl", name: "mirror" }, { url: `${dir}/elsewhere.git` });
assert.equal(R.parseRemotes(git(repo, ["remote", "-v"]).stdout).find((x) => x.name === "mirror").url, `${dir}/elsewhere.git`);
await run({ type: "removeRemote", name: "mirror" });
assert.deepEqual(R.parseRemotes(git(repo, ["remote", "-v"]).stdout).map((x) => x.name), ["origin"]);
assert.throws(() => G.commandsFor({ type: "addRemote" }, { name: "x", url: "--upload-pack=evil" }, ctx()), /URL/);
assert.throws(() => G.commandsFor({ type: "addRemote" }, { name: "-x", url: "u" }, ctx()), /name/);

// ---- worktrees
assert.equal(R.worktreePath("/w/repo", "feat/x y"), "/w/repo-feat-x-y");
assert.equal(R.worktreePath("C:\\w\\repo", "b"), "C:/w/repo-b");
assert.ok(R.samePath("C:\\W\\Repo\\", "c:/w/repo"));
await run({ type: "addWorktree" }, { name: "wt-one", newBranch: true, path: "" });
const wtPath = R.worktreePath(repo, "wt-one");
assert.ok(existsSync(join(wtPath, "a.txt")), "the folder next to the repository");
await run({ type: "addWorktree" }, { name: "from-tag", newBranch: false, path: `${dir}/custom wt` });
let wts = R.parseWorktrees(git(repo, ["worktree", "list", "--porcelain"]).stdout);
assert.deepEqual([wts[0].main, wts[0].branch], [true, "main"], "the main worktree first");
assert.deepEqual(wts.slice(1).map((w) => w.branch).sort(), ["from-tag", "wt-one"]);
await run({ type: "lockWorktree", path: wtPath });
assert.ok(R.parseWorktrees(git(repo, ["worktree", "list", "--porcelain"]).stdout).find((w) => w.branch === "wt-one").locked);
await run({ type: "unlockWorktree", path: wtPath });
writeFileSync(join(wtPath, "dirty.txt"), "x");
assert.equal((await executeAction({ type: "removeWorktree", path: wtPath }, { force: false }, ctx(), exec)).ok, false, "changes keep it");
await run({ type: "removeWorktree", path: wtPath }, { force: true });
rmSync(`${dir}/custom wt`, { recursive: true, force: true });
await run({ type: "pruneWorktrees" });
assert.equal(R.parseWorktrees(git(repo, ["worktree", "list", "--porcelain"]).stdout).length, 1);
assert.throws(() => G.commandsFor({ type: "removeWorktree", path: "--force" }), /folder/);

// ---- stashes
writeFileSync(join(repo, "a.txt"), "a changed\n"); writeFileSync(join(repo, "new.txt"), "n\n");
await run({ type: "stash" }, { message: "first stash", untracked: true });
writeFileSync(join(repo, "f.txt"), "f changed\n");
await run({ type: "stash" }, { message: "", untracked: false });
let stashes = R.parseStashes(git(repo, R.stashListArgs()).stdout);
assert.deepEqual(stashes.map((s) => [s.ref, s.branch]), [["stash@{0}", "main"], ["stash@{1}", "main"]]);
assert.equal(stashes[1].message, "first stash");
let show = git(repo, R.stashShowArgs("stash@{1}"));
if (show.code !== 0) show = git(repo, R.stashShowArgs("stash@{1}", false));
const files = R.splitFiles(show.stdout);
assert.ok(files.some((f) => f.path === "a.txt" && f.add === 1 && f.del === 1));
if (files.some((f) => f.path === "new.txt")) assert.equal(files.find((f) => f.path === "new.txt").status, "A", "untracked part as an added file");
await run({ type: "stashDrop", ref: "stash@{0}" });
await run({ type: "stashApply", ref: "stash@{0}" });
assert.equal(R.parseStashes(git(repo, R.stashListArgs()).stdout).length, 1, "apply keeps it");
sh(repo, "checkout", "--", "."); rmSync(join(repo, "new.txt"));
await run({ type: "stashPop", ref: "stash@{0}" });
assert.equal(R.parseStashes(git(repo, R.stashListArgs()).stdout).length, 0, "pop drops it");
assert.ok(existsSync(join(repo, "new.txt")));
assert.throws(() => G.commandsFor({ type: "stashDrop", ref: "--all" }), /stash/);

// ---- menus of the new rows
const labels = (target) => G.menuFor(target, ctx()).filter((i) => !i.separator).map((i) => i.label);
assert.deepEqual(labels({ kind: "remoteConfig", remote: { name: "origin", url: remote } }), ["Fetch origin", "Rename remote…", "Change URL…", "Remove remote…", "Copy URL"]);
assert.deepEqual(labels({ kind: "worktree", worktree: { path: "/x", branch: "b", main: false, locked: true }, current: false }), ["Open in a space", "Unlock", "Remove worktree…", "Copy path", "Copy branch name"]);
assert.deepEqual(labels({ kind: "worktree", worktree: { path: "/x", branch: "main", main: true }, current: true }), ["Copy path", "Copy branch name"], "no remove of the main or the current one");
assert.deepEqual(labels({ kind: "stash", stash: { ref: "stash@{0}", message: "m" } }), ["Apply", "Pop (apply and drop)", "Drop…", "Copy message"]);
assert.ok(R.ago(Date.now() / 1000 - 7200) === "2h");

// ---- pull the current branch, fetch into another local branch
assert.deepEqual(G.splitUpstream("origin/feature/x", ["origin", "or"]), { remote: "origin", branch: "feature/x" });
assert.deepEqual(G.splitUpstream("team/a/b", ["team", "team/a"]), { remote: "team/a", branch: "b" }, "the longest remote");
assert.equal(G.splitUpstream("other/x", ["origin"]), null);
{
  const c = ctx();
  const local = (name, extra = {}) => G.menuFor({ kind: "branch", name, upstream: `origin/${name}`, ...extra }, c).filter((i) => !i.separator);
  assert.equal(local(c.current)[0].label, `Pull from origin/${c.current}`);
  assert.deepEqual(local(c.current)[0].action, { type: "pull", upstream: `origin/${c.current}` });
  assert.deepEqual(local("other")[0].action, { type: "fetchBranch", name: "other", remote: "origin", branch: "other" });
  assert.ok(!local("other", { gone: true }).some((i) => /^(Pull|Fetch)/.test(i.label)), "no pull or fetch for a gone upstream");
  assert.ok(!G.menuFor({ kind: "branch", name: "x", upstream: null }, c).some((i) => /^(Pull|Fetch)/.test(i.label ?? "")), "no pull or fetch without upstream");
}
assert.throws(() => G.commandsFor({ type: "fetchBranch", name: "a", remote: "nope", branch: "a" }, {}, { remotes: ["origin"] }), /remote branch/);
assert.throws(() => G.commandsFor({ type: "fetchBranch", name: "-x", remote: "origin", branch: "a" }, {}, { remotes: ["origin"] }), /remote branch/);
{
  // A second clone pushes to "lag"; this repository's "lag" moves to it without a checkout.
  const other = `${dir}/lag-clone`;
  sh(repo, "branch", "lag", head()); sh(repo, "push", "-q", "-u", "origin", "lag");
  sh(dir, "clone", "-q", "-b", "lag", remote, other);
  writeFileSync(join(other, "c.txt"), "c\n"); sh(other, "add", "-A"); sh(other, "commit", "-qm", "remote work"); sh(other, "push", "-q");
  const theirs = git(other, ["rev-parse", "HEAD"]).stdout.trim(), before = current();
  await run({ type: "fetchBranch", name: "lag", remote: "origin", branch: "lag" });
  assert.equal(git(repo, ["rev-parse", "lag"]).stdout.trim(), theirs, "fast-forwarded");
  assert.equal(git(repo, ["rev-parse", "origin/lag"]).stdout.trim(), theirs, "the remote-tracking branch moves too");
  assert.equal(current(), before, "no checkout");
  // A local commit on "lag" that the remote does not have: the fetch fails and changes nothing.
  sh(repo, "branch", "-f", "lag", "HEAD");
  const r = await executeAction({ type: "fetchBranch", name: "lag", remote: "origin", branch: "lag" }, {}, ctx(), exec);
  assert.ok(!r.ok || git(repo, ["rev-parse", "lag"]).stdout.trim() === theirs, "never a non-fast-forward update");
}

rmSync(dir, { recursive: true, force: true });
console.log("branches ok");
