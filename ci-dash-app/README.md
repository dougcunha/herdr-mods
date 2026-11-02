# CI Dash for the Herdr app (prototype)

A side panel for the **Herdr app** (the desktop window, not the TUI) that shows
the GitHub Actions runs and artifacts of the repository you are working in. It
is a port of the [`ci-dash`](../ci-dash) TUI plugin. This first slice covers the
**Runs** and **Artifacts** tabs; dispatching workflows is not ported yet.

The panel sits next to Files and Changes and opens from a **CI** button in the
tab bar. It remembers, per space, whether it was open.

## Requirements

- Herdr app 0.1.11 or newer (the layout was cloned from that version).
- Node.js 20 or newer, to run the installer.
- The [GitHub CLI](https://cli.github.com/) logged in with `gh auth login`.

## Install

From this folder:

```sh
node install.mjs
herdr-app do layout.switch '{"name":"main-ci"}'
```

Then click **CI** in the tab bar, top right.

The installer copies `mods/ci-dash` and `mods/tabs-ci` into
`~/.config/herdr-app/mods/` and `layouts/main-ci.json` into
`~/.config/herdr-app/layouts/`, then runs `herdr-app check` on each mod.

| Option | Effect |
| --- | --- |
| `--dir <folder>` | Install into another Herdr home (default: `$HERDR_APP_HOME`, else `~/.config/herdr-app`). |
| `--force` | Replace an existing `main-ci.json`. The old file is kept as `main-ci.json.bak-<time>`. |
| `--no-check` | Skip `herdr-app check`. |

Mods are always overwritten. The layout is copied only when absent, so edits
you made to `main-ci.json` survive an update.

## Why a layout and a bar mod come with it

Herdr's own layouts and mods are read-only, and the right-hand panel is a fixed
stack of Files and Changes. Adding a third panel needs two clones:

- `layouts/main-ci.json`: a clone of `main` with a `ci` block added to the
  `panel-body` stack, and its tab bar set to `tabs-ci`.
- `mods/tabs-ci`: a clone of `tabs` with one extra **CI** button.

Both are copies, so they do not receive later updates to `main` and `tabs`.
When Herdr ships a new version of those, redo the clones (`layout.clone`,
`mod.clone`) and re-apply the two small changes.

## Use

- **Runs**: the 30 latest runs of the repository. Click one for its jobs and
  steps, live status, **Open** (browser), **Cancel**, and **Rerun**. Open runs
  poll every 5 s, backing off to 30 s. A notification fires when a run you were
  watching finishes.
- **Artifacts**: the artifacts of the latest run that produced any, per
  workflow. Click a row to download it to
  `<repo>/.ci-dash/artifacts/<run-id>/<name>`. `↗` opens that folder.
- The repository follows the focused terminal's folder, falling back to the
  other terminals of the space, then to the last repository found. Set
  `props: {"repo": "owner/repo"}` on the block to pin one.

Without the layout, the mod still works on its own:

```sh
herdr-app do tab.new --name "CI" --mod ci-dash
herdr-app do pane.split --direction right --mod ci-dash
```

## Uninstall

```sh
herdr-app do layout.switch '{"name":"main"}'
```

Then delete `mods/ci-dash`, `mods/tabs-ci` and `layouts/main-ci.json` from the
Herdr home folder.

## Known limits

- `exec` allows 30 s per call, so a download of a very large artifact can
  time out. A follow-up can move downloads to `hc run`.
- Mouse only: no keyboard navigation yet.
- No Dispatch tab (workflow, ref and inputs form) yet.
