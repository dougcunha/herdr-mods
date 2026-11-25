// The list of actions: a header with the target terminal, a search field, then 1 row per action.
// Up and Down select a row, Enter runs it. `v` is the View of main.js.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { filterMatches, filterParts, asksOf } from "./vars.js";
import { SHELL_LABEL, actionShortcuts } from "./store.js";
import { jobOf, isRunning } from "./jobs.js";
import { jobState } from "./output.js";
import * as U from "./ui.js";

/** The actions that the search shows. */
export function visible(v) {
  const q = (v.search?.value() ?? "").trim().toLowerCase();
  const all = v.shownList();
  return q ? all.filter((a) => a.name.toLowerCase().includes(q)) : all;
}

/** False when the filter of the action leaves out the target terminal. */
export const allowed = (v, a) => { const c = v.demo ? v.demoCtx : v.ctx; return !c || filterMatches(a.filter, c); };

/** A small label with an icon. */
function meta(t, iconName, text, tip = null) {
  return h_flex().flex_none().gap(5).items_center().h(20).px(7).rounded(5).bg(t.background).border_1().border_color(t.border)
    .when(Boolean(tip), (e) => e.tooltip(tip))
    .child(svg(U.icon(iconName)).size(11).flex_none().text_color(t.dim))
    .child(div().text_size(11).text_color(t.muted).child(text));
}

function sourceText(a) {
  const shell = a.shell && a.shell !== "auto" ? ` · ${SHELL_LABEL[a.shell]}` : "";
  if (a.source === "file") return (U.baseName(a.file) || "(no file)") + shell;
  const n = a.script.trim() ? a.script.trim().split(/\r?\n/).length : 0;
  return (n === 1 ? "1 line" : `${n} lines`) + shell;
}

const WHERE = { terminal: ["terminal", "terminal"], tab: ["plus", "new tab"], background: ["server", "background"] };

/** The state of the last background job of a kind ("run" or "write"): a click shows its output. */
function jobChip(v, t, a, i, kind) {
  const j = v.demo ? null : jobOf(kind, a.id);
  if (!j) return null;
  const st = jobState(t, j);
  return h_flex().id(`qa-job-${kind}-${i}`).flex_none().gap(5).items_center().h(20).px(7).rounded(5).cursor_pointer()
    .bg(U.tint(st.color, "14")).border_1().border_color(U.tint(st.color, "55"))
    .hover((s) => s.bg(U.tint(st.color, "2a")))
    .tooltip(j.reason ? `${j.reason} Click to see the output.` : "Click to see the output.")
    .on_click((_e, cx) => { cx.stop_propagation(); v.openOutput(cx, kind, a); })
    .child(st.spin ? svg(U.icon(st.icon)).size(11).flex_none().spin(900).text_color(st.color) : svg(U.icon(st.icon)).size(11).flex_none().text_color(st.color))
    .child(div().text_size(11).text_color(st.color).child(kind === "write" ? `Script: ${st.text}` : st.text));
}

function row(v, t, a, i, selected) {
  const ok = allowed(v, a);
  const running = v.running === a.id;
  const confirm = v.confirmDelete === a.id;
  const color = ok ? t.accent : t.dim;
  const tile = div().size(36).flex_none().rounded(10).flex().items_center().justify_center().bg(U.tint(color, "1f"))
    .child(svg(U.icon(a.icon)).size(17).text_color(color));
  const shortcuts = v.demo ? [] : actionShortcuts(a.id);
  const metas = h_flex().gap(6).flex_wrap()
    .child(meta(t, a.source === "file" ? "file" : "code", sourceText(a)))
    .child(meta(t, ...(WHERE[a.where] ?? WHERE.terminal)))
    .when(a.confirm || (a.source === "inline" && asksOf(a.script).length > 0), (el) => el.child(meta(t, "check", "asks first")))
    .when(Boolean(a.filter.trim()), (el) => el.child(meta(t, "filter", filterParts(a.filter).join(", "), ok ? "Runs only here" : "Not for this terminal")))
    .children(shortcuts.map((s) => div().h(20).px(7).flex().items_center().rounded(5)
      .bg(t.raised).border_1().border_color(t.input).font_family(U.mono()).text_size(10.5).font_semibold().text_color(t.foreground)
      .child(s.label)))
    .children([jobChip(v, t, a, i, "run"), jobChip(v, t, a, i, "write")].filter(Boolean));
  // While the action runs in the background, the button shows its output (Stop is there).
  const bg = !v.demo && isRunning(jobOf("run", a.id));
  const runButton = h_flex().id(`qa-run-${i}`).h(28).px(10).gap(5).items_center().flex_none().rounded(7)
    .bg(U.tint(ok ? t.accent : t.dim, "1a")).text_color(ok ? t.accent : t.dim).text_size(12).font_medium()
    .when(bg, (el) => el.cursor_pointer().hover((s) => s.bg(U.tint(t.accent, "33")))
      .on_click((_e, cx) => { cx.stop_propagation(); v.openOutput(cx, "run", a); }))
    .when(!bg && ok, (el) => el.cursor_pointer().hover((s) => s.bg(U.tint(t.accent, "33")))
      .on_click((_e, cx) => { cx.stop_propagation(); v.runNow(cx, a); }))
    .tooltip(bg ? "It runs in the background: click to see the output" : ok ? "Run (Enter)" : `Runs only in: ${filterParts(a.filter).join(", ")}`)
    .child(running || bg ? svg(U.icon("refresh")).size(12).spin(900).text_color(t.accent) : svg(U.icon("play")).size(12).text_color(ok ? t.accent : t.dim))
    .child(bg ? "Output" : "Run");
  const actions = h_flex().gap(4).items_center().flex_none()
    .child(runButton)
    .child(U.iconButton(t, `qa-pin-${i}`, "pin", a.pinned ? "In the Actions menu of the bar: click to take it away" : "Add to the Actions menu of the bar (Dock and Kanban)", (cx) => v.pin(cx, a), a.pinned ? t.accent : null))
    .child(U.iconButton(t, `qa-edit-${i}`, "pencil", "Edit", (cx) => v.edit(cx, a)))
    .child(U.iconButton(t, `qa-del-${i}`, "trash", confirm ? "Click again to delete" : "Delete", (cx) => {
      if (!confirm) { v.confirmDelete = a.id; cx.notify(); return; }
      v.confirmDelete = null;
      v.remove(cx, a);
    }, confirm ? t.blocked : null));
  return h_flex().id(`qa-row-${i}`).w_full().px(12).py(10).gap(12).items_center().rounded(10)
    .border_1().border_color(selected ? t.accent : t.border).bg(selected ? t.hover : t.surface)
    .when(!ok, (el) => el.opacity(0.7))
    .hover((s) => s.border_color(selected ? t.accent : t.input))
    .cursor_pointer()
    .on_click((_e, cx) => { v.selected = i; v.keepKeys(); cx.notify(); })
    .child(tile)
    .child(v_flex().flex_1().min_w(0).gap(5)
      .child(div().min_w(0).truncate().text_size(13.5).font_semibold().text_color(t.foreground).child(a.name || "(no name)"))
      .child(metas))
    .child(actions);
}

function empty(v, t) {
  const idea = (text) => div().px(10).h(26).flex().items_center().rounded(13).bg(t.surface).border_1().border_color(t.border).text_size(11.5).text_color(t.muted).child(text);
  return v_flex().flex_1().items_center().justify_center().gap(14).p(30)
    .child(div().size(56).rounded(16).flex().items_center().justify_center().bg(U.tint(t.accent, "1f"))
      .child(svg(U.icon("actions")).size(26).text_color(t.accent)))
    .child(v_flex().items_center().gap(4)
      .child(div().text_size(15).font_semibold().child("No actions yet"))
      .child(div().text_size(12).text_color(t.dim).child("Run a script in the terminal of the space with 1 click or 1 key.")))
    .child(h_flex().gap(6).flex_wrap().justify_center()
      .child(idea("Sync the repository"))
      .child(idea("Install the plugins"))
      .child(idea("Start the dev server")))
    .child(h_flex().gap(8)
      .child(U.button(t, "qa-examples", "Add 2 examples", (cx) => v.addExamples(cx), { iconName: "sparkles" }))
      .child(U.button(t, "qa-new-empty", "New action", (cx) => v.edit(cx, null), { kind: "primary", iconName: "plus" })));
}

/** The line under the title: the target terminal. */
function targetText(v) {
  const c = v.demo ? v.demoCtx : v.ctx;
  if (!c) return v.target ? "Reading the terminal…" : "No space is shown.";
  const where = c.target.terminal ? (c.busy ? `a new tab (${c.target.terminal} runs ${c.busyWith || "a program"})` : c.target.terminal) : "a new tab (no terminal)";
  return `Runs in ${where} · ${c.folder || "~"}`;
}

export function listView(v, t, notice) {
  const list = visible(v);
  if (v.selected >= list.length) v.selected = Math.max(0, list.length - 1);
  const all = v.shownList();
  const header = h_flex().w_full().h(58).px(16).gap(12).items_center().flex_none().border_b(1).border_color(t.border)
    .child(div().size(32).flex_none().rounded(9).flex().items_center().justify_center().bg(U.tint(t.accent, "1f"))
      .child(svg(U.icon("actions")).size(16).text_color(t.accent)))
    .child(v_flex().flex_1().min_w(0).gap(1)
      .child(div().text_size(15).font_semibold().child("Quick Actions"))
      .child(div().text_size(11.5).text_color(t.dim).truncate().child(targetText(v))))
    .child(U.button(t, "qa-new", "New", (cx) => v.edit(cx, null), { kind: "primary", iconName: "plus" }))
    .when(Boolean(U.closeX(t)), (e) => e.child(U.closeX(t)));

  const search = h_flex().w_full().px(16).pt(12).flex_none()
    .child(U.field(t, v.search, { onKey: (e, cx) => v.searchKey(e, cx) }));

  return v_flex().size_full().min_h(0)
    .child(header)
    .when(Boolean(notice), (e) => e.child(h_flex().mx(16).mt(12).gap(8).items_center().p(10).rounded(8).bg(U.tint(t.blocked, "1c"))
      .child(svg(U.icon("alert")).size(14).flex_none().text_color(t.blocked))
      .child(div().flex_1().min_w(0).text_size(12).text_color(t.foreground).child(notice))))
    .when(all.length > 0, (e) => e
      .child(search)
      .child(list.length
        ? v_flex().id("qa-list").flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(6)
          .children(list.map((a, i) => row(v, t, a, i, i === v.selected)))
        : v_flex().flex_1().items_center().justify_center().text_size(12.5).text_color(t.dim).child("No action has this name."))
      .child(h_flex().w_full().h(34).px(16).gap(14).items_center().flex_none().border_t(1).border_color(t.border)
        .text_size(11).text_color(t.dim)
        .child("↑ ↓ select").child("Enter run").child("Esc close")))
    .when(all.length === 0, (e) => e.child(empty(v, t)));
}
