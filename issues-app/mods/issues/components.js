// The Repo chip of the list: the Jira issues of the repository of the shown space, found by the
// Jira "component" field. Which components belong to a repository:
//   1. a `components = "A, B"` line in `.herdr/jira.toml` of the main checkout (before the first
//      [[project]] block: the whole repository; inside a block: only that project, and it wins),
//   2. else the name of the folder of the main checkout (case does not matter).
// The Repository components dialog (components-dialog.js) writes that line.
// The component list of a Jira project is kept in shared("issues.componentList") until the person
// presses Reload in that dialog: components change rarely.

import { exec, readTextFile, writeTextFile, shared, setShared, window as appWindow } from "herdr";
import { call } from "./jira-client.js";

export const FILE = ".herdr/jira.toml";
const LIST = "issues.componentList";

const unquote = (s) => s.replace(/\\(.)/g, "$1");
const quote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** "A, B" as ["A", "B"]: trimmed, without empty names and doubles. */
export function splitNames(text) {
  const seen = new Set(), out = [];
  for (const raw of String(text ?? "").split(",")) {
    const n = raw.trim();
    if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); out.push(n); }
  }
  return out;
}

/** The name of the folder of the main checkout of a repository ({ main, on }). */
export const repoName = (repo) => String(repo?.main ?? "").split(/[/\\]/).filter(Boolean).pop() ?? "";

// The value of a `components` line: "A, B" or ["A", "B"].
function valueOf(rest) {
  const text = rest.trim();
  const strings = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unquote(m[1]));
  if (text.startsWith("[")) return splitNames(strings.join(","));
  return splitNames(strings[0] ?? "");
}

/**
 * The components named in the text of a `.herdr/jira.toml`:
 * { top: string[] | null (the line before the first block), byKey: Map(project key → string[]) }.
 */
export function parseComponents(text) {
  const out = { top: null, byKey: new Map() };
  let block = null; // null: before the first header; { key, components }: in a [[project]]; false: another table
  const close = () => { if (block && block.key && block.components) out.byKey.set(block.key, block.components); };
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[project]]") { close(); block = { key: null, components: null }; continue; }
    if (line.startsWith("[")) { close(); block = false; continue; }
    const m = /^([A-Za-z_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === "components") {
      const names = valueOf(m[2]);
      if (block === null) out.top = names;
      else if (block) block.components = names;
    } else if (m[1] === "key" && block) {
      block.key = /^"((?:[^"\\]|\\.)*)"/.exec(m[2].trim())?.[1] ?? null;
    }
  }
  close();
  return out;
}

/** What `.herdr/jira.toml` of the repository says about components (nothing: top null, no keys). */
export async function fileComponents(repo) {
  if (!repo?.main) return { top: null, byKey: new Map() };
  const text = await readTextFile(`${repo.main}/${FILE}`, { on: repo.on }).catch(() => null);
  return parseComponents(text);
}

/** The component names to look for in project `p`: { names, from: "project" | "file" | "folder" }. */
export function wantedFor(file, p, repo) {
  const own = file.byKey.get(p.key);
  if (own?.length) return { names: own, from: "project" };
  if (file.top?.length) return { names: file.top, from: "file" };
  const folder = repoName(repo);
  return { names: folder ? [folder] : [], from: "folder" };
}

// ---- The component list of a Jira project -------------------------------------------

const listKey = (p) => `${p.site}|${p.key}`;
const asking = new Map();

/** The kept list of project `p` ({ site, key }): { names, at } or null. */
export function cachedComponents(p) {
  const v = shared(LIST)?.[listKey(p)];
  return v && Array.isArray(v.names) ? v : null;
}

/** The component list of project `p`: the kept one, else asked of Jira. `reload`: ask Jira again. */
export async function projectComponents(p, reload = false) {
  const kept = reload ? null : cachedComponents(p);
  if (kept) return kept;
  const id = listKey(p);
  if (!asking.has(id)) {
    asking.set(id, (async () => {
      const list = await call(p.site, `/rest/api/3/project/${encodeURIComponent(p.key)}/components`);
      const names = (Array.isArray(list) ? list : []).map((c) => String(c?.name ?? "")).filter(Boolean).sort((a, b) => a.localeCompare(b));
      const value = { names, at: Date.now() };
      setShared(LIST, { ...(shared(LIST) ?? {}), [id]: value });
      return value;
    })().finally(() => asking.delete(id)));
  }
  return asking.get(id);
}

/** The names of `wanted` that project `p` has, spelled as Jira spells them (case does not matter). */
export async function resolveComponents(p, wanted) {
  const { names } = await projectComponents(p);
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  return [...new Set(wanted.map((w) => byLower.get(w.toLowerCase())).filter(Boolean))];
}

/** JQL: `component in ("A", "B")`. */
export const componentJql = (names) => `component in (${names.map(quote).join(", ")})`;

// ---- Writing the line -----------------------------------------------------------------

/**
 * The text of the file with the top `components` line set to `names` (no names: the line goes).
 * Changes only that line: the rest of the file and its comments stay. `text` null: no file yet.
 */
export function withComponents(text, names) {
  const eol = text?.includes("\r\n") ? "\r\n" : "\n";
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.length && lines.at(-1) === "") lines.pop();
  const header = lines.findIndex((l) => /^\s*\[/.test(l));
  const end = header < 0 ? lines.length : header;
  const at = lines.slice(0, end).findIndex((l) => /^\s*components\s*=/.test(l));
  const line = names.length ? `components = ${quote(names.join(", "))}` : null;
  if (at >= 0) {
    if (line) lines[at] = line; else lines.splice(at, 1);
  } else if (line) {
    if (header < 0) lines.push(line);
    else {
      // Before the first block, and before the comment lines that sit right above it.
      let at2 = header;
      while (at2 > 0 && /^\s*#/.test(lines[at2 - 1])) at2--;
      lines.splice(at2, 0, line, "");
    }
  }
  return lines.length ? lines.join(eol) + eol : "";
}

const isWindows = () => { try { return appWindow().platform === "windows"; } catch { return false; } };

/**
 * Writes the `components` line of the repository's `.herdr/jira.toml` (here with writeTextFile, on another
 * machine with `sh`). Makes no commit. Throws an Error with a message for the person.
 */
export async function saveComponents(repo, names) {
  if (!repo?.main) throw new Error("This space has no git repository.");
  const path = `${repo.main}/${FILE}`;
  const now = await readTextFile(path, { on: repo.on }).catch(() => null);
  if (now == null && !names.length) return;
  const next = withComponents(now, names);
  if (next === now) return;
  if (repo.on) {
    // Another machine: writeTextFile writes here only. A POSIX shell is needed there.
    const again = await readTextFile(path, { on: repo.on }).catch(() => null);
    if (again !== now) throw new Error(`${FILE} changed while you edited. Open the dialog again.`);
    const r = await exec("sh", ["-c", 'mkdir -p "$1/.herdr" && printf %s "$2" > "$1/.herdr/jira.toml"', "sh", repo.main, next], { on: repo.on })
      .catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
    if (r.code !== 0) throw new Error(`Could not write ${FILE} on ${repo.on}: ${String(r.stderr || r.stdout || "sh failed").trim()}`);
    return;
  }
  const dir = `${repo.main}/.herdr`;
  await (isWindows()
    ? exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `New-Item -ItemType Directory -Force -Path '${dir.replace(/['\u2018-\u201B]/g, "$&$&")}' | Out-Null`])
    : exec("mkdir", ["-p", dir])).catch(() => null);
  try { await writeTextFile(path, next, now); }
  catch (e) { throw new Error(`Could not write ${FILE}: ${String(e?.message ?? e)}`); }
}

/** The line that the person can paste into the file by hand. */
export const lineFor = (names) => `components = ${quote(names.join(", "))}`;
