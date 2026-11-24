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
