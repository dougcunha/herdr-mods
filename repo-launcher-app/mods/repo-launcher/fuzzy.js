// Fuzzy matching for the repository list.
//
// A query matches a text when its characters appear in the text in the same
// order (a subsequence). The score prefers matches at the start of the text,
// at the start of a word, and in runs of consecutive characters, so "hm"
// ranks "herdr-mods" above "chrome".

const BOUNDARY = new Set([" ", "-", "_", ".", "/", "\\", ":", "@"]);

const SCORE_MATCH = 16;
const BONUS_FIRST = 24;
const BONUS_BOUNDARY = 14;
const BONUS_CAMEL = 10;
const BONUS_CONSECUTIVE = 12;
const PENALTY_GAP_START = 3;
const PENALTY_GAP = 1;

function isUpper(c) {
  return c >= "A" && c <= "Z";
}

function isLower(c) {
  return c >= "a" && c <= "z";
}

/** The bonus for a match at position `i` of `text`. */
function positionBonus(text, i) {
  if (i === 0) return BONUS_FIRST;
  const prev = text[i - 1];
  if (BOUNDARY.has(prev)) return BONUS_BOUNDARY;
  if (isUpper(text[i]) && isLower(prev)) return BONUS_CAMEL;
  return 0;
}

/**
 * Matches one token against a text.
 * Returns `{ score, indices }` (indices are positions in `text`), or null.
 *
 * The search finds the leftmost window that holds the whole token, then
 * walks back from its end to make the window as short as possible. This is
 * the fzf "v1" method: fast, and good enough for short names.
 */
export function matchToken(token, text) {
  if (!token) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  const q = token.toLowerCase();
  let best = null;

  // Try each start of the first character, so "rl" in "repo-launcher" can
  // pick the boundary "l" instead of the first "l" it sees.
  for (let start = t.indexOf(q[0]); start !== -1; start = t.indexOf(q[0], start + 1)) {
    let ti = start;
    let qi = 0;
    while (ti < t.length && qi < q.length) {
      if (t[ti] === q[qi]) qi++;
      ti++;
    }
    if (qi < q.length) break; // no later start can match either
    const end = ti - 1;

    // Walk back from the end to find the shortest window.
    let bi = end;
    qi = q.length - 1;
    const indices = [];
    while (bi >= start && qi >= 0) {
      if (t[bi] === q[qi]) {
        indices.push(bi);
        qi--;
      }
      bi--;
    }
    indices.reverse();

    let score = 0;
    let prev = -2;
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

/**
 * Matches a query (words separated by spaces) against a repository.
 * Every word must match the name or the path. A match in the name counts
 * more than a match in the path.
 * Returns `{ score, name: indices[], path: indices[] }`, or null.
 */
export function matchRepo(query, name, path) {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { score: 0, name: [], path: [] };
  let score = 0;
  const nameHits = new Set();
  const pathHits = new Set();
  for (const token of tokens) {
    const inName = matchToken(token, name);
    const inPath = matchToken(token, path);
    if (!inName && !inPath) return null;
    if (inName && (!inPath || inName.score * 2 >= inPath.score)) {
      score += inName.score * 2;
      inName.indices.forEach((i) => nameHits.add(i));
    } else {
      score += inPath.score;
      inPath.indices.forEach((i) => pathHits.add(i));
    }
  }
  // An exact name or a name that starts with the query wins.
  const q = query.trim().toLowerCase();
  const n = name.toLowerCase();
  if (n === q) score += 200;
  else if (n.startsWith(q)) score += 80;
  // Shorter names win ties.
  score -= name.length * 0.1;
  return {
    score,
    name: [...nameHits].sort((a, b) => a - b),
    path: [...pathHits].sort((a, b) => a - b),
  };
}

/**
 * Splits `text` into runs of matched and unmatched characters, for drawing.
 * Returns `[{ text, hit }]`.
 */
export function segments(text, indices) {
  if (!indices || indices.length === 0) return [{ text, hit: false }];
  const hits = new Set(indices);
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i], hit });
  }
  return out;
}
