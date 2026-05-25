// Sprunki backend setup — provisions one MIDI track + region per
// category on first run, caches the resulting IDs in localStorage,
// and reuses them on subsequent boots.
//
// Why this exists: `set_sequencer_layout` writes notes into an
// EXISTING region; it doesn't create the region for you. And the
// region has to live on a MIDI track with an instrument plugin or
// the played notes are silent. The previous Sprunki shell skipped
// both of these — it shipped a sequencer layout for a hardcoded
// region id that no Ardour session ever had, so play sounded like
// nothing happening. This module is the missing infrastructure.
//
// The flow per category:
//   1. Look up the cached track_id from `sprunkiStore`. If it
//      matches a live track in `store.state.session`, reuse it.
//   2. Otherwise, send `create_track` with `instrument_uri:
//      "gmsynth"`, `gm_program`, `gm_channel`. The server reports
//      back via `TrackUpdated` / `TrackAdded` events; we poll the
//      store snapshot for the new track by name to recover its id.
//   3. Once the track id is known, look for a MIDI region on it
//      named "Sprunki" — reuse if present, otherwise `create_region`.
//   4. Cache the (track_id, region_id) pair in `sprunkiStore`.

import { CATEGORIES, STEPS_PER_PATTERN, DEFAULT_PATTERNS } from "./components/sound-catalog.js";

const REGION_NAME = "Sprunki";
const PROVISION_TIMEOUT_MS = 6000;

/**
 * Ensure every category has a backing MIDI track + region. Idempotent.
 * Returns a map { categoryId → { track_id, region_id } }.
 * Throws on hard failures so the caller can render an error.
 */
export async function ensureSprunkiBoard(store, ws, sprunkiStore) {
  const out = {};
  const sessionRoot = () => store?.state?.session;
  const tracks = () => sessionRoot()?.tracks || [];

  for (const cat of CATEGORIES) {
    const cached = sprunkiStore.tracksFor(cat.id);
    let trackId = cached.track_id;
    let regionId = cached.region_id;

    // Re-validate the cached track id against the live snapshot.
    if (trackId && !tracks().some((t) => t?.id === trackId)) {
      trackId = null;
      regionId = null;
    }
    if (regionId && trackId) {
      const t = tracks().find((tr) => tr?.id === trackId);
      const regions = store?.state?.regionsByTrack?.get?.(trackId) || t?.regions || [];
      if (!regions.some((r) => r?.id === regionId)) {
        regionId = null;
      }
    }

    if (!trackId) {
      // Reuse any existing track with the same name BEFORE
      // creating a new one. Otherwise a stale localStorage purge
      // (or testing across Playwright contexts) leaves the
      // backend with the previous run's track, and create_track
      // helpfully appends `_2` to disambiguate — accumulating
      // duplicates in the Ardour session over time.
      const existing = tracks().find((t) => t?.name === cat.track_name && t?.kind === "midi");
      if (existing) {
        trackId = existing.id;
      } else {
        trackId = await createCategoryTrack(store, ws, cat);
      }
    }
    if (!regionId) {
      const existingRegion = regionsForTrack(store, trackId)
        .find((r) => r?.name === REGION_NAME);
      if (existingRegion) {
        regionId = existingRegion.id;
      } else {
        regionId = await createCategoryRegion(store, ws, cat, trackId);
      }
    }

    sprunkiStore.setTracks(cat.id, { track_id: trackId, region_id: regionId });
    out[cat.id] = { track_id: trackId, region_id: regionId };
  }
  return out;
}

async function createCategoryTrack(store, ws, cat) {
  const before = new Set(tracksSnapshot(store).map((t) => t.id));
  ws.send({
    type: "create_track",
    name: cat.track_name,
    kind: "midi",
    color: "#7c5cff",
    instrument_uri: cat.default_instrument_uri,
    gm_program: cat.default_gm_program,
    gm_channel: cat.default_gm_channel,
  });
  // The server emits `TrackUpdated` (or rebroadcasts the whole
  // session) once the create lands. Poll for the new track id by
  // diffing against the pre-create set. By-name matches are a
  // fallback for backends that don't surface the create as a delta.
  const fresh = await waitFor(
    () => {
      const ts = tracksSnapshot(store);
      const byDelta = ts.find((t) => !before.has(t.id));
      if (byDelta) return byDelta;
      const byName = ts.find((t) => t.name === cat.track_name);
      return byName || null;
    },
    PROVISION_TIMEOUT_MS,
  );
  if (!fresh) {
    throw new Error(`create_track timed out for ${cat.track_name}`);
  }
  // Plugin URI fallback walk. `add_plugin` returns Err silently when
  // the URI isn't in the host's catalog — the track lands with an
  // empty plugin slot. Walk the category's fallback list and retry
  // until something sticks (or we exhaust the list). avldrums is
  // the gold-standard drum kit but might not be installed on every
  // box; the chain ends at gmsynth which is bundled with Ardour
  // itself.
  await ensureInstrumentLanded(store, ws, fresh.id, cat);
  return fresh.id;
}

/** Make sure the track has at least one instrument plugin attached.
 *  If `default_instrument_uri` didn't take (catalog miss), walk
 *  `instrument_uri_fallbacks` in order. Last resort: ask the server
 *  for an `add_default_instrument` (auto-pick). */
async function ensureInstrumentLanded(store, ws, trackId, cat) {
  const hasPlugin = () =>
    (tracksSnapshot(store).find((t) => t.id === trackId)?.plugins || []).length > 0;
  // The plugin may still be settling — give the first attempt a
  // beat before declaring failure.
  await waitFor(hasPlugin, 1500);
  if (hasPlugin()) return;

  const fallbacks = Array.isArray(cat.instrument_uri_fallbacks)
    ? cat.instrument_uri_fallbacks
    : [];
  for (const uri of fallbacks) {
    if (hasPlugin()) return;
    ws.send({ type: "add_plugin", track_id: trackId, plugin_uri: uri });
    await waitFor(hasPlugin, 1500);
  }
  if (hasPlugin()) return;
  // Last resort — let the server pick whatever it can find.
  ws.send({ type: "add_default_instrument", track_id: trackId });
  await waitFor(hasPlugin, 2000);
  if (!hasPlugin()) {
    console.warn(
      `[sprunki] no instrument landed on ${cat.track_name} — track will be silent`
    );
  }
}

async function createCategoryRegion(store, ws, cat, trackId) {
  // 1 bar at 16 steps = 4 beats. Backend uses ticks; the sequencer
  // layout we ship next regenerates the region length anyway, so an
  // initial 1-bar stub is fine.
  const oneBarSamples = barsToSamples(4); // 4 bars of headroom (Intro/Verse/Chorus/Drop)
  const before = new Set(regionsForTrack(store, trackId).map((r) => r.id));
  // Field name on the wire is `at_samples` (not `start_samples`) —
  // matches `Command::CreateRegion` in foyer-schema. Passing the
  // wrong field made the backend reject silently and the poller
  // timed out waiting for a RegionsList echo that never came.
  ws.send({
    type: "create_region",
    track_id: trackId,
    name: REGION_NAME,
    at_samples: 0,
    length_samples: oneBarSamples,
    kind: "midi",
  });
  const fresh = await waitFor(
    () => {
      const rs = regionsForTrack(store, trackId);
      const byDelta = rs.find((r) => !before.has(r.id));
      if (byDelta) return byDelta;
      const byName = rs.find((r) => r.name === REGION_NAME);
      return byName || null;
    },
    PROVISION_TIMEOUT_MS,
  );
  if (!fresh) {
    throw new Error(`create_region timed out for ${cat.track_name}`);
  }
  return fresh.id;
}

function tracksSnapshot(store) {
  return store?.state?.session?.tracks || [];
}
function regionsForTrack(store, trackId) {
  const fromMap = store?.state?.regionsByTrack?.get?.(trackId);
  if (Array.isArray(fromMap)) return fromMap;
  const t = tracksSnapshot(store).find((tr) => tr?.id === trackId);
  return t?.regions || [];
}

function barsToSamples(bars, sampleRate = 48000, bpm = 120) {
  const secondsPerBeat = 60 / bpm;
  return Math.round(bars * 4 * secondsPerBeat * sampleRate);
}

/**
 * Poll `probe()` every animation frame (or 60 ms in non-DOM contexts)
 * until it returns a truthy value or the timeout elapses. Resolves
 * with the truthy value or `null` on timeout.
 */
function waitFor(probe, timeoutMs) {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = () => {
      const val = probe();
      if (val) return resolve(val);
      if (performance.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, 60);
    };
    tick();
  });
}

/**
 * Pattern-id → starting-bar offset map. Used by the transport's
 * "Play section" handler to know where to seek + loop. Computed
 * from sound-catalog so adding a new pattern doesn't require
 * editing the setup code.
 */
export function patternBarOffset(patternId) {
  const p = DEFAULT_PATTERNS.find((x) => x.id === patternId);
  return p ? p.bar : 0;
}

export { STEPS_PER_PATTERN, barsToSamples };
