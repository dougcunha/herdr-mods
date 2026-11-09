// The files and the shared keys of the mod.
//
// data/automations.json        { "automations": [ <automation> ] }: the definitions. People
//                              can edit the file by hand; the runner reads it again.
// data/automation-runs.json    { "<automation id>": [ <run summary>, newest first ] }: the
//                              last 50 runs of each automation. Only the runner writes it.
// data/automation-runs/<run>/  the files of 1 run: prompt.md, the scripts, their output,
//                              output.txt (headless stdout), result.md (written by the agent),
//                              tail.txt (the last lines of the agent).

import { appHome, readTextFile, writeTextFile, shared, setShared } from "herdr";
import * as fs from "fs/promises";

export const MOD = "automations";
export const KEEP_RUNS = 50;

export const KEY = {
  lang: "herdr-mods.lang",
  disabled: "herdr-mods.disabled",
  leader: "automations.leader", // { copy, at }: the status copy that runs the automations
  running: "automations.running", // [ <active run> ]: runs that are not finished
  state: "automations.state", // { "<id>": { lastFired } }
  queue: "automations.queue", // { "<id>": { trigger, vars } }: 1 waiting run (overlap "queue")
  requests: "automations.requests", // [ { id, at, by } ]: "Run now" of a copy that is not the runner
  rev: "automations.rev", // changes when a copy saves the definitions
  runsRev: "automations.runsRev", // changes when the runner writes the history
  focus: "automations.focus", // { automation, run }: what the dialog shows when it opens
};

const slash = (p) => String(p ?? "").replace(/\\/g, "/");
export const dataDir = () => `${slash(appHome())}/data`;
export const defsPath = () => `${dataDir()}/automations.json`;
export const runsPath = () => `${dataDir()}/automation-runs.json`;
export const runDir = (runId) => `${dataDir()}/automation-runs/${runId}`;

export const newId = (prefix = "") => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// kind: "none" | "file" (cmd is the path of a script) | "inline" (cmd is the script text).
const script = () => ({ kind: "none", cmd: "", timeout: 60 });

/** Only a path: one word (or one quoted text) on one line. */
export const looksLikeFile = (cmd) => /^(?:"[^"\n]+"|'[^'\n]+'|\S+\.[a-z0-9]+)$/i.test(String(cmd ?? "").trim());

/** A script with a kind. Old automations have no kind: it comes from the text. */
function normScript(s) {
  const x = { ...script(), ...(isObj(s) ? s : {}) };
  if (!["none", "file", "inline"].includes(s?.kind)) x.kind = !x.cmd.trim() ? "none" : looksLikeFile(x.cmd) ? "file" : "inline";
  if (x.kind === "none") x.cmd = "";
  return x;
}

/** A new automation with every field. */
export function blank() {
  return {
    id: newId("a"),
    name: "",
    enabled: true,
    agent: "claude",
    mode: "headless", // "headless" | "interactive"
    command: "", // headless: a custom command ({prompt}, {prompt_file}, {run_dir}); "" = the built-in one
    args: "", // more arguments for the agent
    folder: "",
    space: null, // a fixed space id (interactive), else the space that works in the folder
    prompt: "",
    trigger: {
      type: "manual", // "manual" | "schedule" | "agent" | "files" | "git"
      schedule: { kind: "daily", minutes: 60, time: "09:00", days: [1, 2, 3, 4, 5], cron: "0 9 * * 1-5" },
      agent: { statuses: ["done"], anyFolder: false, app: "" },
      files: { glob: "" },
      git: { commit: true, branch: false },
    },
    check: script(),
    pre: script(),
    post: script(),
    overlap: "skip", // "skip" | "queue" | "parallel"
    catchUp: false,
    tabEnd: "keep", // "keep" | "close-ok" | "close"
    timeout: 60, // minutes, for the agent
    notify: "failures", // "failures" | "all" | "skips" | "never"
    requireResult: false,
    updatedAt: Date.now(),
  };
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Fills the missing fields of an automation from blank(), deep for the known objects. */
export function normalize(a) {
  const b = blank();
  if (!isObj(a)) return b;
  const t = isObj(a.trigger) ? a.trigger : {};
  return {
    ...b,
    ...a,
    id: typeof a.id === "string" && a.id ? a.id : b.id,
    trigger: {
      ...b.trigger,
      ...t,
      schedule: { ...b.trigger.schedule, ...(isObj(t.schedule) ? t.schedule : {}) },
      agent: { ...b.trigger.agent, ...(isObj(t.agent) ? t.agent : {}) },
      files: { ...b.trigger.files, ...(isObj(t.files) ? t.files : {}) },
      git: { ...b.trigger.git, ...(isObj(t.git) ? t.git : {}) },
    },
    check: normScript(a.check),
    pre: normScript(a.pre),
    post: normScript(a.post),
  };
}

export async function ensureDir(dir) {
  try { await fs.mkdir(dir, { recursive: true }); } catch { /* it exists */ }
}

/** Reads the definitions: { list, text }. A broken file gives an error. */
export async function loadDefs() {
  const text = await readTextFile(defsPath());
  if (text == null) return { list: [], text: null };
  let json;
  try { json = JSON.parse(text); } catch (e) { return { list: null, text, error: `automations.json: ${e?.message ?? e}` }; }
  const raw = Array.isArray(json?.automations) ? json.automations : [];
  return { list: raw.map(normalize), text };
}

/** Changes the definitions with `change(list) => list`, on the newest file. Returns the new list. */
export async function updateDefs(change) {
  await ensureDir(dataDir());
  for (let i = 0; i < 3; i++) {
    const cur = await loadDefs();
    if (cur.list == null) throw new Error(cur.error);
    const list = change(cur.list.map((a) => ({ ...a })));
    const text = `${JSON.stringify({ automations: list }, null, 2)}\n`;
    try {
      await writeTextFile(defsPath(), text, cur.text);
      setShared(KEY.rev, Date.now());
      return list;
    } catch (e) {
      if (i === 2) throw e;
    }
  }
  return null;
}

/** Reads the history index: { index, text }. */
export async function loadRuns() {
  const text = await readTextFile(runsPath());
  if (text == null) return { index: {}, text: null };
  try {
    const json = JSON.parse(text);
    return { index: isObj(json) ? json : {}, text };
  } catch {
    return { index: {}, text };
  }
}

export const getShared = (key, fallback) => shared(key) ?? fallback;

/** The mods-hub turned this mod off. */
export const kitOff = () => { const v = shared(KEY.disabled); return Array.isArray(v) && v.includes(MOD); };

/** Reads a text file of a run, or "". */
export async function runFile(runId, name) {
  try { return (await readTextFile(`${runDir(runId)}/${name}`)) ?? ""; } catch { return ""; }
}

/** Writes a text file (new or replaced). Only under ~/.config/herdr-app. */
export async function writeFile(path, text) {
  await fs.writeFile(path, String(text ?? ""));
}

/** Deletes the folder of a run (it has only files). */
export async function removeRunDir(runId) {
  const dir = runDir(runId);
  try {
    for (const name of await fs.readdir(dir)) await fs.unlink(`${dir}/${name}`).catch(() => null);
    await fs.rmdir(dir);
  } catch { /* not there */ }
}
