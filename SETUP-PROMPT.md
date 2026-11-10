<!-- herdr-mods-setup-version: 44 -->
# Set up or update my Herdr mods

The first line of this file holds the version of the prompt. The `mods-hub`
mod (called `mods-update` before version 5) reads it. When the version in the repository is newer than the version of
your last run, it shows a button in the status bar that starts an agent with
this prompt.

One prompt for two cases. Paste the text below to your LLM agent (Claude Code,
AmpCode, Cursor, etc.) with the Herdr app installed and running:

- **New machine:** the agent installs and configures the mods of this repository
  and a few third-party mods.
- **You ran this prompt before:** the agent finds what is installed, installs the
  new mods, updates the ones you did not change, asks about the ones you did
  change, and adds new settings without touching your own.

The agent finds out by itself which case it is, item by item. You can run the
prompt again whenever the repository has news.

The agent always installs the required items (the Dock layout and the mods
that it needs). It asks you which optional items you want. On an update, it
asks only about the optional items that are new or that you have not answered
yet.

On a new machine, fill in the 1 placeholder in square brackets: the base
folder of your Git repositories. On an update, leave it as it is: the agent reads
the folder from your `dock/panels.json`.

<!-- prompt-start -->
````markdown
You will install, or update, my Herdr app mods. The Herdr app is already installed and running. I may have run this prompt before on this machine. Work out for each item whether it is missing (install it), up to date (leave it), behind (update it) or changed by me (ask me).

## Rules

1. Read `~/.config/herdr-app/AGENTS.md` before anything else and follow its rules.
2. Before you copy a mod, read its files. Tell me if it runs programs (`exec`, `hc`), uses the network or reads files outside its own folder. On an update, read only what changed, and tell me if the change adds one of those.
3. Never overwrite a file that I changed. A file may be replaced only if it is missing or if it equals an OLDER version from the repository (see "Update an installed item"). If a name is taken by something that is not from the repository, stop and ask me.
4. Do not edit the layouts or mods that Herdr ships. They are read-only.
5. When you create a mod folder, write `mod.json` BEFORE `main.js`. Without `mod.json`, Herdr docks a stray copy of the mod into the layout. When you update a folder that exists, copy `main.js` LAST, so a half-copied mod never runs.
6. After each mod, run `herdr-app check <mod folder>`. Run the check with `Start-Process` and a time limit, because a direct call has hung the shell.
7. Never run `herdr-app do tab.close`, `pane.close`, `space.close` or `terminal.kill` without an explicit `--id`. Never dispatch a GitHub workflow as a test.
8. Do not push, do not move my mouse and do not publish screenshots. Screenshots show my work.
9. In PowerShell, pass `--props` through a variable with forward slashes (`/`). Backslashes arrive empty.
10. Herdr writes some files inside mod folders by itself: `gpui-kit.d.ts`, `jsconfig.json`, hidden files and `*.error`. Ignore them when you compare, and never delete or replace them.
11. Before you replace or change any file that exists, copy it to `~/.config/herdr-app/backups/herdr-mods-<date and time>/`, with the same relative path. That folder is outside `mods/`, so Herdr does not load it. Tell me where it is at the end.
12. Install the required items and only the optional items that I chose (see "Choose the optional items"). Skip every step, `panels.json` entry, layout block, key and check of an item that is not installed. Every step for `layouts/kanban.json` runs only when the `kanban` layout is installed.
13. I can turn a kit mod off in the **Mods** tab of PowerMods. Read `"herdr-mods.disabled"` in `~/.config/herdr-app/shared.json` (a list of mod names; read the file, do not edit it). A mod in that list stays off: update its files as usual, but do not add its layout blocks, do not do its "Configure" steps and skip its checks. Never remove `"hidden": true` from a block of a layout, and never put a mod back in a block where the bars put Herdr's own mod (`spaces`, `files`, `changes`): the bars of the kit do that when I turn the mod on again. The bars also leave out the buttons of an off mod, so keep its `panels.json` entry.

## Before you start

1. Check that these programs exist: `git`, `gh` (the GitHub CLI) and `node`.
2. Run `gh auth status`. If I am not logged in, ask me to run `! gh auth login`. Do not continue with the CI mod without it.
3. Run `herdr-app status` and note the Herdr version. If it is newer than 0.1.12, tell me. The `main-dock` layout is a copy of version 0.1.12 and can be out of date.
4. Make a FULL clone (not `--depth 1`, you need the history) of `https://github.com/dougcunha/herdr-mods` into a temporary folder OUTSIDE `~/.config/herdr-app`. Note the commit you got (`git rev-parse HEAD`).
5. Read `~/.config/herdr-app/data/herdr-mods-setup.json`. It is the record that the last run of this prompt left: `{ "repo", "commit", "version", "date", "items": { "<name>": "<source folder in the repo>" } }`. If it exists, show me what is new: `git log --oneline <recorded commit>..HEAD`, grouped by app folder. If it does not exist, I may still have run the prompt before: you will find the baseline by comparing files.
6. Choose the optional items with me (next section).
7. Make the list of the items below (the required ones and the optional ones that are installed or that I chose), and for each one decide: **install** (not on this machine), **up to date**, **update** or **conflict** (I changed it). If the plan replaces or changes any file that exists, show me the plan as a table and wait for my OK. A plan that only adds new things needs no OK.

## Choose the optional items

The items marked **Required** in "The items" are always installed: do not ask about them. Ask me which of the optional items below I want, in ONE question with multiple choice (use your question tool when you have one; else a numbered list in one message). Give each choice its name and the line below, and what it runs when that is not only reading.

- `kanban-app`: the Kanban layout, every agent as a card in a column by status.
- `ci-dash-app`: CI Dash, GitHub Actions runs, dispatch and artifacts in a panel (runs `gh`).
- `git-dash-app`: Git Dash, the repositories under a base folder with pending work (runs `git`).
- `agent-resume-app`: Agent Resume, starts the agent sessions again after a reboot (adds hooks to the agents).
- `repo-launcher-app`: Repo Launcher, `Ctrl+P` to open a repository in a terminal or an agent.
- `space-deck-app`: Space Deck, the Spaces sidebar as cards, with an icon, a color and a note for each space.
- `spec-board-app`: Spec Board, the SDD specs of a repository in a Dock panel, with buttons that start an agent (runs `git`, and PowerShell or `sh`).
- `tokenhound-app`: the quotas of the TokenHound HUD. Offer it only on Windows.
- `skill-bundles-app`: Skill Bundles, the agent skills of a project against a skill Catalog (a repository with a `bundles.yaml`). Runs `git`, `gh`, `node` and `npx skills`.
- `tab-namer-app`: Tab Namer, F2 and a pencil on the agent cards rename the tab of an agent, with a button that asks a small AI model for a name (runs `claude` or `codex` once for each click, reads the session files of the agent; the AI button needs `agent-resume-app`). It takes the F2 key from Herdr's own tab rename.
- `automations-app`: Automations, runs a coding agent with a prompt in a folder on a schedule, by hand, or when an agent, a file or a git branch changes, with check, pre and post scripts (runs `pwsh` or `sh`, `hc`, `git` and the agent that I choose for each automation).
- `issues-app`: Issues & PRs, the issues of a space from Jira Cloud or GitHub and its pull requests, in 2 Dock panels, with buttons that start an agent (runs `git`, `gh`, `curl` and PowerShell on Windows; uses the network of Jira and GitHub; stores the Jira token in the credential store of the system).
- `light-themes-app`: 5 light themes.
- `dark-themes-app`: 6 soft dark themes.
- `markdown-reader` (third-party): opens Markdown files from the Files panel.
- `insights` (third-party): a dashboard of the agent sessions (uses Node).

On a new machine, ask about all of them. On an update:

- An optional item that is installed stays: update it, do not ask.
- Ask only about the optional items that are not installed and that are not in `declined` of the record (`data/herdr-mods-setup.json`). An item that is new since the last run is in neither list, so it is asked.
- If no item is left to ask about, do not ask. Tell me that I can ask for an item that I declined before.

An item that I do not choose is skipped (rule 12). Keep my answer for "Record the run".

## The items

**Required:** items 1, 4, 5, 11 and 13 (the `main-dock` layout and the mods that it needs). The other items and the third-party mods are optional: install them only when they are installed already or when I chose them (see "Choose the optional items").

For each item, read the `README.md` and the `RECIPE.md` of its folder before you copy anything. A mod copies as a whole folder (`<app>/mods/<name>/` to `~/.config/herdr-app/mods/<name>/`), a layout as a file (`<app>/layouts/<name>.json` and its `.svg`, if any, to `~/.config/herdr-app/layouts/`).

1. `dock-app`: the `main-dock` layout and the mods `tabs-dock`, `files-md` and `files-md-menu`. Install `agent-cards` (item 13) before `tabs-dock` and the layout: the layout's `agents` block shows it, and the tab bar switches that block to `agent-cards` unless the setting **Agent cards** of PowerMods is off (`shared("agent-cards.enabled")` is `false`). Do not set that key yourself. The `files-md` mod shows Markdown rendered and code with syntax colors in its own panel, with an icon for each file type, and opens images in `image-viewer`, so install that one as well. Its Changes panel is the `git-client` mod (item 5). Its right-click menu runs `powershell`, `explorer`, `open` or `xdg-open` on the file you choose, and shows "Open in Markdown Reader" when `markdown-reader` is installed.
2. `ci-dash-app`: the `ci-dash` mod.
3. `git-dash-app`: the `git-dash` mod. It keeps a list of base folders in `shared("git-dash.roots")`. On its first start it fills the list from the folder that I chose before, else from the `root` prop of its `panels.json` entry. Do not edit `shared.json` for it.
4. `image-viewer-app`: the `image-viewer` mod.
5. `git-client-app`: the `git-client` mod, the **Git** panel: Changes (stage files and hunks, commit, amend, an AI commit message), History (the commit graph of Git Graph for Herdr, MIT, with its actions), Branches (branches, tags, remotes and worktrees), Stash and Submodules, with fetch, pull and push, the history and blame of a file, and a button that starts an agent on merge conflicts. The `main-dock` and `kanban` layouts use it in their `changes` block, so install it BEFORE you install or update those layouts. It runs `git` (also `git apply` with a patch file under `~/.config/herdr-app/data/git-client/`, and `sh -c` for a repository on another machine), and `claude -p` or `codex exec` only when I click **AI** in the commit box (it sends the staged diff to that agent). It opens a file with the default app of the system only when I pick **Open file**. **New worktree** makes a folder next to the repository and opens a Herdr space there. **Resolve with agent** starts the agent that I pick in a new tab, with my account. Its Pull and Fetch settings are in the **Settings** tab of PowerMods: do not set `git-client.*` keys yourself.
    **Move from `changes-split` and `git-graph`.** Before version 37 the Changes panel was the `changes-split` mod (folder `changes-app`) and the Graph panel was the third-party `git-graph` mod. `git-client` replaces both. If `mods/changes-split/` or `mods/git-graph/` exists: back them up (rule 11) and install `git-client`. Then, in `layouts/main-dock.json`, `layouts/kanban.json` and every other layout of mine in `layouts/`, change `content.mod` of each block with `"mod": "changes-split"` to `"git-client"` (keep its id, size and place). Remove the `graph` entry from `dock/panels.json`. After "Activate the panels", if a layout still has a block with the id `graph` and `"mod": "git-graph"`, remove that block (read the file again first; the `kanban` bar removes it by itself, the `main-dock` bar does not). In `keys.json`, change the actions `changes-split.split`, `changes-split.unified` and `changes-split.toggle` to `git-client.split`, `git-client.unified` and `git-client.toggle`, and change a key bound to `tabs-dock.graph` or `kanban.panel-graph` to `git-client.history` (tell me). Delete the folders `mods/changes-split/` and `mods/git-graph/` last. If my `changes-split` folder has files that equal no version of the repository (rule 3; look in the history of `changes-app/mods/changes-split/`), or my `git-graph` folder has changes other than the kit's Esc patch, show me the difference and ask before you delete it. In the record, remove `changes-split` from `items` and `files`, and remove `git-graph` from `third` and from `declined`. The new mod reads `shared("changes-split.view")` and `shared("git-graph.columns")` once by itself: do not copy them.
6. `kanban-app`: the `kanban` layout and the `kanban` mod. Its Changes panel is the `git-client` mod (item 5).
7. `agent-resume-app`: the `agent-resume` mod, with its `hooks/` folder. Then follow the "Install" section of its `README.md`: put its block in the `main-dock` layout (step 2), and also at the left end of the `status-row` of `layouts/kanban.json` when the `kanban` layout is installed (the same block, if no block with the id `agent-resume` is there: the mod runs only in the shown layout), and connect each agent that is installed on this machine (step 3: Claude Code, Antigravity, OpenCode; Codex needs nothing). Tell me which agents you connected.
8. `repo-launcher-app`: the mods `repo-launcher` and `repo-launcher-status`. Put the `repo-launcher-status` block in the status row of the `main-dock` and `kanban` layouts, after the `status` block (see "A status bar item" in its `README.md`). It runs PowerShell (or `sh` and `find`) to find repositories, lists my home folder and reads `.claude.json` and Codex's `auth.json` only to show the e-mail of each account. Merge its `keys.json` in "Configure".
9. `light-themes-app`: the 5 light themes. Copy each file of `light-themes-app/themes/` to `~/.config/herdr-app/themes/`. If a file with the same name exists, leave it and tell me. Do not change `appearance` or `theme` for these themes. This folder has no `RECIPE.md`, because the files contain only colors.
10. `dark-themes-app`: the 6 soft dark themes. Copy each file of `dark-themes-app/themes/` to `~/.config/herdr-app/themes/`, with the same rules as item 9. This folder has no `RECIPE.md` either.
11. `mods-hub-app`: the `mods-hub` mod, the **PowerMods** dialog. Put its block in the status row of the `main-dock` and `kanban` layouts, at the right end, after the `repo-launcher-status` block, or after the last block when that one is not there (see "Install" in its `README.md`). It downloads `SETUP-PROMPT.md`, the release notes in `whats-new/` and the README files from GitHub, asks GitHub's public API once a day for the last commit of each installed third-party mod (no token, nothing about me), reads `data/herdr-mods-setup.json`, `installed.json` and the files of the folders in `mods/` (to list them and compare their hashes), and, when I click an agent, writes the prompt to `data/herdr-mods-setup-prompt.md` and starts that agent. Its **Settings** tab writes the shared keys that the `kit.json` files of the mods name, and `keys.json` when I change a shortcut there. Do not set `shared("herdr-mods.lang")` (the kit language): it is my choice in that tab. The `"lang"` props that "Configure" writes stay as the first value.
    **Move from `mods-update`.** Before version 5 this mod was `mods-update` (folder `mods-update-app`). If `~/.config/herdr-app/mods/mods-update/` exists: back it up (rule 11), install `mods-hub`, then in `layouts/main-dock.json`, `layouts/kanban.json` and every other layout of mine in `layouts/` that has it, change the block `{ "id": "mods-update", "content": { "mod": "mods-update" } }` to `{ "id": "mods-hub", "content": { "mod": "mods-hub" } }` (keep its `size` and its place), then delete the folder `mods/mods-update/`. If my `mods-update` folder has files that equal no version of the repository (rule 3; look in the history of the old path `mods-update-app/mods/mods-update/`), show me the difference and ask before you delete it. Do not copy `shared("mods-update")`: the new mod reads it by itself.
12. `tokenhound-app`: the `tokenhound` mod, the quotas of the [TokenHound](https://github.com/dougcunha/TokenHound) HUD. It works only on Windows, with TokenHound 0.1.16 or newer running. Not on Windows: skip this item, do not ask, and tell me in the report. On Windows, when I chose it, check that `%LOCALAPPDATA%\TokenHound\hud.json` exists. If it does not, TokenHound is not installed or not running: tell me and ask whether to install the mod anyway (it shows `TokenHound not found` until TokenHound runs). If I say no, skip the item: then the `quota` entry and the places of `tokenhound` in "Configure" are skipped too. It only reads that file and watches its folder: no program, no network. Its places are in "Configure": the status bar item, the **Quota** panel of the dock, and, if I say yes, a section under the agents list of `main-dock`.
13. `agent-cards-app`: the `agent-cards` mod, the agents of the sidebar as cards with a small robot. The `agents` block of `main-dock` shows it (item 1). It runs no program, reads no file and uses no network. Before version 13 this mod was in `dock-app/mods/agent-cards/`. The installed folder stays `mods/agent-cards/`. When you look for its baseline ("Update an installed item", step 2), use `git log --follow`, or the old path, because the commits before the move are under `dock-app/`. Record its source as `agent-cards-app/mods/agent-cards`.
14. `space-deck-app`: the `space-deck` mod, a Spaces sidebar with cards or a list, an icon, a color and a note for each space, pinned spaces and recent spaces. It runs `git status` and `git rev-parse` in the folder of each space (on the machine of the space), reads `view.json` (the recent spaces) and checks if `mods/repo-launcher/mod.json` exists. No network. It writes the shared keys `space-deck.*` and Herdr's `space.colors`. After you install it, do "The `spaces` block" in "Configure".
15. `spec-board-app`: the `spec-board` mod, a Dock panel with the SDD specs (`tasks/prd-*`) of the shown repository and its worktrees: status, phase, task progress, the markdown (read and edit), delete to the Recycle Bin, and buttons that start an agent with the SDD skills, here or in a new git worktree. It runs `git` (`rev-parse`, `worktree list`, `ls-files`, `status`, and on a click `check-ref-format` and `worktree add`), PowerShell or `sh` to list and copy `tasks/` and to move a spec to the Recycle Bin, and `explorer`, `open` or `xdg-open`. It reads and writes files in the repositories of my spaces (only the markdown that I save) and watches their `tasks/` folders. No network. It writes the shared keys `spec-board.*`. Its place is the `specs` entry of `panels.json` in "Configure".
16. `skill-bundles-app`: the `skill-bundles` mod, the agent skills of the focused project against a skill Catalog (a repository with a `bundles.yaml`, read by `skills.yaml` in each project). When I did not choose it, its `skills` entry and its status bar block in "Configure" are skipped too. It runs `git`, `gh` (only `gh auth status` and `gh repo clone`), `node` (its own `probe.mjs`, which reads the project's skill folders and hashes the Catalog's) and `npx skills` (which downloads skills from GitHub) in the project folder. It clones the Catalog into `~/.config/herdr-app/cache/skill-bundles/` and fetches it every 15 minutes. It reads and writes `skills.yaml`, `.gitignore` and `skills-lock.json` of the project, but only when I click an action. Do not set its shared keys: I write the Catalog (`owner/name`) in the **Settings** tab of PowerMods.
17. `tab-namer-app`: the `tab-namer` mod, a dialog that renames the tab of an agent. The `kanban` and `agent-cards` mods show a pencil on each card when it is installed, and `agent-resume` clears a name that it saved when the agent starts a new session (`/clear`, `/new`). It runs `claude -p` or `codex exec` (only when I click **Generate with AI**), `hc label` and `hc read`, and reads the session files of the agents (`~/.claude/projects/`, `~/.codex/sessions/`). No other network than the call of that agent. Its key is in "Configure". Tell me that the AI button needs `agent-resume` and Claude Code or Codex.
18. `automations-app`: the `automations` mod. Its status bar item (a block of the same mod with `"part": "status"`) is also the runner: the automations run only while the shown layout has it. Its places are in "Configure": the status bar item and the `automations` entry of `panels.json`. It runs the check, pre and post scripts that I write with `pwsh` (Windows) or `sh`, a headless agent in a background terminal (`hc run`, `hc get`, `hc rm`, `hc kill`), `hc read` and `hc label` for agents in a tab, and `git rev-parse`, `git branch` and `git log` for the git trigger. It starts the agents that I choose with my account, opens tabs and spaces (`tab.new`, `space.new`) and closes only the tab of a run, by id. It reads and writes `data/automations.json`, `data/automation-runs.json` and `data/automation-runs/`. No network of its own. Do not create automations for me.
19. `issues-app`: the mods `issues` and `prs`, a copy of `herdr-ranch-issues` and `herdr-ranch-prs` of Herdr Ranch (MIT). `issues` lists the issues of the shown space from Jira Cloud or GitHub; `prs` lists its pull requests. Both only read the trackers, with two exceptions on a Jira issue page: **Comment** adds the comment that I type, and **Move** moves the issue to the status that I pick (a Jira transition). They run `git` and `gh` in the folder of the space (and `git worktree add` when I click **Start agent** or **Agent review**), `curl` for the avatars, and `powershell` (Windows), `security` (macOS) or `secret-tool` (Linux) to store and read the token. They call my Jira site, write `data/issues-app/`, and start the agent that I choose in a new space. Their places are the `issues` and `prs` entries of `panels.json` and their keys in "Configure". If `mods/herdr-ranch-issues/` or `mods/herdr-ranch-prs/` exists, tell me: the kit mods replace them, and I can delete them and their keys. Tell me that Jira needs a classic API token, in **Link space…** of the cog of the Issues panel. Their settings (Order, Page) are in the **Settings** tab of PowerMods: do not set their shared keys.
20. **Anything new.** List the folders ending in `-app` in the clone. If one is not in this list, it is new since this prompt was written: read its `README.md` and `RECIPE.md`, tell me what it is and what it runs, and add it to the question of "Choose the optional items". Do the same for a mod or a layout that is new inside one of the folders above.

Third-party mods (optional). Read the recipe of each one that I chose and tell me what it runs before you copy it:

1. `markdown-reader` (and `markdown-reader-pane`, if the repository has it): https://github.com/kissmikijr/herdr-markdown-reader
2. `insights`: https://github.com/GaganSD/coding-agent-toolkit/tree/main/herdr-insights (a folder inside a larger repository: copy only that folder).

The `insights` mod uses Node. The file `mods/insights/runtime.json` holds the path of `node`. Find the path of `node` on this machine (`where node` or `which node`) and write it in that file. If the file exists and the path still works, leave it.

**Esc patch for `insights`.** In a dialog of the dock, Esc must close the Insights dialog also after a click in it. The mod does not do this, so add these lines to `mods/insights/main.js`. Do it after you install the mod, and on every run when the file does not contain `herdr-mods patch` yet (also when you do not update the mod). Each added line has the comment `herdr-mods patch`, or sits in a block that starts with it.

1. Add `shared, closeOverlay` to the names of the `import { … } from "herdr";` line (only the names that are not there). After that line, add:
   ```js
   // herdr-mods patch (Esc closes the dialog): the dialog that shows this mod, or null.
   const herdrModsDialog = () => props()?.overlay ?? shared("kanban.panelDialog")?.id ?? null;
   ```
2. In `init(_props, cx)` of the exported `View`, after the line `if (this.toolbarMode) return;`, add:
   ```js
   this.herdrModsKeys = cx.focus_handle(); // herdr-mods patch: the keyboard of the dashboard in a dialog
   ```
3. In `render`, on the root element (`v_flex().id("insights-root")…`), before `.overflow_y_scrollbar()`, add:
   ```js
   // herdr-mods patch: in a dialog, a click on the dashboard gives it the keyboard (not in
   // Settings, where text fields and the editor need it), and Esc closes the dialog.
   .track_focus(this.herdrModsKeys)
   .on_mouse_down("left", () => { if (!this.showSettings && herdrModsDialog()) this.herdrModsKeys.focus(); })
   .on_key_down((event, keyCx) => {
     const dialog = event.key === "escape" ? herdrModsDialog() : null;
     if (dialog) { closeOverlay(dialog); keyCx.stop_propagation(); }
   })
   ```

Then run `herdr-app check` on `~/.config/herdr-app/mods/insights`. If the code of the mod changed and one of these places is not there (no `toolbarMode`, no `insights-root`, no `showSettings`), do not guess: leave the file as it was and tell me.

On an update, install a third-party mod only if it is missing. Do not update one that is installed unless I ask: tell me that I can ask. The **Mods** tab of the `mods-hub` dialog shows when GitHub has a newer version of one.

### Update a third-party mod

Do this when I ask for it, also when the `mods-hub` dialog starts you with "Do only its section 'Update a third-party mod'" for one mod. Then do only this section (and the rules of this prompt), not the other items.

1. Clone the mod's repository with its history, without the file contents: `git clone --filter=blob:none <repository>` (for `insights`, `https://github.com/GaganSD/coding-agent-toolkit`; the mod is in `herdr-insights/mods/insights`). The other mods are in `mods/<name>` of their repository (the list above).
2. Back up `~/.config/herdr-app/mods/<name>/` (rule 11).
3. Find the version that is installed and my changes: run `node tools/record-third-party.mjs --name <name> --clone <clone>` from the clone of this repository (herdr-mods). It prints the commit that the installed folder equals best, and `differs`: the files that are not as in that commit. A file in `differs` that has the comment `herdr-mods patch` is a patch of this kit, not mine: drop it, the patch goes back on in step 6. Any other file in `differs` is mine: show me its difference with that commit, and ask before you replace it (as in "Update an installed item", step 2).
4. Read the commits of the mod folder since that version (`git log --oneline <commit>..HEAD -- <mod folder>`) and the new `README.md` and `RECIPE.md`. Tell me what changed and what the new version runs (programs, network). If the mod's own installer needs a step that this prompt does not do, tell me and ask.
5. Copy the mod folder of the clone to `~/.config/herdr-app/mods/<name>/`. Keep the files that exist only here (rule 10, and `runtime.json` of `insights`). Ask before you delete a file that the repository deleted.
6. Apply the Esc patch of the mod again, if it has one (`insights`, above). Run `herdr-app check` on the folder.
7. Record the new version: `node tools/record-third-party.mjs --name <name> --clone <clone> --write`. It writes `third.<name>` in `data/herdr-mods-setup.json` and keeps the rest of that file.
8. Report: the old and the new commit, what changed, the files that you kept, and where the backup is.

## Update an installed item

Use this for every mod folder, theme and hook file that already exists.

1. **Find what is different.** Compare each file of the repository folder with the installed one (ignore the files of rule 10). All the same: the item is up to date. Skip it.
2. **For each file that differs, find out whether I changed it.** Run `git log --format=%H -- <file>` in the clone and `git show <commit>:<file>` for each commit. Compare the installed file with those versions, ignoring the difference between CRLF and LF.
   - It equals an older version: I did not touch it. It is safe to replace. The newest commit that it equals is its **baseline**.
   - It equals none of them: I changed it. This is a **conflict**. Show me the difference between my file and the newest version, and, if you can tell which version it began from, what the repository changed since. Ask me: keep mine, take the new one, or merge. To merge, apply only the repository's changes onto my file and keep my edits.
3. **Files that exist only in the repository** (for example a new icon): copy them.
4. **Files that exist only on this machine, in a mod folder:** keep them. They may be mine. If the repository deleted such a file (`git log --diff-filter=D`), tell me and ask.
5. Copy the files in the order of rule 5, then run `herdr-app check` on the folder.

Layouts (`main-dock.json`, `kanban.json`) are never replaced as a whole: Herdr and the dock write panel blocks into them, and I edit them. For a layout, the baseline is the baseline of the mods of the same app folder (`tabs-dock` for `main-dock`, `kanban` for `kanban`). Run `git diff <baseline> HEAD -- <layout file>` in the clone. No difference: do nothing. A difference: apply only those changes to my file (read `layout()` or the file, then use `layout.set` or edit it), keep my other edits and the blocks that the dock added, and run the "Configure" steps again. If you cannot tell the baseline, show me the difference between my file and the repository's and ask. A layout that points a block to a mod (for example `"mod": "git-client"`) needs that mod installed first.

## Configure

Merge everything into the files that already exist. Do not replace a whole file. Every step must be safe to run twice: add what is missing, and leave what is there. If a key that I use already has another value, keep my value and tell me. This applies to a new machine and to an update.

### `~/.config/herdr-app/dock/panels.json`

Create the `dock` folder if it does not exist. The base folder of my repositories is [BASE FOLDER OF MY REPOSITORIES, for example D:/Projetos]. Use forward slashes. If `panels.json` has a `repos` entry with `props.root` already, use that folder and do not ask.

```json
{
  "panels": [
    { "id": "ci", "label": "CI", "icon": "mods/tabs-dock/ci.svg", "mod": "ci-dash" },
    { "id": "repos", "label": "Pending", "icon": "mods/tabs-dock/repos.svg", "mod": "git-dash", "props": { "root": "[BASE FOLDER OF MY REPOSITORIES]" }, "group": "git" },
    { "id": "specs", "label": "Specs", "icon": "mods/spec-board/specs.svg", "mod": "spec-board" },
    { "id": "insights", "label": "Insights", "icon": "mods/insights/insights.svg", "mod": "insights", "opens": "tab", "name": "Insights" },
    { "id": "kanban", "label": "Kanban", "icon": "mods/kanban/board.svg", "opens": "command", "run": "layout.switch", "args": { "name": "kanban" } },
    { "id": "quota", "label": "Quota", "icon": "mods/tokenhound/gauge.svg", "mod": "tokenhound" },
    { "id": "skills", "label": "Skills", "icon": "mods/skill-bundles/bundles.svg", "mod": "skill-bundles" },
    { "id": "automations", "label": "Automations", "icon": "mods/automations/zap.svg", "mod": "automations" },
    { "id": "issues", "label": "Issues", "icon": "mods/issues/issue.svg", "mod": "issues" },
    { "id": "prs", "label": "PRs", "icon": "mods/prs/pr.svg", "mod": "prs", "group": "git" }
  ]
}
```

Match the entries by `id`. Before you add one, check that its `icon` file exists. If a third-party mod is missing (for example `insights`), leave out only its entry. On an update, add an entry only if its mod was installed in this run, so you do not bring back an entry that I removed on purpose. Never change or reorder the entries that are there, with 3 exceptions: if the `repos` entry has no `group`, add `"group": "git"` to it, so that the Dock and Kanban bars show it in the Git menu with Changes. Remove the `graph` entry (item 5: the Git panel has the graph now). If the `repos` entry has `"label": "Repos"`, change the label to `"Pending"`; keep any other label. Entries of mods that are new in this repository (item 20) go in only if I chose to install the mod. The `quota` entry goes in only when the `tokenhound` mod is installed, the `specs` entry only when the `spec-board` mod is installed, and the `skills` entry only when the `skill-bundles` mod is installed, and the `automations` entry only when the `automations` mod is installed. The `issues` and `prs` entries go in only when the `issues-app` mods are installed.

### The places of `tokenhound`

Do this only when the `tokenhound` mod is installed. If the `kanban` step above gave `"lang"` to its blocks, give the same `"lang"` to the `props` of the blocks below. Do it AFTER "Activate the panels": the `tabs-dock` and `kanban` mods rewrite their layout when they add the Quota panel, and a block written at the same moment can be lost. Read the layout file again after each change.

1. In `layouts/main-dock.json` and `layouts/kanban.json`, add this block to the `children` of `status-row`, right after the `status` block, if no block with this id is there:
   ```json
   { "id": "tokenhound-status", "type": "block", "content": { "mod": "tokenhound", "props": { "part": "status" } }, "size": { "px": 260 } }
   ```
2. Ask me whether I want the TokenHound section under the agents list of `main-dock`. If yes, add this block to the `children` of `sidebar-lists` in `layouts/main-dock.json`, right after the `agents` block, if no block with this id is there:
   ```json
   { "id": "tokenhound-section", "type": "block", "content": { "mod": "tokenhound", "props": { "part": "section" } }, "size": { "px": 186 }, "min": 60 }
   ```

### The status bar item of `skill-bundles`

Do this only when the `skill-bundles` mod is installed, and AFTER "Activate the panels", for the same reason as `tokenhound`. In `layouts/main-dock.json` and `layouts/kanban.json`, add this block to the `children` of `status-row`, right after the `status` block (after `tokenhound-status` when it is there), if no block with this id is there. If the step for `kanban` gave `"lang"` to its blocks, give the same `"lang"` to `props`:

```json
{ "id": "skill-bundles-status", "type": "block", "content": { "mod": "skill-bundles", "props": { "part": "status" } }, "size": { "px": 90 } }
```

### The status bar item of `automations`

Do this only when the `automations` mod is installed, and AFTER "Activate the panels", for the same reason as `tokenhound`. In `layouts/main-dock.json` and `layouts/kanban.json`, add this block to the `children` of `status-row`, right before the `repo-launcher-status` block (else before the `mods-hub` block, else at the end), if no block with this id is there. This block runs the automations: tell me that they run only while a layout with it is shown.

```json
{ "id": "automations-status", "type": "block", "content": { "mod": "automations", "props": { "part": "status" } }, "size": { "px": 120 } }
```

### The `spaces` block

Do this only when the `space-deck` mod is installed, and only once: if a layout names `space-deck` already, or if I said no before (on an update, ask again only when no layout of mine names `space-deck`).

1. Run `herdr-app status` and note the shown layout (`layout`).
2. If that layout is Herdr's own `main` (read-only, rule 4), tell me and ask whether to copy it to a new layout of mine first. If I say no, skip this section.
3. In the shown layout, find the block with the id `spaces` and `"content": { "mod": "spaces" }`. Back up the file (rule 11), then change only `content.mod` to `"space-deck"`. Keep the id, the size and the place of the block. If the block has another mod, leave it and tell me.
4. Ask me whether to do the same in my other layouts that have a `spaces` block with `"mod": "spaces"` (for example `main-dock` and `kanban`). Change only the ones that I name.
5. Tell me that I can go back with `"mod": "spaces"` in the same block.
### `~/.config/herdr-app/layouts/kanban.json`

1. In the `bar` block, add `"lang": "pt"` and `"back": "main-dock"` to `props`. (Use `"lang": "en"`, or leave it out, if I want English.) If `lang` is there already, keep it.
2. In the `board` block, add the same `"lang"` to `props`.
3. Switch the Files panel of this layout to the clone with the right-click menu: in the block with the id `files` of the stack `panel-body`, set `content.mod` to `"files-md"` (it is `"files"` when the layout is new). Do it only when the `files-md` mod is installed. If another mod is there, leave it and tell me.

### Agent hooks of `agent-resume`

Follow step 3 of the "Install" section of `agent-resume-app/README.md`. Use the exact text there. For each agent, first check that its program is on the PATH (`claude`, `agy`, `opencode`, `codex`). Skip the agents that are not installed. If a hook is there already, do not add it a second time: check that its command or path is the one in the README, and if it points to an old place, tell me before you change it.

1. Claude Code: add the `SessionStart` and `SessionEnd` hooks to `~/.claude/settings.json`. On Windows use the `.ps1` command, on macOS and Linux the `.sh` command. Keep the hooks that are there already.
2. Antigravity: add the named hook `herdr-agent-resume` to `~/.gemini/config/hooks.json`. Write the path of the script WITHOUT quotes. agy keeps quotes as text and the hook fails.
3. OpenCode: create `~/.config/opencode/herdr-agent-resume/tui.js` (a copy of `hooks/opencode-tui.js`; on an update, use "Update an installed item" for this file). Add `"./herdr-agent-resume"` to `plugins` in `~/.config/opencode/cli.json` and `"./herdr-agent-resume/tui.js"` to `plugin` in `~/.config/opencode/tui.jsonc`. Then run `opencode plugin list` and check that it shows `herdr-agent-resume`.
4. Codex: do nothing. Do NOT add a hook to `~/.codex/hooks.json`.
5. Do not edit Herdr's own integration files (`herdr-agent-state.*`, `herdr-tui-session.js`, `herdr-opencode/`).

The hook paths point to `~/.config/herdr-app/mods/agent-resume/hooks/`. Write the full path of my home folder, not `~`, in the Windows commands.

### `~/.config/herdr-app/keys.json`

In the `global` section, add the keys that are missing:

```json
"ctrl-shift-l": "layout.switch",
"ctrl-shift-m": "mod.open:markdown-reader",
"ctrl-shift-r": "mod.open:markdown-reader-pane",
"cmd-shift-m": "mod.open:markdown-reader",
"cmd-shift-r": "mod.open:markdown-reader-pane",
"ctrl-p": "mod.open:repo-launcher",
"ctrl-shift-h": "mod.open:mods-hub",
"cmd-shift-h": "mod.open:mods-hub",
"f2": "mod.open:tab-namer",
"ctrl-shift-j": "mod.open:issues",
"cmd-shift-j": "mod.open:issues",
"ctrl-shift-g": "mod.open:prs",
"cmd-shift-g": "mod.open:prs"
```

When the `issues-app` mods are installed, also add these sections, if they are missing:

```json
"mod:issues": { "ctrl-r": "issues.refresh", "ctrl-o": "issues.browser" },
"mod:prs": { "ctrl-r": "prs.refresh", "ctrl-o": "prs.browser" }
```

If a key is bound already, to this action or to another, leave it and tell me (ask me only for a key that would clash). Exception: `f2` runs `tab.rename` in Herdr's default keys; when the `tab-namer` mod is installed and `f2` is `tab.rename` (or missing), set it to `mod.open:tab-namer` and tell me that F2 now opens the Tab Namer dialog. When `f2` has another action of mine, leave it and ask me. Add `f2` only when `tab-namer` is installed, and the 4 `issues` and `prs` keys only when the `issues-app` mods are installed. Add the two `markdown-reader` keys only when that mod is installed, `ctrl-p` only when `repo-launcher` is installed, and the two `mods-hub` keys only when `mods-hub` is installed. If a key runs `mod.open:mods-update`, change it to `mod.open:mods-hub`. Tell me that `ctrl-p` stops reaching the programs in my terminals (shells and Claude Code use it for the previous command), and that I can pick another key in the settings of the launcher. Also merge the `keys.json` of each third-party mod the same way.

### `~/.config/herdr-app/settings.json`

On a new machine, add this:

```json
{ "zoom": 1.1, "appearance": "dark", "minimum_contrast": 1, "sounds": { "enabled": true }, "font": "JetBrainsMono Nerd Font Mono" }
```

The font `JetBrainsMono Nerd Font Mono` must be installed. If it is not, do not write the `font` key and tell me.

On an update, do not change a key that is in the file: these are my own choices now (zoom, theme, font). Add only a key that is missing and that I never had, and tell me.

## Activate the panels

The `tabs-dock` mod and the `kanban` mod add the CI and Pending panels to their layout by themselves, the first time their bar shows. Remember which layout is shown now (`herdr-app status`). Do this:

1. Run `herdr-app do layout.switch --name main-dock`. Wait 5 seconds.
2. Run `herdr-app do layout.switch --name kanban`. Wait 5 seconds.
3. Open `layouts/main-dock.json` and `layouts/kanban.json`. Check that the `panel-body` of each one has the blocks of the panels that I have (`ci`, `repos`, `quota`, and `insights` if it is a panel).
4. Now add the places of `tokenhound` (see "The places of `tokenhound`" in "Configure"), if that mod is installed, the status bar item of `skill-bundles`, if that mod is installed, and the status bar item of `automations`, if that mod is installed.
5. On a new machine, leave the `main-dock` layout active at the end. On an update, go back to the layout that was shown when you started.

## Verify

1. `herdr-app status` must show no errors. No `*.error` file may exist in `~/.config/herdr-app`.
2. Every mod that you installed or updated passed `herdr-app check`.
3. The layouts `main-dock` and `kanban` show up with `ctrl-shift-l`.
4. The `main-dock` status bar shows `Resume on · <n> sessions` at the left.
5. The Changes panel of `main-dock` and `kanban` shows the **Changes** and **History** tabs of `git-client`, and no layout names `changes-split` or `git-graph`.
6. `~/.config/herdr-app/themes/` has the 5 files of `light-themes-app` and the 6 files of `dark-themes-app`, and each one is valid JSON.
7. A second run of "Configure" would change nothing.
8. If `tokenhound` is installed and TokenHound runs, the status bar of `main-dock` and `kanban` shows one agent icon and one percent for each provider, and `herdr-app do tokenhound.open` opens one dialog with `Live` in its header. Close the dialog with `herdr-app do overlay.close`.
9. If `skill-bundles` is installed, the status bar of `main-dock` and `kanban` shows `skills` with `?` (no Catalog yet) or a number, the dock bar shows a **Skills** button, and `herdr-app do skill-bundles.open` opens one dialog. Close it with `herdr-app do overlay.close`. Tell me to write my Catalog in the **Settings** tab of PowerMods.
10. If `space-deck` is installed, the `spaces` block of the layouts that I chose shows it, and `herdr-app do space-deck.demo` shows example cards (run it again to show my spaces).
11. If `spec-board` is installed, the Dock shows a **Specs** button, and with its panel open `herdr-app do spec-board.demo` shows example specs (run it again to show mine).
12. If `tab-namer` is installed, `herdr-app do mod.open --name tab-namer` opens one dialog with the name of the focused tab. Close it with `herdr-app do overlay.close`. If `agent-resume` is installed too, the status bar of `kanban` shows `Resume on` at the left, as `main-dock` does.
13. If `automations` is installed, the status bar of `main-dock` and `kanban` shows `automations`, the dock bar shows an **Automations** button, and within 10 s `~/.config/herdr-app/shared.json` has `"automations.leader"` with a recent `at`. `herdr-app do mod.open --name automations` opens one dialog. Close it with `herdr-app do overlay.close`.
14. If `issues-app` is installed, the dock bar shows an **Issues** button and **PRs** in the Git menu, and `herdr-app do tabs-dock.issues` opens the Issues panel (run it again to close it).
15. The status bar of `main-dock` and `kanban` shows the `mods-hub` item at the right end, `mods/mods-update/` does not exist, and no layout names `mods-update`. Within 1 minute after you write the record (next section), it shows `mods v<version>`, not `Update mods`.

## Record the run

When all the checks pass, write `~/.config/herdr-app/data/herdr-mods-setup.json`: `repo` (the URL), `commit` (the one from the clone), `version` (the number in the first line of `SETUP-PROMPT.md` in the clone, `<!-- herdr-mods-setup-version: N -->`, as a number), `date`, `items`, with the name of each item that is installed and the folder of the repository that it came from (`mods-hub`, not `mods-update`), `declined` (the names of the optional items from "Choose the optional items" that are not installed: the ones that I did not choose now, and the ones of the old record that I was not asked about again; an item that I chose now leaves the list), and `files`. For `files`, run `node tools/record-hashes.mjs` in the clone. It prints `{ "<mod>": { "<file>": "<hash>" } }` for every mod of the repository. Keep only the mods that are installed and that came from the repository (also a mod where I kept my own file: the `mods-hub` dialog then shows that file as changed). Replace the file if it exists. Do not write it if something failed: the next run then starts from the older record.

Then record the third-party mods, so that the `mods-hub` dialog can tell when GitHub has a newer version: for each one that is installed (`markdown-reader`, `markdown-reader-pane`, `insights`), clone its repository with `git clone --filter=blob:none <repository>` (once for the 2 Markdown Reader mods), and run `node tools/record-third-party.mjs --name <name> --clone <clone> --write` in the clone of this repository. Run it after the Esc patches. It finds the commit that the installed folder equals best and writes `third.<name>` into the record, with the other fields kept. If it fails for a mod, tell me in the report and go on.

## Final report

Say first which case this was: a new machine, an update, or a mix. Then list the optional items that I chose and the ones that I declined. Give me a table with 4 columns: item, source, status (installed, updated, up to date, kept because I changed it, skipped or failed) and note. Add one row for each agent of `agent-resume` (Claude Code, Codex, Antigravity, OpenCode): connected, already connected, not installed, or failed. Add "What is new" (the commits since the last run, in one line each) when this was an update. At the end, list what I must do by hand: the `gh` login, the font, the conflicts that I have not decided, anything that failed, and where the backup folder is.
````
<!-- prompt-end -->
