# Git Dash for the Herdr app

A Herdr app mod that shows the pending work of every Git repository under one or more base folders. It is a port of a `git-pendencias.py` report into a panel.

The panel lists only the repositories that need attention, the most urgent first. Each card shows the branch and colored counts: unpushed commits, staged, modified and new files, stash entries, conflicts, a merge or rebase in progress, and merged branches that were not deleted. A click on a card shows its changed files and its fixes. **Refresh** reads all repositories again.

The panel changes a repository only when you click a fix and confirm it. A fix that is not safe has no button: the card tells you what to resolve and opens the repository in a terminal for you.

[`RECIPE.md`](RECIPE.md) describes the mod in full.

## Install

With an agent (Claude Code or any agent that can read files), paste this prompt:

`Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/dougcunha/herdr-mods/tree/main/git-dash-app and add it to the dock: the "main-dock" layout reads ~/.config/herdr-app/dock/panels.json`

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
| Folder button | Shows the list of base folders: 1 row per folder, with its repository count (or `not found`) and a trash button, then **Add folder…**. A second click goes back to the list of repositories. The list is saved and every Git Dash panel uses it. |
| Refresh button | Reads all repositories again. It spins while it works. The panel also refreshes by itself every 5 minutes. |
| Download button | Fetch on refresh. When it is on, `git fetch --all --prune` runs in each repository, so the *behind* count is current. It is off by default. |
| Chips | **Pending**, **Clean**, **Errors** and **All**. |
| Filter box | Filters by repository path or branch. |
| `N folder(s) not found` | Shows in red in the summary line when a base folder cannot be read. A click shows the list of folders. |
| A card | Shows or hides the changed files of that repository (the first 12) and its fixes. |
| **Commit** | Shows a message box and the files to include: **Staged only**, **Tracked files** (`git add -u`) or **All, with new files** (`git add -A`, in red). Enter or **Commit** runs it. |
| **Push** | `git push`, when the branch is ahead of its upstream and not behind. |
| **Pull** | `git pull --ff-only`, when the branch is behind and not ahead. |
| **Publish to origin** | `git push -u origin <branch>`, when the branch has commits and no upstream. |
| **Terminal** | Opens a terminal tab in the repository, in the current space, and runs `git status`. |
| **New space** | Opens the repository in a new space and runs `git status`. |
| **Delete** (merged branch) | Deletes one merged branch: on its remote too when the remote copy exists, then the local branch. |
| **Remove worktree** (merged branch of a linked worktree) | Removes the worktree folder, then deletes the branch: on its remote too when the remote copy exists, then the local branch. |
| **Delete all N** | Deletes all merged branches of the repository that can be deleted now, and removes their worktrees. |

### Merged branches

A local branch is *merged* when its last commit is in the default branch: `origin/HEAD`, else `origin/main`, `origin/master`, `main` or `master`. The card shows `N merged` in blue. The open card lists each merged branch, with `local` or `local + origin`, and a red **Delete** button.

The panel does not show these branches:

- `main`, `master`, `develop`, `development`, `dev`, `trunk`, `staging`, `production` and `release`.
- In the card of a linked worktree: the branch that is checked out in the main worktree.
- A branch whose remote copy has commits that the default branch does not have.
- A branch with no commits of its own: no upstream, and its reflog shows only its creation.

**Delete** shows these commands and waits for **Run**:

```text
git merge-base --is-ancestor refs/heads/feat refs/remotes/origin/main
git push origin --delete feat --force-with-lease=refs/heads/feat:<sha>
git branch -D feat
```

The first command stops the delete when the branch is not merged any more. `--force-with-lease` stops the push when the remote branch moved after the last fetch. The remote copy goes first: when the push fails, the local branch stays, and **Run in terminal** runs the push again. For the branch that is checked out, `git switch main` runs before `git branch -D`. The panel offers this only when the branch has no staged or modified files.

### Merged worktrees

A linked worktree (made with `git worktree add`) has a `.git` file, and the panel shows it as its own card with a `worktree` pill. When the branch of a linked worktree is merged, its row has a `worktree` pill and a red **Remove worktree** button. The row shows in the card of the worktree and in the card of the main worktree. The main worktree is never removed.

**Remove worktree** shows these commands and waits for **Run**. They run in the main worktree:

```text
git merge-base --is-ancestor refs/heads/feat refs/remotes/origin/main
git worktree remove D:/work/repo-feat
git push origin --delete feat --force-with-lease=refs/heads/feat:<sha>
git branch -D feat
```

`git worktree remove` refuses a worktree with staged, modified or new files: then the branch stays here and on the remote. When Git knows the worktree but its folder is gone, `git worktree prune` runs instead. It cleans every worktree of the repository whose folder is gone. After the remove, the card of the worktree goes away and a notification tells the result.

The panel does not offer the remove, and shows the reason, when:

- The worktree has staged, modified or new files: `commit or stash the changes first`.
- The worktree is locked (`git worktree lock`): `the worktree is locked`.
- A terminal of Herdr works inside the worktree folder: `close the terminals in this folder first`. Windows cannot remove a folder that a program uses.

Squash merges and rebase merges change the commits, so the panel does not see these branches as merged. Turn on fetch so that `origin/main` is current.

### Fixes

Push, Pull and Publish show the exact command and wait for **Run**. After a fix, the card shows the result and reads the repository again. When a fix fails, **Run in terminal** runs the same command in a terminal, where Git can ask for a password.

These problems have no fix button. The card lists them under *Resolve by hand*: conflicts, a merge or rebase in progress, a detached HEAD, a branch that is ahead and behind, a removed upstream, no remote, more than 1 remote and no `origin`, a stash, and unpushed commits on other branches. Commit, Push and Pull are not offered while a conflict, an operation or a detached HEAD is present.

Colors: red for conflicts, an operation in progress and unpushed commits; yellow for staged or modified files; cyan for new files; magenta for a stash or merged branches only; green for a clean repository.

### More than 1 base folder

With 2 or more base folders, each card shows the name of its base folder before the path (`Projetos/api`), and the header shows `2 folders`. When 2 base folders have the same name, the name has its parent folder too (`D:/Projetos`, `E:/Projetos`). The sort by urgency is one list for all folders. A repository that is in 2 base folders (one folder inside the other) shows once.

### Commands

Bind a key, or run `herdr-app do git-dash.<command>`:

| Command | What it does |
| ------- | ------------ |
| `git-dash.folders` | Shows the list of base folders. |
| `git-dash.list` | Shows the list of repositories. |
| `git-dash.refresh` | Reads all repositories again. |

## Props

| Prop | Meaning |
| ---- | ------- |
| `root` | The first base folder. It is used only once, when no list of folders is saved yet. After that, the saved list wins, also when it is empty. |
| `depth` | How many folder levels to search. Default `4`. |
| `fetch` | `true` starts with fetch on. A click on the Download button (or the mods-hub setting) wins over it. |
| `lang` | `"en"` (default) or `"pt"`. With the `mods-hub` mod, its **Language** setting (`shared("herdr-mods.lang")`) wins over the prop. |

With the `mods-hub` mod, its **Settings** tab shows the folders and Fetch on refresh of Git Dash too.

## What it runs, and its limits

- It runs `git` in each repository, and `pwsh` (Windows) or `sh` and `find` (other systems) to find the repositories. A mod may read files only inside the Herdr home, so the search is a program. It uses no network, except `git fetch` when you turn fetch on.
- Git reads with `--no-optional-locks`: it does not write to the index. Git 2.35 or newer is needed (`status --show-stash`).
- A fix runs `git` with no input and a 30 second limit. A push that needs a password, or a slow commit hook, fails. Use **Run in terminal** then.
- After **Terminal** or **New space**, the card reads the repository again after 20 seconds, 90 seconds and 5 minutes.
- The search skips `node_modules`, `.venv`, `venv`, `__pycache__`, `bin`, `obj`, `dist`, `build`, `target`, `packages`, `.idea`, `.vs`, `.vscode`, `.gradle`, `.next` and `.cache`. It stops at 400 repositories in each base folder.
- A fetch that needs a password fails after 30 seconds, because the app gives a program no input.
- The panel checks at most 20 merged branches per repository.
- Local folders only. Tested on Windows with Herdr 0.1.12. The `sh` search is untested.
