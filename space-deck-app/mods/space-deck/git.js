// The git status of the folders where spaces work. One `git` runs at a
// time. A folder is read again when its time is due (the Git refresh
// setting), or at once when `soon()` asks for it (an agent of the space changed
// status). A folder on a machine that does not answer keeps its last status.

import { exec } from "herdr";

const base = (path) => path.replace(/\/+$/, "").split("/").pop();

/** Where a space is now: the live folder of its first terminal, else where it was made. */
export function place(space, ps) {
  const tabs = new Set((space.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder;
}

/** The id of a folder on a machine: JSON of [machine, folder]. */
export const where = (space, ps) => JSON.stringify([space.machine ?? null, place(space, ps)]);

export class Git {
  constructor() {
    this.info = {}; // where -> { top, repo, name, linked, branch, ahead, behind, changed } | null (no repo)
    this.checked = {}; // where -> ms of the last read
    this.repos = {}; // where -> { top, repo, name, linked }: these do not change, read once
    this.pending = new Set();
    this.running = false;
  }

  get(w) {
    return this.info[w];
  }

  /** Reads `w` at the next chance. */
  soon(w, cx) {
    this.pending.add(w);
    this.pump(cx);
  }

  /** Queues every folder in `wheres` that is new or older than `everyMs`. */
  due(wheres, everyMs, cx) {
    const now = Date.now();
    for (const w of wheres) if (!(w in this.info) || now - (this.checked[w] ?? 0) >= everyMs) this.pending.add(w);
    this.pump(cx);
  }

  pump(cx) {
    if (this.running || !this.pending.size) return;
    this.running = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const list = [...this.pending];
        this.pending.clear();
        for (const w of list) {
          await this.read(w);
          cx.notify();
        }
      }
      this.running = false;
    });
  }

  async read(w) {
    const [on, cwd] = JSON.parse(w);
    this.checked[w] = Date.now();
    if (!cwd) {
      this.info[w] = null;
      return;
    }
    try {
      // No optional locks and no fsmonitor: the read writes nothing under .git.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" means no repo. Keep the last status for any other error.
        if (/not a git repository/i.test(r.stderr)) this.info[w] = null;
        else this.info[w] ??= null;
        return;
      }
      let repo = this.repos[w];
      if (!repo) {
        const top = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on })).stdout.trim();
        const common = (await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on })).stdout.trim();
        const name = common.endsWith("/.git") ? base(common.slice(0, -5)) : base(common).replace(/\.git$/, "");
        repo = { top, repo: JSON.stringify([on, common]), name, linked: common !== `${top}/.git` };
        if (top) this.repos[w] = repo;
      }
      const info = { ...repo, branch: null, ahead: 0, behind: 0, changed: 0 };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14).trim();
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        } else if (/^[12u?] /.test(line)) info.changed += 1;
      }
      if (info.branch === "(detached)") info.branch = null;
      this.info[w] = info;
    } catch {
      // The machine did not answer: keep what it showed.
      this.info[w] ??= null;
    }
  }
}
