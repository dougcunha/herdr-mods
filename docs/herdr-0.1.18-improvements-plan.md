# Herdr 0.1.18 Mod & Layout Improvements Plan

Overview of Herdr 0.1.18 capabilities targeted across PowerMods:
- Command Palette entries via `"palette"` in `mod.json`
- Window visibility detection (`window()?.visible`) to pause idle UI polling
- Window-wide drag tracking (`.on_window_mouse_move` / `.on_window_mouse_up`)
- Native file picker (`pickFiles`)
- `EditorState` Markdown syntax highlighting (`heading`, `strong`, `emphasis`, `code`, `quote`, `list`, `link`), live `set_soft_wrap`, `tab_size`, and `.blur()`
- `TextView.markdown` `.raw_html(false)`, `.on_selection_change`, and `.highlight_range`
- Mouse side-button navigation (`"back"` / `"forward"`)
- `ScrollHandle` metrics (`offset()`, `content_size()`, `viewport_size()`)
- Terminal `link_handlers` with `link.line` and `link.column`
- Layout `divider.hover` and `pane.veil`

## Phases

- [x] **Phase 1 — Command Palette entries (`"palette"` in `mod.json`)**
  - Add `"palette"` entries under `"group": "PowerMods"` to:
    - `mods-hub-app/mods/mods-hub/mod.json`
    - `automations-app/mods/automations/mod.json`
    - `quick-actions-app/mods/quick-actions/mod.json`
    - `repo-launcher-app/mods/repo-launcher/mod.json`
    - `github-clone-app/mods/github-clone/mod.json`
    - `issues-app/mods/issues/mod.json`
    - `issues-app/mods/prs/mod.json`
    - `visual-review-app/mods/visual-review/mod.json`
    - `skill-bundles-app/mods/skill-bundles/mod.json`
    - `tab-namer-app/mods/tab-namer/mod.json`
    - `powermods-core-app/mods/powermods-core/mod.json`
    - `image-viewer-app/mods/image-viewer/mod.json`
    - `agent-resume-app/mods/agent-resume/mod.json`
    - `tokenhound-app/mods/tokenhound/mod.json`
    - `dock-app/mods/tabs-dock/mod.json`
    - `kanban-app/mods/kanban/mod.json`
  - Verification: `herdr-app check` on each installed mod + open `app.palette` and confirm `PowerMods` entries appear and launch cleanly.

- [ ] **Phase 2 — Pause UI polling when window is hidden (`window()?.visible`)**
  - Guard UI/polling timers with `window()?.visible === false` and trigger pending refresh when `render()` runs with `window()?.visible !== false`:
    - `dock-app/mods/files-md/main.js`
    - `git-client-app/mods/git-client/history.js`
    - `git-dash-app/mods/git-dash/main.js`
    - `ci-dash-app/mods/ci-dash/main.js`
    - `issues-app/mods/issues/main.js` & `issues-app/mods/prs/main.js`
    - `space-deck-app/mods/space-deck/main.js`
    - `spec-board-app/mods/spec-board/main.js`
    - `tokenhound-app/mods/tokenhound/main.js`
    - `agent-resume-app/mods/agent-resume/main.js` & `panel.js`
    - `agent-cards-app/mods/agent-cards/main.js` (visual timer only; keep `syncSounds` active)
    - `kanban-app/mods/kanban/main.js` (visual timer only)
    - `mods-hub-app/mods/mods-hub/main.js`
    - `skill-bundles-app/mods/skill-bundles/main.js`
    - `automations-app/mods/automations/main.js` (dialog UI timer only; keep scheduler `beat` active)
    - `quick-actions-app/mods/quick-actions/main.js` (dialog UI/preview timers only; keep `beat`/`track` active)
  - Note: Do NOT pause background workers (`automations` beat, `powermods-core` pump, `quick-actions` beat/track, `agent-cards` `syncSounds`).
  - Verification: `herdr-app check` on all updated mods + minimize and restore Herdr to verify panels refresh on return.

- [ ] **Phase 3 — Window-wide drags (`.on_window_mouse_move` / `.on_window_mouse_up`)**
  - `visual-review-app/mods/visual-review/canvas.js` (graph pan) & `main.js` (side panel resize)
  - `git-client-app/mods/git-client/history.js` (column resize; remove `on_hover` cancel workaround)
  - `space-deck-app/mods/space-deck/main.js` & `dock-app/mods/tabs-dock/main.js` (clear pressed/drag state on window mouse up)
  - Verification: `herdr-app check` + drag across element and terminal boundaries in all 4 mods.

- [ ] **Phase 4 — Native file picker (`pickFiles`)**
  - `quick-actions-app/mods/quick-actions/form.js` & `main.js`: `Choose…` button for script files
  - `automations-app/mods/automations/form.js` & `main.js`: `Choose…` button for `check`/`pre`/`post` script files (converting paths inside the automation folder to relative paths)
  - `image-viewer-app/mods/image-viewer/main.js`: `Open…` button with `multiple: true` and prev/next navigation
  - Verification: `herdr-app check` + click `Choose…` / `Open…` inside `cx.spawn` in the live app.

- [ ] **Phase 5 — Editor & Markdown upgrades**
  - `spec-board-app/mods/spec-board/main.js`: theme-aware Markdown `syntax` (`heading`, `strong`, `emphasis`, `code`, `quote`, `list`, `link`), live `set_soft_wrap` toggle, `tab_size`, `.raw_html(false)`
  - `dock-app/mods/files-md/main.js`: theme-aware Markdown `syntax` in Source mode, live `set_soft_wrap` toggle, `.raw_html(false)`
  - `issues-app/mods/issues/main.js` & `issues-app/mods/prs/detail.js`: `.raw_html(false)` on `TextView.markdown`
  - Verification: `herdr-app check` + test light/dark themes and HTML-like text (`<Component>`, `List<T>`) with `herdr-app shot`.

- [ ] **Phase 6 — Mouse side buttons (`"back"` / `"forward"`)**
  - Add `.on_mouse_down("back", ...)` / `"forward"` navigation in:
    - `dock-app/mods/files-md/main.js`
    - `spec-board-app/mods/spec-board/main.js`
    - `issues-app/mods/issues/main.js` & `issues-app/mods/prs/main.js`
    - `ci-dash-app/mods/ci-dash/main.js`
    - `automations-app/mods/automations/main.js`
    - `quick-actions-app/mods/quick-actions/main.js`
    - `skill-bundles-app/mods/skill-bundles/main.js`
    - `visual-review-app/mods/visual-review/main.js`
  - Verification: `herdr-app check` + test mouse back/forward buttons in each mod.

- [ ] **Phase 7 — Layout polish (`main-dock.json`, `kanban.json`) & `setAgentOrder`**
  - Add `"hover": "accent"` on root `divider` and resizable container dividers (`work-body`, `board-view`) in `dock-app/layouts/main-dock.json` and `kanban-app/layouts/kanban.json`
  - Evaluate `pane.veil` (~`0.18`) on pane frames
  - Review `space-deck` vs `setAgentOrder`
  - Verification: copy layouts to `~/.config/herdr-app/layouts/`, ensure no `layout.error`, and inspect split panes with `herdr-app shot`.

- [ ] **Phase 8 — Clean text field focus release (`.blur()`)**
  - Update Esc handling on empty search/input fields when docked (non-dialog) to call `state.blur()` while preserving dialog-close behavior in:
    - `git-dash-app/mods/git-dash/ui.js`
    - `dock-app/mods/files-md/main.js`
    - `skill-bundles-app/mods/skill-bundles/view.js`
    - `tokenhound-app/mods/tokenhound/main.js`
    - `spec-board-app/mods/spec-board/main.js`
    - `ci-dash-app/mods/ci-dash/ui.js`
    - `issues-app/mods/issues/main.js` & `issues-app/mods/prs/main.js`
    - `git-client-app/mods/git-client/history.js`
  - Verification: `herdr-app check` + test `Esc` in both docked sidebar panels and overlay dialogs.

- [ ] **Phase 9 — Terminal Link Handlers (`link_handlers` + `link.js` with `line`/`column`)**
  - `image-viewer-app/mods/image-viewer/`: add `link_handlers` in `mod.json` and `link.js` exporting `handleLink(click)`
  - `dock-app/mods/files-md/`: add `link_handlers` in `mod.json` and `link.js` exporting `handleLink(click)` with `link.line` / `link.column` support
  - `dock-app/layouts/main-dock.json` & `kanban-app/layouts/kanban.json`: add `"link_handlers": ["image-viewer", "files-md"]`
  - Verification: `herdr-app check` on installed mods + Ctrl/Cmd-click image and `README.md:10` links in a terminal.

- [ ] **Phase 10 — Advanced `TextView` & `ScrollHandle` features**
  - **10A — Markdown selection popup & in-document search:**
    - Selection popup (`on_selection_change` + `s.position` + `s.range`: Send to focused terminal / Copy Markdown) in `files-md`, `spec-board`, `issues`, `prs`
    - In-document Markdown search with `.highlight_range(...)` in `files-md` and `spec-board`
  - **10B — `ScrollHandle` metrics (`offset()`, `content_size()`, `viewport_size()`):**
    - Real tab overflow indicators in `dock-app/mods/tabs-dock/main.js`
    - "Top" button / auto-load more at bottom in `git-client-app/mods/git-client/history.js`, `issues-app/mods/issues/main.js`, `issues-app/mods/prs/main.js`, `ci-dash-app/mods/ci-dash/main.js`
  - Verification: `herdr-app check` + live interaction and `herdr-app shot` checks.

## Per-Phase & Release Checklist

1. Edit files in `D:\MyProjects\herdr-mods\` and copy changed mods/layouts to `C:\Users\dougc\.config\herdr-app\`.
2. Run `herdr-app check` on the installed copies under `C:\Users\dougc\.config\herdr-app\mods\<mod>` (never on the repo folder).
3. Test live in the running Herdr window (`herdr-app status`, `herdr-app shot`, and manual click/drag tests).
4. When preparing a commit/release:
   - Refresh `preview-src.png` and `preview.png` via `node tools/preview/render.mjs <app>` if any mod's appearance changed.
   - Increment `herdr-mods-setup-version` in `SETUP-PROMPT.md`.
   - Create `whats-new/<N>.md` in English.
   - Run `node tools/record-hashes.mjs` and update `C:\Users\dougc\.config\herdr-app\data\herdr-mods-setup.json`.
