// The GitHub tab of the list: a search over all public repositories of
// GitHub (`gh search repos`, with the gh of the source machine). The text
// goes to the search after a pause in the typing; it takes the search
// qualifiers of GitHub, and chips write the common ones. The clone step is
// the same as for the repositories of the account.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { searchRepos } from "./gh.js";
import { memory, machineLabel, HEAD_H, FOOT_H, ROW_H } from "./common.js";
import { icon, tint, hint, button, iconButton, segmented, chip } from "./ui.js";
import { DEMO } from "./demo.js";
import { openUrl, repoUrl } from "./sys.js";

const PAUSE_MS = 600; // the search starts after this pause in the typing
const STEP = 30; // results for each "More"
const MAX = 100;

const SORTS = [
  { value: "", label: "Best match", tooltip: "The order of GitHub" },
  { value: "stars", label: "Stars", tooltip: "Most stars first" },
  { value: "updated", label: "Updated", tooltip: "Recently updated first" },
];

// Chips that write a qualifier into the search text. A qualifier that ends
// with ":" waits for its value; a full one starts the search.
const QUALIFIERS = [
  { id: "language", text: "language:", tooltip: "A language, for example language:go" },
  { id: "topic", text: "topic:", tooltip: "A topic (a tag of the repository), for example topic:cli" },
  { id: "org", text: "org:", tooltip: "The repositories of an organization, for example org:vercel" },
  { id: "user", text: "user:", tooltip: "The repositories of a user, for example user:torvalds" },
  { id: "stars", text: "stars:>100", tooltip: "More than 100 stars (change the number)" },
];

/** A count for people: 950, 1.2k, 34k, 1.1M. */
function short(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1e6) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
}

export const searchMethods = {
  initSearch() {
    // Kept between openings: the last search and its results.
    memory.search ??= { text: "", sort: "", limit: STEP, results: null, error: null, ran: null };
    const s = memory.search;
    this.searchAt = 0;
    this.searchScroll = 0;
    this.searchVersion = 0;
    this.searchRun = 0;
    this.searching = false;
    this.searchInput = InputState.new({ placeholder: "Search GitHub: words, topic:cli, org:vercel, language:go…", value: s.text });
    this.searchInput.on("change", (_e, cx) => {
      s.text = this.searchInput.value();
      s.limit = STEP;
      this.scheduleSearch(cx);
      cx.notify();
    });
    this.searchInput.on("submit", (_e, cx) => {
      if (this.searchStale()) this.runSearch(cx);
      else this.choose(this.searchRows()[this.searchAt]?.repo, cx);
    });
  },

  setTab(tab, cx) {
    if (tab === this.tab) return;
    this.tab = tab;
    memory.tab = tab;
    this.focusQuery(cx);
    if (tab === "github" && this.searchStale() && memory.search.text.trim()) this.runSearch(cx);
    cx.notify();
  },

  /** The text, the order, the size or the machine changed since the last search. */
  searchStale() {
    const s = memory.search;
    const r = s.ran;
    return !r || r.text !== s.text.trim() || r.sort !== s.sort || r.limit !== s.limit || r.machine !== this.machine;
  },

  scheduleSearch(cx) {
    const v = ++this.searchVersion;
    cx.timer.after(PAUSE_MS, (cx) => {
      if (v === this.searchVersion && this.tab === "github" && this.view === "list") this.runSearch(cx);
    });
  },

  /** Runs the search now. `more`: the same search with more results (the selection stays). */
  runSearch(cx, { more = false } = {}) {
    const s = memory.search;
    const text = s.text.trim();
    const machine = this.machine;
    const ran = { text, sort: s.sort, limit: s.limit, machine };
    if (!text) {
      s.results = null;
      s.error = null;
      s.ran = ran;
      this.searching = false;
      cx.notify();
      return;
    }
    if (memory.demo) {
      s.results = DEMO.search;
      s.error = null;
      s.ran = ran;
      cx.notify();
      return;
    }
    const v = ++this.searchRun;
    this.searching = true;
    cx.spawn(async (cx) => {
      try {
        const list = await searchRepos(machine, text, { sort: ran.sort, limit: ran.limit });
        if (v !== this.searchRun) return;
        s.results = list;
        s.error = null;
        if (!more) {
          this.searchAt = 0;
          this.searchScroll = 0;
        }
      } catch (e) {
        if (v !== this.searchRun) return;
        s.error = { kind: e?.kind ?? "error", message: String(e?.message ?? e) };
      } finally {
        if (v === this.searchRun) {
          s.ran = ran;
          this.searching = false;
        }
        cx.notify();
      }
    });
    cx.notify();
  },

  moreResults(cx) {
    const s = memory.search;
    s.limit = Math.min(MAX, s.limit + STEP);
    this.runSearch(cx, { more: true });
  },

  setSort(value, cx) {
    memory.search.sort = value;
    memory.search.limit = STEP;
    this.runSearch(cx);
    this.focusQuery(cx);
  },

  /** Writes a qualifier at the end of the search text, with the cursor after it. */
  addQualifier(q, cx) {
    const s = memory.search;
    const cur = this.searchInput.value();
    const next = `${cur}${cur && !/\s$/.test(cur) ? " " : ""}${q.text}`;
    this.searchInput.set_value(next);
    this.searchInput.set_selected_range({ start: next.length, end: next.length });
    s.text = next;
    s.limit = STEP;
    if (!q.text.endsWith(":")) this.scheduleSearch(cx);
    this.focusQuery(cx);
    cx.notify();
  },

  clearSearch(cx) {
    this.searchInput.set_value("");
    memory.search.text = "";
    memory.search.limit = STEP;
    this.runSearch(cx);
    this.focusQuery(cx);
  },

  searchRows() {
    return (memory.search.results ?? []).map((repo) => ({ repo, match: null, status: this.repoStatus(repo) }));
  },

  searchKey(e, cx) {
    const k = e.key;
    const m = e.modifiers ?? {};
    const ctrl = m.control || m.platform;
    const rows = this.searchRows();
    if (k === "down" || k === "up") {
      if (!rows.length) return;
      this.searchAt = (this.searchAt + (k === "down" ? 1 : rows.length - 1)) % rows.length;
      this.follow = true;
    } else if (k === "pagedown" || k === "pageup") {
      if (!rows.length) return;
      this.searchAt = Math.max(0, Math.min(rows.length - 1, this.searchAt + (k === "pagedown" ? 8 : -8)));
      this.follow = true;
    } else if (ctrl && k === "r") {
      this.runSearch(cx, { more: true });
    } else if (ctrl && k === "o") {
      const repo = rows[this.searchAt]?.repo;
      if (repo) openUrl(repoUrl(repo.full));
    } else return;
    cx.stop_propagation();
    cx.notify();
  },

  renderSearch(t) {
    const s = memory.search;
    const rows = this.searchRows();
    if (this.searchAt >= rows.length) this.searchAt = Math.max(0, rows.length - 1);
    const where = machineLabel(this.machine);
    const text = s.text.trim();
    const stale = this.searchStale();

    const head = this.header(t, "Clone a repository", `Search all of GitHub with the gh of ${where}`, {
      leading: this.brandTile(t),
      trailing: [
        this.tabSwitch(t),
        iconButton(t, "gc-search-again", "refresh", (cx) => this.runSearch(cx, { more: true }), { tooltip: "Search again (Ctrl+R)", spin: this.searching }),
      ],
    });

    const picker = this.machinePicker(t);
    const search = h_flex().mx(16).mt(12).h(40).flex_none().px(12).gap(10).items_center().rounded(10)
      .bg(t.background).border_1().border_color(tint(t.accent, "99"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(this.searching
        ? svg(icon("spinner")).size(15).text_color(t.accent).spin(900)
        : svg(icon("globe")).size(15).text_color(t.accent))
      .child(Input.new(this.searchInput).flex_1().h_full().text_size(13.5).text_color(t.foreground))
      .when(Boolean(s.text), (e) => e.child(h_flex().id("gc-search-clear").size(20).flex_none().items_center().justify_center().rounded(5)
        .cursor_pointer().hover((st) => st.bg(t.hover)).tooltip("Clear")
        .on_click((_e, cx) => this.clearSearch(cx))
        .child(svg(icon("close")).size(11).text_color(t.muted))))
      .when(Boolean(picker), (e) => e.child(picker));

    const chips = h_flex().mx(16).mt(10).flex_none().gap(10).items_start()
      .child(h_flex().flex_1().min_w(0).flex_wrap().gap(6)
        .child(div().pt(4).text_size(11).text_color(t.dim).child("Add:"))
        .children(QUALIFIERS.map((q) => chip(t, `gc-q-${q.id}`, q.text, false, (cx) => this.addQualifier(q, cx), { tooltip: q.tooltip }))))
      .child(segmented(t, "gc-sort", SORTS, s.sort, (v, cx) => this.setSort(v, cx)));

    const listH = this.listBoxH ?? Math.max(120, this.height() - HEAD_H - FOOT_H - 52 - 34 - 18);
    let content;
    if (!text) {
      content = this.emptyState(t, "globe", "Search all public repositories of GitHub",
        "Type words of the name or the description. Qualifiers work too: topic:cli, org:vercel, user:torvalds, language:rust, stars:>500, -topic:deprecated. Then pick a repository and clone it as usual.", null, listH);
    } else if (s.error && (!rows.length || stale)) {
      content = s.error.kind === "error"
        ? this.emptyState(t, "alert", "The search failed", s.error.message, button(t, "gc-search-retry", "Search again", (cx) => this.runSearch(cx), { symbol: "refresh" }), listH)
        : this.errorState(t, s.error, listH);
    } else if (!s.results && this.searching) {
      content = this.emptyState(t, null, `Searching GitHub for “${text}”…`, "", null, listH);
    } else if (!rows.length && !this.searching && !stale) {
      content = this.emptyState(t, "search", `No repository matches “${text}”`, "Try fewer words, or another qualifier.", null, listH);
    } else if (!rows.length) {
      content = this.emptyState(t, null, `Searching GitHub for “${text}”…`, "", null, listH);
    } else {
      const canMore = !stale && s.results.length >= s.limit && s.limit < MAX;
      const items = canMore ? [...rows, { more: true }] : rows;
      const scroll = { get: () => this.searchScroll, set: (v) => { this.searchScroll = v; } };
      content = div().opacity(this.searching ? 0.6 : 1).child(this.scrollList(t, items, ROW_H, listH, this.searchAt, (r, i) => (r.more
        ? h_flex().h(ROW_H).items_center().justify_center()
          .child(button(t, "gc-more", `More results (up to ${Math.min(MAX, s.limit + STEP)})`, (cx) => this.moreResults(cx), { symbol: "plus" }))
        : this.repoRow(t, r, i === this.searchAt, i, () => { this.searchAt = i; })), scroll));
    }

    const count = rows.length ? `${rows.length} result${rows.length === 1 ? "" : "s"}${s.ran?.sort ? ` · by ${s.ran.sort}` : ""}` : "";
    const footer = h_flex().h(FOOT_H).flex_none().px(16).gap(14).items_center().border_t(1).border_color(t.border).bg(t.chrome ?? t.popover)
      .child(hint(t, ["↑", "↓"], "move"))
      .child(hint(t, ["↵"], "clone"))
      .child(hint(t, ["Ctrl+G"], "your repos"))
      .child(hint(t, ["Ctrl+O"], "GitHub"))
      .child(div().flex_1())
      .child(div().text_size(11).text_color(t.dim).child(memory.demo ? "Demo data" : this.searching ? "Searching…" : count));

    return v_flex().size_full().min_h(0)
      .child(head)
      .child(search)
      .child(chips)
      .child(this.listArea(content))
      .child(footer);
  },

  /** The star count of a search result, for the right side of its row. */
  starsLabel(t, repo) {
    if (repo.stars == null) return null;
    return h_flex().gap(3).items_center().text_size(11).text_color(t.muted)
      .child(svg(icon("star")).size(11).text_color(t.muted))
      .child(short(repo.stars));
  },
};

