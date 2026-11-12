// The sounds of the animation styles. A style can bring its own attention sounds
// ("blocked": an agent needs you, "done": an agent finished while you were not
// looking). When the person picks a style, the cards write them into
// settings.json (`sounds.blocked`, `sounds.done`), so Herdr plays them. A style
// without a sound gives the slot back to Herdr's own sound.

import { appHome, readTextFile, writeTextFile, shared, setShared } from "herdr";

// The files are relative to ~/.config/herdr-app, as settings.json takes them.
const DIR = "mods/agent-cards/sounds/";
export const STYLE_SOUNDS = {
  sheep: { blocked: `${DIR}sheep-blocked.mp3` }, // a quavering "me-he-he" bleat
};
const SLOTS = ["blocked", "done"];

// The style and the files that are in settings.json now ("sheep blocked=…"). Shared, so all
// copies and restarts agree. With the files in it, a new sound of a style is written too.
const KEY_APPLIED = "agent-cards.soundStyle";
const signature = (style) => [style, ...SLOTS.map((s) => `${s}=${STYLE_SOUNDS[style]?.[s] ?? ""}`)].join(" ");

// A path that a style of this mod wrote: only these are taken out again.
const fromStyle = (path) => typeof path === "string" && path.replace(/\\/g, "/").includes(DIR);

/** Puts the sounds of `style` into settings.json, if the style changed since the last time.
 *  A sound that the person chose (not a file of this mod) is replaced only by a style that
 *  has its own sound for that slot, and never taken out. */
export async function syncStyleSounds(style) {
  const applied = shared(KEY_APPLIED), sig = signature(style);
  if (applied === sig) return;
  // No style picked and none applied yet: nothing to do. This is also how `herdr-app check`
  // runs the mod (empty shared state), so a check never writes the person's settings.json.
  if (applied === undefined && shared("agent-cards.animation") === undefined) return;
  const file = `${appHome()}/settings.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await readTextFile(file);
    let settings;
    try { settings = raw ? JSON.parse(raw) : {}; } catch { return; } // a broken file: leave it to the person
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return;
    const sounds = settings.sounds && typeof settings.sounds === "object" ? { ...settings.sounds } : {};
    const own = STYLE_SOUNDS[style] ?? {};
    let changed = false;
    for (const slot of SLOTS) {
      if (own[slot]) {
        if (sounds[slot] !== own[slot]) { sounds[slot] = own[slot]; changed = true; }
      } else if (fromStyle(sounds[slot])) {
        delete sounds[slot];
        changed = true;
      }
    }
    if (!changed) { setShared(KEY_APPLIED, sig); return; }
    settings.sounds = sounds;
    try {
      await writeTextFile(file, JSON.stringify(settings, null, 2) + "\n", raw);
      setShared(KEY_APPLIED, sig);
      return;
    } catch {} // settings.json changed in the meantime: read it again
  }
}
