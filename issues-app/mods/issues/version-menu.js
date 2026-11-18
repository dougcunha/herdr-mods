// The Fix version menu of a Jira issue: the versions of its project, as a popup. The issues mod opens
// itself as this popup with props { dialog: "version", site, key } (the right-click menu of the list, the
// Fix versions row of a page). Save sets the Fix versions of the issue to the checked ones in Jira (a
// write of this mod), then sets shared("issues.changed"): every copy of the mod reloads that issue.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import { props, closeOverlay, theme, notify, setShared } from "herdr";
import { projectVersions, issueFixVersions, setFixVersions } from "./jira.js";
import { fs, openUrl, button } from "./links.js";
import { chooseList, scrolled } from "./choose.js";
import { CHANGED } from "./transition.js";

export class VersionMenu extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.site = p.site; this.key = p.key;
    this.search = InputState.new({ placeholder: "Filter the versions" });
    this.search.on("change", (_e, cx) => { this.top = 0; cx.notify(); });
    cx.timer.after(60, () => { try { this.search.focus(); } catch { /* the click still works */ } });
    this.versions = null; this.chosen = new Set(); this.start = ""; this.top = 0; this.error = ""; this.saving = false;
    cx.spawn(async (cx) => {
      try {
        const [all, now] = await Promise.all([projectVersions(this.site, this.key), issueFixVersions(this.site, this.key)]);
        // A version of the issue that the project list lacks (an archived one) stays in the list, so Save keeps it.
        const have = new Set(all.map((v) => v.id));
        this.versions = [...all, ...now.filter((v) => !have.has(v.id))];
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
    if (this.saving || !this.versions) return;
    this.saving = true; this.error = ""; cx.notify();
    // In the order of the list, so the issue keeps a stable order.
    const ids = this.versions.filter((v) => this.chosen.has(v.id)).map((v) => v.id);
    cx.spawn(async (cx) => {
      try {
        await setFixVersions(this.site, this.key, ids);
        setShared(CHANGED, { site: this.site, key: this.key, at: Date.now() });
        const names = this.versions.filter((v) => this.chosen.has(v.id)).map((v) => v.name);
        notify({ title: `${this.key} Fix versions`, body: names.length ? names.join(", ") : "None", level: "success", timeout: 3000 });
        closeOverlay(props().overlay);
        return;
      } catch (e) {
        const msg = String(e?.message ?? e);
        this.error = e?.status === 400 || e?.status === 403 ? `${msg} The Fix versions field may not be on the edit screen of this issue: set it in Jira.` : msg;
      }
      this.saving = false; cx.notify();
    });
  }

  render() {
    const t = theme(), ready = Array.isArray(this.versions);
    const changed = [...this.chosen].sort().join(",") !== this.start;
    return v_flex().w_full().p(8).gap(8).text_color(t.foreground)
      .child(h_flex().gap(6).items_center().text_size(fs.tiny).text_color(t.muted)
        .child(div().flex_1().child(`Fix versions · ${this.key}`))
        .child(div().text_color(t.dim).child(ready ? `${this.chosen.size} picked` : "")))
      .when(!ready && !this.error, (e) => e.child(div().px(4).py(6).text_size(fs.meta).text_color(t.dim).child("Loading the versions…")))
      .when(ready && !this.versions.length, (e) => e.child(div().px(4).py(6).text_size(fs.meta).text_color(t.dim).child("This project has no versions. Make one in Jira (Releases).")))
      .when(ready && this.versions.length > 0, (e) => e.child(chooseList(t, {
        id: "version-list", items: this.versions.map((v) => ({ id: v.id, name: v.name, note: v.released ? "released" : "" })),
        chosen: this.chosen, multi: true, top: this.top, search: this.search, toggle: (id, cx) => this.toggle(id, cx),
        wheel: (d, shown, cx) => { this.top = scrolled(this.top, d, shown); cx.notify(); } })))
      .when(Boolean(this.error), (e) => e.child(div().text_size(fs.tiny).text_color(t.ansi1).child(this.error)))
      .child(h_flex().gap(8).items_center()
        .child(button(t, "version-jira", "Open in Jira ↗", () => { closeOverlay(props().overlay); openUrl(`https://${this.site}/browse/${this.key}`); }, { kind: "link", small: true }))
        .child(div().flex_1())
        .child(button(t, "version-cancel", "Cancel", () => closeOverlay(props().overlay), { small: true }))
        .child(button(t, "version-save", this.saving ? "Saving…" : "Save", (cx) => this.save(cx), { kind: "primary", small: true, disabled: !ready || !changed || this.saving })));
  }
}
