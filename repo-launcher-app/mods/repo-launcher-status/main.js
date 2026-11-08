// A status bar item for the Repo Launcher: "Ctrl+P  repos". A click opens
// the launcher. It sits in the status row of a layout, beside the
// workspace-status block, and draws the same bar look (chrome fill, top
// border, 11.8 px text).

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, keys, window, shared, props, closeOverlay } from "herdr";

// The mods-hub can turn this mod off (shared "herdr-mods.disabled", a list of mod names). Then the mod draws
// nothing, closes its dialog and skips its timed work. The bars hide its blocks and buttons.
const kitOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes("repo-launcher-status"); };
const offView = () => { const o = props()?.overlay; if (o) closeOverlay(o); return div(); };

const ACTION = "mod.open:repo-launcher";

/** The key bound to the launcher, spelled like the palette hint ("Ctrl+P"). */
function shortcut() {
  const mac = window()?.platform === "macos";
  const names = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
  const b = keys().find((k) => k.section === "global" && k.action === ACTION);
  if (!b?.keys.trim()) return "";
  const stroke = b.keys.trim().split(/\s+/)[0];
  const parts = stroke.endsWith("--") ? [...stroke.slice(0, -2).split("-"), "-"] : stroke.split("-");
  return parts.map((p) => names[p.toLowerCase()] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join("");
}

export default class RepoLauncherStatus extends View {
  render() {
    if (kitOff()) return offView();
    const t = theme();
    const key = shortcut();
    return h_flex().id("repo-launcher-status").size_full().pr(14).items_center().justify_end()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8)
      .child(h_flex().id("rls-open").h(20).px(6).gap(6).items_center().rounded(5).cursor_pointer()
        .text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Open a repository")
        .on_click(() => run("mod.open", { name: "repo-launcher" }))
        .child(svg("mods/repo-launcher/repo.svg").size(12))
        .child(key ? `${key}  repos` : "repos"));
  }
}
