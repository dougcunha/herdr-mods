// Schedules: the presets of the form and a 5-field cron, in local time.
//
// Schedule: { kind, minutes, time, days, cron }
//   interval  every `minutes` minutes, counted from the last run (or the last save)
//   daily     every day at `time` ("HH:MM")
//   weekdays  at `time` on `days` (0 = Sunday ... 6 = Saturday)
//   cron      `cron`: "minute hour day-of-month month day-of-week"
//
// Cron fields accept *, n, a-b, lists (a,b) and steps (*/n, a-b/n). Day of week 7 is Sunday too.
// When both day fields are set (not *), a day matches when either field matches (as in cron).

const MINUTE = 60 * 1000;
const LIMITS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The set of values of 1 cron field, or null when the field is not valid. */
function field(text, [lo, hi]) {
  const out = new Set();
  for (const part of String(text).split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    let a = lo;
    let b = hi;
    if (m[1] !== "*") {
      const [x, y] = m[1].split("-").map(Number);
      a = x;
      b = y ?? (m[2] ? hi : x);
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (a < lo || b > hi || a > b || step < 1) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** A parsed cron expression, or null. */
export function parseCron(expr) {
  const parts = String(expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => field(p, LIMITS[i]));
  if (sets.some((s) => !s)) return null;
  if (sets[4].has(7)) sets[4].add(0);
  return { min: sets[0], hour: sets[1], dom: sets[2], mon: sets[3], dow: sets[4], domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

function matches(c, d) {
  if (!c.min.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.mon.has(d.getMonth() + 1)) return false;
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dow;
  if (c.dowAny) return dom;
  return dom || dow;
}

/** The first time after `afterMs` (exclusive) that the cron matches, within 1 year, or null. */
function cronNext(c, afterMs) {
  const d = new Date(afterMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const end = afterMs + 366 * 24 * 60 * MINUTE;
  while (d.getTime() <= end) {
    if (!c.mon.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (matches(c, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

const hhmm = (time) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return [Number(m[2]), Number(m[1])];
};

/** The schedule as a cron expression (interval: null). */
export function toCron(s) {
  if (!s) return null;
  if (s.kind === "cron") return String(s.cron ?? "").trim();
  const t = hhmm(s.time);
  if (!t) return null;
  if (s.kind === "daily") return `${t[0]} ${t[1]} * * *`;
  if (s.kind === "weekdays") {
    const days = (s.days ?? []).filter((d) => d >= 0 && d <= 6);
    return days.length ? `${t[0]} ${t[1]} * * ${[...days].sort().join(",")}` : null;
  }
  return null;
}

/** An error text for a schedule that cannot run, or "". */
export function scheduleError(s) {
  if (!s) return "No schedule.";
  if (s.kind === "interval") return Number(s.minutes) >= 1 ? "" : "Write 1 minute or more.";
  if (s.kind === "weekdays" && !(s.days ?? []).length) return "Choose 1 day or more.";
  if (s.kind !== "cron" && !hhmm(s.time)) return "Write the time as HH:MM.";
  return parseCron(toCron(s)) ? "" : "The cron expression is not valid.";
}

/**
 * The next time the schedule is due after `afterMs`, or null.
 * `base`: for an interval, the time it counts from (the last run, else the last save).
 */
export function nextDue(s, afterMs, base) {
  if (!s || scheduleError(s)) return null;
  if (s.kind === "interval") {
    const step = Number(s.minutes) * MINUTE;
    let t = (base ?? afterMs) + step;
    if (t <= afterMs) t += Math.ceil((afterMs - t + 1) / step) * step;
    return t;
  }
  return cronNext(parseCron(toCron(s)), afterMs);
}

/** The next `n` times after now. */
export function nextTimes(s, n, base) {
  const out = [];
  let t = Date.now();
  for (let i = 0; i < n; i++) {
    const next = nextDue(s, t, i === 0 ? base : t);
    if (next == null) break;
    out.push(next);
    t = next;
  }
  return out;
}

/** A short text for a schedule ("Every 30 min", "Mon-Fri 09:00"). */
export function describeSchedule(s) {
  if (!s) return "";
  if (s.kind === "interval") return `Every ${s.minutes} min`;
  if (s.kind === "daily") return `Daily ${s.time}`;
  if (s.kind === "weekdays") {
    const days = [...(s.days ?? [])].sort();
    const label = days.join(",") === "1,2,3,4,5" ? "Mon-Fri" : days.map((d) => DAY_NAMES[d]).join(" ");
    return `${label} ${s.time}`;
  }
  return `cron ${s.cron}`;
}

export { DAY_NAMES };

/** "Today 09:00", "Tomorrow 09:00", "Mon 12 09:00". */
export function whenText(ms) {
  if (ms == null) return "";
  const d = new Date(ms);
  const now = new Date();
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / (24 * 60 * MINUTE));
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff === -1) return `Yesterday ${time}`;
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} ${time}`;
}
