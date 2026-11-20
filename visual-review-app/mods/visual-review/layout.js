// Graph layout engine for Visual Review.
// Transforms a ChangeModel + viewport filters into positioned containers, nodes
// and orthogonal/polyline edges via elkjs (Node.js) with a pure-JS layered fallback.
import * as fs from "fs/promises";
import { appHome, exec } from "herdr";

export const CARD_W = 260;
export const HEAD_H = 32;
export const COLLAPSED_W = 230;
export const OVERVIEW_W = 250;
export const OVERVIEW_H = 58;

const DIAGRAM_OPTS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": "28",
  "elk.layered.spacing.nodeNodeBetweenLayers": "48",
  "elk.spacing.edgeEdge": "12",
  "elk.spacing.edgeNode": "18",
};

const OVERVIEW_OPTS = {
  ...DIAGRAM_OPTS,
  "elk.edgeRouting": "POLYLINE",
  "elk.spacing.nodeNode": "40",
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
};

const CONTAINER_PADDING = `[top=${HEAD_H + 14},left=14,bottom=14,right=14]`;

/** Deterministic height estimate for a unit card at 100% zoom. */
export function estimateUnitHeight(u) {
  if (u.state === "context") return 38;
  let h = 34; // header + top bar
  h += 22; // size metrics row
  if (u.cohesion || u.ce > 0 || u.ca > 0) h += 18; // quality row
  if (u.summary) {
    const lines = Math.min(4, Math.max(1, Math.ceil(u.summary.length / 36)));
    h += lines * 16 + 6;
  }
  if (u.members && u.members.length > 0) {
    h += Math.min(u.members.length, 6) * 20 + 8;
    if (u.members.length > 6) h += 16;
  }
  return Math.max(66, h + 10);
}

/** Deterministic height estimate for a table card at 100% zoom. */
export function estimateTableHeight(t) {
  let h = 38;
  if (t.columns && t.columns.length > 0) {
    h += Math.min(t.columns.length, 8) * 19 + 8;
    if (t.columns.length > 8) h += 16;
  } else {
    h += 20;
  }
  return Math.max(58, h + 8);
}

/** Filters visible units, tables and relations according to Focus and edge toggles. */
export function filterModel(model, state) {
  const hiddenRels = state.hiddenRelations ?? new Set();
  const hideAllEdges = Boolean(state.hideAllEdges);
  const focusKey = state.focusKey ?? null;

  let units = model.units ?? [];
  let tables = model.tables ?? [];
  let relations = model.relations ?? [];

  if (focusKey) {
    const allowed = new Set([focusKey]);
    for (const r of relations) {
      const fromKey = r.from.startsWith("t:") ? r.from : `u:${r.from}`;
      const toKey = r.to.startsWith("t:") ? r.to : `u:${r.to}`;
      if (fromKey === focusKey) allowed.add(toKey);
      if (toKey === focusKey) allowed.add(fromKey);
    }
    units = units.filter((u) => allowed.has(`u:${u.id}`));
    tables = tables.filter((t) => allowed.has(`t:${t.id}`));
  }

  const unitSet = new Set(units.map((u) => `u:${u.id}`));
  const tableSet = new Set(tables.map((t) => `t:${t.id}`));

  const visibleRelations = hideAllEdges
    ? []
    : relations.filter((r) => {
      if (hiddenRels.has(r.kind)) return false;
      const fk = r.from.startsWith("t:") ? r.from : `u:${r.from}`;
      const tk = r.to.startsWith("t:") ? r.to : `u:${r.to}`;
      return (unitSet.has(fk) || tableSet.has(fk)) && (unitSet.has(tk) || tableSet.has(tk));
    });

  return { units, tables, relations: visibleRelations };
}

function buildOverviewGraph(filtered) {
  const groups = new Map();
  const nodeToGroup = new Map();

  for (const u of filtered.units) {
    const gId = `c:${u.container}`;
    if (!groups.has(gId)) {
      groups.set(gId, {
        id: gId,
        label: u.container,
        kind: "container",
        counts: { added: 0, modified: 0, deleted: 0, context: 0 },
        total: 0,
      });
    }
    const g = groups.get(gId);
    g.counts[u.state] = (g.counts[u.state] || 0) + 1;
    g.total++;
    nodeToGroup.set(`u:${u.id}`, gId);
  }

  if (filtered.tables.length > 0) {
    const gId = "c:__tables__";
    const g = {
      id: gId,
      label: "Database Tables",
      kind: "tables",
      counts: { added: 0, modified: 0, deleted: 0, context: 0 },
      total: filtered.tables.length,
    };
    for (const t of filtered.tables) {
      if (t.state === "added") g.counts.added++;
      else if (t.state === "dropped") g.counts.deleted++;
      else g.counts.modified++;
      nodeToGroup.set(`t:${t.id}`, gId);
    }
    groups.set(gId, g);
  }

  const children = [...groups.values()].map((g) => ({
    id: g.id,
    width: OVERVIEW_W,
    height: OVERVIEW_H,
    _meta: g,
  }));

  // Merge edges between distinct groups
  const merged = new Map();
  for (const r of filtered.relations) {
    const fk = r.from.startsWith("t:") ? r.from : `u:${r.from}`;
    const tk = r.to.startsWith("t:") ? r.to : `u:${r.to}`;
    const fg = nodeToGroup.get(fk);
    const tg = nodeToGroup.get(tk);
    if (!fg || !tg || fg === tg) continue;
    const key = `${fg}=>${tg}`;
    if (!merged.has(key)) merged.set(key, { id: key, sources: [fg], targets: [tg], count: 0, kinds: new Set(), state: "unchanged" });
    const e = merged.get(key);
    e.count++;
    e.kinds.add(r.kind);
    if (r.state === "added") e.state = "added";
    else if (r.state === "removed" && e.state !== "added") e.state = "removed";
  }

  const edges = [...merged.values()].map((e) => ({
    id: e.id,
    sources: e.sources,
    targets: e.targets,
    _meta: {
      id: e.id,
      from: e.sources[0],
      to: e.targets[0],
      kind: "overview",
      state: e.state,
      count: e.count,
      kinds: [...e.kinds],
      label: `${e.count} rel${e.count === 1 ? "" : "s"}`,
    },
  }));

  return {
    id: "root",
    layoutOptions: OVERVIEW_OPTS,
    children,
    edges,
  };
}

function buildDiagramGraph(filtered, collapsed) {
  const byContainer = new Map();
  const nodeOwner = new Map();

  for (const u of filtered.units) {
    const cid = `c:${u.container}`;
    if (!byContainer.has(cid)) {
      byContainer.set(cid, {
        id: cid,
        label: u.container,
        kind: "container",
        items: [],
        counts: { added: 0, modified: 0, deleted: 0, context: 0 },
      });
    }
    const c = byContainer.get(cid);
    c.items.push({ kind: "unit", id: `u:${u.id}`, data: u });
    c.counts[u.state] = (c.counts[u.state] || 0) + 1;
    nodeOwner.set(`u:${u.id}`, cid);
  }

  if (filtered.tables.length > 0) {
    const cid = "c:__tables__";
    const c = {
      id: cid,
      label: "Database Tables",
      kind: "tables",
      items: [],
      counts: { added: 0, modified: 0, deleted: 0, context: 0 },
    };
    for (const t of filtered.tables) {
      c.items.push({ kind: "table", id: `t:${t.id}`, data: t });
      if (t.state === "added") c.counts.added++;
      else if (t.state === "dropped") c.counts.deleted++;
      else c.counts.modified++;
      nodeOwner.set(`t:${t.id}`, cid);
    }
    byContainer.set(cid, c);
  }

  const children = [];
  for (const c of byContainer.values()) {
    const isCollapsed = collapsed.has(c.id);
    if (isCollapsed) {
      children.push({
        id: c.id,
        width: COLLAPSED_W,
        height: HEAD_H,
        _meta: { ...c, collapsed: true, itemCount: c.items.length },
      });
    } else {
      children.push({
        id: c.id,
        layoutOptions: { "elk.padding": CONTAINER_PADDING },
        _meta: { ...c, collapsed: false, itemCount: c.items.length },
        children: c.items.map((item) => ({
          id: item.id,
          width: CARD_W,
          height: item.kind === "unit" ? estimateUnitHeight(item.data) : estimateTableHeight(item.data),
          _meta: item,
        })),
      });
    }
  }

  // Reroute edges whose endpoint sits inside a collapsed container
  const merged = new Map();
  for (const r of filtered.relations) {
    const fk = r.from.startsWith("t:") ? r.from : `u:${r.from}`;
    const tk = r.to.startsWith("t:") ? r.to : `u:${r.to}`;
    const fc = nodeOwner.get(fk);
    const tc = nodeOwner.get(tk);
    const src = collapsed.has(fc) ? fc : fk;
    const tgt = collapsed.has(tc) ? tc : tk;
    if (!src || !tgt || src === tgt) continue;
    const key = `${src}=>${tgt}:${r.kind}`;
    if (!merged.has(key)) {
      merged.set(key, {
        id: key,
        sources: [src],
        targets: [tgt],
        count: 0,
        kind: r.kind,
        state: r.state,
        relations: [],
      });
    }
    const e = merged.get(key);
    e.count++;
    e.relations.push(r);
    if (r.state === "added") e.state = "added";
    else if (r.state === "removed" && e.state !== "added") e.state = "removed";
  }

  const edges = [...merged.values()].map((e) => ({
    id: e.id,
    sources: e.sources,
    targets: e.targets,
    _meta: {
      id: e.id,
      from: e.sources[0],
      to: e.targets[0],
      kind: e.kind,
      state: e.state,
      count: e.count,
      relations: e.relations,
      label: e.count > 1 ? `${e.kind} (${e.count})` : e.kind,
    },
  }));

  return {
    id: "root",
    layoutOptions: DIAGRAM_OPTS,
    children,
    edges,
  };
}

/** Pure-JS layered fallback layout when Node.js is unavailable. */
function fallbackLayout(graph) {
  const PAD = 24;
  const GAP_X = 28;
  const GAP_Y = 36;
  const containers = [];
  const nodes = [];
  const boxMap = new Map();

  // Pack children inside each container, then arrange containers in a grid
  const positionedContainers = [];
  for (const ch of graph.children || []) {
    if (ch.children && ch.children.length > 0) {
      const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(ch.children.length))));
      let colX = 14;
      let rowY = HEAD_H + 14;
      let rowH = 0;
      let maxW = COLLAPSED_W;
      const localNodes = [];
      ch.children.forEach((n, idx) => {
        if (idx > 0 && idx % cols === 0) {
          rowY += rowH + 18;
          colX = 14;
          rowH = 0;
        }
        localNodes.push({ ...n, lx: colX, ly: rowY });
        colX += n.width + 20;
        rowH = Math.max(rowH, n.height);
        maxW = Math.max(maxW, colX - 6);
      });
      const totalH = rowY + rowH + 14;
      positionedContainers.push({ ...ch, width: maxW, height: totalH, localNodes });
    } else {
      positionedContainers.push({ ...ch, localNodes: [] });
    }
  }

  const maxRowW = 1120;
  let cx = PAD;
  let cy = PAD;
  let rowH = 0;
  let totalW = 0;
  let totalH = 0;

  for (const c of positionedContainers) {
    if (cx > PAD && cx + c.width > maxRowW) {
      cx = PAD;
      cy += rowH + GAP_Y;
      rowH = 0;
    }
    const rect = { x: cx, y: cy, width: c.width, height: c.height };
    boxMap.set(c.id, rect);
    if (c.localNodes.length > 0 || c._meta?.collapsed) {
      containers.push({ id: c.id, ...rect, meta: c._meta });
    } else {
      nodes.push({ id: c.id, ...rect, meta: c._meta });
    }
    for (const n of c.localNodes) {
      const nr = { x: cx + n.lx, y: cy + n.ly, width: n.width, height: n.height };
      boxMap.set(n.id, nr);
      nodes.push({ id: n.id, ...nr, meta: n._meta });
    }
    cx += c.width + GAP_X;
    rowH = Math.max(rowH, c.height);
    totalW = Math.max(totalW, cx);
    totalH = Math.max(totalH, cy + c.height + PAD);
  }

  const edges = [];
  for (const e of graph.edges || []) {
    const s = boxMap.get(e.sources[0]);
    const t = boxMap.get(e.targets[0]);
    if (!s || !t) continue;
    const sx = s.x + s.width / 2;
    const sy = s.y + s.height;
    const tx = t.x + t.width / 2;
    const ty = t.y;
    const midY = (sy + ty) / 2;
    edges.push({
      id: e.id,
      meta: e._meta,
      points: [{ x: sx, y: sy }, { x: sx, y: midY }, { x: tx, y: midY }, { x: tx, y: ty }],
    });
  }

  return {
    width: Math.max(400, totalW + PAD),
    height: Math.max(300, totalH + PAD),
    containers,
    nodes,
    edges,
    engine: "fallback",
  };
}

/** Strips `_meta` before sending to elk-runner and re-attaches it when flattening. */
function stripMeta(graph) {
  const cleanNode = (n) => {
    const out = { id: n.id };
    if (n.width != null) out.width = n.width;
    if (n.height != null) out.height = n.height;
    if (n.layoutOptions) out.layoutOptions = n.layoutOptions;
    if (n.children) out.children = n.children.map(cleanNode);
    if (n.edges) out.edges = n.edges.map((e) => ({ id: e.id, sources: e.sources, targets: e.targets }));
    return out;
  };
  return cleanNode(graph);
}

function flattenElk(laidOut, original) {
  const nodeMeta = new Map();
  const edgeMeta = new Map();
  const collectMeta = (n) => {
    if (n._meta) nodeMeta.set(n.id, n._meta);
    for (const c of n.children || []) collectMeta(c);
    for (const e of n.edges || []) if (e._meta) edgeMeta.set(e.id, e._meta);
  };
  collectMeta(original);

  const containers = [];
  const nodes = [];
  const rawEdges = [];
  const absPos = new Map();
  const PAD = 20;

  absPos.set("root", { x: PAD, y: PAD });

  const walk = (node, ox, oy) => {
    const ax = ox + (node.x || 0);
    const ay = oy + (node.y || 0);
    if (node.id) absPos.set(node.id, { x: ax, y: ay });
    for (const ch of node.children || []) {
      const cx = ax + (ch.x || 0);
      const cy = ay + (ch.y || 0);
      absPos.set(ch.id, { x: cx, y: cy });
      const meta = nodeMeta.get(ch.id);
      if (ch.children && ch.children.length > 0) {
        containers.push({ id: ch.id, x: cx, y: cy, width: ch.width || 0, height: ch.height || 0, meta });
        walk(ch, ax, ay);
      } else if (meta?.collapsed) {
        containers.push({ id: ch.id, x: cx, y: cy, width: ch.width || 0, height: ch.height || 0, meta });
      } else {
        nodes.push({ id: ch.id, x: cx, y: cy, width: ch.width || 0, height: ch.height || 0, meta });
      }
    }
    for (const e of node.edges || []) {
      rawEdges.push({ e, fallbackOrigin: { x: ax, y: ay } });
    }
  };

  walk(laidOut, PAD, PAD);

  const edges = [];
  for (const { e, fallbackOrigin } of rawEdges) {
    const meta = edgeMeta.get(e.id);
    const origin = (e.container && absPos.get(e.container)) || fallbackOrigin;
    const pts = [];
    for (const sec of e.sections || []) {
      if (sec.startPoint) pts.push({ x: origin.x + sec.startPoint.x, y: origin.y + sec.startPoint.y });
      for (const bp of sec.bendPoints || []) pts.push({ x: origin.x + bp.x, y: origin.y + bp.y });
      if (sec.endPoint) pts.push({ x: origin.x + sec.endPoint.x, y: origin.y + sec.endPoint.y });
    }
    if (pts.length >= 2) edges.push({ id: e.id, points: pts, meta });
  }

  return {
    width: Math.max(400, (laidOut.width || 400) + PAD * 2),
    height: Math.max(300, (laidOut.height || 300) + PAD * 2),
    containers,
    nodes,
    edges,
    engine: "elk",
  };
}

let tmpSeq = 0;

export async function computeLayout(model, state) {
  const filtered = filterModel(model, state);
  const mode = state.mode === "overview" ? "overview" : "diagram";
  const collapsed = state.collapsedContainers ?? new Set();

  const elkGraph = mode === "overview"
    ? buildOverviewGraph(filtered)
    : buildDiagramGraph(filtered, collapsed);

  if (!elkGraph.children.length) {
    return { width: 400, height: 300, containers: [], nodes: [], edges: [], engine: "empty" };
  }

  const base = appHome().replace(/\\/g, "/");
  const runnerPath = `${base}/mods/visual-review/elk-runner.mjs`;
  const tmpDir = `${base}/data/visual-review/tmp`;
  const tmpFile = `${tmpDir}/g-${Date.now().toString(36)}-${++tmpSeq}.json`;

  try {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(tmpFile, JSON.stringify(stripMeta(elkGraph)));
    const r = await exec("node", [runnerPath, tmpFile], { timeout: 20000 });
    fs.unlink(tmpFile).catch(() => {});
    if (r.code === 0 && r.stdout) {
      const laidOut = JSON.parse(r.stdout);
      return flattenElk(laidOut, elkGraph);
    }
  } catch {
    fs.unlink(tmpFile).catch(() => {});
  }

  return fallbackLayout(elkGraph);
}
