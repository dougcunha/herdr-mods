// The form of an action: name, icon, script (inline or a file), where it runs, ask before run,
// filter, and a preview of the script with the values of the target terminal. `v` is the View of
// main.js: it holds the draft (`v.draft`), the text fields (`v.f`, `v.script`) and the actions.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { ICONS } from "./store.js";
import { VARIABLES } from "./vars.js";
import { howText } from "./run.js";
import * as U from "./ui.js";

/** The errors of a draft: { name?, script?, file? }. */
export function errors(d) {
  const e = {};
  if (!d.name.trim()) e.name = "Write a name.";
  if (d.source === "file" && !d.file.trim()) e.file = "Write the path of a .ps1 or .sh file.";
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
  else if (p.error) body = h_flex().gap(6).items_center().text_size(11.5).text_color(p.filtered || p.info ? t.muted : t.blocked)
    .child(svg(U.icon("alert")).size(12).flex_none().text_color(p.filtered || p.info ? t.muted : t.blocked)).child(p.error);
  else body = v_flex().gap(6).w_full()
    .child(div().text_size(11.2).text_color(t.dim).child(howText(p)))
    .child(div().id("qa-preview").w_full().max_h(150).overflow_y_scrollbar().p(8).rounded(7).bg(t.background)
      .border_1().border_color(t.border).font_family(U.mono()).text_size(11).text_color(t.foreground).whitespace_normal()
      .child(p.expanded));
  return body;
}

export function editView(v, t) {
  const d = v.draft;
  const live = v.collect();
  const errs = v.showErrors ? errors(live) : {};
  const esc = (e, cx) => v.fieldKey(e, cx);
  const fld = (state, w) => U.field(t, state, { w, onKey: esc });
  const insert = (name) => (cx) => { v.script.replace(`{${name}}`); v.script.focus(); cx.notify(); };
  const firstError = Object.values(errs)[0] ?? "";

  const scriptControl = v_flex().gap(8).w_full()
    .child(U.segmented(t, "qa-src", [{ value: "inline", label: "Inline" }, { value: "file", label: "Script file" }], d.source,
      (val, cx) => v.set(cx, (x) => { x.source = val; })))
    .when(d.source === "inline", (el) => el
      .child(U.area(t, v.script, esc).font_family(U.mono()))
      .child(h_flex().flex_wrap().gap(5).children(VARIABLES.map(([name, tip], i) => U.token(t, `qa-var-${i}`, `{${name}}`, tip, insert(name))))))
    .when(d.source === "file", (el) => el.child(fld(v.f.file)));

  const body = v_flex().w_full()
    .child(U.formRow(t, "Name", "Shown in the list and on the button.", fld(v.f.name), { error: errs.name }))
    .child(U.formRow(t, "Icon", null, iconPicker(v, t, d)))
    .child(U.formRow(t, "Script",
      d.source === "inline"
        ? "PowerShell on Windows. A click on a variable inserts it. Its value comes in quotes: write cd {repo}, not cd \"{repo}\"."
        : "A .ps1 or .sh file (~ is your home folder). The variables in the file get their values too.",
      scriptControl, { error: errs.script ?? errs.file }))
    .child(U.formRow(t, "Preview", "The script with the values of the terminal that has the focus now.", preview(v, t)))
    .child(U.formRow(t, "Where it runs", "Terminal: the terminal that has the focus. When it runs an agent or a program, a new tab in the same folder.",
      U.segmented(t, "qa-where", [{ value: "terminal", label: "Terminal" }, { value: "tab", label: "New tab" }], d.where,
        (val, cx) => v.set(cx, (x) => { x.where = val; }))))
    .child(U.formRow(t, "Ask before run", "Shows the script and asks before it runs.",
      U.toggle(t, "qa-confirm", d.confirm ? "On" : "Off", d.confirm, (cx) => v.set(cx, (x) => { x.confirm = !x.confirm; }))))
    .child(U.formRow(t, "Bar button", "A button with the name and the icon in the bar of the Dock and Kanban layouts. With Only in, it shows only there.",
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
      .child(!p ? div().text_size(11.5).text_color(t.dim).child("Reading the terminal…")
        : p.error ? h_flex().gap(6).items_center().text_size(12).text_color(t.blocked)
          .child(svg(U.icon("alert")).size(13).flex_none().text_color(t.blocked)).child(p.error)
        : div().w_full().p(10).rounded(7).bg(t.background).border_1().border_color(t.border)
          .font_family(U.mono()).text_size(11.5).text_color(t.foreground).whitespace_normal().child(p.expanded)))
    .child(h_flex().w_full().px(16).py(12).gap(8).items_center().justify_end().flex_none().border_t(1).border_color(t.border).bg(t.surface)
      .child(U.button(t, "qa-no", "Cancel", (cx) => (v.props.confirm ? v.close_() : v.back(cx))))
      .child(U.button(t, "qa-yes", "Run", (cx) => v.confirmRun(cx), { kind: "primary", iconName: "play", disabled: !p || Boolean(p.error) || Boolean(v.running) })));
}
