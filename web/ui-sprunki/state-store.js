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

import { DEFAULT_PATTERNS } from "./components/sound-catalog.js";
import { PATCHES, getPatch, patchDefaultBoard } from "./patches.js";
import { buildProgression } from "./theory.js";

const STORAGE_KEY = "foyer.sprunki.v2";
// v3: every slot defaults to empty (gray Polo) — matches OG boot
// behaviour — and the patch library was renumbered 1:1 to the OG
// character cast, so old saved patch_ids no longer resolve. The
// migration path is "discard v2; start fresh"; the patch_palette
// makes it cheap to rebuild any stage that was there.
const VERSION = 3;

/** Default number of sprunkis on a fresh stage. Free-form
 *  positioning means this is a guideline, not a cap; slots can
 *  be added/removed dynamically (future). */
export const DEFAULT_STAGE_SLOT_COUNT = 7;

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
    const x = 0.12 + t * 0.76;
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
  const boards = (s.boards && typeof s.boards === "object") ? s.boards : {};
  return {
    id, x, y, patch_id, boards,
    track_id: typeof s.track_id === "string" ? s.track_id : null,
    region_id: typeof s.region_id === "string" ? s.region_id : null,
  };
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (parsed.version !== VERSION) return defaultState();
    const seed = defaultState();
    const stage = Array.isArray(parsed.stage) && parsed.stage.length > 0
      ? parsed.stage.map((s, i) => sanitizeSlot(s, i)).filter(Boolean)
      : seed.stage;
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
    const activePat = this._state.activePatternId;
    const boards = { ...slot.boards };
    // Seed the active section if it's empty (or if the row ids
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
   *  the "drag patch onto empty stage" gesture. */
  spawnSlot(x, y, patchId = null) {
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
    const board = slot.boards[this._state.activePatternId] || {};
    return new Set(board[rowId] || []);
  }
  toggleCell(slotId, rowId, step) {
    const idx = this._state.stage.findIndex((s) => s.id === slotId);
    if (idx < 0) return;
    const slot = this._state.stage[idx];
    const activePat = this._state.activePatternId;
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
  clearActivePattern() {
    const activePat = this._state.activePatternId;
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
  get activePatternId() { return this._state.activePatternId; }
  setActivePatternId(id) {
    if (this._state.activePatternId === id) return;
    this._state.activePatternId = id;
    this._persist();
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
