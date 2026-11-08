# Plan: the `automations` mod

Status: agreed on 2026-11-08.

## Goal

Run a coding agent with a prompt in a folder, when a trigger fires: a
schedule, a button, an agent status, a file change or a git change. A check
script can skip the run. A pre-script and a post-script run before and after
the agent.

## Structure

- App folder `automations-app`, mod `automations` (title "Automations").
- Bar block `automations-status` (`partOf: automations`) in the status bar of
  the `main-dock` and `kanban` layouts.
- A mod runs timers only while a copy is in a layout block. The bar block is
  the runner. Only 1 copy runs automations: the leader renews
  `shared("automations.leader")` every 15 s. The other copies show the status
  only. A copy takes the lead when the lease is older than 45 s.
- A click on the bar block opens the `automations` dialog: the list, the form,
  the history and "Run now". The dock also gets an `automations` panel.
- First version: this computer only (no remote machines).

## Data

- Definitions: `~/.config/herdr-app/data/automations.json`. People can edit
  the file by hand.
- History: `~/.config/herdr-app/data/automation-runs.json`, the last 50 runs
  of each automation: start, end, trigger, result (`ok`, `failed`, `skipped`,
  `timed out` + reason), the output of the check and the scripts, and the last
  200 lines of the agent.
- Run folder: `~/.config/herdr-app/data/automation-runs/<runId>/` with
  `result.md` (written by the agent) and `output.txt` (headless stdout). The
  mod deletes the folder when its run leaves the last 50.
- Run state (leader lease, last run of each automation, running runs):
  `shared()`.

## An automation

| Field | Values |
|---|---|
| `name`, `enabled` | text, on/off |
| `agent` | an id of `knownAgents()` |
| `mode` | `interactive` (a tab with `tab.new {argv, task}`) or `headless` |
| `headless` | built-in template of the agent, or a custom command with `{prompt}` |
| `folder` | a folder; optional fixed `space` |
| `prompt` | text with variables |
| `trigger` | see below |
| `check`, `pre`, `post` | a command or a script path; timeout (default 60 s, max 10 min) |
| `overlap` | `skip` (default), `queue` (1 waiting run), `parallel` |
| `catchUp` | false (default): skip missed schedule times; true: run 1 time when the runner starts |
| `tabEnd` | `keep` (default), `close-ok` (close when the post-script passed), `close` |
| `timeout` | interactive agent, default 60 min |
| `notify` | `failures` (default: failures and blocked), `all`, `skips`, `never` |
| `requireResult` | false (default); true: no `result.md` → `failed: no result` |

### Headless templates

`claude -p {prompt} --add-dir {run_dir}`, `codex exec {prompt}`,
`gemini -p {prompt}`, `opencode run {prompt}`, `copilot -p {prompt}`, or a
custom template. The run uses `hc run --bg` + `hc wait`, so the 10 min limit of
`exec` does not apply.

### Prompt variables

`{pre}` (stdout of the pre-script), `{check}` (stdout of the check),
`{folder}`, `{trigger}`, `{files}`, `{commit}`, `{date}`, `{result_file}`.
The scripts get the same values as `HERDR_AUTO_*` environment variables, and
the post-script also gets `HERDR_AUTO_STATUS`, `HERDR_AUTO_RESULT_FILE`,
`HERDR_AUTO_RESULT` (the first 8 KB) and `HERDR_AUTO_OUTPUT_FILE`.

## Triggers

- `schedule`: presets (every N minutes, daily at HH:MM, weekdays at HH:MM) or
  a 5-field cron. The form shows the next 3 times.
- `manual`: the button and the command `automations.run {id}`. Every
  automation can also run by hand.
- `agent`: an agent changes to `done` or `blocked`. Filters: the folder of the
  automation (or any folder), the app (`claude`, `codex`). 1 run for each
  change. Agents of automations (terminal label `automation=<id>`, or tabs that
  the mod started) do not fire it.
- `files`: `watchFolder` on the folder, optional glob, 5 s debounce.
- `git`: a new commit (HEAD changed) or a new branch, polled every 30 s.

## A run

1. Check: exit 0 continues. Other codes skip the run; stdout is the reason.
2. Pre-script: a failure cancels the run; stdout goes to `{pre}`.
3. Agent: interactive or headless. In interactive mode, `blocked` gives a
   toast and the run waits. At the timeout, the run is `timed out` and the
   tab stays open.
4. Post-script: gets the status and the result.
5. Tab end, toast, history.

Scripts run in `pwsh` on Windows and `sh` elsewhere, in the folder of the
automation.

## Kit rules

`kit.json` for both mods, `kitOff()`/`offView()`, `mod.json` with
`"place": "none"`, an entry in `dock/panels.json`, a new setup version,
`whats-new/<N>.md`, a preview from the template.
