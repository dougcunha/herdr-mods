// The views of the mod: the panel (Dock panel, pane or dialog) and the status bar item.
// Each view gets the model that main.js builds (see model() there).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { props, shared, closeOverlay } from "herdr";
import { fill } from "./text.js";
import { STATES, toLink } from "./status.js";

const ICON = (name) => `mods/skill-bundles/${name}.svg`;
const MONO = (s) => s?.font_family ?? "JetBrains Mono";

/** A translucent version of a hex color. Theme names pass through. */
const tint = (color, alpha = "24") => (/^#[0-9a-f]{6}$/i.test(color || "") ? color + alpha : color);

const stop = (_e, cx) => cx.stop_propagation();

function stateColor(t, state) {
  switch (state) {
    case "linked": return t.ansi2;
    case "copy": case "stale": return t.ansi3;
    case "missing": case "conflict": case "absent": return t.ansi1;
    case "extra": return t.ansi5;
    default: return t.dim;
  }
}

/** The dialog that shows this mod: its own overlay or the Dock's panel dialog. */
const dialogId = () => props()?.overlay ?? shared("kanban.panelDialog")?.id ?? null;
// A dialog of this mod's own (not a panel dialog of the dock, whose title row has its own ×): the header shows an ×.
const ownDialog = () => { const o = props()?.overlay; return o && shared("kanban.panelDialog")?.id !== o ? o : null; };

/** In a dialog, a click gives the panel the keyboard, so Esc closes the dialog (see AGENTS.md). */
function dialogKeys(el, handle) {
  return el.track_focus(handle)
    .on_mouse_down("left", () => { if (dialogId()) handle.focus(); })
    .on_key_down((e, cx) => {
      const id = e.key === "escape" ? dialogId() : null;
      if (id) { closeOverlay(id); cx.stop_propagation(); }
    });
}

/** A text button. `kind`: "primary" (solid), "danger" or plain. */
function button(t, id, label, onClick, { kind = "plain", disabled = false, tip = null, icon = null } = {}) {
  const solid = kind === "primary";
  const fg = disabled ? t.dim : solid ? t.solid_foreground : kind === "danger" ? t.ansi1 : t.foreground;
  return h_flex().id(id).h(24).px(9).gap(5).flex_none().items_center().justify_center().rounded(6).text_size(12)
    .bg(solid && !disabled ? t.solid : t.raised).border_1().border_color(solid && !disabled ? t.solid : t.border)
    .text_color(fg)
    .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(solid ? tint(t.solid, "dd") : t.hover)))
    .when(Boolean(tip), (e) => e.tooltip(tip))
    .on_mouse_down("left", stop)
    .on_click((_e, cx) => { cx.stop_propagation(); if (!disabled) onClick(cx); })
    .when(Boolean(icon), (e) => e.child(svg(ICON(icon)).size(13)))
    .child(label);
}

/** A small icon button for the header. */
function iconButton(t, id, icon, tip, onClick, { spin = false } = {}) {
  return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(7).cursor_pointer()
    .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
    .tooltip(tip)
    .on_mouse_down("left", stop)
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
    .child(spin ? svg(ICON("spinner")).size(14).spin(900) : svg(ICON(icon)).size(14));
}

function pill(t, label, color) {
  return h_flex().h(18).px(7).gap(5).flex_none().items_center().rounded(9).text_size(10.5)
    .bg(tint(color, "22")).text_color(color)
    .child(div().size(6).rounded(3).bg(color))
    .child(label);
}

/** A centered message with an optional detail (monospace) and buttons. */
function message(t, m, title, hint, { detail = null, buttons = [], spin = false, s } = {}) {
  return v_flex().flex_1().min_h(0).items_center().justify_center().gap(10).p(24)
    .child(h_flex().gap(8).items_center()
      .when(spin, (e) => e.child(svg(ICON("spinner")).size(16).spin(900).text_color(t.accent)))
      .child(div().text_size(14).font_semibold().child(title)))
    .when(Boolean(hint), (e) => e.child(div().max_w(420).text_center().text_size(12).text_color(t.muted).child(hint)))
    .when(Boolean(detail), (e) => e.child(div().max_w(480).w_full().p(10).rounded(8).bg(t.raised).border_1().border_color(t.border)
      .text_size(11).font_family(MONO(s)).text_color(t.ansi1).child(detail)))
    .when(buttons.length > 0, (e) => e.child(h_flex().gap(8).children(buttons)));
}

function header(t, m) {
  const reading = m.cat.fetching || m.cat.state === "cloning";
  const project = m.proj.state === "ready" ? m.proj.name : "";
  return h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
    .child(svg(ICON("bundles")).size(16).text_color(t.accent))
    .child(div().flex_none().font_semibold().child(m.str.title))
    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(project))
    .child(iconButton(t, "sb-fetch", "refresh", m.str.fetch, (cx) => m.a.reload(cx), { spin: reading }))
    .child(iconButton(t, "sb-settings", "settings", m.str.openSettings, () => m.a.settings()))
    .when(Boolean(ownDialog()), (e) => e.child(iconButton(t, "sb-close", "close", m.str.close ?? "Close", () => closeOverlay(ownDialog()))));
}

/** The line under the header: the Catalog, its commit and what the person must know about the clone and the project. */
function catalogLine(t, m) {
  if (m.cat.state !== "ready") return null;
  const c = m.cat;
  const p = m.proj.state === "ready" ? m.proj : null;
  const notes = [];
  if (c.ref?.branch) notes.push([t.accent, fill(m.str.branchWarn, { branch: c.ref.branch })]);
  if (m.cloneNote) notes.push([t.ansi3, m.cloneNote]);
  if (c.fetchError) notes.push([t.ansi3, c.fetchError.split("\n").pop()]);
  if (m.settingSlug && c.catalog.repo && c.catalog.repo.toLowerCase() !== m.settingSlug.toLowerCase()) {
    notes.push([t.ansi3, fill(m.str.repoMismatch, { catalog: c.catalog.repo, setting: m.settingSlug })]);
  }
  if (p?.unknown?.length) notes.push([t.ansi3, fill(m.str.unknownBundles, { list: p.unknown.join(", ") })]);
  if (p?.info?.lockError) notes.push([t.ansi1, fill(m.str.lockError, { error: p.info.lockError })]);
  if (p?.info?.lockOther > 0) notes.push([t.dim, fill(m.str.lockOther, { n: p.info.lockOther })]);
  const at = fill(m.str.catalogAt, { repo: c.catalog.repo, commit: c.commit || "?" }) + (c.own ? ` · ${m.str.ownClone}` : "");
  const busy = Boolean(m.job);
  return v_flex().flex_none().px(12).py(6).gap(3).border_b(1).border_color(t.border).text_size(11)
    .child(div().truncate().text_color(t.dim).child(at))
    .children(notes.map(([color, text]) => div().text_color(color).child(text)))
    .when(m.fixes.length > 0, (e) => e.child(h_flex().pt(3).gap(6).flex_wrap()
      .children(m.fixes.map((f) => button(t, `sb-fix-${f.id}`, f.label, f.run, { kind: f.kind, disabled: busy, tip: f.tip })))))
    .when(Boolean(p?.info?.oldGitignore), (e) => e.child(h_flex().pt(3).gap(8).items_center()
      .child(div().flex_1().min_w(0).text_color(t.dim).child(m.str.oldGitignore))
      .child(button(t, "sb-old-gitignore", m.str.oldGitignoreFix, (cx) => m.a.dropGitignore(cx), { disabled: busy, tip: m.str.oldGitignoreTip }))));
}

/** The counts and the main buttons of the list. */
function summary(t, m) {
  const c = m.proj.counts;
  const busy = Boolean(m.job);
  const can = m.linkable && !busy;
  return v_flex().flex_none().px(12).py(8).gap(8).border_b(1).border_color(t.border)
    .child(h_flex().gap(6).flex_wrap().items_center()
      .children(STATES.filter((st) => c[st] > 0).map((st) => pill(t, `${c[st]} ${m.str[`state_${st}`]}`, stateColor(t, st)))))
    .child(h_flex().gap(6).items_center().flex_wrap()
      .child(button(t, "sb-sync", m.str.syncAll, (cx) => m.a.syncAll(cx), { kind: m.work > 0 ? "primary" : "plain", disabled: !can || m.work === 0, tip: m.str.syncAllTip, icon: "refresh" }))
      .when(!m.plain, (e) => e.child(button(t, "sb-bundles", m.str.bundles, (cx) => (m.hasCatalog ? m.a.mode("bundles", cx) : m.a.settings()), { disabled: busy, tip: m.str.bundlesTip, icon: "bundles" })))
      .when(m.plain, (e) => e.child(button(t, "sb-use-bundles", m.str.useBundles, (cx) => (m.hasCatalog ? m.a.mode("bundles", cx) : m.a.settings()), { disabled: busy, tip: m.hasCatalog ? m.str.useBundlesTip : m.str.useBundlesNoCatalog, icon: "bundles" })))
      // Without a Catalog, Add skill goes to the repository view.
      .child(button(t, "sb-add", m.str.addSkill, (cx) => m.a.mode(m.hasCatalog ? "add" : "repo", cx), { disabled: !can, tip: m.hasCatalog ? m.str.addSkillTip : m.str.addRepoTip, icon: "plus" }))
      .when(m.hasCatalog, (e) => e.child(button(t, "sb-catalog", m.str.catalog, (cx) => m.a.mode("catalog", cx), { disabled: busy, tip: m.str.catalogTip, icon: "settings" }))))
    .when(m.plain, (e) => e.child(div().text_size(11).text_color(t.dim).child(m.str.plainHint)))
    .when(m.work === 0 && c.linked > 0 && c.conflict === 0 && c.absent === 0, (e) => e.child(div().text_size(11).text_color(t.dim).child(m.str.allGood)));
}

/** The actions of a row, by state. */
function rowActions(t, m, row) {
  const busy = Boolean(m.job);
  const can = m.linkable && !busy;
  const id = (k) => `sb-${k}-${row.name}`;
  const onlySource = row.from.length === 1 && row.from[0] === "sources";
  const list = [];
  if (row.state === "missing") list.push(button(t, id("link"), m.str.link, (cx) => m.a.linkOne(row, cx), { disabled: !can }));
  if (row.state === "copy") list.push(button(t, id("convert"), m.str.convert, (cx) => m.a.linkOne(row, cx), { disabled: !can, tip: m.str.tip_copy }));
  if (row.state === "conflict") {
    const label = m.waiting === `replace:${row.name}` ? m.str.confirmAgain : m.str.replace;
    list.push(button(t, id("replace"), label, (cx) => m.a.replace(row, cx), { kind: "danger", disabled: !can, tip: m.str.replaceTip }));
  }
  if (row.state === "extra") list.push(button(t, id("keep"), m.str.keep, (cx) => m.a.keepExtra(row, cx), { disabled: !can || m.plain, tip: m.str.keepTip }));
  if (row.state === "extra" || row.state === "stale") list.push(button(t, id("remove"), m.str.remove, (cx) => m.a.removeLinks(row, cx), { kind: "danger", disabled: !can, tip: m.str.removeTip }));
  if (row.state === "local") {
    const label = m.waiting === `local:${row.name}` ? m.str.confirmAgain : m.str.remove;
    list.push(button(t, id("delete"), label, (cx) => m.a.removeLocal(row, cx), { kind: "danger", disabled: !can, tip: m.str.removeLocalTip }));
  }
  if (onlySource && !m.plain) list.push(button(t, id("drop"), m.str.dropSource, (cx) => m.a.dropSource(row, cx), { kind: "danger", disabled: busy, tip: m.str.dropSourceTip }));
  return list;
}

function skillRow(t, m, row, s) {
  const color = stateColor(t, row.state);
  return h_flex().id(`sb-row-${row.name}`).min_h(30).px(12).gap(8).items_center().hover((x) => x.bg(t.hover))
    .tooltip(m.str[`tip_${row.state}`])
    .child(div().size(7).flex_none().rounded(4).bg(color))
    .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(MONO(s)).child(row.name))
    .when(row.state !== "linked", (e) => e.child(div().flex_none().text_size(11).text_color(color).child(m.str[`state_${row.state}`])))
    .children(rowActions(t, m, row));
}

/** The key of a group for the folded set: a Bundle and the Sources group can have the same name. */
const groupKey = (g) => `${g.kind}:${g.key}`;

function groupTitle(t, m, g) {
  const catalog = m.cat.catalog;
  const title = g.kind === "bundle" || g.kind === "repo" ? g.key : m.str[`group_${g.kind}`];
  const desc = g.kind === "bundle" ? catalog?.descriptions.get(g.key) ?? "" : g.kind === "repo" ? sourceNote(m, g.key) : "";
  const folded = m.collapsed.has(groupKey(g));
  return h_flex().id(`sb-group-${groupKey(g)}`).h(28).pl(8).pr(12).gap(6).items_center().bg(t.surface).border_b(1).border_color(t.border)
    .cursor_pointer().hover((x) => x.bg(t.hover))
    .tooltip(folded ? m.str.expand : m.str.collapse)
    .on_click((_e, cx) => m.a.toggleGroup(groupKey(g), cx))
    .child(svg(ICON(folded ? "chevron-right" : "chevron-down")).size(13).flex_none().text_color(t.dim))
    .child(div().flex_none().text_size(11.5).font_semibold().text_color(t.muted).child(title))
    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(desc))
    .children(groupActions(t, m, g))
    .child(div().flex_none().text_size(11).text_color(t.dim).child(String(g.rows.length)));
}

/** What the title of a repository group says about the clone of that repository. */
function sourceNote(m, repo) {
  const id = m.srcId(repo);
  const src = m.sources[id];
  if (m.srcErrors[id]) return fill(m.str.sourceCloneFailed, { error: String(m.srcErrors[id]).split("\n").pop() });
  if (m.sourcing.has(id)) return src ? m.str.sourceFetching : m.str.sourceCloning;
  if (!src) return "";
  if (src.error) return fill(m.str.sourceFetchFailed, { error: String(src.error).split("\n").pop() });
  return src.behind > 0 ? fill(m.str.sourceBehind, { n: src.behind }) : m.str.sourceCurrent;
}

/** The batch buttons of a group title: act on every skill of the group. */
function groupActions(t, m, g) {
  const can = m.linkable && !m.job;
  const key = groupKey(g);
  const small = (id, label, onClick, opts) => button(t, `sb-all-${id}-${key}`, label, onClick, opts);
  const list = [];
  const work = toLink(g.rows).length;
  if (work > 0) list.push(small("link", fill(m.str.linkGroup, { n: work }), (cx) => m.a.linkGroup(key, cx), { disabled: !can, tip: m.str.linkGroupTip }));
  if (g.kind === "repo") {
    const src = m.sources[m.srcId(g.key)];
    if (src?.behind > 0) list.push(small("source", m.str.sourceUpdate, (cx) => m.a.updateSource(g.key, cx), { kind: "primary", disabled: Boolean(m.job), tip: m.str.sourceUpdateTip }));
  }
  if (g.kind === "extra" && g.rows.length > 1) {
    list.push(small("keep", m.str.keepAll, (cx) => m.a.keepAllExtra(cx), { disabled: !can || m.plain, tip: m.str.keepAllTip }));
    list.push(small("remove", m.waiting === "all:extra" ? m.str.confirmAgain : m.str.removeAll, (cx) => m.a.removeAllLinks("extra", cx), { kind: "danger", disabled: !can, tip: m.str.removeAllTip }));
  }
  if (g.kind === "stale" && g.rows.length > 1) {
    list.push(small("remove", m.str.removeAll, (cx) => m.a.removeAllLinks("stale", cx), { kind: "danger", disabled: !can, tip: m.str.removeAllTip }));
  }
  if (g.kind === "local" && g.rows.length > 1) {
    list.push(small("delete", m.waiting === "all:local" ? m.str.confirmAgain : m.str.removeAll, (cx) => m.a.removeAllLocal(cx), { kind: "danger", disabled: !can, tip: m.str.removeAllLocalTip }));
  }
  return list;
}

function listView(t, m, s) {
  const groups = m.proj.groups;
  return v_flex().flex_1().min_h(0)
    .child(summary(t, m))
    .child(v_flex().id("sb-list").flex_1().min_h(0).overflow_y_scrollbar()
      .when(groups.length === 0, (e) => e.child(v_flex().p(16).gap(6)
        .child(div().text_size(13).font_semibold().child(m.str.plainEmpty))
        .child(div().text_size(12).text_color(t.muted).child(m.str.plainEmptyHint))))
      .children(groups.flatMap((g) => [groupTitle(t, m, g), ...(m.collapsed.has(groupKey(g)) ? [] : g.rows.map((r) => skillRow(t, m, r, s)))])));
}

/** One line of the Bundle picker: a check box, the name and the description. */
function bundleChoice(t, m, name, desc) {
  const core = name === "core";
  const on = core || m.pick.has(name);
  return h_flex().id(`sb-pick-${name}`).min_h(34).px(12).py(4).gap(10).items_center()
    .when(!core, (e) => e.cursor_pointer().hover((x) => x.bg(t.hover)).on_click((_e, cx) => m.a.toggle(name, cx)))
    .child(div().size(16).flex_none().flex().items_center().justify_center().rounded(4).border_1()
      .border_color(on ? t.accent : t.input).bg(on ? (core ? tint(t.accent, "66") : t.accent) : t.background)
      .text_size(11).text_color(t.accent_foreground).child(on ? "✓" : ""))
    .child(v_flex().flex_1().min_w(0)
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(12.5).font_semibold().child(name))
        .when(core, (e) => e.child(div().text_size(11).text_color(t.dim).child(m.str.always))))
      .when(Boolean(desc), (e) => e.child(div().text_size(11).text_color(t.muted).child(desc))))
    .child(div().flex_none().text_size(11).text_color(t.dim).child(String(m.cat.catalog.bundles.get(name)?.length ?? 0)));
}

function bundlePicker(t, m, { intro, primary, onPrimary, onCancel }) {
  const catalog = m.cat.catalog;
  const names = [...catalog.bundles.keys()];
  if (!names.includes("core")) names.unshift("core");
  // A project without skills.yaml on a machine with more than one Catalog: the Catalog of the Bundles.
  const others = m.catalogs.length > 1;
  const current = String(m.cat.slug ?? "").toLowerCase();
  return v_flex().flex_1().min_h(0)
    .when(Boolean(intro), (e) => e.child(div().flex_none().px(12).py(10).text_size(12).text_color(t.muted).border_b(1).border_color(t.border).child(intro)))
    .when(others, (e) => e.child(v_flex().flex_none().px(12).py(8).gap(6).border_b(1).border_color(t.border)
      .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(m.str.catalogPick))
      .child(h_flex().gap(6).flex_wrap().children(m.catalogs.map((slug, i) => {
        const on = slug.toLowerCase() === current;
        return div().id(`sb-catalog-${i}`).h(24).px(10).flex().items_center().rounded(6).text_size(12).border_1()
          .border_color(on ? t.accent : t.border).bg(on ? tint(t.accent, "22") : t.background).text_color(on ? t.accent : t.foreground)
          .when(!on && !m.job, (x) => x.cursor_pointer().hover((h) => h.bg(t.hover)).on_click((_e, cx) => m.a.chooseCatalog(slug, cx)))
          .child(slug);
      })))
      .child(div().text_size(11).text_color(t.dim).child(m.str.catalogPickHint))))
    .child(v_flex().id("sb-picker").flex_1().min_h(0).overflow_y_scrollbar()
      .children(names.map((n) => bundleChoice(t, m, n, catalog.descriptions.get(n) ?? ""))))
    .child(h_flex().flex_none().px(12).py(10).gap(8).justify_end().border_t(1).border_color(t.border)
      .when(Boolean(onCancel), (e) => e.child(button(t, "sb-cancel", m.str.cancel, onCancel)))
      .child(button(t, "sb-apply", primary, onPrimary, { kind: "primary", disabled: Boolean(m.job) })));
}

/** Add skill: the skills of the Clone that the project does not have, with a search field. */
function addView(t, m, s) {
  const catalog = m.cat.catalog;
  const have = new Set(m.proj.rows.map((r) => r.name));
  const items = [];
  const seen = new Set();
  const offer = (bundle, name) => {
    if (seen.has(name)) return;
    seen.add(name);
    if (have.has(name) || !catalog.skills.includes(name)) return;
    if (m.filter && !`${bundle} ${name}`.toLowerCase().includes(m.filter)) return;
    items.push({ bundle, name });
  };
  for (const [bundle, skills] of catalog.bundles) for (const name of skills) offer(bundle, name);
  // The skills of the Clone that no Bundle lists.
  for (const name of [...catalog.skills].sort()) offer(m.str.noBundle, name);
  const busy = Boolean(m.job);
  return v_flex().flex_1().min_h(0)
    .child(h_flex().flex_none().px(12).py(8).gap(8).items_center().border_b(1).border_color(t.border)
      .child(button(t, "sb-back", m.str.back, (cx) => m.a.mode("list", cx), { icon: "back" }))
      .child(h_flex().flex_1().h(28).px(8).gap(6).items_center().rounded(6).bg(t.background).border_1().border_color(t.input)
        .child(svg(ICON("search")).size(13).text_color(t.dim))
        .child(Input.new(m.query).flex_1().h_full().text_size(12)
          .on_key_down((e, cx) => {
            if (e.key !== "escape") return;
            if (m.query.value()) { m.query.set_value(""); cx.stop_propagation(); cx.notify(); }
            else { const id = dialogId(); if (id) { closeOverlay(id); cx.stop_propagation(); } }
          })))
      .child(button(t, "sb-other-repo", m.str.addRepo, (cx) => m.a.mode("repo", cx), { tip: m.str.addRepoTip })))
    .when(!m.plain, (e) => e.child(persistToggle(t, m)))
    .child(v_flex().id("sb-add-list").flex_1().min_h(0).overflow_y_scrollbar()
      .when(items.length === 0, (e) => e.child(div().p(16).text_size(12).text_color(t.dim).child(m.str.nothingToAdd)))
      .children(items.map((it) => h_flex().id(`sb-cand-${it.bundle}-${it.name}`).min_h(30).px(12).gap(8).items_center().hover((x) => x.bg(t.hover))
        .child(div().flex_none().w(96).truncate().text_size(11).text_color(t.dim).child(it.bundle))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(MONO(s)).child(it.name))
        .child(button(t, `sb-addone-${it.bundle}-${it.name}`, m.str.link, (cx) => m.a.addSkill(it.name, cx), { disabled: busy })))));
}

/** A text field in a box. Esc clears the text, then closes the dialog. Enter runs `onEnter`. */
function field(t, state, icon, onEnter = null) {
  return h_flex().flex_1().min_w(0).h(28).px(8).gap(6).items_center().rounded(6).bg(t.background).border_1().border_color(t.input)
    .child(svg(ICON(icon)).size(13).flex_none().text_color(t.dim))
    .child(Input.new(state).flex_1().h_full().text_size(12)
      .on_key_down((e, cx) => {
        if (e.key === "enter" && onEnter) { onEnter(cx); cx.stop_propagation(); return; }
        if (e.key !== "escape") return;
        if (state.value()) { state.set_value(""); cx.stop_propagation(); cx.notify(); }
        else { const id = dialogId(); if (id) { closeOverlay(id); cx.stop_propagation(); } }
      }));
}

/** Add skill from any repository: a repository field, then the skills of the clone of that repository. */
function repoView(t, m, s) {
  const str = m.str;
  const list = m.repoList;
  const busy = Boolean(m.job);
  const have = new Set(m.proj.rows.map((r) => r.name));
  const items = (list?.skills ?? []).filter((it) => !m.filter || `${it.name} ${it.desc}`.toLowerCase().includes(m.filter));
  return v_flex().flex_1().min_h(0)
    .child(h_flex().flex_none().px(12).py(8).gap(8).items_center().border_b(1).border_color(t.border)
      .child(button(t, "sb-back", str.back, (cx) => m.a.mode(m.hasCatalog ? "add" : "list", cx), { icon: "back" }))
      .child(field(t, m.repoInput, "bundles", (cx) => m.a.listRepo(cx)))
      .child(button(t, "sb-list-repo", str.listSkills, (cx) => m.a.listRepo(cx), { kind: "primary", disabled: list?.state === "loading", tip: str.listSkillsTip })))
    .when(!m.plain, (e) => e.child(persistToggle(t, m)))
    .when(list?.state === "ready" && list.skills.length > 0, (e) => e.child(h_flex().flex_none().px(12).py(6).border_b(1).border_color(t.border).child(field(t, m.query, "search"))))
    .child(v_flex().id("sb-repo-list").flex_1().min_h(0).overflow_y_scrollbar()
      .when(!list, (e) => e.child(div().p(16).text_size(12).text_color(t.muted).child(str.repoHint)))
      .when(list?.state === "loading", (e) => e.child(h_flex().p(16).gap(8).items_center()
        .child(svg(ICON("spinner")).size(14).spin(900).text_color(t.accent))
        .child(div().text_size(12).child(fill(str.repoReading, { repo: list.repo })))))
      .when(list?.state === "error", (e) => e.child(v_flex().p(16).gap(8)
        .child(div().text_size(12).font_semibold().text_color(t.ansi1).child(fill(str.repoError, { repo: list.repo })))
        .child(div().p(10).rounded(8).bg(t.raised).border_1().border_color(t.border).text_size(11).font_family(MONO(s)).text_color(t.muted).child(list.error ?? ""))))
      .when(list?.state === "ready" && items.length === 0, (e) => e.child(div().p(16).text_size(12).text_color(t.dim).child(fill(str.repoEmpty, { repo: list.repo }))))
      .children(list?.state === "ready" ? items.map((it) => h_flex().id(`sb-repo-${it.name}`).min_h(40).px(12).py(4).gap(8).items_center().hover((x) => x.bg(t.hover))
        .when(Boolean(it.desc), (e) => e.tooltip(it.desc))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12).font_family(MONO(s)).child(it.name))
          .when(Boolean(it.desc), (e) => e.child(div().truncate().text_size(11).text_color(t.muted).child(it.desc))))
        .when(have.has(it.name), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(str.inProject)))
        .child(button(t, `sb-repo-add-${it.name}`, str.link, (cx) => m.a.addFromRepo(it.name, cx), { disabled: busy || have.has(it.name) }))) : []));
}

/** A small check box. */
function checkBox(t, on) {
  return div().size(16).flex_none().flex().items_center().justify_center().rounded(4).border_1()
    .border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background)
    .text_size(11).text_color(t.accent_foreground).child(on ? "✓" : "");
}

/**
 * The curation of the Catalog: every skill of the Clone with its Bundles, and the Bundles.
 * With a skill open (m.cur.skill): the Bundles of that skill with check boxes, and a new Bundle.
 */
function catalogView(t, m, s) {
  const str = m.str;
  const d = m.cur.details;
  const busy = Boolean(m.job);
  const can = !busy && m.cat.own;
  const catalog = m.cat.catalog;
  const notice = !m.cat.own ? div().flex_none().px(12).py(6).text_size(11).text_color(t.ansi3).border_b(1).border_color(t.border).child(str.curateOwnOnly) : null;
  if (!d) return message(t, m, str.loading, null, { spin: true });
  const open = d.skills.find((x) => x.name === m.cur.skill);
  if (open) {
    const names = [...catalog.bundles.keys()];
    return v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().px(12).py(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(button(t, "sb-cur-back", str.back, (cx) => m.a.curateSkill(null, cx), { icon: "back" }))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12.5).font_semibold().font_family(MONO(s)).child(open.name))
          .when(Boolean(open.desc), (e) => e.child(div().truncate().text_size(11).text_color(t.muted).child(open.desc)))))
      .when(Boolean(notice), (e) => e.child(notice))
      .child(v_flex().id("sb-cur-bundles").flex_1().min_h(0).overflow_y_scrollbar()
        .children(names.map((n) => h_flex().id(`sb-cur-pick-${n}`).min_h(34).px(12).py(4).gap(10).items_center().cursor_pointer().hover((x) => x.bg(t.hover))
          .on_click((_e, cx) => m.a.curatePick(n, cx))
          .child(checkBox(t, m.cur.pick.has(n)))
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_size(12.5).font_semibold().child(n))
            .when(Boolean(catalog.descriptions.get(n)), (e) => e.child(div().truncate().text_size(11).text_color(t.muted).child(catalog.descriptions.get(n)))))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(String(catalog.bundles.get(n)?.length ?? 0))))))
      .child(v_flex().flex_none().px(12).py(8).gap(6).border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.dim).child(str.newBundle))
        .child(h_flex().gap(6).items_center()
          .child(h_flex().w(150).flex_none().child(field(t, m.bundleName, "plus", (cx) => m.a.createBundle(cx))))
          .child(field(t, m.bundleDesc, "bundles", (cx) => m.a.createBundle(cx)))
          .child(button(t, "sb-cur-create", str.create, (cx) => m.a.createBundle(cx), { disabled: !can, tip: str.createTip }))))
      .child(h_flex().flex_none().px(12).py(10).gap(8).justify_end().border_t(1).border_color(t.border)
        .child(button(t, "sb-cur-cancel", str.cancel, (cx) => m.a.curateSkill(null, cx)))
        .child(button(t, "sb-cur-save", str.saveBundles, (cx) => m.a.curateSave(cx), { kind: "primary", disabled: !can })));
  }
  const rows = d.skills.filter((x) => (!m.cur.orphans || !x.bundles.length) && (!m.filter || `${x.name} ${x.bundles.join(" ")} ${x.desc}`.toLowerCase().includes(m.filter)));
  return v_flex().flex_1().min_h(0)
    .child(h_flex().flex_none().px(12).py(8).gap(8).items_center().border_b(1).border_color(t.border)
      .child(button(t, "sb-back", str.back, (cx) => m.a.mode("list", cx), { icon: "back" }))
      .child(field(t, m.query, "search"))
      .child(h_flex().id("sb-cur-orphans").flex_none().h(24).px(8).gap(6).items_center().rounded(6).cursor_pointer().border_1()
        .border_color(m.cur.orphans ? t.accent : t.border).bg(m.cur.orphans ? tint(t.accent, "22") : t.raised).text_size(12)
        .tooltip(str.orphansTip)
        .on_click((_e, cx) => m.a.curateOrphans(cx))
        .child(fill(str.orphans, { n: d.orphans.length }))))
    .when(Boolean(notice), (e) => e.child(notice))
    .when(Boolean(d.error), (e) => e.child(div().px(12).py(6).text_size(11).text_color(t.ansi1).child(d.error ?? "")))
    .child(v_flex().id("sb-cur-list").flex_1().min_h(0).overflow_y_scrollbar()
      .when(rows.length === 0, (e) => e.child(div().p(16).text_size(12).text_color(t.dim).child(m.cur.orphans ? str.noOrphans : str.repoEmptyCatalog)))
      .children(rows.map((x) => h_flex().id(`sb-cur-${x.name}`).min_h(34).px(12).py(3).gap(8).items_center().hover((h) => h.bg(t.hover))
        .when(Boolean(x.desc), (e) => e.tooltip(x.desc))
        .child(div().size(7).flex_none().rounded(4).bg(x.bundles.length ? t.ansi2 : t.ansi3))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12).font_family(MONO(s)).child(x.name))
          .child(div().truncate().text_size(11).text_color(x.bundles.length ? t.dim : t.ansi3).child(x.bundles.length ? x.bundles.join(" · ") : str.noBundle)))
        .child(button(t, `sb-cur-edit-${x.name}`, str.bundles, (cx) => m.a.curateSkill(x.name, cx), { disabled: busy, tip: str.skillBundlesTip }))
        .child(button(t, `sb-cur-del-${x.name}`, m.waiting === `skill:${x.name}` ? str.confirmAgain : str.deleteSkill, (cx) => m.a.curateDelete("skill", x.name, cx), { kind: "danger", disabled: !can, tip: str.deleteSkillTip }))))
      .when(!m.cur.orphans && !m.filter, (e) => e
        .child(h_flex().h(28).px(12).gap(6).items_center().bg(t.surface).border_b(1).border_color(t.border)
          .child(div().flex_1().text_size(11.5).font_semibold().text_color(t.muted).child(str.bundles))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(String(catalog.bundles.size))))
        .children([...catalog.bundles.keys()].map((n) => h_flex().id(`sb-cur-bundle-${n}`).min_h(34).px(12).py(3).gap(8).items_center().hover((h) => h.bg(t.hover))
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_size(12).font_semibold().child(n))
            .child(div().truncate().text_size(11).text_color(t.muted).child(catalog.descriptions.get(n) ?? "")))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(String(catalog.bundles.get(n)?.length ?? 0)))
          .when(n !== "core", (h) => h.child(button(t, `sb-cur-delb-${n}`, m.waiting === `bundle:${n}` ? str.confirmAgain : str.deleteBundle, (cx) => m.a.curateDelete("bundle", n, cx), { kind: "danger", disabled: !can, tip: str.deleteBundleTip })))))));
}

/** The "Keep in skills.yaml" switch of the add views. */
function persistToggle(t, m) {
  return h_flex().id("sb-persist").flex_none().px(12).py(6).gap(8).items_center().cursor_pointer().border_b(1).border_color(t.border)
    .tooltip(m.str.persistTip)
    .on_click((_e, cx) => m.a.persist(cx))
    .child(div().w(28).h(16).flex_none().rounded(8).p(2).bg(m.persist ? t.accent : t.raised).border_1().border_color(m.persist ? t.accent : t.border)
      .child(div().size(10).rounded(5).bg(m.persist ? t.accent_foreground : t.muted).when(m.persist, (e) => e.ml(12))))
    .child(div().text_size(12).child(m.str.persist));
}

/** The bottom line: the running action, or the error of the last one. */
function footer(t, m, s) {
  if (m.job) {
    return h_flex().flex_none().px(12).py(8).gap(8).items_center().border_t(1).border_color(t.border).bg(t.surface)
      .child(svg(ICON("spinner")).size(14).spin(900).text_color(t.accent))
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(m.job.label ?? ""));
  }
  if (m.error) {
    return v_flex().flex_none().px(12).py(8).gap(6).border_t(1).border_color(t.border).bg(tint(t.ansi1, "14"))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(12).font_semibold().text_color(t.ansi1).child(m.str.failed))
        .child(button(t, "sb-dismiss", m.str.dismiss, (cx) => m.a.dismiss(cx))))
      .child(div().text_size(11).font_family(MONO(s)).text_color(t.foreground).child(m.error.text));
  }
  return null;
}

function body(t, m, s) {
  const str = m.str;
  const c = m.cat;
  const p = m.proj;
  const settingsButton = (kind) => button(t, "sb-open-settings", str.openSettings, () => m.a.settings(), { kind, icon: "settings" });
  if (c.state === "cloning") return message(t, m, fill(str.cloning, { repo: c.slug }), null, { spin: true });
  if (c.state === "error") {
    // The Catalog was chosen in the Bundle picker for a project without skills.yaml: a way back to the default one.
    const back = m.plain && m.defaultSlug && String(c.slug ?? "").toLowerCase() !== m.defaultSlug.toLowerCase()
      ? [button(t, "sb-default-catalog", fill(str.useDefaultCatalog, { catalog: m.defaultSlug }), (cx) => m.a.chooseCatalog(m.defaultSlug, cx))] : [];
    return message(t, m, c.missing ? fill(str.noBundlesFile, { repo: c.slug }) : str.cloneFailed, null, { detail: c.error, s, buttons: [button(t, "sb-retry", str.retry, (cx) => m.a.reload(cx), { kind: "primary" }), ...back, settingsButton("plain")] });
  }
  if ((c.state !== "ready" && c.state !== "unset") || p.state === "loading") return message(t, m, str.loading, null, { spin: true });
  if (p.state === "none") return message(t, m, str.noProject, str.noProjectHint);
  if (p.state === "error") return message(t, m, str.failed, null, { detail: p.error, s });
  // A Manifest with only Bundles needs the Catalog. A project with skills or Sources still shows them.
  if (m.mode === "repo") return repoView(t, m, s);
  if (c.state === "unset" && p.manifest && p.rows.length === 0) return message(t, m, str.noCatalog, str.noCatalogHint, { buttons: [settingsButton("primary")] });
  if (m.mode === "bundles" && m.hasCatalog) {
    return m.plain
      ? bundlePicker(t, m, { intro: `${str.noManifest}. ${str.noManifestHint}.`, primary: str.start, onPrimary: (cx) => m.a.applyBundles(cx), onCancel: (cx) => m.a.mode("list", cx) })
      : bundlePicker(t, m, { primary: str.save, onPrimary: (cx) => m.a.applyBundles(cx), onCancel: (cx) => m.a.mode("list", cx) });
  }
  if (m.mode === "add" && m.hasCatalog) return addView(t, m, s);
  if (m.mode === "catalog" && m.hasCatalog) return catalogView(t, m, s);
  return listView(t, m, s);
}

export function panelView(t, m, keys, s) {
  const line = catalogLine(t, m);
  const foot = footer(t, m, s);
  return dialogKeys(v_flex().id("skill-bundles").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13), keys)
    .child(header(t, m))
    .when(Boolean(line), (e) => e.child(line))
    .child(body(t, m, s))
    .when(Boolean(foot), (e) => e.child(foot));
}

/** The status bar item: "skills ✓", "skills 3" (skills that ask for action), or a spinner. */
export function statusView(t, m) {
  const p = m.proj;
  const str = m.str;
  const text = str.statusLabel;
  let color = t.dim;
  let tip = str.statusTipNone;
  let mark = null;
  if (m.job) {
    tip = m.job.label ?? "";
  } else if (m.cat.state === "error" || p.state === "error") {
    // Without the Catalog or the read, the counts would be wrong: show the error instead.
    mark = "!";
    color = t.ansi1;
    tip = m.cat.state === "error" ? `${str.cloneFailed}\n${m.cat.error}` : `${str.failed}\n${p.error}`;
  } else if (m.cat.state === "unset" && p.state === "ready" && p.manifest) {
    mark = "?";
    tip = str.noCatalog;
  } else if (p.state === "ready" && p.rows.length === 0) {
    mark = "—";
    tip = fill(str.statusTipNoSkills, { project: p.name });
  } else if (p.state === "ready") {
    if (m.pending > 0) {
      mark = String(m.pending);
      color = p.counts.missing + p.counts.conflict > 0 ? t.ansi1 : t.ansi3;
      tip = `${fill(str.statusTipPending, { n: m.pending, project: p.name })}\n${fill(str.counts, p.counts)}`;
    } else {
      mark = "✓";
      tip = fill(str.statusTipOk, { project: p.name });
    }
  }
  return h_flex().id("skill-bundles-status").size_full().pr(10).items_center().justify_end()
    .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8)
    .child(h_flex().id("sb-status-open").h(20).px(6).gap(6).items_center().rounded(5).cursor_pointer()
      .text_color(t.dim).hover((x) => x.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .on_click(() => m.a.open())
      .child(m.job ? svg(ICON("spinner")).size(12).spin(900).text_color(t.accent) : svg(ICON("bundles")).size(12))
      .child(text)
      .when(Boolean(mark), (e) => e.child(div().text_color(color).font_semibold().child(mark))));
}
