// The list of automations: a summary band, then 1 card per automation. `v` is the View of
// main.js (defs, index, actions).

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { shared } from "herdr";
import { nextDue, describeSchedule, whenText } from "./schedule.js";
import * as S from "./store.js";
import * as U from "./ui.js";

const DAY = 24 * 60 * 60 * 1000;
const TRIGGER_ICON = { manual: "hand", schedule: "clock", agent: "bot", files: "file", git: "git" };
const PHASE = { start: "starting", check: "check", pre: "pre-script", agent: "agent", post: "post-script" };

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** A short text for the trigger of an automation. */
export function triggerText(a) {
  const tr = a.trigger;
  switch (tr.type) {
    case "schedule": return describeSchedule(tr.schedule);
    case "agent": return `Agent ${(tr.agent.statuses ?? []).map((s) => (s === "blocked" ? "needs you" : s)).join(" / ") || "?"}${tr.agent.app ? ` (${tr.agent.app})` : ""}`;
    case "files": return `Files${tr.files.glob ? ` ${tr.files.glob}` : " change"}`;
    case "git": return [tr.git.commit && "New commit", tr.git.branch && "Branch change"].filter(Boolean).join(" / ") || "Git";
    default: return "Manual";
  }
}

const nextOf = (a) => (a.enabled && a.trigger.type === "schedule"
  ? nextDue(a.trigger.schedule, Date.now(), shared(S.KEY.state)?.[a.id]?.lastFired ?? a.updatedAt) : null);

/** A small label with an icon. */
function meta(t, iconName, text) {
  return h_flex().flex_none().gap(5).items_center().h(20).px(7).rounded(5).bg(t.background).border_1().border_color(t.border)
    .child(svg(U.icon(iconName)).size(11).flex_none().text_color(t.dim))
    .child(div().text_size(11).text_color(t.muted).child(text));
}

/** A tile of the summary band. */
function stat(t, label, value, color, iconName) {
  return h_flex().flex_1().min_w(0).gap(10).items_center().px(12).py(10).rounded(10).bg(t.surface).border_1().border_color(t.border)
    .child(div().size(30).flex_none().rounded(8).flex().items_center().justify_center().bg(U.tint(color, "1f"))
      .child(svg(U.icon(iconName)).size(15).text_color(color)))
    .child(v_flex().min_w(0).gap(1)
      .child(div().text_size(15).font_semibold().text_color(t.foreground).truncate().child(String(value)))
      .child(div().text_size(11).text_color(t.dim).truncate().child(label)));
}

/** The last runs as small bars, the oldest at the left. */
function runBars(t, runs) {
  const last = runs.slice(0, 12).reverse();
  return h_flex().gap(3).items_end().h(16)
    .children(Array.from({ length: 12 }, (_, i) => {
      const r = last[i - (12 - last.length)];
      return div().w(5).h(r ? (r.status === "skipped" ? 8 : 14) : 4).rounded(2)
        .bg(r ? U.STATUS_COLOR(t, r.status) : t.border)
        .when(Boolean(r), (el) => el.tooltip(`${r.status} · ${whenText(r.start)}${r.reason ? ` · ${r.reason}` : ""}`));
    }));
}

function card(v, t, a, i, running) {
  const runs = v.index[a.id] ?? [];
  const last = runs[0];
  const active = running.find((r) => r.automationId === a.id);
  const status = active ? "running" : last?.status ?? null;
  const color = !a.enabled ? t.dim : status ? U.STATUS_COLOR(t, status) : t.accent;
  const next = nextOf(a);
  const confirm = v.confirmDelete === a.id;
  const when = active ? `Running · ${PHASE[active.phase] ?? active.phase}`
    : next != null ? `Next ${whenText(next)}`
    : last ? `Last run ${ago(last.end ?? last.start)}`
    : "Never ran";

  const tile = div().size(40).flex_none().rounded(11).flex().items_center().justify_center().bg(U.tint(color, "1f"))
    .child(active ? svg(U.icon("spinner")).size(18).text_color(color).spin(900) : svg(U.icon(TRIGGER_ICON[a.trigger.type] ?? "zap")).size(18).text_color(color));

  const title = h_flex().gap(8).items_center().min_w(0)
    .child(div().min_w(0).truncate().text_size(13.5).font_semibold().text_color(a.enabled ? t.foreground : t.muted).child(a.name || "(no name)"))
    .when(Boolean(status), (el) => el.child(U.pill(t, status)))
    .when(!a.enabled, (el) => el.child(div().flex_none().px(7).h(18).flex().items_center().rounded(9).bg(t.raised).text_size(10.5).text_color(t.dim).child("off")));

  const metas = h_flex().gap(6).flex_wrap()
    .child(meta(t, TRIGGER_ICON[a.trigger.type] ?? "zap", triggerText(a)))
    .child(meta(t, a.mode === "interactive" ? "terminal" : "bot", `${a.agent} · ${a.mode === "interactive" ? "tab" : "headless"}`))
    .when(Boolean(a.folder), (el) => el.child(meta(t, "folder", U.baseName(a.folder))));

  const reason = last?.reason && !active && (last.status === "failed" || last.status === "timed out" || last.status === "skipped")
    ? div().text_size(11.2).text_color(last.status === "skipped" ? t.dim : t.blocked).truncate().child(last.reason) : null;

  const side = v_flex().w(150).flex_none().gap(6).items_end()
    .child(runBars(t, runs))
    .child(div().text_size(11.2).text_color(active ? t.working : t.dim).truncate().child(when));

  const runButton = h_flex().id(`au-run-${i}`).h(28).px(10).gap(5).items_center().flex_none().rounded(7).cursor_pointer()
    .bg(U.tint(t.accent, "1a")).text_color(t.accent).text_size(12).font_medium()
    .hover((s) => s.bg(U.tint(t.accent, "33")))
    .tooltip("Run now")
    .on_click((_e, cx) => { cx.stop_propagation(); v.runNow(cx, a); })
    .child(svg(U.icon("play")).size(12).text_color(t.accent)).child("Run");

  const actions = h_flex().gap(4).items_center().flex_none()
    .child(runButton)
    .child(U.iconButton(t, `au-his-${i}`, "history", "History", (cx) => v.showHistory(cx, a.id)))
    .child(div().id(`au-en-${i}`).px(4).on_click((_e, cx) => cx.stop_propagation())
      .child(U.toggle(t, `au-tg-${i}`, "", a.enabled, (cx) => v.change(cx, (l) => l.map((x) => (x.id === a.id ? { ...x, enabled: !x.enabled, updatedAt: Date.now() } : x))), a.enabled ? "On: click to turn off" : "Off: click to turn on")))
    .child(U.iconButton(t, `au-del-${i}`, "trash", confirm ? "Click again to delete" : "Delete", (cx) => {
      if (!confirm) { v.confirmDelete = a.id; cx.notify(); return; }
      v.confirmDelete = null;
      v.change(cx, (l) => l.filter((x) => x.id !== a.id));
    }, confirm ? t.blocked : null));

  return h_flex().id(`au-row-${i}`).w_full().px(14).py(12).gap(14).items_center().rounded(12)
    .border_1().border_color(active ? U.tint(t.working, "80") : t.border).bg(t.surface)
    .when(!a.enabled, (el) => el.opacity(0.72))
    .hover((s) => s.border_color(t.input).bg(t.hover))
    .cursor_pointer()
    .on_click((_e, cx) => v.edit(cx, a))
    .child(tile)
    .child(v_flex().flex_1().min_w(0).gap(6).child(title).child(metas).when(Boolean(reason), (el) => el.child(reason)))
    .child(side)
    .child(actions);
}

function empty(v, t) {
  const idea = (text) => div().px(10).h(26).flex().items_center().rounded(13).bg(t.surface).border_1().border_color(t.border).text_size(11.5).text_color(t.muted).child(text);
  return v_flex().flex_1().items_center().justify_center().gap(14).p(30)
    .child(div().size(56).rounded(16).flex().items_center().justify_center().bg(U.tint(t.accent, "1f"))
      .child(svg(U.icon("zap")).size(26).text_color(t.accent)))
    .child(v_flex().items_center().gap(4)
      .child(div().text_size(15).font_semibold().child("No automations yet"))
      .child(div().text_size(12).text_color(t.dim).child("Run an agent with a prompt in a folder when a trigger fires.")))
    .child(h_flex().gap(6).flex_wrap().justify_center()
      .child(idea("Review new commits every morning"))
      .child(idea("Fix the tests when an agent is done"))
      .child(idea("Update the docs when files change")))
    .child(U.button(t, "au-new-empty", "New automation", (cx) => v.edit(cx, null), { kind: "primary", iconName: "plus" }));
}

export function listView(v, t, notice) {
  const running = S.getShared(S.KEY.running, []);
  const all = Object.values(v.index).flat();
  const failed = all.filter((r) => (r.status === "failed" || r.status === "timed out") && Date.now() - (r.start ?? 0) < DAY).length;
  const nexts = v.defs.map(nextOf).filter((x) => x != null).sort((x, y) => x - y);
  const enabled = v.defs.filter((a) => a.enabled).length;

  const header = h_flex().w_full().h(58).px(16).gap(12).items_center().flex_none().border_b(1).border_color(t.border)
    .child(div().size(32).flex_none().rounded(9).flex().items_center().justify_center().bg(U.tint(t.accent, "1f"))
      .child(svg(U.icon("zap")).size(16).text_color(t.accent)))
    .child(v_flex().flex_1().min_w(0).gap(1)
      .child(div().text_size(15).font_semibold().child("Automations"))
      .child(div().text_size(11.5).text_color(t.dim).child(v.defs.length ? `${v.defs.length} automation${v.defs.length === 1 ? "" : "s"}, ${enabled} on` : "Agents on schedules and events")))
    .child(U.button(t, "au-new", "New", (cx) => v.edit(cx, null), { kind: "primary", iconName: "plus" }));

  const band = h_flex().w_full().gap(8).px(16).pt(14)
    .child(stat(t, "on", enabled, t.accent, "zap"))
    .child(stat(t, "running", running.length, running.length ? t.working : t.dim, running.length ? "spinner" : "play"))
    .child(stat(t, "failed in 24 h", failed, failed ? t.blocked : t.dim, "alert"))
    .child(stat(t, "next run", nexts.length ? whenText(nexts[0]) : "—", t.done, "clock"));

  return v_flex().size_full().min_h(0)
    .child(header)
    .when(Boolean(notice), (e) => e.child(h_flex().mx(16).mt(12).gap(8).items_center().p(10).rounded(8).bg(U.tint(t.blocked, "1c"))
      .child(svg(U.icon("alert")).size(14).flex_none().text_color(t.blocked))
      .child(div().text_size(12).text_color(t.foreground).child(notice))))
    .when(v.defs.length > 0, (e) => e
      .child(band)
      .child(v_flex().id("au-list").flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(8)
        .children(v.defs.map((a, i) => card(v, t, a, i, running)))))
    .when(v.defs.length === 0, (e) => e.child(empty(v, t)));
}
