// The shown space's issues, from Jira Cloud or GitHub, grouped by priority or in backlog order
// (the `order` setting, chosen with the cog in its header), with a page per issue and "Start agent".
// Read only, with two exceptions on a Jira page: Comment adds a comment, and the Move menu moves the issue (a Jira transition).
// The source: the space's link (Link space; `issues: "github"` picks GitHub, else its Jira
// project), else `.herdr/jira.toml` in its repository, else a Jira guess (the key in the
// branch name or recent commits, on a site another space links to), else the space's
// GitHub repository.
// A selected issue's page takes the list's place; Back (or Esc) shows the list again.
// Based on herdr-ranch-issues of Herdr Ranch by Jelle Slowack (MIT, see ../../LICENSE).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView, TextareaState, Textarea } from "gpui-base";
import { theme, props, closeOverlay, openOverlay, exec, nextCommand, shared, setShared, spaces, notify, run } from "herdr";
import { fileLinks, suggestKey, search, issue, myself, watched, extraFields, addComment, mentionable, metaFields, sprintOf, myAccountId, assignToMe, editable, setNumberField } from "./jira.js";
import { extraFieldNames, placeholderOf } from "./prompts.js";
import { TOKEN_PAGE, STORE, platform } from "./jira-client.js";
import * as github from "./github.js";
import { rows, haystack, words, matches, ago, hash, slug } from "./rows.js";
import { adfToMarkdown } from "./adf.js";
import { kit, pageLayout, PAGE_WIDE } from "./page-kit.js";
import { LinkDialog } from "./link-dialog.js";
import { AgentDialog, PromptsDialog } from "./agent-dialog.js";
import { TransitionMenu, CHANGED } from "./transition.js";
import { RowMenu, rowAction } from "./row-menu.js";
const ROW_ACTION = rowAction("issues");
import { context, activeSpace, knownSites, defaultJira, openLinkDialog, pref, openSettings, settingsMenu, PAGE, asSplit, pageMode, openPageDialog, pageDialog, splitView, drawn, openAgentDialog, writeIcons, icon, issueKind, kindColor, avatar, segmented, fs, readSizes, openUrl, agentSpaces, agentChip, mostUrgent, liveAgent, AGENT_STATUS, goToSpace, migrateSettings, imagesAsLinks, inDockDialog, iconButton, button, loadPeople, tint } from "./links.js";

// The mods-hub can turn this mod off (shared "herdr-mods.disabled", a list of mod names). Then the mod draws
// nothing, closes its dialog and skips its timed work. The bars hide its blocks and buttons.
const kitOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes("issues"); };
const offView = () => { const o = props()?.overlay; if (o) closeOverlay(o); return div(); };

// A folder on another machine: a server icon and the machine name, in a hue that no agent status uses.
// (The same chip as in the tabs-dock and kanban bars.)
const machineChip = (t, machine) => {
  const color = t.ansi5 || t.accent;
  const tint = /^#[0-9a-f]{6}$/i.test(color || "") ? (a) => color + a : () => color;
  return h_flex().id("machine-chip").h(20).px(7).gap(4).flex_none().max_w(140).items_center().rounded(6).text_size(11).font_semibold()
    .bg(tint("26")).border_1().border_color(tint("66")).text_color(color)
    .tooltip(`On ${machine}`)
    .child(svg("mods/workspace-chrome/server.svg").size(11).flex_none())
    .child(div().truncate().child(machine));
};

const SPINNER = "mods/workspace-chrome/spinner.svg", COG = "mods/workspace-chrome/settings.svg";
const WEEK = 7 * 24 * 3600 * 1000, WIDE = 720, ROOMY = 520, PAGES = 30, COMMENTS = 10, SHOWN = 300;
const browse = (i) => i.url ?? `https://${i.site}/browse/${i.key}`;
const isGithub = (x) => x?.provider === "github";
const where = (repo, p) => ({ cwd: repo?.main, on: repo?.on, github: p.repo });
// Jira descriptions and comments are ADF, GitHub's are Markdown already.
const text = (body) => (typeof body === "string" ? body : adfToMarkdown(body));
// The value of an extra Jira field as text: rich text (ADF) as Markdown, an option or a person by
// its name, a list joined with commas.
function fieldText(v) {
  if (v == null) return "";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.map(fieldText).filter(Boolean).join(", ");
  if (v.type === "doc") return adfToMarkdown(v).trim();
  return String(v.value ?? v.name ?? v.displayName ?? v.key ?? "");
}
const home = (i) => (isGithub(i) ? "GitHub" : "Jira");
const keyText = (i) => (isGithub(i) ? `${i.repo}${i.key}` : i.key);
// The Details card of a page, collapsed or expanded: the last choice, the same in every copy
// (the list, the page dialog), so shared (UI state, not a setting of the hub).
const detailsOpen = () => shared("issues.detailsOpen") !== false;
const keepDetails = (open) => setShared("issues.detailsOpen", open);
// Story points without a long tail (2.5, not 2.5000001).
const points = (n) => String(Math.round(n * 10) / 10);
// A Jira due date ("2026-11-20") with how far it is: { text, late, soon (2 days or less) }.
function dueText(d) {
  const at = Date.parse(`${d}T23:59:59`);
  if (Number.isNaN(at)) return { text: String(d), late: false, soon: false };
  const days = Math.floor((at - Date.now()) / 86400000);
  return { text: `${d} · ${days < 0 ? `${-days}d late` : days === 0 ? "today" : `in ${days}d`}`, late: days < 0, soon: days >= 0 && days <= 2 };
}
// The settings (Settings tab of PowerMods): the list's order (shared "issues.order") and where a page opens ("issues.page").
const split = () => asSplit("issues");
const order = () => (pref("issues", "order") === "backlog" ? "backlog" : "priority");
// The list's space and every link: either changing means another project.
const contextKey = (space) => `${space?.id}|${order()}|${JSON.stringify(shared("space-links") ?? {})}|${JSON.stringify(defaultJira())}`;
// The last list per space and order, so a switch or a restart shows it at once while it refreshes.
const remembered = (key) => { try { return JSON.parse(localStorage.getItem(`issues:${key}`) ?? "null"); } catch { return null; } };
const remember = (key, v) => { try { localStorage.setItem(`issues:${key}`, JSON.stringify(v)); } catch { /* best effort */ } };
// The width this list had last time in the same place (panel, tab or window): the first
// render uses it, so the list doesn't draw narrow and then jump to wide once it's measured.
const place = () => (props()?.overlay ? "window" : props()?.space ? "tab" : "panel");
const lastWidth = () => { try { return Number(localStorage.getItem(`width:${place()}`)) || 0; } catch { return 0; } };
const keepWidth = (w) => { try { localStorage.setItem(`width:${place()}`, String(w)); } catch { /* best effort */ } };
// Pages are cached by site, repository and key: `#12` exists in every GitHub repository.
// The extra fields are part of the key: a change in the setting fetches the pages again.
const pageKey = (i) => `${i.site}|${i.repo ?? ""}|${i.key}|${extraFieldNames().join(",")}`;
// What a space's list keeps in memory (the last SPACES spaces), so switching back shows it at once.
const SPACES = 20;
const KEPT = ["repo", "github", "projects", "from", "capped", "issues", "data", "hay", "saved", "meta", "version", "cache", "error", "signIn", "cursor"];

// What a row draws, worked out once per load: the row renderer runs inside layout, twice
// for every frame Herdr draws (hover, scrolling, any spinner on screen), so it only reads.
const rowData = (i) => ({
  key: i.key, title: i.fields.summary, status: i.fields.status?.name ?? "", blocked: i.blocked,
  active: i.fields.status?.statusCategory?.key === "indeterminate", assignee: i.fields.assignee?.displayName ?? null,
  kind: issueKind(i.fields.issuetype?.name, i.fields.labels ?? []),
  updated: i.fields.updated, age: ago(i.fields.updated),
});

// Markdown is laid out again on every render, and a long text takes the render past the
// app's time limit ("interrupted"), so pages show the start and link to the rest.
const MAX = 2000;
// The start of a comment as one plain line, for the quote of a reply.
const gist = (md) => {
  const plain = String(md ?? "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*>.*$/gm, "").replace(/[*_`#>~]/g, "").replace(/\s+/g, " ").trim();
  return plain.length > 160 ? `${plain.slice(0, 160).replace(/\s+\S*$/, "")}…` : plain;
};
const short = (text) => {
  const t = imagesAsLinks(text?.trim() ?? "");
  if (t.length <= MAX) return t;
  const cut = t.lastIndexOf("\n", MAX);
  return `${t.slice(0, cut > MAX / 2 ? cut : MAX)}\n\n_… the rest is online._`;
};

// Where the space's projects come from, in order; `from` says which: the space's link (or its
// repository's), the repository's .herdr/jira.toml, the default project (Link space or PowerMods),
// a guess from the branch, the GitHub repository.
async function projects(c) {
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

export default class SpaceIssues extends View {
  init(_props, cx) {
    migrateSettings("issues");
    if (props()?.settings) return; // the cog's popup: only settingsMenu
    // Opened as one of its dialogs (Link space, Start agent): only that dialog.
    const dialog = props()?.dialog;
    if (dialog === "page") return this.pageOnly(props(), cx);
    if (dialog) { this.dialog = cx.new(dialog === "link" ? LinkDialog : dialog === "prompts" ? PromptsDialog : dialog === "transition" ? TransitionMenu : dialog === "row" ? RowMenu : AgentDialog, props()); return; }
    // This copy's id: Start agent of a row's menu (row-menu.js) comes back only to the list that opened it.
    this.uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.seenAction = shared(ROW_ACTION)?.at ?? 0;
    // A move made in the Move menu (transition.js) reloads that issue here: the list and an open page.
    this.seenChange = shared(CHANGED)?.at ?? 0;
    this.issues = []; this.projects = []; this.from = null; this.error = null; this.loading = false; this.capped = false;
    this.query = ""; this.filter = null; this.mentions = null; this.mentionsVersion = 0; this.me = {}; this.open = null; this.page = null; this.pageError = null;
    this.width = lastWidth(); this.cache = null; this.signIn = null; this.version = 0; this.gen = 0;
    this.data = new Map(); this.hay = new Map(); this.saved = null; this.versions = 0; this.kept = new Map();
    // The highlight shows only while the keys move it: a clicked row isn't left marked.
    this.keys = false;
    // Loaded pages (the last PAGES), so opening one again is instant.
    this.pages = new Map();
    this.handle = cx.focus_handle();
    this.makeCommentBox();
    // The open issue's page is a view of its own: a live change redraws the list only,
    // and a page that loads redraws the page only (one long render was cut off).
    this.pageView = drawn(cx, () => (this.open ? this.detail(theme()) : div()));
    // A list in a tab (props.space, from mod-buttons) shows its own space and does nothing
    // while that space isn't shown; the side panel's list follows the shown space.
    this.home = props()?.space ?? null;
    this.search = InputState.new({ placeholder: "Search issues" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); cx.notify(); });
    this.refresh(cx);
    cx.spawn(async (cx) => { await writeIcons(); cx.notify(); });
    cx.timer.every(120000, (cx) => { if (!kitOff() && this.visible()) this.refresh(cx); });
    // Following the link (a space switch is caught in render): a cheap check.
    cx.timer.every(1500, (cx) => { if (!kitOff() && this.visible() && (this.stale || contextKey(this.space()) !== this.context)) this.refresh(cx); });
    // Key commands from keys.json ("issues.down"), also reachable with `herdr-app do`.
    cx.spawn(async (cx) => { try { for (;;) this.command(await nextCommand(), cx); } catch { /* the copy is closing */ } });
  }

  // Opened as a page dialog: one issue of `p.list` (the list's issues in its order), stepped
  // with Up/Down. No list, timers or commands here: the list's copy keeps those.
  pageOnly(p, cx) {
    this.seenChange = shared(CHANGED)?.at ?? 0;
    this.only ={ list: p.list ?? [], at: Math.max(0, (p.list ?? []).findIndex((i) => i.key === p.key)) };
    this.repo = p.repo ?? null; this.github = p.github ?? null; this.kidsMap = p.kids ?? {}; this.pageW = 900; this.pages = new Map(); this.open = null; this.page = null; this.pageError = null;
    this.handle = cx.focus_handle();
    this.makeCommentBox();
    // Focus can't move inside a render, so right after: Up/Down then reach the dialog.
    cx.timer.after(0, () => { try { this.handle.focus(); } catch { /* the pointer still works */ } });
    this.pageView = drawn(cx, () => (this.open ? this.detail(theme()) : div()));
    const i = this.only.list[this.only.at];
    if (!i) return;
    if (p.page) this.pages.set(pageKey(i), p.page);
    this.load(i, cx);
  }

  step(by, cx) {
    const at = Math.max(0, Math.min(this.only.list.length - 1, this.only.at + by));
    if (at === this.only.at) return;
    this.only.at = at; this.load(this.only.list[at], cx);
  }

  // Overlay: the page opens in a dialog of its own, with what the list already has.
  openPage(i) {
    const byKey = new Map(this.issues.map((x) => [x.key, x]));
    const list = this.items().items.filter((x) => !x.group).map((x) => byKey.get(x.data.key)).filter(Boolean);
    const kids = {};
    for (const x of this.issues) if (x.fields.parent) (kids[x.fields.parent.key] ??= []).push({ key: x.key, summary: x.fields.summary, done: false });
    openPageDialog("issues", { key: i.key, list: list.length ? list : [i], repo: this.repo, github: this.github, kids, page: this.pages.get(pageKey(i)) ?? null });
  }

  command(name, cx) {
    if (name === "refresh") this.refresh(cx);
    else if (name === "back") this.back(cx);
    else if (this.open) return; // the rest act on the list, which a page covers
    else if (name === "down") this.move(1, cx);
    else if (name === "up") this.move(-1, cx);
    else if (name === "open") this.enter(cx);
    else if (name === "browser") { const i = this.issues.find((x) => x.key === this.cursor); if (i) openUrl(browse(i)); }
    else if (name === "link") openLinkDialog("issues");
    else if (name === "close" && props()?.overlay) closeOverlay(props().overlay);
    // A page dialog that closes hands the keyboard back to the list (else it goes to a terminal).
    else if (name === "focus") { try { this.handle.focus(); } catch { /* not shown */ } }
  }

  space() { return this.home ? spaces().find((s) => s.id === this.home) ?? null : activeSpace(); }
  visible() { return !this.home || Boolean(this.space()?.active); }

  // Each call supersedes a load still running (`gen`), so Refresh and a space switch never
  // wait for an old one; only the latest load's answer is kept.
  // Shows the list of `space` (its project and order: `key`) at once: kept in memory, else
  // stored, else empty while it loads. Never the list of the space shown before.
  show(space, key) {
    if (this.context) { this.kept.delete(this.context); this.kept.set(this.context, Object.fromEntries(KEPT.map((k) => [k, this[k]]))); }
    if (this.kept.size > SPACES) this.kept.delete(this.kept.keys().next().value);
    // A load still running for the space shown before must not land here.
    this.gen++; this.loading = false;
    this.context = key; this.spaceId = space?.id ?? null; this.stale = true;
    this.mentions = null; this.mentionsLoading = false; this.mentionsSeq = (this.mentionsSeq ?? 0) + 1;
    this.error = null; this.signIn = null; this.keys = false; this.open = null; this.shown = null; this.page = null; this.pageError = null;
    const kept = this.kept.get(key);
    if (kept) { Object.assign(this, kept); return; }
    this.restore(space);
  }

  // The stored list of `space` (none: empty).
  restore(space) {
    const last = space && remembered(`${space.id}:${order()}`);
    this.repo = last?.repo ?? null; this.projects = last?.projects ?? []; this.from = last?.from ?? null;
    this.capped = last?.capped ?? false; this.saved = null; this.meta = null; this.cursor = null;
    this.setIssues(last?.issues ?? []);
  }

  refresh(cx) {
    const space = this.space(), key = contextKey(space);
    if (key !== this.context) this.show(space, key);
    this.stale = false;
    const gen = ++this.gen;
    if (!space) { this.loading = false; cx.notify(); return; }
    this.loading = true; cx.notify();
    const current = () => gen === this.gen;
    cx.spawn(async (cx) => {
      try {
        const c = await context(space);
        if (!current()) return;
        this.repo = c.repo; this.github = c.github;
        const linked = await projects(c);
        if (!current()) return;
        this.projects = linked.projects; this.from = linked.from;
        if (!linked.projects.length) { this.setIssues([]); this.error = null; return; }
        const results = await Promise.all(linked.projects.map(async (p) => {
          if (isGithub(p)) {
            this.me[p.site] ??= await github.me(where(c.repo, p));
            return github.search(p, where(c.repo, p));
          }
          this.me[p.site] ??= (await myself(p.site)).accountId;
          return search(p, order());
        }));
        if (!current()) return;
        this.capped = results.some((r) => r.capped); this.error = null; this.signIn = null;
        // Stored when the list or where it comes from changed.
        const meta = JSON.stringify({ repo: this.repo, projects: this.projects, from: this.from, capped: this.capped });
        if (this.setIssues(results.flatMap((r) => r.issues)) || meta !== this.meta) {
          this.meta = meta;
          remember(`${space.id}:${order()}`, { repo: this.repo, issues: this.issues, projects: this.projects, from: this.from, capped: this.capped });
        }
        if (this.filter === "mentioned") this.loadMentions(cx);
        // The pictures of the assignees (Jira; GitHub's come with the page), after the list shows.
        this.people = this.issues.map((x) => x.fields.assignee).filter((a) => a?.pic).map((a) => ({ name: a.displayName, id: a.accountId, url: a.pic }));
      } catch (e) {
        if (!current()) return;
        this.error = String(e?.message ?? e);
        // 401: no sign-in, or one Jira refuses (an expired or a scoped token).
        this.signIn = e?.status === 401 ? e.site ?? this.projects[0]?.site : null;
      }
      finally { if (current()) { this.loading = false; cx.notify(); } }
      if (current() && this.people?.length && await loadPeople(this.people)) cx.notify();
    });
  }

  // The keys for Mentioned (GitHub `mentions:@me`) or Watching (Jira), fetched when that
  // filter is picked and again on each refresh while it stays picked.
  // Mentions have a sequence of their own (`mentionsSeq`): a refresh that bumps `gen` while one
  // loads must not leave mentionsLoading stuck on. The keys land only on the space they were for.
  loadMentions(cx) {
    const context = this.context, projects = this.projects, repo = this.repo;
    if (!projects.length) return;
    const seq = this.mentionsSeq = (this.mentionsSeq ?? 0) + 1;
    this.mentionsLoading = true;
    cx.spawn(async (cx) => {
      try {
        const keys = (await Promise.all(projects.map((p) => (isGithub(p) ? github.mentioned(p, where(repo, p)) : watched(p))))).flat();
        if (seq === this.mentionsSeq && context === this.context) { this.mentions = new Set(keys); this.mentionsVersion++; }
      } catch (e) { if (seq === this.mentionsSeq && context === this.context) this.error = String(e?.message ?? e); }
      finally { if (seq === this.mentionsSeq) { this.mentionsLoading = false; cx.notify(); } }
    });
  }

  // The filters, like GitHub's: Assigned to me, Created by me, Mentioned (Watching on
  // Jira) and Recent activity (updated in the last 7 days). None picked: every issue.
  keep(i) {
    const me = this.me[i.site];
    if (this.filter === "assigned") return (i.assignees ?? [i.fields.assignee?.accountId]).includes(me);
    if (this.filter === "created") return i.author != null && i.author === me;
    if (this.filter === "mentioned") return Boolean(this.mentions?.has(i.key));
    if (this.filter === "recent") return Date.parse(i.fields.updated) > Date.now() - WEEK;
    return true;
  }

  // New issues replace the list only when they differ: an unchanged refresh just updates the
  // ages, so the list isn't regrouped, stored or redrawn for nothing. True when it changed.
  setIssues(issues) {
    const saved = JSON.stringify(issues);
    if (saved === this.saved) {
      for (const d of this.data.values()) d.age = ago(d.updated);
      return false;
    }
    this.saved = saved; this.issues = issues; this.version = ++this.versions;
    this.data = new Map(issues.map((i) => [i.key, rowData(i)]));
    this.hay = new Map(issues.map((i) => [i.key, haystack(i)]));
    return true;
  }

  // An issue's page takes the list's place; the list keeps its search and highlight.
  pick(i, cx) {
    this.cursor = i.key; this.keys = false;
    if (pageMode("issues") === "overlay") { this.openPage(i); cx.notify(); return; }
    this.load(i, cx);
  }
  // The list shows where it was; fresh data loads behind it.
  back(cx) {
    this.open = null; this.page = null; this.pageError = null;
    this.handle.focus(); this.refresh(cx); cx.notify(this.pageView); cx.notify();
  }

  // A page from the cache shows at once and is fetched again behind it.
  load(i, cx) {
    // Another issue: the comment box starts empty.
    if (this.commentFor !== i.key) { this.commentFor = i.key; this.commentError = ""; this.atUser = null; this.named = new Map(); this.reply = null; try { this.commentBox?.set_value(""); } catch { /* not made yet */ } }
    this.open = i; this.shown = i; this.page = this.pages.get(pageKey(i)) ?? null; this.pageError = null;
    // The refresh button of the page spins until the latest load ends.
    const seq = this.pageSeq = (this.pageSeq ?? 0) + 1;
    this.pageLoading = true;
    cx.spawn(async (cx) => {
      let page = null;
      try {
        page = await this.fetchPage(i);
        if (this.open === i) { this.page = page; this.pageError = null; }
      }
      catch (e) {
        if (this.open === i && !this.page) this.pageError = String(e?.message ?? e);
        // The page stays as it was: a toast tells that the refresh failed.
        else if (this.open === i) notify({ title: `${i.key} did not refresh`, body: String(e?.message ?? e).slice(0, 300), level: "error" });
      }
      if (seq === this.pageSeq) this.pageLoading = false;
      cx.notify(this.pageView);
      // The pictures of the people on the page (Jira), then the page again with them.
      if (page?.people?.length && await loadPeople(page.people)) cx.notify(this.pageView);
    });
    cx.notify(this.pageView); cx.notify();
  }

  async fetchPage(i) {
    // Jira names no pull requests: the space's repository is searched for the key.
    // The extra Jira fields of the setting (a name the site doesn't know, or a failed field list, is left out).
    const wanted = extraFieldNames();
    const defs = !isGithub(i) && wanted.length ? await extraFields(i.site, wanted).catch(() => []) : [];
    // Sprint and story points: custom fields whose ids the site's field list gives.
    const mf = isGithub(i) ? { sprint: null, points: [] } : await metaFields(i.site).catch(() => ({ sprint: null, points: [] }));
    const [page, prs, me, edits] = await Promise.all([
      isGithub(i) ? github.issue(i, where(this.repo, i)) : issue(i.site, i.key, [...defs.map((d) => d.id), ...(mf.sprint ? [mf.sprint] : []), ...mf.points]),
      !isGithub(i) && this.github ? github.prsFor(i.key, this.github, where(this.repo, { repo: this.github })).catch(() => []) : null,
      // Jira: the signed-in account (Assign to me) and the fields it can edit (the story points).
      isGithub(i) ? null : myAccountId(i.site).catch(() => null),
      isGithub(i) || !mf.points.length ? null : editable(i.site, i.key).catch(() => null),
    ]);
    if (prs) page.prs = prs;
    page.me = me;
    // The story points field of this issue's edit screen (a site can have two; a project uses one).
    page.pointsField = edits ? mf.points.find((id) => edits.has(id)) ?? null : null;
    // What the Details card and the chips under the title show (Jira; GitHub has none of it).
    const pf = page.fields;
    const points = mf.points.map((id) => pf[id]).find((v) => typeof v === "number");
    page.meta = isGithub(i) ? {} : {
      points: points ?? null,
      sprint: mf.sprint ? sprintOf(pf[mf.sprint]) : null,
      versions: (pf.fixVersions ?? []).map((v) => ({ name: v.name, released: Boolean(v.released) })),
      affects: (pf.versions ?? []).map((v) => v.name),
      components: (pf.components ?? []).map((c) => c.name),
      due: pf.duedate ?? null,
      resolution: pf.resolution?.name ?? null,
    };
    // { name, ph (its placeholder), text (all of it, for the prompt), md (the start, for the page) }.
    page.extra = defs.map((d) => {
      const value = fieldText(page.fields[d.id]);
      delete page.fields[d.id];
      return { name: d.name, ph: placeholderOf(d.wanted), text: value, md: value ? short(value) : "" };
    });
    // Converted once here, not on every render (Herdr renders on any live change): the
    // description, then comments and events in time order.
    const comments = page.fields.comment?.comments ?? [];
    page.md = { description: short(text(page.fields.description)), count: comments.length };
    // A reply (Jira's parentId) goes under the first comment of its thread, in time order.
    // A reply whose thread starts before the shown comments stands alone.
    const shown = comments.slice(-COMMENTS).map((c) => {
      const md = text(c.body);
      return { id: String(c.id), parent: c.parentId != null ? String(c.parentId) : null, who: c.author?.displayName, at: c.created, md: short(md) || " ", gist: gist(md), replies: [] };
    });
    const byId = new Map(shown.map((c) => [c.id, c]));
    const top = [];
    for (const c of shown) {
      let root = c;
      for (let n = 0; root.parent && byId.has(root.parent) && n < 50; n++) root = byId.get(root.parent);
      c.root = root.id;
      if (root === c) top.push(c); else root.replies.push(c);
    }
    page.timeline = [...top, ...(page.events ?? [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    delete page.fields.comment; delete page.events;
    this.pages.delete(pageKey(i)); this.pages.set(pageKey(i), page);
    if (this.pages.size > PAGES) this.pages.delete(this.pages.keys().next().value);
    return page;
  }

  // The page of the issue the highlight or the pointer rests on, fetched after 300 ms there.
  prefetch(i, cx) {
    if (this.pages.has(pageKey(i))) return;
    cx.spawn(async (cx) => {
      await cx.sleep(300);
      if ((this.cursor === i.key || this.hovered === i.key) && !this.pages.has(pageKey(i)) && !this.open) await this.fetchPage(i).catch(() => null);
    });
  }

  // Grouping hundreds of issues on every render costs too much script time: kept until
  // the issues, the search or the filter change. `items` are the list's rows (headings and
  // issues, with their row data), at most SHOWN issues; `total` is how many match.
  items() {
    const here = this.branchKey();
    const k = `${this.version}|${this.query}|${this.filter}|${this.mentionsVersion}|${here}`;
    if (this.cache?.k !== k) {
      const ws = words(this.query);
      const groups = rows(this.issues, (i) => matches(this.hay.get(i.key), ws) && this.keep(i), order());
      const items = [];
      // The issue the shown branch names, pinned on top (it stays in its own group too).
      // Only when it passes the search and the filter too.
      const hereIssue = here && this.issues.find((x) => x.key === here);
      const mine = hereIssue && matches(this.hay.get(here), ws) && this.keep(hereIssue) ? this.data.get(here) : null;
      if (mine) items.push({ key: "group-here", group: { label: "This branch", count: "1" } }, { key: `here-${here}`, data: mine, depth: 0 });
      let left = SHOWN;
      for (const g of groups) {
        if (left <= 0) break;
        const shown = g.rows.slice(0, left); left -= shown.length;
        items.push({ key: `group-${g.id}`, group: { label: g.label, count: String(g.rows.length) } },
          ...shown.map((r) => ({ key: `issue-${r.issue.key}`, data: this.data.get(r.issue.key), depth: r.depth })));
      }
      const flat = groups.flatMap((g) => g.rows.map((r) => r.issue));
      // The key column fits the longest key shown: "#172" needs far less than "ACME0010-1156".
      const longest = items.reduce((n, i) => Math.max(n, i.data?.key.length ?? 0), 0);
      this.cache = { k, items, flat: flat.slice(0, SHOWN), total: flat.length, keyW: Math.min(110, Math.max(36, Math.ceil(longest * 6.6) + 8)) };
    }
    return this.cache;
  }

  // The issue key in the shown space's branch: RKT-412 from feature/RKT-412-x or agent/RKT-412-…,
  // #12 from issue-12-x or 12-x on a GitHub-linked space.
  branchKey() {
    const b = this.space()?.branch ?? "";
    const jira = /(?:^|[^A-Za-z0-9_])([A-Z][A-Z0-9_]{1,19}-\d+)(?![0-9])/.exec(b)?.[1];
    if (jira && this.data.has(jira)) return jira;
    const n = /(?:^|[/-])issue-(\d+)(?![0-9])/.exec(b)?.[1];
    return n ? `#${n}` : jira ?? null;
  }

  move(step, cx) {
    const flat = this.items().flat;
    if (!flat.length) return;
    const at = flat.findIndex((i) => i.key === this.cursor);
    // The keys move the highlight and Enter opens the page.
    const next = flat[Math.max(0, Math.min(flat.length - 1, at < 0 ? 0 : at + step))];
    this.cursor = next.key; this.keys = true; this.prefetch(next, cx);
    cx.notify();
  }

  enter(cx) {
    const i = this.issues.find((x) => x.key === this.cursor);
    if (i) { this.pick(i, cx); this.keys = true; } // opened with the keys: keep the highlight
  }

  dispatch(i, page) {
    const title = page.fields.summary;
    // From a page dialog: the agent's dialog takes its place.
    if (this.only) closeOverlay(props().overlay);
    const f = page.fields, branch = isGithub(i) ? `agent/issue-${i.number}-${slug(title)}-${hash(`github-${i.repo}-${i.number}`)}`
      : `agent/${i.key}-${slug(title)}-${hash(`jira-${i.site}-${i.key}`)}`;
    const tab = `${i.key} ${title}`.slice(0, 60);
    openAgentDialog("issues", {
      kind: "issue", repo: this.repo.main, on: this.repo.on, key: i.key, title, icon: issueKind(f.issuetype?.name, f.labels ?? []),
      vars: {
        key: isGithub(i) ? `${i.repo}${i.key}` : i.key, title, url: browse(i), type: f.issuetype?.name ?? "", status: f.status?.name ?? "",
        priority: f.priority?.name ?? "", labels: (f.labels ?? []).join(", "), description: text(f.description) || "(no description)", tracker: home(i),
        // The extra fields: each by its placeholder ("none" when empty or not on this issue), and all in {fields}.
        ...Object.fromEntries(extraFieldNames().map((n) => [placeholderOf(n), ""])),
        ...Object.fromEntries((page.extra ?? []).map((x) => [x.ph, x.text])),
        fields: (page.extra ?? []).filter((x) => x.text).map((x) => `## ${x.name}\n\n${x.text}`).join("\n\n"),
      },
      // A branch per mode (agent/plan-…, agent/investigate-…), so planning and then working on one issue don't collide.
      branches: { work: branch, plan: branch.replace(/^agent\//, "agent/plan-"), investigate: branch.replace(/^agent\//, "agent/investigate-") }, tabs: { work: tab, plan: `Plan ${tab}`.slice(0, 60), investigate: `Investigate ${tab}`.slice(0, 60) },
    });
  }

  // One row from its row data and the styles `render` picked once (`s`). Built once per
  // render: hover is a style (no script runs on it), and only entering a row calls back,
  // to fetch its page ahead.
  row(d, depth, s) {
    const t = s.t;
    const status = div().flex_none().max_w(110).truncate().px(6).py(1).rounded(4).text_size(fs.tiny)
      .bg(d.active ? s.activeBg : t.raised).text_color(d.active ? t.accent : t.muted).child(d.status);
    const blocked = (e) => (d.blocked ? e.child(div().flex_none().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(fs.tiny).text_color(t.ansi1).child("blocked")) : e);
    const kind = icon(d.kind, kindColor(d.kind, t));
    const key = div().w(s.keyW).flex_none().truncate().text_size(fs.meta).text_color(t.dim).child(d.key);
    const title = div().flex_1().min_w(0).truncate().child(d.title);
    const age = div().w(30).flex_none().text_right().text_size(fs.meta).text_color(t.dim).child(d.age);
    const agent = (e) => { const c = s.agents?.has(d.key) && agentChip(`agent-${depth}-${d.key}`, s.agents.get(d.key), t); return c ? e.child(c) : e; };
    const base = (e) => e.flex_none().pl(10 + depth * 18).pr(10).rounded(6).cursor_pointer().hover((x) => x.bg(t.hover))
      .when(s.keys && s.cursor === d.key, (e) => e.bg(t.selected));
    // Narrow (the side panel): two lines, so the summary keeps the whole width.
    if (s.two) return base(v_flex()).h(fs.row2).justify_center().gap(3)
      .child(h_flex().gap(8).items_center().child(kind).child(key).child(title).child(age))
      .child(agent(blocked(h_flex().pl(s.keyW + 30).gap(6).items_center().child(avatar(d.assignee, t, 16))
        .child(div().flex_1().min_w(0).truncate().text_size(fs.meta).text_color(t.muted).child(d.assignee ?? "Unassigned")))).child(status));
    return agent(blocked(base(h_flex()).h(fs.row).gap(8).items_center().child(kind).child(key).child(title))).child(status)
      .child(avatar(d.assignee, t))
      .child(age);
  }

  // Herdr calls this when the copy goes (only on this root view, never on the dialogs made with
  // cx.new). A page dialog or a Link space / Start agent / Prompts dialog (closed with Esc, × or a
  // click beside it) hands the keyboard back to the list, else keys would go to a terminal.
  async close() { if (this.only || this.dialog) run("issues.focus"); }

  // Goes to an agent's space; a page dialog closes first, so it doesn't cover that space.
  go(id) {
    if (this.only) closeOverlay(props().overlay);
    goToSpace(id);
  }

  // Sub-tasks: Jira's from the page; GitHub's from the list (its children by parent).
  kids(key) {
    if (this.only) return this.kidsMap[key] ?? [];
    return this.issues.filter((x) => x.fields.parent?.key === key).map((x) => ({ key: x.key, summary: x.fields.summary, done: false }));
  }

  // The page's own keys (Up, Down and Esc are the dialog's or the list's): ⌘↵ Start agent, O open, C copy the key, R refresh.
  pageKey(e, cx) {
    const i = this.open, p = this.page, m = e.modifiers ?? {};
    if (!i || this.typing) return false;
    if (e.key === "enter" && m.platform) { const a = liveAgent(agentSpaces(this.repo?.main).issues.get(i.key)); if (a) this.go(a.id); else if (this.repo && p) this.dispatch(i, p); return true; }
    if (m.platform || m.control || m.alt) return false;
    if (e.key === "o") { openUrl(browse(i)); return true; }
    if (e.key === "c") { this.copyKey(i, cx); return true; }
    if (e.key === "r") { this.load(i, cx); return true; }
    return false;
  }

  // The key as the tracker writes it (GitHub's with its repository: owner/repo#12), on the clipboard.
  copyKey(i, cx) {
    const k = keyText(i);
    cx.write_to_clipboard(k);
    notify({ title: `Copied ${k}`, level: "success", timeout: 2000 });
  }

  // The right-click menu of a row (row-menu.js), under the pointer.
  rowMenu(key) {
    const i = this.issues.find((x) => x.key === key);
    if (!i) return;
    openOverlay({ mod: "issues", kind: "popup", width: 220, props: {
      dialog: "row", mod: "issues", to: this.uid, key: i.key, site: i.site, status: i.fields.status?.name ?? "", url: browse(i),
      open: `Open in ${home(i)}`, copy: keyText(i), copyLabel: "Copy key", jira: !isGithub(i), agent: this.repo ? "Start agent" : null,
    } });
  }
  // Start agent from a row's menu: the shared ROW_ACTION names this copy (`to`). The page is
  // fetched first when the list doesn't have it yet.
  followRowAction(cx) {
    const a = shared(ROW_ACTION);
    if (!a?.at || a.at === this.seenAction || !this.uid || a.to !== this.uid) return;
    this.seenAction = a.at;
    const i = this.issues.find((x) => x.key === a.key);
    if (!i || !this.repo) return;
    try {
      cx.timer.after(0, (cx) => {
        const page = this.pages.get(pageKey(i));
        if (page) { this.dispatch(i, page); return; }
        cx.spawn(async () => {
          try { this.dispatch(i, await this.fetchPage(i)); }
          catch (e) { notify({ title: `${i.key} did not load`, body: String(e?.message ?? e).slice(0, 300), level: "error" }); }
        });
      });
    } catch { /* the next render runs it */ this.seenAction = 0; }
  }

  // GitHub's issue page: header (position, actions, title, state badge, byline), the
  // conversation as a timeline, properties in a sidebar. `i` and `p`: the open issue and its page.
  detail(t, i = this.open, p = this.page) {
    const k = kit(t), f = p?.fields ?? i.fields, gh = isGithub(i);
    const kind = issueKind(f.issuetype?.name, f.labels ?? []);
    const cat = f.status?.statusCategory?.key ?? i.fields.status?.statusCategory?.key;
    const closed = gh && f.status?.name === "Closed";
    const badge = gh ? k.badge(closed ? "Closed" : "Open", closed ? t.ansi5 : t.ansi2, "issue")
      : k.badge(f.status?.name ?? "?", cat === "done" ? t.ansi2 : cat === "indeterminate" ? t.accent : t.muted, cat === "done" ? "done" : cat === "indeterminate" ? "pending" : "circle");
    const reporter = f.reporter?.displayName, created = f.created;
    const full = !this.only && pageMode("issues") === "full";
    const nav = this.only ? h_flex().gap(6).items_center().text_size(fs.meta).text_color(t.muted)
        .child(k.arrow("prev", "↑", (cx) => this.step(-1, cx), this.only.at > 0))
        .child(k.arrow("next", "↓", (cx) => this.step(1, cx), this.only.at < this.only.list.length - 1))
        .child(`${this.only.at + 1} of ${this.only.list.length}`)
      : full ? k.button("issue-back", "← Back", () => run("issues.back")) : null;
    const m = p?.meta ?? {};
    const md = (id, body) => TextView.markdown(id, body).selectable(true).on_link_click((url) => openUrl(url));
    // A comment card; Jira comments get Reply, and the replies of a thread sit under its first comment.
    const comment = (x, id) => k.card(`c-${i.key}-${id}`, x.who, x.parent ? "replied" : "commented", `${ago(x.at)} ago`, md(`comment-${i.key}-${id}`, x.md),
      !gh && x.id && button(t, `reply-${i.key}-${id}`, "Reply", (cx) => this.replyTo(x, cx), { kind: "link", small: true, tooltip: "Reply in the thread of this comment" }));
    const timeline = p ? p.timeline.map((x, n) => (x.md == null
      ? k.event(`e-${i.key}-${n}`, x.who, x.text, `${ago(x.at)} ago`, x.color && t[x.color])
      : !x.replies?.length ? comment(x, n)
      : v_flex().gap(8).child(comment(x, n))
        .child(v_flex().gap(8).ml(14).pl(24).border_l_2().border_color(t.border).children(x.replies.map((r, m) => comment(r, `${n}-${m}`)))))) : [];
    const sub = p?.sub?.length ? p.sub : this.kids(i.key);
    const prs = p?.prs ?? [];
    const prIcon = (s) => (s === "MERGED" ? "merged" : s === "CLOSED" ? "closed" : s === "DRAFT" ? "draft" : "pr");
    const working = agentSpaces(this.repo?.main).issues.get(i.key) ?? [], lead = liveAgent(working);
    // The extra fields of the setting: a long text (Refinement) gets a tab, a short value a row of Details.
    const extras = (p?.extra ?? []).filter((x) => x.md);
    const long = extras.filter((x) => x.text.length > 80 || x.text.includes("\n")), brief = extras.filter((x) => !long.includes(x));
    const tabList = [["desc", "Description"], ...long.map((x) => [`x-${x.ph}`, x.name]), ["activity", "Activity", p ? p.md.count : null]];
    // The picked tab stays while the issues change; an issue without it shows its description.
    const tab = tabList.some(([id]) => id === this.pageTab) ? this.pageTab : "desc";
    const pickTab = (id, cx) => { this.pageTab = id; this.typing = false; cx.notify(this.pageView); };
    // What matters most gets a color: a high priority, the active sprint, a due date that is near or past.
    const prio = f.priority?.name ?? "", urgent = /highest|blocker|critical|urgent|high|major/i.test(prio);
    const prioColor = /highest|blocker|critical|urgent/i.test(prio) ? t.ansi1 : urgent ? t.ansi3 : /low|minor|trivial/i.test(prio) ? t.ansi4 : t.muted;
    const sprintColor = (s) => (s.state === "active" ? t.ansi2 : s.state === "future" ? t.accent : t.dim);
    const due = m.due ? dueText(m.due) : null, dueColor = due?.late ? t.ansi1 : due?.soon ? t.ansi3 : t.muted;
    const tags = (list, color) => h_flex().flex_wrap().gap(4).children(list.map((x) => k.tag(x, color)));
    const details = ["full", k.facts("Details", [
      ["Assignee", h_flex().gap(6).items_center().min_w(0)
        .child(div().flex_1().min_w(0).child(f.assignee ? k.person(f.assignee.displayName) : div().text_color(t.dim).child("Unassigned")))
        .when(!gh && Boolean(p?.me) && f.assignee?.accountId !== p?.me, (e) => e.child(button(t, "assign-me", this.assigning ? "Assigning…" : "Assign to me",
          (cx) => this.assignMe(i, cx), { kind: "link", small: true, disabled: Boolean(this.assigning), tooltip: "Make you the assignee of this issue" }))), "user"],
      reporter && [gh ? "Author" : "Reporter", k.person(reporter), "user"],
      prio && ["Priority", div().text_color(urgent ? prioColor : t.foreground).when(urgent, (e) => e.font_semibold()).child(prio), "flag"],
      !gh && ["Story points", this.pointsEdit === i.key ? this.pointsEditor(t, i)
        : div().id("points-value").when(Boolean(p?.pointsField), (e) => e.cursor_pointer().tooltip("Click to change the story points")
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.editPoints(i, m.points, cx)))
          .child(m.points != null
            ? h_flex().gap(5).items_baseline().child(div().text_size(fs.title + 3).font_bold().text_color(t.accent).child(points(m.points))).child(div().text_size(fs.tiny).text_color(t.dim).child(m.points === 1 ? "point" : "points"))
            : div().text_color(t.dim).child(!p ? "…" : p.pointsField ? "Not estimated · click to set" : "Not estimated")), "points"],
      m.sprint && ["Sprint", h_flex().gap(6).items_center().min_w(0).child(div().size(7).flex_none().rounded_full().bg(sprintColor(m.sprint)))
        .child(div().min_w(0).truncate().child(m.sprint.name)), "sprint"],
      m.versions?.length && ["Fix versions", h_flex().flex_wrap().gap(4).children(m.versions.map((v) => k.tag(v.name, v.released ? t.ansi2 : t.accent))), "version"],
      m.affects?.length && ["Affects", tags(m.affects, t.muted), "version"],
      m.components?.length && ["Components", tags(m.components, t.ansi5), "component"],
      f.labels?.length && ["Labels", h_flex().flex_wrap().gap(4).children(f.labels.map((l) => k.label(l))), "tag"],
      due && ["Due", div().text_color(due.late || due.soon ? dueColor : t.foreground).child(due.text), "calendar"],
      f.parent?.key && ["Parent", div().text_color(t.muted).child(f.parent.key), "epic"],
      f.milestone && ["Milestone", div().child(f.milestone), "flag"],
      ...brief.map((x) => [x.name, div().child(x.text)]),
      m.resolution && ["Resolution", div().text_color(t.ansi2).child(m.resolution), "done"],
      created && ["Created", div().text_color(t.muted).child(`${ago(created)} ago`), "pending"],
      f.updated && ["Updated", div().text_color(t.muted).child(`${ago(f.updated)} ago`), "refresh"],
    ], { open: detailsOpen(), toggle: (cx) => { keepDetails(!detailsOpen()); cx.notify(this.pageView); } })];
    const side = [
      k.agents(working, (id) => this.go(id)),
      details,
      sub.length > 0 && k.section("Sub-tasks", v_flex().gap(4).children(sub.map((x) => h_flex().gap(6).items_center().text_size(fs.meta).min_w(0)
          .child(icon(x.done ? "done" : "circle", x.done ? t.ansi2 : t.dim, 13))
          .child(div().flex_none().text_color(t.dim).child(x.key))
          .child(div().min_w(0).truncate().when(x.done, (e) => e.line_through().text_color(t.muted)).child(x.summary)))),
        div().text_size(fs.tiny).text_color(t.dim).child(`${sub.filter((x) => x.done).length} of ${sub.length}`)),
      p?.relations?.length > 0 && k.section("Relations", v_flex().gap(4).children(p.relations.map((x, n) => v_flex().id(`rel-${n}`).gap(1).min_w(0).text_size(fs.meta)
          .child(div().text_size(fs.tiny).text_color(/block/.test(x.label) && !x.done ? t.ansi1 : t.dim).child(x.label))
          .child(h_flex().gap(6).items_center().min_w(0)
            .child(icon(x.done ? "done" : "circle", x.done ? t.ansi2 : t.dim, 13))
            .child(div().flex_none().text_color(t.dim).child(x.key))
            .child(div().min_w(0).truncate().when(x.done, (e) => e.line_through().text_color(t.muted)).child(x.summary)))))),
      p && k.section("Development", prs.length ? v_flex().gap(4).children(prs.map((x) => h_flex().id(`pr-${x.number}`).gap(6).items_center().text_size(fs.meta).min_w(0)
          .cursor_pointer().hover((s) => s.text_color(t.accent)).on_click(() => openUrl(x.url))
          .child(icon(prIcon(x.state), kindColor(prIcon(x.state), t), 13))
          .child(div().flex_none().text_color(t.dim).child(`#${x.number}`))
          .child(div().flex_1().min_w(0).truncate().child(x.title))
          .when(Boolean(x.checks && (x.checks.fail || x.checks.pending || x.checks.pass)), (e) => {
            const c = x.checks, st = c.fail ? "x" : c.pending ? "pending" : "check";
            return e.child(h_flex().flex_none().gap(2).items_center().text_color(kindColor(st, t)).child(icon(st, kindColor(st, t), 11)).child(String(c.fail || c.pending || c.pass)));
          })))
        : div().text_size(fs.meta).text_color(t.dim).child(gh ? "No pull request mentions this issue." : this.github ? `No pull request names ${i.key}.` : "Link a GitHub repository to see pull requests.")),
    ];
    const keys = [...(this.only || split() ? [[["↑", "↓"], "previous / next"]] : []), ...(lead ? [[["⌘", "↵"], "go to agent"]] : this.repo && p ? [[["⌘", "↵"], "Start agent"]] : []),
      [["O"], `open in ${home(i)}`], [["C"], "copy key"], [["R"], "refresh"], [["Esc"], this.only ? "close" : "back"]];
    return pageLayout({
      id: "issue-detail", t, wide: (this.only ? this.pageW : this.width) >= PAGE_WIDE, nav,
      actions: [
        // Fetches this issue again: fields, comments, pull requests.
        iconButton(t, "issue-refresh", "refresh", (cx) => this.load(i, cx), { spin: Boolean(this.pageLoading), tooltip: "Refresh this issue" }),
        // Jira only: the moves of its workflow (the one write of this mod).
        ...(!gh ? [k.button("issue-move", `Move · ${f.status?.name ?? "?"}`, () => this.openMove(i, f.status?.name ?? ""), { icon: "pending" })] : []),
        k.button("issue-open", `Open in ${home(i)}`, () => openUrl(browse(i))),
        ...(lead ? [
          ...(this.repo && p ? [k.button("issue-agent", "Start another", () => this.dispatch(i, p))] : []),
          k.button("issue-go", `Go to agent · ${AGENT_STATUS[lead.status]?.[0] ?? "idle"}`, () => this.go(lead.id), { primary: true, icon: "bot" }),
        ] : this.repo && p ? [k.button("issue-agent", "Start agent", () => this.dispatch(i, p), { primary: true, icon: "bot" })] : []),
      ],
      title: f.summary, key: i.key, copy: (cx) => this.copyKey(i, cx),
      // The facts that matter at a glance, as chips under the title.
      status: h_flex().gap(6).items_center().flex_wrap().child(badge)
        .child(k.chip(kind, f.issuetype?.name ?? "Issue", kindColor(kind, t)))
        .when(Boolean(prio), (e) => e.child(k.chip("flag", prio, prioColor, urgent)))
        .when(m.points != null, (e) => e.child(k.chip("points", `${points(m.points)} pts`, t.accent, true)))
        .when(Boolean(m.sprint), (e) => e.child(k.chip("sprint", m.sprint.name, sprintColor(m.sprint), m.sprint.state === "active")))
        .when(Boolean(due), (e) => e.child(k.chip("calendar", due.text, dueColor, due.late)))
        .when(Boolean(reporter), (e) => e.child(div().pl(2).text_size(fs.meta).text_color(t.dim)
          .child(`${reporter} ${gh ? "opened" : "reported"} this${created ? ` ${ago(created)} ago` : ""}`))),
      tabs: k.tabs(tab, tabList, pickTab),
      main: !p ? [div().p(10).text_color(this.pageError ? t.ansi1 : t.dim).child(this.pageError ?? "Loading the description and comments…")]
        : tab === "activity" ? [
          ...(timeline.length ? timeline : [div().py(6).text_size(fs.meta).text_color(t.dim).child("No comments yet.")]),
          ...(p.md.count > COMMENTS ? [div().pl(38).text_size(fs.meta).text_color(t.dim).child(`Older comments are in ${home(i)}.`)] : []),
          // Jira only: a new comment, posted as the signed-in account.
          ...(!gh ? [this.composer(t, i)] : []),
        ]
        : tab.startsWith("x-") ? long.filter((x) => `x-${x.ph}` === tab).map((x) => k.panel(`panel-${i.key}-${x.ph}`, md(`extra-${i.key}-${x.ph}`, x.md)))
        : [k.panel(`panel-${i.key}-desc`, md(`desc-${i.key}`, p.md.description || "_No description._"))],
      side,
      footer: k.footer(keys),
    });
  }

  // The open page shows its agents' status, but redraws only on its own: a status change
  // (seen here, on the live re-render) redraws it right after this render.
  watchAgents(cx, list) {
    const sig = JSON.stringify(list ?? []);
    if (sig === this.agentSig) return;
    this.agentSig = sig;
    try { cx.timer.after(0, (cx) => cx.notify(this.pageView)); } catch { /* shown on the next page change */ }
  }

  // After a move (shared CHANGED, set by the Move menu): that issue's pages are fetched again, an open
  // one at once, and the list (not a page dialog) refreshes.
  followChanges(cx) {
    const ch = shared(CHANGED);
    if (!this.pages || !ch?.at || ch.at === this.seenChange) return;
    this.seenChange = ch.at;
    try {
      cx.timer.after(0, (cx) => {
        for (const k of [...this.pages.keys()]) if (k.split("|")[2] === ch.key) this.pages.delete(k);
        if (this.open?.key === ch.key) this.load(this.open, cx);
        if (!this.only) this.refresh(cx);
      });
    } catch { /* the 2-minute refresh catches it */ }
  }

  // The comment box of a Jira page: a text area and Comment (Ctrl+Enter). Kept per copy.
  makeCommentBox() {
    this.commentBox = TextareaState.new({ placeholder: "Add a comment…", value: "", rows: 4 });
    this.commenting = false; this.commentError = ""; this.typing = false;
    // While the box has the keyboard, the page's keys (O, C, ↑ ↓) leave the keys to it.
    this.commentBox.on("focus", () => { this.typing = true; });
    this.commentBox.on("blur", () => { this.typing = false; });
    // "@" and a name at the end of the text: a list of Jira people to mention.
    this.atUser = null; this.named = new Map(); this.atSeq = 0; this.reply = null;
    // The story points editor of the Details card: Enter saves, Esc cancels.
    this.pointsEdit = null; this.pointsError = ""; this.savingPoints = false; this.assigning = false;
    this.pointsBox = InputState.new({ placeholder: "Points" });
    this.pointsBox.on("focus", () => { this.typing = true; });
    this.pointsBox.on("blur", () => { this.typing = false; });
    this.pointsBox.on("submit", (_e, cx) => { if (this.open) this.savePoints(this.open, cx); });
    this.commentBox.on("change", (_e, cx) => this.followMention(cx));
  }

  // Reply to a comment: the next comment goes into the thread of that comment (Jira's parentId,
  // the first comment of the thread). The box gets the keyboard.
  replyTo(x, cx) {
    this.reply = { id: x.root ?? x.id, who: x.who ?? "", text: x.gist ?? "" };
    this.atUser = null; this.atSeq++;
    const refocus = () => { try { this.commentBox.focus(); } catch { /* not shown */ } };
    refocus();
    try { cx.timer.after(40, refocus); } catch { /* the first focus stays */ }
    cx.notify(this.pageView);
  }

  // The "@name" that ends the text opens the list of people; each change searches again after 250 ms.
  followMention(cx) {
    const i = this.open;
    if (!i || isGithub(i)) return;
    const text = this.commentBox.value();
    const m = /(^|\s)@([^\s@]{0,30})$/u.exec(text);
    if (!m) { if (this.atUser) { this.atUser = null; this.atSeq++; cx.notify(this.pageView); } return; }
    const q = m[2];
    if (this.atUser?.q === q) return;
    const seq = ++this.atSeq;
    // While the search runs, the list keeps only the names that still match.
    const lq = q.toLowerCase();
    const kept = this.atUser?.users?.filter((u) => u.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(lq))) ?? [];
    this.atUser = { q, start: m.index + m[1].length, end: text.length, users: kept.length ? kept : null, error: "", at: 0 };
    cx.notify(this.pageView);
    cx.spawn(async (cx) => {
      await cx.sleep(250);
      if (seq !== this.atSeq) return;
      let users = [], error = "";
      try { users = await mentionable(i.site, i.key, q); } catch (e) { error = String(e?.message ?? e).slice(0, 200); }
      if (seq !== this.atSeq || !this.atUser) return;
      this.atUser.users = users; this.atUser.error = error; this.atUser.at = 0; cx.notify(this.pageView);
    });
  }
  // Puts "@Name " in the place of the typed "@name"; Comment sends it as a Jira mention.
  pickMention(u, cx) {
    const m = this.atUser;
    if (!m) return;
    const text = this.commentBox.value();
    this.atUser = null; this.atSeq++;
    this.named.set(u.name, u.id);
    this.commentBox.set_value(`${text.slice(0, m.start)}@${u.name} ${text.slice(m.end)}`);
    // A click on a row takes the keyboard from the box: give it back after the click.
    const refocus = () => { try { this.commentBox.focus(); } catch { /* not shown */ } };
    refocus();
    try { cx.timer.after(40, refocus); } catch { /* the first focus stays */ }
    cx.notify(this.pageView);
  }
  // The text with each picked "@Name" as "\0<index>\0", and the people of those indexes.
  withMentions(text) {
    const people = [];
    const names = [...this.named.keys()].sort((a, b) => b.length - a.length);
    if (!names.length) return { text, people };
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`@(${names.map(esc).join("|")})(?![\\p{L}\\p{N}_])`, "gu");
    const out = text.replace(re, (_all, name) => {
      let n = people.findIndex((p) => p.name === name);
      if (n < 0) n = people.push({ id: this.named.get(name), name }) - 1;
      return `\0${n}\0`;
    });
    return { text: out, people };
  }
  mentionList(t) {
    const m = this.atUser, users = m.users ?? [];
    const box = v_flex().id("mention-list").gap(1).p(4).rounded(8).border_1().border_color(t.border).bg(t.background).text_size(fs.meta);
    if (!users.length) return box.child(div().px(6).py(3).text_color(m.error ? t.ansi1 : t.dim)
      .child(m.error ? `The search failed: ${m.error}` : m.users ? `No one matches @${m.q}.` : "Searching people…"));
    return box.children(users.map((u, n) => h_flex().id(`mention-${n}`).gap(6).items_center().px(6).py(3).rounded(6).min_w(0)
      .when(n === m.at, (e) => e.bg(t.hover))
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.pickMention(u, cx))
      .child(avatar(u.name, t, 18))
      .child(div().min_w(0).truncate().child(u.name))))
      .child(div().px(6).pt(2).text_size(fs.tiny).text_color(t.dim).child("↑ ↓ pick · ↵ or Tab mention"));
  }
  composer(t, i) {
    const send = (cx) => this.sendComment(i, cx);
    return v_flex().id(`compose-${i.key}`).gap(6).pl(38)
      // The list's press handler must not take the keyboard from the box. Only Ctrl+Enter stops here:
      // a stopped key never reaches the box as text (this.typing keeps the page's keys out).
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_key_down((e, cx) => {
        const md = e.modifiers ?? {}, list = this.atUser?.users ?? [];
        // The list of people takes ↑ ↓, Enter, Tab and Esc while it shows names.
        if (list.length && !md.control && !md.platform && !md.alt) {
          const m = this.atUser;
          if (e.key === "down" || e.key === "up") { m.at = (m.at + (e.key === "down" ? 1 : list.length - 1)) % list.length; cx.notify(this.pageView); cx.stop_propagation(); return; }
          if (e.key === "enter" || e.key === "tab") { this.pickMention(list[m.at], cx); cx.stop_propagation(); return; }
          if (e.key === "escape") { this.atUser = null; this.atSeq++; cx.notify(this.pageView); cx.stop_propagation(); return; }
        }
        if (e.key === "enter" && (md.control || md.platform)) { send(cx); cx.stop_propagation(); }
      })
      .when(Boolean(this.reply), (e) => e.child(h_flex().gap(6).items_center().min_w(0).px(8).py(4).rounded(6).bg(tint(t.accent, "14")).text_size(fs.meta)
        .child(div().flex_none().text_color(t.accent).child(`Reply to ${this.reply.who || "comment"}`))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(this.reply.text ? `“${this.reply.text}”` : ""))
        .child(iconButton(t, "reply-cancel", "x", (cx) => { this.reply = null; cx.notify(this.pageView); }, { size: 20, tooltip: "Cancel the reply" }))))
      .child(div().h(96).px(8).py(5).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(fs.meta).child(Textarea.new(this.commentBox)))
      .when(Boolean(this.atUser), (e) => e.child(this.mentionList(t)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).text_size(fs.tiny).text_color(this.commentError ? t.ansi1 : t.dim)
          .child(this.commentError || "Posted to Jira as you. Type @ to mention a person. A blank line starts a new paragraph."))
        .child(button(t, "comment-send", this.commenting ? "Posting…" : this.reply ? "Reply" : "Comment", send, { kind: "primary", disabled: this.commenting })));
  }
  // Assign to me (Jira): the signed-in account becomes the assignee; every copy reloads the issue.
  assignMe(i, cx) {
    if (this.assigning) return;
    this.assigning = true; cx.notify(this.pageView);
    cx.spawn(async (cx) => {
      try {
        await assignToMe(i.site, i.key);
        notify({ title: `${i.key} is assigned to you`, level: "success", timeout: 2500 });
        setShared(CHANGED, { site: i.site, key: i.key, at: Date.now() });
      } catch (e) { notify({ title: `${i.key} was not assigned`, body: String(e?.message ?? e).slice(0, 300), level: "error" }); }
      this.assigning = false; cx.notify(this.pageView);
    });
  }
  editPoints(i, now, cx) {
    this.pointsEdit = i.key; this.pointsError = "";
    this.pointsBox.set_value(now != null ? String(now) : "");
    const focus = () => { try { this.pointsBox.focus(); } catch { /* not shown */ } };
    focus();
    try { cx.timer.after(40, focus); } catch { /* the first focus stays */ }
    cx.notify(this.pageView);
  }
  cancelPoints(cx) {
    this.pointsEdit = null; this.pointsError = ""; this.typing = false;
    try { this.handle.focus(); } catch { /* not shown */ }
    cx.notify(this.pageView);
  }
  // An empty field clears the estimate; else a number of 0 or more (a comma is a decimal point too).
  savePoints(i, cx) {
    const field = this.page?.pointsField;
    if (!field || this.savingPoints || this.pointsEdit !== i.key) return;
    const raw = this.pointsBox.value().trim().replace(",", ".");
    const value = raw === "" ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0)) { this.pointsError = "Type a number, or leave it empty."; cx.notify(this.pageView); return; }
    this.savingPoints = true; this.pointsError = ""; cx.notify(this.pageView);
    cx.spawn(async (cx) => {
      try {
        await setNumberField(i.site, i.key, field, value);
        this.pointsEdit = null; this.typing = false;
        try { this.handle.focus(); } catch { /* not shown */ }
        setShared(CHANGED, { site: i.site, key: i.key, at: Date.now() });
      } catch (e) { this.pointsError = String(e?.message ?? e).slice(0, 200); }
      this.savingPoints = false; cx.notify(this.pageView);
    });
  }
  pointsEditor(t, i) {
    return v_flex().id("points-edit").gap(4).min_w(0)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      // Esc reaches here while the field has the keyboard (the dialog does not close).
      .on_key_down((e, cx) => { if (e.key === "escape") { this.cancelPoints(cx); cx.stop_propagation(); } })
      .child(h_flex().gap(4).items_center()
        .child(div().w(72).h(26).px(6).rounded(6).border_1().border_color(this.pointsError ? t.ansi1 : t.accent).bg(t.background).flex().items_center().child(Input.new(this.pointsBox)))
        .child(iconButton(t, "points-save", "check", (cx) => this.savePoints(i, cx), { size: 24, spin: this.savingPoints, tooltip: "Save (Enter)" }))
        .child(iconButton(t, "points-cancel", "x", (cx) => this.cancelPoints(cx), { size: 24, tooltip: "Cancel (Esc)" })))
      .when(Boolean(this.pointsError), (e) => e.child(div().text_size(fs.tiny).text_color(t.ansi1).child(this.pointsError)));
  }
  sendComment(i, cx) {
    const text = this.commentBox.value().trim();
    if (!text || this.commenting) return;
    this.commenting = true; this.commentError = ""; cx.notify(this.pageView);
    cx.spawn(async (cx) => {
      try {
        const m = this.withMentions(text);
        await addComment(i.site, i.key, m.text, m.people, this.reply?.id ?? null);
        this.commentBox.set_value(""); this.named = new Map(); this.atUser = null; this.reply = null;
        notify({ title: `Comment added to ${i.key}`, level: "success", timeout: 2500 });
        // Every copy reloads the page of this issue (followChanges), this one too.
        setShared(CHANGED, { site: i.site, key: i.key, at: Date.now() });
      } catch (e) { this.commentError = String(e?.message ?? e); }
      this.commenting = false; cx.notify(this.pageView);
    });
  }

  // The Move menu of a Jira issue: a popup of this mod (transition.js) under the pointer.
  openMove(i, status) {
    openOverlay({ mod: "issues", kind: "popup", width: 300, props: { dialog: "transition", site: i.site, key: i.key, status } });
  }

  render(cx) {
    if (kitOff()) return offView();
    if (this.dialog) return this.dialog;
    this.followChanges(cx);
    this.followRowAction(cx);
    readSizes();
    if (this.open) this.watchAgents(cx, agentSpaces(this.repo?.main).issues.get(this.open.key));
    if (this.only) {
      // A page belongs to the space it was opened in: a space switch closes it.
      const now = activeSpace()?.id ?? null;
      if (this.onlySpace === undefined) this.onlySpace = now;
      else if (now !== this.onlySpace) { try { cx.timer.after(0, () => closeOverlay(props().overlay)); } catch { /* closes on the next change */ } }
      return pageDialog("issue-dialog", this.handle, this.pageView, { mod: "issues",
        step: (by, cx) => this.step(by, cx), key: (e, cx) => this.pageKey(e, cx), typing: () => this.typing,
        width: (w, cx) => { const was = this.pageW >= PAGE_WIDE; this.pageW = w; if (was !== (w >= PAGE_WIDE)) cx.notify(this.pageView); },
      });
    }
    // Order and Page are in the Settings tab of PowerMods (kit.json): the cog keeps Link space and Prompts.
    if (props()?.settings) return settingsMenu("issues", []);
    // A space switch shows that space's list in this very render, and loads it right after.
    const space = this.space();
    if ((space?.id ?? null) !== this.spaceId) {
      this.show(space, contextKey(space));
      try { cx.timer.after(0, (cx) => { if (this.stale) this.refresh(cx); }); } catch { /* the 1.5 s check loads it */ }
    }
    const inSplit = split(), full = pageMode("issues") === "full";
    if (inSplit !== this.wasSplit) {
      this.wasSplit = inSplit;
      if (this.open) try { cx.timer.after(0, (cx) => cx.notify(this.pageView)); } catch { /* shown on the next page change */ }
    }
    // In a dialog of the dock, the title row of the dialog shows the name and the ×: this header leaves them out.
    const t = theme(), overlay = props()?.overlay, dock = inDockDialog(), wide = this.width >= WIDE;
    const { items, total, keyW } = this.projects.length ? this.items() : { items: [], total: 0, keyW: 36 };
    const toggle = (id, label, _on, flip) => button(t, id, label, (cx) => { flip(cx); cx.notify(); });
    const unlinked = !this.loading && !this.error && !this.projects.length;
    const empty = this.signIn ? `Jira doesn't accept the sign-in for ${this.signIn}.` : this.error || (this.loading ? "Loading issues…" : unlinked ? "No issues linked to this space: link a Jira project or a GitHub repository." : this.issues.length ? (this.filter === "mentioned" && this.mentionsLoading ? "Loading…" : "Nothing matches.") : "No open issues.");
    const source = this.projects.map((p) => (isGithub(p) ? `GitHub ${p.repo}` : p.key)).join(", ")
      + (this.from === "guess" ? " (guessed)" : this.from === "file" ? " (.herdr/jira.toml)" : this.from === "default" ? " (default)" : "");
    const heading = (g) => h_flex().h(fs.head).flex_none().px(10).gap(6).items_end().text_size(fs.meta).text_color(t.dim)
      .child(div().font_semibold().child(g.label)).child(div().child(g.count));
    const s = { t, keyW, activeBg: t.accent + "30", two: this.width < ROOMY, keys: this.keys, cursor: this.cursor, agents: agentSpaces(this.repo?.main).issues };
    const issue = (key) => this.issues.find((x) => x.key === key);
    // A plain list, built once per render. A virtual list calls its row builder for every
    // frame drawn (hovering included), which made hovering lag; this one runs no script
    // between renders. SHOWN caps what a render builds.
    const [shownItems, windowed] = this.keyWindow(items, (i) => i.data?.key === this.cursor, s.two ? fs.row2 : fs.row);
    const list = v_flex().flex_1().min_w(0).min_h(0)
      .when(items.length > 0, (e) => e.child(v_flex().id(windowed ? "issue-list-keys" : "issue-list").w_full().flex_1().min_h(0).px(6).overflow_y_scrollbar()
        .children(shownItems.map((i) => (i.group ? heading(i.group) : this.row(i.data, i.depth, s).id(i.key)
          .on_click((_e, cx) => { const x = issue(i.data.key); if (x) { this.handle.focus(); this.pick(x, cx); } })
          // Right-click: Move, Open, Start agent, Copy key (row-menu.js).
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.rowMenu(i.data.key); })
          .on_hover((on, cx) => {
            if (!on) { if (this.hovered === i.data.key) this.hovered = null; return; }
            this.hovered = i.data.key; const x = issue(i.data.key); if (x) this.prefetch(x, cx);
          }))))))
      .when(total > SHOWN, (e) => e.child(div().px(10).py(4).text_size(fs.meta).text_color(t.dim).child(`Showing ${SHOWN} of ${total}: search to narrow`)))
      .when(this.capped && items.length > 0, (e) => e.child(div().px(10).py(4).text_size(fs.meta).text_color(t.dim).child(order() === "backlog" ? "Showing the first 500 issues of the backlog" : "Showing the 500 most recently updated issues")))
      .when(!items.length, (e) => e.child(v_flex().p(12).gap(8).items_start()
        .child(div().text_color(this.error ? t.ansi1 : t.dim).child(empty))
        .when(unlinked, (e) => e.child(toggle("link-empty", "Link this space", false, () => openLinkDialog("issues"))))
        .when(Boolean(this.signIn), (e) => e
          .child(div().text_size(fs.meta).text_color(t.muted).child(`Connect in Link space (email and a classic API token, stored in ${STORE[platform()]}), or set JIRA_EMAIL and JIRA_API_TOKEN, then Refresh.`))
          .child(h_flex().gap(6)
            .child(toggle("token-page", "API tokens ↗", false, () => openUrl(TOKEN_PAGE)))
            .child(toggle("sign-in-help", "Link space", false, () => openLinkDialog("issues")))))));
    const watching = this.projects.length > 0 && this.projects.every((p) => !isGithub(p));
    const filters = h_flex().child(segmented("filter", [["assigned", "Assigned"], ["created", "Created"], ["mentioned", watching ? "Watching" : "Mentioned"], ["recent", "Recent"]], this.filter, (id, cx) => {
      this.filter = id;
      if (this.filter === "mentioned" && !this.mentions && !this.mentionsLoading) this.loadMentions(cx);
    }, t));
    // Refresh (a spinner while loading), the cog and × in a window: the icon buttons of the kit.
    const search = div().min_w(0).px(8).py(3).rounded(6).border_1().border_color(t.input).text_size(fs.meta).child(Input.new(this.search));
    const close = iconButton(t, "close", "x", () => closeOverlay(overlay), { tooltip: "Close" });
    return v_flex().id("issues").relative().overflow_hidden().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(fs.body)
      .on_size_change((size, cx) => { this.height = size.height; this.resized(Math.round(size.width), cx); })
      .track_focus(this.handle)
      .on_mouse_down("left", () => { try { this.handle.focus(); } catch { /* best effort */ } })
      .on_key_down((e, cx) => {
        // The comment box has the keyboard: only Esc is the list's.
        if (this.typing && e.key !== "escape") return;
        // In a split Up and Down step through the issues, the page following along.
        if (this.open && inSplit && (e.key === "down" || e.key === "up")) { this.move(e.key === "down" ? 1 : -1, cx); const i = this.issues.find((x) => x.key === this.cursor); if (i) this.load(i, cx); }
        else if (this.open) { if (e.key === "escape") this.back(cx); else if (!this.pageKey(e, cx)) return; }
        else if (e.key === "down") this.move(1, cx);
        else if (e.key === "up") this.move(-1, cx);
        else if (e.key === "enter") this.enter(cx);
        else if (e.key === "escape" && overlay) closeOverlay(overlay);
        else return;
        cx.stop_propagation();
      })
      .when(Boolean(this.open) && full, (e) => e.child(this.pageView))
      .when(!this.open || !full, (e) => e.child(this.paged(inSplit, t, v_flex().flex_1().min_h(0).w_full()
      .child(v_flex().flex_none().px(12).py(8).gap(6).border_b(1).border_color(t.border)
        // A press here must not drag the window, but the list keeps the keyboard, so Esc still works
        // (the search field stops its own press and keeps it).
        .on_mouse_down("left", (_e, cx) => { try { this.handle.focus(); } catch { /* best effort */ } cx.stop_propagation(); })
        .child(h_flex().gap(8).items_center()
          .when(!dock, (e) => e.child(div().flex_none().font_semibold().child("Issues")))
          .when(Boolean(this.repo?.on), (e) => e.child(machineChip(t, this.repo.on)))
          .child(div().flex_1().min_w(0).text_size(fs.meta).text_color(t.dim).truncate().child(this.loading && this.issues.length ? `${source} · Refreshing…` : source))
          .when(wide, (e) => e.child(search.w(220)))
          .child(iconButton(t, "refresh", "refresh", (cx) => this.refresh(cx), { spin: this.loading, tooltip: "Refresh" }))
          .child(iconButton(t, "settings", "settings", () => openSettings("issues"), { tooltip: "Link space and prompts" }))
          .when(Boolean(overlay) && !dock, (e) => e.child(close)))
        .when(!wide, (e) => e.child(search.w_full()))
        .child(filters))
      .when(Boolean(this.error && this.issues.length), (e) => e.child(div().px(14).py(4).text_size(fs.meta).text_color(t.ansi1).child(this.error)))
      .child(v_flex().flex_1().min_h(0).child(list))
      .child(kit(t).footer([[["↑", "↓"], "move"], [["↵"], "open"], ...(overlay ? [[["Esc"], "close"]] : [])])))));
  }

  // A new width counts once it has held for 200 ms: a panel that opens or a divider that
  // moves reports every width on the way, and each switch between the narrow and the wide
  // layout made the list jump.
  // While the keys move the highlight, the list shows the rows from just above it (a plain
  // list can't be scrolled from script, and a virtual list made hovering lag). With the mouse,
  // or when the highlight is near the top, the whole list shows and scrolls as usual.
  keyWindow(items, isCursor, rowH) {
    if (!this.keys) { this.winStart = 0; return [items, false]; }
    const at = items.findIndex(isCursor);
    if (at < 0) return [items, false];
    const visible = Math.max(4, Math.floor(((this.height ?? 600) - 150) / rowH));
    let start = this.winStart ?? 0;
    if (at < start + 1) start = Math.max(0, at - 1);
    if (at > start + visible - 2) start = at - visible + 2;
    this.winStart = start;
    return [start > 0 ? items.slice(start) : items, start > 0];
  }

  resized(w, cx) {
    this.nextWidth = w;
    if (this.settling) return;
    this.settling = true;
    const apply = (cx) => { this.settling = false; if (this.nextWidth !== this.width) { this.width = this.nextWidth; keepWidth(this.width); cx.notify(); if (this.open) cx.notify(this.pageView); } };
    try { cx.timer.after(200, apply); } catch { apply(cx); }
  }

  // Split: the list on top and the open issue's page under it, in Herdr's own split.
  paged(inSplit, t, list) {
    return inSplit ? splitView("issue-page", list, this.pageView, Boolean(this.open), (cx) => this.back(cx)) : list;
  }


}
