# Dock

A Herdr app layout whose tab bar builds its side-panel buttons from a file.

Herdr's own `main` layout is read-only, and its tab bar has a fixed list of
buttons (Files, Changes). To add one more button you had to clone the tab bar
and the layout, and edit both. With Dock you clone nothing more: you add one
line to `~/.config/herdr-app/dock/panels.json`, and the button and its panel
show up while the app runs.

![Dock](preview.png)

## Quick Start

Copy and paste this prompt to your LLM agent:

`Read ~/.config/herdr-app/AGENTS.md, then add this layout: https://github.com/dougcunha/herdr-mods/tree/main/dock-app`

To add a button later, for example the [Git Graph](https://github.com/rabeeh-ta/herdr-git-graph) mod:

`Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/rabeeh-ta/herdr-git-graph and add it to the dock: the "main-dock" layout reads ~/.config/herdr-app/dock/panels.json`

## What it adds

| Part | What it is |
| ---- | ---------- |
| `layouts/main-dock.json` | Herdr's `main` layout (the same in 0.1.11 and 0.1.12) with the tab bar `tabs-dock`. Side panel: Files and Changes (the [Changes Split](../changes-app) mod, with a Unified / Split switch). |
| `mods/tabs-dock/` | Herdr's tab bar plus the dock: it reads `dock/panels.json`, draws the buttons and adds the panels to the layout. |
| `mods/files-md/` | Herdr's Files panel (a copy of 0.1.12) with a right-click menu, rendered Markdown and syntax highlighting. See [The Files panel](#the-files-panel). |
| `mods/files-md-menu/` | The popup of that right-click menu. `files-md` needs it. |
| `mods/agent-cards/` | The agents of the sidebar as animated cards. See [The agent cards](#the-agent-cards). |

Switch to the layout with `ctrl-shift-l`. Your own layout stays as it was.

## The Files panel

`files-md` is Herdr's Files panel with these changes:

- **Markdown** opens in the panel as rendered text (headings, tables, code blocks, links you can select and copy). The **Source** button in the header shows the same file as highlighted text, and **Rendered** goes back.
- **Code and other text files** open in the panel with syntax highlighting, line numbers and folding. The editor colors Python, C#, Rust, Go, Java, C, C++, Ruby, PHP, Lua, SQL, JavaScript, JSON, HTML, CSS, YAML and shell files. Kotlin, Scala, TypeScript, TOML, PowerShell, XML and Dockerfile-like files borrow the colors of a close language (Java, JavaScript, YAML, shell or HTML), so they are approximate. Other types, such as Swift, Markdown source and diffs, show as plain text. A file with a null byte shows "Binary file". A text file over 400,000 characters is cut there.
- **Icons** show the type of each row: folders (amber, open or closed), Markdown, code, JSON, shell scripts, images, tables (CSV, Excel), archives, config files (YAML, TOML, dotfiles) and text or documents. Any other file gets a plain file icon. The table is `KINDS` at the top of `files-md/main.js`; the icons are the `.svg` files of the folder (one color, drawn in the color of the type).
- **Images** show in the panel preview, like Markdown and code: fit to the panel, or zoomed from 10% to 800% with scrollbars. The zoom bar in the header has **Fit**, **100%**, **−**, the scale and **+**; the keys `+` (or `=`), `-`, `0` (100%) and `F` (Fit), and Ctrl + mouse wheel, work too. For an image whose size Windows cannot read (SVG, WebP, and every image on macOS and Linux), 100% is the size of the panel. The header shows the size in pixels and in bytes. The right-click item **Open in Image Viewer** opens the image in the [Image Viewer](../image-viewer-app), beside the terminal. Images on another machine have no preview.
- **Filter**: the field at the top has the keyboard when the panel opens and after ← in the preview. Type in it to find a file or a folder anywhere under the root with a fuzzy match (`rdm` finds `README.md`, `deep main` finds `src/deep/main.js`). Each word must match the name or the folders of the path; matched letters are bold. ↑/↓ pick a result, Enter or a click opens it, Esc or × clears the field; in a dialog, Esc with an empty field closes the dialog. A file opens in the preview, and ← or Esc goes back to the results (or to the tree). A folder clears the filter and shows the folder open in the tree. In a Git work tree the filter searches the files that `git ls-files` lists (no ignored files); in other folders it lists all files but skips `.git` and `node_modules`. It searches the first 20,000 files and folders and shows the best 200 matches. Right-click a result for the same menu as a row.
- **Right-click** a file or a folder for a menu:

| Item | On | What it does |
| ---- | -- | ------------ |
| Open with default app | files | Opens the file in the app that Windows (macOS, Linux) has for its type: `Invoke-Item`, `open` or `xdg-open`. |
| Open in Markdown Reader | Markdown files | Opens the file in the [Markdown Reader](https://github.com/kissmikijr/herdr-markdown-reader) beside the terminal. It shows only when that mod is installed. |
| Show in Explorer | files | Opens the folder with the file selected: `explorer /select,`, `open -R`, or the folder in `xdg-open` (Finder and the file manager have the same item). |
| Open in Explorer | folders | Opens the folder. |
| Open terminal here | folders | A new terminal in that folder, to the right of the focused pane. |
| Open in new space | folders | A new space in that folder. |
| New file…, New folder… | folders, empty area | Asks for a name and makes the file or the folder in that folder. A name that is already there shows an error. |
| Cut, Copy | all | Keeps the file or the folder for Paste, in every Files panel. It does not use the system clipboard. |
| Paste “name” | all | Copies (or, after Cut, moves) the kept item into the folder, or into the folder of the file. A copy into a folder that has the same name gets ` - Copy` (`copy` on macOS and Linux). Shows only when an item is kept on the same machine. |
| Duplicate | all | Makes a copy in the same folder: `name - Copy.ext`. |
| Rename… | all | Asks for the new name. The name is selected without its extension. |
| Delete | all | Asks first. On Windows the item goes to the Recycle Bin. On macOS, Linux and other machines it is deleted for good (`rm -rf`). |
| Copy path, Copy relative path, Copy name | all | Writes the text to the clipboard. |

Right-click the empty area below the rows for New file, New folder and Paste in the root folder. For a folder on another machine, the open items do not show (they act on this computer's files); the edit items run on that machine. ↑/↓ and Enter work in the menu, and Esc closes it. The menu opens at the click, also when the panel is a dialog.

## The agent cards

The **Agents** list of the sidebar is the `agent-cards` mod: one card for each agent, with a small robot that acts out the status.

| Status | The robot | The pill |
| ------ | --------- | -------- |
| Working | Types on a laptop: the hands move, the head bobs and a gear turns. | `Working...` |
| Idle | Sleeps: the eyes are closed and "z" letters rise. | `Sleeping` |
| Blocked | Waves an arm, shakes, and shows a `!` bubble. The card border is red. | `Needs you` |
| Done | Jumps with happy eyes and confetti. | `Done` |

- Each card shows the program icon, the space, the tab (or the agent's title) and the time since the last status change. Click a card to go to the agent.
- The order is the order of Herdr's own list: pinned agents first, then the ones that need you, done, working and idle. `agent.next` and `agent.prev` follow it.
- Put the pointer on a card for the **pin** button. A pinned card stays at the top and shows the pin.
- Sub-agents show under their card, one row each. Click a row to peek at the sub-agent. Click "N sub-agents" to fold them.
- A narrow sidebar (the rail) shows a number and a status dot for each agent.
- The animations run inside Herdr (no timer redraws the panel).

**Turn them off** in Herdr Mods → **Settings** → **Agent cards**. Off, the sidebar shows Herdr's own Agents list again; on, the cards come back. The tab bar makes the change in `layouts/main-dock.json` and keeps the size of the block. `tabs-dock.agent-cards` in `keys.json` flips the same setting.

To see all four robots at once, run `herdr-app do agent-cards.demo`. Run it again to show your agents.

## `panels.json`

```json
{
  "panels": [
    { "id": "graph", "label": "Graph", "icon": "mods/tabs-dock/graph.svg", "mod": "git-graph", "group": "git" },
    { "id": "insights", "label": "Insights", "icon": "mods/insights/insights.svg", "mod": "insights", "opens": "tab", "name": "Insights" }
  ]
}
```

| Field | Meaning |
| ----- | ------- |
| `id` | `a-z`, `0-9`, `-`, up to 32 characters, unique. |
| `label` | The button text. |
| `icon` | A path in the Herdr home: `.svg` (drawn in the text color) or a picture. |
| `mod` | The folder in `mods/` to show. It must exist. |
| `props` | Optional. Given to the mod as its `props()`. |
| `opens` | `"panel"` (default): a block in the side panel. `"tab"`: a tab per space with the mod as its only pane. `"command"`: a button that runs a Herdr command (no `mod`). |
| `name` | For `"tab"`: the tab name. |
| `run`, `args` | For `"command"`: the command and its arguments, for example `"run": "layout.switch", "args": { "name": "kanban" }`. |
| `group` | Optional. The entries with the same group share one button. `"git"` puts the entry under the **Git** button, with Changes. |

**Group buttons.** The panels of a group share one button with a small arrow. Changes is in the `git` group, so with `"group": "git"` on Graph and Pending the bar shows one **Git** button. Click it to open a menu with the full name of each panel (Changes, Graph, Pending) and a tick on the open one. Click a row to open or close that panel. The Git button is lit while one of its panels is open. The [Kanban](../kanban-app) bar reads the same field and draws the same button.

The bar has its own icons for the panels, from [Lucide](https://lucide.dev) (ISC license): `mods/tabs-dock/files.svg`, `changes.svg`, `git.svg`, `graph.svg`, `repos.svg` and `ci.svg`. Use them in `panels.json` for a set of icons that match.

A `layout.switch` entry goes to the **layout switch**, a group at the right end of the bar with a button for the shown layout and one for each `layout.switch` entry; the shown layout is lit. A click saves the shown layout in `shared("layout.previous")` first. The [Kanban](../kanban-app) layout reads it and draws the same group in the same place, so the button does not move when you switch.

The **density** button (two chevrons, left of the panel buttons) goes **Auto → Compact → Normal**. **Normal** shows the names of the panel buttons and the layout switch, **Compact** shows only their icons, and **Auto** shows their names when the bar is 2250 px wide or more. The Kanban bar has the same button and uses the same value (`shared("kanban.density")`), so a change in one bar shows in the other.

The **gear** button, right of the density button, opens Herdr's settings. With the `mods-hub` mod installed, it opens a menu instead: **Herdr settings** or **Herdr Mods** (the dialog on its **Settings** tab). `tabs-dock.gear` in `keys.json` does the same.

Language: English, or Portuguese with `"lang": "pt"` in the `props` of the bar block. With the `mods-hub` mod, its **Language** setting (`shared("herdr-mods.lang")`) wins over the prop.

The **panel-open** button (a window with a box in it, the first button of the panel group) sets where the panel buttons open their panel: **Auto → Side panel → Dialog**. **Dialog** opens the panel in the middle of the window, 82% wide and 85% high. **Auto** (the default) opens a dialog when the window is narrower than 1600 px (the px of the app: with a Windows scale of 125%, a 1920 px monitor has 1536 px), else the side panel. This applies to Files, Changes, the panel entries and the tab entries (in **Side panel** mode a tab entry opens in its tab, as before). The dialog has a title row with a button that moves the panel to the side panel (to its tab, for a tab entry) and a close button; Esc and a click beside it close it too. The button of the panel is lit while its dialog is open, and a 2nd click closes it. The Kanban bar has the same button and uses the same value (`shared("kanban.panelOpen")`). A dialog stays open when you switch layout.

- A save of the file shows in the bar at once. Remove an entry and its button and panel go.
- A broken file keeps the last good list and shows an error toast. A bad entry is skipped.
- Bind a key to a panel in `keys.json`: `"layout:main-dock": { "ctrl-alt-shift-g": "tabs-dock.graph" }`. `tabs-dock.group-git` opens the menu of the Git button.

## What it does on your machine

- It reads `dock/panels.json` and the folder list of `mods/` in the Herdr home.
- It edits `layouts/main-dock.json` with the `layout.set` command, to add or remove panel blocks, and to switch the `agents` block between the agent cards and Herdr's own list.
- The tab bar runs no program. The Files panel runs `git` and `powershell` or `sh` to list folders and mark changed files, as Herdr's own Files panel does. The filter runs `git ls-files`, or `powershell` or `sh` (`find`), once to list the files, and again when the files change. Only a click on a right-click menu item runs more: `powershell`, `sh`, `explorer`, `open` or `xdg-open`, on the file you chose. The edit items change files on disk: New, Paste, Duplicate, Rename and Delete.
- It uses no network.

## Limits

- `files-md` needs the `files-md-menu` mod (the right-click menu). The `image-viewer` mod ([this repository](../image-viewer-app)) is optional: only the menu item "Open in Image Viewer" uses it. To show an image, `files-md` copies it to `data/files-md/` in the Herdr home and deletes the copy when you open another file or close the panel. The `markdown-reader` mod (third party) is optional: only the menu item "Open in Markdown Reader" uses it. To go back to Herdr's own Files panel, point the `files` block of `layouts/main-dock.json` to the mod `files`.
- The Changes panel is the `changes-split` mod ([this repository](../changes-app)). Install it before the layout, or the panel stays empty. To go back to Herdr's own Changes panel, point the `changes` block of `layouts/main-dock.json` to the mod `changes`.
- The right-click menu, the Explorer and default app items and the clipboard items were not clicked in a real session: the checks were `herdr-app check`, a screenshot of the menu popup, and the Markdown and highlighting views in the app. Test them on your machine. Tested only on Windows; the macOS and Linux commands are written, not run. The scripts of the edit items were run on Windows (PowerShell and Git's `sh`) outside the app.
- The agent cards were checked with `herdr-app check` and with screenshots of the four statuses (`agent-cards.demo`), the sub-agents and the pin. A click on the pin and on a sub-agent row was not tested in a real session.
- It works only on a personal layout, so it comes with its own copy of `main`.
  That copy does not follow Herdr updates. When Herdr changes the tab bar,
  clone `main` and `tabs` again.
- Built and tested on Windows with Herdr 0.1.11. Herdr 0.1.12 did not change the `main` layout or the `tabs` mod, and the dock loads there without errors. Untested: macOS, Linux, remote machines.
- `RECIPE.md` has the full brief to build it from scratch.
