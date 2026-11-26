# ADR 004: Hybrid Configuration, Trust Model, and Environment Guards

Status: Accepted  
Date: 2026-11-26

## Context

`issues-app` is distributed as part of the `herdr-mods` kit and used across different organizations, Jira sites, GitHub repositories, and agent setups. A feature built for a user's refinement and release-notes skills must:

1. Never break or clutter the UI in environments that do not have those skills or Jira custom fields.
2. Support personal workflows (across spaces without modifying git) as well as team-shared workflows inside a repository.
3. Protect users against untrusted repository files triggering auto-approved headless agent runs.

## Decision

Adopt a **hybrid personal + repository configuration** with **exact-content trust**, **local `id`-based overrides**, **multi-field `editmeta` guards**, and **local skill discovery**:

1. **Hybrid Storage & Precedence:**
   - **Personal:** `~/.config/herdr-app/data/issues-app/actions.json`, managed via an `Issue actions…` dialog (accessible from Issues cog and `PowerMods → Settings → Issues → Edit…`) and synchronized across mod instances via `shared("issues.actionsRev")`.
   - **Repository (optional):** `<mainCheckout>/.herdr/issue-actions.json`, authorized by exact-content trust in `shared("trusted-issue-actions")` (mirroring `shared("trusted-prompts")` in `prompts.js`). The approval dialog explicitly highlights any `allowAutoApprove` or custom CLI flags.
   - **Merging:** Personal and approved repo actions coexist with `personal` / `repo` badges. A personal action with the same `id`, or an entry in `overrides[id]` (`enabled`, `mode`, `agent`), overrides the repo definition locally without dirtying git.

2. **Multi-Field `targetFields` & Filled Semantics:**
   - `guards.targetFields` accepts a list of field names or IDs (supporting multi-field actions like Release Notes).
   - Resolved against Jira `editmeta(site, key)`: hidden if missing (`requireAllFields: false` requires at least one present; `true` requires all).
   - Marked **filled (`✓`)** only when **all** present target fields have non-empty values. Filled actions remain visible and clickable for manual re-runs (unless `hideWhenFilled: true`) and are skipped automatically by `Run all`.

3. **Local Skill Guard (`action.skill`):**
   - When `skill` is specified, `issues-app` checks standard local skill directories (`.agents/skills`, `.claude/skills`, `.gemini/skills`, `.gemini/antigravity/skills`, `.gemini/config/plugins/*/skills`, `.codex/skills`, both repo-local and under `~`).
   - If not found, the action is hidden from issue menus and marked `"not installed"` in `Issue actions…`.

## Alternatives Considered

1. **Store all actions inside `shared("issues.actions")` instead of `data/issues-app/actions.json`**
   - *Pros:* No extra file I/O.
   - *Cons:* Bloats global `shared.json` with multi-line prompt templates and run configurations.
2. **Repository-only or personal-only configuration**
   - *Pros:* Single source of truth.
   - *Cons:* Personal-only cannot be shared with a team; repo-only fails for cross-project personal Jira skills or unlinked spaces.
3. **Single target field per action**
   - *Pros:* Simpler schema.
   - *Cons:* Cannot accurately validate or track filled state for multi-field actions like Release Notes (`Release Notes` + `Release Notes Category`).

## Consequences

- **Positive:**
  - Zero configuration means zero UI footprint.
  - Safe to share `.herdr/issue-actions.json` across mixed teams: members without a skill or on projects without those fields never see broken buttons, and nobody runs repo-defined headless prompts without explicit review.
  - Local overrides allow individuals to switch a team action between `background` and `interactive` without touching git.
- **Negative / Trade-offs:**
  - Skill path conventions vary slightly across CLIs; scanning both folder names and `SKILL.md` frontmatter `name:` across known roots mitigates false negatives, and `skill` remains optional so free-form prompts without a skill still work.
