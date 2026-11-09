// The third-party mods that SETUP-PROMPT.md installs. This file has no imports:
// the mods-hub mod (in Herdr) and tools/record-third-party.mjs (in Node) both
// read it.
//
// repo: "owner/name" on GitHub. path: the mod folder in that repository; the
// update check asks GitHub for the last commit that changed this folder.
// ignore: files that the setup writes for this machine; they are not compared.

export const THIRD_PARTY = {
  "markdown-reader": { repo: "kissmikijr/herdr-markdown-reader", path: "mods/markdown-reader" },
  "markdown-reader-pane": { repo: "kissmikijr/herdr-markdown-reader", path: "mods/markdown-reader-pane" },
  insights: { repo: "GaganSD/coding-agent-toolkit", path: "herdr-insights/mods/insights", home: "herdr-insights", ignore: ["runtime.json"] },
};

/** The page of a third-party mod: its repository, or its folder for a mod inside a larger repository. */
export function thirdUrl(name) {
  const m = THIRD_PARTY[name];
  if (!m) return "";
  return m.home ? `https://github.com/${m.repo}/tree/main/${m.home}` : `https://github.com/${m.repo}`;
}

/** True for a file of mod `name` that is not compared (see `ignore`). */
export function thirdIgnored(name, path) {
  return (THIRD_PARTY[name]?.ignore ?? []).includes(String(path));
}
