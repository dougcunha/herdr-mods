// The icon of each provider: the same program icon that Herdr shows for the agent.
//
// Herdr's program table (knownAgents()) gives the icon path, `tint` (a one-color glyph that
// takes a text color) and `tile` / `color` (a colored tile for the glyph). The table below maps
// a TokenHound provider id to a program key, and holds a fallback for each key in case
// knownAgents() does not list it. A provider without an icon keeps its text badge.

import { knownAgents } from "herdr";

/** TokenHound provider id (or its prefix) -> Herdr program key. */
const PROGRAM_OF = [
  [/^claude(-|$)/i, "claude"],
  [/^codex$/i, "codex"],
  [/^copilot$/i, "copilot"],
  [/^cursor$/i, "cursor"],
  [/^(gemini|antigravity)$/i, "antigravity"],
  [/^opencode$/i, "opencode"],
  [/^grok$/i, "grok"],
];

/** The fallback when knownAgents() has no entry: the shipped icons of Herdr. */
const FALLBACK = {
  claude: { icon: "icons/claude.svg", tint: false, tile: null, color: null },
  codex: { icon: "icons/codex.svg", tint: false, tile: "#000000", color: null },
  copilot: { icon: "icons/copilot.svg", tint: true, tile: null, color: null },
  cursor: { icon: "icons/cursor.svg", tint: true, tile: null, color: null },
  antigravity: { icon: "icons/antigravity.svg", tint: false, tile: null, color: null },
  opencode: { icon: "icons/opencode.svg", tint: true, tile: null, color: null },
  grok: { icon: "icons/grok.svg", tint: true, tile: null, color: null },
};

/** The program keys that Herdr may use for the same agent. */
const ALIASES = { cursor: ["cursor", "cursor-agent"], antigravity: ["antigravity", "agy", "gemini"] };

/** Loads the program table of Herdr. Returns a map key -> program; empty on an error. */
export async function loadPrograms() {
  try {
    const list = await knownAgents();
    return new Map((list ?? []).filter((p) => p?.key && p.icon).map((p) => [p.key, p]));
  } catch {
    return new Map();
  }
}

/** The icon of a provider: { icon, tint, tile, color }, or null for the text badge. */
export function providerIcon(programs, providerId) {
  const key = PROGRAM_OF.find(([re]) => re.test(String(providerId || "")))?.[1];
  if (!key) return null;
  for (const k of ALIASES[key] ?? [key]) {
    const p = programs?.get(k);
    if (p?.icon) return { icon: p.icon, tint: p.tint === true, tile: p.tile ?? null, color: p.color ?? null };
  }
  return FALLBACK[key] ?? null;
}
