// The API that other mods call: globalThis.powermods. A mod cannot import a file of another mod (Herdr
// refuses a path outside the mod folder), but all mods share globalThis. Herdr does not document this, so
// every caller checks `version` and `alive()` first (see core.js in each mod that uses the core).
//
// Every copy of the core puts the API again in init: a reload replaces the old functions.

import { create, remove, list, locate, pathFor, preview, alive, MISSING } from "./worktree.js";

export const VERSION = 1;

export function register() {
  globalThis.powermods = {
    version: VERSION,
    alive,
    missing: MISSING,
    worktree: { create, remove, list, locate, pathFor, preview },
  };
}
