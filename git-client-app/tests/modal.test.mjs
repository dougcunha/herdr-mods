// Unit tests for wide/modal Git client helpers: batch merged computation, submodule
// status parsing, targeted refresh classification, and branch-scoped log args.
// Run: node tests/modal.test.mjs
import * as G from "../mods/git-client/git.js";
import * as R from "../mods/git-client/refs.js";
import assert from "node:assert/strict";

// ---- batch merged map
const local = [
  { name: "main", current: true, upstream: "origin/main" },
  { name: "feat/done", current: false, upstream: "origin/feat/done" },
  { name: "feat/wip", current: false, upstream: null },
];
const remote = [
  { name: "origin/main", remote: "origin", branch: "main" },
  { name: "origin/feat/done", remote: "origin", branch: "feat/done" },
];
assert.equal(R.defaultBranchTarget(local, remote), "origin/main");
assert.equal(R.defaultBranchTarget([{ name: "master" }], []), "master");
assert.deepEqual(R.mergedRefsArgs("origin/main"), ["for-each-ref", "--merged", "origin/main", "--format=%(refname:short)", "refs/heads"]);

const mergedMap = R.computeMergedMap(local, "main", [
  { target: "HEAD", merged: new Set(["main", "feat/done"]) },
  { target: "origin/main", merged: new Set(["main", "feat/done"]) },
]);
assert.deepEqual(mergedMap.get("feat/done"), ["main", "origin/main"]);
assert.equal(mergedMap.has("main"), false, "skips current branch");
assert.equal(mergedMap.has("feat/wip"), false, "unmerged branch omitted");

// Own remote copy does not count as merged
const ownOnly = R.computeMergedMap([{ name: "topic", current: false, upstream: "origin/topic" }], "main", [
  { target: "origin/topic", merged: new Set(["topic"]) },
]);
assert.equal(ownOnly.has("topic"), false);

// ---- submodule status parsing
const st1 = R.parseSubmoduleStatus("## feat/lib...origin/feat/lib [ahead 2, behind 1]\0 M a.txt\0?? b.txt\0");
assert.deepEqual(st1, {
  changes: 2,
  branch: "feat/lib",
  upstream: "origin/feat/lib",
  ahead: 2,
  behind: 1,
  gone: false,
  detached: false,
  unborn: false,
});

const st2 = R.parseSubmoduleStatus("## HEAD (no branch)\0");
assert.deepEqual(st2, {
  changes: 0,
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  gone: false,
  detached: true,
  unborn: false,
});

const st3 = R.parseSubmoduleStatus("## old...origin/old [gone]\0");
assert.equal(st3.branch, "old");
assert.equal(st3.gone, true);

// ---- targeted refresh classification
assert.equal(R.classifyRefresh("stage"), "status");
assert.equal(R.classifyRefresh("discardHunk"), "status");
assert.equal(R.classifyRefresh("stash"), "stash");
assert.equal(R.classifyRefresh("stashPop"), "stash");
assert.equal(R.classifyRefresh("submoduleChooseBranch"), "submodules");
assert.equal(R.classifyRefresh("submodulePull"), "submodules");
assert.equal(R.classifyRefresh("commit"), "full");
assert.equal(R.classifyRefresh("checkout"), "full");

// ---- branch-scoped logArgs
const branchLog = G.logArgs({ all: true, remotes: true, limit: 50, branch: "feat/x" });
assert.ok(branchLog.includes("feat/x"));
assert.ok(!branchLog.includes("--branches"));

console.log("modal ok");
