// Finds the Claude Code agents that look finished (Done or Idle) but still wait for background
// subagents. The Herdr app only sees the status the agent reports, and a Claude that ended its
// turn after launching background subagents reports "done" while they run.
//
// The truth is in the transcript of the Claude session. Claude Code writes it next to a small
// registry of its live sessions:
//   <config>/sessions/<pid>.json                          { pid, sessionId, cwd, startedAt, ... }
//   <config>/projects/<project>/<sessionId>.jsonl         the transcript
// A background subagent leaves 3 marks in the transcript:
//   1. A tool_result "Async agent launched successfully ... agentId: <id>".
//   2. A <task-notification> for <id> that says the agent "is waiting on its own background
//      work": an interim report. The agent is not finished.
//   3. A <task-notification> for <id> without that phrase: the agent finished (or failed).
// So a subagent is pending when it was launched and its last notification is interim or absent.
// A background shell command (the Bash tool with `run_in_background`) leaves 2 marks:
//   1. A tool_result "Command running in background with ID: <id>".
//   2. A <task-notification> for <id> when the command ends (completed, failed or killed).
// So a command is pending when it was started and no notification for it follows.
// A job that Claude stops with the TaskStop tool (KillShell or KillBash in older versions) gets no
// notification: the stop call ends it.
// The registry also tells it: a session that ended its turn while a background command runs has
// `"status": "shell"` in <config>/sessions/<pid>.json.
//
// This file imports only `fs/promises`, so a plain Node script can test it.
import * as fs from "fs/promises";

/** A pending subagent that has not reported for this long stops counting as pending. Claude Code can leave a
 *  subagent marked as waiting for good (for example when it ends while a Monitor it armed is still alive, and no
 *  final notice follows), and a session can die with subagents running: this limit ends both. It counts from the
 *  last report of the subagent (its launch when it has made none). `ttlMs` of the tracker changes it. */
export const WAITING_TTL_MS = 60 * 60 * 1000;
/** A transcript larger than this is not read (it would take too long). */
const MAX_TRANSCRIPT = 96 * 1024 * 1024;

const INTERIM = /waiting on its own background work/;
// The 3 records that carry a notification: the queue, the message Claude receives, and a queued
// command. The quotes are not escaped here, so a tool result or a message that only talks about a
// notification (its quotes are escaped inside the string) does not match.
const NOTIFY_RECORD = /^\{"type":"queue-operation".*?"content":"<task-notification>|"message":\{"role":"user","content":"<task-notification>|"attachment":\{"type":"queued_command","prompt":"<task-notification>/;
const AGENT_TOOLS = ['"name":"Agent"', '"name":"Task"'];
const SHELL_STARTED = /Command running in background with ID:\s*([A-Za-z0-9_-]+)/;
const STOP_TOOLS = new Set(["TaskStop", "KillShell", "KillBash"]);
const STOP_MARKS = [...STOP_TOOLS].map((n) => `"name":"${n}"`);

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
const text = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("\n") : "");

/** The background subagents and shell commands of a transcript that have not finished.
 *  Returns [{ id, kind, description, since }] (`kind`: "agent" or "shell"; `since`: ms since the epoch, or 0). */
export function scanTranscript(transcript) {
  const calls = new Map(); // tool_use id -> { kind, description }
  const agents = new Map(); // agentId or shell id -> { kind, toolUseId, since, last, pending }
  for (const line of String(transcript).split("\n")) {
    if (line.startsWith('{"type":"api-request')) continue; // request dumps: big and of no use here
    if (line.includes('"type":"tool_use"') && (AGENT_TOOLS.some((n) => line.includes(n)) || line.includes('"name":"Bash"') || STOP_MARKS.some((n) => line.includes(n)))) {
      for (const block of parse(line)?.message?.content ?? []) {
        if (block?.type !== "tool_use") continue;
        const description = String(block.input?.description ?? "").trim();
        if (block.name === "Agent" || block.name === "Task") calls.set(block.id, { kind: "agent", description });
        else if (block.name === "Bash" && block.input?.run_in_background === true) calls.set(block.id, { kind: "shell", description });
        else if (STOP_TOOLS.has(block.name)) {
          const job = agents.get(String(block.input?.task_id ?? block.input?.shell_id ?? ""));
          if (job) job.pending = false;
        }
      }
    } else if (line.includes('"tool_result"') && (line.includes("Async agent launched") || line.includes("Command running in background"))) {
      const record = parse(line);
      const since = Date.parse(record?.timestamp ?? "") || 0;
      for (const block of record?.message?.content ?? []) {
        // Only the result of the tool that started the job counts: the output of a shell command can print the same words.
        const call = block?.type === "tool_result" ? calls.get(block.tool_use_id) : null;
        if (!call) continue;
        const pattern = call.kind === "agent" ? /agentId:\s*([A-Za-z0-9_-]+)/ : SHELL_STARTED;
        const id = pattern.exec(text(block.content))?.[1];
        if (id) agents.set(id, { kind: call.kind, toolUseId: block.tool_use_id, since, last: since, pending: true });
      }
    } else if (line.includes("<task-notification>") && NOTIFY_RECORD.test(line)) {
      // The same notification shows several times (queue, delivery) and a record can hold more than one;
      // each is read on its own and the last one in the file wins.
      const at = Date.parse(/"timestamp":"([^"]+)"/.exec(line)?.[1] ?? "") || 0;
      for (const [block] of line.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
        const id = /<task-id>([^<\s]+)<\/task-id>/.exec(block)?.[1];
        const agent = id ? agents.get(id) : null;
        if (!agent) continue;
        // A shell command has no interim report: any notification for it means that it ended.
        agent.pending = agent.kind === "agent" && INTERIM.test(block);
        agent.last = Math.max(agent.last, at);
      }
    }
  }
  return [...agents].filter(([, a]) => a.pending)
    .map(([id, a]) => ({ id, kind: a.kind, description: calls.get(a.toolUseId)?.description ?? "", since: a.last || a.since }));
}

const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** The Claude session that runs in a terminal, from the registry of live sessions
 *  ([{ pid, sessionId, cwd, startedAt, root }]) and what `hc get` says of the terminal.
 *  In this order: the process id (exact), the `resume.session` label of the agent-resume mod, then
 *  the folder when only one session started there after the terminal was made.
 *  Returns { sessionId, root, cwd } or null: when unsure, no session (no card moves). */
export function pickSession(info, registry) {
  const pids = [info.pid, info.foreground?.pid, Number(info.labels?.["resume.pid"])].filter((n) => Number.isInteger(n) && n > 0);
  const byPid = registry.find((r) => pids.includes(r.pid));
  if (byPid) return { sessionId: byPid.sessionId, root: byPid.root, cwd: byPid.cwd };
  const label = info.labels?.["resume.session"];
  if (typeof label === "string" && /^[0-9a-f-]{20,40}$/i.test(label)) {
    const known = registry.find((r) => r.sessionId === label);
    return { sessionId: label, root: known?.root ?? null, cwd: known?.cwd ?? info.cwd };
  }
  const folders = new Set([info.cwd, info.foreground?.cwd].filter(Boolean).map(norm));
  const made = Number(info.created_ms) || 0;
  const here = registry.filter((r) => folders.has(norm(r.cwd)) && (!made || (r.startedAt ?? 0) >= made - 2000));
  return here.length === 1 ? { sessionId: here[0].sessionId, root: here[0].root, cwd: here[0].cwd } : null;
}

/** Applies the status that Claude Code writes in its registry of live sessions to the `items` of
 *  `scanTranscript`. With `"status": "shell"` a background command runs: when the transcript shows none
 *  (the transcript marks can change in a new Claude Code version), the result gets 1 shell item that counts
 *  from `statusUpdatedAt`. The time limit applies to it too: a server that Claude leaves on also keeps
 *  the status "shell". Another status changes nothing: the registry can still say "busy" just after the
 *  turn ends, so it does not prove that no command runs. */
export function withShellStatus(items, registry, sessionId) {
  const record = sessionId ? registry.find((r) => r.sessionId === sessionId) : null;
  if (record?.status !== "shell" || items.some((p) => p.kind === "shell")) return items;
  const since = Number.isFinite(record.statusUpdatedAt) ? record.statusUpdatedAt : 0;
  return [...items, { id: "shell", kind: "shell", description: "", since }];
}

/** How Claude Code names the folder of a project: every character that is not a letter or digit becomes "-". */
export const projectDir = (cwd) => String(cwd ?? "").replace(/[^A-Za-z0-9]/g, "-");

async function list(dir) {
  try { return await fs.readdir(dir); } catch { return []; }
}

async function readJson(path) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); } catch { return null; }
}

/** Reads the Claude Code sessions of this computer and tells which agents wait for subagents.
 *  `hc(args)` and `home()` come from the `herdr` module; `dirs`: the Claude config folders (default: every
 *  `~/.claude*` folder, because people keep more than one). */
export class WaitingTracker {
  constructor({ hc, home, dirs, ttlMs }) {
    this.hc = hc;
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : WAITING_TTL_MS;
    this.home = home;
    this.dirs = Array.isArray(dirs) && dirs.length ? dirs.map(String) : null;
    this.waits = new Map(); // address -> { turn, count, items: [{ id, description, since }] }
    this.infos = new Map(); // address -> { at, info }
    this.paths = new Map(); // sessionId -> transcript path
    this.scans = new Map(); // address -> { turn, items }: what the last read of its transcript found
    this.rootsAt = 0;
    this.roots = [];
  }

  async configRoots() {
    if (this.dirs) return this.dirs;
    if (Date.now() - this.rootsAt < 60000) return this.roots;
    const home = String(this.home()).replace(/[\\/]+$/, "");
    const found = [];
    for (const name of await list(home)) {
      if (!name.startsWith(".claude") || name.endsWith(".json") || name.includes(".bak")) continue;
      if ((await list(`${home}/${name}/sessions`)).length || (await list(`${home}/${name}/projects`)).length) found.push(`${home}/${name}`);
    }
    this.roots = found;
    this.rootsAt = Date.now();
    return found;
  }

  async registry(roots) {
    const out = [];
    for (const root of roots) {
      const files = (await list(`${root}/sessions`)).filter((f) => f.endsWith(".json"));
      const records = await Promise.all(files.map((f) => readJson(`${root}/sessions/${f}`)));
      for (const r of records) {
        if (r && Number.isInteger(r.pid) && typeof r.sessionId === "string") out.push({ ...r, root });
      }
    }
    return out;
  }

  async terminalInfo(address) {
    const hit = this.infos.get(address);
    if (hit && Date.now() - hit.at < 20000) return hit.info;
    let info = null;
    try { info = JSON.parse((await this.hc(["get", address, "--json"]))?.stdout ?? ""); } catch {}
    if (info && !info.error) this.infos.set(address, { at: Date.now(), info });
    else info = null;
    return info;
  }

  async transcriptPath(session, roots) {
    const cached = this.paths.get(session.sessionId);
    if (cached) return cached;
    const file = `${session.sessionId}.jsonl`;
    for (const root of session.root ? [session.root, ...roots.filter((r) => r !== session.root)] : roots) {
      const projects = `${root}/projects`;
      const expected = projectDir(session.cwd);
      const dirs = await list(projects);
      for (const dir of expected && dirs.includes(expected) ? [expected, ...dirs.filter((d) => d !== expected)] : dirs) {
        if ((await list(`${projects}/${dir}`)).includes(file)) {
          const path = `${projects}/${dir}/${file}`;
          this.paths.set(session.sessionId, path);
          return path;
        }
      }
    }
    return null;
  }

  /** The pending subagents of one agent: [] when none or when unsure. The transcript is read again only when
   *  the agent changed turn since the last read (or `recheck`): a session that did not take a turn did not
   *  start or end a subagent, apart from the time limit, which is applied to the saved answer. */
  async pending(candidate, roots, registry, now, recheck) {
    const kept = this.scans.get(candidate.address);
    if (kept && Number.isInteger(kept.turn) && kept.turn === candidate.turn && !recheck) {
      return this.alive(withShellStatus(kept.items, registry, kept.sessionId), now);
    }
    const info = await this.terminalInfo(candidate.address);
    if (!info) return [];
    const session = pickSession({ ...info, cwd: candidate.cwd ?? info.cwd }, registry);
    if (!session) return [];
    const path = await this.transcriptPath(session, roots);
    let items = [];
    if (path) {
      let body = "";
      try { body = await fs.readFile(path, "utf8"); } catch {}
      if (body.length <= MAX_TRANSCRIPT) items = scanTranscript(body);
    }
    this.scans.set(candidate.address, { turn: candidate.turn, sessionId: session.sessionId, items });
    return this.alive(withShellStatus(items, registry, session.sessionId), now);
  }

  alive(items, now) {
    return items.filter((p) => !p.since || now - p.since < this.ttlMs);
  }

  /** Looks at `candidates` ([{ address, turn, cwd }]: Claude agents that show as done or idle) and
   *  keeps `waits`. `recheck`: addresses whose transcript is read again even if the turn is the same.
   *  Returns true when the answer changed. */
  async refresh(candidates, now = Date.now(), recheck = new Set()) {
    const next = new Map(); // the old answer stays until the new one is ready, so a card does not flicker
    const here = new Set(candidates.map((c) => c.address));
    for (const address of this.scans.keys()) if (!here.has(address)) this.scans.delete(address);
    if (candidates.length) {
      const roots = await this.configRoots();
      const registry = await this.registry(roots);
      const results = await Promise.all(candidates.map((c) => this.pending(c, roots, registry, now, recheck.has(c.address)).catch(() => [])));
      candidates.forEach((c, i) => {
        if (results[i].length) next.set(c.address, { turn: c.turn, count: results[i].length, items: results[i] });
      });
    }
    const changed = JSON.stringify([...next]) !== JSON.stringify([...this.waits]);
    this.waits = next;
    return changed;
  }
}
