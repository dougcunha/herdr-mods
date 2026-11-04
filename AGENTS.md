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
