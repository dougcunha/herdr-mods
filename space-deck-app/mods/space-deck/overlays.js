// The popups of Space Deck. Each one is this same mod, opened with
// openOverlay({ mod: "space-deck", props: { part, ... } }):
//   menu    the right-click menu of a space
//   agents  the agents to start in a space (or in a new space: newSpace)
//   plus    the + menu when repo-launcher is not installed
//   picker  the icon, emoji and color of a space
//   note    the note of a space

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, knownAgents, pickFolder, shared } from "herdr";
import { item, setItem, pins, pinAt, unpin, PALETTE, fillOf, KEYS } from "./store.js";

const MOD = "space-deck";
const ICON = (name) => `mods/${MOD}/${name}.svg`;

export const ICONS = [
  "folder", "code", "terminal", "rocket", "star", "heart", "flame", "zap", "bug", "book-open", "briefcase",
  "house", "globe", "database", "server", "cloud", "cpu", "box", "package", "layers", "wrench", "hammer",
  "shield", "lock", "key-round", "gamepad-2", "music", "camera", "palette", "pen-tool", "brain", "bot",
  "sparkles", "coffee", "leaf", "sun", "moon", "flask-conical", "graduation-cap", "chart-column",
  "smartphone", "git-branch", "mail", "message-square", "shopping-cart", "users", "calendar", "file-text",
  "puzzle", "target", "anchor", "feather",
];

const close = () => closeOverlay(props()?.overlay);

/** Opens a popup of this mod at the pointer. */
export function popup(part, extra, width, height) {
  return openOverlay({ mod: MOD, kind: "popup", width, height, props: { part, ...extra } });
}

/** The icon of a program: tinted when it is a one-color glyph. */
export function programIcon(program, size, color) {
  if (!program?.icon) return div().size(size).flex_none().rounded(3).bg(color).opacity(0.5);
  return program.tint ? svg(program.icon).size(size).flex_none().text_color(color) : image(program.icon).size(size).flex_none();
}

// A list of choices: ↑/↓ move, Enter runs, Esc closes.
class ListPart {
  init(cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(40, () => this.handle.focus());
  }

  entries() {
    return [];
  }

  render() {
    const t = theme();
    const list = this.entries();
    return v_flex()
      .id("deck-list")
      .track_focus(this.handle)
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        const n = list.filter((x) => x && !x.disabled).length;
        if (!n) return;
        if (e.key === "down") this.at = (this.at + 1) % n;
        else if (e.key === "up") this.at = (this.at + n - 1) % n;
        else if (e.key === "enter") list.filter((x) => x && !x.disabled)[this.at]?.run(cx);
        else return;
        cx.notify();
      })
      .when(!list.length, (el) => el.child(div().h(31).px(8).flex().items_center().text_color(t.dim).child(this.empty ?? "Nothing here")))
      .children(this.rows(list, t));
  }

  rows(list, t) {
    let n = -1;
    return list.map((x, i) => {
      if (!x) return div().id(`sep-${i}`).mx(7).my(4).h(1).bg(t.border);
      const at = x.disabled ? -1 : ++n;
      return h_flex()
        .id(`it-${i}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(x.disabled ? t.dim : t.foreground)
        .when(at === this.at, (el) => el.bg(t.selected))
        .when(!x.disabled, (el) => el.hover((s) => s.bg(t.hover)).on_click((_e, cx) => x.run(cx)))
        .child(x.icon ? x.icon(t) : div().size(14).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(x.label))
        .when(Boolean(x.hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(x.hint)));
    });
  }
}

const glyph = (name) => (t) => svg(name.includes("/") ? name : ICON(name)).size(14).flex_none().text_color(t.muted);

class MenuPart extends ListPart {
  entries() {
    const p = props() ?? {};
    const pinned = pins().includes(p.key);
    return [
      { label: "Icon and color…", icon: glyph("palette"), run: () => { close(); popup("picker", { space: p.space, key: p.key, name: p.name }, 300, 380); } },
      { label: pinned ? "Unpin" : "Pin", icon: glyph(pinned ? "pin-off" : "pin"), run: () => { close(); pinned ? unpin(p.key) : pinAt(p.key); } },
      { label: "Note…", icon: glyph("sticky-note"), run: () => { close(); popup("note", { space: p.space, key: p.key, name: p.name }, 300, 120); } },
      { label: "New agent…", icon: glyph("bot"), run: () => { close(); popup("agents", { space: p.space, folder: p.folder, machine: p.machine }, 240, 300); } },
      null,
      {
        label: "Herdr options…", icon: glyph("ellipsis"),
        run: () => { close(); openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: p.space } } }); },
      },
    ];
  }
}

class PlusPart extends ListPart {
  entries() {
    return [
      { label: "New space", icon: glyph("plus"), run: () => { close(); run("space.new"); } },
      { label: "New space with agent…", icon: glyph("bot"), run: () => { close(); popup("agents", { newSpace: true }, 240, 300); } },
    ];
  }
}

class AgentsPart extends ListPart {
  init(cx) {
    super.init(cx);
    this.agents = null;
    this.empty = "Looking for agents…";
    const p = props() ?? {};
    cx.spawn(async (cx) => {
      try {
        this.agents = (await knownAgents({ on: p.machine ?? null })).filter((a) => a.installed);
      } catch {
        this.agents = [];
      }
      this.empty = "No agents found";
      cx.notify();
    });
  }

  entries() {
    const p = props() ?? {};
    return (this.agents ?? []).map((a) => ({
      label: a.name,
      icon: (t) => programIcon(a, 14, t.muted),
      run: (cx) => {
        close();
        if (p.newSpace) {
          cx.spawn(async () => {
            const folder = await pickFolder({ prompt: `Folder for ${a.name}` });
            if (folder) run("space.new", { folder, argv: a.run, machine: "" });
          });
          return;
        }
        run("space.select", { id: p.space });
        run("tab.new", { space: p.space, argv: a.run, ...(p.folder ? { folder: p.folder } : {}) });
      },
    }));
  }
}

class NotePart {
  init(cx) {
    const p = props() ?? {};
    this.input = InputState.new({ placeholder: "A short note, for example: waiting for review", value: item(p.key).note ?? "" });
    this.input.on("submit", () => this.save());
    this.input.focus();
    cx.timer.after(40, () => this.input.focus());
  }

  save(value = this.input.value()) {
    setItem(props()?.key, { note: String(value).trim().slice(0, 140) });
    close();
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const button = (id, label, onClick, primary) =>
      div().id(id).h(26).px(10).flex().items_center().rounded(6).text_size(12)
        .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
        .hover((s) => s.opacity(0.85)).on_click(onClick).child(label);
    return v_flex()
      .id("deck-note")
      .w_full()
      .p(10)
      .gap(8)
      .bg(t.popover)
      .text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { close(); cx.stop_propagation(); }
      })
      .child(div().text_color(t.dim).text_size(11.5).truncate().child(`Note for ${p.name ?? "space"}`))
      .child(h_flex().h(30).px(8).rounded(6).border(1).border_color(t.input).bg(t.background)
        .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
      .child(h_flex().gap(6).justify_end()
        .child(button("note-clear", "Clear", () => this.save("")))
        .child(button("note-save", "Save", () => this.save(), true)));
  }
}

class PickerPart {
  init(cx) {
    const p = props() ?? {};
    this.search = InputState.new({ placeholder: "Search icons…" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.emoji = InputState.new({ placeholder: "Emoji", value: item(p.key).emoji ?? "" });
    this.emoji.on("submit", () => this.setEmoji());
    this.search.focus();
    cx.timer.after(40, () => this.search.focus());
  }

  setEmoji() {
    const v = this.emoji.value().trim();
    if (!v) return;
    setItem(props()?.key, { emoji: [...v].slice(0, 4).join(""), icon: null });
    close();
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const it = item(p.key);
    const colors = shared(KEYS.colors) ?? {};
    const color = it.color ?? colors[p.space] ?? "ansi6";
    const q = this.search.value().trim().toLowerCase();
    const icons = ICONS.filter((n) => !q || n.includes(q));
    const cell = (id, selected, content, onClick) =>
      h_flex().id(id).size(32).flex_none().items_center().justify_center().rounded(7)
        .when(selected, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click(onClick)
        .child(content);
    return v_flex()
      .id("deck-picker")
      .w_full()
      .p(10)
      .gap(8)
      .bg(t.popover)
      .text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { close(); cx.stop_propagation(); }
      })
      .child(h_flex().gap(8).items_center()
        .child(tile(it, p.name ?? "?", fillOf(color, t), 26))
        .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.foreground).child(p.name ?? "Space"))
        .child(div().id("pick-default").h(24).px(8).flex().items_center().rounded(6).text_size(11.5).text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Back to the first letter of the name")
          .on_click(() => setItem(p.key, { icon: null, emoji: null }))
          .child("Default")))
      .child(h_flex().h(28).px(8).gap(6).items_center().rounded(6).border(1).border_color(t.input).bg(t.background)
        .child(svg(ICON("search")).size(13).flex_none().text_color(t.dim))
        .child(Input.new(this.search).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
      .child(h_flex().id("pick-grid").w_full().h(200).flex_wrap().content_start().gap(2).overflow_y_scrollbar()
        .children(icons.map((n) => cell(`icon-${n}`, it.icon === n,
          svg(`mods/${MOD}/icons/${n}.svg`).size(16).text_color(t.foreground),
          () => { setItem(p.key, { icon: n, emoji: null }); close(); }).tooltip(n))))
      .child(h_flex().gap(6).items_center()
        .child(h_flex().h(28).w(110).px(8).rounded(6).border(1).border_color(t.input).bg(t.background)
          .child(Input.new(this.emoji).flex_1().h_full().text_size(13).text_color(t.foreground)))
        .child(div().id("pick-emoji").h(26).px(10).flex().items_center().rounded(6).text_size(12).bg(t.raised).text_color(t.foreground)
          .hover((s) => s.bg(t.hover)).on_click(() => this.setEmoji()).child("Use emoji")))
      .child(h_flex().gap(6).items_center()
        .children(PALETTE.map((c) => div().id(`color-${c}`).size(22).flex_none().rounded(11).bg(fillOf(c, t))
          .border(2).border_color(c === color ? t.foreground : t.popover)
          .hover((s) => s.opacity(0.8))
          .on_click(() => setItem(p.key, { color: c })))));
  }
}

/** The square of a space: its emoji, its icon on its color, or the first letter of its name. */
export function tile(it, name, fill, size) {
  const box = h_flex().size(size).flex_none().rounded(Math.round(size * 0.28)).items_center().justify_center();
  if (it.emoji) return box.text_size(Math.round(size * 0.68)).child(it.emoji);
  if (it.icon) return box.bg(fill).child(svg(`mods/${MOD}/icons/${it.icon}.svg`).size(Math.round(size * 0.62)).text_color("#ffffff"));
  return box.bg(fill).text_size(Math.round(size * 0.58)).font_bold().text_color("#ffffff").child([...(name ?? "?")][0]?.toUpperCase() ?? "?");
}

const PARTS = { menu: MenuPart, plus: PlusPart, agents: AgentsPart, note: NotePart, picker: PickerPart };

/** The popup for `part`, or null when `part` is not one. */
export function overlayFor(part) {
  const Part = PARTS[part];
  return Part ? new Part() : null;
}
