// The clone step of the dialog: the folder, the branch and the shallow
// switch of 1 repository, and the clone itself.
//
// The clone runs in a visible terminal: a new space on the machine starts a
// shell in the parent folder, and the mod sends it 1 line with `hc send`
// (`gh repo clone … && cd …`). The line runs in that shell, so the shell goes
// into the new folder at the end. The person sees the progress and can answer
// a prompt (an SSH passphrase, a host key), and the clone goes on when the
// dialog closes.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import { notify, run, hc, panes, pickFolder, checking, settings as appSettings } from "herdr";
import { fetchBranches } from "./gh.js";
import { machineInfo, knownInfo, expandHome, joinPath, parentOf, normalize, isFullPath, pathExists, makeDir, nativePath, cloneLine, openUrl, repoUrl } from "./sys.js";
import { folderFor, rootOf, setRoot, pending, setPending, addLauncherRepo, launcherRoots } from "./store.js";
import { memory, wait, machineLabel, HEAD_H, FOOT_H } from "./common.js";
import { icon, tint, nameColor, letterTile, pill, hint, iconButton, button, toggle, notice } from "./ui.js";

export const stepMethods = {
  initStep(cx) {
    this.step = null;
    this.focusField = null;
    this.checkVersion = 0;
    this.destInput = InputState.new({ placeholder: "~/code/<name>, or D:/Projects/<name> on Windows" });
    this.destInput.on("change", (_e, cx) => {
      if (this.step) {
        this.step.check = null;
        this.scheduleCheck(cx);
      }
      cx.notify();
    });
    this.destInput.on("submit", (_e, cx) => this.launchClone(cx));
    this.destInput.on("focus", (_e, cx) => { this.focusField = "dest"; cx.notify(); });
    this.destInput.on("blur", (_e, cx) => { if (this.focusField === "dest") this.focusField = null; cx.notify(); });

    this.branchInput = InputState.new({ placeholder: "The default branch" });
    this.branchInput.on("change", (_e, cx) => {
      if (this.step) {
        this.step.branchTyped = true;
        this.step.suggestAt = -1;
      }
      cx.notify();
    });
    this.branchInput.on("submit", (_e, cx) => {
      const list = this.suggestions();
      const at = this.step?.suggestAt ?? -1;
      if (at >= 0 && list[at]) this.pickBranch(list[at], cx);
      else this.launchClone(cx);
    });
    this.branchInput.on("focus", (_e, cx) => { this.focusField = "branch"; cx.notify(); });
    this.branchInput.on("blur", (_e, cx) => { if (this.focusField === "branch") this.focusField = null; cx.notify(); });
  },

  /** Opens the clone step of a repository. */
  enterStep(repo, cx) {
    const machine = this.machine;
    // With no clone folder yet, the first root folder of Repo Launcher is the suggestion.
    const own = folderFor(machine, repo.owner);
    const folder = own || (launcherRoots(machine)[0] ?? "");
    // A folder from an owner rule is not offered as the clone folder of the machine.
    const fromRule = Boolean(own) && own !== rootOf(machine);
    const st = {
      repo, machine, shallow: false, fromRule, saveRoot: !rootOf(machine) && !fromRule, branches: null, branchError: "", branchTyped: false,
      suggestAt: -1, check: null, status: this.repoStatus(repo), info: knownInfo(machine), launching: false,
    };
    this.step = st;
    this.view = "step";
    this.destInput.set_value(folder ? joinPath(folder, repo.name) : "");
    this.branchInput.set_value(repo.branch || "");
    this.destInput.focus();
    cx.timer.after(40, () => { if (this.step === st) this.destInput.focus(); });
    if (memory.demo) {
      st.branches = ["main", "dev", "release/2.0", "feature/login"];
      st.check = { text: this.destInput.value().trim(), status: st.status ? "exists" : "free" };
    } else if (!checking()) {
      cx.spawn(async (cx) => {
        try {
          const info = await machineInfo(machine);
          if (this.step === st) st.info = info;
        } catch {}
        cx.notify();
        if (this.step === st) this.checkDest(cx);
      });
      cx.spawn(async (cx) => {
        try {
          const list = await fetchBranches(machine, repo.full);
          if (this.step === st) st.branches = list;
        } catch (e) {
          if (this.step === st) st.branchError = String(e?.message ?? e);
        }
        cx.notify();
      });
    }
    cx.notify();
  },

  /** A problem with the folder text, or "". */
  destProblem(text) {
    if (!text) return "Type the folder for the clone.";
    if (!isFullPath(text)) return "Use a full path, for example ~/code/<name>.";
    // The folder goes into a line for a live shell: no control characters, and
    // no typographic quotes (PowerShell reads them as quotes too).
    if (/[\u0000-\u001f\u007f‘-‛`]/.test(text)) return "The folder has a character that the clone line cannot carry (a control character, a ‘ ’ quote or `).";
    return "";
  },

  /** A problem with the branch text, or "". A branch name goes into a line for a live shell. */
  branchProblem() {
    const b = this.branchInput.value().trim();
    if (!b || /^[\w][\w./+@-]*$/.test(b)) return "";
    return "Use only letters, digits and . / _ + @ - in the branch name.";
  },

  scheduleCheck(cx) {
    const v = ++this.checkVersion;
    cx.timer.after(350, (cx) => {
      if (v === this.checkVersion && this.view === "step") this.checkDest(cx);
    });
  },

  /** Checks that the folder of the clone does not exist on the machine. */
  checkDest(cx) {
    const st = this.step;
    if (!st) return;
    const text = this.destInput.value().trim();
    const problem = this.destProblem(text);
    if (problem) {
      st.check = { text, status: "bad", message: problem };
      cx.notify();
      return;
    }
    if (memory.demo) return;
    st.check = { text, status: "checking" };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const info = st.info ?? await machineInfo(st.machine);
        const exists = await pathExists(st.machine, info, expandHome(text, info));
        if (this.step === st && this.destInput.value().trim() === text) st.check = { text, status: exists ? "exists" : "free" };
      } catch (e) {
        if (this.step === st) st.check = { text, status: "error", message: String(e?.message ?? e) };
      }
      cx.notify();
    });
  },

  /** The branches that match the branch field, for the list under it. */
  suggestions() {
    const st = this.step;
    if (!st?.branches?.length || this.focusField !== "branch") return [];
    const q = st.branchTyped ? this.branchInput.value().trim().toLowerCase() : "";
    const list = st.branches.filter((b) => !q || b.toLowerCase().includes(q));
    if (list.length === 1 && list[0].toLowerCase() === q) return [];
    list.sort((a, b) => (Number(b.toLowerCase().startsWith(q)) - Number(a.toLowerCase().startsWith(q))) || a.localeCompare(b));
    return list.slice(0, 6);
  },

  pickBranch(name, cx) {
    this.branchInput.set_value(name);
    if (this.step) {
      this.step.branchTyped = true;
      this.step.suggestAt = -1;
    }
    this.branchInput.focus();
    cx.notify();
  },

  /** The branch for `--branch`: empty when it is the default branch. */
  branchArg() {
    const b = this.branchInput.value().trim();
    return b && b !== this.step?.repo.branch ? b : "";
  },

  stepKey(e, cx) {
    const k = e.key;
    // A focused text field keeps Esc from Herdr: go back to the list.
    if (k === "escape") {
      cx.stop_propagation();
      return this.back(cx);
    }
    const m = e.modifiers ?? {};
    if ((m.control || m.platform) && k === "o") {
      cx.stop_propagation();
      return openUrl(repoUrl(this.step.repo.full));
    }
    if (this.focusField === "branch" && (k === "down" || k === "up")) {
      const list = this.suggestions();
      if (!list.length || !this.step) return;
      const at = this.step.suggestAt;
      this.step.suggestAt = k === "down" ? (at + 1) % list.length : at <= 0 ? list.length - 1 : at - 1;
      cx.stop_propagation();
      cx.notify();
    }
  },

  /**
   * Starts the clone: checks the folder again, makes its parent folder,
   * opens a new space there and sends the clone line to its shell. The
   * dialog stays open until the line is sent.
   */
  launchClone(cx) {
    const st = this.step;
    if (!st || st.launching) return;
    const text = this.destInput.value().trim();
    const problem = this.destProblem(text);
    if (problem) {
      st.check = { text, status: "bad", message: problem };
      cx.notify();
      return;
    }
    if (this.branchProblem()) {
      cx.notify();
      return;
    }
    if (memory.demo) {
      notify({ title: "Demo data", body: "Run github-clone.demo again to clone a real repository.", level: "info", timeout: 3000 });
      return;
    }
    st.launching = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const machine = st.machine;
      try {
        const info = await machineInfo(machine);
        const dest = expandHome(text, info);
        if (await pathExists(machine, info, dest)) {
          st.check = { text, status: "exists" };
          return;
        }
        const parent = parentOf(dest);
        await makeDir(machine, info, parent);
        if (st.saveRoot && !rootOf(machine)) setRoot(machine, parentOf(normalize(text)));

        const before = new Set(panes().map((p) => p.terminal).filter(Boolean));
        run("space.new", { machine: machine ?? "", folder: nativePath(parent, info) });
        let address = null;
        for (let i = 0; i < 100 && !address; i++) {
          await wait(cx, 100);
          address = panes().find((p) => p.terminal && !before.has(p.terminal))?.terminal ?? null;
        }
        if (!address) throw new Error("The terminal of the new space did not start.");
        await this.waitPrompt(cx, address);
        const line = cloneLine(info, st.repo.full, dest, { branch: this.branchArg(), shallow: st.shallow });
        const r = await hc(["send", address, line]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim() || "hc send failed");
        run("pane.focus", { terminal: address });
        setPending([...pending(), { machine, path: dest, at: Date.now() }]);
        if (memory.launcherInstalled) addLauncherRepo(machine, dest, info);
        this.close();
      } catch (e) {
        notify({ title: `Could not clone ${st.repo.name}`, body: String(e?.message ?? e), level: "error", timeout: 8000 });
      } finally {
        st.launching = false;
        cx.notify();
      }
    });
  },

  /** Waits until the shell of a new terminal draws its prompt (the screen stops changing), at most about 12 s. */
  async waitPrompt(cx, address) {
    let prev = null;
    for (let i = 0; i < 50; i++) {
      await wait(cx, 150);
      let text = "";
      try {
        const r = await hc(["read", address, "--lines", "30"]);
        text = r.code === 0 ? r.stdout.trim() : "";
      } catch {}
      if (text && text === prev) return;
      prev = text;
    }
  },

  browseDest(cx) {
    const st = this.step;
    if (!st || st.machine) return;
    cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: "Clone into this folder" }).catch(() => null);
      if (!dir || this.step !== st) return;
      this.destInput.set_value(joinPath(normalize(dir), st.repo.name));
      this.destInput.focus();
      cx.notify();
    });
  },

  // ---------------------------------------------------------------------------
  // Drawing

  field(t, label, control, below = null) {
    return h_flex().gap(12).items_start()
      .child(div().w(70).flex_none().pt(8).text_size(12).text_color(t.muted).child(label))
      .child(v_flex().flex_1().min_w(0).gap(6).child(control).when(Boolean(below), (e) => e.child(below)));
  },

  destNotice(t) {
    const st = this.step;
    const c = st.check;
    const text = this.destInput.value().trim();
    if (!c || c.text !== text) return notice(t, "info", text ? "Checking the folder…" : "Type the folder for the clone.");
    if (c.status === "checking") return notice(t, "info", "Checking the folder…");
    if (c.status === "free") return notice(t, "ok", "The folder is free. The clone makes it.");
    if (c.status === "exists") return notice(t, "warn", "The folder exists. Choose another folder.");
    return notice(t, "warn", c.message ?? "Could not check the folder.");
  },

  renderStep(t) {
    const st = this.step;
    const repo = st.repo;
    const info = st.info;
    const where = machineLabel(st.machine);
    const c = this.account(st.machine);
    const text = this.destInput.value().trim();
    const free = st.check?.status === "free" && st.check.text === text;
    const font = appSettings().font_family ?? "JetBrains Mono";

    const head = this.header(t, repo.name, [repo.owner, repo.desc].filter(Boolean).join("  ·  "), {
      leading: h_flex().gap(8).items_center()
        .child(iconButton(t, "gc-back", "back", (cx) => this.back(cx), { tooltip: "Back (Esc)" }))
        .child(letterTile(repo.name, nameColor(repo.owner), 34)),
      trailing: [
        repo.private ? pill(t, "private", { symbol: "lock" }) : null,
        repo.fork ? pill(t, "fork", { symbol: "fork" }) : null,
        repo.archived ? pill(t, "archived", { symbol: "archive" }) : null,
        iconButton(t, "gc-step-web", "external", () => openUrl(repoUrl(repo.full)), { tooltip: "Open on GitHub (Ctrl+O)" }),
      ].filter(Boolean),
    });

    const warning = st.status === "cloned"
      ? `${repo.full} is cloned in ${joinPath(folderFor(st.machine, repo.owner), repo.name)} already. To make a second copy, choose another folder.`
      : st.status === "used" ? `The folder ${repo.name} exists in the clone folder and holds something else. Choose another folder.` : "";

    const destRow = h_flex().gap(8).items_center()
      .child(this.inputBox(t, this.destInput, { symbol: "folder", focus: this.focusField === "dest", mono: true }))
      .when(!st.machine, (e) => e.child(button(t, "gc-browse", "Browse…", (cx) => this.browseDest(cx))));
    const saveRoot = !rootOf(st.machine) && !st.fromRule && isFullPath(text) ? h_flex().gap(10).items_center()
      .child(toggle(t, "gc-save-root", st.saveRoot, (cx) => { st.saveRoot = !st.saveRoot; cx.notify(); }))
      .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.muted)
        .child(`Save ${parentOf(normalize(text))} as the clone folder of ${where}`)) : null;

    const list = this.suggestions();
    const branchBelow = v_flex().gap(4)
      .when(list.length > 0, (e) => e.child(v_flex().p(4).gap(1).rounded(8).bg(t.background).border_1().border_color(t.border)
        .children(list.map((b, i) => h_flex().id(`gc-branch-${b}`).h(26).px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .bg(i === st.suggestAt ? tint(t.accent, "24") : "#00000000")
          .hover((s) => s.bg(t.hover))
          // Keep the keyboard in the branch field.
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.pickBranch(b, cx))
          .child(svg(icon("branch")).size(12).flex_none().text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(font).child(b))
          .when(b === repo.branch, (e) => e.child(div().text_size(10.5).text_color(t.dim).child("default")))))))
      .child(div().text_size(11).text_color(t.dim).child(
        this.branchProblem() ? this.branchProblem()
          : st.branchError ? `Could not read the branches: ${st.branchError}`
          : !st.branches ? "Reading the branches…"
          : `${st.branches.length}${st.branches.length >= 100 ? "+" : ""} branch${st.branches.length === 1 ? "" : "es"}. Default: ${repo.branch || "?"}. A name that is not in the list works too.`));

    const shallow = h_flex().gap(10).items_center().pt(4)
      .child(toggle(t, "gc-shallow", st.shallow, (cx) => { st.shallow = !st.shallow; cx.notify(); }))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(12.5).child("Shallow clone (--depth 1)"))
        .child(div().text_size(11).text_color(t.dim).child("Only the last commit of the branch, also in the submodules. Faster for a big repository, but with no history.")))
      .child(div().flex_none().text_size(11).text_color(t.dim).child("Submodules: cloned too"));

    const cmdInfo = info ?? knownInfo(st.machine) ?? { windows: false, home: "~", fold: false };
    const preview = text && isFullPath(text) ? cloneLine(cmdInfo, repo.full, expandHome(text, cmdInfo), { branch: this.branchArg(), shallow: st.shallow }) : "";

    const body = v_flex().id("gc-step-body").h(Math.max(200, this.height() - HEAD_H - FOOT_H)).w_full().overflow_y_scrollbar().p(18).gap(16)
      .when(Boolean(warning), (e) => e.child(h_flex().px(12).py(8).rounded(10).bg(tint(t.blocked, "14")).border_1().border_color(tint(t.blocked, "40"))
        .child(notice(t, "warn", warning))))
      .child(this.field(t, "Machine", h_flex().gap(8).items_center().h(34)
        .child(pill(t, st.machine ? st.machine : "This computer", { symbol: "server", color: t.accent }))
        .child(div().text_size(11.5).text_color(t.dim).child(c?.login ? `The clone runs there, with the gh account ${c.login}.` : "The clone runs there, with its gh account."))))
      .child(this.field(t, "Folder", destRow, v_flex().gap(4).child(this.destNotice(t)).when(Boolean(saveRoot), (e) => e.child(saveRoot))))
      .child(this.field(t, "Branch", this.inputBox(t, this.branchInput, { symbol: "branch", focus: this.focusField === "branch", mono: true }), branchBelow))
      .child(this.field(t, "", shallow))
      .when(Boolean(preview), (e) => e.child(this.field(t, "Runs", v_flex().gap(4)
        .child(div().p(10).rounded(8).bg(t.background).border_1().border_color(t.border).text_size(11.5).font_family(font).text_color(t.muted).child(preview))
        .child(div().text_size(11).text_color(t.dim).child(`In a new space on ${where}. You see the progress there and can answer a prompt.`)))));

    const footer = h_flex().h(FOOT_H).flex_none().px(16).gap(12).items_center().border_t(1).border_color(t.border).bg(t.chrome ?? t.popover)
      .child(hint(t, ["↵"], "clone"))
      .child(hint(t, ["Esc"], "back"))
      .child(hint(t, ["Ctrl+O"], "GitHub"))
      .child(div().flex_1())
      .child(button(t, "gc-step-back", "Back", (cx) => this.back(cx)))
      .child(button(t, "gc-clone", st.launching ? "Starting…" : "Clone", (cx) => this.launchClone(cx),
        { primary: true, symbol: "download", spin: st.launching, disabled: st.launching || !free || Boolean(this.branchProblem()) }));

    return v_flex().size_full().min_h(0).child(head).child(body).child(footer);
  },
};
