// Recent sessions — server-tracked.
//
// The list lives in `~/.local/share/foyer/recents.json` on whichever
// machine is running the sidecar. The browser keeps a read-through
// cache fed by `Event::RecentsList` (sent on attach + after every
// touch / forget / clear). Mutations round-trip through WS commands
// so the persistent store stays authoritative.
//
// Why not localStorage anymore: it forked per browser profile, went
// stale when the sidecar moved between containers, and showed phantom
// entries pointing at projects that didn't exist on the current host.
// The recents file follows the sidecar's data dir, so a fresh
// devcontainer that mounts the same XDG path picks up the same
// history; one that doesn't, starts empty (correct).

let _cache = [];
const _listeners = new Set();

/// Wire the recents cache to the global store. Called from the app
/// shell once `window.__foyer.store` exists. Subscribes to the
/// "recents" event the store now dispatches in response to incoming
/// `recents_list` envelopes; each notification refills the cache and
/// pings every listener.
export function attach(store) {
  if (!store) return () => {};
  const handler = () => {
    const next = Array.isArray(store.state?.recents) ? store.state.recents : [];
    // Defensive copy so callers can sort/filter without mutating store
    // state.
    _cache = next.slice();
    for (const fn of _listeners) {
      try { fn(_cache); } catch (e) { console.error("[recents] listener threw:", e); }
    }
  };
  store.addEventListener("recents", handler);
  // Hydrate immediately if the store already has data (the WS layer
  // sends RecentsList eagerly on connect, which can land before this
  // module runs).
  handler();
  return () => store.removeEventListener("recents", handler);
}

/// Read the current cache. Synchronous so existing call sites
/// (welcome-screen, main-menu) keep working without an async refactor.
/// The cache is kept fresh by the `attach()` subscription above.
export function load() {
  return _cache.slice();
}

/// Subscribe to cache changes. Returns an off function. Useful for
/// components that don't already react to a store event.
export function onChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/// Server-tracked now — clients don't push touches anymore. Kept as a
/// no-op so call sites (e.g. welcome-screen.js's optimistic touch on
/// click) compile without churn. The server bumps the entry on
/// LaunchProject / focus.
export function touch(_entry) {
  // intentional no-op
}

/// Drop an entry by path. Sends a WS command; the resulting
/// RecentsList broadcast updates the cache.
export function forget(path) {
  if (!path) return;
  const ws = window.__foyer?.ws;
  if (!ws) return;
  try { ws.send({ type: "forget_recent", path }); } catch {}
}

/// Empty the entire list, server-side.
export function clearAll() {
  const ws = window.__foyer?.ws;
  if (!ws) return;
  try { ws.send({ type: "clear_recents" }); } catch {}
}
