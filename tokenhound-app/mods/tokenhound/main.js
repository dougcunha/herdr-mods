// tokenhound: shows the quotas of the TokenHound HUD in the Herdr app.
//
// TokenHound (a Windows tray app) writes its HUD content to %LOCALAPPDATA%\TokenHound\hud.json.
// This mod reads that file, watches it for changes, and shows it in these roles (props.part):
//   (none)    the full panel: a Dock panel (dock/panels.json) or a pane.
//   "status"  the status bar item. A click opens the panel in a dialog.
//   "section" a section for the sidebar, under the agents list. A click opens the dialog.
//   "dialog"  the panel in a dialog (the 2 roles above, and the command tokenhound.open).
// A popup is not used: a popup is as tall as its content, and the full list can be taller
// than the window. The dialog scrolls.
//
// The mod only reads the file. It runs no program and uses no network.

import { View } from "gpui-kit";
import { theme, props, shared, settings, openOverlay, closeOverlay, nextCommand, watchFolder } from "herdr";
import { feedDir, feedState, isFeedPath, readFeed, visibleProviders } from "./feed.js";
import { loadPrograms, providerIcon } from "./icons.js";
import { STR } from "./text.js";
import { panelView, sectionView, statusView } from "./view.js";

const MOD = "tokenhound";
const KEY_LANG = "herdr-mods.lang"; // the language of the whole kit, set in the mods-hub; absent: props.lang
const KEY_HIDDEN = "tokenhound.hidden"; // provider ids to leave out, comma separated
const KEY_METRIC = "tokenhound.statusMetric"; // "session" (default) or "both" (session · week) in the status bar
// The file is also read on this timer: it catches a stale feed, a folder that did not exist yet,
// and it moves the countdowns. TokenHound writes at least every 30 s.
const REFRESH_MS = 30000;

export default class TokenHound extends View {
  init(given, cx) {
    // Read props once: props() in a later callback can answer for another copy.
    this.props = (given && Object.keys(given).length ? given : props()) || {};
    this.part = this.props.part ?? "panel";
    this.width = 0;
    this.result = null;
    this.reading = false;
    this.watching = false;
    this.keys = cx.focus_handle();
    this.programs = new Map(); // Herdr's program table, for the agent icons (icons.js)
    cx.spawn(async (cx) => { this.programs = await loadPrograms(); cx.notify(); });
    this.reload(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.reload(cx));
    // "tokenhound.open" (a key in keys.json, or herdr-app do) opens the panel as a dialog.
    // Only the status bar copy listens: a command reaches every shown copy, so more listeners
    // would open more dialogs.
    if (this.part === "status") {
      cx.spawn(async () => {
        for (;;) {
          if ((await nextCommand()) === "open") this.openDialog();
        }
      });
    }
  }

  /** The language: the kit setting when it is set, else the lang prop, else English. */
  get lang() {
    const kit = shared(KEY_LANG);
    return STR[kit] ? kit : STR[this.props.lang] ? this.props.lang : "en";
  }

  reload(cx) {
    // A change during a read: read once more after it, so the newest file wins.
    if (this.reading) { this.again = true; return; }
    this.reading = true;
    this.again = false;
    cx.spawn(async (cx) => {
      try {
        this.result = await readFeed();
      } catch (e) {
        this.result = { doc: null, error: String(e) };
      } finally {
        this.reading = false;
      }
      if (!this.watching && !this.result.unsupported && this.result.doc) this.watch(cx);
      cx.notify();
      if (this.again) this.reload(cx);
    });
  }

  /** Reads the file again as soon as TokenHound replaces it. Stops when the folder goes away. */
  watch(cx) {
    this.watching = true;
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          const changed = await watchFolder(feedDir());
          const root = changed.some((p) => !/\.[a-z0-9~]+$/i.test(String(p).split(/[\\/]/).pop()));
          if (root || changed.some(isFeedPath)) this.reload(cx);
        }
      } catch {
        // The folder does not exist (TokenHound was removed). The timer still reads the file.
      } finally {
        this.watching = false;
      }
    });
  }

  model() {
    const now = Date.now();
    const doc = this.result?.doc ?? null;
    return {
      state: feedState(this.result, now),
      doc,
      error: this.result?.error ?? null,
      providers: visibleProviders(doc, shared(KEY_HIDDEN)),
      now,
      lang: this.lang,
      str: STR[this.lang],
      metric: shared(KEY_METRIC) === "both" ? "both" : "session",
      icon: (providerId) => providerIcon(this.programs, providerId),
    };
  }

  /** Keeps the width at zoom 1 (on_size_change reports zoomed pixels), and redraws only on a change. */
  setWidth(size, cx) {
    const width = Math.round(size.width / (Number(settings().zoom) || 1));
    if (width === this.width) return;
    this.width = width;
    cx.notify();
  }

  /** The panel in a dialog: 2 columns of cards. */
  openDialog() {
    openOverlay({ mod: MOD, kind: "dialog", width: 760, height: 620, props: { part: "dialog", lang: this.lang } });
  }

  /** In a dialog (its own, or a Dock panel dialog), a click gives the panel the keyboard, so Esc closes it. */
  dialogKeys(el) {
    const id = () => this.props.overlay ?? props()?.overlay ?? shared("kanban.panelDialog")?.id ?? null;
    return el.track_focus(this.keys)
      .on_mouse_down("left", () => { if (id()) this.keys.focus(); })
      .on_key_down((e, cx) => {
        const dialog = e.key === "escape" ? id() : null;
        if (dialog) { closeOverlay(dialog); cx.stop_propagation(); }
      });
  }

  render() {
    const t = theme();
    const m = this.model();
    switch (this.part) {
      case "status":
        return statusView(t, m, () => this.openDialog());
      case "section":
        return sectionView(t, m, this.width, () => this.openDialog())
          .on_size_change((size, cx) => { this.setWidth(size, cx); });
      default:
        return this.dialogKeys(panelView(t, m, { width: this.width }))
          .on_size_change((size, cx) => { this.setWidth(size, cx); });
    }
  }
}
