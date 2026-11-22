// The folders view of the dialog: the clone folder of each machine and the
// owner rules. Every change is saved at once in shared state.
//
// Repo Launcher finds a repository only under its own root folders. When a
// clone folder is outside them, this view says so and offers a button that
// adds the folder to Repo Launcher. Nothing changes without that click.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import { notify, pickFolder, checking } from "herdr";
import { machineInfo, knownInfo, normalize } from "./sys.js";
import { mkey, settings, updateSettings, cacheOf, inLauncher, addLauncherRoot } from "./store.js";
import { memory, machineList, HEAD_H, FOOT_H } from "./common.js";
import { pill, hint, iconButton, button, segmented, chip, card, notice } from "./ui.js";

export const folderMethods = {
  initFolders() {
    this.rootInputs = {};
    this.ruleInputs = [];
    this.folderInfos = {};
  },

  openFolders(cx) {
    this.view = "folders";
    this.syncRootInputs();
    this.syncRuleInputs();
    if (!checking()) {
      for (const m of machineList()) {
        if (m.disabled || this.folderInfos[mkey(m.name)]) continue;
        cx.spawn(async (cx) => {
          try { this.folderInfos[mkey(m.name)] = await machineInfo(m.name); } catch {}
          cx.notify();
        });
      }
    }
    this.focusRoot(cx);
    cx.notify();
  },

  /** A text field for the clone folder of each machine. Runs in a handler (a field needs a live host call). */
  syncRootInputs() {
    const roots = settings().roots;
    for (const m of machineList()) {
      const k = mkey(m.name);
      if (this.rootInputs[k]) continue;
      const input = InputState.new({ placeholder: m.name ? "~/code, or C:/Projects on Windows" : "~/code", value: roots[k] ?? "" });
      input.on("change", () => this.saveRoot(m.name, input.value()));
      this.rootInputs[k] = input;
    }
  },

  /** 2 text fields for each owner rule, made again after a rule is added or removed. */
  syncRuleInputs() {
    this.ruleInputs = settings().rules.map((rule, i) => {
      const owner = InputState.new({ placeholder: "owner or organization", value: rule.owner ?? "" });
      owner.on("change", (_e, cx) => { this.saveRule(i, { owner: owner.value().trim() }); cx.notify(); });
      const folder = InputState.new({ placeholder: "~/work", value: rule.folder ?? "" });
      folder.on("change", () => this.saveRule(i, { folder: normalize(folder.value()) }));
      return { owner, folder };
    });
  },

  saveRoot(machine, value) {
    const k = mkey(machine);
    updateSettings((s) => {
      const roots = { ...s.roots };
      const v = normalize(value);
      if (v) roots[k] = v;
      else delete roots[k];
      return { roots };
    });
  },

  saveRule(i, change) {
    updateSettings((s) => ({ rules: s.rules.map((r, j) => (j === i ? { ...r, ...change } : r)) }));
  },

  addRule(cx) {
    const owner = this.owner && this.owner !== "all" ? this.owner : "";
    updateSettings((s) => ({ rules: [...s.rules, { machine: this.machine ?? null, owner, folder: "" }] }));
    this.syncRuleInputs();
    cx.notify();
  },

  removeRule(i, cx) {
    updateSettings((s) => ({ rules: s.rules.filter((_r, j) => j !== i) }));
    this.syncRuleInputs();
    cx.notify();
  },

  browse(input, save, cx) {
    cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: "Clone folder" }).catch(() => null);
      if (!dir) return;
      input.set_value(normalize(dir));
      save(normalize(dir));
      cx.notify();
    });
  },

  /** The warning under a folder that Repo Launcher does not read, with its button. */
  launcherNotice(t, id, machine, folder) {
    const value = String(folder ?? "").trim();
    if (!value || !memory.launcherInstalled) return null;
    const info = this.folderInfos[mkey(machine)] ?? knownInfo(machine);
    if (!info || inLauncher(machine, value, info)) return null;
    return notice(t, "warn", "Repo Launcher does not read this folder, so Ctrl+P does not find these clones.",
      button(t, `gc-rl-${id}`, "Add to Repo Launcher", (cx) => {
        addLauncherRoot(machine, value);
        notify({ title: "Folder added to Repo Launcher", body: "Repo Launcher reads it at its next Refresh (Ctrl+R in Repo Launcher).", level: "success", timeout: 4000 });
        cx.notify();
      }, { symbol: "plus" }));
  },

  renderFolders(t) {
    const s = settings();
    const machinesNow = machineList();

    const head = this.header(t, "Clone folders", "Where GitHub Clone puts each clone", {
      leading: h_flex().gap(8).items_center()
        .child(iconButton(t, "gc-folders-back", "back", (cx) => this.back(cx), { tooltip: "Back (Esc)" }))
        .child(this.brandTile(t)),
    });

    const roots = v_flex().gap(10).children(machinesNow.map((m) => {
      const k = mkey(m.name);
      const input = this.rootInputs[k];
      return v_flex().gap(4)
        .child(h_flex().gap(10).items_center()
          .child(div().w(130).flex_none().child(pill(t, m.name ? m.label : "This computer", { symbol: "server", color: m.disabled ? null : t.accent, max: 100 })))
          .child(input ? this.inputBox(t, input, { symbol: "folder", mono: true }) : div().flex_1())
          .when(!m.name && Boolean(input), (e) => e.child(button(t, "gc-root-browse", "Browse…", (cx) => this.browse(input, (v) => this.saveRoot(null, v), cx)))))
        .when(Boolean(this.launcherNotice(t, `root-${k || "local"}`, m.name, s.roots[k])), (e) => e.child(div().pl(140).child(this.launcherNotice(t, `root-${k || "local"}`, m.name, s.roots[k]))));
    }));

    const rules = v_flex().gap(12)
      .children(s.rules.map((rule, i) => {
        const inputs = this.ruleInputs[i];
        if (!inputs) return div();
        const machine = rule.machine ?? null;
        const local = !machine;
        const c = cacheOf(machine);
        const known = c ? [...new Set([c.login, ...(c.repos ?? []).map((r) => r.owner), ...(c.orgs ?? [])].filter(Boolean))] : [];
        const warn = this.launcherNotice(t, `rule-${i}`, machine, rule.folder);
        return v_flex().gap(6).p(10).rounded(10).bg(t.raised)
          .child(h_flex().gap(8).items_center()
            .child(segmented(t, `gc-rule-m-${i}`, machinesNow.map((m) => ({ value: mkey(m.name), label: m.name ? m.label : "This computer" })), mkey(machine),
              (v, cx) => { this.saveRule(i, { machine: v || null }); cx.notify(); }))
            .child(div().flex_1())
            .child(iconButton(t, `gc-rule-del-${i}`, "trash", (cx) => this.removeRule(i, cx), { tooltip: "Remove this rule", size: 28 })))
          .child(h_flex().gap(8).items_center()
            .child(div().w(190).flex_none().child(h_flex().child(this.inputBox(t, inputs.owner, { symbol: "users" }))))
            .child(div().text_size(12).text_color(t.dim).child("→"))
            .child(this.inputBox(t, inputs.folder, { symbol: "folder", mono: true }))
            .when(local, (e) => e.child(button(t, `gc-rule-browse-${i}`, "Browse…", (cx) => this.browse(inputs.folder, (v) => this.saveRule(i, { folder: v }), cx)))))
          .when(!String(rule.owner ?? "").trim() && known.length > 0, (e) => e.child(h_flex().flex_wrap().gap(6).items_center()
            .child(div().text_size(11).text_color(t.dim).child("Owners:"))
            .children(known.slice(0, 12).map((o) => chip(t, `gc-rule-o-${i}-${o}`, o, false, (cx) => {
              inputs.owner.set_value(o);
              this.saveRule(i, { owner: o });
              cx.notify();
            })))))
          .when(Boolean(warn), (e) => e.child(warn));
      }))
      .when(s.rules.length === 0, (e) => e.child(div().text_size(12).text_color(t.dim).child("No rules. Every clone goes to the clone folder of its machine.")))
      .child(h_flex().child(button(t, "gc-rule-add", "Add rule", (cx) => this.addRule(cx), { symbol: "plus" })));

    const body = v_flex().id("gc-folders-body").h(Math.max(200, this.height() - HEAD_H - FOOT_H)).w_full().overflow_y_scrollbar().p(16).gap(12)
      .child(card(t, "Clone folder of each machine",
        "A clone goes to <folder>/<repository name>. For another machine, type the path: the folder picker shows only this computer. ~ is the home folder of that machine.", roots))
      .child(card(t, "Owner rules",
        "The repositories of 1 owner go to another folder on 1 machine, for example the repositories of your company. A rule wins over the clone folder.", rules));

    const footer = h_flex().h(FOOT_H).flex_none().px(16).gap(14).items_center().border_t(1).border_color(t.border).bg(t.chrome ?? t.popover)
      .child(div().text_size(11).text_color(t.dim).child("Changes are saved at once."))
      .child(div().flex_1())
      .child(hint(t, ["Esc"], "back"));

    return v_flex().size_full().min_h(0).child(head).child(body).child(footer);
  },
};
