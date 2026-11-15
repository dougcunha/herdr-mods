// Test of the Catalog curation of link-skills.mjs. Run: node skill-bundles-app/tests/curate.test.mjs [path of link-skills.mjs]
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const script = process.argv[2] ?? fileURLToPath(new URL("../mods/skill-bundles/link-skills.mjs", import.meta.url));
const base = fs.mkdtempSync(join(os.tmpdir(), "sb-curate-"));
const clone = join(base, "catalog");
const w = (p, t) => { fs.mkdirSync(join(p, ".."), { recursive: true }); fs.writeFileSync(p, t); };
const run = (input) => JSON.parse(execFileSync("node", [script, JSON.stringify(input)], { encoding: "utf8" }));
let fails = 0;
const ok = (cond, label) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) fails++; };
const yaml = () => fs.readFileSync(join(clone, "bundles.yaml"), "utf8");
const bundles = () => Object.fromEntries(run({ op: "catalog", clone }).catalog.bundles);

const START = [
  "# The Catalog of the team.",
  "# Keep this header.",
  "",
  "repo: me/cat",
  "",
  "bundles:",
  "  core:",
  "    description: Every project.",
  "    skills:",
  "      - a",
  "      - b   ",
  "",
  "  # Web front ends.",
  "  web:",
  "    description: \"Web: front ends.\"",
  "    skills:",
  "      - c",
  "",
].join("\n");
w(join(clone, "bundles.yaml"), START);
for (const s of ["a", "b", "c", "d", "e"]) w(join(clone, "SKILLS", s, "SKILL.md"), `---\nname: ${s}\ndescription: The ${s} skill.\n---\n`);

let d = run({ op: "details", clone });
ok(d.orphans.join() === "d,e" && d.skills.find((s) => s.name === "a").bundles.join() === "core", "details: d and e have no Bundle");

d = run({ op: "curate", clone, assign: [{ skill: "d", bundle: "core" }, { skill: "d", bundle: "web" }, { skill: "a", bundle: "core" }] });
let b = bundles();
ok(b.core.join() === "a,b,d" && b.web.join() === "c,d" && d.changed.length === 2 && d.changed[0].action === "assign" && d.changed[0].bundle === "core" && !d.errors.length, "assign adds d to 2 Bundles; a skill that is there already is no change");
ok(yaml().startsWith("# The Catalog of the team.\n# Keep this header.\n") && yaml().includes("  # Web front ends.\n  web:") && yaml().includes("      - b   \n      - d\n"), "the comments and the other lines stay as they were");

d = run({ op: "curate", clone, createBundle: [{ name: "data", description: "Data: SQL and reports." }], assign: [{ skill: "e", bundle: "data" }] });
b = bundles();
ok(b.data.join() === "e" && yaml().includes('  data:\n    description: "Data: SQL and reports."\n    skills:\n      - e\n'), "a new Bundle with a skill, in one call");

d = run({ op: "curate", clone, unassign: [{ skill: "e", bundle: "data" }] });
ok(bundles().data.length === 0 && yaml().includes("    skills: []"), "a Bundle without skills has an empty list (not null)");
d = run({ op: "curate", clone, assign: [{ skill: "e", bundle: "data" }] });
ok(bundles().data.join() === "e" && !yaml().includes("skills: []"), "a skill goes into an empty Bundle");

d = run({ op: "curate", clone, assign: [{ skill: "zz", bundle: "core" }, { skill: "a", bundle: "nope" }], createBundle: [{ name: "Bad Name" }, { name: "web" }], deleteBundle: ["core"] });
ok(d.errors.length === 5 && d.changed.length === 0 && bundles().core.join() === "a,b,d", "bad names, a missing skill, a missing Bundle and core: errors, no change");

// A Bundle name is never a pattern: ".*" must not match core.
d = run({ op: "curate", clone, deleteBundle: [".*"], unassign: [{ skill: "a", bundle: ".*" }], assign: [{ skill: "e", bundle: "c.re" }] });
ok(d.changed.length === 0 && d.problems.map((p) => p.code).join() === "no_bundle,no_bundle" && bundles().core.join() === "a,b,d", "a pattern as a Bundle name changes nothing");
ok(d.problems.every((p) => p.code && p.name && p.text), "each problem has a code, a name and a text");
d = run({ op: "curate", clone, deleteBundle: ["web"] });
b = bundles();
ok(!("web" in b) && !yaml().includes("Web: front ends") && fs.existsSync(join(clone, "SKILLS/c/SKILL.md")) && "data" in b, "a deleted Bundle is gone; its skill folders stay");
ok(run({ op: "details", clone }).orphans.join() === "c", "c has no Bundle now");

d = run({ op: "curate", clone, deleteSkill: ["d", "c"] });
b = bundles();
ok(b.core.join() === "a,b" && !fs.existsSync(join(clone, "SKILLS/d")) && !fs.existsSync(join(clone, "SKILLS/c")) && fs.existsSync(join(clone, "SKILLS/a/SKILL.md")), "a deleted skill leaves every Bundle and its folder is gone");

// A list on one line is read, and a change makes it a block list.
w(join(clone, "bundles.yaml"), "repo: me/cat\nbundles:\n  core:\n    description: Core\n    skills: [a, b]\n  data:\n    description: Data\n    skills: []\n");
ok(bundles().core.join() === "a,b" && bundles().data.length === 0, "a list on one line is read");
d = run({ op: "curate", clone, assign: [{ skill: "e", bundle: "core" }], unassign: [{ skill: "a", bundle: "core" }] });
ok(bundles().core.join() === "b,e" && yaml().includes("    skills:\n      - b\n      - e\n") && !d.errors.length, "a change of a one-line list keeps its other skills");
// A skill folder that is a link out of the clone is never deleted.
const outside = join(base, "outside"); w(join(outside, "SKILL.md"), "x\n");
fs.symlinkSync(outside, join(clone, "SKILLS", "linked"), process.platform === "win32" ? "junction" : "dir");
d = run({ op: "curate", clone, deleteSkill: ["linked", "../outside"] });
ok(d.errors.length === 2 && fs.existsSync(join(outside, "SKILL.md")), "a linked skill folder and a path are refused");
const before = yaml();
d = run({ op: "curate", clone, dryRun: true, deleteBundle: ["data"] });
ok(d.changed.length === 1 && yaml() === before, "dryRun writes nothing");

// init: a first bundles.yaml in a clone that is not a Catalog yet.
const fresh = join(base, "fresh");
for (const s of ["one", "two"]) w(join(fresh, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n`);
const fail = (input) => { try { run(input); return null; } catch (e) { return String(e.stderr ?? e.message); } };
ok(/not a Catalog name/.test(fail({ op: "init", clone: fresh, repo: "../x" }) ?? ""), "init refuses a name that is not owner/name");
const made = run({ op: "init", clone: fresh, repo: "me/fresh" });
ok(made.skills.join() === "one,two" && fs.existsSync(join(fresh, "bundles.yaml")), "init writes bundles.yaml and lists the skills of the clone");
let fc = run({ op: "details", clone: fresh });
ok(fc.catalog.repo === "me/fresh" && fc.orphans.join() === "one,two" && JSON.stringify(fc.catalog.bundles) === '[["core",[]]]', "the new Catalog has an empty core, and every skill is without a Bundle");
ok(/is there already/.test(fail({ op: "init", clone: fresh, repo: "me/fresh" }) ?? ""), "init never replaces a bundles.yaml");
run({ op: "curate", clone: fresh, assign: [{ skill: "one", bundle: "core" }], createBundle: [{ name: "more", description: "More." }] });
run({ op: "curate", clone: fresh, assign: [{ skill: "two", bundle: "more" }] });
fc = run({ op: "details", clone: fresh });
ok(JSON.stringify(fc.catalog.bundles) === '[["core",["one"]],["more",["two"]]]' && fc.orphans.length === 0, "the curation fills the new Catalog");
ok(fs.readFileSync(join(fresh, "bundles.yaml"), "utf8").startsWith("# The skill Catalog"), "the header comment stays");

fs.rmSync(join(clone, "SKILLS", "linked"));
fs.rmSync(base, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
