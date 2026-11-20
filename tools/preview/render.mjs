#!/usr/bin/env node
// Renders <app>/preview.png for herdr.dev/gallery from <app>/preview.json.
//
//   node tools/preview/render.mjs             all apps that have a preview.json
//   node tools/preview/render.mjs dock-app    only these apps
//
// preview.json: { "name", "tagline", "kind": "mod" | "layout" | "themes",
//                 "source": "preview-src.png" (png or svg), "variant"?: "wide" | "tall" | "strip",
//                 "accent"?: "#rrggbb" }
// The output is 1920x1200 (16:10), the shape of a gallery card.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const template = readFileSync(join(here, "template.html"), "utf8");

function browser() {
  const candidates = [
    process.env.PREVIEW_BROWSER,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("No Chrome or Edge found. Set PREVIEW_BROWSER.");
  return found;
}

// PNG width and height from the IHDR chunk.
function pngSize(file) {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function pickVariant({ w, h }) {
  const r = w / h;
  if (r >= 6) return "strip";
  if (r >= 1.6) return "wide";
  return "tall";
}

function render(app, exe) {
  const dir = join(root, app);
  const spec = JSON.parse(readFileSync(join(dir, "preview.json"), "utf8"));
  const src = join(dir, spec.source || "preview-src.png");
  if (!existsSync(src)) throw new Error(`${app}: missing ${basename(src)}`);
  const svg = src.toLowerCase().endsWith(".svg");
  const variant = spec.variant || (svg ? "wide" : pickVariant(pngSize(src)));
  const shot = svg ? "shot.svg" : "shot.png";

  const work = mkdtempSync(join(tmpdir(), "herdr-preview-"));
  try {
    copyFileSync(src, join(work, shot));
    const data = {
      name: spec.name,
      tagline: spec.tagline,
      kind: spec.kind || "mod",
      image: shot,
      variant,
      accent: spec.accent || "",
    };
    const html = template.replace(/\/\*DATA\*\/[\s\S]*?\/\*END\*\//, `const DATA = ${JSON.stringify(data)};`);
    const page = join(work, "page.html");
    writeFileSync(page, html);
    const out = join(dir, "preview.png");
    const before = existsSync(out) ? readFileSync(out) : null;
    execFileSync(exe, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--window-size=1920,1200",
      "--virtual-time-budget=3000",
      `--user-data-dir=${join(work, "profile")}`,
      `--screenshot=${out}`,
      pathToFileURL(page).href,
    ], { stdio: "pipe" });
    // The browser can return before it writes the file (it hands the work to a process that
    // runs already). Wait for a new file: an old preview.png must not count as the result.
    for (let i = 0; i < 60 && (!existsSync(out) || (before && readFileSync(out).equals(before))); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (!existsSync(out) || (before && readFileSync(out).equals(before))) throw new Error(`${app}: the browser wrote no new preview.png`);
    const size = pngSize(out);
    console.log(`${app}: ${variant} -> preview.png ${size.w}x${size.h}`);
  } finally {
    // The browser can still hold its profile folder for a moment.
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
  }
}

const exe = browser();
const apps = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(root).filter((d) => d.endsWith("-app") && existsSync(join(root, d, "preview.json")));
for (const app of apps) render(app, exe);
