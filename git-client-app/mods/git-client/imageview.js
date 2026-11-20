// Image preview for the Changes tab and its Expand dialog: shows Added/Untracked/Deleted images
// and Before/After (or Ours/Theirs) comparisons for modified or conflicted images.
//
// image() only loads paths inside the app folder (absolute paths and ".." do not load), so files
// and git blobs are staged into data/git-client-img/ and deleted when the selection or panel closes.
import { div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, window, theme, settings, checking } from "herdr";
import { READ, imagePlan } from "./git.js";
import { currentView } from "./diffview.js";

const CACHE = "data/git-client-img";
const MAX_BYTES = 64 * 1024 * 1024;
const CARD_HEAD = 26;
const PAD = 10;

const kb = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const quote = (s) => "'" + String(s).replaceAll("'", "''") + "'";
const hash = (s) => { let h = 5381; for (const c of String(s)) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(36); };

function parseStageOut(out) {
  const text = String(out ?? "").trim();
  if (!text || text === "missing") return null;
  const [a, w, h] = text.split(" ");
  if (a === "big") throw new Error(`This image is larger than ${kb(MAX_BYTES)}.`);
  const bytes = Number(a), width = Number(w), height = Number(h);
  return { bytes: Number.isFinite(bytes) ? bytes : 0, size: width > 0 && height > 0 ? { w: width, h: height } : null };
}

async function stageWorktreeFile(src, dst) {
  const windows = window()?.platform === "windows";
  if (windows) {
    const script = "& { param($s,$d) if (-not (Test-Path -LiteralPath $s -PathType Leaf)) { 'missing'; return };"
      + " $i=Get-Item -LiteralPath $s -ErrorAction Stop; if ($i.Length -gt " + MAX_BYTES + ") { 'big ' + $i.Length; return };"
      + " New-Item -ItemType Directory -Force (Split-Path $d) | Out-Null; Copy-Item -LiteralPath $s -Destination $d -Force;"
      + " $w=0; $h=0; try { Add-Type -AssemblyName System.Drawing; $m=[System.Drawing.Image]::FromFile($d); $w=$m.Width; $h=$m.Height; $m.Dispose() } catch {};"
      + " '' + $i.Length + ' ' + $w + ' ' + $h } " + quote(src) + " " + quote(dst);
    const r = await exec("powershell", ["-NoProfile", "-Command", script]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read this image");
    return parseStageOut(r.stdout);
  }
  const script = 'if [ ! -f "$1" ]; then echo missing; exit 0; fi; n=$(wc -c < "$1") || exit 1; if [ "$n" -gt ' + MAX_BYTES + ' ]; then echo "big $n"; exit 0; fi; mkdir -p "$(dirname "$2")" && cp "$1" "$2" && printf "%s 0 0\\n" "$(echo "$n" | tr -d " ")"';
  const r = await exec("sh", ["-c", script, "img", src, dst]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read this image");
  return parseStageOut(r.stdout);
}

async function stageGitBlob(root, spec, dst) {
  const sizeRes = await exec("git", [...READ, "cat-file", "-s", spec], { cwd: root });
  if (sizeRes.code !== 0) return null;
  const size = Number(sizeRes.stdout.trim());
  if (size > MAX_BYTES) throw new Error(`This image is larger than ${kb(MAX_BYTES)}.`);
  const windows = window()?.platform === "windows";
  if (windows) {
    const script = "& { param($r,$sp,$d) New-Item -ItemType Directory -Force (Split-Path $d) | Out-Null;"
      + " $psi=New-Object System.Diagnostics.ProcessStartInfo; $psi.FileName='git'; $psi.WorkingDirectory=$r;"
      + " $psi.UseShellExecute=$false; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true; $psi.CreateNoWindow=$true;"
      + " $arg='\"' + ($sp -replace '(\\\\*)\\\"','$1$1\\\\\\\"' -replace '(\\\\+)$','$1$1') + '\"';"
      + " $psi.Arguments='--no-optional-locks cat-file blob ' + $arg;"
      + " $p=[System.Diagnostics.Process]::Start($psi); $et=$p.StandardError.ReadToEndAsync();"
      + " $fs=[System.IO.File]::Create($d); try { $p.StandardOutput.BaseStream.CopyTo($fs) } finally { $fs.Dispose() };"
      + " $err=$et.GetAwaiter().GetResult(); $p.WaitForExit();"
      + " if ($p.ExitCode -ne 0) { Remove-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue; Write-Error $err; exit $p.ExitCode };"
      + " $w=0; $h=0; try { Add-Type -AssemblyName System.Drawing; $m=[System.Drawing.Image]::FromFile($d); $w=$m.Width; $h=$m.Height; $m.Dispose() } catch {};"
      + " '' + (Get-Item -LiteralPath $d).Length + ' ' + $w + ' ' + $h } " + quote(root) + " " + quote(spec) + " " + quote(dst);
    const r = await exec("powershell", ["-NoProfile", "-Command", script]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read this image from git");
    return parseStageOut(r.stdout);
  }
  const script = 'mkdir -p "$(dirname "$2")" && { git --no-optional-locks cat-file blob "$1" > "$2" || { rm -f "$2"; exit 1; }; } && printf "%s 0 0\\n" "$(wc -c < "$2" | tr -d " ")"';
  const r = await exec("sh", ["-c", script, "img", spec, dst], { cwd: root });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read this image from git");
  return parseStageOut(r.stdout);
}

function removeStaged(rels) {
  const list = (rels ?? []).filter(Boolean);
  if (!list.length) return Promise.resolve();
  const paths = list.map((rel) => `${appHome()}/${rel}`);
  if (window()?.platform === "windows") {
    const cmd = paths.map((p) => "Remove-Item -LiteralPath " + quote(p) + " -Force -ErrorAction SilentlyContinue").join("; ");
    return exec("powershell", ["-NoProfile", "-Command", cmd]).catch(() => null);
  }
  return exec("rm", ["-f", ...paths]).catch(() => null);
}

export async function sweepStagedImages() {
  if (checking()) return;
  const dir = `${appHome()}/${CACHE}`;
  try {
    if (window()?.platform === "windows") {
      await exec("powershell", ["-NoProfile", "-Command",
        "Get-ChildItem -LiteralPath " + quote(dir) + " -File -ErrorAction SilentlyContinue | Where-Object LastWriteTime -lt (Get-Date).AddDays(-1) | Remove-Item -Force -ErrorAction SilentlyContinue"]);
    } else {
      // Through sh: a bare "find" can be Windows' find.exe, which waits for input (seen in herdr-app check).
      await exec("sh", ["-c", 'find "$1" -type f -mtime +1 -delete 2>/dev/null; exit 0', "sweep", dir]);
    }
  } catch { /* nothing to sweep */ }
}

export class ImageDiffView {
  constructor(id) {
    this.id = id;
    this.area = { width: 400, height: 300 };
    this.status = "idle";
    this.before = null;
    this.after = null;
    this.error = null;
    this.staged = [];
    this.seq = 0;
  }

  hasPair() { return Boolean(this.before && this.after); }

  clear() {
    this.seq++;
    const old = this.staged;
    this.staged = [];
    this.before = null;
    this.after = null;
    this.error = null;
    this.status = "idle";
    removeStaged(old);
  }

  dispose() {
    this.seq++;
    const old = this.staged;
    this.staged = [];
    this.before = null;
    this.after = null;
    this.error = null;
    this.status = "idle";
    return removeStaged(old);
  }

  // Loads before/after images for `file` on `side`. When `keepCurrent` is true (a background refresh
  // of the same file), keeps the shown images on screen until the fresh ones are staged.
  async load({ root, on, file, side, keepCurrent = false }) {
    const seq = ++this.seq;
    const plan = imagePlan(file, side);
    if (!plan || !root) { this.clear(); return; }
    if (on) {
      this.clear();
      this.status = "error";
      this.error = "Image preview on another machine is not supported yet.";
      return;
    }
    if (!keepCurrent) {
      const old = this.staged;
      this.staged = [];
      this.before = null;
      this.after = null;
      this.error = null;
      this.status = "loading";
      removeStaged(old);
    }

    const ext = file.path.split(".").pop().toLowerCase();
    const stamp = `${hash(file.path)}-${Date.now().toString(36)}-${seq}`;
    const freshStaged = [];
    const stageOne = async (spec, tag) => {
      if (!spec) return null;
      const rel = `${CACHE}/${stamp}-${tag}.${ext}`;
      const dst = `${appHome()}/${rel}`;
      const info = spec.kind === "file"
        ? await stageWorktreeFile(`${root}/${spec.path}`, dst)
        : await stageGitBlob(root, spec.spec, dst);
      if (!info) return null;
      freshStaged.push(rel);
      return { staged: rel, label: spec.label, tone: spec.tone, bytes: info.bytes, size: info.size };
    };

    try {
      const [before, after] = await Promise.all([stageOne(plan.before, "before"), stageOne(plan.after, "after")]);
      if (this.seq !== seq) { removeStaged(freshStaged); return; }
      const old = this.staged;
      this.staged = freshStaged;
      this.before = before;
      this.after = after;
      this.error = null;
      this.status = before || after ? "ready" : "empty";
      removeStaged(old);
    } catch (e) {
      removeStaged(freshStaged);
      if (this.seq !== seq) return;
      const old = this.staged;
      this.staged = [];
      this.before = null;
      this.after = null;
      this.error = String(e?.message ?? e);
      this.status = "error";
      removeStaged(old);
    }
  }

  card(item, boxW, boxH, t) {
    const accent = item.tone === "added" ? t.ansi2 : t.ansi1;
    const availW = Math.max(24, boxW - PAD * 2);
    const availH = Math.max(24, boxH - CARD_HEAD - PAD * 2);
    let pic;
    if (item.size) {
      const s = Math.min(1, availW / item.size.w, availH / item.size.h);
      pic = image(item.staged).flex_none().w(Math.max(1, Math.round(item.size.w * s))).h(Math.max(1, Math.round(item.size.h * s)));
    } else {
      pic = image(item.staged).flex_none().w(availW).h(availH);
    }
    const meta = [item.size ? `${item.size.w}×${item.size.h}` : null, kb(item.bytes)].filter(Boolean).join(" · ");
    return v_flex().flex_1().min_w(0).min_h(0).overflow_hidden()
      .child(h_flex().h(CARD_HEAD).flex_none().px(10).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border)
        .child(div().px(6).py(1).rounded(4).bg(accent + "20").text_size(10.5).font_semibold().text_color(accent).child(item.label))
        .child(div().flex_1())
        .child(div().flex_none().text_size(10.5).text_color(t.muted).child(meta)))
      .child(div().flex_1().min_h(0).p(PAD).bg(t.canvas).flex().items_center().justify_center().overflow_hidden().child(pic));
  }

  render() {
    const t = theme(), split = currentView() === "split";
    const w = this.area.width, h = this.area.height;
    let body;
    if (this.status === "ready") {
      if (this.before && this.after) {
        if (split) {
          const halfW = Math.max(60, Math.floor((w - 1) / 2));
          body = h_flex().size_full().min_h(0)
            .child(this.card(this.before, halfW, h, t))
            .child(div().w(1).h_full().flex_none().bg(t.border))
            .child(this.card(this.after, halfW, h, t));
        } else {
          const scrollable = h < 260;
          const halfH = scrollable ? 160 : Math.max(80, Math.floor((h - 1) / 2));
          body = v_flex().id(`${this.id}-stack`).size_full().min_h(0).when(scrollable, (e) => e.overflow_y_scrollbar())
            .child(scrollable ? div().w_full().h(halfH).flex_none().flex().child(this.card(this.before, w, halfH, t)) : this.card(this.before, w, halfH, t))
            .child(div().h(1).w_full().flex_none().bg(t.border))
            .child(scrollable ? div().w_full().h(halfH).flex_none().flex().child(this.card(this.after, w, halfH, t)) : this.card(this.after, w, halfH, t));
        }
      } else {
        const only = this.after ?? this.before;
        body = this.card(only, w, h, t);
      }
    } else {
      const text = this.status === "loading" ? "Loading image…" : this.status === "error" ? this.error : "No image to preview";
      body = div().p(12).text_size(12).text_color(this.status === "error" ? t.ansi1 : t.dim).child(text);
    }

    return div().id(`${this.id}-area`).flex_1().min_h(0).w_full().overflow_hidden().flex()
      .on_size_change((size, cx) => {
        const zoom = Number(settings()?.zoom) > 0 ? Number(settings().zoom) : 1;
        const next = { width: Math.max(1, Math.round(size.width / zoom)), height: Math.max(1, Math.round(size.height / zoom)) };
        if (next.width !== this.area.width || next.height !== this.area.height) { this.area = next; cx.notify(); }
      })
      .child(body);
  }
}
