// Tab Namer: a dialog that renames the tab of an agent. F2 (mod.open:tab-namer)
// opens it for the focused tab; the pencil of the kanban and agent-cards cards
// opens it with props { tab, terminal }.
//
// The "Generate with AI" button reads the agent's session (it needs the
// resume.session label of the agent-resume mod) and asks a small model for a
// short name. Without a session, the dialog has only the text field, like
// Herdr's own F2.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, shared, nextCommand } from "herdr";
import { target, currentName, generate, save } from "./namer.js";

// The mods-hub can turn this mod off (shared "herdr-mods.disabled", a list of mod names). Then the mod draws
// nothing, closes its dialog and skips its timed work. The bars hide its blocks and buttons.
const kitOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes("tab-namer"); };
const offView = () => { const o = props()?.overlay; if (o) closeOverlay(o); return div(); };

const ICON = (name) => `mods/tab-namer/${name}.svg`;

const TEXT = {
  en: {
    title: "Rename tab",
    name: "Name",
    hint: "Empty: the tab shows the agent's own title again.",
    ai: "Generate with AI",
    working: "Reading the session…",
    noTab: "No tab to rename.",
    cancel: "Cancel",
    save: "Save",
    aiTip: "Reads the agent's session and asks a small model for a name.",
  },
  pt: {
    title: "Renomear tab",
    name: "Nome",
    hint: "Vazio: a tab mostra de novo o título do próprio agente.",
    ai: "Gerar com IA",
    working: "Lendo a sessão…",
    noTab: "Não há tab para renomear.",
    cancel: "Cancelar",
    save: "Salvar",
    aiTip: "Lê a sessão do agente e pede um nome a um modelo pequeno.",
  },
};

const lang = () => {
  const l = shared("herdr-mods.lang") ?? props()?.lang;
  return l === "pt" ? "pt" : "en";
};

export default class TabNamer extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.t = target({ tab: p.tab, terminal: p.terminal });
    this.busy = false;
    this.error = "";
    const value = currentName(this.t?.tab);
    this.text = value;
    this.input = InputState.new({ value, placeholder: this.t?.tab?.name ?? "" });
    if (value) this.input.set_selected_range({ start: 0, end: value.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; cx.notify(); });
    this.input.on("submit", () => this.submit());
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.focus();
    // The field can lose the keyboard while the dialog opens: focus it again.
    cx.timer.after(40, () => this.input.focus());
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    // `herdr-app do tab-namer.generate` clicks the AI button of an open dialog.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "generate") this.generate(cx);
      }
    });
  }

  /** The AI needs a session of this machine. */
  canGenerate() {
    return Boolean(this.t?.session && this.t?.terminal);
  }

  close() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  submit() {
    if (!this.t?.tab || this.busy) return;
    const name = this.text.trim();
    this.close();
    save(this.t, name);
  }

  generate(cx) {
    if (!this.canGenerate() || this.busy) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const name = await generate(this.t, lang());
        this.text = name;
        this.input.set_value(name);
        this.input.set_selected_range({ start: 0, end: name.length });
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.busy = false;
      this.input.focus();
      cx.notify();
    });
  }

  key(e, cx) {
    if (e.key === "escape") {
      this.close();
      cx.stop_propagation();
    } else if (e.key === "g" && e.modifiers?.control) {
      this.generate(cx);
      cx.stop_propagation();
    }
  }

  render() {
    if (kitOff()) return offView();
    const t = theme();
    const s = TEXT[lang()];
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((st) => st.opacity(0.88)).on_click((_e, cx) => action(cx)).child(text);
    const ai = this.canGenerate();
    const aiButton = h_flex().id("tn-ai").h(32).px(12).gap(7).items_center().rounded(8)
      .border_1().border_color(t.input).bg(t.raised).text_size(12.5).font_medium()
      .text_color(this.busy ? t.dim : t.accent)
      .when(!this.busy, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)))
      .tooltip(s.aiTip)
      .on_click((_e, cx) => this.generate(cx))
      .child(this.busy
        ? svg(ICON("spinner")).size(14).flex_none().spin(900)
        : svg(ICON("sparkles")).size(14).flex_none())
      .child(this.busy ? s.working : s.ai);

    if (!this.t?.tab) {
      return v_flex().id("tab-namer").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
        .w_full().p(18).bg(t.popover).text_color(t.foreground).text_size(13)
        .child(s.noTab)
        .child(h_flex().pt(16).justify_end().child(button("tn-close", s.cancel, false, () => this.close())));
    }

    return v_flex().id("tab-namer").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child(s.title))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child(s.name))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1()
        .border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(div().pt(6).text_size(11.5).text_color(this.error ? t.blocked : t.dim).child(this.error || s.hint))
      .child(h_flex().pt(20).gap(8).items_center()
        .when(ai, (el) => el.child(aiButton))
        .child(div().flex_1())
        .child(button("tn-cancel", s.cancel, false, () => this.close()))
        .child(button("tn-save", s.save, true, () => this.submit())));
  }
}
