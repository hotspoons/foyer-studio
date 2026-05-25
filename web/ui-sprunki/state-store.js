// Sprunki state store — single source of truth for the player's
// boards, transport preferences, instrument choices, and the
// backend track/region IDs we lazily provisioned on first launch.
//
// Persistence shape (localStorage key `foyer.sprunki.v1`):
//   {
//     version: 1,
//     boards: {
//       [patternId]: { [charId]: number[] }   // active step indices
//     },
//     activePatternId: "intro",
//     transport: { mode: "section"|"all", loop: true },
//     prefs: {
//       [category]: { instrument_uri: string, gm_program: number }
//     },
//     tracks: {
//       [category]: { track_id?: string, region_id?: string }
//     }
//   }
//
// The boards/prefs/transport portion is the player's authored work —
// it travels with the user. The `tracks` block is a CACHE of the
// IDs the backend handed us when we created the category tracks;
// it's session-scoped (cleared on session change) so a stale ID
// from a previous Ardour project can't make us write into a region
// that no longer exists.

import { CHARACTERS, CATEGORIES, DEFAULT_PATTERNS } from "./components/sound-catalog.js";

const STORAGE_KEY = "foyer.sprunki.v1";
const VERSION = 1;

function defaultPrefs() {
  const out = {};
  for (const cat of CATEGORIES) {
    out[cat.id] = {
      instrument_uri: cat.default_instrument_uri,
      gm_program: cat.default_gm_program,
    };
  }
  return out;
}

function defaultBoards() {
  // Seed the Intro pattern with a basic four-on-the-floor + back-
  // beat snare + offbeat hi-hat. Without ANY seed, a fresh boot
  // shows tracks playing a loop with zero notes — which looks
  // exactly like a broken audio chain ("transport is moving but
  // nothing comes out"). A tiny default groove makes "press Play
  // and hear something" the first-launch experience and gives the
  // user a working reference when debugging audio routing.
  // Steps 0..15 = sixteenth notes inside one bar.
  return {
    intro: {
      kick:  [0, 4, 8, 12],     // four-on-the-floor
      snare: [4, 12],           // backbeat on 2 and 4
      hihat: [2, 6, 10, 14],    // offbeat
    },
    verse:  {},
    chorus: {},
    drop:   {},
  };
}

function defaultState() {
  return {
    version: VERSION,
    boards: defaultBoards(),
    activePatternId: DEFAULT_PATTERNS[0].id,
    transport: { mode: "section", loop: true },
    prefs: defaultPrefs(),
    tracks: {},
    // Kid-safety gating. `scaryMode` controls whether scary
    // sprunki content (variants with disturbing imagery) is even
    // surfaced; default is OFF so the kid is never accidentally
    // shown a scary character. Flipping it on requires a parental
    // quiz that's hard for a 5-year-old to guess.
    scaryMode: false,
    // `parentalUnlocked` tracks whether the parent has solved the
    // current session's quiz. Stored with an expiry timestamp so
    // walking away from the keyboard doesn't leave the unlock
    // permanently open. Cleared on every page reload — the quiz
    // is short enough that re-solving on each launch is fine.
    parentalUnlockUntil: 0,
    // Has the user dismissed (or accepted) the sprunki download
    // consent prompt? Tracked separately from the actual download
    // state so we never re-show the prompt if the user said no
    // (they can opt in later via the prefs modal).
    sprunkiAssetConsentRecorded: false,
  };
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (parsed.version !== VERSION) return defaultState();
    // Backfill missing keys so a v1 blob written before we added a
    // field doesn't make consumers null-check everywhere.
    const seed = defaultState();
    return {
      version: VERSION,
      boards: { ...seed.boards, ...(parsed.boards || {}) },
      activePatternId: parsed.activePatternId || seed.activePatternId,
      transport: { ...seed.transport, ...(parsed.transport || {}) },
      prefs: { ...seed.prefs, ...(parsed.prefs || {}) },
      tracks: parsed.tracks || {},
      scaryMode: !!parsed.scaryMode,
      // Parental unlock NEVER survives a reload by design — every
      // tab open re-prompts. We just keep the field shape so
      // existing v1 blobs round-trip cleanly; the value is reset.
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
    // Bind a session-id watchdog so a backend swap (different
    // Ardour session) wipes the cached track/region IDs — they
    // belong to the *previous* session and writing to them
    // would silently land notes in a region the user can't see.
    this._installSessionWatchdog();
  }

  _installSessionWatchdog() {
    const store = globalThis.__foyer?.store;
    if (!store) return;
    const onSwap = () => {
      if (Object.keys(this._state.tracks).length === 0) return;
      this._state.tracks = {};
      this._persist();
      this.dispatchEvent(new CustomEvent("tracks-invalidated"));
    };
    store.addEventListener?.("envelope", (ev) => {
      const t = ev?.detail?.body?.type;
      if (t === "backend_swapped" || t === "session_opened") onSwap();
    });
  }

  /** Snapshot copy of the current state. Don't mutate the result. */
  snapshot() {
    return JSON.parse(JSON.stringify(this._state));
  }

  // ── boards ────────────────────────────────────────────────────
  /** Steps active for a (pattern, character) cell, as a Set. */
  cells(patternId, charId) {
    const board = this._state.boards[patternId] || {};
    return new Set(board[charId] || []);
  }
  toggleCell(patternId, charId, step) {
    const next = JSON.parse(JSON.stringify(this._state.boards[patternId] || {}));
    const arr = next[charId] || [];
    const idx = arr.indexOf(step);
    if (idx >= 0) arr.splice(idx, 1);
    else { arr.push(step); arr.sort((a, b) => a - b); }
    next[charId] = arr;
    this._state.boards[patternId] = next;
    this._persist();
    this.dispatchEvent(new CustomEvent("board-changed", { detail: { patternId, charId } }));
  }
  clearPattern(patternId) {
    this._state.boards[patternId] = {};
    this._persist();
    this.dispatchEvent(new CustomEvent("board-changed", { detail: { patternId } }));
  }

  // ── active pattern ────────────────────────────────────────────
  get activePatternId() { return this._state.activePatternId; }
  setActivePatternId(id) {
    if (this._state.activePatternId === id) return;
    this._state.activePatternId = id;
    this._persist();
    this.dispatchEvent(new CustomEvent("pattern-changed", { detail: { id } }));
  }

  // ── transport prefs ───────────────────────────────────────────
  get transport() { return { ...this._state.transport }; }
  setTransport(patch) {
    this._state.transport = { ...this._state.transport, ...patch };
    this._persist();
    this.dispatchEvent(new CustomEvent("transport-changed"));
  }

  // ── instrument prefs ─────────────────────────────────────────
  prefsFor(categoryId) { return { ...(this._state.prefs[categoryId] || {}) }; }
  setPrefs(categoryId, patch) {
    this._state.prefs[categoryId] = { ...(this._state.prefs[categoryId] || {}), ...patch };
    this._persist();
    this.dispatchEvent(new CustomEvent("prefs-changed", { detail: { categoryId } }));
  }
  allPrefs() { return JSON.parse(JSON.stringify(this._state.prefs)); }

  // ── track/region cache ───────────────────────────────────────
  tracksFor(categoryId) { return { ...(this._state.tracks[categoryId] || {}) }; }
  setTracks(categoryId, patch) {
    this._state.tracks[categoryId] = { ...(this._state.tracks[categoryId] || {}), ...patch };
    this._persist();
  }
  invalidateTracks() {
    this._state.tracks = {};
    this._persist();
    this.dispatchEvent(new CustomEvent("tracks-invalidated"));
  }

  // ── parental gate + scary mode ───────────────────────────────
  /** Is the parental unlock currently valid? Returns false once the
   *  expiry has passed. Page reloads always start locked because
   *  `parentalUnlockUntil` is reset to 0 on every load. */
  get parentalUnlocked() {
    return this._state.parentalUnlockUntil > Date.now();
  }
  /** Grant the parental unlock for `durationMs` (defaults to 30 min).
   *  Called by the parental-gate modal after a correct quiz answer. */
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

  /** Whether scary-mode content (horror sprunki variants) is allowed
   *  to be surfaced anywhere in the UI. Default false. Flipping it
   *  on requires `parentalUnlocked === true`; we enforce that here
   *  rather than just at the caller. */
  get scaryMode() {
    return !!this._state.scaryMode && this.parentalUnlocked;
  }
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

  // ── sprunki asset-pack consent ───────────────────────────────
  get sprunkiAssetConsentRecorded() {
    return !!this._state.sprunkiAssetConsentRecorded;
  }
  recordSprunkiAssetConsent() {
    this._state.sprunkiAssetConsentRecorded = true;
    this._persist();
  }

  // ── internals ─────────────────────────────────────────────────
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

/** Reset everything — used by the "Clear all" button in prefs. */
export function resetSprunkiStore() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  _singleton = null;
}

/** Re-export some constants the consumers commonly want from this
 *  module so they don't have to also import sound-catalog.js. */
export { CHARACTERS, CATEGORIES, DEFAULT_PATTERNS };
