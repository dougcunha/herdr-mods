// Jira Cloud: projects named in a repository, the sign-in, and the REST calls.
// Read only, with five exceptions that the person makes on an issue page: a comment, a move (transition),
// Assign to me, a new story points value, and the Fix versions and the components.

import { exec, readTextFile } from "herdr";
import { call, cleanSite, validSite } from "./jira-client.js";
import { componentJql } from "./components.js";

const CAP = 500;
const FIELDS = ["summary", "status", "priority", "issuetype", "assignee", "reporter", "labels", "parent", "updated", "issuelinks"];

// ---- Projects named in a repository ------------------------------------------

// `.herdr/jira.toml` in the main checkout: one or more
//   [[project]]
//   site = "example.atlassian.net"
//   key = "PROJ"
//   filter = "sprint in openSprints()"   # optional JQL, only narrows
function parseToml(text) {
  const projects = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[project]]") { current = {}; projects.push(current); continue; }
    const m = /^([A-Za-z_]+)\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(line);
    if (m && current) current[m[1]] = m[2].replace(/\\(.)/g, "$1");
  }
  // A repository can name any host here; the client only sends a sign-in to Atlassian hosts or ones the person typed in Link space.
  return projects.filter((p) => p.site && p.key).map((p) => ({ ...p, site: cleanSite(p.site) })).filter((p) => validSite(p.site) && /^[A-Z][A-Z0-9_]+$/.test(p.key));
}

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on });
  return r.code === 0 ? r.stdout.trim() : null;
}

// A committed `.herdr/jira.toml` names the projects for everyone who clones the repository.
export async function fileLinks(repo) {
  const text = await readTextFile(`${repo.main}/.herdr/jira.toml`, { on: repo.on }).catch(() => null);
  return text ? parseToml(text) : [];
}

// The key found most often in recent branch names and commit subjects (PROJ-123).
export async function suggestKey(repo) {
  const text = [
    await git(repo.main, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], repo.on),
    await git(repo.main, ["log", "-300", "--format=%s"], repo.on),
  ].join("\n");
  const counts = new Map();
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{1,9})-\d+\b/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

// ---- REST (sign-in and the client: jira-client.js) ----------------------------

export { myself } from "./jira-client.js";

// The fields of a site (id and name, custom ones too), read once per site and kept for the session.
const fieldLists = new Map();
function fieldList(site) {
  if (!fieldLists.has(site)) fieldLists.set(site, call(site, "/rest/api/3/field").catch((e) => { fieldLists.delete(site); throw e; }));
  return fieldLists.get(site);
}
// The extra fields that the person named (prompts.js extraFieldNames), found by id or by name
// (case does not matter): [{ id, name, wanted }] in the order given. A name the site doesn't have is left out.
export async function extraFields(site, wanted) {
  if (!wanted.length) return [];
  const all = await fieldList(site);
  return wanted.map((w) => {
    const f = all.find((x) => x.id === w) ?? all.find((x) => String(x.name ?? "").toLowerCase() === w.toLowerCase());
    return f ? { id: f.id, name: f.name, wanted: w } : null;
  }).filter(Boolean);
}

// The custom fields that every page shows, found in the site's field list (their ids differ per
// site): the Sprint field (Jira Software) and the story points ("Story Points", "Story point estimate").
export async function metaFields(site) {
  const all = await fieldList(site);
  const sprint = all.find((f) => f.schema?.custom === "com.pyxis.greenhopper.jira:gh-sprint") ?? all.find((f) => /^sprint$/i.test(String(f.name ?? "")));
  const points = all.filter((f) => /^story ?points?( estimate)?$|^story point estimate$/i.test(String(f.name ?? "").trim())).map((f) => f.id);
  return { sprint: sprint?.id ?? null, points };
}
// The sprint of a Sprint value (a list of sprints; an old site sends strings "…[name=X,state=ACTIVE,…]"):
// the active one, else the next one, else the last.
// { name, state: "active" | "future" | "closed", id, board, start } (id, board and start: null when Jira sends none).
export function sprintOf(v) {
  const list = (Array.isArray(v) ? v : v ? [v] : []).map((s) => {
    if (s && typeof s === "object") return { name: String(s.name ?? ""), state: String(s.state ?? "").toLowerCase(), id: s.id ?? null, board: s.boardId ?? null, start: s.startDate ?? null };
    const part = (name) => { const x = new RegExp(`${name}=([^,\\]]*)`).exec(String(s))?.[1]; return x && x !== "<null>" ? x : null; };
    const name = part("name");
    return name ? { name, state: (part("state") ?? "").toLowerCase(), id: Number(part("id")) || null, board: Number(part("rapidViewId")) || null, start: part("startDate") } : null;
  }).filter((s) => s?.name);
  return list.find((s) => s.state === "active") ?? list.find((s) => s.state === "future") ?? list.at(-1) ?? null;
}

// With its sub-tasks and history (status, assignee and priority changes become timeline events).
// `extra`: ids of more fields to read (custom fields for the prompts and the page); they come back in page.fields.
export async function issue(site, key, extra = []) {
  const ids = [...new Set(extra)].filter((id) => /^[A-Za-z0-9_.-]+$/.test(id));
  // The `comment` field of the issue has no `parentId`: only the comment endpoint says which comment
  // replies to which. Read the newest 100 there (oldest first); if that fails, keep the embedded list.
  const threaded = call(site, `/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=-created&maxResults=100`).then((r) => (Array.isArray(r?.comments) ? r.comments.reverse() : null), () => null);
  const page = await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,priority,issuetype,assignee,reporter,labels,parent,comment,created,updated,subtasks,issuelinks,fixVersions,versions,components,duedate,resolution,attachment${ids.map((id) => `,${id}`).join("")}&expand=changelog`);
  const comments = await threaded;
  if (comments) page.fields.comment = { ...page.fields.comment, comments };
  // The people that the page shows, with their pictures (links.js loadPeople).
  const people = new Map();
  const seen = (u) => { if (u?.displayName && !people.has(u.displayName)) people.set(u.displayName, { name: u.displayName, id: u.accountId ?? "", url: u.avatarUrls?.["48x48"] ?? "" }); };
  seen(page.fields.assignee); seen(page.fields.reporter);
  for (const c of page.fields.comment?.comments ?? []) seen(c.author);
  for (const h of page.changelog?.histories ?? []) seen(h.author);
  page.people = [...people.values()];
  const events = [];
  for (const h of page.changelog?.histories ?? []) for (const it of h.items ?? []) {
    const who = h.author?.displayName, at = h.created;
    if (it.field === "status") events.push({ who, at, text: `moved this from ${it.fromString} to ${it.toString}`, color: "accent" });
    else if (it.field === "assignee") events.push({ who, at, text: it.toString ? `assigned ${it.toString}` : "removed the assignee" });
    else if (it.field === "priority") events.push({ who, at, text: `set the priority to ${it.toString}` });
  }
  page.events = events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-20);
  page.sub = (page.fields.subtasks ?? []).map((s) => ({ key: s.key, summary: s.fields?.summary ?? "", done: s.fields?.status?.statusCategory?.key === "done" }));
  // Issue links: "blocks", "is blocked by", "relates to", … with the other issue's state.
  page.relations = (page.fields.issuelinks ?? []).map((l) => {
    const other = l.outwardIssue ?? l.inwardIssue, label = l.outwardIssue ? l.type?.outward : l.type?.inward;
    return other ? { label: label ?? "relates to", key: other.key, summary: other.fields?.summary ?? "", done: other.fields?.status?.statusCategory?.key === "done" } : null;
  }).filter(Boolean);
  // The files of the issue (attachments.js downloads them): only what the page shows.
  page.attachments = (page.fields.attachment ?? []).filter((a) => /^\d+$/.test(String(a?.id ?? "")))
    .map((a) => ({ id: String(a.id), name: String(a.filename ?? ""), size: Number(a.size) || 0, who: a.author?.displayName ?? "", at: a.created ?? null }));
  delete page.changelog; delete page.fields.subtasks; delete page.fields.issuelinks; delete page.fields.attachment;
  return page;
}

// ---- Writes: comments and moves (only when the person asks) ------------------

// Plain text as Jira's rich text (ADF): a paragraph per block split by a blank line, a line break
// for each other line end. Nothing in the text is read as markup.
// `people`: [{ id, name }] of the mentions; the text holds each one as "\0<index>\0".
export function textToAdf(text, people = []) {
  const blocks = String(text ?? "").replace(/\r\n?/g, "\n").trim().split(/\n{2,}/);
  const inline = (line) => line.split(/\0(\d+)\0/).flatMap((part, n) => {
    if (n % 2 === 0) return part ? [{ type: "text", text: part }] : [];
    const p = people[Number(part)];
    return p ? [{ type: "mention", attrs: { id: p.id, text: `@${p.name}` } }] : [];
  });
  return { type: "doc", version: 1, content: blocks.map((b) => ({
    type: "paragraph",
    content: b.split("\n").flatMap((line, n) => [...(n ? [{ type: "hardBreak" }] : []), ...inline(line)]),
  })) };
}
// Adds a comment, written by the signed-in account. `parentId` (optional): the id of the comment
// that this one replies to; Jira shows the reply in the thread of that comment.
export async function addComment(site, key, text, people = [], parentId = null) {
  if (!String(text ?? "").trim()) throw new Error("Type a comment.");
  await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: textToAdf(text, people), ...(parentId ? { parentId } : {}) });
}
// The people whose name starts with `query`, for a mention: [{ id, name }].
// Two searches: the people who can see the issue (needs the "Browse users and groups" permission,
// else Jira answers an empty list) and the people who can be assigned to it (needs only the project).
export async function mentionable(site, key, query) {
  const q = `issueKey=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}&maxResults=8`;
  const answers = await Promise.allSettled([
    call(site, `/rest/api/3/user/viewissue/search?${q}`),
    call(site, `/rest/api/3/user/assignable/search?${q}`),
  ]);
  if (answers.every((a) => a.status === "rejected")) throw answers[0].reason;
  const seen = new Map();
  for (const a of answers) {
    for (const u of a.status === "fulfilled" && Array.isArray(a.value) ? a.value : []) {
      if (u?.accountId && u.active !== false && u.accountType !== "app" && !seen.has(u.accountId)) seen.set(u.accountId, { id: u.accountId, name: u.displayName ?? u.accountId });
    }
  }
  return [...seen.values()].slice(0, 8);
}

// The signed-in account ({ accountId, displayName }), kept per site.
const accounts = new Map();
export function myAccount(site) {
  if (!accounts.has(site)) {
    accounts.set(site, call(site, "/rest/api/3/myself")
      .then((m) => (m?.accountId ? { accountId: m.accountId, displayName: m.displayName ?? "" } : null))
      .catch((e) => { accounts.delete(site); throw e; }));
  }
  return accounts.get(site);
}
export function myAccountId(site) {
  return myAccount(site).then((m) => m?.accountId ?? null);
}
// Makes the signed-in account the assignee of the issue.
export async function assignToMe(site, key) {
  const id = await myAccountId(site);
  if (!id) throw new Error("Jira did not give the id of your account.");
  await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, { accountId: id }, undefined, "PUT");
}
// The fields of the issue that the signed-in account can edit (its edit screen): { [id]: fieldMeta }.
export async function editMeta(site, key) {
  const meta = await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}/editmeta`);
  return meta?.fields ?? {};
}
// A Set of editable field ids.
export async function editable(site, key) {
  return new Set(Object.keys(await editMeta(site, key)));
}
// Reads a specific set of fields of one issue.
export async function issueFields(site, key, fields) {
  const ids = [...new Set(fields)].filter((id) => /^[A-Za-z0-9_.-]+$/.test(id));
  const r = await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ids.join(",")}`);
  return r?.fields ?? {};
}
// Sets a number field (the story points); null clears it.
export async function setNumberField(site, key, id, value) {
  await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: { [id]: value } }, undefined, "PUT");
}
// Sets a text or rich-text (ADF) field; empty clears it.
export async function setTextField(site, key, id, text, rich = true) {
  const value = String(text ?? "").trim();
  const payload = !value ? null : rich ? textToAdf(value) : value;
  await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: { [id]: payload } }, undefined, "PUT");
}

// The moves the signed-in account may make on an issue now (its workflow): [{ id, name, to, category }].
export async function transitions(site, key) {
  const r = await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  return (r?.transitions ?? []).filter((x) => x.isAvailable !== false)
    .map((x) => ({ id: String(x.id), name: x.name, to: x.to?.name ?? x.name, category: x.to?.statusCategory?.key ?? "", screen: Boolean(x.hasScreen) }));
}
// The fields that a move's screen requires and the person must fill: [{ id, name, kind, multi, allowed }].
// kind: "choice" (a list to pick from, such as Fix versions or Resolution), "text" (a short text),
// "number", or "other" (rich text, a user picker…: the person makes that move in Jira).
export async function transitionFields(site, key, id) {
  if (!/^\d+$/.test(String(id))) throw new Error("That isn't a transition.");
  const r = await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields&transitionId=${id}`);
  const fields = (r?.transitions ?? []).find((x) => String(x.id) === String(id))?.fields ?? {};
  const need = Object.entries(fields).filter(([, f]) => f?.required);
  // A version field without its list: the versions of the project.
  const versions = need.some(([, f]) => f.schema?.items === "version" && !(f.allowedValues ?? []).length) ? await projectVersions(site, key).catch(() => []) : [];
  return need.map(([fid, f]) => {
    const s = f.schema ?? {}, multi = s.type === "array";
    const given = (f.allowedValues ?? []).length ? f.allowedValues : s.items === "version" ? versions.map((v) => ({ ...v, released: v.released })) : [];
    const allowed = given.filter((v) => v && v.id != null && v.archived !== true)
      .map((v) => ({ id: String(v.id), name: String(v.name ?? v.value ?? v.id), note: v.released === true ? "released" : "" }));
    const rich = ["description", "environment", "comment"].includes(s.system) || /textarea|richtext/i.test(s.custom ?? "");
    const kind = allowed.length ? "choice" : s.type === "string" && !rich ? "text" : s.type === "number" ? "number" : "other";
    if (kind === "choice") allowed.sort(byName);
    return { id: fid, name: f.name ?? fid, kind, multi, allowed };
  });
}
// Makes one move. `fields`: { fieldId: value } for the fields that the move's screen requires, already
// in the shape Jira wants (see fieldValue). Without them, a move with required fields is refused (400).
export async function moveIssue(site, key, id, fields) {
  if (!/^\d+$/.test(String(id))) throw new Error("That isn't a transition.");
  const has = fields && Object.keys(fields).length;
  await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: String(id) }, ...(has ? { fields } : {}) });
}
// The value Jira wants for a field picked in the Move form: ids of a list, a text, a number.
export function fieldValue(f, picked) {
  if (f.kind === "choice") { const ids = [...picked]; return f.multi ? ids.map((id) => ({ id })) : { id: ids[0] }; }
  if (f.kind === "number") return Number(picked);
  return String(picked).trim();
}

// Alphabetical order, case does not matter (for the lists of versions and other choices).
export const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

// The versions of the project of an issue (its key before the dash): [{ id, name, released }], the
// in alphabetical order (case does not matter). Archived versions are left out.
export async function projectVersions(site, key) {
  const project = String(key).replace(/-\d+$/, "");
  const list = await call(site, `/rest/api/3/project/${encodeURIComponent(project)}/versions`);
  const all = (Array.isArray(list) ? list : []).filter((v) => v && v.id != null && !v.archived)
    .map((v) => ({ id: String(v.id), name: String(v.name ?? v.id), released: Boolean(v.released) }));
  return all.sort(byName);
}
// The Fix versions of an issue now: [{ id, name, released }].
export async function issueFixVersions(site, key) {
  const r = await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=fixVersions`);
  return (r?.fields?.fixVersions ?? []).map((v) => ({ id: String(v.id), name: String(v.name ?? v.id), released: Boolean(v.released) }));
}
// The components of the project of an issue: [{ id, name }], in alphabetical order.
export async function projectComponentList(site, key) {
  const project = String(key).replace(/-\d+$/, "");
  const list = await call(site, `/rest/api/3/project/${encodeURIComponent(project)}/components`);
  return (Array.isArray(list) ? list : []).filter((c) => c && c.id != null).map((c) => ({ id: String(c.id), name: String(c.name ?? c.id) })).sort(byName);
}
// The components of an issue now: [{ id, name }].
export async function issueComponents(site, key) {
  const r = await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=components`);
  return (r?.fields?.components ?? []).map((c) => ({ id: String(c.id), name: String(c.name ?? c.id) }));
}
// Sets a field that holds a list of versions or components (fixVersions, components) to exactly these ids
// (an empty list clears it).
export async function setIssueIds(site, key, field, ids) {
  if (!["fixVersions", "components"].includes(field)) throw new Error("That field can't be set here.");
  if (!ids.every((id) => /^\d+$/.test(String(id)))) throw new Error("That isn't a valid id.");
  await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: { [field]: ids.map((id) => ({ id: String(id) })) } }, undefined, "PUT");
}

// Only what the list shows: raw issues (links with their whole target issues) make
// every render slow enough for the app to interrupt it.
function slim(i, site, sprintField) {
  const f = i.fields;
  return {
    key: i.key, site,
    // For the Sprint and Next sprint chips. Null: no sprint, or a site without a Sprint field.
    sprint: sprintField ? sprintOf(f[sprintField]) : null,
    // For the filters: Assigned to me and Created by me.
    assignees: f.assignee ? [f.assignee.accountId] : [], author: f.reporter?.accountId ?? null,
    blocked: (f.issuelinks ?? []).some((l) => l.type?.inward === "is blocked by" && l.inwardIssue
      && l.inwardIssue.fields?.status?.statusCategory?.key !== "done"),
    fields: {
      summary: f.summary, updated: f.updated, labels: f.labels ?? [],
      status: f.status && { name: f.status.name, statusCategory: { key: f.status.statusCategory?.key } },
      priority: f.priority && { name: f.priority.name },
      issuetype: f.issuetype && { name: f.issuetype.name },
      assignee: f.assignee && { displayName: f.assignee.displayName, accountId: f.assignee.accountId, pic: f.assignee.avatarUrls?.["48x48"] ?? "" },
      parent: f.parent && { key: f.parent.key },
    },
  };
}

// The JQL of the Sprint and Next sprint chips. It takes the place of a project filter that names
// a sprint ("sprint in openSprints()" finds nothing between 2 sprints); an other filter stays.
const SPRINT_JQL = { current: "sprint in openSprints()", next: "sprint in futureSprints()" };
const narrowed = (p, sprint) => {
  const own = SPRINT_JQL[sprint];
  if (!own) return p.filter ? ` AND (${p.filter})` : "";
  return `${p.filter && !/\bsprint\b/i.test(p.filter) ? ` AND (${p.filter})` : ""} AND ${own}`;
};

function slimParent(p, site) {
  const f = p?.fields;
  if (!p?.key || !f?.summary) return null;
  return {
    key: p.key, site, sprint: null, assignees: [], author: null, blocked: false,
    fields: {
      summary: f.summary, updated: "", labels: [],
      status: f.status && { name: f.status.name, statusCategory: { key: f.status.statusCategory?.key } },
      priority: f.priority && { name: f.priority.name },
      issuetype: f.issuetype && { name: f.issuetype.name },
      assignee: null, parent: null,
    },
  };
}

async function fetchParents(site, keys, sprintField) {
  const fields = sprintField ? [...FIELDS, sprintField] : FIELDS;
  const out = [];
  for (let n = 0; n < keys.length; n += 50) {
    const chunk = keys.slice(n, n + 50);
    const jql = `key in (${chunk.map((k) => `"${k}"`).join(",")})`;
    const page = await call(site, "/rest/api/3/search/jql", { jql, fields, maxResults: 50 }).catch(() => null);
    if (page?.issues) out.push(...page.issues.map((i) => slim(i, site, sprintField)));
  }
  return out;
}

// When a JQL filter (such as `sprint in openSprints()`) excludes epics or parent issues,
// fetch those missing parents so the tree stays intact.
async function withParents(site, issues, sprintField, fallbacks) {
  const byKey = new Map(issues.map((i) => [i.key, i]));
  const extra = new Map();
  let frontier = issues;
  for (let depth = 0; depth < 2; depth++) {
    const missing = [...new Set(frontier.map((i) => i.fields.parent?.key)
      .filter((k) => k && /^[A-Z][A-Z0-9_]+-\d+$/.test(k) && !byKey.has(k)))];
    if (!missing.length) break;
    const fetched = await fetchParents(site, missing, sprintField);
    const got = new Map(fetched.map((i) => [i.key, i]));
    for (const k of missing) {
      const item = got.get(k) ?? fallbacks.get(k);
      if (item && !byKey.has(k)) { byKey.set(k, item); extra.set(k, item); }
    }
    frontier = [...got.values()];
    if (!frontier.length) break;
  }
  if (!extra.size) return issues;
  const placed = new Set(), out = [];
  const push = (i, seen = new Set()) => {
    if (placed.has(i.key) || seen.has(i.key)) return;
    seen.add(i.key);
    const p = i.fields.parent?.key;
    if (p && extra.has(p) && !placed.has(p)) push(extra.get(p), seen);
    if (!placed.has(i.key)) { placed.add(i.key); out.push(i); }
  };
  for (const i of issues) push(i);
  return out;
}

// Open issues of one linked project, at most CAP: newest first, or in backlog order (Rank).
// `sprint` ("current" | "next", optional): only the issues of the open sprints or of the future sprints.
// `components` (optional): exact Jira component names (components.js resolveComponents); only the issues that have one of them.
export async function search(p, order, sprint = null, components = null) {
  // The list must load on a site without a Sprint field too.
  const sprintField = (await metaFields(p.site).catch(() => null))?.sprint ?? null;
  const jql = `project = "${p.key}" AND statusCategory != Done${narrowed(p, sprint)}${components?.length ? ` AND ${componentJql(components)}` : ""} ORDER BY ${order === "backlog" ? "Rank ASC" : "updated DESC"}`;
  const issues = [];
  const fallbacks = new Map();
  let nextPageToken;
  do {
    const page = await call(p.site, "/rest/api/3/search/jql", { jql, fields: sprintField ? [...FIELDS, sprintField] : FIELDS, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) });
    for (const raw of page.issues ?? []) {
      issues.push(slim(raw, p.site, sprintField));
      const fb = slimParent(raw.fields?.parent, p.site);
      if (fb && !fallbacks.has(fb.key)) fallbacks.set(fb.key, fb);
    }
    nextPageToken = page.isLast ? null : page.nextPageToken;
  } while (nextPageToken && issues.length < CAP);
  const capped = Boolean(nextPageToken);
  const full = await withParents(p.site, issues.slice(0, CAP), sprintField, fallbacks);
  return { issues: full, capped };
}

// The keys of the open issues the signed-in account watches. Jira can't search for
// mentions, so its third filter is Watching (`watcher = currentUser()`).
export async function watched(p) {
  const jql = `project = "${p.key}" AND statusCategory != Done AND watcher = currentUser()${p.filter ? ` AND (${p.filter})` : ""}`;
  const keys = [];
  let nextPageToken;
  do {
    const page = await call(p.site, "/rest/api/3/search/jql", { jql, fields: ["summary"], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) });
    keys.push(...(page.issues ?? []).map((i) => i.key));
    nextPageToken = page.isLast ? null : page.nextPageToken;
  } while (nextPageToken && keys.length < CAP);
  return keys;
}
