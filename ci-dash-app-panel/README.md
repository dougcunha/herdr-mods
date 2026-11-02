# CI Dash side panel for the Herdr app

Adds a **CI** button to the Herdr app's tab bar. It opens the
[CI Dash mod](../ci-dash-app) as a side panel, next to Files and Changes. The
panel remembers, per space, whether it was open.

## Why a layout and a bar mod come with it

Herdr's own layouts and mods are read-only, and the right-hand panel is a fixed
stack of Files and Changes. Adding a third panel needs two clones:

- `layouts/main-ci.json`: a clone of `main` with a `ci` block added to the
  `panel-body` stack, and its tab bar set to `tabs-ci`.
- `mods/tabs-ci`: a clone of `tabs` with one extra **CI** button.

Both are copies, so they do not receive later updates to `main` and `tabs`.
When Herdr ships a new version of those, redo the clones (`layout.clone`,
`mod.clone`) and re-apply the two small changes. They were cloned from Herdr
0.1.11.

## Requirements

- Herdr app 0.1.11 or newer.
- Node.js 20 or newer, to run the installer.
- The `ci-dash-app` folder next to this one (the installer takes the mod from
  there), and the [GitHub CLI](https://cli.github.com/) logged in with
  `gh auth login`.

## Install

From this folder:

```sh
node install.mjs
herdr-app do layout.switch '{"name":"main-ci"}'
```

Then click **CI** in the tab bar, top right.

The installer copies `ci-dash` and `tabs-ci` into `~/.config/herdr-app/mods/`
and `layouts/main-ci.json` into `~/.config/herdr-app/layouts/`, then runs
`herdr-app check` on each mod.

| Option | Effect |
| --- | --- |
| `--dir <folder>` | Install into another Herdr home (default: `$HERDR_APP_HOME`, else `~/.config/herdr-app`). |
| `--force` | Replace an existing `main-ci.json`. The old file is kept as `main-ci.json.bak-<time>`. |
| `--no-check` | Skip `herdr-app check`. |

Mods are always overwritten. The layout is copied only when absent, so edits
you made to `main-ci.json` survive an update.

## Uninstall

```sh
herdr-app do layout.switch '{"name":"main"}'
```

Then delete `mods/tabs-ci` and `layouts/main-ci.json` from the Herdr home
folder. Delete `mods/ci-dash` too if you no longer want the mod.
