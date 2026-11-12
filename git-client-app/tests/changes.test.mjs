// Tests the Changes tab's git logic against throwaway repositories: file and hunk staging (through a
// patch file, and through `sh -c` as on another machine), discard, amend, and an operation in progress.
// Run: node tests/changes.test.mjs
import * as G from "../mods/git-client/git.js";
import { executeAction } from "../mods/git-client/execute.js";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" };
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git = (cwd, args) => { const r = spawnSync("git", args, { cwd, env, encoding: "utf8" }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
// Herdr's exec: `on` is ignored here, so the sh route runs on this machine.
const exec = (cmd, args, o) => Promise.resolve(spawnSync(cmd, args, { cwd: o.cwd, env, encoding: "utf8" })).then((r) => ({ code: r.status, stdout: r.stdout, stderr: r.stderr }));
const dir = mkdtempSync(join(tmpdir(), "herdr-git-client-"));
const io = { async writePatch(text) { const f = join(dir, `p-${Math.random()}.patch`); writeFileSync(f, text); return f; }, async remove(f) { unlinkSync(f); },
  async appendLine(f, line) { const t = existsSync(f) ? readFileSync(f, "utf8") : ""; if (!t.split(/\r?\n/).includes(line)) writeFileSync(f, t + (t && !t.endsWith("\n") ? "\n" : "") + line + "\n"); } };
const many = (n, eol = "\n") => Array.from({ length: n }, (_, i) => `line ${i}`).join(eol) + eol;
const status = (repo) => G.parseStatus(git(repo, [...G.READ, ...G.STATUS]).stdout);
const diff = (repo, path, cached) => git(repo, [...G.READ, "--literal-pathspecs", ...G.PATCH, ...(cached ? ["--cached"] : []), "--", path]).stdout;

// ---- rows and hunks
{
  const text = "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n@@ -10 +10 @@\n-x\n+y\n\\ No newline at end of file\n";
  const p = G.parsePatch(text);
  assert.equal(p.hunks.length, 2);
  assert.equal(G.hunkPatch(p, 1), "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -10 +10 @@\n-x\n+y\n\\ No newline at end of file\n");
  const rows = G.patchRows(text);
  assert.deepEqual(rows.map((r) => [r.kind, r.number ?? null, r.hunk]), [["@", null, 0], ["-", 1, 0], ["+", 1, 0], [" ", 2, 0], ["@", null, 1], ["-", 10, 1], ["+", 10, 1], ["", null, 1]]);
  const split = G.splitRows(rows);
  assert.deepEqual(split.slice(1, 3).map((r) => [r.left?.text, r.right?.text, r.hunk]), [["a", "b", 0], ["c", "c", 0]]);
  assert.equal(G.parsePatch("diff --cc f\n@@@ -1,1 -1,1 +1,1 @@@\n"), null, "a combined diff has no hunks to apply");
  assert.equal(G.newFileRows("a\nb\n").length, 3);
  assert.equal(G.newFileRows("a\0b")[0].text, "Binary file");
}

// ---- file staging, through executeAction as the panel runs it
const repo = join(dir, "repo");
sh(dir, "init", "-q", "-b", "main", repo);
writeFileSync(join(repo, "a.txt"), many(30)); writeFileSync(join(repo, "[x]"), "x"); writeFileSync(join(repo, "x"), "x"); writeFileSync(join(repo, "-dash"), "x");
sh(repo, "add", "-A"); sh(repo, "commit", "-qm", "base");
const head = () => git(repo, ["rev-parse", "HEAD"]).stdout.trim();
const ctx = () => ({ root: repo, on: null, current: "main", head: head(), branches: ["main"], remotes: [] });
const run = async (action, values = {}, c = ctx()) => { const r = await executeAction(action, values, c, exec, io); assert.ok(r.ok, r.message); return r; };

writeFileSync(join(repo, "[x]"), "y"); writeFileSync(join(repo, "x"), "y"); writeFileSync(join(repo, "-dash"), "y"); writeFileSync(join(repo, "new.txt"), "n");
await run({ type: "stage", paths: ["[x]", "-dash"] });
assert.deepEqual(status(repo).filter((f) => f.staged).map((f) => f.path).sort(), ["-dash", "[x]"], "odd names stay paths (not a glob, not an option)");
await run({ type: "unstage", paths: ["[x]"] });
assert.deepEqual(status(repo).filter((f) => f.staged).map((f) => f.path), ["-dash"]);
await run({ type: "discard", paths: ["[x]", "x", "-dash"], untracked: ["new.txt"] });
assert.equal(readFileSync(join(repo, "[x]"), "utf8"), "x");
assert.ok(!existsSync(join(repo, "new.txt")), "an untracked file is deleted");
assert.deepEqual(status(repo).map((f) => [f.path, f.staged, f.unstaged]), [["-dash", true, false]], "discard leaves staged changes");
sh(repo, "reset", "-q", "--hard");
assert.throws(() => G.commandsFor({ type: "stage", paths: ["a\0b"] }), /path/);
assert.equal(G.commandsFor({ type: "stage", paths: Array.from({ length: 250 }, (_, i) => `f${i}`) }).length, 3, "long lists in chunks");

// ---- hunks: stage, unstage and discard one hunk, through a file and through sh -c
for (const on of [null, "remote-like"]) {
  const c = { ...ctx(), on };
  writeFileSync(join(repo, "a.txt"), many(30).replace("line 2\n", "line 2 changed\n").replace("line 25\n", "line 25 changed\n"));
  const p = G.parsePatch(diff(repo, "a.txt"));
  assert.equal(p.hunks.length, 2);
  await run({ type: "stageHunk", patch: G.hunkPatch(p, 0) }, {}, c);
  assert.match(diff(repo, "a.txt", true), /line 2 changed/); assert.doesNotMatch(diff(repo, "a.txt", true), /line 25 changed/);
  const staged = G.parsePatch(diff(repo, "a.txt", true));
  await run({ type: "unstageHunk", patch: G.hunkPatch(staged, 0) }, {}, c);
  assert.equal(diff(repo, "a.txt", true), "", `unstaged (${on ?? "file"})`);
  const p2 = G.parsePatch(diff(repo, "a.txt"));
  await run({ type: "discardHunk", patch: G.hunkPatch(p2, 1) }, {}, c);
  assert.doesNotMatch(readFileSync(join(repo, "a.txt"), "utf8"), /line 25 changed/); assert.match(readFileSync(join(repo, "a.txt"), "utf8"), /line 2 changed/);
  // A hunk that no longer fits is refused with git's words.
  const bad = await executeAction({ type: "unstageHunk", patch: G.hunkPatch(p, 0) }, {}, c, exec, io);
  assert.ok(!bad.ok && /refresh/.test(bad.message));
  sh(repo, "checkout", "--", "a.txt");
}
assert.equal((await executeAction({ type: "stageHunk", patch: "--output=x" }, {}, ctx(), exec, io)).ok, false, "not a patch");

// ---- commit options: amend
writeFileSync(join(repo, "a.txt"), "amended\n"); sh(repo, "add", "a.txt");
await run({ type: "commit" }, { message: "first message", amend: true });
assert.equal(git(repo, ["rev-list", "--count", "HEAD"]).stdout.trim(), "1", "amend makes no new commit");
assert.equal(git(repo, ["log", "-1", "--format=%s"]).stdout.trim(), "first message");

// ---- an operation in progress: a merge with a conflict, its files under .git, abort and continue
const opNow = () => {
  const keys = Object.keys(G.OP_FILES), paths = git(repo, G.opPathArgs()).stdout.split("\n").filter(Boolean), found = {};
  keys.forEach((k, i) => { const p = join(repo, paths[i]); found[k] = existsSync(p) ? readFileSync(p, "utf8") : null; });
  return G.opOf(found);
};
assert.equal(opNow(), null);
sh(repo, "checkout", "-qb", "other"); writeFileSync(join(repo, "a.txt"), "theirs\n"); sh(repo, "commit", "-qam", "theirs");
sh(repo, "checkout", "-q", "main"); writeFileSync(join(repo, "a.txt"), "ours\n"); sh(repo, "commit", "-qam", "ours");
assert.notEqual(git(repo, ["merge", "other"]).code, 0);
assert.equal(opNow(), "merge");
assert.deepEqual(status(repo).filter((f) => f.conflict).map((f) => f.path), ["a.txt"]);
const ctxNow = () => ({ ...ctx(), head: head() });
assert.equal((await executeAction({ type: "commit" }, { message: "x", all: true }, ctxNow(), exec, io)).ok, false, "commit all refuses conflicts");
await run({ type: "abortOp", op: "merge" }, {}, ctxNow());
assert.equal(opNow(), null);
assert.notEqual(git(repo, ["merge", "other"]).code, 0);
writeFileSync(join(repo, "a.txt"), "both\n");
await run({ type: "stage", paths: ["a.txt"] });
await run({ type: "continueOp", op: "merge" }, {}, ctxNow());
assert.equal(opNow(), null);
assert.equal(git(repo, ["rev-list", "--parents", "-n1", "HEAD"]).stdout.trim().split(" ").length, 3, "a merge commit, no editor");
assert.throws(() => G.commandsFor({ type: "continueOp", op: "--exec" }), /operation/);

// ---- ignore and exclude an untracked file (here, and through `sh -c` as on another machine)
{
  assert.equal(G.ignoreLine("a b/x*[1].txt "), "/a b/x\\*\\[1].txt\\ ");
  const untracked = () => status(repo).filter((f) => f.untracked).map((f) => f.path);
  const item = (path, where) => G.menuFor({ kind: "file", side: "unstaged", file: { path, untracked: true } }, ctx()).flat().find((i) => i.action?.where === where);
  writeFileSync(join(repo, "skip.log"), "x\n"); writeFileSync(join(repo, "local.tmp"), "x\n"); writeFileSync(join(repo, "far.tmp"), "x\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules");
  await run(item("skip.log", "gitignore").action);
  await run(item("skip.log", "gitignore").action);
  assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), "node_modules\n/skip.log\n", "ends the last line, adds once");
  await run(item("local.tmp", "exclude").action);
  assert.match(readFileSync(join(repo, ".git/info/exclude"), "utf8"), /\n\/local\.tmp\n$/);
  await run({ type: "ignore", path: "far.tmp", where: "exclude" }, {}, { ...ctx(), on: "remote" });
  await run({ type: "ignore", path: "far.tmp", where: "exclude" }, {}, { ...ctx(), on: "remote" });
  assert.equal(readFileSync(join(repo, ".git/info/exclude"), "utf8").match(/\/far\.tmp/g).length, 1);
  assert.deepEqual(untracked(), [".gitignore"]);
  assert.equal(G.menuFor({ kind: "file", side: "unstaged", file: { path: "a.txt", untracked: false } }, ctx()).flat().some((i) => i.action?.type === "ignore"), false);
  unlinkSync(join(repo, ".gitignore"));
}

// ---- the AI prompt
{
  const p = G.messagePrompt({ diff: "+x", stat: " a | 1 +", subjects: ["feat(a): one"], format: "repo", instructions: "Write in English." });
  assert.match(p, /<recent-subjects>\nfeat\(a\): one/); assert.match(p, /Write in English\./);
  assert.doesNotMatch(G.messagePrompt({ diff: "+x", stat: "", subjects: ["s"], format: "conventional" }), /recent-subjects/);
  assert.equal(G.cleanMessage("```\nfix: a\n\nbody\n```"), "fix: a\n\nbody");
  assert.equal(G.cleanMessage('"fix: a"'), "fix: a");
}

rmSync(dir, { recursive: true, force: true });
console.log("changes ok");
