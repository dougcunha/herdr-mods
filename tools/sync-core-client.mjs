// Copies the client of PowerMods Core (powermods-core-app/client/core.js) into every mod that uses the core.
// `--check`: copies nothing, and exits with 1 when a copy differs from the source.
//
//   node tools/sync-core-client.mjs [--check]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "powermods-core-app/client/core.js";
const TARGETS = [
  "issues-app/mods/issues/core.js",
  "issues-app/mods/prs/core.js",
  "spec-board-app/mods/spec-board/core.js",
  "git-client-app/mods/git-client/core.js",
  "git-dash-app/mods/git-dash/core.js",
];

const check = process.argv.includes("--check");
const text = readFileSync(join(root, SOURCE), "utf8");
let bad = 0;
for (const t of TARGETS) {
  const file = join(root, t);
  let now = null;
  try { now = readFileSync(file, "utf8"); } catch { /* missing */ }
  if (now === text) continue;
  if (check) { console.log(`differs: ${t}`); bad++; continue; }
  writeFileSync(file, text);
  console.log(`copied: ${t}`);
}
if (check && bad) process.exit(1);
if (check) console.log("All copies match.");
