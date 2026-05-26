// Live plugin catalog for Sprunkadoo's Advanced section.
//
// On connect we fire `list_plugins` and stash the full PluginsList
// reply in a singleton. Consumers (preferences-modal) read from
// `pluginCatalog()` to render the per-costume instrument picker;
// they don't talk to the WS themselves.
//
// The catalog refreshes on `backend_swapped` since a new backend
// might have a totally different plugin scan. We also expose a
// `refresh()` hook so the kid can manually re-scan after installing
// a new LV2 outside the running session (rare; needed for power
// users tweaking ~/.lv2 mid-flight).

const _state = {
  entries: [],                  // PluginCatalogEntry[]
  loaded: false,
  pending: false,
  listeners: new Set(),
};

/** Subscribe to catalog updates. Returns an unsubscribe function. */
export function onPluginCatalog(fn) {
  _state.listeners.add(fn);
  if (_state.loaded) fn(_state.entries);
  return () => _state.listeners.delete(fn);
}

/** Current snapshot (may be empty if the catalog hasn't loaded yet). */
export function pluginCatalog() {
  return _state.entries.slice();
}

/** Just the instrument plugins, useful for the Advanced picker. */
export function instrumentCatalog() {
  return _state.entries.filter((e) => e.role === "instrument");
}

/** Look up one catalog entry by URI. Returns null if unknown. */
export function pluginByUri(uri) {
  if (!uri) return null;
  return _state.entries.find((e) => e.uri === uri) || null;
}

/** Drive a refresh — call this on cold boot + on backend_swapped. */
export function refreshPluginCatalog(ws) {
  if (!ws || _state.pending) return;
  _state.pending = true;
  let settled = false;
  const onEnv = (ev) => {
    const body = ev?.detail?.body;
    if (body?.type !== "plugins_list") return;
    ws.removeEventListener("envelope", onEnv);
    settled = true;
    _state.pending = false;
    _state.loaded = true;
    _state.entries = Array.isArray(body.entries) ? body.entries : [];
    for (const fn of _state.listeners) {
      try { fn(_state.entries); } catch (e) { console.warn("[plugin-catalog] listener:", e); }
    }
  };
  ws.addEventListener("envelope", onEnv);
  ws.send({ type: "list_plugins" });
  // Generous timeout — backends scan LV2 lazily and can take 30s+
  // on a cold cache. Give up after 60s; the UI just shows whatever
  // catalog landed before then.
  setTimeout(() => {
    if (settled) return;
    ws.removeEventListener("envelope", onEnv);
    _state.pending = false;
    console.warn("[plugin-catalog] list_plugins timed out after 60s");
  }, 60_000);
}
