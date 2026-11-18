// The Fix versions and Components menu of a Jira issue: the versions or the components of its project, as
// a popup. The issues mod opens itself as this popup with props { dialog: "field", field, site, key }
// (field: "fixVersions" or "components"; the right-click menu of the list, the Fix versions and
// Components rows of a page). Save sets the field of the issue to the checked ones in Jira (a write of
// this mod), then sets shared("issues.changed"): every copy of the mod reloads that issue.
// Both fields hold many values: a check box for each one.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import { props, closeOverlay, theme, notify, setShared } from "herdr";
import { projectVersions, issueFixVersions, projectComponentList, issueComponents, setIssueIds, byName } from "./jira.js";
import { fs, openUrl, button } from "./links.js";
import { chooseList, scrolled } from "./choose.js";
import { CHANGED } from "./transition.js";

const FIELDS = {
  fixVersions: {
    title: "Fix versions", one: "version", list: projectVersions, now: issueFixVersions, scope: true,
    empty: "This project has no versions. Make one in Jira (Releases).",
  },
  components: {
    title: "Components", one: "component", list: projectComponentList, now: issueComponents, scope: false,
    empty: "This project has no components. Make one in Jira (Project settings).",
  },
};

export class FieldMenu extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.site = p.site; this.key = p.key; this.def = FIELDS[p.field] ?? FIELDS.fixVersions; this.field = FIELDS[p.field] ? p.field : "fixVersions";
    this.search = InputState.new({ placeholder: `Filter the ${this.def.one}s` });
    this.search.on("change", (_e, cx) => { this.top = 0; cx.notify(); });
    cx.timer.after(60, () => { try { this.search.focus(); } catch { /* the click still works */ } });
    this.items = null; this.chosen = new Set(); this.start = ""; this.top = 0; this.scope = "unreleased"; this.error = ""; this.saving = false;
    cx.spawn(async (cx) => {
      try {
        const [all, now] = await Promise.all([this.def.list(this.site, this.key), this.def.now(this.site, this.key)]);
        // A value of the issue that the project list lacks (an archived version) stays in the list, so Save keeps it.
        const have = new Set(all.map((v) => v.id));
        this.items = [...all, ...now.filter((v) => !have.has(v.id))].sort(byName);
        this.chosen = new Set(now.map((v) => v.id));
        this.start = [...this.chosen].sort().join(",");
      } catch (e) { this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  toggle(id, cx) {
    if (this.chosen.has(id)) this.chosen.delete(id); else this.chosen.add(id);
    this.error = ""; cx.notify();
  }

  save(cx) {
    if (this.saving || !this.items) return;
    this.saving = true; this.error = ""; cx.notify();
    // In the order of the list, so the issue keeps a stable order.
    const picked = this.items.filter((v) => this.chosen.has(v.id));
    cx.spawn(async (cx) => {
      try {
        await setIssueIds(this.site, this.key, this.field, picked.map((v) => v.id));
        setShared(CHANGED, { site: this.site, key: this.key, at: Date.now() });
        notify({ title: `${this.key} ${this.def.title}`, body: picked.length ? picked.map((v) => v.name).join(", ") : "None", level: "success", timeout: 3000 });
        closeOverlay(props().overlay);
        return;
      } catch (e) {
        const msg = String(e?.message ?? e);
        this.error = e?.status === 400 || e?.status === 403 ? `${msg} The ${this.def.title} field may not be on the edit screen of this issue: set it in Jira.` : msg;
      }
      this.saving = false; cx.notify();
    });
  }

  render() {
    const t = theme(), ready = Array.isArray(this.items), d = this.def;
    const changed = [...this.chosen].sort().join(",") !== this.start;
    return v_flex().w_full().p(8).gap(8).text_color(t.foreground)
      .child(h_flex().gap(6).items_center().text_size(fs.tiny).text_color(t.muted)
        .child(div().flex_1().child(`${d.title} · ${this.key}`))
        .child(div().text_color(t.dim).child(ready ? `${this.chosen.size} picked` : "")))
      .when(!ready && !this.error, (e) => e.child(div().px(4).py(6).text_size(fs.meta).text_color(t.dim).child(`Loading the ${d.one}s…`)))
      .when(ready && !this.items.length, (e) => e.child(div().px(4).py(6).text_size(fs.meta).text_color(t.dim).child(d.empty)))
      .when(ready && this.items.length > 0, (e) => e.child(chooseList(t, {
        id: `${this.field}-list`, items: this.items.map((v) => ({ id: v.id, name: v.name, note: v.released ? "released" : "" })),
        chosen: this.chosen, multi: true, top: this.top, search: this.search,
        scope: d.scope ? { value: this.scope, pick: (v) => { this.scope = v; this.top = 0; } } : undefined, toggle: (id, cx) => this.toggle(id, cx),
        wheel: (dy, shown, cx) => { this.top = scrolled(this.top, dy, shown); cx.notify(); } })))
      .when(Boolean(this.error), (e) => e.child(div().text_size(fs.tiny).text_color(t.ansi1).child(this.error)))
      .child(h_flex().gap(8).items_center()
        .child(button(t, "field-jira", "Open in Jira ↗", () => { closeOverlay(props().overlay); openUrl(`https://${this.site}/browse/${this.key}`); }, { kind: "link", small: true }))
        .child(div().flex_1())
        .child(button(t, "field-cancel", "Cancel", () => closeOverlay(props().overlay), { small: true }))
        .child(button(t, "field-save", this.saving ? "Saving…" : "Save", (cx) => this.save(cx), { kind: "primary", small: true, disabled: !ready || !changed || this.saving })));
  }
}
