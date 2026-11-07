<!-- herdr-mods-setup-version: 2 -->
# Set up or update my Herdr mods

The first line of this file holds the version of the prompt. The `mods-update`
mod reads it. When the version in the repository is newer than the version of
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

## Before you start

1. Check that these programs exist: `git`, `gh` (the GitHub CLI) and `node`.
2. Run `gh auth status`. If I am not logged in, ask me to run `! gh auth login`. Do not continue with the CI mod without it.
3. Run `herdr-app status` and note the Herdr version. If it is newer than 0.1.12, tell me. The `main-dock` layout is a copy of version 0.1.12 and can be out of date.
4. Make a FULL clone (not `--depth 1`, you need the history) of `https://github.com/dougcunha/herdr-mods` into a temporary folder OUTSIDE `~/.config/herdr-app`. Note the commit you got (`git rev-parse HEAD`).
5. Read `~/.config/herdr-app/data/herdr-mods-setup.json`. It is the record that the last run of this prompt left: `{ "repo", "commit", "version", "date", "items": { "<name>": "<source folder in the repo>" } }`. If it exists, show me what is new: `git log --oneline <recorded commit>..HEAD`, grouped by app folder. If it does not exist, I may still have run the prompt before: you will find the baseline by comparing files.
6. Make the list of the items below, and for each one decide: **install** (not on this machine), **up to date**, **update** or **conflict** (I changed it). If the plan replaces or changes any file that exists, show me the plan as a table and wait for my OK. A plan that only adds new things needs no OK.

## The items

For each item, read the `README.md` and the `RECIPE.md` of its folder before you copy anything. A mod copies as a whole folder (`<app>/mods/<name>/` to `~/.config/herdr-app/mods/<name>/`), a layout as a file (`<app>/layouts/<name>.json` and its `.svg`, if any, to `~/.config/herdr-app/layouts/`).

1. `dock-app`: the `main-dock` layout and the mods `tabs-dock`, `files-md` and `files-md-menu`. The `files-md` mod shows Markdown rendered and code with syntax colors in its own panel, with an icon for each file type, and opens images in `image-viewer`, so install that one as well. Its Changes panel is the `changes-split` mod (item 5). Its right-click menu runs `powershell`, `explorer`, `open` or `xdg-open` on the file you choose, and shows "Open in Markdown Reader" when `markdown-reader` is installed.
2. `ci-dash-app`: the `ci-dash` mod.
3. `git-dash-app`: the `git-dash` mod.
4. `image-viewer-app`: the `image-viewer` mod.
5. `changes-app`: the `changes-split` mod, Herdr's Changes panel with a Unified / Split switch. The `main-dock` and `kanban` layouts use it, so install it BEFORE you install or update those layouts. It runs `git` only, the same as Herdr's Changes panel.
6. `kanban-app`: the `kanban` layout and the `kanban` mod. Its Changes panel is the `changes-split` mod (item 5).
7. `agent-resume-app`: the `agent-resume` mod, with its `hooks/` folder. Then follow the "Install" section of its `README.md`: put its block in the `main-dock` layout (step 2), and connect each agent that is installed on this machine (step 3: Claude Code, Antigravity, OpenCode; Codex needs nothing). Tell me which agents you connected.
8. `repo-launcher-app`: the mods `repo-launcher` and `repo-launcher-status`. Put the `repo-launcher-status` block in the status row of the `main-dock` and `kanban` layouts, after the `status` block (see "A status bar item" in its `README.md`). It runs PowerShell (or `sh` and `find`) to find repositories, lists my home folder and reads `.claude.json` and Codex's `auth.json` only to show the e-mail of each account. Merge its `keys.json` in "Configure".
9. `light-themes-app`: the 5 light themes. Copy each file of `light-themes-app/themes/` to `~/.config/herdr-app/themes/`. If a file with the same name exists, leave it and tell me. Do not change `appearance` or `theme` for these themes. This folder has no `RECIPE.md`, because the files contain only colors.
10. `dark-themes-app`: the 6 soft dark themes. Copy each file of `dark-themes-app/themes/` to `~/.config/herdr-app/themes/`, with the same rules as item 9. This folder has no `RECIPE.md` either.
11. `mods-update-app`: the `mods-update` mod. Put its block in the status row of the `main-dock` and `kanban` layouts, at the right end, after the `repo-launcher-status` block (see "Install" in its `README.md`). It downloads `SETUP-PROMPT.md` from GitHub, reads `data/herdr-mods-setup.json` and, when I click its button, writes the prompt to `data/herdr-mods-setup-prompt.md` and starts the agent that I choose.
12. **Anything new.** List the folders ending in `-app` in the clone. If one is not in this list, it is new since this prompt was written: read its `README.md` and `RECIPE.md`, tell me what it is and what it runs, and ask me whether to install it. Do the same for a mod or a layout that is new inside one of the folders above.

Third-party mods. Read the recipe of each one and tell me what it runs before you copy it:

1. `git-graph`: https://github.com/rabeeh-ta/herdr-git-graph
2. `markdown-reader` (and `markdown-reader-pane`, if the repository has it): https://github.com/kissmikijr/herdr-markdown-reader
3. `insights`: https://github.com/GaganSD/coding-agent-toolkit/tree/main/herdr-insights (a folder inside a larger repository: copy only that folder).

The `insights` mod uses Node. The file `mods/insights/runtime.json` holds the path of `node`. Find the path of `node` on this machine (`where node` or `which node`) and write it in that file. If the file exists and the path still works, leave it.

On an update, install a third-party mod only if it is missing. Do not update one that is installed unless I ask: tell me that I can ask.

## Update an installed item

Use this for every mod folder, theme and hook file that already exists.

1. **Find what is different.** Compare each file of the repository folder with the installed one (ignore the files of rule 10). All the same: the item is up to date. Skip it.
2. **For each file that differs, find out whether I changed it.** Run `git log --format=%H -- <file>` in the clone and `git show <commit>:<file>` for each commit. Compare the installed file with those versions, ignoring the difference between CRLF and LF.
   - It equals an older version: I did not touch it. It is safe to replace. The newest commit that it equals is its **baseline**.
   - It equals none of them: I changed it. This is a **conflict**. Show me the difference between my file and the newest version, and, if you can tell which version it began from, what the repository changed since. Ask me: keep mine, take the new one, or merge. To merge, apply only the repository's changes onto my file and keep my edits.
3. **Files that exist only in the repository** (for example a new icon): copy them.
4. **Files that exist only on this machine, in a mod folder:** keep them. They may be mine. If the repository deleted such a file (`git log --diff-filter=D`), tell me and ask.
5. Copy the files in the order of rule 5, then run `herdr-app check` on the folder.

Layouts (`main-dock.json`, `kanban.json`) are never replaced as a whole: Herdr and the dock write panel blocks into them, and I edit them. For a layout, the baseline is the baseline of the mods of the same app folder (`tabs-dock` for `main-dock`, `kanban` for `kanban`). Run `git diff <baseline> HEAD -- <layout file>` in the clone. No difference: do nothing. A difference: apply only those changes to my file (read `layout()` or the file, then use `layout.set` or edit it), keep my other edits and the blocks that the dock added, and run the "Configure" steps again. If you cannot tell the baseline, show me the difference between my file and the repository's and ask. A layout that points a block to a mod (for example `"mod": "changes-split"`) needs that mod installed first.

## Configure

Merge everything into the files that already exist. Do not replace a whole file. Every step must be safe to run twice: add what is missing, and leave what is there. If a key that I use already has another value, keep my value and tell me. This applies to a new machine and to an update.

### `~/.config/herdr-app/dock/panels.json`

Create the `dock` folder if it does not exist. The base folder of my repositories is [BASE FOLDER OF MY REPOSITORIES, for example D:/Projetos]. Use forward slashes. If `panels.json` has a `repos` entry with `props.root` already, use that folder and do not ask.

```json
{
  "panels": [
    { "id": "ci", "label": "CI", "icon": "mods/tabs-dock/ci.svg", "mod": "ci-dash" },
    { "id": "graph", "label": "Graph", "icon": "mods/tabs-dock/graph.svg", "mod": "git-graph", "group": "git" },
    { "id": "repos", "label": "Repos", "icon": "mods/tabs-dock/repos.svg", "mod": "git-dash", "props": { "root": "[BASE FOLDER OF MY REPOSITORIES]" }, "group": "git" },
    { "id": "insights", "label": "Insights", "icon": "mods/insights/insights.svg", "mod": "insights", "opens": "tab", "name": "Insights" },
    { "id": "kanban", "label": "Kanban", "icon": "mods/kanban/board.svg", "opens": "command", "run": "layout.switch", "args": { "name": "kanban" } }
  ]
}
```

Match the entries by `id`. Before you add one, check that its `icon` file exists. If a third-party mod is missing (for example `insights`), leave out only its entry. On an update, add an entry only if its mod was installed in this run, so you do not bring back an entry that I removed on purpose. Never change or reorder the entries that are there, with 1 exception: if the `graph` or `repos` entry has no `group`, add `"group": "git"` to it, so that the Dock and Kanban bars show them in the Git menu with Changes. Entries of mods that are new in this repository (item 12) go in only if I chose to install the mod.

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
"ctrl-p": "mod.open:repo-launcher"
```

If a key is bound already, to this action or to another, leave it and tell me (ask me only for a key that would clash). Add the two `markdown-reader` keys only when that mod is installed, and `ctrl-p` only when `repo-launcher` is installed. Tell me that `ctrl-p` stops reaching the programs in my terminals (shells and Claude Code use it for the previous command), and that I can pick another key in the settings of the launcher. Also merge the `keys.json` of each third-party mod the same way.

### `~/.config/herdr-app/settings.json`

On a new machine, add this:

```json
{ "zoom": 1.1, "appearance": "dark", "minimum_contrast": 1, "sounds": { "enabled": true }, "font": "JetBrainsMono Nerd Font Mono" }
```

The font `JetBrainsMono Nerd Font Mono` must be installed. If it is not, do not write the `font` key and tell me.

On an update, do not change a key that is in the file: these are my own choices now (zoom, theme, font). Add only a key that is missing and that I never had, and tell me.

## Activate the panels

The `tabs-dock` mod and the `kanban` mod add the CI, Repos and Graph panels to their layout by themselves, the first time their bar shows. Remember which layout is shown now (`herdr-app status`). Do this:

1. Run `herdr-app do layout.switch --name main-dock`. Wait 5 seconds.
2. Run `herdr-app do layout.switch --name kanban`. Wait 5 seconds.
3. Open `layouts/main-dock.json` and `layouts/kanban.json`. Check that the `panel-body` of each one has the blocks of the panels that I have (`ci`, `repos`, `graph`, and `insights` if it is a panel).
4. On a new machine, leave the `main-dock` layout active at the end. On an update, go back to the layout that was shown when you started.

## Verify

1. `herdr-app status` must show no errors. No `*.error` file may exist in `~/.config/herdr-app`.
2. Every mod that you installed or updated passed `herdr-app check`.
3. The layouts `main-dock` and `kanban` show up with `ctrl-shift-l`.
4. The `main-dock` status bar shows `Resume on · <n> sessions` at the left.
5. The Changes panel of `main-dock` and `kanban` shows the `Unified` and `Split` buttons in its header.
6. `~/.config/herdr-app/themes/` has the 5 files of `light-themes-app` and the 6 files of `dark-themes-app`, and each one is valid JSON.
7. A second run of "Configure" would change nothing.
8. The status bar of `main-dock` and `kanban` shows the `mods-update` item at the right end. Within 1 minute after you write the record (next section), it shows `mods v<version>`, not `Update mods`.

## Record the run

When all the checks pass, write `~/.config/herdr-app/data/herdr-mods-setup.json`: `repo` (the URL), `commit` (the one from the clone), `version` (the number in the first line of `SETUP-PROMPT.md` in the clone, `<!-- herdr-mods-setup-version: N -->`, as a number), `date`, and `items`, with the name of each item that is installed and the folder of the repository that it came from. Replace the file if it exists. Do not write it if something failed: the next run then starts from the older record.

## Final report

Say first which case this was: a new machine, an update, or a mix. Give me a table with 4 columns: item, source, status (installed, updated, up to date, kept because I changed it, skipped or failed) and note. Add one row for each agent of `agent-resume` (Claude Code, Codex, Antigravity, OpenCode): connected, already connected, not installed, or failed. Add "What is new" (the commits since the last run, in one line each) when this was an update. At the end, list what I must do by hand: the `gh` login, the font, the conflicts that I have not decided, anything that failed, and where the backup folder is.
````
<!-- prompt-end -->
