// Start an agent on a work item in a fresh git worktree, and the Prompts dialog behind the
// cog. Part of prs and issues: each opens itself as one of these dialogs with
// props.dialog "agent" or "prompts". The source is shared/agent-dialog.js.
//
// "agent" props: { mod, kind: "issue" | "pr", repo, on, key, title, icon, vars, branches, tabs }
//   repo:     a folder inside the repository (the main checkout is found from it)
//   on:       the machine (a space's `machine`), null for this computer
//   key, title, icon: what the header shows (icon: a kind from links.js, e.g. "bug", "pr")
//   vars:     the placeholders the prompt templates read (prompts.js PLACEHOLDERS)
//   branches: { mode: branch }, the new branch per mode, editable here
//   tabs:     { mode: name }, the new space's first tab per mode
// "prompts" props: { mod, kind, space }

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { run, props, closeOverlay, theme, exec, knownAgents, notify, spaces, readTextFile, shared, setShared, home as localHome, window as appWindow } from "herdr";
const platform = () => { try { return appWindow().platform; } catch { return "macos"; } };
import { fs, icon, kindColor, avatar, spaceRepo, button as kitButton, chip as kitChip, segmented, iconButton, programTile } from "./links.js";
import { MODES, ABOUT, PLACEHOLDERS, DEFAULTS, promptModes, placeholdersOf, fill, clean, repoPrompts, trustPrompts, userPrompts, saveUserPrompts, template, mainCheckout } from "./prompts.js";
import { worktrees, maybeWorktrees } from "./core.js";

const cut = (text, n) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const LAST = "agent:last";
const lastAgent = () => { try { return localStorage.getItem(LAST); } catch { return null; } };
const keepAgent = (name) => { try { localStorage.setItem(LAST, name); } catch { /* best effort */ } };

// The home folder on the space's machine: this computer's from Herdr (Windows too), a remote one's
// from its shell. null when it can't be read (create() then refuses rather than guess a path).
async function homeOf(on) {
  if (!on) return localHome() || null;
  // Git Bash on Windows says /c/Users/x: cygpath turns it into C:/Users/x, which git.exe reads.
  const r = await exec("sh", ["-c", 'h=$HOME; command -v cygpath >/dev/null 2>&1 && h=$(cygpath -m "$h"); printf %s "$h"'], { on }).catch(() => null);
  const h = r?.code === 0 ? r.stdout.trim() : "";
  return /^(\/|[A-Za-z]:\/)/.test(h) ? h : null;
}

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on });
  return { ok: r.code === 0, out: r.stdout.trim(), err: (r.stderr || r.stdout).trim() };
}

// Shared look for both dialogs.
function parts(t) {
  const label = (text) => div().text_size(fs.tiny).text_color(t.muted).child(text);
  const hint = (text, color) => div().text_size(fs.tiny).text_color(color ?? t.dim).child(text);
  // The buttons of the kit (links.js).
  const button = (id, text, kind, enabled, onClick) => kitButton(t, id, text, onClick, { kind: kind === "primary" ? "primary" : kind === "link" ? "link" : "plain", disabled: !enabled });
  const seg = (id, options, current, pick) => segmented(id, options, current, pick, t, false);
  const chip = (id, text, on, onClick) => kitChip(t, id, text, on, onClick);
  const header = (title, sub) => v_flex().flex_none().gap(3).px(16).pt(14).pb(12).border_b_1().border_color(t.border)
    .child(div().font_semibold().text_size(fs.title + 1).child(title)).child(sub);
  const footer = (children) => h_flex().flex_none().px(16).py(10).gap(8).items_center().border_t_1().border_color(t.border).bg(t.surface).children(children);
  return { label, hint, button, seg, chip, header, footer };
}
// Model and effort per agent (Program.key), with the flags each CLI takes. Others take their
// model from their own settings. The last choice per agent is kept in local storage.
const OPTIONS = {
  claude: { models: ["fable", "opus", "sonnet", "haiku"], efforts: ["low", "medium", "high", "xhigh", "max"],
    args: (m, e) => [...(m ? ["--model", m] : []), ...(e ? ["--effort", e] : [])] },
  codex: { models: null, placeholder: "e.g. gpt-5-codex", efforts: ["low", "medium", "high"],
    args: (m, e) => [...(m ? ["-m", m] : []), ...(e ? ["-c", `model_reasoning_effort=${e}`] : [])] },
  opencode: { models: null, placeholder: "provider/model, e.g. anthropic/claude-sonnet-4", efforts: null,
    args: (m) => (m ? ["-m", m] : []) },
};
// What "Default" means for each agent: the model and effort of its own settings file, else what its
// docs give when nothing is set (code.claude.com/docs/en/model-config). Read when the agent is picked.
//   Claude Code: settings.json `model` and `effortLevel`; unset: the account's default model (Opus 5.5
//     for Pro, Max, Team, Enterprise and the API; an organization can set another one) and the
//     model's default effort (medium for the 5.x models, xhigh for Opus 4.7, high for the others).
//   Codex: config.toml `model` and `model_reasoning_effort` (top level); unset: Codex's own, not documented.
// An environment variable (ANTHROPIC_MODEL, CLAUDE_CODE_EFFORT_LEVEL) can still change them.
const claudeEffort = (model) => (/opus-4-7|opus-4\.7/.test(model ?? "") ? "xhigh" : /-4-|4\.\d/.test(model ?? "") ? "high" : "medium");
async function agentDefaults(key, home, on) {
  if (!home) return null;
  if (key === "claude") {
    const raw = await readTextFile(`${home}/.claude/settings.json`, { on }).catch(() => null);
    let j = {};
    try { j = raw ? JSON.parse(raw) : {}; } catch { /* unreadable: the documented defaults */ }
    const model = typeof j.model === "string" ? j.model : null, effort = typeof j.effortLevel === "string" ? j.effortLevel : null;
    return {
      model: model ?? "account default", modelFrom: model ? "~/.claude/settings.json" : "usually Opus 5.5",
      effort: effort ?? claudeEffort(model), effortFrom: effort ? "~/.claude/settings.json" : `the default of ${model ?? "Opus 5.5"}`,
    };
  }
  if (key === "codex") {
    const raw = await readTextFile(`${home}/.codex/config.toml`, { on }).catch(() => null);
    const top = (raw ?? "").replace(/\r\n?/g, "\n").split(/^\s*\[/m)[0];
    const read = (k) => new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, "m").exec(top)?.[1] ?? null;
    const model = read("model"), effort = read("model_reasoning_effort");
    return { model: model ?? "Codex's own", modelFrom: model ? "~/.codex/config.toml" : "not set", effort: effort ?? "Codex's own", effortFrom: effort ? "~/.codex/config.toml" : "not set" };
  }
  return null;
}

// The known agents per machine, as knownAgents() gave them, kept in shared("issues.agents"):
// { [machine or "local"]: { list, checkedAt } }. knownAgents() starts a shell, so the dialog asks only
// when no list is kept (first open) or when the person clicks ↻, the same as the repo-launcher.
// The repo-launcher's list (installed agents of this computer) fills an empty one at once.
const AGENTS = "issues.agents";
const machineKey = (on) => on ?? "local";
function cachedAgents(on) {
  const own = shared(AGENTS)?.[machineKey(on)];
  if (Array.isArray(own?.list)) return own;
  const rl = !on ? shared("repo-launcher.agents") : null;
  return Array.isArray(rl?.list) ? { list: rl.list, checkedAt: rl.checkedAt ?? null } : null;
}
function keepAgents(on, list) {
  setShared(AGENTS, { ...(shared(AGENTS) ?? {}), [machineKey(on)]: { list, checkedAt: Date.now() } });
}

const optionsKey = (a) => `agent-opts:${a?.key ?? a?.name}`;
const lastOptions = (a) => { try { return JSON.parse(localStorage.getItem(optionsKey(a)) ?? "null") ?? {}; } catch { return {}; } };
const keepOptions = (a, o) => { try { localStorage.setItem(optionsKey(a), JSON.stringify(o)); } catch { /* best effort */ } };
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,79}$/;

const SOURCE = { repo: "the repository's .herdr/prompts.md", yours: "your prompt (cog, Prompts…)", default: "the default prompt" };

export class AgentDialog extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.kind = p.kind ?? "issue";
    // "Fix failing checks" only when a check fails.
    // "Fix stack to merge" only with the gh stack extension.
    this.modes = MODES[this.kind].filter(([id]) => (id !== "checks" || (p.vars?.failing && p.vars.failing !== "none")) && (id !== "stack-fix" || p.ghStack !== false));
    // The mode the list picked (a stack row's Review or Fix), else the first.
    this.mode = this.modes.some(([id]) => id === p.mode) ? p.mode : this.modes[0][0];
    this.agents = []; this.agent = null; this.busy = false; this.error = "";
    this.repoTemplates = {}; this.mine = userPrompts(p.mod);
    this.editing = false; this.edited = false; this.stay = false;
    // Where the agent runs: "worktree" (a new branch in a new worktree, in a new space) or "space" (a new
    // tab of an open space, on the branch that space has now). The shown space is the first choice there.
    this.target = "worktree"; this.targetSpace = spaces().find((s) => s.active)?.id ?? null;
    this.branchState = null; this.main = null; this.base = ""; this.home = "";
    this.setBranch = p.branches?.[this.mode] ?? ""; this.typed = false;
    this.branch = InputState.new({ placeholder: "Branch", value: this.setBranch });
    // An unedited prompt follows the branch ({branch} in it).
    // Typing (anything not set by the dialog itself) is the person's: never rewritten under them.
    this.branch.on("change", (_e, cx) => {
      if (this.branch.value() !== this.setBranch) { this.typed = true; this.renamed = null; }
      if (!this.edited) this.fillPrompt();
      this.checkBranch(cx);
    });
    this.prompt = TextareaState.new({ placeholder: "Prompt", value: "", rows: 12 });
    this.prompt.on("change", (_e, cx) => { if (this.quiet === this.prompt.value()) return; this.edited = true; cx.notify(); });
    this.model = null; this.effort = null;
    this.modelText = InputState.new({ placeholder: "Model (empty: the agent's own setting)" });
    this.handle = cx.focus_handle();
    this.fillPrompt();
    // The kept list shows at once; only an empty one asks Herdr (see cachedAgents).
    const kept = cachedAgents(p.on ?? null);
    if (kept) this.useAgents(kept.list, cx);
    else this.refreshAgents(cx);
    cx.spawn(async (cx) => {
      try {
        this.main = await mainCheckout(p.repo, p.on ?? null);
        if (this.main) {
          this.repoTemplates = await repoPrompts(this.main, p.on ?? null);
          if (!this.edited) this.fillPrompt();
          this.base = (await git(this.main, ["rev-parse", "--abbrev-ref", "HEAD"], p.on ?? null)).out;
          this.home = (await homeOf(p.on ?? null)) ?? "";
        }
      } catch (e) { this.error ||= `Cannot read the repository: ${e?.message ?? e}`; }
      this.checkBranch(cx);
      cx.notify();
    });
  }

  // Esc, Cancel and Start close it here; the list gets the keyboard back. Not a Herdr hook (a child
  // view never gets one): a click beside the dialog goes through the root view's close().
  // The list gets the keyboard back only when its space still shows: after a switch to the new space, the
  // list is not on the screen, and "<mod>.focus" fails with "unknown command".
  close() {
    closeOverlay(props().overlay);
    const m = props()?.mod;
    const same = this.openSpace === undefined || spaces().find((s) => s.active)?.id === this.openSpace;
    if (m && same) run(`${m}.focus`);
  }

  // Shows a list of agents: the chosen one stays when it is still installed, else the last used, else the first.
  useAgents(list, cx) {
    this.agents = list ?? [];
    const ready = this.agents.filter((a) => a.installed !== false);
    const keep = this.agent && ready.find((a) => a.name === this.agent.name);
    this.agent = keep ?? ready.find((a) => a.name === lastAgent()) ?? ready[0] ?? null;
    this.error = this.agent ? (this.error.startsWith("No installed agent") ? "" : this.error) : "No installed agent found (programs.json `run` entries).";
    if (!keep) { this.loadOptions(); this.loadDefaults(cx); }
    cx.notify();
  }
  // Asks Herdr for the agents (it starts a shell: a second or two) and keeps the list.
  refreshAgents(cx) {
    if (this.checkingAgents) return;
    const on = props()?.on ?? null;
    this.checkingAgents = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const list = await knownAgents({ on });
        keepAgents(on, list);
        this.useAgents(list, cx);
      } catch (e) { this.error = `Cannot list agents: ${e}`; }
      this.checkingAgents = false; cx.notify();
    });
  }

  // The agent's own defaults (agentDefaults), for the Default chips.
  loadDefaults(cx) {
    const a = this.agent, on = props()?.on ?? null;
    this.defaults = null;
    if (!a || !OPTIONS[a.key]) return;
    cx.spawn(async (cx) => {
      const home = this.home || await homeOf(on);
      const d = await agentDefaults(a.key, home, on).catch(() => null);
      if (this.agent === a) { this.defaults = d; cx.notify(); }
    });
  }

  loadOptions() {
    const o = lastOptions(this.agent);
    const opts = OPTIONS[this.agent?.key];
    this.model = opts?.models?.includes(o.model) ? o.model : null;
    this.effort = opts?.efforts?.includes(o.effort) ? o.effort : null;
    this.modelText.set_value(OPTIONS[this.agent?.key]?.models ? "" : o.model ?? "");
  }

  // The chosen model and effort, as this agent's flags.
  extraArgs() {
    const o = OPTIONS[this.agent?.key];
    if (!o) return [];
    const model = o.models ? this.model : this.modelText.value().trim() || null;
    if (model && !SAFE.test(model)) throw new Error("A model name has letters, digits and . _ : / @ - only.");
    keepOptions(this.agent, { model, effort: this.effort });
    return o.args(model, o.efforts ? this.effort : null);
  }

  // The open spaces an agent can start in: the ones on the item's machine, the shown one first.
  openSpaces() {
    const on = props()?.on ?? null;
    return spaces().filter((s) => (s.machine ?? null) === on).sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
  }
  chosenSpace() { return this.openSpaces().find((s) => s.id === this.targetSpace) ?? null; }
  // The branch the agent works on: the typed one for a new worktree, the space's own for an open space.
  branchNow() { return this.target === "space" ? this.chosenSpace()?.branch ?? "" : this.branch.value().trim(); }
  pickTarget(target, cx) {
    this.target = target;
    if (!this.edited) this.fillPrompt();
    cx.notify();
  }
  pickSpace(id, cx) {
    this.targetSpace = id;
    if (!this.edited) this.fillPrompt();
    cx.notify();
  }

  // The prompt of the chosen mode from its template; an edited prompt is replaced only by Reset or another mode.
  fillPrompt() {
    const [tpl, from] = template(this.mode, this.repoTemplates, this.mine);
    this.source = from;
    const text = fill(tpl, { ...(props()?.vars ?? {}), branch: this.branchNow() });
    this.quiet = text; this.prompt.set_value(text); this.edited = false;
    // A repository's prompt is shown whole, not folded, so nothing in it goes unseen.
    if (from === "repo") this.editing = true;
  }

  // A mode brings its own branch and prompt, unless the person changed them: those stay
  // (Reset brings the mode's prompt back).
  pickMode(mode, cx) {
    this.mode = mode;
    const b = props()?.branches?.[mode];
    if (b && !this.typed) { this.renamed = null; this.setBranch = b; this.branch.set_value(b); }
    if (!this.edited) this.fillPrompt();
    this.checkBranch(cx); cx.notify();
  }

  checkBranch(cx) {
    const branch = this.branch.value().trim(), on = props()?.on ?? null;
    if (!this.main || !branch) { this.branchState = null; cx.notify(); return; }
    const n = this.branchSeq = (this.branchSeq ?? 0) + 1;
    cx.spawn(async (cx) => {
      await cx.sleep(250);
      if (n !== this.branchSeq) return;
      if (!(await git(this.main, ["check-ref-format", "--branch", branch], on)).ok) { if (n === this.branchSeq) { this.branchState = "invalid"; cx.notify(); } return; }
      const exists = (await git(this.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], on)).ok;
      const remote = !exists && (await git(this.main, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], on)).ok;
      if (n !== this.branchSeq) return;
      // Checked out in another worktree (a second start on the same item): git can't use it
      // again, so the next free name is picked: branch-2, branch-3, …
      const used = exists ? (await git(this.main, ["worktree", "list", "--porcelain"], on)).out.split("\n").filter((l) => l.startsWith("branch refs/heads/")).map((l) => l.slice(18)) : [];
      if (used.includes(branch)) {
        // Typed by the person: say so instead of changing their text.
        if (this.typed) { this.branchState = "busy"; cx.notify(); return; }
        let k = 2, next;
        do { next = `${branch.replace(/-\d+$/, "")}-${k++}`; } while (k < 50 && (used.includes(next) || (await git(this.main, ["show-ref", "--verify", "--quiet", `refs/heads/${next}`], on)).ok));
        if (n !== this.branchSeq) return;
        this.renamed = branch; this.setBranch = next; this.branch.set_value(next); cx.notify(); return;
      }
      this.branchState = exists ? "exists" : remote ? "remote" : "new"; cx.notify();
    });
  }

  start(cx) {
    if (this.busy || !this.agent) return;
    this.busy = true; this.error = "";
    cx.spawn(async (cx) => {
      try { await this.create(); this.close(); }
      catch (e) { this.error = String(e?.message ?? e); }
      this.busy = false;
      cx.notify();
    });
    cx.notify();
  }

  async create() {
    const p = props(), on = p.on ?? null, branch = this.branch.value().trim();
    const prompt = clean(this.prompt.value()).trim();
    if (!prompt) throw new Error("Type a prompt.");
    const extra = this.extraArgs();
    // An open space: a new tab there, in the folder of its focused pane, on its branch. Nothing is created in git.
    if (this.target === "space") {
      const s = this.chosenSpace();
      if (!s) throw new Error("Pick an open space.");
      const before = spaces().find((x) => x.active)?.id;
      keepAgent(this.agent.name);
      run("tab.new", { space: s.id, name: p.tabs?.[this.mode] ?? p.title, argv: [...this.agent.run, ...extra], task: prompt });
      if (!this.stay) run("space.select", { id: s.id });
      else if (before && before !== s.id) run("space.select", { id: before });
      notify({ title: `Started ${this.agent.name}`, body: `${p.tabs?.[this.mode] ?? p.title ?? ""} · ${s.name}`, level: "success", timeout: 4000 });
      return;
    }
    if (!branch) throw new Error("Type a branch name.");
    const main = this.main ?? await mainCheckout(p.repo, on);
    if (!main) throw new Error("Not a git repository.");
    // PowerMods Core makes the worktree in the central folder, copies the files, runs the setup in a
    // "setup" tab of the new space, and then starts the agent (see powermods-core-app).
    const tab = p.tabs?.[this.mode] ?? p.title;
    const r = await worktrees().create({
      repo: main, branch, on, name: cut(tab ?? branch, 40), select: !this.stay,
      agent: { argv: [...this.agent.run, ...extra], task: prompt, tab },
    });
    keepAgent(this.agent.name);
    const copied = r.copied ? ` · ${r.copied} file${r.copied > 1 ? "s" : ""} copied` : "";
    notify(r.setup === "running"
      ? { title: `Setting up ${branch}`, body: `${tab ?? branch}${copied} · ${this.agent.name} starts after the setup`, level: "info", timeout: 5000 }
      : { title: `Started ${this.agent.name}`, body: `${tab ?? branch}${copied}`, level: "success", timeout: 4000 });
  }

  render(cx) {
    const t = theme(), p = props() ?? {}, ui = parts(t);
    // Started for one space's item: a space switch closes it.
    const sp = spaces().find((x) => x.active)?.id ?? null;
    if (this.openSpace === undefined) this.openSpace = sp;
    else if (sp !== this.openSpace && !this.busy) { try { cx.timer.after(0, () => this.close()); } catch { /* next change */ } }
    const branch = this.branch.value().trim();
    const modes = this.modes;
    const verb = this.mode === "review" || this.mode === "stack-review" ? "Start review" : "Start agent";
    const agentCard = (a) => {
      const on = this.agent?.name === a.name, ok = a.installed !== false;
      return h_flex().id(`agent-${a.name}`).gap(8).items_center().px(10).py(7).rounded(8).min_w(150)
        .border_1().border_color(on ? t.accent : t.border).when(on, (e) => e.bg(t.accent + "10"))
        .when(!ok, (e) => e.opacity(0.5))
        .when(ok, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.agent = a; this.loadOptions(); this.loadDefaults(cx); cx.notify(); }))
        // The icon of the provider, as Herdr's programs table and the repo-launcher show it.
        .child(programTile(t, a, 26))
        .child(v_flex().child(div().text_size(fs.meta).child(a.name))
          .child(div().text_size(fs.tiny).text_color(t.dim).child(!ok ? "not installed" : a.name === lastAgent() ? "last used" : "installed")));
    };
    const preview = this.prompt.value().split("\n").slice(0, 5).join("\n");
    const path = this.main ? maybeWorktrees()?.preview({ repo: this.main, branch: branch || "…" }) ?? "(PowerMods Core is not running)" : "";
    return v_flex().id("dispatch").size_full().text_size(fs.body).text_color(t.foreground).bg(t.background).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.close(); cx.stop_propagation(); }
        if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)) { this.start(cx); cx.stop_propagation(); }
      })
      .child(ui.header(this.mode === "review" || this.mode === "stack-review" ? "Review with agent" : "Start agent", h_flex().gap(6).items_center().min_w(0).text_size(fs.meta)
        .when(Boolean(p.icon), (e) => e.child(icon(p.icon, kindColor(p.icon, t), 14)))
        .when(Boolean(p.key), (e) => e.child(div().flex_none().text_color(t.dim).child(p.key)))
        .child(div().min_w(0).truncate().font_semibold().child(p.title ?? ""))))
      .child(v_flex().id("dispatch-body").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).gap(12)
        .child(v_flex().gap(4)
          // ↻ asks Herdr for the installed agents again (the list is kept: see cachedAgents).
          .child(h_flex().gap(6).items_center().child(ui.label("Agent")).child(div().flex_1())
            .child(iconButton(t, "agents-refresh", "refresh", (cx) => this.refreshAgents(cx), { spin: Boolean(this.checkingAgents), size: 24, tooltip: "Check the installed agents again" })))
          .when(!this.agents.length && this.checkingAgents, (e) => e.child(ui.hint("Looking for the installed agents…")))
          .child(h_flex().gap(8).flex_wrap().children(this.agents.filter((a) => a.installed !== false).map(agentCard)))
          .when(this.agents.some((a) => a.installed === false), (e) => e.child(ui.hint(`${this.agents.filter((a) => a.installed === false).length} more known agents aren't installed on this machine.`))))
        .when(Boolean(this.agent), (e) => {
          const o = OPTIONS[this.agent.key];
          if (!o) return e.child(ui.hint(`${this.agent.name} takes its model from its own settings.`));
          // "Default" says what it is: the agent's settings file, else its documented default.
          const d = this.defaults;
          const fromSettings = Boolean(d?.effortFrom.startsWith("~")), claude = this.agent.key === "claude";
          // Claude's default effort follows the model that runs: the chosen one, else the default one.
          const runs = this.model ?? (d?.modelFrom.startsWith("~") ? d.model : "Opus 5.5");
          const effortNow = !d ? null : claude && !fromSettings ? claudeEffort(runs) : d.effort;
          const modelHint = d ? `Default model: ${d.model} (${d.modelFrom})` : "Default model: the agent's own setting";
          const effortHint = !d ? "" : `default effort: ${effortNow} (${fromSettings ? d.effortFrom : claude ? `the default of ${runs}` : d.effortFrom})`;
          return e.child(v_flex().gap(4).child(h_flex().gap(16).flex_wrap().items_start()
            .child(v_flex().gap(4).child(ui.label("Model"))
              .child(o.models ? h_flex().gap(6).flex_wrap().child(ui.chip("model-default", d ? `Default · ${d.model}` : "Default", !this.model, (cx) => { this.model = null; cx.notify(); }))
                  .children(o.models.map((m) => ui.chip(`model-${m}`, m, this.model === m, (cx) => { this.model = m; cx.notify(); })))
                : div().w(300).px(8).py(4).rounded(6).border_1().border_color(t.input).text_size(fs.meta).child(Input.new(this.modelText))))
            .when(Boolean(o.efforts), (e) => e.child(v_flex().gap(4).child(ui.label("Effort"))
              .child(h_flex().gap(6).flex_wrap().child(ui.chip("effort-default", effortNow ? `Default · ${effortNow}` : "Default", !this.effort, (cx) => { this.effort = null; cx.notify(); }))
                .children(o.efforts.map((x) => ui.chip(`effort-${x}`, x, this.effort === x, (cx) => { this.effort = x; cx.notify(); })))))))
            .child(ui.hint([modelHint, effortHint].filter(Boolean).join(" · "))));
        })
        .child(v_flex().gap(4).child(ui.label("Mode"))
          .child(h_flex().child(ui.seg("mode", modes, this.mode, (m, cx) => this.pickMode(m, cx))))
          .child(ui.hint(ABOUT[this.mode])))
        // Where the agent runs. The repository is the one of the shown space (its link, else its terminal's folder).
        // Only an issue can go to an open space: the pull request prompts check out and reset the branch
        // of their folder (gh pr checkout, git reset --hard), which would change that space's checkout.
        .child(v_flex().gap(4).child(ui.label("Where"))
          .when(this.kind === "issue", (e) => e.child(h_flex().child(ui.seg("target", [["worktree", "New worktree"], ["space", "Open space · new tab"]], this.target, (v, cx) => this.pickTarget(v, cx)))))
          .child(ui.hint(this.target === "worktree"
            ? "A new branch in a new git worktree of the repository below, in a new space."
            : "A new tab in an open space, in the folder of its focused pane, on the branch it has now. Nothing is created in git."))
          .when(Boolean(this.main), (e) => e.child(h_flex().gap(6).items_center().min_w(0).text_size(fs.meta)
            .child(div().flex_none().text_color(t.muted).child("Repository"))
            .child(div().flex_none().font_semibold().child(this.main.split("/").pop()))
            .child(div().min_w(0).truncate().text_color(t.dim).child(`${this.main} · on ${this.base || "HEAD"}`)))))
        .when(this.target === "space", (e) => {
          const list = this.openSpaces(), chosen = this.chosenSpace();
          return e.child(v_flex().gap(4).child(ui.label("Space"))
            .child(h_flex().gap(6).flex_wrap().children(list.map((s) => ui.chip(`space-${s.id}`, `${s.name}${s.branch ? ` · ${s.branch}` : ""}${s.active ? " (shown)" : ""}`, s.id === this.targetSpace, (cx) => this.pickSpace(s.id, cx)))))
            .child(ui.hint(chosen ? `The agent works on ${chosen.branch ? `the branch ${chosen.branch}` : "the folder"} of ${chosen.name}.` : "Pick an open space.")));
        })
        .when(this.target === "worktree", (e) => e.child(v_flex().gap(4)
          .child(ui.label("Branch"))
          .child(h_flex().gap(8).items_center().px(8).py(5).rounded(6).border_1().border_color(t.input)
            .child(div().flex_1().min_w(0).font_family("Menlo").text_size(fs.meta).child(Input.new(this.branch)))
            .when(Boolean(this.branchState), (e) => e.child(div().flex_none().text_size(fs.tiny).text_color(this.branchState === "busy" || this.branchState === "invalid" ? t.ansi1 : this.branchState === "new" ? t.dim : t.ansi3)
              .child({ exists: "exists: reuses it", remote: "on origin: starts from it", busy: "in use by another worktree", invalid: "not a valid branch name" }[this.branchState] ?? (this.renamed ? `new (${this.renamed} is in use)` : "new")))))
          .when(Boolean(this.main), (e) => e.child(ui.hint(`from ${this.base || "HEAD"} (the main checkout) · worktree ${path}`)))))
        .when(Boolean(p.fork), (e) => e.child(h_flex().gap(8).items_center().px(10).py(7).rounded(6).bg(t.ansi3 + "1a").text_size(fs.meta).text_color(t.foreground)
          .child(icon("alert", t.ansi3, 13))
          .child(div().flex_1().min_w(0).child("This pull request comes from a fork: the agent builds and runs its code on this machine, with your environment. Only for authors you trust."))))
        .when(Boolean(this.repoTemplates?.templates?.[this.mode] && !this.repoTemplates.trusted), (e) => e.child(h_flex().gap(8).items_center().px(10).py(7).rounded(6).bg(t.surface).text_size(fs.meta).text_color(t.muted)
          .child(div().flex_1().min_w(0).child("This repository has its own prompts (.herdr/prompts.md). They're used only after you've read them."))
          .child(ui.button("trust-prompts", "Show and use them", "link", true, (cx) => { trustPrompts(this.repoTemplates); this.repoTemplates.trusted = true; this.fillPrompt(); cx.notify(); }))))
        .child(v_flex().gap(4)
          .child(h_flex().gap(8).items_center().child(div().flex_1().child(ui.label("Prompt")))
            .child(ui.hint(this.edited ? `edited (was ${SOURCE[this.source]})` : `from ${SOURCE[this.source]}`))
            .when(this.edited, (e) => e.child(ui.button("reset", "Reset", "link", true, (cx) => { this.fillPrompt(); cx.notify(); })))
            .child(ui.button("edit", this.editing ? "Done" : "Edit", "link", true, (cx) => { this.editing = !this.editing; if (this.editing) this.prompt.focus(); cx.notify(); })))
          .child(this.editing ? div().h(240).px(8).py(5).rounded(6).border_1().border_color(t.accent).child(Textarea.new(this.prompt))
            : div().id("prompt-preview").px(10).py(8).rounded(6).border_1().border_color(t.border).bg(t.surface).text_size(fs.meta).text_color(t.muted)
              .cursor_pointer().on_click((_e, cx) => { this.editing = true; this.prompt.focus(); cx.notify(); })
              .child(div().max_h(96).overflow_hidden().child(preview))))
        .child(v_flex().gap(3).text_size(fs.tiny).text_color(t.muted)
          .when(this.target === "worktree", (e) => e
            .child(`① Creates the worktree and branch ${branch || "…"}${this.branchState === "exists" ? " (the branch exists, so it is reused)" : ` from ${this.base || "HEAD"}`}; nothing is pushed.`)
            .child(`② Opens a new space "${p.tabs?.[this.mode] ?? p.title ?? ""}", copies the files and runs the setup of PowerMods Core.`)
            .child(`③ Starts ${this.agent?.name ?? "the agent"} with this prompt when the setup ends well.`))
          .when(this.target === "space", (e) => e
            .child(`Opens a new tab "${p.tabs?.[this.mode] ?? p.title ?? ""}" in ${this.chosenSpace()?.name ?? "the space"} and starts ${this.agent?.name ?? "the agent"} with this prompt.`))
          .child(h_flex().id("stay").gap(6).items_center().cursor_pointer().on_click((_e, cx) => { this.stay = !this.stay; cx.notify(); })
            .child(div().size(14).rounded(3).border_1().border_color(this.stay ? t.border : t.accent).when(!this.stay, (e) => e.bg(t.accent)).flex().items_center().justify_center()
              .when(!this.stay, (e) => e.child(icon("check", t.background, 10))))
            .child(this.target === "space" ? "Switch to that space" : "Switch to the new space")))
        .when(Boolean(this.error), (e) => e.child(div().text_size(fs.meta).text_color(t.ansi1).child(this.error))))
      .child(ui.footer([
        div().flex_1().child(ui.hint("Esc cancels")),
        ui.button("cancel", "Cancel", null, true, () => this.close()),
        ui.button("start", this.busy ? "Starting…" : verb, "primary", !this.busy && Boolean(this.agent)
          && (this.target === "space" ? Boolean(this.chosenSpace()) : this.branchState !== "invalid" && this.branchState !== "busy"), (cx) => this.start(cx)),
      ]));
  }
}

// Cog → Prompts…: the person's template per mode, with placeholders and Reset.
export class PromptsDialog extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.kind = p.kind ?? "issue"; this.mod = p.mod;
    this.mine = { ...userPrompts(p.mod) };
    this.mode = promptModes(this.kind)[0][0];
    this.text = TextareaState.new({ value: this.mine[this.mode] ?? DEFAULTS[this.mode], rows: 11 });
    this.repo = null; this.repoTemplates = {};
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      const space = spaces().find((s) => s.id === p.space) ?? spaces().find((s) => s.active);
      const repo = await spaceRepo(space).catch(() => null);
      this.repo = repo;
      if (repo?.main) this.repoTemplates = await repoPrompts(repo.main, repo.on ?? null);
      cx.notify();
    });
  }

  // Esc, Cancel and Save close it here (not a Herdr hook: see AgentDialog.close).
  close() { closeOverlay(props().overlay); const m = props()?.mod; if (m) run(`${m}.focus`); }

  // Keeps what is typed for the mode on screen before switching.
  keep() {
    const v = this.text.value().trim();
    if (v && v !== DEFAULTS[this.mode].trim()) this.mine[this.mode] = v; else delete this.mine[this.mode];
  }

  pick(mode, cx) { this.keep(); this.mode = mode; this.text.set_value(this.mine[mode] ?? DEFAULTS[mode]); cx.notify(); }

  save() { this.keep(); saveUserPrompts(this.mod, this.mine); this.close(); }

  render(cx) {
    const t = theme(), ui = parts(t);
    const fromRepo = Boolean(this.repoTemplates?.trusted && this.repoTemplates.templates?.[this.mode]);
    const customized = Boolean(this.mine[this.mode]) || this.text.value().trim() !== DEFAULTS[this.mode].trim();
    return v_flex().id("prompts").size_full().text_size(fs.body).text_color(t.foreground).bg(t.background).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.close(); cx.stop_propagation(); }
        if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)) { this.save(); cx.stop_propagation(); }
      })
      .child(ui.header("Prompts", div().text_size(fs.meta).text_color(t.muted).child(`What Start agent sends, per mode. Placeholders fill in the ${this.kind === "pr" ? "pull request" : "issue"}.`)))
      .child(v_flex().id("prompts-body").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).gap(10)
        .child(h_flex().gap(8).items_center().child(ui.seg("pmode", promptModes(this.kind), this.mode, (m, cx) => this.pick(m, cx))).child(div().flex_1())
          .child(ui.chip("state", customized ? "yours" : "default", customized, () => {})))
        .child(ui.hint(ABOUT[this.mode]))
        .child(div().min_h(220).px(8).py(5).rounded(6).border_1().border_color(t.input).font_family("Menlo").text_size(fs.meta).overflow_hidden().child(Textarea.new(this.text)))
        .child(v_flex().gap(4).child(ui.label("Placeholders (click to insert)"))
          .child(h_flex().gap(6).flex_wrap().children(placeholdersOf(this.mode).map((k) => ui.chip(`ph-${k}`, `{${k}}`, false, (cx) => { this.text.replace(`{${k}}`); this.text.focus(); cx.notify(); })))))
        .child(h_flex().gap(8).items_center().px(10).py(7).rounded(6).bg(t.surface).text_size(fs.meta).text_color(t.muted)
          .child(div().size(8).rounded_full().bg(fromRepo ? t.ansi3 : t.accent))
          .child(div().flex_1().min_w(0).child(!this.repo ? "No repository for this space: yours is used everywhere."
            : fromRepo ? `This repository's .herdr/prompts.md has its own "${promptModes(this.kind).find(([id]) => id === this.mode)[1]}": it wins there.`
            : `This repository has no .herdr/prompts.md section for this mode, so this prompt is used. A "## ${promptModes(this.kind).find(([id]) => id === this.mode)[1]}" section there would win once you approve it.`))))
      .child(ui.footer([
        ui.button("reset", "Reset to default", null, true, (cx) => { this.text.set_value(DEFAULTS[this.mode]); delete this.mine[this.mode]; cx.notify(); }),
        div().flex_1(),
        ui.button("cancel", "Cancel", null, true, () => this.close()),
        ui.button("save", "Save", "primary", true, () => this.save()),
      ]));
  }
}
