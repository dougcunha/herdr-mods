import assert from "node:assert/strict";
import { worktreeBranchOptions, worktreeRequest } from "../mods/git-client/worktree-pick.js";

const local = [
  { name: "main", current: true },
  { name: "feat/open-wt", current: false },
  { name: "feat/free", current: false },
];
const remote = [
  { name: "origin/main", remote: "origin", branch: "main" },
  { name: "origin/feat/open-wt", remote: "origin", branch: "feat/open-wt" },
  { name: "origin/feat/remote-only", remote: "origin", branch: "feat/remote-only" },
  { name: "upstream/feat/fork", remote: "upstream", branch: "feat/fork" },
];
const worktrees = [
  { path: "/repo", branch: "main", main: true },
  { path: "/wt/open", branch: "feat/open-wt", main: false },
];

const opts = worktreeBranchOptions({ local, remote, worktrees });

// ---- Existing branch list marks worktree-occupied local (and matching remote) branches as disabled
{
  const byId = new Map(opts.existing.map((x) => [x.id, x]));
  assert.equal(byId.get("local:main").disabled, true);
  assert.equal(byId.get("local:main").badge, "in worktree");
  assert.equal(byId.get("local:feat/open-wt").disabled, true);
  assert.equal(byId.get("local:feat/free").disabled, false);
  assert.equal(byId.get("local:feat/free").badge, "local");

  assert.equal(byId.get("remote:origin/main").disabled, true);
  assert.equal(byId.get("remote:origin/main").badge, "local in worktree");
  assert.equal(byId.get("remote:origin/feat/open-wt").disabled, true);

  assert.equal(byId.get("remote:origin/feat/remote-only").disabled, false);
  assert.equal(byId.get("remote:origin/feat/remote-only").badge, "remote");
  assert.match(byId.get("remote:origin/feat/remote-only").note, /tracking origin\/feat\/remote-only/);
}

// ---- Bases list includes HEAD, all local branches, and all remote branches (even ones in worktrees)
{
  const baseRefs = opts.bases.map((b) => b.ref);
  assert.deepEqual(baseRefs, [
    "HEAD",
    "main",
    "feat/open-wt",
    "feat/free",
    "origin/main",
    "origin/feat/open-wt",
    "origin/feat/remote-only",
    "upstream/feat/fork",
  ]);
  assert.equal(opts.bases[0].label, "HEAD (main)");
}

// ---- Existing mode requests
{
  const byId = new Map(opts.existing.map((x) => [x.id, x]));

  assert.equal(worktreeRequest({ mode: "existing", pickedExisting: null }).ok, false);
  assert.equal(worktreeRequest({ mode: "existing", pickedExisting: byId.get("local:main") }).ok, false);

  // Local branch
  const locReq = worktreeRequest({ mode: "existing", pickedExisting: byId.get("local:feat/free"), folder: "  ", open: true });
  assert.deepEqual(locReq, { ok: true, values: { name: "feat/free", base: undefined, path: "", open: true } });

  // Origin remote branch (not local): PowerMods Core tracks origin/<branch> when base is undefined
  const orgReq = worktreeRequest({ mode: "existing", pickedExisting: byId.get("remote:origin/feat/remote-only"), open: false });
  assert.deepEqual(orgReq, { ok: true, values: { name: "feat/remote-only", base: undefined, path: "", open: false } });

  // Non-origin remote branch (not local): passes full remote ref as base
  const upReq = worktreeRequest({ mode: "existing", pickedExisting: byId.get("remote:upstream/feat/fork"), folder: "/tmp/wt" });
  assert.deepEqual(upReq, { ok: true, values: { name: "feat/fork", base: "upstream/feat/fork", path: "/tmp/wt", open: true } });
}

// ---- New branch mode requests and validation
{
  assert.equal(worktreeRequest({ mode: "new", branchName: "  ", localNames: opts.localNames }).ok, false);
  assert.equal(worktreeRequest({ mode: "new", branchName: "-bad", localNames: opts.localNames }).ok, false);
  assert.equal(worktreeRequest({ mode: "new", branchName: "has space", localNames: opts.localNames }).ok, false);
  assert.match(worktreeRequest({ mode: "new", branchName: "feat/free", localNames: opts.localNames }).error, /already exists locally/);

  const okNew = worktreeRequest({
    mode: "new",
    branchName: "feat/from-remote",
    baseRef: "origin/feat/remote-only",
    folder: "",
    open: true,
    localNames: opts.localNames,
  });
  assert.deepEqual(okNew, {
    ok: true,
    values: { name: "feat/from-remote", base: "origin/feat/remote-only", path: "", open: true },
  });
}

console.log("worktree-pick ok");
