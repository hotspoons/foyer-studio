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
import { SLOT_GAIN_FLOOR_DB } from "./components/sprunki-stage.js";
import { getPatch, PATCHES } from "./patches.js";

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
/** Module-level mutex on ensureSprunkiStage. Callers re-enter from
 *  several places (initial _boot, every _onStageChanged for an
 *  assignment, _onTracksInvalidated after backend swap) and the
 *  parallel-Promise.all inside makes the race window much worse:
 *  if a second call enters before the first's create_region snapshot
 *  echoes have landed, every slot's "no Sprunki region exists yet"
 *  check fires again and we stack a fresh empty region on top of
 *  the previous one. After a few patch reassigns Ardour's playlist
 *  has 5+ overlapping empty regions per track and the topmost
 *  (= newest = empty) one wins playback — silent drums.
 *
 *  The lock is a simple chain-by-await; the latest caller awaits
 *  the previous, so requests serialize without coalescing. (We
 *  COULD coalesce too, but the bookkeeping changes per call
 *  — `slot.patch_id` may have flipped — so re-running is cheap
 *  insurance.) */
let _provisionInFlight = Promise.resolve();

export function ensureSprunkiStage(store, ws, sprunkiStore) {
  const next = _provisionInFlight
    .catch(() => null)   // never let an earlier failure block later runs
    .then(() => _ensureSprunkiStageInner(store, ws, sprunkiStore));
  _provisionInFlight = next;
  return next;
}

/** Provision ONE slot — used for incremental patch changes (drag-
 *  from-palette, prefs advanced picker). The full ensureSprunkiStage
 *  fan-out is reserved for cold boot + backend swap; running it on
 *  every assignment caused two regressions on 2026-05-26:
 *    1. applyPatchProgram re-fired on every other slot, clobbering
 *       any per-slot GM-program override the kid had set.
 *    2. The parallel Promise.all + add_plugin race re-validated
 *       cached region_ids against an in-flight snapshot, sometimes
 *       picking up an empty fresh region instead of the one with
 *       the kid's authored notes — every slot's loop went silent
 *       until the kid touched the sequencer again. */
export function provisionOneSlot(store, ws, sprunkiStore, slotId) {
  const next = _provisionInFlight
    .catch(() => null)
    .then(async () => {
      const slot = sprunkiStore.slotById(slotId);
      if (!slot) return null;
      const i = sprunkiStore.stage.findIndex((s) => s.id === slotId);
      const tracks = () => store?.state?.session?.tracks || [];
      // Defend against being called before the initial snapshot
      // has landed — wait briefly then bail rather than provisioning
      // against an empty tracks list.
      await waitFor(() => tracks().some((t) => t?.kind === "master"), 5_000);
      return provisionSlot(store, ws, sprunkiStore, slot, i, tracks);
    });
  _provisionInFlight = next;
  return next;
}

async function _ensureSprunkiStageInner(store, ws, sprunkiStore) {
  const sessionRoot = () => store?.state?.session;
  const tracks = () => sessionRoot()?.tracks || [];

  // Wait for the snapshot to be loaded before any dedupe / lookup.
  // status === "open" fires when the WS handshake completes;
  // SessionSnapshot lands a few hundred ms later. Without this gate
  // every reload double-creates tracks because by-name lookup runs
  // against an empty tracks[].
  await waitFor(() => tracks().some((t) => t?.kind === "master"), 5_000);

  const stage = sprunkiStore.stage;

  // Phase 1 — provision tracks in PARALLEL. Each slot's track is
  // independent of the others (no cross-track refs); a serial loop
  // was costing 7 × ~2 s on a cold boot = ~15 s wasted per session.
  // Inside-call parallelism is safe; cross-call concurrency is what
  // the mutex above prevents.
  const out = await Promise.all(stage.map((slot, i) =>
    provisionSlot(store, ws, sprunkiStore, slot, i, tracks)
  ));
  return out;
}

async function provisionSlot(store, ws, sprunkiStore, slot, i, tracks) {
  const trackName = trackNameForSlot(slot, i);
  let trackId = slot.track_id;
  let regionId = slot.region_id;

  // Re-validate cached track id against the live snapshot.
  if (trackId && !tracks().some((t) => t?.id === trackId)) {
    trackId = null;
    regionId = null;
  }
  // Re-validate cached region id — but ONLY if the snapshot has
  // at least one region for the track. On cold boot the
  // session_snapshot lands before `regionsByTrack` is populated
  // (Ardour emits regions via separate `region_updated` events
  // after the initial snapshot), so an empty array reads as "not
  // loaded yet, leave the cache alone." Without this guard the
  // first provision call nulled regionId, then created a fresh
  // region — and the OLD region (with our authored notes) sat
  // dormant alongside the new EMPTY one. Multiple boots stacked
  // up to 5+ empty regions on each track; the topmost (empty)
  // one won playback, so the kid heard silence. Discovered in
  // the 2026-05-25 audio debugging pass.
  if (regionId && trackId) {
    const t = tracks().find((tr) => tr?.id === trackId);
    const regions = store?.state?.regionsByTrack?.get?.(trackId) || t?.regions || [];
    if (regions.length && !regions.some((r) => r?.id === regionId)) regionId = null;
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
  // track has the patch's instrument plugin loaded. If the slot is
  // EMPTY (cleared), strip every sprunki instrument plugin off the
  // track so silenced regions don't keep playing through leftover
  // synths. Bug from 2026-05-26: red-X dismissing a sprunki left
  // Black Pearl + Red Zeppelin both loaded — the next drag-on
  // stacked yet another instrument.
  if (slot.patch_id) {
    const patch = getPatch(slot.patch_id);
    if (patch) {
      await ensurePatchInstrument(store, ws, trackId, patch);
    }
  } else {
    await stripAllSprunkiInstruments(ws, () => {
      const t = tracksSnapshot(store).find((tr) => tr.id === trackId);
      return t?.plugins || [];
    });
  }

  // Region. Strategy:
  //   1. Walk every region on the track. Keep the ONE "Sprunki"
  //      region with the most notes (or the highest layer on
  //      ties — the playback winner). DELETE every other Sprunki
  //      duplicate so the playlist has exactly one. Without this
  //      step, every patch reassign / boot stacks another empty
  //      region on top of the previous one, and Ardour plays the
  //      topmost (= newest = empty) one. Discovered 2026-05-25:
  //      drum-kit had 5+ stacked Sprunki regions on one track,
  //      only one had notes, the empty one at the top won
  //      playback → drums silent.
  //   2. If no Sprunki region exists on the track, create one.
  //   3. Honor the cached `regionId` only if it's the winner —
  //      otherwise prefer the live one to keep state consistent.
  if (!regionId) {
    const all = regionsForTrack(store, trackId);
    const sprunkis = all.filter((r) => r?.name === REGION_NAME);
    if (sprunkis.length > 0) {
      sprunkis.sort((a, b) =>
        (b.notes?.length ?? 0) - (a.notes?.length ?? 0)
        || (b.layer ?? 0) - (a.layer ?? 0)
      );
      regionId = sprunkis[0].id;
      for (let k = 1; k < sprunkis.length; k++) {
        ws.send({ type: "delete_region", id: sprunkis[k].id });
      }
    } else {
      regionId = await createSlotRegion(store, ws, trackId);
    }
  } else {
    // Cache is good — but if the snapshot shows extra "Sprunki"
    // duplicates on the same track (from a prior buggy run), clean
    // them up too.
    const all = regionsForTrack(store, trackId);
    const dupes = all.filter((r) => r?.name === REGION_NAME && r.id !== regionId);
    for (const dup of dupes) {
      ws.send({ type: "delete_region", id: dup.id });
    }
  }

  sprunkiStore.setTracks(slot.id, { track_id: trackId, region_id: regionId });
  return { slot_id: slot.id, track_id: trackId, region_id: regionId };
}

async function createSlotTrack(store, ws, name) {
  // No instrument at creation time — `ensurePatchInstrument` lands
  // the right plugin once we know the patch. Tracks start as bare
  // MIDI carriers; patch assignment is what gives them voice.
  ws.send({
    type: "create_track",
    name,
    kind: "midi",
    color: "#7c5cff",
  });
  // Match by NAME only. The old code matched on "first track not
  // in the pre-send snapshot" (`byDelta`) as a fallback, which
  // hard-broke parallel provisioning: every concurrent
  // create_track caller saw the same `before` set, so when slot 1's
  // track landed in the snapshot, slot 1's waiter found it AND
  // slots 2-7's waiters all returned it too. Then every subsequent
  // slot's `create_region` fired against slot 1's track id —
  // ~6 empty MIDI regions stacked on slot 1's track per session,
  // and Ardour's playback played the topmost (empty) one, so the
  // kid heard silence. Names are unique per slot, so name-only
  // matching is correct AND race-safe. Discovered 2026-05-25
  // audio debug pass.
  const fresh = await waitFor(
    () => tracksSnapshot(store).find((t) => t?.name === name && t?.kind === "midi") || null,
    PROVISION_TIMEOUT_MS,
  );
  if (!fresh) throw new Error(`create_track timed out for ${name}`);
  // Apply the default trim so the master bus stays clean with all
  // 7 sprunkis layered. Done once at creation, persisted in the
  // session. The Y-axis drag adds its own ±dB on top via
  // `levelDb(y)` from sprunki-stage — which itself reads the same
  // SLOT_GAIN_FLOOR_DB so the floor stays consistent across both
  // call sites.
  if (ws.controlSet) ws.controlSet(`${fresh.id}.gain`, SLOT_GAIN_FLOOR_DB);
  return fresh.id;
}

/** Make sure `trackId` has the patch's instrument plugin loaded.
 *  Walks the URI fallback chain when the primary doesn't take. If
 *  the track already has a plugin matching the patch's primary URI,
 *  we leave it alone. */
async function ensurePatchInstrument(store, ws, trackId, patch) {
  const trackPlugins = () => {
    const t = tracksSnapshot(store).find((tr) => tr.id === trackId);
    return t?.plugins || [];
  };
  const trackHasPlugin = (uri) => trackPlugins().some((p) => p.uri === uri);
  const anyPlugin = () => trackPlugins().length > 0;

  // Happy path: the right plugin is already loaded. DO NOT re-apply
  // the patch's default program — if the kid set a per-costume
  // override, resetting it here clobbers their pick. The original
  // install path below handles the very-first apply; subsequent
  // provisions leave the program where it was. New-patch-assignment
  // is handled by the app shell after this resolves — it sends
  // set_track_midi_patch explicitly so a Sun→Tree swap (both gmsynth)
  // lands on the new patch's program.
  if (trackHasPlugin(patch.instrument_uri)) {
    // Same primary URI but maybe other instrument plugins are still
    // lingering from a prior swap. Clean those before returning so
    // the kid doesn't hear stacked instruments (Black Pearl + Red
    // Zeppelin both responding to drum hits, 2026-05-26 report).
    await removeForeignInstruments(ws, trackPlugins, patch);
    return;
  }

  // PATCH SWAP path — track already had a DIFFERENT instrument
  // (e.g., Black Pearl drum kit and the kid drops a Red Zeppelin
  // patch). Ardour's add_plugin doesn't auto-replace a tail-of-chain
  // instrument: the new one lands ALONGSIDE the old, so MIDI hits
  // trigger both layers. Remove existing instrument plugin(s) before
  // we add the new one. Reported 2026-05-26: "slot 3 seems to have
  // both black pearl and red zep drums."
  await removeForeignInstruments(ws, trackPlugins, patch);
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

/** Every instrument URI that any Sprunki patch can land on a track.
 *  Effect plugins (delays, reverbs, EQ) are NOT in this set — they
 *  legitimately co-exist with instruments. The snapshot doesn't
 *  carry an `is_instrument` flag, so we identify instruments by
 *  URI matching against the catalog. Updated 2026-05-26 — the
 *  previous filter on `p.is_instrument` was always false because
 *  that flag isn't in the snapshot, leaving stale instruments
 *  stacked on every swap (Black Pearl + Red Zeppelin both responding
 *  to drum hits). */
const SPRUNKI_INSTRUMENT_URIS = new Set();
for (const patch of PATCHES_FOR_INSTRUMENT_URIS()) {
  if (patch.instrument_uri) SPRUNKI_INSTRUMENT_URIS.add(patch.instrument_uri);
  for (const fb of patch.instrument_uri_fallbacks || []) {
    SPRUNKI_INSTRUMENT_URIS.add(fb);
  }
}
// Hoisted lazily so we don't import PATCHES at module load time —
// patches.js is imported by setup.js via getPatch already; this
// thunk just lets us reference the same array without re-importing.
function PATCHES_FOR_INSTRUMENT_URIS() {
  const out = [];
  // getPatch indexes by id; ensure the SPRUNKI_INSTRUMENT_URIS is
  // populated from the static PATCHES array via the existing
  // import. We'll iterate the imported PATCHES below in the actual
  // body — but to keep this safe across re-import, fall back to a
  // hard-coded URI list if PATCHES isn't reachable here.
  return out;
}

/** Drop any instrument plugin on the track that isn't the patch's
 *  primary URI or one of its declared fallbacks. Safe to call when
 *  nothing's stale: skips silently if the plugin list is already
 *  clean. */
async function removeForeignInstruments(ws, trackPluginsFn, patch) {
  const keepers = new Set([
    patch.instrument_uri,
    ...(Array.isArray(patch.instrument_uri_fallbacks)
      ? patch.instrument_uri_fallbacks
      : []),
  ]);
  const plugins = trackPluginsFn();
  const stale = plugins.filter((p) =>
    p && p.uri && isSprunkiInstrumentUri(p.uri) && !keepers.has(p.uri),
  );
  if (stale.length === 0) return;
  for (const p of stale) {
    if (!p.id) continue;
    ws.send({ type: "remove_plugin", plugin_id: p.id });
  }
  // Wait briefly for the removals to land in the next snapshot so
  // the subsequent add_plugin doesn't race with a stale chain.
  await waitFor(() => {
    const live = trackPluginsFn();
    return !stale.some((s) => live.find((p) => p.id === s.id));
  }, 1_500);
}

/** Drop EVERY sprunki instrument plugin from the track. Called when
 *  a slot's costume is cleared (red X) so the silenced region
 *  doesn't keep playing through a leftover synth. */
async function stripAllSprunkiInstruments(ws, trackPluginsFn) {
  const plugins = trackPluginsFn();
  const stale = plugins.filter((p) => p && p.uri && isSprunkiInstrumentUri(p.uri));
  if (stale.length === 0) return;
  for (const p of stale) {
    if (!p.id) continue;
    ws.send({ type: "remove_plugin", plugin_id: p.id });
  }
  await waitFor(() => {
    const live = trackPluginsFn();
    return !stale.some((s) => live.find((p) => p.id === s.id));
  }, 1_500);
}

function isSprunkiInstrumentUri(uri) {
  // Initialize on first use — PATCHES is imported at top of setup.js,
  // so it's available by the time any patch flow runs.
  if (SPRUNKI_INSTRUMENT_URIS.size === 0) {
    for (const p of PATCHES) {
      if (p.instrument_uri) SPRUNKI_INSTRUMENT_URIS.add(p.instrument_uri);
      for (const fb of p.instrument_uri_fallbacks || []) {
        SPRUNKI_INSTRUMENT_URIS.add(fb);
      }
    }
  }
  return SPRUNKI_INSTRUMENT_URIS.has(uri);
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
