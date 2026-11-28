// Pure commit-selection helpers for Visual Review.
// Supports toggling between direct 2-commit diff ("compare": from..to)
// and inclusive commit range ("range": from^1..to), plus sidebar highlights.

function chronologicalPair(from, to, commits = []) {
  const iFrom = commits.findIndex((c) => c.hash === from);
  const iTo = commits.findIndex((c) => c.hash === to);
  if (iFrom >= 0 && iTo >= 0) {
    // commits is newest-first (index 0 is newest). Normalize to oldest -> newest.
    const oldest = iFrom < iTo ? to : from;
    const newest = iFrom < iTo ? from : to;
    return { oldest, newest, count: Math.abs(iFrom - iTo) + 1 };
  }
  return { oldest: from, newest: to, count: null };
}

export function toggleCompareRange(selection, commits = []) {
  if (!selection?.from || !selection?.to || selection.from === selection.to) return null;
  if (selection.mode === "compare") {
    const { oldest, newest, count } = chronologicalPair(selection.from, selection.to, commits);
    return {
      mode: "range",
      from: oldest,
      to: newest,
      label: count
        ? `${oldest.slice(0, 7)}..${newest.slice(0, 7)} (${count})`
        : `${oldest.slice(0, 7)}..${newest.slice(0, 7)} (inclusive)`,
    };
  }
  if (selection.mode === "range") {
    return {
      mode: "compare",
      from: selection.from,
      to: selection.to,
      label: `${selection.from.slice(0, 7)} → ${selection.to.slice(0, 7)}`,
    };
  }
  return null;
}

export function compareToggleInfo(selection, commits = []) {
  if (!selection?.from || !selection?.to || selection.from === selection.to) return null;
  if (selection.mode === "compare") {
    const { oldest } = chronologicalPair(selection.from, selection.to, commits);
    const short = oldest.slice(0, 7);
    return {
      kind: "expand",
      label: `+ Include ${short}`,
      tooltip: `Expand to inclusive commit range (includes changes made in ${short})`,
    };
  }
  if (selection.mode === "range") {
    const fromShort = selection.from.slice(0, 7);
    const toShort = selection.to.slice(0, 7);
    return {
      kind: "narrow",
      label: "Diff only",
      tooltip: `Compare ${fromShort} → ${toShort} directly (excludes changes made in ${fromShort})`,
    };
  }
  return null;
}

export function commitHighlights(selection, commits = []) {
  const selected = new Set();
  if (selection?.mode === "single" && selection.head) {
    selected.add(selection.head);
    return { selected, from: null, to: null };
  }
  if (selection?.mode === "compare" && selection.from && selection.to) {
    selected.add(selection.from);
    selected.add(selection.to);
    return { selected, from: selection.from, to: selection.to };
  }
  if (selection?.mode === "range" && selection.from && selection.to) {
    const iTo = commits.findIndex((c) => c.hash === selection.to);
    const iFrom = commits.findIndex((c) => c.hash === selection.from);
    if (iTo >= 0 && iFrom >= 0) {
      const lo = Math.min(iTo, iFrom);
      const hi = Math.max(iTo, iFrom);
      for (let i = lo; i <= hi; i++) selected.add(commits[i].hash);
    } else {
      selected.add(selection.from);
      selected.add(selection.to);
    }
    return { selected, from: null, to: null };
  }
  return { selected, from: null, to: null };
}
