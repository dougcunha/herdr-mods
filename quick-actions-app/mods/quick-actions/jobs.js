// Background jobs: an action that runs with no terminal on the screen (where "background"), and an agent
// that writes a script with no tab. Each job is a background terminal of herdr-core (`hc run --bg`).
// The state is in shared("quick-actions.jobs"): { "<kind>:<action id>": job }, kind "run" or "write", so
// every copy shows it. The runner copy that holds the lease checks the running jobs every second: the end,
// the exit code, the timeout. At the end it saves the output in data/quick-actions/output/ and shows a toast.

import { hc, shared, setShared, notify, readTextFile, writeTextFile } from "herdr";
import * as fs from "fs/promises";
import { KEY, dataDir, ensureDir } from "./store.js";

export const jobKey = (kind, id) => `${kind}:${id}`;

/** All jobs: { key: job }. */
export function jobs() {
  const v = shared(KEY.jobs);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

export const jobOf = (kind, id) => jobs()[jobKey(kind, id)] ?? null;
export const isRunning = (j) => j?.status === "running";
export const anyRunning = () => Object.values(jobs()).some(isRunning);

/** Changes the fields of a job (a new key adds it). */
export function putJob(key, patch) {
  const all = jobs();
  setShared(KEY.jobs, { ...all, [key]: { ...(all[key] ?? {}), ...patch } });
}

/** Removes the jobs (and their output files) of actions that are not in `ids` any more. A running job stays. */
export async function pruneJobs(ids) {
  const keep = new Set(ids);
  const all = jobs();
  const gone = Object.keys(all).filter((k) => !keep.has(all[k]?.action) && !isRunning(all[k]));
  if (!gone.length) return;
  const next = { ...all };
  for (const k of gone) delete next[k];
  setShared(KEY.jobs, next);
  for (const k of gone) await fs.unlink(outputPath(k)).catch(() => null);
}

/** The minutes before a background job is stopped (the setting, else 30). */
export function timeoutMin() {
  const n = Number(shared(KEY.timeout));
  return Number.isFinite(n) && n > 0 ? n : 30;
}

const outputDir = () => `${dataDir()}/quick-actions/output`;
export const outputPath = (key) => `${outputDir()}/${key.replace(/[^a-z0-9-]+/gi, "-")}.txt`;

/** Starts a background terminal (`hc run --bg`) and returns its address. */
export async function startTerminal({ argv, cwd, on, labels = {} }) {
  const args = ["run", "--bg", "--json", "--no-parent", "--no-notify"];
  for (const [k, v] of Object.entries(labels)) args.push("--label", `${k}=${v}`);
  if (on) args.push("--on", on);
  if (cwd) args.push("--cwd", cwd);
  const r = await hc([...args, "--", ...argv]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "hc run failed").trim());
  let address = null;
  try { address = JSON.parse(r.stdout)?.address ?? null; } catch { address = null; }
  if (!address) address = /\b((?:[\w-]+\/)?t[0-9a-z]+)\b/.exec(r.stdout)?.[1] ?? null;
  if (!address) throw new Error(`hc run gave no terminal: ${r.stdout.trim()}`);
  return address;
}

/** Records a new running job. */
export function addJob(key, fields) {
  const now = Date.now();
  setShared(KEY.jobs, {
    ...jobs(),
    [key]: { status: "running", started: now, deadline: now + timeoutMin() * 60000, code: null, ended: null, reason: "", stopping: false, timedOut: false, ...fields },
  });
}

/** Stops a running job (the Stop button). */
export async function stopJob(key) {
  const j = jobs()[key];
  if (!isRunning(j)) return;
  putJob(key, { stopping: true });
  await hc(["kill", j.address]).catch(() => null);
}

/**
 * The state of a core terminal ({ state, exit_code, reason }), { gone: true } when herdr-core does not know it
 * (`not_found`), or null when the answer did not come (a slow machine): then the job waits for the next check.
 */
async function terminalInfo(address) {
  const r = await hc(["get", address, "--json"]).catch(() => null);
  if (!r) return null;
  let j = null;
  try { j = JSON.parse(r.stdout || r.stderr || "null"); } catch { j = null; }
  if (j?.error) return j.error.kind === "not_found" ? { gone: true } : null;
  if (r.code !== 0 || !j) return null;
  return j.terminal ?? j;
}

/** The text of the screen and history of a terminal. */
async function screenText(address) {
  const r = await hc(["read", address, "--lines", "2000"]).catch(() => null);
  return r?.code === 0 ? r.stdout.replace(/\s+$/, "") : "";
}

/** The output of a job: live while it runs, else the saved file. */
export async function jobOutput(key) {
  const j = jobs()[key];
  if (!j) return "";
  if (isRunning(j)) return j.outFile ? (await readTextFile(j.outFile).catch(() => null)) ?? "" : screenText(j.address);
  return (await readTextFile(outputPath(key)).catch(() => null)) ?? "";
}

/** A short signature of a file (length and a hash), or null when it is not there. */
export async function fileSignature(path) {
  const text = await readTextFile(path).catch(() => null);
  if (text == null) return null;
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

const lastLine = (text) => String(text ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() ?? "";
const seconds = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60000)} min`);

/** Ends a job: saves its output, removes its terminal, writes its status and shows a toast. */
async function finish(key, j, info) {
  // Two copies (the runner and an open dialog) can see the end: the first one marks the job before its
  // first await, so the other one skips it. The mods run in one JavaScript thread.
  const cur = jobs()[key];
  if (!isRunning(cur) || (cur.ending && Date.now() - cur.ending < 60000)) return;
  putJob(key, { ending: Date.now() });
  if (info?.gone) info = null;
  let text = j.outFile ? (await readTextFile(j.outFile).catch(() => null)) ?? "" : info ? await screenText(j.address) : "";
  text = text.replace(/\s+$/, "");
  const code = info?.exit_code ?? null;
  let status;
  let reason = "";
  if (!info) { status = "lost"; reason = "The background terminal is gone: Herdr or herdr-core restarted, or it was removed."; }
  else if (j.timedOut) { status = "timed out"; reason = `Stopped after the timeout of ${timeoutMin()} min. A background job cannot answer a question (a password, Read-Host).`; }
  else if (j.stopping) { status = "stopped"; reason = "Stopped."; }
  else if (code === 0) status = "ok";
  else { status = "failed"; reason = `Exit code ${code ?? "?"}${lastLine(text) ? `: ${lastLine(text)}` : "."}`; }
  // An agent that ends with 0 but did not write the file did not do its work.
  if (status === "ok" && j.kind === "write" && j.file && (await fileSignature(j.file)) === (j.before ?? null)) {
    status = "failed";
    reason = `The agent ended, but ${j.fileShown ?? "the script file"} did not change.${lastLine(text) ? ` Its last line: ${lastLine(text)}` : ""}`;
  }
  // The agent wrote the script in its work folder: copy it to its place.
  if (status === "ok" && j.kind === "write" && j.target && j.target !== j.file) {
    try {
      const script = await readTextFile(j.file);
      if (script == null) throw new Error("the file of the agent is gone");
      await fs.writeFile(j.target, script).catch(async () => {
        await writeTextFile(j.target, script, await readTextFile(j.target).catch(() => null));
      });
    } catch (e) {
      status = "failed";
      reason = `Cannot save ${j.fileShown ?? j.target}: ${e?.message ?? e}`;
    }
  }
  try {
    await ensureDir(outputDir());
    await fs.writeFile(outputPath(key), text ? `${text}\n` : "");
  } catch { /* the toast still shows */ }
  if (info) await hc(["rm", j.address]).catch(() => null);
  const ended = Date.now();
  putJob(key, { status, code, ended, reason });
  const took = seconds(ended - (j.started ?? ended));
  let body;
  if (status === "ok") body = j.kind === "write" ? `${j.agentName ?? "The agent"} wrote ${j.fileShown ?? "the script"} in ${took}.` : `Done in ${took}.`;
  else if (status === "stopped") body = `Stopped after ${took}.`;
  else body = `${reason} Open Quick Actions to see the output.`;
  notify({
    title: j.kind === "write" ? `Quick Actions: ${j.name}` : `Quick action: ${j.name}`,
    body,
    level: status === "ok" || status === "stopped" ? "info" : "error",
    timeout: status === "ok" ? 6000 : 10000,
  });
}

/**
 * The runner: true when this copy may check the jobs. Only 1 copy holds the lease, so 2 copies (2
 * layouts) do not both end a job.
 */
export function holdLease(owner) {
  const l = shared(KEY.lease);
  const now = Date.now();
  if (l?.owner && l.owner !== owner && now - (l.at ?? 0) < 4000) return false;
  if (!l || l.owner !== owner || now - (l.at ?? 0) > 1500) setShared(KEY.lease, { owner, at: now });
  return true;
}

/** Checks the running jobs once: the end, the timeout. */
export async function checkJobs() {
  for (const [key, j] of Object.entries(jobs())) {
    if (!isRunning(j) || !j.address || (j.ending && Date.now() - j.ending < 60000)) continue;
    const info = await terminalInfo(j.address);
    if (!info) continue; // no answer now: the next check asks again
    if (!info.gone && info.state !== "finished") {
      if (Date.now() > (j.deadline ?? Infinity) && !j.stopping) {
        putJob(key, { timedOut: true, stopping: true });
        await hc(["kill", j.address]).catch(() => null);
      }
      continue;
    }
    await finish(key, jobs()[key] ?? j, info);
  }
}
