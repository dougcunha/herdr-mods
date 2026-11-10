// The client of PowerMods Core (powermods-core-app). The core puts its API on globalThis.powermods: a mod
// cannot import a file of another mod. This file is the same in every mod that uses the core: the source is
// powermods-core-app/client/core.js, and `node tools/sync-core-client.mjs` copies it (--check compares).

const NEED = 1; // the API version that this file needs

const MISSING = "PowerMods Core is not running in this layout. Show the Main dock or the Kanban layout: their status row runs it. See https://github.com/dougcunha/herdr-mods/tree/main/powermods-core-app";

/** The API of the core, or an Error with a message for the person when the core is not running or too old. */
export function core() {
  const p = globalThis.powermods;
  if (!p || typeof p.alive !== "function" || !p.alive()) throw new Error(MISSING);
  if ((p.version ?? 0) < NEED) throw new Error("PowerMods Core is too old for this mod. Update the mods (PowerMods, Update mods).");
  return p;
}

/** The worktree service of the core (see core()). */
export const worktrees = () => core().worktree;

/** The worktree service, or null when the core is not running (for things that only show). */
export function maybeWorktrees() {
  try { return core().worktree; } catch { return null; }
}
