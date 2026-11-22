// Example data for the preview image and for tests:
// `herdr-app do quick-actions.demo` shows it in an open dialog, a second run hides it.

import { normalize } from "./store.js";

const action = (id, name, icon, script, more = {}) => normalize({ id, name, icon, script, ...more });

export const DEMO = [
  action("demo-sync", "Sync the repository", "refresh", "git pull --ff-only"),
  action("demo-install", "Install the plugins", "package", "Set-Location {repo}\ngit submodule update --init --recursive\nnpm ci"),
  action("demo-dev", "Start the dev server", "play", "npm run dev", { where: "tab" }),
  action("demo-pr", "Open the pull request", "globe", "gh pr view --web", { filter: "herdr-mods, herdr-plugins" }),
  action("demo-clean", "Clean the build", "trash", "Remove-Item -Recurse -Force (Join-Path {repo} dist)", { confirm: true }),
  action("demo-notes", "Write the release notes", "sparkles", "", { source: "file", file: "~/scripts/release-notes.ps1", filter: "api-gateway" }),
];

export const DEMO_CTX = {
  target: { terminal: "t3", space: null, tab: null },
  machine: null,
  windows: true,
  folder: "D:/MyProjects/herdr-mods",
  busy: false,
  shell: "ps",
  values: { folder: "D:\\MyProjects\\herdr-mods", repo: "D:\\MyProjects\\herdr-mods", repo_name: "herdr-mods", home: "C:\\Users\\you", machine: "local" },
};
