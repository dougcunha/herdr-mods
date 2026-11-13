// A lazy file browser for the focused pane's folder, with bounded read-only previews:
// Markdown is rendered (with a Source toggle), code is highlighted, an image is drawn (Fit or 100%).
// The right-click menu can also open an image in the image-viewer mod, beside the terminal.
// Right-click a row for the menu (files-md-menu): open, show in the file manager, new file or folder,
// cut, copy, paste, duplicate, rename, delete, copy the path. A right-click below the rows acts on the root folder.
// The field at the top filters every file and folder of the root with a fuzzy match (fuzzy.js).
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, run, openOverlay, closeOverlay, appHome, shared, props } from "herdr";
import { tokens, matchEntry, segments } from "./fuzzy.js";

// The mods-hub can turn this mod off (shared "herdr-mods.disabled", a list of mod names). Then the mod draws
// nothing, closes its dialog and skips its timed work. The bars hide its blocks and buttons.
const kitOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes("files-md"); };
const offView = () => { const o = props()?.overlay; if (o) closeOverlay(o); return div(); };

// A folder on another machine: a server icon and the machine name, in a hue that no agent status uses.
// (The same chip as in the tabs-dock and kanban bars.)
const machineChip = (t, machine) => {
  const color = t.ansi5 || t.accent;
  const tint = /^#[0-9a-f]{6}$/i.test(color || "") ? (a) => color + a : () => color;
  return h_flex().id("machine-chip").h(20).px(7).gap(4).flex_none().max_w(140).items_center().rounded(6).text_size(11).font_semibold()
    .bg(tint("26")).border_1().border_color(tint("66")).text_color(color)
    .tooltip(`On ${machine}`)
    .child(svg("mods/workspace-chrome/server.svg").size(11).flex_none())
    .child(div().truncate().child(machine));
};

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
// Cut or Copy keeps { path, name, cut, on } here; Paste in any copy of the panel reads it.
const CLIPBOARD = "files-md.clipboard";

// The programs that change files. Each one returns an exec spec, [program, [args]], for the
// files-md-menu mod. Local Windows uses PowerShell; macOS, Linux and other machines use sh.
// "{{value}}" / "{{value:ps}}" is the name that the person types in the menu.
const ps = (script, ...args) => ["powershell", ["-NoProfile", "-Command", `$ErrorActionPreference = 'Stop'; & { ${script} } ${args.join(" ")}`]];
const sh = (script, ...args) => ["sh", ["-c", script, "files", ...args]];
const COPY_NAME_PS = "function Free($d, $n, $dir) { $b = if ($dir) { $n } else { [IO.Path]::GetFileNameWithoutExtension($n) }; $e = if ($dir) { '' } else { [IO.Path]::GetExtension($n) }; if (-not $b) { $b = $n; $e = '' }; $t = Join-Path $d \"$b - Copy$e\"; $i = 2; while (Test-Path -LiteralPath $t) { $t = Join-Path $d \"$b - Copy ($i)$e\"; $i++ }; $t }";
const COPY_NAME_SH = 'free() { n=${2##*/}; b=$n; e=""; if [ ! -d "$2" ]; then case "$n" in ?*.*) b=${n%.*}; e=".${n##*.}";; esac; fi; t="$1/$b copy$e"; i=2; while [ -e "$t" ] || [ -L "$t" ]; do t="$1/$b copy $i$e"; i=$((i+1)); done; }';
const FS = {
  windows: {
    newFile: dir => ps("param($d, $n) $t = Join-Path $d $n; if (Test-Path -LiteralPath $t) { throw \"'$n' already exists\" }; [IO.File]::Create($t).Dispose()", quote(dir), "{{value:ps}}"),
    newFolder: dir => ps("param($d, $n) $t = Join-Path $d $n; if (Test-Path -LiteralPath $t) { throw \"'$n' already exists\" }; [void][IO.Directory]::CreateDirectory($t)", quote(dir), "{{value:ps}}"),
    rename: path => ps("param($p, $n) $t = Join-Path (Split-Path -LiteralPath $p) $n; if ((Test-Path -LiteralPath $t) -and -not ((Split-Path -Leaf $p) -ieq $n)) { throw \"'$n' already exists\" }; Rename-Item -LiteralPath $p -NewName $n", quote(path), "{{value:ps}}"),
    // To the Recycle Bin, as Explorer does.
    remove: (path, dir) => ps(`param($p) Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${dir ? "DeleteDirectory" : "DeleteFile"}($p, 'OnlyErrorDialogs', 'SendToRecycleBin')`, quote(path)),
    duplicate: path => ps(`param($p) ${COPY_NAME_PS}; $d = Split-Path -LiteralPath $p; Copy-Item -LiteralPath $p -Destination (Free $d (Split-Path -Leaf $p) (Test-Path -LiteralPath $p -PathType Container)) -Recurse`, quote(path)),
    paste: (src, dir, cut) => ps(`param($s, $d, $m) ${COPY_NAME_PS}; $n = Split-Path -Leaf $s; if (-not (Test-Path -LiteralPath $s)) { throw "'$n' is no longer there" }; $full = [IO.Path]::GetFullPath($d).TrimEnd('\\') + '\\'; if ($full.StartsWith([IO.Path]::GetFullPath($s).TrimEnd('\\') + '\\', 'OrdinalIgnoreCase')) { throw 'Cannot paste a folder into itself' }; $t = Join-Path $d $n; if ($m -eq '1') { if (Test-Path -LiteralPath $t) { if ([IO.Path]::GetFullPath($t) -eq [IO.Path]::GetFullPath($s)) { return }; throw "'$n' already exists in this folder" }; Move-Item -LiteralPath $s -Destination $t } else { if (Test-Path -LiteralPath $t) { $t = Free $d $n (Test-Path -LiteralPath $s -PathType Container) }; Copy-Item -LiteralPath $s -Destination $t -Recurse }`, quote(src), quote(dir), cut ? "'1'" : "'0'"),
  },
  posix: {
    newFile: dir => sh('t="$1/$2"; if [ -e "$t" ] || [ -L "$t" ]; then echo "\'$2\' already exists" >&2; exit 1; fi; : > "$t"', dir, "{{value}}"),
    newFolder: dir => sh('t="$1/$2"; if [ -e "$t" ] || [ -L "$t" ]; then echo "\'$2\' already exists" >&2; exit 1; fi; mkdir -- "$t"', dir, "{{value}}"),
    // -ef: a change of case only, on a disk that ignores case, finds the same file.
    rename: path => sh('t="${1%/*}/$2"; if { [ -e "$t" ] || [ -L "$t" ]; } && ! [ "$1" -ef "$t" ]; then echo "\'$2\' already exists" >&2; exit 1; fi; mv -- "$1" "$t"', path, "{{value}}"),
    // No trash on every machine: this deletes for good, and the confirm step says so.
    remove: path => sh('rm -rf -- "$1"', path),
    duplicate: path => sh(`${COPY_NAME_SH}; free "\${1%/*}" "$1"; cp -R -- "$1" "$t"`, path),
    paste: (src, dir, cut) => sh(`${COPY_NAME_SH}; s=$1; d=$2; n=\${s##*/}; if [ ! -e "$s" ] && [ ! -L "$s" ]; then echo "'$n' is no longer there" >&2; exit 1; fi; case "$d/" in "$s/"*) echo "Cannot paste a folder into itself" >&2; exit 1;; esac; t="$d/$n"; if [ "$3" = 1 ]; then [ "$t" = "$s" ] && exit 0; if [ -e "$t" ] || [ -L "$t" ]; then echo "'$n' already exists in this folder" >&2; exit 1; fi; mv -- "$s" "$t"; else if [ -e "$t" ] || [ -L "$t" ]; then free "$d" "$s"; fi; cp -R -- "$s" "$t"; fi`, src, dir, cut ? "1" : "0"),
  },
};

async function directory(path, on) {
  // From Herdr 0.1.15 files: OneDrive folders, curly quotes in paths, and Windows machines without sh.
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// Image preview. image() only loads paths inside the app folder, so the file is copied to
// data/files-md/ first (as the image-viewer mod does). The copy is deleted when another file
// opens or the panel closes; copies older than 1 day (after a crash) are deleted at start.
const IMAGE_DIR = "data/files-md", IMAGE_MAX = 64 * 1024 * 1024;
const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8];
const kb = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const hash = s => { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(36); };
// Copies `src` to `dst`. Returns { bytes, w, h } (w and h are 0 when unknown: SVG, WebP, macOS, Linux) or { big }.
async function stageImage(src, dst) {
  if (window()?.platform === "windows") {
    const r = await exec("powershell", ["-NoProfile", "-Command", "& { param($s,$d) $i = Get-Item -LiteralPath $s -ErrorAction Stop; if ($i.Length -gt " + IMAGE_MAX + ") { 'big ' + $i.Length; return };"
      + " New-Item -ItemType Directory -Force (Split-Path $d) | Out-Null; Copy-Item -LiteralPath $s -Destination $d -Force;"
      + " $w = 0; $h = 0; try { Add-Type -AssemblyName System.Drawing; $m = [System.Drawing.Image]::FromFile($d); $w = $m.Width; $h = $m.Height; $m.Dispose() } catch {};"
      + " '' + $i.Length + ' ' + $w + ' ' + $h } " + quote(src) + " " + quote(dst)]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read this file");
    return parseStage(r.stdout);
  }
  const r = await exec("sh", ["-c", 'n=$(wc -c < "$1") || exit 1; if [ "$n" -gt ' + IMAGE_MAX + ' ]; then echo "big $n"; exit 0; fi; mkdir -p "$(dirname "$2")" && cp "$1" "$2" && echo "$n 0 0"', "image", src, dst]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read this file");
  return parseStage(r.stdout);
}
function parseStage(out) {
  const [a, w, h] = out.trim().split(/\s+/);
  return a === "big" ? { big: Number(w) } : { bytes: Number(a), w: Number(w) || 0, h: Number(h) || 0 };
}
function removeFile(path) {
  return (window()?.platform === "windows"
    ? exec("powershell", ["-NoProfile", "-Command", "Remove-Item -LiteralPath " + quote(path) + " -Force -ErrorAction SilentlyContinue"])
    : exec("rm", ["-f", path])).catch(() => null);
}
function sweepImages() {
  const dir = `${appHome()}/${IMAGE_DIR}`;
  return (window()?.platform === "windows"
    ? exec("powershell", ["-NoProfile", "-Command", "Get-ChildItem -LiteralPath " + quote(dir) + " -File -ErrorAction SilentlyContinue | Where-Object LastWriteTime -lt (Get-Date).AddDays(-1) | Remove-Item -Force -ErrorAction SilentlyContinue"])
    // Through sh: a bare "find" can be Windows' find.exe, which waits for input (seen in herdr-app check).
    : exec("sh", ["-c", 'find "$1" -type f -mtime +1 -delete 2>/dev/null; exit 0', "sweep", dir])).catch(() => null);
}

// Every file and folder under the root, for the filter: relative paths with "/", folders first
// marked by `dir`. In a Git work tree, `git ls-files` gives the files that Git sees (no ignored
// files); else a recursive listing that skips .git and node_modules. At most INDEX_MAX entries.
const INDEX_MAX = 20000, RESULTS_MAX = 200;
async function fileIndex(root, on) {
  const out = new Map(); // path -> dir
  const add = (path, dir) => {
    if (!path || out.has(path) || out.size >= INDEX_MAX) return;
    // The folders of a path are entries too, so a folder can be found by its name.
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) { const p = parts.slice(0, i).join("/"); if (!out.has(p)) out.set(p, true); }
    out.set(path, dir);
  };
  const git = await exec("git", ["--no-optional-locks", "-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, on }).catch(() => null);
  if (git?.code === 0) {
    for (const path of git.stdout.split("\0")) { if (out.size >= INDEX_MAX) break; add(path, false); }
  } else if (!on && window()?.platform === "windows") {
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) $n = (Get-Item -LiteralPath $p).FullName.TrimEnd('\\').Length + 1; function Walk($d) { foreach ($i in Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue) { if ($i.Name -eq '.git' -or $i.Name -eq 'node_modules') { continue }; if ($i.PSIsContainer) { 'd' + $i.FullName.Substring($n); if (-not ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Walk $i.FullName } } else { 'f' + $i.FullName.Substring($n) } } }; Walk $p | Select-Object -First " + INDEX_MAX + " } " + quote(root)]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    for (const line of r.stdout.split(/\r?\n/)) if (line) add(line.slice(1).replaceAll("\\", "/"), line[0] === "d");
  } else {
    const r = await exec("sh", ["-c", 'cd "$1" && find . \\( -name .git -o -name node_modules \\) -prune -o -type d -exec printf "d%s\\n" {} + -o -print | head -n "$2"', "files", root, String(INDEX_MAX + 1)], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    for (const line of r.stdout.split("\n")) {
      const dir = line.startsWith("d./"), path = line.slice(dir ? 3 : 2);
      if (line !== "d." && path) add(path, dir);
    }
  }
  return [...out].map(([path, dir]) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return { path, name, dir, lowerPath: path.toLowerCase(), lowerName: name.toLowerCase() };
  });
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set();
    this.handle = cx.focus_handle(); // the panel's own keyboard focus, for Esc in a dialog
    // The filter: its text field, the file index it searches, and the row that Enter opens.
    this.filter = InputState.new({ placeholder: "Filter files (fuzzy)…" });
    // Wait for a short pause in the typing, so a fast typist does not search on every key.
    this.filter.on("change", (_e, cx) => {
      const seq = this.typed = (this.typed ?? 0) + 1;
      cx.timer.after(70, cx => { if (this.typed === seq) { this.pick = 0; this.search(cx); } });
    });
    this.filter.on("submit", (_e, cx) => this.openResult(this.results?.[this.pick], cx));
    this.query = ""; this.index = null; this.indexStale = true; this.results = null; this.pick = 0;
    this.refresh(cx);
    // The panel opens with the keyboard in the filter. The field is on the screen only after
    // the first frame, so focus it again a moment later.
    this.filter.focus();
    cx.timer.after(40, cx => { if (!this.file) this.filter.focus(); cx.notify(); });
    cx.timer.every(10000, cx => kitOff() || this.refresh(cx));
    sweepImages();
    // The optional third-party reader adds a menu item when it is installed.
    try { readTextFile(`${appHome()}/mods/markdown-reader/mod.json`).then(text => { this.reader = text !== null; }).catch(() => {}); } catch {}
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) { this.indexStale = true; this.refresh(cx); if (this.query) this.search(cx); } } }
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
      this.pending = new Set(); this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      this.index = null; this.indexStale = true; this.indexError = null;
      if (saved?.file) this.show(saved.file, cx);
      if (this.query) this.search(cx);
    }
    // A folder on another machine has no folder watch: build its index again on the timer.
    else if (on && this.query) { this.indexStale = true; this.search(cx); }
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
        if (!this.current(context)) return;
        this.error = null; this.watch(cwd, cx);
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

  // Runs the filter on the index. Builds the index first when there is none or the files changed.
  search(cx) {
    this.query = this.filter.value();
    const words = tokens(this.query);
    if (!words.length) { this.results = null; cx.notify(); return; }
    if ((!this.index || this.indexStale) && this.root && !this.indexing) {
      const context = this.context;
      this.indexing = true; this.indexStale = false;
      cx.spawn(async cx => {
        try { const index = await fileIndex(context.cwd, context.on); if (this.current(context)) { this.index = index; this.indexError = null; } }
        catch (e) { if (this.current(context)) this.indexError = String(e?.message ?? e); }
        finally { this.indexing = false; if (this.current(context)) this.search(cx); else cx.notify(); }
      });
    }
    // When the text only grows, a match must be in the last matches: search only those.
    const query = words.join(" "), last = this.lastSearch;
    const pool = last && last.index === this.index && query.startsWith(last.query) && words.length === last.words ? last.found.map(f => f.entry) : this.index ?? [];
    const found = [];
    for (const entry of pool) {
      const m = matchEntry(words, entry);
      if (m) found.push({ entry, m });
    }
    this.lastSearch = { index: this.index, query, words: words.length, found };
    found.sort((a, b) => b.m.score - a.m.score || a.entry.path.localeCompare(b.entry.path));
    this.total = found.length;
    this.results = found.slice(0, RESULTS_MAX);
    this.pick = Math.min(this.pick, Math.max(0, this.results.length - 1));
    cx.notify();
  }

  // Enter or a click on a result: a file opens in the preview (the filter stays, ← goes back to
  // the results); a folder clears the filter and shows the folder open in the tree.
  openResult(r, cx) {
    if (!r) return;
    const { path, name, dir } = r.entry;
    if (!dir) {
      // Enter in the filter opens the preview too: move the keyboard from the field (which leaves
      // the screen) to the panel, so Esc goes back.
      this.show(path, cx);
      this.keepKeys(true);
      cx.timer.after(40, () => { if (this.file) this.handle.focus(); });
      cx.notify();
      return;
    }
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) { const p = parts.slice(0, i).join("/"); if (!this.folders.has(p)) this.toggle(p, cx); }
    this.clearFilter(cx);
  }

  clearFilter(cx) {
    this.typed = (this.typed ?? 0) + 1; // drops a search that waits for the typing pause
    this.filter.set_value(""); this.query = ""; this.results = null; this.pick = 0;
    cx.notify();
  }

  // The id of the dialog that shows this panel, or null in the side panel. The dock (tabs-dock or
  // kanban) keeps the open panel dialog in the shared key "kanban.panelDialog".
  dialog() {
    if (props()?.overlay) return props().overlay;
    return shared("kanban.panelDialog")?.id ?? null;
  }

  // A click on a row, a result or a button takes the keyboard from the filter field, and then no
  // part of the dialog has it: Esc does not reach the panel. In a dialog, give it to the panel.
  // A file preview takes the keyboard in the side panel too, so Esc can go back from it.
  keepKeys(preview = false) {
    if (preview || this.dialog()) this.handle.focus();
  }

  // Back from the preview to the tree or the results (← or Esc), with the keyboard in the filter.
  back(cx) {
    this.show(null);
    cx.notify();
    cx.timer.after(40, cx => { this.filter.focus(); cx.notify(); });
  }

  // The filter field, with ↑/↓ to pick a result and Esc to clear it (or to close the dialog).
  filterBar(t) {
    return h_flex().id("files-filter").h(34).flex_none().mx(6).mt(6).px(9).gap(7).items_center().rounded(8).border_1().border_color(t.border).bg(t.background)
      .on_key_down((e, cx) => {
        const n = this.results?.length ?? 0;
        if (e.key === "down" && n) this.pick = (this.pick + 1) % n;
        else if (e.key === "up" && n) this.pick = (this.pick + n - 1) % n;
        else if (e.key === "escape") {
          // Esc clears the text first; with an empty field it closes the dialog that shows this panel.
          // The focused text field keeps Esc from the dialog, so close it here.
          if (this.query || this.filter.value()) this.clearFilter(cx);
          else if (this.dialog()) closeOverlay(this.dialog());
          else return;
        }
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(svg("mods/files-md/search.svg").size(13).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).child(Input.new(this.filter).w_full().text_size(12.5).text_color(t.foreground)))
      .when(Boolean(this.query), el => el.child(div().id("files-filter-clear").flex_none().p(2).rounded(5).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => this.clearFilter(cx)).child(svg("mods/files-md/x.svg").size(12).text_color(t.dim))));
  }

  // Text with the matched characters in the accent color and bold.
  highlighted(text, indices, color, t) {
    return h_flex().min_w(0).overflow_hidden().text_color(color)
      .children(segments(text, indices).map(p => p.hit ? div().flex_none().text_color(t.accent).font_bold().child(p.text) : div().flex_none().child(p.text)));
  }

  resultRows(t) {
    return (this.results ?? []).map((r, i) => {
      const { path, name, dir } = r.entry, parent = path.slice(0, Math.max(0, path.length - name.length - 1));
      const kind = kindOf(name, dir, false);
      return h_flex().id(`found-${path}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(i === this.pick, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { this.pick = i; this.keepKeys(); this.openResult(r, cx); })
        .on_mouse_down("right", (e, cx) => { cx.stop_propagation(); this.contextMenu({ name, dir }, path, e); })
        .child(svg(`mods/files-md/${kind.icon}.svg`).size(14).flex_none().text_color(kind.color.startsWith("#") ? kind.color : t[kind.color]))
        .child(div().flex_none().max_w_full().child(this.highlighted(name, r.m.name, t.foreground, t)))
        .child(div().flex_1().min_w(0).text_size(11.5).child(this.highlighted(parent, r.m.path.filter(k => k < parent.length), t.dim, t)));
    });
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

  // The items of the right-click menu for one row (see files-md-menu). Programs that act on this
  // computer's files are left out for a folder on another machine; copying a path stays.
  // The edit items: new file and folder, cut, copy, paste, duplicate, rename, delete. They run on the
  // machine of the folder. With no entry, they act on the root folder (a right-click below the rows).
  editItems(entry, path, native) {
    const win = !this.on && window()?.platform === "windows", fs = win ? FS.windows : FS.posix, on = this.on;
    const nativeOf = p => win ? p.replaceAll("/", "\\") : p;
    const folder = entry ? (entry.dir ? native : nativeOf(`${this.root}/${path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""}`.replace(/\/$/, ""))) : nativeOf(this.root);
    const items = [];
    if (!entry || entry.dir) {
      items.push({ label: "New file…", icon: "file-plus", on, ask: { title: "New file", value: "" }, exec: fs.newFile(folder), sep: true });
      items.push({ label: "New folder…", icon: "folder-plus", on, ask: { title: "New folder", value: "" }, exec: fs.newFolder(folder) });
    }
    if (entry) {
      items.push({ label: "Cut", icon: "scissors", share: [CLIPBOARD, { path: native, name: entry.name, cut: true, on }], sep: true });
      items.push({ label: "Copy", icon: "copy", share: [CLIPBOARD, { path: native, name: entry.name, cut: false, on }] });
    }
    const clip = shared(CLIPBOARD);
    if (clip?.path && (clip.on ?? null) === on) {
      const into = entry && !entry.dir ? folder : entry ? native : folder;
      items.push({ label: `Paste “${clip.name}”`, icon: "clipboard-paste", on, exec: fs.paste(clip.path, into, clip.cut),
        share: clip.cut ? [CLIPBOARD, null] : undefined, sep: !entry });
    }
    if (entry) {
      items.push({ label: "Duplicate", icon: "copy-plus", on, exec: fs.duplicate(native) });
      const dot = entry.dir ? -1 : entry.name.lastIndexOf(".");
      items.push({ label: "Rename…", icon: "pencil", on, ask: { title: `Rename “${entry.name}”`, value: entry.name, select: [0, dot > 0 ? dot : entry.name.length] },
        exec: fs.rename(native), sep: true });
      items.push({ label: "Delete", icon: "trash", on, danger: true, exec: fs.remove(native, entry.dir),
        confirm: { title: win ? `Move “${entry.name}” to the Recycle Bin?` : `Delete “${entry.name}” for good? You cannot undo this.`, button: "Delete" } });
    }
    return items;
  }

  menuItems(entry, path) {
    const platform = window()?.platform, win = platform === "windows", mac = platform === "macos";
    const abs = `${this.root}/${path}`, native = !this.on && win ? abs.replaceAll("/", "\\") : abs;
    if (!entry) return this.editItems(null, "", native).map((it, i) => i === 0 ? { ...it, sep: false } : it);
    const items = [];
    if (!this.on) {
      if (!entry.dir) items.push({ label: "Open with default app", icon: "external-link", exec: win ? ["powershell", ["-NoProfile", "-Command", "& { param($p) Invoke-Item -LiteralPath $p } " + quote(native)]] : mac ? ["open", [native]] : ["xdg-open", [native]] });
      const off = shared("herdr-mods.disabled");
      if (!entry.dir && isImage(entry.name) && !(Array.isArray(off) && off.includes("image-viewer"))) {
        const plan = this.besidePlan("image-viewer", { file: abs, fileOn: this.on });
        if (plan) items.push({ label: "Open in Image Viewer", icon: "image", cmds: plan });
      }
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
    items.push(...this.editItems(entry, path, native));
    items.push({ label: "Copy path", icon: "copy", copy: native, sep: items.length > 0 });
    items.push({ label: "Copy relative path", icon: "link", copy: path || "." });
    items.push({ label: "Copy name", icon: "type", copy: entry.name });
    return items;
  }

  contextMenu(entry, path, e) {
    const items = this.menuItems(entry, path);
    // 31 px a row, 5 px padding top and bottom, 9 px a divider.
    const height = items.length * 31 + 10 + items.filter((it, i) => it.sep && i > 0).length * 9;
    // "pointer" is the last spot that the layout saw, so in a dialog it is wrong. Use the spot of the click.
    const p = e?.position, at = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : "pointer";
    openOverlay({ mod: "files-md-menu", kind: "popup", at, width: 250, height, props: { items, on: this.on } });
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.text = null; this.rendered = false;
    this.unstage(); this.picture = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    if (isImage(path)) { this.showImage(path, context, cx); return; }
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

  // An image opens in the preview: copied into the app folder, then drawn with image().
  // this.picture: { staged, bytes, w, h } once it is ready; this.zoom: "fit" or a scale (1 = 100%).
  showImage(path, context, cx) {
    if (context.on) { this.fileError = "Images on another machine have no preview. Use Copy path, or open the folder on this computer."; return; }
    const ext = path.split(".").pop().toLowerCase(), rel = `${IMAGE_DIR}/${hash(path)}-${Date.now().toString(36)}.${ext}`;
    this.zoom = "fit";
    cx.spawn(async cx => {
      try {
        const out = await stageImage(`${context.cwd}/${path}`, `${appHome()}/${rel}`);
        // Another file opened while the copy ran: drop this copy.
        if (this.file !== path || !this.current(context)) { if (!out.big) removeFile(`${appHome()}/${rel}`); return; }
        if (out.big) { this.fileError = `This image is larger than ${kb(IMAGE_MAX)}.`; return; }
        this.staged = rel;
        this.picture = { staged: rel, ...out };
      } catch (e) { if (this.file === path && this.current(context)) this.fileError = String(e?.message ?? e); }
      finally { cx.notify(); }
    });
  }

  unstage() {
    if (this.staged) removeFile(`${appHome()}/${this.staged}`);
    this.staged = null;
  }

  async close() { this.unstage(); }

  // The size that 100% means: the image's own size, or, when it is not known (SVG, WebP, macOS,
  // Linux), the box of the visible area, which the image fits inside.
  imageBase() {
    const p = this.picture, v = this.view;
    return p.w > 0 && p.h > 0 ? { w: p.w, h: p.h, known: true } : { w: v?.width ?? 400, h: v?.height ?? 300, known: false };
  }

  // The scale on screen: in Fit, the largest that fits the preview and is not above 100%.
  imageScale() {
    if (this.zoom !== "fit") return this.zoom;
    const b = this.imageBase(), v = this.view;
    return v ? Math.min(1, v.width / b.w, v.height / b.h) : 1;
  }

  // One zoom step in or out from the scale on screen (dir 1 or -1).
  zoomStep(dir, cx) {
    const now = this.imageScale();
    const next = dir > 0 ? ZOOM_STEPS.find(s => s > now + 1e-6) : [...ZOOM_STEPS].reverse().find(s => s < now - 1e-6);
    if (next) { this.zoom = next; cx.notify(); }
  }

  setZoom(zoom, cx) {
    this.keepKeys(true);
    this.zoom = zoom;
    cx.notify();
  }

  // The zoom bar of the header: Fit, 100%, −, the scale, +.
  zoomBar(t) {
    const button = (id, label, active, fn, disabled = false) => div().id(id).h(24).px(8).flex_none().rounded(6).flex().items_center().text_size(12)
      .text_color(disabled ? t.dim : active ? t.accent_foreground : t.muted).when(active, el => el.bg(t.accent))
      .when(!disabled, el => el.cursor_pointer().hover(s => s.bg(active ? t.accent : t.hover)).on_click((_e, cx) => fn(cx)))
      .child(label);
    const s = this.imageScale();
    return h_flex().flex_none().gap(2).items_center()
      .child(button("files-zoom-fit", "Fit", this.zoom === "fit", cx => this.setZoom("fit", cx)))
      .child(button("files-zoom-100", "100%", this.zoom === 1, cx => this.setZoom(1, cx)))
      .child(button("files-zoom-out", "−", false, cx => { this.keepKeys(true); this.zoomStep(-1, cx); }, s <= ZOOM_STEPS[0] + 1e-6))
      .child(div().w(42).flex_none().text_center().text_size(12).text_color(t.muted).child(`${Math.round(s * 100)}%`))
      .child(button("files-zoom-in", "+", false, cx => { this.keepKeys(true); this.zoomStep(1, cx); }, s >= ZOOM_STEPS.at(-1) - 1e-6));
  }

  // The image: centered and fit in Fit, else at the chosen scale with scrollbars.
  // Ctrl + mouse wheel zooms (one step per 40 px of wheel, so a touchpad does not race).
  imageView(t) {
    const p = this.picture, b = this.imageBase(), s = this.imageScale();
    const pic = image(p.staged).flex_none().w(b.w * s).h(b.h * s);
    const box = div().id(`files-img-${this.file}`).flex_1().min_h(0).p(10).bg(t.canvas)
      .on_scroll_wheel((e, cx) => {
        if (!(e.modifiers?.control || e.modifiers?.platform)) return;
        cx.stop_propagation();
        this.wheel = (this.wheel ?? 0) + (e.delta?.y ?? 0);
        if (Math.abs(this.wheel) < 40) return;
        this.zoomStep(this.wheel > 0 ? 1 : -1, cx);
        this.wheel = 0;
      });
    return this.zoom === "fit"
      ? box.flex().items_center().justify_center().overflow_hidden().child(pic)
      : box.overflow_scroll().child(pic);
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
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), kind = kindOf(entry.name, entry.dir, open);
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          this.keepKeys(!entry.dir);
          entry.dir ? this.toggle(path, cx) : this.show(path, cx);
        })
        .on_mouse_down("right", (e, cx) => { cx.stop_propagation(); this.contextMenu(entry, path, e); })
        .child(entry.dir ? svg(`mods/files-md/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files-md/${kind.icon}.svg`).size(14).flex_none().text_color(kind.color.startsWith("#") ? kind.color : t[kind.color]))
        .child(div().flex_1().min_w(0).truncate().child(entry.name)));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (kitOff()) return offView();
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      // The space for an image: the panel minus the 42 px header, the 10 px padding and the border.
      // on_size_change reports px with the app zoom applied, while w() and h() are unzoomed: divide.
      .on_size_change((size, cx) => {
        const zoom = Number(settings()?.zoom) > 0 ? Number(settings().zoom) : 1;
        const view = { width: Math.max(1, size.width / zoom - 22), height: Math.max(1, size.height / zoom - 64) };
        if (!this.view || this.view.width !== view.width || this.view.height !== view.height) { this.view = view; if (this.picture) cx.notify(); }
      })
      // Esc in the preview goes back to the tree or the results. Else, in a dialog, Esc closes it
      // (the filter field handles its own Esc first).
      .on_key_down((e, cx) => {
        // Zoom keys of an image: + or = in, - out, 0 for 100%, f for Fit.
        if (this.picture && ["+", "=", "-", "0", "f"].includes(e.key) && !e.modifiers?.control && !e.modifiers?.alt) {
          if (e.key === "0") this.setZoom(1, cx);
          else if (e.key === "f") this.setZoom("fit", cx);
          else this.zoomStep(e.key === "-" ? -1 : 1, cx);
          cx.stop_propagation();
          return;
        }
        if (e.key !== "escape") return;
        if (this.file) this.back(cx);
        else if (this.dialog()) closeOverlay(this.dialog());
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => this.back(cx)).child("←")))
        .child(div().font_semibold().child("Files"))
        .when(Boolean(this.on), el => el.child(machineChip(t, this.on)))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file
          ? [this.file, this.picture?.w ? `${this.picture.w}×${this.picture.h}` : null, this.picture ? kb(this.picture.bytes) : null].filter(Boolean).join(" · ")
          : this.root?.split(/[\\/]/).pop() ?? ""))
        .when(Boolean(this.picture), el => el.child(this.zoomBar(t)))
        .when(Boolean(this.file) && this.text !== null && isMarkdown(this.file), el => el.child(div().id("files-source").flex_none().px(8).py(3).rounded(6).cursor_pointer().text_size(12).text_color(t.muted)
          .hover(s => s.bg(t.hover)).on_click((_e, cx) => { this.keepKeys(); this.toggleSource(cx); }).child(this.rendered ? "Source" : "Rendered"))))
      .when(!this.file && Boolean(this.root), el => el.child(this.filterBar(t)))
      .when(!this.file && this.results !== null, el => el.child(v_flex().id("files-found").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .children(this.resultRows(t))
        .when(!this.results.length || this.total > this.results.length || Boolean(this.indexError), el => el.child(div().p(8).text_size(12).text_color(t.dim)
          .child(this.indexError || (!this.results.length ? (this.indexing || !this.index ? "Indexing files…" : "No match")
            : `Showing the best ${this.results.length} of ${this.total} matches`))))
        .when(this.index?.length >= INDEX_MAX, el => el.child(div().p(8).text_size(11).text_color(t.dim).child(`The filter searches the first ${INDEX_MAX.toLocaleString("en-US")} files and folders`)))))
      .when(!this.file && this.results === null, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .when(Boolean(this.root), el => el.on_mouse_down("right", (e, cx) => { cx.stop_propagation(); this.contextMenu(null, "", e); }))
        .children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.rendered && this.text !== null
        // The id changes with the file, so the rendered text and its scroll start over for each one.
        ? div().id(`files-doc-${this.file}`).flex_1().min_h(0).overflow_y_scrollbar().p(14)
          .child(TextView.markdown(`files-md-${this.file}`, this.text || "*This file is empty.*").w_full().text_size(13).text_color(t.foreground).selectable(true).scrollable(false))
        : this.picture ? this.imageView(t)
        : this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || (isImage(this.file) ? "Loading image…" : "Loading file…"))));
  }
}
