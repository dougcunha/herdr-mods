// Opens a terminal or an agent for a repository: in the repository's open
// space, or in a new space.

import { spaces, panes, run } from "herdr";
import { ACCOUNT_AGENTS, isInside, isWindows, powershell } from "./scan.js";

/**
 * Splits a text of arguments like a shell: spaces separate the arguments,
 * and single or double quotes keep spaces inside one.
 */
export function splitArgs(text) {
  const out = [];
  let cur = "";
  let quote = null;
  let started = false;
  for (const c of String(text ?? "")) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started || cur) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += c;
    }
  }
  if (started || cur) out.push(cur);
  return out;
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * The argv that starts `agent` (from knownAgents()) with the extra
 * arguments and, for a second account, its folder in the account's
 * environment variable.
 *
 * Herdr runs an argv inside the person's shell. It has no field for
 * environment variables, so a second account goes through a small wrapper:
 * `env NAME=dir agent ...` on macOS and Linux, and a PowerShell that sets
 * `$env:NAME` on Windows.
 */
export async function agentArgv(agent, extraArgs, account) {
  const argv = [...(agent.run ?? [agent.key]), ...splitArgs(extraArgs)];
  const spec = ACCOUNT_AGENTS[agent.key];
  if (!account || account.isDefault || !spec) return argv;
  if (isWindows()) {
    const ps = await powershell();
    const command = `$env:${spec.env}=${psQuote(account.dir.replace(/\//g, "\\"))}; & ${argv.map(psQuote).join(" ")}`;
    return [ps, "-NoLogo", "-NoProfile", "-Command", command];
  }
  return ["env", `${spec.env}=${account.dir}`, ...argv];
}

/**
 * The open spaces of `machine` (null: this computer) that work in `repo`: a
 * space with a terminal whose live folder is in the repository.
 *
 * The space of the repository comes first: its name is the repository's
 * (Herdr names a space after the repository of its first terminal), then
 * its start folder is in the repository, then the shown space; then the
 * space with the most terminals there.
 */
export function spacesFor(repoPath, machine = null, allSpaces = spaces(), allPanes = panes()) {
  const repoName = repoPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop().toLowerCase();
  const inRepo = new Map(); // tab id -> [panes in the repository, all panes]
  for (const p of allPanes) {
    if (!p.terminal) continue;
    const [hit, all] = inRepo.get(p.tab) ?? [0, 0];
    inRepo.set(p.tab, [hit + (isInside(p.cwd, repoPath) ? 1 : 0), all + 1]);
  }
  const share = (s) => {
    let hit = 0;
    let all = 0;
    for (const t of s.tabs) {
      const [h, a] = inRepo.get(t.id) ?? [0, 0];
      hit += h;
      all += a;
    }
    return { hit, ratio: all ? hit / all : 0 };
  };
  // `folder` is where a space was made, not where it works now, so it only
  // breaks ties.
  const rank = (s) => (s.name.toLowerCase() === repoName ? 4 : 0) + (isInside(s.folder, repoPath) ? 2 : 0) + (s.active ? 1 : 0);
  return allSpaces
    .filter((s) => (s.machine ?? null) === (machine ?? null))
    .map((s) => ({ s, rank: rank(s), share: share(s) }))
    .filter((x) => x.share.hit > 0)
    .sort((a, b) => (b.rank - a.rank) || (b.share.ratio - a.share.ratio) || (a.s.index - b.s.index))
    .map((x) => x.s);
}

/**
 * Opens `argv` (null: a shell) for the repository.
 * `reuse`: use the repository's open space when it has one.
 * `mode`: "tab" (a new tab), "split" (a split to the right of the space's
 * focused pane) or "go" (only show the space; an agent still gets a tab).
 * `machine`: the machine of the repository (null: this computer), and
 * `windows`: that machine runs Windows.
 * `target`: "new" (a new space) or the id of an open space of that machine.
 * Without it, `reuse` picks the space.
 */
export function open(repoPath, { argv = null, name = undefined, reuse = true, mode = "tab", machine = null, windows = isWindows(), target = null } = {}) {
  const folder = windows ? repoPath.replace(/\//g, "\\") : repoPath;
  const own = spacesFor(repoPath, machine);
  const space = target === "new" ? null
    : target ? spaces().find((s) => s.id === target) ?? null
    : reuse ? own[0] : null;
  const withArgv = (args) => (argv ? { ...args, argv } : args);

  if (!space) {
    run("space.new", withArgv({ folder, ...(machine ? { machine } : {}), ...(name ? { tab: name } : {}) }));
    return { created: true };
  }
  // Some layouts (a board of agents, say) show the focused pane, not the
  // selected space, so the space is shown by focusing one of its panes.
  const pane = paneOf(space, repoPath);
  // "Go to space" needs a terminal that works in the repository already.
  if (mode === "go" && !argv && own.some((s) => s.id === space.id)) {
    run("space.select", { id: space.id });
    if (pane) run("pane.focus", { pane: pane.pane });
    return { created: false };
  }
  if (mode === "split" && pane) {
    run("space.select", { id: space.id });
    run("pane.focus", { pane: pane.pane });
    run("terminal.open", withArgv({ place: "right", folder }));
    return { created: true };
  }
  run("space.select", { id: space.id });
  run("tab.new", withArgv({ space: space.id, folder, ...(name ? { name } : {}) }));
  return { created: true };
}

/**
 * The terminal pane of `space` to show or split: the focused one in the
 * shown tab when it works in the repository, else one that works there,
 * else any terminal pane of the space.
 */
export function paneOf(space, repoPath, allPanes = panes()) {
  const tabIds = new Set(space.tabs.map((t) => t.id));
  const activeTab = space.tabs.find((t) => t.active)?.id;
  const mine = allPanes.filter((p) => p.terminal && tabIds.has(p.tab));
  const inRepo = mine.filter((p) => isInside(p.cwd, repoPath));
  return inRepo.find((p) => p.tab === activeTab && p.focused)
    ?? inRepo.find((p) => p.tab === activeTab)
    ?? inRepo[0]
    ?? mine.find((p) => p.tab === activeTab)
    ?? mine[0]
    ?? null;
}
