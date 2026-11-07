// Reads the HUD feed of TokenHound: %LOCALAPPDATA%\TokenHound\hud.json.
// The contract: https://github.com/dougcunha/TokenHound/blob/main/docs/HUD-FEED.md
//
// The file has the HUD content: the rings in HUD order, the rows of the hover card,
// and the busy state of each agent. TokenHound replaces the file after each HUD
// change, every `heartbeatSeconds`, and one last time at exit (isRunning = false).

import { home, readTextFile, window } from "herdr";

/** The highest schemaVersion that this mod can read. */
export const SCHEMA_VERSION = 1;

/** The folder of the feed. Mods get no environment variables, so the path comes from home(). */
export const feedDir = () => `${home().replace(/\\/g, "/")}/AppData/Local/TokenHound`;
export const feedPath = () => `${feedDir()}/hud.json`;

/** True when a watched path is the feed file (the watcher also reports temporary files). */
export const isFeedPath = (p) => /[\\/]hud\.json$/i.test(String(p || ""));

/**
 * Reads and parses the feed. Returns { doc, error }: doc is null when the file does not
 * exist; error is set when the file exists but is not valid JSON.
 */
export async function readFeed() {
  if (window()?.platform !== "windows") return { doc: null, error: null, unsupported: true };
  const text = await readTextFile(feedPath());
  if (text == null) return { doc: null, error: null };
  try {
    return { doc: JSON.parse(text), error: null };
  } catch (e) {
    return { doc: null, error: String(e) };
  }
}

/**
 * The state of the feed now:
 *   unsupported (not Windows), missing (no file), error (bad JSON), newer (a schema that
 *   this mod does not know), stopped (TokenHound exited), stale (no write for 3 heartbeats),
 *   live.
 */
export function feedState(result, now = Date.now()) {
  if (!result) return "loading";
  if (result.unsupported) return "unsupported";
  if (result.error) return "error";
  const doc = result.doc;
  if (!doc) return "missing";
  if (Number(doc.schemaVersion) > SCHEMA_VERSION) return "newer";
  if (doc.isRunning === false) return "stopped";
  const heartbeat = Math.max(5, Number(doc.heartbeatSeconds) || 30);
  const age = now - Date.parse(doc.writtenAtUtc);
  if (!Number.isFinite(age) || age > 3 * heartbeat * 1000) return "stale";
  return "live";
}

/** The providers to show: all of them, less the ids in the hidden list (comma or space separated). */
export function visibleProviders(doc, hiddenText) {
  const hidden = new Set(String(hiddenText || "").split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean));
  const list = Array.isArray(doc?.providers) ? doc.providers : [];
  return list.filter((p) => p && typeof p.providerId === "string" && !hidden.has(p.providerId.toLowerCase()));
}

/** A fraction as a whole percent, with the HUD rounding. */
export const percent = (f) => `${Math.round(Number(f) * 100)}%`;

/** True when the value is a number (a fraction can be null: TokenHound never invents a total). */
export const hasFraction = (f) => typeof f === "number" && Number.isFinite(f);

/** The HUD level colors: green below 50%, yellow below 80%, orange from 80%. */
export function levelColor(t, f) {
  if (!hasFraction(f)) return t.dim;
  if (f < 0.5) return "#10b981";
  if (f < 0.8) return "#eab308";
  return "#f97316";
}

/** The color of a status that is not ok, or null for ok. */
export function statusColor(t, status) {
  switch (status) {
    case "ok": return null;
    case "needsAuth":
    case "accessDenied":
    case "rateLimited": return t.ansi1;
    default: return t.ansi3;
  }
}
