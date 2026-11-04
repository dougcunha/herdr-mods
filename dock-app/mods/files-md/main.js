// A lazy file browser for the focused pane's folder, with bounded read-only previews:
// Markdown is rendered (with a Source toggle), code is highlighted, an image opens in the image-viewer mod.
// Right-click a row for the menu (files-md-menu): open, show in the file manager, copy the path.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, run, openOverlay, appHome } from "herdr";

const isMarkdown = name => /\.(md|markdown|mdown|mkd|mdx)$/i.test(name);
const isImage = name => /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i.test(name);

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const all = panes();
  let pane = f?.pane ? all.find(p => p.pane === f.pane) : null;
  // A mod pane (the Markdown reader) has no folder: keep the folder of a terminal in the same tab.
  if (pane && !pane.terminal) pane = all.find(p => p.tab === pane.tab && p.terminal && p.cwd && p.focused)
    || all.find(p => p.tab === pane.tab && p.terminal && p.cwd) || pane;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
// File extension → the editor's language. The editor colors py, cs, rs, go, java, c, cpp, ruby, sql, php, lua,
// js, json, html, css, yaml and bash by those names (checked in the app); other names show as plain text.
// An extension that is not listed is passed as it is, so a language the editor learns later just works.
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", yml: "yaml", jsonc: "json", jsonl: "json",
  svelte: "html", vue: "html", htm: "html", xml: "html", csproj: "html", props: "html", xaml: "html",
  sh: "bash", zsh: "bash", ps1: "bash", psm1: "bash", dockerfile: "bash", h: "c", hpp: "cpp", cc: "cpp", cxx: "cpp",
  kt: "java", kts: "java", scala: "java", pyw: "py", rb: "ruby", scss: "css", sass: "css", less: "css" };
// File type → icon (mods/files-md/<icon>.svg) and its color: a theme color name, or a hex color that reads on light and dark themes.
const KINDS = [
  ["file-markdown", "ansi6", /\.(md|markdown|mdown|mkd|mdx)$/i],
  ["file-json", "#e07b39", /\.(json|jsonc|jsonl|json5)$/i],
  ["file-code", "ansi4", /\.(js|mjs|cjs|jsx|ts|mts|cts|tsx|py|pyw|cs|rs|go|java|kt|kts|scala|c|h|cc|cpp|cxx|hpp|rb|php|lua|swift|dart|sql|html?|css|scss|sass|less|vue|svelte|xml|xaml|csproj)$/i],
  ["file-terminal", "ansi2", /\.(sh|bash|zsh|fish|ps1|psm1|bat|cmd)$/i],
  ["file-image", "ansi5", /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i],
  ["file-table", "ansi2", /\.(csv|tsv|xlsx?|ods)$/i],
  ["file-archive", "ansi1", /\.(zip|tar|gz|tgz|bz2|xz|7z|rar|nupkg|jar)$/i],
  ["file-config", "muted", /(^\.[^.]+$|\.(ya?ml|toml|ini|cfg|conf|env|lock|sln|props)$|^dockerfile$)/i],
  ["file-text", "muted", /\.(txt|log|rst|pdf|docx?)$/i],
];
function kindOf(name, dir, open) {
  if (dir) return { icon: open ? "folder-open" : "folder", color: "#e0a526" };
  const [icon, color] = KINDS.find(k => k[2].test(name)) ?? ["file", "dim"];
  return { icon, color };
}
const quote = s => "'" + s.replaceAll("'", "''") + "'";
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Reparse points keep directory attributes even when dangling; check their target.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replaceAll("'", "''") + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    // The optional third-party reader adds a menu item when it is installed.
    try { readTextFile(`${appHome()}/mods/markdown-reader/mod.json`).then(text => { this.reader = text !== null; }).catch(() => {}); } catch {}
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // An image opens in the image-viewer mod, beside the terminal. One viewer per tab.
  viewImage(path) {
    this.openBeside("image-viewer", { file: `${this.root}/${path}`, fileOn: this.on });
  }

  // The commands that open `mod` beside the terminal of this tab, or null when the tab has none.
  // An open pane of the same mod is closed first, so repeated clicks do not stack panes.
  besidePlan(mod, props) {
    const f = focused(), tab = f?.tab, all = panes();
    const target = all.find(p => p.tab === tab && p.terminal && p.pane === f?.pane)
      || all.find(p => p.tab === tab && p.terminal && p.focused)
      || all.find(p => p.tab === tab && p.terminal);
    if (!target) return null;
    const old = all.find(p => p.tab === tab && p.mod === mod);
    return [...(old ? [["pane.close", { pane: old.pane }]] : []), ["pane.split", { pane: target.pane, direction: "right", mod, props }]];
  }

  openBeside(mod, props) {
    const plan = this.besidePlan(mod, props);
    if (!plan) { openOverlay({ mod, props, kind: "dialog", width: 920, height: 0.85 }); return; }
    for (const [name, args] of plan) run(name, args);
  }

  // The items of the right-click menu for one row (see files-md-menu). Programs that act on this
  // computer's files are left out for a folder on another machine; copying a path stays.
  menuItems(entry, path) {
    const platform = window()?.platform, win = platform === "windows", mac = platform === "macos";
    const abs = `${this.root}/${path}`, native = !this.on && win ? abs.replaceAll("/", "\\") : abs;
    const items = [];
    if (!this.on) {
      if (!entry.dir) items.push({ label: "Open with default app", icon: "external-link", exec: win ? ["powershell", ["-NoProfile", "-Command", "& { param($p) Invoke-Item -LiteralPath $p } " + quote(native)]] : mac ? ["open", [native]] : ["xdg-open", [native]] });
      if (!entry.dir && isMarkdown(entry.name) && this.reader) {
        const plan = this.besidePlan("markdown-reader", { file: abs, fileOn: this.on, cwd: this.root, on: this.on, treeVisible: false });
        if (plan) items.push({ label: "Open in Markdown Reader", icon: "book-open", cmds: plan });
      }
      const manager = win ? "Explorer" : mac ? "Finder" : "file manager";
      items.push(entry.dir
        ? { label: `Open in ${manager}`, icon: "folder-open", exec: win ? ["explorer", [native]] : mac ? ["open", [native]] : ["xdg-open", [native]] }
        : { label: `Show in ${manager}`, icon: "folder-open", exec: win ? ["explorer", ["/select,", native]] : mac ? ["open", ["-R", native]] : ["xdg-open", [abs.slice(0, abs.lastIndexOf("/"))]] });
      if (entry.dir) {
        items.push({ label: "Open terminal here", icon: "terminal", cmds: [["terminal.open", { folder: abs, place: "right" }]] });
        items.push({ label: "Open in new space", icon: "square-plus", cmds: [["space.new", { folder: abs }]] });
      }
    }
    items.push({ label: "Copy path", icon: "copy", copy: native, sep: items.length > 0 });
    items.push({ label: "Copy relative path", icon: "link", copy: path });
    items.push({ label: "Copy name", icon: "type", copy: entry.name });
    return items;
  }

  contextMenu(entry, path) {
    const items = this.menuItems(entry, path);
    // 31 px a row, 5 px padding top and bottom, 9 px a divider.
    const height = items.length * 31 + 10 + items.filter(i => i.sep).length * 9;
    openOverlay({ mod: "files-md-menu", kind: "popup", at: "pointer", width: 230, height, props: { items } });
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.text = null; this.rendered = false;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        this.text = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        // Markdown shows rendered; the Source button in the header switches to highlighted text.
        this.rendered = isMarkdown(path);
        if (!this.rendered) this.code = this.highlight(path);
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // A read-only, highlighted view of the text of the open file.
  highlight(path) {
    const t = theme(), ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "txt";
    return EditorState.new({ language: LANG[ext] ?? ext, readonly: true, value: this.text,
      font_family: settings().font_family, font_size: 12,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
  }

  toggleSource(cx) {
    this.rendered = !this.rendered;
    if (!this.rendered && !this.code) this.code = this.highlight(this.file);
    cx.notify();
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`], kind = kindOf(entry.name, entry.dir, open);
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : isImage(entry.name) ? this.viewImage(path) : this.show(path, cx))
        .on_mouse_down("right", () => this.contextMenu(entry, path))
        .child(entry.dir ? svg(`mods/files-md/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files-md/${kind.icon}.svg`).size(14).flex_none().text_color(kind.color.startsWith("#") ? kind.color : t[kind.color]))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(Boolean(this.file) && this.text !== null && isMarkdown(this.file), el => el.child(div().id("files-source").flex_none().px(8).py(3).rounded(6).cursor_pointer().text_size(12).text_color(t.muted)
          .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.toggleSource(cx)).child(this.rendered ? "Source" : "Rendered"))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.rendered && this.text !== null
        // The id changes with the file, so the rendered text and its scroll start over for each one.
        ? div().id(`files-doc-${this.file}`).flex_1().min_h(0).overflow_y_scrollbar().p(14)
          .child(TextView.markdown(`files-md-${this.file}`, this.text || "*This file is empty.*").w_full().text_size(13).text_color(t.foreground).selectable(true).scrollable(false))
        : this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
