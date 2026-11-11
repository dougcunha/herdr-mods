// Jira Cloud: projects named in a repository, the sign-in, and the REST calls.
// Read only, with two exceptions that the person makes on an issue page: a comment and a move (transition).

import { exec, readTextFile } from "herdr";
import { call, cleanSite, validSite } from "./jira-client.js";

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
// the active one, else the next one, else the last. { name, state: "active" | "future" | "closed" }.
export function sprintOf(v) {
  const list = (Array.isArray(v) ? v : v ? [v] : []).map((s) => {
    if (s && typeof s === "object") return { name: String(s.name ?? ""), state: String(s.state ?? "").toLowerCase() };
    const m = /name=([^,\]]*)/.exec(String(s)), st = /state=([^,\]]*)/.exec(String(s));
    return m ? { name: m[1], state: (st?.[1] ?? "").toLowerCase() } : null;
  }).filter((s) => s?.name);
  return list.find((s) => s.state === "active") ?? list.find((s) => s.state === "future") ?? list.at(-1) ?? null;
}

// With its sub-tasks and history (status, assignee and priority changes become timeline events).
// `extra`: ids of more fields to read (custom fields for the prompts and the page); they come back in page.fields.
export async function issue(site, key, extra = []) {
  const ids = [...new Set(extra)].filter((id) => /^[A-Za-z0-9_.-]+$/.test(id));
  const page = await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,priority,issuetype,assignee,reporter,labels,parent,comment,created,updated,subtasks,issuelinks,fixVersions,versions,components,duedate,resolution${ids.map((id) => `,${id}`).join("")}&expand=changelog`);
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
  delete page.changelog; delete page.fields.subtasks; delete page.fields.issuelinks;
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
// Adds a comment, written by the signed-in account.
export async function addComment(site, key, text, people = []) {
  if (!String(text ?? "").trim()) throw new Error("Type a comment.");
  await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: textToAdf(text, people) });
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

// The moves the signed-in account may make on an issue now (its workflow): [{ id, name, to, category }].
export async function transitions(site, key) {
  const r = await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  return (r?.transitions ?? []).filter((x) => x.isAvailable !== false)
    .map((x) => ({ id: String(x.id), name: x.name, to: x.to?.name ?? x.name, category: x.to?.statusCategory?.key ?? "", screen: Boolean(x.hasScreen) }));
}
// Makes one move. A move whose screen asks for required fields is refused by Jira (400): do it in Jira.
export async function moveIssue(site, key, id) {
  if (!/^\d+$/.test(String(id))) throw new Error("That isn't a transition.");
  await call(site, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: String(id) } });
}

// Only what the list shows: raw issues (links with their whole target issues) make
// every render slow enough for the app to interrupt it.
function slim(i, site) {
  const f = i.fields;
  return {
    key: i.key, site,
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

// Open issues of one linked project, at most CAP: newest first, or in backlog order (Rank).
export async function search(p, order) {
  const jql = `project = "${p.key}" AND statusCategory != Done${p.filter ? ` AND (${p.filter})` : ""} ORDER BY ${order === "backlog" ? "Rank ASC" : "updated DESC"}`;
  const issues = [];
  let nextPageToken;
  do {
    const page = await call(p.site, "/rest/api/3/search/jql", { jql, fields: FIELDS, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) });
    issues.push(...(page.issues ?? []).map((i) => slim(i, p.site)));
    nextPageToken = page.isLast ? null : page.nextPageToken;
  } while (nextPageToken && issues.length < CAP);
  return { issues: issues.slice(0, CAP), capped: Boolean(nextPageToken) };
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
