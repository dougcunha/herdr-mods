// The hash of a mod file, for the "local changes" check of the Mods tab.
//
// The setup prompt runs tools/record-hashes.mjs with Node on the clone of the
// repository and writes the hashes to data/herdr-mods-setup.json. The mods-hub
// imports this same file in Herdr and hashes the installed files. Both sides
// must give the same result, so this file has no imports and uses only plain
// JavaScript.

/** Files that Herdr writes into a mod folder by itself. They are never compared. */
export function ignoredFile(path) {
  const name = String(path).split("/").pop();
  return name === "gpui-kit.d.ts" || name === "jsconfig.json" || name.startsWith(".") || name.endsWith(".error");
}

/** Files that are not text. The check skips them, because a text read can change their bytes. */
export function binaryFile(path) {
  return /\.(png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|otf|zip|gz)$/i.test(String(path));
}

/**
 * The hash of the text of a file: 14 hex digits (cyrb53, a 53-bit hash).
 * A byte order mark at the start and the difference between CRLF and LF do
 * not change the result.
 */
export function hashText(text) {
  const s = String(text ?? "").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, "0");
}
