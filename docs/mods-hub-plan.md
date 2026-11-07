# Plan: the `mods-hub` panel and multiple folders in `git-dash`

Status: agreed on 2026-11-07. Delivery 1 done (setup version 4). Delivery 2
done (setup version 5): `kit.json` already holds `app`, `description` and
`readme`; delivery 3 adds `settings`. The Settings tab and the gear menu are
still open, and so is the hub key in delivery 3's list (done in delivery 2).

## Goal

Give the people who install the full kit one central panel. The panel shows
the installed mods, the release notes and the settings of every mod. Every mod
still installs and works alone.

## Why it works without changes in Herdr

- `shared(key)` / `setShared(key, value)` is one store for every mod, and
  `setShared` re-renders every copy. The mods already use prefixed keys
  (`repo-launcher.settings`, `git-dash.root`, `kanban.density`,
  `agent-resume.config`, `changes-split.view`). The hub can read and write
  them, and each mod shows the change at once.
- Herdr's own settings (`app.settings`) have fixed sections. Mods cannot add a
  section, so the hub is a mod.
- `mods-update` already has a dialog with tabs, the release notes, the record
  of the setup run and a status bar item. The hub grows from it.

## Decisions

### Central panel: `mods-hub`

- `mods-update` becomes `mods/mods-hub`, with the title "Herdr Mods". The setup
  prompt migrates it: it replaces the status row block in the `main-dock` and
  `kanban` layouts, copies `shared("mods-update")` to the new key and removes
  the old folder (after a backup).
- The dialog has 4 tabs: Mods, Settings, What's new, Update. It opens on
  What's new when an update is available, else on Mods. After a click on a
  tab, it opens on the last tab used.
- Ways to open it: a click on the status bar item, the palette
  (`mod.open:mods-hub`), `ctrl-shift-h` (`cmd-shift-h` on macOS; the prompt
  adds it only when the key is free) and the gear button of the `kanban` and
  `tabs-dock` bars. The gear opens a small menu: "Herdr settings" and
  "Herdr Mods". Without the hub, the gear runs `app.settings` as before.
  `tabs-dock` gets the same gear.

### Mods tab

- The list comes from the `~/.config/herdr-app/mods/` folder, marked with the
  record `data/herdr-mods-setup.json` (kit mods).
- Each mod shows: folder name, title from `mod.json`, origin (kit with its
  repository folder, third-party or manual), description, errors (a `*.error`
  file, with its text) and local changes.
- Local changes: `tools/hash.js` hashes the text of a file (LF line ends,
  without the files that Herdr writes). The setup prompt runs it with `node`
  and writes the hash of every file to the record. The hub imports the same
  code and compares. No network, no `exec`.
- A third-party mod without `kit.json` shows only its name, title and origin.

### Settings tab

- Each kit mod has a `kit.json`: `{ description, readme, settings: [...] }`.
- Field types: `bool`, `number` (min, max, step), `enum`, `text`,
  `folder-list`, `action` (runs a Herdr command, for example `mod.open` or
  `<mod>.<command>`) and `key`.
- The hub writes only `shared()` keys (with a path inside the object, for
  example `agent-resume.config.enabled`). 1 exception: the `key` type writes
  the `global` section of `keys.json`, with the logic of `repo-launcher`
  (clash check, Replace, removes the old key of the same action). The hub never
  writes layouts or other files.
- A preference that is a prop today moves to `shared()`. The prop stays as the
  first value when the key is missing.
- Language: one kit key, `shared("herdr-mods.lang")`, shown in a "Kit"
  section. `props.lang` stays as the first value.
- Layout: a list at the left ("Kit", then 1 row per mod with settings) and the
  fields of the chosen item at the right.
- Scope: preferences only, not UI state. Kit: language. `kanban`: density,
  cards, Waiting column. `changes-split`: Unified / Split. `agent-resume`: the
  4 SETTINGS rows. `git-dash`: folders, fetch. `repo-launcher`: reuse, mode,
  agent arguments, shortcut (`key`), accounts (`action`). Search, column order,
  hidden columns, recent and favorite repositories stay out. Check each
  `RECIPE.md` before writing the files.

### `git-dash`: multiple base folders

- `git-dash` keeps its own setting, separate from `repo-launcher`.
- One global list: `shared("git-dash.roots")`, an array of folders with
  forward slashes. When the key was never saved, the mod fills it once
  from the old saved folder (`shared("git-dash.root:<root>")` or
  `shared("git-dash.root")`) or else from the `root` prop. A saved empty list
  stays empty, so a person can remove every folder.
- Commands `git-dash.folders`, `git-dash.list` and `git-dash.refresh`. The
  hub's `action` field for the folders uses `git-dash.folders`.
- With 1 folder, nothing changes on screen. With 2 or more, a card shows the
  name of its base folder before the relative path (`Projetos/api`), and the
  header shows `2 folders`. When 2 base folders have the same name, the prefix
  adds the parent folder. The sort by severity stays one list for all folders.
- The Folder button opens a folders view inside the panel: 1 row per folder
  (path, repository count or `not found`, trash button) and **Add folder…**.
  The hub shows the same list and an action that opens this view.

## Deliveries

Each delivery increases `N` in `SETUP-PROMPT.md` and adds `whats-new/<N>.md`.

1. `git-dash` with multiple base folders.
2. `mods-hub`: the new name, the migration, the Mods tab and the hashes in the
   record.
3. `kit.json` in each mod, the Settings tab, the kit language and the gear
   menu.
