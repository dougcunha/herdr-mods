// The form of an automation: a header, tabs (General, Agent, Prompt, Trigger, Scripts,
// Options), and a bottom bar with the error and the buttons. `v` is the View of main.js: it
// holds the draft (`v.draft`), the text fields (`v.f`, `v.prompt`) and the actions.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces } from "herdr";
import { nextTimes, scheduleError, whenText, DAY_NAMES } from "./schedule.js";
import { builtinCommand, headlessKey, isWin } from "./shell.js";
import * as U from "./ui.js";

export const TABS = [
  { key: "general", label: "General", icon: "settings" },
  { key: "agent", label: "Agent", icon: "bot" },
  { key: "prompt", label: "Prompt", icon: "message" },
  { key: "trigger", label: "Trigger", icon: "zap" },
  { key: "scripts", label: "Scripts", icon: "code" },
  { key: "options", label: "Options", icon: "sliders" },
];

const TRIGGER_CARDS = [
  { value: "manual", label: "Manual", text: "Only with Run now.", iconName: "hand" },
  { value: "schedule", label: "Schedule", text: "At times or every N minutes.", iconName: "clock" },
  { value: "agent", label: "Agent status", text: "An agent is done or needs you.", iconName: "bot" },
  { value: "files", label: "Files", text: "Files in the folder change.", iconName: "file" },
  { value: "git", label: "Git", text: "A new commit or branch.", iconName: "git" },
];

const VARIABLES = [
  ["pre", "The output of the pre-script"],
  ["check", "The output of the check"],
  ["folder", "The folder of the automation"],
  ["trigger", "What fired the run"],
  ["files", "The changed files (files trigger)"],
  ["commit", "The commit (git trigger)"],
  ["branch", "The branch (git trigger)"],
  ["date", "The date and time of the run"],
  ["result_file", "Where the agent writes its result"],
  ["run_dir", "The folder of the run"],
];

/** The errors of a draft, by tab: { general: "...", ... }. */
export function errors(d) {
  const e = {};
  if (!d.name) e.general = "Write a name.";
  else if (!d.folder) e.general = "Choose a folder.";
  if (!String(d.prompt ?? "").trim()) e.prompt = "Write a prompt.";
  const tr = d.trigger;
  const t = tr.type === "schedule" ? scheduleError(tr.schedule)
    : tr.type === "agent" && !(tr.agent.statuses ?? []).length ? "Choose 1 agent status or more."
    : tr.type === "git" && !tr.git.commit && !tr.git.branch ? "Choose a git event."
    : "";
  if (t) e.trigger = t;
  return e;
}

export function editView(v, t) {
  const d = v.draft;
  const f = v.f;
  const tab = v.tab ?? "general";
  const live = v.collect();
  const errs = v.showErrors ? errors(live) : {};
  const esc = (e, cx) => { if (e.key === "escape") { v.back(cx); cx.stop_propagation(); } };
  const fld = (state, w) => U.field(t, state, { w, onKey: esc });
  const set = (fn) => (val, cx) => v.set(cx, (x) => fn(x, val));
  const flip = (fn) => (cx) => v.set(cx, fn);

  let body;
  if (tab === "general") body = general(v, t, d, f, fld, errs);
  else if (tab === "agent") body = agent(v, t, d, f, fld, set, flip);
  else if (tab === "prompt") body = prompt(v, t, d, esc, flip, errs);
  else if (tab === "trigger") body = trigger(v, t, d, f, fld, set, flip, errs);
  else if (tab === "scripts") body = scripts(v, t, d, f, fld, esc, set);
  else body = options(t, d, set);

  const tabs = TABS.map((x) => ({ ...x, error: errs[x.key] }));
  const summary = [live.agent, live.mode === "interactive" ? "tab" : "headless", U.baseName(live.folder)].filter(Boolean).join("  ·  ");
  const back = U.iconButton(t, "au-back", "back", "Back (Esc)", (cx) => v.back(cx));
  const firstError = Object.values(errs)[0] ?? "";

  return v_flex().size_full().min_h(0)
    .child(h_flex().w_full().h(62).px(16).gap(12).items_center().flex_none()
      .child(back)
      .child(div().size(34).flex_none().rounded(9).flex().items_center().justify_center().bg(U.tint(t.accent, "1f"))
        .child(svg(U.icon("zap")).size(17).text_color(t.accent)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(15).font_semibold().truncate().child(live.name || (v.isNew ? "New automation" : "(no name)")))
        .child(div().text_size(11.5).text_color(t.dim).truncate().child(summary || "Choose an agent and a folder.")))
      .child(U.toggle(t, "au-enabled", d.enabled ? "Enabled" : "Off", d.enabled, flip((x) => { x.enabled = !x.enabled; }))))
    .child(U.tabBar(t, tabs, tab, (k, cx) => { v.tab = k; cx.notify(); }))
    .child(v_flex().id(`au-form-${tab}`).flex_1().min_h(0).overflow_y_scrollbar().px(24).py(8).child(body))
    .child(h_flex().w_full().px(16).py(12).gap(8).items_center().flex_none().border_t(1).border_color(t.border).bg(t.surface)
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .when(Boolean(firstError), (el) => el
          .child(svg(U.icon("alert")).size(14).flex_none().text_color(t.blocked))
          .child(div().min_w(0).truncate().text_size(12).text_color(t.blocked).child(firstError))))
      .child(U.button(t, "au-cancel", "Cancel", (cx) => v.back(cx)))
      .child(U.button(t, "au-save", v.isNew ? "Create" : "Save", (cx) => v.save(cx), { kind: "primary", iconName: "check" })));
}

function general(v, t, d, f, fld, errs) {
  return v_flex().w_full()
    .child(U.formRow(t, "Name", "Shown in the list, the history and the toasts.", fld(f.name),
      { error: errs.general && !v.collect().name ? errs.general : null }))
    .child(U.formRow(t, "Folder", "The agent and the scripts run here. The files and git triggers watch it.",
      h_flex().gap(8).w_full().child(div().flex_1().min_w(0).child(fld(f.folder)))
        .child(U.button(t, "au-pick", "Choose…", (cx) => v.pick(cx), { iconName: "folder" })),
      { error: errs.general && v.collect().name ? errs.general : null, last: true }));
}

function agent(v, t, d, f, fld, set, flip) {
  const installed = v.agentList.filter((a) => a.installed);
  const options = (installed.length ? installed : v.agentList).map((a) => ({ value: a.key, label: a.name }));
  if (!options.some((o) => o.value === d.agent)) options.push({ value: d.agent, label: d.agent });
  const known = v.agentList.find((a) => a.key === d.agent);
  const builtin = builtinCommand(headlessKey(known ?? { key: d.agent, run: [d.agent] }));
  const spaceOptions = [{ value: null, label: "Space of the folder" }, ...spaces().slice(0, 8).map((s) => ({ value: s.id, label: s.name }))];
  const headless = d.mode !== "interactive";
  return v_flex().w_full()
    .child(U.formRow(t, "Agent", "From Herdr's list of installed agents.", U.chips(t, "au-ag", options, d.agent, set((x, val) => { x.agent = val; }))))
    .child(U.formRow(t, "Mode", headless ? "No tab. The agent runs in the background; its output goes to the history." : "A tab with the agent. You can follow the work and help the agent.",
      U.segmented(t, "au-mode", [{ value: "headless", label: "Headless" }, { value: "interactive", label: "Tab" }], d.mode, set((x, val) => { x.mode = val; }))))
    .when(headless, (el) => el.child(U.formRow(t, "Command", "Use {prompt}, {prompt_file} and {run_dir}.",
      v_flex().gap(6).w_full().child(fld(f.command))
        .child(div().text_size(11.2).text_color(t.dim).child(builtin ? `Empty: ${builtin}` : "This agent has no built-in command: write one.")))))
    .when(!headless, (el) => el
      .child(U.formRow(t, "Space", "Without a space that works in the folder, the run opens a new space.", U.chips(t, "au-sp", spaceOptions, d.space ?? null, set((x, val) => { x.space = val; }))))
      .child(U.formRow(t, "Tab at the end", "Close when OK: the agent finished and the post-script passed.",
        U.segmented(t, "au-te", [{ value: "keep", label: "Keep" }, { value: "close-ok", label: "Close when OK" }, { value: "close", label: "Close" }], d.tabEnd, set((x, val) => { x.tabEnd = val; })))))
    .child(U.formRow(t, "More arguments", "Added to the agent command. A headless agent cannot ask for permission: allow what it needs here.", fld(f.args)))
    .child(U.formRow(t, "Timeout", headless ? "After this time the agent is stopped and the run is \"timed out\"." : "After this time the run is \"timed out\". The tab stays open.",
      h_flex().gap(8).items_center().child(fld(f.timeout, 80)).child(div().text_size(12).text_color(t.muted).child("minutes")), { last: true }));
}

function prompt(v, t, d, esc, flip, errs) {
  const insert = (name) => (cx) => { v.prompt.replace(`{${name}}`); v.prompt.focus(); cx.notify(); };
  return v_flex().w_full().gap(14).py(14)
    .child(v_flex().gap(4)
      .child(div().text_size(12.5).font_medium().child("The first message to the agent"))
      .child(div().text_size(11.2).text_color(t.dim).child("Tell the agent to write its result to {result_file}: the post-script gets it.")))
    .child(U.area(t, v.prompt, esc))
    .when(Boolean(errs.prompt), (el) => el.child(h_flex().gap(5).items_center().text_size(11.2).text_color(t.blocked)
      .child(svg(U.icon("alert")).size(12).text_color(t.blocked)).child(errs.prompt)))
    .child(v_flex().gap(8)
      .child(div().text_size(11.5).font_medium().text_color(t.muted).child("Variables (click to insert)"))
      .child(h_flex().flex_wrap().gap(6).children(VARIABLES.map(([name, tip], i) => U.token(t, `au-var-${i}`, `{${name}}`, tip, insert(name))))))
    .child(div().pt(6).border_t(1).border_color(t.border)
      .child(div().pt(12).child(U.toggle(t, "au-req", "Require a result: without the result file, the run failed", d.requireResult, flip((x) => { x.requireResult = !x.requireResult; })))));
}

function trigger(v, t, d, f, fld, set, flip, errs) {
  const tr = d.trigger;
  // items_stretch: the cards get the height of the tallest one, with their content at the top.
  const cards = h_flex().w_full().gap(8).flex_wrap().items_stretch().py(14)
    .children(TRIGGER_CARDS.map((c, i) => U.choiceCard(t, `au-tc-${i}`, c, tr.type === c.value, (cx) => v.set(cx, (x) => { x.trigger.type = c.value; }))));
  let rows;
  if (tr.type === "schedule") {
    const sc = tr.schedule;
    const live = v.collect().trigger.schedule;
    const err = scheduleError(live);
    const times = err ? [] : nextTimes(live, 3, Date.now());
    const preview = err
      ? h_flex().gap(5).items_center().text_size(11.5).text_color(t.blocked).child(svg(U.icon("alert")).size(12).text_color(t.blocked)).child(err)
      : h_flex().gap(6).flex_wrap().items_center()
        .child(div().text_size(11.5).text_color(t.dim).child("Next:"))
        .children(times.map((x) => div().h(22).px(8).flex().items_center().rounded(6).bg(t.raised).border_1().border_color(t.border).text_size(11.5).child(whenText(x))));
    rows = v_flex().w_full()
      .child(U.formRow(t, "Repeat", null, U.segmented(t, "au-sk", [{ value: "interval", label: "Every N minutes" }, { value: "daily", label: "Daily" }, { value: "weekdays", label: "Days of the week" }, { value: "cron", label: "Cron" }], sc.kind, set((x, val) => { x.trigger.schedule.kind = val; }))))
      .when(sc.kind === "interval", (el) => el.child(U.formRow(t, "Every", "Counted from the last run.", h_flex().gap(8).items_center().child(fld(f.minutes, 80)).child(div().text_size(12).text_color(t.muted).child("minutes")))))
      .when(sc.kind === "daily" || sc.kind === "weekdays", (el) => el.child(U.formRow(t, "Time", "Local time, HH:MM.", fld(f.time, 100))))
      .when(sc.kind === "weekdays", (el) => el.child(U.formRow(t, "Days", null, U.chips(t, "au-days", DAY_NAMES.map((n, i) => ({ value: i, label: n })), sc.days, set((x, val) => {
        const days = new Set(x.trigger.schedule.days ?? []);
        if (days.has(val)) days.delete(val); else days.add(val);
        x.trigger.schedule.days = [...days].sort();
      }), { multi: true }))))
      .when(sc.kind === "cron", (el) => el.child(U.formRow(t, "Cron", "minute hour day month weekday. Example: 0 9 * * 1-5", fld(f.cron))))
      .child(U.formRow(t, "When", null, preview))
      .child(U.formRow(t, "Catch up", "If Herdr was closed at a due time, run 1 time when it opens. Else skip the missed time.",
        U.toggle(t, "au-catch", d.catchUp ? "On" : "Off", d.catchUp, flip((x) => { x.catchUp = !x.catchUp; })), { last: true }));
  } else if (tr.type === "agent") {
    rows = v_flex().w_full()
      .child(U.formRow(t, "Status", "Agents that an automation started never fire this trigger.", U.chips(t, "au-as", [{ value: "done", label: "Done" }, { value: "blocked", label: "Needs you" }], tr.agent.statuses, set((x, val) => {
        const s = new Set(x.trigger.agent.statuses ?? []);
        if (s.has(val)) s.delete(val); else s.add(val);
        x.trigger.agent.statuses = [...s];
      }), { multi: true }), { error: errs.trigger }))
      .child(U.formRow(t, "Where", null, U.segmented(t, "au-any", [{ value: false, label: "In the folder" }, { value: true, label: "Any folder" }], !!tr.agent.anyFolder, set((x, val) => { x.trigger.agent.anyFolder = val; }))))
      .child(U.formRow(t, "Agent app", "Optional. Part of the app name, for example claude or codex.", fld(f.app, 240), { last: true }));
  } else if (tr.type === "files") {
    rows = v_flex().w_full()
      .child(U.formRow(t, "Files", "Optional globs, separated by commas. Empty: every file.", fld(f.glob)))
      .child(U.formRow(t, "How", null, div().text_size(11.5).text_color(t.dim).child("The run starts after 5 s without changes. Changes in .git, during a run of this automation and 10 s after it are ignored."), { last: true }));
  } else if (tr.type === "git") {
    rows = v_flex().w_full()
      .child(U.formRow(t, "Events", "Checked every 30 s.", h_flex().gap(20)
        .child(U.toggle(t, "au-gc", "New commit", tr.git.commit, flip((x) => { x.trigger.git.commit = !x.trigger.git.commit; })))
        .child(U.toggle(t, "au-gb", "Branch change", tr.git.branch, flip((x) => { x.trigger.git.branch = !x.trigger.git.branch; }))), { error: errs.trigger, last: true }));
  } else {
    rows = div().py(14).text_size(12).text_color(t.dim).child("This automation runs only when you click Run now, or with herdr-app do automations.run-<id>.");
  }
  return v_flex().w_full().child(cards).child(div().w_full().border_t(1).border_color(t.border)).child(rows);
}

const SCRIPT_KINDS = [
  { value: "none", label: "None" },
  { value: "file", label: "Script file", tip: "The path of a script file, from the folder of the automation." },
  { value: "inline", label: "Inline script", tip: "The commands, written here. 1 or more lines." },
];

function scripts(v, t, d, f, fld, esc, set) {
  const shell = isWin() ? "PowerShell" : "Bash";
  const cmd = (k) => {
    const kind = d[k].kind;
    const sf = v.scriptFields[k];
    const timeout = h_flex().gap(6).items_center().flex_none()
      .child(div().text_size(11.5).text_color(t.muted).child("Timeout"))
      .child(fld(f[`${k}T`], 56)).child(div().text_size(11.5).text_color(t.muted).child("s"));
    const kinds = h_flex().w_full().gap(12).items_center().flex_wrap()
      .child(U.segmented(t, `au-sk-${k}`, SCRIPT_KINDS, kind, set((x, val) => { x[k].kind = val; })))
      .when(kind !== "none", (el) => el.child(div().flex_1()).child(timeout));
    const hint = (text) => div().text_size(11).text_color(t.dim).child(text);
    return v_flex().gap(8).w_full()
      .child(kinds)
      .when(kind === "file", (el) => el
        .child(fld(sf.file))
        .child(hint(".ps1 runs with PowerShell, .sh with bash, .py with python, .js with node. A relative path starts at the folder of the automation.")))
      .when(kind === "inline", (el) => el
        .child(U.area(t, sf.inline, esc).font_family(U.mono()))
        .child(hint(`${shell} commands, 1 or more lines. They run in the folder of the automation.`)));
  };
  const on = (k) => d[k].kind !== "none";
  // Elements are single-use: a new arrow each time.
  const arrow = () => h_flex().w_full().pl(21).h(18).items_center().child(svg(U.icon("arrow-down")).size(12).text_color(t.dim));
  const agentStep = h_flex().w_full().gap(14).items_center().px(14).py(10).rounded(10).border_1().border_color(t.border).bg(U.tint(t.accent, "10"))
    .child(div().size(26).flex_none().rounded(13).flex().items_center().justify_center().bg(U.tint(t.accent, "26"))
      .child(svg(U.icon("bot")).size(14).text_color(t.accent)))
    .child(div().text_size(12.5).font_semibold().child("The agent runs the prompt"));
  return v_flex().w_full().gap(0).py(14)
    .child(div().pb(12).text_size(11.5).text_color(t.dim).child("For each step, choose a script file or write an inline script. The timeout is in seconds (max 600). The scripts get the variables as HERDR_AUTO_* environment variables."))
    .child(U.stepCard(t, 1, "Check", "Exit code 0 runs. Other codes skip the run; the output is the reason.", cmd("check"), on("check")))
    .child(arrow())
    .child(U.stepCard(t, 2, "Pre-script", "Its output goes to {pre}. A failure cancels the run.", cmd("pre"), on("pre")))
    .child(arrow())
    .child(agentStep)
    .child(arrow())
    .child(U.stepCard(t, 3, "Post-script", "Gets HERDR_AUTO_STATUS, HERDR_AUTO_RESULT, HERDR_AUTO_RESULT_FILE and HERDR_AUTO_OUTPUT_FILE. A failure makes the run failed.", cmd("post"), on("post")));
}

function options(t, d, set) {
  return v_flex().w_full()
    .child(U.formRow(t, "During a run", "What happens when the trigger fires and the last run did not end.",
      U.segmented(t, "au-ov", [{ value: "skip", label: "Skip" }, { value: "queue", label: "Queue 1" }, { value: "parallel", label: "Run in parallel" }], d.overlap, set((x, val) => { x.overlap = val; }))))
    .child(U.formRow(t, "Notifications", "Failures also include an agent that needs you.",
      U.segmented(t, "au-nt", [{ value: "failures", label: "Failures" }, { value: "skips", label: "Failures and skips" }, { value: "all", label: "All" }, { value: "never", label: "Never" }], d.notify, set((x, val) => { x.notify = val; })), { last: true }));
}
