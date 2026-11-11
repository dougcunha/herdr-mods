// The views of the mod: the panel (Dock panel, pane or dialog) and the status bar item.
// Each view gets the model that main.js builds (see model() there).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { props, shared, closeOverlay } from "herdr";
import { fill } from "./text.js";

const ICON = (name) => `mods/skill-bundles/${name}.svg`;
const MONO = (s) => s?.font_family ?? "JetBrains Mono";

/** A translucent version of a hex color. Theme names pass through. */
const tint = (color, alpha = "24") => (/^#[0-9a-f]{6}$/i.test(color || "") ? color + alpha : color);

const stop = (_e, cx) => cx.stop_propagation();

function stateColor(t, state) {
  switch (state) {
    case "ok": return t.ansi2;
    case "outdated": return t.ansi3;
    case "missing": return t.ansi1;
    case "extra": return t.ansi5;
    default: return t.dim;
  }
}

/** The dialog that shows this mod: its own overlay or the Dock's panel dialog. */
const dialogId = () => props()?.overlay ?? shared("kanban.panelDialog")?.id ?? null;

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
    .child(iconButton(t, "sb-settings", "settings", m.str.openSettings, () => m.a.settings()));
}

/** The line under the header: the Catalog, its commit and its warnings. */
function catalogLine(t, m) {
  if (m.cat.state !== "ready") return null;
  const c = m.cat;
  const notes = [];
  if (c.ref?.branch && !c.ref.problem) notes.push([t.accent, fill(m.str.branchWarn, { branch: c.ref.branch })]);
  if (m.blocked) notes.push([t.ansi1, m.blocked]);
  if (c.fetchError) notes.push([t.ansi3, c.fetchError.split("\n").pop()]);
  if (m.settingSlug && c.catalog.repo && c.catalog.repo.toLowerCase() !== m.settingSlug.toLowerCase()) {
    notes.push([t.ansi3, fill(m.str.repoMismatch, { catalog: c.catalog.repo, setting: m.settingSlug })]);
  }
  if (m.proj.state === "ready" && m.proj.unknown?.length) notes.push([t.ansi3, fill(m.str.unknownBundles, { list: m.proj.unknown.join(", ") })]);
  if (m.proj.state === "ready" && m.proj.probe?.lockError) notes.push([t.ansi1, fill(m.str.lockError, { error: m.proj.probe.lockError })]);
  if (m.proj.state === "ready" && m.proj.probe?.error) notes.push([t.ansi1, fill(m.str.probeError, { error: m.proj.probe.error })]);
  const at = fill(m.str.catalogAt, { repo: c.catalog.repo, commit: c.commit || "?" }) + (c.own ? ` · ${m.str.ownClone}` : "");
  const busy = Boolean(m.job);
  return v_flex().flex_none().px(12).py(6).gap(3).border_b(1).border_color(t.border).text_size(11)
    .child(div().truncate().text_color(t.dim).child(at))
    .children(notes.map(([color, text]) => div().text_color(color).child(text)))
    .when(m.fixes.length > 0, (e) => e.child(h_flex().pt(3).gap(6).flex_wrap()
      .children(m.fixes.map((f) => button(t, `sb-fix-${f.id}`, f.label, f.run, { kind: f.kind, disabled: busy, tip: f.tip })))));
}

/** The counts and the main buttons of the list. */
function summary(t, m) {
  const c = m.proj.counts;
  const busy = Boolean(m.job);
  const work = c.outdated + c.missing;
  return v_flex().flex_none().px(12).py(8).gap(8).border_b(1).border_color(t.border)
    .child(h_flex().gap(6).flex_wrap().items_center()
      .when(c.ok > 0, (e) => e.child(pill(t, `${c.ok} ${m.str.state_ok}`, stateColor(t, "ok"))))
      .when(c.outdated > 0, (e) => e.child(pill(t, `${c.outdated} ${m.str.state_outdated}`, stateColor(t, "outdated"))))
      .when(c.missing > 0, (e) => e.child(pill(t, `${c.missing} ${m.str.state_missing}`, stateColor(t, "missing"))))
      .when(c.extra > 0, (e) => e.child(pill(t, `${c.extra} ${m.str.state_extra}`, stateColor(t, "extra"))))
      .when(c.unchecked > 0, (e) => e.child(pill(t, `${c.unchecked} ${m.str.state_unchecked}`, stateColor(t, "unchecked"))))
      .when(c.local > 0, (e) => e.child(pill(t, `${c.local} ${m.str.state_local}`, stateColor(t, "local")))))
    .child(h_flex().gap(6).items_center()
      .child(button(t, "sb-sync", m.str.syncAll, (cx) => m.a.syncAll(cx), { kind: work > 0 ? "primary" : "plain", disabled: busy || work === 0 || Boolean(m.blocked), tip: m.str.syncAllTip, icon: "refresh" }))
      .child(button(t, "sb-bundles", m.str.bundles, (cx) => m.a.mode("bundles", cx), { disabled: busy, tip: m.str.bundlesTip, icon: "bundles" }))
      .child(button(t, "sb-add", m.str.addSkill, (cx) => m.a.mode("add", cx), { disabled: busy, tip: m.str.addSkillTip, icon: "plus" })))
    .when(work === 0 && c.extra === 0 && c.ok > 0, (e) => e.child(div().text_size(11).text_color(t.dim).child(m.str.allGood)));
}

/** The actions of a row, by state. */
function rowActions(t, m, row) {
  const busy = Boolean(m.job);
  const install = !busy && !m.blocked;
  const id = (k) => `sb-${k}-${row.name}`;
  const onlySource = row.from.length === 1 && row.from[0] === "sources";
  const list = [];
  if (row.state === "missing") list.push(button(t, id("install"), m.str.install, (cx) => m.a.installOne(row, cx), { disabled: !install }));
  if (row.state === "outdated") list.push(button(t, id("update"), m.str.update, (cx) => m.a.installOne(row, cx), { disabled: !install }));
  if (row.state === "extra") {
    list.push(button(t, id("keep"), m.str.keep, (cx) => m.a.keepExtra(row, cx), { disabled: busy || !m.proj.manifest, tip: m.str.keepTip }));
    list.push(button(t, id("remove"), m.str.remove, (cx) => m.a.removeExtra(row, cx), { kind: "danger", disabled: busy, tip: m.str.removeTip }));
  }
  if (row.state === "local") {
    const label = m.waiting === `local:${row.name}` ? m.str.confirmAgain : m.str.remove;
    list.push(button(t, id("delete"), label, (cx) => m.a.removeLocal(row, cx), { kind: "danger", disabled: busy, tip: m.str.removeLocalTip }));
  }
  if (onlySource && row.state !== "extra") list.push(button(t, id("drop"), m.str.dropSource, (cx) => m.a.dropSource(row, cx), { kind: "danger", disabled: busy, tip: m.str.dropSourceTip }));
  return list;
}

function skillRow(t, m, row, s) {
  const color = stateColor(t, row.state);
  return h_flex().id(`sb-row-${row.name}`).min_h(30).px(12).gap(8).items_center().hover((x) => x.bg(t.hover))
    .tooltip(m.str[`tip_${row.state}`])
    .child(div().size(7).flex_none().rounded(4).bg(color))
    .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(MONO(s)).child(row.name))
    .when(row.state !== "ok", (e) => e.child(div().flex_none().text_size(11).text_color(color).child(m.str[`state_${row.state}`])))
    .children(rowActions(t, m, row));
}

/** The key of a group for the folded set: a Bundle and the Sources group can have the same name. */
const groupKey = (g) => `${g.kind}:${g.key}`;

function groupTitle(t, m, g) {
  const catalog = m.cat.catalog;
  const title = g.kind === "bundle" ? g.key : m.str[`group_${g.kind}`];
  const desc = g.kind === "bundle" ? catalog?.descriptions.get(g.key) ?? "" : "";
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

/** The batch buttons of a group title: act on every skill of the group. */
function groupActions(t, m, g) {
  const busy = Boolean(m.job);
  const key = groupKey(g);
  const small = (id, label, onClick, opts) => button(t, `sb-all-${id}-${key}`, label, onClick, opts);
  const list = [];
  const work = g.rows.filter((r) => r.state === "missing" || r.state === "outdated").length;
  if (work > 0 && (g.kind === "bundle" || g.kind === "sources")) {
    list.push(small("update", fill(m.str.updateGroup, { n: work }), (cx) => m.a.updateGroup(key, cx), { disabled: busy || Boolean(m.blocked), tip: m.str.updateGroupTip }));
  }
  if (g.kind === "extra" && g.rows.length > 1) {
    list.push(small("keep", m.str.keepAll, (cx) => m.a.keepAllExtra(cx), { disabled: busy || !m.proj.manifest, tip: m.str.keepAllTip }));
    list.push(small("remove", m.waiting === "all:extra" ? m.str.confirmAgain : m.str.removeAll, (cx) => m.a.removeAllExtra(cx), { kind: "danger", disabled: busy, tip: m.str.removeAllTip }));
  }
  if (g.kind === "local" && g.rows.length > 1) {
    list.push(small("delete", m.waiting === "all:local" ? m.str.confirmAgain : m.str.removeAll, (cx) => m.a.removeAllLocal(cx), { kind: "danger", disabled: busy, tip: m.str.removeAllLocalTip }));
  }
  return list;
}

function listView(t, m, s) {
  const groups = m.proj.groups;
  return v_flex().flex_1().min_h(0)
    .child(summary(t, m))
    .child(v_flex().id("sb-list").flex_1().min_h(0).overflow_y_scrollbar()
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
  return v_flex().flex_1().min_h(0)
    .when(Boolean(intro), (e) => e.child(div().flex_none().px(12).py(10).text_size(12).text_color(t.muted).border_b(1).border_color(t.border).child(intro)))
    .child(v_flex().id("sb-picker").flex_1().min_h(0).overflow_y_scrollbar()
      .children(names.map((n) => bundleChoice(t, m, n, catalog.descriptions.get(n) ?? ""))))
    .child(h_flex().flex_none().px(12).py(10).gap(8).justify_end().border_t(1).border_color(t.border)
      .when(Boolean(onCancel), (e) => e.child(button(t, "sb-cancel", m.str.cancel, onCancel)))
      .child(button(t, "sb-apply", primary, onPrimary, { kind: "primary", disabled: Boolean(m.job) || Boolean(m.blocked) })));
}

/** Add skill: the skills of the Catalog that skills.yaml does not cover, with a search field. */
function addView(t, m, s) {
  const catalog = m.cat.catalog;
  const covered = new Set(m.proj.rows.filter((r) => r.state !== "extra" && r.state !== "local").map((r) => r.name));
  const installed = new Set(m.proj.rows.map((r) => r.name));
  const items = [];
  for (const [bundle, skills] of catalog.bundles) {
    for (const name of skills) {
      if (covered.has(name)) continue;
      if (m.filter && !`${bundle} ${name}`.toLowerCase().includes(m.filter)) continue;
      items.push({ bundle, name, installed: installed.has(name) });
    }
  }
  const busy = Boolean(m.job) || Boolean(m.blocked);
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
          }))))
    .child(h_flex().id("sb-persist").flex_none().px(12).py(6).gap(8).items_center().cursor_pointer().border_b(1).border_color(t.border)
      .tooltip(m.str.persistTip)
      .on_click((_e, cx) => m.a.persist(cx))
      .child(div().w(28).h(16).flex_none().rounded(8).p(2).bg(m.persist ? t.accent : t.raised).border_1().border_color(m.persist ? t.accent : t.border)
        .child(div().size(10).rounded(5).bg(m.persist ? t.accent_foreground : t.muted).when(m.persist, (e) => e.ml(12))))
      .child(div().text_size(12).child(m.str.persist)))
    .child(v_flex().id("sb-add-list").flex_1().min_h(0).overflow_y_scrollbar()
      .when(items.length === 0, (e) => e.child(div().p(16).text_size(12).text_color(t.dim).child(m.str.nothingToAdd)))
      .children(items.map((it) => h_flex().id(`sb-cand-${it.bundle}-${it.name}`).min_h(30).px(12).gap(8).items_center().hover((x) => x.bg(t.hover))
        .child(div().flex_none().w(96).truncate().text_size(11).text_color(t.dim).child(it.bundle))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(MONO(s)).child(it.name))
        .when(it.installed, (e) => e.child(div().flex_none().text_size(11).text_color(stateColor(t, "extra")).child(m.str.state_extra)))
        .child(button(t, `sb-addone-${it.bundle}-${it.name}`, m.str.install, (cx) => m.a.addSkill(it.name, cx), { disabled: busy })))));
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
  if (c.state === "unset") return message(t, m, str.noCatalog, str.noCatalogHint, { buttons: [button(t, "sb-open-settings", str.openSettings, () => m.a.settings(), { kind: "primary", icon: "settings" })] });
  if (c.state === "cloning") return message(t, m, fill(str.cloning, { repo: c.slug }), null, { spin: true });
  if (c.state === "error") return message(t, m, str.cloneFailed, null, { detail: c.error, s, buttons: [button(t, "sb-retry", str.retry, (cx) => m.a.reload(cx), { kind: "primary" }), button(t, "sb-open-settings", str.openSettings, () => m.a.settings())] });
  const p = m.proj;
  if (c.state !== "ready" || p.state === "loading") return message(t, m, str.loading, null, { spin: true });
  if (p.state === "none") return message(t, m, str.noProject, str.noProjectHint);
  if (p.state === "error") return message(t, m, str.failed, null, { detail: p.error, s });
  if (!p.manifest) {
    return bundlePicker(t, m, { intro: `${str.noManifest}. ${str.noManifestHint}`, primary: str.start, onPrimary: (cx) => m.a.start(cx) });
  }
  if (m.mode === "bundles") return bundlePicker(t, m, { primary: str.save, onPrimary: (cx) => m.a.applyBundles(cx), onCancel: (cx) => m.a.mode("list", cx) });
  if (m.mode === "add") return addView(t, m, s);
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
  let text = str.statusLabel;
  let color = t.dim;
  let tip = str.statusTipNone;
  let mark = null;
  if (m.job) {
    tip = m.job.label ?? "";
  } else if (m.cat.state === "unset") {
    mark = "?";
    tip = str.noCatalog;
  } else if (m.cat.state === "error" || (p.state === "ready" && p.probe?.error)) {
    // Without the Catalog or the probe, the counts would be wrong: show the error instead.
    mark = "!";
    color = t.ansi1;
    tip = m.cat.state === "error" ? `${str.cloneFailed}\n${m.cat.error}` : fill(str.probeError, { error: p.probe.error });
  } else if (p.state === "ready" && !p.manifest) {
    mark = "—";
    tip = fill(str.statusTipNoManifest, { project: p.name });
  } else if (p.state === "ready") {
    if (m.pending > 0) {
      mark = String(m.pending);
      color = p.counts.missing > 0 ? t.ansi1 : t.ansi3;
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
