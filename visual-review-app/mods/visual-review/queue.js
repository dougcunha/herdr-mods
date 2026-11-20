// Review Queue & Send-to-Agent for Visual Review.
// Lets the user stack observations/prompts tied to diagram items (units, members,
// tables, edges, files) and send them all at once (or individually) to an active
// agent session in the current space, or start a new agent tab when none is running.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Textarea } from "gpui-base";
import { agents, spaces, focused, knownAgents, hc, run, shared, setShared } from "herdr";

const ICONS = "mods/visual-review/icons";
const LAST_AGENT_KEY = "visual-review.lastAgent";
const KNOWN_CACHE_KEY = "visual-review.knownAgents";

const STATUS_ORDER = { idle: 0, done: 1, blocked: 2, working: 3 };

function statusColor(status, t) {
  if (status === "working") return t.working || t.ansi4;
  if (status === "blocked") return t.blocked || t.ansi1;
  if (status === "done") return t.done || t.ansi2;
  return t.idle || t.muted;
}

/** Finds the active Herdr space matching the current window/repo. */
export function currentSpace() {
  const f = focused();
  const all = spaces() ?? [];
  return all.find((s) => s.id === f?.space) ?? all.find((s) => s.active) ?? all[0] ?? null;
}

/** Lists live agent sessions in the current space, ordered idle/done first. */
export function spaceAgents() {
  const sp = currentSpace();
  if (!sp) return [];
  const tabsById = new Map((sp.tabs ?? []).map((tb, idx) => [tb.id, tb.name || `Tab ${idx + 1}`]));
  const last = shared(LAST_AGENT_KEY);
  return (agents() ?? [])
    .filter((a) => a.space === sp.id && a.address)
    .map((a) => ({
      address: a.address,
      app: a.program?.name || a.app || "Agent",
      icon: a.program?.icon || null,
      tint: Boolean(a.program?.tint),
      tabName: tabsById.get(a.tab) || "Tab",
      status: a.status || "idle",
      focused: Boolean(a.focused),
    }))
    .sort((a, b) => {
      if (a.address === last) return -1;
      if (b.address === last) return 1;
      return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    });
}

/** Reads cached installed agents (reusing git-client / issues / repo-launcher caches when available). */
export function cachedKnownAgents(on) {
  const mk = on ?? "local";
  for (const v of [
    shared(KNOWN_CACHE_KEY)?.[mk],
    shared("git-client.agents")?.[mk],
    shared("issues.agents")?.[mk],
    !on ? shared("repo-launcher.agents") : null,
  ]) {
    if (Array.isArray(v?.list) && v.list.length) return v.list.filter((a) => a.installed !== false);
  }
  return [];
}

export async function refreshKnownAgents(on) {
  const mk = on ?? "local";
  const list = await knownAgents({ on });
  setShared(KNOWN_CACHE_KEY, { ...(shared(KNOWN_CACHE_KEY) ?? {}), [mk]: { list, checkedAt: Date.now() } });
  return list.filter((a) => a.installed !== false);
}

/** Extracts a concise, structured reference descriptor for the currently selected diagram item. */
export function describeSelected(selected, model) {
  if (!selected) {
    return {
      targetKey: "general",
      targetKind: "general",
      label: "General review",
      file: null,
      range: null,
      meta: "Overall change set",
      relations: [],
    };
  }
  if (selected.kind === "unit") {
    const u = selected.data;
    const mem = selected.member;
    const rels = (model?.relations || [])
      .filter((r) => r.from === u.id || r.to === u.id)
      .slice(0, 6)
      .map((r) => (r.from === u.id ? `${r.kind} -> ${r.to.split(/[.#/]/).pop()}` : `${r.from.split(/[.#/]/).pop()} -> ${r.kind}`));
    const delta = `${u.added != null ? `+${u.added}` : ""}${u.removed ? ` -${u.removed}` : ""}`.trim();
    return {
      targetKey: `u:${u.id}`,
      targetKind: "unit",
      label: mem ? `${u.name}.${mem.name}${mem.kind === "method" || mem.kind === "constructor" ? "()" : ""}` : u.name,
      file: u.file || null,
      range: u.range || null,
      meta: [u.kind, u.container, delta, `Ce ${u.ce ?? 0}`, `Ca ${u.ca ?? 0}`].filter(Boolean).join(" · "),
      member: mem ? `${mem.kind} ${mem.name}` : null,
      relations: rels,
    };
  }
  if (selected.kind === "table") {
    const tbl = selected.data;
    return {
      targetKey: `t:${tbl.id}`,
      targetKind: "table",
      label: `Table ${tbl.id}`,
      file: tbl.source || null,
      range: null,
      meta: [`table (${tbl.state})`, tbl.entity ? `entity ${tbl.entity}` : null].filter(Boolean).join(" · "),
      relations: [],
    };
  }
  if (selected.kind === "edge") {
    const m = selected.data.meta || {};
    return {
      targetKey: `e:${selected.data.id}`,
      targetKind: "edge",
      label: `${(m.from || "").split(/[.#/]/).pop()} -> ${(m.to || "").split(/[.#/]/).pop()}`,
      file: null,
      range: null,
      meta: `relation ${m.kind || ""} (${m.state || "unchanged"})`.trim(),
      relations: [],
    };
  }
  if (selected.kind === "file") {
    const f = selected.data;
    return {
      targetKey: `f:${f.path}`,
      targetKind: "file",
      label: f.path.split("/").pop() || f.path,
      file: f.path,
      range: null,
      meta: `file (${f.state})`,
      relations: [],
    };
  }
  return { targetKey: "general", targetKind: "general", label: "General review", file: null, range: null, meta: "", relations: [] };
}

/** Formats 1 or N observations into a clean structured prompt for an AI coding agent. */
export function formatQueuePrompt(notes, repo, resolved) {
  const repoName = repo?.root ? repo.root.replace(/\\/g, "/").split("/").filter(Boolean).pop() : "repo";
  const scope = resolved?.label || "current changes";
  const lines = [`[Visual Review · ${repoName} · ${scope}]`, ""];

  // Group notes by targetKey preserving insertion order
  const groups = new Map();
  for (const n of notes) {
    if (!groups.has(n.targetKey)) groups.set(n.targetKey, []);
    groups.get(n.targetKey).push(n);
  }

  let idx = 1;
  for (const group of groups.values()) {
    const first = group[0];
    lines.push(`### ${idx++}. ${first.label}`);
    if (first.meta) lines.push(`Context: ${first.meta}`);
    if (first.file) {
      const loc = first.range ? `${first.file}:${first.range.start}-${first.range.end}` : first.file;
      lines.push(`File: \`${loc}\``);
    }
    if (first.relations?.length) {
      lines.push(`Relations: ${first.relations.join(", ")}`);
    }
    for (const item of group) {
      const tag = item.kind === "question" ? "[Question]" : "[Change request]";
      lines.push(`- ${tag} ${item.text.trim()}`);
    }
    lines.push("");
  }

  if (notes.length > 1) {
    lines.push("Please address each item above in order. Answer any questions clearly, and propose a brief plan before modifying files for change requests.");
  }
  return lines.join("\n").trim();
}

/** Sends a prompt to an existing agent terminal via `hc send`. */
export async function sendToAgent(address, text) {
  setShared(LAST_AGENT_KEY, address);
  const r = await hc(["send", address, text]);
  if (r.code !== 0) {
    throw new Error((r.stderr || r.stdout || `hc send failed (${r.code})`).trim());
  }
  return { address };
}

/** Starts a new coding agent tab in the current space with the prompt as its initial task. */
export function startAgentWithPrompt(repo, agentDef, title, text) {
  const sp = currentSpace();
  const argv = Array.isArray(agentDef?.run) ? agentDef.run : [agentDef?.key || "claude"];
  run("tab.new", {
    ...(sp ? { space: sp.id } : {}),
    folder: repo?.root || sp?.folder,
    name: title || "Visual Review",
    argv,
    task: text,
  });
}

/** Compact composer rendered inside the Details panel for the currently selected item. */
export function renderNoteComposer({
  desc, noteInput, noteKind, queueCount, t,
  onChangeKind, onAddToQueue, onSendNow, onOpenQueue,
}) {
  const kindBtn = (id, label, active) =>
    div()
      .id(`vr-nk-${id}`)
      .h(20)
      .px(7)
      .rounded(3)
      .border(1)
      .border_color(active ? t.accent : t.border)
      .bg(active ? `${t.accent}22` : t.background)
      .flex()
      .items_center()
      .text_size(10)
      .font_semibold()
      .text_color(active ? t.foreground : t.muted)
      .hover((s) => s.border_color(t.accent))
      .on_click((_e, cx) => onChangeKind(id, cx))
      .child(label);

  return v_flex()
    .w_full()
    .mt(6)
    .p(8)
    .rounded(4)
    .bg(t.surface)
    .border(1)
    .border_color(t.border)
    .gap(6)
    .child(
      h_flex().w_full().gap(6).items_center().justify_between()
        .child(div().text_size(11).font_semibold().text_color(t.foreground).child("Ask / Queue for agent"))
        .child(
          h_flex().gap(4).items_center()
            .child(kindBtn("change", "Change", noteKind === "change"))
            .child(kindBtn("question", "Question", noteKind === "question")),
        ),
    )
    .child(
      div()
        .w_full()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_key_down((e, cx) => {
          if (e.key === "enter" && (e.modifiers?.control || e.modifiers?.platform)) {
            cx.stop_propagation();
            onAddToQueue(cx);
          }
        })
        .child(
          Textarea.new(noteInput)
            .w_full()
            .text_size(11.5)
            .text_color(t.foreground)
            .bg(t.background)
            .px(7)
            .py(5)
            .rounded(4)
            .border(1)
            .border_color(t.border),
        ),
    )
    .child(
      h_flex().w_full().gap(6).items_center()
        .child(
          div()
            .id("vr-add-queue")
            .h(24)
            .px(9)
            .rounded(4)
            .bg(t.accent)
            .text_color(t.accent_foreground)
            .flex()
            .items_center()
            .text_size(11)
            .font_semibold()
            .hover((s) => s.opacity(0.9))
            .on_click((_e, cx) => onAddToQueue(cx))
            .child("+ Add to queue"),
        )
        .child(
          div()
            .id("vr-send-single")
            .h(24)
            .px(8)
            .rounded(4)
            .bg(t.background)
            .border(1)
            .border_color(t.border)
            .flex()
            .items_center()
            .text_size(11)
            .text_color(t.foreground)
            .hover((s) => s.border_color(t.accent))
            .on_click((_e, cx) => onSendNow(cx))
            .child("Send now"),
        )
        .child(div().flex_1())
        .when(queueCount > 0, (el) =>
          el.child(
            div()
              .id("vr-open-q-inline")
              .text_size(10.5)
              .font_semibold()
              .text_color(t.accent)
              .hover((s) => s.underline())
              .on_click((_e, cx) => onOpenQueue(cx))
              .child(`Queue (${queueCount})`),
          )),
    );
}

/** Queue drawer / overlay showing all stacked observations + target agent picker. */
export function renderQueueOverlay({
  notes, liveAgents, installedAgents, selectedAgentAddr, selectedNewAgent, useNewAgent, sending, t,
  onSelectAgent, onSelectNewAgent, onToggleUseNew, onRemoveNote, onClearQueue, onJumpToNote,
  onSendAll, onCopyAll, onClose,
}) {
  const showNewPicker = useNewAgent || liveAgents.length === 0;
  const activeAgent = !showNewPicker
    ? (liveAgents.find((a) => a.address === selectedAgentAddr) ?? liveAgents[0] ?? null)
    : null;
  const newAgentDef = showNewPicker
    ? (installedAgents.find((a) => a.name === selectedNewAgent) ?? installedAgents[0] ?? null)
    : null;
  const canSend = notes.length > 0 && !sending && (Boolean(activeAgent) || Boolean(newAgentDef));

  return div()
    .id("vr-queue-backdrop")
    .absolute()
    .top(0)
    .left(0)
    .size_full()
    .bg("#00000066")
    .flex()
    .items_center()
    .justify_center()
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => onClose(cx))
    .child(
      v_flex()
        .id("vr-queue-modal")
        .w(660)
        .max_h(680)
        .rounded(8)
        .bg(t.popover || t.surface)
        .border(1)
        .border_color(t.border)
        .overflow_hidden()
        .on_click((_e, cx) => cx.stop_propagation())
        // Header
        .child(
          h_flex().w_full().h(42).px(14).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
            .child(svg(`${ICONS}/sparkles.svg`).size(14).text_color(t.accent))
            .child(div().text_size(13).font_semibold().text_color(t.foreground).child(`Agent Queue (${notes.length})`))
            .child(div().flex_1())
            .when(notes.length > 0, (el) =>
              el.child(
                div().id("vr-q-clear").px(7).h(22).rounded(4).border(1).border_color(t.border)
                  .flex().items_center().text_size(11).text_color(t.ansi1).hover((s) => s.bg(`${t.ansi1}22`))
                  .on_click((_e, cx) => onClearQueue(cx))
                  .child("Clear all"),
              ))
            .child(
              div().id("vr-q-close").size(24).rounded(4).flex().items_center().justify_center().hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => onClose(cx))
                .child(svg(`${ICONS}/x.svg`).size(13).text_color(t.muted)),
            ),
        )
        // Target agent selector
        .child(
          v_flex().w_full().p(12).gap(8).bg(t.surface).border_b(1).border_color(t.border)
            .child(
              h_flex().w_full().items_center().justify_between()
                .child(div().text_size(11).font_semibold().text_color(t.muted).child(
                  liveAgents.length === 0
                    ? "No active agent in this space — start a new session:"
                    : liveAgents.length === 1
                      ? "Target agent session in this space:"
                      : `Choose target agent (${liveAgents.length} active in this space):`,
                ))
                .when(liveAgents.length > 0, (el) =>
                  el.child(
                    div().id("vr-q-toggle-new").px(7).h(20).rounded(3).border(1)
                      .border_color(useNewAgent ? t.accent : t.border)
                      .bg(useNewAgent ? `${t.accent}22` : t.background)
                      .flex().items_center().text_size(10).text_color(useNewAgent ? t.foreground : t.muted)
                      .hover((s) => s.border_color(t.accent))
                      .on_click((_e, cx) => onToggleUseNew(cx))
                      .child(useNewAgent ? "Use active session" : "+ New agent tab"),
                  )),
            )
            // Live agents pills
            .when(!showNewPicker, (el) =>
              el.child(
                h_flex().flex_wrap().gap(6).children(
                  liveAgents.map((a) => {
                    const sel = activeAgent?.address === a.address;
                    return h_flex()
                      .id(`vr-qa-${a.address}`)
                      .h(30)
                      .px(9)
                      .gap(6)
                      .rounded(5)
                      .items_center()
                      .bg(sel ? `${t.accent}22` : t.background)
                      .border(1)
                      .border_color(sel ? t.accent : t.border)
                      .hover((s) => s.border_color(t.accent))
                      .on_click((_e, cx) => onSelectAgent(a.address, cx))
                      .child(div().size(7).rounded(4).bg(statusColor(a.status, t)).flex_none())
                      .when(Boolean(a.icon), (ic) => ic.child(a.tint ? svg(a.icon).size(13).text_color(t.foreground) : image(a.icon).size(13)))
                      .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(a.app))
                      .child(div().text_size(11).text_color(t.muted).child(`· ${a.tabName}`))
                      .child(div().text_size(10).text_color(t.dim).child(`(${a.status})`));
                  }),
                ),
              ))
            .when(activeAgent?.status === "working", (el) =>
              el.child(div().text_size(10.5).text_color(t.blocked || t.ansi3).child("Note: this agent is currently working; hc send will queue your message in its terminal.")))
            // New agent pills
            .when(showNewPicker, (el) =>
              el.child(
                installedAgents.length === 0
                  ? div().text_size(11).text_color(t.dim).child("No installed coding agents detected. You can still use Copy all.")
                  : h_flex().flex_wrap().gap(6).children(
                    installedAgents.map((a) => {
                      const sel = newAgentDef?.name === a.name;
                      return h_flex()
                        .id(`vr-qn-${a.name}`)
                        .h(30)
                        .px(9)
                        .gap(6)
                        .rounded(5)
                        .items_center()
                        .bg(sel ? `${t.accent}22` : t.background)
                        .border(1)
                        .border_color(sel ? t.accent : t.border)
                        .hover((s) => s.border_color(t.accent))
                        .on_click((_e, cx) => onSelectNewAgent(a.name, cx))
                        .when(Boolean(a.icon), (ic) => ic.child(a.tint ? svg(a.icon).size(13).text_color(t.foreground) : image(a.icon).size(13)))
                        .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(a.name));
                    }),
                  ),
              )),
        )
        // Stacked observations list
        .child(
          v_flex().id("vr-q-list").flex_1().min_h(160).max_h(380).p(12).gap(8).overflow_y_scrollbar()
            .when(!notes.length, (el) =>
              el.child(div().py(24).text_center().text_size(12).text_color(t.dim).child("Queue is empty. Click any node, member, table, or edge and add observations to send them together.")))
            .children(
              notes.map((n, i) =>
                v_flex()
                  .id(`vr-qi-${n.id}`)
                  .w_full()
                  .p(9)
                  .rounded(5)
                  .bg(t.background)
                  .border(1)
                  .border_color(t.border)
                  .gap(4)
                  .child(
                    h_flex().w_full().gap(6).items_center()
                      .child(
                        div().px(5).h(17).rounded(3).flex().items_center().text_size(9.5).font_bold()
                          .bg(n.kind === "question" ? `${t.ansi4}28` : `${t.accent}28`)
                          .text_color(n.kind === "question" ? t.ansi4 : t.accent)
                          .child(n.kind === "question" ? "Question" : "Change"),
                      )
                      .child(
                        div().id(`vr-qj-${n.id}`).flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.accent)
                          .hover((s) => s.underline())
                          .on_click((_e, cx) => onJumpToNote(n, cx))
                          .child(`${i + 1}. ${n.label}`),
                      )
                      .child(
                        div().id(`vr-qr-${n.id}`).size(20).rounded(3).flex().items_center().justify_center().hover((s) => s.bg(t.hover))
                          .on_click((_e, cx) => onRemoveNote(n.id, cx))
                          .child(svg(`${ICONS}/x.svg`).size(11).text_color(t.dim)),
                      ),
                  )
                  .when(n.file, (el) =>
                    el.child(div().text_size(10).text_color(t.dim).truncate().child(n.range ? `${n.file}:${n.range.start}–${n.range.end}` : n.file)))
                  .child(div().text_size(12).text_color(t.foreground).child(n.text)),
              ),
            ),
        )
        // Footer
        .child(
          h_flex().w_full().h(46).px(14).gap(8).items_center().bg(t.chrome).border_t(1).border_color(t.border)
            .child(
              div().id("vr-q-copy").h(28).px(10).rounded(4).bg(t.surface).border(1).border_color(t.border)
                .flex().items_center().text_size(11.5).text_color(notes.length ? t.foreground : t.dim)
                .when(notes.length > 0, (el) => el.hover((s) => s.border_color(t.accent)).on_click((_e, cx) => onCopyAll(cx)))
                .child("Copy prompt"),
            )
            .child(div().flex_1())
            .child(
              div().id("vr-q-send").h(28).px(14).rounded(4)
                .bg(canSend ? t.accent : t.surface)
                .text_color(canSend ? t.accent_foreground : t.dim)
                .flex().items_center().text_size(11.5).font_semibold()
                .when(canSend, (el) => el.hover((s) => s.opacity(0.9)).on_click((_e, cx) => onSendAll(activeAgent, newAgentDef, showNewPicker, cx)))
                .child(
                  sending
                    ? "Sending…"
                    : showNewPicker
                      ? `Start ${newAgentDef?.name || "agent"} & Send (${notes.length})`
                      : `Send all to ${activeAgent?.app || "agent"} (${notes.length})`,
                ),
            ),
        ),
    );
}
