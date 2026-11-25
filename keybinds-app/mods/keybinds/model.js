// Pure domain model for Keybinds: chord normalization, keys.json parsing/serialization,
// action canonicalization and labeling, Quick Actions integration, and conflict analysis.

const MOD_ORDER = ["ctrl", "alt", "shift", "cmd"];
const MOD_ALIASES = {
  control: "ctrl",
  ctrl: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  cmd: "cmd",
  command: "cmd",
  platform: "cmd",
  super: "cmd",
  win: "cmd",
  meta: "cmd",
  secondary: "cmd",
};
const LONE_MODIFIERS = new Set([
  "control", "ctrl", "shift", "alt", "option", "platform", "function", "fn", "meta", "super", "cmd", "command",
]);

/** Keys that terminal programs rely on (Ctrl+C, Ctrl+R, etc.). */
export const TERMINAL_CTRL_KEYS = new Set([
  "ctrl-c", "ctrl-d", "ctrl-l", "ctrl-r", "ctrl-w",
  "ctrl-a", "ctrl-e", "ctrl-u", "ctrl-k", "ctrl-z", "ctrl-[",
]);

/** Common escape sequence presets for the Send Text binding mode. */
export const SEND_PRESETS = [
  { id: "word-left", label: "Word left", value: "\u001bb", display: "\\u001bb" },
  { id: "word-right", label: "Word right", value: "\u001bf", display: "\\u001bf" },
  { id: "del-word", label: "Delete word", value: "\u0017", display: "\\u0017" },
  { id: "clear-line", label: "Clear line", value: "\u0015", display: "\\u0015" },
  { id: "interrupt", label: "Ctrl+C", value: "\u0003", display: "\\u0003" },
  { id: "esc", label: "Escape", value: "\u001b", display: "\\u001b" },
];

export const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "quick-actions", label: "Quick Actions" },
  { id: "spaces", label: "Spaces", re: /^space\./ },
  { id: "tabs", label: "Tabs", re: /^tab\./ },
  { id: "panes", label: "Panes", re: /^pane\./ },
  { id: "agents", label: "Agents", re: /^agent\./ },
  { id: "terminal", label: "Terminal", re: /^terminal\.|^send:|^terminal$/ },
  { id: "layout", label: "Layout & View", re: /^layout\.|^app\.(theme|zoom_|welcome|whats_new|reset)/ },
  { id: "mods", label: "Mods" },
  { id: "app", label: "App & Window", re: /^app\.|^window\./ },
  { id: "unbound", label: "Unbound" },
  { id: "warnings", label: "Warnings" },
];

const KEY_LABELS = {
  pagedown: "PgDn",
  pageup: "PgUp",
  backspace: "⌫",
  delete: "Del",
  escape: "Esc",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  space: "Space",
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
  home: "Home",
  end: "End",
  insert: "Ins",
};

/** Splits a single stroke like "ctrl-shift--" into { mods: string[], key: string }. */
function splitStroke(stroke) {
  const s = String(stroke ?? "").trim();
  if (!s) return { mods: [], key: "" };
  const parts = s.split("-");
  let key = parts.pop();
  if (key === "") {
    // Trailing '-' means the key itself is '-' (e.g. "ctrl--" or "-").
    key = "-";
    if (parts.length && parts[parts.length - 1] === "") parts.pop();
  }
  return { mods: parts, key: key ?? "" };
}

/** Canonicalizes a chord string ("Shift-Control-T" -> "ctrl-shift-t"). */
export function normalizeChord(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  return s.split(/\s+/).map((stroke) => {
    const { mods, key } = splitStroke(stroke);
    const held = new Set();
    for (const m of mods) {
      const canon = MOD_ALIASES[m.toLowerCase()];
      if (canon) held.add(canon);
    }
    const ordered = MOD_ORDER.filter((m) => held.has(m));
    const k = key.length === 1 && /[A-Z]/.test(key) ? key.toLowerCase() : key.toLowerCase();
    return k ? [...ordered, k].join("-") : ordered.join("-");
  }).filter(Boolean).join(" ");
}

/** True when a chord requires the macOS Command modifier. */
export function isMacChord(chord) {
  const norm = normalizeChord(chord);
  return norm.split(/\s+/).some((stroke) => splitStroke(stroke).mods.includes("cmd"));
}

/** Converts a GPUI KeyEvent to a normalized chord or a { blocked } reason. */
export function chordOfEvent(event, section = "global") {
  const rawKey = String(event?.key ?? "").trim();
  if (!rawKey) return null;
  const keyLower = rawKey.toLowerCase();
  if (LONE_MODIFIERS.has(keyLower)) return null;

  let chord = "";
  const strokeRaw = typeof event?.keystroke === "string" ? event.keystroke.trim() : "";
  if (strokeRaw) {
    chord = normalizeChord(strokeRaw);
  }
  if (!chord) {
    const m = event?.modifiers ?? {};
    const mods = [];
    if (m.control) mods.push("ctrl");
    if (m.alt) mods.push("alt");
    if (m.shift) mods.push("shift");
    if (m.platform) mods.push("cmd");
    chord = [...mods, keyLower].join("-");
  }

  if (chord === "ctrl-alt-shift-escape") {
    return { blocked: "Ctrl+Alt+Shift+Esc is Herdr's built-in escape hatch and cannot be bound." };
  }
  const parsed = splitStroke(chord);
  const isFn = /^f([1-9]|1[0-9]|2[0-4])$/.test(parsed.key);
  const isModSection = String(section).startsWith("mod:");
  if (parsed.mods.length === 0 && !isFn && !isModSection) {
    return { blocked: "Add Ctrl, Alt, or Shift (or use F1–F24) outside mod:* sections." };
  }
  return { chord };
}

/** Breaks a chord into individual display tokens for keycap rendering. */
export function chordTokens(chord, platform = "windows") {
  const norm = normalizeChord(chord);
  if (!norm) return [];
  const mac = platform === "macos";
  const modNames = mac
    ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" }
    : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super" };

  const tokens = [];
  const strokes = norm.split(/\s+/);
  strokes.forEach((stroke, idx) => {
    if (idx > 0) tokens.push("then");
    const { mods, key } = splitStroke(stroke);
    for (const m of mods) {
      if (modNames[m]) tokens.push(modNames[m]);
    }
    if (key) {
      const kLabel = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
      tokens.push(kLabel);
    }
  });
  return tokens;
}

/** Human-readable chord string ("Ctrl+Shift+T" or "⌃⇧T"). */
export function prettyChord(chord, platform = "windows") {
  const mac = platform === "macos";
  return chordTokens(chord, platform).join(mac ? "" : "+");
}

/** Returns "global" | "terminal" | "layout" | "mod". */
export function sectionKind(section) {
  if (section === "global") return "global";
  if (section === "terminal") return "terminal";
  if (String(section).startsWith("layout:")) return "layout";
  if (String(section).startsWith("mod:")) return "mod";
  return "global";
}

/** Human label for a keys.json section. */
export function sectionLabel(section) {
  if (section === "global") return "Global";
  if (section === "terminal") return "Terminal";
  if (section.startsWith("layout:")) return `Layout: ${section.slice(7)}`;
  if (section.startsWith("mod:")) return `Mod: ${section.slice(4)}`;
  return section;
}

/** Sortable canonical JSON with sorted object keys for deterministic comparison. */
function stableStringify(val) {
  if (val === null || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(stableStringify).join(",")}]`;
  const keys = Object.keys(val).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(val[k])}`).join(",")}}`;
}

/** Deterministic string identifier for any string or object ActionSpec. */
export function actionKey(spec) {
  if (typeof spec === "string") return `str:${spec}`;
  if (spec && typeof spec === "object") return `obj:${stableStringify(spec)}`;
  return `str:${String(spec ?? "")}`;
}

/** Extracts the command name from either string or object ActionSpec. */
export function commandNameOf(spec) {
  if (spec && typeof spec === "object") return String(spec.command ?? "");
  const s = String(spec ?? "");
  if (s.startsWith("send:") || s === "terminal") return s;
  const idx = s.indexOf(":");
  return idx >= 0 ? s.slice(0, idx) : s;
}

/** Raw display representation of an ActionSpec for subtitles and search. */
export function formatActionRaw(spec) {
  if (typeof spec === "string") return spec;
  if (spec && typeof spec === "object") {
    const args = spec.args && Object.keys(spec.args).length ? ` ${JSON.stringify(spec.args)}` : "";
    return `${spec.command ?? ""}${args}`;
  }
  return String(spec ?? "");
}

/** Escapes control chars for readable display of `send:` actions. */
export function escapeForDisplay(text) {
  let out = "";
  for (const ch of String(text ?? "")) {
    const code = ch.charCodeAt(0);
    if (code === 0x1b) out += "\\u001b";
    else if (code === 0x17) out += "\\u0017";
    else if (code === 0x15) out += "\\u0015";
    else if (code === 0x03) out += "\\u0003";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 32) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out;
}

/** Parses escape sequences typed in the Send Text field (\u001b, \x1b, \n, \r, \t). */
export function unescapeSendInput(text) {
  return String(text ?? "")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

/** Parses keys.json text into { sections, parseError }. */
export function parseDocument(rawText) {
  if (!rawText || !String(rawText).trim()) return { sections: { global: {} }, parseError: null };
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    return { sections: { global: {} }, parseError: `keys.json is invalid JSON: ${e?.message ?? e}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { sections: { global: {} }, parseError: "keys.json root must be a JSON object." };
  }
  const sections = {};
  for (const [sec, map] of Object.entries(parsed)) {
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    const clean = {};
    for (const [chord, action] of Object.entries(map)) {
      const norm = normalizeChord(chord);
      if (!norm) continue;
      if (typeof action === "string" || (action && typeof action === "object" && typeof action.command === "string")) {
        clean[norm] = action;
      }
    }
    sections[sec] = clean;
  }
  if (!sections.global) sections.global = {};
  return { sections, parseError: null };
}

/** Deep-clones sections cleanly. */
export function cloneSections(sections) {
  const out = {};
  for (const [sec, map] of Object.entries(sections ?? {})) {
    out[sec] = {};
    for (const [chord, action] of Object.entries(map ?? {})) {
      out[sec][chord] = typeof action === "object" && action !== null ? JSON.parse(JSON.stringify(action)) : action;
    }
  }
  if (!out.global) out.global = {};
  return out;
}

/** Serializes sections back to formatted JSON, preserving global even if empty. */
export function serializeDocument(sections) {
  const out = {};
  const keys = Object.keys(sections ?? {});
  const ordered = [
    ...(keys.includes("global") ? ["global"] : []),
    ...(keys.includes("terminal") ? ["terminal"] : []),
    ...keys.filter((k) => k !== "global" && k !== "terminal").sort(),
  ];
  for (const sec of ordered) {
    const entries = sections[sec] ?? {};
    if (sec !== "global" && Object.keys(entries).length === 0) continue;
    out[sec] = entries;
  }
  if (!out.global) out.global = {};
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Determines functional sidebar category for an ActionSpec. */
export function categoryOf(spec, commandMap) {
  const cmd = commandNameOf(spec);
  if (cmd.startsWith("quick-actions.run-")) return "quick-actions";
  if (cmd === "mod.open") return "mods";
  for (const cat of CATEGORIES) {
    if (cat.re && cat.re.test(cmd)) return cat.id;
  }
  if (cmd.includes(".") && !commandMap.has(cmd)) return "mods";
  return "app";
}

function titleWords(s) {
  return String(s ?? "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Resolves human-friendly label, description, icon and metadata for an ActionSpec. */
export function describeAction(spec, commandMap, quickActionsMap, modTitlesMap) {
  const raw = formatActionRaw(spec);
  if (typeof spec === "string" && spec === "terminal") {
    return {
      label: "Pass key to terminal program",
      description: "Forwards the keystroke directly to the shell or program running in the terminal.",
      raw,
      iconPath: null,
      orphaned: false,
    };
  }
  if (typeof spec === "string" && spec.startsWith("send:")) {
    const seq = escapeForDisplay(spec.slice(5));
    return {
      label: `Send "${seq}"`,
      description: "Types this sequence directly into the focused terminal.",
      raw,
      iconPath: null,
      orphaned: false,
    };
  }

  const cmd = commandNameOf(spec);
  if (cmd.startsWith("quick-actions.run-")) {
    const id = cmd.slice("quick-actions.run-".length);
    const qa = quickActionsMap.get(id);
    if (qa) {
      const where = qa.where === "tab" ? "new tab" : qa.where === "background" ? "background" : "terminal";
      const scope = qa.filter?.trim() ? ` · only in ${qa.filter.trim()}` : "";
      return {
        label: qa.name || `(Unnamed Quick Action ${id})`,
        description: `Quick Action · runs in ${where}${scope}`,
        raw,
        iconPath: `mods/quick-actions/${qa.icon || "zap"}.svg`,
        orphaned: false,
        quickActionId: id,
      };
    }
    return {
      label: `Missing Quick Action (${id})`,
      description: "This shortcut points to a Quick Action that no longer exists in data/quick-actions.json.",
      raw,
      iconPath: null,
      orphaned: true,
      quickActionId: id,
    };
  }

  if (cmd === "mod.open") {
    const modName = typeof spec === "object" ? String(spec.args?.name ?? "") : spec.slice("mod.open:".length);
    const title = modTitlesMap[modName] || titleWords(modName);
    return {
      label: `Open ${title}`,
      description: `Opens the ${modName} mod overlay.`,
      raw,
      iconPath: null,
      orphaned: false,
    };
  }

  const meta = commandMap.get(cmd);
  if (meta) {
    let suffix = "";
    if (typeof spec === "string" && spec.includes(":")) suffix = ` (${spec.slice(spec.indexOf(":") + 1)})`;
    else if (typeof spec === "object" && spec.args && Object.keys(spec.args).length) {
      const first = Object.entries(spec.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
      suffix = ` (${first})`;
    }
    return {
      label: `${titleWords(cmd)}${suffix}`,
      description: meta.about || "",
      raw,
      iconPath: null,
      orphaned: false,
    };
  }

  const dot = cmd.indexOf(".");
  if (dot > 0) {
    const modName = cmd.slice(0, dot);
    const sub = cmd.slice(dot + 1);
    const title = modTitlesMap[modName] || titleWords(modName);
    return {
      label: `${title}: ${titleWords(sub)}`,
      description: `Mod command sent to ${modName}.`,
      raw,
      iconPath: null,
      orphaned: false,
    };
  }

  return {
    label: titleWords(raw),
    description: "",
    raw,
    iconPath: null,
    orphaned: false,
  };
}

/** Checks safety warnings (terminal control keys & Windows AltGr) for a chord in a section. */
export function safetyWarnings(section, chord, action, platform = "windows") {
  const warnings = [];
  const norm = normalizeChord(chord);
  const kind = sectionKind(section);
  if (kind !== "mod" && TERMINAL_CTRL_KEYS.has(norm) && action !== "terminal") {
    warnings.push("terminal_key");
  }
  if (platform === "windows") {
    const { mods } = splitStroke(norm.split(/\s+/)[0]);
    if (mods.includes("ctrl") && mods.includes("alt") && !mods.includes("cmd")) {
      warnings.push("altgr");
    }
  }
  return warnings;
}

/** Computes same-section conflicts, cross-section precedence overlaps, and safety warnings. */
export function analyzeConflict(sections, targetSection, chord, { replacingChord = null, targetActionKey = null, targetAction = null, platform = "windows" } = {}) {
  const norm = normalizeChord(chord);
  const secMap = sections[targetSection] ?? {};
  const existing = secMap[norm];
  let sameSection = null;
  if (existing !== undefined && actionKey(existing) !== targetActionKey) {
    sameSection = {
      chord: norm,
      otherAction: existing,
      otherActionKey: actionKey(existing),
      canSwap: Boolean(replacingChord && normalizeChord(replacingChord) !== norm),
    };
  }

  const crossSection = [];
  const kind = sectionKind(targetSection);
  const allSecs = Object.keys(sections);
  const checkOther = (sec, relation) => {
    const act = sections[sec]?.[norm];
    if (act !== undefined) crossSection.push({ section: sec, otherAction: act, relation });
  };

  if (kind === "global") {
    if (allSecs.includes("terminal")) checkOther("terminal", "shadowed_by");
    for (const s of allSecs) if (s.startsWith("layout:")) checkOther(s, "shadowed_by");
  } else if (kind === "layout") {
    if (allSecs.includes("terminal")) checkOther("terminal", "shadowed_by");
    if (allSecs.includes("global")) checkOther("global", "overrides");
  } else if (kind === "terminal") {
    for (const s of allSecs) if (s.startsWith("layout:")) checkOther(s, "overrides");
    if (allSecs.includes("global")) checkOther("global", "overrides");
  }

  const warnings = safetyWarnings(targetSection, norm, targetAction, platform);
  return { sameSection, crossSection, warnings };
}

/** Projects KeymapDocument + commands() + Quick Actions into displayable BindingRows. */
export function buildRows({ sections, commands, quickActions, modTitles, showMac, platform }) {
  const commandMap = new Map((commands ?? []).map((c) => [c.name, c]));
  const quickActionsMap = new Map((quickActions ?? []).map((q) => [q.id, q]));
  const hideMac = platform !== "macos" && !showMac;

  const rows = [];
  const boundActions = new Set();
  const boundQuickIds = new Set();
  let hiddenMacBindings = 0;

  for (const [section, map] of Object.entries(sections ?? {})) {
    const byAction = new Map();
    for (const [chord, action] of Object.entries(map ?? {})) {
      const aKey = actionKey(action);
      boundActions.add(commandNameOf(action));
      const cmdName = commandNameOf(action);
      if (cmdName.startsWith("quick-actions.run-")) boundQuickIds.add(cmdName.slice("quick-actions.run-".length));

      if (!byAction.has(aKey)) byAction.set(aKey, { action, aKey, chords: [] });
      byAction.get(aKey).chords.push(chord);
    }

    for (const group of byAction.values()) {
      const visibleChords = [];
      const hiddenMacChords = [];
      for (const c of group.chords) {
        if (hideMac && isMacChord(c)) {
          hiddenMacChords.push(c);
          hiddenMacBindings++;
        } else {
          visibleChords.push(c);
        }
      }
      if (visibleChords.length === 0 && hiddenMacChords.length > 0) continue;

      const desc = describeAction(group.action, commandMap, quickActionsMap, modTitles);
      const category = categoryOf(group.action, commandMap);

      const shadowList = [];
      const warnSet = new Set();
      if (desc.orphaned) warnSet.add("orphaned");
      for (const c of visibleChords) {
        const rep = analyzeConflict(sections, section, c, { targetActionKey: group.aKey, targetAction: group.action, platform });
        for (const cs of rep.crossSection) shadowList.push({ chord: c, ...cs });
        for (const w of rep.warnings) warnSet.add(w);
      }
      if (shadowList.length) warnSet.add("shadow");

      rows.push({
        id: `${section}::${group.aKey}`,
        section,
        action: group.action,
        actionKey: group.aKey,
        category,
        label: desc.label,
        description: desc.description,
        raw: desc.raw,
        iconPath: desc.iconPath,
        orphaned: desc.orphaned,
        quickActionId: desc.quickActionId ?? null,
        chords: visibleChords,
        hiddenMacChords,
        bound: true,
        shadows: shadowList,
        warnings: [...warnSet],
      });
    }
  }

  // Unbound Quick Actions
  for (const qa of quickActions ?? []) {
    if (boundQuickIds.has(qa.id)) continue;
    const action = `quick-actions.run-${qa.id}`;
    const desc = describeAction(action, commandMap, quickActionsMap, modTitles);
    rows.push({
      id: `global::${actionKey(action)}`,
      section: "global",
      action,
      actionKey: actionKey(action),
      category: "quick-actions",
      label: desc.label,
      description: desc.description,
      raw: desc.raw,
      iconPath: desc.iconPath,
      orphaned: false,
      quickActionId: qa.id,
      chords: [],
      hiddenMacChords: [],
      bound: false,
      shadows: [],
      warnings: [],
    });
  }

  // Unbound built-in Herdr commands
  for (const cmd of commands ?? []) {
    if (boundActions.has(cmd.name)) continue;
    const action = cmd.name;
    const desc = describeAction(action, commandMap, quickActionsMap, modTitles);
    rows.push({
      id: `global::${actionKey(action)}`,
      section: "global",
      action,
      actionKey: actionKey(action),
      category: categoryOf(action, commandMap),
      label: desc.label,
      description: desc.description,
      raw: desc.raw,
      iconPath: null,
      orphaned: false,
      quickActionId: null,
      chords: [],
      hiddenMacChords: [],
      bound: false,
      shadows: [],
      warnings: [],
    });
  }

  return { rows, hiddenMacBindings };
}

/** Pure mutation: adds, edits or swaps a single chord without disturbing other aliases. */
export function setBinding(sections, { section, chord, action, oldChord = null, mode = "replace", removeFromSections = [] }) {
  const next = cloneSections(sections);
  const norm = normalizeChord(chord);
  const oldNorm = oldChord ? normalizeChord(oldChord) : null;
  if (!next[section]) next[section] = {};

  const displaced = next[section][norm];
  if (oldNorm && oldNorm !== norm) {
    delete next[section][oldNorm];
    if (mode === "swap" && displaced !== undefined) {
      next[section][oldNorm] = displaced;
    }
  }

  next[section][norm] = action;
  for (const otherSec of removeFromSections) {
    if (otherSec !== section && next[otherSec]) delete next[otherSec][norm];
  }
  return next;
}

/** Pure mutation: deletes a single chord in a single section. */
export function removeBinding(sections, { section, chord }) {
  const next = cloneSections(sections);
  const norm = normalizeChord(chord);
  if (next[section]) delete next[section][norm];
  return next;
}
