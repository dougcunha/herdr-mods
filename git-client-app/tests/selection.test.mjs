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
  orderCommits,
  clickCommit,
  swapCompareState,
  stepIndex,
  visualReviewSelection,
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
    ["Stage 2 files", "Stash 2 files…", "Discard 2 files…", "Copy 2 paths"],
  );
  assert.deepEqual(
    labels({ kind: "files", side: "unstaged", files: [{ path: "a.txt", untracked: false, status: "M" }, { path: "b.txt", untracked: false, status: "M" }] }),
    ["Stage 2 files", "Stash 2 files…", "Discard 2 files…", "Stop tracking 2 files…", "Copy 2 paths"],
  );
  assert.deepEqual(
    labels({ kind: "files", side: "unstaged", files: [{ path: "a.txt", untracked: false, status: "D" }, { path: "b.txt", untracked: false, status: "M" }] }),
    ["Stage 2 files", "Stash 2 files…", "Discard 2 files…", "Copy 2 paths"],
    "no Stop tracking when a deleted file is included",
  );
  assert.deepEqual(
    labels({ kind: "files", side: "unstaged", files: [{ path: "u1.log", untracked: true, status: "?" }, { path: "u2.log", untracked: true, status: "?" }] }),
    ["Stage 2 files", "Stash 2 files…", "Delete 2 files…", "Ignore 2 files…", "Copy 2 paths"],
  );
  assert.deepEqual(
    labels({ kind: "files", side: "staged", files: [{ path: "a.txt", untracked: false, status: "M" }, { path: "b.txt", untracked: false, status: "A" }] }),
    ["Unstage 2 files", "Stash 2 files…", "Stop tracking 2 files…", "Copy 2 paths"],
  );
  assert.deepEqual(
    labels({ kind: "files", side: "conflict", files: [{ path: "a.txt", untracked: false, status: "U" }, { path: "b.txt", untracked: false, status: "U" }] }),
    ["Keep ours for 2 files", "Accept theirs for 2 files", "Mark 2 files resolved (stage)", "Copy 2 paths"],
  );
  assert.deepEqual(
    G.menuFor({ kind: "file", side: "conflict", file: { path: "a.txt", untracked: false, status: "U" } }, { ...c, opSides: { ours: { ref: "master" }, theirs: { ref: "NET10" } } })
      .filter((i) => !i.separator).map((i) => i.label),
    ["Keep ours (master)", "Accept theirs (NET10)", "Mark resolved (stage)", "File history", "Blame", "Open file", "Copy path"],
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

// ---- History 2-commit comparison state machine, menus, and git diff args
{
  const h1 = "1".repeat(40); // newest (index 0)
  const h2 = "2".repeat(40); // middle (index 1)
  const h3 = "3".repeat(40); // oldest (index 2)
  const order = new Map([[h1, 0], [h2, 1], [h3, 2]]);
  const indexOf = (h) => order.get(h);

  // orderCommits orders older -> newer regardless of argument order
  assert.deepEqual(orderCommits(h1, h3, indexOf), { base: h3, target: h1 });
  assert.deepEqual(orderCommits(h3, h1, indexOf), { base: h3, target: h1 });
  assert.deepEqual(orderCommits(h1, "missing", indexOf), { base: h1, target: "missing" });

  // Plain click selects; in narrow mode clicking same commit toggles off; in wide mode stays selected
  let st = clickCommit(null, { hash: h1, indexOf, wide: true });
  assert.deepEqual(st, { selected: h1, compare: null, anchor: h1 });
  st = clickCommit(st, { hash: h1, indexOf, wide: true });
  assert.deepEqual(st, { selected: h1, compare: null, anchor: h1 });

  let narrow = clickCommit(null, { hash: h1, indexOf, wide: false });
  assert.deepEqual(narrow, { selected: h1, compare: null, anchor: h1 });
  narrow = clickCommit(narrow, { hash: h1, indexOf, wide: false });
  assert.deepEqual(narrow, { selected: null, compare: null, anchor: null });

  // Ctrl/Cmd/Shift+Click second commit starts chronological comparison
  st = clickCommit({ selected: h1, compare: null, anchor: h1 }, { hash: h3, indexOf, modifiers: { control: true }, wide: true });
  assert.deepEqual(st, { selected: null, compare: { base: h3, target: h1 }, anchor: h1 });

  // Selecting older first then newer with Shift+Click gives same older -> newer direction
  const stShift = clickCommit({ selected: h3, compare: null, anchor: h3 }, { hash: h1, indexOf, modifiers: { shift: true }, wide: false });
  assert.deepEqual(stShift, { selected: null, compare: { base: h3, target: h1 }, anchor: h3 });

  // Ctrl+Click a 3rd commit replaces the non-anchor end
  const st3 = clickCommit(st, { hash: h2, indexOf, modifiers: { platform: true }, wide: true });
  assert.deepEqual(st3, { selected: null, compare: { base: h2, target: h1 }, anchor: h1 });

  // Ctrl+Click one of the two compared commits drops back to the other single commit
  const dropBase = clickCommit(st3, { hash: h2, indexOf, modifiers: { control: true }, wide: true });
  assert.deepEqual(dropBase, { selected: h1, compare: null, anchor: h1 });
  const dropTarget = clickCommit(st3, { hash: h1, indexOf, modifiers: { control: true }, wide: true });
  assert.deepEqual(dropTarget, { selected: h2, compare: null, anchor: h2 });

  // Ctrl+Click the single selected commit clears selection
  assert.deepEqual(
    clickCommit({ selected: h1, compare: null, anchor: h1 }, { hash: h1, indexOf, modifiers: { control: true }, wide: true }),
    { selected: null, compare: null, anchor: null },
  );

  // Plain click while comparing exits compare and selects clicked commit
  assert.deepEqual(
    clickCommit(st3, { hash: h3, indexOf, wide: true }),
    { selected: h3, compare: null, anchor: h3 },
  );

  // swapCompareState reverses base and target
  assert.deepEqual(
    swapCompareState(st3).compare,
    { base: h1, target: h2 },
  );

  // Commit context menu includes "Compare with <short>" only when another valid commit is selected
  const baseCommit = { hash: h1, parents: [h2], subject: "latest" };
  const otherCommit = { hash: h3, parents: [], subject: "oldest" };
  const menuWithOther = G.menuFor({ kind: "commit", commit: otherCommit }, { head: h1, current: "main", remotes: [], selectedCommit: h1 });
  assert.equal(menuWithOther[0].label, `Compare with ${h1.slice(0, 8)}`);
  assert.deepEqual(menuWithOther[0].action, { type: "compareCommits", a: h1, b: h3 });
  const menuOnSame = G.menuFor({ kind: "commit", commit: baseCommit }, { head: h1, current: "main", remotes: [], selectedCommit: h1 });
  assert.ok(!menuOnSame.some((it) => it.action?.type === "compareCommits"));

  // Real git execution of compareFileArgs and compareDiffArgs
  assert.throws(() => G.compareFileArgs("--bad", h1), /Invalid commit identity/);
  assert.throws(() => G.compareDiffArgs(h1, "not-a-hash", "a.txt"), /Invalid commit identity/);

  const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" };
  const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const git = (cwd, args) => { const r = spawnSync("git", args, { cwd, env, encoding: "utf8" }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
  const dir = mkdtempSync(join(tmpdir(), "herdr-git-cmp-"));
  const repo = join(dir, "repo");
  sh(dir, "init", "-q", "-b", "main", repo);
  sh(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "a.txt"), "one\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "c1");
  const c1 = git(repo, ["rev-parse", "HEAD"]).stdout.trim();

  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "b.txt"), "hello\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "c2");
  const c2 = git(repo, ["rev-parse", "HEAD"]).stdout.trim();

  writeFileSync(join(repo, "a.txt"), "one\n");
  rmSync(join(repo, "b.txt"));
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "c3");
  const c3 = git(repo, ["rev-parse", "HEAD"]).stdout.trim();

  const fa = G.compareFileArgs(c1, c2);
  const files = G.joinFiles(git(repo, [...G.READ, ...fa.status]).stdout, git(repo, [...G.READ, ...fa.numstat]).stdout);
  assert.deepEqual(files.map((f) => [f.status, f.path, f.add, f.del]), [["M", "a.txt", 1, 0], ["A", "b.txt", 1, 0]]);
  const rows = G.diffRows(git(repo, [...G.READ, ...G.compareDiffArgs(c1, c2, "a.txt")]).stdout);
  assert.ok(rows.some((r) => r.kind === "+" && r.text === "two"));

  // Identical trees (c1 vs c3) yield zero changed files
  const faSame = G.compareFileArgs(c1, c3);
  const sameFiles = G.joinFiles(git(repo, [...G.READ, ...faSame.status]).stdout, git(repo, [...G.READ, ...faSame.numstat]).stdout);
  assert.deepEqual(sameFiles, []);

  rmSync(dir, { recursive: true, force: true });
}

// ---- Merge dialog "Do not commit" option
{
  const c = { current: "main", branches: ["main", "feat"], remotes: [] };
  const action = { type: "merge", ref: "feat", what: "branch feat" };
  const spec = G.dialogFor(action, c);
  assert.deepEqual(spec.checks.map((k) => [k.id, k.value]), [["noff", false], ["noCommit", false], ["squash", false]]);
  assert.deepEqual(G.commandsFor(action, { noff: false, noCommit: false }, c), [["merge", "--no-edit", "feat"]]);
  assert.deepEqual(G.commandsFor(action, { noff: true, noCommit: false }, c), [["merge", "--no-edit", "--no-ff", "feat"]]);
  assert.deepEqual(G.commandsFor(action, { noff: false, noCommit: true }, c), [["merge", "--no-ff", "--no-commit", "feat"]]);
  assert.deepEqual(G.commandsFor(action, { noff: true, noCommit: true }, c), [["merge", "--no-ff", "--no-commit", "feat"]]);
  assert.equal(G.doneText(action, { noCommit: false }), "Merged branch feat");
  assert.equal(G.doneText(action, { noCommit: true }), "Merged branch feat (staged, not committed)");

  const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" };
  const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const git = (cwd, args) => { const r = spawnSync("git", args, { cwd, env, encoding: "utf8" }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
  const dir = mkdtempSync(join(tmpdir(), "herdr-git-merge-nc-"));
  const repo = join(dir, "repo");
  sh(dir, "init", "-q", "-b", "main", repo);
  sh(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "a.txt"), "one\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "init");
  const headBefore = git(repo, ["rev-parse", "HEAD"]).stdout.trim();

  sh(repo, "checkout", "-qb", "feat");
  writeFileSync(join(repo, "feat.txt"), "feature\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "feat commit");
  sh(repo, "checkout", "-q", "main");

  for (const args of G.commandsFor(action, { noff: false, noCommit: true }, c)) {
    const r = git(repo, args);
    assert.equal(r.code, 0, r.stderr);
  }
  assert.equal(git(repo, ["rev-parse", "HEAD"]).stdout.trim(), headBefore, "HEAD stays at previous commit");
  assert.equal(git(repo, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]).code, 0, "MERGE_HEAD is present");
  assert.deepEqual(G.parseStatus(git(repo, [...G.READ, ...G.STATUS]).stdout).map((f) => [f.path, f.staged]), [["feat.txt", true]]);

  rmSync(dir, { recursive: true, force: true });
}

// ---- Keyboard file navigation stepIndex helper
{
  assert.equal(stepIndex(-1, 0, 1), -1);
  assert.equal(stepIndex(-1, 5, 1), 0);
  assert.equal(stepIndex(-1, 5, -1), 4);
  assert.equal(stepIndex(0, 5, -1), 0);
  assert.equal(stepIndex(0, 5, 1), 1);
  assert.equal(stepIndex(4, 5, 1), 4);
  assert.equal(stepIndex(4, 5, -1), 3);
}

// ---- Conflict resolution: parseUnmerged, doneText, regular UU, modify/delete, and submodule gitlink
{
  const parsed = G.parseUnmerged(
    `100644 ${"1".repeat(40)} 1\ta.txt\0` +
    `100644 ${"2".repeat(40)} 2\ta.txt\0` +
    `100644 ${"3".repeat(40)} 3\ta.txt\0` +
    `160000 ${"a".repeat(40)} 2\t_lib\0` +
    `160000 ${"b".repeat(40)} 3\t_lib\0` +
    `100644 ${"c".repeat(40)} 2\tdel.txt\0`,
  );
  assert.equal(parsed.get("a.txt")[2].hash, "2".repeat(40));
  assert.equal(parsed.get("a.txt")[3].hash, "3".repeat(40));
  assert.equal(parsed.get("_lib")[2].mode, "160000");
  assert.equal(parsed.get("_lib")[3].hash, "b".repeat(40));
  assert.equal(parsed.get("del.txt")[3], undefined);

  assert.equal(G.doneText({ type: "resolveConflict", side: "ours", paths: ["a.txt"], label: "master" }), "Kept ours (master) for a.txt");
  assert.equal(G.doneText({ type: "resolveConflict", side: "theirs", paths: ["a.txt", "b.txt"], label: "NET10" }), "Accepted theirs (NET10) for 2 files");

  const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" };
  const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const git = (cwd, args) => { const r = spawnSync("git", args, { cwd, env, encoding: "utf8" }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
  const exec = (cmd, args, o) => Promise.resolve(spawnSync(cmd, args, { cwd: o.cwd, env, encoding: "utf8" })).then((r) => ({ code: r.status, stdout: r.stdout, stderr: r.stderr }));
  const dir = mkdtempSync(join(tmpdir(), "herdr-git-conflict-"));
  const subSrc = join(dir, "sub");
  const repo = join(dir, "repo");

  // Submodule source repo with 3 commits
  sh(dir, "init", "-q", "-b", "main", subSrc);
  writeFileSync(join(subSrc, "lib.txt"), "v1\n");
  sh(subSrc, "add", "-A");
  sh(subSrc, "commit", "-qm", "sub1");
  const sub1 = git(subSrc, ["rev-parse", "HEAD"]).stdout.trim();
  writeFileSync(join(subSrc, "lib.txt"), "v2\n");
  sh(subSrc, "add", "-A");
  sh(subSrc, "commit", "-qm", "sub2");
  const sub2 = git(subSrc, ["rev-parse", "HEAD"]).stdout.trim();
  writeFileSync(join(subSrc, "lib.txt"), "v3\n");
  sh(subSrc, "add", "-A");
  sh(subSrc, "commit", "-qm", "sub3");
  const sub3 = git(subSrc, ["rev-parse", "HEAD"]).stdout.trim();

  // Parent repo with regular file, mod-del file, and submodule gitlink
  sh(dir, "init", "-q", "-b", "master", repo);
  sh(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "f1.txt"), "base\n");
  writeFileSync(join(repo, "f2.txt"), "base\n");
  writeFileSync(join(repo, "md.txt"), "base\n");
  sh(repo, "add", "-A");
  sh(repo, "update-index", "--add", "--cacheinfo", `160000,${sub1},_lib`);
  sh(repo, "commit", "-qm", "base");

  // Branch theirs (NET10)
  sh(repo, "checkout", "-qb", "NET10");
  writeFileSync(join(repo, "f1.txt"), "theirs1\n");
  writeFileSync(join(repo, "f2.txt"), "theirs2\n");
  rmSync(join(repo, "md.txt"));
  sh(repo, "add", "-A");
  sh(repo, "update-index", "--add", "--cacheinfo", `160000,${sub3},_lib`);
  sh(repo, "commit", "-qm", "theirs");

  // Branch ours (master)
  sh(repo, "checkout", "-q", "master");
  writeFileSync(join(repo, "f1.txt"), "ours1\n");
  writeFileSync(join(repo, "f2.txt"), "ours2\n");
  writeFileSync(join(repo, "md.txt"), "ours-mod\n");
  sh(repo, "add", "-A");
  sh(repo, "update-index", "--add", "--cacheinfo", `160000,${sub2},_lib`);
  sh(repo, "commit", "-qm", "ours");

  // Merge -> hits conflicts on f1.txt, f2.txt, md.txt, _lib
  const m = git(repo, ["merge", "NET10"]);
  assert.notEqual(m.code, 0, "merge stops on conflicts");

  const ctx = () => ({ root: repo, on: null, current: "master", head: git(repo, ["rev-parse", "HEAD"]).stdout.trim(), branches: ["master", "NET10"], remotes: [] });

  const rOurs = await executeAction({ type: "resolveConflict", side: "ours", paths: ["f1.txt"] }, {}, ctx(), exec, null);
  assert.ok(rOurs.ok, rOurs.message);
  assert.equal(readFileSync(join(repo, "f1.txt"), "utf8"), "ours1\n");

  const rTheirs = await executeAction({ type: "resolveConflict", side: "theirs", paths: ["f2.txt"] }, {}, ctx(), exec, null);
  assert.ok(rTheirs.ok, rTheirs.message);
  assert.equal(readFileSync(join(repo, "f2.txt"), "utf8"), "theirs2\n");

  const rMd = await executeAction({ type: "resolveConflict", side: "theirs", paths: ["md.txt"] }, {}, ctx(), exec, null);
  assert.ok(rMd.ok, rMd.message);
  assert.ok(!existsSync(join(repo, "md.txt")), "choosing deleted theirs removes md.txt");

  const rSub = await executeAction({ type: "resolveConflict", side: "theirs", paths: ["_lib"] }, {}, ctx(), exec, null);
  assert.ok(rSub.ok, rSub.message);
  assert.equal(git(repo, ["ls-files", "--stage", "--", "_lib"]).stdout.trim(), `160000 ${sub3} 0\t_lib`);

  assert.equal(git(repo, ["ls-files", "--unmerged"]).stdout.trim(), "", "all conflicts resolved");

  rmSync(dir, { recursive: true, force: true });
}

// ---- Selection-aware Visual Review launch and context menu
{
  const h1 = "11111111aaaa";
  const h2 = "22222222bbbb";
  const h3 = "33333333cccc";
  const commits = [
    { hash: h3, subject: "third commit" },
    { hash: h2, subject: "second commit" },
    { hash: h1, subject: "first commit" },
  ];
  const index = new Map(commits.map((c, i) => [c.hash, i]));

  assert.deepEqual(
    visualReviewSelection({ compare: { base: h1, target: h3 }, selected: null, commits, index }),
    {
      selection: { mode: "compare", from: h1, to: h3, label: "11111111 → 33333333" },
      tooltip: "Visual Review diff 11111111 → 33333333",
    },
  );
  assert.deepEqual(
    visualReviewSelection({ compare: null, selected: h2, commits, index }),
    {
      selection: { mode: "single", head: h2, label: "22222222 · second commit" },
      tooltip: "Visual Review commit 22222222",
    },
  );
  assert.deepEqual(
    visualReviewSelection({ compare: null, selected: "deadbeef1234", commits, index }),
    {
      selection: { mode: "single", head: "deadbeef1234", label: "deadbeef" },
      tooltip: "Visual Review commit deadbeef",
    },
  );
  assert.deepEqual(
    visualReviewSelection({ compare: null, selected: "uncommitted", commits, index, uncommittedKey: "uncommitted" }),
    {
      selection: { mode: "uncommitted" },
      tooltip: "Visual Review uncommitted changes",
    },
  );
  assert.deepEqual(
    visualReviewSelection({ compare: null, selected: null, commits, index }),
    {
      selection: { mode: "branch-base" },
      tooltip: "Visual Review current branch vs base",
    },
  );

  const ctxWithCompare = {
    current: "main",
    head: h3,
    branches: ["main"],
    remotes: [],
    vrEnabled: true,
    selectedCommit: h1,
    compare: { base: h3, target: h1 }, // swapped direction
    compareRange: { base: h1, target: h3 }, // chronological range
  };
  const onCompared = G.menuFor({ kind: "commit", commit: { hash: h1, subject: "first", parents: [] } }, ctxWithCompare);
  const vrItems = onCompared.filter((i) => i.action?.type === "visualReview");
  assert.deepEqual(
    vrItems.map((i) => [i.label, i.action.selection.mode, i.action.selection.from, i.action.selection.to]),
    [
      ["Visual Review diff 33333333 → 11111111", "compare", h3, h1],
      ["Visual Review range 11111111..33333333 (inclusive)", "range", h1, h3],
      ["Visual Review this commit", "single", undefined, undefined],
      ["Visual Review to HEAD", "range", h1, h3],
    ],
  );

  const outsideCompare = G.menuFor({ kind: "commit", commit: { hash: h2, subject: "second", parents: [h1] } }, ctxWithCompare);
  assert.deepEqual(
    outsideCompare.filter((i) => i.action?.type === "visualReview").map((i) => i.label),
    ["Visual Review this commit", "Visual Review to HEAD"],
  );
}

console.log("selection ok");
