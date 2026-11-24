// The form of an action: name, icon, script (inline or a file), where it runs, ask before run,
// filter, and a preview of the script with the values of the target terminal. `v` is the View of
// main.js: it holds the draft (`v.draft`), the text fields (`v.f`, `v.script`) and the actions.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { ICONS, SHELLS, SHELL_LABEL } from "./store.js";
import { VARIABLES } from "./vars.js";
import { howText } from "./run.js";
import { writerPath, shortPath, headlessOf } from "./writer.js";
import { jobOf, isRunning } from "./jobs.js";
import { jobState } from "./output.js";
import * as U from "./ui.js";

/** The errors of a draft: { name?, script?, file? }. */
export function errors(d) {
  const e = {};
  if (!d.name.trim()) e.name = "Write a name.";
  if (d.source === "file" && !d.file.trim()) e.file = "Write the path of a script file, or click Write with an agent….";
  if (d.source === "inline" && !d.script.trim()) e.script = "Write the script.";
  return e;
}

function iconPicker(v, t, d) {
  return h_flex().flex_wrap().gap(4).children(ICONS.map((name, i) => {
    const on = d.icon === name;
    return div().id(`qa-icon-${i}`).size(30).flex().items_center().justify_center().rounded(7).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.border).bg(on ? U.tint(t.accent, "22") : t.background)
      .hover((s) => s.bg(t.hover)).tooltip(name)
      .on_click((_e, cx) => v.set(cx, (x) => { x.icon = name; }))
      .child(svg(U.icon(name)).size(15).text_color(on ? t.accent : t.muted));
  }));
}

function preview(v, t) {
  const p = v.preview;
  let body;
  if (!p) body = div().text_size(11.5).text_color(t.dim).child("Reading the terminal…");
  else if (p.error) body = U.errorLine(t, p.error, p.filtered || p.info ? t.muted : t.blocked);
  else body = v_flex().gap(6).w_full()
    .child(div().text_size(11.2).text_color(t.dim).child(howText(p)))
    .child(div().id("qa-preview").w_full().max_h(150).overflow_y_scrollbar().p(8).rounded(7).bg(t.background)
      .border_1().border_color(t.border).font_family(U.mono()).text_size(11).text_color(t.foreground).whitespace_normal()
      .child(p.expanded));
  return body;
}

/** The "with an agent" panel: what the script must do, the agent, Start. */
function writerPanel(v, t) {
  const w = v.writer;
  const installed = v.agentList.filter((a) => a.installed);
  const path = shortPath(writerPath(v.collect(), v.list));
  const agent = installed.find((a) => a.key === w.agent) ?? null;
  return v_flex().w_full().gap(8).p(12).rounded(8).border_1().border_color(t.input).bg(t.surface)
    .child(div().text_size(12).font_medium().text_color(t.foreground).child(w.mode === "edit" ? "What must change in the script?" : "What must the script do?"))
    .child(U.area(t, w.desc, (e, cx) => v.fieldKey(e, cx)))
    .child(installed.length
      ? U.segmented(t, "qa-agent", installed.map((a) => ({ value: a.key, label: a.name })), w.agent, (val, cx) => { w.agent = val; cx.notify(); })
      : div().text_size(11.5).text_color(t.blocked).child("No agent is installed."))
    .child(U.segmented(t, "qa-agent-where", [
      { value: "tab", label: "In a tab", tip: "You see the agent and can help it" },
      { value: "background", label: "In the background", tip: "No tab: a toast shows the end" },
    ], w.where, (val, cx) => { w.where = val; w.error = ""; cx.notify(); }))
    .child(div().text_size(11).text_color(t.dim).child(w.where === "background"
      ? (agent && !headlessOf(agent)
        ? `${agent.name} has no background mode. Choose In a tab, or another agent.`
        : `Start saves the action with this script file. Then the agent writes ${path} in the background. It cannot ask you anything, so it works with the permissions of its background mode (see the README: OpenCode gets all of them). A toast shows when it ends, and the preview shows the script.`)
      : `Start saves the action with this script file. Then the agent writes ${path} in a new tab of this space (a new space on this computer when this space is on another machine). Run the action when it is done.`))
    .when(Boolean(w.error), (e) => e.child(U.errorLine(t, w.error)))
    .child(h_flex().gap(8)
      .child(U.button(t, "qa-agent-go", w.busy ? "Starting…" : "Start", (cx) => v.runWriter(cx), { kind: "primary", iconName: "sparkles", disabled: !installed.length || Boolean(w.busy) }))
      .child(U.button(t, "qa-agent-cancel", "Cancel", (cx) => { v.writer = null; cx.notify(); })));
}

export function editView(v, t) {
  const d = v.draft;
  const live = v.collect();
  const errs = v.showErrors ? errors(live) : {};
  const esc = (e, cx) => v.fieldKey(e, cx);
  const fld = (state, w) => U.field(t, state, { w, onKey: esc });
  const insert = (name) => (cx) => { v.script.replace(`{${name}}`); v.script.focus(); cx.notify(); };
  const firstError = Object.values(errs)[0] ?? "";

  // An agent can write the script in both modes: the action then uses the file that the agent writes.
  const fileThere = d.source === "file" && v.fileText != null;
  // An agent that writes the script in the background: its state, Output and Stop.
  const wj = v.demo ? null : jobOf("write", d.id);
  const writing = isRunning(wj);
  const st = writing ? jobState(t, wj) : null;
  const writingRow = writing ? h_flex().w_full().gap(8).items_center().p(10).rounded(8).border_1().border_color(U.tint(st.color, "55")).bg(U.tint(st.color, "12"))
    .child(svg(U.icon("refresh")).size(13).flex_none().spin(900).text_color(st.color))
    .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.foreground).child(`${wj.agentName ?? "The agent"} writes the script in the background · ${st.text}`))
    .child(U.button(t, "qa-agent-out", "Output", (cx) => v.openOutput(cx, "write", d)))
    .child(U.button(t, "qa-agent-stop", "Stop", (cx) => v.stopJobOf(cx, "write", d), { kind: "danger", iconName: "close" })) : null;
  const agentButtons = h_flex().gap(8)
    .child(U.button(t, "qa-agent-new", fileThere ? "Write a new one with an agent…" : "Write with an agent…", (cx) => v.openWriter(cx, "new"),
      { iconName: "sparkles", tip: "An agent writes the script file from your description" }))
    .when(fileThere, (e) => e.child(U.button(t, "qa-agent-edit", "Change with an agent…", (cx) => v.openWriter(cx, "edit"), { iconName: "pencil" })));
  const scriptControl = v_flex().gap(8).w_full()
    .child(U.segmented(t, "qa-src", [{ value: "inline", label: "Inline" }, { value: "file", label: "Script file" }], d.source,
      (val, cx) => v.set(cx, (x) => { x.source = val; })))
    .when(d.source === "inline", (el) => el
      .child(U.area(t, v.script, esc).font_family(U.mono()))
      .child(h_flex().flex_wrap().gap(5).children(VARIABLES.map(([name, tip], i) => U.token(t, `qa-var-${i}`, `{${name}}`, tip, insert(name))))
        .child(U.token(t, "qa-var-ask", "{ask:Name}", "Asks the person for a value before the run. {ask:Name=default} gives a default.", (cx) => { v.script.replace("{ask:Name}"); v.script.focus(); cx.notify(); }))))
    .when(d.source === "file", (el) => el.child(
      h_flex().gap(8).w_full()
        .child(div().flex_1().min_w(0).child(fld(v.f.file)))
        .child(U.button(t, "qa-pick-file", "Choose…", (cx) => v.pickFile(cx), { iconName: "file" })),
    ))
    .child(writing ? writingRow : v.writer ? writerPanel(v, t) : agentButtons);

  const body = v_flex().w_full()
    .child(U.formRow(t, "Name", "Shown in the list and on the button.", fld(v.f.name), { error: errs.name }))
    .child(U.formRow(t, "Icon", null, iconPicker(v, t, d)))
    .child(U.formRow(t, "Script",
      d.source === "inline"
        ? "A click on a variable inserts it. Its value comes in quotes (a string in Python and Node.js): write cd {repo}, not cd \"{repo}\"."
        : "A .ps1, .sh, .py or .js file (~ is your home folder). The variables in the file get their values too.",
      scriptControl, { error: errs.script ?? errs.file }))
    .child(U.formRow(t, "Shell",
      d.source === "file"
        ? "Auto: the extension of the file. Python runs with python (python3 on macOS and Linux), Node.js with node, bash with Git Bash on Windows."
        : "Auto: the shell of the terminal (PowerShell on Windows). Another shell, Python and Node.js run the script from a file.",
      U.segmented(t, "qa-shell", SHELLS.map((s) => ({ value: s, label: SHELL_LABEL[s] })), d.shell,
        (val, cx) => v.set(cx, (x) => { x.shell = val; }))))
    .child(U.formRow(t, "Preview", "The script with the values of the terminal that has the focus now.", preview(v, t)))
    .child(U.formRow(t, "Where it runs",
      "Terminal: the terminal that has the focus (a new tab in the same folder when it runs an agent or a program). Background: no terminal on the screen; a toast shows the end, and the list shows the output. A background job cannot answer a question (a password, Read-Host): it stops after the timeout of the settings.",
      U.segmented(t, "qa-where", [{ value: "terminal", label: "Terminal" }, { value: "tab", label: "New tab" }, { value: "background", label: "Background" }], d.where,
        (val, cx) => v.set(cx, (x) => { x.where = val; }))))
    .child(U.formRow(t, "Ask before run", "Shows the script and asks before it runs.",
      U.toggle(t, "qa-confirm", d.confirm ? "On" : "Off", d.confirm, (cx) => v.set(cx, (x) => { x.confirm = !x.confirm; }))))
    .child(U.formRow(t, "In the Actions menu", "An item with the name and the icon in the Actions menu of the bar of the Dock and Kanban layouts. With Only in, it shows only there.",
      U.toggle(t, "qa-pinned", d.pinned ? "On" : "Off", d.pinned, (cx) => v.set(cx, (x) => { x.pinned = !x.pinned; }))))
    .child(U.formRow(t, "Only in", "Folders (and the folders in them) or repository names, separated by commas. * works. Empty: everywhere.",
      fld(v.f.filter)))
    .child(U.formRow(t, "Key", "Add this action to keys.json, for example:",
      div().text_size(11.5).font_family(U.mono()).text_color(t.muted).child(`"ctrl-shift-1": "quick-actions.run-${d.id}"`), { last: true }));

  const back = U.iconButton(t, "qa-back", "back", "Back (Backspace)", (cx) => v.back(cx));
  return v_flex().size_full().min_h(0)
    .child(h_flex().w_full().h(58).px(16).gap(12).items_center().flex_none().border_b(1).border_color(t.border)
      .child(back)
      .child(div().size(32).flex_none().rounded(9).flex().items_center().justify_center().bg(U.tint(t.accent, "1f"))
        .child(svg(U.icon(d.icon)).size(16).text_color(t.accent)))
      .child(div().flex_1().min_w(0).text_size(15).font_semibold().truncate().child(live.name || (v.isNew ? "New action" : "(no name)")))
      .when(Boolean(U.closeX(t)), (e) => e.child(U.closeX(t))))
    .child(v_flex().id("qa-form").flex_1().min_h(0).overflow_y_scrollbar().px(24).py(4).child(body))
    .child(h_flex().w_full().px(16).py(12).gap(8).items_center().flex_none().border_t(1).border_color(t.border).bg(t.surface)
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .when(Boolean(firstError), (el) => el
          .child(svg(U.icon("alert")).size(14).flex_none().text_color(t.blocked))
          .child(div().min_w(0).truncate().text_size(12).text_color(t.blocked).child(firstError))))
      .child(U.button(t, "qa-cancel", "Cancel", (cx) => v.back(cx)))
      .child(U.button(t, "qa-save", v.isNew ? "Create" : "Save", (cx) => v.save(cx), { kind: "primary", iconName: "check" })));
}

/** The question before a run (an action with "Ask before run"). */
export function confirmView(v, t) {
  const a = v.confirmAction;
  const p = v.preview;
  return v_flex().size_full().min_h(0)
    .child(h_flex().w_full().h(58).px(16).gap(12).items_center().flex_none().border_b(1).border_color(t.border)
      .child(div().size(32).flex_none().rounded(9).flex().items_center().justify_center().bg(U.tint(t.accent, "1f"))
        .child(svg(U.icon(a?.icon ?? "zap")).size(16).text_color(t.accent)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(15).font_semibold().truncate().child(a ? `Run ${a.name}?` : v.loaded ? "The action is gone." : "Reading…"))
        .child(div().text_size(11.5).text_color(t.dim).truncate().child(p && !p.error ? howText(p) : "")))
      .when(Boolean(U.closeX(t)), (e) => e.child(U.closeX(t))))
    .child(v_flex().id("qa-confirm-body").flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(8)
      .when(Boolean(v.askFields?.length), (el) => el.child(v_flex().w_full().gap(10).pb(6)
        .children(v.askFields.map((f) => v_flex().w_full().gap(4)
          .child(div().text_size(11.5).font_medium().text_color(t.muted).child(f.label))
          .child(U.field(t, f.state, { onKey: (e, cx) => v.askKey(e, cx) }))))))
      .child(!p ? div().text_size(11.5).text_color(t.dim).child("Reading the terminal…")
        : p.error ? U.errorLine(t, p.error)
        : div().w_full().p(10).rounded(7).bg(t.background).border_1().border_color(t.border)
          .font_family(U.mono()).text_size(11.5).text_color(t.foreground).whitespace_normal().child(p.expanded)))
    .child(h_flex().w_full().px(16).py(12).gap(8).items_center().justify_end().flex_none().border_t(1).border_color(t.border).bg(t.surface)
      .child(U.button(t, "qa-no", "Cancel", (cx) => (v.props.confirm ? v.close_() : v.back(cx))))
      .child(U.button(t, "qa-yes", "Run", (cx) => v.confirmRun(cx), { kind: "primary", iconName: "play", disabled: !p || Boolean(p.error) || Boolean(v.running) })));
}
