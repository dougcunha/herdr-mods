# Agent instructions

## Language

- Write all repository text in English: code, UI strings (pane labels, buttons, toasts, command descriptions), comments and READMEs, even when the conversation is in another language.

## Herdr app mods

The folders that end in `-app` (for example `ci-dash-app`, `dock-app`,
`agent-resume-app`) are mods and layouts for the Herdr desktop app.

Before you make or edit a mod or a layout, read
`~/.config/herdr-app/AGENTS.md`. That file is the reference for the Herdr app:
its files, its layouts, its mod API and its rules. The Herdr app writes it again
on every start, so it always matches the installed version.

The `ci-dash` folder is a plugin for the Herdr TUI, not a mod. The rule above
does not apply to it.
