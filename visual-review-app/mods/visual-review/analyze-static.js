// Fast static analyzer for Visual Review (<500ms, zero AI cost).
// Supports C#/.NET (.cs), TypeScript/JavaScript (.ts/.tsx/.js/.jsx/.mjs/.cjs),
// SQL/Prisma (.sql/.prisma) and falls back to file-level units for other files.
import { readFileContent, normPath } from "./git.js";

const CS_EXT = /\.cs$/i;
const TS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;
const SQL_EXT = /\.sql$/i;
const PRISMA_EXT = /\.prisma$/i;
const MAX_PARSE_FILES = 80;
const MAX_FILE_BYTES = 260 * 1024;

function folderOf(filePath) {
  const i = filePath.lastIndexOf("/");
  return i > 0 ? filePath.slice(0, i) : ".";
}

function baseName(filePath) {
  const i = filePath.lastIndexOf("/");
  return i >= 0 ? filePath.slice(i + 1) : filePath;
}

function stripExt(name) {
  return name.replace(/\.[^.]+$/, "");
}

function stateFromStatus(status, isUntracked) {
  if (isUntracked || status === "A") return "added";
  if (status === "D") return "deleted";
  return "modified";
}

function overlap(start, count, range) {
  if (!range || count <= 0) return 0;
  return Math.max(0, Math.min(start + count - 1, range.end) - Math.max(start, range.start) + 1);
}

export function unitDelta(unit, hunks) {
  if (unit.state === "context") return { added: null, removed: null };
  if (!hunks) return { added: null, removed: null };
  if (!unit.range) {
    const added = hunks.reduce((s, h) => s + h.newCount, 0);
    const removed = hunks.reduce((s, h) => s + h.oldCount, 0);
    return { added, removed };
  }
  if (unit.state === "deleted") {
    return { added: 0, removed: hunks.reduce((s, h) => s + overlap(h.oldStart, h.oldCount, unit.range), 0) };
  }
  const added = hunks.reduce((s, h) => s + overlap(h.newStart, h.newCount, unit.range), 0);
  const removed = unit.baseRange
    ? hunks.reduce((s, h) => s + overlap(h.oldStart, h.oldCount, unit.baseRange), 0)
    : hunks.reduce((s, h) => s + overlap(h.oldStart, h.oldCount, unit.range), 0);
  return { added, removed };
}

export function computeCoupling(units, relations) {
  const pairs = new Set(
    relations
      .filter((r) => r.state !== "removed" && r.from !== r.to && r.kind !== "table-link")
      .map((r) => `${r.from}\n${r.to}`),
  );
  const map = new Map(units.map((u) => [u.id, { ce: 0, ca: 0 }]));
  for (const key of pairs) {
    const [from, to] = key.split("\n");
    if (map.has(from)) map.get(from).ce += 1;
    if (map.has(to)) map.get(to).ca += 1;
  }
  for (const u of units) {
    const c = map.get(u.id) ?? { ce: 0, ca: 0 };
    u.ce = c.ce;
    u.ca = c.ca;
  }
}

/** Finds the closing brace line for a block starting at or after `startLine` (1-based). */
function findBlockEnd(lines, startLine) {
  let depth = 0;
  let seenOpen = false;
  for (let i = startLine - 1; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === "{") { depth++; seenOpen = true; }
      else if (ch === "}") {
        depth--;
        if (seenOpen && depth <= 0) return i + 1;
      }
    }
    if (!seenOpen && line.includes(";")) return i + 1;
  }
  return lines.length;
}

function lineTouchesHunk(lineNo, hunks, isDeleted) {
  if (!hunks || !hunks.length) return true;
  for (const h of hunks) {
    if (isDeleted) {
      if (h.oldCount > 0 && lineNo >= h.oldStart && lineNo < h.oldStart + h.oldCount) return true;
    } else {
      if (h.newCount > 0 && lineNo >= h.newStart && lineNo < h.newStart + h.newCount) return true;
    }
  }
  return false;
}

/** Extracts C#/.NET units, heritage, members, and EF migration tables. */
function parseCSharp(file, text, hunks) {
  const lines = text.split(/\r?\n/);
  const units = [];
  const tables = [];
  const rawRelations = [];
  const fileState = stateFromStatus(file.status, file.isUntracked);
  const isDeleted = fileState === "deleted";

  let ns = folderOf(file.path);
  for (const line of lines) {
    const m = /^\s*namespace\s+([A-Za-z0-9_.]+)/.exec(line);
    if (m) { ns = m[1]; break; }
  }

  const typeRe = /^\s*(?:(?:public|internal|private|protected|static|abstract|sealed|partial|readonly|ref|file|new)\s+)*(class|interface|record\s+struct|record\s+class|record|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)(?:<[^>]+>)?(?:\s*\([^)]*\))?(?:\s*:\s*([^{;]+))?/;
  const memberRe = /^\s*(?:(?:public|internal|private|protected|static|virtual|override|abstract|async|sealed|readonly|new|extern|partial)\s+)+([A-Za-z0-9_<>,.?\[\]\s]+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\(|=>|\{)/;

  for (let i = 0; i < lines.length; i++) {
    const m = typeRe.exec(lines[i]);
    if (!m) continue;
    const rawKind = m[1].startsWith("record") ? "record" : m[1];
    const name = m[2];
    const start = i + 1;
    const end = findBlockEnd(lines, start);
    const id = `${ns}.${name}`;

    // Heritage (: Base, IInterface)
    const heritage = [];
    if (m[3]) {
      for (const part of m[3].split(",")) {
        const clean = part.replace(/where\s+.*/, "").replace(/<.*>/, "").replace(/\(.*\)/, "").trim();
        const short = clean.split(".").pop();
        if (short && /^[A-Za-z_]/.test(short)) heritage.push(short);
      }
    }

    // Scan members inside range
    const members = [];
    let methodCount = 0;
    const bodyText = lines.slice(start, end).join("\n");
    for (let j = start; j < end - 1; j++) {
      const mm = memberRe.exec(lines[j]);
      if (!mm) continue;
      const mName = mm[2];
      if (["if", "for", "foreach", "while", "switch", "catch", "using", "lock", "return"].includes(mName)) continue;
      const isMethod = mm[3] === "(";
      if (isMethod) methodCount++;
      if (lineTouchesHunk(j + 1, hunks, isDeleted) || fileState !== "modified") {
        members.push({
          id: `${mName}${isMethod ? "()" : ""}`,
          name: mName,
          kind: mName === name ? "constructor" : isMethod ? "method" : "property",
          state: fileState === "added" ? "added" : fileState === "deleted" ? "deleted" : "modified",
        });
      }
    }

    units.push({
      id,
      name,
      kind: rawKind,
      state: fileState,
      file: file.path,
      container: ns,
      range: { start, end },
      lines: end - start + 1,
      methods: methodCount,
      members: members.slice(0, 12),
      summary: null,
      cohesion: null,
      _body: bodyText,
      _heritage: heritage,
    });

    // EF Core migration table detection
    if (/migrationBuilder\.(CreateTable|AddColumn|DropTable)/.test(bodyText)) {
      const createRe = /CreateTable\s*\(\s*name:\s*"([^"]+)"/g;
      let cm;
      while ((cm = createRe.exec(bodyText))) {
        tables.push({
          id: cm[1],
          state: fileState === "deleted" ? "dropped" : "added",
          source: file.path,
          columns: [],
        });
      }
      const dropRe = /DropTable\s*\(\s*name:\s*"([^"]+)"/g;
      while ((cm = dropRe.exec(bodyText))) {
        tables.push({ id: cm[1], state: "dropped", source: file.path, columns: [] });
      }
    }

    i = end - 1;
  }

  return { units, tables, rawRelations };
}

/** Extracts TypeScript / JavaScript units, exports, heritage and imports. */
function parseTsJs(file, text, hunks) {
  const lines = text.split(/\r?\n/);
  const units = [];
  const imports = [];
  const fileState = stateFromStatus(file.status, file.isUntracked);
  const isDeleted = fileState === "deleted";
  const folder = folderOf(file.path);

  const importRe = /^\s*import\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+["']([^"']+)["']/;
  const typeRe = /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?(class|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:<[^>]+>)?(?:\s+extends\s+([A-Za-z0-9_$.]+))?(?:\s+implements\s+([^{]+))?/;
  const fnRe = /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;
  const memberRe = /^\s*(?:(?:public|private|protected|static|async|readonly|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const im = importRe.exec(lines[i]);
    if (im) imports.push(im[1]);

    const tm = typeRe.exec(lines[i]);
    if (tm) {
      const kind = tm[1];
      const name = tm[2];
      const start = i + 1;
      const end = findBlockEnd(lines, start);
      const heritage = [];
      if (tm[3]) heritage.push({ name: tm[3].split(".").pop(), kind: "inheritance" });
      if (tm[4]) {
        for (const p of tm[4].split(",")) {
          const clean = p.replace(/<.*>/, "").trim().split(".").pop();
          if (clean) heritage.push({ name: clean, kind: "implementation" });
        }
      }
      const members = [];
      let methodCount = 0;
      for (let j = start; j < end - 1; j++) {
        const mm = memberRe.exec(lines[j]);
        if (!mm) continue;
        const mName = mm[1];
        if (["if", "for", "while", "switch", "catch", "return", "function"].includes(mName)) continue;
        methodCount++;
        if (lineTouchesHunk(j + 1, hunks, isDeleted) || fileState !== "modified") {
          members.push({
            id: `${mName}()`,
            name: mName,
            kind: mName === "constructor" ? "constructor" : "method",
            state: fileState === "added" ? "added" : fileState === "deleted" ? "deleted" : "modified",
          });
        }
      }
      units.push({
        id: `${file.path}#${name}`,
        name,
        kind,
        state: fileState,
        file: file.path,
        container: folder,
        range: { start, end },
        lines: end - start + 1,
        methods: methodCount,
        members: members.slice(0, 12),
        summary: null,
        cohesion: null,
        _imports: imports,
        _tsHeritage: heritage,
      });
      i = end - 1;
      continue;
    }
  }

  // If no classes/interfaces found, represent the file as a module unit with exported functions as members
  if (!units.length) {
    const members = [];
    for (let i = 0; i < lines.length; i++) {
      const fm = fnRe.exec(lines[i]);
      if (!fm) continue;
      if (lineTouchesHunk(i + 1, hunks, isDeleted) || fileState !== "modified") {
        members.push({
          id: `${fm[1]}()`,
          name: fm[1],
          kind: "method",
          state: fileState === "added" ? "added" : fileState === "deleted" ? "deleted" : "modified",
        });
      }
    }
    units.push({
      id: file.path,
      name: stripExt(baseName(file.path)),
      kind: "module",
      state: fileState,
      file: file.path,
      container: folder,
      range: { start: 1, end: Math.max(1, lines.length) },
      lines: lines.length,
      methods: members.length,
      members: members.slice(0, 12),
      summary: null,
      cohesion: null,
      _imports: imports,
    });
  } else {
    // Attach all file imports to every unit in the file for dependency linking
    for (const u of units) u._imports = imports;
  }

  return { units, tables: [] };
}

/** Extracts SQL / Prisma tables and columns. */
function parseTables(file, text) {
  const tables = [];
  const fileState = stateFromStatus(file.status, file.isUntracked);

  if (PRISMA_EXT.test(file.path)) {
    const modelRe = /^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\s*\}/gm;
    let m;
    while ((m = modelRe.exec(text))) {
      const columns = [];
      for (const line of m[2].split(/\r?\n/)) {
        const cm = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+([A-Za-z0-9_?[\]]+)(.*)/.exec(line);
        if (!cm || cm[1].startsWith("@@")) continue;
        columns.push({
          name: cm[1],
          type: cm[2],
          state: fileState === "added" ? "added" : fileState === "deleted" ? "dropped" : "unchanged",
          isPrimaryKey: cm[3].includes("@id"),
        });
      }
      tables.push({
        id: m[1],
        state: fileState === "deleted" ? "dropped" : fileState === "added" ? "added" : "modified",
        source: file.path,
        columns: columns.slice(0, 16),
      });
    }
    return tables;
  }

  // SQL CREATE / ALTER / DROP TABLE
  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"\[]?([A-Za-z0-9_.\[\]"]+)[`"\]]?/gi;
  const alterRe = /ALTER\s+TABLE\s+[`"\[]?([A-Za-z0-9_.\[\]"]+)[`"\]]?/gi;
  const dropRe = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"\[]?([A-Za-z0-9_.\[\]"]+)[`"\]]?/gi;
  const seen = new Set();
  let m;
  while ((m = createRe.exec(text))) {
    const id = m[1].replace(/["`\[\]]/g, "");
    if (!seen.has(id)) { seen.add(id); tables.push({ id, state: "added", source: file.path, columns: [] }); }
  }
  while ((m = alterRe.exec(text))) {
    const id = m[1].replace(/["`\[\]]/g, "");
    if (!seen.has(id)) { seen.add(id); tables.push({ id, state: "modified", source: file.path, columns: [] }); }
  }
  while ((m = dropRe.exec(text))) {
    const id = m[1].replace(/["`\[\]]/g, "");
    if (!seen.has(id)) { seen.add(id); tables.push({ id, state: "dropped", source: file.path, columns: [] }); }
  }
  return tables;
}

function resolveRelativeImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const parts = folderOf(fromFile) === "." ? [] : folderOf(fromFile).split("/");
  for (const seg of spec.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return normPath(parts.join("/"));
}

function fileUnit(file, hunks) {
  const state = stateFromStatus(file.status, file.isUntracked);
  const delta = {
    added: file.added ?? (hunks ? hunks.reduce((s, h) => s + h.newCount, 0) : null),
    removed: file.removed ?? (hunks ? hunks.reduce((s, h) => s + h.oldCount, 0) : null),
  };
  return {
    id: file.path,
    name: baseName(file.path),
    kind: "file",
    state,
    file: file.path,
    container: folderOf(file.path),
    range: null,
    lines: null,
    added: delta.added,
    removed: delta.removed,
    methods: null,
    members: [],
    summary: null,
    cohesion: null,
    ce: 0,
    ca: 0,
  };
}

/**
 * Builds a complete ChangeModel statically from the collected Git diff.
 */
export async function analyzeStatic(repo, resolved, collection) {
  const units = [];
  const tables = [];
  const otherFiles = [];
  const relations = [];

  const parseCandidates = [];
  for (const file of collection.files) {
    const isCode = CS_EXT.test(file.path) || TS_EXT.test(file.path) || SQL_EXT.test(file.path) || PRISMA_EXT.test(file.path);
    if (isCode && parseCandidates.length < MAX_PARSE_FILES) {
      parseCandidates.push(file);
    } else {
      otherFiles.push({
        path: file.path,
        state: stateFromStatus(file.status, file.isUntracked),
        added: file.added,
        removed: file.removed,
      });
    }
  }

  // Read candidate file contents in parallel batches of 12
  const contents = new Map();
  for (let i = 0; i < parseCandidates.length; i += 12) {
    const batch = parseCandidates.slice(i, i + 12);
    await Promise.all(batch.map(async (f) => {
      const ref = f.status === "D" ? resolved.base : (resolved.includeWorktree ? null : resolved.head);
      const pathToRead = f.status === "D" && f.oldPath ? f.oldPath : f.path;
      const text = await readFileContent(repo, ref, pathToRead);
      if (text != null && text.length <= MAX_FILE_BYTES) contents.set(f.path, text);
    }));
  }

  for (const file of parseCandidates) {
    const hunks = collection.hunksByFile.get(file.path);
    const text = contents.get(file.path);
    if (text == null) {
      units.push(fileUnit(file, hunks));
      continue;
    }
    if (SQL_EXT.test(file.path) || PRISMA_EXT.test(file.path)) {
      const found = parseTables(file, text);
      if (found.length) tables.push(...found);
      else otherFiles.push({ path: file.path, state: stateFromStatus(file.status, file.isUntracked), added: file.added, removed: file.removed });
      continue;
    }
    if (CS_EXT.test(file.path)) {
      const res = parseCSharp(file, text, hunks);
      if (res.units.length) units.push(...res.units);
      else units.push(fileUnit(file, hunks));
      tables.push(...res.tables);
      continue;
    }
    if (TS_EXT.test(file.path)) {
      const res = parseTsJs(file, text, hunks);
      units.push(...res.units);
      continue;
    }
  }

  // If no code units at all (e.g. docs/config only commit), promote otherFiles to units so the graph is never blank
  if (!units.length && !tables.length && otherFiles.length) {
    for (const f of collection.files) {
      units.push(fileUnit(f, collection.hunksByFile.get(f.path)));
    }
    otherFiles.length = 0;
  }

  // Compute exact line deltas for every unit
  for (const u of units) {
    if (u.added === undefined || u.removed === undefined) {
      const hunks = collection.hunksByFile.get(u.file);
      const d = unitDelta(u, hunks);
      const fileEntry = collection.files.find((f) => f.path === u.file);
      u.added = d.added ?? fileEntry?.added ?? null;
      u.removed = d.removed ?? fileEntry?.removed ?? null;
    }
  }

  // Build lookup indexes to link relationships between discovered units
  const byName = new Map();
  const byFileNoExt = new Map();
  for (const u of units) {
    if (!byName.has(u.name)) byName.set(u.name, []);
    byName.get(u.name).push(u);
    const key = stripExt(u.file);
    if (!byFileNoExt.has(key)) byFileNoExt.set(key, []);
    byFileNoExt.get(key).push(u);
  }

  const relSeen = new Set();
  const addRel = (from, to, kind, state = "unchanged") => {
    if (!from || !to || from === to) return;
    const key = `${from}->${to}:${kind}`;
    if (relSeen.has(key)) return;
    relSeen.add(key);
    relations.push({ id: key, from, to, kind, state });
  };

  for (const u of units) {
    const relState = u.state === "added" ? "added" : u.state === "deleted" ? "removed" : "unchanged";

    // C# heritage & body references
    if (u._heritage) {
      for (const targetName of u._heritage) {
        const targets = byName.get(targetName) || [];
        for (const t of targets) {
          const kind = t.kind === "interface" ? "implementation" : "inheritance";
          addRel(u.id, t.id, kind, relState);
        }
      }
    }
    if (u._body) {
      for (const [otherName, targets] of byName) {
        if (otherName === u.name || otherName.length < 3) continue;
        const re = new RegExp(`\\b${otherName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (re.test(u._body)) {
          for (const t of targets) {
            if (relSeen.has(`${u.id}->${t.id}:inheritance`) || relSeen.has(`${u.id}->${t.id}:implementation`)) continue;
            addRel(u.id, t.id, "dependency", relState);
          }
        }
      }
    }

    // TS/JS heritage & relative imports
    if (u._tsHeritage) {
      for (const h of u._tsHeritage) {
        for (const t of byName.get(h.name) || []) addRel(u.id, t.id, h.kind, relState);
      }
    }
    if (u._imports) {
      for (const spec of u._imports) {
        const resolvedBase = resolveRelativeImport(u.file, spec);
        if (!resolvedBase) continue;
        const candidates = [
          stripExt(resolvedBase),
          `${stripExt(resolvedBase)}/index`,
        ];
        for (const c of candidates) {
          for (const t of byFileNoExt.get(c) || []) {
            if (t.file !== u.file) addRel(u.id, t.id, "dependency", relState);
          }
        }
      }
    }

    // Strip internal scratch properties
    delete u._body;
    delete u._heritage;
    delete u._imports;
    delete u._tsHeritage;
  }

  // Link tables to matching entity units by name
  for (const tbl of tables) {
    const clean = tbl.id.split(".").pop().toLowerCase();
    const singular = clean.endsWith("s") ? clean.slice(0, -1) : clean;
    const match = units.find((u) => {
      const n = u.name.toLowerCase();
      return n === clean || n === singular || n === `${singular}entity`;
    });
    if (match) {
      tbl.entity = match.id;
      addRel(match.id, `t:${tbl.id}`, "table-link", tbl.state === "added" ? "added" : tbl.state === "dropped" ? "removed" : "unchanged");
    }
  }

  computeCoupling(units, relations);

  return {
    source: "static",
    selection: resolved,
    units,
    relations,
    tables,
    otherFiles,
    skippedFiles: [],
    generatedAt: Date.now(),
    totalChangedFiles: collection.files.length,
  };
}
