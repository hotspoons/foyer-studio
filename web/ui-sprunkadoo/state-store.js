// Sprunki state store — single source of truth for the player's
// stage layout, per-slot loops, transport preferences, harmony,
// and the backend track IDs we provisioned per slot.
//
// **The model.** The kid is composing a SONG made up of N
// performers ("sprunkis") arranged freely on a stage. Each
// performer holds a *patch* (from `patches.js`) which determines
// what instrument they play and what voices (rows) the patch
// surfaces in the sequencer. Authoring (which steps light up)
// lives at the slot+row level.
//
// Persistence shape (localStorage key `foyer.sprunki.v2`):
//
//   {
//     version: 2,
//     stage: [
//       {
//         id: "slot.0",
//         x: 0.18, y: 0.55,                  // 0..1 normalized stage coords
//         patch_id: "drum-kit" | null,
//         boards: {                          // per-section authored loops
//           [patternId]: { [patchRowId]: number[] }
//         },
//         track_id?: string, region_id?: string,   // backend cache (session-scoped)
//       },
//       …
//     ],
//     activePatternId: "intro",
//     transport: { mode, loop },
//     key: { root, mode },
//     sectionChords: { [patternId]: { degree, quality } },
//     progressionId: "I-V-vi-IV" | null,
//     scaryMode, parentalUnlockUntil, sprunkiAssetConsentRecorded,
//   }
//
// On load, a v1 blob (the old character-based model) is discarded
// and we fall back to defaults. v1's authored work is a small
// price to pay for a clean rebuild; we put up a one-time toast in
// `app.js` to apologize.

import { DEFAULT_PATTERNS, STEPS_PER_BAR, STEPS_PER_PATTERN } from "./components/sound-catalog.js";
import { PATCHES, getPatch, patchDefaultBoard } from "./patches.js";
import { buildProgression } from "./theory.js";

// Storage key follows the brand. Renamed from `foyer.sprunki.v2`
// in the 2026-05-25 push to "sprunkadoo" (Rich's 8-year-old's pick).
// v5 → discards any prior saved track_id/region_id mappings because
// a parallel-provisioning race fixed late that day was assigning
// EVERY slot the same trackId on first boot. Stages saved under
// v4 in the window between the rename and the race fix have
// poisoned slot.track_id values that point at slot 0's track for
// EVERY slot — so dragging a costume onto slot 3 visually appears
// to overwrite slot 0's audio. Bump forces a fresh provision.
// Prefs (scary-mode, asset-source, parental consent) migrate from
// any older key version on the first load below.
// v6 introduces the `arrangements` array — kid-composable
// multi-part songs. The previous v5 stored per-slot
// `boards: { [patternId]: { [rowId]: number[] } }` directly on
// the slot; v6 moves those into the active arrangement so the
// kid can keep multiple authored "parts" side by side. The v5
// → v6 migration is a one-shot in `loadFromStorage`: each slot's
// existing `boards` becomes the boards of the default
// arrangement; the slot's own `boards` field is preserved as
// the active mirror so existing reads keep working (slot still
// owns the live view, the arrangement owns the durable copy).
const STORAGE_KEY = "foyer.sprunkadoo.v6";
const LEGACY_STORAGE_KEYS = [
  "foyer.sprunkadoo.v5",
  "foyer.sprunkadoo.v4",
  "foyer.sprunki.v2",
];
const VERSION = 6;

/** Default number of sprunkis on a fresh stage. */
export const DEFAULT_STAGE_SLOT_COUNT = 7;

/** Hard cap on stage occupancy. The kid can drag patches around
 *  freely but can't ever stack more than this many performers on
 *  stage. Matches OG sprunki, which has a fixed-size cast.
 *  Beyond ~7 the sprunkis pile on top of each other on most
 *  viewports and the metaphor of a discrete band breaks down. */
export const MAX_STAGE_SLOTS = 7;

function newSlot(id, x, y, patch_id = null) {
  const slot = { id, x, y, patch_id, boards: {}, track_id: null, region_id: null };
  if (patch_id) {
    const patch = getPatch(patch_id);
    if (patch) {
      const activePat = DEFAULT_PATTERNS[0].id;
      slot.boards[activePat] = patchDefaultBoard(patch);
    }
  }
  return slot;
}

/** Compute a default stage layout: 7 sprunkis evenly spread
 *  across the full stage width, like OG sprunki. Pre-seeds the
 *  first three with Drum Kit / Synth Bass / Warm Pad so a fresh
 *  boot already plays something audible on the first transport
 *  press. The kid drags more patches onto the empty slots. */
function defaultStage() {
  // OG sprunki boots with every slot EMPTY (gray Polo). The kid
  // drags characters in to activate them — that's the central
  // metaphor of the game. Don't pre-load anything; let the user
  // build the cast.
  //
  // Default x-spread covers the middle 80% of stage width so the
  // edge slots don't clip off the left/right edges when the
  // 170 px-wide sprunki body extends past slot.x.
  const out = [];
  for (let i = 0; i < DEFAULT_STAGE_SLOT_COUNT; i++) {
    const t = i / (DEFAULT_STAGE_SLOT_COUNT - 1);
    const x = 0.15 + t * 0.70;
    const y = 0.85;
    out.push(newSlot(`slot.${i}`, x, y, null));
  }
  return out;
}

function defaultKey() {
  return { root: "C", mode: "major" };
}

function defaultSectionChords() {
  const prog = buildProgression("I-V-vi-IV", defaultKey());
  const out = {};
  DEFAULT_PATTERNS.forEach((p, idx) => {
    out[p.id] = prog[idx % prog.length];
  });
  return out;
}

/** Arrangements palette — 8 distinct, kid-readable colors used
 *  as the chip identity in the arrangement editor. New chips
 *  cycle through these in order; once exhausted we wrap and let
 *  the kid recolor manually. */
const ARRANGEMENT_COLORS = [
  "#a45fc9",  // purple (default 1st arrangement)
  "#ff9933",  // orange
  "#7ec8e3",  // sky blue
  "#ffd200",  // gold
  "#ff3b6f",  // hot pink
  "#00d4ff",  // cyan
  "#7a1a1a",  // burgundy
  "#3a8a3a",  // forest
];
export { ARRANGEMENT_COLORS };

/** Default arrangement bar length. Per-arrangement; kid can
 *  shorten it down to 1 (tight loop) or leave at 4 (longest). */
const DEFAULT_ARRANGEMENT_BARS = 4;
const MIN_ARRANGEMENT_BARS = 1;
const MAX_ARRANGEMENT_BARS = 4;
export { DEFAULT_ARRANGEMENT_BARS, MIN_ARRANGEMENT_BARS, MAX_ARRANGEMENT_BARS };

function defaultArrangements() {
  return [
    { id: "arr.0", color: ARRANGEMENT_COLORS[0], length_bars: DEFAULT_ARRANGEMENT_BARS },
  ];
}

/** Default timeline — one entry pointing at the default part.
 *  The kid extends the song by dragging palette parts into
 *  additional timeline slots in the arrangement editor. */
function defaultTimeline() {
  return ["arr.0"];
}

function defaultState() {
  return {
    version: VERSION,
    stage: defaultStage(),
    activePatternId: DEFAULT_PATTERNS[0].id,
    transport: { mode: "section", loop: true },
    key: defaultKey(),
    sectionChords: defaultSectionChords(),
    progressionId: "I-V-vi-IV",
    scaryMode: false,
    parentalUnlockUntil: 0,
    sprunkiAssetConsentRecorded: false,
    // Which character art pack to use. "builtin" is the Foyer
    // Originals pack shipped in-tree (default); "og" pulls the
    // reverse-engineered OG sprunki art from archive.org via the
    // asset-packs system. Per-client preference — different kids
    // on different devices legitimately pick differently, so this
    // lives in localStorage, not on the backend.
    assetSource: "builtin",
    // Song arrangements. Default UI ships with exactly one (the
    // kid sees no chip strip on stage). Adding a second arrangement
    // makes the on-stage color-dot picker appear. Each arrangement
    // is identified by COLOR (no name — no typing surface), and
    // each has its own length_bars (1..4) so a kid can build a
    // tight 1-bar intro + a 4-bar drop. The per-slot step
    // authorings live INSIDE each arrangement, under
    // `arrangements[].boards[slotId][rowId] = [stepIdx, …]`.
    arrangements: defaultArrangements(),
    activeArrangementId: "arr.0",
    // Timeline = ordered list of part ids (references into
    // `arrangements`). A single part can appear multiple times.
    // Default: one entry pointing at the default part so the loop
    // plays continuously on first boot. Editing happens in the
    // arrangement modal: drag from the parts palette into a
    // timeline slot to insert/replace.
    timeline: defaultTimeline(),
    // Per-COSTUME (per-patch) GM program overrides. Keyed by
    // patch.id → { gm_program, gm_channel }. Applied to every slot
    // holding that patch, so a kid who picks "Music Box" for the
    // Sun costume globally sees Sun play Music Box no matter
    // which slot the costume lands on. Survives across sessions.
    // Reset patches by removing the entry (setPatchOverride(id, null)).
    patchOverrides: {},
    // Which timeline slot the kid is focused on. The stage's color
    // strip selects this; clicking a position sets the loop range
    // to just that part's bars. The string "all" means "loop the
    // entire song" (the play-all button at the end of the strip).
    activeTimelinePosition: 0,
  };
}

/** Lightweight slot validator — discards anything that doesn't
 *  look right structurally so a partial localStorage blob can't
 *  poison the in-memory store. */
function sanitizeSlot(s, idx) {
  if (!s || typeof s !== "object") return null;
  const id = typeof s.id === "string" ? s.id : `slot.${idx}`;
  const x = Number.isFinite(s.x) ? Math.max(0, Math.min(1, s.x)) : 0.5;
  const y = Number.isFinite(s.y) ? Math.max(0, Math.min(1, s.y)) : 0.5;
  const patch_id = typeof s.patch_id === "string" && getPatch(s.patch_id) ? s.patch_id : null;
  let boards = (s.boards && typeof s.boards === "object") ? s.boards : {};
  // Legacy migration: pre-arrangement-refactor saves keyed boards
  // by section name ({intro,verse,chorus,drop}). Copy the kid's
  // primary `intro` board onto `arr.0` (the default first chip)
  // and drop the dead section keys so the bridge can find it.
  const sectionKeys = ["intro", "verse", "chorus", "drop"];
  const hasArrKey = Object.keys(boards).some((k) => k.startsWith("arr."));
  const hasSectionKey = sectionKeys.some((k) => boards[k]);
  if (hasSectionKey && !hasArrKey) {
    const intro = boards.intro || boards.verse || boards.chorus || boards.drop || {};
    boards = { "arr.0": intro };
  }
  return {
    id, x, y, patch_id, boards,
    track_id: typeof s.track_id === "string" ? s.track_id : null,
    region_id: typeof s.region_id === "string" ? s.region_id : null,
  };
}

/** Sanitize an `arrangements` blob from localStorage. Strips
 *  anything that doesn't look right and falls back to a single
 *  default arrangement if the array is empty / malformed. */
function sanitizeArrangements(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return defaultArrangements();
  const seen = new Set();
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const id = typeof a.id === "string" && a.id ? a.id : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const color = typeof a.color === "string" && /^#[0-9a-fA-F]{6}$/.test(a.color)
      ? a.color
      : ARRANGEMENT_COLORS[seen.size % ARRANGEMENT_COLORS.length];
    const length_bars = Math.max(
      MIN_ARRANGEMENT_BARS,
      Math.min(MAX_ARRANGEMENT_BARS, Number(a.length_bars) || DEFAULT_ARRANGEMENT_BARS),
    );
    // The per-chip cell authoring lives on each `slot.boards[chipId]`
    // — keyed by chip id directly. No separate `boards` field on
    // the chip itself; the chip is just (id, color, length_bars).
    // This matches the layout schema where one chip ↔ one pattern
    // in `layout.patterns[]`, addressed by chip id.
    out.push({ id, color, length_bars });
  }
  return out.length > 0 ? out : defaultArrangements();
}

/** Sanitize a timeline blob: an ordered list of part ids (with
 *  repetition allowed). Strips entries whose part is unknown,
 *  collapses empties down to a single default entry. */
function sanitizeTimeline(raw, parts) {
  const partIds = new Set((parts || []).map((p) => p.id));
  if (!Array.isArray(raw)) {
    // Derive: one slot per part, in palette order. Preserves
    // the prior playback behaviour for saves predating the split.
    const derived = (parts || []).map((p) => p.id).filter(Boolean);
    return derived.length > 0 ? derived : ["arr.0"];
  }
  const out = raw.filter((id) => typeof id === "string" && partIds.has(id));
  if (out.length > 0) return out;
  const derived = (parts || []).map((p) => p.id).filter(Boolean);
  return derived.length > 0 ? derived : ["arr.0"];
}

/** Sanitize a patch-overrides blob: drop entries whose patch id
 *  isn't a recognized string. Each override can carry any subset of:
 *    - instrument_uri  — LV2/VST URI to load instead of patch.instrument_uri
 *    - gm_program / gm_channel  — MIDI bank/program override (gmsynth-class)
 *    - preset_id  — host-side preset to apply after plugin loads
 *    - params     — map of plugin-param id → value to apply after load
 *  Unknown patch ids stay in the map (the kid might install / re-
 *  enable the patch later) — harmless if no slot holds that patch. */
function sanitizePatchOverrides(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [id, v] of Object.entries(raw)) {
    if (typeof id !== "string" || !id) continue;
    if (!v || typeof v !== "object") continue;
    const ov = {};
    if (typeof v.instrument_uri === "string" && v.instrument_uri) {
      ov.instrument_uri = v.instrument_uri;
    }
    if (Number.isInteger(v.gm_program) && v.gm_program >= 0 && v.gm_program <= 127) {
      ov.gm_program = v.gm_program;
      const chan = Number(v.gm_channel);
      ov.gm_channel = Number.isInteger(chan) && chan >= 0 && chan <= 15 ? chan : 0;
    }
    if (typeof v.preset_id === "string" && v.preset_id) {
      ov.preset_id = v.preset_id;
    }
    if (v.params && typeof v.params === "object") {
      const params = {};
      for (const [pid, pv] of Object.entries(v.params)) {
        if (typeof pid !== "string" || !pid) continue;
        if (typeof pv === "number" && Number.isFinite(pv)) params[pid] = pv;
        else if (typeof pv === "boolean") params[pid] = pv;
      }
      if (Object.keys(params).length > 0) ov.params = params;
    }
    if (Object.keys(ov).length > 0) out[id] = ov;
  }
  return out;
}

/** Sanitize an active-timeline-position value: integer index into
 *  `timeline`, or the literal string "all" for the play-all
 *  selection. Out-of-range or unrecognized values fall back to 0. */
function sanitizeActivePosition(raw, timeline) {
  if (raw === "all") return "all";
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n < (timeline?.length || 0)) return n;
  return 0;
}

/** Dedupe a sanitized stage array: collapse duplicate slot ids
 *  (Lit keys by id, so dupes render TWICE as separate sprunkis —
 *  the "mystery extra sprunki" symptom), trim to MAX_STAGE_SLOTS,
 *  and null out track_id/region_id mappings that multiple slots
 *  claim (would otherwise route a patch assignment onto the wrong
 *  track). */
function dedupeStage(stage) {
  const byId = new Map();
  for (const s of stage) {
    if (!byId.has(s.id)) byId.set(s.id, s);
  }
  let out = Array.from(byId.values()).slice(0, MAX_STAGE_SLOTS);
  // Any track_id claimed by more than one slot is poisoned — clear
  // it on every slot so the next provisionSlot pass rebuilds the
  // mapping cleanly. Same for region_id.
  const trackCount = new Map();
  const regionCount = new Map();
  for (const s of out) {
    if (s.track_id) trackCount.set(s.track_id, (trackCount.get(s.track_id) || 0) + 1);
    if (s.region_id) regionCount.set(s.region_id, (regionCount.get(s.region_id) || 0) + 1);
  }
  out = out.map((s) => ({
    ...s,
    track_id: s.track_id && trackCount.get(s.track_id) > 1 ? null : s.track_id,
    region_id: s.region_id && regionCount.get(s.region_id) > 1 ? null : s.region_id,
  }));
  return out;
}

function loadFromStorage() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // One-shot migration. Walk legacy keys oldest → newest, take
      // the first one that parses, pull over scary-mode +
      // assetSource + asset-pack consent. The stage itself is
      // discarded across version bumps. Delete legacy keys after
      // migrating so the branch only fires once.
      for (const k of LEGACY_STORAGE_KEYS) {
        const legacy = localStorage.getItem(k);
        if (!legacy) continue;
        try {
          const old = JSON.parse(legacy);
          const seed = defaultState();
          seed.scaryMode = !!old.scaryMode;
          seed.sprunkiAssetConsentRecorded = !!old.sprunkiAssetConsentRecorded;
          if (old.assetSource === "og" || old.assetSource === "builtin") {
            seed.assetSource = old.assetSource;
          }
          localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
          for (const old_k of LEGACY_STORAGE_KEYS) localStorage.removeItem(old_k);
          return seed;
        } catch { /* try next legacy key */ }
      }
      return defaultState();
    }
    const parsed = JSON.parse(raw);
    if (parsed.version !== VERSION) return defaultState();
    const seed = defaultState();
    const rawStage = Array.isArray(parsed.stage) && parsed.stage.length > 0
      ? parsed.stage.map((s, i) => sanitizeSlot(s, i)).filter(Boolean)
      : seed.stage;
    const stage = dedupeStage(rawStage);
    return {
      version: VERSION,
      stage,
      activePatternId: parsed.activePatternId || seed.activePatternId,
      transport: { ...seed.transport, ...(parsed.transport || {}) },
      key: { ...seed.key, ...(parsed.key || {}) },
      sectionChords: { ...seed.sectionChords, ...(parsed.sectionChords || {}) },
      progressionId: parsed.progressionId ?? seed.progressionId,
      scaryMode: !!parsed.scaryMode,
      // Parental unlock NEVER survives a reload by design.
      parentalUnlockUntil: 0,
      sprunkiAssetConsentRecorded: !!parsed.sprunkiAssetConsentRecorded,
      assetSource:
        parsed.assetSource === "og" || parsed.assetSource === "builtin"
          ? parsed.assetSource
          : seed.assetSource,
      arrangements: sanitizeArrangements(parsed.arrangements),
      activeArrangementId: typeof parsed.activeArrangementId === "string"
        ? parsed.activeArrangementId
        : seed.activeArrangementId,
      // Timeline: if a saved blob has none (pre-split-model save),
      // derive it from the arrangements list — one slot per part
      // in palette order. That matches the prior behaviour where
      // each chip played once in chip-strip order.
      timeline: sanitizeTimeline(parsed.timeline, sanitizeArrangements(parsed.arrangements)),
      activeTimelinePosition: sanitizeActivePosition(
        parsed.activeTimelinePosition,
        sanitizeTimeline(parsed.timeline, sanitizeArrangements(parsed.arrangements)),
      ),
      patchOverrides: sanitizePatchOverrides(parsed.patchOverrides),
    };
  } catch (e) {
    console.warn("[sprunki-store] failed to load — resetting:", e);
    return defaultState();
  }
}

class SprunkiStore extends EventTarget {
  constructor() {
    super();
    this._state = loadFromStorage();
    this._installSessionWatchdog();
  }

  _installSessionWatchdog() {
    const store = globalThis.__foyer?.store;
    if (!store) return;
    // Only invalidate cached backend track/region ids when the
    // backend ACTUALLY swaps sessions — see the long comment in
    // commit log + design doc. session_opened ALSO fires right
    // after our own initial bring-up; treating that as a swap
    // doubled every track.
    this._lastSessionId = null;
    const sessionId = () => {
      const s = store?.state?.session;
      return s?.id ?? s?.session?.id ?? null;
    };
    const onMaybeSwap = () => {
      const id = sessionId();
      if (!id) return;
      if (this._lastSessionId === null) { this._lastSessionId = id; return; }
      if (id === this._lastSessionId) return;
      this._lastSessionId = id;
      // Drop cached track ids — they belong to the previous session.
      const stage = this._state.stage.map((s) => ({
        ...s, track_id: null, region_id: null,
      }));
      this._state.stage = stage;
      this._persist();
      this.dispatchEvent(new CustomEvent("tracks-invalidated"));
    };
    store.addEventListener?.("envelope", (ev) => {
      const t = ev?.detail?.body?.type;
      if (t === "backend_swapped" || t === "session_opened" || t === "session_snapshot") {
        onMaybeSwap();
      }
    });
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this._state));
  }

  // ── stage ───────────────────────────────────────────────────────
  get stage() { return [...this._state.stage]; }
  slotById(id) { return this._state.stage.find((s) => s.id === id) || null; }

  /** Update a slot's `(x, y)` position. Called continuously during
   *  drag — don't emit a tracks/layout event, just stage-changed
   *  with a `kind: "moved"` so listeners can skip the expensive
   *  push for position-only updates. */
  moveSlot(slotId, x, y) {
    const idx = this._state.stage.findIndex((s) => s.id === slotId);
    if (idx < 0) return;
    const xc = Math.max(0, Math.min(1, x));
    const yc = Math.max(0, Math.min(1, y));
    if (this._state.stage[idx].x === xc && this._state.stage[idx].y === yc) return;
    const next = [...this._state.stage];
    next[idx] = { ...next[idx], x: xc, y: yc };
    this._state.stage = next;
    this._persist();
    this.dispatchEvent(new CustomEvent("stage-changed", {
      detail: { kind: "moved", slotId },
    }));
  }

  /** Assign `patchId` to `slotId`. Seeds the patch's default loop
   *  into the active pattern when the slot was previously empty
   *  (or had a different patch). Persists `track_id`/`region_id`
   *  are kept — the slot's backend track survives patch swaps;
   *  setup.js handles swapping the instrument on top of it. */
  assignPatch(slotId, patchId) {
    const idx = this._state.stage.findIndex((s) => s.id === slotId);
    if (idx < 0) return;
    const patch = getPatch(patchId);
    if (!patch) return;
    const slot = this._state.stage[idx];
    if (slot.patch_id === patchId) return; // already there
    const activePat = this.activeArrangementId;
    const boards = { ...slot.boards };
    // Seed the active chip if it's empty (or if the row ids
    // don't match — patch swap clears the old patch's row data
    // because it referenced rows that no longer exist).
    boards[activePat] = patchDefaultBoard(patch);
    const next = [...this._state.stage];
    next[idx] = { ...slot, patch_id: patchId, boards };
    this._state.stage = next;
    this._persist();
    this.dispatchEvent(new CustomEvent("stage-changed", {
      detail: { kind: "assigned", slotId, patchId },
    }));
  }

  /** Remove the patch from `slotId` but keep the slot on stage
   *  (a "vacant performer" — the costume + position survive, the
   *  sound goes away). Boards are cleared because they referenced
   *  the now-removed patch's row ids. */
  clearSlot(slotId) {
    const idx = this._state.stage.findIndex((s) => s.id === slotId);
    if (idx < 0) return;
    const slot = this._state.stage[idx];
    if (!slot.patch_id) return;
    const next = [...this._state.stage];
    next[idx] = { ...slot, patch_id: null, boards: {} };
    this._state.stage = next;
    this._persist();
    this.dispatchEvent(new CustomEvent("stage-changed", {
      detail: { kind: "cleared", slotId },
    }));
  }

  /** Spawn a new performer at `(x, y)` carrying `patchId`. Used by
   *  the "drag patch onto empty stage" gesture. Returns the new
   *  slot's id, or `null` if the stage is already at MAX_STAGE_SLOTS.
   *  Caller should give the kid feedback ("stage is full") on null. */
  spawnSlot(x, y, patchId = null) {
    if (this._state.stage.length >= MAX_STAGE_SLOTS) return null;
    const id = `slot.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 6)}`;
    const slot = newSlot(id, x, y, patchId);
    this._state.stage = [...this._state.stage, slot];
    this._persist();
    this.dispatchEvent(new CustomEvent("stage-changed", {
      detail: { kind: "spawned", slotId: id, patchId },
    }));
    return id;
  }

  /** Drop a sprunki entirely (different from `clearSlot`: this
   *  removes the slot from the stage array). Used by drag-off-stage
   *  gesture when implemented. */
  removeSlot(slotId) {
    this._state.stage = this._state.stage.filter((s) => s.id !== slotId);
    this._persist();
    this.dispatchEvent(new CustomEvent("stage-changed", {
      detail: { kind: "removed", slotId },
    }));
  }

  // ── boards (per slot) ───────────────────────────────────────────
  /** Active step indices for (slot, row) in the current section. */
  cells(slotId, rowId) {
    const slot = this.slotById(slotId);
    if (!slot) return new Set();
    const board = slot.boards[this.activeArrangementId] || {};
    return new Set(board[rowId] || []);
  }
  toggleCell(slotId, rowId, step) {
    const idx = this._state.stage.findIndex((s) => s.id === slotId);
    if (idx < 0) return;
    const slot = this._state.stage[idx];
    const activePat = this.activeArrangementId;
    const board = { ...(slot.boards[activePat] || {}) };
    const arr = [...(board[rowId] || [])];
    const at = arr.indexOf(step);
    if (at >= 0) arr.splice(at, 1);
    else { arr.push(step); arr.sort((a, b) => a - b); }
    board[rowId] = arr;
    const boards = { ...slot.boards, [activePat]: board };
    const next = [...this._state.stage];
    next[idx] = { ...slot, boards };
    this._state.stage = next;
    this._persist();
    this.dispatchEvent(new CustomEvent("board-changed", {
      detail: { slotId, rowId },
    }));
  }
  /** Replace one slot's board for the given part with the patch's
   *  default board (the seed `patchDefaultBoard` ships). Used by
   *  the sequencer view's "Reset" header chip — the kid asks to
   *  restore the original beat for one part on one sprunki. */
  resetPartToDefault(slotId, partId) {
    const idx = this._state.stage.findIndex((s) => s.id === slotId);
    if (idx < 0) return;
    const slot = this._state.stage[idx];
    if (!slot?.patch_id) return;
    const patch = getPatch(slot.patch_id);
    if (!patch) return;
    const seed = patchDefaultBoard(patch);
    const boards = { ...slot.boards, [partId]: seed };
    const next = [...this._state.stage];
    next[idx] = { ...slot, boards };
    this._state.stage = next;
    this._persist();
    this.dispatchEvent(new CustomEvent("board-changed", {
      detail: { slotId, kind: "reset-part", partId },
    }));
  }

  clearActivePattern() {
    const activePat = this.activeArrangementId;
    const next = this._state.stage.map((s) => {
      const boards = { ...s.boards };
      if (boards[activePat]) boards[activePat] = {};
      return { ...s, boards };
    });
    this._state.stage = next;
    this._persist();
    this.dispatchEvent(new CustomEvent("board-changed", { detail: { kind: "cleared-all" } }));
  }

  // ── active pattern ──────────────────────────────────────────────
  /** `activePatternId` is the chip the kid is currently editing —
   *  alias for `activeArrangementId`. Kept as a separate getter
   *  for legacy call-sites (interior editor, toggleCell, the
   *  initial assignPatch seed) that haven't been renamed.
   *  slot.boards is keyed by chip id, so the alias gives them
   *  the right index into the per-chip authoring. */
  get activePatternId() { return this.activeArrangementId; }
  setActivePatternId(id) {
    // Forwards to setActiveArrangement so legacy "pattern" call
    // sites swap the active chip cleanly. The pattern-changed
    // event still fires for the interior editor's bar-rail.
    if (!id) return;
    this.setActiveArrangement(id);
    this.dispatchEvent(new CustomEvent("pattern-changed", { detail: { id } }));
  }

  // ── transport prefs ─────────────────────────────────────────────
  get transport() { return { ...this._state.transport }; }
  setTransport(patch) {
    this._state.transport = { ...this._state.transport, ...patch };
    this._persist();
    this.dispatchEvent(new CustomEvent("transport-changed"));
  }

  // ── key + chord progression ─────────────────────────────────────
  get key() { return { ...this._state.key }; }
  setKey(patch) {
    this._state.key = { ...this._state.key, ...patch };
    if (this._state.progressionId) {
      const next = buildProgression(this._state.progressionId, this._state.key);
      const sec = { ...this._state.sectionChords };
      DEFAULT_PATTERNS.forEach((p) => {
        const cur = sec[p.id];
        if (!cur) return;
        const fresh = next.find((c) => c.degree === cur.degree);
        if (fresh) sec[p.id] = { ...cur, quality: fresh.quality };
      });
      this._state.sectionChords = sec;
    }
    this._persist();
    this.dispatchEvent(new CustomEvent("harmony-changed"));
  }
  get sectionChords() { return { ...this._state.sectionChords }; }
  chordFor(patternId) {
    return this._state.sectionChords[patternId] || { degree: 0, quality: "major" };
  }
  setChordFor(patternId, patch) {
    const cur = this._state.sectionChords[patternId] || { degree: 0, quality: "major" };
    this._state.sectionChords = {
      ...this._state.sectionChords,
      [patternId]: { ...cur, ...patch },
    };
    this._state.progressionId = null;
    this._persist();
    this.dispatchEvent(new CustomEvent("harmony-changed", { detail: { patternId } }));
  }
  get progressionId() { return this._state.progressionId; }
  setProgression(progressionId) {
    const next = buildProgression(progressionId, this._state.key);
    const sec = {};
    DEFAULT_PATTERNS.forEach((p, idx) => {
      sec[p.id] = next[idx % next.length];
    });
    this._state.sectionChords = sec;
    this._state.progressionId = progressionId;
    this._persist();
    this.dispatchEvent(new CustomEvent("harmony-changed"));
  }

  // ── track cache (per slot) ──────────────────────────────────────
  /** Per-slot `{ track_id, region_id }`. Returned shape mirrors the
   *  v1 store's `tracksFor(category)` so call sites barely change. */
  tracksFor(slotId) {
    const slot = this.slotById(slotId);
    return slot ? { track_id: slot.track_id, region_id: slot.region_id } : {};
  }
  setTracks(slotId, patch) {
    const idx = this._state.stage.findIndex((s) => s.id === slotId);
    if (idx < 0) return;
    const slot = this._state.stage[idx];
    const next = [...this._state.stage];
    next[idx] = {
      ...slot,
      track_id: patch.track_id !== undefined ? patch.track_id : slot.track_id,
      region_id: patch.region_id !== undefined ? patch.region_id : slot.region_id,
    };
    this._state.stage = next;
    this._persist();
  }
  invalidateTracks() {
    this._state.stage = this._state.stage.map((s) => ({
      ...s, track_id: null, region_id: null,
    }));
    this._persist();
    this.dispatchEvent(new CustomEvent("tracks-invalidated"));
  }

  // ── parental gate + scary mode (unchanged from v1) ──────────────
  get parentalUnlocked() { return this._state.parentalUnlockUntil > Date.now(); }
  grantParentalUnlock(durationMs = 30 * 60 * 1000) {
    this._state.parentalUnlockUntil = Date.now() + durationMs;
    this._persist();
    this.dispatchEvent(new CustomEvent("parental-changed"));
  }
  clearParentalUnlock() {
    this._state.parentalUnlockUntil = 0;
    this._persist();
    this.dispatchEvent(new CustomEvent("parental-changed"));
  }
  get scaryMode() { return !!this._state.scaryMode && this.parentalUnlocked; }
  setScaryMode(on) {
    if (on && !this.parentalUnlocked) {
      console.warn("[sprunki-store] refused to enable scary mode — parental unlock required");
      return false;
    }
    this._state.scaryMode = !!on;
    this._persist();
    this.dispatchEvent(new CustomEvent("scary-mode-changed"));
    return true;
  }

  // ── style (whole-cast rewrite, edit-respecting) ─────────────────
  //
  // Picking a style flips the cast: each stage slot's patch + per-
  // row step pattern + bpm + chord progression coalesce to a coherent
  // vibe. The cast array in `style-catalog.js` is applied to
  // stage[0..N) in array order.
  //
  // **Respecting user edits** — applyStyle compares each slot's
  // current board to `patchDefaultBoard(currentPatch)`. If they
  // differ (the kid toggled cells in the interior editor), that
  // slot is left alone — its instrument AND beat are preserved.
  // Empty/default slots get the style cast. Tail slots beyond the
  // cast length are cleared.
  //
  // BPM + progression are global session settings, so they apply
  // regardless of how many slots were skipped — even a fully-
  // customized stage benefits from the tempo/progression flip
  // when the user picks a new style.

  /** Tile a 1-bar (16-step) pattern across BARS_PER_PATTERN bars,
   *  same logic as `patchDefaultBoard`. A style's cast authors at
   *  1 bar; the grid is 4 bars wide, so we repeat 0..15 → 0..63. */
  _tilePattern(oneBar) {
    const tileCount = Math.max(1, Math.floor(STEPS_PER_PATTERN / STEPS_PER_BAR));
    const out = [];
    for (let bar = 0; bar < tileCount; bar++) {
      for (const s of oneBar) {
        const step = s + bar * STEPS_PER_BAR;
        if (step < STEPS_PER_PATTERN) out.push(step);
      }
    }
    return out;
  }

  /** Slot-level customization check. A slot is "customized" if it
   *  has a patch AND any of its arrangement boards diverge from
   *  `patchDefaultBoard(patch)`. We compare against the JSON of the
   *  default rather than per-row so a partially-edited slot
   *  (one row toggled, others untouched) still counts as customized.
   *
   *  Slots without a patch — gray polos the kid hasn't dressed yet
   *  — are NOT customized; they accept whatever the style sends. */
  _slotIsCustomized(slot) {
    if (!slot || !slot.patch_id) return false;
    const patch = getPatch(slot.patch_id);
    if (!patch) return false;
    const seed = patchDefaultBoard(patch);
    const seedJson = JSON.stringify(seed);
    for (const board of Object.values(slot.boards || {})) {
      if (!board || Object.keys(board).length === 0) continue;
      const norm = {};
      for (const [rowId, steps] of Object.entries(board)) {
        norm[rowId] = [...(steps || [])].sort((a, b) => a - b);
      }
      if (JSON.stringify(norm) !== seedJson) return true;
    }
    return false;
  }

  /** Apply a style. Walks the stage left-to-right; each slot whose
   *  boards still match the patch default gets the style's cast
   *  entry written in. Customized slots are skipped (their patch +
   *  beats survive). Tail slots beyond the cast are cleared only
   *  when they aren't customized.
   *
   *  BPM + progression apply globally regardless of skipped slots.
   *
   *  Returns a summary object so the caller can show a toast:
   *    { changed: number, skipped: number, total: number }
   *  Or `false` when the call was a no-op (no stage, invalid style). */
  applyStyle(style) {
    if (!style || !Array.isArray(style.cast)) return false;
    const stage = this._state.stage;
    if (stage.length === 0) return false;

    const arrIds = (this._state.arrangements || []).map((a) => a.id);
    if (arrIds.length === 0) arrIds.push(this.activeArrangementId);

    let changed = 0;
    let skipped = 0;

    const next = stage.map((slot, idx) => {
      if (this._slotIsCustomized(slot)) {
        skipped++;
        return slot;
      }
      const entry = style.cast[idx];
      if (!entry || !getPatch(entry.patch_id)) {
        // Tail slot beyond the cast — clear it so the new style's
        // arrangement isn't muddied by a leftover instrument. (Only
        // cleared slots that weren't customized; customized ones
        // are already short-circuited above.)
        if (!slot.patch_id) return slot;
        changed++;
        return { ...slot, patch_id: null, boards: {} };
      }
      // Style cast wins: write the patch + tiled board for every
      // arrangement so multi-part songs stay coherent on the new
      // vibe. (If the kid had multiple arrangements, they get the
      // same beat on each — they can edit per-part afterward.)
      const board = {};
      for (const [rowId, oneBar] of Object.entries(entry.board || {})) {
        if (!Array.isArray(oneBar) || oneBar.length === 0) continue;
        board[rowId] = this._tilePattern(oneBar);
      }
      const boards = {};
      for (const arrId of arrIds) boards[arrId] = { ...board };
      changed++;
      return {
        ...slot,
        patch_id: entry.patch_id,
        boards,
      };
    });

    this._state.stage = next;

    // Tempo lives on the backend (shared session state); the app
    // shell pulls `bpm` off the event detail and pushes it through
    // the debounced control_set path. Progression chords are local
    // — we update them directly here so the harmony-changed event
    // fans out the same way a manual prefs change would. Both
    // apply EVEN WHEN every slot was skipped, because they affect
    // the whole song's feel.
    if (style.progressionId) {
      const prog = buildProgression(style.progressionId, this._state.key);
      const sec = {};
      DEFAULT_PATTERNS.forEach((p, idx) => {
        sec[p.id] = prog[idx % prog.length];
      });
      this._state.sectionChords = sec;
      this._state.progressionId = style.progressionId;
    }

    this._persist();
    this.dispatchEvent(new CustomEvent("stage-changed", {
      detail: {
        kind: "style-applied",
        styleId: style.id,
        bpm: style.bpm,
        changed,
        skipped,
      },
    }));
    if (style.progressionId) {
      this.dispatchEvent(new CustomEvent("harmony-changed"));
    }
    return { changed, skipped, total: stage.length };
  }

  // ── arrangements (multi-part song builder) ──────────────────────
  get arrangements() {
    return (this._state.arrangements || []).map((a) => ({ ...a }));
  }
  get activeArrangementId() {
    return this._state.activeArrangementId || this._state.arrangements?.[0]?.id || "arr.0";
  }
  get activeArrangement() {
    const id = this.activeArrangementId;
    return (this._state.arrangements || []).find((a) => a.id === id) || null;
  }
  arrangementById(id) {
    return (this._state.arrangements || []).find((a) => a.id === id) || null;
  }

  /** Spawn a new arrangement at the end of the strip. Color
   *  picks the next unused swatch from ARRANGEMENT_COLORS, then
   *  wraps. New arrangement inherits the default length. */
  addArrangement() {
    const list = this._state.arrangements || [];
    const usedColors = new Set(list.map((a) => a.color));
    const nextColor = ARRANGEMENT_COLORS.find((c) => !usedColors.has(c))
      || ARRANGEMENT_COLORS[list.length % ARRANGEMENT_COLORS.length];
    const id = `arr.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 6)}`;
    const fresh = {
      id,
      color: nextColor,
      length_bars: DEFAULT_ARRANGEMENT_BARS,
    };
    this._state.arrangements = [...list, fresh];
    this._persist();
    this.dispatchEvent(new CustomEvent("arrangements-changed", {
      detail: { kind: "added", arrangementId: id },
    }));
    return id;
  }

  removeArrangement(id) {
    const list = this._state.arrangements || [];
    if (list.length <= 1) return false;   // always keep at least one
    const next = list.filter((a) => a.id !== id);
    if (next.length === list.length) return false;
    this._state.arrangements = next;
    // Strip any timeline references to this part. If the timeline
    // would empty out, seed a single entry pointing at the new
    // leftmost part so the song stays playable.
    const nextTimeline = (this._state.timeline || []).filter((tid) => tid !== id);
    this._state.timeline = nextTimeline.length > 0 ? nextTimeline : [next[0].id];
    // Clamp the active timeline position so a removal can't leave
    // it pointing past the end of the (now shorter) timeline.
    if (this._state.activeTimelinePosition !== "all") {
      const len = this._state.timeline.length;
      const pos = Number(this._state.activeTimelinePosition);
      if (!Number.isInteger(pos) || pos < 0 || pos >= len) {
        this._state.activeTimelinePosition = 0;
      }
    }
    if (this._state.activeArrangementId === id) {
      this._state.activeArrangementId = next[0].id;
    }
    this._persist();
    this.dispatchEvent(new CustomEvent("arrangements-changed", {
      detail: { kind: "removed", arrangementId: id },
    }));
    return true;
  }

  setArrangementColor(id, color) {
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return false;
    const idx = (this._state.arrangements || []).findIndex((a) => a.id === id);
    if (idx < 0) return false;
    const list = [...this._state.arrangements];
    if (list[idx].color === color) return false;
    list[idx] = { ...list[idx], color };
    this._state.arrangements = list;
    this._persist();
    this.dispatchEvent(new CustomEvent("arrangements-changed", {
      detail: { kind: "recolored", arrangementId: id, color },
    }));
    return true;
  }

  setArrangementLengthBars(id, bars) {
    const n = Math.max(
      MIN_ARRANGEMENT_BARS,
      Math.min(MAX_ARRANGEMENT_BARS, Number(bars) | 0),
    );
    const idx = (this._state.arrangements || []).findIndex((a) => a.id === id);
    if (idx < 0) return false;
    const list = [...this._state.arrangements];
    if (list[idx].length_bars === n) return false;
    list[idx] = { ...list[idx], length_bars: n };
    this._state.arrangements = list;
    this._persist();
    this.dispatchEvent(new CustomEvent("arrangements-changed", {
      detail: { kind: "resized", arrangementId: id, length_bars: n },
    }));
    return true;
  }

  /** Reorder an arrangement by inserting it at `targetIndex`.
   *  The visual chip strip drag-reorders by calling this. */
  moveArrangement(id, targetIndex) {
    const list = [...(this._state.arrangements || [])];
    const from = list.findIndex((a) => a.id === id);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(list.length - 1, targetIndex));
    if (from === to) return false;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    this._state.arrangements = list;
    this._persist();
    this.dispatchEvent(new CustomEvent("arrangements-changed", {
      detail: { kind: "reordered", arrangementId: id, from, to },
    }));
    return true;
  }

  /** Switch which arrangement the stage's editor is FOCUSED on.
   *  Continuous playback plays every chip in chip-strip order
   *  via the layout's `arrangement[]` field, so switching the
   *  active chip changes which step grid the interior editor
   *  paints into — NOT what's audible. The dot picker on the
   *  toolbar shows which chip is in focus. */
  setActiveArrangement(id) {
    const list = this._state.arrangements || [];
    if (!list.some((a) => a.id === id)) return false;
    if (this._state.activeArrangementId === id) return false;
    this._state.activeArrangementId = id;
    this._persist();
    this.dispatchEvent(new CustomEvent("arrangements-changed", {
      detail: { kind: "active-changed", arrangementId: id },
    }));
    // Interior editor re-renders from the new active chip's
    // boards. No audio change — the layout already contains
    // every chip's pattern.
    this.dispatchEvent(new CustomEvent("board-changed", {
      detail: { kind: "arrangement-switch" },
    }));
    return true;
  }

  // ── timeline (ordered list of part references) ─────────────────
  /** Returns the current timeline as a copy. */
  get timeline() { return [...(this._state.timeline || [])]; }

  /** Active position in the timeline — integer index, or "all"
   *  for the play-all selection at the end of the strip. */
  get activeTimelinePosition() {
    const v = this._state.activeTimelinePosition;
    if (v === "all") return "all";
    return Number.isInteger(v) ? v : 0;
  }

  /** Append a part to the end of the timeline. */
  appendTimelineSlot(partId) {
    if (!this.arrangementById(partId)) return false;
    this._state.timeline = [...(this._state.timeline || []), partId];
    this._persist();
    this.dispatchEvent(new CustomEvent("arrangements-changed", {
      detail: { kind: "timeline-added", partId, position: this._state.timeline.length - 1 },
    }));
    return true;
  }

  /** Replace the part at `position` with `partId`. Used by drag
   *  from palette → timeline-slot in the arrangement editor. */
  setTimelineSlot(position, partId) {
    const tl = this._state.timeline || [];
    if (!Number.isInteger(position) || position < 0 || position >= tl.length) return false;
    if (!this.arrangementById(partId)) return false;
    if (tl[position] === partId) return false;
    const next = [...tl];
    next[position] = partId;
    this._state.timeline = next;
    this._persist();
    this.dispatchEvent(new CustomEvent("arrangements-changed", {
      detail: { kind: "timeline-set", position, partId },
    }));
    return true;
  }

  /** Remove the entry at `position`. Won't shrink below 1 slot
   *  (the timeline must always carry at least one part so the
   *  song has audible content). */
  removeTimelineSlot(position) {
    const tl = this._state.timeline || [];
    if (tl.length <= 1) return false;
    if (!Number.isInteger(position) || position < 0 || position >= tl.length) return false;
    const next = [...tl];
    next.splice(position, 1);
    this._state.timeline = next;
    // Clamp the active position if it pointed at or past the
    // removed slot.
    if (this._state.activeTimelinePosition !== "all") {
      const pos = this._state.activeTimelinePosition;
      if (pos >= next.length) this._state.activeTimelinePosition = next.length - 1;
    }
    this._persist();
    this.dispatchEvent(new CustomEvent("arrangements-changed", {
      detail: { kind: "timeline-removed", position },
    }));
    return true;
  }

  /** Move the timeline entry at `from` to `to`. Drag-reorder. */
  moveTimelineSlot(from, to) {
    const tl = this._state.timeline || [];
    if (!Number.isInteger(from) || from < 0 || from >= tl.length) return false;
    const clamped = Math.max(0, Math.min(tl.length - 1, to));
    if (from === clamped) return false;
    const next = [...tl];
    const [item] = next.splice(from, 1);
    next.splice(clamped, 0, item);
    this._state.timeline = next;
    this._persist();
    this.dispatchEvent(new CustomEvent("arrangements-changed", {
      detail: { kind: "timeline-moved", from, to: clamped },
    }));
    return true;
  }

  /** Select which timeline position the loop range tracks. Pass
   *  the literal string "all" to loop the entire song. Setting a
   *  position also pulls the part being edited (`activeArrangementId`)
   *  in sync so the interior editor opens onto the right part. */
  setActiveTimelinePosition(positionOrAll) {
    const tl = this._state.timeline || [];
    let next;
    if (positionOrAll === "all") {
      next = "all";
    } else {
      const n = Number(positionOrAll);
      if (!Number.isInteger(n) || n < 0 || n >= tl.length) return false;
      next = n;
    }
    if (this._state.activeTimelinePosition === next) return false;
    this._state.activeTimelinePosition = next;
    // Pull active arrangement (= editor focus) in sync when the
    // selection points at a concrete part — kid clicks a colored
    // dot, the editor opens onto THAT part next time it's invoked.
    if (next !== "all") {
      const partId = tl[next];
      if (partId && this._state.activeArrangementId !== partId) {
        this._state.activeArrangementId = partId;
      }
    }
    this._persist();
    this.dispatchEvent(new CustomEvent("arrangements-changed", {
      detail: { kind: "active-position-changed", position: next },
    }));
    return true;
  }

  // ── per-COSTUME (patch) program overrides ───────────────────────
  /** Returns the override for a costume, or null if none set. */
  patchOverride(patchId) {
    if (!patchId) return null;
    const v = this._state.patchOverrides?.[patchId];
    return v ? { ...v } : null;
  }
  /** Effective program for a slot holding `patch` — override if
   *  one is set for that patch, otherwise the patch's default.
   *  Only meaningful when the active instrument is GM-program-aware
   *  (gmsynth / fluidsynth). Plugins like AvlDrums ignore program
   *  changes; their "kit" comes from picking a different plugin via
   *  effectivePatchInstrument(). */
  effectivePatchProgram(patch) {
    if (!patch) return null;
    const ov = this.patchOverride(patch.id);
    if (ov && typeof ov.gm_program === "number") {
      return { gm_program: ov.gm_program, gm_channel: ov.gm_channel ?? patch.gm_channel ?? 0 };
    }
    if (typeof patch.gm_program !== "number") return null;
    return { gm_program: patch.gm_program, gm_channel: patch.gm_channel ?? 0 };
  }
  /** Effective instrument URI for a costume — override if the kid
   *  picked a different plugin via the Advanced section, else the
   *  patch's declared default. */
  effectivePatchInstrumentUri(patch) {
    if (!patch) return null;
    const ov = this.patchOverride(patch.id);
    return ov?.instrument_uri || patch.instrument_uri || null;
  }
  /** Effective preset id for a costume, or null if no override. */
  effectivePatchPresetId(patch) {
    if (!patch) return null;
    return this.patchOverride(patch.id)?.preset_id || null;
  }

  /** Apply a partial override patch. Pass null to clear the entire
   *  override for this patch. Keys present in `patch` are set;
   *  keys with value `null` (within `patch`) are deleted from the
   *  override. Returns true if anything actually changed. */
  patchOverridePatch(patchId, patch) {
    if (!patchId) return false;
    const cur = this._state.patchOverrides[patchId] || {};
    if (patch === null) {
      if (!this._state.patchOverrides[patchId]) return false;
      const next = { ...this._state.patchOverrides };
      delete next[patchId];
      this._state.patchOverrides = next;
      this._persist();
      this.dispatchEvent(new CustomEvent("patch-override-changed", {
        detail: { patchId, override: null },
      }));
      return true;
    }
    const merged = { ...cur };
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined) {
        if (k in merged) { delete merged[k]; changed = true; }
      } else if (merged[k] !== v) {
        merged[k] = v;
        changed = true;
      }
    }
    if (!changed) return false;
    this._state.patchOverrides = {
      ...this._state.patchOverrides,
      [patchId]: merged,
    };
    this._persist();
    this.dispatchEvent(new CustomEvent("patch-override-changed", {
      detail: { patchId, override: merged },
    }));
    return true;
  }

  /** Back-compat: old GM-program-only setter. Pass null to clear. */
  setPatchOverride(patchId, gmProgram, gmChannel = null) {
    if (gmProgram == null) return this.patchOverridePatch(patchId, null);
    return this.patchOverridePatch(patchId, {
      gm_program: Number(gmProgram) | 0,
      gm_channel: gmChannel != null ? (Number(gmChannel) | 0) : 0,
    });
  }

  // ── asset source (built-in vs OG archive.org pack) ──────────────
  get assetSource() {
    const s = this._state.assetSource;
    return s === "og" || s === "builtin" ? s : "builtin";
  }
  /** Returns true when the source actually changed. */
  setAssetSource(source) {
    if (source !== "builtin" && source !== "og") return false;
    if (this._state.assetSource === source) return false;
    this._state.assetSource = source;
    this._persist();
    this.dispatchEvent(new CustomEvent("asset-source-changed", {
      detail: { source },
    }));
    return true;
  }

  // ── sprunki asset-pack consent ──────────────────────────────────
  get sprunkiAssetConsentRecorded() { return !!this._state.sprunkiAssetConsentRecorded; }
  recordSprunkiAssetConsent() {
    this._state.sprunkiAssetConsentRecorded = true;
    this._persist();
  }

  // ── internals ───────────────────────────────────────────────────
  _persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this._state)); }
    catch (e) { console.warn("[sprunki-store] localStorage write failed:", e); }
  }
}

let _singleton = null;
export function sprunkiStore() {
  if (!_singleton) _singleton = new SprunkiStore();
  return _singleton;
}

export function resetSprunkiStore() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  _singleton = null;
}

export { PATCHES, DEFAULT_PATTERNS };
