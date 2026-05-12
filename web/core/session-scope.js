// Session-scoped persistence helper.
//
// Several views persist per-element state (window bounds, panel
// expansion, ...) via `localStorage`, keyed by an Ardour-side id
// like a track's PBD number or a plugin instance index. Those ids
// are ephemeral PER SESSION — opening a different `.ardour` project
// can reuse the same numeric id for an entirely different track,
// and the persisted state from session A bleeds into session B.
// Rich's report (2026-04-27): two sessions both produced
// `foyer.window:track-editor.track.2595` and the second session
// loaded the first session's stored window bounds.
//
// Fix: callers that construct a per-id storage key route the id
// through `sessionScopedKey()` so the resulting key incorporates
// the active session's stable identifier. The session id is the
// `.ardour`-file-persistent UUID the shim writes into the file's
// `<Foyer><Session id="..."/></Foyer>` extra-xml node, surfaced
// to the client as `state.sessions[i].id` (matched by
// `currentSessionId`). Same project reopened later → same scope →
// same persisted state. Different projects → disjoint scopes →
// no collision.
//
// "default" is the fallback when no session is loaded yet (the
// launcher screen, fresh boot before the first snapshot lands).
// We keep it stable so the first session that DOES open inherits
// any layouts the user happened to set up at the launcher.

/** Stable scope string for the current session. Short prefix of the
 *  session id since localStorage keys want to stay readable; the
 *  full id is overkill for collision avoidance. Returns
 *  `"default"` when nothing is open yet. */
export function sessionScope() {
  const id = window.__foyer?.store?.state?.currentSessionId;
  if (typeof id !== "string" || id.length === 0) return "default";
  // Strip the `s_` / `session.` prefix some backends emit so the
  // scope reads as the bare id. Then take a short slice — eight
  // chars of a UUID is enough entropy for "no two open sessions
  // collide" without bloating every key.
  let bare = id;
  if (bare.startsWith("s_")) bare = bare.slice(2);
  if (bare.startsWith("session.")) bare = bare.slice("session.".length);
  return bare.slice(0, 12) || "default";
}

/** Build a storage-key fragment scoped to the active session. The
 *  caller composes the rest of the key (verb + per-track id):
 *    sessionScopedKey(`track-editor.${trackId}`)
 *      → "abc12def3456:track-editor.track.42"
 *  Preserves the bare key when the scope is "default" so layouts
 *  set up before any session loads still find their entries
 *  after the first snapshot. */
export function sessionScopedKey(key) {
  const scope = sessionScope();
  if (scope === "default") return key;
  return `${scope}:${key}`;
}

/** Window-slot id for the current browser window (see
 *  `core/window-restore.js`). Primary returns `"0"`; secondaries
 *  return their `?slot=` URL param. Used by view-local persistence
 *  (tile tree, floats, …) that should differ between two windows of
 *  the same logical peer. Returns `"0"` when the multi-window layer
 *  hasn't booted yet, which is the right fallback for single-window
 *  pages. */
export function windowSlot() {
  if (typeof window === "undefined") return "0";
  const fromGlobal = window.__foyer?.windowSlotId;
  if (typeof fromGlobal === "string" && fromGlobal.length > 0) return fromGlobal;
  // Fallback before window-restore.attach runs: peek at the URL
  // directly so the very first paint already keys correctly.
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("slot");
    if (fromUrl) return fromUrl;
  } catch {}
  return "0";
}

/** Compose a key scoped to BOTH the active session and the current
 *  window slot. Differs from {@link sessionScopedKey} only when the
 *  browser is running as one window of a multi-window peer — the
 *  Primary keeps the historical key (slot `"0"` is bare for cache
 *  compat), Secondaries get a `#slot=N` suffix. Use this for state
 *  that should differ between windows of the same logical user
 *  (tile tree, floating tile list, focus). Plain `sessionScopedKey`
 *  remains correct for per-session global state (recents pin,
 *  picker filter, etc.) that every window should see identically. */
export function windowScopedKey(key) {
  const slot = windowSlot();
  const base = sessionScopedKey(key);
  if (!slot || slot === "0") return base;
  return `${base}#slot=${slot}`;
}
