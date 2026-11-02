# Herdr Plugins

Small, sharp tools for [Herdr](https://github.com/herdrdev/herdr). They
dispatch GitHub Actions, follow every job and rerun failures without leaving
your terminal.

This repository has two kinds of tools, one for each way to run Herdr:

| You run | You install | Folder |
| ------- | ----------- | ------ |
| The Herdr **TUI** (in a terminal) | a plugin | [`ci-dash`](ci-dash) |
| The Herdr **app** (the desktop window) | a mod | [`ci-dash-app`](ci-dash-app) and [`ci-dash-app-panel`](ci-dash-app-panel) |

Plugins and mods are different things. A TUI plugin does not run in the app,
and an app mod does not run in the TUI. Both show the same CI Dash idea.

## Quick Start

Copy and paste one prompt to your LLM agent (Claude Code, AmpCode, Cursor, etc.).

For the Herdr TUI:

`Install and configure ci-dash: https://raw.githubusercontent.com/dougcunha/herdr-plugins/refs/heads/main/ci-dash/README.md`

For the Herdr app, the CI Dash mod:

`Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/dougcunha/herdr-plugins/tree/main/ci-dash-app`

For the Herdr app, the **CI** side panel (the `main-ci` layout and its mods):

`Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/dougcunha/herdr-plugins/tree/main/ci-dash-app and then add this layout: https://github.com/dougcunha/herdr-plugins/tree/main/ci-dash-app-panel`

Optional, to open Markdown files from the Files panel:

`Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/kissmikijr/herdr-markdown-reader`

`AGENTS.md` is the file that the Herdr app writes in its home folder. It tells
the agent how to add a mod or a layout. The agent reads the folder, tells you
what the mod runs, and copies it into `~/.config/herdr-app/`. It never
overwrites a file that exists.

## Herdr TUI plugins

| Plugin | Description |
| ------ | ----------- |
| [CI Dash](ci-dash/README.md) | GitHub Actions in a Herdr pane: dispatch workflows with ref and inputs, watch live. |

![CI Dash artifacts tab in a Herdr pane](ci-dash/docs/artifacts-tab.png)

### Install a plugin

The quickest way to install CI Dash is with Bun:

```sh
bunx @dougcunha/ci-dash@latest install
```

The installer copies the plugin to a stable per-user directory, installs its
dependencies, links it with Herdr, and adds the keybindings.

Each plugin also lives in its own directory and can be linked from a checkout.
For CI Dash:

```sh
cd ci-dash
npm ci --omit=dev
herdr plugin link .
```

See the plugin README for requirements, keybindings, and configuration.

To uninstall CI Dash:

```sh
bunx @dougcunha/ci-dash@latest uninstall
```

## Herdr app mods

| Folder | What it is |
| ------ | ---------- |
| [`ci-dash-app`](ci-dash-app/README.md) | The CI Dash mod. It has three tabs: **Runs**, **Dispatch** and **Artifacts**. It opens in a tab or beside a terminal. |
| [`ci-dash-app-panel`](ci-dash-app-panel/README.md) | A layout (`main-ci`) that adds a **CI** button to the tab bar. The button opens CI Dash as a side panel next to Files and Changes. It also holds two mod clones, `tabs-ci` and `files-md`. |

![CI Dash in the Herdr app](ci-dash-app/preview.png)

![CI Dash Dispatch tab in the Herdr app](ci-dash-app/preview-dispatch.png)

### What the app mod does

- **Runs:** the 30 latest runs, grouped by state. A filter box and status chips
  narrow the list. A run shows its jobs and steps live, with **Open**,
  **Cancel** and **Rerun**.
- **Dispatch:** four steps (workflow, branch, inputs, review). Nothing starts
  until you press **Dispatch**.
- **Artifacts:** the artifacts of the latest run, with filters for name, status
  and file type. A click downloads the file to `<repo>/.ci-dash/artifacts/`.

### Install the app mod

The Herdr app must be running, and the
[GitHub CLI](https://cli.github.com/) must be logged in (`gh auth login`).
Copy the mod folder and check it:

```sh
cp -r ci-dash-app/mods/ci-dash ~/.config/herdr-app/mods/ci-dash
herdr-app check ~/.config/herdr-app/mods/ci-dash
herdr-app do tab.new --name "CI" --mod ci-dash
```

On Windows PowerShell, use `Copy-Item -Recurse` and `$env:USERPROFILE`. The
[`ci-dash-app` README](ci-dash-app/README.md) shows the commands.

The mod runs `gh`, `git` and your file manager through the app's `exec`. It
reaches GitHub through your `gh` login and stores no credentials.
[`ci-dash-app/RECIPE.md`](ci-dash-app/RECIPE.md) describes it in full.

### Install the side panel

To get the **CI** button in the tab bar, run the installer from a checkout:

```sh
cd ci-dash-app-panel
node install.mjs
herdr-app do layout.switch '{"name":"main-ci"}'
```

The installer copies `ci-dash`, `tabs-ci` and `files-md` into
`~/.config/herdr-app/mods/` and the `main-ci` layout into
`~/.config/herdr-app/layouts/`. It then runs `herdr-app check` on each mod.
`Ctrl+Shift+L` goes back to the `main` layout.

The layout and the two clones are copies of Herdr 0.1.11 files. They do not
receive later Herdr updates. The
[`ci-dash-app-panel` README](ci-dash-app-panel/README.md) explains how to
redo them.

`files-md` opens a Markdown file in the
[Markdown Reader](https://github.com/kissmikijr/herdr-markdown-reader) mod when
you click it in Files. That mod belongs to another author and is not part of
this repository. Install it if you want this feature. Without it, only
the click on a `.md` file fails.

## Topics

This repository is tagged with
[`herdr-plugin`](https://github.com/topics/herdr-plugin) for the TUI plugin and
[`herdr-mod`](https://github.com/topics/herdr-mod) for the app mod.

## License

MIT
