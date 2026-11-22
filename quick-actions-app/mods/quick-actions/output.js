// The output view of a background job (jobs.js): its status, the output text (live while it runs) and Stop.
// `v` is the View of main.js: it holds the key of the job (`v.outputKey`) and the text (`v.outputText`).

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { jobs, isRunning } from "./jobs.js";
import * as U from "./ui.js";

const MAX_LINES = 600; // the last lines that the view draws

/** A time span for people: "12 s", "3 min", "2 h". */
export function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

/** The status of a job in a few words, and its color. */
export function jobState(t, j) {
  if (!j) return { text: "", color: t.dim, icon: "alert" };
  const now = Date.now();
  if (isRunning(j)) return { text: `Runs for ${span(now - j.started)}`, color: t.working, icon: "refresh", spin: true };
  const ago = j.ended ? `${span(now - j.ended)} ago` : "";
  const took = j.ended && j.started ? span(j.ended - j.started) : "";
  if (j.status === "ok") return { text: `Done in ${took} · ${ago}`, color: t.ansi2 ?? t.accent, icon: "check" };
  if (j.status === "stopped") return { text: `Stopped · ${ago}`, color: t.muted, icon: "close" };
  if (j.status === "timed out") return { text: `Timed out · ${ago}`, color: t.blocked, icon: "alert" };
  if (j.status === "lost") return { text: `Lost · ${ago}`, color: t.blocked, icon: "alert" };
  return { text: `Failed${j.code != null ? ` (exit ${j.code})` : ""} · ${ago}`, color: t.blocked, icon: "alert" };
}

export function outputView(v, t) {
  const key = v.outputKey;
  const j = key ? jobs()[key] ?? null : null;
  const a = j ? v.list.find((x) => x.id === j.action) : null;
  const st = jobState(t, j);
  const title = j?.kind === "write" ? `Script of ${a?.name ?? j?.name ?? "the action"}` : a?.name ?? j?.name ?? "Output";
  const where = j ? (j.kind === "write" ? `${j.agentName ?? "The agent"} writes ${j.fileShown ?? "the script"} in the background` : `In the background${j.machine ? ` on ${j.machine}` : ""}`) : "";

  const lines = String(v.outputText ?? "").replace(/\s+$/, "").split(/\r?\n/);
  const cut = Math.max(0, lines.length - MAX_LINES);
  const text = v.outputText == null
    ? div().text_size(11.5).text_color(t.dim).child("Reading the output…")
    : !String(v.outputText).trim()
      ? div().text_size(11.5).text_color(t.dim).child(isRunning(j) ? "No output yet." : "No output.")
      : v_flex().w_full().font_family(U.mono()).text_size(11).text_color(t.foreground)
        .when(cut > 0, (e) => e.child(div().text_color(t.dim).child(`(${cut} older lines are not shown)`)))
        .children(lines.slice(cut).map((l) => div().w_full().whitespace_normal().child(l || " ")));

  const header = h_flex().w_full().h(58).px(16).gap(12).items_center().flex_none().border_b(1).border_color(t.border)
    .child(U.iconButton(t, "qa-out-back", "back", "Back (Esc)", (cx) => v.closeOutput(cx)))
    .child(div().size(32).flex_none().rounded(9).flex().items_center().justify_center().bg(U.tint(st.color, "1f"))
      .child(st.spin ? svg(U.icon(st.icon)).size(15).spin(900).text_color(st.color) : svg(U.icon(st.icon)).size(15).text_color(st.color)))
    .child(v_flex().flex_1().min_w(0).gap(1)
      .child(div().text_size(15).font_semibold().truncate().child(title))
      .child(div().text_size(11.5).text_color(t.dim).truncate().child([where, st.text].filter(Boolean).join(" · "))))
    .when(Boolean(U.closeX(t)), (e) => e.child(U.closeX(t)));

  const body = v_flex().id("qa-output").flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(10)
    .when(Boolean(j?.reason) && !isRunning(j) && j.status !== "stopped", (e) => e.child(U.errorLine(t, j.reason)))
    .child(div().w_full().p(10).rounded(7).bg(t.background).border_1().border_color(t.border).child(text));

  const footer = h_flex().w_full().px(16).py(12).gap(8).items_center().justify_end().flex_none().border_t(1).border_color(t.border).bg(t.surface)
    .child(div().flex_1().text_size(11).text_color(t.dim).child(isRunning(j) ? "The output follows the job. A background job cannot answer a question." : ""))
    .when(isRunning(j), (e) => e.child(U.button(t, "qa-out-stop", "Stop", (cx) => v.stopOutput(cx), { kind: "danger", iconName: "close" })))
    .child(U.button(t, "qa-out-close", "Back", (cx) => v.closeOutput(cx)));

  return v_flex().size_full().min_h(0).child(header).child(body).child(footer);
}
