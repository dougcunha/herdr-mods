// CI Dash for the Herdr app: GitHub Actions runs and artifacts of the focused
// repository. Port of the ci-dash TUI plugin; this first slice covers the
// Runs tab (list, live detail, cancel, rerun) and the Artifacts tab.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, home, theme, notify, props } from "herdr";
import { Gh, resolveRepo, errorHint, safeName } from "./gh.js";
import { relTime, duration, bytes, stateOf, GLYPH } from "./format.js";

const MOD = "ci-dash"; // folder name under ~/.config/herdr-app/mods
const POLL_MS = 5000;

const isWin = () => /^[A-Za-z]:[\\/]/.test(home());
const sep = (root) => (root.includes("\\") ? "\\" : "/");
const join = (root, ...parts) => [root.replace(/[\\/]+$/, ""), ...parts].join(sep(root));

let lastCwd = null;

// A mod pane has no folder of its own, so look at the terminals around it:
// the focused pane, then its tab, then the rest of its space. The last folder
// found stays as a fallback so clicking this panel never loses the repository.
function location() {
  const f = focused();
  const space = spaces().find((s) => s.id === f?.space) || spaces().find((s) => s.active);
  const all = panes();
  const pane = f?.pane ? all.find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const inTab = all.find((p) => p.tab === f?.tab && p.cwd)?.cwd;
  const spaceTabs = new Set((space?.tabs ?? []).map((tab) => tab.id));
  const inSpace = all.find((p) => spaceTabs.has(p.tab) && p.cwd)?.cwd;
  const cwd = pane?.cwd || f?.cwd || inTab || inSpace || lastCwd || space?.folder;
  if (pane?.cwd || f?.cwd || inTab || inSpace) lastCwd = cwd;
  return { cwd, on };
}

async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await mapper(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function dirExists(dir, on) {
  try {
    const r = isWin()
      ? await exec("pwsh", ["-NoProfile", "-Command", `Test-Path -LiteralPath '${dir.replace(/'/g, "''")}' -PathType Container`], { on })
      : await exec("test", ["-d", dir], { on });
    return isWin() ? r.stdout.trim() === "True" : r.code === 0;
  } catch { return false; }
}

async function openFolder(dir) {
  const [cmd, args] = isWin() ? ["explorer.exe", [dir]] : home().startsWith("/Users/") ? ["open", [dir]] : ["xdg-open", [dir]];
  await exec(cmd, args);
}

export default class CiDash extends View {
  init(_props, cx) {
    this.tab = "runs";
    this.key = null;
    this.resolving = false;
    this.repo = null; this.gh = null; this.root = null; this.error = null;
    this.reset();
    cx.timer.every(POLL_MS, (cx) => this.tick(cx));
  }

  reset() {
    this.runs = []; this.runsLoading = false; this.runsError = null; this.runsLoaded = false;
    this.detail = null;
    this.art = { groups: [], failed: 0, loaded: false, loading: false, error: null };
    this.dl = {}; this.lastDir = ""; this.note = "";
  }

  // ---- repository --------------------------------------------------------

  ensureContext(cx) {
    const { cwd, on } = location();
    const key = `${on ?? ""}|${cwd ?? ""}`;
    if (key === this.key) return;
    this.key = key;
    this.resolve(cx, cwd, on);
  }

  resolve(cx, cwd, on) {
    if (this.resolving) { this.pending = { cwd, on }; return; }
    this.resolving = true;
    const override = props()?.repo;
    cx.spawn(async (cx) => {
      try {
        if (!cwd && !override) throw new Error("No folder to look for a repository in.");
        const repo = await resolveRepo({ cwd, on, override });
        const changed = !this.repo || this.repo.slug !== repo.slug || this.repo.host !== repo.host;
        if (changed) {
          this.repo = repo; this.gh = new Gh({ repo, cwd, on }); this.reset(); this.error = null;
          const top = cwd ? await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null) : null;
          this.root = top && top.code === 0 ? top.stdout.trim() : cwd;
          this.loadRuns(cx);
        } else {
          this.gh.cwd = cwd; this.gh.on = on;
        }
      } catch (e) {
        // A pane outside a repository keeps showing the repository already loaded.
        if (!this.repo) this.error = e;
      } finally {
        this.resolving = false;
        const next = this.pending; this.pending = null;
        if (next) this.resolve(cx, next.cwd, next.on);
        cx.notify();
      }
    });
  }

  // ---- polling -----------------------------------------------------------

  tick(cx) {
    if (!this.gh) return;
    const d = this.detail;
    if (d) {
      const holding = d.hold && Date.now() < d.hold;
      const live = !stateOf(d.run).done || holding;
      // Back off like the TUI: every 5 s at first, then 10 s, then 30 s.
      const due = d.tick <= 12 || (d.tick <= 60 ? d.tick % 2 === 0 : d.tick % 6 === 0);
      if (live && due) this.pollDetail(cx);
      else cx.notify(); // keeps "3m ago" and running durations fresh
      return;
    }
    if (this.tab === "runs" && this.runs.some((r) => !stateOf(r).done)) this.loadRuns(cx, true);
  }

  // ---- runs --------------------------------------------------------------

  loadRuns(cx, silent = false) {
    const gh = this.gh;
    if (!gh || this.runsLoading) return;
    this.runsLoading = true;
    if (!silent) this.runsError = null;
    cx.spawn(async (cx) => {
      try {
        const runs = await gh.listRuns(30);
        if (this.gh !== gh) return;
        if (this.runsLoaded) {
          const before = new Map(this.runs.map((r) => [r.id, stateOf(r).done]));
          for (const r of runs) if (before.get(r.id) === false && stateOf(r).done) this.announce(r);
        }
        this.runs = runs; this.runsLoaded = true; this.runsError = null;
      } catch (e) {
        if (this.gh === gh && (!silent || !this.runs.length)) this.runsError = e;
      } finally {
        this.runsLoading = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  announce(run) {
    const st = stateOf(run);
    notify({
      title: `CI ${st.label}: ${run.name || "workflow"}`,
      body: `#${run.run_number ?? "?"} · ${run.head_branch || ""} · ${duration(run.run_started_at || run.created_at, run.updated_at)}`,
      level: st.kind === "success" ? "success" : st.kind === "failure" ? "error" : "info",
    });
  }

  openRun(id, cx) {
    this.detail = { id, run: this.runs.find((r) => r.id === id) || null, jobs: [], artifacts: [], artLoaded: false, artError: null, error: null, tick: 0, inFlight: false, live: false, hold: 0, attempt: 0 };
    this.tab = "runs";
    this.note = "";
    this.pollDetail(cx);
    cx.notify();
  }

  pollDetail(cx) {
    const d = this.detail, gh = this.gh;
    if (!d || !gh || d.inFlight) return;
    d.inFlight = true;
    cx.spawn(async (cx) => {
      try {
        const [run, jobs] = await Promise.all([gh.getRun(d.id), gh.listJobs(d.id)]);
        if (this.detail !== d) return;
        // Right after a rerun GitHub can still answer with the old attempt.
        const stale = d.hold && Date.now() < d.hold && run.run_attempt === d.attempt;
        d.run = stale ? { ...run, status: "queued", conclusion: null } : run;
        d.jobs = stale ? [] : jobs;
        d.error = null; d.tick += 1;
        const st = stateOf(d.run);
        if (!st.done) d.live = true;
        if (st.done) {
          if (!d.artLoaded) {
            d.artifacts = await gh.listArtifacts(d.id).catch((e) => { d.artError = e; return []; });
            d.artLoaded = true;
          }
          if (d.live) { d.live = false; this.announce(run); }
        }
      } catch (e) {
        if (this.detail === d) d.error = e;
      } finally {
        d.inFlight = false;
        cx.notify();
      }
    });
  }

  act(label, fn, cx) {
    this.note = `${label}…`;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await fn(); this.note = ""; } catch (e) { this.note = `${label} failed: ${e.message || e}`; }
      cx.notify();
    });
  }

  cancel(cx) {
    const d = this.detail;
    if (d) this.act("Cancel", async () => { await this.gh.cancelRun(d.id); this.pollDetail(cx); }, cx);
  }

  rerun(cx) {
    const d = this.detail;
    if (!d) return;
    this.act("Rerun", async () => {
      await this.gh.rerunRun(d.id);
      Object.assign(d, { artLoaded: false, artifacts: [], tick: 0, live: false, hold: Date.now() + 20000, attempt: d.run?.run_attempt ?? 0 });
      this.pollDetail(cx);
    }, cx);
  }

  openWeb(cx) {
    const d = this.detail;
    if (d) this.act("Open run", () => this.gh.openRunWeb(d.id), cx);
  }

  // ---- artifacts ---------------------------------------------------------

  loadArtifactTab(cx) {
    const gh = this.gh, art = this.art;
    if (!gh || art.loading) return;
    art.loading = true; art.error = null;
    cx.spawn(async (cx) => {
      let failed = 0, firstError = null;
      try {
        const list = await gh.listWorkflows();
        const workflows = list.filter((w) => w.path?.startsWith(".github/workflows/") && w.state !== "deleted");
        const groups = await mapLimit(workflows, 6, async (workflow) => {
          try {
            for (const run of await gh.latestRuns(workflow.id, 5)) {
              const artifacts = await gh.listArtifacts(run.id);
              if (artifacts.length) return { workflow, run, artifacts };
            }
            return null;
          } catch (e) { failed += 1; firstError = firstError || e; return null; }
        });
        const found = groups.filter(Boolean);
        if (!found.length && firstError) throw firstError;
        const newest = (g) => Math.max(0, ...g.artifacts.map((a) => Date.parse(a.created_at || "") || 0));
        if (this.gh !== gh) return;
        art.groups = found.sort((a, b) => newest(b) - newest(a));
        art.failed = failed; art.loaded = true;
      } catch (e) {
        if (this.gh === gh) art.error = e;
      } finally {
        art.loading = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  download(runId, artifact, cx) {
    const key = `${runId}:${artifact.id}`;
    if (!this.gh || !this.root || this.dl[key]?.state === "busy") return;
    if (artifact.expired) { this.note = `Artifact "${artifact.name}" has expired.`; cx.notify(); return; }
    const dir = join(this.root, ".ci-dash", "artifacts", String(runId), safeName(artifact.name));
    const gh = this.gh;
    this.dl[key] = { state: "busy" };
    cx.spawn(async (cx) => {
      try {
        await gh.downloadArtifact(runId, artifact.name, dir);
        this.dl[key] = { state: "done", dir };
        this.lastDir = dir;
      } catch (e) {
        this.dl[key] = { state: "error", msg: String(e.message || e) };
      }
      cx.notify();
    });
    cx.notify();
  }

  openArtifactsFolder(cx) {
    if (!this.root) return;
    const candidates = [this.lastDir, join(this.root, ".ci-dash", "artifacts")].filter(Boolean);
    cx.spawn(async (cx) => {
      for (const dir of candidates) {
        if (await dirExists(dir)) {
          try { await openFolder(dir); this.note = `Opened ${dir}`; } catch (e) { this.note = `Could not open ${dir}: ${e}`; }
          cx.notify();
          return;
        }
      }
      this.note = `No artifacts downloaded yet. They go to ${candidates[candidates.length - 1]}`;
      cx.notify();
    });
  }

  // ---- UI pieces ---------------------------------------------------------

  color(kind, t) {
    return { success: t.ansi2, failure: t.ansi1, warning: t.ansi3, running: t.working, queued: t.blocked, neutral: t.dim }[kind] ?? t.dim;
  }

  icon(state, t) {
    if (state.kind === "running") return svg(`mods/${MOD}/spinner.svg`).size(14).flex_none().text_color(t.working).spin(900);
    return div().w(14).flex_none().text_center().text_size(13).text_color(this.color(state.kind, t)).child(GLYPH[state.kind] ?? "•");
  }

  button(id, label, onClick, t, { primary = false, active = false, disabled = false } = {}) {
    return div().id(id).h(26).px(10).flex_none().flex().items_center().rounded(7).text_size(12)
      .border_1().border_color(active || primary ? t.accent : t.border)
      .text_color(disabled ? t.dim : active || primary ? t.accent : t.muted)
      .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
      .child(label);
  }

  header(t, cx) {
    const onArtifacts = this.tab === "artifacts";
    return h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().flex_none().child("CI Dash"))
      .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.repo ? this.repo.slug : ""))
      .child(div().flex_1())
      .child(this.button("tab-runs", "Runs", (cx) => { this.tab = "runs"; this.detail = null; this.note = ""; cx.notify(); }, t, { active: !onArtifacts }))
      .child(this.button("tab-art", "Artifacts", (cx) => { this.tab = "artifacts"; this.note = ""; if (!this.art.loaded && !this.art.loading) this.loadArtifactTab(cx); else cx.notify(); }, t, { active: onArtifacts }))
      .when(onArtifacts, (e) => e.child(this.button("folder", "↗", (cx) => this.openArtifactsFolder(cx), t, { disabled: !this.root })))
      .child(this.button("refresh", "⟳", (cx) => {
        if (onArtifacts) this.loadArtifactTab(cx);
        else if (this.detail) { this.detail.artLoaded = false; this.pollDetail(cx); }
        else this.loadRuns(cx);
      }, t, { disabled: !this.gh }));
  }

  message(t, title, detail) {
    return v_flex().flex_1().min_h(0).p(16).gap(6).child(div().text_color(t.foreground).child(title)).when(Boolean(detail), (e) => e.child(div().text_size(12).text_color(t.dim).child(detail)));
  }

  errorView(t, error) {
    const text = error?.message || String(error);
    return this.message(t, text, errorHint(error));
  }

  runRow(r, t) {
    const st = stateOf(r), now = Date.now();
    const dur = st.done ? duration(r.run_started_at || r.created_at, r.updated_at) : duration(r.run_started_at || r.created_at, now);
    return h_flex().id(`run-${r.id}`).w_full().flex_none().h(50).px(12).gap(10).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openRun(r.id, cx))
      .child(this.icon(st, t))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().child(r.display_title || r.name || `Run ${r.id}`))
        .child(div().truncate().text_size(11).text_color(t.dim).child([r.name, `#${r.run_number}`, r.head_branch, r.actor?.login, relTime(r.created_at, now)].filter(Boolean).join(" · "))))
      .child(div().flex_none().text_size(11).text_color(t.muted).child(dur));
  }

  runsView(t) {
    if (this.runsError && !this.runs.length) return this.errorView(t, this.runsError);
    if (!this.runsLoaded) return this.message(t, "Loading runs…");
    if (!this.runs.length) return this.message(t, "No workflow runs yet.", "Runs appear here after a workflow executes.");
    return v_flex().id("runs-scroll").flex_1().min_h(0).overflow_y_scrollbar().children(this.runs.map((r) => this.runRow(r, t)));
  }

  stepRow(s, t) {
    const st = stateOf(s);
    return h_flex().h(22).flex_none().pl(30).pr(12).gap(8).items_center().text_size(12).text_color(st.done ? t.muted : t.foreground)
      .child(this.icon(st, t))
      .child(div().flex_1().min_w(0).truncate().child(s.name))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(s.started_at && s.completed_at ? duration(s.started_at, s.completed_at) : ""));
  }

  jobBlock(j, t) {
    const st = stateOf(j), now = Date.now();
    return v_flex().flex_none().pb(4)
      .child(h_flex().h(28).flex_none().px(12).gap(8).items_center().font_semibold()
        .child(this.icon(st, t))
        .child(div().flex_1().min_w(0).truncate().child(j.name))
        .child(div().flex_none().text_size(11).text_color(t.muted).child(j.started_at ? duration(j.started_at, j.completed_at ? Date.parse(j.completed_at) : now) : "")))
      .children((j.steps || []).map((s) => this.stepRow(s, t)));
  }

  artifactRow(runId, a, t) {
    const key = `${runId}:${a.id}`, dl = this.dl[key];
    const state = a.expired ? "expired" : dl?.state === "busy" ? "Downloading…" : dl?.state === "done" ? "✓ Downloaded" : dl?.state === "error" ? "Retry" : "Download";
    const sub = dl?.state === "error" ? dl.msg : dl?.state === "done" ? dl.dir : [bytes(a.size_in_bytes), relTime(a.created_at)].filter(Boolean).join(" · ");
    return h_flex().id(`art-${key}`).w_full().flex_none().h(46).px(12).gap(10).items_center()
      .when(!a.expired, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.download(runId, a, cx)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_color(a.expired ? t.dim : t.foreground).child(a.name))
        .child(div().truncate().text_size(11).text_color(dl?.state === "error" ? t.ansi1 : t.dim).child(sub)))
      .child(div().flex_none().text_size(11).text_color(dl?.state === "done" ? t.ansi2 : a.expired ? t.dim : t.accent).child(state));
  }

  detailView(t) {
    const d = this.detail, run = d.run;
    if (!run) return d.error ? this.errorView(t, d.error) : this.message(t, "Loading run…");
    const st = stateOf(run), now = Date.now();
    const dur = duration(run.run_started_at || run.created_at, st.done ? run.updated_at : now);
    return v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().px(12).py(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(this.button("back", "‹ Runs", (cx) => { this.detail = null; cx.notify(); }, t))
        .child(div().flex_1())
        .child(this.button("web", "Open", (cx) => this.openWeb(cx), t))
        .when(!st.done, (e) => e.child(this.button("cancel", "Cancel", (cx) => this.cancel(cx), t)))
        .when(st.done, (e) => e.child(this.button("rerun", "Rerun", (cx) => this.rerun(cx), t, { primary: true }))))
      .child(v_flex().id("detail-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().flex_none().px(12).py(10).gap(4)
          .child(h_flex().gap(8).items_center().child(this.icon(st, t)).child(div().flex_1().min_w(0).truncate().font_semibold().child(run.display_title || run.name)))
          .child(div().text_size(11).text_color(t.dim).child([`${run.name} #${run.run_number}`, run.head_branch, run.event, run.actor?.login].filter(Boolean).join(" · ")))
          .child(div().text_size(11).text_color(this.color(st.kind, t)).child([st.label, dur].filter(Boolean).join(" · "))))
        .when(d.error, (e) => e.child(div().px(12).pb(6).text_size(11).text_color(t.ansi1).child(`Update failed: ${d.error.message || d.error}`)))
        .children(d.jobs.map((j) => this.jobBlock(j, t)))
        .when(!d.jobs.length && !d.error, (e) => e.child(div().px(12).py(6).text_size(12).text_color(t.dim).child("Waiting for jobs…")))
        .when(st.done && (d.artifacts.length > 0 || d.artError), (e) => e
          .child(div().px(12).pt(10).pb(4).text_size(11).font_semibold().text_color(t.muted).child("ARTIFACTS"))
          .when(Boolean(d.artError), (x) => x.child(div().px(12).text_size(11).text_color(t.ansi1).child(`Could not list artifacts: ${d.artError.message}`)))
          .children(d.artifacts.map((a) => this.artifactRow(run.id, a, t)))));
  }

  artifactsView(t) {
    const art = this.art;
    if (art.error) return this.errorView(t, art.error);
    if (art.loading && !art.loaded) return this.message(t, "Loading artifacts…", "Reading the latest runs of every workflow.");
    if (!art.loaded) return this.message(t, "Loading artifacts…");
    if (!art.groups.length) return this.message(t, "No artifacts found.", "None of the latest runs of any workflow produced artifacts.");
    return v_flex().id("art-scroll").flex_1().min_h(0).overflow_y_scrollbar()
      .when(art.failed > 0, (e) => e.child(div().px(12).py(6).text_size(11).text_color(t.blocked).child(`${art.failed} workflow(s) could not be read.`)))
      .children(art.groups.flatMap((g) => [
        div().flex_none().px(12).pt(10).pb(2).text_size(11).font_semibold().text_color(t.muted).truncate()
          .child(`${g.workflow.name.toUpperCase()} · #${g.run.run_number} · ${g.run.head_branch}`),
        ...g.artifacts.map((a) => this.artifactRow(g.run.id, a, t)),
      ]));
  }

  render(cx) {
    this.ensureContext(cx);
    const t = theme();
    let body;
    if (!this.repo) body = this.error ? this.errorView(t, this.error) : this.message(t, "Looking for a GitHub repository…");
    else if (this.tab === "artifacts") body = this.artifactsView(t);
    else body = this.detail ? this.detailView(t) : this.runsView(t);

    return v_flex().id("ci-dash").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(this.header(t, cx))
      .child(body)
      .when(Boolean(this.note), (e) => e.child(div().flex_none().px(12).py(6).border_t(1).border_color(t.border).text_size(11).text_color(t.blocked).truncate().child(this.note)));
  }
}
