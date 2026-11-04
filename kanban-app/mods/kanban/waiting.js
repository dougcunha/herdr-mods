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

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
const text = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("\n") : "");

/** The background subagents of a transcript that have not finished.
 *  Returns [{ id, description, since }] (`since`: ms since the epoch, or 0). */
export function scanTranscript(transcript) {
  const calls = new Map(); // tool_use id -> description
  const agents = new Map(); // agentId -> { toolUseId, since, pending }
  for (const line of String(transcript).split("\n")) {
    if (line.startsWith('{"type":"api-request')) continue; // request dumps: big and of no use here
    if (line.includes('"type":"tool_use"') && AGENT_TOOLS.some((n) => line.includes(n))) {
      for (const block of parse(line)?.message?.content ?? []) {
        if (block?.type === "tool_use" && (block.name === "Agent" || block.name === "Task")) {
          calls.set(block.id, String(block.input?.description ?? "").trim());
        }
      }
    } else if (line.includes("Async agent launched") && line.includes('"tool_result"')) {
      const record = parse(line);
      const since = Date.parse(record?.timestamp ?? "") || 0;
      for (const block of record?.message?.content ?? []) {
        // Only the result of the Agent (or Task) tool counts: the output of a shell command can print the same words.
        const id = block?.type === "tool_result" && calls.has(block.tool_use_id) ? /agentId:\s*([A-Za-z0-9_-]+)/.exec(text(block.content))?.[1] : null;
        if (id) agents.set(id, { toolUseId: block.tool_use_id, since, last: since, pending: true });
      }
    } else if (line.includes("<task-notification>") && NOTIFY_RECORD.test(line)) {
      // The same notification shows several times (queue, delivery) and a record can hold more than one;
      // each is read on its own and the last one in the file wins.
      const at = Date.parse(/"timestamp":"([^"]+)"/.exec(line)?.[1] ?? "") || 0;
      for (const [block] of line.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
        const id = /<task-id>([^<\s]+)<\/task-id>/.exec(block)?.[1];
        const agent = id ? agents.get(id) : null;
        if (!agent) continue;
        agent.pending = INTERIM.test(block);
        agent.last = Math.max(agent.last, at);
      }
    }
  }
  return [...agents].filter(([, a]) => a.pending)
    .map(([id, a]) => ({ id, description: calls.get(a.toolUseId) ?? "", since: a.last || a.since }));
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
    if (kept && Number.isInteger(kept.turn) && kept.turn === candidate.turn && !recheck) return this.alive(kept.items, now);
    const info = await this.terminalInfo(candidate.address);
    if (!info) return [];
    const session = pickSession({ ...info, cwd: candidate.cwd ?? info.cwd }, registry);
    if (!session) return [];
    const path = await this.transcriptPath(session, roots);
    if (!path) return [];
    let body;
    try { body = await fs.readFile(path, "utf8"); } catch { return []; }
    if (body.length > MAX_TRANSCRIPT) return [];
    const items = scanTranscript(body);
    this.scans.set(candidate.address, { turn: candidate.turn, items });
    return this.alive(items, now);
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
