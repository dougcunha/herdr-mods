#!/usr/bin/env node
// Installs the CI Dash panel into the Herdr app's home folder.
//
//   node install.mjs [--dir <herdr-app home>] [--force] [--no-check]
//
// - mods/*           are copied over (they belong to this package).
// - layouts/main-ci  is copied only when absent, so your own edits survive.
//                    --force replaces it and keeps the old file as *.bak-<time>.
// - Every mod is validated with `herdr-app check` unless --no-check is given.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const home = resolve(option("--dir") || process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app"));
const force = flag("--force");

if (!existsSync(home)) {
  console.error(`Herdr app folder not found: ${home}\nStart the Herdr app once, or pass --dir <folder>.`);
  process.exit(1);
}

console.log(`Installing into ${home}`);

const mods = readdirSync(join(here, "mods"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
for (const name of mods) {
  mkdirSync(join(home, "mods", name), { recursive: true });
  cpSync(join(here, "mods", name), join(home, "mods", name), { recursive: true, force: true });
  console.log(`  mod     ${name}`);
}

const layoutSrc = join(here, "layouts", "main-ci.json");
const layoutDst = join(home, "layouts", "main-ci.json");
mkdirSync(join(home, "layouts"), { recursive: true });
if (!existsSync(layoutDst)) {
  copyFileSync(layoutSrc, layoutDst);
  console.log("  layout  main-ci (new)");
} else if (force) {
  renameSync(layoutDst, `${layoutDst}.bak-${Date.now()}`);
  copyFileSync(layoutSrc, layoutDst);
  console.log("  layout  main-ci (replaced, old file kept as .bak)");
} else {
  console.log("  layout  main-ci already exists, left unchanged (use --force to replace)");
}

let failed = false;
if (!flag("--no-check")) {
  for (const name of mods) {
    const r = spawnSync("herdr-app", ["check", join(home, "mods", name)], { encoding: "utf8", shell: process.platform === "win32" });
    if (r.error) { console.log(`  check   skipped: herdr-app not found on PATH`); break; }
    const ok = r.status === 0;
    failed ||= !ok;
    console.log(`  check   ${name}: ${ok ? "passed" : `FAILED\n${(r.stdout + r.stderr).trim()}`}`);
  }
}

console.log(`
Next steps:
  1. Switch to the layout:   herdr-app do layout.switch '{"name":"main-ci"}'
     (or press Ctrl+Shift+L until "main-ci" shows). Ctrl+Shift+L goes back to "main".
  2. Click the CI button in the tab bar to open the panel.
Requires the GitHub CLI logged in: gh auth login`);
process.exit(failed ? 1 : 0);
