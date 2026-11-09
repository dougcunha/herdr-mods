# Issues & PRs

![Issues & PRs](preview.png)

2 mods for the Herdr app that show the work of the shown space next to its terminals and agents:

- **`issues`**: the issues of the space from Jira Cloud or GitHub. Each issue opens as a page. **Start agent** opens a coding agent on the issue in a new git worktree and space.
- **`prs`**: the pull requests of the space, grouped by what each one waits for (review requested, yours to fix, ready to merge). Each pull request opens as a page with its checks, files and a merge box. **Agent review** checks it out, builds, tests and reports.

Both mods only read. They write nothing to Jira or GitHub. **Start agent** makes a local worktree and branch, and pushes nothing.

## Credits

These mods are a copy of `herdr-ranch-issues` and `herdr-ranch-prs` of [Herdr Ranch](https://github.com/jslowack/herdr-ranch) by Jelle Slowack, version 0.5.0 (commit `999eb3e`), under the [MIT license](LICENSE). Thank you, Jelle.

The changes of this kit:

- The mods are called `issues` and `prs`.
- The settings (**Order**, **Page** and the shortcut) are in the **Settings** tab of **Herdr Mods**, not in the cog. The cog keeps **Link space…** and **Prompts…**. Your settings of Herdr Ranch move over once.
- The kit updates the mods (**Herdr Mods**), so the update check of Herdr Ranch and its **Update** button are gone.
- The mods are Dock panels (`dock/panels.json`), not buttons of the `mod-buttons` layout. The **Opens in** setting is gone.
- In a dialog of the Dock, the header of the list does not repeat the name and the × of the dialog, and Esc closes the dialog also after a click in the header.
- No Linear: the issues come from Jira Cloud or GitHub.
- On Windows, **Connect** in **Link space** stored the token but showed "The credential store refused it". Fixed.
- The **Mods** tab of Herdr Mods can turn each mod off.
- The `herdr-ranch-reviews` mod is not part of the kit: it runs Unix programs only.

## Install

The setup prompt of this repository installs the mods (item `issues-app`). By hand:

1. Copy `mods/issues/` and `mods/prs/` to `~/.config/herdr-app/mods/`.
2. Add the panels to `~/.config/herdr-app/dock/panels.json`:

   ```json
   { "id": "issues", "label": "Issues", "icon": "mods/issues/issue.svg", "mod": "issues" },
   { "id": "prs", "label": "PRs", "icon": "mods/prs/pr.svg", "mod": "prs", "group": "git" }
   ```

3. Add the keys to `~/.config/herdr-app/keys.json`:

   ```json
   "global": {
     "ctrl-shift-j": "mod.open:issues",
     "ctrl-shift-g": "mod.open:prs"
   },
   "mod:issues": { "ctrl-r": "issues.refresh", "ctrl-o": "issues.browser" },
   "mod:prs": { "ctrl-r": "prs.refresh", "ctrl-o": "prs.browser" }
   ```

**Needs:** [`gh`](https://cli.github.com) signed in, and `git`. `curl` for the avatars of the pull requests. A Jira Cloud site (`*.atlassian.net`) with a classic API token, only if you use Jira.

## Connect Jira

1. Create a **classic** API token at <https://id.atlassian.com/manage-profile/security/api-tokens> (not "Create API token with scopes").
2. Open the Issues panel and click the cog, then **Link space…**.
3. Select **Jira**. Type the site, your e-mail and the token, and click **Connect**.
4. Select the project and, if you want, a filter.

The token goes to the credential store of the system (Windows Credential Manager, macOS Keychain, Linux Secret Service), never to the settings of Herdr. The full guide: [Connect Jira](https://github.com/jslowack/herdr-ranch/blob/main/docs/connect-jira.md).

## What it runs

- `git` and `gh` in the folder of the space.
- `curl` for the avatars, `powershell` (Windows), `security` (macOS) or `secret-tool` (Linux) for the token.
- Network: your Jira site and GitHub (through `gh`).
- Files: `~/.config/herdr-app/data/issues-app/` (icons, avatars and, for a moment, the token before it goes to the credential store).

More: [RECIPE.md](RECIPE.md).
