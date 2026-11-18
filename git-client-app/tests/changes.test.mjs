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

// ---- ignore an untracked file: the file itself, here and through `sh -c` as on another machine
{
  assert.equal(G.ignoreLine("a b/x*[1].txt "), "/a b/x\\*\\[1].txt\\ ");
  const untracked = () => status(repo).filter((f) => f.untracked).map((f) => f.path);
  const types = (file) => G.menuFor({ kind: "file", side: "unstaged", file }, ctx()).flat().map((i) => i.action?.type);
  assert.equal(types({ path: "skip.log", untracked: true }).filter((t) => t === "ignore").length, 1, "one menu item: the dialog asks the rest");
  assert.equal(types({ path: "a.txt", untracked: false }).includes("ignore"), false);
  const ignore = (path, what, local, c = ctx()) => run({ type: "ignore", path }, { what, local }, c);
  writeFileSync(join(repo, "skip.log"), "x\n"); writeFileSync(join(repo, "local.tmp"), "x\n"); writeFileSync(join(repo, "far.tmp"), "x\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules");
  assert.deepEqual(G.initialValues({ type: "ignore", path: "skip.log" }, ctx()), { what: "file", local: false });
  await ignore("skip.log", "file", false);
  await ignore("skip.log", "file", false);
  assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), "node_modules\n/skip.log\n", "ends the last line, adds once");
  await ignore("local.tmp", "file", true);
  assert.match(readFileSync(join(repo, ".git/info/exclude"), "utf8"), /\n\/local\.tmp\n$/);
  await ignore("far.tmp", "file", true, { ...ctx(), on: "remote" });
  await ignore("far.tmp", "file", true, { ...ctx(), on: "remote" });
  assert.equal(readFileSync(join(repo, ".git/info/exclude"), "utf8").match(/\/far\.tmp/g).length, 1);
  assert.deepEqual(untracked(), [".gitignore"]);
  for (const what of [undefined, "dir:src", "ext"]) assert.equal((await executeAction({ type: "ignore", path: "Makefile" }, { what, local: false }, ctx(), exec, io)).ok, false, "only a choice of the dialog");
  unlinkSync(join(repo, ".gitignore"));
}

// ---- ignore a folder or an extension, and stop tracking a file
{
  const { mkdirSync } = await import("node:fs");
  assert.deepEqual(G.parentDirs("a/b/c.txt"), ["a", "a/b"]);
  assert.deepEqual(G.parentDirs("c.txt"), []);
  assert.equal(G.ignoreLine("out [1]/sub dir", true), "/out \\[1]/sub dir/");
  assert.deepEqual(G.ignoreChoices("a/b/c.min.js").map((c) => [c.value, c.label, c.line]),
    [["file", "c.min.js", "/a/b/c.min.js"], ["extdir", "a/b/*.js", "/a/b/*.js"], ["ext", "*.js", "*.js"], ["dir:a/b", "a/b/", "/a/b/"], ["dir:a", "a/", "/a/"]]);
  assert.deepEqual(G.ignoreChoices(".env").map((c) => c.value), ["file"], "a dot file has no extension, a file at the top has no folder");
  assert.deepEqual(G.ignoreChoices("x [1].log").map((c) => [c.value, c.label, c.line]).slice(1), [["extdir", "/*.log", "/*.log"], ["ext", "*.log", "*.log"]], "at the top: the top folder only");
  assert.deepEqual(G.ignoreChoices("x/Makefile").map((c) => c.value), ["file", "dir:x"]);
  const menu = (file, side = "unstaged") => G.menuFor({ kind: "file", side, file }, ctx()).flat().map((i) => i.action?.type);
  assert.ok(menu({ path: "a.txt", untracked: false, status: "M" }).includes("untrack"));
  assert.ok(!menu({ path: "a.txt", untracked: false, status: "D" }).includes("untrack"), "a deleted file is not on disk");
  assert.ok(!menu({ path: "a.txt", untracked: false, status: "U" }, "conflict").includes("untrack"));
  assert.ok(!menu({ path: "new.txt", untracked: true }).includes("untrack"));

  unlinkSync(join(repo, "skip.log")); // of the block above: its .gitignore is gone
  for (const d of ["out [1]/sub dir", "out [1]/other", "keep/deep"]) mkdirSync(join(repo, d), { recursive: true });
  for (const f of ["out [1]/sub dir/a.o", "out [1]/sub dir/b.o", "out [1]/other/c.o", "keep/d.o", "keep/e.bak", "keep/h.bak", "keep/deep/g.bak", "f.bak"]) writeFileSync(join(repo, f), "x\n");
  const untracked = () => status(repo).filter((f) => f.untracked).map((f) => f.path).sort();
  const action = { type: "ignore", path: "out [1]/sub dir/a.o" };
  assert.deepEqual(G.dialogFor(action, ctx()).choice.options.map((o) => o.value), ["file", "extdir", "ext", "dir:out [1]/sub dir", "dir:out [1]"]);
  assert.equal((await executeAction(action, { what: "dir:keep", local: false }, ctx(), exec, io)).ok, false, "only a folder of the file");
  await run(action, { what: "dir:out [1]/sub dir", local: true });
  await run(action, { what: "dir:out [1]/sub dir", local: true }, { ...ctx(), on: "remote" });
  assert.equal(readFileSync(join(repo, ".git/info/exclude"), "utf8").match(/^\/out \\\[1\]\/sub dir\/$/gm).length, 1, "once");
  assert.deepEqual(untracked(), ["f.bak", "keep/d.o", "keep/deep/g.bak", "keep/e.bak", "keep/h.bak", "out [1]/other/c.o"], "the other folders stay");
  await run(action, { what: "dir:out [1]", local: false });
  assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), "/out \\[1]/\n");
  assert.deepEqual(untracked(), [".gitignore", "f.bak", "keep/d.o", "keep/deep/g.bak", "keep/e.bak", "keep/h.bak"]);
  // An extension in the folder of the file: not at the top, not in a folder under it.
  await run({ type: "ignore", path: "keep/e.bak" }, { what: "extdir", local: true });
  await run({ type: "ignore", path: "keep/e.bak" }, { what: "extdir", local: true }, { ...ctx(), on: "remote" });
  assert.equal(readFileSync(join(repo, ".git/info/exclude"), "utf8").match(/^.keep.[*][.]bak$/gm).length, 1, "once");
  assert.deepEqual(untracked(), [".gitignore", "f.bak", "keep/d.o", "keep/deep/g.bak"]);
  assert.equal(G.doneText({ type: "ignore", path: "keep/e.bak" }, { what: "extdir", local: true }), "Added /keep/*.bak to .git/info/exclude");
  assert.equal(G.doneText(action, { what: "dir:out [1]", local: false }), "Added /out \\[1]/ to .gitignore");
  // An extension: in every folder.
  await run({ type: "ignore", path: "keep/e.bak" }, { what: "ext", local: false });
  assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), "/out \\[1]/\n*.bak\n");
  assert.deepEqual(untracked(), [".gitignore", "keep/d.o"], "at the top and in every folder");
  assert.equal(G.doneText({ type: "ignore", path: "keep/e.bak" }, { what: "ext", local: true }), "Added *.bak to .git/info/exclude");
  unlinkSync(join(repo, ".gitignore")); unlinkSync(join(repo, "f.bak")); rmSync(join(repo, "out [1]"), { recursive: true }); rmSync(join(repo, "keep"), { recursive: true });

  // Stop tracking: out of the index, still on disk, a line in the ignore file.
  const xy = (path) => { const f = status(repo).find((s) => s.path === path); return f ? `${f.x}${f.y}` : null; };
  for (const [name, where, on] of [["t1.cfg", "gitignore", null], ["t2.cfg", "exclude", "remote"]]) {
    writeFileSync(join(repo, name), "v1\n"); sh(repo, "add", name); sh(repo, "commit", "-qm", `add ${name}`);
    writeFileSync(join(repo, name), "v2\n"); // changed and not staged: the usual case
    const action = { type: "untrack", path: name };
    assert.equal((await executeAction(action, { where: "elsewhere" }, { ...ctx(), on }, exec, io)).ok, false);
    assert.equal(xy(name), " M", "a wrong value changes nothing");
    await run(action, { where }, { ...ctx(), on });
    assert.equal(readFileSync(join(repo, name), "utf8"), "v2\n", "the file stays on disk");
    assert.equal(xy(name), "D ", "a staged removal, and not listed as untracked");
    assert.equal(git(repo, ["ls-files", "--", name]).stdout, "");
    assert.match(readFileSync(join(repo, where === "exclude" ? ".git/info/exclude" : ".gitignore"), "utf8"), new RegExp(`^/${name.replace(".", "\\.")}$`, "m"));
  }
  // Staged content that differs from HEAD and from the file (MM, AM).
  writeFileSync(join(repo, "t3.cfg"), "v1\n"); sh(repo, "add", "t3.cfg"); sh(repo, "commit", "-qm", "add t3");
  writeFileSync(join(repo, "t3.cfg"), "v2\n"); sh(repo, "add", "t3.cfg"); writeFileSync(join(repo, "t3.cfg"), "v3\n");
  writeFileSync(join(repo, "t4.cfg"), "v1\n"); sh(repo, "add", "t4.cfg"); writeFileSync(join(repo, "t4.cfg"), "v2\n");
  assert.deepEqual([xy("t3.cfg"), xy("t4.cfg")], ["MM", "AM"]);
  for (const name of ["t3.cfg", "t4.cfg"]) {
    await run({ type: "untrack", path: name }, { where: "gitignore" });
    assert.equal(readFileSync(join(repo, name), "utf8"), name === "t3.cfg" ? "v3\n" : "v2\n", "the file on disk does not change");
    assert.equal(git(repo, ["ls-files", "--", name]).stdout, "");
  }
  assert.equal(xy("t3.cfg"), "D "); assert.equal(xy("t4.cfg"), null, "a file that was only added: ignored now");
  sh(repo, "reset", "-q", "--hard"); sh(repo, "clean", "-fdxq");
}

// ---- the AI prompt
{
  const p = G.messagePrompt({ diff: "+x", stat: " a | 1 +", subjects: ["feat(a): one"], format: "repo", instructions: "Write in English." });
  assert.match(p, /<recent-subjects>\nfeat\(a\): one/); assert.match(p, /Write in English\./);
  assert.doesNotMatch(G.messagePrompt({ diff: "+x", stat: "", subjects: ["s"], format: "conventional" }), /recent-subjects/);
  assert.equal(G.cleanMessage("```\nfix: a\n\nbody\n```"), "fix: a\n\nbody");
  assert.equal(G.cleanMessage('"fix: a"'), "fix: a");
}

// Discard a submodule to the parent's index, including tracked edits inside it.
{
  const source = join(dir, "source");
  const path = "modules/my lib";
  const checkout = join(repo, path);
  sh(dir, "init", "-q", "-b", "main", source);
  writeFileSync(join(source, "file.txt"), "first\n");
  sh(source, "add", "file.txt");
  sh(source, "commit", "-qm", "first");
  sh(repo, "-c", "protocol.file.allow=always", "submodule", "add", "--", source, path);
  sh(repo, "commit", "-qm", "add submodule");
  writeFileSync(join(checkout, "file.txt"), "second\n");
  sh(checkout, "commit", "-qam", "second");
  const staged = sh(checkout, "rev-parse", "HEAD").trim();
  sh(repo, "add", "--", path);
  sh(checkout, "checkout", "-q", "HEAD^");
  writeFileSync(join(checkout, "file.txt"), "dirty\n");
  sh(checkout, "add", "file.txt");
  writeFileSync(join(checkout, "local.txt"), "keep\n");

  await run({ type: "discard", paths: [path] });
  assert.equal(sh(checkout, "rev-parse", "HEAD").trim(), staged);
  assert.equal(readFileSync(join(checkout, "file.txt"), "utf8").trim(), "second");
  assert.equal(sh(checkout, "status", "--porcelain").trim(), "?? local.txt");
  assert.equal(sh(repo, "rev-parse", `:${path}`).trim(), staged);

  writeFileSync(join(checkout, "file.txt"), "dirty again\n");
  await run({ type: "discard", paths: [path] });
  assert.equal(sh(checkout, "status", "--porcelain").trim(), "?? local.txt");
}

rmSync(dir, { recursive: true, force: true });
console.log("changes ok");
