// agent-resume: starts the Claude Code sessions again after a reboot.
//
// The Claude hook (hooks/herdr-claude-resume.ps1) writes 2 labels on the terminal:
//   claude.session = the session id
//   claude.pid     = the pid of the shell that runs Claude
// After a reboot, herdr-core gives each kept terminal a new shell in its last folder.
// The new shell has a different pid. When this mod sees a labeled terminal with a
// different pid and no agent in it, it types "claude <flags> --resume <id>" in the shell.
// <flags> comes from the label claude.args (for example --dangerously-skip-permissions).
// Before it types, it writes claude.tried=<id>, so a failed resume is not repeated.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { terminals, hc, notify, theme } from "herdr";

// Time between 2 scans, and time a new shell gets to start before the mod types in it.
const SCAN_MS = 3000;
const SETTLE_MS = 4000;

const SHELLS = new Set([
  "pwsh", "pwsh.exe", "powershell", "powershell.exe", "cmd", "cmd.exe",
  "bash", "bash.exe", "zsh", "fish", "sh", "dash", "nu", "nu.exe",
]);

function labeled() {
  return terminals().filter((t) => t.state === "live" && t.labels?.["claude.session"]);
}

export default class AgentResume extends View {
  init(_props, cx) {
    this.firstSeen = {}; // "<address>#<pid>" -> time the mod first saw that shell
    this.busy = false;
    this.last = null; // text of the last result, for the tooltip line
    cx.timer.every(SCAN_MS, (cx) => this.scan(cx));
    this.scan(cx);
  }

  scan(cx) {
    if (this.busy) return;
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
      if (resumed.length > 0) {
        const where = resumed.map((t) => t.labels?.where ?? t.address).join(", ");
        this.last = `${resumed.length} resumed`;
        notify({
          title: resumed.length === 1 ? "Claude session resumed" : `${resumed.length} Claude sessions resumed`,
          body: where,
          level: "success",
          timeout: 8000,
        });
        cx.notify();
      }
    });
  }

  // Returns true when the mod typed the resume command in the terminal.
  async tryResume(t) {
    const r = await hc(["get", t.address, "--json"]);
    if (r.code !== 0) return false;
    let info;
    try {
      info = JSON.parse(r.stdout);
    } catch {
      return false;
    }
    const l = info.labels ?? {};
    const sid = l["claude.session"];
    if (!sid || info.state !== "live" || info.status) return false;
    if (l["claude.tried"] === sid) return false;
    // The same shell pid: Claude ended in this shell, there was no reboot.
    if (String(info.pid) === l["claude.pid"]) return false;
    // Type only into a shell, never into another program.
    const fg = (info.foreground?.name ?? "").toLowerCase();
    if (!SHELLS.has(fg)) return false;
    // Give the new shell time to show its prompt.
    const key = `${info.address}#${info.pid}`;
    const now = Date.now();
    if (!this.firstSeen[key]) this.firstSeen[key] = now;
    if (now - this.firstSeen[key] < SETTLE_MS) return false;
    // Only text made of safe characters goes to the shell.
    if (!/^[A-Za-z0-9-]+$/.test(sid)) return false;
    const flags = (l["claude.args"] ?? "").trim();
    if (!/^[\w.:/\\= -]*$/.test(flags)) return false;
    const command = ["claude", flags, "--resume", sid].filter(Boolean).join(" ");

    const mark = await hc(["label", t.address, `claude.tried=${sid}`]);
    if (mark.code !== 0) return false;
    const sent = await hc(["send", t.address, command]);
    return sent.code === 0;
  }

  render() {
    const t = theme();
    const count = labeled().length;
    return h_flex()
      .id("agent-resume")
      .size_full()
      .px(10)
      .gap(6)
      .items_center()
      .justify_end()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .child(div().text_color(count > 0 ? t.accent : t.dim).child("↻"))
      .child(div().truncate().child(this.last ?? `${count} Claude tracked`));
  }
}
