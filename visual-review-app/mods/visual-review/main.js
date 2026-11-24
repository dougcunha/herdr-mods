// Visual Review for Herdr: interactive change graph for Git commits.
// Hybrid static (C#/.NET, TS/JS, SQL/Prisma) + on-demand AI semantic analysis,
// orthogonal ELK layout, native GPUI PathBuilder rendering, semantic zoom and inline diffs.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState } from "gpui-base";
import {
  spaces, panes, focused, theme, settings, shared, setShared, props, run,
  openOverlay, closeOverlay, notify, checking, nextCommand,
} from "herdr";
import { resolveRepo, readCommits, resolveSelection, collectDiff, readFileDiff } from "./git.js";
import { analyzeStatic } from "./analyze-static.js";
import { analyzeWithAI, aiSettings, resolveEngine } from "./analyze-ai.js";
import { cacheKeyFor, readCache, writeCache, cacheStats, clearCache, formatBytes } from "./cache.js";
import { computeLayout } from "./layout.js";
import { renderCanvas, renderListView, badgeEl } from "./canvas.js";
import { renderCommitsSidebar } from "./commits.js";
import { renderDetailsPanel, renderSplitDiffOverlay } from "./details.js";
import {
  spaceAgents, cachedKnownAgents, refreshKnownAgents, describeSelected,
  formatQueuePrompt, sendToAgent, startAgentWithPrompt,
  renderNoteComposer, renderQueueOverlay,
} from "./queue.js";

const ICONS = "mods/visual-review/icons";
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 2.2;
const EDGE_KINDS = [
  { id: "inheritance", label: "Inh" },
  { id: "implementation", label: "Impl" },
  { id: "composition", label: "Comp" },
  { id: "dependency", label: "Dep" },
  { id: "table-link", label: "Tables" },
];

const kitOff = () => {
  const v = shared("herdr-mods.disabled");
  return Array.isArray(v) && v.includes("visual-review");
};
const offView = () => {
  const o = props()?.overlay;
  if (o) closeOverlay(o);
  return div();
};

function largeDiffThreshold() {
  const n = Number(shared("visual-review.largeDiffThreshold"));
  return Number.isFinite(n) && n >= 10 ? n : 40;
}

function dialogBounds(fullscreen) {
  let vp = null;
  try { vp = window.viewport_size?.(); } catch {}
  const z = settings()?.zoom || 1;
  const maxW = vp?.width ? Math.max(900, Math.floor(vp.width / z) - 24) : 1440;
  const maxH = vp?.height ? Math.max(600, Math.floor(vp.height / z) - 24) : 900;
  if (fullscreen) return { width: maxW, height: maxH };
  return { width: Math.min(maxW, 1360), height: Math.min(maxH, 860) };
}

function candidateFolders() {
  const out = [];
  const seen = new Set();
  const add = (cwd, on) => {
    if (!cwd) return;
    const key = `${on ?? ""}\0${cwd}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ cwd, on: on ?? null });
  };

  const p = props() ?? {};
  if (p.cwd) add(p.cwd, p.on);

  const f = focused();
  const allSpaces = spaces() ?? [];
  const activeSpace = allSpaces.find((s) => s.id === f?.space) ?? allSpaces.find((s) => s.active) ?? null;
  const machine = activeSpace?.machine ?? null;

  if (f?.cwd) add(f.cwd, machine);

  if (activeSpace) {
    const tabIds = new Set((activeSpace.tabs ?? []).map((t) => t.id));
    const spacePanes = (panes() ?? []).filter((pn) => tabIds.has(pn.tab) && pn.cwd);
    // Prefer focused pane, then panes in the active tab, then any terminal in the active space
    for (const pn of spacePanes.filter((pn) => pn.focused)) add(pn.cwd, machine);
    for (const pn of spacePanes.filter((pn) => pn.tab === f?.tab)) add(pn.cwd, machine);
    for (const pn of spacePanes) add(pn.cwd, machine);
    if (activeSpace.folder) add(activeSpace.folder, machine);
  }

  // Last resort: any live terminal pane
  const machineByTab = new Map(allSpaces.flatMap((s) => (s.tabs ?? []).map((t) => [t.id, s.machine ?? null])));
  for (const pn of panes() ?? []) {
    if (pn.cwd) add(pn.cwd, machineByTab.get(pn.tab) ?? null);
  }

  return out;
}

export default class VisualReview extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.viewSize = { width: 960, height: 640 };

    // Repo & commits state
    this.repo = null;
    this.commits = [];
    this.uncommittedCount = 0;
    this.commitsLoading = false;
    this.selection = props()?.selection ?? { mode: "branch-base" };
    this.resolved = null;
    this.collection = null;
    this.rangeAnchor = null;

    // Model & layout state
    this.model = null;
    this.layout = null;
    this.fromCache = false;
    this.statusText = "Initializing…";
    this.error = null;
    this.busy = false;
    this.aiRunning = false;
    this.largeDiffBanner = false;
    this.runSeq = 0;

    // UI panels & filters
    const savedW = shared("visual-review.panelWidths");
    this.commitsW = Number.isFinite(savedW?.commits) ? savedW.commits : 276;
    this.detailsW = Number.isFinite(savedW?.details) ? savedW.details : 370;
    this.resize = null;
    this.showCommits = props()?.showCommits ?? true;
    this.showDetails = props()?.showDetails ?? true;
    this.showSettings = false;
    this.showLegend = false;
    this.showNodeSearch = false;
    this.splitDiff = null; // { filePath, range } | null
    this.cacheInfo = { count: 0, bytes: 0 };

    // Review queue & agent target state
    this.queue = [];
    this.queueSeq = 0;
    this.noteKind = "change"; // "change" | "question"
    this.showQueue = false;
    this.selectedAgentAddr = null;
    this.selectedNewAgent = null;
    this.useNewAgent = false;
    this.installedAgents = [];
    this.sendingQueue = false;

    // Canvas camera & filters
    this.mode = props()?.mode ?? "diagram"; // "overview" | "diagram" | "list"
    this.zoom = 1;
    this.panX = 24;
    this.panY = 24;
    this.drag = null;
    this.dragMoved = false;
    this.selectedId = null;
    this.selected = null;
    this.focusKey = null;
    this.hiddenRelations = new Set();
    this.hideAllEdges = false;
    this.collapsedContainers = new Set();

    // Inline diff state
    this.diffText = "";
    this.diffLoading = false;
    this.diffSeq = 0;

    // Inputs
    this.commitSearch = InputState.new({ placeholder: "Filter commits…" });
    this.commitSearch.on("submit", (_e, cx) => this.loadCommits(cx));

    this.nodeSearch = InputState.new({ placeholder: "Find unit or file… (Enter)" });
    this.nodeSearch.on("submit", (_e, cx) => this.jumpBySearch(cx));

    this.noteInput = TextareaState.new({ placeholder: "Add observation or prompt for this item… (Ctrl+Enter queues)", rows: 3 });

    if (checking()) return;

    // Handle clearCache action launched from mods-hub Settings
    if (props()?.clearCache) {
      cx.spawn(async (cx) => {
        const res = await clearCache();
        this.cacheInfo = await cacheStats();
        notify({
          title: "Visual Review cache cleared",
          body: `Removed ${res.removed} cached analysis file${res.removed === 1 ? "" : "s"}.`,
          level: "info",
        });
        cx.notify();
      });
    }

    // Command listener
    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (!cmd) break;
        if (cmd === "focus") this.handle.focus();
        else if (cmd === "clear-cache") await this.purgeCache(cx);
        cx.notify();
      }
    });

    // Initial load
    this.bootstrap(cx);
  }

  bootstrap(cx) {
    cx.spawn(async (cx) => {
      this.cacheInfo = await cacheStats();
      const candidates = candidateFolders();
      if (!candidates.length) {
        this.error = "Open a terminal in a Git repository first.";
        this.statusText = "No active repository";
        cx.notify();
        return;
      }
      this.commitsLoading = true;
      this.statusText = "Reading repository…";
      cx.notify();
      try {
        let repo = null;
        for (const target of candidates) {
          repo = await resolveRepo(target.cwd, target.on);
          if (repo) break;
        }
        if (!repo) {
          this.error = `Not a Git repository: ${candidates[0].cwd}`;
          this.statusText = "Not a Git repository";
          this.commitsLoading = false;
          cx.notify();
          return;
        }
        this.repo = repo;
        const { commits, uncommittedCount } = await readCommits(repo.root, repo.on, { limit: 120 });
        this.commits = commits;
        this.uncommittedCount = uncommittedCount;
        this.commitsLoading = false;
        cx.notify();
        await this.analyzeSelection(cx);
      } catch (e) {
        this.error = String(e?.message || e);
        this.commitsLoading = false;
        cx.notify();
      }
    });
  }

  loadCommits(cx) {
    if (!this.repo) return;
    this.commitsLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { commits, uncommittedCount } = await readCommits(this.repo.root, this.repo.on, {
          limit: 120,
          search: this.commitSearch.value() || "",
        });
        this.commits = commits;
        this.uncommittedCount = uncommittedCount;
      } catch (e) {
        this.error = String(e?.message || e);
      } finally {
        this.commitsLoading = false;
        cx.notify();
      }
    });
  }

  async analyzeSelection(cx) {
    if (!this.repo) return;
    const seq = ++this.runSeq;
    this.busy = true;
    this.error = null;
    this.fromCache = false;
    this.selected = null;
    this.selectedId = null;
    this.focusKey = null;
    this.collapsedContainers = new Set();
    this.largeDiffBanner = false;
    this.statusText = "Collecting diff…";
    cx.notify();

    try {
      const resolved = await resolveSelection(this.repo, this.selection);
      if (seq !== this.runSeq) return;
      this.resolved = resolved;

      const collection = await collectDiff(this.repo, resolved);
      if (seq !== this.runSeq) return;
      this.collection = collection;

      if (!collection.files.length) {
        this.model = {
          source: "static", selection: resolved, units: [], relations: [], tables: [],
          otherFiles: [], skippedFiles: [], generatedAt: Date.now(), totalChangedFiles: 0,
        };
        this.layout = { width: 400, height: 300, containers: [], nodes: [], edges: [], engine: "empty" };
        this.statusText = `No changes in ${resolved.label}`;
        this.busy = false;
        cx.notify();
        return;
      }

      // Check disk cache for an existing AI model for this exact commit range first
      const eng = await resolveEngine(this.repo.on);
      const cKey = cacheKeyFor(this.repo, resolved, eng);
      const cached = await readCache(cKey);
      if (seq !== this.runSeq) return;

      if (cached) {
        this.model = cached;
        this.fromCache = true;
      } else {
        this.statusText = `Analyzing ${collection.files.length} changed file${collection.files.length === 1 ? "" : "s"}…`;
        cx.notify();
        this.model = await analyzeStatic(this.repo, resolved, collection);
        if (seq !== this.runSeq) return;
      }

      // Large-diff protection: automatically switch to Overview if file count exceeds threshold
      const limit = largeDiffThreshold();
      if (collection.files.length > limit) {
        this.mode = "overview";
        this.largeDiffBanner = true;
      } else if (this.mode === "overview" && !this.largeDiffBanner) {
        // Keep user's explicit mode
      }

      await this.relayout(cx, true);
    } catch (e) {
      if (seq !== this.runSeq) return;
      this.error = String(e?.message || e);
      this.statusText = "Analysis failed";
    } finally {
      if (seq === this.runSeq) {
        this.busy = false;
        cx.notify();
      }
    }
  }

  runAIEnrich(cx, force = false) {
    if (!this.repo || !this.resolved || !this.collection || this.aiRunning) return;
    if (!this.collection.files.length) return;
    const seq = this.runSeq;
    this.aiRunning = true;
    this.error = null;
    this.statusText = "Running AI semantic analysis (read-only)…";
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const eng = await resolveEngine(this.repo.on);
        const cKey = cacheKeyFor(this.repo, this.resolved, eng);
        if (!force && cKey) {
          const cached = await readCache(cKey);
          if (cached && seq === this.runSeq) {
            this.model = cached;
            this.fromCache = true;
            await this.relayout(cx, true);
            this.aiRunning = false;
            cx.notify();
            return;
          }
        }
        const aiModel = await analyzeWithAI(this.repo, this.resolved, this.collection);
        if (seq !== this.runSeq) return;
        this.model = aiModel;
        this.fromCache = false;
        if (cKey) {
          await writeCache(cKey, aiModel);
          this.cacheInfo = await cacheStats();
        }
        await this.relayout(cx, true);
      } catch (e) {
        if (seq !== this.runSeq) return;
        this.error = String(e?.message || e);
        notify({ title: "AI analysis failed", body: this.error, level: "error" });
      } finally {
        if (seq === this.runSeq) {
          this.aiRunning = false;
          cx.notify();
        }
      }
    });
  }

  async relayout(cx, autoFit = false) {
    if (!this.model) return;
    if (this.mode === "list") {
      this.statusText = this.summaryStatus();
      cx.notify();
      return;
    }
    this.layout = await computeLayout(this.model, {
      mode: this.mode,
      focusKey: this.focusKey,
      hiddenRelations: this.hiddenRelations,
      hideAllEdges: this.hideAllEdges,
      collapsedContainers: this.collapsedContainers,
    });
    if (autoFit) this.fitToView();
    this.statusText = this.summaryStatus();
    cx.notify();
  }

  summaryStatus() {
    if (!this.model) return "";
    const uCount = this.model.units.length;
    const rCount = this.model.relations.length;
    const tCount = this.model.tables.length;
    const src = this.model.source === "ai" ? (this.fromCache ? "AI (cached)" : "AI") : "Static";
    const eng = this.layout?.engine === "fallback" ? " · JS layout" : "";
    return `${src} · ${uCount} units · ${rCount} relations${tCount ? ` · ${tCount} tables` : ""}${eng}`;
  }

  canvasDims() {
    const leftW = this.showCommits ? this.commitsW + 5 : 0;
    const rightW = this.showDetails ? this.detailsW + 5 : 0;
    return {
      vw: Math.max(240, this.viewSize.width - leftW - rightW),
      vh: Math.max(200, this.viewSize.height - 86),
    };
  }

  startResize(side, e, cx) {
    cx.stop_propagation();
    const x = e?.position?.x ?? 0;
    this.resize = { side, startX: x, startW: side === "left" ? this.commitsW : this.detailsW };
  }

  moveResize(e, cx) {
    if (!this.resize) return;
    if (e?.pressed_button !== "left") { this.endResize(); return; }
    const x = e?.position?.x;
    if (x == null) return;
    const z = settings()?.zoom || 1;
    const dx = (x - this.resize.startX) / z;
    if (this.resize.side === "left") {
      this.commitsW = Math.round(Math.max(180, Math.min(540, this.resize.startW + dx)));
    } else {
      this.detailsW = Math.round(Math.max(260, Math.min(820, this.resize.startW - dx)));
    }
    cx.notify();
  }

  endResize() {
    if (!this.resize) return;
    this.resize = null;
    setShared("visual-review.panelWidths", { commits: this.commitsW, details: this.detailsW });
  }

  fitToView() {
    if (!this.layout) return;
    const { vw, vh } = this.canvasDims();
    const pad = 28;
    const scaleX = (vw - pad * 2) / Math.max(1, this.layout.width);
    const scaleY = (vh - pad * 2) / Math.max(1, this.layout.height);
    this.zoom = Math.max(ZOOM_MIN, Math.min(1, Math.min(scaleX, scaleY)));
    this.panX = Math.round((vw - this.layout.width * this.zoom) / 2);
    this.panY = Math.round(Math.max(16, (vh - this.layout.height * this.zoom) / 2));
  }

  setZoom(nextZoom, pivotX = null, pivotY = null) {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nextZoom));
    if (Math.abs(clamped - this.zoom) < 0.001) return;
    const { vw, vh } = this.canvasDims();
    const px = pivotX ?? vw / 2;
    const py = pivotY ?? vh / 2;
    const wx = (px - this.panX) / this.zoom;
    const wy = (py - this.panY) / this.zoom;
    this.zoom = clamped;
    this.panX = px - wx * this.zoom;
    this.panY = py - wy * this.zoom;
  }

  centerOnNode(nodeId) {
    if (!this.layout) return;
    const target = this.layout.nodes.find((n) => n.id === nodeId) || this.layout.containers.find((c) => c.id === nodeId);
    if (!target) return;
    const { vw, vh } = this.canvasDims();
    if (this.zoom < 0.75) this.zoom = 0.9;
    this.panX = Math.round(vw / 2 - (target.x + target.width / 2) * this.zoom);
    this.panY = Math.round(vh / 2 - (target.y + target.height / 2) * this.zoom);
  }

  selectNode(nodeId, item, cx, member = null) {
    this.selectedId = nodeId;
    this.selected = { kind: item.kind, data: item.data, member };
    this.showDetails = true;
    const filePath = item.kind === "unit" ? item.data.file : item.kind === "table" ? item.data.source : null;
    this.loadDiffFor(filePath, cx);
    cx.notify();
  }

  jumpToNode(nodeKey, cx) {
    if (!this.model) return;
    if (nodeKey.startsWith("t:")) {
      const id = nodeKey.slice(2);
      const tbl = this.model.tables.find((t) => t.id === id);
      if (tbl) {
        this.selectNode(nodeKey, { kind: "table", data: tbl }, cx);
        this.centerOnNode(nodeKey);
      }
      return;
    }
    const id = nodeKey.startsWith("u:") ? nodeKey.slice(2) : nodeKey;
    const unit = this.model.units.find((u) => u.id === id);
    if (!unit) return;
    const cid = `c:${unit.container}`;
    const wasCollapsed = this.collapsedContainers.has(cid);
    if (wasCollapsed) this.collapsedContainers.delete(cid);
    if (this.mode === "overview") this.mode = "diagram";
    this.selectNode(`u:${unit.id}`, { kind: "unit", data: unit }, cx);
    if (wasCollapsed || !this.layout?.nodes.some((n) => n.id === `u:${unit.id}`)) {
      cx.spawn(async (cx) => {
        await this.relayout(cx, false);
        this.centerOnNode(`u:${unit.id}`);
        cx.notify();
      });
    } else {
      this.centerOnNode(`u:${unit.id}`);
      cx.notify();
    }
  }

  jumpBySearch(cx) {
    const q = (this.nodeSearch.value() || "").trim().toLowerCase();
    if (!q || !this.model) return;
    const unit = this.model.units.find((u) => u.name.toLowerCase().includes(q) || u.file.toLowerCase().includes(q) || u.container.toLowerCase().includes(q));
    if (unit) { this.jumpToNode(`u:${unit.id}`, cx); return; }
    const tbl = this.model.tables.find((t) => t.id.toLowerCase().includes(q));
    if (tbl) this.jumpToNode(`t:${tbl.id}`, cx);
  }

  loadDiffFor(filePath, cx) {
    const seq = ++this.diffSeq;
    this.diffText = "";
    if (!filePath || !this.repo || !this.resolved) {
      this.diffLoading = false;
      return;
    }
    this.diffLoading = true;
    cx.spawn(async (cx) => {
      try {
        const entry = this.collection?.files?.find((f) => f.path === filePath);
        const text = await readFileDiff(this.repo, this.resolved, filePath, entry?.oldPath);
        if (seq === this.diffSeq) this.diffText = text || "";
      } catch {
        if (seq === this.diffSeq) this.diffText = "";
      } finally {
        if (seq === this.diffSeq) {
          this.diffLoading = false;
          cx.notify();
        }
      }
    });
  }

  openFileInPane(relPath) {
    if (!this.repo || !relPath) return;
    const full = `${this.repo.root.replace(/\\/g, "/")}/${relPath}`;
    run("pane.split", { direction: "right", mod: "files-md", props: { file: full, fileOn: this.repo.on } });
  }

  async purgeCache(cx) {
    const res = await clearCache();
    this.cacheInfo = await cacheStats();
    this.fromCache = false;
    notify({
      title: "Visual Review cache cleared",
      body: `Removed ${res.removed} cached analysis file${res.removed === 1 ? "" : "s"}.`,
      level: "info",
    });
    cx.notify();
  }

  openDialogCopy(fullscreen) {
    const { width, height } = dialogBounds(fullscreen);
    openOverlay({
      mod: "visual-review",
      kind: "dialog",
      width,
      height,
      props: {
        cwd: this.repo?.root,
        on: this.repo?.on,
        selection: this.selection,
        mode: this.mode,
        showCommits: this.showCommits,
        showDetails: this.showDetails,
        fullscreen,
      },
    });
  }

  toggleDialogFullscreen() {
    const next = !Boolean(props()?.fullscreen ?? shared("visual-review.dialogFullscreen"));
    setShared("visual-review.dialogFullscreen", next);
    const ov = props()?.overlay;
    if (ov) closeOverlay(ov);
    this.openDialogCopy(next);
  }

  addCurrentNoteToQueue(cx) {
    const text = (this.noteInput.value() || "").trim();
    if (!text) return;
    const desc = describeSelected(this.selected, this.model);
    this.queue.push({
      id: `n-${++this.queueSeq}`,
      ...desc,
      kind: this.noteKind,
      text,
      createdAt: Date.now(),
    });
    this.noteInput.set_value("");
    notify({ title: "Added to agent queue", body: `${desc.label} (${this.queue.length} queued)`, level: "info", timeout: 2200 });
    cx.notify();
  }

  openQueueModal(cx) {
    this.showQueue = true;
    const on = this.repo?.on ?? null;
    this.installedAgents = cachedKnownAgents(on);
    if (!this.installedAgents.length) {
      cx.spawn(async (cx) => {
        try {
          this.installedAgents = await refreshKnownAgents(on);
          cx.notify();
        } catch {}
      });
    }
    cx.notify();
  }

  sendSingleNoteNow(cx) {
    const text = (this.noteInput.value() || "").trim();
    if (!text) return;
    const live = spaceAgents();
    if (live.length === 1) {
      const desc = describeSelected(this.selected, this.model);
      const note = { id: "single", ...desc, kind: this.noteKind, text };
      const payload = formatQueuePrompt([note], this.repo, this.resolved);
      this.noteInput.set_value("");
      cx.spawn(async (cx) => {
        try {
          await sendToAgent(live[0].address, payload);
          notify({
            title: `Sent to ${live[0].app} (${live[0].tabName})`,
            body: desc.label,
            level: "success",
            action: { name: "agent.focus", args: { terminal: live[0].address } },
          });
        } catch (e) {
          notify({ title: "Failed to send to agent", body: String(e?.message || e), level: "error" });
        }
        cx.notify();
      });
      return;
    }
    // 0 or 2+ agents: add to queue and open the queue modal so user picks the target session
    this.addCurrentNoteToQueue(cx);
    this.openQueueModal(cx);
  }

  sendQueueBatch(activeAgent, newAgentDef, isNew, cx) {
    if (!this.queue.length || this.sendingQueue) return;
    const notes = [...this.queue];
    const payload = formatQueuePrompt(notes, this.repo, this.resolved);
    this.sendingQueue = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        if (isNew) {
          const title = notes.length === 1 ? notes[0].label : `Review (${notes.length} items)`;
          startAgentWithPrompt(this.repo, newAgentDef, title, payload);
          this.queue = [];
          this.showQueue = false;
          notify({ title: `Started ${newAgentDef?.name || "agent"}`, body: `Sent ${notes.length} observation${notes.length === 1 ? "" : "s"}.`, level: "success" });
        } else if (activeAgent) {
          await sendToAgent(activeAgent.address, payload);
          this.queue = [];
          this.showQueue = false;
          notify({
            title: `Sent ${notes.length} item${notes.length === 1 ? "" : "s"} to ${activeAgent.app}`,
            body: `${activeAgent.tabName} · click to focus`,
            level: "success",
            action: { name: "agent.focus", args: { terminal: activeAgent.address } },
          });
        }
      } catch (e) {
        notify({ title: "Failed to send queue", body: String(e?.message || e), level: "error" });
      } finally {
        this.sendingQueue = false;
        cx.notify();
      }
    });
  }

  toggleEdgeKind(kind, cx) {
    if (this.hideAllEdges) this.hideAllEdges = false;
    if (this.hiddenRelations.has(kind)) this.hiddenRelations.delete(kind);
    else this.hiddenRelations.add(kind);
    cx.spawn(async (cx) => { await this.relayout(cx, false); });
  }

  handleKeyDown(e, cx) {
    const key = String(e?.key || "").toLowerCase();
    if (key === "escape") {
      if (this.splitDiff) { this.splitDiff = null; cx.notify(); return; }
      if (this.showQueue) { this.showQueue = false; cx.notify(); return; }
      if (this.showNodeSearch) { this.showNodeSearch = false; cx.notify(); return; }
      if (this.showSettings) { this.showSettings = false; cx.notify(); return; }
      if (this.showLegend) { this.showLegend = false; cx.notify(); return; }
      if (this.focusKey) {
        this.focusKey = null;
        cx.spawn(async (cx) => { await this.relayout(cx, true); });
        return;
      }
      if (this.selected) { this.selected = null; this.selectedId = null; cx.notify(); return; }
      const ov = props()?.overlay;
      if (ov) closeOverlay(ov);
      return;
    }
    if (key === "/") {
      this.showNodeSearch = !this.showNodeSearch;
      cx.notify();
      return;
    }
    if (key === "+" || key === "=") { this.setZoom(this.zoom * 1.15); cx.notify(); return; }
    if (key === "-") { this.setZoom(this.zoom / 1.15); cx.notify(); return; }
    if (key === "0") { this.fitToView(); cx.notify(); return; }
    if (key === "arrowleft") { this.panX += 60; cx.notify(); return; }
    if (key === "arrowright") { this.panX -= 60; cx.notify(); return; }
    if (key === "arrowup") { this.panY += 60; cx.notify(); return; }
    if (key === "arrowdown") { this.panY -= 60; cx.notify(); return; }
  }

  render(cx) {
    if (kitOff()) return offView();
    const t = theme();
    const isOverlay = Boolean(props()?.overlay);
    const aiCfg = aiSettings();

    // Counts for header
    const counts = { added: 0, modified: 0, deleted: 0 };
    for (const u of this.model?.units || []) {
      if (u.state === "added") counts.added++;
      else if (u.state === "modified") counts.modified++;
      else if (u.state === "deleted") counts.deleted++;
    }

    const toolBtn = (id, label, iconName, active, onClick) =>
      h_flex()
        .id(id)
        .h(24)
        .px(7)
        .gap(5)
        .rounded(4)
        .items_center()
        .bg(active ? t.selected : t.surface)
        .border(1)
        .border_color(active ? t.accent : t.border)
        .text_size(11)
        .text_color(active ? t.foreground : t.muted)
        .hover((s) => s.bg(active ? t.selected : t.hover))
        .on_click(onClick)
        .when(iconName, (el) => el.child(svg(`${ICONS}/${iconName}.svg`).size(12).text_color(active ? t.accent : t.muted)))
        .when(label, (el) => el.child(label));

    // Top bar
    const repoName = this.repo?.root ? this.repo.root.replace(/\\/g, "/").split("/").filter(Boolean).pop() : null;
    const topBar = h_flex()
      .w_full()
      .h(40)
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(toolBtn("vr-toggle-commits", null, "panel", this.showCommits, (_e, cx) => { this.showCommits = !this.showCommits; cx.notify(); }))
      .child(svg(`${ICONS}/graph.svg`).size(15).text_color(t.accent))
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Visual Review"))
      .when(repoName, (el) =>
        el.child(
          h_flex()
            .px(8)
            .h(22)
            .gap(5)
            .rounded(4)
            .items_center()
            .bg(`${t.accent}22`)
            .border(1)
            .border_color(t.accent)
            .child(svg(`${ICONS}/folder.svg`).size(11).text_color(t.accent))
            .child(div().text_size(11).font_semibold().text_color(t.foreground).truncate().max_w(180).child(this.repo.on ? `${this.repo.on}:${repoName}` : repoName)),
        ))
      .when(this.resolved, (el) =>
        el.child(div().px(6).py(2).rounded(4).bg(t.surface).border(1).border_color(t.border).text_size(11).text_color(t.muted).truncate().max_w(200).child(this.resolved.label)))
      .child(
        h_flex().gap(6).items_center().text_size(12).font_bold()
          .child(div().text_color(counts.added ? t.ansi2 : t.dim).child(`+${counts.added}`))
          .child(div().text_color(counts.modified ? t.ansi4 : t.dim).child(`~${counts.modified}`))
          .child(div().text_color(counts.deleted ? t.ansi1 : t.dim).child(`−${counts.deleted}`)),
      )
      .child(div().flex_1())
      // View switcher
      .child(
        h_flex().rounded(4).border(1).border_color(t.border).overflow_hidden().children(
          [
            { id: "overview", label: "Overview" },
            { id: "diagram", label: "Diagram" },
            { id: "list", label: "List" },
          ].map((m) =>
            div()
              .id(`vr-mode-${m.id}`)
              .h(24)
              .px(9)
              .flex()
              .items_center()
              .text_size(11)
              .bg(this.mode === m.id ? t.accent : t.surface)
              .text_color(this.mode === m.id ? t.accent_foreground : t.muted)
              .hover((s) => s.bg(this.mode === m.id ? t.accent : t.hover))
              .on_click((_e, cx) => {
                if (this.mode === m.id) return;
                this.mode = m.id;
                cx.spawn(async (cx) => { await this.relayout(cx, true); });
              })
              .child(m.label),
          ),
        ),
      )
      // Agent Queue button
      .child(
        h_flex()
          .id("vr-queue-btn")
          .h(24)
          .px(8)
          .gap(5)
          .rounded(4)
          .items_center()
          .bg(this.queue.length ? `${t.accent}22` : t.surface)
          .border(1)
          .border_color(this.queue.length ? t.accent : t.border)
          .text_size(11)
          .font_semibold()
          .text_color(this.queue.length ? t.foreground : t.muted)
          .hover((s) => s.border_color(t.accent))
          .on_click((_e, cx) => this.openQueueModal(cx))
          .child(`Queue${this.queue.length ? ` (${this.queue.length})` : ""}`),
      )
      // Enrich with AI / Re-analyze
      .child(
        h_flex()
          .id("vr-enrich-ai")
          .h(24)
          .px(9)
          .gap(5)
          .rounded(4)
          .items_center()
          .bg(t.accent)
          .text_color(t.accent_foreground)
          .text_size(11)
          .font_semibold()
          .hover((s) => s.opacity(0.9))
          .on_click((_e, cx) => this.runAIEnrich(cx, this.model?.source === "ai"))
          .child(svg(`${ICONS}/sparkles.svg`).size(12).text_color(t.accent_foreground))
          .child(this.aiRunning ? "Analyzing…" : this.model?.source === "ai" ? "Re-analyze AI" : "Enrich with AI"),
      )
      .when(!isOverlay, (el) =>
        el.child(toolBtn("vr-pop-modal", null, "expand", false, () => {
          this.openDialogCopy(Boolean(shared("visual-review.dialogFullscreen")));
        })))
      .when(isOverlay, (el) => {
        const isFull = Boolean(props()?.fullscreen ?? shared("visual-review.dialogFullscreen"));
        return el.child(toolBtn("vr-toggle-full", isFull ? "Normal" : "Full", "expand", isFull, () => this.toggleDialogFullscreen()));
      })
      .child(toolBtn("vr-settings-btn", null, "settings", this.showSettings, (_e, cx) => {
        this.showSettings = !this.showSettings;
        if (this.showSettings) cx.spawn(async (cx) => { this.cacheInfo = await cacheStats(); cx.notify(); });
        cx.notify();
      }))
      .child(toolBtn("vr-toggle-details", null, "panel", this.showDetails, (_e, cx) => { this.showDetails = !this.showDetails; cx.notify(); }))
      .when(isOverlay, (el) =>
        el.child(toolBtn("vr-close-modal", null, "x", false, () => closeOverlay(props().overlay))));

    // Secondary controls bar: edge filters + status + zoom
    const controlBar = h_flex()
      .w_full()
      .h(34)
      .px(10)
      .gap(6)
      .items_center()
      .bg(t.surface)
      .border_b(1)
      .border_color(t.border)
      // Edge master toggle
      .child(toolBtn(
        "vr-edges-all",
        this.hideAllEdges ? "Edges off" : "Edges",
        this.hideAllEdges ? "eye-off" : "eye",
        !this.hideAllEdges,
        (_e, cx) => {
          this.hideAllEdges = !this.hideAllEdges;
          cx.spawn(async (cx) => { await this.relayout(cx, false); });
        },
      ))
      // Per-kind edge toggles
      .children(
        EDGE_KINDS.map((k) => {
          const on = !this.hideAllEdges && !this.hiddenRelations.has(k.id);
          return div()
            .id(`vr-edge-${k.id}`)
            .h(22)
            .px(6)
            .rounded(3)
            .border(1)
            .border_color(on ? t.border : t.surface)
            .bg(on ? t.background : t.surface)
            .flex()
            .items_center()
            .text_size(10)
            .text_color(on ? t.foreground : t.dim)
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.toggleEdgeKind(k.id, cx))
            .child(k.label);
        }),
      )
      .when(this.focusKey, (el) =>
        el.child(
          h_flex().id("vr-clear-focus").h(22).px(7).gap(5).rounded(3).bg(t.accent).text_color(t.accent_foreground).items_center().text_size(10).font_semibold()
            .on_click((_e, cx) => {
              this.focusKey = null;
              cx.spawn(async (cx) => { await this.relayout(cx, true); });
            })
            .child(`Focus: ${this.focusKey.replace(/^[ut]:/, "").split(/[.#/]/).pop()} ×`),
        ))
      .child(div().flex_1().min_w(0).truncate().px(6).text_size(11).text_color(this.error ? t.ansi1 : t.muted).child(this.error || this.statusText))
      // Quick search
      .child(toolBtn("vr-search-toggle", null, "search", this.showNodeSearch, (_e, cx) => { this.showNodeSearch = !this.showNodeSearch; cx.notify(); }))
      .when(this.showNodeSearch, (el) =>
        el.child(
          div().w(180).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(Input.new(this.nodeSearch).text_size(11).text_color(t.foreground).bg(t.background).px(6).py(2).rounded(4).border(1).border_color(t.accent)),
        ))
      // Zoom controls (Overview & Diagram)
      .when(this.mode !== "list", (el) =>
        el.child(
          h_flex().gap(2).items_center()
            .child(toolBtn("vr-z-out", null, "minus", false, (_e, cx) => { this.setZoom(this.zoom / 1.18); cx.notify(); }))
            .child(div().w(42).flex().justify_center().text_size(11).text_color(t.muted).child(`${Math.round(this.zoom * 100)}%`))
            .child(toolBtn("vr-z-in", null, "plus", false, (_e, cx) => { this.setZoom(this.zoom * 1.18); cx.notify(); }))
            .child(toolBtn("vr-z-fit", "Fit", null, false, (_e, cx) => { this.fitToView(); cx.notify(); })),
        ))
      .child(toolBtn("vr-legend-btn", "?", null, this.showLegend, (_e, cx) => { this.showLegend = !this.showLegend; cx.notify(); }));

    // Inline Settings / Cache bar when toggled
    const settingsBar = this.showSettings
      ? h_flex()
        .w_full()
        .px(12)
        .py(8)
        .gap(12)
        .items_center()
        .bg(t.surface)
        .border_b(1)
        .border_color(t.accent)
        .text_size(11)
        .child(div().font_semibold().text_color(t.foreground).child("Settings"))
        .child(div().text_color(t.muted).child(`AI: ${aiCfg.provider}${aiCfg.model ? ` (${aiCfg.model})` : ""}`))
        .child(div().text_color(t.muted).child(`Overview threshold: >${largeDiffThreshold()} files`))
        .child(div().text_color(t.muted).child(`Disk cache: ${this.cacheInfo.count} entr${this.cacheInfo.count === 1 ? "y" : "ies"} (${formatBytes(this.cacheInfo.bytes)})`))
        .child(div().flex_1())
        .child(
          h_flex()
            .id("vr-purge-cache")
            .h(24)
            .px(8)
            .gap(5)
            .rounded(4)
            .bg(t.background)
            .border(1)
            .border_color(t.ansi1)
            .items_center()
            .text_size(11)
            .text_color(t.ansi1)
            .hover((s) => s.bg(`${t.ansi1}22`))
            .on_click((_e, cx) => { cx.spawn(async (cx) => { await this.purgeCache(cx); }); })
            .child(svg(`${ICONS}/trash.svg`).size(12).text_color(t.ansi1))
            .child("Clear cache"),
        )
        .child(
          div().id("vr-open-hub-settings").h(24).px(8).rounded(4).bg(t.background).border(1).border_color(t.border)
            .flex().items_center().text_size(11).text_color(t.foreground).hover((s) => s.border_color(t.accent))
            .on_click(() => {
              setShared("mods-hub", { ...(shared("mods-hub") ?? {}), tab: "settings", section: "visual-review" });
              run("mod.open", { name: "mods-hub" });
            })
            .child("All settings…"),
        )
      : null;

    // Legend bar when toggled
    const legendBar = this.showLegend
      ? h_flex()
        .id("vr-legend-bar")
        .w_full()
        .px(12)
        .py(7)
        .gap(16)
        .flex_wrap()
        .items_center()
        .bg(t.surface)
        .border_b(1)
        .border_color(t.border)
        .text_size(11)
        .child(
          h_flex().gap(8).items_center()
            .child(div().font_semibold().text_color(t.foreground).child("States:"))
            .child(h_flex().gap(4).items_center().child(badgeEl("added", t, 9)).child(div().text_color(t.muted).child("Added")))
            .child(h_flex().gap(4).items_center().child(badgeEl("modified", t, 9)).child(div().text_color(t.muted).child("Modified")))
            .child(h_flex().gap(4).items_center().child(badgeEl("deleted", t, 9)).child(div().text_color(t.muted).child("Deleted")))
            .child(h_flex().gap(4).items_center().child(badgeEl("context", t, 9)).child(div().text_color(t.muted).child("Context"))),
        )
        .child(
          h_flex().gap(10).items_center()
            .child(div().font_semibold().text_color(t.foreground).child("Edges:"))
            .child(div().text_color(t.muted).child("───▷ Inheritance"))
            .child(div().text_color(t.muted).child("- - ▷ Implementation"))
            .child(div().text_color(t.muted).child("◆─── Composition"))
            .child(div().text_color(t.muted).child("- - > Dependency"))
            .child(div().text_color(t.muted).child("···> Table link")),
        )
        .child(
          h_flex().gap(8).items_center()
            .child(div().font_semibold().text_color(t.foreground).child("Keys:"))
            .child(div().text_color(t.dim).child("Drag pan · Ctrl+wheel zoom · 0 fit · / find · Esc clear")),
        )
      : null;

    // Large diff info banner
    const largeBanner = this.largeDiffBanner && this.mode === "overview"
      ? h_flex().w_full().px(12).py(5).gap(8).items_center().bg(t.surface).border_b(1).border_color(t.border).text_size(11)
        .child(div().text_color(t.accent).font_semibold().child("Large change set:"))
        .child(div().flex_1().text_color(t.muted).child(`${this.model?.totalChangedFiles || 0} changed files — opened in Overview. Click any container to drill into it.`))
        .child(div().id("vr-dismiss-large").text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.largeDiffBanner = false; cx.notify(); }).child("Dismiss"))
      : null;

    const queueCounts = new Map();
    for (const q of this.queue) {
      queueCounts.set(q.targetKey, (queueCounts.get(q.targetKey) ?? 0) + 1);
    }

    // Center content
    const center = this.mode === "list"
      ? renderListView({
        model: this.model || { units: [], tables: [], relations: [] },
        state: { focusKey: this.focusKey, hiddenRelations: this.hiddenRelations, hideAllEdges: this.hideAllEdges },
        selectedId: this.selectedId,
        t,
        onSelectNode: (id, item, cx) => this.selectNode(id, item, cx),
        onJumpToUnit: (targetKey, cx) => this.jumpToNode(targetKey, cx),
      })
      : renderCanvas({
        layout: this.layout,
        zoom: this.zoom,
        panX: this.panX,
        panY: this.panY,
        viewSize: (() => {
          const { vw, vh } = this.canvasDims();
          return { width: vw, height: vh };
        })(),
        selectedId: this.selectedId,
        focusKey: this.focusKey,
        queueCounts,
        mode: this.mode,
        t,
        onSelectNode: (id, item, cx) => this.selectNode(id, item, cx),
        onSelectMember: (id, item, member, cx) => this.selectNode(id, item, cx, member),
        onSelectEdge: (edge, cx) => {
          this.selectedId = `e:${edge.id}`;
          this.selected = { kind: "edge", data: edge };
          this.showDetails = true;
          cx.notify();
        },
        onToggleContainer: (cid, cx) => {
          if (this.collapsedContainers.has(cid)) this.collapsedContainers.delete(cid);
          else this.collapsedContainers.add(cid);
          cx.spawn(async (cx) => { await this.relayout(cx, false); });
        },
        onOpenContainer: (cid, cx) => {
          // Clicking an Overview box opens Diagram with all other containers collapsed
          const allIds = new Set((this.model?.units || []).map((u) => `c:${u.container}`));
          if (this.model?.tables?.length) allIds.add("c:__tables__");
          allIds.delete(cid);
          this.collapsedContainers = allIds;
          this.lastContainer = cid;
          this.fromOverview = true;
          this.mode = "diagram";
          cx.spawn(async (cx) => { await this.relayout(cx, true); });
        },
        onFocus: (key, cx) => {
          this.focusKey = this.focusKey === key ? null : key;
          cx.spawn(async (cx) => { await this.relayout(cx, true); });
        },
        onPanStart: (e, _cx) => {
          this.handle.focus();
          const pos = e?.position || { x: 0, y: 0 };
          this.drag = { x: pos.x, y: pos.y, panX: this.panX, panY: this.panY };
          this.dragMoved = false;
        },
        onPanMove: (e, cx) => {
          if (!this.drag) return;
          if (e?.pressed_button !== "left") { this.drag = null; return; }
          const pos = e?.position;
          if (!pos) return;
          const dx = pos.x - this.drag.x;
          const dy = pos.y - this.drag.y;
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.dragMoved = true;
          this.panX = this.drag.panX + dx;
          this.panY = this.drag.panY + dy;
          cx.notify();
        },
        onPanEnd: () => { this.drag = null; },
        onWheel: (e, cx) => {
          const dx = e?.delta?.x ?? 0;
          const dy = e?.delta?.y ?? 0;
          if (e?.modifiers?.control || e?.modifiers?.platform) {
            const factor = dy < 0 ? 1.12 : 1 / 1.12;
            this.setZoom(this.zoom * factor);
          } else if (e?.modifiers?.shift) {
            this.panX += (dy || dx);
          } else {
            this.panX += dx;
            this.panY += dy;
          }
          cx.notify();
        },
        onPinch: (e, cx) => {
          const d = e?.delta ?? 0;
          if (d) {
            this.setZoom(this.zoom * (1 + d));
            cx.notify();
          }
        },
        onBackgroundClick: (_e, cx) => {
          if (this.dragMoved) { this.dragMoved = false; return; }
          this.selectedId = null;
          this.selected = null;
          cx.notify();
        },
      });

    const resizeHandle = (id, side) => {
      const active = this.resize?.side === side;
      return div()
        .id(id)
        .w(5)
        .flex_none()
        .h_full()
        .cursor_col_resize()
        .bg(active ? t.accent : t.border)
        .hover((s) => s.bg(t.accent))
        .on_mouse_down("left", (e, cx) => this.startResize(side, e, cx));
    };

    // Main 3-column body
    const body = h_flex()
      .flex_1()
      .min_h(0)
      .w_full()
      .overflow_hidden()
      .when(this.showCommits, (el) =>
        el.child(renderCommitsSidebar({
          repo: this.repo,
          commits: this.commits,
          uncommittedCount: this.uncommittedCount,
          selection: this.selection,
          rangeAnchor: this.rangeAnchor,
          searchInput: this.commitSearch,
          loading: this.commitsLoading,
          width: this.commitsW,
          t,
          onSelectPreset: (mode, cx) => {
            this.rangeAnchor = null;
            this.selection = { mode };
            cx.spawn(async (cx) => { await this.analyzeSelection(cx); });
          },
          onClickCommit: (commit, isShift, cx) => {
            if (isShift && this.rangeAnchor && this.rangeAnchor !== commit.hash) {
              const iA = this.commits.findIndex((c) => c.hash === this.rangeAnchor);
              const iB = this.commits.findIndex((c) => c.hash === commit.hash);
              if (iA >= 0 && iB >= 0) {
                const newest = this.commits[Math.min(iA, iB)];
                const oldest = this.commits[Math.max(iA, iB)];
                const count = Math.abs(iA - iB) + 1;
                this.selection = {
                  mode: "range",
                  from: oldest.hash,
                  to: newest.hash,
                  label: `${oldest.short}..${newest.short} (${count})`,
                };
                cx.spawn(async (cx) => { await this.analyzeSelection(cx); });
                return;
              }
            }
            this.rangeAnchor = commit.hash;
            this.selection = { mode: "single", head: commit.hash, label: `${commit.short} · ${commit.subject.slice(0, 28)}` };
            cx.spawn(async (cx) => { await this.analyzeSelection(cx); });
          },
          onRefresh: (cx) => this.loadCommits(cx),
          onCollapse: (cx) => { this.showCommits = false; cx.notify(); },
        })).child(resizeHandle("vr-resize-left", "left")))
      .child(center)
      .when(this.showDetails, (el) =>
        el.child(resizeHandle("vr-resize-right", "right")).child(renderDetailsPanel({
          model: this.model,
          selected: this.selected,
          diffText: this.diffText,
          diffLoading: this.diffLoading,
          aiRunning: this.aiRunning,
          width: this.detailsW,
          composer: this.selected
            ? renderNoteComposer({
              desc: describeSelected(this.selected, this.model),
              noteInput: this.noteInput,
              noteKind: this.noteKind,
              queueCount: this.queue.length,
              t,
              onChangeKind: (k, cx) => { this.noteKind = k; cx.notify(); },
              onAddToQueue: (cx) => this.addCurrentNoteToQueue(cx),
              onSendNow: (cx) => this.sendSingleNoteNow(cx),
              onOpenQueue: (cx) => this.openQueueModal(cx),
            })
            : null,
          t,
          onClose: (cx) => { this.showDetails = false; cx.notify(); },
          onJumpToNode: (key, cx) => this.jumpToNode(key, cx),
          onFocusNode: (key, cx) => {
            this.focusKey = this.focusKey === key ? null : key;
            cx.spawn(async (cx) => { await this.relayout(cx, true); });
          },
          onEnrichAI: (cx) => this.runAIEnrich(cx, false),
          onOpenFile: (path) => this.openFileInPane(path),
          onOpenSplitDiff: (filePath, range, cx) => {
            this.splitDiff = { filePath, range };
            this.handle.focus();
            cx.notify();
          },
          onSelectOtherFile: (f, cx) => {
            this.selectedId = `f:${f.path}`;
            this.selected = { kind: "file", data: f };
            this.loadDiffFor(f.path, cx);
            cx.notify();
          },
        })));

    return v_flex()
      .id("vr-root")
      .relative()
      .size_full()
      .bg(t.background)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.handleKeyDown(e, cx))
      .on_mouse_down("back", (_e, cx) => {
        if (this.splitDiff) { this.splitDiff = null; cx.stop_propagation(); cx.notify(); return; }
        if (this.focusKey) {
          this.forwardFocus = this.focusKey;
          this.focusKey = null;
          cx.stop_propagation();
          cx.spawn(async (cx) => { await this.relayout(cx, true); });
          return;
        }
        if (this.mode === "diagram" && this.fromOverview) {
          this.mode = "overview";
          this.fromOverview = false;
          cx.stop_propagation();
          cx.spawn(async (cx) => { await this.relayout(cx, true); });
          return;
        }
        if (this.selected) { this.selected = null; this.selectedId = null; cx.stop_propagation(); cx.notify(); }
      })
      .on_mouse_down("forward", (_e, cx) => {
        if (this.mode === "overview" && this.lastContainer) {
          const allIds = new Set((this.model?.units || []).map((u) => `c:${u.container}`));
          if (this.model?.tables?.length) allIds.add("c:__tables__");
          allIds.delete(this.lastContainer);
          this.collapsedContainers = allIds;
          this.mode = "diagram";
          this.fromOverview = true;
          cx.stop_propagation();
          cx.spawn(async (cx) => { await this.relayout(cx, true); });
          return;
        }
        if (!this.focusKey && this.forwardFocus) {
          this.focusKey = this.forwardFocus;
          this.forwardFocus = null;
          cx.stop_propagation();
          cx.spawn(async (cx) => { await this.relayout(cx, true); });
        }
      })
      .on_window_mouse_move((e, cx) => this.moveResize(e, cx))
      .on_window_mouse_up("left", () => this.endResize())
      .on_size_change((size, cx) => {
        const z = settings()?.zoom || 1;
        this.viewSize = { width: size.width / z, height: size.height / z };
        cx.notify();
      })
      .child(topBar)
      .child(controlBar)
      .when(settingsBar, (el) => el.child(settingsBar))
      .when(legendBar, (el) => el.child(legendBar))
      .when(largeBanner, (el) => el.child(largeBanner))
      .child(body)
      .when(this.splitDiff, (el) =>
        el.child(renderSplitDiffOverlay({
          filePath: this.splitDiff.filePath,
          range: this.splitDiff.range,
          diffText: this.diffText,
          diffLoading: this.diffLoading,
          t,
          onClose: (cx) => { this.splitDiff = null; cx.notify(); },
          onOpenFile: (path) => this.openFileInPane(path),
        })))
      .when(this.showQueue, (el) =>
        el.child(renderQueueOverlay({
          notes: this.queue,
          liveAgents: spaceAgents(),
          installedAgents: this.installedAgents,
          selectedAgentAddr: this.selectedAgentAddr,
          selectedNewAgent: this.selectedNewAgent,
          useNewAgent: this.useNewAgent,
          sending: this.sendingQueue,
          t,
          onSelectAgent: (addr, cx) => { this.selectedAgentAddr = addr; this.useNewAgent = false; cx.notify(); },
          onSelectNewAgent: (name, cx) => { this.selectedNewAgent = name; cx.notify(); },
          onToggleUseNew: (cx) => { this.useNewAgent = !this.useNewAgent; cx.notify(); },
          onRemoveNote: (id, cx) => { this.queue = this.queue.filter((n) => n.id !== id); cx.notify(); },
          onClearQueue: (cx) => { this.queue = []; cx.notify(); },
          onJumpToNote: (note, cx) => {
            this.showQueue = false;
            if (note.targetKey && (note.targetKey.startsWith("u:") || note.targetKey.startsWith("t:"))) {
              this.jumpToNode(note.targetKey, cx);
            }
            cx.notify();
          },
          onSendAll: (activeAgent, newAgentDef, isNew, cx) => this.sendQueueBatch(activeAgent, newAgentDef, isNew, cx),
          onCopyAll: (cx) => {
            const payload = formatQueuePrompt(this.queue, this.repo, this.resolved);
            cx.write_to_clipboard(payload);
            notify({ title: "Copied queue prompt", body: `${this.queue.length} observation${this.queue.length === 1 ? "" : "s"} copied.`, level: "success", timeout: 2200 });
          },
          onClose: (cx) => { this.showQueue = false; cx.notify(); },
        })));
  }
}
