# Plan: Modern Modal Workspace for `git-client`

Status: design agreed on 2026-11-26 (3 interview rounds via `/grill-with-docs`).

## Overview & Goals

Upgrade `git-client` when opened in a wide container or modal dialog (`width >= 820px`) into a modern, full-featured desktop Git client workspace, while preserving the compact 5-tab layout for narrow side panels (`< 820px`).

Goals:
1. **Desktop two-pane workspace**: Left accordion sidebar (`Changes`, `Branches`, `Stash`, `Submodules`, `Tags`, `Remotes`, `Worktrees`) paired with a persistent commit graph on the top-right and a 2-column Bottom Inspector on the bottom-right.
2. **Immediate visibility of pending work**: Surface uncommitted changes, unpushed/behind/gone/local-only branches, and dirty/out-of-sync/ahead/behind submodules at a glance — even when sections are collapsed.
3. **Zero-lag modal refresh model**: Disable `watchFolder`, the 15-second polling timer, and background `warm()` preloading in modal mode. Refresh only on initial load, targeted post-action updates, or manual `Refresh` (`F5`) / `Fetch & Refresh` (`Shift+F5`).
4. **Two-level safe submodule management**: Manage submodule status and branches directly from the parent sidebar (with safe local-preserving branch switching and optional `.gitmodules` tracking) or drill into a submodule via a clickable breadcrumb (`Parent › lib`).

---

## Architecture

### Component Tree

```text
Client (main.js → client.js)
├── Narrow (< 820px): tabBar + branchBar + active tab (Changes | History | Branches | Stash | Submodules)
└── Wide / Modal (>= 820px):
    ├── wideBar (clickable repo/submodule breadcrumb, machine chip, branch + ↑/↓/gone, Fetch/Pull/Push/Refresh/Close)
    └── h_resizable ("gc-wide-split", sidebarWidth persisted in shared "git-client.sidebarWidth")
        ├── Sidebar (sidebar.js)
        │   ├── Filter input (branches, tags, remotes, stashes, submodules, worktrees)
        │   ├── Pinned "Changes" row (conflicts / staged / unstaged / Clean badge)
        │   └── Accordion sections:
        │       ├── Local branches (selection bar, ↑/↓/gone/local/merged pills, hover Pull/FF/Push)
        │       ├── Remote branches (grouped by remote)
        │       ├── Stash (list + New stash)
        │       ├── Submodules (status dot, current branch/detached, changed/sync/↑/↓, inline Pull / Switch branch / Menu)
        │       ├── Tags (collapsed by default)
        │       ├── Remotes (collapsed by default)
        │       └── Worktrees (collapsed by default; lazy-loaded on expand)
        └── v_resizable ("gc-insp-split-<gen>", right workspace)
            ├── Top: History graph (history.js → renderGraph)
            │   └── Search bar + All/Current + Remotes + Branch filter / out-of-range notice + Virtual graph list
            └── Bottom Inspector (visible when inspector != null; separate saved heights for Changes vs Commit/Stash)
                ├── "changes" → Changes.renderWide (opBanner + h_resizable [file lists + commit box | DiffView/ImageDiffView])
                ├── "commit"  → History.detailsPaneWide (h_resizable [metadata + file list | DiffView])
                └── "stash"   → Stash.renderWide (h_resizable [header + Apply/Pop/Drop + file list | DiffView])
```

### Data Flow & Two-Phase Snapshot

1. **Phase 1 (Immediate local read — no network)**:
   - `History` runs `rev-parse --show-toplevel`, `log`, `HEAD`, `symbolic-ref`, `for-each-ref` (local branch names), `remote`, and `status --porcelain=v1 -z --branch`.
   - `Branches` runs `for-each-ref` (`refs/heads`, `refs/remotes`, `refs/tags` — already includes `ahead`/`behind`/`gone`), `remote -v`, and batch `for-each-ref --merged` against `HEAD` + default branch (`origin/main`, `origin/master`, `main`, or `master`). Worktrees are skipped unless the Worktrees section is expanded.
   - `Stash` runs `stash list`.
   - `Submodules` runs `submodule status --recursive` and `config -f .gitmodules`.
2. **Phase 2 (Async parallel enrichment)**:
   - For up to 20 initialized submodules (bounded concurrency of 6), `Submodules` runs one `git status --porcelain=v1 -z --no-renames --untracked-files=normal --branch` per submodule to populate changed-file counts, current branch/detached state, upstream, and `ahead`/`behind`/`gone`.
3. **Targeted Post-Action Refresh (`classifyRefresh`)**:
   - `perform()` emits `{ at, type, root, on }` to `shared("git-client.changed")`.
   - `status` (`stage`, `unstage`, `discard`, `ignore*`, `untrack*`, `*Hunk`) → reloads only `git status` + `Changes` numstat/diff.
   - `stash` (`stash`, `stashApply`, `stashPop`, `stashDrop`) → reloads `status` + `Changes` + `Stash` list.
   - `submodules` (`submodule*`) → reloads `status` + `Changes` + `Submodules`.
   - `full` (`commit`, `checkout*`, `pull`, `push`, `fetch*`, `merge`, `rebase`, branch/tag/remote/worktree ops) → reloads history, branches, stash, and submodules.

---

## Architecture Decision Records (ADRs)

### ADR-001: Responsive 820px Wide Activation & 90×90 Git Modal
- **Decision**: Activate the two-pane desktop layout whenever `git-client` renders at `width >= 820px` (both in modal dialogs and wide tabs), while keeping the narrow 5-tab layout below `820px`. Update `tabs-dock` and `kanban` so opening the Git modal uses `width: 0.9, height: 0.9` (leaving other panel dialogs at `0.82 × 0.85`) and passes `modal: true` in `props`.
- **Consequences**: Side-panel users on narrow panes retain the compact workflow without horizontal cramping; modal users get maximum screen real estate and deterministic modal detection.

### ADR-002: Persistent Top Graph with 2-Column Bottom Inspector
- **Decision**: Keep the History graph permanently visible in the top-right pane and show `Changes`, `Commit Details`, or `Stash` in a resizable bottom-right inspector. Render every inspector mode in two horizontal columns (left list/metadata/commit box, right diff view). Persist separate inspector heights in `shared()` (`git-client.changesHeight` defaulting to ~52% and `git-client.detailsHeight` defaulting to ~42%). On initial load of a repository with uncommitted changes, auto-open `Changes` in the inspector.
- **Consequences**: Users never lose graph context while staging, committing, inspecting commits, or reviewing stashes, and never need a separate back-navigation step inside Commit Details.

### ADR-003: Modal Manual Refresh, 2-Phase Snapshot, and Targeted Post-Action Refresh
- **Decision**: When `modal: true` (or inside a dialog overlay), disable `watchFolder`, the 15s polling interval, and `warm()` preloading. After the initial 2-phase load, refresh only via `Refresh` (`F5`), `Fetch & Refresh` (`Shift+F5`), or targeted post-action updates from `perform()`. Replace the O(N) per-branch `for-each-ref --contains` loop (up to 100 processes) with batch `for-each-ref --merged` (1–2 processes), and defer `worktree list` + per-worktree `status` until the Worktrees section is expanded.
- **Consequences**: Eliminates background CPU/disk churn and UI freezes in modals, cuts branch load latency dramatically in large repos, and preserves live watching in the side panel where external terminal edits are expected side-by-side.

### ADR-004: Two-Level Submodule Management & Safe Real-Branch Switching
- **Decision**:
  1. In the parent sidebar, display each submodule's live branch/detached state, dirty file count, sync state, and `↑`/`↓` counts, with inline quick actions (**Pull / update**, **Switch branch…**, and context menu).
  2. A single click on a submodule row enters that submodule inside the modal with a clickable breadcrumb (`Parent › lib`). Returning to the parent detects and focuses the modified submodule pointer in `Changes`.
  3. Switching branches in a submodule uses a dedicated picker (`SubmoduleBranchDialog`) that loads local and cached remote branches immediately (with an on-demand **Fetch** button). If the target branch exists locally, check it out safely with `git switch` and fast-forward merge (`git merge --ff-only`) — **never** `git switch -C` — so unpushed local commits are never overwritten. If the branch exists only on the remote, create a real local tracking branch (`git switch -c <branch> --track <remote>/<branch>`). Provide an optional checkbox (unchecked by default) to also run `git submodule set-branch` in `.gitmodules`.
- **Consequences**: Developers can work normally on real branches inside submodules without detached-HEAD pitfalls or silent commit loss, while keeping `.gitmodules` edits intentional.

### ADR-005: Single-Press Modal `Esc` & Explicit Sidebar Multi-Select
- **Decision**: Pressing `Esc` in modal mode first clears active transient state (focused input text, graph search/branch filter, File History/Blame view, or multi-selection); when in the clean workspace state (even with the Bottom Inspector open), a single `Esc` closes the modal directly (the Bottom Inspector keeps its own `×` button). In the sidebar, a normal click on a branch scrolls and highlights its commit in the graph (offering "Load more" / "Filter to branch" if beyond the loaded page), double-click checks it out, and multi-selection for bulk delete uses checkboxes / `Ctrl+click` / `Shift+click`.
- **Consequences**: Fast keyboard dismissal of the modal while preventing accidental loss of typed commit messages or search filters, and clear separation between branch inspection and bulk deletion.

---

## Glossary

| Term | Meaning |
| --- | --- |
| **Wide/Modal Workspace** | The two-pane layout (`width >= 820px`) combining the left accordion sidebar, top-right History graph, and bottom-right inspector. |
| **Bottom Inspector** | The resizable panel below the History graph that renders `Changes`, `Commit Details`, or `Stash` in two horizontal columns. |
| **Two-Phase Snapshot** | Initial data load split into (1) immediate local parent-repo reads and (2) parallel async `git status --branch` enrichment per initialized submodule. |
| **Targeted Post-Action Refresh** | Reloading only the Git data slice affected by an internal action (`status`, `stash`, `submodules`, or `full`) via `classifyRefresh()`. |
| **Safe Submodule Branch Switch** | Checking out an existing local branch + `--ff-only` merge (preserving local commits) or creating a local tracking branch for a remote-only branch, instead of `switch --detach` or `switch -C`. |
| **Submodule Pointer** | The gitlink commit SHA recorded in the parent repository's index/tree for a submodule path. |
| **Breadcrumb Context Stack** | The navigation stack (`Client.subs`) tracking nested submodule entry from the parent repository so users can jump back up and inspect the changed submodule pointer. |
