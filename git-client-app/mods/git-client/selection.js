// Pure multi-file selection helpers for the Changes tab.
// Selection is scoped to one section ("unstaged" | "staged" | "conflict" | null)
// so bulk actions like Stage, Unstage, Discard, and Mark resolved stay unambiguous.

export const emptySelection = () => ({ side: null, paths: new Set(), anchor: null });

export const isPicked = (state, side, path) => Boolean(state?.side === side && state.paths.has(path));

export function clickRow(state, { path, side, list = [], currentSel = null, modifiers = null }) {
  const shift = Boolean(modifiers?.shift);
  const toggle = Boolean(modifiers?.control || modifiers?.platform);
  const ordered = list.map((f) => f.path);

  if (shift) {
    const from = state?.side === side && state.anchor && ordered.includes(state.anchor)
      ? state.anchor
      : currentSel?.side === side && ordered.includes(currentSel.path)
        ? currentSel.path
        : path;
    const a = ordered.indexOf(from), b = ordered.indexOf(path);
    const range = a >= 0 && b >= 0 ? ordered.slice(Math.min(a, b), Math.max(a, b) + 1) : [path];
    const paths = toggle && state?.side === side ? new Set([...state.paths, ...range]) : new Set(range);
    return { state: { side, paths, anchor: from }, open: { path, side }, closed: false };
  }

  if (toggle) {
    const paths = state?.side === side ? new Set(state.paths) : new Set();
    if ((!state || state.paths.size === 0) && currentSel?.side === side && currentSel.path !== path) {
      paths.add(currentSel.path);
    }
    if (paths.has(path)) paths.delete(path);
    else paths.add(path);
    if (paths.size === 0) return { state: emptySelection(), open: currentSel, closed: false };
    return {
      state: { side, paths, anchor: path },
      open: paths.has(path) ? { path, side } : currentSel,
      closed: false,
    };
  }

  if (state?.paths?.size > 0) {
    return { state: emptySelection(), open: { path, side }, closed: false };
  }
  const same = currentSel?.path === path && currentSel?.side === side;
  return { state: emptySelection(), open: same ? null : { path, side }, closed: same };
}

export function clickCheckbox(state, { path, side, list = [], modifiers = null }) {
  if (modifiers?.shift && state?.side === side && state.anchor) {
    const ordered = list.map((f) => f.path);
    const a = ordered.indexOf(state.anchor), b = ordered.indexOf(path);
    const range = a >= 0 && b >= 0 ? ordered.slice(Math.min(a, b), Math.max(a, b) + 1) : [path];
    return { side, paths: new Set([...state.paths, ...range]), anchor: path };
  }
  if (state?.side !== side) {
    return { side, paths: new Set([path]), anchor: path };
  }
  const paths = new Set(state.paths);
  if (paths.has(path)) paths.delete(path);
  else paths.add(path);
  return paths.size === 0 ? emptySelection() : { side, paths, anchor: path };
}

export function selectAll(list, side) {
  if (!list?.length || !side) return emptySelection();
  return { side, paths: new Set(list.map((f) => f.path)), anchor: list[0].path };
}

export function pruneSelection(state, listsBySide) {
  if (!state?.side || !state.paths?.size) return state ?? emptySelection();
  const valid = new Set((listsBySide[state.side] ?? []).map((f) => f.path));
  const paths = new Set([...state.paths].filter((p) => valid.has(p)));
  if (paths.size === 0) return emptySelection();
  const anchor = state.anchor && paths.has(state.anchor) ? state.anchor : [...paths][0];
  return { side: state.side, paths, anchor };
}

export function selectedFiles(state, listsBySide) {
  if (!state?.side || !state.paths?.size) return [];
  return (listsBySide[state.side] ?? []).filter((f) => state.paths.has(f.path));
}

// ---- Branches tab multi-selection (local + remote branches, for bulk deletion)

export const emptyBranchSelection = () => ({ local: new Set(), remote: new Set(), anchor: null });

export const branchPickedCount = (state) => (state?.local?.size ?? 0) + (state?.remote?.size ?? 0);

export const isBranchPicked = (state, kind, name) => Boolean(state?.[kind]?.has(name));

export function toggleBranch(state, { kind, name, list = [], modifiers = null }) {
  const ordered = list.map((b) => b.name);
  if (!ordered.includes(name)) return state ?? emptyBranchSelection();
  const next = {
    local: new Set(state?.local ?? []),
    remote: new Set(state?.remote ?? []),
  };
  if (modifiers?.shift && state?.anchor?.kind === kind && ordered.includes(state.anchor.name)) {
    const a = ordered.indexOf(state.anchor.name), b = ordered.indexOf(name);
    for (const item of ordered.slice(Math.min(a, b), Math.max(a, b) + 1)) next[kind].add(item);
    return { ...next, anchor: { kind, name } };
  }
  if (next[kind].has(name)) next[kind].delete(name);
  else next[kind].add(name);
  if (next.local.size + next.remote.size === 0) return emptyBranchSelection();
  return { ...next, anchor: { kind, name } };
}

export function selectBranches(state, kind, list = []) {
  const next = {
    local: new Set(state?.local ?? []),
    remote: new Set(state?.remote ?? []),
  };
  next[kind] = new Set(list.map((b) => b.name));
  if (next.local.size + next.remote.size === 0) return emptyBranchSelection();
  return { ...next, anchor: list.length ? { kind, name: list[0].name } : state?.anchor ?? null };
}

export function pruneBranchSelection(state, data) {
  if (!branchPickedCount(state)) return emptyBranchSelection();
  const validLocal = new Set((data?.local ?? []).filter((b) => !b.current).map((b) => b.name));
  const validRemote = new Set((data?.remote ?? []).map((b) => b.name));
  const local = new Set([...(state.local ?? [])].filter((n) => validLocal.has(n)));
  const remote = new Set([...(state.remote ?? [])].filter((n) => validRemote.has(n)));
  if (local.size + remote.size === 0) return emptyBranchSelection();
  const anchor = state.anchor && (state.anchor.kind === "local" ? local : remote).has(state.anchor.name) ? state.anchor : null;
  return { local, remote, anchor };
}

export function selectedBranches(state, data) {
  return {
    local: (data?.local ?? []).filter((b) => !b.current && state?.local?.has(b.name)),
    remote: (data?.remote ?? []).filter((b) => state?.remote?.has(b.name)),
  };
}

// ---- History tab 2-commit comparison selection

// Orders two commit hashes chronologically (older -> newer) using the graph list index
// (0 is newest, larger index is older). Falls back to (a, b) if either is outside the index.
export function orderCommits(a, b, indexOf) {
  const ia = indexOf?.(a), ib = indexOf?.(b);
  if (Number.isInteger(ia) && Number.isInteger(ib) && ia >= 0 && ib >= 0 && ia !== ib) {
    return ia > ib ? { base: a, target: b } : { base: b, target: a };
  }
  return { base: a, target: b };
}

export function clickCommit(state, { hash, indexOf, modifiers = null, wide = false }) {
  const cur = state ?? { selected: null, compare: null, anchor: null };
  const mod = Boolean(modifiers?.control || modifiers?.platform || modifiers?.shift);

  if (!mod) {
    if (cur.compare) return { selected: hash, compare: null, anchor: hash };
    if (!wide && cur.selected === hash) return { selected: null, compare: null, anchor: null };
    return { selected: hash, compare: null, anchor: hash };
  }

  if (cur.compare) {
    if (hash === cur.compare.base) return { selected: cur.compare.target, compare: null, anchor: cur.compare.target };
    if (hash === cur.compare.target) return { selected: cur.compare.base, compare: null, anchor: cur.compare.base };
    const anchor = cur.anchor === cur.compare.base || cur.anchor === cur.compare.target ? cur.anchor : cur.compare.base;
    return { selected: null, compare: orderCommits(anchor, hash, indexOf), anchor };
  }

  if (cur.selected) {
    if (hash === cur.selected) return { selected: null, compare: null, anchor: null };
    return { selected: null, compare: orderCommits(cur.selected, hash, indexOf), anchor: cur.selected };
  }

  return { selected: hash, compare: null, anchor: hash };
}

export function swapCompareState(state) {
  if (!state?.compare) return state;
  return { ...state, compare: { base: state.compare.target, target: state.compare.base } };
}

export function stepIndex(current, length, step) {
  if (length <= 0) return -1;
  if (current < 0 || current >= length) return step > 0 ? 0 : length - 1;
  return Math.max(0, Math.min(length - 1, current + step));
}
