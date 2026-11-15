# 0002: Skills are links to the Clone, not copies

Status: accepted (2026-11-15). It replaces the install part of [0001](0001-resolution-rules-in-the-mod.md).

## Context

The mod installed skills with `npx skills add`: each project got a copy of each skill and a `skills-lock.json`, and the mod compared hashes to find outdated copies. A change of one skill meant an update in every project. The person wants one place with version control for the skills, and projects that only point to it.

## Decision

- The Clone of the Catalog is the only place with the skill files. It is the person's own clone (setting), else a clone in the cache of the mod.
- A project gets one Link for each skill in each agent folder (`.agents/skills`, `.claude/skills`, `.codex/skills`): a directory junction on Windows, a symbolic link on macOS and Linux.
- The mod does not use `npx skills`. The Lock and the Outdated and Unchecked states are gone.
- The Manifest (`skills.yaml`) stays committed in the project. A project without a Manifest can have Links: they show as Extra.
- The Links are hidden from Git with one line for each Link in `.git/info/exclude` (found with `git rev-parse --git-path info/exclude`). That block is also the record of the Links that the mod made. The old block of the committed `.gitignore` is removed only with a button.
- The Clone of the Catalog is pulled on the timer when it is clean. A Clone with changes does not stop the mod: the panel only says so.
- A Copy becomes a Link on the first action in the project. A Copy whose folder hash is the Lock hash is deleted. Any other real folder that a Link replaces moves to `.agents/skills-backup/`. A folder that Git tracks is never changed without a click (Conflict).
- A Local skill with the name of a Manifest skill wins (Conflict), until **Replace by link**.
- Missing and Stale Links are offered in one toast and applied with one click. The mod writes nothing in a project on a read or on a timer.
- One Node file, `link-skills.mjs`, has all the rules: it reads `bundles.yaml` and `skills.yaml`, finds the state of each skill and makes the Links. The mod runs it and shows its JSON. A person without Herdr runs `node <clone>/link-skills.mjs` in a project. The parsers of 0001 moved into this file, so there is still one copy of the rules.

## Phases

1. Links for the Catalog on this computer (this version).
2. Skills of other repositories (`sources:`): one clone for each repository in the cache; the mod fetches on the timer and updates with a button.
3. Spaces on other machines: the settings of that machine (`shared.json` there), with the values of this computer as the fallback, and a cache there.

Phase 2 is done (2026-11-15): the clones of other repositories are in `<appHome>/cache/skill-bundles/sources/<owner>/<name>`; the mod only counts the new commits of their remotes, and **Update** on the repository group brings a clone to its remote.

Phase 3 is done (2026-11-15): for a project on another machine, the mod writes `link-skills.mjs` into `~/.config/herdr-app/cache/skill-bundles/` of that machine and runs it there with `node`. The Catalog name and the clone URL come from the `shared.json` of that machine, else from this computer; "Your own clone" comes only from that machine, else the Clone is in the cache there. The Source clones are in the cache there too.

## Consequences

- A change in the Clone (also one that is not committed) shows in every project at once.
- An edit of a skill through a Link edits the Clone. In the cache clone of the mod, the next fetch discards it (`git reset --hard`).
- `git clean -fdx` in a project removes its Links (not the skill files). The mod offers them again.
- The Clone and the project must be on local disks of the same computer.
- A person of the team without Links sees no skills until they run the link script.
