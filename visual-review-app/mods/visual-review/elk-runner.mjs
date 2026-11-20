// Minimal Node.js bridge that runs elkjs on a JSON graph file and prints the laid-out graph to stdout.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ELK = require(join(__dirname, "vendor", "elk.bundled.js"));

const inputPath = process.argv[2];
if (!inputPath) {
  process.stderr.write("Usage: node elk-runner.mjs <graph.json>\n");
  process.exit(1);
}

const graph = JSON.parse(readFileSync(inputPath, "utf8").replace(/^\uFEFF/, ""));
const elk = new ELK();
const laidOut = await elk.layout(graph);
process.stdout.write(JSON.stringify(laidOut));
