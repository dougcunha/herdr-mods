// Example data for the preview image and for tests:
// `herdr-app do github-clone.demo` shows it, a second run hides it.

const day = 86400000;
const now = Date.now();

const repo = (owner, name, { desc = "", lang = "", days = 3, priv = false, fork = false, archived = false } = {}) => ({
  full: `${owner}/${name}`, owner, name, private: priv, fork, archived, desc, lang, pushed: now - days * day, branch: "main",
});

export const DEMO = {
  account: {
    login: "you",
    orgs: ["acme-labs", "tiny-tools", "secure-corp"],
    fetchedAt: now - 4 * 60000,
    error: null,
    repos: [
      repo("you", "dotfiles", { desc: "Shell, editor and terminal settings", lang: "Shell", days: 1 }),
      repo("you", "herdr-mods", { desc: "Mods, layouts and themes for the Herdr app", lang: "JavaScript", days: 0.2 }),
      repo("you", "notes-cli", { desc: "Take notes from the terminal", lang: "Rust", days: 12 }),
      repo("you", "ray-tracer", { desc: "A small ray tracer, one weekend at a time", lang: "C++", days: 340 }),
      repo("you", "awesome-gpui", { desc: "A list of GPUI apps and libraries", lang: "", days: 40, fork: true }),
      repo("you", "budget", { desc: "Personal budget tracker", lang: "TypeScript", days: 6, priv: true }),
      repo("acme-labs", "api-gateway", { desc: "The gateway in front of every Acme service", lang: "Go", days: 0.5, priv: true }),
      repo("acme-labs", "design-system", { desc: "Components, tokens and icons of Acme apps", lang: "TypeScript", days: 2, priv: true }),
      repo("acme-labs", "mobile-app", { desc: "The Acme app for Android and iOS", lang: "Kotlin", days: 4, priv: true }),
      repo("acme-labs", "infra", { desc: "Terraform for the Acme cloud", lang: "HCL", days: 9, priv: true }),
      repo("acme-labs", "legacy-portal", { desc: "The old customer portal", lang: "PHP", days: 900, priv: true, archived: true }),
      repo("tiny-tools", "jsonfmt", { desc: "Format JSON fast, with colors", lang: "Rust", days: 20 }),
      repo("tiny-tools", "port-check", { desc: "Which program uses this port?", lang: "Go", days: 75 }),
    ],
  },
  search: [
    { ...repo("open-tools", "fast-grep", { desc: "A grep that skips what .gitignore skips", lang: "Rust", days: 1 }), stars: 18400 },
    { ...repo("termkit", "termkit", { desc: "Widgets for terminal apps", lang: "Go", days: 3 }), stars: 9200 },
    { ...repo("acme-labs", "design-system", { desc: "Components, tokens and icons of Acme apps", lang: "TypeScript", days: 2 }), stars: 310 },
    { ...repo("you", "notes-cli", { desc: "Take notes from the terminal", lang: "Rust", days: 12 }), stars: 42 },
  ],
  status: { "you/herdr-mods": "cloned", "you/dotfiles": "cloned", "acme-labs/infra": "used" },
};
