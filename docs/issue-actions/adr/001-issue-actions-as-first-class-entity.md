# ADR 001: Issue Actions as a First-Class Entity

Status: Accepted  
Date: 2026-11-26

## Context

The `issues` mod currently offers one agent launch path: **Start agent** (`agent-dialog.js`). That flow is designed for code implementation/investigation:

1. It defaults to creating a new git branch and worktree via `powermods-core` (`worktrees().create(...)`), opening a new Herdr space.
2. It provides fixed issue modes (`work`, `plan`, `investigate`) backed by `prompts.js` and `.herdr/prompts.md`.
3. It requires selecting an agent, model, effort, branch, and reviewing a multi-section modal before launching.

The user wants to run issue-scoped agent workflows (e.g., a skill to populate Jira `Refinement` and a skill to populate `Release Notes` fields for newly created tasks) directly from the `issues` mod, with one-click ergonomics, optional background execution, and zero breakage in environments that do not use those skills or Jira fields.

## Decision

Model **Issue Actions** as a dedicated, first-class entity in `issues-app`, separate from **Start agent** modes and `JiraChecklist` items.

- **Separate from `Start agent`:** Issue Actions execute in the active space's working directory (never creating branches or worktrees), default to headless/background execution, support environment/skill guards, and support sequential execution (`sequences` / `Run all`).
- **Integrated with UI surfaces:** Exposed via an `Actions` menu on the issue page header, an `Actions…` entry in `RowMenu`, an active-run indicator on list rows, and optional shortcuts on empty `JiraChecklist` rows (e.g., clicking `Run <Action>` next to an empty `Refinement` row).

## Alternatives Considered

1. **Extend `Start agent` (`MODES.issue` / `.herdr/prompts.md`) with custom modes and a "no worktree" flag**
   - *Pros:* Reuses `AgentDialog` and `PromptsDialog`.
   - *Cons:* Forces users through the full worktree/branch/model dialog for routine one-click Jira tasks; mixes code-editing worktree lifecycles (`agentSpaces` branch regex `^agent/...`) with non-code tracker tasks; lacks per-action `targetFields`, `skill` guards, background/headless lifecycle, and sequential orchestration.
2. **Embed skill triggers exclusively inside `JiraChecklist`**
   - *Pros:* Directly tied to missing pre-flight fields.
   - *Cons:* `JiraChecklist` only exists inside the `Start agent` dialog, making it unusable when the user just created an issue and wants to enrich it before starting work (or run release-notes generation independently).

## Consequences

- **Positive:**
  - Keeps **Start agent** focused and predictable for git worktree workflows.
  - Enables one-click single and sequential execution from both the issue page and the issue list (`RowMenu`).
  - Environments without configured Issue Actions see no extra menus, modes, or dialogs.
- **Negative / Trade-offs:**
  - Introduces a second configuration surface (`Issue actions…`) alongside `Prompts…`, though shared placeholder expansion (`prompts.js` `fill()`, `clean()`, `extraFieldNames()`) and agent discovery (`issues.agents`) are reused.
