// The state of each skill of a project, from the Manifest, the Catalog and the probe
// (probe.mjs). No I/O. The words are the ones of CONTEXT.md.
//
// A row: { name, state, repo, from: string[] }
//   state: "ok" | "outdated" | "missing" | "unchecked" | "extra" | "local"
// A row of a project without a Manifest also has { plain: true, group: <repository> }.

import { resolveManifest, sameRepo } from "./manifest.js";

/** The states that ask the person to act. The status bar item counts them. */
export const ACTION_STATES = ["outdated", "missing", "extra"];

/** The Lock source types that `npx skills update` skips. */
const NOT_UPDATED = new Set(["node_modules", "local"]);

/** The hash of a Lock entry ("" when it has none). */
export const lockHash = (entry) => String(entry?.computedHash ?? entry?.skillFolderHash ?? "");

/**
 * Builds the rows. `manifest` is null when the project has no skills.yaml.
 * Returns { rows, unknown, counts }.
 */
export function buildRows({ manifest, catalog, probe, check = null }) {
  const lock = probe?.lock ?? {};
  const dirs = new Set(probe?.dirs ?? []);
  const hashes = probe?.hashes ?? {};
  const rows = [];
  const seen = new Set();
  let unknown = [];

  // No Manifest: the rows are the skills of the Lock, grouped by their repository. `check` is
  // the last `npx skills check` of the project: { outdated: { skill: Lock hash at that time },
  // failed: [repository], error }. An Outdated skill whose Lock hash changed was updated since.
  if (!manifest) {
    const failed = new Set((check?.failed ?? []).map((s) => String(s).toLowerCase()));
    for (const [name, entry] of Object.entries(lock)) {
      seen.add(name);
      const repo = entry?.sourceUrl || entry?.source || "";
      const checked = check && !check.error && entry?.sourceType && !NOT_UPDATED.has(entry.sourceType) && !failed.has(repo.toLowerCase());
      let state;
      if (!dirs.has(name)) state = "missing";
      else if (!checked) state = "unchecked";
      else state = check.outdated?.[name] === lockHash(entry) ? "outdated" : "ok";
      rows.push({ name, state, repo, from: [], plain: true, group: entry?.source || repo });
    }
  }

  if (manifest && catalog) {
    const resolved = resolveManifest(manifest, catalog);
    unknown = resolved.unknown;
    for (const [name, { repo, from }] of resolved.required) {
      seen.add(name);
      const entry = lock[name];
      let state;
      if (!entry || !dirs.has(name)) state = "missing";
      else if (!sameRepo(repo, catalog.repo) || !sameRepo(entry.source, catalog.repo)) state = "unchecked";
      else {
        const now = hashes[name];
        const old = entry.computedHash ?? entry.skillFolderHash ?? "";
        state = !now || !old ? "unchecked" : now === old ? "ok" : "outdated";
      }
      rows.push({ name, state, repo, from });
    }
  }

  // Skills that `skills add` installed (a Lock entry with a source type) but the Manifest does not list.
  for (const [name, entry] of Object.entries(lock)) {
    if (seen.has(name) || !entry?.sourceType) continue;
    seen.add(name);
    rows.push({ name, state: "extra", repo: entry.source ?? "", from: [] });
  }
  // Folders with a SKILL.md and no Lock entry: written by hand.
  for (const name of dirs) {
    if (seen.has(name) || lock[name]) continue;
    rows.push({ name, state: "local", repo: "", from: [] });
  }

  const counts = { ok: 0, outdated: 0, missing: 0, unchecked: 0, extra: 0, local: 0 };
  for (const r of rows) counts[r.state]++;
  return { rows, unknown, counts };
}

/** The number of skills that ask the person to act. */
export const pending = (counts) => ACTION_STATES.reduce((n, s) => n + (counts?.[s] ?? 0), 0);

/**
 * The groups of the panel, in order: one for each Bundle of the Manifest (in its order), then
 * Sources, Extra and Local. A skill in 2 Bundles shows in the first one. Without a Manifest:
 * one group for each repository of the Lock, then Local.
 */
export function groupRows(rows, manifest) {
  const groups = [];
  const byKey = new Map();
  const group = (key, kind) => {
    if (!byKey.has(key)) { const g = { key, kind, rows: [] }; byKey.set(key, g); groups.push(g); }
    return byKey.get(key);
  };
  for (const b of manifest?.bundles ?? []) group(b, "bundle");
  for (const r of rows) {
    if (r.state === "extra") group("extra", "extra").rows.push(r);
    else if (r.state === "local") group("local", "local").rows.push(r);
    else if (r.plain) group(r.group, "repo").rows.push(r);
    else {
      const first = r.from.find((f) => f !== "sources") ?? "sources";
      group(first, first === "sources" ? "sources" : "bundle").rows.push(r);
    }
  }
  const order = { bundle: 0, repo: 0, sources: 1, extra: 2, local: 3 };
  return groups.filter((g) => g.rows.length).sort((a, b) => order[a.kind] - order[b.kind]);
}
