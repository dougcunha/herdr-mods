// The data of the Spec Board: the SDD specs (tasks/prd-<slug>/) of a repository
// and of its git worktrees, read from the files that the SDD skills write.

import { exec, home, readTextFile } from "herdr";

export const isWin = () => /^[A-Za-z]:[\\/]/.test(home());
/** A path with forward slashes and no trailing slash (a drive root keeps it). */
export const norm = (p) => String(p || "").trim().replace(/\\/g, "/").replace(/([^:/])\/+$/, "$1");
/** Paths in one form, to compare them. */
export const same = (a, b) => {
  const f = (p) => (isWin() ? norm(p).toLowerCase() : norm(p));
  return f(a) === f(b);
};
/** True when `p` is `root` or a folder under it. */
export const inside = (p, root) => {
  const f = (x) => (isWin() ? norm(x).toLowerCase() : norm(x));
  const a = f(p);
  const b = f(root);
  return Boolean(a && b) && (a === b || a.startsWith(b.endsWith("/") ? b : b + "/"));
};
/** A path in the form of this system, for programs and Herdr commands. */
export const native = (p) => (isWin() ? norm(p).replace(/\//g, "\\") : norm(p));
export const join = (...parts) => norm(parts.filter(Boolean).join("/"));
export const baseName = (p) => norm(p).split("/").pop() || p;
export const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Runs a PowerShell command (Windows PowerShell is always there) and returns stdout. */
export async function powershell(command, cwd) {
  const r = await exec("powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], cwd ? { cwd } : {});
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim());
  return r.stdout;
}

/** Runs git in `cwd`. Rejects with git's message when it fails. */
export async function git(cwd, args) {
  const r = await exec("git", ["-C", native(cwd), ...args]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `git exit ${r.code}`).trim());
  return r.stdout;
}

/**
 * The repository of `cwd`: its main checkout and every worktree.
 * A folder that is not in git is a repository of one folder.
 * Returns { root, name, git, worktrees: [{ path, branch, main }] }.
 */
export async function findRepo(cwd) {
  let top;
  try {
    top = norm((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    const root = norm(cwd);
    return { root, name: baseName(root), git: false, worktrees: [{ path: root, branch: null, main: true }] };
  }
  const worktrees = [];
  try {
    let cur = null;
    for (const line of (await git(top, ["worktree", "list", "--porcelain"])).split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        cur = { path: norm(line.slice(9)), branch: null, main: worktrees.length === 0, bare: false };
        worktrees.push(cur);
      } else if (cur && line.startsWith("branch ")) {
        cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
      } else if (cur && line === "bare") {
        cur.bare = true;
      } else if (cur && (line === "prunable" || line.startsWith("prunable "))) {
        cur.gone = true;
      }
    }
  } catch { /* an old git: only the checkout of cwd */ }
  const list = worktrees.filter((w) => !w.bare && !w.gone);
  if (!list.some((w) => same(w.path, top))) list.push({ path: top, branch: null, main: list.length === 0 });
  const root = list.find((w) => w.main)?.path ?? top;
  return { root, name: baseName(root), git: true, worktrees: list };
}

/**
 * The files under `dir` (4 levels at most), as paths relative to `dir` with
 * forward slashes, each with its change time in ms (0 when unknown).
 * A missing folder gives [].
 */
export async function listFiles(dir) {
  if (isWin()) {
    const cmd = `$d=${psQuote(native(dir))}; if (Test-Path -LiteralPath $d -PathType Container) { `
      + `$n=(Get-Item -LiteralPath $d).FullName.TrimEnd('\\').Length + 1; `
      + `Get-ChildItem -LiteralPath $d -Recurse -Depth 3 -File -Force -ErrorAction SilentlyContinue | ForEach-Object { `
      + `$_.FullName.Substring($n) + [char]9 + [long]($_.LastWriteTimeUtc - [datetime]'1970-01-01').TotalMilliseconds } }`;
    const out = await powershell(cmd);
    return out.split(/\r?\n/).filter(Boolean).map((l) => {
      const [rel, ms] = l.split("\t");
      return { rel: rel.replace(/\\/g, "/"), time: Number(ms) || 0 };
    });
  }
  const r = await exec("sh", ["-c", 'cd "$1" 2>/dev/null || exit 0; find . -maxdepth 4 -type f', "sh", dir]);
  return r.stdout.split(/\n/).filter(Boolean).map((l) => ({ rel: l.replace(/^\.\//, ""), time: 0 }));
}

// ---- the specs -----------------------------------------------------------

/** The phases of sdd-orquestrar-fluxo, in order. `conceito` is shown on the first step. */
export const PHASES = ["produto", "projeto-plano", "implementacao", "revisao", "correcoes", "aceite", "concluido"];
export const phaseIndex = (phase) => (phase === "conceito" ? 0 : PHASES.indexOf(phase));

/**
 * The status of a spec, from its checkpoint:
 * waiting (aguardando-hil), blocked, active, paused, new (no checkpoint),
 * done (concluido) or invalid (a checkpoint that is not valid JSON).
 */
export function statusOf(cp) {
  if (cp === undefined) return "new";
  if (cp === null) return "invalid";
  if (cp.status === "concluido" || cp.phase === "concluido") return "done";
  return { "aguardando-hil": "waiting", bloqueado: "blocked", ativo: "active", pausado: "paused" }[cp.status] ?? "active";
}

/** Sort weight of a status: the ones that need the person first. */
export const URGENCY = { waiting: 0, blocked: 1, invalid: 2, active: 3, paused: 4, new: 5, done: 6 };

const REVIEW = /\b(APROVADO COM RESSALVAS|REPROVADO|APROVADO|APPROVED WITH RESERVATIONS|REJECTED|APPROVED)\b/;
/** The status word of a codereview.md, or null. */
export function reviewStatus(text) {
  return String(text ?? "").match(REVIEW)?.[1] ?? null;
}

/** The text of `pending_hil`, which a skill may write as a string or an object. */
export function hilText(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return String(v.gate ?? v.pergunta ?? v.question ?? v.titulo ?? v.title ?? JSON.stringify(v));
  return String(v);
}

/**
 * The group of a slug that a split of sdd-orquestrar-prds made:
 * "colinha-01-catalogo" → "colinha", "admin-01b-fundacao" → "admin".
 */
export function groupOf(slug) {
  return slug.match(/^(.+?)-\d{2}[a-z]?-/)?.[1] ?? null;
}

const lower = (s) => s.toLowerCase();

/**
 * Builds the specs of one `tasks/` folder from its file list. A spec is a
 * folder `prd-<slug>` with at least one file.
 */
function specsOf(where, files) {
  const by = new Map();
  for (const f of files) {
    const parts = f.rel.split("/");
    if (parts.length < 2 || !/^prd-/i.test(parts[0])) continue;
    const dir = parts[0];
    const s = by.get(dir) ?? { dir, files: [], time: 0 };
    s.files.push({ rel: parts.slice(1).join("/"), time: f.time });
    s.time = Math.max(s.time, f.time);
    by.set(dir, s);
  }
  return [...by.values()].map((s) => {
    const names = new Map(s.files.map((f) => [lower(f.rel), f.rel]));
    const pick = (name) => names.get(name) ?? null;
    const tasks = [];
    for (const f of s.files) {
      const m = f.rel.match(/^(done\/)?(task_(\d+)\.md)$/i);
      if (m) tasks.push({ file: f.rel, name: m[2], num: Number(m[3]), done: Boolean(m[1]) });
    }
    tasks.sort((a, b) => a.num - b.num);
    const reviews = new Map();
    for (const f of s.files) {
      const m = f.rel.match(/^(codereview_(\d+))\/(.+)$/i);
      if (!m) continue;
      const r = reviews.get(m[1]) ?? { dir: m[1], num: Number(m[2]), report: null, tasks: [] };
      if (/^codereview\.md$/i.test(m[3])) r.report = f.rel;
      const t = m[3].match(/^(done\/)?(task_(\d+)\.md)$/i);
      if (t) r.tasks.push({ file: f.rel, name: t[2], num: Number(t[3]), done: Boolean(t[1]) });
      reviews.set(m[1], r);
    }
    const designs = s.files.filter((f) => /^designreview_\d+\/designreview\.md$/i.test(f.rel)).map((f) => f.rel).sort();
    return {
      slug: s.dir.replace(/^prd-/i, ""),
      dir: s.dir,
      where, // the worktree: { path, branch, main }
      path: join(where.path, "tasks", s.dir),
      time: s.time,
      docs: {
        prd: pick("prd.md"),
        techspec: pick("techspec.md"),
        tasks: pick("tasks.md"),
        workflow: pick("workflow.md"),
        snapshot: pick("snapshot-contexto.md"),
        brief: pick("brief.md"),
        checkpoint: pick("checkpoint.json"),
      },
      designs,
      tasks,
      reviews: [...reviews.values()].sort((a, b) => a.num - b.num),
    };
  });
}

/** Reads and parses a checkpoint: undefined when there is none, null when it is not valid JSON. */
async function readCheckpoint(spec) {
  if (!spec.docs.checkpoint) return undefined;
  try {
    const text = await readTextFile(join(spec.path, spec.docs.checkpoint));
    if (text == null) return undefined;
    const cp = JSON.parse(text);
    return cp && typeof cp === "object" ? cp : null;
  } catch {
    return null;
  }
}

/** The titles of the tasks from the list of tasks.md: `- [T01 — Title](task_01.md)`. */
async function readTitles(spec) {
  if (!spec.docs.tasks) return {};
  const text = await readTextFile(join(spec.path, spec.docs.tasks)).catch(() => null);
  const titles = {};
  for (const m of String(text ?? "").matchAll(/\[([^\]]+)\]\((?:done\/)?(task_\d+\.md)\)/gi)) {
    titles[m[2].toLowerCase()] = m[1].replace(/^T\d+\s*[—–-]\s*/, "").trim();
  }
  return titles;
}

/**
 * All the specs of `repo` (from findRepo). A spec that is in more than one
 * worktree shows once: the copy with a checkpoint, then the highest
 * checkpoint generation, then the newest files. `others` lists the other copies.
 */
export async function scan(repo) {
  const all = [];
  const tasksDirs = [];
  for (const w of repo.worktrees) {
    const dir = join(w.path, "tasks");
    const files = await listFiles(dir).catch(() => []);
    if (files.length) tasksDirs.push(dir);
    all.push(...specsOf(w, files));
  }
  await Promise.all(all.map(async (s) => {
    s.checkpoint = await readCheckpoint(s);
    s.status = statusOf(s.checkpoint);
    const titles = await readTitles(s);
    for (const t of s.tasks) t.title = titles[t.name.toLowerCase()] ?? null;
    s.total = s.tasks.length;
    s.doneCount = s.tasks.filter((t) => t.done).length;
    const last = s.reviews.filter((r) => r.report).pop();
    s.review = s.checkpoint?.review_status ?? null;
    s.lastReview = last ?? null;
  }));
  // Without a checkpoint, a copy that a worktree checkout made is not newer work: the main checkout wins.
  const rank = (s) => [s.checkpoint !== undefined ? 1 : 0, Number(s.checkpoint?.generation) || 0, s.where.main ? 1 : 0, s.time];
  const better = (a, b) => {
    const x = rank(a);
    const y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
  };
  const bySlug = new Map();
  for (const s of all) {
    const key = s.slug.toLowerCase();
    const cur = bySlug.get(key);
    if (!cur) bySlug.set(key, { ...s, others: [] });
    else if (better(s, cur)) bySlug.set(key, { ...s, others: [...cur.others, { ...cur, others: undefined }] });
    else cur.others.push(s);
  }
  return { specs: [...bySlug.values()], tasksDirs };
}

/** Sorts specs: "urgency" (status, then newest) or "name". */
export function sortSpecs(list, mode) {
  const byName = (a, b) => a.slug.localeCompare(b.slug);
  if (mode === "name") return [...list].sort(byName);
  return [...list].sort((a, b) => (URGENCY[a.status] - URGENCY[b.status]) || (b.time - a.time) || byName(a, b));
}

/**
 * Rows for the list: with `grouped`, the specs of a split (2 or more with
 * the same prefix) go under one header, at the place of their most urgent spec,
 * in slug order.
 */
export function rowsOf(sorted, grouped) {
  if (!grouped) return sorted.map((s) => ({ kind: "spec", spec: s }));
  const counts = new Map();
  for (const s of sorted) {
    const g = groupOf(s.slug);
    if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const rows = [];
  const seen = new Set();
  for (const s of sorted) {
    const g = groupOf(s.slug);
    if (!g || counts.get(g) < 2) {
      rows.push({ kind: "spec", spec: s });
      continue;
    }
    if (seen.has(g)) continue;
    seen.add(g);
    const members = sorted.filter((x) => groupOf(x.slug) === g).sort((a, b) => a.slug.localeCompare(b.slug));
    rows.push({ kind: "group", name: g, specs: members });
    for (const m of members) rows.push({ kind: "spec", spec: m, inGroup: g });
  }
  return rows;
}
