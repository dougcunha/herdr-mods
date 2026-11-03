// agent-resume: starts the Claude Code sessions again after a reboot.
//
// The Claude hook (hooks/herdr-claude-resume.ps1) writes labels on the terminal:
//   claude.session = the session id
//   claude.pid     = the pid of the shell that runs Claude
//   claude.args    = the flags of the claude command (for example --dangerously-skip-permissions)
// After a reboot, herdr-core gives each kept terminal a new shell in its last folder.
// The new shell has a different pid. When this mod sees a labeled terminal with a
// different pid and no agent in it, it types "claude <flags> --resume <id>" in the shell.
// Before it types, it writes claude.tried=<id>, so a failed resume is not repeated.
//
// This file has 2 roles:
//   - In the layout (the status bar): the indicator and the scanner.
//   - As a popup (props.panel): the panel with the config and the sessions (panel.js).

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { notify, theme, props, openOverlay, nextCommand } from "herdr";
import { config, labeled, inspect, sessionState, resumeNow } from "./resume.js";
import { Panel } from "./panel.js";

// Time between 2 scans.
const SCAN_MS = 3000;

export default class AgentResume extends View {
  init(_p, cx) {
    // An overlay gets its props from props(), not from the init argument.
    if (props()?.panel) {
      this.panel = new Panel(cx);
      return;
    }
    this.firstSeen = {}; // "<address>#<pid>" -> time the mod first saw that shell
    this.busy = false;
    this.lastCount = 0; // sessions resumed in the last scan that resumed any
    cx.timer.every(SCAN_MS, (cx) => this.scan(cx));
    this.scan(cx);
    // "agent-resume.panel" (a key in keys.json, or herdr-app do) opens the panel.
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        if (c === "panel") this.openPanel(false);
      }
    });
  }

  scan(cx) {
    if (this.busy || !config().enabled) return;
    // A terminal with an agent status runs an agent now: do not touch it.
    const list = labeled().filter((t) => {
      const l = t.labels;
      return !t.status && l["claude.tried"] !== l["claude.session"];
    });
    if (list.length === 0) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      const resumed = [];
      try {
        for (const t of list) {
          if (await this.tryResume(t)) resumed.push(t);
        }
      } finally {
        this.busy = false;
      }
      if (resumed.length === 0) return;
      this.lastCount = resumed.length;
      if (config().toast) {
        notify({
          title: resumed.length === 1 ? "Claude session resumed" : `${resumed.length} Claude sessions resumed`,
          body: resumed.map((t) => t.labels?.where ?? t.address).join(", "),
          level: "success",
          timeout: 8000,
        });
      }
      cx.notify();
    });
  }

  // Returns true when the mod typed the resume command in the terminal.
  async tryResume(t) {
    const info = await inspect(t.address);
    // Only a new shell (other pid) after a loss. The same pid: Claude ended in this shell.
    if (!info || sessionState(info) !== "waiting") return false;
    // Give the new shell time to show its prompt.
    const key = `${info.address}#${info.pid}`;
    const now = Date.now();
    if (!this.firstSeen[key]) this.firstSeen[key] = now;
    if (now - this.firstSeen[key] < config().settleMs) return false;
    return resumeNow(t.address);
  }

  // From a click: a popup at the pointer. From a key: a dialog in the center.
  openPanel(atPointer = true) {
    openOverlay({
      mod: "agent-resume",
      kind: atPointer ? "popup" : "dialog",
      ...(atPointer ? { at: "pointer" } : {}),
      width: 420,
      height: 460,
      props: { panel: true },
    });
  }

  render(cx) {
    if (this.panel) return this.panel.render(cx);
    const t = theme();
    const on = config().enabled;
    const count = labeled().length;
    const text = on
      ? `Resume on · ${count} ${count === 1 ? "session" : "sessions"}`
      : "Resume off";
    return h_flex()
      .id("agent-resume")
      .size_full()
      .px(14)
      .gap(6)
      .items_center()
      .justify_start()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .tooltip(on ? "Agent Resume monitors your Claude sessions. Click to open the panel." : "Agent Resume is off. Click to open the panel.")
      .on_click(() => this.openPanel())
      .child(div().flex_none().size(7).rounded(4).bg(on ? t.ansi2 : t.dim))
      .child(div().truncate().child(text))
      .when(on && this.lastCount > 0, (el) => el.child(div().flex_none().text_color(t.dim).child(`↻ ${this.lastCount}`)));
  }
}
