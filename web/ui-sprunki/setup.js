// Sprunki backend setup — provisions one MIDI track + region per
// *stage slot* (not per category — that's the v1 model).
//
// Per slot:
//   1. Look up the cached `track_id` on the slot. If it matches a
//      live track in the session snapshot, reuse it. Otherwise
//      reuse any track named "Sprunki Slot N" already in the
//      session (handles reloads); only `create_track` as a last
//      resort.
//   2. If the slot holds a patch, verify the track's plugin chain
//      matches the patch's `instrument_uri`. If not, walk the
//      fallback chain to repair. This catches:
//        * tracks created before the URI catalogue fix landed,
//        * patches the kid swapped on an existing slot,
//        * users that emptied the plugin manually in the GUI.
//   3. Look for a MIDI region on the track named "Sprunki"; create
//      one if missing. Cache the (track_id, region_id) on the slot.
//
// On a fresh Ardour session, this provisions N empty tracks
// (typically 7 — `DEFAULT_STAGE_SLOT_COUNT`), one per slot. On a
// reload, it should be a no-op: tracks exist, plugins land, regions
// already there, layout-push uses the cached IDs.

import {
  BARS_PER_PATTERN,
  DEFAULT_PATTERNS,
  STEPS_PER_PATTERN,
} from "./components/sound-catalog.js";
import { getPatch } from "./patches.js";

const REGION_NAME = "Sprunki";
const PROVISION_TIMEOUT_MS = 8000;

/** Per-slot track name. Stable across reloads so the by-name
 *  lookup deduplicates properly. Using `·` (middle-dot) because
 *  Ardour sanitizes "/" to "_" in route names. */
function trackNameForSlot(slot, idx) {
  return `Sprunki Slot ${idx + 1}`;
}

/**
 * Ensure every stage slot has a backing MIDI track + region, and
 * that any slot holding a patch has the patch's instrument loaded
 * on its track. Idempotent. Throws on hard failures so the caller
 * can render an error toast.
 *
 * @param {object} store         — foyer-core store (for snapshots).
 * @param {object} ws            — foyer-core ws (for commands).
 * @param {object} sprunkiStore  — our SprunkiStore.
 * @returns {Promise<Array<{slot_id, track_id, region_id}>>} the
 *   provisioned slot-track-region triples, in slot order.
 */
export async function ensureSprunkiStage(store, ws, sprunkiStore) {
  const sessionRoot = () => store?.state?.session;
  const tracks = () => sessionRoot()?.tracks || [];

  // Wait for the snapshot to be loaded before any dedupe / lookup.
  // status === "open" fires when the WS handshake completes;
  // SessionSnapshot lands a few hundred ms later. Without this gate
  // every reload double-creates tracks because by-name lookup runs
  // against an empty tracks[].
  await waitFor(() => tracks().some((t) => t?.kind === "master"), 5_000);

  const out = [];
  const stage = sprunkiStore.stage;
  for (let i = 0; i < stage.length; i++) {
    const slot = stage[i];
    const trackName = trackNameForSlot(slot, i);
    let trackId = slot.track_id;
    let regionId = slot.region_id;

    // Re-validate cached track id against the live snapshot.
    if (trackId && !tracks().some((t) => t?.id === trackId)) {
      trackId = null;
      regionId = null;
    }
    if (regionId && trackId) {
      const t = tracks().find((tr) => tr?.id === trackId);
      const regions = store?.state?.regionsByTrack?.get?.(trackId) || t?.regions || [];
      if (!regions.some((r) => r?.id === regionId)) regionId = null;
    }

    // Resolve the track: cache → by-name → create.
    if (!trackId) {
      const existing = tracks().find((t) => t?.name === trackName && t?.kind === "midi");
      if (existing) {
        trackId = existing.id;
      } else {
        trackId = await createSlotTrack(store, ws, trackName);
      }
    }

    // Patch verification: if the slot holds a patch, make sure the
    // track has the patch's instrument plugin loaded.
    if (slot.patch_id) {
      const patch = getPatch(slot.patch_id);
      if (patch) {
        await ensurePatchInstrument(store, ws, trackId, patch);
      }
    }

    // Region.
    if (!regionId) {
      const existingRegion = regionsForTrack(store, trackId)
        .find((r) => r?.name === REGION_NAME);
      if (existingRegion) {
        regionId = existingRegion.id;
      } else {
        regionId = await createSlotRegion(store, ws, trackId);
      }
    }

    sprunkiStore.setTracks(slot.id, { track_id: trackId, region_id: regionId });
    out.push({ slot_id: slot.id, track_id: trackId, region_id: regionId });
  }
  return out;
}

async function createSlotTrack(store, ws, name) {
  const before = new Set(tracksSnapshot(store).map((t) => t.id));
  // No instrument at creation time — `ensurePatchInstrument` lands
  // the right plugin once we know the patch. Tracks start as bare
  // MIDI carriers; patch assignment is what gives them voice.
  ws.send({
    type: "create_track",
    name,
    kind: "midi",
    color: "#7c5cff",
  });
  const fresh = await waitFor(
    () => {
      const ts = tracksSnapshot(store);
      const byDelta = ts.find((t) => !before.has(t.id));
      if (byDelta) return byDelta;
      const byName = ts.find((t) => t.name === name);
      return byName || null;
    },
    PROVISION_TIMEOUT_MS,
  );
  if (!fresh) throw new Error(`create_track timed out for ${name}`);
  return fresh.id;
}

/** Make sure `trackId` has the patch's instrument plugin loaded.
 *  Walks the URI fallback chain when the primary doesn't take. If
 *  the track already has a plugin matching the patch's primary URI,
 *  we leave it alone. */
async function ensurePatchInstrument(store, ws, trackId, patch) {
  const trackHasPlugin = (uri) => {
    const t = tracksSnapshot(store).find((tr) => tr.id === trackId);
    return (t?.plugins || []).some((p) => p.uri === uri);
  };
  const anyPlugin = () => {
    const t = tracksSnapshot(store).find((tr) => tr.id === trackId);
    return (t?.plugins || []).length > 0;
  };

  // Happy path: the right plugin is already loaded.
  if (trackHasPlugin(patch.instrument_uri)) {
    await applyPatchProgram(ws, trackId, patch);
    return;
  }

  // We deliberately do NOT remove an existing plugin before adding
  // the new one — Ardour's chain semantics get confused by a
  // remove+add race during a patch swap, and the server's
  // add_plugin gracefully replaces a tail-of-chain instrument when
  // a new one of the same role lands. (If this turns out to be
  // wrong in practice, we add a remove_plugin call here.)
  ws.send({ type: "add_plugin", track_id: trackId, plugin_uri: patch.instrument_uri });
  await waitFor(() => trackHasPlugin(patch.instrument_uri), 1_500);
  if (trackHasPlugin(patch.instrument_uri)) {
    await applyPatchProgram(ws, trackId, patch);
    return;
  }

  // Walk the fallback chain.
  const fallbacks = Array.isArray(patch.instrument_uri_fallbacks)
    ? patch.instrument_uri_fallbacks
    : [];
  for (const uri of fallbacks) {
    if (anyPlugin()) break;
    ws.send({ type: "add_plugin", track_id: trackId, plugin_uri: uri });
    await waitFor(() => trackHasPlugin(uri), 1_500);
    if (trackHasPlugin(uri)) break;
  }
  if (!anyPlugin()) {
    // Last resort — ask the server to pick anything.
    ws.send({ type: "add_default_instrument", track_id: trackId });
    await waitFor(anyPlugin, 2_000);
  }
  if (anyPlugin()) {
    await applyPatchProgram(ws, trackId, patch);
  } else {
    console.warn(`[sprunki] no instrument landed for patch ${patch.id} on ${trackId}`);
  }
}

async function applyPatchProgram(ws, trackId, patch) {
  // GM program-change on the patch's channel. gmsynth's program
  // handler reads bank+pgm from MIDI data per channel.
  if (typeof patch.gm_program === "number") {
    ws.send({
      type: "set_track_midi_patch",
      track_id: trackId,
      channel: patch.gm_channel || 0,
      bank: 0,
      program: patch.gm_program,
    });
  }
}

async function createSlotRegion(store, ws, trackId) {
  // 16 bars of headroom — Intro / Verse / Chorus / Drop, each
  // 4 bars long, mirroring OG's continuous multi-bar loop feel.
  const regionLengthSamples = barsToSamples(BARS_PER_PATTERN * DEFAULT_PATTERNS.length);
  const before = new Set(regionsForTrack(store, trackId).map((r) => r.id));
  ws.send({
    type: "create_region",
    track_id: trackId,
    name: REGION_NAME,
    at_samples: 0,
    length_samples: regionLengthSamples,
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
  if (!fresh) throw new Error(`create_region timed out for track ${trackId}`);
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

export function patternBarOffset(patternId) {
  const p = DEFAULT_PATTERNS.find((x) => x.id === patternId);
  return p ? p.bar : 0;
}

export { STEPS_PER_PATTERN, barsToSamples };
