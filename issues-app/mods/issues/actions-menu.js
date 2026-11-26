// Popup menu of applicable Issue Actions and Sequences for a single issue.
// Opened from the issue page header ("Actions" button) or from RowMenu ("Actions…").

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, notify, props, spaces, theme } from "herdr";
import { editMeta, extraFields, issue as fetchJiraIssue, issueFields } from "./jira.js";
import * as github from "./github.js";
import { extraFieldNames, placeholderOf } from "./prompts.js";
import { button, fs, icon, openActionLogDialog, openActionsConfigDialog, tint } from "./links.js";
import {
  dismissRun, evaluateAction, evaluateSequence, fieldText, getRun, issueRunKey,
  loadPersonalConfig, loadRepoConfig, mergeConfigs, resolveTargetFields, scanSkills,
  setActionModeOrOverride,
} from "./actions-store.js";
import { cancelActionRun, resolveCwd, retryCurrentStepInteractively, startActionRun } from "./actions-runner.js";

const SPIN = "mods/workspace-chrome/spinner.svg";
const MAX_ROWS = 10;
const ROW_H = 32;

export class ActionsMenu extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.p = p;
    this.at = 0;
    this.loading = true;
    this.busy = false;
    this.error = "";
    this.merged = null;
    this.repoCfg = null;
    this.rows = [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(40, () => { try { this.handle.focus(); } catch { /* pointer still works */ } });
    this.load(cx);
  }

  space() {
    return spaces().find((s) => s.id === this.p.spaceId) ?? spaces().find((s) => s.active) ?? null;
  }

  repoObj() {
    return this.p.repoMain ? { main: this.p.repoMain, on: this.p.repoOn ?? null } : null;
  }

  runKey() {
    return issueRunKey(this.p.site, this.p.repo, this.p.key);
  }

  load(cx) {
    this.loading = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const p = this.p, repo = this.repoObj(), sp = this.space();
        const on = repo?.on ?? sp?.machine ?? null;
        const cwd = resolveCwd(sp, repo);
        const [personal, repoCfg, skills] = await Promise.all([
          loadPersonalConfig(),
          loadRepoConfig(repo),
          scanSkills({ repoMain: repo?.main ?? "", cwd, on }),
        ]);
        const merged = mergeConfigs(personal, repoCfg);
        this.repoCfg = repoCfg;
        this.merged = merged;

        let meta = null, vals = null;
        if (!p.isGh && p.site && p.key) {
          const needFields = merged.actions.some((a) => (a.guards?.targetFields?.length ?? 0) > 0);
          if (needFields) {
            meta = await editMeta(p.site, p.key).catch(() => null);
            const allTargets = [...new Set(merged.actions.flatMap((a) => a.guards?.targetFields ?? []))];
            const resolved = resolveTargetFields(allTargets, meta);
            if (resolved.length) {
              vals = await issueFields(p.site, p.key, resolved.map((f) => f.id)).catch(() => null);
            }
          }
        }

        const evalById = new Map();
        const actionById = new Map(merged.actions.map((a) => [a.id, a]));
        for (const a of merged.actions) {
          evalById.set(a.id, evaluateAction(a, { issue: p.issue, isGh: Boolean(p.isGh), skills, editMeta: meta, fieldValues: vals }));
        }

        const rows = [];
        const visibleActions = merged.actions.filter((a) => evalById.get(a.id)?.visible);
        const pendingAll = visibleActions.filter((a) => a.includeInRunAll && !evalById.get(a.id)?.filled);
        if (pendingAll.length >= 2) {
          rows.push({
            id: "__run_all__",
            kind: "runAll",
            label: `Run all (${pendingAll.length} pending)`,
            sub: pendingAll.map((a) => a.name).join(" → "),
            steps: pendingAll,
          });
        }

        for (const s of merged.sequences) {
          const ev = evaluateSequence(s, evalById, actionById);
          if (!ev.visible) continue;
          rows.push({
            id: `seq:${s.id}`,
            kind: "sequence",
            label: s.name,
            sub: `${ev.steps.length} ${ev.steps.length === 1 ? "step" : "steps"}`,
            filled: ev.filled,
            source: s._source,
            steps: ev.steps,
            seq: s,
          });
        }

        for (const a of visibleActions) {
          const ev = evalById.get(a.id);
          rows.push({
            id: `act:${a.id}`,
            kind: "action",
            label: a.name,
            sub: a.description,
            filled: ev.filled,
            mode: a.mode,
            source: a._source,
            action: a,
            steps: [a],
          });
        }

        this.rows = rows;
        this.at = Math.min(this.at, Math.max(0, rows.length - 1));
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  async ensurePage() {
    const p = this.p;
    if (p.page) return p.page;
    if (p.isGh) {
      return github.issue(p.issue, { cwd: p.repoMain, on: p.repoOn ?? null, github: p.repo });
    }
    const wanted = extraFieldNames();
    const defs = wanted.length ? await extraFields(p.site, wanted).catch(() => []) : [];
    const page = await fetchJiraIssue(p.site, p.key, defs.map((d) => d.id));
    page.extra = defs.map((d) => {
      const value = fieldText(page.fields[d.id]);
      delete page.fields[d.id];
      return { name: d.name, ph: placeholderOf(d.wanted), text: value };
    });
    return page;
  }

  trigger(row, cx) {
    if (!row || this.busy || this.loading) return;
    const run = getRun(this.runKey());
    if (run?.status === "running" || run?.status === "awaiting_verification") {
      this.error = `${this.p.key} already has an action running.`;
      cx.notify();
      return;
    }
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async () => {
      try {
        const page = await this.ensurePage();
        await startActionRun({
          issue: this.p.issue,
          page,
          isGh: Boolean(this.p.isGh),
          space: this.space(),
          repo: this.repoObj(),
          config: this.merged,
          steps: row.steps,
          label: row.label,
        });
        closeOverlay(props().overlay);
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.busy = false;
        cx.notify();
      }
    });
  }

  runInteractiveFallback(cx) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async () => {
      try {
        await retryCurrentStepInteractively(this.runKey(), { space: this.space(), repo: this.repoObj() });
        closeOverlay(props().overlay);
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.busy = false;
        cx.notify();
      }
    });
  }

  switchToInteractive(r, cx) {
    const step = r?.steps?.[r.stepIndex] ?? r?.steps?.[0];
    if (!step || this.busy) return;
    this.busy = true;
    cx.spawn(async () => {
      try {
        await setActionModeOrOverride({ id: step.actionId, _source: step.source ?? "personal" }, { mode: "interactive" });
        await retryCurrentStepInteractively(this.runKey(), { space: this.space(), repo: this.repoObj() });
        closeOverlay(props().overlay);
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.busy = false;
        cx.notify();
      }
    });
  }

  renderRunStatus(t, r) {
    if (!r) return null;
    const step = r.steps?.[r.stepIndex];
    const stepInfo = (r.steps?.length ?? 0) > 1 ? ` (${r.stepIndex + 1}/${r.steps.length})` : "";
    if (r.status === "running" || r.status === "awaiting_verification") {
      return v_flex().gap(6).p(8).rounded(7).border_1().border_color(tint(t.accent, "66")).bg(tint(t.accent, "12"))
        .child(h_flex().gap(6).items_center()
          .child(svg(SPIN).size(13).flex_none().text_color(t.accent).spin(900))
          .child(div().flex_1().min_w(0).truncate().text_size(fs.meta).font_semibold()
            .child(r.status === "awaiting_verification" ? `Verifying ${step?.name ?? r.label}${stepInfo}…` : `Running ${step?.name ?? r.label}${stepInfo}…`))
          .when(r.status === "running", (e) => e.child(button(t, "act-cancel", "Cancel", (cx) => {
            cx.spawn(async () => { await cancelActionRun(this.runKey()); cx.notify(); });
          }, { small: true }))));
    }
    if (r.status === "needs_input" || r.status === "failed" || r.status === "timed_out") {
      const col = r.status === "needs_input" ? t.ansi3 : t.ansi1;
      return v_flex().gap(6).p(8).rounded(7).border_1().border_color(tint(col, "66")).bg(tint(col, "12"))
        .child(h_flex().gap(6).items_center()
          .child(icon("alert", col, 13))
          .child(div().flex_1().min_w(0).truncate().text_size(fs.meta).font_semibold().text_color(col)
            .child(r.status === "needs_input" ? "Needs input" : r.status === "timed_out" ? "Timed out" : "Failed"))
          .child(button(t, "act-dismiss", "Dismiss", (cx) => { dismissRun(this.runKey()); cx.notify(); }, { kind: "link", small: true })))
        .when(Boolean(r.reason), (e) => e.child(div().text_size(fs.tiny).text_color(t.muted).child(r.reason)))
        .child(h_flex().gap(6).flex_wrap()
          .when(Boolean(r.outputPath), (e) => e.child(button(t, "act-log", "View log", () => {
            closeOverlay(props().overlay);
            openActionLogDialog(this.p.mod ?? "issues", { runKey: this.runKey(), spaceId: this.p.spaceId, repoMain: this.p.repoMain, repoOn: this.p.repoOn });
          }, { small: true })))
          .child(button(t, "act-retry-int", "Run interactively", (cx) => this.runInteractiveFallback(cx), { kind: "primary", small: true }))
          .child(button(t, "act-switch-int", "Switch to interactive", (cx) => this.switchToInteractive(r, cx), { small: true })));
    }
    return null;
  }

  render() {
    const t = theme(), p = this.p, run = getRun(this.runKey());
    const running = run?.status === "running" || run?.status === "awaiting_verification";
    const rowEl = (x, n) => {
      const active = n === this.at;
      const iconName = x.kind === "runAll" ? "play" : x.kind === "sequence" ? "stack" : x.filled ? "check" : "zap";
      const iconColor = x.filled ? t.ansi2 : x.kind === "runAll" ? t.accent : t.muted;
      return h_flex().id(`act-row-${x.id}`).h(ROW_H).px(8).gap(8).flex_none().rounded(7).items_center()
        .when(!running && !this.busy, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.trigger(x, cx)))
        .when(running || this.busy, (e) => e.opacity(0.5))
        .when(active, (e) => e.bg(t.selected))
        .child(icon(iconName, iconColor, 14))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(fs.meta).when(x.kind === "runAll", (e) => e.font_semibold().text_color(t.accent)).child(x.label))
          .when(Boolean(x.sub), (e) => e.child(div().truncate().text_size(fs.tiny - 1).text_color(t.dim).child(x.sub))))
        .when(x.mode === "interactive", (e) => e.child(div().flex_none().px(5).py(1).rounded(4).bg(t.raised).text_size(fs.tiny - 1).text_color(t.muted).child("interactive")))
        .when(x.source === "repo", (e) => e.child(div().flex_none().px(5).py(1).rounded(4).bg(tint(t.accent, "18")).text_size(fs.tiny - 1).text_color(t.accent).child("repo")));
    };

    const listBox = () => {
      const box = v_flex().w_full().gap(2);
      if (this.rows.length > MAX_ROWS) {
        return box.h(MAX_ROWS * (ROW_H + 2)).overflow_y_scrollbar().children(this.rows.map(rowEl));
      }
      return box.children(this.rows.map(rowEl));
    };

    return v_flex().id("actions-menu").track_focus(this.handle).w_full().p(8).gap(6).bg(t.popover).text_size(fs.meta).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); return; }
        if (!this.rows.length) return;
        if (e.key === "down") { this.at = (this.at + 1) % this.rows.length; cx.notify(); cx.stop_propagation(); }
        else if (e.key === "up") { this.at = (this.at + this.rows.length - 1) % this.rows.length; cx.notify(); cx.stop_propagation(); }
        else if (e.key === "enter") { this.trigger(this.rows[this.at], cx); cx.stop_propagation(); }
      })
      .child(h_flex().px(4).gap(6).items_center()
        .child(div().flex_1().truncate().text_size(fs.tiny).font_semibold().text_color(t.muted).child(`Actions · ${p.key ?? ""}`))
        .child(button(t, "act-manage", "Manage…", () => {
          closeOverlay(props().overlay);
          openActionsConfigDialog(p.mod ?? "issues", this.space());
        }, { kind: "link", small: true })))
      .when(Boolean(this.repoCfg?.exists && !this.repoCfg.trusted), (e) => e.child(h_flex().gap(6).items_center().px(8).py(6).rounded(6).bg(tint(t.ansi3, "18")).border_1().border_color(tint(t.ansi3, "44"))
        .child(icon("alert", t.ansi3, 13))
        .child(div().flex_1().min_w(0).text_size(fs.tiny).child(".herdr/issue-actions.json is waiting for approval."))
        .child(button(t, "act-review-repo", "Review…", () => {
          closeOverlay(props().overlay);
          openActionsConfigDialog(p.mod ?? "issues", this.space(), "defaults");
        }, { kind: "link", small: true }))))
      .when(Boolean(run), (e) => { const el = this.renderRunStatus(t, run); return el ? e.child(el) : e; })
      .when(this.loading, (e) => e.child(div().px(6).py(8).text_color(t.dim).child("Checking issue fields and skills…")))
      .when(!this.loading && this.rows.length === 0 && !this.error, (e) => e.child(v_flex().px(6).py(6).gap(6)
        .child(div().text_color(t.dim).child("No issue actions apply to this issue."))
        .child(button(t, "act-configure", "Configure Issue actions…", () => {
          closeOverlay(props().overlay);
          openActionsConfigDialog(p.mod ?? "issues", this.space());
        }, { small: true }))))
      .when(!this.loading && this.rows.length > 0, (e) => e.child(listBox()))
      .when(Boolean(this.error), (e) => e.child(div().px(4).text_size(fs.tiny).text_color(t.ansi1).child(this.error)));
  }
}
