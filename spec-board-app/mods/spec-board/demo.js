// Example specs for screenshots (command `spec-board.demo`). Nothing here is on disk.

import { statusOf } from "./data.js";

const ROOT = "D:/MyProjects/notes-app";
const WT = "C:/Users/you/.herdr/worktrees/notes-app";

const prd = (title, goal) => `# PRD — ${title}

## Problem

${goal}

## Functional requirements

| ID | Requirement | Acceptance |
| --- | --- | --- |
| RF-01 | The person sees the change at once | The list updates in less than 1 s |
| RF-02 | The change survives a restart | The value is the same after the app starts again |
| RF-03 | Errors show in a toast | The toast names the file and the cause |

## Out of scope

- Sync between devices.
- A new settings screen.
`;

const plan = (n) => `# Implementation plan

## Tasks

${Array.from({ length: n }, (_, i) => `- [T0${i + 1} — ${["Data model", "Storage", "List view", "Editor", "Toasts", "Tests", "Docs"][i]}](task_0${i + 1}.md): one observable result.`).join("\n")}
`;

function spec(slug, opts) {
  const where = opts.worktree ? { path: `${WT}/${opts.worktree}`, branch: opts.worktree, main: false } : { path: ROOT, branch: "main", main: true };
  const tasks = Array.from({ length: opts.tasks ?? 0 }, (_, i) => ({
    file: i < (opts.done ?? 0) ? `done/task_0${i + 1}.md` : `task_0${i + 1}.md`,
    name: `task_0${i + 1}.md`,
    num: i + 1,
    done: i < (opts.done ?? 0),
    title: ["Data model", "Storage", "List view", "Editor", "Toasts", "Tests", "Docs"][i],
  }));
  const cp = opts.status === undefined ? undefined : {
    schema_version: 1, generation: 7, feature: slug, workspace: where.path,
    nivel: opts.nivel ?? "sdd-completo", phase: opts.phase, status: opts.status, mode: opts.mode ?? "monitorado",
    review_status: opts.review ?? null, pending_hil: opts.hil ?? null,
    next_action: { kind: "executar", instruction: opts.next ?? "", read: [] },
  };
  const reviews = opts.review ? [{ dir: "codereview_01", num: 1, report: "codereview_01/codereview.md", tasks: [] }] : [];
  const s = {
    slug, dir: `prd-${slug}`, where, path: `${where.path}/tasks/prd-${slug}`, time: opts.time,
    docs: {
      prd: "prd.md", techspec: opts.status ? "techspec.md" : null, tasks: tasks.length ? "tasks.md" : null,
      workflow: opts.status ? "workflow.md" : null, snapshot: null, brief: null, checkpoint: opts.status ? "checkpoint.json" : null,
    },
    designs: [], tasks, reviews, checkpoint: cp, total: tasks.length, doneCount: tasks.filter((t) => t.done).length,
    review: opts.review ?? null, lastReview: reviews[0] ?? null, others: [], demo: true,
  };
  s.status = statusOf(cp);
  return s;
}

export function demoSpecs() {
  const now = Date.now();
  const list = [
    spec("notes-01-markdown-editor", { status: "ativo", phase: "implementacao", tasks: 5, done: 3, worktree: "feat/notes-01-markdown-editor", time: now - 6e5 }),
    spec("notes-02-offline-sync", { status: "aguardando-hil", phase: "projeto-plano", tasks: 4, done: 0, hil: "HIL 2", next: "Approve the TechSpec and the 4 tasks.", time: now - 3e6 }),
    spec("notes-03-shared-folders", { time: now - 9e7 }),
    spec("export-pdf", { status: "bloqueado", phase: "correcoes", tasks: 6, done: 5, review: "REPROVADO", next: "Fix the 2 findings of the review.", time: now - 7e6 }),
    spec("dark-theme", { status: "pausado", phase: "implementacao", tasks: 4, done: 1, mode: "auto", time: now - 2e8 }),
    spec("search-index", { status: "concluido", phase: "concluido", tasks: 5, done: 5, review: "APROVADO", time: now - 9e8 }),
  ];
  const texts = new Map();
  for (const s of list) {
    texts.set(`${s.path}/prd.md`, prd(s.slug.replace(/^notes-\d+-/, "").replace(/-/g, " "), "People lose their notes when the app closes before they save. They want the app to keep every change without a click."));
    texts.set(`${s.path}/techspec.md`, "# TechSpec\n\n## Architecture\n\nA small store writes each change to disk in the background.\n");
    texts.set(`${s.path}/tasks.md`, plan(s.total));
    texts.set(`${s.path}/workflow.md`, "# Workflow\n\n- WF-01: level `sdd-completo`, chosen in HIL 0.\n");
    texts.set(`${s.path}/codereview_01/codereview.md`, `# Code review\n\n**Status:** ${s.review ?? ""}\n`);
    for (const t of s.tasks) texts.set(`${s.path}/${t.file}`, `# T0${t.num} — ${t.title}\n\n## Result\n\nOne observable result.\n`);
  }
  return {
    repo: { root: ROOT, name: "notes-app", git: true, worktrees: [{ path: ROOT, branch: "main", main: true }] },
    specs: list,
    texts,
  };
}
