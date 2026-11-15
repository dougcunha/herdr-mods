// The writers of skills.yaml (the Manifest). This file has no imports and does no I/O.
// The readers of bundles.yaml and skills.yaml are in link-skills.mjs: the mod shows what that
// script reads, so there is one copy of the rules (see docs/adr/0002).

/** The bundles in the order of the Manifest: core first, then by name. */
export function orderBundles(names) {
  const rest = [...new Set(names.filter((n) => n && n !== "core"))].sort();
  return ["core", ...rest];
}

/**
 * skills.yaml text. Comments and unknown keys of the old file are lost.
 * `skills:` has the skills of the Catalog that are not in a Bundle of the project; `sources:` has
 * the skills of other repositories.
 */
export function formatManifest({ bundles, skills, sources }) {
  const lines = ["bundles:", ...orderBundles(bundles).map((b) => `  - ${b}`)];
  const own = [...new Set(skills ?? [])].sort();
  if (own.length) lines.push("", "skills:", ...own.map((s) => `  - ${s}`));
  const kept = (sources ?? []).filter((s) => s.repo && s.skills.length);
  if (kept.length) {
    lines.push("", "sources:");
    for (const s of kept) {
      lines.push(`  - repo: ${s.repo}`, "    skills:");
      for (const sk of [...new Set(s.skills)].sort()) lines.push(`      - ${sk}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** A repository name without a "#branch" and in lower case, to compare 2 sources. */
export const sameRepo = (a, b) => String(a ?? "").split("#")[0].toLowerCase() === String(b ?? "").split("#")[0].toLowerCase();

/** Adds skills to the Sources of a Manifest (a copy). */
export function withSource(manifest, repo, skills) {
  const sources = manifest.sources.map((s) => ({ repo: s.repo, skills: [...s.skills] }));
  let entry = sources.find((s) => sameRepo(s.repo, repo));
  if (!entry) { entry = { repo, skills: [] }; sources.push(entry); }
  for (const s of skills) if (!entry.skills.includes(s)) entry.skills.push(s);
  return { bundles: [...manifest.bundles], skills: [...(manifest.skills ?? [])], sources };
}

/** Adds skills of the Catalog to `skills:` of a Manifest (a copy). */
export function withSkills(manifest, names) {
  return { bundles: [...manifest.bundles], skills: [...new Set([...(manifest.skills ?? []), ...names])], sources: manifest.sources.map((s) => ({ repo: s.repo, skills: [...s.skills] })) };
}

/** Removes a skill from `skills:` and from every Source of a Manifest (a copy). */
export function withoutSource(manifest, skill) {
  return {
    bundles: [...manifest.bundles],
    skills: (manifest.skills ?? []).filter((x) => x !== skill),
    sources: manifest.sources.map((s) => ({ repo: s.repo, skills: s.skills.filter((x) => x !== skill) })).filter((s) => s.skills.length),
  };
}
