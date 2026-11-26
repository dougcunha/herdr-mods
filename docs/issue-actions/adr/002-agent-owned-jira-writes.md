# ADR 002: Agent-Owned Jira Writes

Status: Accepted  
Date: 2026-11-26

## Context

Two architectural options exist for how an Issue Action updates Jira fields:

1. **Agent-owned writes:** The mod launches the agent with the issue context and skill prompt; the agent/skill reads the codebase and writes directly to Jira using its configured MCP server or CLI tools (the same workflow the user already uses manually). Afterward, the mod refreshes the issue from Jira.
2. **Mod-owned writes:** The agent runs read-only, returns structured output (e.g., JSON or Markdown), and `issues-app` writes the fields to Jira via Jira REST API v3 (`/rest/api/3/issue/{key}`).

In `issues-app/mods/issues/jira.js`, `textToAdf()` currently converts plain text paragraphs and `@mentions` only—it does not convert full Markdown (headings, lists, code blocks, tables, bold/links) into Atlassian Document Format (ADF), nor does `jira.js` currently support arbitrary custom field types (multi-select options, cascading selects, checkboxes, user pickers, or multi-field atomic payloads).

## Decision

Keep **Jira writes owned by the agent/skill** (Option 1) in V1.

- `issues-app` is responsible for:
  1. Checking applicability (`editmeta`, `targetFields`, `skill` guard).
  2. Launching the agent with full issue context (`key`, `title`, `url`, `site`, `project`, `description`, `{fields}`, etc.).
  3. Detecting `NEEDS_INPUT` / process errors and verifying post-run whether `targetFields` were populated.
  4. Emitting `shared("issues.changed")` so all views reload the updated issue from Jira.
- The user's existing skills (e.g., `/jira-refinement`, `/jira-release-notes`) continue using their Jira MCP/CLI integrations unchanged.

## Alternatives Considered

1. **Mod-owned writes (agent returns JSON/text, mod calls Jira REST API)**
   - *Pros:* Agents could run completely read-only against Jira; easier to preview diffs before saving; removes MCP dependency from the agent session.
   - *Cons:* Requires rewriting all existing Jira skills to stop using MCP and adhere to a mod-specific output schema; requires implementing full Markdown-to-ADF conversion and schema-driven custom field serialization (selects, arrays, rich text, checkboxes) inside `jira.js`; breaks skills that perform multi-step Jira actions (updating multiple fields, adding comments, linking issues).
2. **Hybrid `writeMode: "agent" | "mod"` in V1**
   - *Pros:* Maximum flexibility.
   - *Cons:* Doubles the implementation and testing surface (structured output parsing + Markdown→ADF + custom field encoders) before validating the core runner and UX.

## Consequences

- **Positive:**
  - Zero changes required to the user's existing Jira skills.
  - Supports arbitrary Jira field types, rich ADF formatting, and multi-field updates out of the box.
  - Keeps `issues-app` free of complex Markdown→ADF serialization and custom-field write schemas.
- **Negative / Trade-offs:**
  - Requires the active agent environment to have Jira MCP/CLI access configured and, for background runs, explicit `allowAutoApprove` opt-in so MCP write calls do not hang waiting for interactive approval.
  - Can be extended cleanly in a future V2 by adding an optional `writeMode: "mod"` without breaking existing `"agent"` actions.
