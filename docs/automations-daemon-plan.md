# Plan: the `automations` daemon

Status: decisions agreed on 2026-11-13. No code yet.

This plan follows `docs/automations-plan.md` (the mod as it is today).

## Goal

Run the automations without the Herdr app open. Then add resident agents:
agents that are always available and take messages from the Herdr app and from
Slack (other channels later).

## Why it is feasible

- `herdr-core` (`hc`) is a server separate from the app. It keeps terminals
  alive with the app closed. Its API has `terminal.run`, `terminal.send`,
  `terminal.wait`, `terminal.read`, `events.subscribe`, `machine.exec` and
  `file.read|write|edit`, also on other machines (`--on <machine>`).
- The headless agent of the mod already starts through `hc run`
  (`shell.js`, `startHeadless`).
- Only these parts need the app today: the trigger loop (`cx.timer`), the
  lease and the run state in `shared()`, `exec` for the scripts, `watchFolder`,
  `notify`, `run("tab.new" | "space.new")`, `spaces()`, `panes()`, `agents()`
  and `knownAgents()`.
- `shared()` is not a channel for an outside process: only the app writes
  `shared.json`.

## Phases

1. **Phase 1:** the automations of today run in a daemon, without the app.
   The mod becomes a client of the daemon.
2. **Phase 2:** resident agents, with Slack as the first channel.

## Decisions

| Topic | Decision |
| --- | --- |
| Runner | 1 Node daemon replaces the runner of the app. No second engine in the mod. |
| Topology | 1 central daemon on a "home" machine. It runs each automation on the machine of the automation through `hc --on`. 1 list of automations, 1 Slack connection. |
| Home machine | Configurable in the setup. Default: the PC where the Herdr app runs. The mod keeps the name of the home machine in a preference (`shared()`, shown in the Settings tab of `mods-hub`). |
| Life of the daemon | A core terminal (`hc run --keep --name automations …`) and a login entry (Task Scheduler on Windows, systemd user unit on Linux) that starts it. |
| UI channel | The daemon has a control command (`ctl list|run|stop|save|history|send …`). The mod calls it through `hc exec [--on <home>]`. The same command serves the shell and Slack. No open port. |
| Code | `automations-app/daemon/` in this repository. The mod and the daemon change in the same commit, with the same setup version. |
| Dependencies | None. Node 22+ only (`fetch` and `WebSocket` are built in). |
| No daemon | The mod shows "No daemon" and a button that installs and starts the daemon. Without the daemon, nothing runs. `whats-new` tells the person. |
| Tab mode | Stays. The daemon starts the interactive agent with `hc run --keep` and the labels `herdr.space` and `herdr.tab`. With the app closed, the tab shows when the app opens. |
| Notifications | A target for each automation: Herdr, Slack or both, with a global default. The mod shows toasts from the events of the daemon while the app is open. |
| Slack transport | The person's own Slack app with Socket Mode (the daemon opens the connection; no public URL). |
| Slack access | A list of permitted user IDs for each resident agent. The daemon ignores and logs all other messages. |
| Slack mapping | 1 channel for each resident agent. A new message in the channel starts a new session; replies in the thread continue the same session. Automations take fixed commands (`run`, `stop`, `status`) in a control channel. |
| Resident agent | 1 headless run for each message, on the same session (`claude -p --resume <session>` or the equivalent). The person can open the same session in a Herdr tab with `--resume`. |
| Permissions | A fixed profile for each resident agent: machine, folder and permission arguments, set only in the UI. A message cannot change the profile. The agent reports in Slack what the profile does not permit. |
| Secrets | `data/automations-secrets.json` on the home machine, readable by the user only. The UI writes the tokens through `ctl` and never reads them back (it shows "configured"). Never in `automations.json`. |
| Channels | A small interface for each channel (connect, receive a message, send a reply). Only `slack.js` in phase 2. |

## Limits and risks

- **Logout and reboot:** the core does not keep running after logout
  (`hc server status` gives `keeps_running_after_logout: null` on Windows). A
  reboot stops the runs until the next login.
- **Home machine off:** nothing runs on any machine.
- **Files trigger on a remote machine:** polling, not events.
- **Resident agents:** only agents with resume in headless mode. Claude Code
  has it; the other agents are not checked.
- **Security:** each permitted user runs commands on the machine of the agent,
  inside the profile. The README says "No network" and "This computer only";
  both texts change.
- **Kit:** the daemon is a new kind of artifact for a kit that installs by file
  copy. It needs install, update, on/off (`herdr-mods.disabled`) and
  `SETUP-PROMPT.md` steps.

## To test before the code

1. The app adopts a terminal with the labels `herdr.space` and `herdr.tab`
   that the daemon started while the app was closed.
2. `engine.js`, `schedule.js` and `store.js` run in Node behind an adapter for
   the `herdr` module (`exec`, `hc`, files, state in files instead of
   `shared()`).
3. The "Agent status" trigger works with `hc events`, without `agents()` of
   the app.
4. Which agents other than Claude Code can resume a session in headless mode.

## Open for the start of phase 1

- The format of the `ctl` commands and their JSON output.
- The new fields of `automations.json`: `machine`, the notification target.
- How the mod gets live changes from the daemon (poll `ctl status`, or follow
  `hc events` on the labels of the daemon).
- The steps of the install button on Windows and on Linux.
