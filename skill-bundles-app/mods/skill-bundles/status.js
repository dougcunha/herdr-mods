// The counts and the groups of the rows that link-skills.mjs reads. No I/O.
// The words are the ones of CONTEXT.md.
//
// A row: { name, state, repo, from: string[], tracked }
//   state: "linked" | "missing" | "stale" | "copy" | "conflict" | "absent" | "unsupported" | "extra" | "local"

export const STATES = ["linked", "missing", "copy", "stale", "conflict", "absent", "unsupported", "extra", "local"];

/** The states that one click of "Link all" (or of the offer) changes: links to make and links to remove. */
export const toLink = (rows) => (rows ?? []).filter((r) => r.state === "missing" || r.state === "copy").map((r) => r.name);
export const toRemove = (rows) => (rows ?? []).filter((r) => r.state === "stale").map((r) => r.name);

export function countRows(rows) {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const r of rows ?? []) counts[r.state] = (counts[r.state] ?? 0) + 1;
  return counts;
}

/** The number of skills that ask the person to act. The status bar item shows it. */
export const pending = (c) => (c?.missing ?? 0) + (c?.copy ?? 0) + (c?.stale ?? 0) + (c?.conflict ?? 0);

/**
 * The groups of the panel, in order: one for each Bundle of the Manifest (in its order), then
 * Sources (of the Catalog), one for each other repository of the Sources, Extra, Stale,
 * Other repositories (not cloned) and Local. A skill in 2 Bundles shows in the first one.
 */
export function groupRows(rows, manifest, catalogRepo = "") {
  const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
  const groups = [];
  const byKey = new Map();
  const group = (key, kind) => {
    const id = `${kind}:${key}`;
    if (!byKey.has(id)) { const g = { key, kind, rows: [] }; byKey.set(id, g); groups.push(g); }
    return byKey.get(id);
  };
  for (const b of manifest?.bundles ?? []) group(b, "bundle");
  for (const r of rows) {
    if (r.from.length) {
      const first = r.from.find((f) => f !== "sources") ?? "sources";
      // A Source of another repository has a group of its own, with the state of the clone of that repository.
      if (first === "sources" && r.repo && !same(r.repo, catalogRepo)) group(r.repo, "repo").rows.push(r);
      else group(first, first === "sources" ? "sources" : "bundle").rows.push(r);
    } else if (r.state === "local") group("local", "local").rows.push(r);
    else if (r.state === "stale") group("stale", "stale").rows.push(r);
    else if (r.state === "unsupported") group("other", "other").rows.push(r);
    else group("extra", "extra").rows.push(r);
  }
  const order = { bundle: 0, sources: 1, repo: 2, extra: 3, stale: 4, other: 5, local: 6 };
  return groups.filter((g) => g.rows.length).sort((a, b) => order[a.kind] - order[b.kind]);
}
