// Feature registry — which DAW-side capabilities are available.
//
// Different back-end DAWs support different feature sets. The sidecar
// advertises its backend's capabilities in the `ClientGreeting`
// payload (`features: {...}`); core parses that into a flat map and
// exposes `features.has("id")` / `features.get("id")` so the UI can
// gate menu items, hide unsupported panels, and swap widget
// implementations.
//
// **Why not derive from the command set?** RBAC already does that for
// role gating. Features are different: some capabilities aren't
// single commands (e.g. "supports midi routing" requires a handful of
// coordinated commands). We want a DAW-authored manifest, not a
// reverse-derivation.
//
// **Default on missing data.** If the server doesn't send a feature
// entry, default is `undefined` — which the UI treats as "I don't
// know, show it" (backwards-compatible). Explicit `false` means
// "hide it."

const _features = new Map();
const _listeners = new Set();

/** Replace the whole feature map (called by bootstrap after greeting). */
export function setFeatures(map) {
  _features.clear();
  if (map && typeof map === "object") {
    for (const [k, v] of Object.entries(map)) _features.set(k, v);
  }
  for (const cb of _listeners) {
    try { cb(); } catch (err) { console.error("features listener", err); }
  }
}

/** True if the feature is explicitly enabled. */
export function featureEnabled(id) {
  return _features.get(id) === true;
}

/** Tri-state — returns `true`, `false`, or `undefined` (unknown). */
export function featureState(id) {
  return _features.get(id);
}

/**
 * UI uses this: show the surface unless the server has explicitly
 * said "this DAW doesn't do that." Missing = show (optimistic).
 */
export function showFeature(id) {
  return _features.get(id) !== false;
}

/** Current snapshot as a plain object (for debugging / settings UI). */
export function featureSnapshot() {
  return Object.fromEntries(_features);
}

/** Subscribe to updates (fires after `setFeatures`). */
export function onFeatureChange(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}
