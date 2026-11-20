// AI semantic enricher for Visual Review.
// Runs Claude Code or Codex in read-only mode on the repository's machine to
// extract semantic units, summaries, cohesion scores, relations and DB tables,
// then recomputes exact Git line deltas and Ce/Ca coupling locally.
import { exec, knownAgents, shared } from "herdr";
import { normPath } from "./git.js";
import { unitDelta, computeCoupling } from "./analyze-static.js";

export const AI_KEY = "visual-review.ai";
const DEFAULT_MODEL = { claude: "sonnet", codex: "" };

const UNIT_KINDS = new Set(["class", "interface", "record", "struct", "enum", "module", "file"]);
const UNIT_STATES = new Set(["added", "modified", "deleted", "context"]);
const MEMBER_KINDS = new Set(["method", "property", "field", "constructor"]);
const MEMBER_STATES = new Set(["added", "modified", "deleted"]);
const REL_KINDS = new Set(["inheritance", "implementation", "composition", "dependency", "table-link"]);
const REL_STATES = new Set(["added", "removed", "unchanged"]);
const TABLE_STATES = new Set(["added", "modified", "dropped"]);
const COL_STATES = new Set(["added", "modified", "dropped", "unchanged"]);

export function aiSettings() {
  const s = shared(AI_KEY);
  const o = s && typeof s === "object" ? s : {};
  return {
    provider: ["claude", "codex"].includes(o.provider) ? o.provider : "auto",
    model: typeof o.model === "string" ? o.model.trim() : "",
  };
}

const installedCache = new Map();

export async function resolveEngine(on) {
  const s = aiSettings();
  let provider = s.provider;
  if (provider === "auto") {
    const key = on ?? "";
    const cached = installedCache.get(key);
    let ids = cached && Date.now() - cached.at < 60000 ? cached.ids : null;
    if (!ids) {
      ids = new Set();
      try {
        for (const a of await knownAgents({ on })) {
          if (a.installed) ids.add(String(a.key ?? "").toLowerCase());
        }
      } catch {}
      installedCache.set(key, { at: Date.now(), ids });
    }
    const has = (k) => [...ids].some((id) => id === k || id.startsWith(k));
    provider = has("claude") ? "claude" : has("codex") ? "codex" : null;
  }
  if (!provider) return null;
  return { provider, model: s.model || DEFAULT_MODEL[provider] || "" };
}

function buildPrompt(resolved, files) {
  const diffCmd = resolved.includeWorktree
    ? `git diff ${resolved.base}`
    : `git diff ${resolved.base} ${resolved.head}`;
  const listed = files.slice(0, 60).map((f) => `${f.status} ${f.path}`).join("\n");
  const extra = files.length > 60 ? `\n... and ${files.length - 60} more files (run ${diffCmd} --stat)` : "";

  return [
    "Analyze the design of this Git change in read-only mode and output ONLY a single valid JSON object (no markdown fences, no commentary).",
    `Diff command: ${diffCmd}`,
    `Changed files (${files.length}):\n${listed}${extra}`,
    "Inspect the diff and relevant files (including immediate unchanged neighbor types as context units when helpful).",
    "Return JSON with this exact shape:",
    '{"units":[{"id":"Namespace.Class or path#Name","name":"ShortName","kind":"class|interface|record|struct|enum|module","state":"added|modified|deleted|context","file":"repo/rel/path","container":"C# namespace or folder","range":{"start":1,"end":50},"baseRange":{"start":1,"end":45},"methods":4,"summary":"1-2 concise sentences explaining what changed and why","cohesion":{"score":4,"reason":"short reason"},"members":[{"id":"Foo()","name":"Foo","kind":"method|property|field|constructor","state":"added|modified|deleted"}]}],"relations":[{"from":"unit.id","to":"unit.id","kind":"inheritance|implementation|composition|dependency","state":"added|removed|unchanged"}],"tables":[{"id":"schema.table","state":"added|modified|dropped","source":"path","entity":"unit.id","columns":[{"name":"id","type":"uuid","baseType":"int","state":"added|modified|dropped|unchanged","isPrimaryKey":true,"references":"other.id"}]}],"skippedFiles":[{"file":"path","reason":"generated"}]}',
    "Rules: cover every meaningful changed source file; every relation must reference valid unit ids; keep summaries crisp and objective; output ONLY the JSON object.",
  ].join("\n\n");
}

function extractJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  // Direct JSON
  if (text.startsWith("{")) {
    try { return JSON.parse(text); } catch {}
  }
  // Fenced ```json ... ```
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch {}
  }
  // Outermost { ... }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }
  return null;
}

function narrowRange(r) {
  if (!r || typeof r !== "object") return null;
  const start = Number(r.start);
  const end = Number(r.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
  return { start, end };
}

function normalizeModel(raw, resolved, collection, engine) {
  const units = [];
  const unitIds = new Set();
  const coveredFiles = new Set();

  for (const u of Array.isArray(raw.units) ? raw.units : []) {
    if (!u || typeof u !== "object" || !u.id || !u.name) continue;
    const id = String(u.id);
    if (unitIds.has(id)) continue;
    unitIds.add(id);
    const file = normPath(u.file || "");
    if (file) coveredFiles.add(file);
    const state = UNIT_STATES.has(u.state) ? u.state : "modified";
    const range = narrowRange(u.range);
    const baseRange = narrowRange(u.baseRange);
    const hunks = collection.hunksByFile.get(file);
    const delta = unitDelta({ state, range, baseRange }, hunks);
    const fileEntry = collection.files.find((f) => f.path === file);

    const members = [];
    for (const m of Array.isArray(u.members) ? u.members : []) {
      if (!m || !m.name) continue;
      members.push({
        id: String(m.id || m.name),
        name: String(m.name),
        kind: MEMBER_KINDS.has(m.kind) ? m.kind : "method",
        state: MEMBER_STATES.has(m.state) ? m.state : "modified",
      });
    }

    const cohesion = u.cohesion && Number.isFinite(Number(u.cohesion.score))
      ? { score: Math.max(1, Math.min(5, Math.round(Number(u.cohesion.score)))), reason: String(u.cohesion.reason || "") }
      : null;

    units.push({
      id,
      name: String(u.name),
      kind: UNIT_KINDS.has(u.kind) ? u.kind : "class",
      state,
      file,
      container: typeof u.container === "string" && u.container ? u.container : (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "."),
      range,
      baseRange,
      lines: range ? range.end - range.start + 1 : null,
      added: state === "context" ? null : (delta.added ?? fileEntry?.added ?? null),
      removed: state === "context" ? null : (delta.removed ?? fileEntry?.removed ?? null),
      methods: Number.isInteger(u.methods) && u.methods >= 0 ? u.methods : null,
      members,
      summary: typeof u.summary === "string" && u.summary.trim() ? u.summary.trim() : null,
      cohesion,
      ce: 0,
      ca: 0,
    });
  }

  const tables = [];
  const tableIds = new Set();
  for (const t of Array.isArray(raw.tables) ? raw.tables : []) {
    if (!t || !t.id) continue;
    const id = String(t.id);
    if (tableIds.has(id)) continue;
    tableIds.add(id);
    if (t.source) coveredFiles.add(normPath(t.source));
    const columns = [];
    for (const c of Array.isArray(t.columns) ? t.columns : []) {
      if (!c || !c.name) continue;
      columns.push({
        name: String(c.name),
        type: String(c.type || ""),
        baseType: c.baseType ? String(c.baseType) : null,
        state: COL_STATES.has(c.state) ? c.state : "unchanged",
        isPrimaryKey: Boolean(c.isPrimaryKey),
        references: c.references ? String(c.references) : null,
      });
    }
    tables.push({
      id,
      state: TABLE_STATES.has(t.state) ? t.state : "modified",
      source: normPath(t.source || ""),
      entity: t.entity && unitIds.has(String(t.entity)) ? String(t.entity) : null,
      columns,
    });
  }

  const relations = [];
  const relSeen = new Set();
  for (const r of Array.isArray(raw.relations) ? raw.relations : []) {
    if (!r || !r.from || !r.to) continue;
    const from = String(r.from);
    const to = String(r.to);
    if (!unitIds.has(from) || !unitIds.has(to) || from === to) continue;
    const kind = REL_KINDS.has(r.kind) ? r.kind : "dependency";
    const state = REL_STATES.has(r.state) ? r.state : "unchanged";
    const key = `${from}->${to}:${kind}`;
    if (relSeen.has(key)) continue;
    relSeen.add(key);
    relations.push({ id: key, from, to, kind, state });
  }

  // Add entity -> table links
  for (const tbl of tables) {
    if (tbl.entity && unitIds.has(tbl.entity)) {
      const key = `${tbl.entity}->t:${tbl.id}:table-link`;
      if (!relSeen.has(key)) {
        relSeen.add(key);
        relations.push({
          id: key,
          from: tbl.entity,
          to: `t:${tbl.id}`,
          kind: "table-link",
          state: tbl.state === "added" ? "added" : tbl.state === "dropped" ? "removed" : "unchanged",
        });
      }
    }
  }

  const skippedFiles = [];
  for (const sf of Array.isArray(raw.skippedFiles) ? raw.skippedFiles : []) {
    if (sf?.file) {
      const p = normPath(sf.file);
      coveredFiles.add(p);
      skippedFiles.push({ file: p, reason: String(sf.reason || "skipped") });
    }
  }

  const otherFiles = collection.files
    .filter((f) => !coveredFiles.has(f.path))
    .map((f) => ({
      path: f.path,
      state: f.isUntracked || f.status === "A" ? "added" : f.status === "D" ? "deleted" : "modified",
      added: f.added,
      removed: f.removed,
    }));

  computeCoupling(units, relations);

  return {
    source: "ai",
    engine,
    selection: resolved,
    units,
    relations,
    tables,
    otherFiles,
    skippedFiles,
    generatedAt: Date.now(),
    totalChangedFiles: collection.files.length,
  };
}

export async function analyzeWithAI(repo, resolved, collection) {
  const eng = await resolveEngine(repo.on);
  if (!eng) throw new Error("Claude Code or Codex is not installed on this machine.");

  const prompt = buildPrompt(resolved, collection.files);
  const args = eng.provider === "claude"
    ? [
      "-p", prompt,
      ...(eng.model ? ["--model", eng.model] : []),
      "--no-session-persistence",
      "--allowedTools", "Read,Grep,Glob,Bash(git diff:*),Bash(git show:*),Bash(git status:*),Bash(git log:*)",
    ]
    : [
      "exec",
      ...(eng.model ? ["-m", eng.model] : []),
      "--skip-git-repo-check",
      "--ephemeral",
      "-s", "read-only",
      prompt,
    ];

  const r = await exec(eng.provider, args, { cwd: repo.root, on: repo.on, timeout: 240000 });
  if (r.code !== 0) {
    const errLine = (r.stderr || r.stdout || `exit code ${r.code}`).trim().split("\n").pop()?.slice(0, 220);
    throw new Error(errLine || "AI analysis failed.");
  }

  const parsed = extractJson(r.stdout);
  if (!parsed || (!Array.isArray(parsed.units) && !Array.isArray(parsed.tables))) {
    throw new Error("The AI model did not return a valid design model JSON.");
  }

  return normalizeModel(parsed, resolved, collection, eng);
}
