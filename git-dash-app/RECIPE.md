# Git Dash

A Herdr app mod. It is a side panel (or a tab) that shows the pending work of every Git repository under one base folder: unpushed commits, staged, modified and new files, stash, conflicts and operations in progress. It lists the repositories that need attention first.

No preview image ships with this recipe: a real screenshot would show private repository names.

## What you see

A card with a 1 px border, 10 px radius and the theme `background`, filling its block. From top to bottom:

1. **Header**, 40 px high. A `repos.svg` icon in `accent`, the title **Git Dash** in semibold, the base folder name in `dim` (11 px, truncated), and 3 square 28 px icon buttons: Fetch (`download.svg`), Folder (`folder.svg`) and Refresh (`refresh.svg`). Fetch has an accent wash when it is on. Refresh shows an accent `spinner.svg` while it works.
2. **Summary line**, 11 px, `dim`: `111 repositories · 5 with pending` on the left; on the right `Scanning folders…`, then `Analyzing 22/111` in `accent`, then `Updated 3m ago`.
3. **Filter box**, 34 px, `raised` background, with a magnifier, the typed text and a clear button. The right side shows `shown/total` while text is typed.
4. **Chips**, wrapping: **Pending** (yellow dot), **Clean** (green dot), **Errors** (red dot, only when there are errors) and **All**. Each chip has a count badge. **Pending** is on at start.
5. **List**, scrolling, with a 1 px top border. Each repository is a card with a 1 px bottom border:
   - Row 1: an 8 px dot colored by severity, the path of the repository relative to the base folder (13 px semibold, truncated), and a `▸` or `▾` when it has changed files.
   - Row 2, indented 16 px, wrapping 20 px pills: the branch (`branch.svg`, monospace), then `merge in progress` (and `rebase`, `cherry-pick`, `revert`, `bisect`) and `N conflicts` and `N unpushed` in red, `N staged` in green, `N modified` in yellow, `N new` in cyan, `N stash` in magenta, `↓N behind` in blue.
   - Row 3, 11 px `dim`, only when needed: notes joined by ` · `: `No remote`, `Branch has no upstream`, `Upstream branch was removed`, `Detached HEAD with N unpushed commit(s)`, `↑N ahead of upstream`, `Other branches: x (2), y (1)`, `Fetch failed`.
   - Expanded: up to 12 rows of `state  path` (state in monospace: `UU` red, `??` cyan, a staged code green, an unstaged code yellow) and `… N more file(s)`.
   - Expanded, below the files, the **fix area** (indented 16 px, clicks stop there so the card stays open):
     - `Resolve by hand: …` in yellow (11 px), when `fixes(r).manual` is not empty.
     - A row of 24 px buttons (`smallButton`): the safe fixes in accent (**Commit**, **Push**, **Pull**, **Publish to origin**), then **Terminal** (`terminal.svg`) and **New space**.
     - After a click on Push, Pull or Publish: a `raised` box with `Run this command?`, the command in monospace and **Run** / **Cancel**.
     - After a click on Commit: a `raised` box with a message input, 1 to 3 mode buttons (**Staged only**, **Tracked files**, **All, with new files**; the last one red with a warning line), the commands in monospace and **Commit** / **Cancel**.
     - While a fix runs: a spinner and `Push · Running…`.
     - The result: a green `Done.` or a red `Failed.` box with the last 4 output lines, and **Run in terminal** on a failure.
6. **Empty states**: no folder: a tile with the icon, the title *Choose a folder with your repositories*, a hint and a primary **Choose folder** button. A folder with no repository, or an error (the folder does not exist): the message and the same button.

Severity (dot color and sort order, highest first): 5 conflicts or an operation (red), 4 unpushed commits (red), 3 staged or modified (yellow), 2 new files only (cyan), 1 stash only (magenta), 0 clean (green). An error repository has a red dot, shows its error line and no pills. Ties sort by path.

## How it behaves

- Start: the base folder is the saved choice (`shared("git-dash.root")`), else the `root` prop. With none, the panel shows the empty state. Fetch starts from the `fetch` prop, else `shared("git-dash.fetch")`.
- The mod finds the repositories first, then analyzes 12 at a time. Cards appear while the run goes on. On a refresh the old cards stay until their new data arrives; repositories that vanished are removed at the end.
- **Folder** opens `pickFolder`. A choice clears the list, saves the folder with `setShared` and starts a run. A run of the old folder that ends later is ignored (a generation counter).
- **Refresh** does nothing while a run is active. A 30 s timer re-renders the *Updated* age, and starts a silent run when the data is 5 minutes old.
- A card with changed files, a fix, a pending item, an error or a fix result toggles on click. A clean card does nothing.
- **Fixes** (`fixes(r)` in `git.js`) split into `auto` and `manual`. Conflicts, an operation or a detached HEAD block all `auto` fixes. Otherwise: dirty files give `commit`; with an upstream, ahead only gives `push`, behind only gives `pull` (`--ff-only`), ahead and behind is `diverged` (manual); an upstream that is gone is manual; no upstream with commits on the branch gives `publish` to `origin` (or the only remote). No remote, stash and other branches with commits are manual.
- Only one card at a time asks (`this.ask`). The commit mode starts at *staged* when something is staged, else *tracked*, else *all*. An empty message does not commit.
- A fix runs with `runSteps` (`exec("git", ...)`, one step after the other, stop at the first failure), then `refreshOne` reads the repository again: `findRepos(path, 0)` for its operations, then `analyze`.
- **Terminal** runs `tab.new {name, folder, argv: ["git","status"]}`; **New space** runs `space.new` with the same arguments. **Run in terminal** uses `argv: ["git", ...failedStep]`. The shell stays open after the command. Then `refreshOne` runs after 20 s, 90 s and 5 min.
- Languages: `en` and `pt` dictionaries in `main.js`.

## Built from

Files in `mods/git-dash/`: `mod.json` (`{ "place": "none" }`, written first), `main.js` (the `View`), `git.js` (search and analysis), `ui.js` (pills, chips, buttons, small card buttons, search box) and the icons `repos`, `refresh`, `folder`, `download`, `search`, `close`, `branch`, `spinner`, `terminal` (`.svg`, 24 px, stroke `currentColor`).

- **Search** (`findRepos`): runs `pwsh -NoProfile -NonInteractive -Command <script>` on Windows, `sh -c <script>` with `find` elsewhere. It walks `depth` levels (default 4), skips the folders in the `SKIP` list and reparse points, does not enter a repository's `.git`, stops at 400 repositories, and prints `path<TAB>marker,marker` per repository. The markers are the files `MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` and `BISECT_LOG` inside the Git folder (a `.git` file with `gitdir:` is followed). A missing folder gives exit code 2 and a message on stderr.
- **Analysis** (`analyze`): `git --no-optional-locks -c core.quotepath=false status --porcelain=v2 --branch --show-stash --ignore-submodules=dirty --untracked-files=normal` gives branch, upstream, ahead and behind, stash count and files. Type `1` or `2` lines count as staged when `X` is not `.` and as modified when `Y` is not `.`; `u` is a conflict; `?` is new. `git remote` runs only when there is no upstream. `git log --branches HEAD --not --remotes --source --format=%S` gives the unpushed commits by branch (skipped without a remote or in a repository with no commit). `git fetch --all --prune --quiet` runs first when fetch is on.
- A repository is *pending* when it has unpushed commits, stash, staged, modified, new files, conflicts, an operation, no remote, or is ahead of its upstream by more than its unpushed count.
- `herdr` functions: `exec`, `home`, `theme`, `props`, `shared`, `setShared`, `pickFolder`, `run`. `gpui-base`: `InputState` (its `submit` event commits), `Input`. Native animation only: `svg(...).spin(900)`.

## Watch out

- A mod reads files only inside the Herdr home (`fs/promises` throws *outside every granted read root*). Do not walk the base folder with `fs`: use `exec`.
- In PowerShell, `@($a, $b + 1)` is a 3 item array, because the comma binds tighter than `+`. Compute `$next = $level + 1` first, or the depth limit never works.
- PowerShell hashtable keys are case-insensitive, so `Build` and `bin` skip too. The Python original is case-sensitive. This is a deliberate small difference.
- `exec` cannot set environment variables, so `GIT_OPTIONAL_LOCKS=0` becomes the flag `--no-optional-locks`. Porcelain v2 output does not depend on the locale, so `LC_ALL` is not needed.
- `exec` has a 30 s limit and gives the program no input. `props()` can answer for another copy: read the props once in `init(given, cx)`.
- Pass props to `tab.new` from PowerShell through a variable: `$p = '{"root":"D:/Projetos"}'`, then `--props $p`. Forward slashes avoid JSON escapes.
- A hot reload of the mod closes the tabs that show it. A `main.js` save restarts the scan.
- The `root` prop is only a first guess. The folder from the picker is saved in `shared.json` and wins.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/git-dash` passes.
- With `root` set to a folder of repositories, the panel scans, shows `Analyzing n/m`, then `Updated just now`.
- The **Pending** list equals the repositories that `git-pendencias.py <folder> --json` marks `pendente`, with the same counts, and the repository total equals its `repositorios` length.
- A repository with a conflict or a rebase in progress is first and red. A detached HEAD with commits that no remote has shows `N unpushed`.
- **Folder** changes the list to the new folder, and the choice survives a restart. **Refresh** spins and ends.
- In a test folder: **Push** on a repository that is ahead, **Pull** on one that is behind and **Commit** (*Tracked files*) on a dirty one each show `Done.`, and the card reads the repository again. A repository with a conflict shows only *Resolve by hand*, **Terminal** and **New space**.
- **Terminal** opens a tab in the repository folder with the `git status` output, and the shell stays open.
- With the Dock entry in `panels.json`, the **Repos** button shows next to **Changes** and **CI**, and it shows and hides the panel.
- `herdr-app status` shows `"errors": []`.
