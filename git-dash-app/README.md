# Git Dash for the Herdr app

A Herdr app mod that shows the pending work of every Git repository under one base folder. It is a port of a `git-pendencias.py` report into a panel.

The panel lists only the repositories that need attention, the most urgent first. Each card shows the branch and colored counts: unpushed commits, staged, modified and new files, stash entries, conflicts and a merge or rebase in progress. A click on a card shows its changed files and its fixes. **Refresh** reads all repositories again.

The panel changes a repository only when you click a fix and confirm it. A fix that is not safe has no button: the card tells you what to resolve and opens the repository in a terminal for you.

[`RECIPE.md`](RECIPE.md) describes the mod in full.

## Install

With an agent (Claude Code or any agent that can read files), paste this prompt:

`Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/dougcunha/herdr-plugins/tree/main/git-dash-app and add it to the dock: the "main-dock" layout reads ~/.config/herdr-app/dock/panels.json`

Or do it yourself. The Herdr app must be running and `git` must be in your `PATH`.

```powershell
Copy-Item -Recurse git-dash-app\mods\git-dash "$env:USERPROFILE\.config\herdr-app\mods\git-dash"
herdr-app check "$env:USERPROFILE\.config\herdr-app\mods\git-dash"
```

On macOS and Linux use `cp -r git-dash-app/mods/git-dash ~/.config/herdr-app/mods/git-dash`.

The mod has `"place": "none"`: it adds no panel by itself. Pick one way to show it.

### A button in the Dock

With the [`dock-app`](../dock-app/README.md) layout, add one entry to `~/.config/herdr-app/dock/panels.json`:

```json
{ "id": "repos", "label": "Repos", "icon": "mods/git-dash/repos.svg", "mod": "git-dash",
  "props": { "root": "D:/Projetos" } }
```

The **Repos** button shows in the tab bar next to **Changes** and **CI**. A click shows the panel and a second click hides it.

### A tab

```sh
herdr-app do tab.new --name Repos --mod git-dash --props '{"root":"D:/Projetos"}'
```

## Use

| Control | What it does |
| ------- | ------------ |
| Folder button | Opens the folder picker. The folder is saved and used on the next start. |
| Refresh button | Reads all repositories again. It spins while it works. The panel also refreshes by itself every 5 minutes. |
| Download button | Fetch on refresh. When it is on, `git fetch --all --prune` runs in each repository, so the *behind* count is current. It is off by default. |
| Chips | **Pending**, **Clean**, **Errors** and **All**. |
| Filter box | Filters by repository path or branch. |
| A card | Shows or hides the changed files of that repository (the first 12) and its fixes. |
| **Commit** | Shows a message box and the files to include: **Staged only**, **Tracked files** (`git add -u`) or **All, with new files** (`git add -A`, in red). Enter or **Commit** runs it. |
| **Push** | `git push`, when the branch is ahead of its upstream and not behind. |
| **Pull** | `git pull --ff-only`, when the branch is behind and not ahead. |
| **Publish to origin** | `git push -u origin <branch>`, when the branch has commits and no upstream. |
| **Terminal** | Opens a terminal tab in the repository, in the current space, and runs `git status`. |
| **New space** | Opens the repository in a new space and runs `git status`. |

Push, Pull and Publish show the exact command and wait for **Run**. After a fix, the card shows the result and reads the repository again. When a fix fails, **Run in terminal** runs the same command in a terminal, where Git can ask for a password.

These problems have no fix button. The card lists them under *Resolve by hand*: conflicts, a merge or rebase in progress, a detached HEAD, a branch that is ahead and behind, a removed upstream, no remote, more than 1 remote and no `origin`, a stash, and unpushed commits on other branches. Commit, Push and Pull are not offered while a conflict, an operation or a detached HEAD is present.

Colors: red for conflicts, an operation in progress and unpushed commits; yellow for staged or modified files; cyan for new files; magenta for a stash only; green for a clean repository.

## Props

| Prop | Meaning |
| ---- | ------- |
| `root` | The first base folder. A folder that you choose with the picker wins over it. |
| `depth` | How many folder levels to search. Default `4`. |
| `fetch` | `true` starts with fetch on. |
| `lang` | `"en"` (default) or `"pt"`. |

## What it runs, and its limits

- It runs `git` in each repository, and `pwsh` (Windows) or `sh` and `find` (other systems) to find the repositories. A mod may read files only inside the Herdr home, so the search is a program. It uses no network, except `git fetch` when you turn fetch on.
- Git reads with `--no-optional-locks`: it does not write to the index. Git 2.35 or newer is needed (`status --show-stash`).
- A fix runs `git` with no input and a 30 second limit. A push that needs a password, or a slow commit hook, fails. Use **Run in terminal** then.
- After **Terminal** or **New space**, the card reads the repository again after 20 seconds, 90 seconds and 5 minutes.
- The search skips `node_modules`, `.venv`, `venv`, `__pycache__`, `bin`, `obj`, `dist`, `build`, `target`, `packages`, `.idea`, `.vs`, `.vscode`, `.gradle`, `.next` and `.cache`. It stops at 400 repositories.
- A fetch that needs a password fails after 30 seconds, because the app gives a program no input.
- Local folders only. Tested on Windows with Herdr 0.1.12. The `sh` search is untested.
