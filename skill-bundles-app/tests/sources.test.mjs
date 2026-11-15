// Test of link-skills.mjs with a Source of another repository. Run: node skill-bundles-app/tests/sources.test.mjs [path of link-skills.mjs]
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const script = process.argv[2] ?? fileURLToPath(new URL("../mods/skill-bundles/link-skills.mjs", import.meta.url));
const base = fs.mkdtempSync(join(os.tmpdir(), "sb-src-"));
const clone = join(base, "catalog");
const sourcesRoot = join(base, "sources");
const other = join(sourcesRoot, "other", "repo");
const proj = join(base, "proj");
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const w = (p, t) => { fs.mkdirSync(join(p, ".."), { recursive: true }); fs.writeFileSync(p, t); };
const run = (input) => JSON.parse(execFileSync("node", [script, JSON.stringify(input)], { encoding: "utf8" }));
let fails = 0;
const ok = (cond, label) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) fails++; };
const rowsOf = (r) => Object.fromEntries(r.rows.map((x) => [x.name, x]));
const base0 = { project: proj, clone, sourcesRoot };

fs.mkdirSync(clone, { recursive: true }); git(clone, "init", "-q");
w(join(clone, "bundles.yaml"), "repo: me/cat\n\nbundles:\n  core:\n    skills:\n      - a\n");
w(join(clone, "skills/a/SKILL.md"), "---\nname: a\n---\n");
fs.mkdirSync(proj, { recursive: true }); git(proj, "init", "-q");
w(join(proj, "skills.yaml"), "bundles:\n  - core\n\nsources:\n  - repo: Other/Repo\n    skills:\n      - o\n");
w(join(proj, ".agents/skills/q/SKILL.md"), "copy of q, edited\n");
w(join(proj, "skills-lock.json"), JSON.stringify({ version: 1, skills: { q: { source: "other/repo", sourceType: "github", computedHash: "x" } } }));

let r = rowsOf(run({ op: "read", ...base0 }));
ok(r.o.state === "unsupported" && r.q.state === "unsupported", "without a clone of the repository: not cloned");
const src = run({ op: "source", sourcesRoot, repo: "Other/Repo" });
ok(src.exists === false && src.url === "https://github.com/Other/Repo.git" && src.dir.replace(/\\/g, "/").endsWith("sources/other/repo"), "the place and the URL of the clone");

fs.mkdirSync(other, { recursive: true }); git(other, "init", "-q"); git(other, "remote", "add", "origin", "https://github.com/Other/Repo.git");
for (const s of ["o", "p", "q"]) { w(join(other, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: "The ${s} skill."\n---\n`); w(join(other, "skills", s, "SENTINEL.txt"), "keep\n"); }
ok(run({ op: "list", dir: other }).skills.map((x) => `${x.name}=${x.desc}`).join() === "o=The o skill.,p=The p skill.,q=The q skill.", "list gives the names and the descriptions");

r = rowsOf(run({ op: "read", ...base0 }));
ok(r.o.state === "missing" && r.q.state === "copy" && r.a.state === "missing", "with the clone: o is Missing, q is a Copy");
let d = run({ op: "apply", ...base0, link: ["a", "o"] });
r = rowsOf(run({ op: "read", ...base0 }));
ok(r.o.state === "linked" && r.a.state === "linked" && d.errors.length === 0, "o links to the clone of its repository");
ok(fs.realpathSync(join(proj, ".claude/skills/o")).toLowerCase() === fs.realpathSync(join(other, "skills/o")).toLowerCase(), "the link of o points into the source clone");
ok(r.q.state === "extra" && r.q.repo === "other/repo" && d.backedUp.includes("q"), "the Copy q is an Extra link of other/repo; its edit is in the Backup");
ok(!fs.existsSync(join(proj, "skills-lock.json")), "the Lock is gone");

d = run({ op: "apply", ...base0, link: ["p"], repos: { p: "other/repo" }, extra: ["p"] });
r = rowsOf(run({ op: "read", ...base0 }));
ok(r.p?.state === "extra" && r.p.repo === "other/repo", "a new skill of another repository is Extra, with its repository");
d = run({ op: "apply", ...base0, remove: ["p", "q"] });
r = rowsOf(run({ op: "read", ...base0 }));
ok(!r.p && !r.q && fs.existsSync(join(other, "skills/p/SENTINEL.txt")) && fs.existsSync(join(other, "skills/q/SENTINEL.txt")), "remove keeps the source clone whole");

w(join(proj, "skills.yaml"), "bundles:\n  - core\n");
r = rowsOf(run({ op: "read", ...base0 }));
ok(r.o.state === "stale", "a Source that left the Manifest is Stale");
// A repo: text that is an option of git or a path out of the cache is never cloned.
for (const bad of ["--upload-pack=x", "../x", "a/../../x", "-o/x", "a b/c"]) {
  const c = run({ op: "source", sourcesRoot, repo: bad });
  ok(c.dir === null && c.exists === false && Boolean(c.error), "rejected: " + bad);
}
w(join(proj, "skills.yaml"), "bundles:\n  - core\n\nsources:\n  - repo: --upload-pack=x\n    skills:\n      - z\n");
ok(rowsOf(run({ op: "read", ...base0 })).z.state === "unsupported", "a bad repo: stays Not cloned");
// Without a Catalog, a Source of another repository still links.
w(join(proj, "skills.yaml"), "bundles:\n  - core\n\nsources:\n  - repo: other/repo\n    skills:\n      - o\n      - p\n");
r = rowsOf(run({ op: "read", project: proj, clone: null, sourcesRoot }));
ok(r.o.state === "linked" && r.p.state === "missing", "without a Catalog: o is Linked, p is Missing");
ok(rowsOf(run({ op: "read", project: proj, clone: null, sourcesRoot: join(base, "none") })).p.state === "unsupported", "without a Catalog and without the clone: Not cloned");
// An Extra link into the Catalog clone is of the Catalog, also when its origin has another name.
git(clone, "remote", "add", "origin", "https://github.com/fork/other-name.git");
w(join(clone, "skills/x/SKILL.md"), "x\n");
run({ op: "apply", ...base0, link: ["x"], extra: ["x"] });
ok(rowsOf(run({ op: "read", ...base0 })).x.repo === "me/cat", "an Extra skill of the Catalog clone has the Catalog name");
fs.rmSync(base, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
