// The Worktrees tab: the last worktrees that PowerMods Core made or removed. The core keeps them in the
// shared key `powermods-core.jobs`; this tab only reads them (and clears the finished ones).

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run, shared, setShared } from "herdr";
import { textButton } from "./ui.js";

const JOBS = "powermods-core.jobs";
const RUNNING = new Set(["git", "copy", "trust", "setup"]);
const STATE_TEXT = { git: "git worktree add", copy: "copying files", trust: "waiting for your answer", setup: "setup running", done: "done", failed: "failed" };

/** True when PowerMods Core runs: it puts its API on globalThis. */
export const coreLoaded = () => typeof globalThis.powermods === "object" && globalThis.powermods != null;

const jobs = () => { const v = shared(JOBS); return Array.isArray(v) ? v : []; };
const clearFinished = () => setShared(JOBS, jobs().filter((j) => RUNNING.has(j.state)));

const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

/**
 * The tab. `view.openJob` is the id of the expanded row; a click on a row sets it.
 */
export function renderWorktrees(t, view) {
  const list = jobs();
  const color = (s) => (RUNNING.has(s) ? t.working : s === "failed" ? t.blocked : t.done);
  const box = v_flex().id("mh-wt").w_full().h(330).p(10).gap(8).rounded(6).bg(t.background).border_1().border_color(t.border)
    .overflow_y_scrollbar().text_size(12.5);
  const empty = div().text_size(12).text_color(t.dim).child("No worktree yet. Issues, PRs, Spec Board and the Git panel make worktrees through PowerMods Core.");
  return v_flex().w_full().gap(8)
    .child(!list.length ? box.child(empty) : box.children(list.map((j) => {
      const open = view.openJob === j.id;
      return v_flex().id(`mh-wt-${j.id}`).flex_none().gap(6).p(10).rounded(8).bg(t.popover).border_1().border_color(open ? t.accent : t.border)
        .child(h_flex().id(`mh-wt-head-${j.id}`).gap(8).items_center().cursor_pointer()
          .on_click((_e, cx) => { view.openJob = open ? null : j.id; cx.notify(); })
          .child(div().size(8).flex_none().rounded(4).bg(color(j.state)))
          .child(div().flex_none().font_semibold().child(`${j.kind === "remove" ? "Remove · " : ""}${j.branch ?? j.path ?? "?"}`))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(j.repo ?? ""))
          .child(div().flex_none().text_size(11.5).text_color(color(j.state)).child(STATE_TEXT[j.state] ?? j.state))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(j.at))))
        .when(Boolean(j.path), (e) => e.child(div().text_size(11.5).text_color(t.muted).truncate()
          .child(`${j.path}${j.on ? ` · on ${j.on}` : ""}${j.copied ? ` · ${j.copied} file${j.copied > 1 ? "s" : ""} copied` : ""}`)))
        .when(Boolean(j.error), (e) => e.child(div().text_size(11.5).text_color(t.blocked).child(j.error)))
        .when(open && Boolean(j.log), (e) => e.child(div().id(`mh-wt-log-${j.id}`).max_h(200).overflow_y_scrollbar().p(8).rounded(6).bg(t.background)
          .font_family("Menlo").text_size(11).text_color(t.muted).child(j.log)))
        .when(open && Boolean(j.spaceId) && j.kind !== "remove", (e) => e.child(h_flex()
          .child(textButton(t, `mh-wt-space-${j.id}`, "Show the space", () => run("space.select", { id: j.spaceId })))));
    })))
    .child(h_flex().gap(8).items_center()
      .when(list.length > 0, (e) => e.child(textButton(t, "mh-wt-clear", "Clear the finished ones", (cx) => { clearFinished(); view.openJob = null; cx.notify(); })))
      .child(div().flex_1())
      .child(textButton(t, "mh-wt-setup", "Setup commands…", () => run("mod.open", { name: "powermods-core" }))));
}
