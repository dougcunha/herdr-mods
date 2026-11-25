// Keybinds Manager: modern visual editor for Herdr's keys.json.
// Supports press-to-record capture, same-section Replace/Swap and cross-section
// precedence warnings, terminal/AltGr safety alerts, search by key, custom bindings,
// Quick Actions integration, hidden-by-default macOS bindings, and session undo.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { theme, props, closeOverlay, commands, keys, nextCommand, checking, window, notify } from "herdr";
import {
  CATEGORIES, prettyChord, sectionLabel, sectionKind, chordOfEvent, analyzeConflict,
  buildRows, setBinding, removeBinding, serializeDocument, parseDocument, normalizeChord,
} from "./model.js";
import {
  kitOff, showMacPref, setShowMacPref, loadKeysFile, saveKeysFile, saveRawKeysText,
  readKeysError, loadQuickActions, loadInstalledMods,
} from "./store.js";
import { renderNewForm, resolveFormAction } from "./form.js";
import * as U from "./ui.js";

const offView = () => {
  const o = props()?.overlay;
  if (o) closeOverlay(o);
  return div();
};

const errMsg = (e) => String(e?.message ?? e);

function captureActionName(chord) {
  return "kb_cap_" + Array.from(chord).map((c) => c.charCodeAt(0).toString(16)).join("_");
}

export default class Keybinds extends View {
  init(given, cx) {
    this.props = (given && Object.keys(given).length ? given : props()) || {};
    this.platform = window()?.platform ?? "windows";
    this.handle = cx.focus_handle();
    this.listScroll = ScrollHandle.new();

    this.view = "list"; // "list" | "new"
    this.category = "all";
    this.sectionFilter = "all";
    this.query = "";
    this.filterChord = null;
    this.recordingFilter = false;
    this.filterBlockedMsg = null;

    this.sections = { global: {} };
    this.rawText = null;
    this.parseError = null;
    this.keysError = null;
    this.saveError = null;
    this.saving = false;
    this.loaded = false;

    this.quickActions = [];
    this.modNames = [];
    this.modTitles = {};

    this.capture = null; // { rowId, section, action, actionKey, oldChord, mode: "edit"|"add", blockedMsg }
    this.pending = null; // { capture, chord, report }
    this.confirmRestore = false;
    this.history = { initialRaw: null, undo: [], redo: [] };
    this.captureActionMap = new Map();
    this.installedCaptureKeys = new Set();
    this.escapeBound = false;

    this.focusAction = typeof this.props.focusAction === "string" ? this.props.focusAction : null;
    this.autoRecord = Boolean(this.props.autoRecord);
    this.focusApplied = false;

    this.search = InputState.new({ placeholder: "Search actions, commands, or shortcuts…" });
    this.search.on("change", (_e, cx) => {
      this.query = this.search.value().trim().toLowerCase();
      cx.notify();
    });

    // Inputs for the "+ New Binding" form are created once here (never in render).
    this.formInputs = {
      cmdSearch: InputState.new({ placeholder: "Filter Herdr commands…" }),
      cmdArgs: InputState.new({ placeholder: "Optional arg (e.g. right, 1, or {\"id\":\"sidebar\"})" }),
      modName: InputState.new({ placeholder: "Mod folder name (e.g. quick-actions)" }),
      modCmd: InputState.new({ placeholder: "Mod command (e.g. open, refresh)" }),
      send: InputState.new({ placeholder: "Text or escapes (e.g. \\u001bb)" }),
    };
    for (const inp of Object.values(this.formInputs)) {
      inp.on("change", (_e, cx) => cx.notify());
    }
    this.newForm = this.blankForm();

    if (checking()) return;

    this.reloadAll(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand());
        if (kitOff()) continue;
        if (c === "new") this.openForm(cx);
        else if (c === "list") this.closeForm(cx);
        else if (c === "toggle-mac") { setShowMacPref(!showMacPref()); cx.notify(); }
        else if (c === "record-filter") this.startFilterRecord(cx);
        else if (c === "undo") this.undo(cx);
        else if (c === "redo") this.redo(cx);
        else if (c.startsWith("category-")) { this.category = c.slice(9); cx.notify(); }
        else if (c.startsWith("section-")) { this.sectionFilter = c.slice(8); cx.notify(); }
      }
    });

    cx.timer.after(40, () => {
      if (this.focusAction && this.autoRecord) this.handle.focus();
      else this.search.focus();
    });
  }

  blankForm() {
    return {
      mode: "command", // "command" | "mod" | "send" | "terminal"
      command: "tab.new",
      modKind: "open", // "open" | "cmd"
      modName: "",
      section: "global",
      chord: null,
      recording: false,
      blockedMsg: null,
      showError: false,
    };
  }

  focusRoot(cx) {
    this.search?.blur();
    for (const inp of Object.values(this.formInputs)) inp.blur();
    this.handle.focus();
    cx.timer.after(40, () => this.handle.focus());
  }

  close_() {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  reloadAll(cx) {
    cx.spawn(async (cx) => {
      const [kf, qa, mods, ke] = await Promise.all([
        loadKeysFile(),
        loadQuickActions(),
        loadInstalledMods(),
        readKeysError(),
      ]);
      this.rawText = kf.raw;
      this.sections = kf.sections;
      this.parseError = kf.parseError;
      this.keysError = ke;
      this.quickActions = qa;
      this.modNames = mods.names;
      this.modTitles = mods.titles;
      if (this.history.initialRaw === null && kf.raw != null) {
        this.history.initialRaw = kf.raw;
      }
      this.loaded = true;
      this.installCaptureBindings(cx);
      this.applyInitialFocus(cx);
      cx.notify();
    });
  }

  /** Scrolls to and optionally starts recording on `props().focusAction`. */
  applyInitialFocus(cx) {
    if (this.focusApplied || !this.focusAction) return;
    this.focusApplied = true;
    if (this.focusAction.startsWith("quick-actions.run-")) {
      this.category = "quick-actions";
    }
    const { rows } = this.computeRows();
    const visible = this.filterRows(rows);
    const idx = visible.findIndex((r) => r.raw === this.focusAction || r.action === this.focusAction);
    if (idx < 0) return;
    this.listScroll.scroll_to_item(idx);
    if (this.autoRecord) {
      const row = visible[idx];
      const oldChord = row.chords[0] ?? null;
      this.startCapture(row, oldChord, oldChord ? "edit" : "add", cx);
    }
  }

  computeRows() {
    return buildRows({
      sections: this.sections,
      commands: commands() ?? [],
      quickActions: this.quickActions,
      modTitles: this.modTitles,
      showMac: showMacPref(),
      platform: this.platform,
    });
  }

  availableSections(rows) {
    const set = new Set(["global", "terminal", ...Object.keys(this.sections ?? {})]);
    for (const r of rows) set.add(r.section);
    return [...set].sort((a, b) => {
      const rank = (s) => (s === "global" ? 0 : s === "terminal" ? 1 : s.startsWith("layout:") ? 2 : 3);
      return rank(a) - rank(b) || a.localeCompare(b);
    });
  }

  matchesSection(row) {
    if (this.sectionFilter === "all") return true;
    return row.section === this.sectionFilter;
  }

  matchesSearch(row) {
    if (this.filterChord) {
      const target = this.filterChord;
      if (!row.chords.some((c) => c === target)) return false;
    }
    if (!this.query) return true;
    const hay = [
      row.label,
      row.description,
      row.raw,
      row.section,
      sectionLabel(row.section),
      ...row.chords,
      ...row.chords.map((c) => prettyChord(c, this.platform).toLowerCase()),
    ].join(" ").toLowerCase();
    return this.query.split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  matchesCategory(row, catId) {
    if (catId === "all") return true;
    if (catId === "unbound") return !row.bound;
    if (catId === "warnings") return row.warnings.length > 0;
    return row.category === catId;
  }

  filterRows(rows) {
    return rows
      .filter((r) => this.matchesSection(r) && this.matchesCategory(r, this.category) && this.matchesSearch(r))
      .sort((a, b) => {
        // Bound rows first, then alphabetical by label
        if (a.bound !== b.bound) return a.bound ? -1 : 1;
        return a.label.localeCompare(b.label);
      });
  }

  categoryCounts(rows) {
    const filteredBySecAndQuery = rows.filter((r) => this.matchesSection(r) && this.matchesSearch(r));
    const counts = {};
    for (const c of CATEGORIES) {
      counts[c.id] = filteredBySecAndQuery.filter((r) => this.matchesCategory(r, c.id)).length;
    }
    return counts;
  }

  // ---- Recording & Mutations ---------------------------------------------------------------

  isRecording() {
    return Boolean(
      this.recordingFilter ||
      (this.capture && !this.pending) ||
      (this.view === "new" && this.newForm?.recording),
    );
  }

  /**
   * Installs scoped GPUI key bindings under `KeybindsRecording` for Escape and every
   * shortcut in `keys.json` / `keys()`, so bound shortcuts are captured instead of firing.
   * Must not be called from `render()`.
   */
  installCaptureBindings(cx) {
    if (!this.escapeBound) {
      try {
        cx.bind_keys([{ keystroke: "escape", action: "kb_rec_escape", context: "KeybindsRecording" }]);
        this.escapeBound = true;
      } catch { /* ignore */ }
    }
    const chords = new Set();
    for (const map of Object.values(this.sections ?? {})) {
      for (const raw of Object.keys(map ?? {})) {
        const c = normalizeChord(raw);
        if (c && c !== "ctrl-alt-shift-escape" && c !== "escape") chords.add(c);
      }
    }
    for (const entry of keys() ?? []) {
      const c = normalizeChord(entry?.keys);
      if (c && c !== "ctrl-alt-shift-escape" && c !== "escape") chords.add(c);
    }

    const batch = [];
    for (const chord of chords) {
      if (this.installedCaptureKeys.has(chord)) continue;
      batch.push({ keystroke: chord, action: captureActionName(chord), context: "KeybindsRecording" });
    }
    if (!batch.length) return;

    try {
      cx.bind_keys(batch);
      for (const b of batch) {
        const chord = b.keystroke;
        this.installedCaptureKeys.add(chord);
        this.captureActionMap.set(b.action, chord);
      }
    } catch {
      for (const b of batch) {
        try {
          cx.bind_keys([b]);
          this.installedCaptureKeys.add(b.keystroke);
          this.captureActionMap.set(b.action, b.keystroke);
        } catch { /* skip chords rejected by GPUI */ }
      }
    }
  }

  cancelActiveRecording(cx) {
    if (this.recordingFilter) {
      this.recordingFilter = false;
      this.filterBlockedMsg = null;
      cx.notify();
      return;
    }
    if (this.view === "new" && this.newForm?.recording) {
      this.newForm.recording = false;
      this.newForm.blockedMsg = null;
      cx.notify();
      return;
    }
    if (this.capture && !this.pending) {
      this.cancelCapture(cx);
    }
  }

  handleCapturedChord(chord, cx) {
    if (this.recordingFilter) {
      this.filterChord = chord;
      this.recordingFilter = false;
      this.filterBlockedMsg = null;
      cx.notify();
      return;
    }

    if (this.view === "new" && this.newForm?.recording) {
      const check = chordOfEvent({ key: "x", keystroke: chord }, this.newForm.section);
      if (check?.blocked) {
        this.newForm.blockedMsg = check.blocked;
        cx.notify();
        return;
      }
      this.newForm.chord = check?.chord ?? chord;
      this.newForm.recording = false;
      this.newForm.blockedMsg = null;
      cx.notify();
      return;
    }

    if (this.capture && !this.pending) {
      const check = chordOfEvent({ key: "x", keystroke: chord }, this.capture.section);
      if (check?.blocked) {
        this.capture.blockedMsg = check.blocked;
        cx.notify();
        return;
      }
      const norm = check?.chord ?? chord;
      // Re-pressing the exact same chord cancels cleanly without rewriting disk.
      if (this.capture.oldChord && this.capture.oldChord === norm) {
        this.cancelCapture(cx);
        return;
      }
      const report = analyzeConflict(this.sections, this.capture.section, norm, {
        replacingChord: this.capture.oldChord,
        targetActionKey: this.capture.actionKey,
        targetAction: this.capture.action,
        platform: this.platform,
      });
      if (!report.sameSection && !report.crossSection.length && !report.warnings.length) {
        const next = setBinding(this.sections, {
          section: this.capture.section,
          chord: norm,
          action: this.capture.action,
          oldChord: this.capture.oldChord,
          mode: "replace",
        });
        this.commitSections(next, cx);
      } else {
        this.pending = { capture: this.capture, chord: norm, report };
        cx.notify();
      }
    }
  }

  startFilterRecord(cx) {
    this.installCaptureBindings(cx);
    this.capture = null;
    this.pending = null;
    this.recordingFilter = true;
    this.filterBlockedMsg = null;
    this.focusRoot(cx);
    cx.notify();
  }

  startCapture(row, oldChord, mode, cx) {
    this.installCaptureBindings(cx);
    this.recordingFilter = false;
    this.pending = null;
    this.saveError = null;
    this.capture = {
      rowId: row.id,
      section: row.section,
      action: row.action,
      actionKey: row.actionKey,
      oldChord,
      mode,
      blockedMsg: null,
    };
    this.focusRoot(cx);
    cx.notify();
  }

  cancelCapture(cx) {
    this.capture = null;
    this.pending = null;
    cx.notify();
  }

  openForm(cx) {
    this.capture = null;
    this.pending = null;
    this.recordingFilter = false;
    this.saveError = null;
    this.newForm = this.blankForm();
    if (this.sectionFilter !== "all") this.newForm.section = this.sectionFilter;
    this.view = "new";
    this.focusRoot(cx);
    cx.notify();
  }

  closeForm(cx) {
    this.view = "list";
    this.newForm.recording = false;
    this.saveError = null;
    cx.notify();
  }

  startFormRecord(cx) {
    this.installCaptureBindings(cx);
    this.newForm.recording = true;
    this.newForm.blockedMsg = null;
    this.focusRoot(cx);
    cx.notify();
  }

  saveNewForm(cx) {
    const res = resolveFormAction(this);
    if (res.error || !this.newForm.chord) {
      this.newForm.showError = true;
      cx.notify();
      return;
    }
    const next = setBinding(this.sections, {
      section: this.newForm.section,
      chord: this.newForm.chord,
      action: res.action,
      mode: "replace",
    });
    this.commitSections(next, cx, () => {
      this.view = "list";
      this.newForm.recording = false;
    });
  }

  /** Persists a new sections object atomically, tracks Undo, and checks keys.error. */
  commitSections(nextSections, cx, onSaved = null) {
    if (this.saving) return;
    if (this.parseError) {
      this.saveError = "Fix the JSON syntax error in keys.json before saving.";
      cx.notify();
      return;
    }
    const prevRaw = this.rawText ?? serializeDocument(this.sections);
    this.saving = true;
    this.saveError = null;
    this.confirmRestore = false;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const { raw } = await saveKeysFile(nextSections, this.rawText);
        if (prevRaw !== raw) {
          this.history.undo.push(prevRaw);
          this.history.redo = [];
        }
        this.rawText = raw;
        this.sections = nextSections;
        this.capture = null;
        this.pending = null;
        this.installCaptureBindings(cx);
        if (onSaved) onSaved();
        cx.timer.after(300, (cx) => this.checkKeysError(cx));
      } catch (e) {
        const msg = errMsg(e);
        if (/stale|changed|mismatch/i.test(msg)) {
          this.saveError = "keys.json changed on disk. Reloaded latest file; please try again.";
          this.reloadAll(cx);
        } else {
          this.saveError = `Could not save keys.json: ${msg}`;
        }
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  checkKeysError(cx) {
    cx.spawn(async (cx) => {
      const ke = await readKeysError();
      if (ke !== this.keysError) {
        this.keysError = ke;
        cx.notify();
      }
    });
  }

  undo(cx) {
    if (!this.history.undo.length || this.saving) return;
    const targetRaw = this.history.undo[this.history.undo.length - 1];
    this.applyRawSnapshot(targetRaw, cx, () => {
      this.history.undo.pop();
      this.history.redo.push(this.rawText);
    });
  }

  redo(cx) {
    if (!this.history.redo.length || this.saving) return;
    const targetRaw = this.history.redo[this.history.redo.length - 1];
    this.applyRawSnapshot(targetRaw, cx, () => {
      this.history.redo.pop();
      this.history.undo.push(this.rawText);
    });
  }

  restoreOriginal(cx) {
    if (this.history.initialRaw == null || this.history.initialRaw === this.rawText || this.saving) return;
    if (!this.confirmRestore) {
      this.confirmRestore = true;
      cx.notify();
      return;
    }
    const targetRaw = this.history.initialRaw;
    this.applyRawSnapshot(targetRaw, cx, () => {
      this.history.undo.push(this.rawText);
      this.history.redo = [];
      this.confirmRestore = false;
    });
  }

  applyRawSnapshot(targetRaw, cx, onMoved) {
    const parsed = parseDocument(targetRaw);
    if (parsed.parseError) return;
    this.saving = true;
    this.saveError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await saveRawKeysText(targetRaw, this.rawText);
        onMoved();
        this.rawText = targetRaw;
        this.sections = parsed.sections;
        this.capture = null;
        this.pending = null;
        cx.timer.after(300, (cx) => this.checkKeysError(cx));
      } catch (e) {
        this.saveError = `Could not restore keys.json: ${errMsg(e)}`;
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  resolvePending(mode, removeFromSections, cx) {
    if (!this.pending) return;
    const { capture, chord } = this.pending;
    const next = setBinding(this.sections, {
      section: capture.section,
      chord,
      action: capture.action,
      oldChord: capture.oldChord,
      mode,
      removeFromSections,
    });
    this.commitSections(next, cx);
  }

  deleteChord(row, chord, cx) {
    const next = removeBinding(this.sections, { section: row.section, chord });
    this.commitSections(next, cx);
  }

  // ---- Keyboard handling -------------------------------------------------------------------

  onKey(e, cx) {
    // 1. Active recording (Search filter, New Binding form, or inline row capture)
    if (this.isRecording()) {
      const noMods = !e.modifiers?.control && !e.modifiers?.alt && !e.modifiers?.shift && !e.modifiers?.platform;
      if (e.key === "backspace" && noMods) {
        this.cancelActiveRecording(cx);
        cx.stop_propagation();
        return;
      }
      const sec = this.recordingFilter
        ? "mod:filter"
        : (this.view === "new" && this.newForm?.recording) ? this.newForm.section : this.capture.section;
      const res = chordOfEvent(e, sec);
      if (!res) return;
      if (res.blocked) {
        if (this.recordingFilter) this.filterBlockedMsg = res.blocked;
        else if (this.view === "new" && this.newForm?.recording) this.newForm.blockedMsg = res.blocked;
        else if (this.capture) this.capture.blockedMsg = res.blocked;
        cx.stop_propagation();
        cx.notify();
        return;
      }
      this.handleCapturedChord(res.chord, cx);
      cx.stop_propagation();
      return;
    }

    // 2. Undo / Redo shortcuts when root has focus
    const primary = this.platform === "macos" ? e.modifiers?.platform : e.modifiers?.control;
    if (primary && !e.modifiers?.alt && e.key?.toLowerCase() === "z") {
      if (e.modifiers?.shift) this.redo(cx);
      else this.undo(cx);
      cx.stop_propagation();
      return;
    }

    // 5. Esc inside focused Input
    if (e.key === "escape") {
      if (this.view === "new") this.closeForm(cx);
      else if (this.query || this.filterChord) {
        this.search.set_value("");
        this.query = "";
        this.filterChord = null;
        cx.notify();
      } else {
        this.close_();
      }
      cx.stop_propagation();
    }
  }

  // ---- Rendering ---------------------------------------------------------------------------

  render() {
    if (kitOff()) return offView();
    const t = theme();
    let root = v_flex().id("keybinds-root").size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .track_focus(this.handle)
      .on_mouse_down("left", (_e, cx) => {
        if (this.confirmRestore) { this.confirmRestore = false; cx.notify(); }
        this.handle.focus();
      })
      .on_key_down((e, cx) => this.onKey(e, cx));

    if (this.isRecording()) {
      root = root
        .key_context("KeybindsRecording")
        .on_action("kb_rec_escape", (_e, cx) => this.cancelActiveRecording(cx));
      for (const [actionName, chord] of this.captureActionMap) {
        root = root.on_action(actionName, (_e, cx) => this.handleCapturedChord(chord, cx));
      }
    }
    return root.child(this.view === "new" ? renderNewForm(this, t) : this.renderListView(t));
  }

  renderListView(t) {
    const { rows, hiddenMacBindings } = this.computeRows();
    const counts = this.categoryCounts(rows);
    const sections = this.availableSections(rows);
    const visible = this.filterRows(rows);
    const showMac = showMacPref();
    const macHiddenAvailable = this.platform !== "macos" && hiddenMacBindings > 0;

    const header = h_flex().w_full().h(54).px(18).gap(10).items_center().flex_none().border_b(1).border_color(t.border)
      .child(div().size(30).flex_none().rounded(8).flex().items_center().justify_center().bg(U.tint(t.accent, "20"))
        .child(svg(U.icon("keyboard")).size(16).text_color(t.accent)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Keybinds"))
        .child(div().text_size(11).text_color(t.dim).child("Click any keycap to rebind · Esc cancels recording or closes")))
      .when(macHiddenAvailable || showMac, (el) => el.child(
        U.button(t, "kb-mac-toggle",
          showMac ? "Hide macOS" : `Show macOS (${hiddenMacBindings})`,
          (cx) => { setShowMacPref(!showMac); cx.notify(); },
          { kind: showMac ? "primary" : "plain", h: 26, tip: "Toggle visibility of cmd-* macOS shortcuts" })))
      .child(U.button(t, "kb-new-btn", "New", (cx) => this.openForm(cx), { kind: "primary", iconName: "plus", h: 26 }))
      .when(Boolean(U.closeX(t)), (el) => el.child(U.closeX(t)));

    const searchInput = div().flex_1().min_w(0).h_full().flex().items_center()
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          if (this.query || this.filterChord) {
            this.search.set_value("");
            this.query = "";
            this.filterChord = null;
            cx.notify();
          } else {
            this.close_();
          }
          cx.stop_propagation();
        }
      })
      .child(Input.new(this.search).h_full().w_full().text_size(12.2));

    const searchRow = h_flex().w_full().px(18).pt(10).pb(8).gap(8).items_center().flex_none().border_b(1).border_color(t.border)
      .child(h_flex().id("kb-search-box").flex_1().min_w(0).h(32).px(10).gap(8).items_center().rounded(8)
        .bg(t.background).border_1().border_color(this.query || this.filterChord ? t.accent : t.input).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(svg(U.icon("search")).size(13).flex_none().text_color(t.dim))
        .child(searchInput)
        .when(Boolean(this.filterChord), (el) => el.child(h_flex().gap(4).flex_none().items_center()
          .child(U.staticKeycaps(t, this.filterChord, this.platform))
          .child(div().id("kb-clear-chord").size(18).flex().items_center().justify_center().rounded(4).cursor_pointer()
            .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.filterChord = null; cx.notify(); })
            .child(svg(U.icon("close")).size(10)))))
        .when(Boolean(this.query), (el) => el.child(div().id("kb-clear-q").size(18).flex().items_center().justify_center().rounded(4).cursor_pointer()
          .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.search.set_value(""); this.query = ""; cx.notify(); })
          .child(svg(U.icon("close")).size(11)))))
      .child(this.recordingFilter
        ? h_flex().h(32).px(10).gap(6).flex_none().items_center().rounded(8).bg(U.tint(t.accent, "20")).border_1().border_color(t.accent)
          .child(svg(U.icon("record")).size(12).text_color(t.accent))
          .child(div().text_size(11.5).font_semibold().text_color(t.accent).child("Press key to filter…"))
          .child(div().id("kb-rec-filter-cancel").px(5).py(2).rounded(4).cursor_pointer().text_size(10.5).text_color(t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.recordingFilter = false; cx.notify(); })
            .child("Cancel"))
        : U.button(t, "kb-rec-filter", "Record Key", (cx) => this.startFilterRecord(cx),
          { iconName: "record", h: 32, tip: "Press a shortcut to find every action bound to it" }));

    const banners = v_flex().w_full().flex_none()
      .when(Boolean(this.parseError || this.keysError || this.saveError), (el) => el
        .child(h_flex().mx(18).mt(8).p(9).gap(8).items_center().rounded(7)
          .bg(U.tint(t.blocked, "18")).border_1().border_color(U.tint(t.blocked, "55"))
          .child(svg(U.icon("alert")).size(14).flex_none().text_color(t.blocked))
          .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.foreground).whitespace_normal()
            .child(this.saveError || this.parseError || `Herdr reported keys.error: ${this.keysError}`))));

    const sidebar = v_flex().id("kb-sidebar").w(188).flex_none().h_full().p(10).gap(10).border_r(1).border_color(t.border)
      .bg(t.chrome).overflow_y_scrollbar()
      .child(v_flex().gap(2)
        .child(div().px(8).pb(3).text_size(10.5).font_semibold().text_color(t.dim).child("CATEGORIES"))
        .children(CATEGORIES.filter((c) => {
          if (c.id === "quick-actions") return counts["quick-actions"] > 0 || this.quickActions.length > 0;
          if (c.id === "warnings") return counts.warnings > 0 || this.category === "warnings";
          return true;
        }).map((c) => {
          const on = this.category === c.id;
          const cnt = counts[c.id] ?? 0;
          return h_flex().id(`kb-cat-${c.id}`).w_full().h(27).px(8).gap(6).items_center().rounded(6).cursor_pointer()
            .bg(on ? t.selected : "#00000000").text_color(on ? t.foreground : t.muted)
            .when(on, (el) => el.font_semibold())
            .hover((s) => s.bg(on ? t.selected : t.hover))
            .on_click((_e, cx) => { this.category = c.id; this.capture = null; this.pending = null; cx.notify(); })
            .child(div().flex_1().min_w(0).truncate().text_size(12).child(c.label))
            .when(c.id === "warnings" && cnt > 0, (el) => el.child(div().size(6).rounded_full().bg(t.blocked)))
            .child(div().flex_none().text_size(10.8).text_color(on ? t.accent : t.dim).child(String(cnt)));
        })))
      .child(v_flex().gap(2).pt(4).border_t(1).border_color(t.border)
        .child(div().px(8).pb(3).text_size(10.5).font_semibold().text_color(t.dim).child("SECTIONS"))
        .child(this.sectionNavItem(t, "all", "All sections"))
        .children(sections.map((s) => this.sectionNavItem(t, s, sectionLabel(s)))));

    const listBody = !this.loaded
      ? v_flex().flex_1().items_center().justify_center().text_size(12.5).text_color(t.dim).child("Loading keys.json…")
      : !visible.length
        ? v_flex().flex_1().items_center().justify_center().gap(6).p(24)
          .child(div().text_size(13).font_medium().text_color(t.muted).child("No shortcuts match this filter"))
          .child(div().text_size(11.5).text_color(t.dim).child("Clear the search box or switch category/section."))
        : v_flex().id("kb-list").flex_1().min_w(0).h_full().p(12).gap(6).overflow_y_scrollbar().track_scroll(this.listScroll)
          .children(visible.map((row, idx) => this.renderRow(t, row, idx)));

    const canUndo = this.history.undo.length > 0 && !this.saving;
    const canRedo = this.history.redo.length > 0 && !this.saving;
    const canRestore = this.history.initialRaw != null && this.history.initialRaw !== this.rawText && !this.saving;

    const footer = h_flex().w_full().h(46).px(18).gap(8).items_center().flex_none().border_t(1).border_color(t.border).bg(t.surface)
      .child(U.button(t, "kb-undo", "Undo", (cx) => this.undo(cx), { iconName: "undo", disabled: !canUndo, h: 25, tip: "Undo last change (Ctrl+Z)" }))
      .child(U.button(t, "kb-redo", "Redo", (cx) => this.redo(cx), { iconName: "redo", disabled: !canRedo, h: 25, tip: "Redo change (Ctrl+Shift+Z)" }))
      .child(U.button(t, "kb-restore", this.confirmRestore ? "Click again to restore" : "Restore original", (cx) => this.restoreOriginal(cx),
        { kind: this.confirmRestore ? "danger" : "plain", iconName: "refresh", disabled: !canRestore, h: 25, tip: "Restore keys.json to how it was when this dialog opened" }))
      .child(div().flex_1())
      .child(div().text_size(11).text_color(t.dim).child(`${visible.length} ${visible.length === 1 ? "item" : "items"}`))
      .child(U.button(t, "kb-done", "Close", () => this.close_(), { h: 25 }));

    return v_flex().size_full().min_h(0)
      .child(header)
      .child(searchRow)
      .child(banners)
      .child(h_flex().flex_1().min_h(0).w_full()
        .child(sidebar)
        .child(listBody))
      .child(footer);
  }

  sectionNavItem(t, value, label) {
    const on = this.sectionFilter === value;
    return h_flex().id(`kb-sec-${value}`).w_full().h(25).px(8).items_center().rounded(6).cursor_pointer()
      .bg(on ? t.selected : "#00000000").text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.font_semibold())
      .hover((s) => s.bg(on ? t.selected : t.hover))
      .on_click((_e, cx) => { this.sectionFilter = value; this.capture = null; this.pending = null; cx.notify(); })
      .child(div().truncate().text_size(11.8).child(label));
  }

  renderRow(t, row, idx) {
    const cap = this.capture?.rowId === row.id ? this.capture : null;
    const pend = this.pending && this.pending.capture.rowId === row.id ? this.pending : null;
    const focusedRow = this.focusAction && (row.raw === this.focusAction || row.action === this.focusAction);

    const secColor = sectionKind(row.section) === "terminal" ? t.ansi4 : sectionKind(row.section) === "layout" ? t.ansi5 : t.ansi6;
    const qaIcon = row.iconPath ? svg(row.iconPath).size(14).flex_none().text_color(row.orphaned ? t.blocked : t.accent) : null;

    const topLine = h_flex().w_full().gap(10).items_center()
      .when(Boolean(qaIcon), (el) => el.child(div().size(24).flex_none().rounded(6).flex().items_center().justify_center()
        .bg(U.tint(row.orphaned ? t.blocked : t.accent, "1c")).child(qaIcon)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(6).items_center().flex_wrap()
          .child(div().text_size(12.8).font_semibold().text_color(row.bound ? t.foreground : t.muted).child(row.label))
          .when(row.section !== "global", (el) => el.child(U.badge(t, sectionLabel(row.section), secColor)))
          .when(row.orphaned, (el) => el.child(U.badge(t, "orphaned", t.blocked, { tip: "This Quick Action was deleted" })))
          .when(row.shadows.some((s) => s.relation === "shadowed_by"), (el) => el.child(U.badge(t, "shadowed", t.ansi3, {
            tip: row.shadows.filter((s) => s.relation === "shadowed_by").map((s) => `${prettyChord(s.chord, this.platform)} overridden by ${sectionLabel(s.section)}`).join("\n"),
          })))
          .when(row.warnings.includes("terminal_key") || row.warnings.includes("altgr"), (el) => el.child(U.badge(t, "caution", t.ansi3, {
            tip: "Intercepts a terminal Ctrl key or Windows AltGr combination",
          }))))
        .child(h_flex().gap(6).items_center()
          .child(div().font_family(U.mono()).text_size(10.8).text_color(t.dim).truncate().child(row.raw))
          .when(Boolean(row.description), (el) => el.child(div().text_size(11).text_color(t.dim).truncate().child(`· ${row.description}`)))))
      .child(h_flex().gap(5).flex_none().items_center()
        .children(row.chords.map((chord, cIdx) => {
          const isRec = Boolean(cap && !pend && cap.mode === "edit" && cap.oldChord === chord);
          return U.keycapGroup(t, {
            id: `kb-cap-${idx}-${cIdx}`,
            chord,
            platform: this.platform,
            recording: isRec,
            onEdit: (cx) => this.startCapture(row, chord, "edit", cx),
            onRemove: (cx) => this.deleteChord(row, chord, cx),
            onCancel: (cx) => this.cancelCapture(cx),
          });
        }))
        .when(Boolean(cap && !pend && cap.mode === "add"), (el) => el.child(U.keycapGroup(t, {
          id: `kb-add-rec-${idx}`,
          chord: "",
          platform: this.platform,
          recording: true,
          onCancel: (cx) => this.cancelCapture(cx),
        })))
        .when(!cap || cap.mode !== "add", (el) => el.child(div().id(`kb-add-${idx}`).size(24).flex().items_center().justify_center()
          .rounded(6).cursor_pointer().border_1().border_color(t.border).bg(t.background).text_color(t.muted)
          .hover((s) => s.border_color(t.accent).text_color(t.accent).bg(t.hover))
          .tooltip(row.bound ? "Add another shortcut" : "Assign shortcut")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.startCapture(row, null, "add", cx))
          .child(svg(U.icon("plus")).size(12)))));

    return v_flex().id(`kb-row-${idx}`).w_full().flex_none().px(12).py(9).gap(8).rounded(9)
      .bg(focusedRow || cap ? t.raised : t.surface)
      .border_1().border_color(cap || pend ? t.accent : focusedRow ? U.tint(t.accent, "88") : t.border)
      .hover((s) => s.border_color(cap || pend ? t.accent : t.input))
      .child(topLine)
      .when(Boolean(cap?.blockedMsg && !pend), (el) => el.child(
        h_flex().gap(6).items_center().px(8).py(5).rounded(6).bg(U.tint(t.blocked, "18"))
          .child(svg(U.icon("alert")).size(12).flex_none().text_color(t.blocked))
          .child(div().text_size(11.3).text_color(t.blocked).child(cap.blockedMsg))))
      .when(Boolean(pend), (el) => el.child(this.renderConflictPanel(t, pend, idx)));
  }

  renderConflictPanel(t, pend, idx) {
    const { capture, chord, report } = pend;
    const same = report.sameSection;
    const cross = report.crossSection;
    const warns = report.warnings;
    const danger = Boolean(same) || warns.length > 0;
    const color = danger ? t.blocked : t.ansi3;
    const label = prettyChord(chord, this.platform);

    const higherSections = cross.filter((c) => c.relation === "shadowed_by").map((c) => c.section);
    const allCrossSections = cross.map((c) => c.section);

    return v_flex().w_full().gap(7).p(10).rounded(8).bg(U.tint(color, "14")).border_1().border_color(U.tint(color, "55"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().gap(8).items_center()
        .child(svg(U.icon(danger ? "alert" : "shield")).size(14).flex_none().text_color(color))
        .child(U.staticKeycaps(t, chord, this.platform))
        .child(div().flex_1().min_w(0).text_size(12).font_semibold().text_color(t.foreground)
          .child(same ? `Already bound in ${sectionLabel(capture.section)}` : "Shortcut overlap / caution")))
      .when(Boolean(same), (el) => el.child(div().text_size(11.5).text_color(t.muted).whitespace_normal()
        .child(`${label} currently runs "${typeof same.otherAction === "string" ? same.otherAction : same.otherAction.command}" in ${sectionLabel(capture.section)}.`)))
      .children(cross.map((c) => div().text_size(11.5).text_color(t.muted).whitespace_normal()
        .child(c.relation === "shadowed_by"
          ? `Shadowed by ${sectionLabel(c.section)} (currently runs "${typeof c.otherAction === "string" ? c.otherAction : c.otherAction.command}").`
          : `Overrides ${sectionLabel(c.section)} (currently runs "${typeof c.otherAction === "string" ? c.otherAction : c.otherAction.command}").`)))
      .when(warns.includes("terminal_key"), (el) => el.child(div().text_size(11.5).text_color(t.muted).whitespace_normal()
        .child("Programs in your terminal rely on this Ctrl+letter key. Binding it stops it from reaching shells and editors.")))
      .when(warns.includes("altgr"), (el) => el.child(div().text_size(11.5).text_color(t.muted).whitespace_normal()
        .child("Ctrl+Alt acts as AltGr on Windows international keyboards and may interfere with typing characters.")))
      .child(h_flex().gap(6).flex_wrap().pt(2)
        .when(Boolean(same), (el) => el
          .child(U.button(t, `kb-conf-rep-${idx}`, "Replace", (cx) => this.resolvePending("replace", [], cx),
            { kind: "danger", iconName: "check", h: 25, tip: "Assign here and remove from the conflicting action" }))
          .when(same.canSwap, (s) => s.child(U.button(t, `kb-conf-swap-${idx}`, `Swap with ${prettyChord(capture.oldChord, this.platform)}`,
            (cx) => this.resolvePending("swap", [], cx),
            { iconName: "swap", h: 25, tip: "Exchange the two shortcuts" }))))
        .when(!same, (el) => el
          .child(U.button(t, `kb-conf-save-${idx}`, warns.length ? "Bind anyway" : "Save anyway",
            (cx) => this.resolvePending("replace", [], cx), { kind: warns.length ? "danger" : "primary", iconName: "check", h: 25 })))
        .when(!same && allCrossSections.length > 0, (el) => el
          .child(U.button(t, `kb-conf-take-${idx}`,
            higherSections.length ? `Save & remove from ${higherSections.map(sectionLabel).join(", ")}` : `Save & remove from ${allCrossSections.map(sectionLabel).join(", ")}`,
            (cx) => this.resolvePending("replace", allCrossSections, cx), { h: 25 })))
        .child(U.button(t, `kb-conf-cancel-${idx}`, "Cancel", (cx) => this.cancelCapture(cx), { h: 25 })));
  }
}
