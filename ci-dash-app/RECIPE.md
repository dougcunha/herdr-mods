# CI Dash

A panel for the Herdr app that shows the GitHub Actions runs of the repository you are working in, starts workflows with `workflow_dispatch`, and downloads build artifacts. It has three tabs: **Runs**, **Dispatch** and **Artifacts**. It follows the folder of the focused terminal, so it always shows the repository you are in. All GitHub access goes through the `gh` CLI; the mod stores no credentials.

![CI Dash](preview.png)

## What you see

One rounded card (radius 10, 1 px `border`, `background` fill, 13 px text) with three stacked bands:

1. **Header, 38 px.** `CI Dash` in semibold, then the repository slug (`owner/repo`, 11 px, `dim`, truncated), then a **⟳** button on the right. On the Artifacts tab a **↗** button sits left of it.
2. **Tab strip, 40 px, 1 px bottom border.** Three pill tabs, 28 px tall, radius 8: `Runs`, `Dispatch`, `Artifacts` (12 px), each with a small count badge once its data has loaded. The active tab has a `raised` fill and a 1 px `border`; the others are `muted` on the plain background.
3. **Body**, one of:
   - **Runs list.** At the top, a **filter box** (36 px, radius 10, `raised` fill, 1 px `border`) with a magnifier icon, the placeholder `Filter runs…`, a count on the right (`12/30` while filtering, else the total) and a `×` button while text is typed. Under it, **filter chips** that wrap (26 px, radius 8): `All`, then `Running`, `Failed`, `Passed`, `Other`, each with a colored dot and a count badge. A chip with a count of 0 is hidden unless selected. The runs below are grouped under section headers: an 11 px semibold uppercase label in the group color (`IN PROGRESS` `working`, `NEEDS ATTENTION` `ansi1`, `PASSED` `ansi2`, `OTHER` `dim`), the group count in `dim`, and a 1 px `border` line filling the rest of the row. Each run is a row (padding 14 × 8, `hover` fill under the pointer): the status icon, the title (14 px, one line), `#<run number>` and `<time ago>` in 11 px `dim` on the right; below it, indented 24 px, a wrapping row of pills (see below) and the `<workflow> · <actor>` text in 11 px `dim`. Pills are 20 px tall, radius 6, 11 px text, with a translucent tinted fill: the branch in a monospace font with a branch icon (neutral `raised` fill), the status (`✓ passed` green, `✕ failed` red, `running` with a spinning ring, `queued`, `cancelled`…), the duration (neutral), the trigger when it is not `push` (`accent` tint, for example `schedule` or `workflow dispatch`), and `attempt N` after a rerun. When no run matches, the text `No run matches the filters.` and a `Clear filters` button.
   - **Run detail.** A bar with `‹ Runs`, `Open`, and `Cancel` (while running) or `Rerun` (when finished). Under it: the run title with its icon, a `<workflow> #<n> · <branch> · <event> · <actor>` line, and a colored `<status> · <duration>` line. Then each job (28 px, semibold: icon, name, duration) with its steps (22 px, indented 30 px: icon, name, duration). When the run has finished and produced artifacts, an `ARTIFACTS` caption (11 px, semibold, `muted`) and one row per artifact.
   - **Dispatch**, four screens under a **step indicator** (a row of numbered 20 px circles joined by thin lines: `Workflow`, `Branch`, `Inputs`, `Review`). The current step is an `accent` circle with its number and a semibold label, finished steps are green `✓` circles (clickable, to go back), the rest are `dim`. Labels show for every step when the indicator is at least 420 px wide, else only for the current step.
     1. *Workflow:* the line `Pick a workflow to run by hand.`, the filter box, then one **card** per workflow (radius 10, `raised` fill, 1 px `border`, `hover` fill under the pointer). A card has a 28 px rounded tile with a play icon in an `accent` tint, the workflow name (14 px), its path in a monospace font (11 px, `dim`) and a `›` at the end; below, indented, an `N inputs` pill (`accent` tint) or a neutral `no inputs` pill, the status pill of its latest run in the Runs list and `last run <time ago>` (or `no recent run`).
     2. *Branch:* a summary strip (play tile, workflow name, monospace path), the filter box, a `BRANCHES n` section header with the note `Choose where the run starts`, and 38 px rows: branch icon (`accent` for the default branch), the name in a monospace font, a `default` (`accent`) or `current` pill, and `›`. A back button `‹ Workflows` in a footer.
     3. *Inputs:* the summary strip with the chosen branch as a pill at its right, then one **card** per input: the name (semibold), a `required` pill in `ansi1` or an `optional` neutral pill, the type as a monospace pill at the far right, the description (11 px, `dim`) and the editor. `string`, `number` and `environment` use a 30 px text box on the `background` fill. `boolean` uses a two-segment control `true | false`, the chosen segment tinted `accent`. `choice` uses wrapping chips, the chosen one tinted `accent`. Warnings from the workflow file show as `blocked`-colored banners. A footer has `‹ Branches` and the primary button `Review →`.
     4. *Review:* the summary strip, an `accent`-colored banner with an info icon, `Nothing starts until you press Dispatch.`, then an `INPUTS n` header and a table card (rows with the name in 11 px monospace `dim` on the left, 110 px wide, and the value in 12 px monospace; `(empty)` in `dim` for a blank value). A workflow with no inputs shows a card, `No inputs to fill`, `The run starts on <branch> with the workflow's own defaults.` The footer has `‹ Back` and the primary button `▶ Dispatch`.
     - The primary button is 32 px tall, radius 8, `solid` fill with `solid_foreground` text, semibold; it takes the `accent` fill on hover. Problems and errors show as `ansi1` banners above the footer.
     - While something loads, the body shows a centered 22 px spinner in `accent`, a title (13 px) and a hint (11 px, `dim`).
   - **Artifacts list.** The same filter box (`Filter artifacts…`) and chips: `All`, `Available` (`accent` dot), `Downloaded` (`ansi2`), `Expired` (`ansi1`). The filter matches artifact name, workflow name and branch. When at least one artifact name ends in a known file extension, a second chip row follows, led by the 11 px `dim` word `Type`: `All types`, then one chip per type found (`.zip`, `.exe`, `.7z`, `.appimage`, `.tar.gz`…), most common first, and `other` last for names without a known extension. Each chip has a count badge; the status chips count only what the selected type allows, and the type chips count only what the selected status allows. Groups have a section header in `muted`: the workflow name in capitals, the count, a dim `#<run> · <branch>` note, and the divider line. Each artifact is a row: a package icon (`accent`, `dim` when expired), the name (14 px), and the action word in `accent` on the right (`Download`, `Downloading…`, `Retry`, `Again`); below it, indented, a monospace pill with the type in an `accent` tint when the name has a known extension, then pills for the size and the age, then `expired`, `✓ downloaded`, `✕ failed` or `downloading` as it applies, and the target folder or the error in 11 px text.
   - Loading, empty and error messages: a title line and, when there is one, a 12 px `dim` hint.
4. **Note line.** A one-line 11 px `blocked`-colored message at the bottom with a 1 px top border, only while there is something to say (a download result, a cancel request, an error).

Buttons are 26 px tall, 10 px side padding, radius 7, 1 px border, 12 px text. A primary or active button uses `accent` for border and text; a disabled one uses `dim`.

## How it behaves

**Status icons** (14 px): `✓` success in `ansi2`, `✕` failure, timed out or startup failure in `ansi1`, `!` action required in `ansi3`, `–` cancelled, skipped, neutral or stale in `dim`, `○` queued in `blocked`, and a spinning ring (`spinner.svg`, 900 ms per turn, `working` color) while in progress. Jobs and steps use the same icons.

**Which repository.** The folder comes from the focused terminal, else any terminal in the same tab, else any terminal in the same space, else the last folder found. `gh repo view --json nameWithOwner,url,isPrivate,defaultBranchRef` run in that folder names the repository. A pane outside a repository keeps showing the repository already loaded. The prop `repo` pins one.

**Runs tab.** Loads the 30 latest runs on start. While any listed run is not finished, the list refreshes every 5 s without a loading state. A run that goes from running to finished posts a notification: title `CI <result>: <workflow>`, body `#<n> · <branch> · <duration>`, level `success`, `error` or `info`.

**Run detail.** Click a run. It polls the run and its jobs every 5 s for 12 polls, then every 10 s until poll 60, then every 30 s, and stops when the run finishes. `Open` opens the run in the browser. `Cancel` and `Rerun` act at once. After a rerun the panel ignores a still-old answer for 20 s so the run does not flash back to finished. `‹ Runs` or the Runs tab goes back.

**Dispatch tab.** Loads on first use. Four steps:
1. *Workflow.* Active workflows whose file declares `workflow_dispatch` on the default branch. The filter matches name and path. The last-run pill comes from the runs already loaded in the Runs tab (matched by workflow id), so it costs no extra request. Clicking a finished step in the indicator goes back to it and keeps what was loaded.
2. *Branch.* Branches only. The default branch (tag `default`) and the branch of the focused terminal (tag `current`) come first.
3. *Inputs.* One card per input under `on.workflow_dispatch.inputs`: name, a red `*` when required, the type in 10 px `dim`, the description, and an editor. `string`, `number` and `environment` use a 30 px text box. `boolean` uses two chips, `true` and `false`. `choice` uses one chip per option, wrapping. The default value is pre-filled. A workflow with no inputs skips to Review. `Review` checks required fields, numbers and choices and shows the first problem in red.
4. *Review.* Lists workflow, branch and every value (`(empty)` when blank). The text `Nothing starts until you press Dispatch.` is shown. `Dispatch` sends the request, finds the new run, and opens it in the Runs tab. If GitHub returns no run id, the panel looks for the run on each 5 s tick for up to 18 tries, and then says it could not find it. It never dispatches twice.

**Artifacts tab.** Loads on first use and on `⟳`. For every workflow it takes the latest 5 runs and shows the artifacts of the first run that has any. Groups are sorted by newest artifact. Clicking a row downloads it to `<repository root>/.ci-dash/artifacts/<run id>/<artifact name>` (the name is made safe for file systems). The row shows `Downloading…`, then `✓ Downloaded` and the path, or `Retry` and the error. Expired artifacts show `expired` and do nothing. `↗` opens the last download folder, else `.ci-dash/artifacts`, in the file manager, and says so in the note line when nothing was downloaded yet.

**Filters.** Typing in a filter box narrows the list at once (case-insensitive, over title, workflow, branch, actor, trigger and `#number` for runs; name, workflow and branch for artifacts). A chip narrows by group; counts on the chips follow the typed text. The filter box and the chip are cleared when the panel switches to another repository.

**Props** (read once when the mod starts): `tab` = `runs` | `dispatch` | `artifacts`; `repo` = `owner/repo`; `workflow` = text that pre-selects the first matching workflow; `ref` = with `workflow`, also pre-selects that branch (these stop at the inputs or Review step and never dispatch); `filter` = text to put in the Runs and Artifacts filter boxes; `status` = a chip to select: `live`, `attention`, `passed` or `other` for runs, `available`, `downloaded` or `expired` for artifacts; `type` = an artifact file type to select, such as `zip` or `exe`.

**File types.** GitHub's artifact list gives only a name and a size, so the type is the extension at the end of the name, lowercased, and only when it is in a fixed list of known extensions (archives, installers, packages, binaries, documents, images, scripts, and the compound `tar.gz`, `tar.bz2`, `tar.xz`, `tar.zst`, `tar.lz4`). A name such as `Notepad++.gcc.x86_64.Release` or `release-1.2.3` has no type and counts under `other`. Nothing is downloaded to find the type.

## Built from

Files in `mods/ci-dash/`: `main.js` (the `View`, header, Runs, detail, Artifacts), `dispatch.js` (the Dispatch tab), `ui.js` (pills, section headers, the search box, filter chips, the step indicator, the segmented control, icon tiles and the loading spinner), `gh.js` (every `gh` call), `workflow-inputs.js` (reads `on.workflow_dispatch.inputs`), `format.js` (time, size, status and `mapLimit` helpers), `yaml.js` (a minified browser bundle of `yaml` 2.8.1, ISC license in `yaml.LICENSE`), the icons `spinner.svg`, `ci.svg`, `search.svg`, `branch.svg`, `package.svg`, `close.svg`, `play.svg` and `info.svg` (24 px, 2 px stroke, `currentColor`), and `mod.json` = `{ "place": "none" }`.

Imports: `View`, `div`, `svg` from `gpui-kit`; `v_flex`, `h_flex`, `InputState`, `Input` from `gpui-base`; `spaces`, `panes`, `focused`, `exec`, `home`, `theme`, `settings`, `notify`, `props` from `herdr`. Theme colors used by name: `background`, `raised`, `border`, `foreground`, `muted`, `dim`, `accent`, `hover`, `selected`, `blocked`, `working`, `ansi1`, `ansi2`, `ansi3`. A tinted pill fill is the theme color plus a hex alpha of `24`; if a theme color is not a `#rrggbb` string it is used as is. Timers: one `cx.timer.every(5000)`; the spinner uses `.spin(900)`.

Programs it runs with `exec` (tell the person before installing):
- `gh repo view`, `gh api` (workflows, runs, jobs, artifacts, branches, file contents, cancel, rerun, dispatch), `gh run view --web`, `gh run download`. These use the network and the person's `gh` login.
- `git rev-parse --show-toplevel`, to find the repository root.
- `explorer.exe`, `open` or `xdg-open`, and `pwsh -Command Test-Path` or `test -d`, to open and check the download folder.

It reads no files itself and writes only the downloaded artifacts under `.ci-dash/artifacts/` in the repository.

The dispatch call is `gh api --method POST repos/<owner>/<repo>/actions/workflows/<id>/dispatches -f ref=<branch> -f inputs[<name>]=<value> … -F return_run_details=true`. Inputs use `-f` so every value stays a string.

## Watch out

- `exec` has a 30 s limit, no stdin and no `Buffer`. So the dispatch body goes as `-f` flags, workflow files are read with `Accept: application/vnd.github.raw+json` instead of base64, and a very large artifact can time out.
- `gh api --slurp` cannot be combined with `--jq`. The mod parses the JSON itself.
- A mod pane has no folder of its own, and `spaces()[i].tabs[]` has no `terminals` field. Use `panes()` (matched by `tab`) to find the folder of a terminal.
- `props()` inside a callback can answer for another copy of the mod. Read props once in `init` and keep them.
- Create `InputState` objects when the form is built, never inside `render()`, or the text resets on every redraw.
- Never test Dispatch against a workflow that publishes or deploys. Use the `workflow` and `ref` props to reach the form, or a public repository such as `cli/cli` with `workflow` = `deployment` for a read-only form with real inputs.
- Workflow, job, artifact and branch lists are read in full (100 per page, all pages). The Runs tab shows only the 30 latest runs, and the Artifacts tab looks only at the 5 latest runs of each workflow, so an older artifact is not listed.
- Needs `gh` installed and logged in (`gh auth status`). The token needs `repo` scope for private repositories and permission for Actions.
- Mouse only; text boxes take keyboard input. Tags are not listed as refs.
- `mod.json` has `"place": "none"`, so the mod appears only where a layout or a command puts it: `herdr-app do tab.new --mod ci-dash`, or `pane.split` with `mod`.

## Done when

- `herdr-app check mods/ci-dash` passes and `herdr-app status` lists no errors after the mod opens.
- In a repository with a GitHub remote, the Runs tab lists the latest runs with status icons, and a run that is in progress shows the spinner.
- Clicking a run shows its jobs and steps, and `Open` opens it in the browser.
- The Dispatch tab lists only workflows that declare `workflow_dispatch`, and a workflow with inputs shows one editor per input with the right control for each type.
- Review shows the values and sends nothing until `Dispatch` is pressed. If the dispatch call fails, Review shows the error and nothing starts.
- The Artifacts tab lists artifacts per workflow, and a click on a row writes the files to `.ci-dash/artifacts/<run id>/<name>`.
- In a repository whose artifacts are named like `app-x64.zip` and `setup.exe`, the Artifacts tab shows a `Type` row with `.zip` and `.exe` chips and their counts. Selecting `.exe` keeps only the `.exe` artifacts, and the counter on the right reads `3/14` style (shown over total). A repository whose artifact names have no known extension shows no `Type` row.
- Typing in the Runs filter box shrinks the list and the count on the right (`12/30`), a status chip keeps only that group, and `×` or `Clear filters` brings every run back. The Artifacts tab filters the same way.
- Opening the mod with `{"tab":"runs","filter":"dependabot","status":"passed"}` in a repository that has such runs shows the box filled, the `Passed` chip selected and only matching runs.
- Focusing a terminal in another repository switches the panel to that repository; focusing a terminal outside any repository keeps the current one.
