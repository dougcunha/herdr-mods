// The fields of the Settings tab. Each kit mod describes its settings in the
// `settings` list of its kit.json. A field reads and writes 1 shared() key, or
// 1 property of the object in that key (`path`). The `key` type writes
// keys.json instead (see keys.js), and `action` runs a Herdr command.
//
// Field: { id, type, label, hint?, key?, path?, default?, ... }
//   bool        values?: [on, off] when the key holds other values than true/false
//   enum        options: [{ value, label }]; a value of null or "" removes the key
//   number      min, max, step, scale? (shown = stored / scale), unit?
//   text        placeholder?
//   folder-list (an array of folders with forward slashes)
//   key         action: the keys.json action ("mod.open:mods-hub")
//   action      command, args?, button: the text of the button

import { shared, setShared } from "herdr";

export const TYPES = ["bool", "enum", "number", "text", "folder-list", "key", "action"];

/** The valid fields of a `settings` list. Unknown types and fields without a key are left out. */
export function cleanFields(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((f) => f && typeof f === "object" && TYPES.includes(f.type) && typeof f.label === "string"
    && (f.type === "key" ? typeof f.action === "string"
      : f.type === "action" ? typeof f.command === "string"
      : typeof f.key === "string" && f.key));
}

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

/** The stored value of a field, or undefined. */
function stored(f) {
  const v = shared(f.key);
  if (!f.path) return v;
  return isObject(v) ? v[f.path] : undefined;
}

/** The value that the field shows: the stored value, else its default. */
export function readField(f) {
  const v = stored(f);
  switch (f.type) {
    case "bool":
      if (Array.isArray(f.values)) return v === f.values[0] ? true : v === f.values[1] ? false : f.default === true;
      return typeof v === "boolean" ? v : f.default === true;
    case "enum":
      return (f.options ?? []).some((o) => o.value === v) ? v : (f.default ?? null);
    case "number": {
      const n = Number(v);
      return v != null && Number.isFinite(n) ? n : (f.default ?? 0);
    }
    case "text":
      return typeof v === "string" ? v : (f.default ?? "");
    case "folder-list":
      return Array.isArray(v) ? v.filter((p) => typeof p === "string") : [];
    default:
      return v;
  }
}

/**
 * Writes the value of a field. Null or "" removes the key (or the property).
 * A property write merges into the object that is there, so its other
 * properties stay.
 */
export function writeField(f, value) {
  let v = value;
  if (f.type === "bool" && Array.isArray(f.values)) v = value ? f.values[0] : f.values[1];
  if (f.type === "number") {
    v = Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, Number(value)));
  }
  const unset = v === null || v === undefined || v === "";
  if (!f.path) {
    setShared(f.key, unset ? null : v);
    return;
  }
  const cur = shared(f.key);
  const obj = isObject(cur) ? { ...cur } : {};
  if (unset) delete obj[f.path];
  else obj[f.path] = v;
  setShared(f.key, obj);
}

/** Folders in one form, to compare them. */
export const sameFolder = (p) => String(p || "").replace(/\\/g, "/").replace(/([^:/])\/+$/, "$1").toLowerCase();
/** A folder as it is saved: forward slashes, no trailing slash (a drive root keeps it). */
export const normFolder = (p) => String(p || "").trim().replace(/\\/g, "/").replace(/([^:/])\/+$/, "$1");
