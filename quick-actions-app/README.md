# Quick Actions for the Herdr app

![Quick Actions](preview.png)

A Herdr app mod that keeps named scripts and runs them in the terminal of the active space with 1 click or 1 key. Examples: sync the repository, install the plugins, start the dev server.

- **The list.** Press `Alt+Q` (or click the Quick Actions icon in the status bar). Type a part of the name, select with ↑ and ↓, and press Enter. The header shows the terminal that gets the script.
- **Inline script or script file.** Type the script in the form, or give the path of a `.ps1`, `.sh`, `.py` or `.js` file (`~` is your home folder).
- **Shell.** **Auto** (the default) uses the shell of the terminal for an inline script, and the extension for a script file. Or choose **PowerShell**, **bash**, **Python** or **Node.js** for the action.
- **A script by an agent.** You do not need a file first. Write the name of the action, choose the **Shell** (the language of the script), click **Write with an agent…**, write what the script must do and choose the agent (from Herdr's agent list). **Start** saves the action with its script file and opens a tab in the space with the agent, in the folder of the file. The script file is on this computer, so when the space is on another machine (WSL, an SSH machine), the agent opens in a new space on this computer. When the agent does not start, the panel shows the error. Or choose **In the background**: the agent works with no tab, and a toast shows when it ends; the form shows its state with **Output** and **Stop**, and the preview shows the script when it is there. The agent gets the rules of the variables and writes only the file. Run the action when the agent is done. **Change with an agent…** changes a script that exists. New files go to `~/.config/herdr-app/data/quick-actions/scripts/<name>.<ext>` (**Script folder** in the settings), or to the path that you write.
- **Variables.** `{folder}`, `{repo}`, `{repo_name}`, `{branch}`, `{space}`, `{tab}`, `{terminal}`, `{machine}`, `{home}`, `{date}` and `{time}` get their values from the terminal and the space when the action runs. The form shows a preview of the script with these values.
- **Safe values.** Each value goes into the script in quotes for the shell (a JSON string for Python and Node.js). Write `cd {repo}`, not `cd "{repo}"`. A branch or a folder with spaces, `;`, `$` or quotes cannot run code. Other text in braces (`@{u}`, a PowerShell script block) does not change.
- **The terminal that has the focus.** The action types its line into that terminal, after it clears a draft at the prompt. When the terminal runs an agent or a program (`npm`, `vim`, a server), the action opens a new tab in the same space and folder and runs there.
- **New tab.** An action can always run in a new tab, with the name of the action.
- **Background.** An action can run with no terminal on the screen: **Where it runs**, **Background**. It runs in the folder of the focused terminal, on its machine. A toast shows when it ends, with the exit code when it fails. Its row in the list shows the state of the last run (running, done, failed, stopped, timed out); a click on it shows the output, and **Stop** stops a run. While it runs, its **Run** button is **Output**. A background run stops after the **Background timeout** of the settings (30 min by default): it cannot answer a question (a password, `Read-Host`, a prompt of `npm`).
- **Ask before run.** An action can show its script with the values and wait for **Run** (or Enter).
- **Questions.** `{ask:Label}` or `{ask:Label=default}` in a script asks for a value before the run: the question shows 1 field for each label, with the script and the values. The answer goes in quotes too.
- **Only in.** An action can have a list of folders and repository names. It runs only there; elsewhere its row is gray.
- **The Actions menu.** Pin an action (the pin of its row, or **In the Actions menu** in the form) and the **Actions** button of the bar of the [Dock](../dock-app) and [Kanban](../kanban-app) layouts becomes a menu: **Actions** (it opens the list), a line, then the pinned actions with their names and icons. A click on an action runs it. An action with **Only in** shows only while the focused terminal is in one of its folders or repositories. With no pinned action, **Actions** opens the list at once. **Bar buttons** in the gear menu of the bar moves and hides the button, as the other buttons.
- **Keys.** Each action has a command: `quick-actions.run-<id>`. The form shows it, ready for `keys.json`.

[`RECIPE.md`](RECIPE.md) describes the mod in full.

## Install

With an agent (Claude Code or any agent that can read files), paste this prompt:

`Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/dougcunha/herdr-mods/tree/main/quick-actions-app, add its status bar item and merge its keys.json`

Or copy the folder yourself. The Herdr app must be running. Copy `mod.json` first: without it, Herdr docks a stray copy of the mod in your layout.

```sh
cp -r quick-actions-app/mods/quick-actions ~/.config/herdr-app/mods/quick-actions
herdr-app check ~/.config/herdr-app/mods/quick-actions
```

Then add the status bar item to the `children` of the `status-row` block of your layout (`layouts/main-dock.json`, `layouts/kanban.json`):

```json
{ "id": "quick-actions-status", "type": "block", "content": { "mod": "quick-actions", "props": { "part": "status" } }, "size": { "px": 34 } }
```

**The keys and the Actions menu items of the actions work only while the shown layout has this item.** A key or a menu item sends `quick-actions.run-<id>`, and only a copy of the mod on the screen gets it. The item also remembers the last terminal that had the focus. Without it, the list shows a warning, and its **Run** buttons still work.

For an **Actions** button (it opens the list) in the Dock and Kanban bars, add this entry to `~/.config/herdr-app/dock/panels.json`:

```json
{ "id": "quick-actions", "label": "Actions", "icon": "mods/quick-actions/actions.svg", "opens": "command", "run": "mod.open", "args": { "name": "quick-actions" } }
```

Then add the key to the `global` section of `~/.config/herdr-app/keys.json` (the file [`keys.json`](keys.json) has it):

```json
"alt-q": "mod.open:quick-actions"
```

## First use

1. Press `Alt+Q`.
2. Click **Add 2 examples**, or **New action**.
3. Write the name and the script, for example `git pull --ff-only`. The preview shows the script with the values of your terminal.
4. Click **Create**.
5. Select the action and press Enter.

To give an action its own key, copy the line under **Key** in the form into the `global` section of `keys.json`, for example:

```json
"ctrl-shift-1": "quick-actions.run-q1abcd"
```

## How a script gets to the terminal

| Script | What the terminal gets |
| --- | --- |
| 1 line in the shell of the terminal | That line, so your shell history shows the real command. |
| 2 or more lines, a script file, another shell, Python or Node.js | 1 line that runs a file with the script and its values. The files are in `~/.config/herdr-app/data/quick-actions/runs/` (the last 20). |

The line that runs the file:

| Language | In PowerShell | In bash, zsh or sh |
| --- | --- | --- |
| PowerShell | `& '<file>'` | `pwsh -NoProfile -File '<file>'` |
| bash | `& '<Git Bash>' '<file>'` on Windows | `bash '<file>'` |
| Python | `& '<python.exe>' '<file>'` (or `py -3`) on Windows | `python3 '<file>'` |
| Node.js | `& 'node' '<file>'` | `node '<file>'` |

On Windows, the mod looks for Git Bash (next to `git`, in `Program Files\Git` or in scoop), because the `bash` of the PATH can be the one of WSL, which cannot read a Windows path. It also skips the `python` link of the Microsoft Store. It asks each machine once.

In PowerShell, `& '<file>'` runs in your shell: a `Set-Location` in the script stays after the run.

**Other machines.** In a space on another machine (`hc machine ls`), the actions run the same way: the values come from that machine (its folder, its `git`, its home folder), and `hc put` copies the run file there first. A script file stays on this computer: the mod reads it here and sends a copy with each run. The shell of the terminal decides: PowerShell on a Windows machine, `bash`, `zsh` or `sh` on macOS and Linux.

To join a value and more text in PowerShell, use `Join-Path {repo} dist`: `{repo}\dist` gives 2 words. In `sh`, `{repo}/dist` works. In Python, `os.path.join({repo}, "dist")`; in Node.js, `path.join({repo}, "dist")`.

## Background runs

A background run is a terminal of herdr-core that is not on the screen (`hc run --bg`), with the label `quick-actions=<id>`. The run file goes to that terminal as with a new tab, and the shell of the machine runs it:

| Language | Program |
| --- | --- |
| PowerShell | `pwsh -NoProfile -Command "& '<file>'; exit $LASTEXITCODE"`: the exit code of the last program (PowerShell itself ends with 0 after a program that failed), or 1 when the script stops with an error (`throw`, or a cmdlet error with `$ErrorActionPreference = 'Stop'`). A cmdlet error that does not stop the script does not count. Check `$LASTEXITCODE` after each program |
| bash, sh | `bash '<file>'` (Git Bash on Windows): the exit code of the script. Put `set -e` at the top to stop at the first error |
| Python, Node.js | `python3`, `python` or `py -3`, and `node`: the exit code of the script |

The terminal gets the environment of herdr-core and no profile (`-NoProfile`): a program that only your profile puts in the `PATH` is not found. The status bar item of Quick Actions checks the runs every second, so it must be in the layout (the Dock and Kanban layouts have it). The output of the last run of each action stays in `~/.config/herdr-app/data/quick-actions/output/`. When Herdr or herdr-core restarts during a run, the run is **lost**.

### The agent in the background

A headless agent cannot ask for permission, so each command has a flag that lets it write the file. It works in the folder of the script:

| Agent | Command | What it may do with no question |
| --- | --- | --- |
| Claude Code | `claude -p <task> --permission-mode acceptEdits` | Edit files |
| Codex | `codex exec --skip-git-repo-check --sandbox workspace-write <task>` | Edit files and run commands in the sandbox of the folder |
| OpenCode | `opencode run --auto <task>` | Everything that its settings do not deny |
| Antigravity | `agy -p <task> --mode accept-edits` | Edit files |
| oh-my-pi | `omp -p <task> --approval-mode write` | Its write tools |

Other agents have no background mode: use **In a tab**. The agent works in a work folder and writes the script there: on Windows `%TEMP%\herdr-quick-actions\<id>`, elsewhere `data/quick-actions/writer/<id>/work`. At the end, the mod copies the script to its place. (The sandbox of Codex on Windows cannot write in a folder under a folder with a dot, such as `~/.config`.) **Change with an agent…** copies the script to the work folder first. The task goes in a file (`data/quick-actions/writer/<id>/prompt.md`), and the output of the agent in `output.txt` there. The run is **failed** when the agent ends with an error, or when it did not write the script.

## Limits

- **PowerShell commands.** On Windows, the mod finds a busy terminal through the child processes of the shell. A command that runs inside PowerShell (for example `Start-Sleep`) has no child process: the line waits and runs after it. A program with a window that the shell started (`Start-Process notepad`) is a child process too: the terminal is busy until the program closes, and the actions open a new tab.
- **Text that you type in the terminal.** Herdr holds a line while you type in the target terminal: the line comes when you press Enter or clear your text, at most 60 s after your last key there. Then the line goes after the text at the prompt. The mod clears the prompt first (Esc in PowerShell, Ctrl+U in the other shells), but text that you type during the wait stays. When the line waits more than 3 s, a toast says so: do not type in that terminal until the line comes.
- **No command palette entries.** A mod cannot add entries to the command palette. Use the list or a key.

## Files

- `~/.config/herdr-app/data/quick-actions.json`: the actions. You can edit it by hand; the list reads it again.
- `~/.config/herdr-app/data/quick-actions/runs/`: the run files.
- `~/.config/herdr-app/data/quick-actions/output/`: the output of the last background run of each action.
- `~/.config/herdr-app/data/quick-actions/run-log.json`: the steps of the last 15 runs (the target terminal, busy or free, the line, the result of `hc send`, the error). When a run does nothing, this file tells why.
- `shared("quick-actions.jobs")`: the state of the last background run of each action.
- `~/.config/herdr-app/data/quick-actions/scripts/`: the script files that an agent writes (the default **Script folder**).
- `~/.config/herdr-app/dock/panels.json`: the mod writes 1 entry for each pinned action, with the id `qa-<id>`, `"group": "quick-actions"` and `"section": "pinned"`, at the end of the list. It adds `"group": "quick-actions"` to the **Actions** entry (the id `quick-actions`), so both share 1 button. It changes no other entry.
- `shared("dock.hiddenEntries")`: `{ "quick-actions": [ "qa-<id>" ] }`, the buttons that the bars leave out now.

## What it runs

- `hc keys` (Esc or Ctrl+U, to clear a draft at the prompt), `hc send` and `hc read` on the terminal that gets the line, and `hc put` to copy a run file to another machine.
- A background run: `hc run --bg` (on the machine of the space), then `hc get` each second, `hc read` for the output, `hc kill` for Stop and the timeout, and `hc rm` at the end.
- `git rev-parse --show-toplevel` and `git branch --show-current` in the folder of the terminal, only when the script or its filter needs `{repo}`, `{repo_name}` or `{branch}`.
- On Windows, `pwsh` (or `powershell`) with `Get-CimInstance Win32_Process`, to see if the shell runs a command, and once for each machine `Get-Command` and `Test-Path`, to find Git Bash and Python.
- `python`, `python3`, `py`, `node`, `bash` or `pwsh`, when an action in that language runs.
- On another machine, `sh` (`uname`, `$HOME`) or `pwsh` (`$HOME`) once, to know its system.
- **Write with an agent…** and **Change with an agent…**: the agent that you choose, in a new tab (`tab.new` with its command from Herdr's agent list), or in a new space on this computer (`space.new`) when the space is on another machine, with your account. **In the background**: its headless command (above) in `hc run --bg`, through `pwsh -NoProfile -File agent.ps1` (or `sh agent.sh`). It makes the script folder first (`pwsh New-Item` or `mkdir -p` when the folder is outside your home folder).

No network of its own. The mod runs only the scripts that you write or ask for, and only when you start them.
