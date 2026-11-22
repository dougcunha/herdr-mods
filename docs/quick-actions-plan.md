# Plan: the `quick-actions` mod

Status: design agreed on 2026-11-22 (1 round of questions). Phase 1 done on
2026-11-22 (setup versions 129 and 130).

## Goal

Let the person make named actions: a script that runs in the terminal of the
active space with one click or one key. Examples: sync the repository
(`git pull --ff-only`), install some plugins, run a setup.

- The person types the script in the form, or uses a script file on disk.
- An agent can write the script file from a description.
- An action can show as a button in the bar of the Dock and Kanban layouts.
- Variables such as `{folder}`, `{branch}` and `{space}` get their values from
  the terminal and the space when the action runs.

## Names

- Mod: `quick-actions`. App folder: `quick-actions-app`. Title: "Quick Actions".
- Shared keys start with `quick-actions.`.
- Commands: `quick-actions.run-<id>`, `quick-actions.open`, `quick-actions.demo`.

## Glossary

| Term | Meaning |
| --- | --- |
| **Action** | A name, an icon, a script and its options. 1 list for all spaces. |
| **Inline script** | The script text that the person types in the form. |
| **Script file** | A `.ps1` or `.sh` file on disk that the action runs. |
| **Target terminal** | The terminal that has the focus when the action starts. The action runs there, or in a new tab beside it. |
| **Free terminal** | A target terminal whose program is a shell at its prompt (`program` of the pane is a shell). |
| **Busy terminal** | A target terminal that runs an agent, an editor or a command. |
| **Run file** | A temporary file with the expanded script. The terminal gets 1 line that runs it. |
| **Pinned action** | An action with a button in the bar of the Dock and Kanban layouts. |
| **Filter** | An optional list of folders and repository names. The action shows and runs only there. |
| **Runner** | The status-row block of the mod. It gets the `quick-actions.run-<id>` commands and runs the actions. |

## Facts found during the session

- `run("<mod>.<command>")` and a `keys.json` binding deliver the command only
  to the shown copies of the mod. `mod.open {name}` takes no props. So a bar
  button can run 1 specific action only when a copy of the mod is on the
  screen. The mod needs a block in the status row, like `automations-status`
  and `powermods-core-status`.
- `dock/panels.json` entries with `"opens": "command"` run a command with
  `run(entry.run, entry.args)`. `entryMod()` in `tabs-dock` and `kanban`
  already reads the mod of a `"<mod>.<command>"` entry, so the bars hide the
  button when the mod is off. The **Bar buttons** order and eye work for
  these entries too.
- `PaneInfo` has `cwd`, `branch`, `program` and `status`. `focused()` gives
  the space, the tab and the terminal of the focus, also for a layout
  terminal block.
- `hc send <terminal> "text"` types into a terminal, also on another machine
  (`wsl/t7`).
- `automations` has the parts to reuse: `shell.js` (`quote` for PowerShell and
  sh, `runScript`), `store.js` (a JSON file in `data/`, `kitOff`), and the
  `{name}` syntax for variables.
- `kit.json` is in `<app>/mods/<mod>/kit.json`.
- On Windows, Herdr runs an `argv` as `pwsh -NoExit -Command "& 'prog' 'arg'"`.

## Decisions

1. **Script source.** An action has an inline script or a script file. The
   form has **New with an agent…**: the person describes the script, and an
   agent (from `knownAgents()`) writes the script file. The mod has no
   "Save as file" button.
2. **Buttons.** A pinned action is a button in the bar of the Dock and Kanban
   layouts (`tabs-dock` and `kanban`). 1 more button, **Actions**, opens the
   list. The order and the eye of **Bar buttons** apply.
3. **Busy terminal.** When the target terminal is busy, the action runs in a
   new tab of the same space, in the folder of the target terminal.
4. **Scope.** 1 global list. Each action can have a filter of folders and
   repository names. No code comes from a cloned repository.

### Defaults (the person can change them)

- **Where it runs**, for each action: **Terminal** (the default: the target
  terminal, or a new tab when it is busy) or **New tab** (always a new tab).
- **Ask before run**, for each action: off by default.
- **Variables.** Only the names of this table expand. Every other `{…}` stays
  as it is, so `@{u}` and PowerShell script blocks do not change.

  | Variable | Value |
  | --- | --- |
  | `{folder}` | The folder of the target terminal (`cwd`). |
  | `{repo}` | The root of the git repository of `{folder}`. Empty when it is not a repository. |
  | `{repo_name}` | The last part of `{repo}`. |
  | `{branch}` | The branch of the target terminal. |
  | `{space}` | The name of the space. |
  | `{tab}` | The name of the tab. |
  | `{terminal}` | The address of the target terminal (`t7`, `wsl/t7`). |
  | `{machine}` | The machine of the space, `local` for this computer. |
  | `{home}` | The home folder of that machine. |
  | `{date}`, `{time}` | `YYYY-MM-DD` and `HH:MM`, local time. |
  | `{ask:Label}`, `{ask:Label=default}` | The mod asks the person for a value before the run. |

- **Quotes.** Each value goes into the script as 1 quoted literal for the shell
  (PowerShell `'…'` with `''`, sh `'…'` with `'\''`). The person writes
  `cd {repo}`, not `cd "{repo}"`. A branch or a folder with spaces, `;`, `$`
  or quotes cannot run code.
- **How the script gets to the terminal.** A script of 1 line goes to the
  terminal as that line, so the shell history shows the real command. A script
  of 2 or more lines, and every script file, goes into a run file; the
  terminal gets 1 line that runs it (`& '<run file>'` in PowerShell,
  `. '<run file>'` in sh). The mod keeps the last 20 run files.
- **Shell.** PowerShell for a terminal on Windows, sh for a terminal on macOS
  and Linux. The file extension of a script file wins.
- **Data.** The list is in `~/.config/herdr-app/data/quick-actions.json`.
  `shared("quick-actions.rev")` tells every copy to read it again.
- **Script folder** (a setting): `~/.config/herdr-app/data/quick-actions/scripts`.
  The agent writes the new script files there.
- **Pinned buttons.** The mod writes 1 entry in `dock/panels.json` for each
  pinned action: `{ "id": "qa-<id>", "label", "icon", "opens": "command",
  "run": "quick-actions.run-<id>" }`. It changes only the entries whose `id`
  starts with `qa-`, and the `actions` entry (`mod.open:quick-actions`). It
  writes with `writeTextFile(path, text, expected)`, so it does not overwrite
  a change of the person.
- **Filter in the bars.** The runner writes the ids of the pinned actions that
  do not match the target terminal to `shared("dock.hiddenEntries")`. The bars
  leave out these entries. The name of the key is generic, so other mods can
  use it.
- **Runner.** An icon-only block in the status row of `main-dock` and
  `kanban`. A click opens the list. Without this block in the shown layout, a
  bar button or a key of an action does not run (Herdr has no shown copy to
  get the command), and the list dialog shows a warning. Test in phase 1 what
  Herdr shows in that case.
- **Remote spaces.** Phase 1: a script of 1 line runs in a terminal on any
  machine (`hc send` works there). A script of 2 or more lines and a script
  file run only on this computer; on another machine the mod shows a toast.
  Phase 4 removes this limit.
- **Command palette.** No entry for each action: a mod cannot add entries to
  the palette.

## Phases

1. **Actions and runs.** The data file, the list dialog (`mod.open`), the form
   (name, icon, inline script or script file, where it runs, ask before run,
   filter), a preview of the expanded script for the target terminal, the
   runner block, runs in the target terminal with the new-tab fallback, the
   variables without `{ask:…}`, the keys `quick-actions.run-<id>`,
   `kit.json`, settings, on and off, README, setup version, `whats-new`,
   the status-row block in `main-dock` and `kanban`.
2. **Bar buttons.** The pinned switch, the `qa-<id>` and `actions` entries of
   `panels.json`, `dock.hiddenEntries` in `tabs-dock` and `kanban`.
3. **Agent and questions.** **New with an agent…** and **Edit with an
   agent…** for script files, `{ask:Label}` prompts before the run.
4. **Remote spaces.** Scripts of 2 or more lines and script files on another
   machine (the run file goes there through `hc exec --on`).

## Risks

- **Text at the prompt.** If the person typed text at the prompt and did not
  press Enter, the line of the action goes after that text. Test in phase 1
  whether Esc (PSReadLine) or Ctrl+U (bash, zsh) before the line clears it.
- **Free terminal detection.** `program` follows what runs now. A shell that
  waits on a long command (`npm install`) shows `npm` or `node`: that is busy,
  which is correct. Test a shell with a prompt theme and a shell in WSL.
- **New tab and a slow shell.** The new tab gets the line only after its
  screen stops changing (`hc read` 2 times), as in `github-clone`.
- **Target after a popup.** The runner reads the target terminal before it
  opens a dialog (ask before run, `{ask:…}`), and uses that target after the
  dialog closes.
- **`panels.json` written by 2 writers.** The person, the setup prompt and the
  mod write the file. The mod changes only its own entries and uses
  `expected`. A failed write shows a toast and tries again on the next save.
- **Agent permissions.** The agent starts with the script folder as its
  folder, so it can write there without a question. The task tells it to
  write only the file and not to run it.
- **Preview image.** The list must show example actions only (`demo`), with
  folders of `D:\MyProjects`.

### Phase 1 (as built)

- **Busy on Windows.** Herdr (and `hc get`, `foreground`) reports the shell
  also while a command of the shell runs (`ping`, `npm`). The mod also asks
  for the child processes of the shell (`Get-CimInstance Win32_Process`,
  about 0.6 s): a child makes the terminal busy. A PowerShell cmdlet that
  runs inside the shell (`Start-Sleep`) has no child: the line waits and runs
  after it. On macOS and Linux, Herdr sees the foreground program.
- **Text at the prompt.** `hc send` does not wait for a draft at a shell
  prompt: it pastes after it. The mod presses Esc (PowerShell) or Ctrl+U
  (other shells) with `hc keys` first. Tested in pwsh 7 with PSReadLine.
- **The dialog runs the actions itself**, with the target that it took when
  it opened, and closes after the line went out. Only keys (and, in phase 2,
  bar buttons) need the runner.
- **`{terminal}`** is the target terminal, also when the action runs in a new
  tab.
- **PowerShell and joined values.** `'D:\x'\dist` is 2 arguments in
  PowerShell. The README says to use `Join-Path {repo} dist`.
- **Key.** `alt-q` opens the list (`keys.json` of the app folder).
- **Status block** of 34 px, before `repo-launcher-status`.
- **Curly quotes.** PowerShell also takes `‘ ’ ‚ ‛` as single quotes, so
  `psq` doubles them too (setup version 130). Tested: a value with
  `’;Write-Output INJECTED;‘` stays 1 literal. The `psq` of `automations` and
  the `psQuote` of `github-clone` still double only `'`.
- **New tab.** The new terminal must have the `herdr.space` label of the
  target space, so a background terminal that starts at the same time does
  not get the line.
- **Tested in the app:** runs from the list (Enter) with a free and a busy
  terminal, the question in the list and in its own dialog, a `.ps1` script
  file, the `kanban` layout, and on and off through `mods-hub.off-quick-actions`.
  Without the status block, `herdr-app do quick-actions.run-<id>` answers
  "unknown command". Not tested from the shell: the keyboard focus (search
  field, arrows, Enter, Esc after a click).

## Open questions

None.
