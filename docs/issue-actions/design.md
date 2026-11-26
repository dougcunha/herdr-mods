# Issue Actions — Design Document

Status: Accepted  
Date: 2026-11-26  
Scope: `issues-app` (`mods/issues`) and `powermods-core-app` (`mods/powermods-core`)

---

## 1. Overview

**Issue Actions** adds generic, user- and repository-configured agent actions directly to the `issues` mod. While **Start agent** creates a new git branch and worktree for implementing or investigating code, **Issue Actions** runs focused agent prompts or skills directly against an issue in the active workspace without creating a worktree (for example, running `/jira-refinement` to populate a `Refinement` field and `/jira-release-notes` to populate release notes fields for newly created tasks).

The feature is strictly opt-in and environment-aware:

- Environments without any configured actions see zero UI changes.
- Environments missing a referenced skill or target Jira fields hide the inapplicable actions automatically instead of failing or cluttering the UI.
- Repositories can commit `.herdr/issue-actions.json` for team workflows, gated by explicit exact-content trust approval, while personal actions and local overrides remain independent of git.

### Goals

1. Run single or sequential issue-scoped agent skills in one click from the issue page, list context menu (`RowMenu`), or `JiraChecklist`.
2. Default to **background (headless)** execution with progress feedback, toast notifications, and automatic issue refresh, while supporting **interactive** execution (opening an agent tab in the space) per action or as a one-click fallback.
3. Detect when a skill in background mode needs human input (`NEEDS_INPUT` contract, missing `targetFields` after exit 0, or process error/timeout) and surface direct recovery actions (**Run interactively**, **Switch to interactive**, log viewer).
4. Keep Jira writes inside the agent/skill (via MCP/CLI) so existing multi-field and rich-ADF skills work without modification.
5. Persist background run tracking via `powermods-core` (with an `issues` fallback) so sequential steps, notifications, and refreshes complete even when the issue page or Dock dialog is closed.

### Non-Goals

- Replacing **Start agent** or creating git worktrees/branches for issue actions.
- Parsing agent output to write arbitrary Jira custom field schemas from `issues-app` in V1 (see [ADR 002](adr/002-agent-owned-jira-writes.md)).
- Supporting background (`hc run --bg`) execution on remote machines (`space.machine != null`) in V1.
- Auto-triggering actions on Jira polling without explicit user click.

---

## 2. Architecture & Component Boundaries

```
+-----------------------------------------------------------------------------+
| issues-app (mods/issues)                                                    |
|                                                                             |
|  - Personal store: ~/.config/herdr-app/data/issues-app/actions.json         |
|  - Repo store:     <mainCheckout>/.herdr/issue-actions.json + trust         |
|  - Guards:         tracker, site, project, issueType, status, editmeta,     |
|                    local skill presence                                     |
|  - UI entrypoints: detail() Actions menu & banner, RowMenu "Actions...",    |
|                    list row spinner pill, JiraChecklist shortcut,           |
|                    "Issue actions..." management dialog                     |
|  - Jira REST:      editmeta, field reads, post-run verification,            |
|                    emitting shared("issues.changed")                        |
|  - Fallback poller: monitors shared("issues.actionRuns") while mounted      |
+--------------------------------------+--------------------------------------+
                                       |
               shared("issues.actionRuns") / shared("issues.changed")
                                       |
+--------------------------------------v--------------------------------------+
| powermods-core-app (mods/powermods-core)                                    |
|                                                                             |
|  - Persistent background run tracker (runs in status bar while app is open) |
|  - Polls hc terminal status for active background steps (`hc get <addr>`)   |
|  - Parses output.txt for `NEEDS_INPUT:` / tail errors on completion         |
|  - Launches next step in a sequence (when no Jira re-check blocks) or       |
|    hands off field verification / next-step trigger state to issues-app     |
|  - Fires notify() toasts and cleans up finished core terminals (`hc rm`)    |
+-----------------------------------------------------------------------------+
```

### Responsibility Split (Jira Credentials Boundary)

Jira credentials are stored in the OS credential store and accessed exclusively by `issues-app` (`jira-client.js` / `jira.js`). `powermods-core` does **not** hold Jira credentials or call Jira REST APIs directly:

- **When `powermods-core` is running:** It owns process monitoring (`hc get --json`), timeout enforcement, `output.txt` inspection (`NEEDS_INPUT:` detection), terminal cleanup (`hc rm`), toast notifications, and advancing pure-prompt steps or flagging `awaiting_verification` on `shared("issues.actionRuns")` when `targetFields` verification or between-step Jira reload is required. While any `issues` copy is alive (panel, Dock dialog, or background mount), `issues` performs the Jira REST reload and kicks off the next sequential step; if `issues` is closed during a multi-step sequence requiring Jira field reloads, the run either executes the pre-built prompt or pauses in `pending_reload` until `issues` mounts (or completes single-step verification on next open).
- **When `powermods-core` is not running:** `issues-app` runs the same state-machine poller on a timer while mounted, so the feature still works cleanly in layouts without `powermods-core` (for example, Herdr's default `main` layout).

---

## 3. Data Model & Storage

### 3.1 Personal Configuration

Stored at `~/.config/herdr-app/data/issues-app/actions.json`. Changes increment a revision counter in `shared("issues.actionsRev")` so all open copies of `issues` (side panel, Dock dialog, page dialog) reload immediately.

```json
{
  "version": 1,
  "defaults": {
    "agent": {
      "key": "agy",
      "model": null,
      "effort": null,
      "extraArgs": "",
      "timeoutSec": 300,
      "allowAutoApprove": false
    }
  },
  "actions": [
    {
      "id": "jira-refinement",
      "name": "Fill Refinement",
      "description": "Analyze the issue and codebase to populate the Refinement field.",
      "enabled": true,
      "mode": "background",
      "skill": "jira-refinement",
      "prompt": "Run /jira-refinement for {tracker} issue {key} ({url}).\n\nSummary: {title}\nType: {type} · Status: {status}\n\nDescription:\n\"\"\"\n{description}\n\"\"\"",
      "guards": {
        "tracker": "jira",
        "sites": [],
        "projects": ["PROJ"],
        "issueTypes": [],
        "statuses": [],
        "targetFields": ["Refinement"],
        "requireAllFields": false,
        "hideWhenFilled": false
      },
      "agent": null,
      "includeInRunAll": true
    },
    {
      "id": "jira-release-notes",
      "name": "Fill Release Notes",
      "description": "Generate and save Release Notes and Category fields on the issue.",
      "enabled": true,
      "mode": "background",
      "skill": "jira-release-notes",
      "prompt": "Run /jira-release-notes for {tracker} issue {key} ({url}).\n\nSummary: {title}\nRefinement:\n\"\"\"\n{refinement}\n\"\"\"",
      "guards": {
        "tracker": "jira",
        "sites": [],
        "projects": ["PROJ"],
        "issueTypes": [],
        "statuses": [],
        "targetFields": ["Release Notes", "Release Notes Category"],
        "requireAllFields": true,
        "hideWhenFilled": false
      },
      "agent": null,
      "includeInRunAll": true
    }
  ],
  "sequences": [
    {
      "id": "new-task-prep",
      "name": "Prepare New Task (Refinement + Release Notes)",
      "description": "Runs Refinement first, reloads the issue, then runs Release Notes.",
      "enabled": true,
      "steps": ["jira-refinement", "jira-release-notes"]
    }
  ],
  "overrides": {
    "repo-action-id": {
      "enabled": true,
      "mode": "interactive"
    }
  }
}
```

### 3.2 Repository Configuration & Trust

Optional file at `<mainCheckout>/.herdr/issue-actions.json`:

```json
{
  "version": 1,
  "actions": [ ... ],
  "sequences": [ ... ]
}
```

- **Exact-content trust:** Stored in `shared("trusted-issue-actions")`, keyed by `mainCheckout` path: `{ [main]: { text } }`, matching `shared("trusted-prompts")` in `prompts.js`.
- Any edit to `.herdr/issue-actions.json` invalidates trust until the user reviews and approves the file again.
- The trust review prompt explicitly highlights any action configured with `allowAutoApprove: true` or custom `extraArgs` so repositories cannot silently run auto-approved headless prompts.

### 3.3 Precedence & Merging

1. Approved repository actions/sequences and personal actions/sequences **coexist** in the UI, labeled with a `repo` or `personal` badge.
2. If a personal action/sequence has the **same `id`** as a repository action/sequence, the personal definition wins.
3. `overrides[id]` in personal `actions.json` applies partial local overrides (`enabled`, `mode`, `agent`, `includeInRunAll`) on top of a repository action without modifying git-tracked files.

### 3.4 Run State & Disk Artifacts

- **Shared state (`shared("issues.actionRuns")`):** Map keyed by issue context key (`${site}|${repo ?? ""}|${key}`), retaining active runs and the latest completed run per issue (bounded to recent entries):
  ```json
  {
    "PROJ-123": {
      "runId": "act_1764180000_ab12",
      "issueKey": "PROJ-123",
      "site": "example.atlassian.net",
      "repoMain": "D:/MyProjects/example-repo",
      "cwd": "D:/MyProjects/example-repo",
      "kind": "sequence",
      "label": "Prepare New Task",
      "steps": [
        { "actionId": "jira-refinement", "name": "Fill Refinement", "mode": "background", "targetFields": ["Refinement"] },
        { "actionId": "jira-release-notes", "name": "Fill Release Notes", "mode": "background", "targetFields": ["Release Notes", "Release Notes Category"] }
      ],
      "stepIndex": 0,
      "mode": "background",
      "address": "t42",
      "status": "running",
      "reason": "",
      "missingFields": [],
      "outputPath": "C:/Users/.../.config/herdr-app/data/issues-app/runs/act_.../step-0-output.txt",
      "startedAt": 1764180000000,
      "endedAt": null
    }
  }
  ```
- **Disk artifacts:** Stored under `~/.config/herdr-app/data/issues-app/runs/<runId>/`:
  - `step-<n>-prompt.md`
  - `step-<n>-output.txt`
  - `step-<n>.ps1` or `step-<n>.sh` (wrapper script, same pattern as `automations-app/mods/automations/shell.js`).

---

## 4. Environment Guards & Field Semantics

Before rendering an action on an issue, the mod evaluates its guards in order. If any guard fails, the action is hidden for that issue.

| Guard | Evaluation Rule |
|---|---|
| `enabled` | Must be `true` (after applying `overrides[id]`). |
| `guards.tracker` | `"any"` \| `"jira"` \| `"github"`. |
| `guards.sites` | If non-empty, issue `site` must match (case-insensitive). |
| `guards.projects` | If non-empty, Jira project key (prefix of `key`, e.g. `PROJ`) or GitHub `owner/repo` must match. |
| `guards.issueTypes` | If non-empty, `fields.issuetype.name` must match (case-insensitive). |
| `guards.statuses` | If non-empty, `fields.status.name` must match (case-insensitive). |
| `skill` | If non-empty, the named skill must exist in local skill directories (Section 4.2). |
| `guards.targetFields` | Evaluated against Jira `editmeta(site, key)` (Section 4.1). |

### 4.1 Multi-Field `targetFields` & Filled Semantics

`targetFields` accepts an array of Jira field names or custom field IDs (e.g., `["Release Notes", "Release Notes Category"]`).

1. **Resolution:** Resolved against `editmeta(site, key)` (editable fields for that exact issue type and project/status) and `fieldList(site)`.
2. **Presence check:**
   - If `requireAllFields` is `false` (default): visible if **at least one** declared target field exists in `editmeta`.
   - If `requireAllFields` is `true`: visible only if **all** declared target fields exist in `editmeta`.
   - If `targetFields` is empty: no field guard is applied.
3. **Filled check (`✓`):**
   - Inspects all resolved target fields present on the issue via `issueFields(site, key, ids)` and `fieldText()`.
   - An action is **filled** only when **every** present target field has a non-empty value.
   - When filled:
     - If `hideWhenFilled: true`, the action is omitted from the menu and `Run all`.
     - Otherwise (default), the action stays in the menu with a `✓` badge (allowing manual re-run if requirements changed) and is **skipped** by `Run all`.
4. **Sequence evaluation:** A sequence is visible if at least one of its steps is visible and enabled; it skips steps whose `guards` hide them or that are already filled when invoked via `Run all`.

### 4.2 Local Skill Discovery

When `action.skill` is set (e.g., `"jira-refinement"`), `issues-app` scans standard skill locations on the local machine (once per session, cached in memory with a manual refresh button in `Issue actions…`):

- Repo-local (when a repo is linked): `<main>/.agents/skills`, `<main>/.claude/skills`, `<main>/.gemini/skills`, `<main>/.codex/skills`
- User-global: `~/.agents/skills`, `~/.claude/skills`, `~/.gemini/skills`, `~/.gemini/antigravity/skills`, `~/.gemini/antigravity-cli/builtin/skills`, `~/.gemini/config/plugins/*/skills`, `~/.gemini/config/plugins/*/antigravity/skills`, `~/.codex/skills`

A skill matches if a subfolder `<dir>/<skill>/SKILL.md` exists or a `SKILL.md` YAML frontmatter declares `name: <skill>`.

---

## 5. Execution Engine & `NEEDS_INPUT` Protocol

### 5.1 Working Directory & Remote Spaces

- **`cwd`:** Uses the live folder of the active space (`panes()` / `spaceFolders(space)` from `links.js`), falling back to `repo.main`. Never creates a git worktree or branch.
- **Remote spaces (`space.machine != null`):**
  - `background` mode is **local-only in V1** (disabled with an explanatory hint, consistent with `attachments.js`).
  - `interactive` mode opens a new tab in the target space via `run("tab.new", ...)` normally.

### 5.2 Background vs. Interactive Execution

- **Background mode (`hc run --bg`):**
  - Builds the CLI invocation for the configured agent (`defaults.agent` + per-action `agent` override):
    - `agy`: `agy -p <prompt> [--model <m>] [--effort <e>] [--print-timeout <t>]` + (`--mode auto` or `--dangerously-skip-permissions` when `allowAutoApprove` is true)
    - `claude`: `claude -p <prompt> [--dangerously-skip-permissions]`
    - `codex`: `codex exec --skip-git-repo-check <prompt>`
    - `gemini`: `gemini -p <prompt>`
    - `opencode`: `opencode run <prompt>`
    - `copilot`: `copilot -p <prompt>`
  - Writes `prompt.md` and a wrapper `.ps1`/`.sh` script to the run directory, piping output to `step-<n>-output.txt`, and launches via `hc run --bg --json --no-parent --label issue-action=<runId> --cwd <cwd> -- <shell> <script>`.
- **Interactive mode:**
  - Opens a new tab in the active space (never a worktree) using `agentStart(argv, prompt)` from `core.js` (so `agy` receives `-i <prompt>`, while `claude`/`codex` receive `task`).

### 5.3 Three-Signal `NEEDS_INPUT` & Error Detection

In background mode, a skill may require human decisions or missing information (e.g., asking which release note category applies when ambiguous). Three signals catch this reliably:

1. **Prompt Contract (Soft Protocol):** Background prompts wrap the user template with a concise system instruction:
   - Never guess or invent missing required user input.
   - If human input or confirmation is needed and cannot proceed safely, make no partial guesses and output a final line starting with `NEEDS_INPUT: <short reason>`, then exit.
2. **Post-Run Jira Verification:** When a step declares `targetFields` and exits with code `0` without `NEEDS_INPUT:`, `issues-app` re-fetches those fields from Jira.
   - If any target field present on the issue is still empty, the step transitions to `needs_input` (or `warning` if partial) with `missingFields` populated, rather than silently reporting success.
3. **Process Exit / Timeout:** Non-zero exit code or exceeding `timeoutSec` marks the run `failed` or `timed_out` with the last lines of `step-<n>-output.txt`.

### 5.4 Recovery UX

When a background run finishes with `needs_input`, `failed`, or `timed_out`:

- A toast notifies the user with the issue key, step name, and reason.
- The issue page banner (and `Actions` popup) shows:
  - Status badge + reason + missing field names (if any).
  - **View log** (opens an inline/overlay viewer of `step-<n>-output.txt`).
  - **Run interactively** (one-off launch of the failed/current step in an interactive tab in the current space).
  - **Switch to interactive** (updates the action's `mode` to `"interactive"` in `actions.json`, or creates a local override for a repo action).

### 5.5 Sequential Execution, `Run all`, and Concurrency

- **Serial steps:** A sequence (or `Run all` batch) runs one step at a time. Between steps:
  1. `issues-app` reloads the issue's fields from Jira (`issueFields` / `fetchPage`) and emits `shared("issues.changed")` so `{fields}` and `{refinement}` placeholders reflect step $N$'s writes before step $N+1$ expands its prompt.
  2. If step $N$ ends in `needs_input`, `failed`, or `timed_out`, the sequence **halts immediately**, preserving all Jira changes already saved by earlier steps.
- **Per-issue lock & cross-issue parallelism:** Different issues can run background actions concurrently; starting a second run on an issue that already has a `running` action is blocked until the current run completes or is canceled.

---

## 6. UI Entry Points

1. **Issue Page Header (`detail()` in `main.js`):**
   - Renders an **Actions** dropdown/popup button next to `Move` / `Open in Jira` **only when at least one action/sequence passes all guards for the issue**.
   - While a run is active on the open issue, the button shows a spinner and current step progress (e.g., `Actions · 1/2`).
   - Inside the popup:
     - Top item: **Run all (`N` pending)** when 2+ individual actions are applicable and unfilled.
     - Sequences section (when configured and applicable).
     - Individual actions list with `✓` for filled actions, mode badge (`bg` / `interactive`), and `personal` / `repo` tag.
   - Below the header (or above tabs), an inline **Action Run Banner** appears when a run is `running`, `needs_input`, `failed`, or `timed_out` (with dismiss, **View log**, **Run interactively**, and **Switch to interactive**).
2. **Issue List (`main.js` & `row-menu.js`):**
   - **Row indicator:** Issues with an active `running` action display a compact spinner/pill in the row.
   - **Right-click `RowMenu`:** Shows a single **Actions…** item when at least one enabled action matches the tracker/project. Clicking it opens the **Actions** popup for that row, loading `editmeta` and `targetFields` on demand (identical pattern to `TransitionMenu` and `FieldMenu`).
3. **`JiraChecklist` (`jira-checklist.js`):**
   - For empty checklist rows (such as `Refinement`), if an applicable Issue Action declares that field in `targetFields`, renders an inline action button (e.g., `Run <Action Name>`) beside `Edit` / `Jira ↗`.
4. **Management Dialog (`Issue actions…`):**
   - Opened from the Issues panel cog menu, from **PowerMods → Settings → Issues → Edit…** (via `issues.actions` command, matching `issues.components`), or from the trust prompt banner when `.herdr/issue-actions.json` is unapproved.
   - Manages default agent/model/effort/auto-approve, personal actions, sequences, local overrides for repo actions, local skill scan refresh, and repo trust approval.

---

## 7. Prompt Placeholders

Action prompt templates reuse `fill()` and `clean()` from `prompts.js`, supporting all issue placeholders (`{key}`, `{title}`, `{url}`, `{type}`, `{status}`, `{priority}`, `{labels}`, `{description}`, `{fields}`, `{tracker}`, plus all configured `{extraFields}` like `{refinement}`) and two action-specific placeholders:

- `{site}` — Jira site host (e.g., `example.atlassian.net`) or `github.com`.
- `{project}` — Jira project key (e.g., `PROJ`) or GitHub `owner/repo`.

(`{branch}` resolves to the current space branch when available, or `"none"`.)

---

## 8. Phased Implementation Plan

1. **Core & Storage Foundation (`issues`):** `actions-store.js` (personal JSON, `.herdr/issue-actions.json` + trust, overrides, skill scanner, guard evaluator) and `kit.json` settings entry (`issues.actions`).
2. **Execution & Tracking (`issues` + `powermods-core`):** Headless command builder, run directory writer, `NEEDS_INPUT` prompt contract & log parser, persistent `shared("issues.actionRuns")` tracker in `powermods-core` with `issues` fallback, sequential step orchestration + Jira post-run verification.
3. **UI Integration (`issues`):** `Actions` popup (header + `RowMenu` on-demand loader), issue page run/recovery banner + log viewer, list row active spinner pill, `JiraChecklist` inline shortcut, and `Issue actions…` management dialog.
4. **Docs & Release Housekeeping:** Update `issues-app/README.md`, `issues-app/RECIPE.md`, `powermods-core-app/README.md`, `SETUP-PROMPT.md` version, and `whats-new/<N>.md`.

---

## References

- [Domain Glossary](glossary.md)
- [ADR 001: Issue Actions as a First-Class Entity](adr/001-issue-actions-as-first-class-entity.md)
- [ADR 002: Agent-Owned Jira Writes](adr/002-agent-owned-jira-writes.md)
- [ADR 003: Background-First Execution with NEEDS_INPUT Contract](adr/003-background-first-execution-with-needs-input-contract.md)
- [ADR 004: Hybrid Config, Trust, and Environment Guards](adr/004-hybrid-config-trust-and-environment-guards.md)
- [ADR 005: Persistent Run Tracking via PowerMods Core](adr/005-persistent-run-tracking-via-powermods-core.md)
