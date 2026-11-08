# Agent instructions

## Language

- Write all repository text in English: code, UI strings (pane labels, buttons, toasts, command descriptions), comments and READMEs, even when the conversation is in another language.

## Herdr app mods

Every folder in this repository that ends in `-app` (for example `ci-dash-app`,
`dock-app`, `agent-resume-app`) is a mod, a layout or a set of themes for the
Herdr desktop app.

Before you make or edit a mod or a layout, read
`~/.config/herdr-app/AGENTS.md`. That file is the reference for the Herdr app:
its files, its layouts, its mod API and its rules. The Herdr app writes it again
on every start, so it always matches the installed version.

The Herdr TUI plugins live in a separate repository,
[`herdr-plugins`](https://github.com/dougcunha/herdr-plugins). Do not add them
here.

## Version of the setup prompt

`SETUP-PROMPT.md` starts with `<!-- herdr-mods-setup-version: N -->`. The
`mods-hub` mod (called `mods-update` before version 5) compares this number
with the version of the last run on a machine and shows an **Update mods**
button when the number is higher. When a change adds or changes a mod, a layout
or a theme, increase `N` by 1 in the same commit. Keep the
`<!-- prompt-start -->` and `<!-- prompt-end -->` markers around the prompt:
the mod sends only the text between them to the agent.

## Release notes: `whats-new/<N>.md`

Every time you increase `N` in `SETUP-PROMPT.md`, create `whats-new/<N>.md` in
the same commit. The **What's new** tab of the `mods-hub` dialog downloads
this file from GitHub and shows it to the person.

Rules:

- Write the notes in English only.
- Write a markdown list. Do not add a title: the mod adds `## Version <N>`.
- Write 1 item for each change that the person can see or must know. Start the
  item with the name of the mod, layout or theme set in bold, for example
  `- **repo-launcher:** …`.
- Write what changed for the person, not how the code changed.
- Do not edit the file of an older version, unless it has an error.

## `kit.json` in every mod

Every mod folder of this repository has a `kit.json`:
`{ "app": "<app folder>", "description": "<1 or 2 sentences>", "readme": "<GitHub URL of the app folder>", "settings": [...] }`.
The **Mods** tab of `mods-hub` shows the description and marks the mod as part
of the kit. Add it to a new mod, and change the description when the mod
changes what it does.

`partOf` (optional) names the mod that this mod is a part of
(`repo-launcher-status` → `repo-launcher`). The **Mods** tab shows no switch
for a part: it goes on and off with that mod.

`settings` (optional) lists the preferences that the **Settings** tab of
`mods-hub` shows. The field types and their keys are in
`mods-hub-app/mods/mods-hub/fields.js`. Rules:

- Put a preference in `shared()`, never only in a prop or in `localStorage`.
  A prop can give the first value; the shared key wins when it is set.
- Read the key on every render (or in a short timer), not once in `init`, so a
  change in the hub shows at once.
- List preferences only, not UI state (search text, column order, recent
  items).
- When a mod reads `props.lang`, read `shared("herdr-mods.lang")` first.

### On and off

The **Mods** tab of `mods-hub` turns a kit mod off with the shared key
`herdr-mods.disabled` (a list of mod names; see `mods-hub/onoff.js`). Every new
kit mod must follow it:

- Copy the `kitOff()` and `offView()` helpers of an other kit mod. Start
  `render()` with `if (kitOff()) return offView();`, and skip timed work
  (`cx.timer.every(…, (cx) => kitOff() || …)`).
- A button that opens an other kit mod checks that mod too (see `namerOff` in
  `agent-cards`).
- A `dock/panels.json` entry needs nothing more: the bars leave out its button
  and hide its block. A block of a layout of the kit also needs nothing: the
  bars hide it. A mod that replaces a Herdr mod in a block goes into
  `ORIGINALS` of `tabs-dock` and `kanban`.


## Gallery image: `preview.png`

herdr.dev/gallery shows the `preview.png` of each app folder in a card of
16:10 (`960x600`, `object-fit: cover`, anchored at the top left). An image of
another shape loses its right or bottom part, or shows as a thin strip. The
card is about 330 px wide in the gallery grid, so small text in a raw
screenshot cannot be read.

Never save a raw screenshot as `preview.png`. Make it with the template:

1. Save the raw screenshot as `<app>/preview-src.png` (or point `source` to an
   other image of the folder, for example `layouts/<name>.svg`). Crop it to the
   mod: the panel, the dialog or the bar, not the whole window.
2. Write `<app>/preview.json`:
   `{ "name": "<Mod name>", "tagline": "<3 to 5 words>", "kind": "mod" | "layout", "source": "preview-src.png" }`.
   Optional: `"variant": "wide" | "tall" | "strip"` (the script picks one
   from the shape of the image) and `"accent": "#rrggbb"`.
3. Run `node tools/preview/render.mjs <app>` (no argument: all apps). It
   renders `tools/preview/template.html` in headless Edge or Chrome and writes
   `<app>/preview.png` at `1920x1200`.
4. Open `preview.png` and look at it at card size (about 330x206): the name and
   the tagline must be easy to read, and the screenshot must fill its area.

Rules:

- Write the tagline in English: a short call of 3 to 5 words about what the
  person gets (`GitHub Actions in a panel`), not a description of the code.
- Use the name that the gallery shows (`Changes Split`, not `changes-app`).
- Keep `preview-src.png` and `preview.json` in the repository, so that a change
  of the template can render all images again.
- Do the same when a mod changes how it looks: take a new `preview-src.png`
  and render `preview.png` again in the same commit.
- Other images of a README (`preview-status.png`, `preview-panel.png`) are
  documentation. Do not put them in the template.
- A new `preview.png` alone does not need a new setup version.

## Claude-Reflect Learnings

<!-- Auto-generated by claude-reflect. Do not edit this section manually. -->

### Guardrails
- Write `mod.json` (with `"place": "none"`) BEFORE `main.js` in every new mod folder, also in a throwaway test mod. Without it, Herdr docks a block of the mod into the shown layout file (`layouts/<name>.json`), and the block stays after the folder is deleted.
- Give every new mod a `"title"` in `mod.json` (for example `"title": "Agent Cards"`). Without it, the `mods-hub` dialog does not show the name of the mod.
- Preview images (`preview.png` and others) must not show e-mail addresses, tokens or other personal data. Use example values (`you@work.example`) for the screenshot.
- Preview images must show only folders and repositories of `D:\MyProjects`. Never show a work folder or a work repository.
- Run `herdr-app check` on the installed copy in `~/.config/herdr-app/mods/`, not on the repository folder: the check writes `gpui-kit.d.ts` and `jsconfig.json` into the folder that it checks.

### Herdr app runtime traps
- A `popup` overlay is as tall as its content: `height` in `mod.json` does not size it, so a `flex_1` list gets 0 px. Give lists a fixed height and `w_full()`.
- `v_virtual_list` drew nothing inside a popup. Draw a windowed list yourself (rows at fixed offsets, `on_scroll_wheel`), like the shipped `picker` mod.
- Esc closes a popup or a dialog before the mod's `on_key_down` sees it. Use Backspace or ← for "back".
- A dialog made of a layout (the dock's panel dialogs) does not take the keyboard: the terminal behind it keeps it and gets Esc. The title row of the dialog (`panel-title` in `tabs-dock` and `kanban`) takes the keyboard when it opens and closes the dialog on Esc.
- A click on a row in a dialog takes the keyboard from a text field, and no part of the dialog has it after that: Esc does nothing. Give the mod a focus handle (`track_focus` on its root, `on_key_down` for Esc) and focus it in the click handlers when it is in a dialog (`keepKeys` in `files-md`), or on the root's left mouse down while text fields stop their own mouse down (`dialogKeys` in `git-dash/ui.js`).
- Exception: when a text field (`Input`) has the keyboard, Esc does not close the dialog; the mod's `on_key_down` gets it. Close the dialog there: `props().overlay`, or for a dock panel dialog the id in `shared("kanban.panelDialog")` (see `escapeKey` in `git-dash/ui.js`).
- A text field keeps the keyboard for a moment after it leaves the screen. Call `handle.focus()` again with `cx.timer.after(40, …)`.
- `space.select` does not change what a layout that follows the focused pane shows (the `kanban` layout). `pane.focus {terminal | pane}` works in every layout. `run()` returns null: find a new terminal by comparing `panes()` before and after.
- `spaces()[i].folder` is where a space was made, not where it works now. Use the live folders of its terminals (`panes()[i].cwd`).
- On Windows, Herdr runs an `argv` as `pwsh -NoExit -Command "& 'prog' 'arg'"`. To set an environment variable, start a nested `pwsh -NoProfile -Command "$env:X='…'; & 'prog'"`.
- Do not run a bare `find` with `exec`: on Windows it is `find.exe`, which waits for input and hangs. In `herdr-app check`, `window()` does not say `windows`, so a Unix-only branch runs there too. Use `sh -c 'find "$1" …' name dir`.
- `fs.readdir` reads only inside the home folder. `readTextFile` reads any path. Search other drives with `exec`.
- `herdr-app check` does not draw deferred rows or later async states. Test in the app and look with `herdr-app shot`.
- `localStorage` is one store for each copy of a mod (side panel, dialog, each layout). For a value that every copy must show, use `shared()` and `setShared()`: Herdr keeps the value and re-renders every copy.
- Do not make a column as wide as the longest line with one shared sideways scroll: with long lines the other column goes off screen. Measure the width with `on_size_change` (divide it by `settings().zoom`) and wrap the lines. Test with long lines, not only short ones.
- A mod pane opened with `herdr-app do pane.split --mod <mod>` has no id in `herdr-app ls` (it lists only terminals), so the shell cannot close it. To test a sidebar mod, prefer its `demo` command in a block, or tell the person to close the pane with the X of its header.
- `agent-desktop` runs headless and cannot click. To test a mod from the shell, give it commands with `nextCommand()` and run `herdr-app do <mod>.<command>`. `kanban.panel-<id>` opens a panel.

<!-- End claude-reflect section -->
