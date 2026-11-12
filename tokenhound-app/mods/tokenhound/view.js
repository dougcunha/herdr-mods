// The views of the mod: the panel (Dock panel and dialog), the status bar item and the
// sidebar section. Each view gets the model that main.js builds:
//   { state, doc, providers, now, str, metric, icon(providerId) }

import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, shared, closeOverlay } from "herdr";
import { hasFraction, levelColor, percent, statusColor } from "./feed.js";
import { countdown, duration, fill } from "./text.js";

const ICON = "mods/tokenhound/gauge.svg";
const BUSY = "#10b981";
const SVG = (name) => `mods/tokenhound/${name}.svg`;
// A dialog of this mod's own (not a panel dialog of the dock, whose title row has its own ×): the header shows an ×.
const ownDialog = () => { const o = props()?.overlay; return o && shared("kanban.panelDialog")?.id !== o ? o : null; };

/** A small icon button. It stops the mouse, so a click does not reach the row or the section. */
function iconButton(t, id, icon, tip, onClick, size = 20) {
  return div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(5)
    .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
    .tooltip(tip)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
    .child(svg(SVG(icon)).size(Math.round(size * 0.65)));
}

/** The hidden providers as chips; a click on a chip shows the provider again. */
function hiddenChips(t, m) {
  return h_flex().w_full().flex_wrap().gap(6).items_center().text_size(11).text_color(t.dim)
    .child(div().child(m.str.hiddenLabel))
    .children(m.hidden.map((h) => h_flex().id(`th-unhide-${h.id}`).h(22).px(7).gap(5).items_center().rounded(6)
      .bg(t.raised).border_1().border_color(t.border).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(m.str.showProvider)
      .on_click((_e, cx) => { cx.stop_propagation(); m.ui.unhide(h.id); })
      .child(svg(SVG("eye")).size(12))
      .child(h.name)));
}

/** A translucent version of a hex color. Theme names pass through. */
const tint = (color, alpha = "26") => (/^#[0-9a-f]{6}$/i.test(color || "") ? color + alpha : color);

/** The states in which the mod still shows the last values, with a warning. */
const SHOWS_DATA = new Set(["live", "stale", "stopped"]);

function stateColor(t, state) {
  if (state === "live") return BUSY;
  if (state === "stale" || state === "stopped") return t.ansi3;
  if (state === "loading") return t.dim;
  return t.ansi1;
}

function stateHint(m) {
  const s = m.str;
  switch (m.state) {
    case "stale": return fill(s.staleHint, { age: duration(m.now - Date.parse(m.doc.writtenAtUtc)) });
    case "stopped": return s.stoppedHint;
    case "missing": return s.missingHint;
    case "error": return fill(s.errorHint, { error: m.error ?? "" });
    case "newer": return fill(s.newerHint, { version: m.doc?.schemaVersion, known: 1 });
    case "unsupported": return s.unsupportedHint;
    default: return "";
  }
}

/** The ring color of a provider: the status color when it is not ok, else the session level. */
const ringColor = (t, p) => statusColor(t, p.status) ?? levelColor(t, p.sessionUsedFraction);

/**
 * The mark of a provider: the agent icon that Herdr shows (see icons.js), on its colored tile
 * when the program has one. A provider without an icon (Cline, GLM, Perplexity) gets its text badge
 * in a circle of the ring color.
 */
function badge(t, m, p, size) {
  const icon = m.icon(p.providerId);
  if (!icon) return letterBadge(t, p, size);
  const glyphSize = icon.tile ? Math.round(size * 0.68) : size;
  const glyph = icon.tint
    ? svg(icon.icon).size(glyphSize).flex_none().text_color(icon.tile ? (icon.color ?? "#ffffff") : t.foreground)
    : image(icon.icon).size(glyphSize).flex_none();
  return div().size(size).flex_none().flex().items_center().justify_center()
    .when(Boolean(icon.tile), (e) => e.rounded(Math.round(size * 0.25)).bg(icon.tile))
    .child(glyph);
}

function letterBadge(t, p, size) {
  const color = ringColor(t, p);
  const text = String(p.badge ?? "?");
  // 2 letters ("OC", "Cp") need a smaller font to stay inside the circle.
  const font = Math.max(7, Math.round(size * (text.length > 1 ? 0.36 : 0.46)));
  return div().size(size).flex_none().flex().items_center().justify_center().rounded(size / 2)
    .bg(tint(color)).border_1().border_color(color).text_color(color)
    .text_size(font).font_semibold()
    .child(text);
}

/** The color of the value text: the status color when the status is not ok, else the level. */
const valueColor = (t, p, f) => statusColor(t, p.status) ?? (hasFraction(f) ? levelColor(t, f) : t.dim);

const busyDot = (size) => div().size(size).flex_none().rounded(size / 2).bg(BUSY)
  .loop("opacity", { from: 0.35, to: 1, period: 1200 });

function bar(t, fraction, height = 4) {
  const f = Math.min(1, Math.max(0, fraction));
  return div().w_full().h(height).flex_none().rounded(height / 2).bg(t.raised)
    .child(div().h_full().w(`${(f * 100).toFixed(1)}%`).rounded(height / 2).bg(levelColor(t, fraction)));
}

function statePill(t, m) {
  const color = stateColor(t, m.state);
  return h_flex().h(20).px(8).gap(5).flex_none().items_center().rounded(6).text_size(11)
    .bg(tint(color, "1f")).text_color(color)
    .child(div().size(6).rounded(3).bg(color))
    .child(m.str[m.state] ?? m.state);
}

/** The main value of a row in the kit language: TokenHound writes English. */
function primaryText(m, r) {
  if (m.lang !== "en" && hasFraction(r.usedFraction)) return fill(m.str.used, { pct: percent(r.usedFraction) });
  return r.primaryText ?? "";
}

function row(t, m, r) {
  const reset = countdown(m.str, r.resetTimeUtc, m.now) ?? r.resetText ?? "";
  const color = hasFraction(r.usedFraction) ? levelColor(t, r.usedFraction) : t.muted;
  return v_flex().gap(4).w_full()
    .child(h_flex().gap(8).items_center().w_full()
      .child(h_flex().gap(6).flex_1().min_w(0).items_center()
        .child(div().truncate().text_size(12).text_color(t.foreground).child(r.label ?? ""))
        .when(Boolean(r.scopeText), (e) => e.child(div().truncate().text_size(11).text_color(t.dim).child(r.scopeText))))
      .child(div().flex_none().text_size(12).font_semibold().text_color(color).child(primaryText(m, r))))
    .when(hasFraction(r.usedFraction), (e) => e.child(bar(t, r.usedFraction)))
    .when(Boolean(r.secondaryText || reset), (e) => e.child(h_flex().gap(8).w_full().text_size(11).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().child(r.secondaryText ?? ""))
      .child(div().flex_none().child(reset))))
    .when(Boolean(r.errorText), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(r.errorText)));
}

function card(t, m, p, width) {
  const note = p.statusMessage ?? p.activeSessionText ?? "";
  const noteColor = p.statusMessage ? (statusColor(t, p.status) ?? t.muted) : t.dim;
  const rows = Array.isArray(p.rows) ? p.rows : [];
  return v_flex().id(`th-card-${p.providerId}`).when(width > 0, (e) => e.w(width)).when(!width, (e) => e.w_full())
    .flex_none().p(10).gap(8).rounded(10)
    .bg(t.surface).border_1().border_color(t.border)
    .child(h_flex().gap(9).items_center().w_full()
      .child(badge(t, m, p, 24))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(p.displayName ?? p.providerId))
        .when(Boolean(note), (e) => e.child(div().truncate().text_size(11).text_color(noteColor).child(note))))
      .when(p.isBusy === true, (e) => e.child(h_flex().gap(5).flex_none().items_center().text_size(11).text_color(BUSY)
        .child(busyDot(7)).child(m.str.busy)))
      .when(Boolean(m.ui), (e) => e.child(iconButton(t, `th-hide-${p.providerId}`, "eye-off", m.str.hideProvider, () => m.ui.hide(p.providerId)))))
    .children(rows.map((r) => row(t, m, r)));
}

function message(t, m) {
  return v_flex().w_full().p(16).gap(6).items_center()
    .child(svg(ICON).size(22).text_color(stateColor(t, m.state)))
    .child(div().text_size(13).text_color(t.foreground).child(m.str[m.state] ?? m.state))
    .child(div().max_w(300).text_size(11).text_color(t.dim).child(stateHint(m)));
}

function header(t, m) {
  const written = Date.parse(m.doc?.writtenAtUtc ?? "");
  const age = Number.isFinite(written) ? fill(m.str.updated, { age: duration(m.now - written) }) : "";
  return h_flex().w_full().flex_none().px(12).py(10).gap(8).items_center().border_b(1).border_color(t.border)
    .child(svg(ICON).size(15).flex_none().text_color(t.accent))
    .child(div().text_size(13).font_semibold().text_color(t.foreground).child(m.str.title))
    .child(statePill(t, m))
    .child(div().flex_1())
    .child(div().flex_none().text_size(11).text_color(t.dim).child(age))
    .when(Boolean(ownDialog()), (e) => e.child(iconButton(t, "th-close", "close", m.str.close ?? "Close", () => closeOverlay(ownDialog()), 26)));
}

/** The card width in a wide panel: columns of at least CARD_MIN px. 0: one column, full width. */
const CARD_MIN = 340;
function cardWidth(width) {
  const inner = width - 20; // the list padding
  const columns = Math.floor((inner + 8) / (CARD_MIN + 8));
  return columns < 2 ? 0 : Math.floor((inner - 8 * (columns - 1)) / columns);
}

/**
 * The full panel. `width`: the panel width at zoom 1 (0 when not known yet); a wide panel
 * shows the cards in columns.
 */
export function panelView(t, m, { width = 0 } = {}) {
  const warn = m.state === "stale" || m.state === "stopped";
  const cw = cardWidth(width);
  const list = v_flex().w_full().p(10).gap(8)
    .when(warn, (e) => e.child(div().w_full().text_size(11).text_color(t.ansi3).child(stateHint(m))))
    .when(m.providers.length === 0, (e) => e.child(div().p(12).text_size(12).text_color(t.dim).child(m.str.empty)))
    .child(h_flex().w_full().flex_wrap().items_start().gap(8)
      .children(m.providers.map((p) => card(t, m, p, cw))))
    .when(m.hidden.length > 0 && Boolean(m.ui), (e) => e.child(hiddenChips(t, m)));
  const body = SHOWS_DATA.has(m.state) ? list : message(t, m);
  return v_flex().id("tokenhound").size_full().bg(t.background)
    .child(header(t, m))
    .child(v_flex().id("tokenhound-scroll").flex_1().min_h(0).overflow_y_scrollbar().child(body));
}

function statusEntry(t, m, p) {
  const both = m.metric === "both";
  const value = (f) => (hasFraction(f) ? percent(f) : "–");
  const text = both ? `${value(p.sessionUsedFraction)} · ${value(p.weeklyUsedFraction)}` : value(p.sessionUsedFraction);
  return h_flex().gap(5).flex_none().items_center()
    .child(badge(t, m, p, 15))
    .child(div().text_color(valueColor(t, p, p.sessionUsedFraction)).child(text))
    .when(p.isBusy === true, (e) => e.child(busyDot(5)));
}

/** The status bar item: one entry for each provider, or the state when there is no data. */
export function statusView(t, m, onClick) {
  const stale = m.state !== "live";
  const tip = SHOWS_DATA.has(m.state) && !stale ? m.str.clickHint : `${stateHint(m)} ${m.str.clickHint}`.trim();
  return h_flex().id("tokenhound-status").size_full().px(10).gap(10).items_center().overflow_hidden()
    .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
    .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(tip)
    .on_click((_e, cx) => onClick(cx))
    .when(!SHOWS_DATA.has(m.state) || m.providers.length === 0, (e) => e
      .child(svg(ICON).size(12).flex_none().text_color(stateColor(t, m.state)))
      .child(div().truncate().child(m.providers.length === 0 && m.state === "live" ? m.str.title : m.str[m.state] ?? m.state)))
    .when(SHOWS_DATA.has(m.state) && m.providers.length > 0, (e) => e
      .when(stale, (el) => el.opacity(0.55).child(div().size(6).flex_none().rounded(3).bg(stateColor(t, m.state))))
      .children(m.providers.map((p) => statusEntry(t, m, p))));
}

/**
 * The sidebar section: one line for each provider. Narrow (a rail): the badge and the percent only.
 * Minimized (m.ui.minimized): the head and one strip with the badge and the session percent of
 * each provider. The head has the minimize button; a line shows the hide button on hover.
 */
export function sectionView(t, m, width, onClick) {
  const ui = m.ui;
  const narrow = width > 0 && width < 160;
  const small = ui.minimized;
  const value = (p) => div().flex_none().text_size(11).text_color(valueColor(t, p, p.sessionUsedFraction))
    .child(hasFraction(p.sessionUsedFraction) ? percent(p.sessionUsedFraction) : "–");
  const line = (p) => {
    const hovered = ui.hover === p.providerId && !narrow;
    return h_flex().id(`th-line-${p.providerId}`).w_full().gap(8).items_center()
      .on_hover((h, cx) => ui.setHover(h ? p.providerId : ui.hover === p.providerId ? null : ui.hover, cx))
      .child(badge(t, m, p, narrow ? 18 : 16))
      .when(!narrow, (e) => e.child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().truncate().text_size(12).text_color(t.foreground).child(p.displayName ?? p.providerId))
        .when(hasFraction(p.sessionUsedFraction), (el) => el.child(bar(t, p.sessionUsedFraction, 3)))))
      .when(p.isBusy === true, (e) => e.child(busyDot(6)))
      .when(hovered, (e) => e.child(iconButton(t, `th-hide-${p.providerId}`, "eye-off", m.str.hideProvider, () => ui.hide(p.providerId), 18)))
      .when(!hovered, (e) => e.child(value(p)));
  };
  const strip = h_flex().id("tokenhound-strip").w_full().gap(10).items_center().overflow_hidden()
    .when(m.state !== "live", (el) => el.opacity(0.55))
    .children(m.providers.map((p) => h_flex().id(`th-mini-${p.providerId}`).flex_none().gap(4).items_center()
      .tooltip(p.displayName ?? p.providerId)
      .child(badge(t, m, p, 14))
      .child(value(p))));
  const head = h_flex().gap(6).items_center().text_size(10.5).text_color(t.dim)
    .child(div().size(6).flex_none().rounded(3).bg(stateColor(t, m.state)))
    .when(!narrow, (e) => e.child(div().flex_1().min_w(0).truncate().child(m.str.title.toUpperCase()))
      .when(m.hidden.length > 0 && !small, (el) => el.child(h_flex().id("th-hidden-count").flex_none().h(18).px(5).gap(3).items_center().rounded(5)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(m.str.showAll)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); ui.unhideAll(); })
        .child(svg(SVG("eye")).size(11))
        .child(fill(m.str.hiddenCount, { n: m.hidden.length }))))
      .child(iconButton(t, "th-minimize", small ? "chevron-up" : "chevron-down", small ? m.str.expand : m.str.minimize, () => ui.toggle(), 18)));
  return v_flex().id("tokenhound-section").size_full().px(narrow ? 6 : 12).py(small ? 6 : 8).gap(small ? 5 : 7).bg(t.chrome)
    .border_t(1).border_color(t.border).cursor_pointer().on_click((_e, cx) => onClick(cx))
    .child(head)
    .when(!SHOWS_DATA.has(m.state), (e) => e.when(!narrow, (el) => el.child(div().text_size(11).text_color(t.dim).child(m.str[m.state] ?? m.state))))
    .when(SHOWS_DATA.has(m.state) && small && !narrow, (e) => e.child(strip))
    .when(SHOWS_DATA.has(m.state) && (!small || narrow), (e) => e.child(v_flex().id("tokenhound-lines").flex_1().min_h(0).gap(7).overflow_y_scrollbar()
      .when(m.state !== "live", (el) => el.opacity(0.55))
      .children(m.providers.map(line))));
}