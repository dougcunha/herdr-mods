// Example data for `herdr-app do space-deck.demo`: every kind of card at once
// (pinned, a worktree, an agent that needs you, a remote space, a note), for
// a screenshot or a test. Nothing here is written to shared().

const prog = (key, name) => ({ key, name, icon: `icons/${key}.svg`, tint: false, tile: null, color: null, shell: false, agent: true });
const CLAUDE = prog("claude", "Claude Code");
const CODEX = prog("codex", "Codex");
const OPENCODE = prog("opencode", "OpenCode");

const min = 60 * 1000;

function row(id, name, extra) {
  return {
    id: `demo-${id}`,
    name,
    active: false,
    status: null,
    machine: null,
    key: `demo|${id}`,
    where: "",
    folder: `D:/MyProjects/${name}`,
    git: null,
    agents: [],
    tabs: 1,
    terms: 1,
    terminals: [],
    activity: Date.now() - 30 * min,
    tree: null,
    parent: null,
    index: 0,
    ...extra,
  };
}

const git = (branch, ahead = 0, behind = 0, changed = 0) => ({ branch, ahead, behind, changed, linked: false, repo: branch, name: branch });
const agent = (program, status) => ({ address: `${program.key}-${status}`, status, program, name: program.name });
const term = (n, title, program = null, status = null, focused = false) =>
  ({ terminal: `demo-t${n}`, pane: `demo-p${n}`, title, cwd: null, status, app: program?.key ?? null, program, focused });

export function demoModel() {
  const now = Date.now();
  return {
    pinned: [
      row("mods", "herdr-mods", {
        active: true, status: "working", tabs: 3, terms: 4, activity: now - 2 * min,
        git: git("main", 2, 0, 3),
        agents: [agent(CLAUDE, "working"), agent(CODEX, "idle")],
        terminals: [term(1, "Space Deck: terminal rows", CLAUDE, "working", true), term(2, "Review the diff", CODEX, "idle"), term(3, "pwsh"), term(4, "npm run dev")],
        deco: { icon: "rocket", color: "ansi4", note: "Space Deck: test the drag of pinned cards" },
      }),
      row("hound", "TokenHound", {
        status: "blocked", tabs: 2, terms: 2, activity: now - 8 * min,
        git: git("feature/hud-v2", 0, 1, 0),
        agents: [agent(CLAUDE, "blocked")],
        terminals: [term(5, "Approve: run migrations?", CLAUDE, "blocked"), term(6, "pwsh")],
        deco: { icon: "gamepad-2", color: "ansi3" },
      }),
    ],
    groups: [
      {
        machine: null,
        rows: [
          row("plugins", "herdr-plugins", {
            status: "done", tabs: 2, terms: 3, activity: now - 25 * min,
            git: git("main", 0, 0, 1),
            agents: [agent(OPENCODE, "done")],
            deco: { icon: "puzzle", color: "ansi5" },
          }),
          row("plugins-wt", "fix-status", {
            tree: "└", folder: "D:/MyProjects/herdr-plugins-fix-status", git: git("fix-status", 1, 0, 2), activity: now - 3 * 60 * min,
            deco: { color: "ansi5" },
          }),
          row("brake", "context-brake", {
            tabs: 1, terms: 1, activity: now - 26 * 60 * min, git: git("main"),
            deco: { emoji: "🧠", note: "Waiting for review of PR 12" },
          }),
          row("wiki", "llmwiki", { git: git("main"), activity: now - 3 * 24 * 60 * min, deco: { icon: "book-open", color: "ansi2" } }),
        ],
      },
      {
        machine: "build-box",
        rows: [
          row("jev", "jev-mcp", {
            machine: "build-box", folder: "~/src/jev-mcp", tabs: 1, terms: 2, status: "working", activity: now - 1 * min,
            git: git("main", 0, 3, 0), agents: [agent(CODEX, "working")],
            deco: { icon: "server", color: "ansi6" },
          }),
        ],
      },
    ],
    remote: true,
    recent: [
      { name: "", folder: "D:/MyProjects/WinServicesTool", key: "demo|wst", deco: { icon: "wrench", color: "ansi1" } },
      { name: "", folder: "D:/MyProjects/claude-mods", key: "demo|cm" },
    ],
  };
}
