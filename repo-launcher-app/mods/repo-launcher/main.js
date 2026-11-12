// Repo Launcher: a popup to find a repository by a fuzzy name and open a
// terminal or an agent (with any of its accounts) in it.
//
// Three views:
//   list     - the search box and the repositories (favorites first)
//   actions  - what to open in the chosen repository
//   settings - root folders, reuse mode, shortcut, agent arguments, accounts
//
// The repository list comes from a cache in shared state. Only Refresh and a
// change of the root folders read the disk again.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, closeOverlay, knownAgents, pickFolder, notify, panes, spaces, run, settings as appSettings, shared, machines } from "herdr";
import { matchRepo } from "./fuzzy.js";
import { findRepos, detectAccounts, accountEmail, displayPath, normalize, pathKey, isWindows, powershell, machineInfo, placeId, ACCOUNT_AGENTS } from "./scan.js";
import { agentArgv, open, openFree, spacesFor } from "./launch.js";
import {
  settings, updateSettings, cache, setCache, isFavorite, toggleFavorite, markOpened, lastOpened,
  boundKeys, prettyKeys, chordOf, actionOf, bindShortcut, announceShortcut, agentCache, setAgentCache,
  remoteAgentCache, setRemoteAgentCache, allRoots,
} from "./store.js";
import {
  icon, GOLD, tint, spaceColor, repoColor, letterTile, programTile, pill, kbd, hint, toggle,
  iconButton, button, segmented, highlighted, ago, sectionTitle,
} from "./ui.js";

// The mods-hub can turn this mod off (shared "herdr-mods.disabled", a list of mod names). Then the mod draws
// nothing, closes its dialog and skips its timed work. The bars hide its blocks and buttons.
const kitOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes("repo-launcher"); };
const offView = () => { const o = props()?.overlay; if (o) closeOverlay(o); return div(); };

const RECENT_COUNT = 5;
const ROW_H = 50;
const HEAD_H = 30;
const ACTION_H = 52;
// A popup is as tall as its content, so the lists get a fixed height.
const LIST_MAX = 440;
const EMPTY_H = 300;
const SETTINGS_H = 560;

const MODES = [
  { value: "tab", label: "New tab", symbol: "plus" },
  { value: "split", label: "Split right", symbol: "layers" },
  { value: "go", label: "Go to space", symbol: "chevron" },
];
const MODE_TEXT = { tab: "in a new tab", split: "in a split to the right", go: "" };

// Kept between openings of the popup, so the next one draws at once.
// `place`: the quick filter of the list: "all", "local" or a machine name.
const memory = { accounts: null, scanningSince: 0, checkingAgents: false, checkingRemote: {}, place: "all" };
const isScanning = () => Date.now() - memory.scanningSince < 180000;

// Other machines (`hc machine ls`), by name. Herdr leaves out temporary ones.
const remoteMachines = () => machines().map((m) => m.name).filter(Boolean);
/** What the launcher knows of the system of a repository's machine (null: this computer). */
const infoOf = (machine) => (machine ? cache().machines?.[machine] ?? { windows: false, home: "" } : null);
const repoId = (repo) => placeId(repo.machine, repo.path);
const parentOf = (repo) => displayPath(repo.path.slice(0, repo.path.length - repo.name.length), infoOf(repo.machine));
/** A root or a missing root for people: "notebook: ~\src" for another machine. */
function placeLabel(id) {
  const bar = id.indexOf("|");
  if (bar < 0) return displayPath(id);
  const machine = id.slice(0, bar);
  return `${machine}: ${displayPath(id.slice(bar + 1), infoOf(machine))}`;
}

export default class RepoLauncher extends View {
  init(_props, cx) {
    this.view = "list";
    this.filter = "";
    this.at = 0;
    this.actionAt = 0;
    this.repo = null;
    this.capturing = false;
    this.pendingChord = null;
    this.keyError = "";
    this.handle = cx.focus_handle();
    // Scroll offsets (px) of the lists. `follow`: keep the selection in view.
    this.scrollTop = { list: 0, actions: 0 };
    this.follow = true;

    this.query = InputState.new({ placeholder: "Search repositories…" });
    this.query.on("change", (_e, cx) => {
      this.filter = this.query.value();
      this.at = 0;
      this.scrollTop.list = 0;
      this.follow = true;
      cx.notify();
    });
    this.query.on("submit", (_e, cx) => this.choose(this.selectedRepo(), cx));
    this.query.focus();
    // A folder on another machine: the system picker shows only this computer.
    this.remotePath = InputState.new({ placeholder: "~/projects or C:\\Projects" });
    this.remotePath.on("submit", (_e, cx) => this.addRemoteRoot(cx));
    this.remoteTarget = null;
    cx.timer.after(600, () => {
      if (this.view === "list") this.query.focus();
    });

    // The agents come from shared state. Only the first open (no list yet)
    // and the Refresh button in the settings ask Herdr again.
    const savedAgents = agentCache().list;
    this.agents = savedAgents ?? [];
    this.accounts = memory.accounts ?? [];
    this.argInputs = {};
    this.ensureArgInputs();
    if (!savedAgents) this.refreshAgents(cx);
    if (isWindows()) cx.spawn(async () => { await powershell(); });
    cx.spawn(async (cx) => {
      this.accounts = await detectAccounts();
      memory.accounts = this.accounts;
      cx.notify();
    });

    // A first open with folders but no cache (a scan stopped by closing the popup).
    if (allRoots().length && !cache().scannedAt && !isScanning()) this.scan(cx);
  }

  close() {
    closeOverlay(props().overlay);
  }

  // A text field keeps the keyboard for a moment after it leaves the
  // screen, so the focus is given again a frame later.
  focusRoot(cx) {
    this.handle.focus();
    cx.timer.after(40, () => this.handle.focus());
  }

  focusQuery(cx) {
    this.query.focus();
    cx.timer.after(40, () => this.query.focus());
  }

  // ---------------------------------------------------------------------------
  // Data

  /**
   * Searches the roots of each machine at the same time. A machine that
   * cannot be reached keeps the repositories of its last search.
   * Resolves with `{ count, failed }`.
   */
  async scanNow(roots) {
    memory.scanningSince = Date.now();
    try {
      const groups = new Map();
      for (const r of roots) groups.set(r.machine, [...(groups.get(r.machine) ?? []), r.path]);
      const results = await Promise.all([...groups].map(async ([on, paths]) => {
        try {
          // An offline machine would make each shell wait for its timeout.
          if (on && machines().find((m) => m.name === on)?.layout === "unavailable") throw new Error(`${on} cannot be reached now`);
          const info = await machineInfo(on);
          return { on, info, ...(await findRepos(paths, { on, info })) };
        } catch (error) {
          return { on, error };
        }
      }));
      const prev = cache();
      const repos = [];
      const missing = [];
      const known = { ...prev.machines };
      const failed = [];
      for (const r of results) {
        if (r.error) {
          failed.push(r.on);
          repos.push(...prev.repos.filter((x) => (x.machine ?? null) === r.on));
          notify({ title: r.on ? `Could not read the folders on ${r.on}` : "Could not read the folders", body: String(r.error?.message ?? r.error), level: "error", timeout: 8000 });
          continue;
        }
        repos.push(...r.repos);
        missing.push(...r.missing.map((m) => placeId(r.on, m)));
        if (r.on) known[r.on] = { windows: r.info.windows, home: r.info.home };
      }
      setCache({ repos, scannedAt: Date.now(), missing, machines: known });
      if (missing.length) {
        notify({ title: "Some folders were not found", body: missing.map(placeLabel).join(", "), level: "warning", timeout: 6000 });
      }
      return { count: repos.length, failed };
    } finally {
      memory.scanningSince = 0;
    }
  }

  scan(cx, { quiet = true } = {}) {
    if (isScanning()) return;
    const roots = allRoots(remoteMachines());
    cx.spawn(async (cx) => {
      try {
        const { count, failed } = await this.scanNow(roots);
        if (!quiet && !failed.length) notify({ title: "Repositories updated", body: `${count} repositories in ${roots.length} folder${roots.length === 1 ? "" : "s"}`, level: "success", timeout: 3000 });
      } catch (e) {
        notify({ title: "Could not read the folders", body: String(e?.message ?? e), level: "error", timeout: 8000 });
      }
      cx.notify();
    });
    cx.notify();
  }

  addRoot(cx) {
    cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: "Add folder" }).catch(() => null);
      if (!dir) return;
      const path = normalize(dir);
      const roots = settings().roots;
      if (!roots.some((r) => pathKey(r) === pathKey(path))) {
        updateSettings({ roots: [...roots, path] });
        memory.scanningSince = 0;
        this.scan(cx, { quiet: false });
      }
      cx.notify();
    });
  }

  /** The machine that a new remote folder goes to: the chosen one, else the first. */
  remoteMachine() {
    const list = remoteMachines();
    return list.includes(this.remoteTarget) ? this.remoteTarget : list[0] ?? null;
  }

  addRemoteRoot(cx) {
    const machine = this.remoteMachine();
    const path = normalize(this.remotePath.value().trim());
    if (!machine || !path) return;
    const list = settings().remoteRoots;
    if (!list.some((r) => r.machine === machine && pathKey(r.path) === pathKey(path))) {
      updateSettings({ remoteRoots: [...list, { machine, path }] });
      memory.scanningSince = 0;
      this.scan(cx, { quiet: false });
    }
    this.remotePath.set_value("");
    cx.notify();
  }

  /** `root`: an entry of allRoots(). */
  removeRoot(root, cx) {
    const same = (machine, path) => (machine ?? null) === root.machine && pathKey(path) === pathKey(root.path);
    updateSettings((s) => (root.machine
      ? { remoteRoots: s.remoteRoots.filter((r) => !same(r.machine, r.path)) }
      : { roots: s.roots.filter((r) => !same(null, r)) }));
    // The other folders keep their repositories: drop this folder's only.
    const c = cache();
    setCache({ ...c, repos: c.repos.filter((r) => !same(r.machine, r.root)), missing: c.missing.filter((m) => pathKey(m) !== pathKey(root.id)) });
    cx.notify();
  }

  /** The choices of the quick filter: none when all repositories are on this computer. */
  places() {
    const names = [...new Set(cache().repos.map((r) => r.machine).filter(Boolean))].sort();
    if (!names.length) return [];
    return [{ value: "all", label: "All" }, { value: "local", label: "This computer" }, ...names.map((m) => ({ value: m, label: m }))];
  }

  /** The quick filter now; "all" when its machine has no repositories any more. */
  place() {
    return this.places().some((p) => p.value === memory.place) ? memory.place : "all";
  }

  setPlace(value, cx) {
    memory.place = value;
    this.at = 0;
    this.scrollTop.list = 0;
    this.follow = true;
    cx.notify();
  }

  /** The rows of the list view: section titles and repositories. */
  rows() {
    const place = this.place();
    const repos = cache().repos
      .filter((r) => place === "all" || (place === "local" ? !r.machine : r.machine === place))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const q = this.filter.trim();
    const rows = [];
    const add = (title, items, opts = {}) => {
      if (!items.length) return;
      rows.push({ kind: "head", title, count: items.length, ...opts });
      for (const r of items) rows.push({ kind: "repo", ...r });
    };

    const free = this.freeRows(q);
    const addFree = () => {
      if (!free.length) return;
      rows.push({ kind: "head", title: "No repository", count: free.length, symbol: "terminal" });
      rows.push(...free);
    };

    if (q) {
      const hits = [];
      for (const repo of repos) {
        const parent = parentOf(repo);
        const match = matchRepo(q, repo.name, parent);
        if (!match) continue;
        const fav = isFavorite(repoId(repo));
        const recent = lastOpened(repoId(repo));
        hits.push({ repo, parent, match, fav, score: match.score + (fav ? 40 : 0) + (recent ? 10 : 0) });
      }
      hits.sort((a, b) => b.score - a.score || a.repo.name.localeCompare(b.repo.name));
      add("Results", hits, { symbol: "search" });
      addFree();
      return rows;
    }
    addFree();

    const entry = (repo) => ({
      repo,
      parent: parentOf(repo),
      match: null,
      fav: isFavorite(repoId(repo)),
    });
    const favorites = repos.filter((r) => isFavorite(repoId(r))).map(entry);
    const rest = repos.filter((r) => !isFavorite(repoId(r)));
    const recent = rest.filter((r) => lastOpened(repoId(r)) > 0)
      .sort((a, b) => lastOpened(repoId(b)) - lastOpened(repoId(a)))
      .slice(0, RECENT_COUNT);
    const recentKeys = new Set(recent.map((r) => pathKey(repoId(r))));
    const others = rest.filter((r) => !recentKeys.has(pathKey(repoId(r))));
    add("Favorites", favorites, { symbol: "star-fill", color: GOLD });
    add("Recent", recent.map(entry), { symbol: "refresh" });
    // This computer's repositories, then one section for each other machine.
    const groups = new Map([[null, []]]);
    for (const r of others) groups.set(r.machine ?? null, [...(groups.get(r.machine ?? null) ?? []), r]);
    const remote = groups.size > 1;
    for (const [machine, items] of groups) {
      add(machine ? `On ${machine}` : remote ? "On this computer" : "Repositories", items.map(entry), { symbol: "repo" });
    }
    return rows;
  }

  /**
   * The rows that open a terminal or an agent outside a repository, like
   * Herdr's own New menu: in the shown space, or in a new space. Their
   * `repo` is a stand-in with `free: true` and no path.
   */
  freeRows(q) {
    const active = spaces().find((s) => s.active);
    const machine = active?.machine ?? null;
    const items = [
      { key: "terminal", title: "Terminal", detail: active ? `A new tab in the space ${active.name}` : "A new tab in the shown space", pick: null },
      { key: "space", title: "New space", detail: machine ? `A new space on ${machine}` : "A new space with a shell", pick: "new" },
    ];
    const out = [];
    for (const it of items) {
      const match = q ? matchRepo(q, it.title, it.detail) : null;
      if (q && !match) continue;
      out.push({ kind: "free", ...it, match, repo: { free: true, key: it.key, name: it.title, path: "", machine, pick: it.pick } });
    }
    return out;
  }

  selectable(rows = this.rows()) {
    return rows.filter((r) => r.kind === "repo" || r.kind === "free");
  }

  selectedRepo() {
    const list = this.selectable();
    return list[Math.min(this.at, list.length - 1)]?.repo ?? null;
  }

  /** The accounts of an agent: the detected ones and the ones a person added. */
  accountsOf(agentKey) {
    const seen = new Set();
    const out = [];
    for (const a of [...this.accounts, ...settings().accounts]) {
      if (a.agent !== agentKey || seen.has(pathKey(a.dir))) continue;
      seen.add(pathKey(a.dir));
      out.push(a);
    }
    return out;
  }

  /** The installed agents of a machine (null: this computer). */
  agentsOn(machine) {
    return machine ? remoteAgentCache(machine).list ?? [] : this.agents;
  }

  /** Asks another machine for its agents once; Refresh agents asks again. */
  checkRemoteAgents(machine, cx, { force = false } = {}) {
    if (!machine || memory.checkingRemote[machine]) return;
    if (!force && remoteAgentCache(machine).list) return;
    memory.checkingRemote[machine] = true;
    cx.spawn(async (cx) => {
      try {
        setRemoteAgentCache(machine, (await knownAgents({ on: machine })).filter((a) => a.installed));
      } catch (e) {
        notify({ title: `Could not read the agents on ${machine}`, body: String(e?.message ?? e), level: "error" });
      } finally {
        memory.checkingRemote[machine] = false;
      }
      cx.notify();
    });
  }

  /** The choices of the actions view. */
  actions() {
    const out = [{ id: "terminal", title: "Terminal", subtitle: this.repo?.free ? "A shell" : "A shell in the repository", program: { icon: "icons/shell.svg", tint: true, color: theme().foreground, tile: theme().raised } }];
    const args = settings().args;
    const machine = this.repo?.machine ?? null;
    for (const agent of this.agentsOn(machine)) {
      const extra = (args[agent.key] ?? "").trim();
      const command = [...(agent.run ?? []), extra].filter(Boolean).join(" ");
      // The accounts are folders on this computer.
      const accounts = ACCOUNT_AGENTS[agent.key] && !machine ? this.accountsOf(agent.key) : [];
      if (accounts.length > 1) {
        for (const account of accounts) {
          out.push({
            id: `${agent.key}:${pathKey(account.dir)}`,
            title: agent.name,
            account,
            subtitle: command,
            agent,
            extra,
            program: agent,
          });
        }
      } else {
        out.push({ id: agent.key, title: agent.name, subtitle: command, agent, extra, program: agent });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Actions

  /**
   * Where a choice can open: a new space, or an open space of the
   * repository's machine. The spaces that work in the repository come first,
   * then the shown space, then the others in sidebar order.
   */
  targets() {
    const repo = this.repo;
    if (!repo) return [];
    const machine = repo.machine ?? null;
    const own = repo.free ? [] : spacesFor(repo.path, machine);
    const ownIds = new Set(own.map((s) => s.id));
    const others = spaces()
      .filter((s) => (s.machine ?? null) === machine && !ownIds.has(s.id))
      .sort((a, b) => (Number(b.active) - Number(a.active)) || (a.index - b.index));
    return [
      { value: "new", label: "New space" },
      ...own.map((s) => ({ value: s.id, label: s.name, space: s, own: true })),
      ...others.map((s) => ({ value: s.id, label: s.name, space: s, own: false })),
    ];
  }

  /** The chosen target; without a choice, the one that "Reuse open space" picks. */
  target(list = this.targets()) {
    if (this.pickedTarget && list.some((x) => x.value === this.pickedTarget)) return this.pickedTarget;
    // Without a repository, the shown space, like Herdr's New menu.
    if (this.repo?.free) return list.find((x) => x.space?.active)?.value ?? "new";
    const own = list.find((x) => x.own);
    return settings().reuse && own ? own.value : "new";
  }

  setReuse(on, cx) {
    updateSettings({ reuse: on });
    // The switch picks the space again.
    this.pickedTarget = null;
    cx.notify();
  }

  choose(repo, cx) {
    if (!repo) return;
    this.repo = repo;
    this.pickedTarget = repo.pick ?? null;
    this.checkRemoteAgents(repo.machine, cx);
    this.view = "actions";
    this.actionAt = 0;
    this.scrollTop.actions = 0;
    this.follow = true;
    this.focusRoot(cx);
    cx.notify();
  }

  back(cx) {
    this.view = "list";
    this.capturing = false;
    this.pendingChord = null;
    this.focusQuery(cx);
    cx.notify();
  }

  openSettings(cx) {
    this.view = "settings";
    this.capturing = false;
    this.keyError = "";
    this.ensureArgInputs();
    this.focusRoot(cx);
    cx.notify();
  }

  /**
   * Asks Herdr for the installed agents and saves the list in shared state.
   * Herdr starts a shell for this check, so it runs only on the first open
   * and when a person clicks Refresh. `loud`: show a toast with the result.
   */
  refreshAgents(cx, { loud = false } = {}) {
    // The machines with folders here ask again too.
    if (loud) for (const m of new Set(settings().remoteRoots.map((r) => r.machine))) this.checkRemoteAgents(m, cx, { force: true });
    if (memory.checkingAgents) return;
    memory.checkingAgents = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const list = (await knownAgents()).filter((a) => a.installed);
        this.agents = list;
        setAgentCache(list);
        // The agents can arrive after the settings view opened.
        this.ensureArgInputs();
        if (loud) notify({ title: "Agents updated", body: `${list.length} installed agent${list.length === 1 ? "" : "s"} found.`, level: "success" });
      } catch (e) {
        if (loud) notify({ title: "Could not read the agents", body: String(e?.message ?? e), level: "error" });
      } finally {
        memory.checkingAgents = false;
      }
      cx.notify();
    });
  }

  /**
   * Makes the argument field of each agent that has none yet. A text field
   * needs a live host call, so this runs only in `init`, in a handler or in
   * a task, never in `render`.
   */
  ensureArgInputs() {
    for (const agent of this.agents) {
      if (this.argInputs[agent.key]) continue;
      const input = InputState.new({ placeholder: "Extra arguments, e.g. --verbose", value: settings().args[agent.key] ?? "" });
      input.on("change", () => updateSettings((s) => ({ args: { ...s.args, [agent.key]: input.value() } })));
      // A click in a field stops a shortcut capture that is in progress.
      input.on("focus", (_e, cx) => {
        if (!this.capturing) return;
        this.capturing = false;
        cx.notify();
      });
      this.argInputs[agent.key] = input;
    }
  }

  /** Opens `action` in the chosen repository and closes the popup. */
  launch(action, cx) {
    const repo = this.repo;
    if (!repo || !action || this.launching) return;
    this.launching = true;
    const s = settings();
    const name = action.agent
      ? (action.account && !action.account.isDefault ? `${action.agent.name} (${action.account.label})` : action.agent.name)
      : undefined;
    // Building the argv of a second account can run a program (which
    // PowerShell), so it runs as a task.
    cx.spawn(async (cx) => {
      let argv = null;
      try {
        argv = action.agent ? await agentArgv(action.agent, action.extra, action.account) : null;
      } catch (e) {
        this.launching = false;
        notify({ title: "Could not start the agent", body: String(e?.message ?? e), level: "error" });
        return;
      }
      const before = new Set(panes().map((p) => p.terminal).filter(Boolean));
      let result;
      try {
        const machine = repo.machine ?? null;
        if (repo.free) result = openFree({ argv, name, target: this.target(), mode: s.reuseMode, machine });
        else result = open(repo.path, { argv, name, reuse: s.reuse, mode: s.reuseMode, machine, windows: machine ? infoOf(machine).windows : isWindows(), target: this.target() });
      } catch (e) {
        this.close();
        notify({ title: `Could not open ${repo.name}`, body: String(e?.message ?? e), level: "error" });
        return;
      }
      if (!repo.free) markOpened(repoId(repo));
      if (!result?.created) return this.close();
      // Focus the new terminal, so every layout shows it (a layout can
      // follow the focused pane rather than the selected space). The popup
      // stays open for at most 2 s while the terminal starts.
      let tries = 0;
      const focusNew = (cx) => {
        const fresh = panes().find((p) => p.terminal && !before.has(p.terminal));
        if (fresh) run("pane.focus", { terminal: fresh.terminal });
        if (fresh || ++tries >= 20) return this.close();
        cx.timer.after(100, focusNew);
      };
      focusNew(cx);
    });
  }

  quickTerminal(repo, cx) {
    this.repo = repo;
    this.pickedTarget = repo.pick ?? null;
    this.launch(this.actions()[0], cx);
  }

  async captureKey(e, cx) {
    if (e.key === "escape") {
      this.capturing = false;
      cx.notify();
      return;
    }
    const chord = chordOf(e);
    if (!chord) return;
    this.capturing = false;
    await this.saveChord(chord, false, cx);
  }

  async saveChord(chord, replace, cx) {
    try {
      await bindShortcut(chord, replace);
      this.pendingChord = null;
      this.keyError = "";
      notify({ title: "Shortcut saved", body: `${prettyKeys(chord)} opens the Repo Launcher`, level: "success", timeout: 3000 });
      // Herdr reads keys.json again after the write. Wait until `keys()`
      // has the new chord (at most 2 s), then redraw the other mods.
      let tries = 0;
      const announce = (cx) => {
        if (boundKeys().includes(chord) || ++tries >= 20) {
          announceShortcut();
          cx.notify();
          return;
        }
        cx.timer.after(100, announce);
      };
      announce(cx);
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (msg.startsWith("taken:")) {
        this.pendingChord = { chord, action: msg.slice(6) };
      } else {
        this.keyError = msg;
      }
    }
    cx.notify();
  }

  onKey(e, cx) {
    const k = e.key;
    const m = e.modifiers ?? {};
    const ctrl = m.control || m.platform;

    if (this.view === "settings") {
      if (this.capturing) {
        cx.stop_propagation();
        cx.spawn(async (cx) => this.captureKey(e, cx));
        return;
      }
      // A focused argument field keeps Esc from Herdr: close the popup here.
      if (k === "escape") {
        cx.stop_propagation();
        return this.close();
      }
      return;
    }

    if (this.view === "actions") {
      const actions = this.actions();
      if (k === "backspace" || k === "left") {
        cx.stop_propagation();
        return this.back(cx);
      }
      if (k === "down" || k === "up") {
        this.actionAt = (this.actionAt + (k === "down" ? 1 : actions.length - 1)) % actions.length;
        this.follow = true;
      } else if (k === "enter") {
        this.launch(actions[this.actionAt], cx);
      } else if (/^[1-9]$/.test(k) && !ctrl && !m.alt) {
        const a = actions[Number(k) - 1];
        if (a) this.launch(a, cx);
      } else if (k === "tab") {
        const list = this.targets();
        const i = list.findIndex((x) => x.value === this.target(list));
        this.pickedTarget = list[(i + (m.shift ? list.length - 1 : 1)) % list.length].value;
      } else if (ctrl && k === "s") {
        if (!this.repo.free) toggleFavorite(repoId(this.repo));
      } else if (ctrl && k === "e" && !this.repo.free) {
        return this.setReuse(!settings().reuse, cx);
      } else return;
      cx.stop_propagation();
      cx.notify();
      return;
    }

    // The list view.
    const list = this.selectable();
    if (k === "escape") return this.close();
    if (k === "down" || k === "up") {
      if (!list.length) return;
      this.at = (this.at + (k === "down" ? 1 : list.length - 1)) % list.length;
      this.follow = true;
    } else if (k === "pagedown" || k === "pageup") {
      if (!list.length) return;
      this.at = Math.max(0, Math.min(list.length - 1, this.at + (k === "pagedown" ? 8 : -8)));
      this.follow = true;
    } else if (ctrl && k === "s") {
      const repo = this.selectedRepo();
      if (repo && !repo.free) toggleFavorite(repoId(repo));
    } else if (ctrl && k === "e") {
      updateSettings((s) => ({ reuse: !s.reuse }));
    } else if (ctrl && k === "r") {
      memory.scanningSince = 0;
      this.scan(cx, { quiet: false });
    } else if (ctrl && k === "m") {
      const places = this.places();
      if (!places.length) return;
      const i = places.findIndex((p) => p.value === this.place());
      cx.stop_propagation();
      return this.setPlace(places[(i + 1) % places.length].value, cx);
    } else if (ctrl && k === "enter") {
      const repo = this.selectedRepo();
      if (repo) this.quickTerminal(repo, cx);
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ---------------------------------------------------------------------------
  // Drawing

  render() {
    if (kitOff()) return offView();
    const t = theme();
    const body = this.view === "actions" ? this.renderActions(t)
      : this.view === "settings" ? this.renderSettings(t)
      : this.renderList(t);
    return v_flex().id("repo-launcher").size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(body);
  }

  reuseSwitch(t) {
    const on = settings().reuse;
    return h_flex().id("rl-reuse").h(30).pl(10).pr(6).gap(8).flex_none().items_center().rounded(8)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip("When the repository has an open space, open there (Ctrl+E)")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => this.setReuse(!on, cx))
      .child(div().text_size(12).text_color(on ? t.foreground : t.muted).child("Reuse open space"))
      .child(toggle(t, "rl-reuse-toggle", on, (cx) => this.setReuse(!on, cx)));
  }

  header(t, title, subtitle, { leading, trailing = [] }) {
    return h_flex().h(60).flex_none().px(16).gap(12).items_center().border_b(1).border_color(t.border)
      .child(leading)
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(15).font_semibold().truncate().child(title))
        .when(Boolean(subtitle), (e) => e.child(div().text_size(11.5).text_color(t.dim).truncate().child(subtitle))))
      .children(trailing)
      .when(Boolean(props()?.overlay), (e) => e.child(iconButton(t, "rl-close", "close", () => this.close(), { tooltip: "Close", size: 26 })));
  }

  brandTile(t) {
    return h_flex().size(34).flex_none().rounded(10).items_center().justify_center().bg(t.accent)
      .child(svg(icon("repo")).size(18).text_color(t.accent_foreground ?? "#ffffff"));
  }

  // --- list ------------------------------------------------------------------

  renderList(t) {
    const s = settings();
    const c = cache();
    const scanning = isScanning();
    const rows = this.rows();
    const list = this.selectable(rows);
    if (this.at >= list.length) this.at = Math.max(0, list.length - 1);
    const sel = list[this.at]?.repo ?? null;

    const roots = allRoots();
    const subtitle = roots.length === 0
      ? "Add a folder to start"
      : `${c.repos.length} repositories in ${roots.length} folder${roots.length === 1 ? "" : "s"}`;

    const head = this.header(t, "Open a repository", subtitle, {
      leading: this.brandTile(t),
      trailing: [
        this.reuseSwitch(t),
        div().w(1).h(20).bg(t.border).flex_none(),
        iconButton(t, "rl-refresh", "refresh", (cx) => {
          memory.scanningSince = 0;
          this.scan(cx, { quiet: false });
        }, { tooltip: "Read the folders again (Ctrl+R)", spin: scanning }),
        iconButton(t, "rl-settings", "settings", (cx) => this.openSettings(cx), { tooltip: "Settings" }),
      ],
    });

    const search = h_flex().mx(16).mt(14).mb(8).h(42).flex_none().px(14).gap(10).items_center().rounded(11)
      .bg(t.background).border_1().border_color(tint(t.accent, "99"))
      .child(svg(icon("search")).size(16).text_color(t.accent))
      .child(Input.new(this.query).flex_1().h_full().text_size(14).text_color(t.foreground))
      .when(Boolean(this.filter), (e) => e.child(div().text_size(11).text_color(t.dim).child(`${list.length} match${list.length === 1 ? "" : "es"}`)))
      .when(this.places().length > 0, (e) => e.child(div().flex_none().tooltip(`Show the repositories of one machine (${prettyKeys("ctrl-m")})`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(segmented(t, "rl-place", this.places(), this.place(), (v, cx) => this.setPlace(v, cx)))));

    let content;
    if (roots.length === 0) {
      content = this.emptyState(t, "folder-plus", "Add the folders that hold your repositories",
        "The launcher reads them once and keeps the list. Refresh reads them again.",
        h_flex().gap(8)
          .child(button(t, "rl-add-first", "Add folder…", (cx) => this.addRoot(cx), { primary: true, symbol: "plus" }))
          .when(remoteMachines().length > 0, (e) => e.child(button(t, "rl-add-remote-first", "Folder on another machine…", (cx) => this.openSettings(cx), { symbol: "folder-plus" }))));
    } else if (c.repos.length === 0 && scanning) {
      content = this.emptyState(t, null, "Looking for repositories…", roots.map((r) => placeLabel(r.id)).join("  ·  "));
    } else if (c.repos.length === 0) {
      content = this.emptyState(t, "repo", "No repositories found",
        `The search opens ${3} folder levels under each root folder.`,
        button(t, "rl-rescan", "Refresh", (cx) => { memory.scanningSince = 0; this.scan(cx, { quiet: false }); }, { symbol: "refresh" }));
    } else if (list.length === 0) {
      content = this.emptyState(t, "search", `No repository matches “${this.filter.trim()}”`, "Try fewer letters, or Refresh if the repository is new.");
    } else {
      const sizes = rows.map((r) => (r.kind === "head" ? HEAD_H : ROW_H));
      const selRow = rows.findIndex((r) => r.kind !== "head" && r.repo === sel);
      // Show the section title above the first row of a section too.
      const focusRow = selRow > 0 && rows[selRow - 1].kind === "head" ? [selRow - 1, selRow] : [selRow, selRow];
      content = this.scrollList(t, "list", rows, sizes, LIST_MAX, focusRow, (r) => (r.kind === "head"
        ? sectionTitle(t, r.title, { symbol: r.symbol, color: r.color, count: r.count })
        : r.kind === "free" ? this.freeRow(t, r, r.repo === sel)
        : this.repoRow(t, r, r.repo === sel)));
    }

    const footer = h_flex().h(38).flex_none().px(16).gap(14).items_center().border_t(1).border_color(t.border).bg(t.chrome ?? t.popover)
      .child(hint(t, ["↑", "↓"], "move"))
      .child(hint(t, ["↵"], "choose"))
      .child(hint(t, [prettyKeys("ctrl-enter")], "terminal"))
      .child(hint(t, [prettyKeys("ctrl-s")], "favorite"))
      .when(this.places().length > 0, (e) => e.child(hint(t, [prettyKeys("ctrl-m")], "machine")))
      .child(div().flex_1())
      .child(div().text_size(11).text_color(t.dim).child(scanning ? "Scanning…" : c.scannedAt ? `Scanned ${ago(c.scannedAt)}` : ""));

    return v_flex().size_full().min_h(0)
      .child(head)
      .child(search)
      .child(content)
      .child(footer);
  }

  /**
   * A list that draws only the rows in view. Rows sit at fixed offsets in
   * one strip; the wheel moves the strip, and while `follow` is on the
   * strip moves just enough to show the rows `focus` names ([first, last]).
   */
  scrollList(t, id, items, heights, maxHeight, focus, draw) {
    const tops = [];
    let y = 0;
    for (const h of heights) {
      tops.push(y);
      y += h;
    }
    const total = y;
    const height = Math.min(maxHeight, total);
    const max = Math.max(0, total - height);
    let top = this.scrollTop[id] ?? 0;
    const [first, last] = focus;
    if (this.follow && first >= 0 && last >= 0) {
      if (tops[first] < top) top = tops[first];
      if (tops[last] + heights[last] > top + height) top = tops[last] + heights[last] - height;
    }
    top = Math.max(0, Math.min(top, max));
    this.scrollTop[id] = top;

    const rows = [];
    items.forEach((item, i) => {
      if (tops[i] + heights[i] <= top || tops[i] >= top + height) return;
      rows.push(div().absolute().left(0).right(0).top(tops[i] - top).h(heights[i]).child(draw(item, i)));
    });
    const thumb = total > height ? Math.max(24, (height * height) / total) : 0;
    return div().id(`rl-scroll-${id}`).relative().w_full().h(height).flex_none().overflow_hidden()
      .on_scroll_wheel((e, cx) => {
        this.follow = false;
        this.scrollTop[id] = Math.max(0, Math.min((this.scrollTop[id] ?? 0) - e.delta.y, max));
        cx.notify();
      })
      .children(rows)
      .when(thumb > 0, (el) => el.child(div().absolute().right(3).w(4).rounded(2).bg(tint(t.foreground, "33"))
        .top(max ? ((height - thumb) * top) / max : 0).h(thumb)));
  }

  emptyState(t, symbol, title, detail, action = null) {
    return v_flex().h(EMPTY_H).w_full().flex_none().items_center().justify_center().gap(10).p(28)
      .child(h_flex().size(54).rounded(27).items_center().justify_center().bg(tint(t.accent, "1a"))
        .child(symbol
          ? svg(icon(symbol)).size(24).text_color(t.accent)
          : svg(icon("spinner")).size(24).text_color(t.accent).spin(900)))
      .child(div().mt(4).text_size(14).font_semibold().child(title))
      .when(Boolean(detail), (e) => e.child(div().max_w(460).text_size(12).text_color(t.dim).child(detail)))
      .when(Boolean(action), (e) => e.child(div().mt(8).child(action)));
  }

  spaceBadge(t, repo) {
    const open = spacesFor(repo.path, repo.machine ?? null);
    if (!open.length) return null;
    const space = open[0];
    const color = spaceColor(t, space) ?? t.accent;
    const status = space.status;
    const more = open.length > 1 ? ` +${open.length - 1}` : "";
    if (status === "working") return pill(t, `${space.name}${more}`, { color: t.working, symbol: "spinner", spin: true, max: 130 });
    if (status === "blocked") return pill(t, `${space.name}${more}`, { color: t.blocked, dot: t.blocked, max: 130 });
    if (status === "done") return pill(t, `${space.name}${more}`, { color: t.done, dot: t.done, max: 130 });
    return pill(t, `${space.name}${more}`, { color, dot: color, max: 130 });
  }

  /** A row of the "No repository" section. */
  freeRow(t, r, selected) {
    return h_flex().id(`rl-free-${r.key}`).h(ROW_H).px(8).flex_none()
      .child(h_flex().size_full().px(10).gap(12).items_center().rounded(10).cursor_pointer()
        .border_1().border_color(selected ? tint(t.accent, "80") : "#00000000")
        .bg(selected ? tint(t.accent, "1c") : "#00000000")
        .when(!selected, (e) => e.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => {
          this.at = Math.max(0, this.selectable().findIndex((x) => x.kind === "free" && x.key === r.key));
          this.choose(r.repo, cx);
        })
        .child(r.key === "space"
          ? h_flex().size(32).flex_none().rounded(9).items_center().justify_center().bg(t.raised).border_1().border_color(t.border)
            .child(svg(icon("plus")).size(16).text_color(t.foreground))
          : programTile(t, { icon: "icons/shell.svg", tint: true, color: t.foreground, tile: t.raised }, 32))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(highlighted(r.title, r.match?.name, { color: t.foreground, hit: t.accent, size: 13.5, bold: true }))
          .child(div().text_size(11).text_color(t.dim).truncate().child(r.detail)))
        .when(selected, (e) => e.child(kbd(t, "↵"))));
  }

  repoRow(t, r, selected) {
    const { repo, parent, match, fav } = r;
    const open = spacesFor(repo.path, repo.machine ?? null);
    const color = open.length ? spaceColor(t, open[0]) : repoColor(repo.name);
    const badge = this.spaceBadge(t, repo);
    const branch = open[0]?.branch;
    return h_flex().id(`rl-row-${repoId(repo)}`).h(ROW_H).px(8).flex_none()
      .child(h_flex().size_full().px(10).gap(12).items_center().rounded(10).cursor_pointer()
        .border_1().border_color(selected ? tint(t.accent, "80") : "#00000000")
        .bg(selected ? tint(t.accent, "1c") : fav ? tint(GOLD, "0c") : "#00000000")
        .when(!selected, (e) => e.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => {
          this.at = Math.max(0, this.selectable().findIndex((x) => x.repo === repo));
          this.choose(repo, cx);
        })
        .child(letterTile(repo.name, color, 32))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().min_w(0).gap(6).items_center()
            .child(highlighted(repo.name, match?.name, { color: t.foreground, hit: t.accent, size: 13.5, bold: true }))
            .when(Boolean(branch), (e) => e.child(h_flex().flex_none().gap(3).items_center().text_size(11).text_color(t.dim)
              .child(svg(icon("branch")).size(11))
              .child(div().max_w(140).truncate().child(branch)))))
          .child(highlighted(parent, match?.path, { color: t.dim, hit: t.accent, size: 11 })))
        .when(Boolean(repo.machine), (e) => e.child(pill(t, repo.machine, { max: 110 })))
        .when(Boolean(badge), (e) => e.child(badge))
        .child(h_flex().id(`rl-star-${repoId(repo)}`).size(28).flex_none().items_center().justify_center().rounded(7)
          .cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(fav ? "Remove from favorites (Ctrl+S)" : "Add to favorites (Ctrl+S)")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            toggleFavorite(repoId(repo));
            cx.notify();
          })
          .child(svg(icon(fav ? "star-fill" : "star")).size(15).text_color(fav ? GOLD : selected ? t.muted : tint(t.dim, "99"))))
        .when(selected, (e) => e.child(kbd(t, "↵"))));
  }

  // --- actions ---------------------------------------------------------------

  renderActions(t) {
    const repo = this.repo;
    const s = settings();
    const actions = this.actions();
    if (this.actionAt >= actions.length) this.actionAt = 0;
    const free = Boolean(repo.free);
    const open = free ? [] : spacesFor(repo.path, repo.machine ?? null);
    const targets = this.targets();
    const picked = targets.find((x) => x.value === this.target(targets));
    const target = picked?.space ?? null;
    const fav = !free && isFavorite(repoId(repo));
    const color = open.length ? spaceColor(t, open[0]) : repoColor(repo.name);

    const head = this.header(t, free ? "No repository" : repo.name,
      free ? (repo.machine ? `A terminal or an agent on ${repo.machine}` : "A terminal or an agent")
        : repo.machine ? placeLabel(repoId(repo)) : displayPath(repo.path), {
      leading: h_flex().gap(8).items_center()
        .child(iconButton(t, "rl-back", "back", (cx) => this.back(cx), { tooltip: "Back (Esc)" }))
        .child(free ? programTile(t, { icon: "icons/shell.svg", tint: true, color: t.foreground, tile: t.raised }, 34) : letterTile(repo.name, color, 34)),
      trailing: free ? [] : [
        iconButton(t, "rl-fav", fav ? "star-fill" : "star", (cx) => { toggleFavorite(repoId(repo)); cx.notify(); },
          { tooltip: fav ? "Remove from favorites (Ctrl+S)" : "Add to favorites (Ctrl+S)", color: fav ? GOLD : null }),
      ],
    });

    // Where the choice opens.
    // "Go to space" needs a space that works in the repository.
    const mode = s.reuseMode === "go" && !picked?.own ? "tab" : s.reuseMode;
    const where = target
      ? (mode === "go"
        ? [`Terminal goes to the space `, target.name, `. An agent opens in a new tab there.`]
        : [`Opens in the space `, target.name, ` ${MODE_TEXT[mode]}.`])
      : repo.machine
        ? ["Opens in a new space on ", repo.machine, "."]
        : ["Opens in a new space.", "", ""];
    const chips = h_flex().flex_1().min_w(0).flex_wrap().gap(6)
      .children(targets.map((x) => this.targetChip(t, x, x.value === picked?.value)));
    const banner = v_flex().mx(16).mt(14).p(12).gap(10).flex_none().rounded(11)
      .bg(target ? tint(spaceColor(t, target) ?? t.accent, "14") : t.raised)
      .border_1().border_color(target ? tint(spaceColor(t, target) ?? t.accent, "40") : t.border)
      .child(h_flex().gap(10).items_center()
        .child(svg(icon("layers")).size(16).text_color(target ? (spaceColor(t, target) ?? t.accent) : t.muted))
        .child(h_flex().flex_1().min_w(0).text_size(12.5).text_color(t.muted)
          .child(div().flex_none().child(where[0]))
          .when(Boolean(where[1]), (e) => e.child(div().flex_none().font_semibold().text_color(t.foreground).child(where[1])))
          .child(div().truncate().child(where[2])))
        .when(!free, (e) => e.child(this.reuseSwitch(t))))
      .child(h_flex().gap(10).items_start()
        .child(div().w(64).flex_none().pt(4).text_size(11.5).text_color(t.dim).child("Space:"))
        .child(chips))
      .when(Boolean(target), (e) => e.child(h_flex().gap(10).items_center()
        .child(div().w(64).flex_none().text_size(11.5).text_color(t.dim).child("Open as:"))
        .child(segmented(t, "rl-mode", free ? MODES.filter((x) => x.value !== "go") : MODES, free ? mode : s.reuseMode, (v, cx) => { updateSettings({ reuseMode: v }); cx.notify(); }))));

    const sizes = actions.map(() => ACTION_H);
    const listEl = div().mt(10).mb(8).w_full().flex_none()
      .child(this.scrollList(t, "actions", actions, sizes, LIST_MAX, [this.actionAt, this.actionAt], (a, i) => this.actionRow(t, a, i)))
      .when(Boolean(repo.machine && memory.checkingRemote[repo.machine]), (e) => e.child(h_flex().h(30).px(18).gap(8).items_center()
        .text_size(11.5).text_color(t.dim)
        .child(svg(icon("spinner")).size(12).text_color(t.accent).spin(900))
        .child(div().child(`Looking for the agents on ${repo.machine}…`))));

    const footer = h_flex().h(38).flex_none().px(16).gap(14).items_center().border_t(1).border_color(t.border).bg(t.chrome ?? t.popover)
      .child(hint(t, ["↑", "↓"], "move"))
      .child(hint(t, ["↵"], "open"))
      .child(hint(t, ["1–9"], "pick"))
      .child(hint(t, ["Tab"], "space"))
      .when(!free, (e) => e.child(hint(t, [prettyKeys("ctrl-e")], "reuse")))
      .child(div().flex_1())
      .child(hint(t, ["⌫"], "back"))
      .child(hint(t, ["Esc"], "close"));

    return v_flex().size_full().min_h(0)
      .child(head)
      .child(banner)
      .child(listEl)
      .child(footer);
  }

  /** A choice of the space picker. `x`: an entry of targets(). */
  targetChip(t, x, on) {
    const color = x.space ? spaceColor(t, x.space) ?? t.accent : t.accent;
    return h_flex().id(`rl-target-${x.value}`).h(24).px(9).gap(6).flex_none().items_center().rounded(12)
      .cursor_pointer().text_size(11.5)
      .bg(on ? tint(color, "2a") : t.raised)
      .border_1().border_color(on ? tint(color, "99") : t.border)
      .text_color(on ? t.foreground : t.muted)
      .when(!on, (e) => e.hover((s) => s.text_color(t.foreground)))
      .tooltip(x.space ? (x.own ? "This space works in the repository (Tab)" : "Open in this space (Tab)") : "Open in a new space (Tab)")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        this.pickedTarget = x.value;
        cx.notify();
      })
      .child(x.space
        ? div().size(7).flex_none().rounded(4).bg(color)
        : svg(icon("plus")).size(11).flex_none().text_color(on ? t.accent : t.muted))
      .child(div().max_w(130).truncate().when(on, (e) => e.font_semibold()).child(x.label))
      .when(Boolean(x.own), (e) => e.child(svg(icon("repo")).size(10).flex_none().text_color(t.dim)));
  }

  actionRow(t, a, index) {
    const selected = index === this.actionAt;
    const account = a.account;
    return h_flex().id(`rl-act-${a.id}`).h(ACTION_H).px(8).flex_none()
      .child(h_flex().size_full().px(10).gap(12).items_center().rounded(10).cursor_pointer()
        .border_1().border_color(selected ? tint(t.accent, "80") : "#00000000")
        .bg(selected ? tint(t.accent, "1c") : "#00000000")
        .when(!selected, (e) => e.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.launch(a, cx))
        .child(programTile(t, a.program, 34))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(8).items_center()
            .child(div().text_size(13.5).font_semibold().child(a.title))
            .when(Boolean(account), (e) => e.child(pill(t, account.label, { color: account.isDefault ? t.accent : t.ansi5 ?? t.accent, symbol: "user" }))))
          .child(div().text_size(11).text_color(t.dim).truncate()
            .child(account ? [account.email, a.subtitle].filter(Boolean).join("  ·  ") : a.subtitle)))
        .child(index < 9 ? kbd(t, String(index + 1)) : div()));
  }

  // --- settings ----------------------------------------------------------------

  card(t, title, detail, body) {
    return v_flex().gap(10).p(14).flex_none().rounded(12).bg(t.background).border_1().border_color(t.border)
      .child(v_flex().gap(2)
        .child(div().text_size(13).font_semibold().child(title))
        .when(Boolean(detail), (e) => e.child(div().text_size(11.5).text_color(t.dim).child(detail))))
      .child(body);
  }

  renderSettings(t) {
    const s = settings();
    const c = cache();
    const scanning = isScanning();

    const head = this.header(t, "Settings", "Repo Launcher", {
      leading: h_flex().gap(8).items_center()
        .child(iconButton(t, "rl-back", "back", (cx) => this.back(cx), { tooltip: "Back (Esc)" }))
        .child(this.brandTile(t)),
      trailing: [],
    });

    // Root folders.
    const counts = {};
    for (const r of c.repos) {
      const k = pathKey(placeId(r.machine, r.root));
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const known = remoteMachines();
    const target = this.remoteMachine();
    const remoteAdd = known.length === 0 ? null : h_flex().gap(8).items_center()
      .child(known.length > 1
        ? segmented(t, "rl-remote-machine", known.map((m) => ({ value: m, label: m })), target, (v, cx) => { this.remoteTarget = v; cx.notify(); })
        : pill(t, target, { max: 140 }))
      .child(h_flex().flex_1().h(30).px(10).items_center().rounded(8).bg(t.raised).border_1().border_color(t.border)
        .child(Input.new(this.remotePath).flex_1().h_full().text_size(12)))
      .child(button(t, "rl-add-remote", "Add", (cx) => this.addRemoteRoot(cx), { symbol: "plus" }));
    const roots = v_flex().gap(6)
      .children(allRoots().map((root, i) => {
        const missing = c.missing.some((m) => pathKey(m) === pathKey(root.id));
        const offline = root.machine && !known.includes(root.machine);
        return h_flex().id(`rl-root-${i}`).h(40).px(10).gap(10).items_center().rounded(9).bg(t.raised)
          .child(svg(icon("folder")).size(16).text_color(missing || offline ? t.blocked : t.accent))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(displayPath(root.path, infoOf(root.machine))))
          .when(Boolean(root.machine), (e) => e.child(pill(t, root.machine, { max: 110 })))
          .child(offline ? pill(t, "unknown machine", { color: t.blocked })
            : missing ? pill(t, "not found", { color: t.blocked })
            : pill(t, `${counts[pathKey(root.id)] ?? 0} repos`))
          .child(iconButton(t, `rl-root-del-${i}`, "trash", (cx) => this.removeRoot(root, cx), { tooltip: "Remove this folder", size: 28 }));
      }))
      .when(Boolean(remoteAdd), (e) => e.child(div().pt(4).text_size(11.5).text_color(t.dim).child("A folder on another machine (type its path):")).child(remoteAdd))
      .child(h_flex().gap(8).pt(2)
        .child(button(t, "rl-add-root", "Add folder…", (cx) => this.addRoot(cx), { primary: true, symbol: "folder-plus" }))
        .child(button(t, "rl-refresh-all", scanning ? "Scanning…" : "Refresh", (cx) => { memory.scanningSince = 0; this.scan(cx, { quiet: false }); }, { symbol: "refresh" }))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(c.scannedAt ? `Scanned ${ago(c.scannedAt)}` : "")));

    // Reuse.
    const reuse = v_flex().gap(10)
      .child(h_flex().gap(10).items_center()
        .child(div().flex_1().text_size(12.5).child("Reuse the open space of a repository"))
        .child(toggle(t, "rl-set-reuse", s.reuse, (cx) => { updateSettings({ reuse: !s.reuse }); cx.notify(); })))
      .child(h_flex().gap(10).items_center().opacity(s.reuse ? 1 : 0.5)
        .child(div().flex_1().text_size(12.5).child("Open there as"))
        .child(segmented(t, "rl-set-mode", MODES, s.reuseMode, (v, cx) => { updateSettings({ reuseMode: v }); cx.notify(); })));

    // Shortcut.
    const bound = boundKeys();
    const shortcut = v_flex().gap(8)
      .child(h_flex().gap(10).items_center()
        .child(svg(icon("keyboard")).size(16).text_color(t.muted))
        .child(h_flex().flex_1().gap(6).items_center()
          .children(bound.length ? bound.map((k) => kbd(t, prettyKeys(k))) : [div().text_size(12).text_color(t.dim).child("No shortcut")]))
        .child(this.capturing
          ? h_flex().gap(8).items_center()
            .child(h_flex().id("rl-capturing").h(30).px(12).items_center().rounded(8).border_1().border_color(t.accent)
              .bg(tint(t.accent, "1a")).text_size(12).text_color(t.accent).child(div().child("Press the new keys…").loop("opacity", { from: 0.45, to: 1, period: 1100 })))
            .child(button(t, "rl-key-stop", "Cancel", (cx) => { this.capturing = false; cx.notify(); }))
          : button(t, "rl-change-key", "Change", (cx) => {
            this.capturing = true;
            this.pendingChord = null;
            this.keyError = "";
            this.focusRoot(cx);
            cx.notify();
          })))
      .when(Boolean(this.pendingChord), (e) => e.child(h_flex().gap(10).items_center().p(10).rounded(9)
        .bg(tint(t.blocked, "14")).border_1().border_color(tint(t.blocked, "40"))
        .child(div().flex_1().text_size(12).text_color(t.foreground)
          .child(`${prettyKeys(this.pendingChord.chord)} runs “${this.pendingChord.action}” now.`))
        .child(button(t, "rl-key-cancel", "Cancel", (cx) => { this.pendingChord = null; cx.notify(); }))
        .child(button(t, "rl-key-replace", "Replace", (cx) => {
          const chord = this.pendingChord.chord;
          cx.spawn(async (cx) => this.saveChord(chord, true, cx));
        }, { primary: true }))))
      .when(Boolean(this.keyError), (e) => e.child(div().text_size(11.5).text_color(t.blocked).child(this.keyError)))
      .child(div().text_size(11).text_color(t.dim)
        .child("Saved in keys.json (global). A Ctrl+letter key also stops reaching the programs in your terminals."));

    // Agent arguments.
    const args = v_flex().gap(8)
      .children(this.agents.map((agent) => h_flex().gap(10).items_center()
        .child(programTile(t, agent, 26))
        .child(div().w(110).flex_none().truncate().text_size(12.5).child(agent.name))
        .child(h_flex().flex_1().h(32).px(10).items_center().rounded(8).bg(t.raised).border_1().border_color(t.border)
          .child(div().flex_none().mr(6).text_size(12).text_color(t.dim).font_family(appSettings().font_family ?? "JetBrains Mono").child((agent.run ?? [agent.key]).join(" ")))
          .child(this.argInputs[agent.key]
            ? Input.new(this.argInputs[agent.key]).flex_1().h_full().text_size(12).font_family(appSettings().font_family ?? "JetBrains Mono")
            : div()))))
      .when(this.agents.length === 0, (e) => e.child(div().text_size(12).text_color(t.dim)
        .child(memory.checkingAgents ? "Looking for installed agents…" : "No installed agents found.")))
      .child(h_flex().gap(8).pt(2).items_center()
        .child(button(t, "rl-refresh-agents", memory.checkingAgents ? "Checking…" : "Refresh agents",
          (cx) => this.refreshAgents(cx, { loud: true }), { symbol: "refresh" }))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim)
          .child(agentCache().checkedAt ? `Checked ${ago(agentCache().checkedAt)}` : "")));

    // Accounts.
    const accountRows = [];
    for (const agentKey of Object.keys(ACCOUNT_AGENTS)) {
      const agent = this.agents.find((a) => a.key === agentKey);
      for (const account of this.accountsOf(agentKey)) {
        const manual = !account.detected;
        accountRows.push(h_flex().id(`rl-acc-${agentKey}-${pathKey(account.dir)}`).h(44).px(10).gap(10).items_center().rounded(9).bg(t.raised)
          .child(programTile(t, agent ?? { key: agentKey }, 26))
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(h_flex().gap(8).items_center()
              .child(div().text_size(12.5).font_semibold().child(account.label))
              .when(Boolean(account.email), (e) => e.child(div().text_size(11.5).text_color(t.muted).truncate().child(account.email))))
            .child(div().text_size(11).text_color(t.dim).truncate().child(`${ACCOUNT_AGENTS[agentKey].env}=${displayPath(account.dir)}`)))
          .child(pill(t, manual ? "added" : "detected", { color: manual ? t.accent : null }))
          .when(manual, (e) => e.child(iconButton(t, `rl-acc-del-${pathKey(account.dir)}`, "trash", (cx) => {
            updateSettings((st) => ({ accounts: st.accounts.filter((a) => !(a.agent === agentKey && pathKey(a.dir) === pathKey(account.dir))) }));
            cx.notify();
          }, { tooltip: "Remove this account", size: 28 }))));
      }
    }
    const accounts = v_flex().gap(6)
      .children(accountRows)
      .child(h_flex().gap(8).pt(2)
        .children(Object.keys(ACCOUNT_AGENTS).map((agentKey) => {
          const agent = this.agents.find((a) => a.key === agentKey);
          return button(t, `rl-acc-add-${agentKey}`, `Add ${agent?.name ?? agentKey} account…`, (cx) => this.addAccount(agentKey, cx), { symbol: "plus" });
        })));

    const body = v_flex().id("rl-settings").h(SETTINGS_H).w_full().flex_none().overflow_y_scrollbar().p(16).gap(12)
      .child(this.card(t, "Repository folders", `The launcher looks for Git repositories down to 3 folder levels under each folder. It reads them again only when you add or remove a folder, or click Refresh. A repository on another machine opens in a space on that machine.`, roots))
      .child(this.card(t, "Open space", "A repository has an open space when one of the space's terminals works in it.", reuse))
      .child(this.card(t, "Shortcut", "The keys that open this launcher.", shortcut))
      .child(this.card(t, "Agent arguments", "Added after the command of each agent, for example --dangerously-skip-permissions. The launcher keeps the list of agents. Click Refresh agents after you install or remove an agent.", args))
      .child(this.card(t, "Accounts", "Each account is a configuration folder. The launcher finds ~/.claude, ~/.claude-*, ~/.codex and ~/.codex-* itself.", accounts));

    return v_flex().size_full().min_h(0).child(head).child(body)
      .child(h_flex().h(38).flex_none().px(16).gap(14).items_center().border_t(1).border_color(t.border).bg(t.chrome ?? t.popover)
        .child(div().text_size(11).text_color(t.dim).child("Changes are saved at once."))
        .child(div().flex_1())
        .child(hint(t, ["Esc"], "close")));
  }

  addAccount(agentKey, cx) {
    cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: "Use this folder" }).catch(() => null);
      if (!dir) return;
      const path = normalize(dir);
      const email = await accountEmail(agentKey, path).catch(() => null);
      const label = path.split("/").pop().replace(/^\.(claude|codex)[-_.]?/, "") || path.split("/").pop();
      updateSettings((s) => ({
        accounts: [...s.accounts.filter((a) => !(a.agent === agentKey && pathKey(a.dir) === pathKey(path))),
          { agent: agentKey, dir: path, label, email, isDefault: false }],
      }));
      cx.notify();
    });
  }
}
