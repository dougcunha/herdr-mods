# Issue Actions — Domain Glossary

Status: Accepted  
Date: 2026-11-26

This glossary defines the canonical domain terms used across the **Issue Actions** design, ADRs, configuration schemas, and code.

---

### Issue Action
A reusable, user- or repository-defined prompt template (typically invoking a local skill such as `/jira-refinement` or `/jira-release-notes`) that runs an AI coding agent on a single issue in the active space's working directory without creating a git worktree or branch.

### Action Context
The runtime environment passed when expanding and launching an Issue Action: the issue's metadata (`key`, `title`, `url`, `site`, `project`, `type`, `status`, `description`, `fields`, extra fields), the active Herdr `space`, and its local working directory (`cwd`).

### Action Source
Where an Issue Action or Sequence originates:
- **`personal`**: Defined by the user in `~/.config/herdr-app/data/issues-app/actions.json`.
- **`repo`**: Defined in `<mainCheckout>/.herdr/issue-actions.json` and explicitly approved via a **Trust Record**.

### Local Override
A per-`id` entry in the user's personal `actions.json` (`overrides[id]`) that alters specific properties (such as `enabled`, `mode`, or `agent`) of a `repo`-sourced Issue Action locally without modifying the git-tracked `.herdr/issue-actions.json` file.

### Composite Action (Sequence)
An ordered list of Issue Action `id`s executed serially on an issue (`Step 1 -> Jira reload -> Step 2 -> ...`). A sequence halts on the first failed or `needs_input` step while preserving any Jira updates already saved by completed steps.

### Run All
A synthetic batch action surfaced at the top of the `Actions` menu when two or more applicable individual actions exist for an issue and are currently **pending** (not yet filled). It executes those pending actions serially in configured order, automatically skipping already-filled actions (`✓`).

### Target Field
A Jira field (identified by display name or custom field ID, such as `Refinement`, `Release Notes`, or `Release Notes Category`) declared in an action's `guards.targetFields` list as the field(s) that the action is expected to populate.

### Environment Guard
A declarative predicate on an Issue Action (`tracker`, `sites`, `projects`, `issueTypes`, `statuses`, `targetFields`, `requireAllFields`, `hideWhenFilled`) evaluated against the current issue and its Jira `editmeta` to determine whether the action should be shown, hidden, or marked as filled (`✓`).

### Skill Guard
An optional `skill` identifier on an Issue Action that checks whether a matching skill (`<skill>/SKILL.md` or frontmatter `name: <skill>`) exists in standard local skill directories before exposing the action in the UI.

### Trust Record
An exact-content approval stored in `shared("trusted-issue-actions")`, keyed by repository main checkout path, authorizing the execution of `<mainCheckout>/.herdr/issue-actions.json`. Any modification to the file invalidates the trust record and requires re-approval.

### Execution Mode
How an Issue Action invokes its agent:
- **`background`** (default): Runs non-interactively via `hc run --bg` with stdout/stderr logged to a run file (`step-<n>-output.txt`), progress indicators in the UI, and automatic issue refresh on completion.
- **`interactive`**: Opens a new terminal tab in the active space running the agent interactively with the expanded prompt (via `agentStart()`).

### Auto-Approve Opt-In
An explicit boolean setting (`allowAutoApprove`, default `false`) authorizing headless background executions to pass tool-approval bypass flags (e.g., `agy --mode auto` / `--dangerously-skip-permissions`, `claude --dangerously-skip-permissions`) so MCP/CLI tools can write to Jira without hanging on an interactive confirmation prompt.

### Needs-Input Contract
A lightweight prompt instruction appended to background Issue Action runs directing the agent never to guess missing human input and instead terminate with a `NEEDS_INPUT: <reason>` line.

### Post-Run Field Verification
A validation step executed by `issues-app` after a background action exits with code `0`: if `targetFields` are declared, `issues-app` re-fetches those fields from Jira and flags `needs_input` if any editable target field present on the issue remained empty.

### Action Run
A tracked execution instance (single action or sequence) stored in `shared("issues.actionRuns")`, holding `runId`, `issueKey`, `steps`, `stepIndex`, `mode`, `address`, `status` (`running | ok | needs_input | failed | timed_out`), `reason`, `missingFields`, `outputPath`, and timestamps. At most one Action Run may be `running` per issue at a time.

### Persistent Runner
The background polling loop hosted in `powermods-core-app` (with an in-mod fallback in `issues-app` when `powermods-core` is absent) that monitors `hc` terminal completion, inspects `output.txt`, emits completion toasts, and drives run state transitions even after the issue page or Dock dialog closes.

### Issue Change Signal
The existing `shared("issues.changed")` notification (`{ site, key, at }`) emitted when Jira issue state is modified, triggering all mounted `issues` views (list, side panel, page dialog) to invalidate cached pages and reload fresh data from Jira.
