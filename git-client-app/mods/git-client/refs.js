// Reads of the Branches and Stash tabs, with no herdr imports so node can test them: branches,
// remote branches and tags in one for-each-ref, the remotes, the worktrees and the stashes.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "5m", "3h", "2d", "Mar 4", "Mar 2024".
export function ago(seconds, now = Date.now()) {
  if (!seconds) return "";
  const s = now / 1000 - seconds;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  const d = new Date(seconds * 1000);
  return d.getFullYear() === new Date(now).getFullYear() ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// One line per ref, its fields split by NUL. creatordate works for commits and annotated tags.
const FIELDS = ["%(refname)", "%(objectname)", "%(upstream:short)", "%(upstream:track)", "%(creatordate:unix)", "%(HEAD)", "%(contents:subject)"];
export const refsArgs = () => ["for-each-ref", "--sort=-creatordate", `--format=${FIELDS.join("%00")}`, "refs/heads", "refs/remotes", "refs/tags"];

export function parseTrack(track) {
  const t = String(track ?? "");
  return { gone: t.includes("gone"), ahead: Number(/ahead (\d+)/.exec(t)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(t)?.[1] ?? 0) };
}

export function parseRefs(text) {
  const out = { local: [], remote: [], tags: [] };
  for (const line of String(text ?? "").split("\n")) {
    const [ref, hash, upstream, track, time, head, ...subject] = line.split("\0");
    if (!ref || !hash) continue;
    const base = { hash, time: Number(time) || 0, subject: subject.join("\0") };
    if (ref.startsWith("refs/heads/")) out.local.push({ ...base, name: ref.slice(11), upstream: upstream || null, ...parseTrack(track), current: head === "*" });
    else if (ref.startsWith("refs/remotes/")) {
      const name = ref.slice(13), slash = name.indexOf("/");
      if (slash < 0 || name.endsWith("/HEAD")) continue;
      out.remote.push({ ...base, name, remote: name.slice(0, slash), branch: name.slice(slash + 1) });
    } else if (ref.startsWith("refs/tags/")) out.tags.push({ ...base, name: ref.slice(10) });
  }
  // The checked-out branch first, then the newest.
  out.local.sort((a, b) => Number(b.current) - Number(a.current));
  return out;
}

// `git remote -v`: "name\turl (fetch)" and "name\turl (push)".
export function parseRemotes(text) {
  const map = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = /^(\S+)\t(.+?) \((fetch|push)\)$/.exec(line.trim());
    if (!m) continue;
    const r = map.get(m[1]) ?? { name: m[1], url: "", pushUrl: "" };
    if (m[3] === "fetch") r.url = m[2]; else r.pushUrl = m[2];
    map.set(m[1], r);
  }
  return [...map.values()];
}

// `git worktree list --porcelain`: blocks of "worktree <path>", "HEAD <hash>", "branch <ref>",
// "detached", "bare", "locked [reason]", "prunable [reason]", split by an empty line.
export function parseWorktrees(text) {
  const out = [];
  let w = null;
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("worktree ")) { w = { path: line.slice(9).trim(), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false }; out.push(w); continue; }
    if (!w) continue;
    if (line.startsWith("HEAD ")) w.head = line.slice(5).trim();
    else if (line.startsWith("branch ")) w.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
    else if (line === "detached") w.detached = true;
    else if (line === "bare") w.bare = true;
    else if (line.startsWith("locked")) w.locked = true;
    else if (line.startsWith("prunable")) w.prunable = true;
  }
  out.forEach((x, i) => { x.main = i === 0; });
  return out;
}

const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
export const samePath = (a, b, windows = /^[a-zA-Z]:/.test(String(a ?? ""))) => (windows ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b));

// The folder of a new worktree: <repo>-<branch> next to the repository.
export function worktreePath(root, branch) {
  const r = norm(root), slash = r.lastIndexOf("/");
  return `${r.slice(0, slash + 1)}${r.slice(slash + 1)}-${String(branch).replace(/[\\/:*?"<>|\s]+/g, "-")}`;
}

// ---- File history: the commits that changed a file, following renames, each with the path it had there.
export const fileLogArgs = (path, limit = 300) => ["log", "--follow", `-n${limit}`, "--name-only", "--format=%x1e%H%x00%an%x00%at%x00%s", "--", path];
export function parseFileLog(text) {
  return String(text ?? "").split("\x1e").map((block) => {
    const [head, ...rest] = block.split("\n");
    const [hash, author, time, ...subject] = (head ?? "").split("\0");
    if (!/^[0-9a-f]{40,64}$/.test(hash ?? "")) return null;
    return { hash, author, time: Number(time) || 0, subject: subject.join("\0"), path: rest.map((l) => l.trim()).find(Boolean) ?? null };
  }).filter(Boolean);
}

// ---- Blame: `git blame --porcelain`. Each line: "<hash> <orig> <final> [<count>]", then the fields of the
// commit the first time it shows ("author …", "author-time …", "summary …"), then "\t<text>".
export const blameArgs = (path) => ["blame", "--porcelain", "--", path];
export function parseBlame(text) {
  const commits = new Map(), rows = [];
  let cur = null;
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("\t")) {
      if (!cur) continue;
      const c = commits.get(cur.hash);
      const prev = rows[rows.length - 1];
      rows.push({ hash: cur.hash, number: cur.final, text: line.slice(1) || " ", author: c.author, time: c.time, summary: c.summary,
        first: !prev || prev.hash !== cur.hash, uncommitted: /^0+$/.test(cur.hash) });
      cur = null;
      continue;
    }
    const m = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/.exec(line);
    if (m) { cur = { hash: m[1], final: Number(m[3]) }; if (!commits.has(m[1])) commits.set(m[1], { author: "", time: 0, summary: "" }); continue; }
    if (!cur) continue;
    const c = commits.get(cur.hash), sp = line.indexOf(" "), key = sp < 0 ? line : line.slice(0, sp), value = sp < 0 ? "" : line.slice(sp + 1);
    if (key === "author") c.author = value;
    else if (key === "author-time") c.time = Number(value) || 0;
    else if (key === "summary") c.summary = value;
  }
  return rows;
}

// ---- Submodules: `git submodule status --recursive` ("<state><hash> <path>[ (<describe>)]"; state " " ok,
// "-" not initialized, "+" another commit than the recorded one, "U" in conflict) and the .gitmodules config.
export const submoduleStatusArgs = () => ["submodule", "status", "--recursive"];
export const gitmodulesArgs = () => ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.(path|url|branch)$"];
const STATES = { " ": "ok", "-": "uninitialized", "+": "out of sync", U: "conflict" };
export function parseSubmodules(statusText, configText = "") {
  const config = new Map(); // name → { path, url, branch }
  for (const line of String(configText ?? "").split("\n")) {
    const m = /^submodule\.(.+)\.(path|url|branch) (.*)$/.exec(line.trim());
    if (!m) continue;
    const c = config.get(m[1]) ?? { name: m[1] };
    c[m[2]] = m[3];
    config.set(m[1], c);
  }
  const byPath = new Map([...config.values()].filter((c) => c.path).map((c) => [c.path, c]));
  return String(statusText ?? "").split("\n").map((line) => {
    const m = /^([ +\-U])([0-9a-f]{40,64}) (.+?)(?: \((.*)\))?$/.exec(line);
    if (!m) return null;
    const c = byPath.get(m[3]);
    return { path: m[3], hash: m[2], state: STATES[m[1]], describe: m[4] ?? null, name: c?.name ?? m[3], url: c?.url ?? null, branch: c?.branch ?? null, nested: !byPath.has(m[3]) };
  }).filter(Boolean);
}
// The folder a new submodule gets from its URL: "https://x/y/lib.git" → "lib".
export const submoduleFolder = (url) => String(url ?? "").replace(/[\\/]+$/, "").split(/[\\/:]/).pop().replace(/\.git$/, "") || "submodule";

export const STASH_FORMAT = "%gd%x00%H%x00%ct%x00%gs";
export const stashListArgs = () => ["stash", "list", `--format=${STASH_FORMAT}`];
export function parseStashes(text) {
  return String(text ?? "").split("\n").map((line) => {
    const [ref, hash, time, ...subject] = line.split("\0");
    if (!/^stash@\{\d+\}$/.test(ref ?? "") || !hash) return null;
    const s = subject.join("\0"), m = /^(?:WIP on|On) ([^:]+): (.*)$/.exec(s);
    return { ref, hash, time: Number(time) || 0, branch: m?.[1] ?? null, message: m ? m[2] : s };
  }).filter(Boolean);
}

export const stashShowArgs = (ref, untracked = true) => ["stash", "show", "-p", "--no-color", "--no-ext-diff", "--no-textconv", ...(untracked ? ["--include-untracked"] : []), ref];

// A patch of many files cut into one patch per file, with its counts.
export function splitFiles(text) {
  const files = [];
  let cur = null;
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("diff --git ")) { cur = { path: "", status: "M", add: 0, del: 0, lines: [line] }; files.push(cur); continue; }
    if (!cur) continue;
    cur.lines.push(line);
    if (line.startsWith("new file mode")) cur.status = "A";
    else if (line.startsWith("deleted file mode")) cur.status = "D";
    else if (line.startsWith("+++ ") && line !== "+++ /dev/null") cur.path = line.slice(6);
    else if (line.startsWith("--- ") && line !== "--- /dev/null" && !cur.path) cur.path = line.slice(6);
    else if (line.startsWith("+") && !line.startsWith("+++")) cur.add++;
    else if (line.startsWith("-") && !line.startsWith("---")) cur.del++;
  }
  for (const f of files) {
    if (!f.path) f.path = (/^diff --git a\/(.+) b\//.exec(f.lines[0])?.[1]) ?? "?";
    f.text = f.lines.join("\n"); delete f.lines;
  }
  return files;
}
