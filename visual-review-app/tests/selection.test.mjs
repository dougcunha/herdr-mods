import assert from "node:assert/strict";
import { toggleCompareRange, compareToggleInfo, commitHighlights } from "../mods/visual-review/selection.js";

const c4 = "44444444dddd";
const c3 = "33333333cccc";
const c2 = "22222222bbbb";
const c1 = "11111111aaaa";
// Commits are newest-first, matching git log output
const commits = [
  { hash: c4, short: "4444444" },
  { hash: c3, short: "3333333" },
  { hash: c2, short: "2222222" },
  { hash: c1, short: "1111111" },
];

// ---- toggleCompareRange
{
  const cmp = { mode: "compare", from: c2, to: c4, label: "2222222 → 4444444" };
  const rng = toggleCompareRange(cmp, commits);
  assert.deepEqual(rng, {
    mode: "range",
    from: c2,
    to: c4,
    label: "2222222..4444444 (3)",
  });
  assert.deepEqual(toggleCompareRange(rng, commits), {
    mode: "compare",
    from: c2,
    to: c4,
    label: "2222222 → 4444444",
  });

  // Swapped compare (newer -> older) normalizes to chronological order when expanding to range
  const swapped = { mode: "compare", from: c4, to: c1 };
  assert.deepEqual(toggleCompareRange(swapped, commits), {
    mode: "range",
    from: c1,
    to: c4,
    label: "1111111..4444444 (4)",
  });

  // Fallback when commits aren't in the loaded list
  assert.deepEqual(toggleCompareRange({ mode: "compare", from: c1, to: c3 }, []), {
    mode: "range",
    from: c1,
    to: c3,
    label: "1111111..3333333 (inclusive)",
  });

  // Non-pair modes return null
  assert.equal(toggleCompareRange({ mode: "single", head: c1 }, commits), null);
  assert.equal(toggleCompareRange({ mode: "branch-base" }, commits), null);
  assert.equal(toggleCompareRange({ mode: "uncommitted" }, commits), null);
}

// ---- compareToggleInfo
{
  assert.deepEqual(compareToggleInfo({ mode: "compare", from: c2, to: c4 }, commits), {
    kind: "expand",
    label: "+ Include 2222222",
    tooltip: "Expand to inclusive commit range (includes changes made in 2222222)",
  });
  assert.deepEqual(compareToggleInfo({ mode: "compare", from: c4, to: c1 }, commits), {
    kind: "expand",
    label: "+ Include 1111111",
    tooltip: "Expand to inclusive commit range (includes changes made in 1111111)",
  });
  assert.deepEqual(compareToggleInfo({ mode: "range", from: c2, to: c4 }, commits), {
    kind: "narrow",
    label: "Diff only",
    tooltip: "Compare 2222222 → 4444444 directly (excludes changes made in 2222222)",
  });
  assert.equal(compareToggleInfo({ mode: "single", head: c1 }, commits), null);
  assert.equal(compareToggleInfo({ mode: "branch-base" }, commits), null);
}

// ---- commitHighlights
{
  const single = commitHighlights({ mode: "single", head: c2 }, commits);
  assert.deepEqual([...single.selected], [c2]);
  assert.equal(single.from, null);
  assert.equal(single.to, null);

  const compare = commitHighlights({ mode: "compare", from: c1, to: c3 }, commits);
  assert.deepEqual([...compare.selected], [c1, c3]);
  assert.equal(compare.from, c1);
  assert.equal(compare.to, c3);

  const range = commitHighlights({ mode: "range", from: c1, to: c3 }, commits);
  assert.deepEqual([...range.selected], [c3, c2, c1]);
  assert.equal(range.from, null);
  assert.equal(range.to, null);
}

console.log("visual-review selection ok");
