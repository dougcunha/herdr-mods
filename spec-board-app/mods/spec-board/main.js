// Spec Board for the Herdr app: the SDD specs (tasks/prd-<slug>/) of the shown
// space's repository and of its git worktrees, with their status, phase and
// task progress. It reads, edits and deletes the markdown of a spec, and starts
// an agent with the SDD skills: a new spec (sdd-triar), start or continue a spec
// (sdd-orquestrar-fluxo), here or in a new git worktree.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, EditorState, Editor, TextView } from "gpui-base";
import {
  theme, settings, props, shared, setShared, spaces, panes, focused, run, notify, nextCommand,
  readTextFile, writeTextFile, watchFolder, closeOverlay, exec,
} from "herdr";
import { findRepo, scan, sortSpecs, rowsOf, PHASES, phaseIndex, hilText, reviewStatus, groupOf, join, native, isWin } from "./data.js";
import {
  KEY, launch, resolveSkill, promptFor, quoteArg, triageNames, flowNames, branchFrom, branchPrefix, checkBranch,
  makeWorktree, worktreePath, commitState, isTracked, copySpec, trash,
} from "./actions.js";
import { demoSpecs } from "./demo.js";

// The mods-hub can turn this mod off (shared "herdr-mods.disabled", a list of mod names). Then the mod draws
// nothing, closes its dialog and skips its timed work. The bars hide its blocks and buttons.
const kitOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes("spec-board"); };
const offView = () => { const o = props()?.overlay; if (o) closeOverlay(o); return div(); };

const MOD = "spec-board";
const KEY_LANG = "herdr-mods.lang";
const icon = (name) => `mods/${MOD}/${name}.svg`;
const tint = (color, alpha = "24") => (/^#[0-9a-f]{6}$/i.test(color || "") ? color + alpha : color);
const fill = (s, vars = {}) => s.replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? ""));
const WIDE = 760; // from this width, the list and the detail show side by side
const LIST_W = 380;

const STR = {
  en: {
    title: "Specs", refresh: "Refresh", newSpec: "New spec", sort: "Sort", search: "Search specs…",
    showDone: "Show done", noRepo: "Open a terminal in a repository to see its specs.",
    remote: "Spec Board reads specs of this computer only.",
    noTasks: "No SDD specs here. A spec is a folder tasks/prd-<name>/ of the repository.",
    noMatch: "No spec matches.", loading: "Reading specs…", demo: "Example specs",
    sortGroup: "Urgency, grouped", sortUrgency: "Urgency", sortName: "Name",
    st_waiting: "Needs you", st_blocked: "Blocked", st_active: "Active", st_paused: "Paused",
    st_new: "Not started", st_done: "Done", st_invalid: "Bad checkpoint",
    ph_conceito: "Concept", ph_produto: "Product", "ph_projeto-plano": "Plan", ph_implementacao: "Build",
    ph_revisao: "Review", ph_correcoes: "Fixes", ph_aceite: "Acceptance", ph_concluido: "Done",
    tasksOf: "{done}/{total} tasks", noTaskYet: "No tasks yet", specs: "{n} specs",
    worktree: "worktree", alsoIn: "Also in: {list}",
    t_prd: "PRD", t_techspec: "TechSpec", t_tasks: "Tasks", t_reviews: "Reviews", t_workflow: "Workflow",
    t_snapshot: "Snapshot", t_brief: "Brief", t_design: "Design review",
    plan: "Plan (tasks.md)", pending: "pending", doneWord: "done", correction: "{n} fix tasks",
    noReviews: "No code review yet.", noFile: "This spec has no {name} yet.",
    start: "Start", startWt: "Start in worktree", cont: "Continue", auto: "Continue in auto mode",
    monitored: "Continue in monitored mode", startAuto: "Start in auto mode", startMonitored: "Start in monitored mode",
    del: "Delete", openFolder: "Open folder", edit: "Edit", save: "Save", cancel: "Cancel", reload: "Reload",
    back: "Back", saved: "Saved", conflict: "The file changed on disk. Reload it or copy your text first.",
    level: "Level", mode: "Mode", review: "Review", next: "Next",
    newTitle: "New spec", newHint: "Describe the request. The agent runs {skill} with it, then the SDD flow.",
    newPlaceholder: "What do you want to build or change?", startHere: "Start here", startInWt: "Start in a worktree…",
    wtTitle: "Start in a new worktree", branch: "Branch", wtWhere: "Folder: {path}",
    wtCreate: "Create worktree and start", copyQ: "Copy the spec folder into the worktree",
    notCommitted: "The folder of this spec is not in the last commit ({state}). A new worktree does not have it.",
    st_untracked: "not tracked", st_changed: "changed", checking: "Checking git…",
    delTitle: "Delete {name}?", delHint: "The folder goes to the Recycle Bin: {path}",
    delOpen: "This spec is not done. Its agent loses the checkpoint and the plan.",
    delTracked: "Git tracks files of this folder: git shows the delete as a change.",
    delOthers: "The copies in other worktrees stay.", delBtn: "Move to Recycle Bin",
    launched: "Agent started", launchedBody: "{skill} for {name}", wtMade: "Worktree created",
    failed: "Spec Board", badBranch: "That is not a valid branch name.", emptyRequest: "Write the request first.",
    deleted: "Moved to the Recycle Bin", demoNo: "Example specs: nothing changes on disk.",
  },
  pt: {
    title: "Specs", refresh: "Atualizar", newSpec: "Nova spec", sort: "Ordenar", search: "Buscar specs…",
    showDone: "Mostrar concluídas", noRepo: "Abra um terminal num repositório para ver as specs dele.",
    remote: "O Spec Board lê só specs deste computador.",
    noTasks: "Não há specs SDD aqui. Uma spec é uma pasta tasks/prd-<nome>/ do repositório.",
    noMatch: "Nenhuma spec corresponde.", loading: "Lendo as specs…", demo: "Specs de exemplo",
    sortGroup: "Urgência, em grupos", sortUrgency: "Urgência", sortName: "Nome",
    st_waiting: "Aguardando você", st_blocked: "Bloqueado", st_active: "Ativo", st_paused: "Pausado",
    st_new: "Não iniciado", st_done: "Concluído", st_invalid: "Checkpoint inválido",
    ph_conceito: "Conceito", ph_produto: "Produto", "ph_projeto-plano": "Plano", ph_implementacao: "Implementação",
    ph_revisao: "Revisão", ph_correcoes: "Correções", ph_aceite: "Aceite", ph_concluido: "Concluído",
    tasksOf: "{done}/{total} tasks", noTaskYet: "Sem tasks ainda", specs: "{n} specs",
    worktree: "worktree", alsoIn: "Também em: {list}",
    t_prd: "PRD", t_techspec: "TechSpec", t_tasks: "Tasks", t_reviews: "Revisões", t_workflow: "Workflow",
    t_snapshot: "Snapshot", t_brief: "Brief", t_design: "Revisão de design",
    plan: "Plano (tasks.md)", pending: "pendente", doneWord: "concluída", correction: "{n} tasks de correção",
    noReviews: "Ainda sem revisão de código.", noFile: "Esta spec ainda não tem {name}.",
    start: "Iniciar", startWt: "Iniciar em worktree", cont: "Continuar", auto: "Continuar em modo auto",
    monitored: "Continuar em modo monitorado", startAuto: "Iniciar em modo auto", startMonitored: "Iniciar em modo monitorado",
    del: "Apagar", openFolder: "Abrir pasta", edit: "Editar", save: "Salvar", cancel: "Cancelar", reload: "Recarregar",
    back: "Voltar", saved: "Salvo", conflict: "O arquivo mudou no disco. Recarregue ou copie o seu texto antes.",
    level: "Nível", mode: "Modo", review: "Revisão", next: "Próximo",
    newTitle: "Nova spec", newHint: "Descreva o pedido. O agente executa {skill} com ele e depois o fluxo SDD.",
    newPlaceholder: "O que você quer construir ou mudar?", startHere: "Iniciar aqui", startInWt: "Iniciar em worktree…",
    wtTitle: "Iniciar num worktree novo", branch: "Branch", wtWhere: "Pasta: {path}",
    wtCreate: "Criar worktree e iniciar", copyQ: "Copiar a pasta da spec para o worktree",
    notCommitted: "A pasta desta spec não está no último commit ({state}). Um worktree novo não tem a pasta.",
    st_untracked: "fora do git", st_changed: "com mudanças", checking: "Conferindo o git…",
    delTitle: "Apagar {name}?", delHint: "A pasta vai para a Lixeira: {path}",
    delOpen: "Esta spec não está concluída. O agente perde o checkpoint e o plano.",
    delTracked: "O git controla arquivos desta pasta: o git mostra a remoção como mudança.",
    delOthers: "As cópias em outros worktrees ficam.", delBtn: "Mover para a Lixeira",
    launched: "Agente iniciado", launchedBody: "{skill} para {name}", wtMade: "Worktree criado",
    failed: "Spec Board", badBranch: "Este nome de branch não é válido.", emptyRequest: "Escreva o pedido antes.",
    deleted: "Movida para a Lixeira", demoNo: "Specs de exemplo: nada muda no disco.",
  },
};

const errText = (e) => String(e?.message ?? e ?? "").split(/\r?\n/).filter(Boolean).slice(-2).join(" ");

/** The folder that the shown space works in: its focused terminal, else a terminal of the tab. */
function location() {
  const f = focused();
  const space = spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active);
  const all = panes();
  let pane = f?.pane ? all.find((p) => p.pane === f.pane) : null;
  if (pane && !pane.terminal) {
    pane = all.find((p) => p.tab === pane.tab && p.terminal && p.cwd && p.focused)
      || all.find((p) => p.tab === pane.tab && p.terminal && p.cwd) || null;
  }
  if (!pane && space) {
    const tab = space.tabs.find((t) => t.active)?.id;
    pane = all.find((p) => p.tab === tab && p.terminal && p.cwd) ?? null;
  }
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, remote: space?.machine != null };
}

export default class SpecBoard extends View {
  init(given, cx) {
    this.props = (given && Object.keys(given).length ? given : props()) || {};
    this.keys = cx.focus_handle();
    this.width = 0;
    this.repo = null;
    this.specs = [];
    this.loading = false;
    this.again = false;
    this.error = "";
    this.loc = "";
    this.sel = null; // slug (lower case) of the open spec
    this.tab = "prd";
    this.doc = null; // a file of the Tasks or Reviews tab, relative to the spec
    this.texts = new Map(); // absolute path → text (null: missing)
    this.times = new Map(); // absolute path → file time when read
    this.edit = null; // { path, state, original }
    this.sheet = null;
    this.menu = null; // the mode menu of the open spec
    this.sortOpen = false;
    this.watched = new Set();
    this.watchGen = 0;
    this.demo = null;
    this.search = InputState.new({ placeholder: this.s("search") });
    this.search.on("change", (_e, cx) => cx.notify());
    cx.timer.every(1500, (cx) => kitOff() || this.follow(cx));
    cx.timer.every(30000, (cx) => kitOff() || this.refresh(cx));
    this.follow(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "refresh") this.refresh(cx);
        else if (c === "new") this.openNew(cx);
        else if (c === "demo") { this.demo = this.demo ? null : demoSpecs(); this.sel = null; this.refresh(cx); }
        else if (c === "back") { this.sheet = null; if (this.doc) this.doc = null; else this.select(null, cx); }
        else if (c.startsWith("open-")) this.select(this.specs.find((s) => s.slug.toLowerCase() === c.slice(5).toLowerCase()) ?? null, cx);
        else if (c.startsWith("tab-")) { this.tab = c.slice(4); this.doc = null; this.edit = null; }
        else if (c.startsWith("doc-") && this.selected) { this.doc = c.slice(4); }
        else if (c === "edit" && this.selected) { const sp = this.selected; const rel = this.doc ?? this.tabsOf(sp).find((x) => x.id === this.tab)?.file; if (rel) this.startEdit(join(sp.path, rel), cx); }
        else if (c === "delete" && this.selected) this.askDelete(this.selected, cx);
        else if (c === "worktree" && this.selected) this.openWorktree(this.selected, null, cx);
        else if (c === "menu" && this.selected) this.menu = this.menu ? null : this.selected.slug;
        cx.notify();
      }
    });
  }

  /** The language: the kit setting when it is set, else the `lang` prop, else English. */
  get lang() {
    const kit = shared(KEY_LANG);
    return STR[kit] ? kit : STR[this.props?.lang] ? this.props.lang : "en";
  }

  s(key, vars) { return fill(STR[this.lang][key] ?? STR.en[key] ?? key, vars); }

  // ---- data ----------------------------------------------------------------

  /** Rescans when the shown space moves to another folder. */
  follow(cx) {
    const loc = location();
    const key = `${loc.remote}|${loc.cwd ?? ""}`;
    if (key === this.loc) return;
    this.loc = key;
    this.remote = loc.remote;
    this.cwd = loc.cwd;
    this.repo = null;
    this.specs = [];
    this.sel = null;
    this.doc = null;
    this.edit = null;
    this.sheet = null;
    this.refresh(cx);
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    if (this.demo) {
      this.repo = this.demo.repo;
      this.specs = this.demo.specs;
      for (const [k, v] of this.demo.texts) if (!this.texts.has(k)) this.texts.set(k, v);
      cx.notify();
      return;
    }
    if (!this.cwd || this.remote) { cx.notify(); return; }
    this.loading = true;
    this.error = "";
    cx.notify();
    const cwd = this.cwd;
    cx.spawn(async (cx) => {
      try {
        const repo = await findRepo(cwd);
        const { specs, tasksDirs } = await scan(repo);
        if (cwd !== this.cwd) return;
        this.repo = repo;
        this.specs = specs;
        this.forgetChanged(specs);
        this.watch(tasksDirs, cx);
      } catch (e) {
        this.error = errText(e);
      } finally {
        this.loading = false;
        cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  /** Drops the texts of files that changed since they were read, and reads the shown one again. */
  forgetChanged(specs) {
    for (const s of specs) {
      for (const f of this.filesOf(s)) {
        const abs = join(s.path, f.rel);
        if (this.times.has(abs) && this.times.get(abs) !== f.time && this.edit?.path !== abs) {
          this.texts.delete(abs);
          this.times.delete(abs);
        }
      }
    }
  }

  filesOf(s) {
    const out = [];
    for (const rel of Object.values(s.docs)) if (rel) out.push({ rel, time: s.time });
    return out;
  }

  /** Watches each tasks/ folder; a change rescans. A new list of folders starts new watches. */
  watch(dirs, cx) {
    const key = [...dirs].sort().join("|");
    if (key === [...this.watched].sort().join("|")) return;
    this.watched = new Set(dirs);
    const gen = ++this.watchGen;
    for (const dir of dirs) {
      cx.spawn(async (cx) => {
        for (;;) {
          try { await watchFolder(native(dir)); } catch { return; }
          if (gen !== this.watchGen) return;
          this.texts.clear();
          this.times.clear();
          this.refresh(cx);
        }
      });
    }
  }

  /** The text of a file: cached, else read now (render shows a blank until it comes). */
  text(path, cx) {
    if (this.texts.has(path)) return this.texts.get(path);
    if (this.demo) return null;
    this.texts.set(path, undefined);
    cx.spawn(async (cx) => {
      const t = await readTextFile(path).catch(() => null);
      this.texts.set(path, t);
      const spec = this.specs.find((s) => path.startsWith(s.path + "/"));
      this.times.set(path, spec?.time ?? 0);
      cx.notify();
    });
    return undefined;
  }

  get selected() {
    return this.specs.find((s) => s.slug.toLowerCase() === this.sel) ?? null;
  }

  // ---- actions ---------------------------------------------------------------

  toast(title, body = "", level = "info") { notify({ title, body, level, timeout: 4000 }); }

  closeDialog() {
    const id = this.props?.overlay ?? shared("kanban.panelDialog")?.id;
    if (!id) return false;
    closeOverlay(id);
    return true;
  }

  select(spec, cx) {
    this.sel = spec ? spec.slug.toLowerCase() : null;
    this.doc = null;
    this.edit = null;
    this.menu = null;
    this.sheet = null;
    if (spec) this.tab = this.tabsOf(spec)[0]?.id ?? "prd";
    cx.notify();
  }

  /** Starts sdd-orquestrar-fluxo for `spec` in its folder. `mode`: "auto", "monitorado" or null. */
  continueSpec(spec, mode, cx) {
    this.menu = null;
    if (this.demo) { this.toast(this.s("demo"), this.s("demoNo")); return; }
    cx.spawn(async (cx) => {
      try {
        const skill = await resolveSkill(flowNames(), spec.where.path);
        const args = `--prd ${spec.slug}${mode ? ` --modo ${mode}` : ""}`;
        await launch(spec.where.path, promptFor(skill, args), spec.slug);
        this.toast(this.s("launched"), this.s("launchedBody", { skill, name: spec.slug }), "success");
        this.closeDialog();
      } catch (e) {
        this.toast(this.s("failed"), errText(e), "error");
      }
      cx.notify();
    });
  }

  openNew(cx) {
    const state = TextareaState.new({ placeholder: this.s("newPlaceholder"), rows: 5 });
    state.on("change", (_e, cx) => cx.notify());
    this.sheet = { kind: "new", state, error: "", skill: triageNames()[0] };
    this.menu = null;
    cx.timer.after(40, () => state.focus());
    if (this.repo) {
      cx.spawn(async (cx) => {
        const skill = await resolveSkill(triageNames(), this.repo.root);
        if (this.sheet?.kind === "new") { this.sheet.skill = skill; cx.notify(); }
      });
    }
    cx.notify();
  }

  /** The sheet that makes a worktree: for an existing spec, or for a new request (`request`). */
  openWorktree(spec, request, cx, mode = null) {
    const suggestion = spec ? `${branchPrefix()}${spec.slug}` : branchFrom(request);
    const state = InputState.new({ value: suggestion });
    state.on("change", (_e, cx) => cx.notify());
    this.sheet = { kind: "worktree", spec, request, state, mode, copy: true, commit: spec ? "checking" : null, error: "", busy: false };
    this.menu = null;
    cx.timer.after(40, () => state.focus());
    if (spec && !this.demo && this.repo?.git) {
      cx.spawn(async (cx) => {
        const c = await commitState(spec).catch(() => "untracked");
        if (this.sheet?.spec === spec) { this.sheet.commit = c; cx.notify(); }
      });
    } else if (spec) {
      this.sheet.commit = "committed";
    }
    cx.notify();
  }

  startHere(cx) {
    const sh = this.sheet;
    const request = sh.state.value().trim();
    if (!request) { sh.error = this.s("emptyRequest"); cx.notify(); return; }
    if (this.demo) { this.toast(this.s("demo"), this.s("demoNo")); return; }
    cx.spawn(async (cx) => {
      try {
        const skill = await resolveSkill(triageNames(), this.repo.root);
        const folder = this.selected?.where?.path ?? this.repo.worktrees.find((w) => this.cwd && this.cwd.replace(/\\/g, "/").toLowerCase().startsWith(w.path.toLowerCase()))?.path ?? this.repo.root;
        await launch(folder, promptFor(skill, `--prompt ${quoteArg(request)}`));
        this.sheet = null;
        this.toast(this.s("launched"), this.s("launchedBody", { skill, name: request.slice(0, 60) }), "success");
        this.closeDialog();
      } catch (e) {
        sh.error = errText(e);
      }
      cx.notify();
    });
  }

  createWorktree(cx) {
    const sh = this.sheet;
    const branch = sh.state.value().trim();
    if (this.demo) { this.toast(this.s("demo"), this.s("demoNo")); return; }
    sh.busy = true;
    sh.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const from = sh.spec?.where.path ?? this.repo.root;
        try { await checkBranch(from, branch); } catch { throw new Error(this.s("badBranch")); }
        const path = await makeWorktree(from, this.repo.name, branch);
        this.toast(this.s("wtMade"), path, "success");
        let skill;
        let prompt;
        if (sh.spec) {
          if (sh.commit !== "committed" && sh.copy) await copySpec(sh.spec, path);
          skill = await resolveSkill(flowNames(), path);
          prompt = promptFor(skill, `--prd ${sh.spec.slug}${sh.mode ? ` --modo ${sh.mode}` : ""}`);
        } else {
          skill = await resolveSkill(triageNames(), path);
          prompt = promptFor(skill, `--prompt ${quoteArg(sh.request)}`);
        }
        await launch(path, prompt, sh.spec?.slug);
        this.sheet = null;
        this.toast(this.s("launched"), this.s("launchedBody", { skill, name: sh.spec?.slug ?? branch }), "success");
        this.refresh(cx);
        this.closeDialog();
      } catch (e) {
        sh.error = errText(e);
        sh.busy = false;
      }
      cx.notify();
    });
  }

  askDelete(spec, cx) {
    this.sheet = { kind: "delete", spec, tracked: false, busy: false, error: "" };
    this.menu = null;
    if (!this.demo && this.repo?.git) {
      cx.spawn(async (cx) => {
        const tracked = await isTracked(spec).catch(() => false);
        if (this.sheet?.spec === spec) { this.sheet.tracked = tracked; cx.notify(); }
      });
    }
    cx.notify();
  }

  doDelete(cx) {
    const sh = this.sheet;
    if (this.demo) { this.toast(this.s("demo"), this.s("demoNo")); return; }
    sh.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await trash(sh.spec.path);
        this.toast(this.s("deleted"), sh.spec.slug, "success");
        this.sheet = null;
        this.sel = null;
        this.refresh(cx);
      } catch (e) {
        sh.error = errText(e);
        sh.busy = false;
      }
      cx.notify();
    });
  }

  openFolder(spec) {
    if (this.demo) return;
    if (isWin()) exec("explorer", [native(spec.path)]).catch(() => {});
    else exec("sh", ["-c", 'open "$1" 2>/dev/null || xdg-open "$1"', "sh", spec.path]).catch(() => {});
  }

  startEdit(path, cx) {
    const original = this.texts.get(path) ?? "";
    const state = EditorState.new({
      language: "markdown", value: original, soft_wrap: true, line_numbers: false, folding: false,
      font_family: settings().font_family, font_size: 13,
    });
    this.edit = { path, state, original, error: "" };
    cx.notify();
  }

  saveEdit(cx) {
    const ed = this.edit;
    const value = ed.state.value();
    if (this.demo) {
      this.texts.set(ed.path, value);
      this.edit = null;
      cx.notify();
      return;
    }
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(native(ed.path), value, ed.original);
        this.texts.set(ed.path, value);
        this.edit = null;
        this.toast(this.s("saved"), ed.path.split("/").slice(-2).join("/"), "success");
      } catch {
        ed.error = this.s("conflict");
      }
      cx.notify();
    });
  }

  reloadEdit(cx) {
    const path = this.edit.path;
    this.edit = null;
    this.texts.delete(path);
    cx.notify();
  }

  onKey(e, cx) {
    if (e.key === "escape") {
      if (this.sheet) { this.sheet = null; cx.stop_propagation(); cx.notify(); return; }
      if (this.menu || this.sortOpen) { this.menu = null; this.sortOpen = false; cx.stop_propagation(); cx.notify(); return; }
      if (!this.edit && this.closeDialog()) cx.stop_propagation();
      return;
    }
    if ((e.key === "backspace" || e.key === "left") && !this.edit && !this.sheet) {
      if (this.doc) { this.doc = null; cx.notify(); } else if (this.sel && this.width < WIDE) this.select(null, cx);
    }
  }

  /** on_key_down for a text field: Esc closes the sheet, else the dialog. */
  fieldKey() {
    return (e, cx) => {
      if (e.key !== "escape") return;
      if (this.sheet) { this.sheet = null; cx.notify(); } else if (this.search.value()) { this.search.set_value(""); cx.notify(); } else if (!this.closeDialog()) return;
      cx.stop_propagation();
    };
  }

  // ---- pieces ------------------------------------------------------------------

  statusColor(t, st) {
    return { waiting: t.blocked, blocked: t.ansi1, active: t.working, paused: t.ansi5, new: t.muted, done: t.done, invalid: t.ansi1 }[st] ?? t.muted;
  }

  chip(t, st, big = false) {
    const c = this.statusColor(t, st);
    return h_flex().h(big ? 22 : 20).px(big ? 9 : 7).gap(5).flex_none().items_center().rounded(11)
      .bg(tint(c, "22")).text_color(c).text_size(big ? 12 : 11).font_semibold()
      .child(div().size(6).rounded(3).bg(c).when(st === "active", (e) => e.loop("opacity", { from: 0.35, to: 1, period: 1200 })))
      .child(this.s(`st_${st}`));
  }

  /** 7 segments, one per phase: past ones in the status color, the current one bright. */
  stepper(t, spec, labels = false) {
    const cur = spec.checkpoint ? phaseIndex(spec.checkpoint.phase) : -1;
    const c = this.statusColor(t, spec.status);
    const done = spec.status === "done";
    return v_flex().w_full().gap(5)
      .child(h_flex().w_full().gap(3).children(PHASES.map((p, i) => {
        const past = done || i < cur;
        const now = !done && i === cur;
        return div().flex_1().h(5).rounded(3)
          .bg(past ? tint(c, "aa") : now ? c : tint(t.foreground, "14"))
          .when(now && spec.status === "active", (e) => e.loop("opacity", { from: 0.45, to: 1, period: 1400 }))
          .tooltip(this.s(`ph_${p}`));
      })))
      .when(labels, (e) => e.child(h_flex().w_full().gap(3).children(PHASES.map((p, i) => div().flex_1().min_w(0).truncate()
        .text_size(10).text_color(i === cur && !done ? t.foreground : t.dim).when(i === cur && !done, (x) => x.font_semibold())
        .child(this.s(`ph_${i === 0 && spec.checkpoint?.phase === "conceito" ? "conceito" : p}`))))));
  }

  progress(t, spec) {
    const c = spec.status === "done" ? t.done : this.statusColor(t, spec.status === "new" ? "active" : spec.status);
    const pct = spec.total ? Math.round((spec.doneCount / spec.total) * 100) : 0;
    return h_flex().w_full().gap(8).items_center()
      .child(div().flex_1().h(6).rounded(3).bg(tint(t.foreground, "14"))
        .child(div().h_full().w(`${pct}%`).rounded(3).bg(c)))
      .child(div().flex_none().text_size(11).text_color(t.muted)
        .child(spec.total ? this.s("tasksOf", { done: spec.doneCount, total: spec.total }) : this.s("noTaskYet")));
  }

  phaseLabel(spec) {
    const p = spec.checkpoint?.phase;
    return p ? this.s(`ph_${p}`) : "";
  }

  wtBadge(t, spec) {
    return h_flex().h(18).px(6).gap(4).flex_none().items_center().rounded(5).bg(tint(t.accent, "1c")).text_color(t.accent)
      .text_size(10).max_w(170)
      .child(svg(icon("git-branch")).size(10).flex_none())
      .child(div().truncate().child(spec.where.branch ?? this.s("worktree")));
  }

  iconBtn(t, id, name, tooltip, onClick, { active = false, spin = false } = {}) {
    return div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(7).cursor_pointer()
      .tooltip(tooltip).when(active, (e) => e.bg(tint(t.accent, "26")))
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(svg(icon(spin ? "spinner" : name)).size(15).text_color(active || spin ? t.accent : t.muted).when(spin, (e) => e.spin(900)));
  }

  btn(t, id, label, onClick, { tone = "", symbol = "", disabled = false, compact = false } = {}) {
    const color = disabled ? t.dim : tone === "danger" ? t.ansi1 : tone === "primary" ? t.accent : t.foreground;
    const solid = tone === "primary" && !disabled;
    return h_flex().id(id).h(compact ? 26 : 30).px(compact ? 9 : 12).gap(6).flex_none().items_center().rounded(8)
      .text_size(12).font_semibold()
      .bg(solid ? t.solid ?? t.accent : tone === "danger" ? tint(t.ansi1, "1a") : t.raised)
      .text_color(solid ? t.solid_foreground ?? t.accent_foreground : color)
      .border_1().border_color(solid ? t.solid ?? t.accent : tone === "danger" ? tint(t.ansi1, "55") : t.border)
      .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
      .when(Boolean(symbol), (e) => e.child(svg(icon(symbol)).size(13).flex_none()))
      .child(label);
  }

  // ---- list ------------------------------------------------------------------

  header(t) {
    const sub = this.demo ? this.s("demo") : this.repo ? this.repo.name : "";
    return h_flex().h(46).flex_none().px(12).gap(8).items_center().border_b_1().border_color(t.border)
      .child(div().size(26).flex_none().flex().items_center().justify_center().rounded(7).bg(tint(t.accent, "22"))
        .child(svg(icon("specs")).size(15).text_color(t.accent)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(13).font_semibold().child(this.s("title")))
        .when(Boolean(sub), (e) => e.child(div().text_size(11).text_color(t.dim).truncate().child(sub))))
      .child(this.iconBtn(t, "sb-new", "plus", this.s("newSpec"), (cx) => this.openNew(cx), { active: this.sheet?.kind === "new" }))
      .child(this.iconBtn(t, "sb-sort", "sort", this.s("sort"), (cx) => { this.sortOpen = !this.sortOpen; cx.notify(); }, { active: this.sortOpen }))
      .child(this.iconBtn(t, "sb-refresh", "refresh", this.s("refresh"), (cx) => this.refresh(cx), { spin: this.loading }));
  }

  get sortMode() {
    const v = shared(KEY.sort);
    return ["urgency-group", "urgency", "name"].includes(v) ? v : "urgency-group";
  }

  visible() {
    const q = this.search.value().trim().toLowerCase();
    const showDone = shared(KEY.showDone) === true;
    return this.specs.filter((s) => (showDone || s.status !== "done" || s.slug.toLowerCase() === this.sel)
      && (!q || s.slug.toLowerCase().includes(q)));
  }

  toolbar(t) {
    const showDone = shared(KEY.showDone) === true;
    const doneCount = this.specs.filter((s) => s.status === "done").length;
    return v_flex().flex_none().px(10).pt(10).pb(6).gap(8)
      .child(h_flex().id("sb-search").h(32).px(10).gap(8).items_center().rounded(9).bg(t.raised).border_1().border_color(t.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_key_down(this.fieldKey())
        .child(svg(icon("search")).size(13).flex_none().text_color(t.dim))
        .child(Input.new(this.search).h_full().flex_1().min_w(0).text_size(12)))
      .when(this.sortOpen, (e) => e.child(h_flex().gap(6).flex_wrap().children([
        ["urgency-group", "sortGroup"], ["urgency", "sortUrgency"], ["name", "sortName"],
      ].map(([v, k]) => {
        const on = this.sortMode === v;
        return h_flex().id(`sb-sort-${v}`).h(24).px(9).items_center().rounded(12).text_size(11).cursor_pointer()
          .bg(on ? tint(t.accent, "26") : t.raised).text_color(on ? t.accent : t.muted).border_1().border_color(on ? tint(t.accent, "66") : t.border)
          .on_click((_e, cx) => { setShared(KEY.sort, v === "urgency-group" ? null : v); cx.notify(); })
          .child(this.s(k));
      }))))
      .child(h_flex().gap(8).items_center()
        .child(h_flex().id("sb-done").gap(6).items_center().cursor_pointer()
          .on_click((_e, cx) => { setShared(KEY.showDone, showDone ? null : true); cx.notify(); })
          .child(div().w(26).h(15).rounded(8).p(2).bg(showDone ? t.accent : tint(t.foreground, "22"))
            .child(div().size(11).rounded(6).bg(t.background).when(showDone, (e) => e.ml(11))))
          .child(div().text_size(11).text_color(t.muted).child(`${this.s("showDone")} (${doneCount})`)))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(this.s("specs", { n: this.specs.length }))));
  }

  card(t, spec, inGroup) {
    const on = spec.slug.toLowerCase() === this.sel;
    const c = this.statusColor(t, spec.status);
    const hil = spec.status === "waiting" ? hilText(spec.checkpoint?.pending_hil) : "";
    const label = inGroup ? spec.slug.slice(inGroup.length + 1) : spec.slug;
    return h_flex().id(`sb-card-${spec.slug}`).mx(10).mb(6).rounded(10).overflow_hidden().cursor_pointer()
      .bg(on ? tint(t.accent, "14") : t.surface ?? t.raised).border_1().border_color(on ? tint(t.accent, "88") : t.border)
      .hover((s) => s.border_color(tint(t.accent, "66")))
      .on_click((_e, cx) => this.select(spec, cx))
      .child(div().w(3).h_full().flex_none().bg(c))
      .child(v_flex().flex_1().min_w(0).px(10).py(9).gap(7)
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(label))
          .when(!spec.where.main, (e) => e.child(this.wtBadge(t, spec))))
        .child(h_flex().gap(6).items_center()
          .child(this.chip(t, spec.status))
          .when(Boolean(this.phaseLabel(spec)), (e) => e.child(div().text_size(11).text_color(t.muted).truncate().child(this.phaseLabel(spec))))
          .when(Boolean(hil), (e) => e.child(div().text_size(11).text_color(c).font_semibold().truncate().child(`· ${hil}`))))
        .when(spec.status !== "new", (e) => e.child(this.stepper(t, spec)))
        .child(this.progress(t, spec)));
  }

  groupHeader(t, row) {
    const done = row.specs.reduce((n, s) => n + s.doneCount, 0);
    const total = row.specs.reduce((n, s) => n + s.total, 0);
    return h_flex().mx(12).mt(6).mb(6).gap(8).items_center()
      .child(svg(icon("folder")).size(12).flex_none().text_color(t.dim))
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(row.name))
      .child(div().text_size(10).text_color(t.dim).child(`${row.specs.length} · ${total ? Math.round((done / total) * 100) : 0}%`))
      .child(div().flex_1().h(1).bg(t.border));
  }

  message(t, text) {
    return div().p(18).text_size(12).text_color(t.dim).child(text);
  }

  list(t) {
    let body;
    if (this.remote && !this.demo) body = this.message(t, this.s("remote"));
    else if (!this.cwd && !this.demo) body = this.message(t, this.s("noRepo"));
    else if (this.error) body = this.message(t, this.error);
    else if (!this.repo && this.loading) body = this.message(t, this.s("loading"));
    else if (!this.specs.length) body = this.message(t, this.loading ? this.s("loading") : this.s("noTasks"));
    else {
      const shown = this.visible();
      const rows = rowsOf(sortSpecs(shown, this.sortMode === "name" ? "name" : "urgency"), this.sortMode === "urgency-group");
      body = shown.length
        ? v_flex().pb(10).children(rows.map((r) => (r.kind === "group" ? this.groupHeader(t, r) : this.card(t, r.spec, r.inGroup))))
        : this.message(t, this.s("noMatch"));
    }
    return v_flex().size_full().min_h(0)
      .child(this.toolbar(t))
      .child(v_flex().id("sb-list").flex_1().min_h(0).overflow_y_scrollbar().child(body));
  }

  // ---- detail -------------------------------------------------------------------

  tabsOf(spec) {
    const d = spec.docs;
    const tabs = [];
    if (d.brief) tabs.push({ id: "brief", file: d.brief });
    tabs.push({ id: "prd", file: d.prd });
    tabs.push({ id: "techspec", file: d.techspec });
    if (d.tasks || spec.tasks.length) tabs.push({ id: "tasks", count: spec.total });
    if (spec.reviews.length || spec.designs.length) tabs.push({ id: "reviews", count: spec.reviews.length + spec.designs.length });
    if (d.workflow) tabs.push({ id: "workflow", file: d.workflow });
    if (d.snapshot) tabs.push({ id: "snapshot", file: d.snapshot });
    return tabs;
  }

  actions(t, spec) {
    const isNew = spec.status === "new";
    const row = h_flex().gap(6).flex_wrap().items_center();
    if (isNew) {
      row.child(this.btn(t, "sb-start", this.s("start"), (cx) => this.continueSpec(spec, null, cx), { tone: "primary", symbol: "play" }))
        .child(this.btn(t, "sb-start-wt", this.s("startWt"), (cx) => this.openWorktree(spec, null, cx), { symbol: "git-branch" }));
    } else if (spec.status !== "done") {
      row.child(h_flex()
        .child(this.btn(t, "sb-cont", this.s("cont"), (cx) => this.continueSpec(spec, null, cx), { tone: "primary", symbol: "play" }).rounded_r(0))
        .child(div().id("sb-cont-menu").h(30).w(26).flex().items_center().justify_center().rounded_r(8).cursor_pointer()
          .bg(t.solid ?? t.accent).border_l_1().border_color(tint(t.background, "55"))
          .hover((s) => s.opacity(0.85))
          .on_click((_e, cx) => { cx.stop_propagation(); this.menu = this.menu ? null : spec.slug; cx.notify(); })
          .child(svg(icon("chevron-down")).size(13).text_color(t.solid_foreground ?? t.accent_foreground))));
    }
    if (isNew) {
      row.child(div().id("sb-start-menu").h(30).w(30).flex().items_center().justify_center().rounded(8).cursor_pointer()
        .bg(t.raised).border_1().border_color(t.border).hover((s) => s.bg(t.hover)).tooltip(this.s("startAuto"))
        .on_click((_e, cx) => { cx.stop_propagation(); this.menu = this.menu ? null : spec.slug; cx.notify(); })
        .child(svg(icon("chevron-down")).size(13).text_color(t.muted)));
    }
    row.child(div().flex_1())
      .child(this.iconBtn(t, "sb-folder", "external-link", this.s("openFolder"), () => this.openFolder(spec)))
      .child(this.iconBtn(t, "sb-del", "trash", this.s("del"), (cx) => this.askDelete(spec, cx)));
    const menu = this.menu === spec.slug
      ? h_flex().gap(6).flex_wrap()
        .child(this.btn(t, "sb-m-auto", this.s(isNew ? "startAuto" : "auto"), (cx) => this.continueSpec(spec, "auto", cx), { compact: true, symbol: "play" }))
        .child(this.btn(t, "sb-m-mon", this.s(isNew ? "startMonitored" : "monitored"), (cx) => this.continueSpec(spec, "monitorado", cx), { compact: true, symbol: "play" }))
        .when(isNew, (e) => e.child(this.btn(t, "sb-m-wt-auto", `${this.s("startWt")} · auto`, (cx) => this.openWorktree(spec, null, cx, "auto"), { compact: true, symbol: "git-branch" })))
      : null;
    return v_flex().gap(8).child(row).when(Boolean(menu), (e) => e.child(menu));
  }

  facts(t, spec) {
    const cp = spec.checkpoint;
    const items = [];
    if (cp?.nivel) items.push([this.s("level"), cp.nivel]);
    if (cp) items.push([this.s("mode"), cp.mode ?? "monitorado"]);
    if (spec.review) items.push([this.s("review"), spec.review]);
    const hil = spec.status === "waiting" ? hilText(cp?.pending_hil) : "";
    const next = spec.status === "done" ? "" : cp?.next_action?.instruction;
    return v_flex().gap(6)
      .when(items.length > 0, (e) => e.child(h_flex().gap(6).flex_wrap().children(items.map(([k, v]) => h_flex().h(20).px(7).gap(4).items_center()
        .rounded(5).bg(tint(t.foreground, "0f")).text_size(11)
        .child(div().text_color(t.dim).child(k)).child(div().text_color(t.foreground).child(String(v)))))))
      .when(Boolean(hil || next), (e) => e.child(h_flex().gap(8).p(8).rounded(8).items_start()
        .bg(tint(this.statusColor(t, spec.status), "14")).border_1().border_color(tint(this.statusColor(t, spec.status), "44"))
        .child(svg(icon("message")).size(13).mt(1).flex_none().text_color(this.statusColor(t, spec.status)))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .when(Boolean(hil), (x) => x.child(div().text_size(12).font_semibold().text_color(this.statusColor(t, spec.status)).child(hil)))
          .when(Boolean(next), (x) => x.child(div().text_size(12).text_color(t.foreground).child(next))))))
      .when(spec.others?.length > 0, (e) => e.child(div().text_size(11).text_color(t.dim)
        .child(this.s("alsoIn", { list: spec.others.map((o) => o.where.branch ?? o.where.path).join(", ") }))));
  }

  detail(t, spec, narrow) {
    const tabs = this.tabsOf(spec);
    if (!tabs.some((x) => x.id === this.tab)) this.tab = tabs[0].id;
    const head = v_flex().flex_none().px(14).pt(12).pb(10).gap(10).border_b_1().border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .when(narrow, (e) => e.child(this.iconBtn(t, "sb-back", "chevron-left", this.s("back"), (cx) => this.select(null, cx))))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(15).font_semibold().truncate().child(spec.slug))
          .child(div().text_size(11).text_color(t.dim).truncate().child(`tasks/${spec.dir}`)))
        .when(!spec.where.main, (e) => e.child(this.wtBadge(t, spec)))
        .child(this.chip(t, spec.status, true)))
      .when(spec.status !== "new", (e) => e.child(this.stepper(t, spec, !narrow)))
      .child(this.progress(t, spec))
      .child(this.facts(t, spec))
      .child(this.actions(t, spec));
    const tabRow = h_flex().id("sb-tabs").flex_none().px(10).gap(2).border_b_1().border_color(t.border).overflow_x_scroll()
      .children(tabs.map((x) => {
        const on = x.id === this.tab;
        return h_flex().id(`sb-tab-${x.id}`).h(34).px(8).gap(5).flex_none().items_center().cursor_pointer()
          .border_b_2().border_color(on ? t.accent : tint(t.background, "00"))
          .text_size(12).text_color(on ? t.foreground : x.file === null ? t.dim : t.muted).when(on, (e) => e.font_semibold())
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.tab = x.id; this.doc = null; this.edit = null; cx.notify(); })
          .child(this.s(`t_${x.id}`))
          .when(x.count != null && x.count > 0, (e) => e.child(div().h(16).px(5).rounded(8).flex().items_center().text_size(10)
            .bg(tint(t.foreground, "14")).text_color(t.muted).child(String(x.count))));
      }));
    return v_flex().size_full().min_h(0)
      .child(head)
      .child(tabRow)
      .child(this.tabBody(t, spec, tabs.find((x) => x.id === this.tab)));
  }

  tabBody(t, spec, tab) {
    if (tab.id === "tasks" && !this.doc) return this.taskList(t, spec);
    if (tab.id === "reviews" && !this.doc) return this.reviewList(t, spec);
    const rel = this.doc ?? tab.file;
    if (!rel) return v_flex().flex_1().child(this.message(t, this.s("noFile", { name: this.s(`t_${tab.id}`) })));
    return this.viewer(t, spec, rel, Boolean(this.doc));
  }

  rowItem(t, id, iconName, color, title, right, onClick) {
    return h_flex().id(id).h(36).px(10).mx(8).gap(9).items_center().rounded(8).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx))
      .child(svg(icon(iconName)).size(14).flex_none().text_color(color))
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(title))
      .when(Boolean(right), (e) => e.child(right));
  }

  taskList(t, spec) {
    const rows = [];
    if (spec.docs.tasks) rows.push(this.rowItem(t, "sb-plan", "file-text", t.accent, this.s("plan"), null, (cx) => { this.doc = spec.docs.tasks; cx.notify(); }));
    for (const task of spec.tasks) {
      const label = `T${String(task.num).padStart(2, "0")}${task.title ? ` — ${task.title}` : ""}`;
      const pill = div().h(18).px(7).rounded(9).flex().items_center().text_size(10)
        .bg(task.done ? tint(t.done, "22") : tint(t.foreground, "10")).text_color(task.done ? t.done : t.muted)
        .child(this.s(task.done ? "doneWord" : "pending"));
      rows.push(this.rowItem(t, `sb-task-${task.num}`, task.done ? "check" : "file-text", task.done ? t.done : t.dim, label, pill,
        (cx) => { this.doc = task.file; cx.notify(); }));
    }
    return v_flex().id("sb-tasklist").flex_1().min_h(0).py(8).overflow_y_scrollbar()
      .children(rows.length ? rows : [this.message(t, this.s("noTaskYet"))]);
  }

  reviewList(t, spec) {
    const rows = [];
    for (const r of spec.reviews) {
      if (!r.report) continue;
      const path = join(spec.path, r.report);
      const word = spec.demo ? spec.review : reviewStatus(this.texts.get(path));
      this.text(path, this.cx);
      const color = /REPROV|REJECT/.test(word ?? "") ? t.ansi1 : /RESSALV|RESERV/.test(word ?? "") ? t.blocked : word ? t.done : t.dim;
      const right = h_flex().gap(6).items_center()
        .when(r.tasks.length > 0, (e) => e.child(div().text_size(10).text_color(t.dim).child(this.s("correction", { n: r.tasks.length }))))
        .when(Boolean(word), (e) => e.child(div().h(18).px(7).rounded(9).flex().items_center().text_size(10).font_semibold()
          .bg(tint(color, "22")).text_color(color).child(word)));
      rows.push(this.rowItem(t, `sb-rev-${r.num}`, "file-text", color, `Code review ${String(r.num).padStart(2, "0")}`, right,
        (cx) => { this.doc = r.report; cx.notify(); }));
      for (const task of r.tasks) {
        rows.push(this.rowItem(t, `sb-rev-${r.num}-${task.num}`, task.done ? "check" : "chevron-right", task.done ? t.done : t.dim,
          `   ${r.dir}/${task.name}`, null, (cx) => { this.doc = task.file; cx.notify(); }));
      }
    }
    spec.designs.forEach((d, i) => rows.push(this.rowItem(t, `sb-design-${i}`, "file-text", t.accent, `${this.s("t_design")} ${d.split("/")[0].replace(/\D+/g, "")}`, null,
      (cx) => { this.doc = d; cx.notify(); })));
    return v_flex().id("sb-revlist").flex_1().min_h(0).py(8).overflow_y_scrollbar()
      .children(rows.length ? rows : [this.message(t, this.s("noReviews"))]);
  }

  viewer(t, spec, rel, sub) {
    const path = join(spec.path, rel);
    const editing = this.edit?.path === path;
    const text = editing ? null : this.text(path, this.cx);
    const bar = h_flex().h(38).flex_none().px(10).gap(6).items_center().border_b_1().border_color(t.border)
      .when(sub, (e) => e.child(this.iconBtn(t, "sb-doc-back", "chevron-left", this.s("back"), (cx) => { this.doc = null; this.edit = null; cx.notify(); })))
      .child(svg(icon("file-text")).size(13).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(rel))
      .when(!editing && typeof text === "string", (e) => e.child(this.btn(t, "sb-edit", this.s("edit"), (cx) => this.startEdit(path, cx), { compact: true, symbol: "pencil" })))
      .when(editing, (e) => e
        .child(this.btn(t, "sb-cancel", this.s("cancel"), (cx) => { this.edit = null; cx.notify(); }, { compact: true }))
        .when(Boolean(this.edit?.error), (x) => x.child(this.btn(t, "sb-reload", this.s("reload"), (cx) => this.reloadEdit(cx), { compact: true })))
        .child(this.btn(t, "sb-save", this.s("save"), (cx) => this.saveEdit(cx), { compact: true, tone: "primary", symbol: "save" })));
    let body;
    if (editing) {
      body = v_flex().flex_1().min_h(0)
        .when(Boolean(this.edit.error), (e) => e.child(div().px(12).py(6).text_size(12).text_color(t.ansi1).bg(tint(t.ansi1, "14")).child(this.edit.error)))
        .child(div().flex_1().min_h(0).p(4).child(Editor.new(this.edit.state).size_full()));
    } else if (typeof text === "string") {
      body = div().id(`sb-doc-${path}`).flex_1().min_h(0).overflow_y_scrollbar().px(18).py(12)
        .child(TextView.markdown(`sb-md-${path}`, rel.endsWith(".json") ? "```json\n" + text + "\n```" : text).selectable(true).scrollable(false).text_size(13));
    } else {
      body = this.message(t, text === null ? this.s("noFile", { name: rel }) : this.s("loading"));
    }
    return v_flex().flex_1().min_h(0).child(bar).child(body);
  }

  // ---- sheets -------------------------------------------------------------------

  sheetView(t) {
    const sh = this.sheet;
    const box = v_flex().id("sb-sheet").flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(12);
    const title = (s) => div().text_size(15).font_semibold().child(s);
    const hint = (s, color = t.muted) => div().text_size(12).text_color(color).child(s);
    const field = (child, id) => h_flex().id(id).px(10).py(6).rounded(9).bg(t.raised).border_1().border_color(t.border)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_key_down(this.fieldKey()).child(child);
    const err = (s) => (s ? div().p(8).rounded(8).text_size(12).text_color(t.ansi1).bg(tint(t.ansi1, "14")).child(s) : null);
    const cancel = this.btn(t, "sb-sh-cancel", this.s("cancel"), (cx) => { this.sheet = null; cx.notify(); });

    if (sh.kind === "new") {
      return box.child(title(this.s("newTitle")))
        .child(hint(this.s("newHint", { skill: sh.skill })))
        .child(field(Textarea.new(sh.state).w_full().min_h(110).text_size(13), "sb-new-text"))
        .when(Boolean(sh.error), (e) => e.child(err(sh.error)))
        .child(h_flex().gap(8).flex_wrap()
          .child(this.btn(t, "sb-new-here", this.s("startHere"), (cx) => this.startHere(cx), { tone: "primary", symbol: "play" }))
          .child(this.btn(t, "sb-new-wt", this.s("startInWt"), (cx) => {
            const req = sh.state.value().trim();
            if (!req) { sh.error = this.s("emptyRequest"); cx.notify(); return; }
            this.openWorktree(null, req, cx);
          }, { symbol: "git-branch" }))
          .child(div().flex_1()).child(cancel));
    }

    if (sh.kind === "worktree") {
      const branch = sh.state.value().trim();
      const where = this.repo ? worktreePath(this.repo.name, branch || "…") : "";
      const needCopy = sh.spec && sh.commit && sh.commit !== "committed" && sh.commit !== "checking";
      return box.child(title(this.s("wtTitle")))
        .child(hint(sh.spec ? sh.spec.slug : sh.request))
        .child(v_flex().gap(4)
          .child(div().text_size(11).font_semibold().text_color(t.muted).child(this.s("branch")))
          .child(field(Input.new(sh.state).w_full().h(22).text_size(13), "sb-wt-branch"))
          .child(hint(this.s("wtWhere", { path: native(where) }), t.dim)))
        .when(sh.commit === "checking", (e) => e.child(hint(this.s("checking"), t.dim)))
        .when(Boolean(needCopy), (e) => e.child(v_flex().gap(8).p(10).rounded(9).bg(tint(t.blocked, "14")).border_1().border_color(tint(t.blocked, "55"))
          .child(div().text_size(12).text_color(t.foreground).child(this.s("notCommitted", { state: this.s(`st_${sh.commit}`) })))
          .child(h_flex().id("sb-copy").gap(8).items_center().cursor_pointer()
            .on_click((_e, cx) => { sh.copy = !sh.copy; cx.notify(); })
            .child(div().size(16).rounded(4).flex().items_center().justify_center().border_1()
              .border_color(sh.copy ? t.accent : t.input ?? t.border).bg(sh.copy ? t.accent : t.background)
              .when(sh.copy, (x) => x.child(svg(icon("check")).size(11).text_color(t.accent_foreground))))
            .child(div().text_size(12).child(this.s("copyQ"))))))
        .when(Boolean(sh.error), (e) => e.child(err(sh.error)))
        .child(h_flex().gap(8)
          .child(this.btn(t, "sb-wt-go", this.s("wtCreate"), (cx) => this.createWorktree(cx),
            { tone: "primary", symbol: sh.busy ? "spinner" : "git-branch", disabled: sh.busy || !branch || sh.commit === "checking" }))
          .child(div().flex_1()).child(cancel));
    }

    if (sh.kind === "delete") {
      const s = sh.spec;
      return box.child(title(this.s("delTitle", { name: s.slug })))
        .child(hint(this.s("delHint", { path: native(s.path) })))
        .when(s.status !== "done", (e) => e.child(hint(this.s("delOpen"), t.ansi1)))
        .when(sh.tracked, (e) => e.child(hint(this.s("delTracked"), t.blocked)))
        .when(s.others?.length > 0, (e) => e.child(hint(this.s("delOthers"), t.dim)))
        .when(Boolean(sh.error), (e) => e.child(err(sh.error)))
        .child(h_flex().gap(8)
          .child(this.btn(t, "sb-del-go", this.s("delBtn"), (cx) => this.doDelete(cx), { tone: "danger", symbol: "trash", disabled: sh.busy }))
          .child(div().flex_1()).child(cancel));
    }
    return box;
  }

  // ---- render -----------------------------------------------------------------------

  render(cx) {
    if (kitOff()) return offView();
    this.cx = cx;
    const t = theme();
    const wide = this.width >= WIDE;
    if (wide && !this.selected && this.specs.length) {
      // Side by side, the detail is never empty: open the first spec of the list.
      const first = sortSpecs(this.visible(), this.sortMode === "name" ? "name" : "urgency")[0];
      if (first) { this.sel = first.slug.toLowerCase(); this.tab = this.tabsOf(first)[0]?.id ?? "prd"; }
    }
    const spec = this.selected;
    let body;
    if (this.sheet) {
      body = wide
        ? h_flex().flex_1().min_h(0)
          .child(div().w(LIST_W).flex_none().h_full().border_r_1().border_color(t.border).child(this.list(t)))
          .child(v_flex().flex_1().min_w(0).h_full().child(this.sheetView(t)))
        : v_flex().flex_1().min_h(0).child(this.sheetView(t));
    } else if (wide) {
      body = h_flex().flex_1().min_h(0)
        .child(div().w(LIST_W).flex_none().h_full().border_r_1().border_color(t.border).child(this.list(t)))
        .child(v_flex().flex_1().min_w(0).h_full()
          .when(Boolean(spec), (e) => e.child(this.detail(t, spec, false))));
    } else {
      body = v_flex().flex_1().min_h(0).child(spec ? this.detail(t, spec, true) : this.list(t));
    }
    return v_flex().id("spec-board").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.keys)
      .on_mouse_down("left", () => { if (this.props?.overlay ?? shared("kanban.panelDialog")?.id) this.keys.focus(); })
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_size_change((size, cx) => {
        const w = Math.round(size.width / (settings().zoom || 1));
        if (w !== this.width) { this.width = w; cx.notify(); }
      })
      .child(this.header(t))
      .child(body);
  }
}
