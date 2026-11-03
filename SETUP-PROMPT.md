# Set up all my Herdr mods on a fresh machine

Install the Herdr app, open it once, then paste the text below to your LLM agent
(Claude Code, AmpCode, Cursor, etc.). The agent installs and configures the mods
of this repository and a few third-party mods.

Before you paste it, fill in the 1 placeholder in square brackets: the base
folder of your Git repositories.

````markdown
You will install and configure my Herdr app mods on a new machine. The Herdr app is already installed and running.

## Rules

1. Read `~/.config/herdr-app/AGENTS.md` before anything else and follow its rules.
2. Before you copy a mod, read its files. Tell me if it runs programs (`exec`, `hc`), uses the network or reads files outside its own folder.
3. Never overwrite a file that exists. If a name is taken, stop and ask me.
4. Do not edit the layouts or mods that Herdr ships. They are read-only.
5. When you create a mod folder, write `mod.json` BEFORE `main.js`. Without `mod.json`, Herdr docks a stray copy of the mod into the layout.
6. After each mod, run `herdr-app check <mod folder>`. Run the check with `Start-Process` and a time limit, because a direct call has hung the shell.
7. Never run `herdr-app do tab.close`, `pane.close`, `space.close` or `terminal.kill` without an explicit `--id`. Never dispatch a GitHub workflow as a test.
8. Do not push, do not move my mouse and do not publish screenshots. Screenshots show my work.
9. In PowerShell, pass `--props` through a variable with forward slashes (`/`). Backslashes arrive empty.

## Before you start

1. Check that these programs exist: `git`, `gh` (the GitHub CLI) and `node`.
2. Run `gh auth status`. If I am not logged in, ask me to run `! gh auth login`. Do not continue with the CI mod without it.
3. Run `herdr-app status` and note the Herdr version. If it is newer than 0.1.12, tell me. The `main-dock` layout is a copy of version 0.1.12 and can be out of date.
4. Clone `https://github.com/dougcunha/herdr-plugins` into a temporary folder OUTSIDE `~/.config/herdr-app`.

## Install, in this order

For each item, read the `README.md` and the `RECIPE.md` of the folder before you copy.

1. `dock-app`: the `main-dock` layout and the mods `tabs-dock` and `files-md`. The `files-md` mod opens Markdown files in `markdown-reader` and images in `image-viewer`, so install those two as well.
2. `ci-dash-app`: the `ci-dash` mod.
3. `git-dash-app`: the `git-dash` mod.
4. `image-viewer-app`: the `image-viewer` mod.
5. `kanban-app`: the `kanban` layout and the `kanban` mod.
6. `agent-resume-app`: the `agent-resume` mod, with its `hooks/` folder. Then follow the "Install" section of its `README.md`: put its block in the `main-dock` layout (step 2), and connect each agent that is installed on this machine (step 3: Claude Code, Antigravity, OpenCode; Codex needs nothing). Tell me which agents you connected.
7. `light-themes-app`: the 5 light themes. Copy each file of `light-themes-app/themes/` to `~/.config/herdr-app/themes/`. If a file with the same name exists, do not overwrite it: skip it and tell me. Do not change `appearance` or `theme` for these themes. This folder has no `RECIPE.md`, because the files contain only colors.

Do not install the `ci-dash` folder (the one without `-app`). It is a Herdr TUI plugin and does not run in the app.

Third-party mods. Read the recipe of each one and tell me what it runs before you copy it:

1. `git-graph`: https://github.com/rabeeh-ta/herdr-git-graph
2. `markdown-reader` (and `markdown-reader-pane`, if the repository has it): https://github.com/kissmikijr/herdr-markdown-reader
3. `insights`: https://github.com/GaganSD/coding-agent-toolkit/tree/main/herdr-insights (a folder inside a larger repository: copy only that folder).

The `insights` mod uses Node. The file `mods/insights/runtime.json` holds the path of `node`. Find the path of `node` on this machine (`where node` or `which node`) and write it in that file.

## Configure

Merge everything into the files that already exist. Do not replace a whole file. If a key is already in use, ask me.

### `~/.config/herdr-app/dock/panels.json`

Create the `dock` folder if it does not exist. The base folder of my repositories is [BASE FOLDER OF MY REPOSITORIES, for example D:/Projetos]. Use forward slashes.

```json
{
  "panels": [
    { "id": "ci", "label": "CI", "icon": "mods/ci-dash/ci.svg", "mod": "ci-dash" },
    { "id": "repos", "label": "Repos", "icon": "mods/git-dash/repos.svg", "mod": "git-dash", "props": { "root": "[BASE FOLDER OF MY REPOSITORIES]" } },
    { "id": "graph", "label": "Graph", "icon": "mods/git-graph/icons/graph.svg", "mod": "git-graph" },
    { "id": "insights", "label": "Insights", "icon": "mods/insights/insights.svg", "mod": "insights", "opens": "tab", "name": "Insights" },
    { "id": "kanban", "label": "Kanban", "icon": "mods/kanban/board.svg", "opens": "command", "run": "layout.switch", "args": { "name": "kanban" } }
  ]
}
```

Before you write it, check that the `icon` file of each entry exists. If a third-party mod is missing (for example `insights`), remove only its entry.

### `~/.config/herdr-app/layouts/kanban.json`

1. In the `bar` block, add `"lang": "pt"` and `"back": "main-dock"` to `props`. (Use `"lang": "en"`, or leave it out, if I want English.)
2. In the `board` block, add the same `"lang"` to `props`.

### Agent hooks of `agent-resume`

Follow step 3 of the "Install" section of `agent-resume-app/README.md`. Use the exact text there. For each agent, first check that its program is on the PATH (`claude`, `agy`, `opencode`, `codex`). Skip the agents that are not installed.

1. Claude Code: add the `SessionStart` and `SessionEnd` hooks to `~/.claude/settings.json`. On Windows use the `.ps1` command, on macOS and Linux the `.sh` command. Keep the hooks that are there already.
2. Antigravity: add the named hook `herdr-agent-resume` to `~/.gemini/config/hooks.json`. Write the path of the script WITHOUT quotes. agy keeps quotes as text and the hook fails.
3. OpenCode: create `~/.config/opencode/herdr-agent-resume/tui.js` (a copy of `hooks/opencode-tui.js`). Add `"./herdr-agent-resume"` to `plugins` in `~/.config/opencode/cli.json` and `"./herdr-agent-resume/tui.js"` to `plugin` in `~/.config/opencode/tui.jsonc`. Then run `opencode plugin list` and check that it shows `herdr-agent-resume`.
4. Codex: do nothing. Do NOT add a hook to `~/.codex/hooks.json`.
5. Do not edit Herdr's own integration files (`herdr-agent-state.*`, `herdr-tui-session.js`, `herdr-opencode/`).

The hook paths point to `~/.config/herdr-app/mods/agent-resume/hooks/`. Write the full path of my home folder, not `~`, in the Windows commands.

### `~/.config/herdr-app/keys.json`

In the `global` section, add:

```json
"ctrl-shift-l": "layout.switch",
"ctrl-shift-m": "mod.open:markdown-reader",
"ctrl-shift-r": "mod.open:markdown-reader-pane",
"cmd-shift-m": "mod.open:markdown-reader",
"cmd-shift-r": "mod.open:markdown-reader-pane"
```

Also merge the `keys.json` of each third-party mod.

### `~/.config/herdr-app/settings.json`

```json
{ "zoom": 1.1, "appearance": "dark", "minimum_contrast": 1, "sounds": { "enabled": true }, "font": "JetBrainsMono Nerd Font Mono" }
```

The font `JetBrainsMono Nerd Font Mono` must be installed. If it is not, do not write the `font` key and tell me.

## Activate the panels

The `tabs-dock` mod and the `kanban` mod add the CI, Repos and Graph panels to their layout by themselves, the first time their bar shows. Do this:

1. Run `herdr-app do layout.switch --name main-dock`. Wait 5 seconds.
2. Run `herdr-app do layout.switch --name kanban`. Wait 5 seconds.
3. Open `layouts/main-dock.json` and `layouts/kanban.json`. Check that the `panel-body` of each one has the blocks `ci`, `repos` and `graph`.
4. Leave the `main-dock` layout active at the end.

## Verify

1. `herdr-app status` must show no errors. No `*.error` file may exist in `~/.config/herdr-app`.
2. Every installed mod passed `herdr-app check`.
3. The layouts `main-dock` and `kanban` show up with `ctrl-shift-l`.
4. The `main-dock` status bar shows `Resume on · <n> sessions` at the left.
5. `~/.config/herdr-app/themes/` has the 5 files of `light-themes-app`, and each one is valid JSON.

## Final report

Give me a table with 4 columns: item, source, status (installed, skipped or failed) and note. Add one row for each agent of `agent-resume` (Claude Code, Codex, Antigravity, OpenCode): connected, not installed, or failed. At the end, list what I must do by hand: the `gh` login, the font, anything that failed.
````
