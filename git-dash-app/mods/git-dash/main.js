// Git Dash for the Herdr app: the pending work of every Git repository under
// one base folder. Port of git-pendencias.py.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, shared, setShared, pickFolder, run } from "herdr";
import { findRepos, analyze, mapLimit, pending, severity, fixes, commitSteps, runSteps, show, MAX_REPOS } from "./git.js";
import { icon, mono, pill, searchBox, busy, filterChip, iconButton, button, smallButton, tint } from "./ui.js";

const KEY_ROOT = "git-dash.root";
// The saved folder is per panel: a copy with a `root` prop keeps its choice under
// "git-dash.root:<root>", so two panels with different roots do not share it.
// A copy without `root` keeps the old key.
const rootKey = (p) => (typeof p.root === "string" && p.root ? `${KEY_ROOT}:${p.root}` : KEY_ROOT);
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
    fix_commit: "Commit", fix_push: "Push", fix_pull: "Pull", fix_publish: "Publish to {remote}",
    openTab: "Terminal", openSpace: "New space", retryTab: "Run in terminal",
    openTabTip: "Open a terminal tab in this repository, in the current space, and run git status.",
    openSpaceTip: "Open this repository in a new space and run git status.",
    confirmRun: "Run this command?", confirmRunN: "Run these commands?", run: "Run", cancel: "Cancel", running: "Running…",
    commitPh: "Commit message (Enter to commit)", noMsg: "Type a commit message.",
    mode_staged: "Staged only", mode_tracked: "Tracked files", mode_all: "All, with new files",
    allWarn: "New files go into the commit too. Look at the file list before you commit.",
    done: "Done.", failed: "Failed.",
    manual: "Resolve by hand: {text}",
    m_error: "the repository cannot be read", m_conflicts: "conflicts", m_operation: "an operation in progress",
    m_detached: "detached HEAD", m_diverged: "the branch is ahead and behind its upstream",
    m_upstreamGone: "the upstream branch was removed", m_manyRemotes: "more than 1 remote and no origin",
    m_noRemote: "no remote", m_stash: "stash", m_otherBranches: "unpushed commits on other branches",
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
    fix_commit: "Commit", fix_push: "Push", fix_pull: "Pull", fix_publish: "Publicar em {remote}",
    openTab: "Terminal", openSpace: "Novo space", retryTab: "Rodar no terminal",
    openTabTip: "Abre uma aba de terminal neste repositório, no space atual, e roda git status.",
    openSpaceTip: "Abre este repositório em um novo space e roda git status.",
    confirmRun: "Rodar este comando?", confirmRunN: "Rodar estes comandos?", run: "Rodar", cancel: "Cancelar", running: "Rodando…",
    commitPh: "Mensagem do commit (Enter faz o commit)", noMsg: "Digite uma mensagem de commit.",
    mode_staged: "Só staged", mode_tracked: "Arquivos rastreados", mode_all: "Tudo, com arquivos novos",
    allWarn: "Os arquivos novos também entram no commit. Confira a lista de arquivos antes do commit.",
    done: "Feito.", failed: "Falhou.",
    manual: "Resolva à mão: {text}",
    m_error: "o repositório não pode ser lido", m_conflicts: "conflitos", m_operation: "uma operação em andamento",
    m_detached: "HEAD destacado", m_diverged: "a branch está à frente e atrás do upstream",
    m_upstreamGone: "o upstream foi removido", m_manyRemotes: "mais de 1 remoto e nenhum origin",
    m_noRemote: "sem remoto", m_stash: "stash", m_otherBranches: "commits não enviados em outras branches",
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
    this.rootKey = rootKey(this.props);
    const saved = shared(this.rootKey);
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

    // Fixes. Only one card at a time asks for a confirmation or a commit message.
    this.ask = null; // { path, kind: "confirm", fix } | { path, kind: "commit", mode }
    this.running = new Map(); // path -> label of the fix that runs
    this.result = new Map(); // path -> { ok, out, failed }
    this.msg = InputState.new({ placeholder: this.s("commitPh") });
    this.msg.on("change", (_e, cx) => cx.notify());
    this.msg.on("submit", (_e, cx) => this.commit(cx));

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
      this.ask = null; this.running.clear(); this.result.clear();
      this.root = dir; this.updated = 0; this.scanError = null;
      setShared(this.rootKey, dir);
      this.refresh(cx);
      cx.notify();
    });
  }

  toggleFetch(cx) {
    this.fetch = !this.fetch;
    setShared(KEY_FETCH, this.fetch);
    cx.notify();
  }

  // ---- fixes -------------------------------------------------------------

  /** Reads one repository again (its operations too), after a fix or a terminal. */
  refreshOne(path, cx) {
    const gen = this.gen, root = this.root;
    cx.spawn(async (cx) => {
      const found = await findRepos(path, 0).catch(() => null);
      const same = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const entry = found?.find((e) => same(e.path) === same(path))
        ?? { path, operations: this.repos.get(path)?.operations ?? [] };
      const r = await analyze({ path, operations: entry.operations }, root);
      if (gen !== this.gen || !this.repos.has(path)) return;
      this.repos.set(path, r);
      cx.notify();
    });
  }

  /** Starts a fix: a commit asks for a message, the other fixes ask for a confirmation. */
  startFix(r, fix, cx) {
    this.result.delete(r.path);
    if (fix.id === "commit") {
      const mode = r.staged ? "staged" : r.modified ? "tracked" : "all";
      this.ask = { path: r.path, kind: "commit", mode };
      this.msg.set_value("");
      this.msg.focus();
    } else {
      this.ask = { path: r.path, kind: "confirm", fix };
    }
    cx.notify();
  }

  execute(path, steps, label, cx) {
    this.ask = null;
    this.running.set(path, label);
    this.result.delete(path);
    cx.spawn(async (cx) => {
      const res = await runSteps(path, steps);
      this.running.delete(path);
      this.result.set(path, res);
      cx.notify();
      this.refreshOne(path, cx);
    });
    cx.notify();
  }

  commit(cx) {
    const a = this.ask;
    if (!a || a.kind !== "commit") return;
    const message = this.msg.value().trim();
    if (!message) { this.result.set(a.path, { ok: false, out: this.s("noMsg") }); cx.notify(); return; }
    this.execute(a.path, commitSteps(a.mode, message), this.s("fix_commit"), cx);
  }

  /** Opens the repository in a terminal tab of the current space, or in a new space. */
  openTerminal(r, where, cx, argv = ["git", "status"]) {
    const name = base(r.path);
    if (where === "space") run("space.new", { name, folder: r.path, argv });
    else run("tab.new", { name, folder: r.path, argv });
    // The person works in the terminal. Read the repository again later.
    for (const ms of [20000, 90000, 300000]) cx.timer.after(ms, (cx) => this.refreshOne(r.path, cx));
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

  /** The fix area of an open card: buttons, a confirmation or the commit form, then the result. */
  actions(r, fx, t) {
    const p = r.path, key = (s) => `${s}-${p}`;
    const label = this.running.get(p);
    const res = this.result.get(p);
    const ask = this.ask?.path === p ? this.ask : null;
    const code = (step) => div().w_full().truncate().font_family(mono()).text_size(11).text_color(t.foreground).child(show(step));
    const cancel = smallButton(t, key("gd-cancel"), this.s("cancel"), (cx) => { this.ask = null; cx.notify(); });
    const panel = (...kids) => v_flex().gap(6).p(8).rounded(8).bg(t.raised).border_1().border_color(t.border).children(kids);

    let main;
    if (label) {
      main = h_flex().gap(6).items_center().text_size(11).text_color(t.accent)
        .child(svg(icon("spinner")).size(12).flex_none().text_color(t.accent).spin(900))
        .child(`${label} · ${this.s("running")}`);
    } else if (ask?.kind === "confirm") {
      const { steps } = ask.fix;
      main = panel(
        div().text_size(11).text_color(t.muted).child(this.s(steps.length > 1 ? "confirmRunN" : "confirmRun")),
        ...steps.map(code),
        h_flex().gap(6)
          .child(smallButton(t, key("gd-run"), this.s("run"), (cx) => this.execute(p, steps, this.s(`fix_${ask.fix.id}`, { remote: ask.fix.remote }), cx), { tone: "primary" }))
          .child(cancel));
    } else if (ask?.kind === "commit") {
      const modes = [r.staged && "staged", r.modified && "tracked", r.untracked && "all"].filter(Boolean);
      const message = this.msg.value().trim();
      main = panel(
        h_flex().id(key("gd-msg")).h(30).px(10).items_center().rounded(7).bg(t.background).border_1().border_color(t.input).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.msg).h_full().flex_1().min_w(0).text_size(12).text_color(t.foreground)),
        h_flex().flex_wrap().gap(4).children(modes.map((m) =>
          smallButton(t, key(`gd-mode-${m}`), this.s(`mode_${m}`), (cx) => { ask.mode = m; cx.notify(); },
            { tone: ask.mode === m ? (m === "all" ? "danger" : "primary") : "" }))),
        ...(ask.mode === "all" ? [div().text_size(11).text_color(t.ansi1).child(this.s("allWarn"))] : []),
        ...commitSteps(ask.mode, message || "…").map(code),
        h_flex().gap(6)
          .child(smallButton(t, key("gd-commit"), this.s("fix_commit"), (cx) => this.commit(cx), { tone: "primary", disabled: !message }))
          .child(cancel));
    } else {
      main = h_flex().flex_wrap().gap(6)
        .children(fx.auto.map((f) => smallButton(t, key(`gd-fix-${f.id}`), this.s(`fix_${f.id}`, { remote: f.remote }),
          (cx) => this.startFix(r, f, cx), { tone: "primary" })))
        .child(smallButton(t, key("gd-tab"), this.s("openTab"), (cx) => this.openTerminal(r, "tab", cx),
          { symbol: "terminal", tooltip: this.s("openTabTip") }))
        .child(smallButton(t, key("gd-space"), this.s("openSpace"), (cx) => this.openTerminal(r, "space", cx),
          { tooltip: this.s("openSpaceTip") }));
    }

    const tail = res ? res.out.split("\n").filter(Boolean).slice(-4) : [];
    return v_flex().id(key("gd-act")).pl(16).pt(4).gap(6)
      .on_click((_e, cx) => cx.stop_propagation())
      .when(fx.manual.length > 0, (e) => e.child(div().text_size(11).text_color(t.ansi3)
        .child(this.s("manual", { text: fx.manual.map((m) => this.s(`m_${m}`)).join(", ") }))))
      .child(main)
      .when(Boolean(res), (e) => e.child(v_flex().gap(2).p(8).rounded(8).bg(tint(res.ok ? t.ansi2 : t.ansi1, "14"))
        .child(div().text_size(11).font_semibold().text_color(res.ok ? t.ansi2 : t.ansi1).child(this.s(res.ok ? "done" : "failed")))
        .children(tail.map((line) => div().w_full().truncate().font_family(mono()).text_size(10).text_color(t.muted).child(line)))
        .when(!res.ok && Boolean(res.failed), (x) => x.child(h_flex().pt(4).child(
          smallButton(t, key("gd-retry"), this.s("retryTab"), (cx) => this.openTerminal(r, "tab", cx, ["git", ...res.failed]),
            { symbol: "terminal", tone: "danger" }))))));
  }

  repoCard(r, t) {
    const open = this.open.has(r.path);
    const fx = fixes(r);
    const expandable = Boolean(r.error) || r.files.length > 0 || fx.auto.length > 0 || pending(r) || this.result.has(r.path);
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
      .when(open && expandable && r.files.length > 0, (e) => e.child(v_flex().pl(16).pt(2)
        .children(r.files.slice(0, MAX_FILES).map((f) => this.fileRow(f, t)))
        .when(r.files.length > MAX_FILES, (x) => x.child(div().h(20).text_size(11).text_color(t.dim).child(this.s("moreFiles", { n: r.files.length - MAX_FILES }))))))
      .when(open && expandable, (e) => e.child(this.actions(r, fx, t)));
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
