// Fuzzy matching for the filter of the Files panel (the method of repo-launcher/fuzzy.js).
//
// A query matches a text when its characters appear in the text in the same order (a
// subsequence). The score prefers matches at the start of the text, at the start of a word,
// and in runs of consecutive characters, so "rdm" ranks "README.md" above "src/readme-tools.md".

const BOUNDARY = new Set([" ", "-", "_", ".", "/", "\\", ":", "@"]);
const SCORE_MATCH = 16, BONUS_FIRST = 24, BONUS_BOUNDARY = 14, BONUS_CAMEL = 10, BONUS_CONSECUTIVE = 12;
const PENALTY_GAP_START = 3, PENALTY_GAP = 1;

const isUpper = c => c >= "A" && c <= "Z";
const isLower = c => c >= "a" && c <= "z";

function positionBonus(text, i) {
  if (i === 0) return BONUS_FIRST;
  const prev = text[i - 1];
  if (BOUNDARY.has(prev)) return BONUS_BOUNDARY;
  if (isUpper(text[i]) && isLower(prev)) return BONUS_CAMEL;
  return 0;
}

// Matches one token against a text (lower case in `lower`). Returns { score, indices } or null.
// The search tries each start of the first character and keeps the shortest, best window (fzf "v1").
function matchToken(q, text, lower) {
  let best = null;
  for (let start = lower.indexOf(q[0]); start !== -1; start = lower.indexOf(q[0], start + 1)) {
    let ti = start, qi = 0;
    while (ti < lower.length && qi < q.length) { if (lower[ti] === q[qi]) qi++; ti++; }
    if (qi < q.length) break; // no later start can match either
    const indices = [];
    for (let bi = ti - 1, k = q.length - 1; bi >= start && k >= 0; bi--) if (lower[bi] === q[k]) { indices.push(bi); k--; }
    indices.reverse();
    let score = 0, prev = -2;
    for (const i of indices) {
      score += SCORE_MATCH + positionBonus(text, i);
      if (i === prev + 1) score += BONUS_CONSECUTIVE;
      else if (prev >= 0) score -= PENALTY_GAP_START + PENALTY_GAP * (i - prev - 1);
      prev = i;
    }
    if (!best || score > best.score) best = { score, indices };
  }
  return best;
}

// Splits a query into lower-case words. Every word must match.
export const tokens = query => query.trim().toLowerCase().split(/\s+/).filter(Boolean);

// Matches the words against an entry { name, path, lowerName, lowerPath }. A match in the name
// counts twice; a word that is not in the name can match the folders of the path.
// Returns { score, name: indices[], path: indices[] } (path indices are in `path`), or null.
export function matchEntry(words, entry) {
  let score = 0;
  const nameHits = new Set(), pathHits = new Set();
  for (const q of words) {
    const inName = matchToken(q, entry.name, entry.lowerName);
    const inPath = inName && inName.score >= 0 ? null : matchToken(q, entry.path, entry.lowerPath);
    if (inName && (!inPath || inName.score * 2 >= inPath.score)) { score += inName.score * 2; inName.indices.forEach(i => nameHits.add(i)); }
    else if (inPath) { score += inPath.score; inPath.indices.forEach(i => pathHits.add(i)); }
    else return null;
  }
  const q = words.join(" ");
  if (entry.lowerName === q) score += 200;
  else if (entry.lowerName.startsWith(q)) score += 80;
  // Shorter and less deep paths win ties.
  score -= entry.path.length * 0.1;
  return { score, name: [...nameHits].sort((a, b) => a - b), path: [...pathHits].sort((a, b) => a - b) };
}

// Splits text into runs of matched and unmatched characters: [{ text, hit }].
export function segments(text, indices) {
  if (!indices?.length) return [{ text, hit: false }];
  const hits = new Set(indices), out = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i), last = out[out.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i], hit });
  }
  return out;
}
