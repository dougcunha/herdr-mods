// The files of a Jira issue (its attachments), saved into `.jira/<KEY>/` of the shown space.
// The folder is the root of the checkout where the space works now (a worktree space gets its own),
// else the live folder of the space. Only for a space on this computer: the sign-in stays here.
// Herdr's fetch reads text only, so curl downloads the files. The sign-in never goes on a command
// line: curl reads it from a file in a private folder (`-K`), and that file is deleted after each download.
// curl sends the sign-in only to the Jira site, not to a host that Jira redirects to.
// An archive (.zip, .tar, .tar.gz, .tgz, .tar.bz2, .tar.xz; .7z and .rar on Windows and macOS) can be extracted
// into a folder with its name.

import { exec, appHome, writeTextFile, panes } from "herdr";
import { credentials, trustedSite, platform } from "./jira-client.js";

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const ARCHIVE = /\.(zip|tar|tgz|tbz2?|txz|tar\.(gz|bz2|xz))$/i;
// bsdtar (the tar of Windows and macOS) reads these too; the GNU tar of Linux does not.
const BSD_ONLY = /\.(7z|rar)$/i;
const ending = (name) => (platform() !== "linux" && BSD_ONLY.test(name) ? BSD_ONLY : ARCHIVE);
const LONG = 600000; // exec's longest timeout: 10 minutes for one file
export const isArchive = (name) => ending(name ?? "").test(name ?? "");

// A size for people: 812 B, 14 KB, 2.3 MB.
export function sizeText(n) {
  if (!(n >= 0)) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 || u === 0 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

// A file name from Jira is not trusted: no folder parts, no control or reserved characters,
// no leading dot or dash, no name that Windows keeps for a device.
function safeName(name) {
  let n = String(name ?? "").replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, "_").replace(/^[\s.-]+/, "").replace(/[\s.]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = `_${n}`;
  if (n.length > 150) n = `${n.slice(0, 110)}${n.slice(-40)}`;
  return n || "attachment";
}
const stem = (file) => file.replace(ending(file), "") || file;

// The file name on disk of each attachment: Map(id → name). Jira permits 2 files with the same
// name: the later ones get their id before the extension, so no file replaces an other one.
export function fileNames(list) {
  const names = new Map(), used = new Set();
  for (const a of list ?? []) {
    let n = safeName(a.name);
    if (used.has(n.toLowerCase())) {
      const dot = n.search(ending(n)) >= 0 ? n.search(ending(n)) : n.lastIndexOf(".");
      n = dot > 0 ? `${n.slice(0, dot)} (${a.id})${n.slice(dot)}` : `${n} (${a.id})`;
    }
    used.add(n.toLowerCase());
    names.set(a.id, n);
  }
  return names;
}

// PowerShell reads the curly quotes as quotes too.
const psQuote = (s) => `'${String(s).replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;
const ps = (script) => exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
const windows = () => platform() === "windows";
const said = (r) => String(r?.stderr || r?.stdout || "").trim().slice(0, 300);

// `privately`: the folder of the sign-in files, for this user only. A sign-in file that an earlier
// download left behind (Herdr stopped, or curl ran too long) is deleted here.
async function makeDir(dir, privately = false) {
  const r = await (windows()
    ? ps(`[void][System.IO.Directory]::CreateDirectory(${psQuote(dir)})${privately ? `; Get-ChildItem -LiteralPath ${psQuote(dir)} -Filter 'c-*' | Remove-Item -Force` : ""}`)
    : exec("sh", ["-c", privately ? 'mkdir -p "$1" && chmod 700 "$1" && rm -f "$1"/c-*' : 'mkdir -p "$1"', "sh", dir])).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
  if (r.code !== 0) throw new Error(`Can't make the folder ${dir}. ${said(r)}`);
}
const removeFile = (file) => (windows() ? ps(`Remove-Item -LiteralPath ${psQuote(file)} -Force -ErrorAction SilentlyContinue`) : exec("rm", ["-f", file])).catch(() => null);

// Where the files of `key` go for `space`: <root>/.jira/<KEY>. The root is the checkout of the
// space's live folder (its focused terminal, else its first one), else that folder itself.
export async function targetFolder(space, key) {
  if (!space) throw new Error("No space is shown.");
  if (space.machine) throw new Error("Downloads work only for a space on this computer.");
  if (!KEY.test(key ?? "")) throw new Error("That isn't a Jira issue key.");
  const tabs = new Set((space.tabs ?? []).map((t) => t.id));
  const here = panes().filter((p) => p.cwd && tabs.has(p.tab));
  const cwd = (here.find((p) => p.focused) ?? here[0])?.cwd || space.folder;
  if (!cwd) throw new Error("The space has no folder.");
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => null);
  const root = (top?.code === 0 && top.stdout.trim()) || cwd;
  return `${root.replace(/[\\/]+$/, "")}/.jira/${key}`;
}
// The folder as the system writes it.
export const shownPath = (dir) => (windows() ? dir.replace(/\//g, "\\") : dir);

// A curl config file with the sign-in, in `dir` (a folder that only this user opens). The caller deletes it.
async function authFile(c, dir) {
  const user = `${c.email}:${c.token}`;
  if (/[\r\n]/.test(user) || c.email.includes(":")) throw new Error("The Jira sign-in has characters that curl can't read.");
  const file = `${dir}/c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await writeTextFile(file, `user = "${user.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`, null);
  return file;
}

// Extracts an archive into `out`. bsdtar (Windows, macOS) reads zip too; Linux needs unzip for a zip.
async function unpack(file, out) {
  await makeDir(out);
  const run = async (cmd, args) => exec(cmd, args, { timeout: LONG });
  let r;
  if (platform() === "linux" && /\.zip$/i.test(file)) r = await run("unzip", ["-o", "-q", file, "-d", out]);
  // Windows: its own tar, not the GNU tar of Git (that one can't read a zip and reads "C:" as a host).
  else if (windows()) r = await run("C:\\Windows\\System32\\tar.exe", ["-xf", file, "-C", out]).catch(() => run("tar", ["-xf", file, "-C", out]));
  else r = await run("tar", ["-xf", file, "-C", out]);
  if (r.code !== 0) throw new Error(`Extract failed. ${said(r)}`);
}

// Downloads `items` ([{ id, file }], file from fileNames) of the issue `key` into the folder of `space`.
// `extract`: each archive is also extracted, into a folder with its name next to it.
// `step(id, state, note)` tells the progress of each file: "loading", "done" or "failed".
// Resolves with { dir, failed (a count) }; rejects when nothing can start (no sign-in, no folder).
export async function saveAttachments({ site, key, space, items, extract = false, step = () => {} }) {
  if (!trustedSite(site)) throw new Error(`${site} isn't a Jira site of yours.`);
  const c = await credentials(site);
  if (!c) throw new Error(`No Jira sign-in for ${site}.`);
  const dir = await targetFolder(space, key);
  await makeDir(dir);
  const secrets = `${appHome()}/data/issues-app/private`;
  await makeDir(secrets, true);
  let failed = 0;
  for (const a of items) {
    if (!/^\d+$/.test(a.id)) continue;
    step(a.id, "loading");
    let cfg = null;
    try {
      const dest = `${dir}/${a.file}`;
      cfg = await authFile(c, secrets);
      // -q: no .curlrc. The URL is built here, never taken from Jira's answer.
      const r = await exec("curl", ["-q", "-K", cfg, "--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https",
        "-o", dest, `https://${site}/rest/api/3/attachment/content/${a.id}`], { timeout: LONG });
      if (r.code !== 0) throw new Error(said(r) || `curl stopped with code ${r.code}.`);
      if (extract && isArchive(a.file)) await unpack(dest, `${dir}/${stem(a.file)}`);
      step(a.id, "done", extract && isArchive(a.file) ? "Extracted" : "Saved");
    } catch (e) {
      failed++;
      step(a.id, "failed", String(e?.message ?? e).slice(0, 300));
    } finally {
      if (cfg) await removeFile(cfg);
    }
  }
  return { dir, failed };
}
