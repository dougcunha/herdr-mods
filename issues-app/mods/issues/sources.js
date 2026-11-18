// Where the issues of a space come from, in order; `from` says which: the space's link (or its
// repository's), the repository's .herdr/jira.toml, the default project (Link space or PowerMods),
// a guess from the branch, the GitHub repository.
// Used by the list (main.js) and by the Repository components dialog (components-dialog.js).

import { fileLinks, suggestKey } from "./jira.js";
import { knownSites, defaultJira } from "./links.js";
import * as github from "./github.js";

export const isGithub = (x) => x?.provider === "github";

// `c`: context(space) of links.js. Returns { from, projects }.
export async function projects(c) {
  const gh = c.github && { provider: "github", repo: c.github, site: github.SITE, key: c.github, filter: c.link.issuesFilter };
  if (c.link.issues === "github" && gh) return { from: "link", projects: [gh] };
  if (c.link.jira) return { from: "link", projects: [c.link.jira] };
  const fallback = defaultJira();
  if (!c.repo) return fallback ? { from: "default", projects: [fallback] } : { from: gh ? "repo" : null, projects: gh ? [gh] : [] };
  const file = await fileLinks(c.repo);
  if (file.length) return { from: "file", projects: file };
  if (fallback) return { from: "default", projects: [fallback] };
  const key = /\b([A-Z][A-Z0-9]{1,9})-\d+\b/.exec(c.space.branch ?? "")?.[1] || await suggestKey(c.repo).catch(() => "");
  const site = knownSites()[0];
  if (key && site) return { from: "guess", projects: [{ site, key }] };
  return gh ? { from: "repo", projects: [gh] } : { from: null, projects: [] };
}
