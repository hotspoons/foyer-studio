// Theme system — mirrors Patapsco's `[data-theme="..."]` CSS scopes +
// localStorage persistence + 'auto' (system preference) mode.
//
// Public API: getTheme, setTheme, cycleTheme, applyTheme, THEMES, THEME_META,
// onThemeChange. Call applyTheme() once on boot; subsequent setTheme/cycle
// calls reapply automatically.

export const THEMES = ["dim", "dark", "light", "auto"];

export const THEME_META = {
  dim:   { icon: "sparkles",         label: "Dim" },
  dark:  { icon: "moon",             label: "Dark" },
  light: { icon: "sun",              label: "Light" },
  auto:  { icon: "computer-desktop", label: "Auto" },
};

const STORAGE_KEY = "foyer.theme";
const EVT = "foyer:theme-change";

export function getTheme() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && THEMES.includes(raw)) return raw;
  } catch {}
  return "dim";
}

/** Resolve "auto" to a concrete theme using prefers-color-scheme. */
export function effectiveTheme(raw) {
  const t = raw || getTheme();
  if (t === "auto") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dim"
      : "light";
  }
  return t;
}

export function setTheme(name) {
  if (!THEMES.includes(name)) return;
  try { localStorage.setItem(STORAGE_KEY, name); } catch {}
  applyTheme();
  window.dispatchEvent(new CustomEvent(EVT, { detail: { theme: name } }));
}

export function cycleTheme() {
  const cur = getTheme();
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  setTheme(next);
  return next;
}

export function applyTheme() {
  document.documentElement.setAttribute("data-theme", effectiveTheme());
}

export function onThemeChange(fn) {
  window.addEventListener(EVT, fn);
  return () => window.removeEventListener(EVT, fn);
}

/** Auto-respond to system preference changes when the theme is 'auto'. */
if (typeof window !== "undefined" && window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener?.("change", () => {
    if (getTheme() === "auto") applyTheme();
  });
}
