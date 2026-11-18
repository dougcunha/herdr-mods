// The Move menu of an issue page: the moves (Jira transitions) that the workflow allows now, as a
// popup. The issues mod opens itself as this popup with props { dialog: "transition", site, key, status }.
// A pick moves the issue in Jira, then sets shared("issues.changed"): every copy of the mod (the
// list, a page dialog) reloads that issue. A move whose screen requires fields (a Fix version, a
// Resolution…) shows a form for them first; a field that the form can't fill (rich text) is made in Jira.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, notify, setShared } from "herdr";
import { transitions, moveIssue, transitionFields, fieldValue } from "./jira.js";
import { fs, openUrl, button } from "./links.js";
import { chooseList, scrolled, SHOWN } from "./choose.js";

export const CHANGED = "issues.changed";
// The color of a status category, as the page's badge shows it.
const categoryColor = (t, c) => (c === "done" ? t.ansi2 : c === "indeterminate" ? t.accent : t.muted);

export class TransitionMenu extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.site = p.site; this.key = p.key; this.status = p.status ?? "";
    this.list = null; this.error = ""; this.busy = null;
    // The form of a move that requires fields: { tr, fields, picked (Map id → Set | InputState), tops (Map id → row) }.
    this.form = null;
    cx.spawn(async (cx) => {
      try { this.list = await transitions(this.site, this.key); }
      catch (e) { this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  pick(tr, cx) {
    if (this.busy) return;
    this.busy = tr.id; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      // A move with a screen may require fields: ask Jira which. If that fails, try the move as it is.
      let fields = [];
      if (tr.screen) { try { fields = await transitionFields(this.site, this.key, tr.id); } catch { fields = []; } }
      if (fields.length) {
        const picked = new Map(fields.map((f) => [f.id, f.kind === "choice" ? new Set() : InputState.new({ placeholder: f.name })]));
        // A list of more than a few rows has a filter box of its own.
        const searches = new Map();
        for (const f of fields) {
          if (f.kind !== "choice" || f.allowed.length <= SHOWN) continue;
          const s = InputState.new({ placeholder: `Filter ${f.name}` });
          s.on("change", (_e, cx) => { this.form?.tops.set(f.id, 0); cx.notify(); });
          searches.set(f.id, s);
        }
        this.form = { tr, fields, picked, searches, tops: new Map(), scopes: new Map() };
        this.busy = null; cx.notify();
        return;
      }
      await this.send(tr, undefined, cx);
    });
  }

  // Makes the move; an error stays in the menu.
  async send(tr, fields, cx) {
    this.busy = tr.id; this.error = ""; cx.notify();
    try {
      await moveIssue(this.site, this.key, tr.id, fields);
      setShared(CHANGED, { site: this.site, key: this.key, at: Date.now() });
      notify({ title: `${this.key} → ${tr.to}`, level: "success", timeout: 3000 });
      closeOverlay(props().overlay);
      return;
    } catch (e) {
      const msg = String(e?.message ?? e);
      // Required fields that the form didn't know: the API can't fill them for the person.
      this.error = e?.status === 400 && !fields ? `${msg} This move asks for fields: make it in Jira.` : msg;
    }
    this.busy = null; cx.notify();
  }

  // Checks the form and makes the move.
  submit(cx) {
    const f = this.form;
    if (!f || this.busy) return;
    const values = {};
    for (const x of f.fields) {
      const v = f.picked.get(x.id);
      if (x.kind === "other") { this.error = `${x.name} can't be set here: make this move in Jira.`; cx.notify(); return; }
      const got = x.kind === "choice" ? v : v.value().trim();
      if (x.kind === "choice" ? got.size === 0 : got === "") { this.error = `${x.name} is required.`; cx.notify(); return; }
      if (x.kind === "number" && !Number.isFinite(Number(got))) { this.error = `${x.name} must be a number.`; cx.notify(); return; }
      values[x.id] = fieldValue(x, got);
    }
    this.send(f.tr, values, cx);
  }

  toggle(x, id, cx) {
    const set = this.form.picked.get(x.id);
    if (x.multi) { if (set.has(id)) set.delete(id); else set.add(id); }
    else { const had = set.has(id); set.clear(); if (!had) set.add(id); }
    this.error = ""; cx.notify();
  }

  renderForm(t) {
    const f = this.form, busy = Boolean(this.busy);
    return v_flex().w_full().p(8).gap(8).text_color(t.foreground)
      .child(h_flex().gap(6).items_center().text_size(fs.tiny).text_color(t.muted)
        .child(div().flex_1().truncate().child(`Move ${this.key} → ${f.tr.to}`)))
      .child(div().text_size(fs.tiny).text_color(t.dim).child("This move asks for:"))
      .children(f.fields.map((x) => v_flex().gap(4)
        .child(div().text_size(fs.meta).font_semibold().child(x.name))
        .child(x.kind === "choice"
          ? chooseList(t, { id: `form-${x.id}`, items: x.allowed, chosen: f.picked.get(x.id), multi: x.multi, top: f.tops.get(x.id) ?? 0,
            search: f.searches.get(x.id), toggle: (id, cx) => this.toggle(x, id, cx),
            scope: x.allowed.some((v) => v.note === "released") ? { value: f.scopes.get(x.id) ?? "unreleased", pick: (v) => { f.scopes.set(x.id, v); f.tops.set(x.id, 0); } } : undefined,
            wheel: (d, shown, cx) => { f.tops.set(x.id, scrolled(f.tops.get(x.id) ?? 0, d, shown)); cx.notify(); } })
          : x.kind === "other" ? div().text_size(fs.tiny).text_color(t.ansi3).child("This field can't be filled here: make the move in Jira.")
          : div().px(8).py(5).rounded(6).border_1().border_color(t.input).bg(t.background).child(Input.new(f.picked.get(x.id))))))
      .when(Boolean(this.error), (e) => e.child(div().text_size(fs.tiny).text_color(t.ansi1).child(this.error)))
      .child(h_flex().gap(8).items_center()
        .child(button(t, "form-back", "Back", (cx) => { this.form = null; this.error = ""; cx.notify(); }, { small: true, disabled: busy }))
        .child(div().flex_1())
        .child(button(t, "form-move", busy ? "Moving…" : "Move", (cx) => this.submit(cx), { kind: "primary", small: true, disabled: busy })));
  }

  render() {
    const t = theme();
    if (this.form) return this.renderForm(t);
    const row = (tr) => h_flex().id(`move-${tr.id}`).h(30).px(8).gap(8).items_center().rounded(6).text_size(fs.meta)
      .when(!this.busy, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(tr, cx)))
      .when(Boolean(this.busy) && this.busy !== tr.id, (e) => e.opacity(0.5))
      .child(div().size(8).flex_none().rounded_full().bg(categoryColor(t, tr.category)))
      .child(div().flex_1().min_w(0).truncate().child(tr.name))
      .when(tr.name !== tr.to, (e) => e.child(div().flex_none().text_color(t.dim).child(`→ ${tr.to}`)))
      .when(this.busy === tr.id, (e) => e.child(div().flex_none().text_color(t.dim).child("Moving…")));
    return v_flex().w_full().p(6).gap(2).text_color(t.foreground)
      .child(h_flex().px(8).py(4).gap(6).items_center().text_size(fs.tiny).text_color(t.muted)
        .child(div().flex_1().child(`Move ${this.key}`)).child(div().text_color(t.dim).child(this.status)))
      .when(this.list === null && !this.error, (e) => e.child(div().px(8).py(6).text_size(fs.meta).text_color(t.dim).child("Loading the moves…")))
      .when(Array.isArray(this.list) && !this.list.length, (e) => e.child(div().px(8).py(6).text_size(fs.meta).text_color(t.dim).child("No move is open to you from this status.")))
      .children((this.list ?? []).map(row))
      .when(Boolean(this.error), (e) => e.child(div().px(8).py(6).text_size(fs.tiny).text_color(t.ansi1).child(this.error)))
      .child(h_flex().id("move-in-jira").mt(2).px(8).py(5).gap(6).items_center().rounded(6).text_size(fs.tiny).text_color(t.muted).cursor_pointer()
        .border_t_1().border_color(t.border).hover((s) => s.text_color(t.foreground))
        .on_click(() => { closeOverlay(props().overlay); openUrl(`https://${this.site}/browse/${this.key}`); })
        .child("Open in Jira ↗"));
  }
}
