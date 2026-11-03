# Agent Resume

A mod for the Herdr app. It starts your Claude Code sessions again after a
reboot of Windows (or a restart of herdr-core).

After a reboot, herdr-core keeps your tabs and panes, but each lost terminal
gets an empty shell in its last folder. The agent does not come back. This mod
types `claude --resume <session id>` in each of these shells, so every Claude
Code session continues where it stopped.

![Agent Resume](preview.png)

## What you see

- **The indicator**, at the right of the status bar: a green dot and
  `Resume on · 2 sessions` (the count of terminals with a recorded Claude
  session). When you turn auto resume off, the dot is gray and the text is
  `Resume off`. After a resume, it adds `↻ <n>`.
- **The panel**: click the indicator, or run the mod command
  `agent-resume.panel` (bind it in `keys.json`, for example
  `"global": { "ctrl-alt-r": "agent-resume.panel" }`, or run
  `herdr-app do agent-resume.panel`).

  ![Agent Resume panel](preview-panel.png)

  - **Auto resume**: on or off. Off stops the automatic resume. The labels
    stay, so you can turn it on again later.
  - **Shell wait**: 1 to 30 s (default 4 s). The time a new shell gets before
    the mod types in it.
  - **Toast**: on or off. The notification after a resume.
  - **Monitored sessions**: one row for each recorded terminal: its place, its
    address, the start of the session id, the flags and the state:
    `active` (Claude runs), `waiting for resume` (a new shell),
    `resume failed` (the command ran, Claude did not start), `stopped`
    (Claude ended in the same shell without `/exit`). **Resume** types the
    resume command now (only into a shell). **Forget** removes the labels.

  The settings are in `shared("agent-resume.config")`, so they stay after a
  restart of the app.
- After a resume, a toast: "2 Claude sessions resumed", with the place of each
  terminal.

## How it works

2 parts work together:

1. **A Claude Code hook** (`hooks/herdr-claude-resume.ps1`).
   - `SessionStart`: writes 2 labels on the herdr-core terminal
     (`HC_TERMINAL_ID`): `claude.session=<id>`, `claude.pid=<shell pid>` and
     `claude.args=<flags>`. It skips `claude -p` and sub-agents.
   - `SessionEnd`: when you exit Claude (`/exit`, reason `prompt_input_exit`
     or `logout`), removes the labels. Other reasons (for example a Windows
     shutdown) keep them.
2. **The `agent-resume` mod** (`mods/agent-resume`). Every 3 s it looks for a
   live terminal that has `claude.session`, no agent status and a shell pid
   that is different from `claude.pid`. A different pid means that the shell
   is new: the old one was lost. After the shell wait (default 4 s), the mod writes
   `claude.tried=<id>` and types `claude --resume <id>`. The mark stops a
   second try if the resume fails. The next `SessionStart` removes it.

The mod runs programs: it calls `hc get`, `hc label` and `hc send`. It does
not use the network and reads no files.

## Install

Copy and paste this prompt to your agent:

`Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/dougcunha/herdr-plugins/tree/main/agent-resume-app`

Or do it by hand:

1. Copy `mods/agent-resume/` to `~/.config/herdr-app/mods/agent-resume/`
   (`mod.json` first).
2. Copy `hooks/herdr-claude-resume.ps1` to `~/.claude/hooks/`.
3. Add the hooks to `~/.claude/settings.json`:

   ```json
   "hooks": {
     "SessionStart": [{ "matcher": "^(startup|resume|clear|compact|fork)$", "hooks": [
       { "type": "command", "timeout": 10,
         "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\\Users\\<you>\\.claude\\hooks\\herdr-claude-resume.ps1\" start" } ] }],
     "SessionEnd": [{ "hooks": [
       { "type": "command", "timeout": 10,
         "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\\Users\\<you>\\.claude\\hooks\\herdr-claude-resume.ps1\" end" } ] }]
   }
   ```

   Keep the hooks that you have already. Add these beside them.
4. Put the mod in your layout. The mod must be in a shown block to run. For
   example, replace the `status` block of the layout with a row:

   ```json
   { "id": "status-row", "type": "row", "size": { "px": 28 }, "resizable": false,
     "children": [
       { "id": "status", "type": "block", "content": { "mod": "workspace-status" } },
       { "id": "agent-resume", "type": "block", "content": { "mod": "agent-resume" }, "size": { "px": 190 } } ] }
   ```

   Herdr's own layouts are read-only: clone one first (`layout.clone`).
5. Run `herdr-app check ~/.config/herdr-app/mods/agent-resume`.

Only sessions that start after the install are recorded. Start Claude again in
each open terminal (or run `/resume` in it) to record the session.

## Limits

- Claude Code only. Other agents need their own hook and resume command.
- The hook keeps the flags of the `claude` command (for example
  `--dangerously-skip-permissions`, `--model opus`) in the label
  `claude.args`, and the mod uses them again. It drops the session flags
  (`--resume`, `--continue`, `--session-id`) and any prompt text.
- `claude -p` (print mode) is not recorded.
- Claude asks to trust the folder again if the folder is not trusted.
- The hook is for Windows (PowerShell). On macOS or Linux, write the same hook
  in sh.
