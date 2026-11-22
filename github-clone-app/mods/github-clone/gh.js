// GitHub through the `gh` CLI of a machine: the account, its repositories,
// its organizations and the branches of a repository. The `gh auth login`
// session of that machine is used; the mod stores no credential.

import { exec } from "herdr";

/** Why a machine gave no list: "nogh" (no gh), "login" (not logged in), "offline", "error". */
export class GhError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

async function gh(on, args, timeout = 60000) {
  let r;
  try {
    r = await exec("gh", args, { on: on ?? undefined, timeout });
  } catch (e) {
    const text = String(e?.message ?? e);
    if (/timed? ?out/i.test(text)) throw new GhError("error", `gh did not answer in ${Math.round(timeout / 1000)} s`);
    if (on && /reach|connect|unavailable|offline/i.test(text)) throw new GhError("offline", `${on} cannot be reached now`);
    throw new GhError("nogh", `gh is not installed${on ? ` on ${on}` : ""}`);
  }
  if (r.code !== 0) {
    const text = String(r.stderr || r.stdout || "").trim();
    if (/gh auth login|not logged|authenticat|HTTP 401|bad credentials/i.test(text)) throw new GhError("login", `gh is not logged in${on ? ` on ${on}` : ""}`);
    throw new GhError("error", text.split(/\r?\n/).filter(Boolean).slice(0, 2).join(" ") || `gh exited with status ${r.code}`);
  }
  return r.stdout;
}

const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

const REPO_JQ = ".[] | {f: .full_name, o: .owner.login, n: .name, p: .private, k: .fork, a: .archived, d: .description, l: .language, u: .pushed_at, b: .default_branch}";

/** A repository as the mod keeps it. */
export function repoOf(x) {
  return {
    full: x.f,
    owner: x.o,
    name: x.n,
    private: Boolean(x.p),
    fork: Boolean(x.k),
    archived: Boolean(x.a),
    desc: x.d ?? "",
    lang: x.l ?? "",
    pushed: x.u ? Date.parse(x.u) || 0 : 0,
    branch: x.b ?? "",
  };
}

/**
 * The account of the machine, its repositories (owner, collaborator and
 * organization member) and its organizations.
 * Resolves with `{ login, repos, orgs }`. Rejects with a GhError.
 */
export async function fetchAccount(on) {
  const login = (await gh(on, ["api", "user", "--jq", ".login"], 30000)).trim();
  const [repoText, orgText] = await Promise.all([
    gh(on, ["api", "--paginate", "user/repos?per_page=100&affiliation=owner,collaborator,organization_member", "--jq", REPO_JQ], 300000),
    gh(on, ["api", "--paginate", "user/orgs?per_page=100", "--jq", ".[].login"], 60000).catch(() => ""),
  ]);
  const seen = new Set();
  const repos = [];
  for (const line of lines(repoText)) {
    try {
      const repo = repoOf(JSON.parse(line));
      if (!repo.full || seen.has(repo.full)) continue;
      seen.add(repo.full);
      repos.push(repo);
    } catch {}
  }
  return { login, repos, orgs: lines(orgText) };
}

const SEARCH_FIELDS = "fullName,owner,name,description,language,stargazersCount,updatedAt,isPrivate,isFork,isArchived,defaultBranch";

/**
 * The words of a search text as arguments for `gh search repos`: a quoted
 * phrase stays 1 argument (gh quotes it again), a qualifier such as
 * `stars:>100` or `-topic:x` stays as it is.
 */
export function queryArgs(text) {
  return (String(text ?? "").match(/"[^"]*"|\S+/g) ?? [])
    .map((t) => (t.length > 1 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t))
    .filter(Boolean);
}

/**
 * Searches the repositories of GitHub (`gh search repos`).
 * `sort`: "" (best match), "stars" or "updated". Resolves with repositories
 * (as repoOf() makes them, plus `stars`). Rejects with a GhError.
 */
export async function searchRepos(on, text, { sort = "", limit = 30 } = {}) {
  const args = ["search", "repos", "--limit", String(limit), "--json", SEARCH_FIELDS];
  if (sort) args.push("--sort", sort);
  // After "--", a word that starts with "-" (an excluded qualifier) is not a flag.
  args.push("--", ...queryArgs(text));
  const out = await gh(on, args, 60000);
  let list = [];
  try { list = JSON.parse(out || "[]"); } catch { throw new GhError("error", "gh gave a search result that is not JSON"); }
  return list.filter((x) => x?.fullName).map((x) => ({
    ...repoOf({
      f: x.fullName, o: x.owner?.login ?? x.fullName.split("/")[0], n: x.name, p: x.isPrivate, k: x.isFork, a: x.isArchived,
      d: x.description, l: x.language, u: x.updatedAt, b: x.defaultBranch,
    }),
    stars: Number(x.stargazersCount) || 0,
  }));
}

/** The first 100 branches of a repository. */
export async function fetchBranches(on, full) {
  return lines(await gh(on, ["api", `repos/${full}/branches?per_page=100`, "--jq", ".[].name"], 30000));
}
