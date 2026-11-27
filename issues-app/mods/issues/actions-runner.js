// Prompt expansion, NEEDS_INPUT detection, background/interactive execution, sequential
// orchestration, Jira post-run field verification, and fallback run poller for Issue Actions.

import { appHome, exec, hc, knownAgents, notify, panes, readTextFile, run, setShared, shared, spaces, window as appWindow, writeTextFile } from "herdr";
import { adfToMarkdown } from "./adf.js";
import { agentStart } from "./core.js";
import { editMeta, extraFields, issue as fetchJiraIssue, issueFields } from "./jira.js";
import { extraFieldNames, fill, placeholderOf } from "./prompts.js";
import { CHANGED } from "./transition.js";
import {
  ACTION_RUNS, allRuns, ensureDir, fieldText, getRun, issueProject, issueRunKey,
  loadPersonalConfig, loadRepoConfig, mergeConfigs, patchRun, resolveTargetFields, setRun,
} from "./actions-store.js";

const isWin = () => {
  try { return appWindow()?.platform === "windows"; } catch { return false; }
};
const psq = (s) => `'${String(s ?? "").replace(/['\u2018-\u201B]/g, "$&$&")}'`;
const shq = (s) => `'${String(s ?? "").replace(/'/g, `'\\''`)}'`;

function splitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(text ?? "")))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// ---- Prompt expansion & NEEDS_INPUT protocol ------------------------------------------------------

const pageText = (body) => (typeof body === "string" ? body : adfToMarkdown(body));

export function buildIssueVars(issue, page, isGh, branch = "") {
  const f = page?.fields ?? issue?.fields ?? {};
  const tracker = isGh ? "GitHub" : "Jira";
  const key = isGh ? `${issue.repo}${issue.key}` : issue.key;
  const url = issue.url ?? (isGh ? `https://github.com/${issue.repo}/issues/${issue.number}` : `https://${issue.site}/browse/${issue.key}`);
  return {
    key,
    title: f.summary ?? "",
    url,
    type: f.issuetype?.name ?? "",
    status: f.status?.name ?? "",
    priority: f.priority?.name ?? "",
    labels: (f.labels ?? []).join(", "),
    description: pageText(f.description) || "(no description)",
    tracker,
    site: isGh ? "github.com" : (issue.site ?? ""),
    project: issueProject(issue, isGh),
    branch: branch || "",
    ...Object.fromEntries(extraFieldNames().map((n) => [placeholderOf(n), ""])),
    ...Object.fromEntries((page?.extra ?? []).map((x) => [x.ph, x.text])),
    fields: (page?.extra ?? []).filter((x) => x.text).map((x) => `## ${x.name}\n\n${x.text}`).join("\n\n"),
  };
}

const NEEDS_INPUT_CONTRACT = [
  "",
  "---",
  "Non-interactive background execution rule:",
  "- Do not guess or invent missing required human decisions or missing information.",
  "- If human input or interactive confirmation is required to proceed safely, stop without making partial guesses and write a final line starting with: NEEDS_INPUT: <brief reason>",
].join("\n");

const AUTO_APPROVE_CONTRACT = [
  "",
  "---",
  "Non-interactive background execution rule:",
  "- The user explicitly triggered this action and pre-authorized applying/saving the result directly.",
  "- Skip any interactive confirmation step before saving (such as asking approval to write the proposed field content); write the result directly.",
  "- Do not guess or invent missing required technical or business information: only if genuinely missing required information prevents proceeding safely, stop without making partial guesses and write a final line starting with: NEEDS_INPUT: <brief reason>",
].join("\n");

export function buildActionPrompt(action, vars, mode, allowAutoApprove = false) {
  const expanded = fill(action.prompt, vars).trim();
  if (mode === "background") return `${expanded}\n${allowAutoApprove ? AUTO_APPROVE_CONTRACT : NEEDS_INPUT_CONTRACT}`;
  return expanded;
}

export function parseNeedsInput(output) {
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

export function tailLines(output, max = 6) {
  return String(output ?? "").split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-max).join("\n");
}

// ---- Agent & workspace resolution -----------------------------------------------------------------

export function resolveCwd(space, repo) {
  if (space) {
    const tabs = new Set((space.tabs ?? []).map((t) => t.id));
    const own = panes().filter((p) => p.terminal && p.cwd && tabs.has(p.tab));
    const dir = own.find((p) => p.focused)?.cwd ?? own[0]?.cwd ?? space.folder;
    if (dir) return dir;
  }
  return repo?.main ?? null;
}

function cachedAgentsList(on = null) {
  const mKey = on ?? "local";
  const own = shared("issues.agents")?.[mKey]?.list;
  if (Array.isArray(own) && own.length) return own;
  if (!on) {
    const rl = shared("repo-launcher.agents")?.list;
    if (Array.isArray(rl) && rl.length) return rl;
  }
  return null;
}

export async function getAgentsList(on = null) {
  const cached = cachedAgentsList(on);
  if (cached) return cached;
  const list = await knownAgents(on ? { on } : undefined).catch(() => []);
  if (Array.isArray(list) && list.length) {
    const mKey = on ?? "local";
    setShared("issues.agents", { ...(shared("issues.agents") ?? {}), [mKey]: { list, checkedAt: Date.now() } });
  }
  return list ?? [];
}

export function effectiveAgentConfig(actionAgent, defaultAgent) {
  const base = defaultAgent ?? { key: "agy", model: null, effort: null, extraArgs: "", timeoutSec: 300, allowAutoApprove: false };
  if (!actionAgent) return { ...base };
  return {
    key: actionAgent.key || base.key,
    model: actionAgent.model || base.model,
    effort: actionAgent.effort || base.effort,
    extraArgs: actionAgent.extraArgs || base.extraArgs || "",
    timeoutSec: actionAgent.timeoutSec || base.timeoutSec || 300,
    allowAutoApprove: actionAgent.allowAutoApprove ?? base.allowAutoApprove ?? false,
  };
}

export function pickAgent(agentsList, desiredKey) {
  const ready = (agentsList ?? []).filter((a) => a.installed !== false);
  const k = String(desiredKey ?? "").toLowerCase();
  return ready.find((a) => String(a.key ?? "").toLowerCase() === k || String(a.name ?? "").toLowerCase() === k)
    ?? ready[0]
    ?? null;
}

const INTERACTIVE_OPTS = {
  claude: (m, e) => [...(m ? ["--model", m] : []), ...(e ? ["--effort", e] : [])],
  codex: (m, e) => [...(m ? ["-m", m] : []), ...(e ? ["-c", `model_reasoning_effort=${e}`] : [])],
  opencode: (m) => (m ? ["-m", m] : []),
  agy: (m, e) => [...(m ? ["--model", m] : []), ...(e ? ["--effort", e] : [])],
};

function agentProgKey(agent, fallbackKey) {
  if (agent?.key) return String(agent.key).toLowerCase();
  const base = String(agent?.run?.[0] ?? fallbackKey ?? "").split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
  return base || "agy";
}

function headlessArgsFor(progKey, cfg, promptExpr, quoteFn) {
  const extra = splitArgs(cfg.extraArgs).map(quoteFn);
  const m = cfg.model, e = cfg.effort, auto = Boolean(cfg.allowAutoApprove);
  const t = Math.max(15, Number(cfg.timeoutSec) || 300);
  switch (progKey) {
    case "agy":
      return [
        "-p", promptExpr,
        ...(m ? ["--model", quoteFn(m)] : []),
        ...(e ? ["--effort", quoteFn(e)] : []),
        "--print-timeout", quoteFn(`${t}s`),
        ...(auto ? ["--dangerously-skip-permissions"] : []),
        ...extra,
      ];
    case "claude":
      return [
        "-p", promptExpr,
        ...(m ? ["--model", quoteFn(m)] : []),
        ...(e ? ["--effort", quoteFn(e)] : []),
        ...(auto ? ["--dangerously-skip-permissions"] : []),
        ...extra,
      ];
    case "codex":
      return [
        "exec", "--skip-git-repo-check",
        ...(m ? ["-m", quoteFn(m)] : []),
        ...(e ? ["-c", quoteFn(`model_reasoning_effort=${e}`)] : []),
        ...(auto ? ["--full-auto"] : []),
        ...extra,
        promptExpr,
      ];
    case "gemini":
      return [
        "-p", promptExpr,
        ...(m ? ["-m", quoteFn(m)] : []),
        ...(auto ? ["-y"] : []),
        ...extra,
      ];
    case "opencode":
      return [
        "run",
        ...(m ? ["-m", quoteFn(m)] : []),
        ...extra,
        promptExpr,
      ];
    case "copilot":
      return ["-p", promptExpr, ...extra];
    default:
      return null;
  }
}

// ---- Launching steps ------------------------------------------------------------------------------

async function launchBackgroundStep({ runId, stepIndex, prompt, cwd, agent, agentCfg }) {
  const progKey = agentProgKey(agent, agentCfg.key);
  const baseRun = agent?.run?.length ? agent.run : [progKey];
  const win = isWin();
  const q = win ? psq : shq;
  const promptExpr = win ? "$prompt" : '"$prompt"';
  const args = headlessArgsFor(progKey, agentCfg, promptExpr, q);
  if (!args) throw new Error(`Agent "${agent?.name ?? progKey}" has no built-in background command. Switch this action to interactive mode.`);

  const dir = `${appHome()}/data/issues-app/runs/${runId}`;
  await ensureDir(dir);
  const promptFile = `${dir}/step-${stepIndex}-prompt.md`;
  const outputPath = `${dir}/step-${stepIndex}-output.txt`;
  await writeTextFile(promptFile, prompt);

  let prog, argv;
  if (win) {
    const scriptPath = `${dir}/step-${stepIndex}.ps1`;
    const cmdCall = `& ${baseRun.map(psq).join(" ")} ${args.join(" ")}`;
    const body = [
      "$ErrorActionPreference = 'Continue'",
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
      `Set-Location -LiteralPath ${psq(cwd)}`,
      `$prompt = Get-Content -Raw -LiteralPath ${psq(promptFile)} -Encoding UTF8`,
      "$global:LASTEXITCODE = 0",
      `& { ${cmdCall} } *> ${psq(outputPath)}`,
      "if ($LASTEXITCODE) { exit $LASTEXITCODE }",
      "if (-not $?) { exit 1 }",
      "exit 0",
      "",
    ].join("\n");
    await writeTextFile(scriptPath, body);
    prog = "pwsh";
    argv = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath];
  } else {
    const scriptPath = `${dir}/step-${stepIndex}.sh`;
    const cmdCall = `${baseRun.map(shq).join(" ")} ${args.join(" ")}`;
    const body = [
      `cd ${shq(cwd)} || exit 1`,
      `prompt=$(cat ${shq(promptFile)})`,
      `${cmdCall} > ${shq(outputPath)} 2>&1`,
      "exit $?",
      "",
    ].join("\n");
    await writeTextFile(scriptPath, body);
    prog = "sh";
    argv = [scriptPath];
  }

  const r = await hc([
    "run", "--bg", "--json", "--no-parent",
    "--label", `issue-action=${runId}`,
    "--label", `issue-step=${stepIndex}`,
    "--cwd", cwd,
    "--", prog, ...argv,
  ]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "hc run failed").trim());
  let address = null;
  try { address = JSON.parse(r.stdout)?.address ?? null; } catch { address = null; }
  if (!address) address = /\b((?:[\w-]+\/)?t[0-9a-z]+)\b/.exec(r.stdout)?.[1] ?? null;
  if (!address) throw new Error(`hc run did not return a terminal address: ${r.stdout.trim()}`);
  return { address, outputPath };
}

function launchInteractiveStep({ actionName, prompt, space, cwd, issueKey, agent, agentCfg }) {
  if (!space?.id) throw new Error("No open space to launch the interactive tab.");
  const progKey = agentProgKey(agent, agentCfg.key);
  const baseRun = agent?.run?.length ? agent.run : [progKey];
  const flags = INTERACTIVE_OPTS[progKey]?.(agentCfg.model, agentCfg.effort) ?? [];
  const extra = splitArgs(agentCfg.extraArgs);
  const argv = [...baseRun, ...flags, ...extra];
  const tabName = `${issueKey} · ${actionName}`.slice(0, 60);
  run("tab.new", { space: space.id, folder: cwd ?? space.folder, name: tabName, ...agentStart(argv, prompt) });
}

// ---- Public start / cancel / retry ----------------------------------------------------------------

export async function startActionRun({ issue, page, isGh, space, repo, config, steps, label, forceMode = null }) {
  if (!issue || !steps?.length) throw new Error("No action to run.");
  const runKey = issueRunKey(issue.site, issue.repo, issue.key);
  const existing = getRun(runKey);
  if (existing && (existing.status === "running" || existing.status === "awaiting_verification")) {
    throw new Error(`${issue.key} already has an action running.`);
  }

  const resolvedSteps = steps.map((s) => ({
    actionId: s.id,
    name: s.name,
    mode: forceMode ?? s.mode ?? "background",
    source: s._source ?? "personal",
    prompt: s.prompt,
    skill: s.skill ?? "",
    targetFields: s.guards?.targetFields ?? [],
    requireAllFields: Boolean(s.guards?.requireAllFields),
    agent: s.agent ?? null,
  }));

  const hasBg = resolvedSteps.some((s) => s.mode === "background");
  if (hasBg && space?.machine) {
    throw new Error("Background Issue Actions run only for spaces on this computer. Switch this action to Interactive mode for remote spaces.");
  }

  const cwd = resolveCwd(space, repo);
  if (!cwd) throw new Error("No working folder found for this space.");

  const agentsList = await getAgentsList(space?.machine ?? null);
  const first = resolvedSteps[0];
  const agentCfg = effectiveAgentConfig(first.agent, config?.defaults?.agent);
  const agent = pickAgent(agentsList, agentCfg.key);
  if (!agent) throw new Error("No installed coding agent found.");

  const vars = buildIssueVars(issue, page, isGh, space?.branch ?? "");
  const prompt = buildActionPrompt(first, vars, first.mode, Boolean(agentCfg.allowAutoApprove));
  const runId = `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  if (first.mode === "interactive") {
    launchInteractiveStep({ actionName: first.name, prompt, space, cwd, issueKey: issue.key, agent, agentCfg });
    setRun(runKey, {
      runId,
      runKey,
      issueKey: issue.key,
      site: issue.site ?? "",
      repo: issue.repo ?? "",
      isJira: !isGh,
      spaceId: space?.id ?? null,
      repoMain: repo?.main ?? null,
      cwd,
      label: label || first.name,
      steps: resolvedSteps,
      stepIndex: 0,
      mode: "interactive",
      address: null,
      outputPath: null,
      status: "ok",
      reason: resolvedSteps.length > 1 ? `Opened interactive tab for "${first.name}". Run remaining steps from Actions after finishing.` : "Opened interactive agent tab.",
      missingFields: [],
      startedAt: Date.now(),
      stepStartedAt: Date.now(),
      endedAt: Date.now(),
      timeoutSec: agentCfg.timeoutSec,
    });
    notify({ title: `${issue.key}: ${first.name}`, body: "Opened interactive agent tab.", level: "info", timeout: 3000 });
    return;
  }

  const { address, outputPath } = await launchBackgroundStep({ runId, stepIndex: 0, prompt, cwd, agent, agentCfg });
  setRun(runKey, {
    runId,
    runKey,
    issueKey: issue.key,
    site: issue.site ?? "",
    repo: issue.repo ?? "",
    isJira: !isGh,
    spaceId: space?.id ?? null,
    repoMain: repo?.main ?? null,
    cwd,
    label: label || first.name,
    steps: resolvedSteps,
    stepIndex: 0,
    mode: "background",
    address,
    outputPath,
    status: "running",
    reason: "",
    missingFields: [],
    startedAt: Date.now(),
    stepStartedAt: Date.now(),
    endedAt: null,
    timeoutSec: agentCfg.timeoutSec,
  });
  notify({ title: `${issue.key}: ${label || first.name}`, body: `Running ${first.name} in background…`, level: "info", timeout: 3000 });
}

export async function cancelActionRun(runKey) {
  const r = getRun(runKey);
  if (!r || r.status !== "running") return;
  if (r.address) {
    await hc(["kill", r.address]).catch(() => null);
    await hc(["rm", r.address]).catch(() => null);
  }
  patchRun(runKey, { status: "failed", reason: "Canceled by user.", endedAt: Date.now() });
}

export async function retryCurrentStepInteractively(runKey, { space, repo } = {}) {
  const r = getRun(runKey);
  if (!r) throw new Error("Run record not found.");
  const step = r.steps?.[r.stepIndex] ?? r.steps?.[0];
  if (!step) throw new Error("No step to retry.");
  const [personal, repoCfg] = await Promise.all([loadPersonalConfig(), loadRepoConfig(repo)]);
  const merged = mergeConfigs(personal, repoCfg);
  const targetSpace = space ?? spaces().find((s) => s.id === r.spaceId) ?? spaces().find((s) => s.active);
  if (!targetSpace) throw new Error("No open space found.");
  const agentsList = await getAgentsList(targetSpace?.machine ?? null);
  const agentCfg = effectiveAgentConfig(step.agent, merged.defaults.agent);
  const agent = pickAgent(agentsList, agentCfg.key);
  if (!agent) throw new Error("No installed coding agent found.");

  let prompt = null;
  if (r.isJira && r.site) {
    const wanted = extraFieldNames();
    const defs = wanted.length ? await extraFields(r.site, wanted).catch(() => []) : [];
    const page = await fetchJiraIssue(r.site, r.issueKey, defs.map((d) => d.id)).catch(() => null);
    if (page) {
      page.extra = defs.map((d) => {
        const value = fieldText(page.fields[d.id]);
        delete page.fields[d.id];
        return { name: d.name, ph: placeholderOf(d.wanted), text: value };
      });
      const vars = buildIssueVars({ key: r.issueKey, site: r.site, fields: page.fields }, page, false, targetSpace.branch ?? "");
      prompt = buildActionPrompt(step, vars, "interactive");
    }
  }
  if (!prompt) {
    const rawSaved = await readTextFile(`${appHome()}/data/issues-app/runs/${r.runId}/step-${r.stepIndex}-prompt.md`).catch(() => "");
    prompt = rawSaved.split("\n---\nNon-interactive background execution rule:")[0].trim() || step.prompt;
  }

  launchInteractiveStep({ actionName: step.name, prompt, space: targetSpace, cwd: r.cwd, issueKey: r.issueKey, agent, agentCfg });
  patchRun(runKey, { status: "ok", mode: "interactive", reason: `Retried "${step.name}" interactively.`, endedAt: Date.now() });
}

// ---- Background poller & sequential continuation --------------------------------------------------

const inFlight = new Set();

async function verifyJiraFields(site, key, targetFields) {
  if (!targetFields?.length) return [];
  const meta = await editMeta(site, key).catch(() => null);
  const present = resolveTargetFields(targetFields, meta);
  if (!present.length) return [];
  const vals = await issueFields(site, key, present.map((f) => f.id)).catch(() => null);
  if (!vals) return [];
  return present.filter((f) => !fieldText(vals[f.id]).trim()).map((f) => f.name);
}

async function advanceOrFinish(runKey, r) {
  const step = r.steps?.[r.stepIndex];
  if (!step) { patchRun(runKey, { status: "ok", endedAt: Date.now() }); return; }

  if (r.isJira && r.site) {
    if (step.targetFields?.length) {
      const missing = await verifyJiraFields(r.site, r.issueKey, step.targetFields);
      if (missing.length) {
        setShared(CHANGED, { site: r.site, key: r.issueKey, at: Date.now() });
        const reason = `Finished without populating: ${missing.join(", ")}`;
        patchRun(runKey, { status: "needs_input", missingFields: missing, reason, endedAt: Date.now() });
        notify({ title: `${r.issueKey}: ${step.name} needs review`, body: reason, level: "warning", timeout: 8000 });
        return;
      }
    }
    setShared(CHANGED, { site: r.site, key: r.issueKey, at: Date.now() });
  }

  const nextIdx = r.stepIndex + 1;
  if (nextIdx >= (r.steps?.length ?? 0)) {
    patchRun(runKey, { status: "ok", reason: "", missingFields: [], endedAt: Date.now() });
    notify({ title: `${r.issueKey}: ${r.label} finished`, level: "success", timeout: 4000 });
    return;
  }

  const nextStep = r.steps[nextIdx];
  const space = spaces().find((s) => s.id === r.spaceId) ?? spaces().find((s) => s.active) ?? null;
  const [personal, repoCfg] = await Promise.all([
    loadPersonalConfig(),
    r.repoMain ? loadRepoConfig({ main: r.repoMain, on: null }) : null,
  ]);
  const merged = mergeConfigs(personal, repoCfg);
  const agentsList = await getAgentsList(space?.machine ?? null);
  const agentCfg = effectiveAgentConfig(nextStep.agent, merged.defaults.agent);
  const agent = pickAgent(agentsList, agentCfg.key);
  if (!agent) {
    patchRun(runKey, { status: "failed", reason: "No installed coding agent found for next step.", endedAt: Date.now() });
    notify({ title: `${r.issueKey}: ${nextStep.name} failed`, body: "No installed coding agent found.", level: "error", timeout: 7000 });
    return;
  }

  // Reload fresh Jira fields before expanding the next step so {fields} / {refinement} reflect step N.
  let vars = { key: r.issueKey, title: r.issueKey, url: "", type: "", status: "", priority: "", labels: "", description: "", tracker: r.isJira ? "Jira" : "GitHub", site: r.site ?? "", project: r.repo || r.issueKey.replace(/-\d+$/, ""), branch: "", fields: "" };
  if (r.isJira && r.site) {
    const wanted = extraFieldNames();
    const defs = wanted.length ? await extraFields(r.site, wanted).catch(() => []) : [];
    const page = await fetchJiraIssue(r.site, r.issueKey, defs.map((d) => d.id)).catch(() => null);
    if (page) {
      page.extra = defs.map((d) => {
        const value = fieldText(page.fields[d.id]);
        delete page.fields[d.id];
        return { name: d.name, ph: placeholderOf(d.wanted), text: value };
      });
      vars = buildIssueVars({ key: r.issueKey, site: r.site, fields: page.fields }, page, false);
    }
  }

  const prompt = buildActionPrompt(nextStep, vars, nextStep.mode, Boolean(agentCfg.allowAutoApprove));
  if (nextStep.mode === "interactive") {
    try {
      launchInteractiveStep({ actionName: nextStep.name, prompt, space, cwd: r.cwd, issueKey: r.issueKey, agent, agentCfg });
      patchRun(runKey, { stepIndex: nextIdx, mode: "interactive", address: null, status: "ok", reason: `Opened interactive tab for "${nextStep.name}".`, endedAt: Date.now() });
      notify({ title: `${r.issueKey}: ${nextStep.name}`, body: "Opened interactive agent tab.", level: "info", timeout: 4000 });
    } catch (e) {
      const msg = String(e?.message ?? e);
      patchRun(runKey, { stepIndex: nextIdx, status: "failed", reason: msg, endedAt: Date.now() });
      notify({ title: `${r.issueKey}: ${nextStep.name} failed`, body: msg, level: "error", timeout: 7000 });
    }
    return;
  }

  try {
    const { address, outputPath } = await launchBackgroundStep({ runId: r.runId, stepIndex: nextIdx, prompt, cwd: r.cwd, agent, agentCfg });
    patchRun(runKey, {
      stepIndex: nextIdx,
      mode: "background",
      address,
      outputPath,
      status: "running",
      reason: "",
      missingFields: [],
      stepStartedAt: Date.now(),
      timeoutSec: agentCfg.timeoutSec,
      notifiedPending: false,
    });
  } catch (e) {
    const msg = String(e?.message ?? e);
    patchRun(runKey, { stepIndex: nextIdx, status: "failed", reason: msg, endedAt: Date.now() });
    notify({ title: `${r.issueKey}: ${nextStep.name} failed`, body: msg, level: "error", timeout: 7000 });
  }
}

async function fallbackPollProcess(runKey, r) {
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

  const verified = patchRun(runKey, { status: "awaiting_verification", stepEndedAt: Date.now() });
  if (verified) await advanceOrFinish(runKey, verified);
}

export function tickIssueActionRuns(cx) {
  const runs = allRuns();
  const coreAlive = Boolean(globalThis.powermods?.issueActions?.alive?.());
  for (const [runKey, r] of Object.entries(runs)) {
    if (!r || inFlight.has(runKey)) continue;
    if (r.status === "awaiting_verification") {
      inFlight.add(runKey);
      cx.spawn(async () => {
        try { await advanceOrFinish(runKey, r); }
        catch (e) {
          patchRun(runKey, { status: "failed", reason: String(e?.message ?? e), endedAt: Date.now() });
        } finally {
          inFlight.delete(runKey);
        }
      });
    } else if (r.status === "running" && r.mode === "background" && r.address && !coreAlive) {
      inFlight.add(runKey);
      cx.spawn(async () => {
        try { await fallbackPollProcess(runKey, r); }
        catch (e) {
          patchRun(runKey, { status: "failed", reason: String(e?.message ?? e), endedAt: Date.now() });
        } finally {
          inFlight.delete(runKey);
        }
      });
    }
  }
}
