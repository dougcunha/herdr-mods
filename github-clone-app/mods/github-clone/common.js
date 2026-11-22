// Parts that the views of the dialog share (main.js, step.js, folders.js).

import { machines } from "herdr";

export const ROW_H = 54;
export const HEAD_H = 60;
export const FOOT_H = 38;

// Kept between openings of the dialog. `loading` and `probing`: the machines
// with a read in progress. `probes`: the folders of each machine (probeFolders()).
export const memory = { loading: {}, probing: {}, probes: {}, demo: false, launcherInstalled: false };

/** Waits `ms` in a task. */
export const wait = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));

/** The machines of the picker: this computer, then the other machines of Herdr. */
export function machineList() {
  const others = machines().filter((m) => m.name).map((m) => ({ name: m.name, label: m.name, disabled: m.layout === "unavailable" }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [{ name: null, label: "This computer", disabled: false }, ...others];
}

export const machineLabel = (machine) => (machine ? machine : "this computer");

/** True when Herdr cannot reach the machine now. */
export const offline = (machine) => Boolean(machine) && machines().find((m) => m.name === machine)?.layout === "unavailable";
