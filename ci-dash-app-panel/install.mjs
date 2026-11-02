#!/usr/bin/env node
// Installs the CI Dash panel into the Herdr app's home folder.
//
//   node install.mjs [--dir <herdr-app home>] [--force] [--no-check]
//
// - mods/ci-dash     comes from the sibling ../ci-dash-app folder (the mod itself).
// - mods/image-viewer comes from the sibling ../image-viewer-app folder (images opened from Files).
// - mods/*           of this folder (tabs-ci, files-md) are copied over as well.
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

const sources = [join(here, "..", "ci-dash-app", "mods"), join(here, "..", "image-viewer-app", "mods"), join(here, "mods")];
const found = new Map(); // mod name -> source folder
for (const root of sources) {
  if (!existsSync(root)) continue;
  for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) found.set(entry.name, join(root, entry.name));
}
if (!found.has("ci-dash")) {
  console.error("The ci-dash mod was not found. Run this script from a checkout that has the ci-dash-app folder next to ci-dash-app-panel.");
  process.exit(1);
}
const mods = [...found.keys()];
for (const [name, from] of found) {
  mkdirSync(join(home, "mods", name), { recursive: true });
  cpSync(from, join(home, "mods", name), { recursive: true, force: true });
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
if (!existsSync(join(home, "mods", "image-viewer"))) {
  console.log(`
Note: the Files panel (files-md) opens images in the image-viewer mod, which was not found.
Run this script from a checkout that has the image-viewer-app folder next to ci-dash-app-panel.`);
}
if (!existsSync(join(home, "mods", "markdown-reader"))) {
  console.log(`
Note: the Files panel (files-md) opens Markdown files in the markdown-reader mod,
which is not installed here. Until it is, clicking a .md file in Files will not open a reader.
Install it from https://github.com/kissmikijr/herdr-markdown-reader (folders mods/markdown-reader
and mods/markdown-reader-pane).`);
}
process.exit(failed ? 1 : 0);
