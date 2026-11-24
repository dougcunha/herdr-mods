// Native GPUI graph canvas & List renderer for Visual Review.
// Draws edges and UML markers with PathBuilder + window.paint_path(), and
// interactive containers/cards with div().absolute() + 3-level semantic zoom.
import { div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { filterModel, HEAD_H } from "./layout.js";

const ICONS = "mods/visual-review/icons";
const BADGE = { added: "+", modified: "~", deleted: "−", dropped: "−", removed: "−", context: "ctx", unchanged: "=" };
const REL_WORDS = {
  inheritance: ["extends", "extended by"],
  implementation: ["implements", "implemented by"],
  composition: ["owns", "owned by"],
  dependency: ["uses", "used by"],
  "table-link": ["maps to", "mapped by"],
};

export function stateColor(state, t) {
  if (state === "added") return t.ansi2;
  if (state === "modified") return t.ansi4;
  if (state === "deleted" || state === "dropped" || state === "removed") return t.ansi1;
  return t.muted;
}

export function badgeEl(state, t, fontSize = 10) {
  const solid = state !== "context" && state !== "unchanged";
  const col = stateColor(state, t);
  return div()
    .flex_none()
    .px(4)
    .h(Math.max(14, fontSize + 5))
    .rounded(3)
    .flex()
    .items_center()
    .justify_center()
    .text_size(fontSize)
    .font_bold()
    .when(solid, (el) => el.bg(col).text_color(t.background))
    .when(!solid, (el) => el.border(1).border_color(t.border).text_color(t.muted))
    .child(BADGE[state] || state);
}

/** Longest segment midpoint for placing an edge label. */
function edgeMidpoint(points) {
  let best = { len: -1, x: 0, y: 0 };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > best.len) best = { len, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  return best;
}

/** Builds grouped PathBuilder elements for all visible edges + UML markers. */
function buildEdgePaths(edges, zoom, panX, panY, selectedId, t) {
  const strokes = new Map();
  const fills = new Map();

  const sx = (x) => x * zoom + panX;
  const sy = (y) => y * zoom + panY;

  const getStroke = (color, width, dash) => {
    const key = `${color}|${width.toFixed(1)}|${dash || ""}`;
    if (!strokes.has(key)) {
      let pb = PathBuilder.stroke(width);
      if (dash === "dashed") pb = pb.dash_array([Math.max(3, 6 * zoom), Math.max(2, 4 * zoom)]);
      else if (dash === "dotted") pb = pb.dash_array([Math.max(1.5, 2 * zoom), Math.max(2, 3 * zoom)]);
      strokes.set(key, { pb, color });
    }
    return strokes.get(key);
  };

  const getFill = (color) => {
    if (!fills.has(color)) fills.set(color, { pb: PathBuilder.fill(), color });
    return fills.get(color);
  };

  for (const edge of edges) {
    const pts = edge.points;
    if (!pts || pts.length < 2) continue;
    const meta = edge.meta || {};
    const isSel = selectedId === `e:${edge.id}`;
    const color = isSel ? t.accent : (meta.state === "added" || meta.state === "removed" ? stateColor(meta.state, t) : t.muted);
    const dash = meta.kind === "implementation" || meta.kind === "dependency"
      ? "dashed"
      : meta.kind === "table-link"
        ? "dotted"
        : "";
    const baseW = meta.kind === "overview"
      ? Math.min(4.5, 1.2 + (meta.count || 1) * 0.45)
      : (isSel ? 2.4 : 1.4);
    const width = Math.max(1, baseW * Math.min(1.4, Math.max(0.65, zoom)));

    const entry = getStroke(color, width, dash);
    entry.pb = entry.pb.move_to(sx(pts[0].x), sy(pts[0].y));
    for (let i = 1; i < pts.length; i++) {
      entry.pb = entry.pb.line_to(sx(pts[i].x), sy(pts[i].y));
    }

    // Target marker
    const pPrev = pts[pts.length - 2];
    const pEnd = pts[pts.length - 1];
    const ang = Math.atan2(pEnd.y - pPrev.y, pEnd.x - pPrev.x);
    const sz = Math.max(5, 9 * Math.min(1.2, Math.max(0.6, zoom)));
    const ex = sx(pEnd.x), ey = sy(pEnd.y);
    const ax = ex - sz * Math.cos(ang - Math.PI / 6);
    const ay = ey - sz * Math.sin(ang - Math.PI / 6);
    const bx = ex - sz * Math.cos(ang + Math.PI / 6);
    const by = ey - sz * Math.sin(ang + Math.PI / 6);

    if (meta.kind === "inheritance" || meta.kind === "implementation") {
      const f = getFill(t.background);
      f.pb = f.pb.add_polygon([[ex, ey], [ax, ay], [bx, by]], true);
      const s = getStroke(color, Math.max(1.2, 1.5 * Math.min(1.2, zoom)), "");
      s.pb = s.pb.move_to(ex, ey).line_to(ax, ay).line_to(bx, by).close();
    } else {
      const s = getStroke(color, Math.max(1.2, 1.5 * Math.min(1.2, zoom)), "");
      s.pb = s.pb.move_to(ax, ay).line_to(ex, ey).line_to(bx, by);
    }

    // Source marker for composition (filled diamond)
    if (meta.kind === "composition") {
      const p0 = pts[0], p1 = pts[1];
      const sang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      const d = Math.max(4, 7 * Math.min(1.2, Math.max(0.6, zoom)));
      const x0 = sx(p0.x), y0 = sy(p0.y);
      const x1 = x0 + d * Math.cos(sang - Math.PI / 4), y1 = y0 + d * Math.sin(sang - Math.PI / 4);
      const x2 = x0 + d * 1.45 * Math.cos(sang), y2 = y0 + d * 1.45 * Math.sin(sang);
      const x3 = x0 + d * Math.cos(sang + Math.PI / 4), y3 = y0 + d * Math.sin(sang + Math.PI / 4);
      const f = getFill(color);
      f.pb = f.pb.add_polygon([[x0, y0], [x1, y1], [x2, y2], [x3, y3]], true);
    }
  }

  const els = [];
  for (const { pb, color } of strokes.values()) {
    els.push(window.paint_path(pb.build(), color).absolute().top(0).left(0).size_full());
  }
  for (const { pb, color } of fills.values()) {
    els.push(window.paint_path(pb.build(), color).absolute().top(0).left(0).size_full());
  }
  return els;
}

/** Renders a container frame + collapsible header. */
function renderContainer(c, { zoom, panX, panY, t, onToggle }) {
  const x = c.x * zoom + panX;
  const y = c.y * zoom + panY;
  const w = Math.max(80, c.width * zoom);
  const h = Math.max(24, c.height * zoom);
  const meta = c.meta || {};
  const collapsed = Boolean(meta.collapsed);
  const headH = Math.max(20, Math.min(h, HEAD_H * zoom));
  const fs = Math.max(9, Math.min(13, Math.round(12 * zoom)));
  const counts = meta.counts || {};
  const countParts = [];
  if (counts.added) countParts.push(`+${counts.added}`);
  if (counts.modified) countParts.push(`~${counts.modified}`);
  if (counts.deleted) countParts.push(`−${counts.deleted}`);

  return div()
    .id(`cont-${c.id}`)
    .absolute()
    .left(x)
    .top(y)
    .w(w)
    .h(h)
    .rounded(4)
    .bg(collapsed ? t.surface : t.chrome)
    .border(1)
    .border_color(meta.kind === "tables" ? t.accent : t.border)
    .overflow_hidden()
    .child(
      h_flex()
        .id(`cont-head-${c.id}`)
        .w_full()
        .h(headH)
        .px(Math.max(4, Math.round(8 * zoom)))
        .gap(5)
        .items_center()
        .bg(t.surface)
        .when(!collapsed, (el) => el.border_b(1).border_color(t.border))
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => onToggle(c.id, cx))
        .child(svg(`${ICONS}/${collapsed ? "chevron-right" : "chevron-down"}.svg`).size(Math.max(10, Math.round(12 * zoom))).text_color(t.muted).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_size(fs).font_semibold().text_color(t.foreground).child(meta.label || c.id))
        .when(countParts.length > 0 && zoom >= 0.45, (el) =>
          el.child(div().flex_none().text_size(Math.max(9, fs - 1)).text_color(t.muted).child(countParts.join(" ")))),
    );
}

/** Renders an Overview container summary box. */
function renderOverviewNode(n, { zoom, panX, panY, selectedId, t, onOpenContainer }) {
  const x = n.x * zoom + panX;
  const y = n.y * zoom + panY;
  const w = Math.max(90, n.width * zoom);
  const h = Math.max(30, n.height * zoom);
  const meta = n.meta || {};
  const counts = meta.counts || {};
  const isSel = selectedId === n.id;
  const fs = Math.max(10, Math.min(15, Math.round(13 * zoom)));

  return v_flex()
    .id(`ov-${n.id}`)
    .absolute()
    .left(x)
    .top(y)
    .w(w)
    .h(h)
    .rounded(4)
    .bg(t.surface)
    .border(isSel ? 2 : 1)
    .border_color(isSel ? t.accent : t.border)
    .px(Math.max(6, Math.round(10 * zoom)))
    .py(Math.max(4, Math.round(6 * zoom)))
    .justify_between()
    .overflow_hidden()
    .hover((s) => s.bg(t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => onOpenContainer(n.id, cx))
    .child(
      h_flex().gap(6).items_center().min_w(0)
        .child(svg(`${ICONS}/folder.svg`).size(Math.max(11, Math.round(13 * zoom))).text_color(t.accent).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_size(fs).font_semibold().text_color(t.foreground).child(meta.label || n.id)),
    )
    .child(
      h_flex().gap(8).items_center().text_size(Math.max(9, fs - 2))
        .child(div().text_color(t.muted).child(`${meta.total || 0} item${meta.total === 1 ? "" : "s"}`))
        .when(counts.added > 0, (el) => el.child(div().text_color(t.ansi2).font_semibold().child(`+${counts.added}`)))
        .when(counts.modified > 0, (el) => el.child(div().text_color(t.ansi4).font_semibold().child(`~${counts.modified}`)))
        .when(counts.deleted > 0, (el) => el.child(div().text_color(t.ansi1).font_semibold().child(`−${counts.deleted}`))),
    );
}

/** Renders a Unit or Table card with 3-level semantic zoom. */
function renderCardNode(n, { zoom, panX, panY, selectedId, focusKey, queueCount = 0, t, onSelect, onSelectMember, onFocus }) {
  const x = n.x * zoom + panX;
  const y = n.y * zoom + panY;
  const w = Math.max(70, n.width * zoom);
  const h = Math.max(22, n.height * zoom);
  const item = n.meta || {};
  const isTable = item.kind === "table";
  const data = item.data || {};
  const state = data.state || "modified";
  const isSel = selectedId === n.id;
  const isFocused = focusKey === n.id;
  const isContext = state === "context";
  const topColor = stateColor(state, t);

  // 3 semantic zoom tiers
  const tier = zoom < 0.55 ? 0 : zoom < 0.85 ? 1 : 2;
  const padX = Math.max(4, Math.round(9 * zoom));
  const padY = Math.max(3, Math.round(6 * zoom));
  const titleFs = Math.max(9, Math.min(14, Math.round(12.5 * zoom)));
  const subFs = Math.max(8, Math.min(12, Math.round(10.5 * zoom)));

  const card = v_flex()
    .id(`node-${n.id}`)
    .absolute()
    .left(x)
    .top(y)
    .w(w)
    .h(h)
    .rounded(4)
    .bg(isContext ? t.chrome : t.background)
    .border(isSel || isFocused ? 2 : 1)
    .border_color(isSel ? t.accent : isFocused ? t.foreground : t.border)
    .overflow_hidden()
    .hover((s) => s.border_color(isSel ? t.accent : t.muted))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => onSelect(n.id, item, cx));

  // 3px colored top state rule
  if (!isContext) {
    card.child(div().w_full().h(Math.max(2, Math.round(3 * zoom))).flex_none().bg(topColor));
  }

  const body = v_flex().flex_1().min_h(0).px(padX).py(padY).gap(Math.max(2, Math.round(4 * zoom))).overflow_hidden();

  // Header row: badge + name + queue chip + kind/delta + Focus button (tier 2)
  const head = h_flex().w_full().gap(5).items_center().min_w(0)
    .child(badgeEl(state, t, Math.max(8, Math.round(10 * zoom))))
    .child(div().flex_1().min_w(0).truncate().text_size(titleFs).font_semibold().text_color(isContext ? t.muted : t.foreground).child(isTable ? data.id : data.name))
    .when(queueCount > 0, (el) =>
      el.child(
        div().flex_none().px(5).h(Math.max(14, Math.round(16 * zoom))).rounded(8).bg(t.accent).text_color(t.accent_foreground)
          .flex().items_center().text_size(Math.max(8, Math.round(10 * zoom))).font_bold()
          .child(String(queueCount)),
      ));

  if (tier === 0 && !isTable && !isContext) {
    const dText = `${data.added != null ? `+${data.added}` : ""}${data.removed ? ` −${data.removed}` : ""}`.trim();
    if (dText) head.child(div().flex_none().text_size(subFs).text_color(t.muted).child(dText));
  } else if (tier >= 1) {
    head.child(div().flex_none().text_size(subFs).text_color(t.dim).child(isTable ? "table" : data.kind));
  }

  if (tier === 2) {
    head.child(
      div()
        .id(`focus-${n.id}`)
        .flex_none()
        .px(5)
        .h(18)
        .rounded(3)
        .border(1)
        .border_color(isFocused ? t.accent : t.border)
        .bg(isFocused ? t.accent : t.surface)
        .flex()
        .items_center()
        .text_size(10)
        .text_color(isFocused ? t.accent_foreground : t.muted)
        .hover((s) => s.bg(isFocused ? t.accent : t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); onFocus(n.id, cx); })
        .child(isFocused ? "All" : "Focus"),
    );
  }
  body.child(head);

  // Tier 1 & 2: metrics & summary / columns
  if (tier >= 1 && !isContext) {
    if (isTable) {
      const cols = data.columns || [];
      const limit = tier === 2 ? 8 : 3;
      if (cols.length > 0) {
        const colList = v_flex().gap(2).overflow_hidden();
        for (const col of cols.slice(0, limit)) {
          colList.child(
            h_flex().gap(4).items_center().text_size(subFs)
              .child(badgeEl(col.state, t, Math.max(8, subFs - 1)))
              .child(div().truncate().text_color(t.foreground).child(col.name))
              .child(div().truncate().text_color(t.dim).child(col.baseType ? `${col.baseType} → ${col.type}` : col.type)),
          );
        }
        if (cols.length > limit) {
          colList.child(div().text_size(subFs).text_color(t.dim).child(`+${cols.length - limit} more columns`));
        }
        body.child(colList);
      } else {
        body.child(div().text_size(subFs).text_color(t.dim).truncate().child(data.source || "schema change"));
      }
    } else {
      // Size & quality metrics row
      const mRow = h_flex().gap(7).items_center().text_size(subFs).overflow_hidden();
      if (data.lines != null) mRow.child(div().text_color(t.muted).child(`${data.lines}L`));
      if (data.added != null && state !== "deleted") mRow.child(div().text_color(t.ansi2).font_semibold().child(`+${data.added}`));
      if (data.removed != null && state !== "added") mRow.child(div().text_color(t.ansi1).font_semibold().child(`−${data.removed}`));
      if (data.methods != null && data.methods > 0) mRow.child(div().text_color(t.muted).child(`${data.methods}m`));
      if (data.cohesion) mRow.child(div().text_color(t.accent).font_semibold().child(`C${data.cohesion.score}`));
      if (data.ce > 0 || data.ca > 0) mRow.child(div().text_color(t.dim).child(`Ce ${data.ce} · Ca ${data.ca}`));
      body.child(mRow);

      // Summary
      if (data.summary) {
        body.child(
          div()
            .text_size(subFs)
            .text_color(t.muted)
            .overflow_hidden()
            .max_h(tier === 2 ? 52 : 28)
            .child(data.summary),
        );
      }

      // Tier 2: changed members list
      if (tier === 2 && data.members && data.members.length > 0) {
        const mList = v_flex().gap(2).pt(2).border_t(1).border_color(t.border).overflow_hidden();
        for (const m of data.members.slice(0, 6)) {
          mList.child(
            h_flex()
              .id(`mem-${n.id}-${m.id}`)
              .gap(5)
              .items_center()
              .px(3)
              .h(18)
              .rounded(3)
              .hover((s) => s.bg(t.hover))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => { cx.stop_propagation(); onSelectMember(n.id, item, m, cx); })
              .child(badgeEl(m.state, t, 9))
              .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.foreground).child(m.kind === "method" || m.kind === "constructor" ? `${m.name}()` : m.name)),
          );
        }
        if (data.members.length > 6) {
          mList.child(div().text_size(10).text_color(t.dim).px(3).child(`+${data.members.length - 6} more members`));
        }
        body.child(mList);
      }
    }
  }

  return card.child(body);
}

/** Main interactive GPUI graph canvas (Overview & Diagram modes). */
export function renderCanvas({
  layout, zoom, panX, panY, viewSize, selectedId, focusKey, queueCounts, mode, t,
  onSelectNode, onSelectMember, onSelectEdge, onToggleContainer, onOpenContainer, onFocus,
  onPanStart, onPanMove, onPanEnd, onWheel, onPinch, onBackgroundClick,
}) {
  const vw = viewSize?.width || 900;
  const vh = viewSize?.height || 600;
  const margin = 120;

  const visible = (r) => {
    const sx = r.x * zoom + panX;
    const sy = r.y * zoom + panY;
    const sw = r.width * zoom;
    const sh = r.height * zoom;
    return sx + sw >= -margin && sx <= vw + margin && sy + sh >= -margin && sy <= vh + margin;
  };

  const root = div()
    .id("vr-canvas")
    .relative()
    .flex_1()
    .h_full()
    .min_w(0)
    .min_h(0)
    .bg(t.canvas)
    .overflow_hidden()
    .on_mouse_down("left", (e, cx) => onPanStart(e, cx))
    .on_window_mouse_move((e, cx) => onPanMove(e, cx))
    .on_window_mouse_up("left", (e, cx) => onPanEnd(e, cx))
    .on_scroll_wheel((e, cx) => onWheel(e, cx))
    .on_pinch((e, cx) => onPinch(e, cx))
    .on_click((e, cx) => onBackgroundClick(e, cx));

  if (!layout || (!layout.containers.length && !layout.nodes.length)) {
    return root.flex().items_center().justify_center().child(
      div().text_size(13).text_color(t.muted).child("No changed units to display for this selection."),
    );
  }

  // 1. Containers (behind edges & cards)
  for (const c of layout.containers) {
    if (!visible(c)) continue;
    root.child(renderContainer(c, { zoom, panX, panY, t, onToggle: onToggleContainer }));
  }

  // 2. Edges painted natively on GPU
  if (layout.edges.length > 0) {
    const edgePaths = buildEdgePaths(layout.edges, zoom, panX, panY, selectedId, t);
    for (const ep of edgePaths) root.child(ep);
  }

  // 3. Nodes (Overview boxes or Unit/Table cards)
  for (const n of layout.nodes) {
    if (!visible(n)) continue;
    if (mode === "overview") {
      root.child(renderOverviewNode(n, { zoom, panX, panY, selectedId, t, onOpenContainer }));
    } else {
      root.child(renderCardNode(n, {
        zoom, panX, panY, selectedId, focusKey, queueCount: queueCounts?.get(n.id) ?? 0, t,
        onSelect: onSelectNode,
        onSelectMember,
        onFocus,
      }));
    }
  }

  // 4. Edge labels (in Diagram mode when zoom >= 0.65)
  if (mode !== "overview" && zoom >= 0.65 && layout.edges.length <= 80) {
    for (const edge of layout.edges) {
      const mid = edgeMidpoint(edge.points);
      if (mid.len < 24) continue;
      const lx = mid.x * zoom + panX - 36;
      const ly = mid.y * zoom + panY - 9;
      if (lx < -margin || lx > vw + margin || ly < -margin || ly > vh + margin) continue;
      const isSel = selectedId === `e:${edge.id}`;
      const col = isSel ? t.accent : stateColor(edge.meta?.state, t);
      root.child(
        div()
          .id(`elbl-${edge.id}`)
          .absolute()
          .left(lx)
          .top(ly)
          .px(5)
          .h(17)
          .rounded(3)
          .bg(t.surface)
          .border(1)
          .border_color(isSel ? t.accent : t.border)
          .flex()
          .items_center()
          .text_size(10)
          .text_color(col)
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); onSelectEdge(edge, cx); })
          .child(edge.meta?.label || edge.meta?.kind || "rel"),
      );
    }
  }

  return root;
}

/** Linear List mode: grouped by container, clickable rows and relation links. */
export function renderListView({ model, state, selectedId, t, onSelectNode, onJumpToUnit }) {
  const filtered = filterModel(model, state);
  const groups = new Map();
  const byId = new Map();

  for (const u of filtered.units) {
    byId.set(`u:${u.id}`, u);
    if (!groups.has(u.container)) groups.set(u.container, []);
    groups.get(u.container).push({ kind: "unit", id: `u:${u.id}`, data: u });
  }
  if (filtered.tables.length > 0) {
    groups.set("Database Tables", filtered.tables.map((tbl) => ({ kind: "table", id: `t:${tbl.id}`, data: tbl })));
  }

  const relsByNode = new Map();
  for (const r of filtered.relations) {
    const fk = r.from.startsWith("t:") ? r.from : `u:${r.from}`;
    const tk = r.to.startsWith("t:") ? r.to : `u:${r.to}`;
    const words = REL_WORDS[r.kind] || [r.kind, r.kind];
    if (!relsByNode.has(fk)) relsByNode.set(fk, []);
    relsByNode.get(fk).push({ word: words[0], target: tk, state: r.state });
    if (!relsByNode.has(tk)) relsByNode.set(tk, []);
    relsByNode.get(tk).push({ word: words[1], target: fk, state: r.state });
  }

  const scroll = v_flex().id("vr-list").flex_1().h_full().min_w(0).min_h(0).bg(t.canvas).p(16).gap(14).overflow_y_scrollbar();

  for (const [groupName, items] of groups) {
    const section = v_flex().gap(6).max_w(940).w_full();
    section.child(
      h_flex().gap(6).items_center().pb(4).border_b(1).border_color(t.border)
        .child(svg(`${ICONS}/folder.svg`).size(13).text_color(t.accent))
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child(groupName))
        .child(div().text_size(11).text_color(t.dim).child(`(${items.length})`)),
    );

    for (const item of items) {
      const d = item.data;
      const isTable = item.kind === "table";
      const isSel = selectedId === item.id;
      const col = stateColor(d.state, t);
      const rels = relsByNode.get(item.id) || [];

      const row = h_flex()
        .id(`lrow-${item.id}`)
        .w_full()
        .rounded(4)
        .bg(isSel ? t.selected : t.surface)
        .border(1)
        .border_color(isSel ? t.accent : t.border)
        .overflow_hidden()
        .hover((s) => s.bg(isSel ? t.selected : t.hover))
        .on_click((_e, cx) => onSelectNode(item.id, item, cx))
        .child(div().w(3).flex_none().bg(col))
        .child(
          v_flex().flex_1().min_w(0).px(10).py(7).gap(4)
            .child(
              h_flex().gap(8).items_center()
                .child(badgeEl(d.state, t, 10))
                .child(div().text_size(13).font_semibold().text_color(t.foreground).child(isTable ? d.id : d.name))
                .child(div().text_size(11).text_color(t.dim).child(isTable ? "table" : d.kind))
                .when(!isTable && d.added != null, (el) => el.child(div().text_size(11).text_color(t.ansi2).child(`+${d.added}`)))
                .when(!isTable && d.removed != null && d.removed > 0, (el) => el.child(div().text_size(11).text_color(t.ansi1).child(`−${d.removed}`)))
                .when(!isTable && d.cohesion, (el) => el.child(div().text_size(11).text_color(t.accent).child(`C${d.cohesion.score}`)))
                .when(!isTable && (d.ce > 0 || d.ca > 0), (el) => el.child(div().text_size(11).text_color(t.dim).child(`Ce ${d.ce} · Ca ${d.ca}`))),
            )
            .when(!isTable && d.summary, (el) => el.child(div().text_size(12).text_color(t.muted).child(d.summary)))
            .when(rels.length > 0, (el) =>
              el.child(
                h_flex().flex_wrap().gap(6).pt(2).children(
                  rels.slice(0, 12).map((r, idx) => {
                    const targetUnit = byId.get(r.target);
                    const targetLabel = targetUnit ? targetUnit.name : r.target.replace(/^[ut]:/, "");
                    return h_flex()
                      .id(`lrel-${item.id}-${idx}`)
                      .gap(4)
                      .px(5)
                      .h(20)
                      .rounded(3)
                      .bg(t.background)
                      .border(1)
                      .border_color(t.border)
                      .items_center()
                      .text_size(11)
                      .hover((s) => s.border_color(t.accent))
                      .on_click((_e, cx) => { cx.stop_propagation(); onJumpToUnit(r.target, cx); })
                      .child(div().text_color(t.dim).child(r.word))
                      .child(div().text_color(t.accent).child(targetLabel));
                  }),
                ),
              )),
        );
      section.child(row);
    }
    scroll.child(section);
  }

  return scroll;
}
