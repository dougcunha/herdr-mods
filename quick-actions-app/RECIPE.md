# Quick Actions

A Herdr mod that keeps named scripts and runs them in the terminal of the shown space. A status bar item gets the keys of the actions and remembers the last terminal that had the focus; a dialog shows the list, the form and the question before a run.

![Quick Actions](preview.png)

## Files

| File | What it does |
| --- | --- |
| `mod.json` | `place: none`, title, dialog 820 × 640. |
| `main.js` | The View: `props.part === "status"` is the status bar item and runner; else the dialog (list, form, question). |
| `store.js` | `data/quick-actions.json`, `normalize()`, the shared keys, the run files. |
| `vars.js` | The target terminal, its context (folder, busy, shell, the values of the variables), `expand()`, the filter. |
| `run.js` | `prepare()` (no side effects) and `runAction()`: the run file, the new tab, `hc keys` and `hc send`. |
| `list.js`, `form.js`, `ui.js` | The views. |
| `demo.js` | Example actions for the preview (`quick-actions.demo`). |

## Data

`~/.config/herdr-app/data/quick-actions.json`: `{ "actions": [ <action> ] }`. An action:

| Field | Value |
| --- | --- |
| `id` | `a-z`, `0-9`, `-`, up to 24 characters (`q` + time + random). |
| `name`, `icon` | The icon is a file of the mod: `zap`, `play`, `terminal`, `refresh`, `download`, `package`, `git-branch`, `sparkles`, `code`, `gear`, `globe`, `server`, `file-terminal`, `folder`, `trash`. |
| `source` | `"inline"` (`script` is the text) or `"file"` (`file` is a path; `~` is the home folder). |
| `where` | `"terminal"` (the target terminal; a new tab when it is busy) or `"tab"` (always a new tab). |
| `confirm` | Ask before the run. |
| `filter` | Folders and repository names, separated by commas. Empty: everywhere. |
| `pinned` | Reserved for the bar buttons (phase 2). |

Saves go through `writeTextFile(path, text, expected)` on the newest file (3 tries) and set `shared("quick-actions.rev")`; every dialog copy reads the file again when the key changes (1 s timer).

## Runner (status copy)

- A 34 px block: a 13 px `actions.svg` (Lucide square-terminal) in `dim`, `working` while a run goes on. A click runs `mod.open:quick-actions`.
- Every 500 ms: when `focused().terminal` is set and differs from `shared("quick-actions.target")` (`{ terminal, space, tab }`), it writes the key. Every 20 s: `shared("quick-actions.runner") = { at }`. The dialog shows a warning when `at` is older than 60 s.
- `nextCommand()`: `open` opens the dialog; `run-<id>` reads the file, takes the target (`currentTarget()`), and runs the action, or opens a dialog (640 × 340) with `props: { confirm: <id>, target }` when the action asks first.

## The target terminal

`currentTarget()`: `focused().terminal`; else the kept target when it is alive and in the focused space; else the focused (or first) terminal pane of the focused tab; else `{ terminal: null, space, tab }`. The dialog takes it once, when it opens.

`context(target, need)`:

- Machine: the `machine` of the space. This computer: `window().platform`. Another machine: `sh -c 'uname -s; printf "%s\n" "$HOME"'`, else `pwsh -Command $HOME` (cached).
- Folder: `focused().cwd` for the focused terminal, else the pane `cwd`, else the terminal's `foreground.cwd` or `cwd`, else the space folder. Forward slashes; values use the slashes of the machine.
- Busy: no terminal, or `program.shell` is false (an agent, or a program that Herdr sees). On Windows, Herdr reports the shell also while a command runs, so the mod also runs `Get-CimInstance Win32_Process -Filter 'ParentProcessId=<pid>'` (not `conhost.exe` or `OpenConsole.exe`): a child process makes the terminal busy (about 0.6 s).
- Shell: the name of the foreground process or of the program (`pwsh`, `powershell` → `ps`; `bash`, `zsh`, `sh`, `dash`, `ksh`, `fish`), else `ps` on Windows and `sh` elsewhere.
- Values: `folder`, `space`, `tab`, `terminal`, `machine` (`local`), `home`, `date`, `time`, `branch` (the pane's branch), and only when the script or the filter needs them: `repo`, `repo_name` (`git rev-parse --show-toplevel`), `branch` (`git branch --show-current` when the pane has none).

## A run

`prepare(action, target)`:

1. The script text (the file is read with `readTextFile`). Empty: an info message.
2. The context; the filter (a folder part matches the folder and its subfolders, `*` and `**` work; a name part matches `repo_name`, `*` works).
3. A new tab when `where` is `tab` or the terminal is busy. The shell of the line: the shell of the target terminal, or `ps` on Windows and `sh` elsewhere for a new tab. The shell of the script: the extension of a script file (`.ps1`, `.sh`, `.bash`, `.zsh`), else the shell of the line.
4. `expand()`: only the known `{name}`s; each value becomes 1 literal: PowerShell `'…'` with each `'`, `‘`, `’`, `‚` and `‛` doubled (PowerShell takes all of them as single quotes), sh `'…'` with `'\''`. Other braces stay.

`runAction()`:

1. 1 line (inline only): the line itself. Else: a run file `data/quick-actions/runs/<time36>-<slug>.ps1|.sh` (the last 20 stay), and the line `& '<file>'` (PowerShell), `pwsh -NoProfile -File '<file>'` (a `.ps1` in a POSIX shell), or `<shell> '<file>'`. On another machine, only 1 line runs: else an error toast.
2. Target terminal: `hc keys <t> esc` (PowerShell: PSReadLine reverts the line) or `hc keys <t> ctrl+u`, then `hc send <t> <line>` (it pastes and presses Enter).
3. New tab: `tab.new { space, folder, name, focus: true }`; the new terminal is an address that `terminals()` did not have before, with the `herdr.space` label of the target space (150 ms polls, 10 s); then the screen must be the same in 2 reads of `hc read --lines 30` (150 ms apart, 12 s at most); then `hc send`.
4. `pane.focus { terminal }`. A failure posts an error toast `Quick action: <name>`.

## Dialog

- **List** (`list.js`): a 58 px header (32 px tile, "Quick Actions", "Runs in <terminal> · <folder>" or "a new tab (<terminal> runs <program>)", **New**, ×); a warning band when the list file is broken or no runner is alive; a search field (focused at open); 1 row per action (36 px icon tile, the name, labels: lines or file name, terminal or new tab, asks first, the filter), **Run**, pencil, trash (2 clicks). The selected row has an `accent` border. A row whose filter leaves out the target is at 70% and its Run is off. ↑ ↓ select, Enter runs, Esc closes. Empty: **Add 2 examples** (Sync the repository; Update and install, which asks first) and **New action**.
- **Form** (`form.js`): rows of 200 px labels: Name, Icon (15 buttons), Script (Inline | Script file; a mono textarea with the variable tokens, a click inserts `{name}` at the cursor; or the path field), Preview (prepare() again 400 ms after a change: where it runs, and the expanded script), Where it runs (Terminal | New tab), Ask before run, Only in, Key (`"ctrl-shift-1": "quick-actions.run-<id>"`). Save checks name and script; Esc in a field goes back to the list.
- **Question** (`confirmView`): the icon, "Run <name>?", where it runs, the expanded script, Cancel and **Run** (Enter).
- `herdr-app do quick-actions.<new | edit-<id> | list | save | demo | up | down | enter>` drives an open dialog.

## On and off

`kitOff()` (`herdr-mods.disabled` has `quick-actions`): the dialog closes, the status copy draws nothing and skips its timer and its commands.
