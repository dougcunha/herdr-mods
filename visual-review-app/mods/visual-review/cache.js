// Disk cache for AI-enriched ChangeModels under ~/.config/herdr-app/data/visual-review/cache.
import * as fs from "fs/promises";
import { appHome } from "herdr";

const cacheDir = () => `${appHome().replace(/\\/g, "/")}/data/visual-review/cache`;

function hashKey(str) {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Returns a cache key for immutable commit selections, or null for worktree selections. */
export function cacheKeyFor(repo, resolved, aiInfo) {
  if (!repo || !resolved || resolved.includeWorktree || !resolved.head) return null;
  const raw = [
    repo.root,
    repo.on ?? "",
    resolved.base,
    resolved.head,
    aiInfo?.provider ?? "auto",
    aiInfo?.model ?? "",
  ].join("|");
  return hashKey(raw);
}

export async function readCache(key) {
  if (!key) return null;
  try {
    const raw = await fs.readFile(`${cacheDir()}/${key}.json`, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.units)) return parsed;
  } catch { /* cache miss */ }
  return null;
}

export async function writeCache(key, model) {
  if (!key || !model) return;
  try {
    const dir = cacheDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/${key}.json`, JSON.stringify(model));
  } catch { /* non-fatal */ }
}

export async function cacheStats() {
  const dir = cacheDir();
  try {
    const entries = await fs.readdir(dir);
    const jsonFiles = entries.filter((f) => f.endsWith(".json"));
    let bytes = 0;
    for (const f of jsonFiles) {
      try {
        const text = await fs.readFile(`${dir}/${f}`, "utf8");
        bytes += text.length;
      } catch {}
    }
    return { count: jsonFiles.length, bytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

export async function clearCache() {
  const dir = cacheDir();
  let removed = 0;
  try {
    const entries = await fs.readdir(dir);
    for (const f of entries) {
      if (!f.endsWith(".json")) continue;
      try {
        await fs.unlink(`${dir}/${f}`);
        removed++;
      } catch {}
    }
  } catch { /* directory may not exist */ }
  return { removed };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
