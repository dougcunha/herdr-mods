// Collapsible right Details & Inline Diff panel for Visual Review.
// Shows metrics, summary, cohesion, clickable relations, changed members,
// and the unified diff of the selected unit, table, or file.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { settings } from "herdr";
import { badgeEl, stateColor } from "./canvas.js";

const ICONS = "mods/visual-review/icons";
const MAX_DIFF_LINES = 260;
const MAX_SPLIT_ROWS = 1200;
const HUNK_HDR = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses a unified diff string into paired side-by-side rows with line numbers. */
export function parseSplitDiff(diffText) {
  if (!diffText) return { rows: [], added: 0, removed: 0 };
  const rows = [];
  let oldNo = 0, newNo = 0;
  let removed = [], added = [];
  let totalAdd = 0, totalDel = 0;

  const flush = () => {
    const n = Math.max(removed.length, added.length);
    for (let i = 0; i < n; i++) {
      rows.push({ kind: "change", left: removed[i] ?? null, right: added[i] ?? null });
    }
    removed = [];
    added = [];
  };

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("@@ ")) {
      flush();
      const m = HUNK_HDR.exec(line);
      if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); }
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("-")) {
      removed.push({ no: oldNo++, text: line.slice(1) });
      totalDel++;
    } else if (line.startsWith("+")) {
      added.push({ no: newNo++, text: line.slice(1) });
      totalAdd++;
    } else if (line.startsWith(" ")) {
      flush();
      const text = line.slice(1);
      rows.push({ kind: "ctx", left: { no: oldNo++, text }, right: { no: newNo++, text } });
    } else if (line.startsWith("\\")) {
      flush();
      rows.push({ kind: "hunk", text: line });
    }
  }
  flush();
  return { rows, added: totalAdd, removed: totalDel };
}

/** Full-pane side-by-side (split) diff viewer overlay. */
export function renderSplitDiffOverlay({ filePath, range, diffText, diffLoading, t, onClose, onOpenFile }) {
  const font = settings()?.font_family || "JetBrains Mono";
  const parsed = parseSplitDiff(diffText);
  const shown = parsed.rows.slice(0, MAX_SPLIT_ROWS);

  const cell = (entry, bgColor, textColor, isLeft) =>
    h_flex()
      .flex_1()
      .min_w(0)
      .gap(8)
      .px(8)
      .py(1)
      .when(isLeft, (el) => el.border_r(1).border_color(t.border))
      .when(bgColor, (el) => el.bg(bgColor))
      .child(
        div()
          .w(38)
          .flex_none()
          .text_right()
          .font_family(font)
          .text_size(11)
          .text_color(t.dim)
          .child(entry ? String(entry.no) : ""),
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .font_family(font)
          .text_size(11.5)
          .text_color(textColor)
          .child(entry ? (entry.text || " ") : " "),
      );

  return v_flex()
    .id("vr-split-diff-overlay")
    .absolute()
    .top(0)
    .left(0)
    .size_full()
    .bg(t.background)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    // Header
    .child(
      h_flex()
        .w_full()
        .h(40)
        .px(12)
        .gap(10)
        .items_center()
        .bg(t.chrome)
        .border_b(1)
        .border_color(t.border)
        .child(svg(`${ICONS}/file.svg`).size(14).text_color(t.accent).flex_none())
        .child(div().flex_1().min_w(0).text_size(13).font_semibold().text_color(t.foreground).truncate().child(filePath || "Diff"))
        .when(range, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`L${range.start}–${range.end}`)))
        .child(
          h_flex().flex_none().gap(6).items_center().text_size(11).font_semibold()
            .when(parsed.added > 0, (el) => el.child(div().text_color(t.ansi2).child(`+${parsed.added}`)))
            .when(parsed.removed > 0, (el) => el.child(div().text_color(t.ansi1).child(`−${parsed.removed}`))),
        )
        .when(filePath, (el) =>
          el.child(
            h_flex().id("vr-sd-open").flex_none().h(24).px(8).gap(5).rounded(4).bg(t.surface).border(1).border_color(t.border)
              .items_center().text_size(11).text_color(t.foreground).hover((s) => s.border_color(t.accent))
              .on_click((_e, cx) => onOpenFile(filePath, cx))
              .child(svg(`${ICONS}/external-link.svg`).size(11).text_color(t.muted))
              .child("Open file"),
          ))
        .child(
          h_flex().id("vr-sd-close").flex_none().h(24).px(9).gap(5).rounded(4).bg(t.accent).text_color(t.accent_foreground)
            .items_center().text_size(11).font_semibold()
            .on_click((_e, cx) => onClose(cx))
            .child(svg(`${ICONS}/x.svg`).size(11).text_color(t.accent_foreground))
            .child("Close (Esc)"),
        ),
    )
    // Column headers
    .child(
      h_flex().w_full().h(26).bg(t.surface).border_b(1).border_color(t.border).text_size(11).font_semibold().text_color(t.muted)
        .child(h_flex().flex_1().min_w(0).px(12).items_center().border_r(1).border_color(t.border).child("Before (Base)"))
        .child(h_flex().flex_1().min_w(0).px(12).items_center().child("After (Selected)")),
    )
    // Scrollable split rows
    .child(
      v_flex()
        .id("vr-sd-body")
        .flex_1()
        .min_h(0)
        .w_full()
        .overflow_y_scrollbar()
        .when(diffLoading, (el) => el.child(div().p(16).text_size(12).text_color(t.muted).child("Loading diff…")))
        .when(!diffLoading && !shown.length, (el) => el.child(div().p(16).text_size(12).text_color(t.dim).child("No diff lines to display.")))
        .children(
          shown.map((row) => {
            if (row.kind === "hunk") {
              return div()
                .w_full()
                .px(12)
                .py(3)
                .bg(t.surface)
                .border_y(1)
                .border_color(t.border)
                .font_family(font)
                .text_size(11)
                .text_color(t.accent)
                .child(row.text);
            }
            if (row.kind === "ctx") {
              return h_flex().w_full()
                .child(cell(row.left, null, t.muted, true))
                .child(cell(row.right, null, t.muted, false));
            }
            return h_flex().w_full()
              .child(cell(row.left, row.left ? `${t.ansi1}1c` : t.chrome, row.left ? t.foreground : t.dim, true))
              .child(cell(row.right, row.right ? `${t.ansi2}1c` : t.chrome, row.right ? t.foreground : t.dim, false));
          }),
        )
        .when(parsed.rows.length > MAX_SPLIT_ROWS, (el) =>
          el.child(div().p(12).text_size(11).text_color(t.dim).child(`… showing first ${MAX_SPLIT_ROWS} of ${parsed.rows.length} rows.`))),
    );
}

function sectionHead(title, t, right = null) {
  return h_flex().w_full().gap(8).pb(4).mt(8).border_b(1).border_color(t.border).items_center().justify_between()
    .child(div().flex_1().min_w(0).truncate().text_size(11).font_semibold().text_color(t.muted).child(title))
    .when(right, (el) => el.child(div().flex_none().child(right)));
}

function renderDiffBox({ diffText, diffLoading, filePath, range, t, onOpenFile, onOpenSplitDiff }) {
  const font = settings()?.font_family || "JetBrains Mono";
  const box = v_flex().w_full().gap(4);

  const actions = filePath
    ? h_flex().gap(4).items_center()
      .child(
        h_flex().id("vr-open-split-diff").gap(4).px(6).h(20).rounded(3).bg(t.background).border(1).border_color(t.border)
          .items_center().text_size(10).text_color(t.foreground).hover((s) => s.border_color(t.accent))
          .on_click((_e, cx) => onOpenSplitDiff(filePath, range, cx))
          .child(svg(`${ICONS}/expand.svg`).size(10).text_color(t.accent))
          .child("Side-by-side"),
      )
      .child(
        h_flex().id("vr-open-file").gap(4).px(6).h(20).rounded(3).bg(t.background).border(1).border_color(t.border)
          .items_center().text_size(10).text_color(t.foreground).hover((s) => s.border_color(t.accent))
          .on_click((_e, cx) => onOpenFile(filePath, cx))
          .child(svg(`${ICONS}/external-link.svg`).size(10).text_color(t.muted))
          .child("Open"),
      )
    : null;

  box.child(sectionHead(
    range ? `Diff (${filePath}:${range.start}–${range.end})` : `Diff (${filePath || ""})`,
    t,
    actions,
  ));

  if (diffLoading) {
    return box.child(div().py(8).text_size(11).text_color(t.muted).child("Loading diff…"));
  }
  if (!diffText || !diffText.trim()) {
    return box.child(div().py(8).text_size(11).text_color(t.dim).child("No diff available for this item."));
  }

  const allLines = diffText.split(/\r?\n/);
  const shown = allLines.slice(0, MAX_DIFF_LINES);

  const code = v_flex()
    .w_full()
    .rounded(4)
    .bg(t.background)
    .border(1)
    .border_color(t.border)
    .py(4)
    .overflow_hidden();

  for (let i = 0; i < shown.length; i++) {
    const line = shown[i];
    if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    const isAdd = line.startsWith("+");
    const isDel = line.startsWith("-");
    const isHunk = line.startsWith("@@");
    const color = isAdd ? t.ansi2 : isDel ? t.ansi1 : isHunk ? t.accent : t.muted;

    code.child(
      div()
        .w_full()
        .px(6)
        .py(1)
        .font_family(font)
        .text_size(11)
        .text_color(color)
        .when(isAdd, (el) => el.bg(`${t.ansi2}18`))
        .when(isDel, (el) => el.bg(`${t.ansi1}18`))
        .when(isHunk, (el) => el.bg(t.surface))
        .truncate()
        .child(line || " "),
    );
  }

  if (allLines.length > MAX_DIFF_LINES) {
    code.child(div().px(6).py(4).text_size(10).text_color(t.dim).child(`… truncated (${allLines.length - MAX_DIFF_LINES} more lines). Click Open to view full file.`));
  }

  return box.child(code);
}

export function renderDetailsPanel({
  model, selected, diffText, diffLoading, aiRunning, width = 370, composer = null, t,
  onClose, onJumpToNode, onFocusNode, onEnrichAI, onOpenFile, onOpenSplitDiff, onSelectOtherFile,
}) {
  const panel = v_flex()
    .id("vr-details-panel")
    .w(width)
    .flex_none()
    .h_full()
    .bg(t.chrome)
    .overflow_hidden();

  // Panel header
  const titleText = !selected
    ? "Overview"
    : selected.kind === "unit"
      ? selected.data.name
      : selected.kind === "table"
        ? selected.data.id
        : selected.kind === "edge"
          ? (selected.data.meta?.kind || "Relation")
          : selected.data.path;

  panel.child(
    h_flex().w_full().h(34).px(10).gap(6).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(titleText))
      .child(
        div().id("vr-details-hide").size(22).rounded(4).flex().items_center().justify_center()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => onClose(cx))
          .child(svg(`${ICONS}/x.svg`).size(12).text_color(t.muted)),
      ),
  );

  const body = v_flex().id("vr-details-body").flex_1().min_h(0).p(12).gap(6).overflow_y_scrollbar();

  if (!selected) {
    // Summary of other/skipped files when nothing is selected
    const others = model?.otherFiles || [];
    const skipped = model?.skippedFiles || [];
    body.child(div().text_size(12).text_color(t.muted).child("Click any node, member, or edge on the graph to inspect its details, relationships, and inline diff."));

    if (model?.source === "static") {
      body.child(
        v_flex().mt(6).p(8).rounded(4).bg(t.surface).border(1).border_color(t.border).gap(8)
          .child(
            h_flex().gap(6).items_center()
              .child(svg(`${ICONS}/sparkles.svg`).size(13).text_color(t.accent).flex_none())
              .child(div().flex_1().min_w(0).text_size(11).text_color(t.muted).child("Static structural graph active. Run AI enrichment for summaries, cohesion scores, and semantic relations.")),
          )
          .child(
            div().id("vr-det-ai").px(10).h(24).rounded(4).bg(t.accent).text_color(t.accent_foreground)
              .flex().items_center().justify_center().text_size(11).font_semibold()
              .on_click((_e, cx) => !aiRunning && onEnrichAI(cx))
              .child(aiRunning ? "Running AI…" : "Enrich with AI"),
          ),
      );
    }

    if (others.length > 0) {
      body.child(sectionHead(`Other changed files (${others.length})`, t));
      for (const f of others.slice(0, 40)) {
        body.child(
          h_flex().id(`vr-oth-${f.path}`).gap(6).px(6).py(4).rounded(3).items_center()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => onSelectOtherFile(f, cx))
            .child(badgeEl(f.state, t, 9))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.foreground).child(f.path))
            .when(f.added != null, (el) => el.child(div().text_size(10).text_color(t.ansi2).child(`+${f.added}`)))
            .when(f.removed != null && f.removed > 0, (el) => el.child(div().text_size(10).text_color(t.ansi1).child(`−${f.removed}`))),
        );
      }
    }

    if (skipped.length > 0) {
      body.child(sectionHead(`Skipped files (${skipped.length})`, t));
      for (const s of skipped.slice(0, 20)) {
        body.child(
          h_flex().gap(6).px(6).py(2).text_size(11)
            .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(s.file))
            .child(div().flex_none().text_color(t.dim).child(s.reason)),
        );
      }
    }

    return panel.child(body);
  }

  // UNIT DETAILS
  if (selected.kind === "unit") {
    const u = selected.data;
    const nodeKey = `u:${u.id}`;
    const outgoing = (model?.relations || []).filter((r) => r.from === u.id);
    const incoming = (model?.relations || []).filter((r) => r.to === u.id);

    body.child(
      h_flex().gap(6).items_center()
        .child(badgeEl(u.state, t, 10))
        .child(div().text_size(14).font_semibold().text_color(t.foreground).truncate().child(u.name))
        .child(div().text_size(11).text_color(t.dim).child(u.kind))
        .child(div().flex_1())
        .child(
          div().id("vr-det-focus").px(7).h(22).rounded(4).bg(t.surface).border(1).border_color(t.border)
            .flex().items_center().text_size(11).text_color(t.foreground).hover((s) => s.border_color(t.accent))
            .on_click((_e, cx) => onFocusNode(nodeKey, cx))
            .child("Focus"),
        ),
    );

    body.child(div().text_size(11).text_color(t.dim).truncate().child(`${u.container} · ${u.file}`));

    // Metrics strip
    body.child(
      h_flex().flex_wrap().gap(8).py(6).px(8).rounded(4).bg(t.surface).border(1).border_color(t.border).text_size(11)
        .when(u.lines != null, (el) => el.child(div().text_color(t.foreground).child(`${u.lines} lines`)))
        .when(u.added != null, (el) => el.child(div().text_color(t.ansi2).font_semibold().child(`+${u.added}`)))
        .when(u.removed != null, (el) => el.child(div().text_color(t.ansi1).font_semibold().child(`−${u.removed}`)))
        .when(u.methods != null, (el) => el.child(div().text_color(t.muted).child(`${u.methods} methods`)))
        .child(div().text_color(t.muted).child(`Ce ${u.ce ?? 0}`))
        .child(div().text_color(t.muted).child(`Ca ${u.ca ?? 0}`))
        .when(u.cohesion, (el) => el.child(div().text_color(t.accent).font_semibold().child(`Cohesion ${u.cohesion.score}/5`))),
    );

    if (u.summary) {
      body.child(div().text_size(12).text_color(t.foreground).child(u.summary));
    }
    if (u.cohesion?.reason) {
      body.child(div().text_size(11).text_color(t.muted).child(`Cohesion note: ${u.cohesion.reason}`));
    }
    if (composer) body.child(composer);

    if (u.members && u.members.length > 0) {
      body.child(sectionHead(`Changed members (${u.members.length})`, t));
      for (const m of u.members) {
        const isSelMem = selected.member?.id === m.id;
        body.child(
          h_flex().gap(6).px(6).py(3).rounded(3).items_center()
            .when(isSelMem, (el) => el.bg(t.selected))
            .child(badgeEl(m.state, t, 9))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.foreground).child(m.kind === "method" || m.kind === "constructor" ? `${m.name}()` : m.name))
            .child(div().text_size(10).text_color(t.dim).child(m.kind)),
        );
      }
    }

    if (outgoing.length > 0 || incoming.length > 0) {
      body.child(sectionHead(`Relations (${outgoing.length} out · ${incoming.length} in)`, t));
      for (const r of outgoing) {
        const targetKey = r.to.startsWith("t:") ? r.to : `u:${r.to}`;
        const label = r.to.split(/[.#/]/).pop();
        body.child(
          h_flex().id(`vr-out-${r.id}`).gap(6).px(6).py(3).rounded(3).items_center()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => onJumpToNode(targetKey, cx))
            .child(div().text_size(10).text_color(t.dim).child(`→ ${r.kind}`))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.accent).child(label)),
        );
      }
      for (const r of incoming) {
        const sourceKey = `u:${r.from}`;
        const label = r.from.split(/[.#/]/).pop();
        body.child(
          h_flex().id(`vr-in-${r.id}`).gap(6).px(6).py(3).rounded(3).items_center()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => onJumpToNode(sourceKey, cx))
            .child(div().text_size(10).text_color(t.dim).child(`← ${r.kind}`))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.accent).child(label)),
        );
      }
    }

    body.child(renderDiffBox({ diffText, diffLoading, filePath: u.file, range: u.range, t, onOpenFile, onOpenSplitDiff }));
    return panel.child(body);
  }

  // TABLE DETAILS
  if (selected.kind === "table") {
    const tbl = selected.data;
    body.child(
      h_flex().gap(6).items_center()
        .child(badgeEl(tbl.state, t, 10))
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child(tbl.id))
        .child(div().text_size(11).text_color(t.dim).child("table")),
    );
    if (tbl.source) body.child(div().text_size(11).text_color(t.dim).child(tbl.source));
    if (composer) body.child(composer);
    if (tbl.entity) {
      body.child(
        h_flex().id("vr-tbl-ent").gap(6).py(4).items_center().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => onJumpToNode(`u:${tbl.entity}`, cx))
          .child(div().text_size(11).text_color(t.muted).child("Entity:"))
          .child(div().text_size(11).text_color(t.accent).child(tbl.entity)),
      );
    }
    if (tbl.columns?.length) {
      body.child(sectionHead(`Columns (${tbl.columns.length})`, t));
      for (const c of tbl.columns) {
        body.child(
          h_flex().gap(6).px(6).py(3).items_center().text_size(11)
            .child(badgeEl(c.state, t, 9))
            .child(div().font_semibold().text_color(t.foreground).child(c.name))
            .child(div().text_color(t.muted).child(c.baseType ? `${c.baseType} → ${c.type}` : c.type))
            .when(c.isPrimaryKey, (el) => el.child(div().px(4).rounded(2).bg(t.surface).text_size(9).text_color(t.accent).child("PK")))
            .when(c.references, (el) => el.child(div().text_size(10).text_color(t.dim).child(`→ ${c.references}`))),
        );
      }
    }
    if (tbl.source) body.child(renderDiffBox({ diffText, diffLoading, filePath: tbl.source, range: null, t, onOpenFile, onOpenSplitDiff }));
    return panel.child(body);
  }

  // EDGE DETAILS
  if (selected.kind === "edge") {
    const meta = selected.data.meta || {};
    body.child(
      h_flex().gap(6).items_center()
        .child(badgeEl(meta.state || "unchanged", t, 10))
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child(meta.label || meta.kind || "Relation")),
    );
    const list = meta.relations || [{ from: meta.from, to: meta.to, kind: meta.kind, state: meta.state }];
    if (composer) body.child(composer);
    body.child(sectionHead(`Connections (${list.length})`, t));
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const fk = r.from?.startsWith("t:") || r.from?.startsWith("u:") ? r.from : `u:${r.from}`;
      const tk = r.to?.startsWith("t:") || r.to?.startsWith("u:") ? r.to : `u:${r.to}`;
      body.child(
        v_flex().p(6).rounded(4).bg(t.surface).border(1).border_color(t.border).gap(4)
          .child(
            div().id(`vr-ef-${i}`).text_size(11).text_color(t.accent).hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => onJumpToNode(fk, cx))
              .child(`From: ${r.from}`),
          )
          .child(
            div().id(`vr-et-${i}`).text_size(11).text_color(t.accent).hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => onJumpToNode(tk, cx))
              .child(`To: ${r.to}`),
          ),
      );
    }
    return panel.child(body);
  }

  // OTHER FILE DETAILS
  if (selected.kind === "file") {
    const f = selected.data;
    body.child(
      h_flex().gap(6).items_center()
        .child(badgeEl(f.state, t, 10))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(f.path)),
    );
    if (composer) body.child(composer);
    body.child(renderDiffBox({ diffText, diffLoading, filePath: f.path, range: null, t, onOpenFile, onOpenSplitDiff }));
    return panel.child(body);
  }

  return panel.child(body);
}
