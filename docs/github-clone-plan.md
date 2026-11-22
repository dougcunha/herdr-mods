# Plan: the `github-clone` mod

Status: design agreed in the grilling session of 2026-11-22 (4 rounds).
Phase 1 done on 2026-11-22 (setup version 125). Phase 2 next.

## Goal

Give the person a dialog that lists the GitHub repositories of the
authenticated account, filters them by owner and by a fuzzy text, and clones
one into a default folder. The clone can run on this computer or on another
machine of `hc machine ls`. A second tab searches the public repositories of
GitHub.

The mod only clones. To open a repository, the person uses `repo-launcher`.

## Names

- Mod: `github-clone`. App folder: `github-clone-app`. Title: "GitHub Clone".
- Shared keys start with `github-clone.`.

## Glossary

| Term | Meaning |
| --- | --- |
| **Repo list** | The repositories of the account on the **source machine**: owner, collaborator and organization member (`GET /user/repos`). |
| **Source machine** | The machine that the machine picker of the dialog shows. Its `gh` gives the repo list, and the clone runs there. `null` is this computer. |
| **Owner chip** | A filter button for 1 owner: the user or 1 organization. **All** shows every owner. |
| **Clone root** | The default folder for clones on 1 machine. |
| **Owner rule** | An optional override of the clone root for 1 owner on 1 machine (for example `my-work-org` → `D:/Projetos`). |
| **Destination** | `<clone root or owner rule folder>/<repo name>`. The clone step shows it, and the person can edit it. |
| **Clone step** | The part of the dialog after the person selects a repository: destination, branch, shallow switch and the Clone button. |
| **Cloned repo** | A repository of the list whose destination folder exists on the source machine. |
| **Search tab** | The **GitHub** tab of the dialog: `gh search repos` over all public repositories. The other tab is **Mine**. |

## Facts found during the session

- `exec(cmd, args, { on: machine })` runs a program on another machine through
  herdr-core. `gh` is authenticated and `git` is installed on this computer,
  on `notebook` and on `wsl`.
- The git protocol of `gh` changes per machine: this computer and `notebook`
  use SSH, `wsl` uses HTTPS. `gh repo clone` follows the setting of the
  machine where it runs.
- The account has 165 repositories in 3 owners (51, 111 and 3). The full list
  (`--paginate`, 100 per page) takes about 3 s. 32 are forks and 2 are
  archived.
- The account is a member of 4 organizations, but only 2 of them have
  repositories in the list. The probable cause is an organization with SAML
  SSO that the token is not authorized for.
- A silent `exec` has a 10-minute cap and no input. A passphrase, host-key or
  credential prompt stops it.
- Spike of 2026-11-22: `space.new` with a folder and no `argv`, then
  `hc send <terminal> "git init demo && cd demo"`. The line runs in the
  interactive shell itself, so `cd` moves that shell. It worked in PowerShell
  on this computer and in bash on `wsl`. The unnamed space took the name of
  the new repository. (A child process in `argv` cannot move the shell.)
- The list call works on `notebook` through herdr-core: the `&` of
  `user/repos?per_page=2&affiliation=owner` keeps its meaning.
- `tabs-dock` and `kanban` hide a `panels.json` button with
  `run: "mod.open"` when `args.name` is in `herdr-mods.disabled`
  (`entryMod`).
- `repo-launcher` does not check that the folder of a cache entry exists. It
  checks only its roots.
- `repo-launcher` has parts that this mod can copy: `fuzzy.js` (fuzzy match
  with highlights), root folders per machine (`repo-launcher.settings.roots`
  and `.remoteRoots`) and the repository cache (`repo-launcher.cache`).
- The `mods-hub` Settings tab has the field types `folder-list` and
  `folder-map` (`{ name, folder }` rows), but no field with a machine and an
  owner in the same row.
- `gh search repos` takes qualifiers (`topic:`, `org:`, `user:`,
  `language:`, `stars:`), `--sort stars|forks|updated|help-wanted-issues`
  and `--limit` (default 30). GitHub "tags" of a repository are its topics.
- `alt-g` is free in the `global` section of `keys.json` today.

## Decisions

### Round 1

1. **The clone runs in a visible terminal.** The mod opens a new space on the
   source machine and runs `gh repo clone` there. The person sees the progress
   and can answer a prompt. The clone continues when the dialog closes.
   *Why:* a silent `exec` stops on a prompt, has a 10-minute cap and loses its
   result when the dialog closes.
2. **The `gh` of each machine gives the repo list.** The machine picker of the
   dialog selects the source machine. The list comes from the active `gh`
   account of that machine, and the clone runs there with the same account. The mod keeps 1
   cache per machine.
   *Why:* a machine can have another account than this computer; its own
   `gh` lists only what that account can clone.
3. **The repo list has every affiliation, with chips.** Owner, collaborator
   and organization member. Chips: **All**, the user, and 1 chip for each
   organization. Forks have an icon. Archived repositories are hidden; an
   **Archived** chip shows them. The list is cached in `shared()`, with a
   Refresh button.
4. **The clone folder is per machine, with owner rules.** 1 clone root per
   machine and optional owner rules per machine. Destination:
   `<folder>/<repo name>`. The clone step shows the destination and lets the
   person edit it.
   *Why:* the folder picker of the system works only on this computer, and a
   Windows path has no meaning on `wsl`. The person keeps work and personal
   repositories in different folders.
5. **Public search is a tab of the same dialog (phase 2).** A **Mine |
   GitHub** switch at the top. On **GitHub**, the text goes to
   `gh search repos` after a pause in the typing. The text takes qualifiers,
   and chips help to write them. The clone step is the same.
6. **Light integration with `repo-launcher`.** The mod adds the repository to
   `repo-launcher.cache`, so `Ctrl+P` finds it at once. The mod works without
   `repo-launcher`.
   *How (round 4 fix):* the dialog closes when the clone starts, so no copy of
   the mod is alive when the clone ends. The mod writes the cache entry when
   the clone starts and keeps it in `github-clone.pending`. The next time the
   dialog opens, it removes the entries whose folder does not exist (a clone
   that failed or that the person stopped).
7. **The decisions go in this file**, updated after each round.

### Round 2

8. **The clone terminal opens in a new space, in focus.** `space.new` on the
   source machine. The dialog closes and the new space shows. After the clone,
   the shell of the terminal is in the destination folder. Nothing else
   starts: to open an agent, the person uses `Ctrl+P`.
   *How (round 4 fix, from the spike):* 1 `exec` makes the parent folder of
   the destination on the source machine. `space.new {machine, folder:
   <parent>}` with no `argv` starts the shell there. The mod finds the new
   terminal (`run()` returns null: compare `terminals()` before and after)
   and sends 1 line with `hc send`:
   `gh repo clone '<owner>/<name>' '<destination>' -- [--branch '<b>'] [--depth 1] && cd '<destination>'`.
   Single quotes and `&&` work in bash, zsh and fish. Windows PowerShell 5.1
   has no `&&`, so Windows gets
   `gh repo clone … ; if ($?) { Set-Location -LiteralPath '<destination>' }`.
   On an error, the shell stays in the parent folder, and the error stays on
   the screen.
9. **A cloned repo does not open.** Its row shows a "cloned" mark. Enter shows
   a warning that the destination exists and offers a clone into another
   folder.
   *Why:* the mod only clones; `repo-launcher` opens repositories.
10. **3 entry points**, plus the command palette (`mod.open:github-clone`):
    - the key `alt-g` in `keys.json`, with a `key` field in the hub Settings
      tab to change it;
    - a `dock/panels.json` entry with `opens: "command"`, `run: "mod.open"`:
      a button in the Dock bar and in the Kanban bar;
    - a GitHub button in the header of `repo-launcher` (a change in
      `repo-launcher`; the button hides when `github-clone` is not installed or
      is off).
11. **The folders have their own settings view.** A gear in the dialog opens
    it: 1 clone root per machine and the owner rules. The hub Settings tab
    shows an "Open GitHub Clone" button that opens the dialog, with a hint
    that the folders are behind its gear (like `repo-launcher`: the hub runs
    exactly 1 command, so it cannot open the folders view directly). On the
    first clone on a machine with no clone root, the clone step suggests the
    first `repo-launcher` root of that machine and offers "Save as default".
12. **The clone step has destination, branch and shallow.** The machine comes
    from the picker. The branch defaults to the default branch of the
    repository. The shallow switch adds `--depth 1`. A fork gets its
    `upstream` remote from `gh repo clone`.
13. **The fuzzy filter matches owner and name** (`owner/name`). Words that a
    space separates can match different parts, as in `repo-launcher`.

### Round 3

14. **The branch field has suggestions.** The default branch is in the field
    when the clone step opens. When the person types, a list shows the
    branches that match: the first 100 of the API, read when the step opens.
    A name that is not in the list is valid too.
15. **The list order is Name by default, and the person can change it.** A
    sort selector in the dialog: Name (`owner/name`), Last push
    (`pushed_at`), Owner then name. The choice is a preference: shared key
    `github-clone.order`, with an `enum` field in the hub Settings tab. With
    text in the filter, the fuzzy score decides the order.
16. **The Search tab has chips and a sort selector (phase 2).** Chips write
    `language:`, `topic:`, `org:`/`user:` and `stars:>` into the search text.
    The sort selector: Best match, Stars, Updated. 30 results, and a "More"
    button up to 100.
17. **No `gh` or no login: a message and a Login button.** The list shows the
    cause. "Login" opens a terminal on the source machine with
    `gh auth login`. Without `gh`, the message gives the install link
    (https://cli.github.com). After the login, Refresh loads the list.

### Round 4

18. **A folder outside the `repo-launcher` roots gets a warning and a
    button.** An entry of `repo-launcher.cache` keeps its root, and the next
    scan of `repo-launcher` removes an entry that is outside every root. The
    folder settings view shows a warning when a clone root or an owner rule
    folder is outside the roots of `repo-launcher` on that machine. The button
    "Add to repo-launcher" adds the folder. Nothing changes without the click.

### During phase 1

19. **Open on GitHub.** The person asked for it during phase 1. `Ctrl+O` in
    the list and in the clone step, an arrow button on the selected row and
    in the header of the clone step. It opens
    `https://github.com/<owner>/<name>` in the browser of this computer
    (`rundll32 url.dll,FileProtocolHandler`, `open` or `xdg-open`, as in
    the `issues` mod).

### Defaults (agreed in round 4)

- **Machine picker.** Chips: this computer and each machine of `machines()`
  (not `temporary`). The default is the machine of the focused space. A
  machine with `layout: "unavailable"` is disabled. `Ctrl+M` cycles.
- **Cache.** 1 entry per machine in `shared("github-clone.cache")`. The dialog
  shows the cache at once. It reads the list again in the background when the
  cache is older than 15 minutes. Refresh (`Ctrl+R`) reads it at once.
- **Cloned mark.** 1 `exec` per machine lists the folders of the clone root
  and of the owner rule folders, with the `origin` URL of each Git folder. A
  repository is a cloned repo when its destination folder exists and its
  `origin` is that repository. A folder with the same name and another
  `origin` (for example a fork and its original) shows "folder in use", and
  the clone step asks for another destination.
- **Row.** `owner/name` with the matched letters highlighted, icons for
  private, fork and archived, the description (1 line, dim), the language and
  the time of the last push.
- **SSO hint.** An organization of `GET /user/orgs` with no repositories in
  the list still gets a chip. The chip says that the token may need SSO
  authorization (`gh auth refresh`, or the SSO page of the organization).
- **Keys of the dialog (round 4 fix).** List view: `↑` `↓` move, `Enter`
  opens the clone step, `Esc` closes the dialog (the filter field has the
  keyboard, so the mod gets Esc and closes the dialog itself), `Ctrl+R`
  refreshes, `Ctrl+M` cycles the machine. Clone step: the destination field
  has the keyboard when the step opens; `Backspace` and `←` edit the text;
  `Esc` and a Back button go back to the list; `Enter` starts the clone.
- **Overlay.** A `dialog` with a fixed size, and a list drawn as a window of
  rows (the `popup` and `v_virtual_list` traps of the repository AGENTS.md).
- **Clone command.** `gh repo clone <owner>/<name> <destination> --
  [--branch <b>] [--depth 1]`, in a wrapper for each system: the shell enters
  the destination when the clone ends without an error. On an error, the
  shell stays in the parent folder, and the error stays on the screen.
- **Destination checks.** Before the clone, 1 `exec` checks that the
  destination does not exist (also after an edit). A `~` at the start of a
  path expands on the source machine.
- **First clone root.** The clone step suggests the first `repo-launcher`
  root of that machine when the machine has no clone root.
- **Hosts.** Only `github.com` in phase 1. GitHub Enterprise hosts are out of
  scope.
- **Kit rules.** `kit.json` with the settings (key, order, "Edit folders…"),
  `kitOff()`/`offView()`, `mod.json` with `"place": "none"` and a `title`,
  a new setup version with `whats-new/<N>.md`, a README and a RECIPE, and a
  `preview.png` made from demo data.

## Phases

1. Repo list of the source machine, owner chips, fuzzy filter, clone step and
   clone in a visible terminal, settings view of the folders, entry points,
   `repo-launcher` integration.
2. Search tab.

## Risks

- **SSO organizations.** The list does not show the repositories of an
  organization that the token is not authorized for.
- **Preview image.** The repo list shows work repositories. The preview must
  show only `D:\MyProjects` content: the mod needs demo data for the
  screenshot.
- **Tasks of a closed overlay.** The `repo-launcher` README says that its
  scan stops when the popup closes. The mod must not need a task after the
  dialog closes (see decisions 6 and 8). Not checked in the Herdr source.
- **`hc send` and a slow shell.** The mod waits until the screen of the new
  terminal stops changing (`hc read`), then sends the line. Tested on this
  computer and on `notebook` (PowerShell with a prompt theme): the line
  arrived once.
- **Large accounts.** 165 repositories take 3 s. An account with thousands
  takes much longer: the cache and a background refresh must keep the dialog
  fast.

## Open questions

None.
