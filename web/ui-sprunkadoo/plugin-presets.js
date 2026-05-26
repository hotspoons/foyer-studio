// Plugin preset cache.
//
// The shim's `list_plugin_presets` takes a plugin INSTANCE id and
// returns the preset list. Presets are deterministic per plugin
// URI (a Black Pearl instance on slot 1 has the same preset list
// as a Black Pearl instance on slot 4), so we cache by URI: the
// first instance of a given plugin URI triggers a query, subsequent
// instances re-use the cached result.
//
// Consumers (the Advanced section's preset picker) subscribe via
// `onPresets(uri, fn)` and get notified when the list arrives.

const _cache = new Map();        // uri -> { presets, loaded, pending }
const _listeners = new Map();    // uri -> Set<fn>

function notify(uri) {
  const fns = _listeners.get(uri);
  if (!fns) return;
  const entry = _cache.get(uri);
  const presets = entry?.presets || [];
  for (const fn of fns) {
    try { fn(presets); } catch (e) { console.warn("[plugin-presets] listener:", e); }
  }
}

/** Presets for a plugin URI, or `[]` if not yet loaded. */
export function presetsForUri(uri) {
  return _cache.get(uri)?.presets || [];
}

/** Subscribe to preset-list updates for one URI. Returns an
 *  unsubscribe fn. Fires immediately with the current cached value
 *  if any. */
export function onPresets(uri, fn) {
  if (!_listeners.has(uri)) _listeners.set(uri, new Set());
  _listeners.get(uri).add(fn);
  const entry = _cache.get(uri);
  if (entry?.loaded) fn(entry.presets || []);
  return () => _listeners.get(uri)?.delete(fn);
}

/** Ensure presets for `pluginUri` are loaded. Sends list_plugin_presets
 *  against the given instance id; the response's presets get keyed
 *  by URI so later queries are cache hits. Idempotent — multiple
 *  concurrent calls for the same URI collapse to one in-flight
 *  request. */
export function fetchPresetsForInstance(ws, pluginUri, instanceId) {
  if (!ws || !pluginUri || !instanceId) return;
  const cur = _cache.get(pluginUri);
  if (cur?.loaded || cur?.pending) return;
  _cache.set(pluginUri, { presets: [], loaded: false, pending: true });
  let settled = false;
  const onEnv = (ev) => {
    const body = ev?.detail?.body;
    if (body?.type !== "plugin_presets_listed") return;
    if (body.plugin_id !== instanceId) return;
    ws.removeEventListener("envelope", onEnv);
    settled = true;
    _cache.set(pluginUri, {
      presets: Array.isArray(body.presets) ? body.presets : [],
      loaded: true,
      pending: false,
    });
    notify(pluginUri);
  };
  ws.addEventListener("envelope", onEnv);
  ws.send({ type: "list_plugin_presets", plugin_id: instanceId });
  setTimeout(() => {
    if (settled) return;
    ws.removeEventListener("envelope", onEnv);
    _cache.set(pluginUri, { presets: [], loaded: true, pending: false });
    notify(pluginUri);
  }, 15_000);
}
