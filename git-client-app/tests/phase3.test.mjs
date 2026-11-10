// Tests the logic of phase 3 against throwaway repositories: file history (renames), blame, submodules
// (status, add, update, sync, remove) and the prompt of "Resolve with agent". Run: node tests/phase3.test.mjs
import * as G from "../mods/git-client/git.js";
import * as R from "../mods/git-client/refs.js";
import { executeAction } from "../mods/git-client/execute.js";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

// protocol.file.allow: submodules from a local folder (git refuses the file transport by default).
const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always" };
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git = (cwd, args) => { const r = spawnSync("git", args, { cwd, env, encoding: "utf8" }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
const exec = (cmd, args, o) => Promise.resolve(spawnSync(cmd, args, { cwd: o.cwd, env, encoding: "utf8" })).then((r) => ({ code: r.status, stdout: r.stdout, stderr: r.stderr }));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "herdr-git-client-3-"))).replace(/\\/g, "/");
const repo = `${dir}/repo`;
sh(dir, "init", "-q", "-b", "main", repo);
const commit = (msg) => { sh(repo, "add", "-A"); sh(repo, "commit", "-qm", msg); };
const ctx = () => ({ root: repo, on: null, current: "main", head: git(repo, ["rev-parse", "HEAD"]).stdout.trim(), branches: [], remotes: [] });
const run = async (action, values = {}) => { const r = await executeAction(action, values, ctx(), exec); assert.ok(r.ok, `${action.type}: ${r.message}`); return r; };

// ---- file history, across a rename
writeFileSync(join(repo, "old name.txt"), "one\ntwo\n"); commit("add file");
sh(repo, "mv", "old name.txt", "new name.txt"); commit("rename file");
writeFileSync(join(repo, "new name.txt"), "one\ntwo changed\nthree\n"); commit("edit file");
const log = R.parseFileLog(git(repo, ["-c", "core.quotePath=false", ...R.fileLogArgs("new name.txt")]).stdout);
assert.deepEqual(log.map((c) => [c.subject, c.path]), [["edit file", "new name.txt"], ["rename file", "new name.txt"], ["add file", "old name.txt"]], "follows the rename");
const first = git(repo, ["show", "--format=", "--no-color", log[2].hash, "--", log[2].path]).stdout;
assert.match(first, /\+one/, "the diff of the file in its first commit, under its old name");

// ---- blame
writeFileSync(join(repo, "new name.txt"), "one\ntwo changed\nthree\nnot committed\n");
const blame = R.parseBlame(git(repo, R.blameArgs("new name.txt")).stdout);
assert.deepEqual(blame.map((r) => [r.number, r.text, r.uncommitted ? null : r.summary, r.uncommitted]), [
  [1, "one", "add file", false], [2, "two changed", "edit file", false], [3, "three", "edit file", false], [4, "not committed", null, true]]);
assert.deepEqual(blame.map((r) => r.first), [true, true, false, true], "a group starts where the commit changes");
assert.equal(blame[0].author, "T");
sh(repo, "checkout", "--", "new name.txt");

// ---- menus of a file
const fileMenu = (f) => G.menuFor({ kind: "file", side: "unstaged", file: f }, ctx()).filter((i) => !i.separator).map((i) => i.label);
assert.ok(fileMenu({ path: "a", untracked: false, status: "M", x: " " }).includes("File history"));
assert.ok(fileMenu({ path: "a", untracked: false, status: "M", x: " " }).includes("Blame"));
assert.ok(!fileMenu({ path: "a", untracked: true, status: "A", x: "?" }).includes("File history"), "no history for an untracked file");
assert.ok(!fileMenu({ path: "a", untracked: false, status: "D", x: " " }).includes("Blame"), "no blame of a deleted file");

// ---- submodules
const lib = `${dir}/lib`;
sh(dir, "init", "-q", "-b", "main", lib);
writeFileSync(join(lib, "lib.txt"), "v1\n"); sh(lib, "add", "-A"); sh(lib, "commit", "-qm", "lib v1");
assert.deepEqual(R.parseSubmodules(git(repo, R.submoduleStatusArgs()).stdout), []);
assert.equal(R.submoduleFolder("https://example.com/a/lib.git"), "lib");
assert.equal(R.submoduleFolder("git@example.com:a/b.git/"), "b");
await run({ type: "submoduleAdd" }, { url: lib, path: "", branch: "main" });
commit("add lib");
const status = () => R.parseSubmodules(git(repo, R.submoduleStatusArgs()).stdout, git(repo, R.gitmodulesArgs()).stdout);
assert.deepEqual(status().map((s) => [s.path, s.state, s.url, s.branch]), [["lib", "ok", lib, "main"]]);
// A new commit upstream: Update from the remote branch moves the submodule; the parent sees it out of sync.
writeFileSync(join(lib, "lib.txt"), "v2\n"); sh(lib, "commit", "-qam", "lib v2");
await run({ type: "submoduleUpdateRemote", path: "lib" });
assert.equal(readFileSync(join(repo, "lib", "lib.txt"), "utf8").trim(), "v2");
assert.equal(status()[0].state, "out of sync");
await run({ type: "submoduleUpdate", path: "lib" });
assert.equal(status()[0].state, "ok", "back to the recorded commit");
// A fresh clone: not initialized until Update.
const clone = `${dir}/clone`;
sh(dir, "clone", "-q", repo, clone);
const cloneStatus = () => R.parseSubmodules(git(clone, R.submoduleStatusArgs()).stdout, git(clone, R.gitmodulesArgs()).stdout);
assert.equal(cloneStatus()[0].state, "uninitialized");
const cctx = { root: clone, on: null, current: "main", head: git(clone, ["rev-parse", "HEAD"]).stdout.trim(), branches: [], remotes: ["origin"] };
assert.ok((await executeAction({ type: "submoduleUpdate" }, {}, cctx, exec)).ok);
assert.equal(cloneStatus()[0].state, "ok");
assert.ok((await executeAction({ type: "submoduleSync", path: "lib" }, {}, cctx, exec)).ok);
// Menu and remove.
const smMenu = G.menuFor({ kind: "submodule", submodule: status()[0] }, ctx()).filter((i) => !i.separator).map((i) => i.label);
assert.deepEqual(smMenu, ["Open in the client", "Open in a space", "Update to the recorded commit", "Update from the remote branch", "Sync the URL", "Remove submodule…", "Copy path", "Copy URL"]);
await run({ type: "submoduleRemove", path: "lib" });
assert.ok(!existsSync(join(repo, "lib", "lib.txt")), "the folder is gone");
assert.equal(git(repo, ["config", "-f", ".gitmodules", "--get-regexp", "submodule"]).stdout, "", "and its .gitmodules entry");
assert.throws(() => G.commandsFor({ type: "submoduleAdd" }, { url: "--upload-pack=x", path: "" }), /URL/);
assert.throws(() => G.commandsFor({ type: "submoduleRemove", path: "-f" }), /folder/);
assert.deepEqual(R.parseSubmodules("-1234567890123456789012345678901234567890 deps/x\nU1234567890123456789012345678901234567890 y (v1)\n").map((s) => [s.path, s.state, s.describe, s.nested]),
  [["deps/x", "uninitialized", null, true], ["y", "conflict", "v1", true]]);

// ---- the prompt of the agent
const p = G.conflictPrompt({ op: "merge", files: ["a.js", "b.js"], current: "main", theirs: "feature", root: "/r" });
assert.match(p, /a merge of feature into main/); assert.match(p, /- a\.js\n- b\.js/); assert.match(p, /Do not run git merge --continue/);
assert.match(G.conflictPrompt({ op: "rebase", files: ["x"], current: "fix", theirs: null, root: "/r" }), /a rebase of fix/);

rmSync(dir, { recursive: true, force: true });
console.log("phase 3 ok");
