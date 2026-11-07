// Mods update: offers to update the Herdr mods of
// https://github.com/dougcunha/herdr-mods.
//
// In the status row of a layout, it compares the version of SETUP-PROMPT.md
// on GitHub with the version of the last run of the prompt on this machine
// (data/herdr-mods-setup.json). When GitHub has a newer version, it shows an
// "Update mods" button and posts 1 toast. The button (or `mod.open`) opens
// this mod as a dialog: the person chooses an agent, and the mod starts it
// in a new space with the prompt of SETUP-PROMPT.md. The "What's new" tab of
// the dialog shows the release notes in whats-new/<version>.md.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";
import { theme, props, run, notify, closeOverlay, knownAgents, panes, appHome, nextCommand } from "herdr";
import {
  MOD, REPO, CHECK_EVERY, icon, download, downloadNotes, noteVersions, installedVersion, writePrompt,
  state, setState, updateAvailable,
} from "./setup.js";

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
    // `herdr-app do mods-update.check` (or a key bound to it) checks GitHub now.
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
    this.tab = null; // "update" or "news"; null: "news" when an update is available, else "update"
    this.notes = new Map(); // version -> { loading } | { text } (null text: no file) | { error }
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(40, () => this.handle.focus());
    cx.spawn(async (cx) => {
      this.local = await installedVersion();
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

  /** The tab that the dialog shows. */
  shownTab() {
    if (this.tab) return this.tab;
    return this.local != null && updateAvailable(this.local) ? "news" : "update";
  }

  onKey(e, cx) {
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
    const bar = h_flex().id("mods-update").size_full().pr(14).items_center().justify_end()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8);
    if (update) {
      return bar.child(button.px(8).bg(tint(t.accent)).text_color(t.accent).font_semibold()
        .hover((st) => st.bg(t.accent).text_color(t.accent_foreground))
        .tooltip(`Version ${s.remote} of the Herdr mods is available (your last setup run: ${local || "none recorded"}). Click to choose an agent.`)
        .child(svg(icon("update")).size(12))
        .child("Update mods"));
    }
    const tip = s.error ? `Could not check GitHub: ${s.error}` : `Herdr mods: setup version ${local || "none recorded"}. Click to check or run the setup again.`;
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
        .on_click((_e, cx) => {
          this.tab = key;
          if (key === "news") this.loadNotes(cx);
          cx.notify();
        })
        .child(label);
    };
    const tabs = h_flex().w_full().gap(4).border_b(1).border_color(t.border)
      .child(tabButton("update", "Update"))
      .child(tabButton("news", "What's new"));

    const footButton = (id, label, onClick) =>
      h_flex().id(id).h(28).px(12).items_center().rounded(6).cursor_pointer().text_size(12.5)
        .border_1().border_color(t.border).text_color(t.foreground)
        .hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => onClick(cx))
        .child(label);

    return v_flex().id("mods-update-dialog").w_full().p(18).gap(12).bg(t.popover).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(h_flex().gap(8).items_center()
        .child(svg(icon("update")).size(18).text_color(update ? t.accent : t.muted))
        .child(div().text_size(15).font_semibold().child("Update the Herdr mods")))
      .child(div().text_color(statusColor).child(status))
      .child(tabs)
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
        .child(footButton("mu-check", this.checking ? "Checking…" : "Check now", (cx) => this.check(cx, true)))
        .child(div().flex_1())
        .when(update, (el) => el.child(footButton("mu-skip", `Skip version ${s.remote}`, (cx) => this.skip(cx))))
        .child(footButton("mu-close", "Close", () => this.close())));
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
