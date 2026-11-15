// Test of link-skills.mjs in temp repos. Run: node skill-bundles-app/tests/links.test.mjs [path of link-skills.mjs]
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const script = process.argv[2] ?? fileURLToPath(new URL("../mods/skill-bundles/link-skills.mjs", import.meta.url));
const base = fs.mkdtempSync(join(os.tmpdir(), "sb-links-"));
const clone = join(base, "catalog");
const clone2 = join(base, "catalog-moved");
const proj = join(base, "proj");
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const w = (p, t) => { fs.mkdirSync(join(p, ".."), { recursive: true }); fs.writeFileSync(p, t); };
const run = (input) => JSON.parse(execFileSync("node", [script, JSON.stringify(input)], { encoding: "utf8" }));
let fails = 0;
const ok = (cond, label) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) fails++; };
const states = (r) => Object.fromEntries(r.rows.map((x) => [x.name, x.state]));
const isLink = (p) => fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;

// The clone.
fs.mkdirSync(clone, { recursive: true });
git(clone, "init", "-q");
w(join(clone, "bundles.yaml"), "repo: me/cat\n\nbundles:\n  core:\n    description: Every project.\n    skills:\n      - a\n      - b\n      - gone\n  extra-b:\n    skills:\n      - c\n");
for (const s of ["a", "b", "c", "d", "t"]) { w(join(clone, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n${s}\n`); w(join(clone, "skills", s, "SENTINEL.txt"), "keep me\n"); }

// The project: an npx-style install of a (unchanged) and b (edited), a tracked copy t, a local skill z, a foreign junction fj.
fs.mkdirSync(proj, { recursive: true });
git(proj, "init", "-q");
w(join(proj, "skills.yaml"), "bundles:\n  - core\n\nsources:\n  - repo: me/cat\n    skills:\n      - t\n  - repo: other/repo\n    skills:\n      - o\n");
w(join(proj, ".gitignore"), "node_modules/\n\n# Artefatos gerados por `npx skills add` (Install-Skills.ps1) — reproduzíveis a\n# partir de skills.yaml + bundles.yaml, não são fonte de verdade.\n.agents/\n.claude/skills/\n.codex/skills/\nskills-lock.json\n");
const hashV2 = (dir) => {
  const out = [];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`); else out.push({ path: Buffer.from(rel + e.name), content: fs.readFileSync(join(d, e.name)) }); } };
  walk(dir, "");
  out.sort((x, y) => Buffer.compare(x.path, y.path));
  const h = createHash("sha256");
  for (const f of out) { h.update(f.path); h.update("\0"); h.update(String(f.content.length)); h.update("\0"); h.update(f.content); }
  return h.digest("hex");
};
const lock = { version: 1, skills: {} };
for (const s of ["a", "b"]) {
  fs.cpSync(join(clone, "skills", s), join(proj, ".agents/skills", s), { recursive: true });
  fs.mkdirSync(join(proj, ".claude/skills"), { recursive: true });
  fs.symlinkSync(join(proj, ".agents/skills", s), join(proj, ".claude/skills", s), "junction");
  lock.skills[s] = { source: "me/cat", sourceType: "github", computedHash: hashV2(join(proj, ".agents/skills", s)) };
}
lock.skills.o = { source: "other/repo", sourceType: "github", computedHash: "x" };
w(join(proj, ".agents/skills/o/SKILL.md"), "other\n");
w(join(proj, ".agents/skills/b/SKILL.md"), "edited by hand\n");
w(join(proj, "skills-lock.json"), JSON.stringify(lock, null, 2));
w(join(proj, ".claude/skills/z/SKILL.md"), "local\n");
w(join(proj, ".claude/skills/t/SKILL.md"), "tracked copy\n");
git(proj, "add", "-f", ".claude/skills/t/SKILL.md");
fs.symlinkSync(join(clone, "skills", "d"), join(proj, ".claude/skills/fj"), "junction");

let r = run({ op: "read", project: proj, clone });
let s = states(r);
console.log(JSON.stringify(s));
ok(s.a === "copy" && s.b === "copy", "a and b are Copies");
ok(s.gone === "absent", "gone is not in the clone");
ok(s.t === "conflict", "a tracked folder is a Conflict");
ok(s.o === "unsupported", "another repository is not supported yet");
ok(s.z === "local" && s.fj === "local", "a hand-made folder and a foreign junction are Local");
ok(r.oldGitignore === true, "the old .gitignore block is seen");
ok(!fs.existsSync(join(proj, ".git/info/exclude")) || !fs.readFileSync(join(proj, ".git/info/exclude"), "utf8").includes("skill-bundles"), "read wrote nothing");

let d = run({ op: "apply", project: proj, clone, link: [], remove: [] });
console.log(JSON.stringify(d));
r = run({ op: "read", project: proj, clone }); s = states(r);
console.log(JSON.stringify(s));
ok(s.a === "linked" && s.b === "linked", "the Copies are links now");
ok(d.backedUp.includes("b") && !d.backedUp.includes("a"), "only the edited Copy went to the Backup");
ok(fs.readFileSync(join(proj, ".agents/skills-backup/b/SKILL.md"), "utf8") === "edited by hand\n", "the Backup has the edit");
ok(["a", "b"].every((n) => [".agents", ".claude", ".windsurf"].every((x) => isLink(join(proj, x, "skills", n)))), "3 links for each skill");
ok(fs.existsSync(join(clone, "skills/a/SENTINEL.txt")) && fs.existsSync(join(clone, "skills/b/SENTINEL.txt")), "the clone is whole");
ok(Object.keys(JSON.parse(fs.readFileSync(join(proj, "skills-lock.json"), "utf8")).skills).join() === "o", "the Lock keeps only the other repository");
ok(s.t === "conflict" && fs.readFileSync(join(proj, ".claude/skills/t/SKILL.md"), "utf8") === "tracked copy\n", "the tracked folder did not change");
ok(git(proj, "status", "--porcelain", "--", ".agents", ".claude", ".codex").trim() === "" || !/skills\/(a|b)\b/.test(git(proj, "status", "--porcelain", "-uall")), "Git does not see the links");

// Without the old .gitignore block, the exclude block alone must hide the links.
d = run({ op: "apply", project: proj, clone, dropGitignore: true });
const st = git(proj, "status", "--porcelain", "-uall");
ok(!fs.readFileSync(join(proj, ".gitignore"), "utf8").includes(".agents/") && fs.readFileSync(join(proj, ".gitignore"), "utf8").includes("node_modules/"), "the old block is gone, the rest stays");
ok(!/skills\/(a|b)\//.test(st) && !/skills-backup/.test(st), "the exclude block hides the links and the Backup");
ok(/\.claude\/skills\/z\//.test(st), "a Local skill shows in Git");

// Extra, stale, remove.
d = run({ op: "apply", project: proj, clone, link: ["c"], extra: ["c"] });
s = states(run({ op: "read", project: proj, clone }));
ok(s.c === "extra", "a linked skill out of the Manifest is Extra");
w(join(proj, "skills.yaml"), "bundles:\n  - core\n  - extra-b\n");
s = states(run({ op: "read", project: proj, clone }));
ok(s.c === "linked" && s.t === "local", "c is in a Bundle now; t left the Manifest and is Local");
run({ op: "apply", project: proj, clone });
w(join(proj, "skills.yaml"), "bundles:\n  - core\n");
s = states(run({ op: "read", project: proj, clone }));
ok(s.c === "stale", "a skill that left its Bundle is Stale");
d = run({ op: "apply", project: proj, clone, remove: ["c", "fj", "z"] });
s = states(run({ op: "read", project: proj, clone }));
ok(!("c" in s) && s.fj === "local" && s.z === "local", "remove takes only the links of the tool");
ok(fs.existsSync(join(clone, "skills/c/SENTINEL.txt")) && fs.existsSync(join(clone, "skills/d/SENTINEL.txt")), "the clone is whole after remove");

// A skill deleted from the clone: its links are Stale. A moved clone: Missing, then relinked.
fs.cpSync(clone, clone2, { recursive: true });
s = states(run({ op: "read", project: proj, clone: clone2 }));
ok(s.a === "missing" && s.b === "missing", "another clone path: the links are Missing");
d = run({ op: "apply", project: proj, clone: clone2, link: ["a", "b"] });
s = states(run({ op: "read", project: proj, clone: clone2 }));
ok(s.a === "linked" && s.b === "linked" && d.errors.length === 0, "the links point to the new clone");
ok(fs.existsSync(join(clone, "skills/a/SENTINEL.txt")), "the old clone is whole");

// Conflict → replace; Local → delete (a foreign junction must not delete its target).
w(join(proj, "skills.yaml"), "bundles:\n  - core\n\nsources:\n  - repo: me/cat\n    skills:\n      - t\n      - d\n");
s = states(run({ op: "read", project: proj, clone: clone2 }));
ok(s.t === "conflict" && s.d === "missing", "t is a Conflict again, d is Missing");
d = run({ op: "apply", project: proj, clone: clone2, replace: ["t"], deleteLocal: ["fj", "z"] });
s = states(run({ op: "read", project: proj, clone: clone2 }));
ok(s.t === "linked" && fs.existsSync(join(proj, ".agents/skills-backup/t/SKILL.md")), "replace moved t to the Backup and linked it");
ok(!("fj" in s) && !("z" in s) && fs.existsSync(join(clone, "skills/d/SENTINEL.txt")), "delete removed fj and z, and the target of fj is whole");

// A worktree shares the exclude block.
git(proj, "add", "skills.yaml"); git(proj, "-c", "user.name=t", "-c", "user.email=t@t.example", "commit", "-qm", "x");
const wt = join(base, "wt");
git(proj, "worktree", "add", "-q", wt);
s = states(run({ op: "read", project: wt, clone: clone2 }));
ok(s.a === "missing", "a new worktree has Missing skills");
run({ op: "apply", project: wt, clone: clone2, link: ["a", "b", "d"] });
s = states(run({ op: "read", project: wt, clone: clone2 }));
ok(s.a === "linked" && git(wt, "status", "--porcelain", "-uall").trim() === "", "the worktree is linked and clean for Git");
ok(states(run({ op: "read", project: proj, clone: clone2 })).a === "linked", "the main folder still has its links");

// The terminal use.
fs.copyFileSync(script, join(clone2, "link-skills.mjs"));
fs.rmSync(join(wt, ".claude/skills/a"));
const out = execFileSync("node", [join(clone2, "link-skills.mjs")], { cwd: wt, encoding: "utf8" });
console.log(out.trim());
ok(/Linked: a/.test(out), "the terminal run links a again");

// The skills: key of the Manifest (skills of the Catalog out of the Bundles), also as a list on one line.
w(join(proj, "skills.yaml"), "bundles: [core]\nskills:\n  - c\nother: 1\n  - not-a-skill\n");
r = run({ op: "read", project: proj, clone: clone2 });
ok(r.manifest.bundles.join() === "core" && r.manifest.skills.join() === "c" && states(r).c === "missing" && !("not-a-skill" in states(r)), "skills: asks for a skill of the Catalog");
// A list item without indent is valid YAML: it must not end the list.
w(join(proj, "skills.yaml"), "bundles:\n- core\n- extra-b\nskills:\n- t\n");
r = run({ op: "read", project: proj, clone: clone2 });
ok(r.manifest.bundles.join() === "core,extra-b" && r.manifest.skills.join() === "t", "list items without indent are read");
w(join(proj, "skills.yaml"), "bundles: [core]\nskills:\n  - c\n");
// A link of an older version in .codex/skills is removed by the next change, with its line of the block.
const ex = join(proj, ".git/info/exclude");
fs.mkdirSync(join(proj, ".codex/skills"), { recursive: true });
fs.symlinkSync(join(clone2, "skills", "a"), join(proj, ".codex/skills/a"), "junction");
fs.writeFileSync(ex, fs.readFileSync(ex, "utf8").replace("# <<< skill-bundles links", "/.codex/skills/a\n# <<< skill-bundles links"));
ok(run({ op: "read", project: proj, clone: clone2 }).retired === 1, "a link in .codex/skills counts as retired");
d = run({ op: "apply", project: proj, clone: clone2 });
ok(d.retired.join() === ".codex/skills/a" && !fs.existsSync(join(proj, ".codex")) && !fs.readFileSync(ex, "utf8").includes(".codex") && fs.existsSync(join(clone2, "skills/a/SENTINEL.txt")), "apply removes the retired link, the empty folder and the line; the clone is whole");

git(proj, "worktree", "remove", "--force", wt);
ok(fs.existsSync(join(clone2, "skills/a/SENTINEL.txt")), "removing the worktree keeps the clone");
fs.rmSync(base, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
