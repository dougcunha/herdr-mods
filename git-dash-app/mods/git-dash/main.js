// Git Dash for the Herdr app: the pending work of every Git repository under
// one or more base folders. Port of git-pendencias.py.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, shared, setShared, pickFolder, run, panes, spaces, layout, openOverlay, notify, home, nextCommand, closeOverlay } from "herdr";
import { findRepos, analyze, mapLimit, pending, severity, fixes, commitSteps, runSteps, removedBy, samePath, show, MAX_REPOS } from "./git.js";
import { icon, mono, pill, searchBox, busy, filterChip, iconButton, button, smallButton, tint, dialogKeys } from "./ui.js";
import { WtTab, WT_STR } from "./wt-view.js";

// The mods-hub can turn this mod off (shared "herdr-mods.disabled", a list of mod names). Then the mod draws
// nothing, closes its dialog and skips its timed work. The bars hide its blocks and buttons.
const kitOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes("git-dash"); };
const offView = () => { const o = props()?.overlay; if (o) closeOverlay(o); return div(); };
// The Git button opens the git-client mod: it shows only while that kit mod is on.
const gitOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes("git-client"); };
/** The first node of a layout tree with the id `id`, and its parent. */
const findNode = (node, id, parent = null) => {
  if (!node) return null;
  if (node.id === id) return { node, parent };
  for (const c of node.children ?? []) { const hit = findNode(c, id, node); if (hit) return hit; }
  return null;
};
/** True when a block of the tree shows the mod `mod`. */
const hasMod = (node, mod) => Boolean(node) && (node.content?.mod === mod || (node.children ?? []).some((c) => hasMod(c, mod)));

// The base folders: one list for every copy of the panel, with forward slashes.
const KEY_ROOTS = "git-dash.roots";
// The single folder of older versions. A copy with a `root` prop kept its choice
// under "git-dash.root:<root>", a copy without it under "git-dash.root". These
// keys are read once, when "git-dash.roots" does not exist yet, and never written.
const KEY_ROOT = "git-dash.root";
const oldRootKey = (p) => (typeof p.root === "string" && p.root ? `${KEY_ROOT}:${p.root}` : KEY_ROOT);
const KEY_FETCH = "git-dash.fetch";
const KEY_TAB = "git-dash.tab"; // the last tab (UI state, not a setting of the mods-hub)
const KEY_LANG = "herdr-mods.lang"; // the language of the whole kit, set in the mods-hub; absent: the `lang` prop
// Keeps the slash of a drive root ("D:/") and of "/".
const normRoot = (p) => String(p || "").trim().replace(/\\/g, "/").replace(/([^:/])\/+$/, "$1");
/** A clean list of folders: strings only, normalized, no duplicates. */
const cleanRoots = (list) => {
  const out = [], seen = new Set();
  for (const p of Array.isArray(list) ? list : []) {
    const r = typeof p === "string" ? normRoot(p) : "";
    if (r && !seen.has(samePath(r))) { seen.add(samePath(r)); out.push(r); }
  }
  return out;
};
const rootsSig = (list) => list.map(samePath).join("\n");
/** A path for the screen: native slashes, `~` for the home folder. */
const nativePath = (p) => {
  const h = normRoot(home());
  let s = normRoot(p);
  if (h && (samePath(s) === samePath(h) || samePath(s).startsWith(`${samePath(h)}/`))) s = `~${s.slice(h.length)}`;
  return /^[A-Za-z]:[\\/]/.test(home()) ? s.replace(/\//g, "\\") : s;
};
const WORKERS = 12; // repositories analyzed at once
const AUTO_MS = 5 * 60 * 1000; // a silent refresh when the data is this old
const MAX_FILES = 12;

const STR = {
  en: {
    title: "Git Dash", choose: "Choose folder", refresh: "Refresh",
    pickTitle: "Choose a folder with your repositories",
    pickHint: "Git Dash looks for Git repositories inside it, up to {depth} levels deep, and shows what is pending in each one.",
    pickPrompt: "Use this folder",
    folders: "Folders", nFolders: "{n} folders", foldersTitle: "Repository folders",
    foldersHint: "Git Dash looks for Git repositories in each folder, up to {depth} levels deep.",
    addFolder: "Add folder…", removeFolder: "Remove this folder", back: "Back to the list",
    reposN: "{n} repos", notFound: "not found", missing: "{n} folder(s) not found",
    alreadyThere: "This folder is in the list already.",
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
    openGit: "Git", openGitTip: "Open this repository in the Git panel. A terminal of the repository gets the focus; with no terminal there, a new tab opens in the current space (or a new space, when there is no space).",
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
    merged: "{n} merged", mergedTitle: "Merged into {base}, not deleted:", current: "current",
    whereLocal: "local", whereBoth: "local + {remote}",
    fix_delete: "Delete", fix_deleteAll: "Delete all {n}",
    deleteTip: "Delete the local branch {branch}.", deleteTipBoth: "Delete the branch {branch} here and on {remote}.",
    blocked_busy: "finish the operation first", blocked_dirty: "commit or stash the changes first",
    worktree: "worktree", fix_removeWorktree: "Remove worktree",
    removeTip: "Remove the worktree {path} and delete the local branch {branch}.",
    removeTipBoth: "Remove the worktree {path} and delete the branch {branch} here and on {remote}.",
    blocked_locked: "the worktree is locked", blocked_inUse: "close the terminals in this folder first",
    removed: "Worktree removed", removedFailed: "Worktree removed, but a later step failed",
  },
  pt: {
    title: "Git Dash", choose: "Escolher pasta", refresh: "Atualizar",
    pickTitle: "Escolha a pasta dos seus repositórios",
    pickHint: "O Git Dash procura repositórios Git dentro dela, até {depth} níveis, e mostra as pendências de cada um.",
    pickPrompt: "Usar esta pasta",
    folders: "Pastas", nFolders: "{n} pastas", foldersTitle: "Pastas de repositórios",
    foldersHint: "O Git Dash procura repositórios Git em cada pasta, até {depth} níveis.",
    addFolder: "Adicionar pasta…", removeFolder: "Remover esta pasta", back: "Voltar para a lista",
    reposN: "{n} repos", notFound: "não encontrada", missing: "{n} pasta(s) não encontrada(s)",
    alreadyThere: "Esta pasta já está na lista.",
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
    openGit: "Git", openGitTip: "Abre este repositório no painel Git. Um terminal do repositório recebe o foco; sem terminal lá, uma nova aba abre no space atual (ou um novo space, quando não há space).",
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
    merged: "{n} mergeada(s)", mergedTitle: "Mergeadas em {base} e não apagadas:", current: "atual",
    whereLocal: "local", whereBoth: "local + {remote}",
    fix_delete: "Apagar", fix_deleteAll: "Apagar todas ({n})",
    deleteTip: "Apaga a branch local {branch}.", deleteTipBoth: "Apaga a branch {branch} aqui e em {remote}.",
    blocked_busy: "termine a operação antes", blocked_dirty: "faça commit ou stash das mudanças antes",
    worktree: "worktree", fix_removeWorktree: "Remover worktree",
    removeTip: "Remove o worktree {path} e apaga a branch local {branch}.",
    removeTipBoth: "Remove o worktree {path} e apaga a branch {branch} aqui e em {remote}.",
    blocked_locked: "o worktree está travado", blocked_inUse: "feche os terminais nesta pasta antes",
    removed: "Worktree removido", removedFailed: "Worktree removido, mas um passo seguinte falhou",
  },
};

for (const l of Object.keys(STR)) Object.assign(STR[l], WT_STR[l]);

const fill = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? ""));
const base = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

export default class GitDash extends View {
  init(given, cx) {
    // Read props once, here, and keep them: props() inside a later callback can
    // answer for another copy. Fall back to props() when the argument is empty.
    this.props = (given && Object.keys(given).length ? given : props()) || {};
    this.keys = cx.focus_handle(); // the panel's keyboard in a dialog, for Esc (see dialogKeys)
    this.depth = Number.isInteger(this.props.depth) && this.props.depth >= 0 ? this.props.depth : 4;
    // The saved list wins. When it does not exist yet, the old saved folder, else
    // the `root` prop, becomes its first item. An empty saved list stays empty.
    let saved = shared(KEY_ROOTS);
    if (!Array.isArray(saved)) {
      const old = shared(oldRootKey(this.props));
      const first = (typeof old === "string" && old) || (typeof this.props.root === "string" && this.props.root) || "";
      saved = cleanRoots([first]);
      if (saved.length) setShared(KEY_ROOTS, saved);
    }
    this.roots = cleanRoots(saved);
    this.sig = rootsSig(this.roots);

    // The panel opens on the last tab ("list" | "worktrees"). A dialog is a new copy each time, so the tab is shared.
    this.tab = shared(KEY_TAB) === "worktrees" ? "worktrees" : "list";
    this.view = this.tab; // "list" | "folders" | "worktrees"
    this.wt = new WtTab(this); // the Worktrees tab
    this.rootErrors = {}; // samePath(root) -> why the folder could not be read
    this.repos = new Map(); // path -> result of analyze(), with `root`
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

    cx.timer.every(30000, (cx) => kitOff() || (this.wt.tick(), this.tick(cx)));
    // Another copy of the panel (or the mods-hub) can change the list: follow it.
    cx.timer.every(1000, (cx) => kitOff() || this.followRoots(cx));
    // Commands: `git-dash.folders` shows the folders view, `git-dash.list` the list, `git-dash.worktrees` the
    // Worktrees tab, `git-dash.refresh` reads again (the shown tab).
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "list" || c === "worktrees") this.setTab(c);
        else if (c === "folders") this.view = c;
        else if (c === "refresh") this.view === "worktrees" ? this.wt.refresh(cx) : this.refresh(cx);
        cx.notify();
      }
    });
  }

  /** The language: the kit setting `herdr-mods.lang` when it is set, else the `lang` prop, else English. */
  get lang() {
    const kit = shared(KEY_LANG);
    return STR[kit] ? kit : STR[this.props.lang] ? this.props.lang : "en";
  }

  /** Fetch on refresh: the saved choice when there is one, else the `fetch` prop. */
  get fetch() {
    const v = shared(KEY_FETCH);
    return typeof v === "boolean" ? v : this.props.fetch === true;
  }

  s(key, vars) { return fill(STR[this.lang][key] ?? key, vars); }

  gitOff() { return gitOff(); }

  /** Shows the tab `id` ("list" or "worktrees") and keeps it for the next start of the panel. */
  setTab(id) {
    this.tab = id;
    this.view = id;
    if (shared(KEY_TAB) !== id) setShared(KEY_TAB, id);
  }

  // ---- data --------------------------------------------------------------

  tick(cx) {
    // Only ask for the silent run: render() starts it. Herdr does not draw a hidden copy (the
    // other child of a stack, a hidden column), so a hidden panel runs no git until it shows.
    if (this.roots.length && !this.loading && this.updated && Date.now() - this.updated >= AUTO_MS) this.due = true;
    cx.notify(); // keeps "Updated 3m ago" fresh
  }

  refresh(cx) {
    if (!this.roots.length || this.loading) return;
    const gen = ++this.gen, roots = [...this.roots], fetch = this.fetch;
    this.loading = true; this.scanning = true; this.scanError = null;
    this.progress = { done: 0, total: 0 };
    cx.spawn(async (cx) => {
      try {
        // One search per folder, at the same time. A folder that cannot be read
        // does not stop the others: it goes in rootErrors.
        const found = await Promise.all(roots.map((root) => findRepos(root, this.depth)
          .then((list) => ({ root, list }), (e) => ({ root, error: String(e?.message || e) }))));
        if (gen !== this.gen) return;
        const errors = {}, entries = [], seen = new Set();
        let capped = false;
        for (const f of found) {
          if (f.error) { errors[samePath(f.root)] = f.error; continue; }
          if (f.list.length >= MAX_REPOS) capped = true;
          // A folder inside another base folder: its repositories show once, under the first folder.
          for (const e of f.list) {
            if (seen.has(samePath(e.path))) continue;
            seen.add(samePath(e.path));
            entries.push({ ...e, root: f.root });
          }
        }
        this.rootErrors = errors;
        if (!entries.length && found.every((f) => f.error)) throw new Error(found.map((f) => f.error).join(" · "));
        this.capped = capped;
        this.scanning = false;
        this.progress = { done: 0, total: entries.length };
        cx.notify();
        await mapLimit(entries, WORKERS, async (entry) => {
          const r = await analyze(entry, entry.root, { fetch });
          if (gen !== this.gen) return;
          r.root = entry.root;
          this.repos.set(entry.path, r);
          this.progress.done += 1;
          cx.notify();
        });
        if (gen !== this.gen) return;
        const keep = new Set(entries.map((p) => p.path));
        for (const k of [...this.repos.keys()]) if (!keep.has(k)) this.repos.delete(k);
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

  /** Uses `roots` as the list: saves it when `save`, then reads every folder again. */
  setRoots(roots, cx, save = true) {
    this.roots = cleanRoots(roots);
    this.sig = rootsSig(this.roots);
    if (save) setShared(KEY_ROOTS, this.roots);
    this.gen += 1; this.loading = false; this.scanning = false;
    this.repos.clear(); this.open.clear(); this.ask = null; this.running.clear(); this.result.clear();
    this.rootErrors = {}; this.updated = 0; this.scanError = null; this.capped = false;
    this.wt.due = true; // the shown tab reads again in render()
    cx.notify();
  }

  /** Follows a list that another copy of the panel (or the mods-hub) saved. */
  followRoots(cx) {
    const now = cleanRoots(shared(KEY_ROOTS));
    if (Array.isArray(shared(KEY_ROOTS)) && rootsSig(now) !== this.sig) this.setRoots(now, cx, false);
  }

  addFolder(cx) {
    cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: this.s("pickPrompt") }).catch(() => null);
      if (!dir) return;
      if (this.roots.some((r) => samePath(r) === samePath(dir))) {
        notify({ title: this.s("alreadyThere"), body: nativePath(dir), level: "info" });
        return;
      }
      this.setRoots([...this.roots, dir], cx);
    });
  }

  removeRoot(root, cx) {
    const rest = this.roots.filter((r) => samePath(r) !== samePath(root));
    if (this.loading) { this.setRoots(rest, cx); return; }
    // No run: drop the cards of that folder, and keep the others without a new search.
    this.roots = rest;
    this.sig = rootsSig(rest);
    setShared(KEY_ROOTS, rest);
    delete this.rootErrors[samePath(root)];
    for (const [k, r] of [...this.repos]) {
      if (samePath(r.root) === samePath(root)) { this.repos.delete(k); this.open.delete(k); this.result.delete(k); }
    }
    if (this.ask && !this.repos.has(this.ask.path)) this.ask = null;
    cx.notify();
  }

  /** The name of a card: the path under its base folder, with the folder's name first when there are 2 or more. */
  label(r) {
    if (this.roots.length < 2 || !r.root) return r.name;
    const prefix = this.prefix(r.root);
    return samePath(r.path) === samePath(r.root) ? prefix : `${prefix}/${r.name}`;
  }

  /** The short name of a base folder: its last part, or its last 2 parts when another folder has the same last part. */
  prefix(root) {
    const parts = (p) => normRoot(p).split("/").filter(Boolean);
    const last = (p) => parts(p).slice(-1)[0] || normRoot(p);
    const twin = this.roots.some((o) => samePath(o) !== samePath(root) && last(o).toLowerCase() === last(root).toLowerCase());
    return twin ? parts(root).slice(-2).join("/") : last(root);
  }

  toggleFetch(cx) {
    setShared(KEY_FETCH, !this.fetch);
    cx.notify();
  }

  // ---- fixes -------------------------------------------------------------

  /** Reads one repository again (its operations too), after a fix or a terminal. */
  refreshOne(path, cx) {
    const gen = this.gen, root = this.repos.get(path)?.root;
    if (!root) return;
    cx.spawn(async (cx) => {
      const found = await findRepos(path, 0).catch(() => null);
      const entry = found?.find((e) => samePath(e.path) === samePath(path))
        ?? { path, operations: this.repos.get(path)?.operations ?? [] };
      const r = await analyze({ path, operations: entry.operations }, root);
      if (gen !== this.gen || !this.repos.has(path)) return;
      r.root = root;
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

  /** Runs `steps` for the card `path`. `fix.cwd`: where they run (else `path`);
   *  `fix.removes`: worktree folders that the steps remove, whose cards go away. */
  execute(path, steps, label, cx, fix = {}) {
    this.ask = null;
    this.running.set(path, label);
    this.result.delete(path);
    cx.spawn(async (cx) => {
      const res = await runSteps(fix.cwd || path, steps);
      this.running.delete(path);
      const gone = new Set(removedBy(steps, res.done, fix.removes ?? []).map(samePath));
      for (const k of [...this.repos.keys()]) {
        if (gone.has(samePath(k)) && k !== path) { this.repos.delete(k); this.open.delete(k); this.result.delete(k); }
      }
      if (gone.has(samePath(path))) {
        // This card was the removed worktree: say it with a notification, and read the main worktree again.
        this.repos.delete(path); this.open.delete(path);
        notify({ title: this.s(res.ok ? "removed" : "removedFailed"), body: res.ok ? path : res.out, level: res.ok ? "success" : "warning" });
        const main = fix.cwd && [...this.repos.keys()].find((k) => samePath(k) === samePath(fix.cwd));
        if (main) this.refreshOne(main, cx);
        cx.notify();
        return;
      }
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

  /** Opens the repository in the Git panel (the git-client mod). The panel follows the focused terminal, so a
   *  terminal of the repository gets the focus first: one that works there now (the current space first), else a
   *  new tab in the current space, else a new space. Then the Changes panel of the bar opens. */
  openGit(r, cx) {
    const dir = samePath(r.path);
    // A terminal in a nested repository of the list shows that repository, not this one.
    const nested = [...this.repos.keys()].map(samePath).filter((k) => k !== dir && k.startsWith(`${dir}/`));
    const inRepo = (cwd) => {
      const c = samePath(cwd);
      return (c === dir || c.startsWith(`${dir}/`)) && !nested.some((k) => c === k || c.startsWith(`${k}/`));
    };
    const local = (spaces() ?? []).filter((s) => s.machine == null);
    const spaceOf = (tab) => local.find((s) => s.tabs.some((t) => t.id === tab));
    const hits = (panes() ?? []).filter((p) => p.terminal && p.cwd && inRepo(p.cwd) && spaceOf(p.tab));
    const pane = hits.find((p) => spaceOf(p.tab).active) ?? hits[0];
    const showPanel = () => this.showGitPanel(r.path);
    if (pane) {
      run("space.select", { id: spaceOf(pane.tab).id });
      run("pane.focus", { pane: pane.pane });
      return showPanel();
    }
    const folder = /^[A-Za-z]:[\\/]/.test(r.path) ? r.path.replace(/\//g, "\\") : r.path;
    const name = base(r.path);
    const before = new Set((panes() ?? []).map((p) => p.terminal).filter(Boolean));
    const current = local.find((s) => s.active);
    if (current) run("tab.new", { name, space: current.id, folder });
    else run("space.new", { name, folder });
    // The new terminal starts a moment later: focus it, so a layout that follows the focused pane shows it.
    let tries = 0;
    const focusNew = (cx) => {
      const fresh = (panes() ?? []).find((p) => p.terminal && !before.has(p.terminal));
      if (fresh) { run("pane.focus", { terminal: fresh.terminal }); showPanel(); return; }
      if (++tries < 20) cx.timer.after(100, focusNew); else showPanel();
    };
    cx.timer.after(50, focusNew);
    for (const ms of [20000, 90000, 300000]) cx.timer.after(ms, (cx) => this.refreshOne(r.path, cx));
  }

  /** Shows the Changes panel (git-client) of the bar of the shown layout. A layout with no such panel gets a dialog. */
  showGitPanel(path) {
    const root = layout();
    const body = findNode(root, "panel-body");
    const changes = (body?.node.children ?? []).find((c) => c.id === "changes" && !c.hidden);
    const bar = hasMod(root, "kanban") ? "kanban.panel-changes" : hasMod(root, "tabs-dock") ? "tabs-dock.changes" : null;
    if (changes && bar) {
      // The Changes panel shows in the side panel now: leave it (the bar command closes a panel that shows).
      const panel = findNode(root, "panel")?.node ?? body.node; // the same rule as the bars
      const dialog = shared("kanban.panelDialog");
      if (!dialog?.id && panel && !panel.hidden && body.node.active === "changes") return;
      return run(bar);
    }
    const own = this.props.overlay;
    if (own) closeOverlay(own);
    openOverlay({ mod: "git-client", props: { folder: path }, kind: "dialog", width: 0.82, height: 0.85 });
  }

  /** True when a terminal of Herdr works inside `dir` (Windows cannot remove that folder). */
  inUse(dir) {
    const d = samePath(dir);
    return (panes() ?? []).some((p) => p.cwd && (samePath(p.cwd) === d || samePath(p.cwd).startsWith(`${d}/`)));
  }

  // ---- formatting --------------------------------------------------------

  age(at = this.updated) {
    if (!at) return "";
    const m = Math.floor((Date.now() - at) / 60000);
    if (m < 1) return this.s("now");
    return m < 60 ? this.s("ago", { n: m }) : this.s("agoH", { n: Math.floor(m / 60) });
  }

  /** The label of a fix: its button text, and the text while it runs. */
  fixLabel(f) {
    if (f.id === "delete") return f.worktree ? `${this.s("fix_removeWorktree")} ${f.branch}` : `${this.s("fix_delete")} ${f.branch}`;
    return this.s(`fix_${f.id}`, { remote: f.remote, n: f.n });
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
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.rootsText()))
      .child(iconButton(t, "gd-fetch", "download", (cx) => this.toggleFetch(cx),
        { active: this.fetch, tooltip: this.s(this.fetch ? "fetchTipOn" : "fetchTipOff") }))
      .child(iconButton(t, "gd-folder", "folder", (cx) => { this.view = this.view === "folders" ? this.tab : "folders"; cx.notify(); },
        { active: this.view === "folders", tooltip: this.s(this.view === "folders" ? "back" : "folders") }))
      .child(this.view === "worktrees"
        ? iconButton(t, "gd-refresh", "refresh", (cx) => this.wt.refresh(cx), { spin: this.wt.loading, tooltip: this.s("refresh") })
        : iconButton(t, "gd-refresh", "refresh", (cx) => this.refresh(cx),
          { disabled: !this.roots.length, spin: this.loading, tooltip: this.s("refresh") }));
  }

  /** The header text: the name of the only folder, or `2 folders`. */
  rootsText() {
    if (!this.roots.length) return "";
    return this.roots.length === 1 ? base(this.roots[0]) : this.s("nFolders", { n: this.roots.length });
  }

  /** `12 repositories · 5 with pending` on the left, the progress or age on the right. */
  summary(t, list) {
    const withPending = list.filter((r) => !r.error && pending(r)).length;
    const state = this.scanning ? this.s("scanning")
      : this.loading ? this.s("analyzing", this.progress)
      : this.updated ? this.s("updated", { t: this.age() }) : "";
    const missing = Object.keys(this.rootErrors).length;
    return h_flex().flex_none().px(14).pb(2).gap(8).items_center().text_size(11).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().child(`${this.s("repos", { n: list.length })} · ${this.s("withPending", { n: withPending })}`))
      .when(missing > 0, (e) => e.child(div().id("gd-missing").flex_none().text_color(t.blocked).cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.view = "folders"; cx.notify(); })
        .child(this.s("missing", { n: missing }))))
      .child(div().flex_none().text_color(this.loading ? t.accent : t.dim).child(state));
  }

  /** The list of base folders: 1 row per folder, then Add folder. */
  foldersView(t) {
    const all = [...this.repos.values()];
    const row = (root) => {
      const k = samePath(root);
      const error = this.rootErrors[k];
      const n = all.filter((r) => samePath(r.root || "") === k).length;
      const count = error ? this.s("notFound") : this.scanning ? "…" : this.s("reposN", { n });
      return h_flex().id(`gd-root-${k}`).h(40).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
        .when(Boolean(error), (e) => e.tooltip(error))
        .child(svg(icon("folder")).size(15).flex_none().text_color(error ? t.blocked : t.accent))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(nativePath(root)))
        .child(pill(t, { label: count, color: error ? t.blocked : undefined }))
        .child(iconButton(t, `gd-rm-${k}`, "trash", (cx) => this.removeRoot(root, cx), { tooltip: this.s("removeFolder") }));
    };
    return v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().px(14).pt(4).pb(10).gap(2)
        .child(div().text_size(13).font_semibold().child(this.s("foldersTitle")))
        .child(div().text_size(11).text_color(t.dim).child(this.s("foldersHint", { depth: this.depth }))))
      .child(v_flex().id("gd-roots").flex_1().min_h(0).overflow_y_scrollbar().border_t(1).border_color(t.border)
        .children(this.roots.map(row))
        .child(h_flex().flex_none().px(14).py(10).gap(8)
          .child(button(t, "gd-add", this.s("addFolder"), (cx) => this.addFolder(cx), { primary: true }))
          .when(this.roots.length > 0, (e) => e.child(button(t, "gd-back", this.s("back"), (cx) => { this.view = this.tab; cx.notify(); })))));
  }

  pills(r, t) {
    const items = [];
    if (r.branch) items.push(pill(t, { label: r.branch, symbol: "branch", code: true }));
    if (r.worktree) items.push(pill(t, { label: this.s("worktree") }));
    for (const op of r.operations) items.push(pill(t, { label: this.s("operation", { op }), color: t.ansi1 }));
    if (r.conflicts) items.push(pill(t, { label: this.s("conflicts", { n: r.conflicts }), color: t.ansi1 }));
    if (r.unpushed) items.push(pill(t, { label: this.s("unpushed", { n: r.unpushed }), color: t.ansi1 }));
    if (r.staged) items.push(pill(t, { label: this.s("staged", { n: r.staged }), color: t.ansi2 }));
    if (r.modified) items.push(pill(t, { label: this.s("modified", { n: r.modified }), color: t.ansi3 }));
    if (r.untracked) items.push(pill(t, { label: this.s("untracked", { n: r.untracked }), color: t.ansi6 }));
    if (r.stash) items.push(pill(t, { label: this.s("stash", { n: r.stash }), color: t.ansi5 }));
    if (r.behind) items.push(pill(t, { label: this.s("behind", { n: r.behind }), color: t.ansi4 }));
    if (r.merged.length) items.push(pill(t, { label: this.s("merged", { n: r.merged.length }), symbol: "branch", color: t.ansi4 }));
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
          .child(smallButton(t, key("gd-run"), this.s("run"), (cx) => this.execute(p, steps, this.fixLabel(ask.fix), cx, ask.fix),
            { tone: ask.fix.id.startsWith("delete") ? "danger" : "primary" }))
          .child(cancel));
    } else if (ask?.kind === "commit") {
      const modes = [r.staged && "staged", r.modified && "tracked", r.untracked && "all"].filter(Boolean);
      const message = this.msg.value().trim();
      main = panel(
        h_flex().id(key("gd-msg")).h(30).px(10).items_center().rounded(7).bg(t.background).border_1().border_color(t.input).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          // Esc cancels the commit, as the Cancel button does (the field keeps Esc from the dialog).
          .on_key_down((e, cx) => { if (e.key !== "escape") return; this.ask = null; cx.stop_propagation(); cx.notify(); })
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
      main = v_flex().gap(8)
        .child(h_flex().flex_wrap().gap(6)
          .children(fx.auto.map((f) => smallButton(t, key(`gd-fix-${f.id}`), this.fixLabel(f),
            (cx) => this.startFix(r, f, cx), { tone: "primary" })))
          .child(smallButton(t, key("gd-tab"), this.s("openTab"), (cx) => this.openTerminal(r, "tab", cx),
            { symbol: "terminal", tooltip: this.s("openTabTip") }))
          .child(smallButton(t, key("gd-space"), this.s("openSpace"), (cx) => this.openTerminal(r, "space", cx),
            { tooltip: this.s("openSpaceTip") }))
          .when(!gitOff(), (e) => e.child(smallButton(t, key("gd-git"), this.s("openGit"), (cx) => this.openGit(r, cx),
            { symbol: "branch", tooltip: this.s("openGitTip") }))))
        .when(fx.merged.length > 0, (e) => e.child(this.mergedList(r, fx, t, key)));
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

  /** The merged branches of an open card, each with its delete button, and "Delete all". */
  mergedList(r, fx, t, key) {
    const ready = fx.merged.filter((m) => m.fix);
    // The current branch goes last: its delete switches to the base branch.
    const all = ready.length > 1 ? {
      id: "deleteAll", n: ready.length, cwd: ready[0].fix.cwd, removes: ready.flatMap((m) => m.fix.removes),
      steps: [...ready].sort((a, b) => Number(a.branch.current) - Number(b.branch.current)).flatMap((m) => m.fix.steps),
    } : null;
    const tip = (b) => b.worktree
      ? this.s(b.remote ? "removeTipBoth" : "removeTip", { path: b.worktree.path, branch: b.name, remote: b.remote?.name })
      : b.remote ? this.s("deleteTipBoth", { branch: b.name, remote: b.remote.name }) : this.s("deleteTip", { branch: b.name });
    // 2 lines, so a narrow panel shows the whole name and the whole reason:
    // the branch and its pills, then where it is and the button (or why it must wait).
    const row = ({ branch: b, fix, blocked }) => v_flex().py(2).text_size(11)
      .child(h_flex().h(22).gap(8).items_center()
        .child(svg(icon("branch")).size(11).flex_none().text_color(t.ansi4))
        .child(div().flex_shrink_1().min_w(0).truncate().font_family(mono()).text_color(t.foreground).child(b.name))
        .when(b.current, (e) => e.child(pill(t, { label: this.s("current"), color: t.accent })))
        .when(Boolean(b.worktree), (e) => e.child(pill(t, { label: this.s("worktree") }))))
      .child(h_flex().h(24).pl(19).gap(8).items_center()
        .child(div().flex_none().text_color(t.dim).child(b.remote ? this.s("whereBoth", { remote: b.remote.name }) : this.s("whereLocal")))
        .child(div().flex_1())
        .child(fix
          ? smallButton(t, key(`gd-del-${b.name}`), this.s(b.worktree ? "fix_removeWorktree" : "fix_delete"), (cx) => this.startFix(r, fix, cx), {
            tone: "danger", tooltip: tip(b),
          })
          : div().flex_shrink_1().min_w(0).truncate().text_color(t.ansi3).child(this.s(`blocked_${blocked}`))));
    return v_flex().gap(2).pt(6).border_t(1).border_color(t.border)
      .child(h_flex().h(24).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.s("mergedTitle", { base: r.base.name })))
        .when(Boolean(all), (e) => e.child(smallButton(t, key("gd-del-all"), this.fixLabel(all), (cx) => this.startFix(r, all, cx), { tone: "danger" }))))
      .children(fx.merged.map(row));
  }

  repoCard(r, t) {
    const open = this.open.has(r.path);
    const fx = fixes(r, (dir) => this.inUse(dir));
    const expandable = Boolean(r.error) || r.files.length > 0 || fx.auto.length > 0 || pending(r) || this.result.has(r.path);
    const notes = r.notes.map((n) => this.noteText(n));
    return v_flex().id(`repo-${r.path}`).w_full().flex_none().px(14).py(9).gap(6).border_b(1).border_color(t.border)
      .when(expandable, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => {
        if (this.open.has(r.path)) this.open.delete(r.path); else this.open.add(r.path);
        cx.notify();
      }))
      .child(h_flex().gap(8).items_center()
        .child(div().size(8).rounded(4).flex_none().bg(this.sevColor(r, t)))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(this.label(r)))
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
      .when(withButton, (e) => e.child(h_flex().gap(8)
        .child(button(t, "gd-pick", this.s(this.roots.length ? "addFolder" : "choose"), (cx) => this.addFolder(cx), { primary: true }))
        .when(this.roots.length > 0, (x) => x.child(button(t, "gd-folders", this.s("folders"), (cx) => { this.view = "folders"; cx.notify(); })))));
  }

  /** The tabs under the header: Repositories and Worktrees. */
  tabs(t) {
    const n = [...this.wt.groups.values()].reduce((a, g) => a + g.rows.length, 0);
    const tab = (id, label, count) => filterChip(t, `gd-tab-${id}`, label, count, this.view === id, (cx) => { this.setTab(id); cx.notify(); });
    return h_flex().flex_none().px(12).pb(6).gap(4)
      .child(tab("list", this.s("tabRepos"), this.repos.size))
      .child(tab("worktrees", this.s("tabWorktrees"), this.wt.updated || n ? n : "…"));
  }

  body(t) {
    if (this.view === "folders") return this.foldersView(t);
    return v_flex().flex_1().min_h(0)
      .child(this.tabs(t))
      .child(this.view === "worktrees"
        ? this.wt.body(t, (title, detail) => this.emptyState(t, title, detail, !this.roots.length))
        : this.repoBody(t));
  }

  repoBody(t) {
    if (!this.roots.length) return this.emptyState(t, this.s("pickTitle"), this.s("pickHint", { depth: this.depth }), true);
    const where = this.roots.map(nativePath).join(", ");
    if (this.scanError && !this.repos.size) return this.emptyState(t, this.scanError, where, true);
    if (this.scanning && !this.repos.size) return busy(t, this.s("scanning"), where);
    if (!this.repos.size && !this.loading) {
      return this.emptyState(t, this.s("none"), this.s("noneHint", { root: where, depth: this.depth }), true);
    }
    if (!this.repos.size) return busy(t, this.s("analyzing", this.progress), where);

    const all = [...this.repos.values()];
    const names = new Map(all.map((r) => [r.path, this.label(r)]));
    const byName = (a, b) => names.get(a.path).localeCompare(names.get(b.path));
    const bad = all.filter((r) => r.error);
    const todo = all.filter((r) => !r.error && pending(r))
      .sort((a, b) => severity(b) - severity(a) || byName(a, b));
    const clean = all.filter((r) => !r.error && !pending(r)).sort(byName);
    bad.sort(byName);

    const q = this.query.value().trim().toLowerCase();
    const hit = (r) => !q || `${names.get(r.path)} ${r.branch}`.toLowerCase().includes(q);
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

  render(cx) {
    if (kitOff()) return offView();
    if (this.due) { this.due = false; this.refresh(cx); }
    // The Repositories tab analyzes the repositories the first time it shows (and after a change of the folders).
    if (this.view === "list" && this.roots.length && !this.updated && !this.loading && !this.scanError) this.refresh(cx);
    // The Worktrees tab reads its data the first time it shows, then when it is old (only while it shows).
    if (this.view === "worktrees" && !this.wt.loading && (this.wt.due || !this.wt.updated)) { this.wt.due = false; this.wt.refresh(cx); }
    const t = theme();
    return dialogKeys(v_flex().id("git-dash").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13), this.keys)
      .child(this.header(t))
      .child(this.body(t));
  }
}
