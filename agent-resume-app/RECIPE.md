# Agent Resume

A small block at the left of the status bar. After a reboot of Windows (or a
restart of herdr-core), it types `claude --resume <id>` in each shell that
replaced a lost Claude Code terminal, and shows a toast.

![Agent Resume](preview.png)

## What you see

- In the status bar, at the left, a block of 150 px, 28 px high: background
  `chrome`, top border 1 px `border`, text 11.8 px `muted` (`foreground` on
  hover), items at the left with 14 px left padding (the same as
  `workspace-status`), no right padding and a 6 px gap. The width fits the
  text, so the gap to the next item is near the 16 px gap of `workspace-status`.
- The block shows a dot of 7 px (`ansi2` when auto resume is on, else `dim`)
  and `Resume on · <n> sessions` or `Resume off`. Its tooltip says if the mod
  is on and how many sessions the last resume started.
- The panel (a popup of 420 × 460 px, background `popover`, text 12.5 px):
  - Header: a dot of 8 px, "Agent Resume" in semibold 13.5 px, a `✕` button.
    Border below.
  - "SETTINGS" (11 px, semibold, `muted`), then 3 rows with a title and a
    hint (11.5 px, `dim`) at the left and a control at the right:
    "Auto resume" (a switch 34 × 18 px: `accent` track with an
    `accent_foreground` knob at the right when on, `input` track with a
    `muted` knob at the left when off), "Shell wait" (`−`, `<n> s`, `+`,
    buttons 22 px with a `border`) and "Toast" (a switch).
  - "MONITORED SESSIONS (<n>)", then a scroll list of cards (`surface`, 1 px
    `border`, radius 6): a dot and the `where` label in semibold, then
    `<address> · <8 first characters of the id> · <flags>` in `dim`, then the
    state in its color: `active` (`ansi2`), `waiting for resume`
    (`working`), `resume failed` (`blocked`), `stopped` (`dim`). At the
    right: "Resume" (`solid`, not shown when active) and "Forget" (`raised`).
  - Footer (11.5 px, `dim`, border above): the result of the last button, or
    "Sessions that started before the hook was installed are not recorded."

## How it behaves

- Every 3 s the mod reads `terminals()`. It ignores a terminal that has an
  agent status (any of working, blocked, done, idle): an agent runs in it.
- For a live terminal with the label `claude.session`, no status and no
  `claude.tried` equal to the session, it runs `hc get <t> --json`. It
  continues only if the `pid` is different from the label `claude.pid` and the
  foreground program is a shell (pwsh, powershell, cmd, bash, zsh, fish, sh,
  dash, nu).
- It waits until it has seen that shell pid for the shell wait (default 4 s).
  Then it runs `hc label <t> claude.tried=<id>` and
  `hc send <t> "claude <claude.args> --resume <id>"`.
- When auto resume is off, the scan does nothing.
- After one scan with 1 or more resumes, it posts one toast:
  "Claude session resumed" or "<n> Claude sessions resumed", level success,
  8 s, body = the `where` labels.
- A click on the indicator opens the panel at the pointer. The mod command
  `agent-resume.panel` (from `nextCommand()`) opens it as a dialog.
- The panel reads `hc get` of each recorded terminal every 2 s, while it is
  open. A switch or a stepper writes `shared("agent-resume.config")`
  (`{enabled, settleMs, toast}`), and every copy renders again.
- "Resume" types the resume command now, only into a live shell with no agent
  status. "Forget" removes the 4 labels. The footer shows the result.

## Built from

- `mods/agent-resume/`: `mod.json` (`{"place":"none"}`), `main.js` (the
  indicator and the scanner), `panel.js` (the panel), `resume.js` (config,
  states, resume and forget, used by both).
- One mod, 2 roles: the panel is the same mod opened with
  `openOverlay({mod: "agent-resume", kind: "popup", at: "pointer", props: {panel: true}})`.
  The copy reads `props().panel` in `init` and starts no scanner.
- Layout: a `row` of 28 px that holds an `agent-resume` block of 150 px
  (first, at the left) and the `status` block (`workspace-status`).
- `herdr` functions: `terminals`, `hc`, `notify`, `theme`, `props`,
  `openOverlay`, `closeOverlay`, `nextCommand`, `shared`, `setShared`.
- `hooks/herdr-claude-resume.ps1`, a Claude Code hook:
  - `start` (SessionStart): finds the `claude.exe` process above the hook
    (Win32_Process parents) and reads its command line. It stops if the line
    has `-p` or `--print`. It keeps the flags, without `--resume`, `-r`,
    `--continue`, `-c`, `--session-id`, `--fork-session`, `--from-pr` and
    without prompt text. Then `hc get $env:HC_TERMINAL_ID --json` and
    `hc label <t> claude.session=<id> claude.pid=<pid> claude.args=<flags> claude.tried=`.
  - The mod types `claude <claude.args> --resume <id>`.
  - `end` (SessionEnd): only for reason `prompt_input_exit` or `logout`, and
    only when the label is the same session: removes the 3 labels.
  - It does nothing outside herdr-core (no `HC_TERMINAL_ID`) and for
    sub-agents (`agent_id` in the input).

## Watch out

- herdr-core keeps labels and the address of a lost terminal, but gives it a
  new shell. There is no field that says "recovered": the pid change is the
  signal. `reason` stays null on the new shell.
- `hc send` from an agent terminal wraps the text in `<hc from="...">` tags
  when the target is an agent. The mod runs from the app, without
  `HC_TERMINAL_ID`, so the shell gets plain text.
- After you exit Claude, the terminal status goes back to null. Without the
  `SessionEnd` hook, the next reboot resumes a session that you closed.
- A `claude -p` run inside a Claude terminal also fires SessionStart with
  the same `HC_TERMINAL_ID`. Without the `-p` check, it replaces the label of
  the interactive session.
- An overlay copy gets its props from `props()`. The first argument of
  `init` is empty for it. With `init(p)` the panel shows the indicator, and
  a second scanner starts.
- `herdr-app check` renders only the layout role. To check the panel role,
  check a temporary copy that always takes the panel branch.
- A mod runs only in a shown block. A hidden block never starts.
- `claude --resume` keeps the same session id. The hook writes the labels
  again with the new pid, and removes `claude.tried`.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/agent-resume` passes.
- The status bar shows a green dot and `Resume on · <n> sessions`, and `<n>`
  grows by 1 when you start Claude in a terminal.
- `herdr-app do agent-resume.panel` opens the panel. The current Claude
  session is in the list as `active`. "Auto resume" off turns the dot gray and
  shows `Resume off`.
- `hc get <t> --json` of a Claude terminal shows `claude.session` and
  `claude.pid`.
- `/exit` in Claude removes the labels.
- A test shell started with `hc run --bg --keep --label claude.session=<id>
  --label claude.pid=1 -- pwsh` in the folder of session `<id>` gets
  `claude --resume <id>` in about 7 s, and the toast shows.
- After `hc server restart`, each Claude session comes back in its pane.
