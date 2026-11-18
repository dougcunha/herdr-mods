// "Repository components": which Jira components are the issues of this repository. The Repo chip of the
// list shows only the issues that have one of them. The choice is the `components` line at the top of
// `.herdr/jira.toml` in the main checkout of the repository (components.js writes it; the person commits it).
// The mod opens itself as this dialog with props { dialog: "components", space, mod }, from the cog of
// the list or from PowerMods → Settings → Issues. The component list of the Jira project is kept
// until Reload (components.js).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, spaces, run, notify } from "herdr";
import { context, fs, button as kitButton, icon } from "./links.js";
import { projects, isGithub } from "./sources.js";
import { fileComponents, cachedComponents, projectComponents, repoName, saveComponents, lineFor, FILE } from "./components.js";

const SHOWN = 200;
const age = (at) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

export class ComponentsDialog extends View {
  init(_props, cx) {
    this.space = spaces().find((s) => s.id === props()?.space) ?? spaces().find((s) => s.active);
    this.repo = null; this.project = null; this.names = []; this.at = null; this.chosen = new Set();
    this.state = "loading"; this.error = ""; this.saving = false; this.reloading = false; this.fallback = "";
    this.search = InputState.new({ placeholder: "Search components" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      try {
        const c = await context(this.space);
        this.repo = c.repo;
        if (!c.repo) { this.state = "norepo"; cx.notify(); return; }
        const linked = await projects(c);
        this.project = linked.projects.find((p) => !isGithub(p)) ?? null;
        if (!this.project) { this.state = "nojira"; cx.notify(); return; }
        const file = await fileComponents(c.repo);
        this.fallback = repoName(c.repo);
        const kept = cachedComponents(this.project);
        if (kept) { this.names = kept.names; this.at = kept.at; }
        // The line of the file; none: the folder name (when the project has such a component) is the start.
        const start = file.top ?? [];
        this.chosen = new Set(start.map((n) => n.toLowerCase()));
        this.listed = start;
        this.state = "ready";
        cx.notify();
        if (!kept) await this.load(false, cx);
        if (!file.top) this.preselect();
        cx.notify();
      } catch (e) { this.error = String(e?.message ?? e); this.state = this.state === "loading" ? "ready" : this.state; cx.notify(); }
    });
  }

  // Esc, Cancel and Save close it here; the list that opened it gets the keyboard back.
  close() { closeOverlay(props().overlay); const m = props()?.mod; if (m) run(`${m}.focus`); }

  // The folder name is the start when the file has no line and the project has such a component.
  preselect() {
    const hit = this.names.find((n) => n.toLowerCase() === this.fallback.toLowerCase());
    if (hit) this.chosen = new Set([hit.toLowerCase()]);
  }

  // Asks Jira for the component list of the project (the kept list stays when it fails).
  async load(reload, cx) {
    this.reloading = true; this.error = ""; cx.notify();
    try {
      const r = await projectComponents(this.project, reload);
      this.names = r.names; this.at = r.at;
    } catch (e) { this.error = e?.status === 401 ? `Jira doesn't accept the sign-in for ${this.project.site}. Connect in Link space.` : String(e?.message ?? e); }
    this.reloading = false; cx.notify();
  }

  toggle(name, cx) {
    const k = name.toLowerCase();
    if (this.chosen.has(k)) this.chosen.delete(k); else this.chosen.add(k);
    cx.notify();
  }

  // The rows: the components of Jira, and the names of the file that Jira does not have (checked, so they can go).
  rows() {
    const q = this.search.value().trim().toLowerCase();
    const have = new Set(this.names.map((n) => n.toLowerCase()));
    const unknown = (this.listed ?? []).filter((n) => !have.has(n.toLowerCase())).map((n) => ({ name: n, missing: true }));
    return [...unknown, ...this.names.map((name) => ({ name, missing: false }))].filter((r) => !q || r.name.toLowerCase().includes(q));
  }

  save(cx) {
    if (this.saving || !this.repo) return;
    // In the order of the list; a name of the file that Jira does not know keeps its spelling.
    const all = [...(this.listed ?? []).filter((n) => !this.names.some((x) => x.toLowerCase() === n.toLowerCase())), ...this.names];
    const names = all.filter((n) => this.chosen.has(n.toLowerCase()));
    this.saving = true; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await saveComponents(this.repo, names);
        notify({ title: "Components saved", body: names.length ? `${FILE}: ${names.join(", ")}. Commit the file to share it.` : `Removed from ${FILE}.`, level: "success", timeout: 4000 });
        run("issues.refresh");
        this.close();
        return;
      } catch (e) {
        this.error = `${String(e?.message ?? e)}${names.length ? ` Add this line to ${FILE} yourself: ${lineFor(names)}` : ""}`;
      }
      this.saving = false; cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    // A switch to another space closes it, so Save can't land on a space not shown.
    const sp = spaces().find((x) => x.active)?.id ?? null;
    if (this.openSpace === undefined) this.openSpace = sp;
    else if (sp !== this.openSpace && !this.saving) { try { cx.timer.after(0, () => this.close()); } catch { /* next change */ } }
    const hint = (text, color) => div().text_size(fs.tiny).text_color(color ?? t.dim).child(text);
    const button = (id, text, kind, onClick, extra) => kitButton(t, id, text, onClick, { kind: kind === "primary" ? "primary" : kind === "link" ? "link" : "plain", ...extra });
    const rows = this.state === "ready" ? this.rows() : [];
    const ready = this.state === "ready";
    const check = (on) => div().size(16).flex_none().rounded(4).border_1().border_color(on ? t.accent : t.border).bg(on ? t.accent + "33" : t.background)
      .flex().items_center().justify_center().when(on, (e) => e.child(icon("check", t.accent, 12)));
    const machine = this.repo?.on ? ` on ${this.repo.on}` : "";
    const body = this.state === "loading" ? div().p(12).text_color(t.dim).child("Loading…")
      : this.state === "norepo" ? div().p(12).text_color(t.dim).child("This space has no git repository: there is no file to keep the components in.")
      : this.state === "nojira" ? div().p(12).text_color(t.dim).child("This space has no Jira project. Link one first (cog → Link space…).")
      : v_flex().flex_1().min_h(0).gap(8)
        .child(div().px(8).py(5).rounded(6).border_1().border_color(t.input).bg(t.background).child(Input.new(this.search)))
        .child(v_flex().id("components-list").flex_1().min_h(0).overflow_y_scrollbar().rounded(8).border_1().border_color(t.border).p(4).gap(1)
          .children(rows.slice(0, SHOWN).map((r) => h_flex().id(`component-${r.name}`).h(28).px(8).gap(8).flex_none().items_center().rounded(6).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggle(r.name, cx))
            .child(check(this.chosen.has(r.name.toLowerCase())))
            .child(div().flex_1().min_w(0).truncate().text_color(r.missing ? t.dim : t.foreground).child(r.name))
            .when(r.missing, (e) => e.child(div().flex_none().text_size(fs.tiny).text_color(t.ansi3).child("not in Jira")))))
          .when(rows.length === 0, (e) => e.child(div().p(8).text_color(t.dim).child(this.names.length ? "Nothing matches." : this.reloading ? "Loading components…" : "This Jira project has no components.")))
          .when(rows.length > SHOWN, (e) => e.child(div().px(8).py(4).text_size(fs.meta).text_color(t.dim).child(`Showing ${SHOWN} of ${rows.length}: search to narrow`))));

    return v_flex().id("repo-components").size_full().text_size(fs.body).text_color(t.foreground).bg(t.background).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.close(); cx.stop_propagation(); }
        if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)) { this.save(cx); cx.stop_propagation(); }
      })
      .child(v_flex().flex_none().gap(3).px(16).pt(14).pb(12).border_b_1().border_color(t.border)
        .child(div().font_semibold().text_size(fs.title + 1).child("Repository components"))
        .child(div().text_size(fs.meta).text_color(t.muted).child(
          `${this.repo ? repoName(this.repo) : this.space?.name ?? "?"}${machine}: the Jira components of its issues${this.project ? `, in ${this.project.key}` : ""}. The Repo chip shows only these.`)))
      .child(v_flex().id("repo-components-body").flex_1().min_h(0).px(16).py(12).gap(8)
        .child(body)
        .when(ready && this.chosen.size === 0, (e) => e.child(hint(`Nothing picked: the Repo chip looks for the folder name${this.fallback ? ` (${this.fallback})` : ""}.`)))
        .when(ready, (e) => e.child(hint(`Saved in ${FILE} of the main checkout, as one line. The file is not committed: you commit it, so the whole team gets it.`)))
        .when(Boolean(this.error), (e) => e.child(div().text_size(fs.meta).text_color(t.ansi1).child(this.error))))
      .child(h_flex().flex_none().px(16).py(10).gap(8).items_center().border_t_1().border_color(t.border).bg(t.surface)
        .when(ready && Boolean(this.project), (e) => e
          .child(button("reload", this.reloading ? "Loading…" : "Reload", "plain", (cx) => { if (!this.reloading) this.load(true, cx); }, { icon: "refresh", small: true, tooltip: "Ask Jira for the components of the project again" }))
          .child(hint(this.at ? `List from ${age(this.at)}` : "")))
        .child(div().flex_1())
        .child(button("cancel", "Cancel", null, () => this.close()))
        .child(button("save", this.saving ? "Saving…" : "Save", "primary", (cx) => this.save(cx), { disabled: !ready })));
  }
}
