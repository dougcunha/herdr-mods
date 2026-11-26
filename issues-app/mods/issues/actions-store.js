// Storage, repo trust, precedence/overrides, local skill discovery, guard evaluation, and
// shared run-state helpers for Issue Actions (issues-app).
//
// Personal config: ~/.config/herdr-app/data/issues-app/actions.json
// Repo config:     <mainCheckout>/.herdr/issue-actions.json (exact-content trust in shared("trusted-issue-actions"))
// Active runs:     shared("issues.actionRuns") keyed by `${site}|${repo}|${key}`

import { appHome, exec, home, readTextFile, shared, setShared, window as appWindow, writeTextFile } from "herdr";
import { adfToMarkdown } from "./adf.js";

export const ACTIONS_REV = "issues.actionsRev";
export const TRUST_ACTIONS = "trusted-issue-actions";
export const ACTION_RUNS = "issues.actionRuns";
export const PERSONAL_FILE = "data/issues-app/actions.json";
export const REPO_FILE = ".herdr/issue-actions.json";

const MAX_KEPT_RUNS = 25;

const isWin = () => {
  try { return appWindow()?.platform === "windows"; } catch { return false; }
};
const psq = (s) => `'${String(s ?? "").replace(/['\u2018-\u201B]/g, "$&$&")}'`;

export async function ensureDir(dir) {
  if (!dir) return;
  if (isWin()) {
    await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `New-Item -ItemType Directory -Force -Path ${psq(dir)} | Out-Null`]).catch(() => null);
  } else {
    await exec("mkdir", ["-p", dir]).catch(() => null);
  }
}

export function slugId(name) {
  const s = String(name ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || `action-${Date.now().toString(36)}`;
}

const toStrList = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/[,\n]/))
  .map((x) => String(x ?? "").trim())
  .filter(Boolean);

export function defaultAgentConfig() {
  return {
    key: "agy",
    model: null,
    effort: null,
    extraArgs: "",
    timeoutSec: 300,
    allowAutoApprove: false,
  };
}

export function normalizeAgent(a, partial = false) {
  if (!a || typeof a !== "object") return partial ? null : defaultAgentConfig();
  const base = defaultAgentConfig();
  const timeout = Number(a.timeoutSec);
  return {
    key: typeof a.key === "string" && a.key.trim() ? a.key.trim() : (partial ? null : base.key),
    model: typeof a.model === "string" && a.model.trim() ? a.model.trim() : null,
    effort: typeof a.effort === "string" && a.effort.trim() ? a.effort.trim() : null,
    extraArgs: typeof a.extraArgs === "string" ? a.extraArgs.trim() : "",
    timeoutSec: Number.isFinite(timeout) && timeout >= 15 ? Math.min(3600, Math.round(timeout)) : base.timeoutSec,
    allowAutoApprove: Boolean(a.allowAutoApprove),
  };
}

export function normalizeGuards(g) {
  return {
    tracker: ["jira", "github", "any"].includes(g?.tracker) ? g.tracker : "any",
    sites: toStrList(g?.sites),
    projects: toStrList(g?.projects),
    issueTypes: toStrList(g?.issueTypes),
    statuses: toStrList(g?.statuses),
    targetFields: toStrList(g?.targetFields),
    requireAllFields: Boolean(g?.requireAllFields),
    hideWhenFilled: Boolean(g?.hideWhenFilled),
  };
}

export function normalizeAction(a) {
  if (!a || typeof a !== "object") return null;
  const name = String(a.name ?? "").trim();
  const id = String(a.id ?? "").trim() || slugId(name);
  if (!name && !id) return null;
  return {
    id,
    name: name || id,
    description: String(a.description ?? "").trim(),
    enabled: a.enabled !== false,
    mode: a.mode === "interactive" ? "interactive" : "background",
    skill: String(a.skill ?? "").trim(),
    prompt: String(a.prompt ?? ""),
    guards: normalizeGuards(a.guards),
    agent: a.agent && typeof a.agent === "object" ? normalizeAgent(a.agent, true) : null,
    includeInRunAll: a.includeInRunAll !== false,
  };
}

export function normalizeSequence(s) {
  if (!s || typeof s !== "object") return null;
  const name = String(s.name ?? "").trim();
  const id = String(s.id ?? "").trim() || slugId(name);
  if (!name && !id) return null;
  return {
    id,
    name: name || id,
    description: String(s.description ?? "").trim(),
    enabled: s.enabled !== false,
    steps: Array.isArray(s.steps) ? s.steps.map((x) => String(x ?? "").trim()).filter(Boolean) : [],
  };
}

export function defaultConfig() {
  return {
    version: 1,
    defaults: { agent: defaultAgentConfig() },
    actions: [],
    sequences: [],
    overrides: {},
  };
}

export function normalizeConfig(raw) {
  const base = defaultConfig();
  if (!raw || typeof raw !== "object") return base;
  const overrides = {};
  if (raw.overrides && typeof raw.overrides === "object" && !Array.isArray(raw.overrides)) {
    for (const [k, v] of Object.entries(raw.overrides)) {
      if (!k || !v || typeof v !== "object") continue;
      const clean = {};
      if (typeof v.enabled === "boolean") clean.enabled = v.enabled;
      if (v.mode === "background" || v.mode === "interactive") clean.mode = v.mode;
      if (typeof v.includeInRunAll === "boolean") clean.includeInRunAll = v.includeInRunAll;
      if (v.agent && typeof v.agent === "object") clean.agent = normalizeAgent(v.agent, true);
      if (Object.keys(clean).length) overrides[k] = clean;
    }
  }
  return {
    version: 1,
    defaults: { agent: normalizeAgent(raw.defaults?.agent, false) },
    actions: (Array.isArray(raw.actions) ? raw.actions : []).map(normalizeAction).filter(Boolean),
    sequences: (Array.isArray(raw.sequences) ? raw.sequences : []).map(normalizeSequence).filter(Boolean),
    overrides,
  };
}

// ---- Personal config I/O --------------------------------------------------------------------------

export async function loadPersonalConfig() {
  const path = `${appHome()}/${PERSONAL_FILE}`;
  const raw = await readTextFile(path).catch(() => null);
  if (!raw) return defaultConfig();
  try {
    return normalizeConfig(JSON.parse(raw.replace(/^\uFEFF/, "")));
  } catch {
    return defaultConfig();
  }
}

export async function savePersonalConfig(cfg) {
  const normalized = normalizeConfig(cfg);
  const path = `${appHome()}/${PERSONAL_FILE}`;
  const dir = path.slice(0, path.lastIndexOf("/"));
  await ensureDir(dir);
  const prev = await readTextFile(path).catch(() => null);
  await writeTextFile(path, `${JSON.stringify(normalized, null, 2)}\n`, prev);
  setShared(ACTIONS_REV, Date.now());
  return normalized;
}

// ---- Repository config & exact-content trust ------------------------------------------------------

const approvedMap = () => {
  const v = shared(TRUST_ACTIONS);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
};

export async function loadRepoConfig(repo) {
  if (!repo?.main) return { exists: false, main: null, raw: "", trusted: false, actions: [], sequences: [], error: "", hasRiskyFlags: false };
  const raw = await readTextFile(`${repo.main}/${REPO_FILE}`, { on: repo.on ?? null }).catch(() => null);
  if (!raw) return { exists: false, main: repo.main, raw: "", trusted: false, actions: [], sequences: [], error: "", hasRiskyFlags: false };
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  let parsed = null, error = "";
  try { parsed = JSON.parse(text); } catch (e) { error = `Invalid ${REPO_FILE}: ${e?.message ?? e}`; }
  const norm = parsed ? normalizeConfig(parsed) : defaultConfig();
  const trusted = approvedMap()[repo.main]?.text === text;
  const hasRiskyFlags = norm.actions.some((a) => a.agent?.allowAutoApprove || a.agent?.extraArgs);
  return {
    exists: true,
    main: repo.main,
    raw: text,
    trusted,
    actions: norm.actions,
    sequences: norm.sequences,
    error,
    hasRiskyFlags,
  };
}

export function trustRepoConfig(repoCfg) {
  if (!repoCfg?.main || typeof repoCfg.raw !== "string") return;
  const kept = Object.fromEntries(Object.entries(approvedMap()).filter(([, v]) => typeof v?.text === "string"));
  setShared(TRUST_ACTIONS, { ...kept, [repoCfg.main]: { text: repoCfg.raw } });
}

export function revokeRepoTrust(main) {
  if (!main) return;
  const next = { ...approvedMap() };
  delete next[main];
  setShared(TRUST_ACTIONS, Object.keys(next).length ? next : null);
}

// ---- Merging & local overrides --------------------------------------------------------------------

function applyOverride(item, ov) {
  if (!ov) return item;
  return {
    ...item,
    enabled: typeof ov.enabled === "boolean" ? ov.enabled : item.enabled,
    mode: ov.mode === "background" || ov.mode === "interactive" ? ov.mode : item.mode,
    includeInRunAll: typeof ov.includeInRunAll === "boolean" ? ov.includeInRunAll : item.includeInRunAll,
    agent: ov.agent ? { ...(item.agent ?? {}), ...ov.agent } : item.agent,
    _overridden: true,
  };
}

export function mergeConfigs(personal, repoCfg) {
  const p = normalizeConfig(personal);
  const byId = new Map();
  if (repoCfg?.trusted && !repoCfg.error) {
    for (const a of repoCfg.actions) {
      byId.set(a.id, applyOverride({ ...a, _source: "repo", _overridden: false }, p.overrides[a.id]));
    }
  }
  for (const a of p.actions) {
    byId.set(a.id, { ...a, _source: "personal", _overridden: false });
  }

  const seqById = new Map();
  if (repoCfg?.trusted && !repoCfg.error) {
    for (const s of repoCfg.sequences) {
      seqById.set(s.id, applyOverride({ ...s, _source: "repo", _overridden: false }, p.overrides[s.id]));
    }
  }
  for (const s of p.sequences) {
    seqById.set(s.id, { ...s, _source: "personal", _overridden: false });
  }

  return {
    defaults: p.defaults,
    actions: [...byId.values()],
    sequences: [...seqById.values()],
    overrides: p.overrides,
  };
}

export async function setActionModeOrOverride(action, patch) {
  const personal = await loadPersonalConfig();
  if (action._source === "repo") {
    personal.overrides[action.id] = { ...(personal.overrides[action.id] ?? {}), ...patch };
  } else {
    const idx = personal.actions.findIndex((a) => a.id === action.id);
    if (idx >= 0) personal.actions[idx] = normalizeAction({ ...personal.actions[idx], ...patch });
  }
  return savePersonalConfig(personal);
}

export async function clearRepoOverride(id) {
  const personal = await loadPersonalConfig();
  if (!personal.overrides[id]) return personal;
  delete personal.overrides[id];
  return savePersonalConfig(personal);
}

// ---- Local skill discovery ------------------------------------------------------------------------

const skillCache = new Map(); // `${on}|${cwd}|${repoMain}` -> Set<string>
const winCache = new Map();
const homeCache = new Map();

export function clearSkillCache(repoMain = null) {
  if (repoMain === null) { skillCache.clear(); return; }
  const needle = String(repoMain);
  for (const k of [...skillCache.keys()]) {
    if (k === needle || k.endsWith(`|${needle}`)) skillCache.delete(k);
  }
}

async function windowsOn(on) {
  if (!on) return isWin();
  if (winCache.has(on)) return winCache.get(on);
  const r = await exec("sh", ["-c", "uname -s"], { on }).catch(() => null);
  let win = r?.code === 0 ? /^(MINGW|MSYS|CYGWIN)/i.test(r.stdout.trim()) : null;
  if (win == null) {
    const p = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::OSVersion.Platform"], { on }).catch(() => null);
    win = p?.code === 0 && /Win32NT/i.test(p.stdout);
  }
  winCache.set(on, win);
  return win;
}

async function homeOf(on) {
  if (!on) return String(home() ?? "").replace(/\\/g, "/").replace(/\/+$/, "") || null;
  if (homeCache.has(on)) return homeCache.get(on);
  let h = "";
  const r = await exec("sh", ["-c", 'h=$HOME; command -v cygpath >/dev/null 2>&1 && h=$(cygpath -m "$h"); printf %s "$h"'], { on }).catch(() => null);
  if (r?.code === 0) h = r.stdout.trim();
  if (!/^(\/|[A-Za-z]:\/)/.test(h)) {
    const p = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('UserProfile')"], { on }).catch(() => null);
    if (p?.code === 0) h = p.stdout.trim().replace(/\\/g, "/");
  }
  h = h.replace(/\/+$/, "");
  if (/^(\/|[A-Za-z]:\/)/.test(h)) { homeCache.set(on, h); return h; }
  return null;
}

function skillRoots(homeDir, projectDirs) {
  const dirs = [...new Set((projectDirs ?? []).map((d) => String(d ?? "").replace(/\\/g, "/").replace(/\/+$/, "")).filter(Boolean))];
  const roots = [];
  for (const d of dirs) {
    roots.push(`${d}/.agents/skills`, `${d}/.claude/skills`, `${d}/.gemini/skills`, `${d}/.codex/skills`, `${d}/.windsurf/skills`);
  }
  if (homeDir) {
    roots.push(
      `${homeDir}/.agents/skills`,
      `${homeDir}/.claude/skills`,
      `${homeDir}/.gemini/skills`,
      `${homeDir}/.gemini/antigravity/skills`,
      `${homeDir}/.gemini/antigravity/global_skills`,
      `${homeDir}/.gemini/antigravity-cli/builtin/skills`,
      `${homeDir}/.codex/skills`,
      `${homeDir}/.windsurf/skills`,
    );
  }
  return {
    roots,
    pluginRoot: homeDir ? `${homeDir}/.gemini/config/plugins` : "",
    skillsJsonFiles: dirs.map((d) => `${d}/.agents/skills.json`),
  };
}

export async function scanSkills(optsOrRepoMain = "", force = false) {
  const opts = optsOrRepoMain && typeof optsOrRepoMain === "object"
    ? optsOrRepoMain
    : { repoMain: optsOrRepoMain, force };
  const on = opts.on ?? null;
  const repoMain = opts.repoMain ? String(opts.repoMain).replace(/\\/g, "/").replace(/\/+$/, "") : "";
  const cwd = opts.cwd ? String(opts.cwd).replace(/\\/g, "/").replace(/\/+$/, "") : "";
  const shouldForce = Boolean(opts.force);
  const cacheKey = `${on ?? "local"}|${cwd}|${repoMain}`;

  if (!shouldForce && skillCache.has(cacheKey)) return skillCache.get(cacheKey);

  const [win, homeDir] = await Promise.all([windowsOn(on), homeOf(on)]);
  const { roots, pluginRoot, skillsJsonFiles } = skillRoots(homeDir, [cwd, repoMain]);
  const found = new Set();
  if (!roots.length && !pluginRoot) { skillCache.set(cacheKey, found); return found; }

  const execOpts = on ? { on } : undefined;
  let stdout = "";

  const scanExec = win
    ? (() => {
        const arr = roots.map(psq).join(",");
        const script = [
          "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
          "function Scan-SkillDir($dir) {",
          "  if (-not (Test-Path -LiteralPath $dir)) { return }",
          "  $md = Join-Path $dir 'SKILL.md'",
          "  if (-not (Test-Path -LiteralPath $md)) { return }",
          "  $dirName = Split-Path -Leaf $dir",
          "  if ($dirName) { Write-Output $dirName }",
          "  $lines = Get-Content -LiteralPath $md -TotalCount 25 -ErrorAction SilentlyContinue",
          "  if ($lines -and $lines[0] -match '^---\\s*$') {",
          "    for ($i = 1; $i -lt $lines.Count; $i++) {",
          "      if ($lines[$i] -match '^---\\s*$') { break }",
          "      if ($lines[$i] -match '^name:\\s*(.+?)\\s*$') {",
          "        $n = $Matches[1].Trim('\"', \"'\")",
          "        if ($n) { Write-Output $n }",
          "      }",
          "    }",
          "  }",
          "}",
          `$roots = @(${arr})`,
          "foreach ($r in $roots) {",
          "  if (-not (Test-Path -LiteralPath $r)) { continue }",
          "  Get-ChildItem -LiteralPath $r -Directory -ErrorAction SilentlyContinue | ForEach-Object { Scan-SkillDir $_.FullName }",
          "}",
          `$plugins = ${psq(pluginRoot)}`,
          "if ($plugins -and (Test-Path -LiteralPath $plugins)) {",
          "  Get-ChildItem -LiteralPath $plugins -Directory -ErrorAction SilentlyContinue | ForEach-Object {",
          "    foreach ($sub in @('skills', 'antigravity/skills')) {",
          "      $p = Join-Path $_.FullName $sub",
          "      if (Test-Path -LiteralPath $p) {",
          "        Get-ChildItem -LiteralPath $p -Directory -ErrorAction SilentlyContinue | ForEach-Object { Scan-SkillDir $_.FullName }",
          "      }",
          "    }",
          "  }",
          "}",
        ].join("\n");
        return exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], execOpts).catch(() => null);
      })()
    : (() => {
        const shScript = [
          'plugins="$1"; shift',
          'read_skill() {',
          '  f="$1"; d=$(dirname "$f"); basename "$d"',
          '  awk \'NR==1 && $0 ~ /^---[[:space:]]*$/ { fm=1; next } fm && $0 ~ /^---[[:space:]]*$/ { exit } fm && $0 ~ /^name:/ { sub(/^name:[[:space:]]*/, ""); gsub(/["\x27]/, ""); gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit }\' "$f"',
          '}',
          'for r in "$@"; do',
          '  [ -d "$r" ] || continue',
          '  find -L "$r" -maxdepth 2 -type f -name "SKILL.md" 2>/dev/null | while IFS= read -r f; do read_skill "$f"; done',
          'done',
          'if [ -n "$plugins" ] && [ -d "$plugins" ]; then',
          '  find -L "$plugins" -maxdepth 4 -type f -name "SKILL.md" 2>/dev/null | while IFS= read -r f; do read_skill "$f"; done',
          'fi',
        ].join("\n");
        return exec("sh", ["-c", shScript, "scan-skills", pluginRoot || "", ...roots], execOpts).catch(() => null);
      })();

  const [execRes, ...jsonTexts] = await Promise.all([
    scanExec,
    ...skillsJsonFiles.map((file) => readTextFile(file, on ? { on } : undefined).catch(() => null)),
  ]);

  if (execRes?.code === 0) stdout = execRes.stdout;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const name = line.trim().toLowerCase();
    if (name) found.add(name);
  }
  for (const raw of jsonTexts) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      for (const item of parsed?.include_only ?? []) {
        const name = String(item ?? "").trim().toLowerCase();
        if (name) found.add(name);
      }
    } catch { /* ignore malformed skills.json */ }
  }

  skillCache.set(cacheKey, found);
  return found;
}

// ---- Environment guard evaluation -----------------------------------------------------------------

export function fieldText(v) {
  if (v == null) return "";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.map(fieldText).filter(Boolean).join(", ");
  if (v.type === "doc") return adfToMarkdown(v).trim();
  return String(v.value ?? v.name ?? v.displayName ?? v.key ?? "");
}

export function issueProject(issue, isGh) {
  if (!issue) return "";
  if (isGh) return String(issue.repo ?? "");
  return String(issue.key ?? "").replace(/-\d+$/, "");
}

const listMatch = (list, value) => !list?.length || list.some((x) => x.toLowerCase() === String(value ?? "").trim().toLowerCase());

export function matchesCheapGuards(action, issue, isGh) {
  if (!action || action.enabled === false || !issue) return false;
  const g = action.guards ?? {};
  const tracker = isGh ? "github" : "jira";
  if (g.tracker && g.tracker !== "any" && g.tracker !== tracker) return false;
  if (!listMatch(g.sites, issue.site)) return false;
  if (!listMatch(g.projects, issueProject(issue, isGh))) return false;
  if (!listMatch(g.issueTypes, issue.fields?.issuetype?.name)) return false;
  if (!listMatch(g.statuses, issue.fields?.status?.name)) return false;
  return true;
}

export function resolveTargetFields(targetFields, editMeta) {
  if (!targetFields?.length || !editMeta) return [];
  const entries = Object.entries(editMeta);
  return targetFields.map((wanted) => {
    const w = String(wanted ?? "").trim();
    const wl = w.toLowerCase();
    const hit = entries.find(([id]) => id.toLowerCase() === wl)
      ?? entries.find(([, meta]) => String(meta?.name ?? "").trim().toLowerCase() === wl);
    return hit ? { id: hit[0], name: String(hit[1]?.name ?? hit[0]), wanted: w } : null;
  }).filter(Boolean);
}

export function evaluateAction(action, { issue, isGh, skills = null, editMeta = null, fieldValues = null } = {}) {
  if (!matchesCheapGuards(action, issue, isGh)) {
    return { visible: false, filled: false, presentFields: [], missingFields: [], skillMissing: false, reason: "Does not match issue filters" };
  }
  if (action.skill && skills && !skills.has(action.skill.toLowerCase())) {
    return { visible: false, filled: false, presentFields: [], missingFields: [], skillMissing: true, reason: `Skill "${action.skill}" not installed locally` };
  }
  const targets = action.guards?.targetFields ?? [];
  if (!isGh && targets.length && editMeta) {
    const presentFields = resolveTargetFields(targets, editMeta);
    const enough = action.guards.requireAllFields ? presentFields.length >= targets.length : presentFields.length > 0;
    if (!enough) {
      return { visible: false, filled: false, presentFields, missingFields: [], skillMissing: false, reason: "Target field not available on this issue" };
    }
    const missingFields = fieldValues
      ? presentFields.filter((f) => !fieldText(fieldValues[f.id]).trim()).map((f) => f.name)
      : [];
    const filled = Boolean(fieldValues) && presentFields.length > 0 && missingFields.length === 0;
    if (filled && action.guards.hideWhenFilled) {
      return { visible: false, filled: true, presentFields, missingFields: [], skillMissing: false, reason: "Already filled" };
    }
    return { visible: true, filled, presentFields, missingFields, skillMissing: false, reason: "" };
  }
  return { visible: true, filled: false, presentFields: [], missingFields: [], skillMissing: false, reason: "" };
}

export function evaluateSequence(seq, evalById, actionById) {
  if (!seq || seq.enabled === false) return { visible: false, steps: [], pendingSteps: [], filled: false };
  const steps = seq.steps.map((id) => actionById.get(id)).filter((a) => a && evalById.get(a.id)?.visible);
  const pendingSteps = steps.filter((a) => !evalById.get(a.id)?.filled);
  return {
    visible: steps.length > 0,
    steps,
    pendingSteps,
    filled: steps.length > 0 && pendingSteps.length === 0,
  };
}

// ---- Shared run state helpers ---------------------------------------------------------------------

export const issueRunKey = (site, repo, key) => `${site ?? ""}|${repo ?? ""}|${key ?? ""}`;

export function allRuns() {
  const v = shared(ACTION_RUNS);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

export function getRun(runKey) {
  return runKey ? allRuns()[runKey] ?? null : null;
}

function pruneRuns(map) {
  const entries = Object.entries(map);
  if (entries.length <= MAX_KEPT_RUNS) return map;
  const active = entries.filter(([, r]) => r?.status === "running" || r?.status === "awaiting_verification");
  const done = entries.filter(([, r]) => r?.status !== "running" && r?.status !== "awaiting_verification")
    .sort((a, b) => (b[1]?.endedAt ?? b[1]?.startedAt ?? 0) - (a[1]?.endedAt ?? a[1]?.startedAt ?? 0))
    .slice(0, Math.max(0, MAX_KEPT_RUNS - active.length));
  return Object.fromEntries([...active, ...done]);
}

export function setRun(runKey, run) {
  if (!runKey) return;
  const next = { ...allRuns() };
  if (run) next[runKey] = run;
  else delete next[runKey];
  setShared(ACTION_RUNS, pruneRuns(next));
}

export function patchRun(runKey, patch) {
  const cur = getRun(runKey);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  setRun(runKey, next);
  return next;
}

export function dismissRun(runKey) {
  const cur = getRun(runKey);
  if (!cur || cur.status === "running" || cur.status === "awaiting_verification") return;
  setRun(runKey, null);
}
