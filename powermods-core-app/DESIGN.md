# powermods-core: design

Status: built (setup version 49). Date: 2026-11-10.

`powermods-core` is a mod that gives shared services to the other mods of
this kit. The first service manages git worktrees.

## Problem

4 mods create worktrees today, and each mod does it in a different way:

| Mod | Folder of a new worktree | Setup after create |
|---|---|---|
| `git-client` | `<repo>-<branch>`, next to the repository | None |
| `issues`, `prs` | `~/.herdr/worktrees/<repo>/<branch>` | Copies the files of `.worktreeinclude` |
| `spec-board` | `<spec-board.worktreeRoot>/<repo>/<branch>` | Copies the spec folder |
| `kanban` | Herdr's own worktree dialog | Herdr decides |

The person cannot set 1 folder for all worktrees. No mod can run setup
commands, for example `npm install` or `npx` to install plugins.

## Goals

- 1 setting for the root folder of all new worktrees.
- 1 setup for each new worktree: copy common files, then run commands.
- 1 implementation of create, remove and list, used by every mod.

## Facts that decide the design

These facts come from tests in the app (Herdr app, 2026-11-10):

1. A mod cannot import a file from the folder of another mod.
   `herdr-app check` fails with
   `module ../other/lib.js resolves outside the application directory`.
2. `<mod>.<command>` is a plain string. It carries no arguments, and it
   reaches only a copy of the mod that is on the screen.
3. `globalThis` is shared by all mods. Mod B can call a function that mod A
   put on `globalThis`. The function can use `exec` and `setShared`, also
   after the copy of mod A closed.
4. The Herdr reference (`~/.config/herdr-app/AGENTS.md`) does not document
   fact 3. A future version of Herdr can isolate the mods.
5. Only the kit layouts (`main-dock`, `kanban`) have a status row. The Herdr
   layouts (`main`, `terminals`, `win98`) do not have one.

## Architecture

### A live service with a direct API

`powermods-core` is a status bar item. Its block is in the status row of
`main-dock` and `kanban`. The block keeps the mod loaded while the layout
shows.

In `init`, the core puts its API on `globalThis`:

```js
globalThis.powermods = {
  version: 1,
  alive,                       // true while a status copy runs the queue
  worktree: { create, remove, list, locate, pathFor, preview },
};
```

- The core puts the API again in every `init`. A reload of the mod replaces
  the old functions.
- A mod that calls the API first checks that `globalThis.powermods` exists and
  that `version` is equal to or higher than the version that it needs.
- If the check fails, the mod shows an error with an instruction: "PowerMods
  core is not running in this layout." The error has a button that opens the
  README. The mod does not create a worktree.

### Protection against fact 4

- The `version` field lets a mod refuse an old core.
- The README of the core tells the person that the API uses an undocumented
  behavior of Herdr.
- The request at the end of this file asks Herdr to document an API between
  mods, or to give one.

## API: `worktree`

### `create(request) → Promise<{ path, spaceId, copied, setup, done }>`

`request`:

| Field | Type | Meaning |
|---|---|---|
| `repo` | string | The main checkout of the repository. |
| `branch` | string | The branch of the worktree. The caller makes the name. |
| `base` | string, optional | The start point of a new branch. Default: `HEAD`. |
| `on` | string, optional | The machine. Default: this machine. |
| `path` | string, optional | A folder that the person typed. It replaces the central folder. |
| `space` | object, optional | `{ name }` of the new space. |
| `agent` | object, optional | `{ argv, task }`: the agent to start after the setup. |

The core does all the steps:

1. It finds the folder: `<root>/<repo name>/<slug of branch>`, or `path`.
2. It runs `git worktree add`. It uses `--track` when the branch is only on
   `origin`. On Windows, it sets `core.longpaths` when the person did not set
   it.
3. If step 2 fails, it removes the registered worktree and runs
   `git worktree prune`, so that a retry starts clean.
4. It opens a new space in the worktree.
5. It runs the setup (see "Setup").
6. If the setup ends with code 0, it starts the agent of `request.agent`.

The Promise resolves when the space shows: `setup` is `"none"` (no commands)
or `"running"`. `done` resolves when the setup ends: `{ ok, error? }`. A
dialog can close at once and does not wait for a long setup. The Promise
rejects with an `Error` that has a message for the person. When the setup
fails, the worktree and the space stay, and the core shows an error toast.

`request` also takes `prepare: async ({ path, main, on }) => void` (runs after
the copy, before the setup: Spec Board copies a spec there), and `agent` can
be an async function of `{ path, main, on }` (Spec Board finds the skill in the
new worktree).

`create` and `remove` go into a queue on `globalThis`. A status copy of the
core runs it with its own `cx`, so the job can sleep and wait.

### `remove({ path, on, force }) → Promise<void>`

1. It closes the space of the worktree, if a space is open.
2. It runs `git worktree remove` (with `--force` when `force` is true).
3. If the folder does not exist, it runs `git worktree prune`.

### `list({ repo, on }) → Promise<Worktree[]>`

It returns every worktree of the repository from
`git worktree list --porcelain`. Each item has `{ path, branch, central }`.
`central` is true when the worktree is in the central folder.

`locate(folder, on) → { repo, leaf } | null` is synchronous: `links.js`
(`issues`, `prs`) uses it in render to find the spaces of its agents.
`preview({ repo, branch })` gives the folder as text for a dialog.
`spec-board` finds its worktrees with `git worktree list` and needs no change.

The client file `client/core.js` is the same in every calling mod.
`node tools/sync-core-client.mjs` copies it, and `--check` compares.

## Settings

The `kit.json` of the core lists these settings. The **Settings** tab of
`mods-hub` shows them.

| Shared key | Default | Meaning |
|---|---|---|
| `powermods-core.worktreeRoot` | `~/.herdr/worktrees` | The root folder of new worktrees. |
| `powermods-core.filesFolder` | `~/.herdr/worktree-files` | Every file in this folder goes into each new worktree on this machine. |
| `powermods-core.run` | empty | Commands that run in every new worktree, 1 for each line. |

Rules:

- The default folder is the same as the folder of Herdr's own worktree mod.
  Then the Herdr sidebar shows the space under its repository. A different
  root folder stops this.
- The core reads the keys on every call, not once in `init`.
- The `kit.json` has `"required": true`. The **Mods** tab of `mods-hub`
  shows the core without an on/off switch. `mods-hub` must learn this field.

## Setup

### The file of the repository: `.herdr/worktree.json`

```json
{
  "copy": [".env", "config/local.json", "certs/*.pem"],
  "run": ["npm install"],
  "runWindows": ["npm install"]
}
```

- `copy`: globs of files that git ignores in the main checkout.
- `run`: commands. They run in the default shell of the terminal: `pwsh` on
  Windows, `sh` on other systems.
- `runWindows` (optional): it replaces `run` on Windows.
- The core also reads `.worktreeinclude` (the format of today). Its lines go
  into `copy`.

### Steps

1. Copy the files of `powermods-core.filesFolder`. Only on this machine.
2. Copy the files of `copy` and `.worktreeinclude` from the main checkout.
3. Run the commands of `powermods-core.run`.
4. Run the commands of `.herdr/worktree.json`.
5. Start the agent.

The copy never writes over a file that exists in the worktree.

### Where the commands run

- The commands run in a tab with the name "setup" in the new space
  (`hc run` and `hc wait`). The person sees the output and can answer a
  question of a command.
- If all commands end with code 0, the tab closes. The output stays in the
  dialog of the core.
- If 1 command fails, the next commands do not run. The tab stays open and the
  agent does not start.

### Trust

A cloned repository can contain commands of another person.

- Before the core runs the commands of `.herdr/worktree.json`, it shows them
  and asks the person.
- It asks the first time and again after each change of the file.
- It keeps the hash of each approved file in `shared("powermods-core.trusted")`.
- The commands of the settings run without a question.

### Other machines

When `on` names another machine:

- The core makes the worktree under `~/.herdr/worktrees` of that machine,
  or under the root folder of the settings.
- It runs steps 2, 3 and 4 there.
- It does not run step 1: the files folder is only on this machine.

## The status bar item

- It shows a small worktree icon.
- While a setup runs, it shows the number of setups that run.
- A click opens the Worktrees tab of the PowerMods dialog (`mods-hub`): the
  last worktrees that the core made, and the log of the setup of each one.

## Scope of version 1

Mods that use the core:

| Mod | Change |
|---|---|
| `issues`, `prs` | Start agent calls `create`. `copyIncludes` goes into the core. `links.js` calls `list`. |
| `spec-board` | Calls `create`. The key `spec-board.worktreeRoot` goes away. The copy of the spec folder stays in `spec-board`, after `create`. |
| `git-client` | Calls `create` and `remove`. A typed path still works (`path`). |
| `git-dash` | Calls `remove`. |

Not in version 1:

- `kanban` keeps Herdr's own worktree dialog.
- Worktrees that exist in other folders stay there. There is no migration.
  `git-client` and `git-dash` still show and remove them.

## Work in the repository

1. Make `powermods-core-app/mods/powermods-core/` with `mod.json`
   (`"place": "none"`, `"title": "PowerMods Core"`) before `main.js`.
2. Add `kit.json`, the README and `preview.png`.
3. Add the block of the core to the status row of `main-dock` and `kanban`.
4. Teach `mods-hub` the field `"required": true`.
5. Change `issues`, `prs`, `spec-board`, `git-client` and `git-dash`.
6. Increase `N` in `SETUP-PROMPT.md` and write `whats-new/<N>.md`.

## Request to the Herdr project

Text to send to the Herdr project:

> **Request: a documented way for mods to call each other**
>
> We maintain a kit of Herdr app mods. Several mods need the same service, for
> example "create a git worktree and run its setup". Today we found 3 ways to
> share code between mods:
>
> 1. `import "../other-mod/lib.js"`: `herdr-app check` refuses it ("resolves
>    outside the application directory").
> 2. `<mod>.<command>`: the command is a plain string with no arguments, and
>    it reaches only a copy that is on the screen. There is no reply.
> 3. `globalThis`: it is shared by all mods. A mod can put an object there and
>    another mod can call it, also with `exec` and `setShared`. But the
>    reference does not document this, so we do not know if it stays.
>
> We ask for one of these:
>
> - Document that `globalThis` is shared by all mods of a window, and say how
>   long an object on it stays (reload of the mod that made it, close of all
>   its copies).
> - Or give a small API: a mod exports functions (`export const api = {…}` or
>   `provide(name, object)`), and another mod gets them
>   (`await use("other-mod")`), with a version and a clear error when the mod
>   is not loaded.
>
> A second, smaller request: let a mod with `"place": "none"` start without a
> block in the layout (a background mod), so that a service does not need a
> status bar item to stay loaded.
