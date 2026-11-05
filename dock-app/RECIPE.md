# Dock

A Herdr layout (`main-dock`) whose tab bar draws its side-panel buttons from a file, `~/.config/herdr-app/dock/panels.json`. Add one entry to the file and a new button shows in the bar, with its panel. You do not clone the tab bar or edit the layout again. Remove the entry and the button and its panel go away.

![Dock](preview.png)

## What you see

The window of Herdr's `main` layout, with the same sidebar, tabs as pills and pane cards. Only the tab bar differs: 44px high (the same as the Kanban bar), 10px right padding, 6px gap. After the row of tab pills (it scrolls sideways):

- `+` (26px, tooltip "New tab"): the new-tab menu (`new-menu` popup, 250 x 512).

Then the right end. It is the same as the right end of the Kanban bar (`mods/kanban`), in the same place and size, so a layout switch does not move it. 6px between its parts:

- **Panels**, one rounded group (32px high, 10px radius, 1px `border`, background `foreground` at 6%): **Files** and **Changes** first, when their blocks are in the layout and the welcome screen chose them (`shared("workspace.panels")`; icons `mods/files/file.svg` and `mods/changes/changes.svg`); then one button for each valid `panel` or `tab` entry of `panels.json`, in the file's order; then the `command` entries that are not `layout.switch`. A button is 26px high, 7px radius, 14px icon, `muted`; lit (`accent` text on `accent` at 15%) while its panel is open.
- **Layout switch**, one rounded group: a button for the shown layout (icon `mods/tabs-dock/layout-main.svg`, label from the layout name: `main-dock` → "Main dock") and one for each `layout.switch` entry of `panels.json`. The shown layout is lit. Only names in `layouts()` count, each once. Hidden with fewer than 2 layouts.
- On Windows and Linux the minimize, maximize and close buttons (28px, 7px radius, 2px apart).

Below 2250px of bar width (`on_size_change`) the buttons of both groups show only their icons, and the names go to the tooltips ("Show or hide {name}", "Switch to the {name} layout"). The Kanban bar uses the same width. `props.lang` `"pt"` gives Portuguese tooltips; the default is English.

The side panel is 368px wide (min 280, max 900), hidden at first, on the right of the work area, with a stack `panel-body`. The stack holds `files`, `changes` and one block for each panel entry.

## How it behaves

- A click on a panel button opens the panel on that child (`layout.select` then `layout.show`). A click on the button of the open panel hides it. A click on another button switches the child.
- The open panel is remembered for each space (`localStorage` key `panels` of the tab bar): switching space restores that space's panel, or hides it if the space never had one. While the bar adds blocks, a saved choice such as `graph` is not lost: it waits up to 3 s.
- **Entry kinds.** `"opens": "panel"` (default) adds a block to `panel-body`. `"opens": "tab"` makes the button focus the space's tab that shows `mod` as its only pane, or make that tab with `tab.new {name, mod}`. It adds no block.
- **The file is live.** The bar watches `dock/` (`watchFolder`). Each save reloads the list. A missing file is an empty list. A file with broken JSON, or without a `panels` array, keeps the last good list and posts an error toast (`Dock: panels.json`). A bad entry (a wrong id, a missing label or icon, a `mod` that is not in `mods/`, a repeated id) is skipped, and the toast names the first one. The other entries still work.
- **Adding blocks.** A panel entry whose block is missing is added to the layout with one `layout.set` of the whole tree, read from `layout()` and written back with the new child. The same call removes the blocks that this bar added before and the file no longer lists. The bar remembers the ones it added in `localStorage` key `injected`.
- **One try.** The bar tries once for each pair of layout name and file version. A layout that refuses the edit (a shipped layout, such as Herdr's own `main`) is not tried again until the file changes.
- An entry whose `id` is the id of another node of the layout (`main`, `status`, `agents`, ...) is ignored.
- Keys: a command `tabs-dock.<id>` toggles that panel as its button does (`nextCommand`). Bind it in `keys.json`, for example `"layout:main-dock": { "ctrl-alt-shift-g": "tabs-dock.graph" }`. Ask before taking a key that the person already uses.
- Agent statuses show on the tab pills as in Herdr's tab bar: a spinner (`working`), a dot in `blocked` or `done` color. `idle` shows nothing.

### `panels.json`

```json
{
  "panels": [
    { "id": "graph", "label": "Graph", "icon": "mods/git-graph/icons/graph.svg", "mod": "git-graph" },
    { "id": "ci", "label": "CI", "icon": "mods/ci-dash/ci.svg", "mod": "ci-dash", "props": { "repo": "owner/name" } },
    { "id": "insights", "label": "Insights", "icon": "mods/insights/insights.svg", "mod": "insights", "opens": "tab", "name": "Insights" }
  ]
}
```

| Field | Meaning |
| ----- | ------- |
| `id` | `a-z`, `0-9`, `-`, 1 to 32 characters, unique. It is the stack child id and the key command name. |
| `label` | The button text. |
| `icon` | A `.svg` (drawn in the text color) or a picture, a path in the Herdr home. |
| `mod` | The folder in `mods/` that the panel (or the tab) shows. It must exist. |
| `props` | Optional. Passed to the mod as its `props()`. |
| `opens` | `"panel"` (default) or `"tab"`. |
| `name` | For `"tab"`: the tab name. Default: `label`. |

## Built from

- `layouts/main-dock.json`: Herdr's `main` layout, the same in 0.1.11 and 0.1.12 (a row: `sidebar` with `brand`, `spaces`, `agents`, `sidebar-footer`; `work` column with `tabs` 44px (42px in `main`), `work-body`, `status` 28px), with `tabs` set to the mod `tabs-dock`, and `panel-body` holding only `files` (mod `files-md`) and `changes` (mod `changes`). Ids `panel`, `panel-body`, `files` and `changes` must stay: the bar and other mods look them up.
- `mods/tabs-dock/`, `mod.json` `{ "place": "none", "title": "Dock tabs" }`. `main.js` is Herdr's `tabs` mod (tab pills, drag to reorder, rename, close, window buttons, per-space panel memory) with the dock added.
- `herdr` functions: `layout()`, `shared()`, `spaces()`, `panes()`, `appHome()`, `readTextFile`, `watchFolder`, `nextCommand`, `notify`, `openOverlay`, `run`. Commands: `layout.set`, `layout.select`, `layout.show`, `layout.hide`, `tab.new`, `tab.select`, `tab.move`, `tab.rename`, `tab.close`, `tab.next`, `tab.prev`, `pane.focus`, `pane.zoom`, `window.*`. `fs/promises`: `mkdir`, `readdir`.
- `mods/files-md/`, `mod.json` `{ "place": "none", "cloned_from": { "name": "files", "version": "0.1.12" } }`. `main.js` is Herdr's `files` mod with these changes. A click on a Markdown file shows it in the panel preview with `TextView.markdown(id, text)` (id includes the file path, `selectable(true)`, `scrollable(false)`, inside a scrolling `div`), and a header button, **Source** / **Rendered**, switches to a read-only `Editor`. Any other text file shows in a read-only `Editor` with syntax colors from the theme's `ansi` colors; the `LANG` table maps an extension to a language name the editor knows (`py`, `cs`, `rs`, `go`, `java`, `c`, `cpp`, `ruby`, `sql`, `php`, `lua`, `js`, `json`, `html`, `css`, `yaml`, `bash`; names such as `markdown`, `ts`, `toml` and `rb` are not known and must be mapped). A file with a null byte shows "Binary file"; text over 400,000 characters is cut. A click on an image runs `pane.split` with the mod `image-viewer` (props `file`, `fileOn`); an open pane of that mod is closed first, and with no terminal pane in the tab it opens as a dialog. A right-click on a row (`on_mouse_down("right")`) opens the popup `files-md-menu` at the pointer (230 px wide, 31 px a row, 5 px padding, 9 px a divider) with the items as props. Its icons are its own, one-color `svg()` files in `mods/files-md/`: `chevron-down`, `chevron-right`, `file`, `folder`, `folder-open`, `file-markdown`, `file-code`, `file-json`, `file-image`, `file-terminal`, `file-config`, `file-text`, `file-archive` and `file-table`. A `KINDS` table maps a file name to an icon and a color (a theme `ansi` name, or a hex color for folders `#e0a526` and JSON `#e07b39`, because the theme's yellow is nearly black on a light theme); the row's `svg` is 14 px.
- `mods/files-md-menu/`, `mod.json` `{ "place": "none" }`. `main.js` draws a list of items from `props().items`. An item has `label` and any of `copy` (text for the clipboard, `cx.write_to_clipboard`, written before the popup closes), `exec` (`[program, [args]]`, run with `exec`; a nonzero exit shows an error toast, except `explorer`, which exits 1 when it works) and `cmds` (`[[command, args], ...]` for `run`); `icon` names `mods/files-md-menu/<icon>.svg` (`external-link`, `folder-open`, `book-open`, `terminal`, `square-plus`, `copy`, `link`, `type`), drawn 14 px in the muted color; `sep: true` draws a divider above. Up, down, Enter and Escape work. `files-md` builds the items: Open with default app (`Invoke-Item -LiteralPath`, `open`, `xdg-open`), Open in Markdown Reader (only when `mods/markdown-reader/mod.json` can be read), Show in Explorer (`explorer` with the two arguments `/select,` and the path with backslashes; a path with forward slashes opens Documents), Open in Explorer, Open terminal here (`terminal.open {folder, place: "right"}`), Open in new space (`space.new {folder}`), and the three Copy items. Folders on another machine get only Copy items.
- Shipped mods it uses: `workspace-chrome`, `spaces`, `agents`, `pane`, `workspace-status`, `changes`, `new-menu`, `menu`. Mods it opens at a click: `image-viewer` (this repository), and `markdown-reader` (third party, optional) from the menu.
- Art: `win-min.svg`, `win-max.svg`, `win-restore.svg`, `win-close.svg` in `mods/tabs-dock/` (vector window icons).
- The tab bar reads `mods/` (a folder list) and `dock/panels.json` in the Herdr home and runs no program. `files-md` runs `git`, `powershell` or `sh` to list folders, and a click on a menu item runs `powershell`, `explorer`, `open` or `xdg-open`. Nothing uses the network.

## Watch out

- **`layout.set` only works on personal layouts.** Herdr's own `main` refuses it, so this is a layout of its own. Clone it again from the shipped `main` when Herdr changes the tab bar: this copy is frozen at 0.1.12 (it equals 0.1.11). To merge a Herdr update, compare the new shipped `main.json` and `mods/tabs/main.js` with this copy: only your own edits (the `tabs` mod name, `panel-body` children, the dock code in the bar) should differ.
- `layout.set` replaces the whole tree. Read `layout()` and change only `panel-body`, or you lose the person's other edits. A block does not keep unknown fields (a `"dock": true` marker was dropped), so the bar keeps its own list of the blocks it added.
- Never call `layout.set` from `render()` without a guard: it re-renders. The bar keeps a key of layout name plus file version and tries once for each key.
- `watchFolder` needs a folder that exists. The bar makes `dock/` with `mkdir` before it watches. Watch `dock/`, not the Herdr home: the home changes all the time.
- Keep `panels.json` outside `mods/`: a reinstall of the mod replaces its folder.
- Write `mod.json` before `main.js` in a new mod folder, or Herdr docks a copy of the mod into the shown layout.
- Blocks removed from the file are removed from the layout only if this bar added them. A block you wrote by hand in `panel-body` stays.
- A panel entry needs its mod to be a panel (it fills a block). A mod made for panes only may look wrong in 368px.
- Untested: macOS, Linux, a remote machine's window.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/tabs-dock` passes, and `herdr-app status` shows `"layout": "main-dock"` and `"errors": []`.
- With no `panels.json`, the bar shows Files and Changes only, and both open their panels.
- Add `{ "id": "graph", ... }` to `panels.json` while the app runs: within 5 s a Graph button shows, `layouts/main-dock.json` has a `graph` child in `panel-body`, and a click on the button opens the panel.
- Remove that entry: the button goes and the `graph` child leaves the file. A block that you added by hand stays.
- Save `{ "panels": [ ` (broken): an error toast shows, and the buttons stay as they were.
- An entry with `"mod": "does-not-exist"`, or with `"id": "main"`, is skipped, and the other entries work.
- An entry with `"opens": "tab"` focuses its tab on the second click, and does not make a second tab.
- Open Graph in space A and close the panel in space B: switching between the spaces restores each choice.
