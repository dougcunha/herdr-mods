// Persistent background tracker for Issue Actions (issues-app).
// Runs in the status copy of powermods-core so background hc processes continue to be monitored,
// cleaned up, and toasted even if the user closes the Issues panel or dialog.

import { hc, notify, readTextFile, setShared, shared } from "herdr";

const ACTION_RUNS = "issues.actionRuns";
const CHANGED = "issues.changed";
const POLL_MS = 2000;
const STALE_MS = 5000;

const STATE = (globalThis.__powermodsIssueActions ??= { beat: 0, lastPoll: 0, polling: new Set() });

export const issueActionsAlive = () => Date.now() - STATE.beat < STALE_MS;

function allRuns() {
  const v = shared(ACTION_RUNS);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function patchRun(runKey, patch) {
  const map = { ...allRuns() };
  const cur = map[runKey];
  if (!cur) return null;
  map[runKey] = { ...cur, ...patch };
  setShared(ACTION_RUNS, map);
  return map[runKey];
}

function parseNeedsInput(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*NEEDS_INPUT:\s*(.+)$/i.exec(lines[i]);
    if (!m) continue;
    const reason = m[1].trim();
    if (!reason || /^<brief reason>$/i.test(reason)) continue;
    return reason;
  }
  return null;
}

function tailLines(output, max = 4) {
  return String(output ?? "").split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-max).join("\n");
}

export function activeIssueActionCount() {
  return Object.values(allRuns()).filter((r) => r?.status === "running").length;
}

async function checkRun(runKey, r) {
  const step = r.steps?.[r.stepIndex];
  const stepName = step?.name ?? r.label ?? "Action";
  const deadline = (r.stepStartedAt ?? r.startedAt ?? Date.now()) + (Number(r.timeoutSec) || 300) * 1000;

  if (Date.now() > deadline) {
    if (r.address) {
      await hc(["kill", r.address]).catch(() => null);
      await hc(["rm", r.address]).catch(() => null);
    }
    const reason = `Timed out after ${Number(r.timeoutSec) || 300}s.`;
    patchRun(runKey, { status: "timed_out", reason, endedAt: Date.now() });
    notify({ title: `${r.issueKey}: ${stepName} timed out`, body: reason, level: "error", timeout: 8000 });
    return;
  }

  const res = await hc(["get", r.address, "--json"]).catch(() => null);
  let info = null;
  if (res?.code === 0) {
    try { const j = JSON.parse(res.stdout); info = j?.terminal ?? j; } catch { info = null; }
  }
  if (info && info.state !== "finished") return;

  const code = info ? (info.exit_code ?? 0) : null;
  if (r.address) await hc(["rm", r.address]).catch(() => null);

  const output = r.outputPath ? await readTextFile(r.outputPath).catch(() => "") : "";
  const needs = parseNeedsInput(output);
  if (needs) {
    patchRun(runKey, { status: "needs_input", reason: needs, endedAt: Date.now() });
    notify({ title: `${r.issueKey}: ${stepName} needs input`, body: needs, level: "warning", timeout: 9000 });
    return;
  }

  if (code !== 0) {
    const tail = tailLines(output, 4);
    const reason = tail || (code == null ? "Background terminal disappeared." : `Agent exited with code ${code}.`);
    patchRun(runKey, { status: "failed", reason, endedAt: Date.now() });
    notify({ title: `${r.issueKey}: ${stepName} failed`, body: reason.slice(0, 260), level: "error", timeout: 9000 });
    return;
  }

  const isLast = r.stepIndex + 1 >= (r.steps?.length ?? 0);
  const needsJiraCheck = Boolean(r.isJira && step?.targetFields?.length);
  if (isLast && !needsJiraCheck) {
    patchRun(runKey, { status: "ok", reason: "", missingFields: [], endedAt: Date.now() });
    if (r.isJira && r.site) setShared(CHANGED, { site: r.site, key: r.issueKey, at: Date.now() });
    notify({ title: `${r.issueKey}: ${r.label} finished`, level: "success", timeout: 4000 });
    return;
  }

  patchRun(runKey, { status: "awaiting_verification", stepEndedAt: Date.now(), notifiedPending: false });
}

export function pumpIssueActions(cx) {
  const now = Date.now();
  STATE.beat = now;
  if (now - STATE.lastPoll < POLL_MS) return;
  STATE.lastPoll = now;

  for (const [runKey, r] of Object.entries(allRuns())) {
    if (!r) continue;
    if (r.status === "awaiting_verification" && !r.notifiedPending && r.stepEndedAt && now - r.stepEndedAt > 5000) {
      const stepName = r.steps?.[r.stepIndex]?.name ?? r.label ?? "Action";
      patchRun(runKey, { notifiedPending: true });
      notify({
        title: `${r.issueKey}: ${stepName} finished`,
        body: "Open Issues to verify Jira fields and continue.",
        level: "info",
        timeout: 6000,
      });
      continue;
    }
    if (r.status !== "running" || r.mode !== "background" || !r.address || STATE.polling.has(runKey)) continue;
    STATE.polling.add(runKey);
    cx.spawn(async () => {
      try { await checkRun(runKey, r); }
      finally { STATE.polling.delete(runKey); }
    });
  }
}
