# ADR 003: Background-First Execution with `NEEDS_INPUT` Contract

Status: Accepted  
Date: 2026-11-26

## Context

The primary motivation for Issue Actions is eliminating manual context switching when a task is created: the user wants to trigger refinement and release-notes skills directly from `issues` without opening a separate interactive session every time.

However, skills can legitimately hit cases where human input or confirmation is required (ambiguous acceptance criteria, missing environment details, or an interactive skill prompt). If run headless without safeguards, the agent might either hang waiting for stdin, silently guess wrong values, or exit `0` without filling the target Jira fields.

## Decision

Support a **configurable hybrid execution model** per action, **defaulting to `background`**, paired with a **three-signal `NEEDS_INPUT` detection protocol** and **one-click interactive recovery**.

1. **Configurable Mode (`"background" | "interactive"`, default `"background"`):**
   - `background` runs via `hc run --bg` with stdout/stderr captured to `~/.config/herdr-app/data/issues-app/runs/<runId>/step-<n>-output.txt`.
   - `interactive` opens a new tab in the current space via `agentStart(argv, prompt)` (passing `-i <prompt>` for `agy`, or `task` for other agents), never creating a worktree.
   - A dedicated default agent configuration (`defaults.agent` in `actions.json`) is used for Issue Actions, with optional per-action overrides (`agent.key`, `model`, `effort`, `extraArgs`, `timeoutSec`, `allowAutoApprove`).

2. **Three-Signal `NEEDS_INPUT` & Failure Detection (for `background` runs):**
   - **Signal 1 — Prompt Contract:** Background runs prepend/append a short instruction telling the agent not to guess missing human input and instead output `NEEDS_INPUT: <reason>` and exit.
   - **Signal 2 — Post-Run Jira Field Verification:** If an action declares `guards.targetFields` and exits `0` without `NEEDS_INPUT:`, `issues-app` reloads those fields from Jira; if any editable target field on the issue remained empty, the run is flagged as `needs_input` with the missing field names.
   - **Signal 3 — Exit Code / Timeout:** Non-zero exit code or exceeding `timeoutSec` marks the run `failed` or `timed_out`.

3. **Recovery UX:**
   - Failed or `needs_input` runs show a toast, a status banner on the issue page, a **View log** action, **Run interactively** (one-off interactive retry of that step), and **Switch to interactive** (persists `mode: "interactive"` personally or as a local override).

## Alternatives Considered

1. **Always interactive (new tab in current space)**
   - *Pros:* Never hits headless permission or input stalls.
   - *Cons:* Interrupts workflow and spawns tabs for every routine issue enrichment even when no human interaction is needed.
2. **Always background without `NEEDS_INPUT` contract or field verification**
   - *Pros:* Simpler prompt wrapper.
   - *Cons:* Agent may fabricate missing details or exit `0` silently without updating Jira, leaving the user unaware until checking Jira manually.

## Consequences

- **Positive:**
  - Hands-off background execution is the zero-friction default when skills have enough context.
  - Interactive skills or under-specified issues fail fast and loudly with one-click interactive recovery.
  - Dedicated `defaults.agent` prevents Issue Actions from interfering with the user's preferred coding agent in **Start agent**.
- **Negative / Trade-offs:**
  - Background mode requires agent-specific headless flags (maintained in a small adapter table matching `automations-app/mods/automations/shell.js`) and explicit `allowAutoApprove` opt-in for MCP write tools.
