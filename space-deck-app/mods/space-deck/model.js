// What the panel shows, as plain data: the Pinned section, one group of rows
// for each machine, and the recent spaces. The panel draws it; the demo
// command gives fake data in the same shape.

import { spaces, agents, panes, machines } from "herdr";
import { where, place } from "./git.js";
import { keyOf, item, pins, needsYouFirst, normFolder } from "./store.js";

const URGENT = { blocked: 0, done: 1 };
export const needsYou = (status) => status === "blocked" || status === "done";

/**
 * One row for each space:
 * { id, name, active, status, machine, key, where, folder, git, agents, tabs, terms, terminals, activity, tree, parent, index }
 * `terminals`: [{ terminal, pane, title, cwd, status, app, program, focused }], in Herdr's order.
 */
export function rows(git) {
  const ps = panes();
  const ag = agents();
  return spaces().map((s, index) => {
    const w = where(s, ps);
    const g = git.get(w) ?? null;
    const folder = place(s, ps);
    const tabIds = new Set((s.tabs ?? []).map((t) => t.id));
    const key = keyOf(s.machine, g?.top || folder);
    const changed = Math.max(0, ...(s.tabs ?? []).map((t) => t.changed_at ?? 0));
    return {
      id: s.id,
      name: s.name,
      active: s.active,
      status: s.status,
      machine: s.machine ?? null,
      key,
      where: w,
      folder,
      git: g,
      agents: ag.filter((a) => a.space === s.id).map((a) => ({ address: a.address, status: a.status, program: a.program, name: a.program?.name ?? a.app ?? "agent", pane: a.pane })),
      tabs: (s.tabs ?? []).length,
      terms: ps.filter((p) => p.terminal && tabIds.has(p.tab)).length,
      terminals: ps.filter((p) => p.terminal && tabIds.has(p.tab)).map((p) => ({
        terminal: p.terminal, pane: p.pane, title: p.title, cwd: p.cwd, status: p.status, app: p.app, program: p.program, focused: p.focused,
      })),
      activity: Math.max(changed, item(key).activeAt ?? 0) || null,
      tree: null,
      parent: null,
      index,
    };
  });
}

/** Rows in Herdr's order, each worktree under the row of its repo (when that row is in `list`). */
function nest(list) {
  const mains = new Set(list.filter((r) => r.git && !r.git.linked).map((r) => r.git.repo));
  const nested = (r) => r.git?.linked && mains.has(r.git.repo);
  const units = [];
  const placed = new Set();
  for (const r of list) {
    if (nested(r)) continue;
    const unit = [r];
    if (r.git && !r.git.linked && !placed.has(r.git.repo)) {
      placed.add(r.git.repo);
      const kids = list.filter((k) => nested(k) && k.git.repo === r.git.repo);
      kids.forEach((k, n) => unit.push({ ...k, tree: n === kids.length - 1 ? "└" : "├" }));
    }
    units.push(unit);
  }
  return units;
}

/** Units with a space that needs you first, when the setting is on. The order stays the same in each part. */
function urgentFirst(units) {
  if (!needsYouFirst()) return units;
  const rank = (u) => Math.min(...u.map((r) => URGENT[r.status] ?? 9));
  return units.map((u, i) => ({ u, i, k: rank(u) < 9 ? 0 : 1 })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.u);
}

/** { pinned: rows, groups: [{ machine, rows }], remote: bool } */
export function sections(all) {
  const order = pins();
  const pinnedSet = new Set(order);
  const pinned = all.filter((r) => pinnedSet.has(r.key))
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key) || a.index - b.index)
    .map((r) => ({ ...r, parent: r.git?.linked ? r.git.name : null }));
  const rest = all.filter((r) => !pinnedSet.has(r.key));
  const names = [...new Set([null, ...all.map((r) => r.machine).filter(Boolean), ...machines().map((m) => m.name).filter(Boolean)])];
  const groups = names.map((m) => ({ machine: m, rows: urgentFirst(nest(rest.filter((r) => r.machine === m))).flat() }));
  return { pinned: urgentFirst(pinned.map((r) => [r])).flat(), groups, remote: names.length > 1 };
}

/** The recent spaces of view.json that are not open now: [{ name, folder, key }]. */
export function recentRows(view, all, count) {
  const open = new Set(all.flatMap((r) => [normFolder(r.folder), normFolder(r.git?.top)]));
  const seen = new Set();
  const out = [];
  for (const r of view?.recent ?? []) {
    const f = normFolder(r?.folder);
    if (!f || open.has(f) || seen.has(f)) continue;
    seen.add(f);
    out.push({ name: r.name || "", folder: r.folder, key: keyOf(null, r.folder) });
    if (out.length >= count) break;
  }
  return out;
}
