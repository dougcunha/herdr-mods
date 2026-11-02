// Git Dash for the Herdr app: the pending work of every Git repository under
// one base folder. Port of git-pendencias.py.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import { theme, props, shared, setShared, pickFolder } from "herdr";
import { findRepos, analyze, mapLimit, pending, severity, MAX_REPOS } from "./git.js";
import { icon, mono, pill, searchBox, busy, filterChip, iconButton, button } from "./ui.js";

const KEY_ROOT = "git-dash.root";
const KEY_FETCH = "git-dash.fetch";
const WORKERS = 12; // repositories analyzed at once
const AUTO_MS = 5 * 60 * 1000; // a silent refresh when the data is this old
const MAX_FILES = 12;

const STR = {
  en: {
    title: "Git Dash", choose: "Choose folder", refresh: "Refresh",
    pickTitle: "Choose a folder with your repositories",
    pickHint: "Git Dash looks for Git repositories inside it, up to {depth} levels deep, and shows what is pending in each one.",
    pickPrompt: "Use this folder",
    pending: "Pending", clean: "Clean", errors: "Errors", all: "All",
    repos: "{n} repositories", withPending: "{n} with pending",
    scanning: "Scanning folders…", analyzing: "Analyzing {done}/{total}", updated: "Updated {t}",
    allClean: "All repositories are clean.", none: "No Git repository found.", noMatch: "No repository matches the filter.",
    noneHint: "Look in {root}, up to {depth} levels deep.", filterPh: "Filter repositories…",
    moreFiles: "… {n} more file(s)", fetchTipOn: "Fetch on refresh: ON. Refresh runs git fetch first, so “behind” counts are current. Slower. Click to turn off.",
    fetchTipOff: "Fetch on refresh: OFF. Refresh reads local data only (fast). Click to run git fetch on refresh and update “behind” counts.",
    unpushed: "{n} unpushed", staged: "{n} staged", modified: "{n} modified", untracked: "{n} new",
    stash: "{n} stash", conflicts: "{n} conflicts", behind: "↓{n} behind", operation: "{op} in progress",
    noRemote: "No remote", noUpstream: "Branch has no upstream", upstreamGone: "Upstream branch was removed",
    detachedCommits: "Detached HEAD with {n} unpushed commit(s)", aheadOfUpstream: "↑{n} ahead of upstream",
    otherBranches: "Other branches: {text}", fetchFailed: "Fetch failed", logFailed: "Could not list unpushed commits",
    capped: "Only the first {n} repositories show.",
    now: "just now", ago: "{n}m ago", agoH: "{n}h ago",
  },
  pt: {
    title: "Git Dash", choose: "Escolher pasta", refresh: "Atualizar",
    pickTitle: "Escolha a pasta dos seus repositórios",
    pickHint: "O Git Dash procura repositórios Git dentro dela, até {depth} níveis, e mostra as pendências de cada um.",
    pickPrompt: "Usar esta pasta",
    pending: "Pendentes", clean: "Limpos", errors: "Erros", all: "Todos",
    repos: "{n} repositórios", withPending: "{n} com pendência",
    scanning: "Procurando pastas…", analyzing: "Analisando {done}/{total}", updated: "Atualizado {t}",
    allClean: "Todos os repositórios estão limpos.", none: "Nenhum repositório Git encontrado.", noMatch: "Nenhum repositório combina com o filtro.",
    noneHint: "Busca em {root}, até {depth} níveis.", filterPh: "Filtrar repositórios…",
    moreFiles: "… mais {n} arquivo(s)", fetchTipOn: "Fetch ao atualizar: LIGADO. O refresh roda git fetch antes, então “atrás” fica em dia. Mais lento. Clique para desligar.",
    fetchTipOff: "Fetch ao atualizar: DESLIGADO. O refresh lê só dados locais (rápido). Clique para rodar git fetch no refresh e atualizar “atrás”.",
    unpushed: "{n} não enviado(s)", staged: "{n} staged", modified: "{n} modificado(s)", untracked: "{n} novo(s)",
    stash: "{n} stash", conflicts: "{n} conflitos", behind: "↓{n} atrás", operation: "{op} em andamento",
    noRemote: "Sem remoto", noUpstream: "Branch sem upstream", upstreamGone: "Upstream removido",
    detachedCommits: "HEAD destacado com {n} commit(s) não enviados", aheadOfUpstream: "↑{n} à frente do upstream",
    otherBranches: "Outras branches: {text}", fetchFailed: "Fetch falhou", logFailed: "Falha ao listar commits não enviados",
    capped: "Só os primeiros {n} repositórios aparecem.",
    now: "agora", ago: "há {n} min", agoH: "há {n} h",
  },
};

const fill = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? ""));
const base = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

export default class GitDash extends View {
  init(given, cx) {
    // Read props once, here, and keep them: props() inside a later callback can
    // answer for another copy. Fall back to props() when the argument is empty.
    this.props = (given && Object.keys(given).length ? given : props()) || {};
    this.lang = STR[this.props.lang] ? this.props.lang : "en";
    this.depth = Number.isInteger(this.props.depth) && this.props.depth >= 0 ? this.props.depth : 4;
    // The folder the person chose (saved) wins over the `root` prop, which is only the first guess.
    const saved = shared(KEY_ROOT);
    this.root = (typeof saved === "string" && saved) || (typeof this.props.root === "string" && this.props.root) || null;
    this.fetch = typeof this.props.fetch === "boolean" ? this.props.fetch : shared(KEY_FETCH) === true;

    this.repos = new Map(); // path -> result of analyze()
    this.gen = 0; // bumps when a run must be ignored (a new folder was chosen)
    this.loading = false;
    this.scanning = false;
    this.progress = { done: 0, total: 0 };
    this.scanError = null;
    this.capped = false;
    this.updated = 0;
    this.filter = "pending";
    this.open = new Set();
    this.query = InputState.new({ placeholder: this.s("filterPh") });
    this.query.on("change", (_e, cx) => cx.notify());

    cx.timer.every(30000, (cx) => this.tick(cx));
    if (this.root) this.refresh(cx);
  }

  s(key, vars) { return fill(STR[this.lang][key] ?? key, vars); }

  // ---- data --------------------------------------------------------------

  tick(cx) {
    if (this.root && !this.loading && this.updated && Date.now() - this.updated >= AUTO_MS) this.refresh(cx);
    else cx.notify(); // keeps "Updated 3m ago" fresh
  }

  refresh(cx) {
    if (!this.root || this.loading) return;
    const gen = ++this.gen, root = this.root, fetch = this.fetch;
    this.loading = true; this.scanning = true; this.scanError = null;
    this.progress = { done: 0, total: 0 };
    cx.spawn(async (cx) => {
      try {
        const paths = await findRepos(root, this.depth);
        if (gen !== this.gen) return;
        this.capped = paths.length >= MAX_REPOS;
        this.scanning = false;
        this.progress = { done: 0, total: paths.length };
        cx.notify();
        await mapLimit(paths, WORKERS, async (entry) => {
          const r = await analyze(entry, root, { fetch });
          if (gen !== this.gen) return;
          this.repos.set(entry.path, r);
          this.progress.done += 1;
          cx.notify();
        });
        if (gen !== this.gen) return;
        const seen = new Set(paths.map((p) => p.path));
        for (const k of [...this.repos.keys()]) if (!seen.has(k)) this.repos.delete(k);
        this.updated = Date.now();
      } catch (e) {
        if (gen === this.gen) this.scanError = String(e?.message || e);
      } finally {
        if (gen === this.gen) { this.loading = false; this.scanning = false; }
        cx.notify();
      }
    });
    cx.notify();
  }

  chooseFolder(cx) {
    cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: this.s("pickPrompt") }).catch(() => null);
      if (!dir) return;
      this.gen += 1; this.loading = false; this.repos.clear(); this.open.clear();
      this.root = dir; this.updated = 0; this.scanError = null;
      setShared(KEY_ROOT, dir);
      this.refresh(cx);
      cx.notify();
    });
  }

  toggleFetch(cx) {
    this.fetch = !this.fetch;
    setShared(KEY_FETCH, this.fetch);
    cx.notify();
  }

  // ---- formatting --------------------------------------------------------

  age() {
    if (!this.updated) return "";
    const m = Math.floor((Date.now() - this.updated) / 60000);
    if (m < 1) return this.s("now");
    return m < 60 ? this.s("ago", { n: m }) : this.s("agoH", { n: Math.floor(m / 60) });
  }

  noteText(n) {
    return this.s(n.id, { n: n.n, text: n.text });
  }

  sevColor(r, t) {
    if (r.error) return t.ansi1;
    return { 5: t.ansi1, 4: t.ansi1, 3: t.ansi3, 2: t.ansi6, 1: t.ansi5, 0: t.ansi2 }[severity(r)];
  }

  // ---- views -------------------------------------------------------------

  header(t) {
    return h_flex().h(40).flex_none().px(12).gap(6).items_center()
      .child(svg(icon("repos")).size(16).flex_none().text_color(t.accent))
      .child(div().font_semibold().flex_none().child(this.s("title")))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.root ? base(this.root) : ""))
      .child(iconButton(t, "gd-fetch", "download", (cx) => this.toggleFetch(cx),
        { active: this.fetch, tooltip: this.s(this.fetch ? "fetchTipOn" : "fetchTipOff") }))
      .child(iconButton(t, "gd-folder", "folder", (cx) => this.chooseFolder(cx), { tooltip: this.s("choose") }))
      .child(iconButton(t, "gd-refresh", "refresh", (cx) => this.refresh(cx),
        { disabled: !this.root, spin: this.loading, tooltip: this.s("refresh") }));
  }

  /** `12 repositories · 5 with pending` on the left, the progress or age on the right. */
  summary(t, list) {
    const withPending = list.filter((r) => !r.error && pending(r)).length;
    const state = this.scanning ? this.s("scanning")
      : this.loading ? this.s("analyzing", this.progress)
      : this.updated ? this.s("updated", { t: this.age() }) : "";
    return h_flex().flex_none().px(14).pb(2).gap(8).items_center().text_size(11).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().child(`${this.s("repos", { n: list.length })} · ${this.s("withPending", { n: withPending })}`))
      .child(div().flex_none().text_color(this.loading ? t.accent : t.dim).child(state));
  }

  pills(r, t) {
    const items = [];
    if (r.branch) items.push(pill(t, { label: r.branch, symbol: "branch", code: true }));
    for (const op of r.operations) items.push(pill(t, { label: this.s("operation", { op }), color: t.ansi1 }));
    if (r.conflicts) items.push(pill(t, { label: this.s("conflicts", { n: r.conflicts }), color: t.ansi1 }));
    if (r.unpushed) items.push(pill(t, { label: this.s("unpushed", { n: r.unpushed }), color: t.ansi1 }));
    if (r.staged) items.push(pill(t, { label: this.s("staged", { n: r.staged }), color: t.ansi2 }));
    if (r.modified) items.push(pill(t, { label: this.s("modified", { n: r.modified }), color: t.ansi3 }));
    if (r.untracked) items.push(pill(t, { label: this.s("untracked", { n: r.untracked }), color: t.ansi6 }));
    if (r.stash) items.push(pill(t, { label: this.s("stash", { n: r.stash }), color: t.ansi5 }));
    if (r.behind) items.push(pill(t, { label: this.s("behind", { n: r.behind }), color: t.ansi4 }));
    return items;
  }

  fileRow(f, t) {
    const color = f.state === "UU" ? t.ansi1 : f.state === "??" ? t.ansi6 : f.state[0] !== " " ? t.ansi2 : t.ansi3;
    return h_flex().h(20).flex_none().gap(8).items_center().text_size(11)
      .child(div().w(18).flex_none().font_family(mono()).text_color(color).child(f.state.trim() || "·"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(f.path));
  }

  repoCard(r, t) {
    const open = this.open.has(r.path);
    const expandable = !r.error && r.files.length > 0;
    const notes = r.notes.map((n) => this.noteText(n));
    return v_flex().id(`repo-${r.path}`).w_full().flex_none().px(14).py(9).gap(6).border_b(1).border_color(t.border)
      .when(expandable, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => {
        if (this.open.has(r.path)) this.open.delete(r.path); else this.open.add(r.path);
        cx.notify();
      }))
      .child(h_flex().gap(8).items_center()
        .child(div().size(8).rounded(4).flex_none().bg(this.sevColor(r, t)))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(r.name))
        .when(expandable, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(open ? "▾" : "▸"))))
      .when(Boolean(r.error), (e) => e.child(div().pl(16).text_size(11).text_color(t.ansi1).child(r.error)))
      .when(!r.error, (e) => e.child(h_flex().pl(16).flex_wrap().gap(6).items_center().children(this.pills(r, t))))
      .when(notes.length > 0, (e) => e.child(div().pl(16).text_size(11).text_color(t.dim).child(notes.join(" · "))))
      .when(open && expandable, (e) => e.child(v_flex().pl(16).pt(2)
        .children(r.files.slice(0, MAX_FILES).map((f) => this.fileRow(f, t)))
        .when(r.files.length > MAX_FILES, (x) => x.child(div().h(20).text_size(11).text_color(t.dim).child(this.s("moreFiles", { n: r.files.length - MAX_FILES }))))));
  }

  emptyState(t, title, detail, withButton = false) {
    return v_flex().flex_1().min_h(0).items_center().justify_center().gap(10).p(24)
      .child(div().size(44).rounded(12).flex().items_center().justify_center().bg(t.raised)
        .child(svg(icon("repos")).size(22).text_color(t.accent)))
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child(title))
      .when(Boolean(detail), (e) => e.child(div().max_w(300).text_size(12).text_color(t.dim).text_center().child(detail)))
      .when(withButton, (e) => e.child(button(t, "gd-pick", this.s("choose"), (cx) => this.chooseFolder(cx), { primary: true })));
  }

  body(t) {
    if (!this.root) return this.emptyState(t, this.s("pickTitle"), this.s("pickHint", { depth: this.depth }), true);
    if (this.scanError && !this.repos.size) return this.emptyState(t, this.scanError, this.root, true);
    if (this.scanning && !this.repos.size) return busy(t, this.s("scanning"), this.root);
    if (!this.repos.size && !this.loading) {
      return this.emptyState(t, this.s("none"), this.s("noneHint", { root: this.root, depth: this.depth }), true);
    }
    if (!this.repos.size) return busy(t, this.s("analyzing", this.progress), this.root);

    const all = [...this.repos.values()];
    const bad = all.filter((r) => r.error);
    const todo = all.filter((r) => !r.error && pending(r))
      .sort((a, b) => severity(b) - severity(a) || a.name.localeCompare(b.name));
    const clean = all.filter((r) => !r.error && !pending(r)).sort((a, b) => a.name.localeCompare(b.name));
    bad.sort((a, b) => a.name.localeCompare(b.name));

    const q = this.query.value().trim().toLowerCase();
    const hit = (r) => !q || `${r.name} ${r.branch}`.toLowerCase().includes(q);
    const pools = { pending: todo, clean, errors: bad, all: [...todo, ...clean, ...bad] };
    const shown = pools[this.filter].filter(hit);

    const chip = (id, label, count, color) =>
      filterChip(t, `gd-f-${id}`, label, count, this.filter === id, (cx) => { this.filter = id; cx.notify(); }, color);
    const chips = [chip("pending", this.s("pending"), todo.length, t.ansi3), chip("clean", this.s("clean"), clean.length, t.ansi2)];
    if (bad.length || this.filter === "errors") chips.push(chip("errors", this.s("errors"), bad.length, t.ansi1));
    chips.push(chip("all", this.s("all"), all.length));

    let empty = null;
    if (!shown.length) {
      empty = q ? this.s("noMatch") : this.filter === "pending" ? this.s("allClean") : this.s("noMatch");
    }

    return v_flex().flex_1().min_h(0)
      .child(this.summary(t, all))
      .child(v_flex().flex_none().px(12).pt(6).pb(8).gap(8)
        .child(searchBox(t, "gd-query", this.query, {
          right: q ? `${shown.length}/${pools[this.filter].length}` : "",
          onClear: (cx) => { this.query.set_value(""); cx.notify(); },
        }))
        .child(h_flex().flex_wrap().gap(4).children(chips)))
      .child(v_flex().id("gd-scroll").flex_1().min_h(0).overflow_y_scrollbar().border_t(1).border_color(t.border)
        .children(shown.map((r) => this.repoCard(r, t)))
        .when(Boolean(empty), (e) => e.child(div().p(16).text_size(12).text_color(t.dim).child(empty)))
        .when(this.capped, (e) => e.child(div().px(14).py(8).text_size(11).text_color(t.blocked).child(this.s("capped", { n: MAX_REPOS })))));
  }

  render(_cx) {
    const t = theme();
    return v_flex().id("git-dash").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(this.header(t))
      .child(this.body(t));
  }
}
