# 0003: One engine for the mod and for the terminal tool of a Catalog

Status: accepted (2026-11-15). It extends [0002](0002-links-to-the-clone.md).

## Context

A team must use its skills in one way. The mod is the main tool, but a person without Herdr needs a fallback. A Catalog repository can ship a terminal tool of its own (a wizard). Two tools with two sets of rules give two results for one project.

## Decision

- `link-skills.mjs` is the engine of both. Its source is this repository. A Catalog repository keeps a copy and checks in its CI that the copy is the same file.
- The engine has every rule and every change: the state of a project (`read`), the links (`apply`), the clones of other repositories (`source`, `list`) and the curation of the Catalog (`details`, `curate`). A tool only asks and shows.
- The agent folders are fixed: `.agents/skills`, `.claude/skills`, `.windsurf/skills`. No tool asks for agents. Codex, Cursor, GitHub Copilot and OpenCode read `.agents/skills`, so `.codex/skills` is retired: the next change in a project removes the links of the tool there.
- Project scope only. No tool links into the home folder of a person.
- The Manifest has `bundles:`, `skills:` (skills of the Catalog out of the Bundles) and `sources:` (other repositories). The engine also reads a Catalog skill in `sources:` of an older file.
- The curation changes `bundles.yaml` line by line and commits nothing. It runs only in a person's own clone.

## Consequences

- A change of a rule is one change, in this repository, then a new copy in each Catalog.
- The engine stays one file without dependencies: a Catalog tool can add a parser or a prompt library around it, but not inside it.
- A tool that installs copies (`npx skills`, a state file of its own) must go from a Catalog that uses this model: it undoes the links.
