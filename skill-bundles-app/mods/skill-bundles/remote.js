// Files on another machine (a space on a machine of `hc machine ls`).
// The mod API reads a file there (readTextFile with `on`), but writes only on this
// computer. So a write on another machine runs node there. The same file is in the
// spec-board and skill-bundles mods.

import { exec, home, window, readTextFile, writeTextFile } from "herdr";

const slash = (p) => String(p ?? "").replace(/\\/g, "/").replace(/([^:/])\/+$/, "$1");
const infos = new Map();

/**
 * The system of a machine: { windows, home }. Null `on` is this computer.
 * A Windows machine with Git Bash also has `sh`, so `uname` tells the two apart.
 * Rejects when no shell runs there.
 */
export async function machineInfo(on) {
  if (!on) return { windows: window()?.platform === "windows", home: slash(home()) };
  if (infos.has(on)) return infos.get(on);
  let info = null;
  try {
    const r = await exec("sh", ["-c", 'uname -s; printf "%s\\n" "$HOME"'], { on, timeout: 20000 });
    const [uname, h] = r.stdout.split("\n").map((s) => s.trim());
    if (r.code === 0 && uname && !/^(MINGW|MSYS|CYGWIN)/i.test(uname)) info = { windows: false, home: slash(h) };
  } catch {}
  if (!info) {
    for (const ps of ["pwsh", "powershell"]) {
      try {
        const r = await exec(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$HOME"], { on, timeout: 20000 });
        if (r.code === 0 && r.stdout.trim()) { info = { windows: true, home: slash(r.stdout.trim()) }; break; }
      } catch {}
    }
  }
  if (!info) throw new Error(`Could not run a shell on ${on}`);
  infos.set(on, info);
  return info;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The UTF-8 bytes of `text` in base64. */
function base64(text) {
  const bin = unescape(encodeURIComponent(text));
  let out = "";
  for (let i = 0; i < bin.length; i += 3) {
    const a = bin.charCodeAt(i);
    const b = i + 1 < bin.length ? bin.charCodeAt(i + 1) : -1;
    const c = i + 2 < bin.length ? bin.charCodeAt(i + 2) : -1;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b < 0 ? 0 : b >> 4)]
      + (b < 0 ? "=" : B64[((b & 15) << 2) | (c < 0 ? 0 : c >> 6)]) + (c < 0 ? "=" : B64[c & 63]);
  }
  return out;
}

// Writes a part of the file into "<path>.herdr-tmp"; the last part renames it to <path>.
const WRITE = "const fs=require('fs');const [p,first,last,d]=process.argv.slice(1);const t=p+'.herdr-tmp';"
  + "fs[first==='1'?'writeFileSync':'appendFileSync'](t,Buffer.from(d,'base64'));if(last==='1')fs.renameSync(t,p);";
// A command line on Windows takes at most 32767 characters.
const PART = 12000;

/**
 * writeTextFile on the machine `on` (null: this computer). With `expected` (a text, or null
 * for "no file"), it rejects when the file on disk is not that text.
 */
export async function writeFileOn(on, path, text, expected) {
  if (!on) return writeTextFile(path, text, expected);
  if (expected !== undefined) {
    const now = await readTextFile(path, { on }).catch(() => null);
    if ((now ?? null) !== (expected ?? null)) throw new Error(`${path} changed on disk.`);
  }
  const data = base64(String(text));
  const parts = Math.max(1, Math.ceil(data.length / PART));
  for (let i = 0; i < parts; i++) {
    const r = await exec("node", ["-e", WRITE, path, i === 0 ? "1" : "0", i === parts - 1 ? "1" : "0", data.slice(i * PART, (i + 1) * PART)], { on });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || `node exit ${r.code}`).trim());
  }
}
