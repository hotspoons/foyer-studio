// Recent sessions — browser-local list of paths the user has opened.
//
// Stored per-browser so remote collaborators working on shared sidecars
// don't see each other's recent lists (Decision on 2026-04-22). The
// sidecar keeps the authoritative session list for what's currently
// open; this only tracks history (most recently used, regardless of
// whether it's open right now).
//
// Schema in localStorage under `foyer.recents.v1`:
//
//   [
//     { path: "/abs/path/to/session.ardour",
//       name: "Session Name",
//       opened_at: 1714000000,
//       backend_id: "ardour" },
//     ...
//   ]
//
// Ordering: most-recent first. Capped by `recentsCap()` (configurable
// via the settings panel under `foyer.recents.cap`, default 10).

const KEY = "foyer.recents.v1";
const CAP_KEY = "foyer.recents.cap";
const DEFAULT_CAP = 10;

export function recentsCap() {
  const raw = Number(localStorage.getItem(CAP_KEY));
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_CAP;
  return Math.min(50, Math.max(1, Math.round(raw)));
}
export function setRecentsCap(n) {
  const v = Math.min(50, Math.max(1, Math.round(Number(n) || DEFAULT_CAP)));
  localStorage.setItem(CAP_KEY, String(v));
  // Truncate if needed.
  const list = load();
  if (list.length > v) save(list.slice(0, v));
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && typeof e.path === "string" && e.path.length > 0);
  } catch {
    return [];
  }
}

function save(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Quota exceeded or serialization error — drop silently. Losing a
    // recents entry never breaks an open flow.
  }
}

/** Record a session as most-recently-used. Updates `opened_at` if the
 *  path is already in the list, or prepends a new entry otherwise.
 *  Always truncates to the configured cap. */
export function touch({ path, name, backend_id }) {
  if (!path) return;
  const cap = recentsCap();
  const list = load().filter((e) => e.path !== path);
  list.unshift({
    path,
    name: name || pathTail(path),
    backend_id: backend_id || "ardour",
    opened_at: Math.floor(Date.now() / 1000),
  });
  save(list.slice(0, cap));
}

/** Remove a recent entry (user's "forget this" action). */
export function forget(path) {
  const list = load().filter((e) => e.path !== path);
  save(list);
}

/** Clear the entire recents list. */
export function clearAll() {
  save([]);
}

function pathTail(p) {
  const m = String(p).match(/[^/\\]+$/);
  return m ? m[0] : p;
}
