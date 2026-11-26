# ADR 005: Persistent Run Tracking via PowerMods Core

Status: Accepted  
Date: 2026-11-26

## Context

In Herdr, the `issues` mod runs inside a Dock panel, a layout block, or an overlay dialog. If a user triggers a background Issue Action (especially a two-step sequence such as Refinement followed by Release Notes) and then closes the Dock panel dialog or switches views:

1. The `hc run --bg` terminal continues running in `herdr-core`,
2. **However**, if only the closed `issues` view held the polling timer in memory, the user would miss the completion/error toast, step 2 of a sequence would never launch, and the issue state would remain stale until reopened.

Meanwhile, `powermods-core` already runs persistently in the status row of `dock-app` and `kanban-app`, and Jira credentials live strictly inside `issues-app` (`jira-client.js`).

## Decision

Store run state in **`shared("issues.actionRuns")`** and run a **persistent tracker in `powermods-core`**, with an **in-mod fallback poller in `issues-app`**:

1. **Persistent Tracker (`powermods-core`):**
   - Polls active `running` entries in `shared("issues.actionRuns")` via `hc get <address> --json`.
   - On terminal exit, cleans up the core terminal (`hc rm <address>`), inspects `step-<n>-output.txt` for `NEEDS_INPUT:` or error tails, updates `shared("issues.actionRuns")`, and fires `notify()` toasts.
   - If the finished step has `targetFields` to verify or belongs to a multi-step sequence requiring Jira reload before the next step, transitions the run to `awaiting_verification` / `pending_next` for `issues-app` to execute the authenticated Jira REST check and launch step $N+1$ (or directly completes single-step actions without `targetFields`).
2. **Fallback Poller (`issues-app`):**
   - While any `issues` copy is mounted, it handles Jira REST verification, sequence step advancement, emitting `shared("issues.changed")`, and—if `powermods-core` is not running in the current layout—performs the `hc get` process polling directly.
3. **Concurrency & Remote Scope:**
   - **Per-issue lock:** Different issues can run background actions in parallel; at most one `running` action is allowed per issue key at a time.
   - **Remote spaces (`space.machine != null`):** V1 restricts `background` mode to local spaces (consistent with `attachments.js`), while `interactive` mode opens a tab in the remote space normally.

## Alternatives Considered

1. **Track background runs strictly inside `issues-app` memory/timers**
   - *Pros:* Zero changes to `powermods-core-app`.
   - *Cons:* Closing the `issues` panel dialog drops completion toasts and stalls multi-step sequences.
2. **Have `powermods-core` call Jira REST APIs directly**
   - *Pros:* Full end-to-end sequence continuation even with zero `issues` copies alive.
   - *Cons:* Duplicates Jira credential-store access and REST client logic outside `issues-app`, violating credential isolation.

## Consequences

- **Positive:**
  - Run status survives panel/dialog close and stays consistent across all `issues` copies (list, page dialog, side panel) via `shared("issues.actionRuns")`.
  - Jira credentials remain strictly isolated inside `issues-app`.
  - Works in layouts without `powermods-core` via the `issues-app` fallback poller.
- **Negative / Trade-offs:**
  - In a multi-step sequence, advancing from step 1 to step 2 (which requires authenticated Jira reload) still relies on a mounted `issues` instance (true whenever the `issues` Dock panel or tab is loaded in the layout); if `issues` was an ephemeral dialog and closed completely, verification/next-step resumes as soon as `issues` opens again.
  - Requires bumping `powermods-core` API/version and running `node tools/sync-core-client.mjs` when implemented.
