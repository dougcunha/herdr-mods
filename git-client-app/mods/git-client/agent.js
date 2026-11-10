// "Resolve with agent": a dialog, opened with props { role: "agent", ctx, op, files, theirs }, that starts a
// coding agent in a new tab of the shown space, in the repository, with a prompt about the conflicts.
// Based on the agent dialog of the issues mod (herdr-mods).
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { props, closeOverlay, theme, knownAgents, run, notify, spaces, shared, setShared } from "herdr";
import { icon } from "./menu.js";
import { conflictPrompt } from "./git.js";

// The known agents per machine, kept in shared("git-client.agents"): knownAgents() starts a shell, so the
// dialog asks only when no list is kept (first open) or on ↻. The lists of issues and repo-launcher fill an
// empty one at once.
const AGENTS = "git-client.agents";
const machineKey = (on) => on ?? "local";
function cachedAgents(on) {
  for (const v of [shared(AGENTS)?.[machineKey(on)], shared("issues.agents")?.[machineKey(on)], !on ? shared("repo-launcher.agents") : null]) {
    if (Array.isArray(v?.list) && v.list.length) return v.list;
  }
  return null;
}
const keepAgents = (on, list) => setShared(AGENTS, { ...(shared(AGENTS) ?? {}), [machineKey(on)]: { list, checkedAt: Date.now() } });
const LAST = "git-client.lastAgent";

export class AgentDialog {
  init(cx) {
    const p = props();
    this.on = p.ctx?.on ?? null;
    this.prompt = TextareaState.new({ value: conflictPrompt({ op: p.op, files: p.files ?? [], current: p.ctx?.current, theirs: p.theirs, root: p.ctx?.root }), rows: 12 });
    this.agents = cachedAgents(this.on) ?? [];
    this.pick();
    if (!this.agents.length) this.refresh(cx);
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  pick() {
    const ready = this.agents.filter((a) => a.installed !== false);
    this.agent = ready.find((a) => a.name === this.agent?.name) ?? ready.find((a) => a.name === shared(LAST)) ?? ready[0] ?? null;
  }

  refresh(cx) {
    if (this.checking) return;
    this.checking = true;
    cx.spawn(async (cx) => {
      try { const list = await knownAgents({ on: this.on }); this.agents = list; keepAgents(this.on, list); this.pick(); }
      catch (e) { this.error = String(e?.message ?? e); }
      this.checking = false; cx.notify();
    });
    cx.notify();
  }

  start() {
    const p = props(), prompt = this.prompt.value().trim();
    if (!this.agent || !prompt) return;
    const space = spaces().find((s) => s.active);
    setShared(LAST, this.agent.name);
    run("tab.new", { ...(space ? { space: space.id } : {}), folder: p.ctx.root, name: `Resolve ${p.op}`, argv: this.agent.run, task: prompt });
    notify({ title: `Started ${this.agent.name}`, body: `Resolve the ${p.op} conflicts`, level: "success", timeout: 4000 });
    closeOverlay(p.overlay);
  }

  render() {
    const t = theme(), p = props(), ready = this.agents.filter((a) => a.installed !== false);
    const card = (a) => {
      const on = this.agent?.name === a.name;
      return h_flex().id(`ga-${a.name}`).h(36).px(10).gap(8).items_center().rounded(8).border_1().cursor_pointer()
        .border_color(on ? t.accent : t.border).when(on, (e) => e.bg(t.accent + "14")).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.agent = a; cx.notify(); })
        .when(Boolean(a.icon), (e) => e.child(a.tint ? svg(a.icon).size(16).text_color(t.foreground) : image(a.icon).size(16)))
        .child(div().text_size(12.5).child(a.name));
    };
    const button = (id, text, primary, enabled, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? (enabled ? t.solid : t.raised) : t.raised)
      .text_color(primary ? (enabled ? t.solid_foreground : t.dim) : t.foreground).text_size(12.5).font_medium()
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88))).on_click(() => { if (enabled) action(); }).child(text);
    return v_flex().id("git-client-agent").track_focus(this.handle).size_full().min_h(0).p(18).gap(12).bg(t.popover).text_color(t.foreground).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(p.overlay);
        else if (e.key === "enter" && (e.modifiers?.control || e.modifiers?.platform)) this.start();
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("Resolve conflicts with an agent")).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().text_color(t.muted).child(`The agent starts in a new tab of this space, in ${p.ctx?.root ?? "the repository"}.`))
      .child(h_flex().items_center().gap(8).child(div().flex_1().text_size(11.5).text_color(t.dim).child("Agent"))
        .child(h_flex().id("ga-refresh").size(24).items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover))
          .tooltip("Check the installed agents again").on_click((_e, cx) => this.refresh(cx)).child(svg(icon("refresh")).size(13))))
      .child(h_flex().gap(8).flex_wrap().children(ready.map(card))
        .when(!ready.length, (e) => e.child(div().text_size(12).text_color(t.dim).child(this.checking ? "Looking for the installed agents…" : "No installed agent found (programs.json `run` entries)."))))
      .child(div().text_size(11.5).text_color(t.dim).child("Prompt"))
      .child(div().id("ga-prompt").flex_1().min_h(160).px(10).py(8).rounded(9).border_1().border_color(t.input).bg(t.background).cursor_text()
        .child(Textarea.new(this.prompt).w_full().h_full().text_size(12.5).text_color(t.foreground)))
      .when(Boolean(this.error), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .child(h_flex().gap(8).justify_end()
        .child(button("ga-cancel", "Cancel", false, true, () => closeOverlay(p.overlay)))
        .child(button("ga-start", "Start agent", true, Boolean(this.agent), () => this.start())));
  }
}
