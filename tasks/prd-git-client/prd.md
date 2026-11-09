# PRD: git-client ("Git")

Status: approved (interview of 2026-11-09). Phase 1 in progress.

## Goal

One Git panel for the daily work with Git. It replaces 2 mods:

- `changes-split` (`changes-app`): the Changes panel with a Unified / Split diff.
- `git-graph` (third party, `rabeeh-ta/herdr-git-graph`, MIT): the commit graph and its actions.

The `git-dash` (Pending) and `prs` (PRs) mods stay separate.

## Identity

- App folder `git-client-app`, mod `git-client`, title "Git".
- Base: a copy of upstream `herdr-git-graph` v0.3.2 (commit `2f4fe0f`), plus the diff code of `changes-split`.
- The mod folder keeps the MIT `LICENSE` of upstream with its copyright line, and `icons/LICENSE-lucide.txt`.
- `kit.json` has `credit`: "Based on Git Graph for Herdr by rabeeh-ta (MIT license)".
- The layout block id stays `changes`: `tabs-dock` and `kanban` find the panel by that id.
- UI text in English only.
- The mod works on repositories of remote Herdr machines (`exec … { on }`). A remote repository has no folder watch: the mod reads it again on a timer.

## Replaced mods

- The `kanban` and `main-dock` layouts show `git-client` in the `changes` block.
- `ORIGINALS` of `tabs-dock` and `kanban`: `"git-client": "changes"` (Herdr's own Changes panel while the mod is off).
- The Graph button leaves `panels.json` (README, RECIPE, SETUP-PROMPT).
- `changes-app` leaves the repository. `git-graph` leaves the setup prompt and `THIRD_PARTY` of `mods-hub`.
- The installed copies of `changes-split` and `git-graph` are removed from the machine only after the person says yes.
- First values: when a `git-client.*` key is not set, the mod reads `changes-split.view` (Unified / Split) and `git-graph.columns` once.

## Tabs

A tab bar at the top. A tab shows an icon and its name. When the panel is narrower than 420 px, a tab shows only its icon, with a tooltip and a count (changed files, stashes).

| Tab | Content | Phase |
| --- | --- | --- |
| Changes | Staged, Unstaged and Conflicts lists, the diff, the commit box | 1 |
| History | The graph of git-graph, with all its actions and a search field | 1 |
| Branches | Sections Local, Remote, Tags, Remotes, Worktrees | 2 |
| Stash | The stash list, the diff of a stash, apply, pop, drop | 2 |
| Submodules | The submodules and their state | 3 |

The tab is UI state of one copy (not a preference). The commands `git-client.<tab>` select it.

The header under the tabs shows the branch, ahead / behind, and the buttons Fetch, Pull, Push and Refresh. All tabs use one read of the repository (one watcher, one timer).

## Changes tab

- Lists: **Conflicts** (unmerged files, only when there are some), **Staged**, **Unstaged** (with untracked files).
- A file row: status letter, path, `+` / `−` counts, and buttons Stage / Unstage / Discard (on hover). A right-click menu: Stage, Unstage, Discard, Open file, Copy path. Phase 3 adds File history and Blame.
- "Stage all" and "Unstage all" on the section titles. Stage all never stages unmerged files.
- A click on a file shows its diff under the lists: the diff of the index for a staged file, the diff of the work tree for an unstaged file.
- The diff has the Unified / Split switch (shared `git-client.view`) and an **Expand** button that opens the same diff in a wide dialog.
- Hunks: each `@@` row of the diff takes a click. A popup menu shows Stage hunk / Unstage hunk / Discard hunk. A virtual list row cannot hold its own buttons, so the hunk actions use `on_item_click` / `on_item_secondary_click` with the row key.
- Hunk patches come from the raw `git diff` output of one file (its header plus one hunk), never from the shown rows (they cut long lines and long diffs). `git apply --cached` stages, `--cached -R` unstages, `-R` discards.
  - Local repository: the patch goes to a file under `<appHome>/data/git-client/`, then `git apply <file>`, then the file is deleted.
  - Remote repository: `sh -c 'printf "%s" "$1" | git apply … -' sh <patch>`.
  - Checked in a spike: LF, CRLF with `core.autocrlf` input / true / false, no final newline, non-ASCII path.
- Untracked files stage as a whole file (no hunks).
- Discard asks first (a confirm dialog). Discard of an untracked file deletes it (`git clean -f -- <path>`).
- Commit box:
  - A multi-line message field.
  - Options: **Amend** (loads the last message when the field is empty), **Commit all** (stages all tracked and untracked changes first; not with conflicts), **Push after commit**.
  - A **Generate** button (AI message, see below).
  - The commit button says what it commits: "Commit 3 files", "Amend", "Commit all".
- Conflicts section: the unmerged files, and the buttons **Resolve with agent**, **Continue** and **Abort** for the operation in progress (merge, rebase, cherry-pick, revert). Phase 1 shows the files, Continue and Abort. Phase 3 adds Resolve with agent.

## History tab

- The graph, the labels, the commit details, the diffs and every action of git-graph. Double-click on a label checks out.
- The Manygit list (many repositories in a folder) and the self-update of git-graph are removed.
- The uncommitted row opens the Changes tab.
- Search field: plain text searches the message (`--grep`, `-i`) and a hash prefix; `author:<text>` uses `--author`; `path:<path>` uses `-- <path>`. Git does the search, so it covers all of the history. While a filter is on, the list shows no lanes (a filtered log has parents that are not in the list).

## Fetch, pull and push

- Phase 1: Fetch (`fetch --all`), Pull (`pull --ff-only`), Push (the current branch; `--set-upstream` to the default remote when it has no upstream).
- Phase 2: setting `git-client.pull` (`config` (default) / `rebase` / `merge`), `fetch --prune` (setting, default on), **Force push** (`--force-with-lease`, with a confirm dialog), and set upstream on the first push without a question.

## AI commit message

- Settings of its own: `git-client.ai.provider` (`auto` / `claude` / `codex`), `git-client.ai.model` (default `haiku` for Claude Code, `gpt-6-luna` for Codex, as tab-namer), `git-client.ai.format` (`repo` (default) / `conventional` / `free`), `git-client.ai.instructions` (extra text).
- `repo`: the prompt has the subjects of the last 20 commits, and the model copies their style.
- The input is the staged diff (all changes with Commit all): `git diff --cached --stat` plus the diff, cut to 6,000 characters (one argv; a `.cmd` shim on Windows takes 8,191 characters in all).
- The program runs on the machine of the repository (`exec … { on }`), with `claude -p --model … --no-session-persistence --tools ""` or `codex exec -m … --skip-git-repo-check --ephemeral -s read-only`.
- The answer goes into the message field. The person can edit it before the commit.

## Branches tab (phase 2)

- Local: checkout, new branch, rename, delete, merge into current, rebase current on it, push, set upstream.
- Remote: checkout (tracking branch), merge, delete on the remote.
- Tags: new, delete, push.
- Remotes: add, rename, remove, set URL.
- Worktrees: list (folder, branch, changes), create (new or existing branch, folder `<repo>-<branch>` next to the repository), open in a space (`space.new` with the folder, or go to the space that already shows it), remove (asks; `--force` only when the person ticks it), prune, lock, unlock.

## Stash tab (phase 2)

The stashes with their message and age. A click shows the files and the diff. Apply, Pop, Drop (asks), and a new stash (message, include untracked).

## Phase 3

- **Resolve with agent:** a dialog like `issues/agent-dialog.js`: pick the agent (`knownAgents({ on })`), edit the prompt (operation, branches, files in conflict), start it in a new tab of the same space and folder (`tab.new` with `argv` and `task`).
- **File history and blame:** a sub-view with Back, opened from the menu of a file: the log of the file (`log --follow`), a commit opens its diff for that file; blame (`blame --porcelain`) with the commit, author and date of each line.
- **Submodules tab** (always shown): each submodule with its commit and state (ok, modified, out of sync, not initialized). Update / init (one or all, `--recursive`), Open in the client (the client shows the submodule, with Back to the parent), Sync, checkout of the recorded commit or of the remote branch, Add (URL and folder), Remove.

## Commands

`git-client.changes`, `.history`, `.branches`, `.stash`, `.submodules`, `.commit`, `.fetch`, `.pull`, `.push`, `.refresh`, `.split`, `.unified`, `.toggle`. No default keys.

## Settings (`kit.json`)

Phase 1: Diff view (Unified / Split), AI provider, AI model, AI message format, AI extra instructions. Phase 2: Pull mode, Fetch prune.

## Out of scope

Interactive rebase. Line staging. Conflict resolution inside the mod.

## Delivery

Each phase is one kit version (`SETUP-PROMPT.md` N+1 and `whats-new/<N>.md`).

1. Phase 1: the fork, the tabs, Changes (hunks, commit options, AI), History (search), Fetch / Pull / Push, the layout change and the removal of the old mods.
2. Phase 2: Branches (with Remotes and Worktrees), Stash, the push / pull options.
3. Phase 3: conflicts with an agent, file history and blame, Submodules.
