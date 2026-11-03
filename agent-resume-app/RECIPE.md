# Agent Resume

A small block at the right of the status bar. After a reboot of Windows (or a
restart of herdr-core), it types `claude --resume <id>` in each shell that
replaced a lost Claude Code terminal, and shows a toast.

![Agent Resume](preview.png)

## What you see

- In the status bar, at the right, a block of 150 px, 28 px high: background
  `chrome`, top border 1 px `border`, text 11.8 px `muted`, items at the right
  with 10 px side padding and a 6 px gap.
- The block shows `↻` (color `accent` when 1 or more sessions are recorded,
  else `dim`) and `<n> Claude tracked`. After a resume it shows `<n> resumed`.

## How it behaves

- Every 3 s the mod reads `terminals()`. It ignores a terminal that has an
  agent status (any of working, blocked, done, idle): an agent runs in it.
- For a live terminal with the label `claude.session`, no status and no
  `claude.tried` equal to the session, it runs `hc get <t> --json`. It
  continues only if the `pid` is different from the label `claude.pid` and the
  foreground program is a shell (pwsh, powershell, cmd, bash, zsh, fish, sh,
  dash, nu).
- It waits until it has seen that shell pid for 4 s. Then it runs
  `hc label <t> claude.tried=<id>` and `hc send <t> "claude --resume <id>"`.
- After one scan with 1 or more resumes, it posts one toast:
  "Claude session resumed" or "<n> Claude sessions resumed", level success,
  8 s, body = the `where` labels.
- There are no clicks or keys.

## Built from

- `mods/agent-resume/main.js` and `mod.json` (`{"place":"none"}`).
- Layout: a `row` of 28 px that holds the `status` block
  (`workspace-status`) and an `agent-resume` block of 150 px.
- `herdr` functions: `terminals`, `hc`, `notify`, `theme`.
- `hooks/herdr-claude-resume.ps1`, a Claude Code hook:
  - `start` (SessionStart): `hc get $env:HC_TERMINAL_ID --json`, then
    `hc label <t> claude.session=<id> claude.pid=<pid> claude.tried=`.
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
- A mod runs only in a shown block. A hidden block never starts.
- `claude --resume` keeps the same session id. The hook writes the labels
  again with the new pid, and removes `claude.tried`.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/agent-resume` passes.
- The status bar shows `↻ <n> Claude tracked`, and `<n>` grows by 1 when you
  start Claude in a terminal.
- `hc get <t> --json` of a Claude terminal shows `claude.session` and
  `claude.pid`.
- `/exit` in Claude removes the labels.
- A test shell started with `hc run --bg --keep --label claude.session=<id>
  --label claude.pid=1 -- pwsh` in the folder of session `<id>` gets
  `claude --resume <id>` in about 7 s, and the toast shows.
- After `hc server restart`, each Claude session comes back in its pane.
