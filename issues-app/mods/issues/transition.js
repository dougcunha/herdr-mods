// The Move menu of an issue page: the moves (Jira transitions) that the workflow allows now, as a
// popup. The issues mod opens itself as this popup with props { dialog: "transition", site, key, status }.
// A pick moves the issue in Jira (the only write of this mod), then sets shared("issues.changed"):
// every copy of the mod (the list, a page dialog) reloads that issue.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, notify, setShared } from "herdr";
import { transitions, moveIssue } from "./jira.js";
import { fs, openUrl } from "./links.js";

export const CHANGED = "issues.changed";
// The color of a status category, as the page's badge shows it.
const categoryColor = (t, c) => (c === "done" ? t.ansi2 : c === "indeterminate" ? t.accent : t.muted);

export class TransitionMenu extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.site = p.site; this.key = p.key; this.status = p.status ?? "";
    this.list = null; this.error = ""; this.busy = null;
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
      try {
        await moveIssue(this.site, this.key, tr.id);
        setShared(CHANGED, { site: this.site, key: this.key, at: Date.now() });
        notify({ title: `${this.key} → ${tr.to}`, level: "success", timeout: 3000 });
        closeOverlay(props().overlay);
      } catch (e) {
        const msg = String(e?.message ?? e);
        // Required fields on the move's screen: the API can't fill them for the person.
        this.error = e?.status === 400 ? `${msg} This move asks for fields: make it in Jira.` : msg;
        this.busy = null; cx.notify();
      }
    });
  }

  render() {
    const t = theme();
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
