// Pure helpers for the New Worktree dialog: local/remote branch options,
// base commit/branch options, and validation/request building.

export function worktreeBranchOptions({ local = [], remote = [], worktrees = [] } = {}) {
  const used = new Set((worktrees ?? []).map((w) => w.branch).filter(Boolean));
  const localNames = new Set((local ?? []).map((b) => b.name));
  const current = (local ?? []).find((b) => b.current)?.name ?? null;

  const existing = [
    ...(local ?? []).map((b) => {
      const disabled = used.has(b.name);
      return {
        kind: "local",
        id: `local:${b.name}`,
        name: b.name,
        branch: b.name,
        remote: null,
        localExists: true,
        disabled,
        badge: disabled ? "in worktree" : "local",
        note: disabled
          ? "Already checked out in a worktree."
          : `Checks out existing local branch ${b.name}.`,
      };
    }),
    ...(remote ?? []).map((b) => {
      const hasLocal = localNames.has(b.branch);
      const disabled = hasLocal && used.has(b.branch);
      return {
        kind: "remote",
        id: `remote:${b.name}`,
        name: b.name,
        branch: b.branch,
        remote: b.remote,
        localExists: hasLocal,
        disabled,
        badge: disabled ? "local in worktree" : "remote",
        note: disabled
          ? `Local branch ${b.branch} is already open in a worktree. Switch to New branch and start from ${b.name}.`
          : hasLocal
            ? `Local branch ${b.branch} already exists and will be checked out.`
            : `Creates local branch ${b.branch} tracking ${b.name}.`,
      };
    }),
  ];

  const bases = [
    {
      kind: "head",
      id: "head:HEAD",
      ref: "HEAD",
      label: current ? `HEAD (${current})` : "HEAD",
      badge: "HEAD",
    },
    ...(local ?? []).map((b) => ({
      kind: "local",
      id: `local:${b.name}`,
      ref: b.name,
      label: b.name,
      badge: b.current ? "current" : "local",
    })),
    ...(remote ?? []).map((b) => ({
      kind: "remote",
      id: `remote:${b.name}`,
      ref: b.name,
      label: b.name,
      badge: "remote",
    })),
  ];

  return { existing, bases, localNames };
}

export function worktreeRequest({
  mode = "new",
  branchName = "",
  baseRef = "HEAD",
  pickedExisting = null,
  folder = "",
  open = true,
  localNames = null,
} = {}) {
  const path = String(folder ?? "").trim();
  const select = open !== false;

  if (mode === "existing") {
    if (!pickedExisting) return { ok: false, error: "Pick a local or remote branch." };
    if (pickedExisting.disabled) {
      return { ok: false, error: pickedExisting.note || "That branch is already checked out in a worktree." };
    }
    const name = pickedExisting.branch;
    const base =
      pickedExisting.kind === "remote" && !pickedExisting.localExists && pickedExisting.remote !== "origin"
        ? pickedExisting.name
        : undefined;
    return { ok: true, values: { name, base, path, open: select } };
  }

  const name = String(branchName ?? "").trim();
  if (!name) return { ok: false, error: "Branch name is empty." };
  if (name.startsWith("-") || /\s/.test(name)) {
    return { ok: false, error: 'Branch name can\'t start with "-" or contain spaces.' };
  }
  if (localNames?.has(name)) {
    return {
      ok: false,
      error: `Branch ${name} already exists locally. Switch to Existing branch to check it out, or pick another name.`,
    };
  }
  const base = String(baseRef ?? "HEAD").trim() || "HEAD";
  return { ok: true, values: { name, base, path, open: select } };
}
