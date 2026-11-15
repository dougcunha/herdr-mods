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
ok(b.core.join() === "a,b,d" && b.web.join() === "c,d" && d.changed.length === 2 && !d.errors.length, "assign adds d to 2 Bundles; a skill that is there already is no change");
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

d = run({ op: "curate", clone, deleteBundle: ["web"] });
b = bundles();
ok(!("web" in b) && !yaml().includes("Web: front ends") && fs.existsSync(join(clone, "SKILLS/c/SKILL.md")) && "data" in b, "a deleted Bundle is gone; its skill folders stay");
ok(run({ op: "details", clone }).orphans.join() === "c", "c has no Bundle now");

d = run({ op: "curate", clone, deleteSkill: ["d", "c"] });
b = bundles();
ok(b.core.join() === "a,b" && !fs.existsSync(join(clone, "SKILLS/d")) && !fs.existsSync(join(clone, "SKILLS/c")) && fs.existsSync(join(clone, "SKILLS/a/SKILL.md")), "a deleted skill leaves every Bundle and its folder is gone");

// A skill folder that is a link out of the clone is never deleted.
const outside = join(base, "outside"); w(join(outside, "SKILL.md"), "x\n");
fs.symlinkSync(outside, join(clone, "SKILLS", "linked"), process.platform === "win32" ? "junction" : "dir");
d = run({ op: "curate", clone, deleteSkill: ["linked", "../outside"] });
ok(d.errors.length === 2 && fs.existsSync(join(outside, "SKILL.md")), "a linked skill folder and a path are refused");
const before = yaml();
d = run({ op: "curate", clone, dryRun: true, deleteBundle: ["data"] });
ok(d.changed.length === 1 && yaml() === before, "dryRun writes nothing");

fs.rmSync(join(clone, "SKILLS", "linked"));
fs.rmSync(base, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
