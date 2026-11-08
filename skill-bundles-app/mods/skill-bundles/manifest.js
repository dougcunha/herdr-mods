// The files of a Catalog and of a project: bundles.yaml (the Catalog), skills.yaml (the
// Manifest) and the .gitignore block. This file has no imports and does no I/O.
//
// The parsers read line by line with the same patterns as Read-BundlesCatalog and
// Read-ProjectManifest in Skills.Common.ps1 of the Catalog, so that a file gives the same
// result in the mod and in the scripts (see docs/adr/0001). PowerShell's -match ignores
// case, so every pattern here has the "i" flag.

/** Removes a comment and the quotes around a value, as the scripts do. */
const uncomment = (line) => line.replace(/#.*$/, "");
const unquote = (s) => s.trim().replace(/^["']+|["']+$/g, "");

/** bundles.yaml: { repo, bundles: Map<name, string[]>, descriptions: Map<name, string> }. */
export function parseCatalog(text) {
  let repo = null;
  const bundles = new Map();
  const descriptions = new Map();
  let current = null;
  let inSkills = false;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = uncomment(raw);
    if (!line.trim()) continue;
    let m;
    if ((m = /^repo:\s*(.+?)\s*$/i.exec(line))) { repo = unquote(m[1]); continue; }
    if ((m = /^\s{2}([\w-]+):\s*$/i.exec(line))) {
      current = m[1];
      bundles.set(current, []);
      inSkills = false;
      continue;
    }
    if ((m = /^\s*description:\s*(.+?)\s*$/i.exec(line))) {
      if (current) descriptions.set(current, unquote(m[1]));
      inSkills = false;
      continue;
    }
    if (/^\s*skills:\s*$/i.test(line)) { inSkills = true; continue; }
    if (inSkills && current && (m = /^\s*-\s*(.+?)\s*$/i.exec(line))) bundles.get(current).push(unquote(m[1]));
  }
  return { repo, bundles, descriptions };
}

/** skills.yaml: { bundles: string[], sources: [{ repo, skills: string[] }] }. */
export function parseManifest(text) {
  const bundles = [];
  const sources = [];
  let current = null;
  let section = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = uncomment(raw);
    if (!line.trim()) continue;
    if (/^bundles:\s*$/i.test(line)) { section = "bundles"; continue; }
    if (/^sources:\s*$/i.test(line)) { section = "sources"; continue; }
    let m;
    if (section === "bundles" && (m = /^\s*-\s*(.+?)\s*$/i.exec(line))) { bundles.push(unquote(m[1])); continue; }
    if (section === "sources") {
      if ((m = /^\s*-\s*repo:\s*(.+?)\s*$/i.exec(line))) {
        if (current) sources.push(current);
        current = { repo: unquote(m[1]), skills: [] };
        continue;
      }
      if (/^\s*skills:\s*$/i.test(line)) continue;
      if (current && (m = /^\s*-\s*(.+?)\s*$/i.exec(line))) current.skills.push(unquote(m[1]));
    }
  }
  if (current) sources.push(current);
  return { bundles, sources };
}

/** The bundles in the order that Init-Skills.ps1 writes: core first, then by name. */
export function orderBundles(names) {
  const rest = [...new Set(names.filter((n) => n && n !== "core"))].sort();
  return ["core", ...rest];
}

/** skills.yaml text in the form that Configure-Skills.ps1 and Add-Skill.ps1 write. */
export function formatManifest({ bundles, sources }) {
  const lines = ["bundles:", ...orderBundles(bundles).map((b) => `  - ${b}`)];
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

/**
 * The skills that the Manifest asks for: Map<skill, { repo, from: string[] }>. `from` names the
 * Bundles of the skill and "sources" for a Source. `unknown` lists Bundles that the Catalog does
 * not have (the scripts skip them with a warning).
 */
export function resolveManifest(manifest, catalog) {
  const required = new Map();
  const unknown = [];
  const add = (repo, skill, from) => {
    const r = required.get(skill);
    if (r) { if (!r.from.includes(from)) r.from.push(from); return; }
    required.set(skill, { repo, from: [from] });
  };
  for (const b of manifest.bundles) {
    const skills = catalog.bundles.get(b);
    if (!skills) { unknown.push(b); continue; }
    for (const s of skills) add(catalog.repo, s, b);
  }
  for (const src of manifest.sources) for (const s of src.skills) add(src.repo, s, "sources");
  return { required, unknown };
}

/** Adds skills to the Sources of a Manifest (a copy). */
export function withSource(manifest, repo, skills) {
  const sources = manifest.sources.map((s) => ({ repo: s.repo, skills: [...s.skills] }));
  let entry = sources.find((s) => sameRepo(s.repo, repo));
  if (!entry) { entry = { repo, skills: [] }; sources.push(entry); }
  for (const s of skills) if (!entry.skills.includes(s)) entry.skills.push(s);
  return { bundles: [...manifest.bundles], sources };
}

/** Removes a skill from every Source of a Manifest (a copy). */
export function withoutSource(manifest, skill) {
  return {
    bundles: [...manifest.bundles],
    sources: manifest.sources.map((s) => ({ repo: s.repo, skills: s.skills.filter((x) => x !== skill) })).filter((s) => s.skills.length),
  };
}

// The marker that Set-SkillsGitignore in Skills.Common.ps1 looks for. The block keeps the
// script's exact text (Portuguese), so that the script and the mod see the same block.
const GITIGNORE_MARKER = "# Artefatos gerados por `npx skills add`";
const GITIGNORE_ENTRIES = [".agents/", ".claude/skills/", ".codex/skills/", "skills-lock.json"];

/** The .gitignore text with the block of generated files, or null when it is there already. */
export function withGitignoreBlock(text) {
  const old = String(text ?? "");
  if (old.includes(GITIGNORE_MARKER)) return null;
  const lines = old.split(/\r?\n/).map((l) => l.trim());
  if (GITIGNORE_ENTRIES.every((e) => lines.includes(e))) return null;
  const nl = old.includes("\r\n") ? "\r\n" : "\n";
  const block = [
    "",
    `${GITIGNORE_MARKER} (Install-Skills.ps1) — reproduzíveis a`,
    "# partir de skills.yaml + bundles.yaml, não são fonte de verdade.",
    ...GITIGNORE_ENTRIES,
  ];
  const head = old && !old.endsWith("\n") ? old + nl : old;
  return head + block.join(nl) + nl;
}
