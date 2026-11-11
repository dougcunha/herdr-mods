// The Worktrees tab of Git Dash: its state, its data runs and its views.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import { run, panes, spaces } from "herdr";
import { candidates, findMains, readGroup, rereadGroup, rowActions, runActionSteps, showStep, dirty, isOld } from "./wt.js";
import { samePath } from "./git.js";
import { icon, mono, pill, searchBox, busy, filterChip, smallButton, tint } from "./ui.js";

const AUTO_MS = 5 * 60 * 1000;

export const WT_STR = {
  en: {
    tabRepos: "Repositories", tabWorktrees: "Worktrees",
    wtScanning: "Looking for worktrees… {done}/{total}", wtReading: "Reading worktrees…",
    wtSummary: "{n} worktrees in {r} repositories", wtNone: "No worktree found.",
    wtNoneHint: "Git Dash looks in the repositories of its folders and of Repo Launcher.",
    wtNoFolders: "No repository folders.", wtNoFoldersHint: "Add folders here (folder button) or in Repo Launcher.",
    wtFilterPh: "Filter worktrees…",
    wf_all: "All", wf_merged: "Merged", wf_changes: "Changes", wf_old: "Old", wf_missing: "Missing",
    detached: "detached", locked: "locked", missingDir: "folder missing", merged: "merged",
    noCommits: "no commits", openNow: "open",
    baseAhead: "↑{n} not in {base}", baseBehind: "↓{n} behind {base}", unpushed: "↑{n} unpushed", noUpstream: "not pushed",
    changes: "{n} changed", conflicts: "{n} conflicts",
    lastDays: "{n}d ago", lastHours: "{n}h ago", lastNow: "now",
    a_remove: "Remove", a_forceRemove: "Force remove", a_removeDelete: "Remove + delete branch",
    a_removeDeleteBoth: "Remove + delete branch (local + remote)", a_prune: "Prune", a_pruneDelete: "Prune + delete branch",
    a_merge: "Merge into {base}", a_pr: "Pull request",
    b_locked: "the worktree is locked", b_noBase: "no default branch", b_mainBusy: "the main checkout has an operation in progress",
    b_mainBranch: "the main checkout is not on {base}", b_mainDirty: "the main checkout has changes",
    b_dirty: "commit the changes first", b_diverged: "the branch is ahead and behind its upstream",
    warnSpace: "A space that works only in this folder closes, with its agent.",
    warnForce: "The worktree has changes. They are lost. A space that works only in this folder closes.",
    warnUnmerged: "The branch has {n} commit(s) that are not in {base}. They are lost when the branch is deleted.",
    warnPrune: "The branch is deleted, also when it has commits that are not in {base}.",
    openSpace: "Open", openSpaceTip: "Go to the space of this worktree, or open it in a new space.",
    terminal: "Terminal", git: "Git",
    confirm: "Run these steps?", run: "Run", cancel: "Cancel", running: "Running…", done: "Done.", failed: "Failed.",
    retry: "Open a terminal",
  },
  pt: {
    tabRepos: "Repositórios", tabWorktrees: "Worktrees",
    wtScanning: "Procurando worktrees… {done}/{total}", wtReading: "Lendo worktrees…",
    wtSummary: "{n} worktrees em {r} repositórios", wtNone: "Nenhum worktree encontrado.",
    wtNoneHint: "O Git Dash procura nos repositórios das pastas dele e do Repo Launcher.",
    wtNoFolders: "Nenhuma pasta de repositórios.", wtNoFoldersHint: "Adicione pastas aqui (botão de pasta) ou no Repo Launcher.",
    wtFilterPh: "Filtrar worktrees…",
    wf_all: "Todos", wf_merged: "Mergeados", wf_changes: "Com mudanças", wf_old: "Antigos", wf_missing: "Sem pasta",
    detached: "destacado", locked: "travado", missingDir: "pasta não existe", merged: "mergeado",
    noCommits: "sem commits", openNow: "aberto",
    baseAhead: "↑{n} fora de {base}", baseBehind: "↓{n} atrás de {base}", unpushed: "↑{n} não enviado(s)", noUpstream: "sem push",
    changes: "{n} alterado(s)", conflicts: "{n} conflitos",
    lastDays: "há {n} d", lastHours: "há {n} h", lastNow: "agora",
    a_remove: "Remover", a_forceRemove: "Forçar remoção", a_removeDelete: "Remover + apagar branch",
    a_removeDeleteBoth: "Remover + apagar branch (local + remoto)", a_prune: "Prune", a_pruneDelete: "Prune + apagar branch",
    a_merge: "Merge em {base}", a_pr: "Pull request",
    b_locked: "o worktree está travado", b_noBase: "sem branch padrão", b_mainBusy: "o checkout principal tem uma operação em andamento",
    b_mainBranch: "o checkout principal não está em {base}", b_mainDirty: "o checkout principal tem mudanças",
    b_dirty: "faça commit das mudanças antes", b_diverged: "a branch está à frente e atrás do upstream",
    warnSpace: "Um space que trabalha só nesta pasta fecha, com o agente dele.",
    warnForce: "O worktree tem mudanças. Elas são perdidas. Um space que trabalha só nesta pasta fecha.",
    warnUnmerged: "A branch tem {n} commit(s) que não estão em {base}. Eles são perdidos quando a branch é apagada.",
    warnPrune: "A branch é apagada, mesmo quando tem commits que não estão em {base}.",
    openSpace: "Abrir", openSpaceTip: "Vai para o space deste worktree, ou abre em um novo space.",
    terminal: "Terminal", git: "Git",
    confirm: "Rodar estes passos?", run: "Rodar", cancel: "Cancelar", running: "Rodando…", done: "Feito.", failed: "Falhou.",
    retry: "Abrir um terminal",
  },
};

const base = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
const inside = (cwd, dir) => { const c = samePath(cwd), d = samePath(dir); return c === d || c.startsWith(`${d}/`); };

export class WtTab {
  /** `host`: the GitDash view (strings, terminals, the Git panel, the list of repositories). */
  constructor(host) {
    this.host = host;
    this.groups = new Map(); // samePath(main) -> readGroup()
    this.gen = 0;
    this.loading = false;
    this.progress = { done: 0, total: 0 };
    this.updated = 0;
    this.due = false;
    this.filter = "all";
    this.open = new Set(); // row keys with their actions shown
    this.ask = null; // { key, action }
    this.running = new Map(); // row key -> label
    this.result = new Map(); // row key -> { ok, out, failed }
    this.query = InputState.new({ placeholder: host.s("wtFilterPh") });
    this.query.on("change", (_e, cx) => cx.notify());
  }

  s(key, vars) { return this.host.s(key, vars); }

  /** The folders to look in: Repo Launcher's repositories and the cards of Git Dash. */
  paths() {
    return candidates([...this.host.repos.values()].map((r) => r.worktree?.main ?? r.path));
  }

  /** Called by the timer of the host: ask for a silent run when the data is old (render() starts it). */
  tick() {
    if (!this.loading && this.updated && Date.now() - this.updated >= AUTO_MS) this.due = true;
  }

  refresh(cx) {
    if (this.loading) return;
    const paths = this.paths();
    const gen = ++this.gen;
    // The cards of Git Dash are part of the list: a run before they are all read must run again after.
    this.partial = this.host.loading;
    this.loading = true;
    this.progress = { done: 0, total: paths.length };
    cx.spawn(async (cx) => {
      try {
        const mains = await findMains(paths, () => { if (gen === this.gen) { this.progress.done += 1; cx.notify(); } });
        if (gen !== this.gen) return;
        const next = new Map();
        await Promise.all(mains.map(async (m) => {
          const g = await readGroup(m);
          if (gen === this.gen) { next.set(samePath(g.main), g); this.groups.set(samePath(g.main), g); cx.notify(); }
        }));
        if (gen !== this.gen) return;
        this.groups = next;
      } finally {
        // Also after a failure: render() must not start the run again at once.
        if (gen === this.gen) { this.loading = false; this.updated = Date.now(); }
        cx.notify();
      }
    });
    cx.notify();
  }

  rereadGroup(main, cx) {
    cx.spawn(async (cx) => {
      const g = await rereadGroup(main).catch(() => null);
      if (g) this.groups.set(samePath(g.main), g); else this.groups.delete(samePath(main));
      cx.notify();
    });
  }

  execute(g, w, action, cx) {
    this.ask = null;
    const label = this.actionLabel(g, action);
    this.running.set(w.key, label);
    this.result.delete(w.key);
    cx.spawn(async (cx) => {
      const res = await runActionSteps(action.steps);
      this.running.delete(w.key);
      this.result.set(w.key, res);
      cx.notify();
      this.rereadGroup(g.main, cx);
    });
    cx.notify();
  }

  /** Goes to a space whose terminal works in the worktree, or opens a new space there. */
  openSpace(w) {
    const local = (spaces() ?? []).filter((s) => s.machine == null);
    const pane = (panes() ?? []).find((p) => p.terminal && p.cwd && inside(p.cwd, w.path) && local.some((s) => s.tabs.some((t) => t.id === p.tab)));
    if (pane) {
      const sp = local.find((s) => s.tabs.some((t) => t.id === pane.tab));
      run("space.select", { id: sp.id });
      run("pane.focus", { pane: pane.pane });
      return;
    }
    const folder = /^[A-Za-z]:[\\/]/.test(w.path) ? w.path.replace(/\//g, "\\") : w.path;
    run("space.new", { name: w.branch || base(w.path), folder });
  }

  /** True when a terminal of Herdr works inside the worktree. */
  inUse(w) {
    return (panes() ?? []).some((p) => p.cwd && inside(p.cwd, w.path));
  }

  actionLabel(g, a) {
    return this.s(`a_${a.id}`, { base: g.base?.local || g.base?.name || "main" });
  }

  ago(sec) {
    if (!sec) return "";
    const s = Date.now() / 1000 - sec;
    if (s < 3600) return this.s("lastNow");
    if (s < 86400) return this.s("lastHours", { n: Math.floor(s / 3600) });
    return this.s("lastDays", { n: Math.floor(s / 86400) });
  }

  // ---- views -----------------------------------------------------------------

  pills(g, w, t) {
    const b = g.base?.local || g.base?.name || "";
    const out = [];
    if (w.prunable) out.push(pill(t, { label: this.s("missingDir"), color: t.ansi1 }));
    if (w.locked) out.push(pill(t, { label: this.s("locked"), color: t.ansi3 }));
    if (w.error) return out;
    if (!w.prunable) {
      if (this.inUse(w)) out.push(pill(t, { label: this.s("openNow"), color: t.accent }));
      if (w.conflicts) out.push(pill(t, { label: this.s("conflicts", { n: w.conflicts }), color: t.ansi1 }));
      const n = w.staged + w.modified + w.untracked;
      if (n) out.push(pill(t, { label: this.s("changes", { n }), color: t.ansi3 }));
      if (w.merged) out.push(pill(t, { label: this.s("merged"), symbol: "branch", color: t.ansi4 }));
      else if (w.branch && g.base && w.baseAhead === 0) out.push(pill(t, { label: this.s("noCommits") }));
      if (w.baseAhead) out.push(pill(t, { label: this.s("baseAhead", { n: w.baseAhead, base: b }), color: t.ansi2 }));
      if (w.baseBehind) out.push(pill(t, { label: this.s("baseBehind", { n: w.baseBehind, base: b }), color: t.ansi6 }));
      if (w.branch && w.baseAhead && !w.upstream) out.push(pill(t, { label: this.s("noUpstream"), color: t.ansi5 }));
      else if (w.ahead) out.push(pill(t, { label: this.s("unpushed", { n: w.ahead }), color: t.ansi5 }));
      if (w.last) out.push(pill(t, { label: this.ago(w.last), color: isOld(w) ? t.ansi3 : undefined }));
    }
    return out;
  }

  rowActions(g, w, t) {
    const key = (s) => `${s}-${w.key}`;
    const label = this.running.get(w.key);
    const res = this.result.get(w.key);
    const ask = this.ask?.key === w.key ? this.ask : null;
    const baseName = g.base?.local || g.base?.name || "main";
    let main;
    if (label) {
      main = h_flex().gap(6).items_center().text_size(11).text_color(t.accent)
        .child(svg(icon("spinner")).size(12).flex_none().text_color(t.accent).spin(900))
        .child(`${label} · ${this.s("running")}`);
    } else if (ask) {
      const a = ask.action;
      main = v_flex().gap(6).p(8).rounded(8).bg(t.raised).border_1().border_color(t.border)
        .child(div().text_size(11).text_color(t.muted).child(this.s("confirm")))
        .when(Boolean(a.warn), (e) => e.child(div().text_size(11).text_color(t.ansi1)
          .child(this.s(a.warn, { n: w.baseAhead, base: baseName }))))
        .children(a.steps.map((s) => div().w_full().truncate().font_family(mono()).text_size(11).text_color(t.foreground).child(showStep(s))))
        .child(h_flex().gap(6)
          .child(smallButton(t, key("wt-run"), this.s("run"), (cx) => this.execute(g, w, a, cx), { tone: a.tone }))
          .child(smallButton(t, key("wt-cancel"), this.s("cancel"), (cx) => { this.ask = null; cx.notify(); })));
    } else {
      const acts = rowActions(g, w);
      const ready = acts.filter((a) => !a.blocked);
      const blocked = acts.filter((a) => a.blocked);
      main = v_flex().gap(6)
        .child(h_flex().flex_wrap().gap(6)
          .when(!w.prunable, (e) => e
            .child(smallButton(t, key("wt-open"), this.s("openSpace"), () => this.openSpace(w), { tooltip: this.s("openSpaceTip") }))
            .child(smallButton(t, key("wt-tab"), this.s("terminal"), (cx) => this.host.openTerminal({ path: w.path }, "tab", cx), { symbol: "terminal" }))
            .when(!this.host.gitOff(), (x) => x.child(smallButton(t, key("wt-git"), this.s("git"), (cx) => this.host.openGit({ path: w.path }, cx), { symbol: "branch" }))))
          .children(ready.map((a) => smallButton(t, key(`wt-a-${a.id}`), this.actionLabel(g, a),
            (cx) => { this.ask = { key: w.key, action: a }; this.result.delete(w.key); cx.notify(); }, { tone: a.tone }))))
        .children(blocked.map((a) => div().text_size(11).text_color(t.ansi3)
          .child(`${this.actionLabel(g, a)}: ${this.s(`b_${a.blocked}`, { base: baseName })}`)));
    }
    const tail = res ? res.out.split("\n").filter(Boolean).slice(-4) : [];
    return v_flex().id(key("wt-act")).pl(16).pt(4).gap(6)
      .on_click((_e, cx) => cx.stop_propagation())
      .child(main)
      .when(Boolean(res), (e) => e.child(v_flex().gap(2).p(8).rounded(8).bg(tint(res.ok ? t.ansi2 : t.ansi1, "14"))
        .child(div().text_size(11).font_semibold().text_color(res.ok ? t.ansi2 : t.ansi1).child(this.s(res.ok ? "done" : "failed")))
        .children(tail.map((line) => div().w_full().truncate().font_family(mono()).text_size(10).text_color(t.muted).child(line)))
        .when(!res.ok && Boolean(res.failed?.argv), (x) => x.child(h_flex().pt(4).child(
          smallButton(t, key("wt-retry"), this.s("retry"), (cx) => this.host.openTerminal({ path: res.failed.cwd }, "tab", cx, res.failed.argv),
            { symbol: "terminal", tone: "danger" }))))));
  }

  row(g, w, t) {
    const open = this.open.has(w.key);
    const color = w.prunable || w.error || w.conflicts ? t.ansi1 : dirty(w) ? t.ansi3 : w.merged ? t.ansi4 : t.ansi2;
    return v_flex().id(`wt-${w.key}`).w_full().flex_none().px(14).py(8).gap(5).border_b(1).border_color(t.border)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { if (open) this.open.delete(w.key); else this.open.add(w.key); cx.notify(); })
      .child(h_flex().gap(8).items_center()
        .child(div().size(8).rounded(4).flex_none().bg(color))
        .child(svg(icon("branch")).size(12).flex_none().text_color(t.ansi4))
        .child(div().flex_shrink_1().min_w(0).truncate().font_family(mono()).text_size(12).font_semibold()
          .child(w.branch || this.s("detached")))
        .child(div().flex_1())
        .child(div().flex_none().text_size(11).text_color(t.dim).child(open ? "▾" : "▸")))
      .child(div().pl(16).truncate().text_size(11).text_color(t.dim).child(w.path))
      .when(Boolean(w.error), (e) => e.child(div().pl(16).text_size(11).text_color(t.ansi1).child(w.error)))
      .child(h_flex().pl(16).flex_wrap().gap(6).items_center().children(this.pills(g, w, t)))
      .when(open, (e) => e.child(this.rowActions(g, w, t)));
  }

  groupHeader(g, t, n) {
    return h_flex().h(30).flex_none().px(14).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border)
      .child(svg(icon("repos")).size(13).flex_none().text_color(t.accent))
      .child(div().flex_shrink_1().min_w(0).truncate().text_size(12).font_semibold().child(g.name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(g.mainBranch ? `${g.mainBranch} · ${g.main}` : g.main))
      .child(pill(t, { label: String(n) }));
  }

  body(t, emptyState) {
    const groups = [...this.groups.values()].sort((a, b) => a.name.localeCompare(b.name));
    const rows = groups.flatMap((g) => g.rows.map((w) => ({ g, w })));
    if (!rows.length) {
      if (this.loading) return busy(t, this.s("wtScanning", this.progress));
      if (!this.paths().length) return emptyState(this.s("wtNoFolders"), this.s("wtNoFoldersHint"));
      return emptyState(this.s("wtNone"), this.s("wtNoneHint"));
    }
    const tests = {
      all: () => true,
      merged: ({ w }) => w.merged,
      changes: ({ w }) => dirty(w),
      old: ({ w }) => isOld(w),
      missing: ({ w }) => w.prunable,
    };
    const q = this.query.value().trim().toLowerCase();
    const hit = ({ g, w }) => !q || `${g.name} ${w.branch} ${w.path}`.toLowerCase().includes(q);
    const shown = rows.filter(tests[this.filter]).filter(hit);
    const chip = (id, color) => {
      const count = rows.filter(tests[id]).length;
      if (!count && id !== "all" && this.filter !== id) return null;
      return filterChip(t, `wt-f-${id}`, this.s(`wf_${id}`), count, this.filter === id, (cx) => { this.filter = id; cx.notify(); }, color);
    };
    const chips = [chip("all"), chip("merged", t.ansi4), chip("changes", t.ansi3), chip("old", t.ansi5), chip("missing", t.ansi1)].filter(Boolean);
    const state = this.loading ? this.s("wtReading") : this.updated ? this.host.s("updated", { t: this.host.age(this.updated) }) : "";
    const list = [];
    for (const g of groups) {
      const mine = shown.filter((x) => x.g === g);
      if (!mine.length) continue;
      list.push(this.groupHeader(g, t, mine.length));
      for (const { w } of mine) list.push(this.row(g, w, t));
    }
    return v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().px(14).pb(2).gap(8).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(this.s("wtSummary", { n: rows.length, r: groups.filter((g) => g.rows.length).length })))
        .child(div().flex_none().text_color(this.loading ? t.accent : t.dim).child(state)))
      .child(v_flex().flex_none().px(12).pt(6).pb(8).gap(8)
        .child(searchBox(t, "wt-query", this.query, {
          right: q ? `${shown.length}/${rows.length}` : "",
          onClear: (cx) => { this.query.set_value(""); cx.notify(); },
        }))
        .child(h_flex().flex_wrap().gap(4).children(chips)))
      .child(v_flex().id("wt-scroll").flex_1().min_h(0).overflow_y_scrollbar().border_t(1).border_color(t.border)
        .children(list)
        .when(!shown.length, (e) => e.child(div().p(16).text_size(12).text_color(t.dim).child(this.host.s("noMatch")))));
  }
}

