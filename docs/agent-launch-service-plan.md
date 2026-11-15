# Agent launch service in `powermods-core`: analysis

Status: analysis only, no code. Date: 2026-11-13.

## Goal

Move the logic that starts a new agent into `powermods-core`, with 1 generic
dialog that every mod uses. The person gets the same look and the same options
in every mod: the agent, the account (personal or work), the model and effort,
and where the agent opens (new worktree, open space, new space).

## Conclusion

The change is feasible and recommended. The core already uses the necessary
pattern: it opens its own dialog for a job and gets the answer back through
`globalThis` (`askTrust` in `powermods-core-app/mods/powermods-core/worktree.js`).
1 point needs a test in the app before the work starts: an account together
with a first prompt (see "To test before the code").

## What exists today

8 flows start a new agent. Each flow has its own logic and its own interface.

| Flow | Agent choice | Account | Model and effort | Extra arguments | Editable prompt | Where it opens | Other machine |
|---|---|---|---|---|---|---|---|
| `issues`, `prs` (`agent-dialog.js`) | Cards | No | Yes | No | Yes, with modes | New worktree; open space only for an issue | Yes |
| `spec-board` (`actions.js`, `main.js`) | Only in Settings (`spec-board.agent`) | No | No | No | No | Automatic: the space of the folder, else a new space; or a worktree | Yes |
| `repo-launcher` (`launch.js`, `main.js`) | List | Yes | No | Yes (Settings) | No prompt | New or open space, tab or split | Yes, without accounts |
| `git-client` (`agent.js`, resolve conflicts) | Cards, other look | No | No | No | Yes | Always a new tab of the shown space | Yes |
| `kanban` (duplicate an agent) | Copies the agent of the card | No | Copies the flags | Copies | No | Tab in the same space, or Herdr's worktree dialog | Yes |
| `space-deck` (`overlays.js`, agents menu) | List | No | No | No | No | Tab in the space, or a new space | Yes |
| `automations` (`engine.js`) | In the form | No | No | Yes | In the form | The space of the automation, else a new space | No |
| `mods-hub`, `skill-bundles` | First installed, or a list | No | No | No | No | New space | No |

`agent-resume` is not in the list: it resumes sessions in terminals that exist.

Other differences:

- **Account:** only `repo-launcher` knows the accounts (`ACCOUNT_AGENTS` in
  `scan.js`, `agentArgv` in `launch.js`). No flow with a prompt uses an account.
- **Copied code:** `issues/agent-dialog.js` and `prs/agent-dialog.js` are
  identical (531 lines each). `git-client/agent.js` is a third, smaller copy.
- **Agent cache:** 3 shared keys (`issues.agents`, `git-client.agents`,
  `repo-launcher.agents`). Each mod reads the keys of the others as a fallback.
- **Last used agent:** `issues` keeps it in `localStorage` (1 value for each
  copy of the mod). `git-client` keeps it in `shared()`.
- **Space of a repository:** `repo-launcher` (`spacesFor`) and `spec-board`
  (`spaceFor`) have 2 different functions for the same question.

## Design of the service

1. The mod calls `powermods.agent.start(request)` through `client/core.js`.
2. The core keeps the `request` on `globalThis` with an id.
3. The core opens its dialog with `props: { part: "agent", job: id }`.
4. The dialog reads the `request`. The person chooses. The core starts the agent.
5. The call returns a Promise with the result, or with the cancel.

The `request` carries what belongs to the mod (functions cannot go in `props`):

- The header: icon, key and title.
- The modes and the prompt of each mode, or a function that makes the prompt.
- The permitted targets, for example `["worktree", "space"]`. `prs` gives only
  `["worktree"]`: its prompts reset the branch of their folder.
- The suggested branch for each mode.
- The `prepare` and `agent` functions that `spec-board` uses today.

The dialog always shows the same blocks: agent, account, model and effort,
target, prompt, and "switch to the space".

The core also owns: the detection of accounts, the argv with the account
wrapper, 1 agent cache for each machine, and the last used agent in `shared()`.

## Advantages

- 1 look and 1 set of options in all mods.
- The account, the model and the reuse of a space become available in all
  flows at the same time.
- 1 agent cache and 1 "last used" value.
- Less code: about 1,100 lines go out of `issues`, `prs` and `git-client`.
- A new option (for example a new agent in `OPTIONS`) goes in 1 place.

## Risks and limits

- **Account with a prompt:** the account wrapper replaces the `argv` with
  `pwsh -Command "$env:CLAUDE_CONFIG_DIR=…; & claude"` (Windows) or
  `env NAME=dir claude` (other systems). The Herdr reference says only
  "task: its first message" and has no field for environment variables. No mod
  uses the wrapper together with `task` today.
- **Accounts on another machine:** the detection uses `fs.readdir` on the local
  home folder. On a remote machine, the dialog has no account choice, or the
  core finds the accounts with `exec`.
- **Layout without the core:** the core runs only where its status block is.
  Today `repo-launcher`, `space-deck` and `git-client` start agents in every
  layout. If they need the core, they stop in Herdr's `main` layout.
- **API that Herdr does not document:** the service adds to the use of the
  shared `globalThis`. The risk exists already for the worktrees.
- **The "Default" of the model:** `agentDefaults` reads
  `~/.claude/settings.json`. With another account, it must read the folder of
  that account.
- **Rules of the domain:** modes, templates and the trust of
  `.herdr/prompts.md` stay in the mods. The dialog knows nothing about an issue
  or a pull request.

## To test before the code

1. Start an agent with the account wrapper and a `task`
   (`tab.new { argv: <wrapper>, task }`) on Windows. Does Claude get the
   prompt? If not, the core puts the prompt inside the wrapper command.
2. Can a dialog copy of the core start an agent in an open space when no
   status copy runs (a layout without the block)?

## Phases

1. Do the 2 tests above.
2. Add `agent.start` to the core (API version 2) and move `issues` and `prs` to
   it. Their dialog is the base: it is the most complete one.
3. Move `spec-board`. It gets the choice of agent, account and target.
4. Move `git-client` (resolve conflicts).
5. Move only the logic (accounts, `agentArgv`, agent cache) of `repo-launcher`
   and `space-deck` to the core. They keep their own interface: they are quick
   menus, not dialogs.
6. Keep `kanban` (duplicate), `automations`, `mods-hub` and `skill-bundles`
   out. They ask the person nothing.

Each phase that changes a mod needs: `node tools/sync-core-client.mjs`, a new
setup version in `SETUP-PROMPT.md`, and `whats-new/<N>.md`.

## Open decisions

- In a layout without the core: does the mod show an error, or keep a simple
  fallback path?
- Does `repo-launcher` use the dialog of the core, or only its logic?
- Do the calls without a terminal (`tab-namer`, `git-client/ai.js`) follow the
  chosen account? Today they always use the default account.
