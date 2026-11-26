// Non-blocking Jira pre-flight checklist shown inside the Start agent dialog (agent-dialog.js).
// Checks whether the issue is assigned to the signed-in Jira account, has Story points, Components,
// Fix versions, Refinement (when that field exists on this issue type), and is In Progress.
// Every item can be fixed inline without leaving the dialog; Start agent is never blocked.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { notify, setShared } from "herdr";
import {
  myAccount, assignToMe, editMeta, issueFields, setNumberField, setTextField,
  projectComponentList, projectVersions, setIssueIds,
  transitions, transitionFields, moveIssue, fieldValue, byName,
} from "./jira.js";
import { adfToMarkdown } from "./adf.js";
import { fs, icon, button as kitButton, iconButton, openUrl, tint } from "./links.js";
import { chooseList, scrolled, SHOWN } from "./choose.js";
import { CHANGED } from "./transition.js";
import {
  evaluateAction, getRun, issueRunKey, loadPersonalConfig, loadRepoConfig, mergeConfigs, scanSkills,
} from "./actions-store.js";
import { startActionRun, resolveCwd } from "./actions-runner.js";

const POINTS_RE = /^story ?points?( estimate)?$|^story point estimate$/i;
const REFINEMENT_EXACT = /^refinement$/i;
const REFINEMENT_ANY = /\b(refinement|refinamento)\b/i;

const isRichSchema = (s) => Boolean(s) && (
  ["description", "environment"].includes(s.system) ||
  /textarea|richtext/i.test(s.custom ?? "") ||
  s.type === "doc"
);

const formatPoints = (n) => String(Math.round(n * 10) / 10);

function fieldText(v) {
  if (v == null) return "";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.map(fieldText).filter(Boolean).join(", ");
  if (v.type === "doc") return adfToMarkdown(v).trim();
  return String(v.value ?? v.name ?? v.displayName ?? v.key ?? "");
}

function pickInProgress(list) {
  return list.find((t) => /^in progress$/i.test(t.to) || /^in progress$/i.test(t.name))
    ?? list.find((t) => /in progress|em andamento|doing/i.test(t.to) || /in progress|em andamento|doing/i.test(t.name))
    ?? list.find((t) => t.category === "indeterminate")
    ?? null;
}

export class JiraChecklist {
  constructor(jira, { onUpdate } = {}) {
    this.site = jira.site;
    this.key = jira.key;
    this.url = jira.url ?? `https://${jira.site}/browse/${jira.key}`;
    this.onUpdate = onUpdate ?? (() => {});

    // Initial values from the issue page (shown immediately while fresh metadata loads).
    this.me = jira.me ? { accountId: jira.me, displayName: "" } : null;
    this.status = jira.status ?? "";
    this.statusCategory = jira.statusCategory ?? "";
    this.assignee = jira.assignee ?? null; // { accountId, name } | null
    this.points = jira.points ?? null;
    this.pointsField = jira.pointsField ?? null;
    this.components = (jira.components ?? []).map((name, idx) => ({ id: String(idx), name }));
    this.versions = (jira.versions ?? []).map((name, idx) => ({ id: String(idx), name }));
    this.canComponents = true;
    this.canVersions = true;
    this.refinementField = null; // { id, name, rich } | null (only when present on this issue type)
    this.refinementText = "";
    this.transitions = [];
    this.inProgressTr = null;
    this.actionContext = jira.actionContext ?? null;
    this.mergedConfig = null;
    this.refinementAction = null;

    this.loading = true;
    this.loadError = "";
    this.expanded = true;
    this.busy = null; // "assign" | "points" | "components" | "versions" | "refinement" | "move" | null
    this.error = ""; // last action error

    // Active inline editor: null | "points" | "components" | "versions" | "refinement" | "move-form"
    this.openEditor = null;

    // Inline Story points input
    this.pointsInput = InputState.new({ placeholder: "e.g. 3" });
    this.pointsInput.on("submit", (_e, cx) => this.savePoints(cx));

    // Inline Components / Fix versions picker state
    this.picker = null; // { field, items, chosen: Set, top, scope, search: InputState, loading }

    // Inline Refinement textarea
    this.refinementInput = TextareaState.new({ placeholder: "Add refinement notes…", value: "", rows: 5 });

    // Inline Transition screen form (when Move to In Progress requires screen fields)
    this.moveForm = null; // { tr, fields, picked: Map, searches: Map, tops: Map, scopes: Map }
  }

  load(cx) {
    const seq = this.seq = (this.seq ?? 0) + 1;
    this.loading = true;
    this.loadError = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const [me, meta, trs] = await Promise.all([
          myAccount(this.site).catch(() => this.me),
          editMeta(this.site, this.key).catch(() => null),
          transitions(this.site, this.key).catch(() => []),
        ]);
        if (seq !== this.seq) return;
        if (me) this.me = me;
        this.transitions = Array.isArray(trs) ? trs : [];
        this.inProgressTr = pickInProgress(this.transitions);

        if (meta) {
          const entries = Object.entries(meta);
          const pts = entries.find(([, f]) => POINTS_RE.test(String(f?.name ?? "").trim()));
          if (pts) this.pointsField = pts[0];
          this.canComponents = Object.hasOwn(meta, "components");
          this.canVersions = Object.hasOwn(meta, "fixVersions");
          const ref = entries.find(([, f]) => REFINEMENT_EXACT.test(String(f?.name ?? "").trim()))
            ?? entries.find(([, f]) => REFINEMENT_ANY.test(String(f?.name ?? "").trim()));
          this.refinementField = ref ? { id: ref[0], name: ref[1]?.name ?? "Refinement", rich: isRichSchema(ref[1]?.schema) } : null;
        }

        const want = ["status", "assignee", "components", "fixVersions"];
        if (this.pointsField) want.push(this.pointsField);
        if (this.refinementField) want.push(this.refinementField.id);
        const f = await issueFields(this.site, this.key, want);
        if (seq !== this.seq) return;

        this.status = f.status?.name ?? this.status;
        this.statusCategory = f.status?.statusCategory?.key ?? this.statusCategory;
        this.assignee = f.assignee ? { accountId: f.assignee.accountId ?? "", name: f.assignee.displayName ?? "" } : null;
        this.components = (f.components ?? []).map((c) => ({ id: String(c.id), name: String(c.name ?? c.id) }));
        this.versions = (f.fixVersions ?? []).map((v) => ({ id: String(v.id), name: String(v.name ?? v.id), released: Boolean(v.released) }));
        if (this.pointsField) this.points = typeof f[this.pointsField] === "number" ? f[this.pointsField] : null;
        if (this.refinementField) this.refinementText = fieldText(f[this.refinementField.id]);

        if (this.refinementField && this.actionContext?.issue) {
          try {
            const repo = this.actionContext.repo ?? null;
            const sp = this.actionContext.space ?? null;
            const on = repo?.on ?? sp?.machine ?? null;
            const cwd = resolveCwd(sp, repo);
            const [personal, repoCfg, skills] = await Promise.all([
              loadPersonalConfig(),
              loadRepoConfig(repo),
              scanSkills({ repoMain: repo?.main ?? "", cwd, on }),
            ]);
            if (seq === this.seq) {
              const merged = mergeConfigs(personal, repoCfg);
              this.mergedConfig = merged;
              const rn = this.refinementField.name.toLowerCase();
              const ri = this.refinementField.id.toLowerCase();
              this.refinementAction = merged.actions.find((a) => {
                const targets = (a.guards?.targetFields ?? []).map((x) => x.toLowerCase());
                if (!targets.includes(rn) && !targets.includes(ri)) return false;
                return evaluateAction(a, {
                  issue: this.actionContext.issue,
                  isGh: false,
                  skills,
                  editMeta: meta,
                  fieldValues: f,
                }).visible;
              }) ?? null;
            }
          } catch { /* non-blocking */ }
        }

        this.expanded = this.missingCount() > 0;
      } catch (e) {
        if (seq !== this.seq) return;
        this.loadError = String(e?.message ?? e);
      }
      if (seq === this.seq) { this.loading = false; cx.notify(); }
    });
  }

  closeOpen(cx) {
    if (!this.openEditor) return false;
    this.openEditor = null;
    this.picker = null;
    this.moveForm = null;
    this.error = "";
    cx.notify();
    return true;
  }

  markChanged() {
    setShared(CHANGED, { site: this.site, key: this.key, at: Date.now() });
  }

  checks() {
    const list = [];
    const isMe = Boolean(this.me?.accountId && this.assignee?.accountId === this.me.accountId);
    list.push({
      id: "assignee",
      label: "Assignee",
      ok: isMe,
      detail: isMe ? (this.me?.displayName ? `Assigned to you (${this.me.displayName})` : "Assigned to you")
        : this.assignee?.name ? `Assigned to ${this.assignee.name}` : "Unassigned",
    });

    if (this.pointsField || this.points != null) {
      list.push({
        id: "points",
        label: "Story points",
        ok: this.points != null,
        detail: this.points != null ? formatPoints(this.points) : "Not set",
      });
    }

    if (this.canComponents || this.components.length > 0) {
      list.push({
        id: "components",
        label: "Components",
        ok: this.components.length > 0,
        detail: this.components.length ? this.components.map((c) => c.name).join(", ") : "None",
      });
    }

    if (this.canVersions || this.versions.length > 0) {
      list.push({
        id: "versions",
        label: "Fix versions",
        ok: this.versions.length > 0,
        detail: this.versions.length ? this.versions.map((v) => v.name).join(", ") : "None",
      });
    }

    if (this.refinementField) {
      const hasRef = this.refinementText.trim().length > 0;
      list.push({
        id: "refinement",
        label: this.refinementField.name,
        ok: hasRef,
        detail: hasRef ? "Filled" : "Empty",
      });
    }

    const inProgress = this.statusCategory === "indeterminate" || /in progress|em andamento/i.test(this.status);
    list.push({
      id: "status",
      label: "Status",
      ok: inProgress,
      detail: this.status || "Unknown",
    });

    return list;
  }

  missingCount() {
    return this.checks().filter((c) => !c.ok).length;
  }

  // ---- Actions --------------------------------------------------------------

  assignMe(cx) {
    if (this.busy) return;
    this.busy = "assign"; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await assignToMe(this.site, this.key);
        const me = this.me ?? await myAccount(this.site).catch(() => null);
        if (me) { this.me = me; this.assignee = { accountId: me.accountId, name: me.displayName }; }
        this.markChanged();
        notify({ title: `${this.key} assigned to you`, level: "success", timeout: 2500 });
      } catch (e) { this.error = String(e?.message ?? e); }
      this.busy = null; cx.notify();
    });
  }

  openPoints(cx) {
    if (this.openEditor === "points") { this.closeOpen(cx); return; }
    this.openEditor = "points"; this.error = "";
    this.pointsInput.set_value(this.points != null ? String(this.points) : "");
    cx.notify();
    const focus = () => { try { this.pointsInput.focus(); } catch { /* best effort */ } };
    focus();
    try { cx.timer.after(40, focus); } catch { /* best effort */ }
  }

  savePoints(cx) {
    if (this.busy || !this.pointsField) return;
    const raw = this.pointsInput.value().trim().replace(",", ".");
    const value = raw === "" ? null : Number(raw);
    if (value === null || !Number.isFinite(value) || value < 0) {
      this.error = "Type a number of 0 or more.";
      cx.notify();
      return;
    }
    this.busy = "points"; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await setNumberField(this.site, this.key, this.pointsField, value);
        this.points = value;
        this.openEditor = null;
        this.markChanged();
        notify({ title: `${this.key} story points set to ${formatPoints(value)}`, level: "success", timeout: 2500 });
      } catch (e) { this.error = String(e?.message ?? e); }
      this.busy = null; cx.notify();
    });
  }

  openPicker(kind, cx) {
    if (this.openEditor === kind) { this.closeOpen(cx); return; }
    this.openEditor = kind; this.error = "";
    const isVersions = kind === "versions";
    const current = isVersions ? this.versions : this.components;
    const search = InputState.new({ placeholder: isVersions ? "Filter versions" : "Filter components" });
    search.on("change", (_e, cx) => { if (this.picker) this.picker.top = 0; cx.notify(); });
    this.picker = {
      kind,
      field: isVersions ? "fixVersions" : "components",
      title: isVersions ? "Fix versions" : "Components",
      items: null,
      chosen: new Set(current.map((x) => x.id)),
      top: 0,
      scope: isVersions ? "unreleased" : null,
      search,
      loading: true,
    };
    cx.notify();
    const focus = () => { try { search.focus(); } catch { /* best effort */ } };
    try { cx.timer.after(40, focus); } catch { /* best effort */ }
    cx.spawn(async (cx) => {
      try {
        const all = isVersions
          ? await projectVersions(this.site, this.key)
          : await projectComponentList(this.site, this.key);
        if (this.picker?.kind !== kind) return;
        const have = new Set(all.map((v) => v.id));
        const merged = [...all, ...current.filter((v) => /^\d+$/.test(v.id) && !have.has(v.id))].sort(byName);
        this.picker.items = merged.map((v) => ({ id: v.id, name: v.name, note: v.released ? "released" : "" }));
        this.picker.loading = false;
      } catch (e) {
        if (this.picker?.kind !== kind) return;
        this.error = String(e?.message ?? e);
        this.picker.loading = false;
      }
      cx.notify();
    });
  }

  togglePickerItem(id, cx) {
    if (!this.picker) return;
    if (this.picker.chosen.has(id)) this.picker.chosen.delete(id);
    else this.picker.chosen.add(id);
    this.error = "";
    cx.notify();
  }

  savePicker(cx) {
    const pk = this.picker;
    if (this.busy || !pk?.items) return;
    const picked = pk.items.filter((v) => pk.chosen.has(v.id));
    this.busy = pk.kind; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await setIssueIds(this.site, this.key, pk.field, picked.map((v) => v.id));
        if (pk.kind === "versions") this.versions = picked.map((v) => ({ id: v.id, name: v.name, released: v.note === "released" }));
        else this.components = picked.map((v) => ({ id: v.id, name: v.name }));
        this.openEditor = null;
        this.picker = null;
        this.markChanged();
        notify({ title: `${this.key} ${pk.title} updated`, body: picked.length ? picked.map((v) => v.name).join(", ") : "None", level: "success", timeout: 2500 });
      } catch (e) { this.error = String(e?.message ?? e); }
      this.busy = null; cx.notify();
    });
  }

  openRefinement(cx) {
    if (this.openEditor === "refinement") { this.closeOpen(cx); return; }
    this.openEditor = "refinement"; this.error = "";
    this.refinementInput.set_value(this.refinementText);
    cx.notify();
    const focus = () => { try { this.refinementInput.focus(); } catch { /* best effort */ } };
    focus();
    try { cx.timer.after(40, focus); } catch { /* best effort */ }
  }

  saveRefinement(cx) {
    if (this.busy || !this.refinementField) return;
    const value = this.refinementInput.value().trim();
    if (!value) { this.error = `Type the ${this.refinementField.name.toLowerCase()} text.`; cx.notify(); return; }
    this.busy = "refinement"; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await setTextField(this.site, this.key, this.refinementField.id, value, this.refinementField.rich);
        this.refinementText = value;
        this.openEditor = null;
        this.markChanged();
        this.onUpdate({ refinement: { name: this.refinementField.name, text: value } }, cx);
        notify({ title: `${this.key} ${this.refinementField.name} saved`, level: "success", timeout: 2500 });
      } catch (e) { this.error = String(e?.message ?? e); }
      this.busy = null; cx.notify();
    });
  }

  moveToInProgress(cx) {
    const tr = this.inProgressTr;
    if (this.busy || !tr) return;
    this.busy = "move"; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      let fields = [];
      if (tr.screen) {
        try { fields = await transitionFields(this.site, this.key, tr.id); } catch { fields = []; }
      }
      if (fields.length) {
        const picked = new Map(fields.map((f) => [f.id, f.kind === "choice" ? new Set() : InputState.new({ placeholder: f.name })]));
        const searches = new Map();
        for (const f of fields) {
          if (f.kind !== "choice" || f.allowed.length <= SHOWN) continue;
          const s = InputState.new({ placeholder: `Filter ${f.name}` });
          s.on("change", (_e, cx) => { this.moveForm?.tops.set(f.id, 0); cx.notify(); });
          searches.set(f.id, s);
        }
        this.moveForm = { tr, fields, picked, searches, tops: new Map(), scopes: new Map() };
        this.openEditor = "move-form";
        this.busy = null;
        cx.notify();
        return;
      }
      await this.sendMove(tr, undefined, cx);
    });
  }

  submitMoveForm(cx) {
    const f = this.moveForm;
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
    this.sendMove(f.tr, values, cx);
  }

  async sendMove(tr, fields, cx) {
    this.busy = "move"; this.error = ""; cx.notify();
    try {
      await moveIssue(this.site, this.key, tr.id, fields);
      this.status = tr.to;
      this.statusCategory = tr.category || "indeterminate";
      this.inProgressTr = null;
      this.openEditor = null;
      this.moveForm = null;
      this.markChanged();
      this.onUpdate({ status: tr.to }, cx);
      notify({ title: `${this.key} → ${tr.to}`, level: "success", timeout: 3000 });
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
    this.busy = null;
    cx.notify();
  }

  // ---- Render ---------------------------------------------------------------

  renderInlineEditor(t) {
    const btn = (id, label, onClick, opts = {}) => kitButton(t, id, label, onClick, { small: true, ...opts });
    const box = (children) => v_flex().gap(6).mt(4).p(8).rounded(6).border_1().border_color(t.border).bg(t.background)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .children(children);

    if (this.openEditor === "points") {
      return box([
        h_flex().gap(6).items_center()
          .child(div().w(90).h(26).px(8).rounded(6).border_1().border_color(t.accent).bg(t.background).flex().items_center().text_size(fs.meta).child(Input.new(this.pointsInput)))
          .child(btn("chk-pts-save", this.busy === "points" ? "Saving…" : "Save", (cx) => this.savePoints(cx), { kind: "primary", disabled: Boolean(this.busy) }))
          .child(btn("chk-pts-cancel", "Cancel", (cx) => this.closeOpen(cx), { disabled: Boolean(this.busy) })),
      ]);
    }

    if ((this.openEditor === "components" || this.openEditor === "versions") && this.picker) {
      const pk = this.picker;
      return box([
        pk.loading
          ? div().text_size(fs.meta).text_color(t.dim).child(`Loading ${pk.title.toLowerCase()}…`)
          : !pk.items?.length
            ? div().text_size(fs.meta).text_color(t.dim).child(`No ${pk.title.toLowerCase()} in this project.`)
            : chooseList(t, {
                id: `chk-${pk.kind}`,
                items: pk.items,
                chosen: pk.chosen,
                multi: true,
                top: pk.top,
                search: pk.search,
                scope: pk.scope ? { value: pk.scope, pick: (v, cx) => { pk.scope = v; pk.top = 0; cx.notify(); } } : undefined,
                toggle: (id, cx) => this.togglePickerItem(id, cx),
                wheel: (dy, shown, cx) => { pk.top = scrolled(pk.top, dy, shown); cx.notify(); },
              }),
        h_flex().gap(6).items_center()
          .child(div().flex_1().text_size(fs.tiny).text_color(t.dim).child(`${pk.chosen.size} selected`))
          .child(btn("chk-pk-cancel", "Cancel", (cx) => this.closeOpen(cx), { disabled: Boolean(this.busy) }))
          .child(btn("chk-pk-save", this.busy === pk.kind ? "Saving…" : "Save", (cx) => this.savePicker(cx), { kind: "primary", disabled: Boolean(this.busy) || pk.loading || !pk.items })),
      ]);
    }

    if (this.openEditor === "refinement") {
      return box([
        div().h(110).px(8).py(5).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(fs.meta).child(Textarea.new(this.refinementInput)),
        h_flex().gap(6).items_center()
          .child(btn("chk-ref-jira", "Open in Jira ↗", () => openUrl(this.url), { kind: "link" }))
          .child(div().flex_1())
          .child(btn("chk-ref-cancel", "Cancel", (cx) => this.closeOpen(cx), { disabled: Boolean(this.busy) }))
          .child(btn("chk-ref-save", this.busy === "refinement" ? "Saving…" : "Save", (cx) => this.saveRefinement(cx), { kind: "primary", disabled: Boolean(this.busy) })),
      ]);
    }

    if (this.openEditor === "move-form" && this.moveForm) {
      const f = this.moveForm;
      return box([
        div().text_size(fs.tiny).text_color(t.muted).child(`Move to ${f.tr.to} requires:`),
        ...f.fields.map((x) => v_flex().gap(4)
          .child(div().text_size(fs.meta).font_semibold().child(x.name))
          .child(x.kind === "choice"
            ? chooseList(t, {
                id: `chk-mv-${x.id}`,
                items: x.allowed,
                chosen: f.picked.get(x.id),
                multi: x.multi,
                top: f.tops.get(x.id) ?? 0,
                search: f.searches.get(x.id),
                scope: x.allowed.some((v) => v.note === "released")
                  ? { value: f.scopes.get(x.id) ?? "unreleased", pick: (v, cx) => { f.scopes.set(x.id, v); f.tops.set(x.id, 0); cx.notify(); } }
                  : undefined,
                toggle: (id, cx) => {
                  const set = f.picked.get(x.id);
                  if (x.multi) { if (set.has(id)) set.delete(id); else set.add(id); }
                  else { const had = set.has(id); set.clear(); if (!had) set.add(id); }
                  this.error = ""; cx.notify();
                },
                wheel: (d, shown, cx) => { f.tops.set(x.id, scrolled(f.tops.get(x.id) ?? 0, d, shown)); cx.notify(); },
              })
            : x.kind === "other"
              ? div().text_size(fs.tiny).text_color(t.ansi3).child("This field can't be filled here: make the move in Jira.")
              : div().px(8).py(5).rounded(6).border_1().border_color(t.input).bg(t.background).child(Input.new(f.picked.get(x.id))))),
        h_flex().gap(6).items_center()
          .child(btn("chk-mv-jira", "Open in Jira ↗", () => openUrl(this.url), { kind: "link" }))
          .child(div().flex_1())
          .child(btn("chk-mv-cancel", "Cancel", (cx) => this.closeOpen(cx), { disabled: Boolean(this.busy) }))
          .child(btn("chk-mv-go", this.busy === "move" ? "Moving…" : `Move to ${f.tr.to}`, (cx) => this.submitMoveForm(cx), { kind: "primary", disabled: Boolean(this.busy) })),
      ]);
    }

    return null;
  }

  renderRow(t, item) {
    const busy = Boolean(this.busy);
    const btn = (id, label, onClick, opts = {}) => kitButton(t, id, label, onClick, { small: true, disabled: busy, ...opts });
    const actions = [];
    if (!item.ok) {
      if (item.id === "assignee") {
        actions.push(btn("chk-assign", this.busy === "assign" ? "Assigning…" : "Assign to me", (cx) => this.assignMe(cx), {
          tooltip: this.assignee?.name ? `Reassign from ${this.assignee.name} to you` : "Assign this issue to you",
        }));
      } else if (item.id === "points" && this.pointsField) {
        actions.push(btn("chk-points", this.openEditor === "points" ? "Close" : "Set", (cx) => this.openPoints(cx)));
      } else if (item.id === "components" && this.canComponents) {
        actions.push(btn("chk-comp", this.openEditor === "components" ? "Close" : "Pick…", (cx) => this.openPicker("components", cx)));
      } else if (item.id === "versions" && this.canVersions) {
        actions.push(btn("chk-ver", this.openEditor === "versions" ? "Close" : "Pick…", (cx) => this.openPicker("versions", cx)));
      } else if (item.id === "refinement" && this.refinementField) {
        if (this.refinementAction && this.actionContext) {
          const r = getRun(issueRunKey(this.site, "", this.key));
          const running = r?.status === "running" || r?.status === "awaiting_verification";
          actions.push(btn("chk-ref-action", running ? "Running…" : `Run ${this.refinementAction.name}`, (cx) => {
            if (running) return;
            cx.spawn(async (cx) => {
              try {
                await startActionRun({
                  issue: this.actionContext.issue,
                  page: this.actionContext.page,
                  isGh: false,
                  space: this.actionContext.space,
                  repo: this.actionContext.repo,
                  config: this.mergedConfig,
                  steps: [this.refinementAction],
                  label: this.refinementAction.name,
                });
                cx.notify();
              } catch (e) {
                this.error = String(e?.message ?? e);
                cx.notify();
              }
            });
          }, { disabled: busy || running }));
        }
        actions.push(btn("chk-ref-edit", this.openEditor === "refinement" ? "Close" : "Edit", (cx) => this.openRefinement(cx)));
        actions.push(btn("chk-ref-open", "Jira ↗", () => openUrl(this.url), { kind: "link", disabled: false }));
      } else if (item.id === "status") {
        if (this.inProgressTr) {
          actions.push(btn("chk-move", this.busy === "move" ? "Moving…" : `Move to ${this.inProgressTr.to}`, (cx) => this.moveToInProgress(cx)));
        } else if (!this.loading) {
          actions.push(btn("chk-move-jira", "Open in Jira ↗", () => openUrl(this.url), { kind: "link", disabled: false }));
        }
      }
    }

    const showEditor = (item.id === "points" && this.openEditor === "points")
      || (item.id === "components" && this.openEditor === "components")
      || (item.id === "versions" && this.openEditor === "versions")
      || (item.id === "refinement" && this.openEditor === "refinement")
      || (item.id === "status" && this.openEditor === "move-form");

    return v_flex().gap(2)
      .child(h_flex().gap(8).items_center().min_h(24).text_size(fs.meta)
        .child(icon(item.ok ? "check" : "alert", item.ok ? t.ansi2 : t.ansi3, 13))
        .child(div().flex_none().font_semibold().text_color(item.ok ? t.muted : t.foreground).child(item.label))
        .child(div().flex_1().min_w(0).truncate().text_color(item.ok ? t.dim : t.ansi3).child(item.detail))
        .children(actions))
      .when(showEditor, (e) => { const ed = this.renderInlineEditor(t); return ed ? e.child(ed) : e; });
  }

  render(t) {
    const items = this.checks();
    const missing = items.filter((c) => !c.ok).length;
    const allOk = !this.loading && missing === 0;

    // Compact 1-line green summary when everything passes and collapsed.
    if (allOk && !this.expanded) {
      return h_flex().id("jira-checklist").gap(8).items_center().px(10).py(7).rounded(8)
        .border_1().border_color(tint(t.ansi2, "44")).bg(tint(t.ansi2, "10")).text_size(fs.meta)
        .child(icon("check", t.ansi2, 13))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(`Jira ready · Assigned to you · ${this.status}`))
        .child(kitButton(t, "chk-expand", "Details", (cx) => { this.expanded = true; cx.notify(); }, { kind: "link", small: true }));
    }

    const accent = missing > 0 ? t.ansi3 : t.ansi2;
    return v_flex().id("jira-checklist").gap(6).px(12).py(9).rounded(8)
      .border_1().border_color(this.loading ? t.border : tint(accent, "55"))
      .bg(this.loading ? t.surface : tint(accent, "0e"))
      .child(h_flex().gap(6).items_center()
        .child(icon(missing > 0 ? "alert" : "check", this.loading ? t.dim : accent, 13))
        .child(div().font_semibold().text_size(fs.meta).text_color(t.foreground).child("Jira checklist"))
        .child(div().flex_1().text_size(fs.tiny).text_color(t.dim).child(
          this.loading ? "Checking issue fields…"
            : missing > 0 ? `${missing} ${missing === 1 ? "item" : "items"} to review · optional`
            : "All set"
        ))
        .child(iconButton(t, "chk-refresh", "refresh", (cx) => this.load(cx), { spin: this.loading, size: 22, tooltip: "Recheck Jira fields" }))
        .child(kitButton(t, "chk-toggle", this.expanded ? "Hide" : "Show", (cx) => { this.expanded = !this.expanded; cx.notify(); }, { kind: "link", small: true })))
      .when(Boolean(this.loadError), (e) => e.child(div().text_size(fs.tiny).text_color(t.ansi1).child(`Could not check all Jira fields: ${this.loadError}`)))
      .when(this.expanded, (e) => e.child(v_flex().gap(4).pt(2).children(items.map((it) => this.renderRow(t, it)))))
      .when(Boolean(this.error), (e) => e.child(div().pt(2).text_size(fs.tiny).text_color(t.ansi1).child(this.error)));
  }
}
