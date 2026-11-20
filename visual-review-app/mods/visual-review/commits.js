// Collapsible left Commit Selector sidebar for Visual Review.
// Supports quick presets (Branch vs base, Uncommitted) and single or Shift+click contiguous commit ranges.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";

const ICONS = "mods/visual-review/icons";

function ago(sec) {
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  return `${Math.round(s / (86400 * 30))}mo`;
}

function presetBtn({ id, label, sub, active, t, onClick }) {
  return h_flex()
    .id(id)
    .w_full()
    .px(8)
    .py(6)
    .rounded(4)
    .gap(6)
    .items_center()
    .bg(active ? t.selected : t.background)
    .border(1)
    .border_color(active ? t.accent : t.border)
    .hover((s) => s.bg(active ? t.selected : t.hover))
    .on_click(onClick)
    .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(active ? t.foreground : t.muted).child(label))
    .when(sub, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(sub)));
}

export function renderCommitsSidebar({
  repo, commits, uncommittedCount, selection, rangeAnchor, searchInput, loading, width = 276, t,
  onSelectPreset, onClickCommit, onRefresh, onCollapse,
}) {
  // Determine which commit indices are currently highlighted in selection
  const selectedHashes = new Set();
  if (selection?.mode === "single" && selection.head) {
    selectedHashes.add(selection.head);
  } else if (selection?.mode === "range" && selection.from && selection.to) {
    const iTo = commits.findIndex((c) => c.hash === selection.to);
    const iFrom = commits.findIndex((c) => c.hash === selection.from);
    if (iTo >= 0 && iFrom >= 0) {
      const lo = Math.min(iTo, iFrom);
      const hi = Math.max(iTo, iFrom);
      for (let i = lo; i <= hi; i++) selectedHashes.add(commits[i].hash);
    }
  }

  return v_flex()
    .id("vr-commits-sidebar")
    .w(width)
    .flex_none()
    .h_full()
    .bg(t.chrome)
    .overflow_hidden()
    // Sidebar header
    .child(
      h_flex().w_full().h(34).px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(svg(`${ICONS}/commit.svg`).size(13).text_color(t.accent))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child("Commits"))
        .child(
          div().id("vr-commits-refresh").size(22).rounded(4).flex().items_center().justify_center()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => onRefresh(cx))
            .child(svg(`${ICONS}/refresh.svg`).size(12).text_color(t.muted)),
        )
        .child(
          div().id("vr-commits-hide").size(22).rounded(4).flex().items_center().justify_center()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => onCollapse(cx))
            .child(svg(`${ICONS}/x.svg`).size(12).text_color(t.muted)),
        ),
    )
    // Presets
    .child(
      v_flex().w_full().p(8).gap(6).border_b(1).border_color(t.border)
        .child(presetBtn({
          id: "vr-preset-branch",
          label: repo?.mainBranch ? `${repo.mainBranch}..${repo.branch}` : "Branch vs base",
          sub: "branch",
          active: selection?.mode === "branch-base",
          t,
          onClick: (_e, cx) => onSelectPreset("branch-base", cx),
        }))
        .child(presetBtn({
          id: "vr-preset-uncommitted",
          label: "Uncommitted changes",
          sub: uncommittedCount > 0 ? `${uncommittedCount} files` : "clean",
          active: selection?.mode === "uncommitted",
          t,
          onClick: (_e, cx) => onSelectPreset("uncommitted", cx),
        })),
    )
    // Search input
    .child(
      h_flex().w_full().px(8).py(6).gap(6).items_center().border_b(1).border_color(t.border)
        .child(svg(`${ICONS}/search.svg`).size(12).text_color(t.dim).flex_none())
        .child(
          div().flex_1().min_w(0)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(Input.new(searchInput).text_size(12).text_color(t.foreground).bg(t.background).px(6).py(3).rounded(4).border(1).border_color(t.border)),
        ),
    )
    // Commit list
    .child(
      v_flex().id("vr-commit-list").flex_1().min_h(0).p(6).gap(3).overflow_y_scrollbar()
        .when(loading && !commits.length, (el) => el.child(div().p(8).text_size(12).text_color(t.muted).child("Loading commits…")))
        .when(!loading && !commits.length, (el) => el.child(div().p(8).text_size(12).text_color(t.muted).child("No commits found.")))
        .children(
          commits.map((c) => {
            const isSel = selectedHashes.has(c.hash);
            const isAnchor = rangeAnchor === c.hash;
            return v_flex()
              .id(`vr-c-${c.short}`)
              .w_full()
              .px(8)
              .py(6)
              .rounded(4)
              .gap(2)
              .bg(isSel ? t.selected : t.chrome)
              .border(1)
              .border_color(isSel ? t.accent : isAnchor ? t.muted : t.chrome)
              .hover((s) => s.bg(isSel ? t.selected : t.hover))
              .on_click((e, cx) => onClickCommit(c, Boolean(e?.modifiers?.shift), cx))
              .child(
                h_flex().gap(5).items_center().min_w(0)
                  .child(div().flex_none().text_size(10).font_semibold().text_color(isSel ? t.accent : t.dim).child(c.short))
                  .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(c.subject || "(no message)")),
              )
              .child(
                h_flex().gap(6).items_center().text_size(10).text_color(t.dim)
                  .child(div().flex_1().min_w(0).truncate().child(c.author))
                  .child(div().flex_none().child(ago(c.date))),
              );
          }),
        ),
    )
    // Hint footer
    .child(
      div().w_full().px(10).py(6).border_t(1).border_color(t.border).text_size(10).text_color(t.dim)
        .child("Click: 1 commit · Shift+click: contiguous range"),
    );
}
