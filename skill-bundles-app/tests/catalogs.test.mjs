// Test of `catalog:` in skills.yaml (a project names its Catalog), in temp repos.
// Run: node skill-bundles-app/tests/catalogs.test.mjs [path of link-skills.mjs]
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { formatManifest, withSkills, withSource, withoutSource } from "../mods/skill-bundles/manifest.js";

const script = process.argv[2] ?? fileURLToPath(new URL("../mods/skill-bundles/link-skills.mjs", import.meta.url));
const base = fs.mkdtempSync(join(os.tmpdir(), "sb-catalogs-"));
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const w = (p, t) => { fs.mkdirSync(join(p, ".."), { recursive: true }); fs.writeFileSync(p, t); };
const run = (input) => JSON.parse(execFileSync("node", [script, JSON.stringify(input)], { encoding: "utf8" }));
const fails_ = [];
const ok = (cond, label) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) fails_.push(label); };
const real = (p) => fs.realpathSync.native(p).toLowerCase();
const target = (p) => { try { return real(p); } catch { return null; } };

// 2 Catalogs with the same Bundle and the same skill name.
const catalog = (name) => {
  const dir = join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  w(join(dir, "bundles.yaml"), `repo: me/${name}\n\nbundles:\n  core:\n    skills:\n      - commit\n`);
  w(join(dir, "skills", "commit", "SKILL.md"), `---\nname: commit\n---\nof ${name}\n`);
  return dir;
};
const x = catalog("x");
const y = catalog("y");
const project = (name, manifest) => {
  const dir = join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  if (manifest !== null) w(join(dir, "skills.yaml"), manifest);
  return dir;
};
const linkOf = (proj) => target(join(proj, ".claude/skills/commit"));

// The parser: quotes, a comment, CRLF.
let p = project("parse", 'catalog: "me/y"   # the Catalog of this project\r\nbundles:\r\n  - core\r\n');
let r = run({ op: "read", project: p, clone: y });
ok(r.manifest.catalog === "me/y" && r.manifest.bundles.join() === "core", "catalog: is read with quotes, a comment and CRLF");
ok(r.catalogProblem === null && r.rows.find((s) => s.name === "commit")?.state === "missing", "the clone of that Catalog: no problem, the skill is Missing");

// No key: every clone is accepted (the Catalog of the caller).
p = project("plain", "bundles:\n  - core\n");
r = run({ op: "read", project: p, clone: x });
ok(r.manifest.catalog === null && r.catalogProblem === null, "no catalog: key gives no problem");

// The clone of another Catalog: read reports, apply refuses, nothing is linked.
p = project("other", "catalog: me/y\nbundles:\n  - core\n");
r = run({ op: "read", project: p, clone: x });
ok(r.catalogProblem?.code === "catalog_other" && r.catalogProblem.wanted === "me/y" && r.catalogProblem.have === "me/x", "another clone gives catalog_other");
ok(r.rows.length === 0, "nothing of the other clone is asked for");
let failed = spawnSync("node", [script, JSON.stringify({ op: "apply", project: p, clone: x, link: ["commit"] })], { encoding: "utf8" });
ok(failed.status !== 0 && /names the Catalog me\/y/.test(failed.stderr) && linkOf(p) === null, "apply refuses the other clone and makes no link");
r = run({ op: "read", project: p, clone: null });
ok(r.catalogProblem?.code === "catalog_other" && r.catalogProblem.have === null, "no clone gives catalog_other too");
run({ op: "apply", project: p, clone: y, link: ["commit"] });
ok(linkOf(p) === real(join(y, "skills", "commit")), "the clone of the Catalog links");

// A project that moves from the Catalog x to y: the same skill name must go to the new clone.
p = project("moved", "bundles:\n  - core\n");
run({ op: "apply", project: p, clone: x, link: ["commit"] });
ok(linkOf(p) === real(join(x, "skills", "commit")), "first linked to x");
w(join(p, "skills.yaml"), "catalog: me/y\nbundles:\n  - core\n");
r = run({ op: "read", project: p, clone: y });
ok(r.rows.find((s) => s.name === "commit")?.state === "missing", "after catalog: me/y, the link to x is not Linked");
run({ op: "apply", project: p, clone: y, link: ["commit"] });
ok(linkOf(p) === real(join(y, "skills", "commit")), "the link goes to y");
ok(fs.existsSync(join(x, "skills", "commit", "SKILL.md")), "the skill of x is still there");

// A text that is not a Catalog.
for (const bad of ["../x", "-x/y", "x", "a/b/c", "me/..", "me/x y"]) {
  p = project(`bad-${bad.replace(/\W+/g, "_")}`, `catalog: ${bad}\nbundles:\n  - core\n`);
  r = run({ op: "read", project: p, clone: x });
  ok(r.catalogProblem?.code === "catalog_invalid" && r.rows.length === 0, `catalog: ${bad} is invalid`);
}
p = project("url", "catalog: https://github.com/Me/Y.git\nbundles:\n  - core\n");
ok(run({ op: "read", project: p, clone: y }).catalogProblem === null, "a GitHub URL in another case names the Catalog");

// A fork: bundles.yaml says me/y, the caller found the clone as fork/y.
p = project("fork", "catalog: fork/y\nbundles:\n  - core\n");
ok(run({ op: "read", project: p, clone: y }).catalogProblem?.code === "catalog_other", "a fork name without catalogAs is another Catalog");
ok(run({ op: "read", project: p, clone: y, catalogAs: "fork/y" }).catalogProblem === null, "catalogAs names the clone of a fork");

// The terminal.
p = project("cli", "catalog: me/y\nbundles:\n  - core\n");
failed = spawnSync("node", [script, "--project", p, "--clone", x, "--sources", join(base, "sources")], { encoding: "utf8" });
ok(failed.status === 1 && /names the Catalog me\/y/.test(failed.stderr) && linkOf(p) === null, "the terminal refuses the clone of another Catalog");
const done = spawnSync("node", [script, "--project", p, "--clone", y, "--sources", join(base, "sources")], { encoding: "utf8" });
ok(done.status === 0 && linkOf(p) === real(join(y, "skills", "commit")), "the terminal links with the clone of the Catalog");

// The writers of the mod keep the key.
const parsed = (text) => { const d = project(`w-${Math.random().toString(36).slice(2)}`, text); return run({ op: "read", project: d, clone: y }).manifest; };
const start = { catalog: "me/y", bundles: ["core"], skills: [], sources: [] };
ok(formatManifest(start).startsWith("catalog: me/y\n\nbundles:\n"), "formatManifest writes catalog: first");
ok(!formatManifest({ ...start, catalog: null }).includes("catalog"), "formatManifest writes no catalog: without one");
for (const [label, m] of [["withSkills", withSkills(start, ["a"])], ["withSource", withSource(start, "o/r", ["b"])], ["withoutSource", withoutSource(withSkills(start, ["a"]), "a")]]) {
  ok(parsed(formatManifest(m)).catalog === "me/y", `${label} keeps catalog:`);
}

fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
console.log(fails_.length ? `\n${fails_.length} FAILED` : "\nall ok");
process.exit(fails_.length ? 1 : 0);
