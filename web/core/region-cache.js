// Global region cache — keyed `region_id → { region, track_id }`.
//
// Regions live OFF the session snapshot (the snapshot only carries
// tracks). Timeline-view fetches them on mount via `list_regions` per
// track and holds the result in its own instance state. That works for
// timeline-view itself but leaves anyone else (rehydrate factories for
// MIDI editor / beat sequencer windows, etc.) with no way to look up
// a region by id without a timeline open.
//
// Fix: subscribe to the same envelope traffic at boot, mirror regions
// into a global Map. Anyone needing to resolve a region id calls
// `findRegion(id)`. Also fires `list_regions` for every track in the
// session snapshot so the cache populates without depending on the
// timeline mounting. (Rich, 2026-04-26.)

const REGIONS = new Map(); // region_id → { region, track_id }
let _wired = false;

// Coalesce dispatches across animation frames. During active editing
// the server fires `region_updated` per note operation; we don't want
// rehydrate to run on every keystroke. One event per frame is plenty
// to wake any listener that's waiting for the cache to populate.
let _dispatchPending = false;
function _scheduleDispatch() {
  if (_dispatchPending) return;
  _dispatchPending = true;
  requestAnimationFrame(() => {
    _dispatchPending = false;
    window.dispatchEvent(new CustomEvent("foyer:region-cache-updated"));
  });
}

function _onEnvelope(ev) {
  const env = ev?.detail || {};
  const body = env.body;
  if (!body) return;
  // Only signal listeners when the SET of known regions changes — new
  // additions, or removals. Mutations to an already-cached region (the
  // common case during a drag, or while the user types notes) don't
  // unlock anything new for rehydrate, so re-firing the listener wakes
  // a chain of work for nothing. During a region drag the timeline
  // sends update_region every 80ms; the shim echoes region_updated
  // for each, the cache mutates, and on the previous broadcast-on-
  // every-update behavior we'd kick rehydrate per drag-frame on top of
  // an already-stressed shim. (Rich, 2026-04-26.)
  let added = false;
  let removed = false;
  if (body.type === "regions_list" && Array.isArray(body.regions)) {
    for (const r of body.regions) {
      if (!r?.id) continue;
      const existed = REGIONS.has(r.id);
      REGIONS.set(r.id, { region: r, track_id: body.track_id });
      if (!existed) added = true;
    }
  } else if (body.type === "region_updated" && body.region?.id) {
    const id = body.region.id;
    const existed = REGIONS.has(id);
    REGIONS.set(id, { region: body.region, track_id: body.region.track_id });
    if (!existed) added = true;
  } else if (body.type === "region_removed" && body.region_id) {
    if (REGIONS.delete(body.region_id)) removed = true;
  }
  if (added || removed) _scheduleDispatch();
}

function _requestAll() {
  const ws = window.__foyer?.ws;
  const session = window.__foyer?.store?.state?.session;
  if (!ws || !session?.tracks) return;
  for (const t of session.tracks) {
    if (t?.id) ws.send({ type: "list_regions", track_id: t.id });
  }
}

/** Lookup a region by id. Returns `{ region, track_id }` or null. */
export function findRegion(regionId) {
  if (!regionId) return null;
  return REGIONS.get(regionId) || null;
}

/** Boot the cache. Idempotent — subsequent calls are no-ops. */
export function bootRegionCache() {
  if (_wired) return;
  _wired = true;
  const ws = window.__foyer?.ws;
  const store = window.__foyer?.store;
  if (!ws || !store) {
    // The bootstrap order can call us before ws/store land. Retry on
    // the next animation frame; the foyer-app constructor populates
    // both before its render.
    requestAnimationFrame(() => { _wired = false; bootRegionCache(); });
    return;
  }
  ws.addEventListener("envelope", _onEnvelope);
  // Refetch only when the session IDENTITY changes — opening a new
  // session, switching sessions. Earlier we listened on the firehose
  // `change` event, but `regions_list` replies themselves fire change,
  // and replying-to-our-own-fetch produced an infinite loop:
  // change → list_regions → regions_list reply → change → list_regions
  // → ... The server's broadcast channel saturated within seconds and
  // started emitting "client lagged" warnings. Tracking session.id is
  // enough: regions for the current session are already kept in sync
  // by `region_updated` / `region_removed` envelopes. (Rich, 2026-04-26.)
  let _lastSessionId = null;
  const maybeRefetch = () => {
    const s = store.state.session;
    const id = s?.id || null;
    if (!id || id === _lastSessionId) return;
    _lastSessionId = id;
    _requestAll();
  };
  store.addEventListener("sessions", maybeRefetch);
  store.addEventListener("change", maybeRefetch);
  // Fire once now in case the session is already present at boot.
  maybeRefetch();
}

// Expose for debugging.
export const _internals = { REGIONS };
