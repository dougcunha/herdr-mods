// Herdr Mods (mods-hub): the central dialog of the Herdr mods of
// https://github.com/dougcunha/herdr-mods.
//
// In the status row of a layout, it compares the version of SETUP-PROMPT.md
// on GitHub with the version of the last run of the prompt on this machine
// (data/herdr-mods-setup.json). When GitHub has a newer version, it shows an
// "Update mods" button and posts 1 toast. The button (or `mod.open`) opens
// this mod as a dialog with 3 tabs: Mods (the installed mods, where they come
// from, errors and local changes), What's new (whats-new/<version>.md) and
// Update (the person chooses an agent, and the mod starts it in a new space
// with the prompt of SETUP-PROMPT.md).

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";
import { theme, props, run, notify, closeOverlay, knownAgents, panes, appHome, nextCommand } from "herdr";
import {
  MOD, REPO, CHECK_EVERY, icon, download, downloadNotes, downloadReadme, noteVersions, installedVersion, readRecord,
  writePrompt, state, setState, updateAvailable,
} from "./setup.js";
import { scanMods, checkChanges } from "./mods.js";

const TABS = [["mods", "Mods"], ["news", "What's new"], ["update", "Update"]];
const ORIGINS = [["kit", "Kit"], ["third", "Third-party"], ["manual", "Manual"], ["herdr", "Herdr"]];

/** A color with an alpha suffix (`"#rrggbb" + "aa"`). Other colors pass through. */
const tint = (color, alpha = "24") => (/^#[0-9a-f]{6}$/i.test(color || "") ? color + alpha : color);

/** How often a copy reads the local record again (the agent writes it at the end of a run). */
const READ_EVERY = 60 * 1000;

const errorText = (e) => String(e?.message ?? e);

export default class ModsUpdate extends View {
  init(_props, cx) {
    this.dialog = !!props()?.overlay;
    this.local = null; // the version of the last run here; null until read
    this.checking = false;
    if (this.dialog) return this.initDialog(cx);

    cx.timer.every(READ_EVERY, (cx) => this.readLocal(cx));
    cx.timer.every(10 * 60 * 1000, (cx) => this.check(cx, false));
    this.readLocal(cx);
    this.check(cx, false);
    // `herdr-app do mods-hub.check` (or a key bound to it) checks GitHub now.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "check") {
          this.readLocal(cx);
          this.check(cx, true);
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Data

  readLocal(cx) {
    cx.spawn(async (cx) => {
      this.local = await installedVersion();
      this.announce();
      cx.notify();
    });
  }

  /** Downloads SETUP-PROMPT.md when the last check is old (or `force`). */
  check(cx, force) {
    if (this.checking) return;
    if (!force && Date.now() - (state().checkedAt ?? 0) < CHECK_EVERY) return;
    // In the dialog, a forced check also downloads the release notes again.
    if (this.dialog && force) this.notes.clear();
    this.checking = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { version } = await download();
        setState({ remote: version, checkedAt: Date.now(), error: null });
      } catch (e) {
        // Keep the last version that we know.
        setState({ checkedAt: Date.now(), error: errorText(e) });
      }
      this.checking = false;
      this.announce();
      if (this.dialog) this.loadNotes(cx);
      cx.notify();
    });
  }

  /** Downloads the release notes that the "What's new" tab shows and that are not loaded yet. */
  loadNotes(cx) {
    if (this.local == null) return;
    const wanted = noteVersions(this.local, state().remote).filter((n) => !this.notes.has(n));
    if (!wanted.length) return;
    for (const n of wanted) this.notes.set(n, { loading: true });
    cx.notify();
    cx.spawn(async (cx) => {
      await Promise.all(wanted.map(async (n) => {
        try {
          this.notes.set(n, { text: await downloadNotes(n) });
        } catch (e) {
          this.notes.set(n, { error: errorText(e) });
        }
      }));
      cx.notify();
    });
  }

  /** Posts 1 toast for each new version. Only the status copies do it. */
  announce() {
    if (this.dialog || this.local == null || !updateAvailable(this.local)) return;
    const { remote, notified } = state();
    if (notified === remote) return;
    setState({ notified: remote });
    notify({
      title: "Herdr mods update",
      body: `Version ${remote} is available. Click to update.`,
      level: "info",
      icon: icon("update"),
      timeout: 15000,
      action: { name: "mod.open", args: { name: MOD } },
    });
  }

  // ---------------------------------------------------------------------------
  // Dialog

  initDialog(cx) {
    this.agents = null; // installed agents; null until known
    this.busy = null; // the key of the agent that starts
    this.launchError = null;
    this.tab = null; // "mods", "news" or "update"; set when the local version is known
    this.notes = new Map(); // version -> { loading } | { text } (null text: no file) | { error }
    // Mods tab
    this.mods = null; // scanMods() result; null until read
    this.record = null; // the setup record
    this.changes = new Map(); // mod name -> checkChanges() result (null: nothing to compare)
    this.filter = "kit";
    this.openMod = null; // the name of the expanded row
    this.readme = null; // { app, name, loading } | { app, name, text } | { app, name, error }
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(40, () => this.handle.focus());
    this.loadMods(cx);
    cx.spawn(async (cx) => {
      this.local = await installedVersion();
      this.tab = this.startTab();
      if (this.tab === "news") setState({ newsSeen: state().remote });
      this.loadNotes(cx);
      cx.notify();
      try {
        this.agents = (await knownAgents()).filter((a) => a.installed && a.run?.length);
      } catch (e) {
        this.agents = [];
        this.launchError = errorText(e);
      }
      cx.notify();
    });
    // The dialog shows the newest state: check again if the last check is older than 5 minutes.
    if (Date.now() - (state().checkedAt ?? 0) > 5 * 60 * 1000) this.check(cx, true);
  }

  close() {
    if (props()?.overlay) closeOverlay(props().overlay);
  }

  launch(agent, cx) {
    if (this.busy) return;
    this.busy = agent.key;
    this.launchError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let path;
      let version;
      try {
        const setup = await download();
        if (!setup.prompt) throw new Error("SETUP-PROMPT.md has no prompt-start and prompt-end markers");
        version = setup.version;
        setState({ remote: version, checkedAt: Date.now(), error: null });
        path = await writePrompt(setup.prompt);
      } catch (e) {
        this.busy = null;
        this.launchError = errorText(e);
        cx.notify();
        return;
      }
      // The task is 1 short line: the prompt has many lines, quotes and `$`,
      // which a shell or a terminal can change. The agent reads the file.
      const task = `Read the file ${path} and follow the instructions in it. It is the prompt of SETUP-PROMPT.md, version ${version}, from ${REPO}.`;
      const before = new Set(panes().map((p) => p.terminal).filter(Boolean));
      try {
        // It starts in ~/.config/herdr-app: the AGENTS.md of the Herdr app is there.
        run("space.new", { name: "Mods update", folder: appHome(), argv: agent.run, task });
      } catch (e) {
        this.busy = null;
        this.launchError = errorText(e);
        cx.notify();
        return;
      }
      // Focus the new terminal, so every layout shows it (the kanban layout
      // follows the focused pane, not the selected space).
      let tries = 0;
      const focusNew = (cx) => {
        const fresh = panes().find((p) => p.terminal && !before.has(p.terminal));
        if (fresh) run("pane.focus", { terminal: fresh.terminal });
        if (fresh || ++tries >= 20) return this.close();
        cx.timer.after(100, focusNew);
      };
      focusNew(cx);
    });
  }

  skip(cx) {
    setState({ skipped: state().remote });
    cx.notify();
  }

  /**
   * The first tab: What's new when an update is available and the dialog did
   * not show its notes yet, else the last tab that the person clicked, else Mods.
   */
  startTab() {
    const s = state();
    if (this.local != null && updateAvailable(this.local) && s.newsSeen !== s.remote) return "news";
    return TABS.some(([k]) => k === s.tab) ? s.tab : "mods";
  }

  /** The tab that the dialog shows. */
  shownTab() {
    return this.tab ?? "mods";
  }

  /** Reads the mods folder and the record, then checks the kit mods for local changes. */
  loadMods(cx) {
    this.mods = null;
    this.changes.clear();
    cx.notify();
    cx.spawn(async (cx) => {
      this.record = await readRecord();
      try {
        this.mods = await scanMods(this.record);
      } catch (e) {
        this.mods = [];
        this.modsError = errorText(e);
      }
      cx.notify();
      const files = this.record?.files ?? {};
      for (const m of this.mods.filter((m) => m.origin === "kit")) {
        this.changes.set(m.name, await checkChanges(m.name, files[m.name]).catch(() => null));
        cx.notify();
      }
    });
  }

  /** Shows the README of an app folder, downloaded from GitHub. */
  showReadme(mod, cx) {
    const app = mod.app;
    this.readme = { app, name: mod.name, loading: true };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const text = await downloadReadme(app);
        if (this.readme?.app === app) this.readme = { app, name: mod.name, text: text ?? "*This folder has no README.md on GitHub.*" };
      } catch (e) {
        if (this.readme?.app === app) this.readme = { app, name: mod.name, error: errorText(e) };
      }
      cx.notify();
    });
  }

  selectTab(key, cx) {
    this.tab = key;
    this.readme = null;
    setState({ tab: key });
    if (key === "news") this.loadNotes(cx);
    cx.notify();
  }

  onKey(e, cx) {
    // Esc closes the dialog before the mod sees it: Backspace and ← go back from a README.
    if (this.readme && (e.key === "backspace" || e.key === "left")) {
      this.readme = null;
      cx.notify();
      return;
    }
    if (this.shownTab() !== "update") return;
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= 9 && this.agents?.[n - 1]) this.launch(this.agents[n - 1], cx);
  }

  // ---------------------------------------------------------------------------
  // Drawing

  render() {
    return this.dialog ? this.renderDialog(theme()) : this.renderStatus(theme());
  }

  /** The status row item: same bar look as workspace-status (chrome fill, top border, 11.8 px text). */
  renderStatus(t) {
    const s = state();
    const local = this.local ?? 0;
    const update = this.local != null && updateAvailable(local);
    const button = h_flex().id("mu-open").h(20).px(6).gap(6).items_center().rounded(5).cursor_pointer()
      .on_click(() => run("mod.open", { name: MOD }));
    const bar = h_flex().id("mods-hub").size_full().pr(14).items_center().justify_end()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8);
    if (update) {
      return bar.child(button.px(8).bg(tint(t.accent)).text_color(t.accent).font_semibold()
        .hover((st) => st.bg(t.accent).text_color(t.accent_foreground))
        .tooltip(`Version ${s.remote} of the Herdr mods is available (your last setup run: ${local || "none recorded"}). Click to choose an agent.`)
        .child(svg(icon("update")).size(12))
        .child("Update mods"));
    }
    const tip = s.error ? `Could not check GitHub: ${s.error}` : `Herdr mods: setup version ${local || "none recorded"}. Click to open Herdr Mods.`;
    return bar.child(button.text_color(t.dim)
      .hover((st) => st.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .child(svg(icon(this.checking ? "refresh" : "check")).size(12))
      .child(local ? `mods v${local}` : "mods"));
  }

  renderDialog(t) {
    const s = state();
    const local = this.local ?? 0;
    const update = this.local != null && updateAvailable(local);
    const yours = local ? `version ${local}` : "none recorded";

    let status;
    let statusColor = t.muted;
    if (this.checking && s.remote == null) status = "Checking GitHub…";
    else if (s.remote == null) {
      status = `Could not check GitHub${s.error ? `: ${s.error}` : "."}`;
      statusColor = t.blocked;
    } else if (update) {
      status = `Version ${s.remote} is available. Your last setup run: ${yours}.`;
      statusColor = t.foreground;
    } else if (s.remote > local && s.remote === s.skipped) status = `You skipped version ${s.remote}. Your last setup run: ${yours}.`;
    else status = `You have the newest version (${s.remote}).`;

    const agents = this.agents;
    const note = (text) => div().text_size(12).text_color(t.dim).child(text);
    const rows = agents == null ? [note("Looking for installed agents…")]
      : agents.length === 0 ? [note("No installed agent found. Herdr lists the agents of programs.json that have a \"run\" entry.")]
      : agents.slice(0, 9).map((a, i) => {
        const busy = this.busy === a.key;
        return h_flex().id(`mu-agent-${a.key}`).w_full().h(40).px(10).gap(10).items_center().rounded(6)
          .cursor_pointer().hover((st) => st.bg(t.hover))
          .when(busy, (el) => el.bg(t.selected))
          .on_click((_e, cx) => this.launch(a, cx))
          .child(programTile(t, a, 26))
          .child(div().flex_1().truncate().child(a.name))
          .child(div().text_size(11.5).text_color(t.dim).child(busy ? "Starting…" : String(i + 1)));
      });
    const list = v_flex().w_full().gap(2).children(rows);

    const tab = this.shownTab();
    const tabButton = (key, label) => {
      const on = tab === key;
      return h_flex().id(`mu-tab-${key}`).h(28).px(12).items_center().cursor_pointer().text_size(12.5)
        .border_b(2).border_color(on ? t.accent : t.popover)
        .text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_semibold())
        .hover((st) => st.text_color(t.foreground))
        .on_click((_e, cx) => this.selectTab(key, cx))
        .child(label);
    };
    const tabs = h_flex().w_full().gap(4).border_b(1).border_color(t.border)
      .children(TABS.map(([key, label]) => tabButton(key, label)));

    const footButton = (id, label, onClick) =>
      h_flex().id(id).h(28).px(12).items_center().rounded(6).cursor_pointer().text_size(12.5)
        .border_1().border_color(t.border).text_color(t.foreground)
        .hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => onClick(cx))
        .child(label);

    return v_flex().id("mods-hub-dialog").w_full().p(18).gap(12).bg(t.popover).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(h_flex().gap(8).items_center()
        .child(svg(icon("hub")).size(18).text_color(update ? t.accent : t.muted))
        .child(div().text_size(15).font_semibold().child("Herdr Mods")))
      .child(div().text_color(statusColor).child(status))
      .child(tabs)
      .when(tab === "mods", (el) => el.child(this.readme ? this.renderReadme(t) : this.renderMods(t)))
      .when(tab === "update", (el) => el
        .child(div().text_size(12).text_color(t.dim).child(
          "The agent that you choose gets the prompt of SETUP-PROMPT.md in a new space. "
          + "It installs the new mods and updates the ones that you did not change. "
          + "It asks you before it replaces a file that exists."))
        .child(div().text_size(12).font_semibold().text_color(t.muted)
          .child(update ? "Choose an agent to update the mods:" : "Choose an agent to run the setup again:"))
        .child(list)
        .when(!!this.launchError, (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.launchError))))
      .when(tab === "news", (el) => el.child(this.renderNotes(t, local, s.remote)))
      .child(h_flex().w_full().pt(4).gap(8).items_center()
        .child(footButton("mu-check", this.checking ? "Checking…" : "Check now", (cx) => {
          this.check(cx, true);
          if (tab === "mods") this.loadMods(cx);
        }))
        .child(div().flex_1())
        .when(update, (el) => el.child(footButton("mu-skip", `Skip version ${s.remote}`, (cx) => this.skip(cx))))
        .child(footButton("mu-close", "Close", () => this.close())));
  }

  /** The Mods tab: origin chips, a line about the record, and 1 row per mod (a click shows the details). */
  renderMods(t) {
    const box = v_flex().id("mh-mods").w_full().h(330).rounded(6).bg(t.background).border_1().border_color(t.border)
      .overflow_y_scrollbar();
    const message = (text, color = t.dim) => box.child(div().p(12).text_size(12).text_color(color).child(text));
    if (this.mods == null) return message("Reading the mods folder…");
    if (this.modsError && !this.mods.length) return message(`Could not read the mods folder: ${this.modsError}`, t.blocked);

    const counts = Object.fromEntries(ORIGINS.map(([k]) => [k, this.mods.filter((m) => m.origin === k).length]));
    const chip = ([key, label]) => {
      const on = this.filter === key;
      return h_flex().id(`mh-f-${key}`).h(24).px(9).gap(6).items_center().rounded(6).cursor_pointer().text_size(12)
        .bg(on ? t.raised : t.popover).border_1().border_color(on ? t.border : t.popover)
        .text_color(on ? t.foreground : t.muted).hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => { this.filter = key; this.openMod = null; cx.notify(); })
        .child(label)
        .child(div().text_size(10.5).text_color(t.dim).child(String(counts[key])));
    };

    const r = this.record;
    const recordLine = !r ? "No setup run recorded. Run the setup (Update tab) to check the kit mods for local changes."
      : r.files ? `Setup version ${r.version ?? "?"}${r.commit ? ` · commit ${String(r.commit).slice(0, 7)}` : ""}. Local changes are compared with that commit.`
      : `Setup version ${r.version ?? "?"}. The record has no file hashes: run the setup again to check for local changes.`;

    const shown = this.mods.filter((m) => m.origin === this.filter);
    const rows = shown.length ? shown.map((m) => this.modRow(t, m))
      : [div().p(12).text_size(12).text_color(t.dim).child("No mod of this kind is installed.")];
    return v_flex().w_full().gap(8)
      .child(h_flex().w_full().gap(4).flex_wrap().children(ORIGINS.map(chip)))
      .child(div().text_size(11.5).text_color(t.dim).child(recordLine))
      .child(box.children(rows));
  }

  /** 1 row of the Mods tab. */
  modRow(t, m) {
    const open = this.openMod === m.name;
    const ch = this.changes.get(m.name);
    const nChanged = ch ? ch.changed.length + ch.missing.length : 0;
    const dot = m.errors.length ? t.blocked
      : nChanged ? t.ansi3
      : m.origin === "kit" && ch ? t.ansi2
      : t.dim;
    const pill = (label, color) => h_flex().h(18).px(6).flex_none().items_center().rounded(5).text_size(10.5)
      .bg(tint(color, "22")).text_color(color).child(label);
    const line = (label, value, color = t.muted) => h_flex().w_full().gap(6).text_size(11.5)
      .child(div().w(70).flex_none().text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).text_color(color).child(value));

    const head = h_flex().id(`mh-row-${m.name}`).w_full().h(34).px(10).gap(8).items_center().cursor_pointer()
      .hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { this.openMod = open ? null : m.name; cx.notify(); })
      .child(div().size(8).flex_none().rounded(4).bg(dot))
      .child(div().flex_none().font_semibold().child(m.name))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(m.title && m.title !== m.name ? m.title : ""))
      .when(m.errors.length > 0, (el) => el.child(pill("error", t.blocked)))
      .when(nChanged > 0, (el) => el.child(pill(`${nChanged} changed`, t.ansi3)))
      .when(Boolean(m.app), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(m.app)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(open ? "▾" : "▸"));

    const details = v_flex().w_full().px(26).pb(10).gap(4)
      .when(Boolean(m.description), (el) => el.child(div().pb(2).text_size(12).text_color(t.muted).child(m.description)))
      .when(m.origin === "kit", (el) => {
        if (ch === undefined) return el.child(line("Files", "Checking…", t.dim));
        if (ch === null) return el.child(line("Files", "No hashes in the setup record for this mod.", t.dim));
        const none = !ch.changed.length && !ch.missing.length && !ch.added.length;
        return el
          .when(none, (x) => x.child(line("Files", "Same as the setup run.", t.ansi2)))
          .when(ch.changed.length > 0, (x) => x.child(line("Changed", ch.changed.join(", "), t.ansi3)))
          .when(ch.missing.length > 0, (x) => x.child(line("Missing", ch.missing.join(", "), t.blocked)))
          .when(ch.added.length > 0, (x) => x.child(line("Only here", ch.added.join(", "))));
      })
      .when(m.origin === "herdr", (el) => el.child(line("Origin", "Installed by Herdr. Herdr updates it.")))
      .when(m.origin === "third", (el) => el.child(line("Origin", m.readme)))
      .when(m.origin === "manual", (el) => el.child(line("Origin", "Not from this kit, a known third party or Herdr.")))
      .children(m.errors.map((er) => line(er.file, er.text || "(empty)", t.blocked)))
      .when(m.origin === "kit" && Boolean(m.app), (el) => el.child(h_flex().pt(4)
        .child(h_flex().id(`mh-readme-${m.name}`).h(24).px(10).items_center().rounded(6).cursor_pointer().text_size(12)
          .border_1().border_color(t.border).text_color(t.foreground).hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => this.showReadme(m, cx))
          .child(`README of ${m.app}`))));

    return v_flex().w_full().flex_none().border_b(1).border_color(t.border)
      .child(head)
      .when(open, (el) => el.child(details));
  }

  /** The README of an app folder, in place of the list, with a back button. */
  renderReadme(t) {
    const rd = this.readme;
    const body = rd.loading ? "*Loading…*" : rd.error ? `*Could not download the README: ${rd.error}*` : rd.text;
    const id = `mh-readme-${rd.app}-${String(body).length}`;
    return v_flex().w_full().gap(8)
      .child(h_flex().w_full().gap(8).items_center()
        .child(h_flex().id("mh-back").h(24).px(10).items_center().rounded(6).cursor_pointer().text_size(12)
          .border_1().border_color(t.border).hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => { this.readme = null; cx.notify(); })
          .child("← Back"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(`${rd.app}/README.md · Backspace goes back`)))
      .child(div().w_full().h(330).p(12).rounded(6).bg(t.background).border_1().border_color(t.border).text_size(12.5)
        .child(TextView.markdown(id, body).scrollable(true).selectable(true).size_full()));
  }

  /** The "What's new" tab: the notes of each version, newest first, in 1 scrollable box. */
  renderNotes(t, local, remote) {
    const versions = this.local == null ? [] : noteVersions(local, remote);
    const box = div().w_full().h(280).p(12).rounded(6).bg(t.background).border_1().border_color(t.border)
      .text_size(12.5).text_color(t.foreground);
    const message = (text, color = t.dim) => box.child(div().text_size(12).text_color(color).child(text));
    if (this.local == null || (remote == null && this.checking)) return message("Checking GitHub…");
    if (!versions.length) return message("Could not check GitHub, so the release notes are not known.", t.blocked);
    const parts = versions.map((n) => {
      const note = this.notes.get(n);
      const body = !note || note.loading ? "*Loading…*"
        : note.error ? `*Could not download the notes: ${note.error}*`
        : note.text ?? "*No notes for this version.*";
      return `## Version ${n}\n\n${body}`;
    });
    const markdown = parts.join("\n\n");
    // A new id when the text changes makes the view draw the new text.
    const id = `mu-notes-${versions.join("-")}-${markdown.length}`;
    return box.child(TextView.markdown(id, markdown).scrollable(true).selectable(true).size_full());
  }
}

/** The tile of a program from knownAgents(): its icon on its tile color. */
function programTile(t, program, size) {
  const glyph = Math.round(size * 0.56);
  const drawn = !program?.icon
    ? svg(icon("update")).size(glyph).text_color(t.foreground)
    : program.tint
      ? svg(program.icon).size(glyph).text_color(program.color ?? "#ffffff")
      : image(program.icon).size(glyph);
  return h_flex().size(size).flex_none().rounded(Math.round(size * 0.28)).items_center().justify_center()
    .bg(program?.tile ?? t.raised).border_1().border_color(tint("#ffffff", "14"))
    .child(drawn);
}
