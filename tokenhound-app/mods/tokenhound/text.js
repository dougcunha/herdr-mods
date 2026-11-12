// The texts of the mod in English and Portuguese, and the countdowns.
// The texts that come from TokenHound (row labels, status messages) are in English.

export const STR = {
  en: {
    title: "TokenHound",
    live: "Live",
    stale: "Not updated",
    stopped: "TokenHound closed",
    missing: "TokenHound not found",
    error: "Feed unreadable",
    newer: "Update this mod",
    unsupported: "Windows only",
    loading: "Reading…",
    staleHint: "TokenHound has not written the feed for {age}. It may have stopped.",
    stoppedHint: "TokenHound exited. Start it to see live quotas.",
    missingHint: "Install and start TokenHound 0.1.16 or newer. It writes %LOCALAPPDATA%\\TokenHound\\hud.json.",
    errorHint: "The feed file is not valid JSON: {error}",
    newerHint: "TokenHound writes feed version {version}. This mod reads version {known}. Update the TokenHound mod.",
    unsupportedHint: "TokenHound runs on Windows only.",
    empty: "No provider has a reading yet.",
    updated: "Updated {age} ago",
    busy: "Busy",
    session: "Session",
    weekly: "Week",
    off: "off",
    resetsNow: "Resets now",
    resetsIn: "Resets in {time}",
    used: "{pct} used",
    clickHint: "Click to show the quotas.",
    minimize: "Minimize",
    expand: "Expand",
    hideProvider: "Hide this provider",
    close: "Close",
    showProvider: "Show this provider again",
    hiddenLabel: "Hidden:",
    hiddenCount: "{n} hidden",
    showAll: "Show the hidden providers",
  },
  pt: {
    title: "TokenHound",
    live: "Ao vivo",
    stale: "Sem atualização",
    stopped: "TokenHound fechado",
    missing: "TokenHound não encontrado",
    error: "Feed ilegível",
    newer: "Atualize este mod",
    unsupported: "Só Windows",
    loading: "Lendo…",
    staleHint: "O TokenHound não grava o feed há {age}. Ele pode ter parado.",
    stoppedHint: "O TokenHound fechou. Abra o app para ver as cotas ao vivo.",
    missingHint: "Instale e abra o TokenHound 0.1.16 ou mais novo. Ele grava %LOCALAPPDATA%\\TokenHound\\hud.json.",
    errorHint: "O arquivo do feed não é um JSON válido: {error}",
    newerHint: "O TokenHound grava a versão {version} do feed. Este mod lê a versão {known}. Atualize o mod TokenHound.",
    unsupportedHint: "O TokenHound roda só no Windows.",
    empty: "Nenhum provider tem leitura ainda.",
    updated: "Atualizado há {age}",
    busy: "Ativo",
    session: "Sessão",
    weekly: "Semana",
    off: "desl.",
    resetsNow: "Reinicia agora",
    resetsIn: "Reinicia em {time}",
    used: "{pct} usado",
    clickHint: "Clique para ver as cotas.",
    minimize: "Minimizar",
    expand: "Expandir",
    hideProvider: "Ocultar este provider",
    close: "Fechar",
    showProvider: "Mostrar este provider de novo",
    hiddenLabel: "Ocultos:",
    hiddenCount: "{n} ocultos",
    showAll: "Mostrar os providers ocultos",
  },
};

/** Replaces {name} with vars.name. */
export const fill = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_m, k) => (k in vars ? String(vars[k]) : `{${k}}`));

/** A duration as the HUD writes it: 2d 3h, 4h 10m, 7m, 12s. */
export function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The countdown to a reset, live: "Resets in 2h 10m". Null without a reset time. */
export function countdown(str, resetIso, now = Date.now()) {
  const at = Date.parse(resetIso ?? "");
  if (!Number.isFinite(at)) return null;
  const left = at - now;
  if (left <= 0) return str.resetsNow;
  return fill(str.resetsIn, { time: duration(Math.max(60000, left)) });
}
