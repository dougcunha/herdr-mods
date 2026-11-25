// Guided "+ New Binding" view with 4 action modes:
//   1. Command (built-in Herdr command + optional shorthand or JSON args)
//   2. Mod Command (<mod>.<command> or mod.open:<mod>)
//   3. Send Text (send:<text> with common terminal escape presets)
//   4. Pass to Terminal ("terminal")

import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";
import { commands, layouts } from "herdr";
import {
  SEND_PRESETS, sectionLabel, unescapeSendInput, escapeForDisplay, prettyChord, analyzeConflict,
} from "./model.js";
import * as U from "./ui.js";

const MODES = [
  { value: "command", label: "Command", tip: "Bind a built-in Herdr command" },
  { value: "mod", label: "Mod Command", tip: "Open a mod or send a command to a mod" },
  { value: "send", label: "Send Text", tip: "Type text or escape sequences into the terminal" },
  { value: "terminal", label: "Pass to Terminal", tip: "Forward a key directly to the terminal program" },
];

/** Validates and builds the ActionSpec from the current form state: { action?, error? }. */
export function resolveFormAction(v) {
  const f = v.newForm;
  if (!f) return { error: "Form is not ready." };
  if (f.mode === "terminal") return { action: "terminal" };
  if (f.mode === "send") {
    const raw = v.formInputs.send.value();
    const unescaped = unescapeSendInput(raw);
    if (!unescaped) return { error: "Enter text or pick a sequence preset to send." };
    return { action: `send:${unescaped}` };
  }
  if (f.mode === "mod") {
    const modName = (f.modName || v.formInputs.modName.value()).trim();
    if (!modName) return { error: "Pick or enter a mod name." };
    if (f.modKind === "open") return { action: `mod.open:${modName}` };
    const cmd = v.formInputs.modCmd.value().trim();
    if (!cmd) return { error: "Enter the mod command name (for example: open or refresh)." };
    return { action: `${modName}.${cmd}` };
  }
  // mode === "command"
  const cmd = f.command;
  if (!cmd) return { error: "Select a Herdr command from the list." };
  const argRaw = v.formInputs.cmdArgs.value().trim();
  if (!argRaw) return { action: cmd };
  if (argRaw.startsWith("{")) {
    try {
      const parsed = JSON.parse(argRaw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: "JSON arguments must be an object like {\"id\": \"sidebar\"}." };
      }
      return { action: { command: cmd, args: parsed } };
    } catch (e) {
      return { error: `Invalid JSON arguments: ${e?.message ?? e}` };
    }
  }
  return { action: `${cmd}:${argRaw}` };
}

/** Available section options for the target selector (global, terminal, layouts, existing sections, and selected mod). */
function sectionChoices(v) {
  const secs = new Set(["global", "terminal"]);
  for (const l of layouts() ?? []) secs.add(`layout:${l}`);
  for (const s of Object.keys(v.sections ?? {})) secs.add(s);
  if (v.newForm?.mode === "mod" && v.newForm?.modName) secs.add(`mod:${v.newForm.modName}`);
  return [...secs];
}

function formRow(t, label, hint, control, { error = null, last = false } = {}) {
  return h_flex().w_full().gap(16).py(8).items_start()
    .when(!last, (el) => el.border_b(1).border_color(t.border))
    .child(v_flex().w(170).flex_none().gap(2).pt(4)
      .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(label))
      .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).whitespace_normal().child(hint))))
    .child(v_flex().flex_1().min_w(0).gap(6).items_start()
      .child(control)
      .when(Boolean(error), (el) => el.child(h_flex().gap(5).items_center().text_size(11.2).text_color(t.blocked)
        .child(svg(U.icon("alert")).size(12).flex_none().text_color(t.blocked))
        .child(div().whitespace_normal().child(error)))));
}

function inputBox(t, state, onKey, { monoFont = false } = {}) {
  let inner = Input.new(state).h(30).w_full().px(9).rounded(7).border_1().border_color(t.input).bg(t.background)
    .text_size(12).text_color(t.foreground);
  if (monoFont) inner = inner.font_family(U.mono());
  if (!onKey) return inner;
  return div().w_full().on_key_down(onKey).child(inner);
}

/** Renders the conflict/warning notice for the recorded chord in the New Binding form. */
export function renderFormConflict(v, t, report) {
  if (!report) return null;
  const hasSame = Boolean(report.sameSection);
  const hasCross = report.crossSection.length > 0;
  const hasWarn = report.warnings.length > 0;
  if (!hasSame && !hasCross && !hasWarn) return null;

  const lines = [];
  if (hasSame) {
    lines.push(`Already bound in ${sectionLabel(v.newForm.section)} to "${report.sameSection.otherAction}". Saving will replace it.`);
  }
  for (const cs of report.crossSection) {
    const verb = cs.relation === "shadowed_by" ? "Shadowed by" : "Overrides";
    lines.push(`${verb} ${sectionLabel(cs.section)} ("${typeof cs.otherAction === "string" ? cs.otherAction : cs.otherAction.command}").`);
  }
  if (report.warnings.includes("terminal_key")) {
    lines.push("Terminal programs rely on this Ctrl+letter key; binding it prevents it from reaching the shell.");
  }
  if (report.warnings.includes("altgr")) {
    lines.push("Ctrl+Alt combinations act as AltGr on Windows international keyboards.");
  }

  const danger = hasSame || hasWarn;
  const color = danger ? t.blocked : t.ansi3;
  return v_flex().w_full().gap(4).p(9).rounded(7).bg(U.tint(color, "14")).border_1().border_color(U.tint(color, "55"))
    .children(lines.map((msg) => h_flex().gap(6).items_start().text_size(11.5).text_color(t.foreground)
      .child(svg(U.icon(danger ? "alert" : "shield")).size(13).flex_none().text_color(color))
      .child(div().flex_1().min_w(0).whitespace_normal().child(msg))));
}

export function renderNewForm(v, t) {
  const f = v.newForm;
  const esc = (e, cx) => {
    if (e.key === "escape") { v.closeForm(cx); cx.stop_propagation(); }
  };
  const resolved = resolveFormAction(v);
  const allCmds = commands() ?? [];
  const cmdQ = v.formInputs.cmdSearch.value().trim().toLowerCase();
  const filteredCmds = cmdQ
    ? allCmds.filter((c) => c.name.toLowerCase().includes(cmdQ) || c.about?.toLowerCase().includes(cmdQ))
    : allCmds;
  const pickedCmd = allCmds.find((c) => c.name === f.command) ?? null;

  const allSections = sectionChoices(v);
  const quickSecs = ["global", "terminal", ...allSections.filter((s) => s !== "global" && s !== "terminal")];

  const report = f.chord ? analyzeConflict(v.sections, f.section, f.chord, {
    targetAction: resolved.action ?? null,
    platform: v.platform,
  }) : null;

  const canSave = !resolved.error && Boolean(f.chord) && !v.saving;

  const actionControl = () => {
    if (f.mode === "terminal") {
      return div().p(10).w_full().rounded(7).bg(t.background).border_1().border_color(t.border).text_size(12).text_color(t.muted)
        .whitespace_normal()
        .child("Binds the action \"terminal\". Useful in the terminal section to return a shortcut (such as ctrl-1) to your shell, tmux, or editor.");
    }
    if (f.mode === "send") {
      const preview = unescapeSendInput(v.formInputs.send.value());
      return v_flex().w_full().gap(8)
        .child(h_flex().flex_wrap().gap(5).children(SEND_PRESETS.map((p) =>
          U.button(t, `kb-preset-${p.id}`, p.label, (cx) => {
            v.formInputs.send.set_value(p.display);
            cx.notify();
          }, { h: 24, tip: `Send ${p.display}` }))))
        .child(inputBox(t, v.formInputs.send, esc, { monoFont: true }))
        .when(Boolean(preview), (el) => el.child(div().text_size(11).text_color(t.dim)
          .child(`Action string: send:${escapeForDisplay(preview)}`)));
    }
    if (f.mode === "mod") {
      return v_flex().w_full().gap(8)
        .child(U.segmented(t, "kb-mod-kind", [
          { value: "open", label: "Open mod (mod.open:<name>)" },
          { value: "cmd", label: "Run mod command (<mod>.<cmd>)" },
        ], f.modKind, (val, cx) => { f.modKind = val; v.focusRoot(cx); cx.notify(); }))
        .child(h_flex().w_full().flex_wrap().gap(4).children((v.modNames ?? []).slice(0, 18).map((m) => {
          const on = f.modName === m;
          return h_flex().id(`kb-mod-chip-${m}`).h(23).px(8).items_center().rounded(6).cursor_pointer().text_size(11.5)
            .bg(on ? U.tint(t.accent, "24") : t.background).border_1().border_color(on ? t.accent : t.border)
            .text_color(on ? t.accent : t.muted).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { f.modName = m; v.formInputs.modName.set_value(m); v.focusRoot(cx); cx.notify(); })
            .child(m);
        })))
        .child(inputBox(t, v.formInputs.modName, esc))
        .when(f.modKind === "cmd", (el) => el.child(inputBox(t, v.formInputs.modCmd, esc, { monoFont: true })));
    }
    // command
    return v_flex().w_full().gap(8)
      .child(inputBox(t, v.formInputs.cmdSearch, esc))
      .child(v_flex().id("kb-cmd-picker").w_full().h(86).rounded(7).bg(t.background).border_1().border_color(t.border)
        .overflow_y_scrollbar()
        .children(filteredCmds.slice(0, 80).map((c) => {
          const on = f.command === c.name;
          return h_flex().id(`kb-cmd-opt-${c.name}`).w_full().px(9).py(6).gap(8).items_center().cursor_pointer()
            .bg(on ? t.selected : "#00000000").hover((s) => s.bg(on ? t.selected : t.hover))
            .on_click((_e, cx) => { f.command = c.name; v.focusRoot(cx); cx.notify(); })
            .child(div().w(165).flex_none().font_family(U.mono()).text_size(11.5).font_semibold()
              .text_color(on ? t.accent : t.foreground).truncate().child(c.name))
            .child(div().flex_1().min_w(0).text_size(11.2).text_color(t.dim).truncate().child(c.about || ""));
        }))
        .when(!filteredCmds.length, (el) => el.child(div().p(10).text_size(11.5).text_color(t.dim).child("No matching command."))))
      .when(Boolean(pickedCmd), (el) => {
        const rawAbout = pickedCmd.about || "";
        const about = rawAbout.length > 130 ? `${rawAbout.slice(0, 129)}…` : rawAbout;
        const argsHint = pickedCmd.args?.length ? ` · Args: ${pickedCmd.args.map((a) => a.name + (a.required ? "*" : "")).join(", ")}` : "";
        return el
          .child(div().text_size(11.2).text_color(t.muted).whitespace_normal().child(`${about}${argsHint}`))
          .child(inputBox(t, v.formInputs.cmdArgs, esc, { monoFont: true }));
      });
  };

  const recorderControl = v_flex().w_full().gap(8)
    .child(h_flex().gap(8).items_center()
      .when(f.recording, (el) => el.child(h_flex().h(30).px(12).gap(8).items_center().rounded(7)
        .bg(U.tint(t.accent, "20")).border_1().border_color(t.accent)
        .child(svg(U.icon("record")).size(13).text_color(t.accent))
        .child(div().text_size(12).font_semibold().text_color(t.accent).child("Press shortcut keys now… (Esc to cancel)"))
        .child(U.button(t, "kb-new-rec-cancel", "Cancel", (cx) => { f.recording = false; f.blockedMsg = null; cx.notify(); }, { h: 22 }))))
      .when(!f.recording, (el) => el.child(h_flex().gap(8).items_center()
        .when(Boolean(f.chord), (x) => x.child(U.staticKeycaps(t, f.chord, v.platform)))
        .when(!f.chord, (x) => x.child(div().text_size(12).text_color(t.dim).child("No shortcut recorded yet")))
        .child(U.button(t, "kb-new-rec", f.chord ? "Re-record…" : "Press to record…", (cx) => v.startFormRecord(cx),
          { kind: f.chord ? "plain" : "primary", iconName: "record" })))))
    .when(Boolean(f.blockedMsg), (el) => el.child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.blocked)
      .child(svg(U.icon("alert")).size(12).text_color(t.blocked))
      .child(f.blockedMsg)))
    .when(Boolean(report), (el) => el.child(renderFormConflict(v, t, report)));

  return v_flex().size_full().min_h(0)
    .child(h_flex().w_full().h(52).px(18).gap(10).items_center().flex_none().border_b(1).border_color(t.border)
      .child(U.button(t, "kb-new-back", "Back", (cx) => v.closeForm(cx), { iconName: "back" }))
      .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("New Key Binding"))
      .when(Boolean(U.closeX(t)), (el) => el.child(U.closeX(t))))
    .child(v_flex().id("kb-new-body").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(6)
      .child(formRow(t, "Action type", "Choose what this shortcut should do.",
        U.segmented(t, "kb-new-mode", MODES, f.mode, (val, cx) => { f.mode = val; v.focusRoot(cx); cx.notify(); })))
      .child(formRow(t, "Action", null, actionControl(), { error: resolved.error && f.showError ? resolved.error : null }))
      .child(formRow(t, "Section", "terminal overrides layout:* and global. mod:* applies only inside that mod.",
        h_flex().w_full().flex_wrap().gap(5).children(quickSecs.map((sec) => {
          const on = f.section === sec;
          return h_flex().id(`kb-new-sec-${sec}`).h(24).px(9).items_center().rounded(6).cursor_pointer().text_size(11.5)
            .bg(on ? U.tint(t.accent, "24") : t.background).border_1().border_color(on ? t.accent : t.border)
            .text_color(on ? t.accent : t.muted).when(on, (el) => el.font_semibold())
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { f.section = sec; f.blockedMsg = null; v.focusRoot(cx); cx.notify(); })
            .child(sectionLabel(sec));
        }))))
      .child(formRow(t, "Shortcut", f.chord ? `Formatted: ${prettyChord(f.chord, v.platform)}` : "Click to capture a key combination.",
        recorderControl, { last: true })))
    .child(h_flex().w_full().px(18).py(12).gap(8).items_center().justify_end().flex_none().border_t(1).border_color(t.border).bg(t.surface)
      .when(Boolean(v.saveError), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.blocked).child(v.saveError)))
      .when(!v.saveError, (el) => el.child(div().flex_1()))
      .child(U.button(t, "kb-new-cancel", "Cancel", (cx) => v.closeForm(cx)))
      .child(U.button(t, "kb-new-save", v.saving ? "Saving…" : "Save binding", (cx) => v.saveNewForm(cx),
        { kind: "primary", iconName: "check", disabled: !canSave })));
}
