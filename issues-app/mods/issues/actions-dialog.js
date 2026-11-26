// Management dialogs for Issue Actions:
// - ActionsConfigDialog: CRUD for personal actions, sequences, default agent & auto-approve,
//   local overrides for repo actions, local skill scan, and .herdr/issue-actions.json trust.
// - ActionLogDialog: inspects stdout/stderr of a background run and offers interactive recovery.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { closeOverlay, notify, props, readTextFile, run, spaces, theme } from "herdr";
import { placeholdersOf } from "./prompts.js";
import { button, chip, fs, icon, iconButton, programTile, segmented, spaceRepo, tint } from "./links.js";
import {
  clearRepoOverride, clearSkillCache, defaultAgentConfig, defaultConfig, getRun, loadPersonalConfig,
  loadRepoConfig, mergeConfigs, normalizeAction, normalizeSequence, revokeRepoTrust,
  savePersonalConfig, scanSkills, setActionModeOrOverride, slugId, trustRepoConfig,
} from "./actions-store.js";
import { getAgentsList, resolveCwd, retryCurrentStepInteractively } from "./actions-runner.js";

const csv = (list) => (Array.isArray(list) ? list.join(", ") : "");
const fromCsv = (text) => String(text ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
const stopPress = (e) => e.on_mouse_down("left", (_ev, cx) => cx.stop_propagation());

export class ActionsConfigDialog extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.mod = p.mod ?? "issues";
    this.space = spaces().find((s) => s.id === p.space) ?? spaces().find((s) => s.active) ?? null;
    this.tab = ["actions", "sequences", "defaults"].includes(p.tab) ? p.tab : "actions";
    this.loading = true;
    this.saving = false;
    this.error = "";
    this.repo = null;
    this.repoCfg = null;
    this.personal = defaultConfig();
    this.merged = mergeConfigs(this.personal, null);
    this.skills = new Set();
    this.agents = [];
    this.editingAction = null; // null | { originalId, ...inputs }
    this.editingSeq = null;    // null | { originalId, steps: [], name, desc, enabled }

    // Default agent inputs
    this.defModel = InputState.new({ placeholder: "Model (empty: agent default)" });
    this.defEffort = InputState.new({ placeholder: "Effort (low | medium | high | xhigh | max)" });
    this.defExtraArgs = InputState.new({ placeholder: "Extra CLI args (optional)" });
    this.defTimeout = InputState.new({ placeholder: "300" });

    this.handle = cx.focus_handle();
    cx.timer.after(40, () => { try { this.handle.focus(); } catch { /* best effort */ } });
    this.loadAll(cx);
  }

  close() {
    closeOverlay(props().overlay);
    if (this.mod) run(`${this.mod}.focus`);
  }

  loadAll(cx, rescanSkills = false) {
    this.loading = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const repo = await spaceRepo(this.space).catch(() => null);
        this.repo = repo;
        const on = repo?.on ?? this.space?.machine ?? null;
        const cwd = resolveCwd(this.space, repo);
        if (rescanSkills) clearSkillCache();
        const [personal, repoCfg, skills, agents] = await Promise.all([
          loadPersonalConfig(),
          loadRepoConfig(repo),
          scanSkills({ repoMain: repo?.main ?? "", cwd, on, force: rescanSkills }),
          getAgentsList(on),
        ]);
        this.personal = personal;
        this.repoCfg = repoCfg;
        this.skills = skills;
        this.agents = agents;
        this.merged = mergeConfigs(personal, repoCfg);
        this.syncDefaultInputs();
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  syncDefaultInputs() {
    const a = this.personal.defaults?.agent ?? defaultAgentConfig();
    this.defModel.set_value(a.model ?? "");
    this.defEffort.set_value(a.effort ?? "");
    this.defExtraArgs.set_value(a.extraArgs ?? "");
    this.defTimeout.set_value(String(a.timeoutSec ?? 300));
  }

  async persistPersonal(next, cx) {
    this.saving = true;
    this.error = "";
    cx.notify();
    try {
      this.personal = await savePersonalConfig(next);
      this.merged = mergeConfigs(this.personal, this.repoCfg);
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
    this.saving = false;
    cx.notify();
  }

  // ---- Action editor -------------------------------------------------------------------------------

  openActionEditor(a, cx) {
    const src = a ?? normalizeAction({
      id: "",
      name: "",
      description: "",
      mode: "background",
      skill: "",
      prompt: "Run /skill-name for {tracker} issue {key} ({url}).\n\nSummary: {title}\n\nDescription:\n\"\"\"\n{description}\n\"\"\"",
      guards: { tracker: "jira", targetFields: [] },
      includeInRunAll: true,
    });
    const f = {
      originalId: a ? a.id : null,
      id: InputState.new({ placeholder: "auto-from-name", value: a?.id ?? "" }),
      name: InputState.new({ placeholder: "e.g. Fill Refinement", value: src.name }),
      desc: InputState.new({ placeholder: "Short description (optional)", value: src.description }),
      skill: InputState.new({ placeholder: "e.g. jira-refinement (optional)", value: src.skill }),
      prompt: TextareaState.new({ placeholder: "Prompt sent to the agent…", value: src.prompt, rows: 7 }),
      mode: src.mode,
      enabled: src.enabled,
      includeInRunAll: src.includeInRunAll,
      tracker: src.guards.tracker,
      sites: InputState.new({ placeholder: "example.atlassian.net (empty: any)", value: csv(src.guards.sites) }),
      projects: InputState.new({ placeholder: "PROJ, OPS (empty: any)", value: csv(src.guards.projects) }),
      issueTypes: InputState.new({ placeholder: "Task, Bug, Story (empty: any)", value: csv(src.guards.issueTypes) }),
      statuses: InputState.new({ placeholder: "To Do, Open (empty: any)", value: csv(src.guards.statuses) }),
      targetFields: InputState.new({ placeholder: "Refinement, Release Notes (empty: no field guard)", value: csv(src.guards.targetFields) }),
      requireAllFields: src.guards.requireAllFields,
      hideWhenFilled: src.guards.hideWhenFilled,
      agentKey: InputState.new({ placeholder: "Inherit default agent (e.g. agy, claude)", value: src.agent?.key ?? "" }),
      agentModel: InputState.new({ placeholder: "Inherit default model", value: src.agent?.model ?? "" }),
      agentEffort: InputState.new({ placeholder: "Inherit default effort", value: src.agent?.effort ?? "" }),
      agentExtra: InputState.new({ placeholder: "Extra CLI args (optional)", value: src.agent?.extraArgs ?? "" }),
      agentTimeout: InputState.new({ placeholder: "300", value: src.agent?.timeoutSec ? String(src.agent.timeoutSec) : "" }),
      agentAutoApprove: src.agent?.allowAutoApprove ?? null, // null = inherit default
    };
    this.editingAction = f;
    cx.notify();
  }

  saveActionEditor(cx) {
    const f = this.editingAction;
    if (!f) return;
    const name = f.name.value().trim();
    if (!name) { this.error = "Action name is required."; cx.notify(); return; }
    const prompt = f.prompt.value().trim();
    if (!prompt) { this.error = "Prompt is required."; cx.notify(); return; }
    const id = f.id.value().trim() || slugId(name);
    const hasAgentOverride = Boolean(
      f.agentKey.value().trim() || f.agentModel.value().trim() || f.agentEffort.value().trim()
      || f.agentExtra.value().trim() || f.agentTimeout.value().trim() || f.agentAutoApprove !== null,
    );
    const built = normalizeAction({
      id,
      name,
      description: f.desc.value().trim(),
      enabled: f.enabled,
      mode: f.mode,
      skill: f.skill.value().trim(),
      prompt,
      includeInRunAll: f.includeInRunAll,
      guards: {
        tracker: f.tracker,
        sites: fromCsv(f.sites.value()),
        projects: fromCsv(f.projects.value()),
        issueTypes: fromCsv(f.issueTypes.value()),
        statuses: fromCsv(f.statuses.value()),
        targetFields: fromCsv(f.targetFields.value()),
        requireAllFields: f.requireAllFields,
        hideWhenFilled: f.hideWhenFilled,
      },
      agent: hasAgentOverride ? {
        key: f.agentKey.value().trim() || null,
        model: f.agentModel.value().trim() || null,
        effort: f.agentEffort.value().trim() || null,
        extraArgs: f.agentExtra.value().trim(),
        timeoutSec: Number(f.agentTimeout.value().trim()) || undefined,
        allowAutoApprove: f.agentAutoApprove ?? false,
      } : null,
    });

    const next = { ...this.personal, actions: [...this.personal.actions] };
    const matchId = f.originalId ?? id;
    const idx = next.actions.findIndex((x) => x.id === matchId);
    if (idx >= 0) next.actions[idx] = built;
    else next.actions.push(built);
    this.editingAction = null;
    cx.spawn(async (cx) => { await this.persistPersonal(next, cx); });
  }

  deletePersonalAction(id, cx) {
    const next = {
      ...this.personal,
      actions: this.personal.actions.filter((a) => a.id !== id),
      sequences: this.personal.sequences.map((s) => ({ ...s, steps: s.steps.filter((x) => x !== id) })),
    };
    cx.spawn(async (cx) => { await this.persistPersonal(next, cx); });
  }

  // ---- Sequence editor -----------------------------------------------------------------------------

  openSeqEditor(s, cx) {
    const src = s ?? normalizeSequence({ id: "", name: "", description: "", enabled: true, steps: [] });
    this.editingSeq = {
      originalId: s ? s.id : null,
      id: InputState.new({ placeholder: "auto-from-name", value: s?.id ?? "" }),
      name: InputState.new({ placeholder: "e.g. Prepare New Task", value: src.name }),
      desc: InputState.new({ placeholder: "Description (optional)", value: src.description }),
      enabled: src.enabled,
      steps: [...src.steps],
    };
    cx.notify();
  }

  saveSeqEditor(cx) {
    const f = this.editingSeq;
    if (!f) return;
    const name = f.name.value().trim();
    if (!name) { this.error = "Sequence name is required."; cx.notify(); return; }
    if (!f.steps.length) { this.error = "Pick at least one action step."; cx.notify(); return; }
    const id = f.id.value().trim() || slugId(name);
    const built = normalizeSequence({ id, name, description: f.desc.value().trim(), enabled: f.enabled, steps: f.steps });
    const next = { ...this.personal, sequences: [...this.personal.sequences] };
    const idx = next.sequences.findIndex((x) => x.id === (f.originalId ?? id));
    if (idx >= 0) next.sequences[idx] = built;
    else next.sequences.push(built);
    this.editingSeq = null;
    cx.spawn(async (cx) => { await this.persistPersonal(next, cx); });
  }

  deletePersonalSeq(id, cx) {
    const next = { ...this.personal, sequences: this.personal.sequences.filter((s) => s.id !== id) };
    cx.spawn(async (cx) => { await this.persistPersonal(next, cx); });
  }

  // ---- Render helpers ------------------------------------------------------------------------------

  fieldRow(t, label, ctrl, hintText = "") {
    return v_flex().gap(3)
      .child(div().text_size(fs.tiny).font_semibold().text_color(t.muted).child(label))
      .child(ctrl)
      .when(Boolean(hintText), (e) => e.child(div().text_size(fs.tiny - 1).text_color(t.dim).child(hintText)));
  }

  inputBox(t, state) {
    return stopPress(div().px(8).py(5).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(fs.meta))
      .child(Input.new(state));
  }

  checkRow(t, id, label, on, toggle) {
    return h_flex().id(id).gap(6).items_center().cursor_pointer().on_click((_e, cx) => toggle(cx))
      .child(div().size(14).rounded(3).border_1().border_color(on ? t.accent : t.border).when(on, (e) => e.bg(t.accent))
        .flex().items_center().justify_center().when(on, (e) => e.child(icon("check", t.background, 10))))
      .child(div().text_size(fs.meta).child(label));
  }

  renderActionsTab(t) {
    if (this.editingAction) return this.renderActionEditor(t);
    const list = this.merged.actions;
    return v_flex().gap(10)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(fs.meta).text_color(t.muted).child("Actions appear on issues matching their guards and installed skills."))
        .child(button(t, "act-new", "New action", (cx) => this.openActionEditor(null, cx), { kind: "primary", icon: "plus", small: true })))
      .when(!list.length, (e) => e.child(div().p(14).rounded(8).border_1().border_color(t.border).bg(t.surface).text_size(fs.meta).text_color(t.dim)
        .child("No Issue Actions configured yet. Click New action to add one (for example /jira-refinement or /jira-release-notes).")))
      .children(list.map((a) => {
        const skillMissing = Boolean(a.skill && this.skills.size > 0 && !this.skills.has(a.skill.toLowerCase()));
        return v_flex().id(`cfg-act-${a.id}`).gap(6).p(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
          .child(h_flex().gap(6).items_center()
            .child(div().font_semibold().child(a.name))
            .child(div().px(6).py(1).rounded(4).bg(a._source === "repo" ? tint(t.accent, "1f") : t.raised).text_size(fs.tiny).text_color(a._source === "repo" ? t.accent : t.muted).child(a._source))
            .when(a._overridden, (e) => e.child(div().px(6).py(1).rounded(4).bg(tint(t.ansi3, "1f")).text_size(fs.tiny).text_color(t.ansi3).child("overridden")))
            .when(skillMissing, (e) => e.child(div().px(6).py(1).rounded(4).bg(tint(t.ansi1, "1f")).text_size(fs.tiny).text_color(t.ansi1).child(`skill missing: ${a.skill}`)))
            .child(div().flex_1())
            .child(chip(t, `cfg-mode-${a.id}`, a.mode === "background" ? "Background" : "Interactive", a.mode === "background", (cx) => {
              const nextMode = a.mode === "background" ? "interactive" : "background";
              cx.spawn(async (cx) => {
                this.personal = await setActionModeOrOverride(a, { mode: nextMode });
                this.merged = mergeConfigs(this.personal, this.repoCfg);
                cx.notify();
              });
            }))
            .child(chip(t, `cfg-en-${a.id}`, a.enabled ? "Enabled" : "Disabled", a.enabled, (cx) => {
              cx.spawn(async (cx) => {
                this.personal = await setActionModeOrOverride(a, { enabled: !a.enabled });
                this.merged = mergeConfigs(this.personal, this.repoCfg);
                cx.notify();
              });
            })))
          .when(Boolean(a.description), (e) => e.child(div().text_size(fs.meta).text_color(t.muted).child(a.description)))
          .child(h_flex().gap(8).items_center().flex_wrap().text_size(fs.tiny).text_color(t.dim)
            .child(`id: ${a.id}`)
            .when(Boolean(a.skill), (e) => e.child(`skill: ${a.skill}`))
            .when(a.guards.targetFields.length > 0, (e) => e.child(`fields: ${a.guards.targetFields.join(", ")}`))
            .child(div().flex_1())
            .when(a._source === "personal", (e) => e
              .child(button(t, `cfg-edit-${a.id}`, "Edit", (cx) => this.openActionEditor(a, cx), { small: true }))
              .child(button(t, `cfg-del-${a.id}`, "Delete", (cx) => this.deletePersonalAction(a.id, cx), { small: true })))
            .when(a._source === "repo" && a._overridden, (e) => e
              .child(button(t, `cfg-reset-${a.id}`, "Reset override", (cx) => {
                cx.spawn(async (cx) => {
                  this.personal = await clearRepoOverride(a.id);
                  this.merged = mergeConfigs(this.personal, this.repoCfg);
                  cx.notify();
                });
              }, { small: true }))));
      }));
  }

  renderActionEditor(t) {
    const f = this.editingAction;
    const ph = [...new Set([...placeholdersOf("work"), "site", "project"])];
    return v_flex().gap(10)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().font_semibold().child(f.originalId ? `Edit action · ${f.originalId}` : "New Issue Action"))
        .child(button(t, "act-ed-cancel", "Back", (cx) => { this.editingAction = null; this.error = ""; cx.notify(); }, { small: true }))
        .child(button(t, "act-ed-save", "Save action", (cx) => this.saveActionEditor(cx), { kind: "primary", small: true })))
      .child(h_flex().gap(10)
        .child(div().flex_1().child(this.fieldRow(t, "Name", this.inputBox(t, f.name))))
        .child(div().w(180).child(this.fieldRow(t, "ID (optional)", this.inputBox(t, f.id)))))
      .child(this.fieldRow(t, "Description", this.inputBox(t, f.desc)))
      .child(h_flex().gap(12).items_center().flex_wrap()
        .child(v_flex().gap(3).child(div().text_size(fs.tiny).font_semibold().text_color(t.muted).child("Execution mode"))
          .child(segmented("act-mode", [["background", "Background"], ["interactive", "Interactive"]], f.mode, (v, cx) => { f.mode = v; cx.notify(); }, t, false)))
        .child(div().flex_1().child(this.fieldRow(t, "Required local skill (optional)", this.inputBox(t, f.skill), "If set, hidden when this skill is not installed locally."))))
      .child(this.checkRow(t, "act-run-all", "Include in Run all", f.includeInRunAll, (cx) => { f.includeInRunAll = !f.includeInRunAll; cx.notify(); }))
      .child(v_flex().gap(4)
        .child(div().text_size(fs.tiny).font_semibold().text_color(t.muted).child("Prompt template"))
        .child(stopPress(div().h(150).px(8).py(5).rounded(6).border_1().border_color(t.input).bg(t.background).font_family("Menlo").text_size(fs.meta))
          .child(Textarea.new(f.prompt)))
        .child(h_flex().gap(4).flex_wrap().children(ph.map((k) => chip(t, `act-ph-${k}`, `{${k}}`, false, (cx) => { f.prompt.replace(`{${k}}`); f.prompt.focus(); cx.notify(); })))))
      .child(v_flex().gap(8).p(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
        .child(div().font_semibold().text_size(fs.meta).child("Environment Guards (leave empty for any)"))
        .child(segmented("act-tracker", [["any", "Any tracker"], ["jira", "Jira only"], ["github", "GitHub only"]], f.tracker, (v, cx) => { f.tracker = v; cx.notify(); }, t, false))
        .child(h_flex().gap(8)
          .child(div().flex_1().child(this.fieldRow(t, "Sites", this.inputBox(t, f.sites))))
          .child(div().flex_1().child(this.fieldRow(t, "Projects", this.inputBox(t, f.projects)))))
        .child(h_flex().gap(8)
          .child(div().flex_1().child(this.fieldRow(t, "Issue types", this.inputBox(t, f.issueTypes))))
          .child(div().flex_1().child(this.fieldRow(t, "Statuses", this.inputBox(t, f.statuses)))))
        .child(this.fieldRow(t, "Target Jira fields (comma-separated names or IDs)", this.inputBox(t, f.targetFields), "Checked against editmeta; verified after background runs."))
        .child(h_flex().gap(14).flex_wrap()
          .child(this.checkRow(t, "act-req-all", "Require all target fields", f.requireAllFields, (cx) => { f.requireAllFields = !f.requireAllFields; cx.notify(); }))
          .child(this.checkRow(t, "act-hide-filled", "Hide when already filled", f.hideWhenFilled, (cx) => { f.hideWhenFilled = !f.hideWhenFilled; cx.notify(); }))))
      .child(v_flex().gap(8).p(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
        .child(div().font_semibold().text_size(fs.meta).child("Agent Override (optional)"))
        .child(h_flex().gap(8)
          .child(div().flex_1().child(this.fieldRow(t, "Agent key", this.inputBox(t, f.agentKey))))
          .child(div().flex_1().child(this.fieldRow(t, "Model", this.inputBox(t, f.agentModel))))
          .child(div().flex_1().child(this.fieldRow(t, "Effort", this.inputBox(t, f.agentEffort)))))
        .child(h_flex().gap(8)
          .child(div().flex_1().child(this.fieldRow(t, "Extra CLI args", this.inputBox(t, f.agentExtra))))
          .child(div().w(120).child(this.fieldRow(t, "Timeout (sec)", this.inputBox(t, f.agentTimeout)))))
        .child(segmented("act-auto", [[null, "Inherit auto-approve"], [true, "Auto-approve ON"], [false, "Auto-approve OFF"]], f.agentAutoApprove, (v, cx) => { f.agentAutoApprove = v; cx.notify(); }, t, false)));
  }

  renderSequencesTab(t) {
    if (this.editingSeq) {
      const f = this.editingSeq;
      const actionMap = new Map(this.merged.actions.map((a) => [a.id, a]));
      return v_flex().gap(10)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().font_semibold().child(f.originalId ? `Edit sequence · ${f.originalId}` : "New Sequence"))
          .child(button(t, "seq-ed-cancel", "Back", (cx) => { this.editingSeq = null; this.error = ""; cx.notify(); }, { small: true }))
          .child(button(t, "seq-ed-save", "Save sequence", (cx) => this.saveSeqEditor(cx), { kind: "primary", small: true })))
        .child(h_flex().gap(10)
          .child(div().flex_1().child(this.fieldRow(t, "Name", this.inputBox(t, f.name))))
          .child(div().w(180).child(this.fieldRow(t, "ID (optional)", this.inputBox(t, f.id)))))
        .child(this.fieldRow(t, "Description", this.inputBox(t, f.desc)))
        .child(v_flex().gap(6).p(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
          .child(div().font_semibold().text_size(fs.meta).child("Ordered Steps"))
          .when(!f.steps.length, (e) => e.child(div().text_size(fs.tiny).text_color(t.dim).child("No steps yet. Add actions below.")))
          .children(f.steps.map((id, idx) => h_flex().id(`seq-step-${idx}`).gap(6).items_center().px(8).py(5).rounded(6).bg(t.background).border_1().border_color(t.border)
            .child(div().w(20).text_size(fs.tiny).text_color(t.dim).child(`${idx + 1}.`))
            .child(div().flex_1().truncate().child(actionMap.get(id)?.name ?? id))
            .when(idx > 0, (e) => e.child(button(t, `seq-up-${idx}`, "↑", (cx) => { const s = f.steps; [s[idx - 1], s[idx]] = [s[idx], s[idx - 1]]; cx.notify(); }, { small: true })))
            .when(idx < f.steps.length - 1, (e) => e.child(button(t, `seq-dn-${idx}`, "↓", (cx) => { const s = f.steps; [s[idx + 1], s[idx]] = [s[idx], s[idx + 1]]; cx.notify(); }, { small: true })))
            .child(button(t, `seq-rm-${idx}`, "×", (cx) => { f.steps.splice(idx, 1); cx.notify(); }, { small: true }))))
          .child(div().pt(4).text_size(fs.tiny).text_color(t.muted).child("Click an action to append:"))
          .child(h_flex().gap(6).flex_wrap().children(this.merged.actions.map((a) => chip(t, `seq-add-${a.id}`, `+ ${a.name}`, false, (cx) => { f.steps.push(a.id); cx.notify(); })))));
    }

    const actionMap = new Map(this.merged.actions.map((a) => [a.id, a]));
    const list = this.merged.sequences;
    return v_flex().gap(10)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(fs.meta).text_color(t.muted).child("Sequences run multiple actions in order, reloading Jira fields between steps."))
        .child(button(t, "seq-new", "New sequence", (cx) => this.openSeqEditor(null, cx), { kind: "primary", icon: "plus", small: true })))
      .when(!list.length, (e) => e.child(div().p(14).rounded(8).border_1().border_color(t.border).bg(t.surface).text_size(fs.meta).text_color(t.dim)
        .child("No sequences yet. Click New sequence to chain actions (e.g. Refinement → Release Notes).")))
      .children(list.map((s) => v_flex().id(`cfg-seq-${s.id}`).gap(6).p(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
        .child(h_flex().gap(6).items_center()
          .child(div().font_semibold().child(s.name))
          .child(div().px(6).py(1).rounded(4).bg(s._source === "repo" ? tint(t.accent, "1f") : t.raised).text_size(fs.tiny).text_color(s._source === "repo" ? t.accent : t.muted).child(s._source))
          .child(div().flex_1())
          .when(s._source === "personal", (e) => e
            .child(button(t, `seq-edit-${s.id}`, "Edit", (cx) => this.openSeqEditor(s, cx), { small: true }))
            .child(button(t, `seq-del-${s.id}`, "Delete", (cx) => this.deletePersonalSeq(s.id, cx), { small: true }))))
        .when(Boolean(s.description), (e) => e.child(div().text_size(fs.meta).text_color(t.muted).child(s.description)))
        .child(div().text_size(fs.tiny).text_color(t.dim).child(s.steps.map((id) => actionMap.get(id)?.name ?? id).join(" → ") || "(no steps)"))));
  }

  renderDefaultsTab(t) {
    const def = this.personal.defaults?.agent ?? defaultAgentConfig();
    const readyAgents = this.agents.filter((a) => a.installed !== false);
    const repo = this.repoCfg;

    const saveDef = (patch, cx) => {
      const next = {
        ...this.personal,
        defaults: {
          agent: {
            ...def,
            model: this.defModel.value().trim() || null,
            effort: this.defEffort.value().trim() || null,
            extraArgs: this.defExtraArgs.value().trim(),
            timeoutSec: Math.max(15, Number(this.defTimeout.value().trim()) || 300),
            ...patch,
          },
        },
      };
      cx.spawn(async (cx) => { await this.persistPersonal(next, cx); });
    };

    return v_flex().gap(12)
      .child(v_flex().gap(8).p(12).rounded(8).border_1().border_color(t.border).bg(t.surface)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().font_semibold().child("Default Agent for Issue Actions"))
          .child(button(t, "def-save", "Save defaults", (cx) => saveDef({}, cx), { kind: "primary", small: true })))
        .child(h_flex().gap(8).flex_wrap().children(readyAgents.map((a) => {
          const on = (def.key ?? "").toLowerCase() === String(a.key ?? a.name).toLowerCase();
          return h_flex().id(`def-ag-${a.name}`).gap(8).items_center().px(10).py(6).rounded(7).cursor_pointer()
            .border_1().border_color(on ? t.accent : t.border).when(on, (e) => e.bg(tint(t.accent, "16")))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => saveDef({ key: a.key ?? a.name }, cx))
            .child(programTile(t, a, 22))
            .child(div().text_size(fs.meta).child(a.name));
        })))
        .child(h_flex().gap(8)
          .child(div().flex_1().child(this.fieldRow(t, "Model", this.inputBox(t, this.defModel))))
          .child(div().flex_1().child(this.fieldRow(t, "Effort", this.inputBox(t, this.defEffort)))))
        .child(h_flex().gap(8)
          .child(div().flex_1().child(this.fieldRow(t, "Extra CLI args", this.inputBox(t, this.defExtraArgs))))
          .child(div().w(120).child(this.fieldRow(t, "Timeout (sec)", this.inputBox(t, this.defTimeout)))))
        .child(this.checkRow(t, "def-auto", "Allow auto-approve flags in background mode (--dangerously-skip-permissions / --full-auto / -y)", def.allowAutoApprove, (cx) => saveDef({ allowAutoApprove: !def.allowAutoApprove }, cx)))
        .child(div().text_size(fs.tiny).text_color(t.dim).child("Needed if your Jira MCP tools ask for confirmation during non-interactive background runs.")))
      .child(h_flex().gap(8).items_center().p(12).rounded(8).border_1().border_color(t.border).bg(t.surface)
        .child(v_flex().flex_1().gap(2)
          .child(div().font_semibold().child("Local Skills Cache"))
          .child(div().text_size(fs.meta).text_color(t.muted).child(`${this.skills.size} local ${this.skills.size === 1 ? "skill" : "skills"} detected${this.space?.machine ? ` on ${this.space.machine}` : ""}.`)))
        .child(button(t, "rescan-skills", "Rescan skills", (cx) => this.loadAll(cx, true), { icon: "refresh", small: true })))
      .child(v_flex().gap(8).p(12).rounded(8).border_1().border_color(t.border).bg(t.surface)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().font_semibold().child("Repository Actions (.herdr/issue-actions.json)"))
          .when(Boolean(repo?.exists && !repo.error), (e) => e.child(repo.trusted
            ? button(t, "repo-revoke", "Revoke trust", (cx) => { revokeRepoTrust(repo.main); this.loadAll(cx); }, { small: true })
            : button(t, "repo-trust", "Approve & trust", (cx) => { trustRepoConfig(repo); this.loadAll(cx); notify({ title: "Repository actions trusted", level: "success", timeout: 2500 }); }, { kind: "primary", small: true }))))
        .when(!repo?.exists, (e) => e.child(div().text_size(fs.meta).text_color(t.dim).child(this.repo ? `No .herdr/issue-actions.json found in ${this.repo.main}.` : "This space has no git repository.")))
        .when(Boolean(repo?.error), (e) => e.child(div().text_size(fs.meta).text_color(t.ansi1).child(repo.error)))
        .when(Boolean(repo?.exists && !repo.error), (e) => e
          .child(div().text_size(fs.meta).text_color(repo.trusted ? t.ansi2 : t.ansi3)
            .child(repo.trusted ? `Trusted (${repo.actions.length} actions, ${repo.sequences.length} sequences)` : `Not trusted yet (${repo.actions.length} actions, ${repo.sequences.length} sequences)`))
          .when(repo.hasRiskyFlags, (e2) => e2.child(div().p(8).rounded(6).bg(tint(t.ansi3, "18")).text_size(fs.tiny).text_color(t.ansi3)
            .child("Warning: This repository defines actions with allowAutoApprove or custom extraArgs. Review the actions below before approving.")))
          .children(repo.actions.map((a) => div().px(8).py(5).rounded(6).bg(t.background).border_1().border_color(t.border).text_size(fs.tiny)
            .child(`${a.name} (${a.mode}${a.agent?.allowAutoApprove ? ", auto-approve" : ""}${a.skill ? `, skill: ${a.skill}` : ""})`)))));
  }

  render() {
    const t = theme();
    return v_flex().id("actions-cfg").size_full().bg(t.background).text_color(t.foreground).text_size(fs.body).track_focus(this.handle)
      .on_mouse_down("left", () => { try { this.handle.focus(); } catch { /* best effort */ } })
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.close(); cx.stop_propagation(); }
      })
      .child(v_flex().flex_none().gap(8).px(16).pt(14).pb(12).border_b_1().border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().font_semibold().text_size(fs.title + 1).child("Issue Actions"))
          .child(iconButton(t, "cfg-close", "x", () => this.close(), { tooltip: "Close (Esc)" })))
        .child(segmented("act-cfg-tabs", [["actions", "Actions"], ["sequences", "Sequences"], ["defaults", "Defaults & Repo"]], this.tab, (v, cx) => {
          this.tab = v; this.editingAction = null; this.editingSeq = null; this.error = ""; cx.notify();
        }, t, false)))
      .child(v_flex().id("act-cfg-body").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).gap(10)
        .when(this.loading, (e) => e.child(div().text_color(t.dim).child("Loading configuration…")))
        .when(!this.loading && this.tab === "actions", (e) => e.child(this.renderActionsTab(t)))
        .when(!this.loading && this.tab === "sequences", (e) => e.child(this.renderSequencesTab(t)))
        .when(!this.loading && this.tab === "defaults", (e) => e.child(this.renderDefaultsTab(t)))
        .when(Boolean(this.error), (e) => e.child(div().text_size(fs.meta).text_color(t.ansi1).child(this.error))))
      .child(h_flex().flex_none().px(16).py(10).gap(8).items_center().border_t_1().border_color(t.border).bg(t.surface)
        .child(div().flex_1().text_size(fs.tiny).text_color(t.dim).child("Saved in data/issues-app/actions.json · Esc closes"))
        .child(button(t, "cfg-done", "Done", () => this.close(), { kind: "primary" })));
  }
}

export class ActionLogDialog extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.p = p;
    this.mod = p.mod ?? "issues";
    this.run = getRun(p.runKey);
    this.output = "";
    this.loading = true;
    this.busy = false;
    this.error = "";
    this.handle = cx.focus_handle();
    cx.timer.after(40, () => { try { this.handle.focus(); } catch { /* best effort */ } });
    cx.spawn(async (cx) => {
      if (this.run?.outputPath) {
        this.output = await readTextFile(this.run.outputPath).catch(() => "");
      }
      this.loading = false;
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
    if (this.mod) run(`${this.mod}.focus`);
  }

  space() {
    return spaces().find((s) => s.id === this.p.spaceId) ?? spaces().find((s) => s.active) ?? null;
  }

  repoObj() {
    return this.p.repoMain ? { main: this.p.repoMain, on: this.p.repoOn ?? null } : null;
  }

  retry(switchMode, cx) {
    if (this.busy || !this.run) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async () => {
      try {
        if (switchMode) {
          const step = this.run.steps?.[this.run.stepIndex] ?? this.run.steps?.[0];
          if (step) await setActionModeOrOverride({ id: step.actionId, _source: step.source ?? "personal" }, { mode: "interactive" });
        }
        await retryCurrentStepInteractively(this.p.runKey, { space: this.space(), repo: this.repoObj() });
        this.close();
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.busy = false;
        cx.notify();
      }
    });
  }

  render() {
    const t = theme(), r = this.run;
    return v_flex().id("act-log-dlg").size_full().bg(t.background).text_color(t.foreground).text_size(fs.body).track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .child(h_flex().flex_none().gap(8).px(16).pt(14).pb(12).items_center().border_b_1().border_color(t.border)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().font_semibold().text_size(fs.title + 1).child(r ? `${r.issueKey} · ${r.label}` : "Action Output"))
          .when(Boolean(r?.reason), (e) => e.child(div().text_size(fs.meta).text_color(r.status === "needs_input" ? t.ansi3 : t.ansi1).child(r.reason))))
        .child(iconButton(t, "log-close", "x", () => this.close(), { tooltip: "Close (Esc)" })))
      .child(v_flex().id("act-log-body").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).gap(8)
        .when(this.loading, (e) => e.child(div().text_color(t.dim).child("Loading output…")))
        .when(!this.loading, (e) => e.child(div().p(10).rounded(8).border_1().border_color(t.border).bg(t.surface).font_family("Menlo").text_size(fs.meta)
          .child(this.output.trim() || "(No output was written.)")))
        .when(Boolean(this.error), (e) => e.child(div().text_size(fs.meta).text_color(t.ansi1).child(this.error))))
      .child(h_flex().flex_none().px(16).py(10).gap(8).items_center().border_t_1().border_color(t.border).bg(t.surface)
        .child(button(t, "log-copy", "Copy output", (cx) => {
          cx.write_to_clipboard(this.output);
          notify({ title: "Copied output", level: "success", timeout: 2000 });
        }, { small: true, disabled: !this.output }))
        .child(div().flex_1())
        .when(Boolean(r && ["needs_input", "failed", "timed_out"].includes(r.status)), (e) => e
          .child(button(t, "log-switch", "Switch to interactive", (cx) => this.retry(true, cx), { small: true, disabled: this.busy }))
          .child(button(t, "log-retry", "Run interactively", (cx) => this.retry(false, cx), { kind: "primary", small: true, disabled: this.busy })))
        .child(button(t, "log-done", "Close", () => this.close())));
  }
}
