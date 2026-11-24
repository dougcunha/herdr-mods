import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as G from "../mods/git-client/git.js";
import { executeAction } from "../mods/git-client/execute.js";
import {
  emptySelection,
  isPicked,
  clickRow,
  clickCheckbox,
  selectAll,
  pruneSelection,
  selectedFiles,
  emptyBranchSelection,
  branchPickedCount,
  isBranchPicked,
  toggleBranch,
  selectBranches,
  pruneBranchSelection,
  selectedBranches,
} from "../mods/git-client/selection.js";

// ---- Selection state machine
const unstaged = [{ path: "a.txt" }, { path: "b.txt" }, { path: "c.txt" }, { path: "d.txt" }];
const staged = [{ path: "s1.txt" }, { path: "s2.txt" }];
const lists = { conflict: [], unstaged, staged };

{
  // Plain click opens and toggles closed
  const r1 = clickRow(emptySelection(), { path: "a.txt", side: "unstaged", list: unstaged, currentSel: null });
  assert.deepEqual(r1.open, { path: "a.txt", side: "unstaged" });
  assert.equal(r1.closed, false);
  assert.equal(r1.state.paths.size, 0);

  const r2 = clickRow(r1.state, { path: "a.txt", side: "unstaged", list: unstaged, currentSel: r1.open });
  assert.equal(r2.open, null);
  assert.equal(r2.closed, true);
}

{
  // Ctrl/Cmd+Click seeds from currently open file on the same side, toggles items, and empties cleanly
  const open = { path: "a.txt", side: "unstaged" };
  const c1 = clickRow(emptySelection(), { path: "c.txt", side: "unstaged", list: unstaged, currentSel: open, modifiers: { control: true } });
  assert.deepEqual([...c1.state.paths].sort(), ["a.txt", "c.txt"]);
  assert.deepEqual(c1.open, { path: "c.txt", side: "unstaged" });

  // Toggle off "a.txt", then "c.txt"
  const c2 = clickRow(c1.state, { path: "a.txt", side: "unstaged", list: unstaged, currentSel: c1.open, modifiers: { platform: true } });
  assert.deepEqual([...c2.state.paths], ["c.txt"]);
  const c3 = clickRow(c2.state, { path: "c.txt", side: "unstaged", list: unstaged, currentSel: c2.open, modifiers: { control: true } });
  assert.equal(c3.state.side, null);
  assert.equal(c3.state.paths.size, 0);

  // Plain click when multi-selection is active clears multi-selection and opens clicked file
  const c4 = clickRow(c1.state, { path: "b.txt", side: "unstaged", list: unstaged, currentSel: c1.open });
  assert.equal(c4.state.paths.size, 0);
  assert.deepEqual(c4.open, { path: "b.txt", side: "unstaged" });
  assert.equal(c4.closed, false);
}

{
  // Shift+Click: forward, backward, Ctrl+Shift union, and cross-section reset
  const s1 = clickRow(emptySelection(), { path: "c.txt", side: "unstaged", list: unstaged, currentSel: { path: "a.txt", side: "unstaged" }, modifiers: { shift: true } });
  assert.deepEqual([...s1.state.paths], ["a.txt", "b.txt", "c.txt"]);
  assert.equal(s1.state.anchor, "a.txt");

  // Backward from c.txt -> b.txt? Using anchor a.txt: slice is a.txt..b.txt
  const s2 = clickRow(s1.state, { path: "b.txt", side: "unstaged", list: unstaged, currentSel: s1.open, modifiers: { shift: true } });
  assert.deepEqual([...s2.state.paths], ["a.txt", "b.txt"]);

  // Ctrl+Shift+Click adds range while keeping existing picks
  const s3 = clickRow(
    { side: "unstaged", paths: new Set(["d.txt"]), anchor: "c.txt" },
    { path: "b.txt", side: "unstaged", list: unstaged, currentSel: null, modifiers: { shift: true, control: true } },
  );
  assert.deepEqual([...s3.state.paths].sort(), ["b.txt", "c.txt", "d.txt"]);

  // Shift+Click in another section resets to that section
  const s4 = clickRow(s1.state, { path: "s2.txt", side: "staged", list: staged, currentSel: s1.open, modifiers: { shift: true } });
  assert.equal(s4.state.side, "staged");
  assert.deepEqual([...s4.state.paths], ["s2.txt"]);
}

{
  // Checkbox toggle, Shift+Checkbox range union, and section switching
  let st = clickCheckbox(emptySelection(), { path: "a.txt", side: "unstaged", list: unstaged });
  assert.equal(isPicked(st, "unstaged", "a.txt"), true);
  st = clickCheckbox(st, { path: "c.txt", side: "unstaged", list: unstaged, modifiers: { shift: true } });
  assert.deepEqual([...st.paths].sort(), ["a.txt", "b.txt", "c.txt"]);
  st = clickCheckbox(st, { path: "b.txt", side: "unstaged", list: unstaged });
  assert.deepEqual([...st.paths].sort(), ["a.txt", "c.txt"]);

  // Switching to staged resets selection to staged
  st = clickCheckbox(st, { path: "s1.txt", side: "staged", list: staged });
  assert.equal(st.side, "staged");
  assert.deepEqual([...st.paths], ["s1.txt"]);
  st = clickCheckbox(st, { path: "s1.txt", side: "staged", list: staged });
  assert.equal(st.side, null);
  assert.equal(st.paths.size, 0);
}

{
  // selectAll, pruneSelection, selectedFiles
  const all = selectAll(unstaged, "unstaged");
  assert.equal(all.paths.size, 4);
  assert.deepEqual(selectedFiles(all, lists).map((f) => f.path), ["a.txt", "b.txt", "c.txt", "d.txt"]);

  const pruned = pruneSelection(all, { conflict: [], staged, unstaged: [{ path: "b.txt" }, { path: "d.txt" }] });
  assert.deepEqual([...pruned.paths], ["b.txt", "d.txt"]);
  assert.equal(pruned.anchor, "b.txt");

  const gone = pruneSelection(pruned, { conflict: [], staged, unstaged: [] });
  assert.equal(gone.side, null);
  assert.equal(gone.paths.size, 0);
  assert.equal(selectAll([], "unstaged").side, null);
}

// ---- Multi-file context menus
{
  const c = { head: "abc123", on: null };
  const labels = (target) => G.menuFor(target, c).filter((i) => !i.separator).map((i) => i.label);

  assert.deepEqual(
    labels({ kind: "files", side: "unstaged", files: [{ path: "a.txt", untracked: false, status: "M" }, { path: "u.txt", untracked: true, status: "?" }] }),
    ["Stage 2 files", "Discard 2 files…", "Copy 2 paths"],
  );
  assert.deepEqual(
    labels({ kind: "files", side: "unstaged", files: [{ path: "a.txt", untracked: false, status: "M" }, { path: "b.txt", untracked: false, status: "M" }] }),
    ["Stage 2 files", "Discard 2 files…", "Stop tracking 2 files…", "Copy 2 paths"],
  );
  assert.deepEqual(
    labels({ kind: "files", side: "unstaged", files: [{ path: "a.txt", untracked: false, status: "D" }, { path: "b.txt", untracked: false, status: "M" }] }),
    ["Stage 2 files", "Discard 2 files…", "Copy 2 paths"],
    "no Stop tracking when a deleted file is included",
  );
  assert.deepEqual(
    labels({ kind: "files", side: "unstaged", files: [{ path: "u1.log", untracked: true, status: "?" }, { path: "u2.log", untracked: true, status: "?" }] }),
    ["Stage 2 files", "Delete 2 files…", "Ignore 2 files…", "Copy 2 paths"],
  );
  assert.deepEqual(
    labels({ kind: "files", side: "staged", files: [{ path: "a.txt", untracked: false, status: "M" }, { path: "b.txt", untracked: false, status: "A" }] }),
    ["Unstage 2 files", "Stop tracking 2 files…", "Copy 2 paths"],
  );
  assert.deepEqual(
    labels({ kind: "files", side: "conflict", files: [{ path: "a.txt", untracked: false, status: "U" }, { path: "b.txt", untracked: false, status: "U" }] }),
    ["Mark 2 files resolved (stage)", "Copy 2 paths"],
  );
}

// ---- Disposable repo execution: bulk stage, unstage, discard, ignoreMany, untrackMany
{
  const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" };
  const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const git = (cwd, args) => { const r = spawnSync("git", args, { cwd, env, encoding: "utf8" }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
  const exec = (cmd, args, o) => Promise.resolve(spawnSync(cmd, args, { cwd: o.cwd, env, encoding: "utf8" })).then((r) => ({ code: r.status, stdout: r.stdout, stderr: r.stderr }));
  const dir = mkdtempSync(join(tmpdir(), "herdr-git-sel-"));
  const repo = join(dir, "repo");
  const io = {
    async appendLine(f, line) {
      const t = existsSync(f) ? readFileSync(f, "utf8") : "";
      if (!t.split(/\r?\n/).includes(line)) writeFileSync(f, t + (t && !t.endsWith("\n") ? "\n" : "") + line + "\n");
    },
  };

  sh(dir, "init", "-q", "-b", "main", repo);
  sh(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "a.txt"), "1\n");
  writeFileSync(join(repo, "b.txt"), "1\n");
  writeFileSync(join(repo, "c.txt"), "1\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "init");

  const ctx = () => ({ root: repo, on: null, current: "main", head: git(repo, ["rev-parse", "HEAD"]).stdout.trim(), branches: ["main"], remotes: [] });
  const status = () => G.parseStatus(git(repo, [...G.READ, ...G.STATUS]).stdout);
  const run = async (action, values = {}) => {
    const r = await executeAction(action, values, ctx(), exec, io);
    assert.ok(r.ok, r.message);
    return r;
  };

  // Stage & unstage multiple files
  writeFileSync(join(repo, "a.txt"), "2\n");
  writeFileSync(join(repo, "b.txt"), "2\n");
  writeFileSync(join(repo, "u1.tmp"), "u1\n");
  writeFileSync(join(repo, "u2.tmp"), "u2\n");
  await run({ type: "stage", paths: ["a.txt", "b.txt", "u1.tmp"] });
  assert.deepEqual(status().filter((f) => f.staged).map((f) => f.path).sort(), ["a.txt", "b.txt", "u1.tmp"]);

  await run({ type: "unstage", paths: ["a.txt", "u1.tmp"], unborn: false });
  assert.deepEqual(status().filter((f) => f.staged).map((f) => f.path), ["b.txt"]);

  // Bulk discard tracked + untracked
  await run({ type: "discard", paths: ["a.txt"], untracked: ["u1.tmp", "u2.tmp"] });
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "1\n");
  assert.ok(!existsSync(join(repo, "u1.tmp")) && !existsSync(join(repo, "u2.tmp")));

  // ignoreMany
  writeFileSync(join(repo, "ign1.log"), "x\n");
  writeFileSync(join(repo, "ign2.log"), "y\n");
  await run({ type: "ignoreMany", paths: ["ign1.log", "ign2.log"] }, { where: "gitignore" });
  const gi = readFileSync(join(repo, ".gitignore"), "utf8");
  assert.match(gi, /^\/ign1\.log$/m);
  assert.match(gi, /^\/ign2\.log$/m);
  assert.ok(!status().some((f) => f.path === "ign1.log" || f.path === "ign2.log"));

  // untrackMany
  await run({ type: "untrackMany", paths: ["a.txt", "c.txt"] }, { where: "exclude" });
  const ex = readFileSync(join(repo, ".git/info/exclude"), "utf8");
  assert.match(ex, /^\/a\.txt$/m);
  assert.match(ex, /^\/c\.txt$/m);
  assert.ok(existsSync(join(repo, "a.txt")) && existsSync(join(repo, "c.txt")));
  assert.equal(git(repo, ["ls-files", "--", "a.txt", "c.txt"]).stdout, "");

  rmSync(dir, { recursive: true, force: true });
}

// ---- Branch multi-selection state machine, menus, dialogs, and commands
{
  const localAll = [{ name: "main", current: true }, { name: "feat/a", current: false }, { name: "feat/b", current: false }, { name: "feat/c", current: false }];
  const localSelectable = localAll.filter((b) => !b.current);
  const remote = [
    { name: "origin/feat/a", remote: "origin", branch: "feat/a" },
    { name: "origin/feat/b", remote: "origin", branch: "feat/b" },
    { name: "upstream/old", remote: "upstream", branch: "old" },
  ];

  // Current branch cannot be selected
  let bst = toggleBranch(emptyBranchSelection(), { kind: "local", name: "main", list: localSelectable });
  assert.equal(branchPickedCount(bst), 0);

  // Toggle local, Shift+Click range, and simultaneous remote selection
  bst = toggleBranch(bst, { kind: "local", name: "feat/a", list: localSelectable });
  bst = toggleBranch(bst, { kind: "local", name: "feat/c", list: localSelectable, modifiers: { shift: true } });
  assert.deepEqual([...bst.local].sort(), ["feat/a", "feat/b", "feat/c"]);

  bst = toggleBranch(bst, { kind: "remote", name: "origin/feat/a", list: remote });
  bst = toggleBranch(bst, { kind: "remote", name: "upstream/old", list: remote, modifiers: { shift: true } });
  assert.equal(bst.local.size, 3);
  assert.equal(bst.remote.size, 3);
  assert.equal(isBranchPicked(bst, "remote", "origin/feat/b"), true);

  // Prune drops missing branches & current branch
  const pruned = pruneBranchSelection(bst, {
    local: [{ name: "feat/a", current: true }, { name: "feat/b", current: false }],
    remote: [{ name: "upstream/old", remote: "upstream", branch: "old" }],
  });
  assert.deepEqual([...pruned.local], ["feat/b"]);
  assert.deepEqual([...pruned.remote], ["upstream/old"]);

  const sel = selectedBranches(pruned, {
    local: [{ name: "feat/a", current: true }, { name: "feat/b", current: false }],
    remote: [{ name: "upstream/old", remote: "upstream", branch: "old" }],
  });
  assert.deepEqual(sel.local.map((b) => b.name), ["feat/b"]);
  assert.deepEqual(sel.remote.map((b) => b.name), ["upstream/old"]);

  // selectBranches replaces only its kind
  const allRem = selectBranches(pruned, "remote", remote);
  assert.deepEqual([...allRem.local], ["feat/b"]);
  assert.equal(allRem.remote.size, 3);

  // Menus, dialogs, commands
  const c = { current: "main", branches: ["main", "feat/b"], remotes: ["origin", "upstream"] };
  assert.deepEqual(
    G.menuFor({ kind: "branches", local: ["main", "feat/b", "feat/c"], remote: [] }, c).filter((i) => !i.separator).map((i) => i.label),
    ["Delete 2 branches…", "Copy 2 branch names"],
  );
  assert.deepEqual(
    G.menuFor({ kind: "branches", local: [], remote }, c).filter((i) => !i.separator).map((i) => i.label),
    ["Delete 3 remote branches…", "Copy 3 branch names"],
  );
  assert.deepEqual(
    G.menuFor({ kind: "branches", local: ["feat/b"], remote }, c).filter((i) => !i.separator).map((i) => i.label),
    ["Delete 4 branches (1 local, 3 remote)…", "Copy 4 branch names"],
  );

  const dBoth = G.dialogFor({ type: "deleteBranches", local: ["feat/b"], remote }, c);
  assert.equal(dBoth.title, "Delete branches");
  assert.equal(dBoth.checks.length, 1);
  assert.equal(G.dialogFor({ type: "deleteBranches", local: [], remote }, c).checks, undefined);

  assert.deepEqual(
    G.commandsFor({ type: "deleteBranches", local: ["feat/b", "feat/c"], remote }, { force: true }, c),
    [
      ["branch", "-D", "feat/b", "feat/c"],
      ["push", "origin", "--delete", "feat/a", "feat/b"],
      ["push", "upstream", "--delete", "old"],
    ],
  );
  assert.throws(() => G.commandsFor({ type: "deleteBranches", local: [], remote: [] }, {}, c), /No branches selected/);
  assert.throws(() => G.commandsFor({ type: "deleteBranches", local: ["-bad"], remote: [] }, {}, c), /Invalid ref/);
}

console.log("selection ok");
