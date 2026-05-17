// Beat sequencer for a single MIDI region — Hydrogen-style.
//
// Layout:
//   ┌────────────────────────────────────────────────────────────┐
//   │ toolbar: mode · pattern_steps · res · vel · tempo · clear  │
//   ├────────────────────────────────────────────────────────────┤
//   │ seek bar (session position, click to seek)                 │
//   ├────────────────────────────────────────────────────────────┤
//   │ ARRANGEMENT  (top — Hydrogen song view)                    │
//   │   rows = patterns                                          │
//   │   cols = song bars                                         │
//   │   cells = pattern triggers                                 │
//   ├────────────────────────────────────────────────────────────┤
//   │ PATTERN EDITOR (bottom — the cell grid for selected pat)   │
//   │   rows = drum hits / pitches                               │
//   │   cols = steps within ONE bar                              │
//   ├────────────────────────────────────────────────────────────┤
//   │ velocity lane (drum mode only)                             │
//   └────────────────────────────────────────────────────────────┘
//
// The whole thing serializes into ONE region's `_extra_xml` blob.
// The arrangement extent (highest-bar slot) drives the region's
// length on the shim side. No multi-region "+New pattern" dance —
// patterns live INSIDE the layout and are arranged on the song
// grid. This matches Hydrogen's data model and Rich's 2026-04-21
// redesign ask.
//
// Frontend just ships SetSequencerLayout with the full layout
// blob; the sidecar regenerates notes via expand_sequencer_layout
// and the shim does the atomic ReplaceRegionNotes.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { playPreviewNote, resumePreviewCtx } from "foyer-core/audio/midi-preview.js";
import { chordIntervals, SCALES, PITCH_CLASS_LABELS } from "foyer-core/music-theory.js";
// Reuse the transport bar's drag-to-scrub tempo control rather than a
// plain `<input type="number">` — fine/coarse step + drag handling
// already match the rest of the app's "tempo" affordance.
import "foyer-ui-core/widgets/number-scrub.js";
// Side-strip embedded body — see `_toggleStrip` + render().
import "./midi-manager.js";
import { sequencerStyles } from "./beat-sequencer.styles.js";

// Matches Ardour's `Temporal::ticks_per_beat` and the
// `expand_sequencer_layout` PPQN the server uses to render this
// layout to MIDI notes. The pre-2026-05 960 hardcode was off by 2x
// — beat-sequencer step ticks would have come out at half the
// shim's actual scale.
const PPQN = 1920;
const PREVIEW_PREF_KEY = "foyer.beat.preview.v1";
const ARR_HEIGHT_KEY = "foyer.beat.arr-height.v1";
const PRESETS_KEY = "foyer.beat.presets.v1";
const STRIP_WIDTH_KEY = "foyer.beat.strip-width.v1";
const STRIP_WIDTH_MIN = 280;
const STRIP_WIDTH_DEFAULT = 420;
const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// General-MIDI drum map — the short-name subset used by the "+ Drum" picker.
// Just the practical kit names; the picker also lets the user type a label
// if they want something non-GM.
const GM_DRUM_KIT = [
  { pitch: 35, label: "Kick 2" },
  { pitch: 36, label: "Kick" },
  { pitch: 37, label: "Side stick" },
  { pitch: 38, label: "Snare" },
  { pitch: 39, label: "Clap" },
  { pitch: 40, label: "Snare 2" },
  { pitch: 41, label: "Low tom" },
  { pitch: 42, label: "HH closed" },
  { pitch: 43, label: "High floor tom" },
  { pitch: 44, label: "HH pedal" },
  { pitch: 45, label: "Mid tom" },
  { pitch: 46, label: "HH open" },
  { pitch: 47, label: "Low-mid tom" },
  { pitch: 48, label: "Hi-mid tom" },
  { pitch: 49, label: "Crash" },
  { pitch: 50, label: "High tom" },
  { pitch: 51, label: "Ride" },
  { pitch: 52, label: "China" },
  { pitch: 53, label: "Ride bell" },
  { pitch: 54, label: "Tambourine" },
  { pitch: 55, label: "Splash" },
  { pitch: 56, label: "Cowbell" },
  { pitch: 57, label: "Crash 2" },
  { pitch: 58, label: "Vibraslap" },
  { pitch: 59, label: "Ride 2" },
];

const STEP_COUNTS = [8, 16, 32, 64];
const RESOLUTIONS = [
  { label: "1/4",  subdiv: 1 },
  { label: "1/8",  subdiv: 2 },
  { label: "1/16", subdiv: 4 },
  { label: "1/32", subdiv: 8 },
];
const CELL_WIDTHS = [10, 14, 20, 28, 40, 56, 80];

const PITCH_LABELS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
function isBlackKey(p) { return BLACK_KEYS.has(p % 12); }
function pitchLabel(p) {
  const oct = Math.floor(p / 12) - 1;
  return `${PITCH_LABELS[p % 12]}${oct}`;
}

const PATTERN_COLORS = [
  "#7c5cff", "#f59e0b", "#22d3ee", "#fb7185", "#34d399", "#a78bfa",
  "#fcd34d", "#fda4af", "#67e8f9", "#6ee7b7",
];
function pickPatternColor(idx) {
  return PATTERN_COLORS[idx % PATTERN_COLORS.length];
}
function newPatternId() {
  return `p.${Math.random().toString(36).slice(2, 9)}`;
}

function defaultPitchedRows() {
  const out = [];
  for (let pitch = 84; pitch >= 36; pitch--) {
    out.push({
      pitch,
      label: pitchLabel(pitch),
      channel: 0,
      color: isBlackKey(pitch) ? "#6b7280" : "#7c5cff",
    });
  }
  return out;
}

function defaultDrumRows() {
  return [
    { pitch: 36, label: "Kick",     channel: 9, color: "#f59e0b" },
    { pitch: 38, label: "Snare",    channel: 9, color: "#a78bfa" },
    { pitch: 42, label: "HH closed", channel: 9, color: "#22d3ee" },
    { pitch: 46, label: "HH open",   channel: 9, color: "#67e8f9" },
    { pitch: 49, label: "Crash",    channel: 9, color: "#fb7185" },
    { pitch: 51, label: "Ride",     channel: 9, color: "#fda4af" },
    { pitch: 45, label: "Mid tom",  channel: 9, color: "#fcd34d" },
    { pitch: 41, label: "Low tom",  channel: 9, color: "#fbbf24" },
  ];
}

function defaultLayout() {
  const id = newPatternId();
  return {
    version: 2,
    mode: "drum",
    resolution: 4,
    pattern_steps: 16,
    active: true,
    rows: defaultDrumRows(),
    patterns: [{ id, name: "Pattern 1", color: pickPatternColor(0), cells: [], free_notes: [] }],
    arrangement: [{ pattern_id: id, bar: 0, arrangement_row: 0 }],
  };
}

// Coerce `resolution` to the nearest valid subdiv — matches the
// values the Res dropdown offers. Sessions round-tripped through
// the shim's XML can come back with 0 (property missing) or a
// stale stale value; clamp so the dropdown doesn't render a
// "no-match → first-option" fallback that looks like a silent reset.
function normalizeResolution(v) {
  const allowed = [1, 2, 4, 8];
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 4;
  return allowed.includes(n) ? n : 4;
}

// Migrate a v1 layout (top-level cells, no patterns) into a v2
// shape with one synthesized "Pattern 1" containing those cells.
// Also normalizes resolution/pattern_steps so the rest of the
// component doesn't have to defensively check these.
//
// IMPORTANT: when the input is *already* fully normalized, return
// the same reference. The component's `updated()` assigns
// `this.layout = migrateToV2(this.layout)`, and Lit's default
// hasChanged compares by identity — so if we always returned a
// fresh object, that assignment would fire another `updated()`
// cycle, re-migrate, and loop forever (which is exactly the
// freeze Rich hit on 2026-04-22). Returning the same ref when
// nothing needs rewriting makes the assignment a no-op and
// breaks the cycle.
function migrateToV2(layout) {
  if (!layout) return defaultLayout();
  const resolution = normalizeResolution(layout.resolution);
  const pattern_steps = Number(layout.pattern_steps ?? layout.steps ?? 16) || 16;
  if (layout.patterns && layout.patterns.length > 0) {
    // Already v2. Return the same reference when nothing needs
    // rewriting — the render loop assigns `this.layout =
    // migrateToV2(this.layout)` and Lit's hasChanged default is
    // strict-equality, so returning a fresh object every time
    // creates an infinite `updated()` recursion (Rich's
    // 2026-04-22 freeze).
    //
    // `active` is deliberately NOT compared/rewritten here: its
    // default (undefined → treated as true) is read safely
    // everywhere via `layout.active !== false`. If we wrote
    // `active: true` back into an input that had undefined, the
    // ref would change on every pass → loop.
    if (layout.resolution === resolution && layout.pattern_steps === pattern_steps) {
      return layout;
    }
    return { ...layout, resolution, pattern_steps };
  }
  const id = newPatternId();
  return {
    ...layout,
    version: 2,
    resolution,
    pattern_steps,
    // `active` is intentionally not set here — readers check
    // `layout.active !== false` so undefined is fine. Writing it
    // explicitly would just bloat the blob; the explicit
    // `active` only appears when the user flips it to false via
    // "Convert to MIDI".
    patterns: [{
      id,
      name: "Pattern 1",
      color: pickPatternColor(0),
      cells: layout.cells || [],
      free_notes: layout.free_notes || [],
    }],
    arrangement: layout.arrangement && layout.arrangement.length
      ? layout.arrangement
      : [{ pattern_id: id, bar: 0, arrangement_row: 0 }],
    cells: [],
    free_notes: [],
  };
}

export class BeatSequencer extends LitElement {
  static properties = {
    regionId:   { type: String, attribute: "region-id" },
    regionName: { type: String, attribute: "region-name" },
    trackId:    { type: String, attribute: "track-id" },
    layout:     { attribute: false },
    notes:      { attribute: false },
    trackRegions: { attribute: false },
    _tick:      { state: true, type: Number },
    _cellW:     { state: true, type: Number },
    _selectedPatternId: { state: true, type: String },
    _arrCols:   { state: true, type: Number },
    _arrH:      { state: true, type: Number },
    _preview:   { state: true, type: Boolean },
    _addDrum:   { state: true, type: Boolean },
    _drumPitch: { state: true, type: Number },
    _drumLabel: { state: true, type: String },
    _presetsOpen: { state: true, type: Boolean },
    _stripOpen: { state: true, type: Boolean },
  };

  static styles = sequencerStyles;

  constructor() {
    super();
    this.regionId = "";
    this.regionName = "";
    this.trackId = "";
    this.layout = null;
    // True only after `this.layout` has been seeded from a backend
    // source (the `.layout` property assigned externally, or a
    // `foyer:sequencer-layout-changed` event carrying a layout). When
    // false, we're rendering against a local fallback that
    // `_currentLayout()` synthesized — auto-persisting that one would
    // clobber whatever the agent / another client just set. Set true
    // in the property accessor below + in the sequencer-layout-changed
    // listener; checked by the tempo-change re-persist path.
    this._layoutFromBackend = false;
    this.notes = [];
    this.trackRegions = [];
    this._tick = 0;
    this._cellW = 28;
    this._defaultVelocity = 100;
    this._paintState = null;
    this._selectedPatternId = "";
    this._arrCols = 16;
    this._arrH = Number(localStorage.getItem(ARR_HEIGHT_KEY)) || 200;
    // Last arrangement bar the user clicked. Shift-click on a second
    // bar uses this as the loop anchor (matches the timeline ruler
    // shift-click-to-extend-selection pattern).
    this._lastArrBar = -1;
    this._preview = localStorage.getItem(PREVIEW_PREF_KEY) === "1";
    this._addDrum = false;
    this._drumPitch = 36;
    this._drumLabel = "Custom";
    this._presetsOpen = false;
    // Slide-out instruments/patches drawer on the right edge.
    // Remembered across opens so a user who prefers it visible
    // doesn't have to re-open it every time. PLAN 154.
    try {
      this._stripOpen = localStorage.getItem("foyer.beat.strip-open") === "1";
    } catch {
      this._stripOpen = false;
    }
    try {
      const raw = Number(localStorage.getItem(STRIP_WIDTH_KEY));
      this._stripW = Number.isFinite(raw) && raw >= STRIP_WIDTH_MIN ? raw : STRIP_WIDTH_DEFAULT;
    } catch {
      this._stripW = STRIP_WIDTH_DEFAULT;
    }
    this._stripResizeActive = false;
    this._onStripResizeMoveBound = null;
    this._onStripResizeUpBound = null;
    this._stripResizeStartX = 0;
    this._stripResizeStartW = this._stripW;
    this._onStoreControl = (ev) => {
      if (ev.detail === "transport.position"
          || ev.detail === "transport.tempo"
          || ev.detail === "transport.playing") {
        this.requestUpdate();
      }
      // When the tempo changes (from any source — transport bar,
      // automation, DAW timeline) re-persist the active sequencer
      // layout so the server re-expands the notes at the new beat
      // grid.  Without this, step counts are fixed but the tick→
      // sample conversion changes silently, making the notes drift
      // relative to the visual ruler until the user edits the grid.
      // Only re-persist when the layout was actually loaded from the
      // backend. Lazy local defaults from `_currentLayout()` should
      // not be written back — that's the read-on-mount → echo-as-write
      // bug that clobbered MCP-authored patterns the moment a tab
      // opened the sequencer view.
      if (
        ev.detail === "transport.tempo"
        && this.layout?.active
        && this._layoutFromBackend
      ) {
        this._persistLayout();
      }
    };
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.store?.addEventListener("control", this._onStoreControl);
    window.__foyer?.store?.addEventListener("change", this._onStoreControl);
    // Listen for convert/restore broadcasts from the piano roll so
    // we update our archived state without waiting for a region_updated
    // echo (the shim doesn't broadcast for metadata-only writes).
    this._onSequencerLayoutChanged = (ev) => {
      const d = ev?.detail || {};
      if (!d.regionId || d.regionId !== this.regionId) return;
      if (!d.layout) return;
      this.layout = d.layout;
      this._layoutFromBackend = true;
      this._tick++;
      this.requestUpdate();
    };
    window.addEventListener("foyer:sequencer-layout-changed", this._onSequencerLayoutChanged);
    // Latch number keys 3..9 while held — pitched-mode cell clicks
    // use them as a chord modifier (matches the piano-roll behavior).
    // Resolved against the user's stored scale prefs from the
    // piano-roll toolbar so the editors stay consistent.
    this._heldChordDigit = null;
    this._onChordKeyDown = (e) => {
      // Only latch when the pointer is hovering this editor so a
      // background sequencer doesn't steal the digit from the focused
      // editor. CSS `:hover` propagates from hovered descendants up
      // to the host, so this matches whenever the cursor is anywhere
      // inside the editor.
      if (!this.matches?.(":hover")) return;
      // Don't latch while typing in a text field (number inputs in
      // the toolbar) — let the field receive the key.
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = e.key;
      if (/^[3456789]$/.test(k)) this._heldChordDigit = parseInt(k, 10);
    };
    this._onChordKeyUp = (e) => {
      const k = e.key;
      if (/^[3456789]$/.test(k) && this._heldChordDigit === parseInt(k, 10)) {
        this._heldChordDigit = null;
      }
    };
    window.addEventListener("keydown", this._onChordKeyDown);
    window.addEventListener("keyup",   this._onChordKeyUp);
    window.addEventListener("blur",    this._onChordKeyUp);
    // Re-render when the host foyer-window flips maximized so the
    // transport strip appears/disappears reactively.
    this._onMaximizeChanged = () => { this._tick++; this.requestUpdate(); };
    document.addEventListener("foyer-window-maximize-changed", this._onMaximizeChanged);
    // Client-side undo/redo. Bound on `this` so the listener is
    // unique per instance — a beat sequencer in a foyer-window
    // gets its own ring keyed on its element identity.
    this._onKeyForUndo = (ev) => {
      // Only react when the user is actually focused inside this
      // editor (or a child) — avoids hijacking Ctrl+Z in the timeline
      // / mixer / piano roll. Walk the composed path looking for
      // ourselves.
      const path = ev.composedPath ? ev.composedPath() : [];
      if (!path.includes(this)) return;
      // Don't grab when typing in an input — let the field's native
      // undo work.
      const t = ev.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const meta = ev.ctrlKey || ev.metaKey;
      if (!meta) return;
      const k = (ev.key || "").toLowerCase();
      if (k === "z" && !ev.shiftKey) {
        if (this.undo()) { ev.preventDefault(); ev.stopPropagation(); }
      } else if ((k === "z" && ev.shiftKey) || k === "y") {
        if (this.redo()) { ev.preventDefault(); ev.stopPropagation(); }
      }
    };
    document.addEventListener("keydown", this._onKeyForUndo, true);
  }
  firstUpdated() {
    // Lit binds @wheel= as a passive listener in some browsers,
    // which makes our preventDefault() a no-op — the browser still
    // horizontally scrolls on Shift-wheel. Re-attach the grid
    // wheel handler non-passively so cell velocity + zoom both
    // consume the event cleanly.
    const body = this.renderRoot?.querySelector?.(".body");
    if (body && !this._wheelBound) {
      body.addEventListener("wheel", (ev) => this._onBodyWheel(ev), { passive: false });
      this._wheelBound = true;
    }
  }
  _onBodyWheel(ev) {
    // Zoom is Ctrl/Meta-wheel (preserved from the old handler).
    if (ev.ctrlKey || ev.metaKey) return this._onGridWheel(ev);
    if (!ev.shiftKey) return;
    // Shift-wheel: adjust the velocity of the cell under the
    // pointer. Resolve the target cell via elementFromPoint so
    // we work regardless of which element the wheel technically
    // fired on (the scrolling container, a .vel overlay, etc.).
    const el = this.renderRoot.elementFromPoint
      ? this.renderRoot.elementFromPoint(ev.clientX, ev.clientY)
      : document.elementFromPoint(ev.clientX, ev.clientY);
    const cell = el?.closest?.(".cell");
    if (!cell) return;
    const row = Number(cell.dataset.row);
    const step = Number(cell.dataset.step);
    if (Number.isNaN(row) || Number.isNaN(step)) return;
    this._onCellWheel(ev, row, step);
  }
  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("control", this._onStoreControl);
    window.__foyer?.store?.removeEventListener("change", this._onStoreControl);
    if (this._onSequencerLayoutChanged) {
      window.removeEventListener("foyer:sequencer-layout-changed", this._onSequencerLayoutChanged);
    }
    if (this._onKeyForUndo) document.removeEventListener("keydown", this._onKeyForUndo, true);
    if (this._onChordKeyDown) {
      window.removeEventListener("keydown", this._onChordKeyDown);
      window.removeEventListener("keyup",   this._onChordKeyUp);
      window.removeEventListener("blur",    this._onChordKeyUp);
    }
    if (this._onMaximizeChanged) {
      document.removeEventListener("foyer-window-maximize-changed", this._onMaximizeChanged);
    }
    this._stopStripResize();
    super.disconnectedCallback();
  }

  updated(changed) {
    if (changed.has("regionId") && this.regionId && !this.layout) {
      // Tile-leaf mounts pass only `regionId` / `trackId` — no
      // `.layout`. Look up the region in the live snapshot and
      // adopt its persisted sequencer layout. Without this, the
      // component falls through to `defaultLayout()` in
      // `_currentLayout()` and any MCP-authored pattern reads as
      // an empty fresh starter to the user (and to the next
      // re-persist).
      try {
        const byTrack = window.__foyer?.store?.state?.regionsByTrack;
        if (byTrack && typeof byTrack.entries === "function") {
          for (const [tid, list] of byTrack.entries()) {
            const found = (list || []).find((r) => r.id === this.regionId);
            if (found?.foyer_sequencer) {
              this.layout = found.foyer_sequencer;
              this._layoutFromBackend = true;
              this.trackId = this.trackId || tid;
              break;
            }
          }
        }
      } catch {}
    }
    if (changed.has("layout") || changed.has("regionId")) {
      // Always route incoming layouts through migrateToV2 so both
      // v1 and v2 get normalized (resolution clamped, pattern_steps
      // coerced). Fixes a first-open bug where a stored v2 layout
      // with a missing / stale `resolution` attr silently rendered
      // as 1/8 because the Res dropdown's ?selected match failed
      // and the browser fell through to the second option.
      if (this.layout) {
        this.layout = migrateToV2(this.layout);
      }
      // Default the pattern selection to the first pattern of the
      // current layout.
      const L = this._currentLayout();
      if (!L.patterns.find((p) => p.id === this._selectedPatternId)) {
        this._selectedPatternId = L.patterns[0]?.id || "";
      }
    }
  }

  _currentLayout() {
    if (!this.layout) this.layout = defaultLayout();
    if (!this.layout.patterns || this.layout.patterns.length === 0) {
      this.layout = migrateToV2(this.layout);
    }
    return this.layout;
  }
  _selectedPattern() {
    const L = this._currentLayout();
    return L.patterns.find((p) => p.id === this._selectedPatternId) || L.patterns[0];
  }

  // ── persistence ──────────────────────────────────────────────────
  _persistLayout() {
    const ws = window.__foyer?.ws;
    if (!ws || !this.regionId) return;
    ws.send({
      type: "set_sequencer_layout",
      region_id: this.regionId,
      layout: this.layout,
    });
  }

  _commit(mutator) {
    // Apply `mutator(layout)` immutably-ish, persist, re-render.
    const L = this._currentLayout();
    const next = JSON.parse(JSON.stringify(L));
    mutator(next);
    // Push the BEFORE snapshot onto the per-instance undo ring; any
    // fresh edit invalidates the redo stack. Bounded so a busy user
    // can't balloon memory on a long session. (Rich, TODO #45 —
    // intentionally client-side: the backend already has its own
    // Ardour-side undo; this ring is just for "I tweaked the
    // sequencer pattern, gimme back the previous arrangement.")
    this._pushUndoSnapshot(L);
    this._redoStack = [];
    this.layout = next;
    this._persistLayout();
    this._tick++;
  }

  _pushUndoSnapshot(layout) {
    if (!this._undoStack) this._undoStack = [];
    if (!this._redoStack) this._redoStack = [];
    // Cheap structural-equality skip so a no-op edit doesn't pollute
    // the ring (e.g. a click that toggled a cell on then immediately
    // off in the same gesture).
    const top = this._undoStack[this._undoStack.length - 1];
    const snap = JSON.stringify(layout);
    if (top === snap) return;
    this._undoStack.push(snap);
    if (this._undoStack.length > 64) this._undoStack.shift();
  }

  undo() {
    if (!this._undoStack?.length) return false;
    const cur = this._currentLayout();
    const prev = this._undoStack.pop();
    if (!this._redoStack) this._redoStack = [];
    this._redoStack.push(JSON.stringify(cur));
    if (this._redoStack.length > 64) this._redoStack.shift();
    try {
      this.layout = JSON.parse(prev);
      this._persistLayout();
      this._tick++;
    } catch {}
    return true;
  }

  redo() {
    if (!this._redoStack?.length) return false;
    const cur = this._currentLayout();
    const nxt = this._redoStack.pop();
    if (!this._undoStack) this._undoStack = [];
    this._undoStack.push(JSON.stringify(cur));
    try {
      this.layout = JSON.parse(nxt);
      this._persistLayout();
      this._tick++;
    } catch {}
    return true;
  }

  // ── pattern grid ops ─────────────────────────────────────────────
  _isOnInPattern(pattern, row, step) {
    return pattern?.cells?.some((c) => c.row === row && c.step === step);
  }
  _velocityInPattern(pattern, row, step) {
    return pattern?.cells?.find((c) => c.row === row && c.step === step)?.velocity
      ?? this._defaultVelocity;
  }
  _cellLenSteps(pattern, row, step) {
    return pattern?.cells?.find((c) => c.row === row && c.step === step)?.length_steps ?? 1;
  }
  _maxVelocityInPattern(pattern, step) {
    let max = 0;
    for (const c of pattern?.cells || []) if (c.step === step && c.velocity > max) max = c.velocity;
    return max;
  }

  // ── shared scale prefs (mirror the piano roll's localStorage keys
  //    so a single Scale picker drives both editors). ─────────────
  _readScaleRoot() {
    try {
      const v = parseInt(localStorage.getItem("foyer.midi.scale.root") ?? "0", 10);
      return Number.isFinite(v) ? v : 0;
    } catch { return 0; }
  }
  _readScaleMode() {
    try {
      return localStorage.getItem("foyer.midi.scale.mode") || "chromatic";
    } catch { return "chromatic"; }
  }

  /** Chord-resize drag: pulling right grows every chord cell's
   *  `length_steps` together. Called only from the chord branch in
   *  `_onCellDown` after the chord cells have been toggled on. */
  _beginChordResize(ev, rows, step) {
    const startX = ev.clientX;
    const cellW = this._cellW || 24;
    const L = this._currentLayout();
    const maxLen = Math.max(1, L.pattern_steps - step);
    const onMove = (e) => {
      const dx = e.clientX - startX;
      const delta = Math.round(dx / cellW);
      if (delta < 0) return;
      const next = Math.max(1, Math.min(maxLen, 1 + delta));
      this._commit((Lnext) => {
        const p = Lnext.patterns.find((pp) => pp.id === this._selectedPatternId);
        if (!p) return;
        for (const r of rows) {
          const idx = p.cells.findIndex((c) => c.row === r && c.step === step);
          if (idx >= 0) p.cells[idx] = { ...p.cells[idx], length_steps: next };
        }
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  _setCell(row, step, on, velocity, lengthSteps) {
    const targetId = this._selectedPatternId;
    this._commit((L) => {
      const pat = L.patterns.find((p) => p.id === targetId);
      if (!pat) return;
      const idx = pat.cells.findIndex((c) => c.row === row && c.step === step);
      if (on) {
        const vel = Math.min(127, Math.max(1, Math.round(velocity ?? this._defaultVelocity)));
        const baseLen = idx >= 0 ? (pat.cells[idx].length_steps ?? 1) : 1;
        const len = Math.max(1, Math.round(lengthSteps ?? baseLen));
        if (idx >= 0) pat.cells[idx] = { ...pat.cells[idx], velocity: vel, length_steps: len };
        else pat.cells.push({ row, step, velocity: vel, length_steps: len });
      } else if (idx >= 0) {
        pat.cells.splice(idx, 1);
      }
    });
  }

  _onNoteResizeStart(ev, row, step) {
    ev.preventDefault();
    ev.stopPropagation();
    const pat = this._selectedPattern();
    if (!pat) return;
    const L = this._currentLayout();
    const startLen = this._cellLenSteps(pat, row, step);
    const startX = ev.clientX;
    const cellW = this._cellW;
    const vel = this._velocityInPattern(pat, row, step);
    const maxLen = Math.max(1, L.pattern_steps - step);
    const onMove = (e) => {
      const dx = e.clientX - startX;
      const deltaSteps = Math.round(dx / cellW);
      const next = Math.max(1, Math.min(maxLen, startLen + deltaSteps));
      if (next !== this._cellLenSteps(this._selectedPattern(), row, step)) {
        this._setCell(row, step, true, vel, next);
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  _ticksPerStep() {
    return Math.max(1, Math.round(PPQN / Math.max(1, this._currentLayout().resolution)));
  }

  // ── arrangement ops ──────────────────────────────────────────────
  _isPatternAtBar(patternId, bar) {
    return this._currentLayout().arrangement.some(
      (s) => s.pattern_id === patternId && s.bar === bar,
    );
  }
  _toggleArrCell(patternId, bar) {
    this._commit((L) => {
      const idx = L.arrangement.findIndex(
        (s) => s.pattern_id === patternId && s.bar === bar,
      );
      const row = L.patterns.findIndex((p) => p.id === patternId);
      if (idx >= 0) L.arrangement.splice(idx, 1);
      else L.arrangement.push({ pattern_id: patternId, bar, arrangement_row: row });
    });
  }

  /** Look up the host region in the live region cache. Returns
   *  `{start_samples, length_samples}` so the navigation/loop math
   *  can map bar indices onto timeline samples. */
  _findRegionRecord() {
    const byTrack = window.__foyer?.store?.state?.regionsByTrack;
    if (!byTrack?.entries) return null;
    for (const [, list] of byTrack.entries()) {
      const r = (list || []).find((x) => x.id === this.regionId);
      if (r) return r;
    }
    return null;
  }

  /** Samples-per-bar at the current session tempo + time signature.
   *  Pattern length math falls back to the layout's own
   *  pattern_steps/resolution when the session doesn't expose a
   *  time-signature numerator (stub/legacy backends). */
  _samplesPerBar() {
    const session = window.__foyer?.store?.state?.session;
    const sr = Number(session?.sample_rate) || 48_000;
    const tempo = Number(session?.transport?.tempo?.value) || 120;
    // Use the layout's beats-per-bar (pattern_steps / resolution)
    // since that's what the host engine uses when expanding the
    // layout into MIDI notes. Falls back to 4 if math is degenerate.
    const L = this._currentLayout();
    const steps = Math.max(1, Number(L?.pattern_steps) || 16);
    const res = Math.max(1, Number(L?.resolution) || 4);
    const beatsPerBar = Math.max(1, steps / res);
    return Math.round((60 / tempo) * beatsPerBar * sr);
  }

  /** Timeline-absolute sample position where `bar` (in the
   *  arrangement) begins. Returns `null` when the region hasn't
   *  hydrated yet. */
  _barToTimelineSamples(bar) {
    const r = this._findRegionRecord();
    if (!r) return null;
    const start = Number(r.start_samples) || 0;
    return start + Math.max(0, bar) * this._samplesPerBar();
  }

  /** Navigate the engine's transport to the start of `bar`. */
  _navigateToBar(bar) {
    const samples = this._barToTimelineSamples(bar);
    if (samples == null) return;
    window.__foyer?.ws?.send?.({ type: "locate", samples });
  }

  /** Set the engine's loop range to cover `[barStart, barEnd]`
   *  inclusive and enable looping. */
  _loopBarRange(barStart, barEnd) {
    const a = Math.min(barStart, barEnd);
    const b = Math.max(barStart, barEnd);
    const startSamples = this._barToTimelineSamples(a);
    const endSamples = this._barToTimelineSamples(b + 1);
    if (startSamples == null || endSamples == null) return;
    window.__foyer?.ws?.send?.({
      type: "set_loop_range",
      start_samples: startSamples,
      end_samples: endSamples,
      enabled: true,
    });
  }

  /** Loop the full populated arrangement (bar 0 → max+1). */
  _loopArrangement() {
    const L = this._currentLayout();
    const maxBar = L.arrangement.reduce((m, s) => Math.max(m, s.bar), -1);
    if (maxBar < 0) return;
    this._loopBarRange(0, maxBar);
    this._navigateToBar(0);
  }

  /** Click on an arrangement cell.
   *   - plain click: navigate + toggle pattern in slot
   *   - shift-click: extend loop selection from the last-clicked bar
   *   - alt-click: loop just this bar
   *   - right-click: handled separately via context menu (TBD) */
  _onArrCellClick(ev, patternId, bar) {
    if (ev.shiftKey && this._lastArrBar >= 0) {
      this._loopBarRange(this._lastArrBar, bar);
      return;
    }
    if (ev.altKey) {
      this._loopBarRange(bar, bar);
      this._navigateToBar(bar);
      this._lastArrBar = bar;
      return;
    }
    this._toggleArrCell(patternId, bar);
    this._navigateToBar(bar);
    this._lastArrBar = bar;
  }
  _addPattern() {
    this._commit((L) => {
      const id = newPatternId();
      const idx = L.patterns.length;
      L.patterns.push({
        id,
        name: `Pattern ${idx + 1}`,
        color: pickPatternColor(idx),
        cells: [],
        free_notes: [],
      });
      this._selectedPatternId = id;
    });
  }
  _renamePattern(patternId, name) {
    this._commit((L) => {
      const p = L.patterns.find((q) => q.id === patternId);
      if (p) p.name = name;
    });
  }
  _deletePattern(patternId) {
    const L = this._currentLayout();
    const pat = L.patterns.find((p) => p.id === patternId);
    import("foyer-ui-core/widgets/confirm-modal.js").then(({ confirmAction }) => {
      confirmAction({
        title: "Delete pattern?",
        message: `"${pat?.name || "This pattern"}" will be removed from the arrangement.`,
        confirmLabel: "Delete",
        tone: "danger",
      }).then((ok) => {
        if (!ok) return;
        this._commit((Lnext) => {
          Lnext.patterns = Lnext.patterns.filter((p) => p.id !== patternId);
          Lnext.arrangement = Lnext.arrangement.filter((s) => s.pattern_id !== patternId);
          if (this._selectedPatternId === patternId) {
            this._selectedPatternId = Lnext.patterns[0]?.id || "";
          }
        });
      });
    });
  }

  // ── toolbar ──────────────────────────────────────────────────────
  _setSteps(n)      { this._commit((L) => { L.pattern_steps = n; }); }
  _setResolution(r) { this._commit((L) => { L.resolution    = r; }); }
  _setMode(m) {
    this._commit((L) => {
      L.mode = m;
      // Swap row defaults when crossing the drum/pitched boundary,
      // unless the user has clearly customized the rows.
      const looksDrum    = L.rows.every((r) => r.channel === 9);
      const looksPitched = L.rows.every((r) => r.channel === 0);
      if (m === "pitched" && looksDrum)    L.rows = defaultPitchedRows();
      else if (m === "drum" && looksPitched) L.rows = defaultDrumRows();
    });
  }
  _toggleRowFlag(row, field) {
    this._commit((L) => {
      L.rows[row] = { ...L.rows[row], [field]: !L.rows[row][field] };
    });
  }
  _clearSelectedPattern() {
    const targetId = this._selectedPatternId;
    this._commit((L) => {
      const pat = L.patterns.find((p) => p.id === targetId);
      if (pat) { pat.cells = []; pat.free_notes = []; }
    });
  }

  // ── rows (drums / pitches) ──────────────────────────────────────
  _addCustomRow(pitch, label) {
    const p = Math.max(0, Math.min(127, Math.round(Number(pitch))));
    const name = (label || pitchLabel(p)).trim() || pitchLabel(p);
    const L = this._currentLayout();
    const ch = L.mode === "drum" ? 9 : 0;
    const palette = ["#f59e0b", "#a78bfa", "#22d3ee", "#67e8f9", "#fb7185", "#fda4af", "#fcd34d", "#fbbf24", "#34d399", "#c084fc"];
    const color = palette[L.rows.length % palette.length];
    this._commit((Lnext) => {
      Lnext.rows = [...Lnext.rows, { pitch: p, label: name, channel: ch, color }];
    });
  }
  _removeRow(idx) {
    this._commit((L) => {
      if (idx < 0 || idx >= L.rows.length) return;
      L.rows.splice(idx, 1);
      for (const pat of L.patterns) {
        pat.cells = (pat.cells || [])
          .filter((c) => c.row !== idx)
          .map((c) => c.row > idx ? { ...c, row: c.row - 1 } : c);
      }
    });
  }
  _onRowHeadContext(ev, rowIdx, row) {
    ev.preventDefault();
    import("foyer-ui-core/widgets/confirm-modal.js").then(({ confirmAction }) => {
      confirmAction({
        title: "Remove row?",
        message: `"${row.label}" will be removed from the grid along with any cells on it.`,
        confirmLabel: "Remove",
        tone: "danger",
      }).then((ok) => {
        if (ok) this._removeRow(rowIdx);
      });
    });
  }

  _openDrumPicker() {
    this._drumPitch = 36;
    this._drumLabel = "Custom";
    this._addDrum = true;
  }
  _confirmDrumPicker() {
    const pitch = Number(this._drumPitch);
    const label = String(this._drumLabel || "").trim() || pitchLabel(pitch);
    this._addCustomRow(pitch, label);
    this._addDrum = false;
  }

  // ── presets ─────────────────────────────────────────────────────
  _loadPresets() {
    try {
      const raw = localStorage.getItem(PRESETS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  _savePresets(list) {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(list));
    this.requestUpdate();
  }
  _saveAsPreset() {
    const snapshot = JSON.parse(JSON.stringify(this._currentLayout()));
    import("foyer-ui-core/widgets/prompt-modal.js").then(({ promptText }) => {
      promptText({
        title: "Save beat preset",
        message: "Saves the current layout to your browser. Presets are per-browser — use Export to share across machines.",
        defaultValue: `Beat ${new Date().toLocaleDateString()}`,
        placeholder: "preset name",
        confirmLabel: "Save",
      }).then((name) => {
        if (!name) return;
        const presets = this._loadPresets();
        presets.push({
          name,
          created: new Date().toISOString(),
          layout: snapshot,
        });
        this._savePresets(presets);
      });
    });
  }
  _applyPreset(p) {
    if (!p?.layout) return;
    // Preserve region identity — we only replace the editable
    // layout, not the region-level binding.
    const next = JSON.parse(JSON.stringify(p.layout));
    next.version = 2;
    if (!next.patterns?.length) {
      const id = newPatternId();
      next.patterns = [{ id, name: "Pattern 1", color: pickPatternColor(0), cells: [], free_notes: [] }];
      next.arrangement = [{ pattern_id: id, bar: 0, arrangement_row: 0 }];
    }
    this.layout = next;
    this._selectedPatternId = next.patterns[0]?.id || "";
    this._persistLayout();
    this._tick++;
  }
  _deletePreset(idx) {
    const presets = this._loadPresets();
    if (idx < 0 || idx >= presets.length) return;
    const name = presets[idx].name;
    import("foyer-ui-core/widgets/confirm-modal.js").then(({ confirmAction }) => {
      confirmAction({
        title: "Delete preset?",
        message: `"${name}" will be removed from your browser-saved presets.`,
        confirmLabel: "Delete",
        tone: "danger",
      }).then((ok) => {
        if (!ok) return;
        const latest = this._loadPresets();
        const pos = latest.findIndex((p) => p.name === name);
        if (pos >= 0) {
          latest.splice(pos, 1);
          this._savePresets(latest);
        }
      });
    });
  }
  _exportPreset(idx) {
    const presets = this._loadPresets();
    const p = presets[idx];
    if (!p) return;
    const blob = new Blob([JSON.stringify(p, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${p.name.replace(/[^a-z0-9_-]+/gi, "_")}.fybt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  _importPresetFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".fybt,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed?.layout) throw new Error("no layout in preset");
        const presets = this._loadPresets();
        presets.push({
          name: parsed.name || file.name.replace(/\.fybt$/i, "") || "Imported",
          created: new Date().toISOString(),
          layout: parsed.layout,
        });
        this._savePresets(presets);
      } catch (e) {
        import("foyer-ui-core/widgets/confirm-modal.js").then(({ confirmAction }) => {
          confirmAction({
            title: "Import failed",
            message: `Couldn't read this .fybt file: ${e.message}`,
            confirmLabel: "OK",
            cancelLabel: "Close",
          });
        });
      }
    };
    input.click();
  }

  // ── arrangement-box vertical resize ──────────────────────────────
  _startArrResize(ev) {
    ev.preventDefault();
    const startY = ev.clientY;
    const startH = this._arrH;
    const onMove = (e) => {
      const h = Math.max(80, Math.min(600, startH + (e.clientY - startY)));
      this._arrH = h;
    };
    const onUp = () => {
      localStorage.setItem(ARR_HEIGHT_KEY, String(Math.round(this._arrH)));
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  _togglePreview() {
    this._preview = !this._preview;
    localStorage.setItem(PREVIEW_PREF_KEY, this._preview ? "1" : "0");
    if (this._preview) resumePreviewCtx();
  }

  /** Flip `active=true` on the layout. Server regenerates notes
   *  from the arrangement, overwriting whatever MIDI was on the
   *  region. Used by the "archived" banner's Restore button. */
  _restoreSequencer() {
    const L = this._currentLayout();
    if (!this.regionId) return;
    if (L.active !== false) return;
    import("foyer-ui-core/widgets/confirm-modal.js").then(({ confirmAction }) => {
      confirmAction({
        title: "Restore beat sequencer?",
        message:
          "The archived sequencer layout will become active again. "
          + "The region's current MIDI notes will be overwritten with "
          + "notes regenerated from the sequencer's arrangement.\n\n"
          + "Any edits you made in the piano roll since this layout "
          + "was archived will be lost.",
        confirmLabel: "Restore & overwrite MIDI",
        tone: "warning",
      }).then((ok) => {
        if (!ok) return;
        const next = { ...L, active: true };
        this.layout = next;
        this._persistLayout();
        this._tick++;
        // Restore regenerates notes server-side, so the regular
        // region_updated echo will reach the piano roll. We still
        // broadcast the layout flip immediately so the piano roll
        // doesn't render-flicker between "convert" optimistic state
        // and the echo arriving.
        window.dispatchEvent(new CustomEvent("foyer:sequencer-layout-changed", {
          detail: { regionId: this.regionId, layout: next },
        }));
      });
    });
  }

  _currentTempo() {
    return Number(window.__foyer?.store?.get?.("transport.tempo") ?? 120);
  }
  _setTempo(bpm) {
    const v = Math.max(20, Math.min(300, Number(bpm) || 120));
    window.__foyer?.ws?.controlSet?.("transport.tempo", v);
  }

  _playheadSamples() {
    return Number(window.__foyer?.store?.get?.("transport.position") ?? 0);
  }
  _sessionLengthSamples() {
    return Number(window.__foyer?.store?.state?.session?.timeline?.length_samples
      ?? (48_000 * 120));
  }
  _sampleRate() {
    return Number(window.__foyer?.store?.state?.session?.timeline?.sample_rate ?? 48_000);
  }
  _onSeekClick(ev) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const sampleTarget = Math.round(ratio * this._sessionLengthSamples());
    // Locate routes through the server's transport.position
    // ControlSet, so we don't need to also fire a controlSet from
    // here (was firing both, hence multiple "Locate accepted but
    // not wired" toasts per click).
    window.__foyer?.ws?.send({ type: "locate", samples: sampleTarget });
  }

  // ── pattern-cell interaction ─────────────────────────────────────
  _onCellDown(ev, row, step) {
    ev.preventDefault();
    const pat = this._selectedPattern();
    if (!pat) return;
    const L = this._currentLayout();
    const rowDef = L.rows[row];
    const wasOn = this._isOnInPattern(pat, row, step);

    // Chord-on-click in pitched mode. Held digit + Shift/Ctrl resolves
    // the chord shape; we map each chord pitch to a row index (skipping
    // pitches that aren't in the visible row set) and toggle ON each
    // cell at `step`. Drag-to-resize after click extends every chord
    // cell's `length_steps` together. (Rich, 2026-04-26.)
    if (L.mode === "pitched" && this._heldChordDigit && rowDef?.pitch != null) {
      const intervals = chordIntervals(
        this._heldChordDigit,
        ev.shiftKey,
        ev.ctrlKey || ev.metaKey,
        this._readScaleRoot(),
        this._readScaleMode(),
        rowDef.pitch,
      );
      const targets = [];
      for (const iv of intervals) {
        const pit = rowDef.pitch + iv;
        const r = L.rows.findIndex((rr) => rr.pitch === pit);
        if (r >= 0) targets.push(r);
      }
      if (targets.length === 0) return;
      // Single _commit so undo treats the whole chord as one step.
      this._commit((Lnext) => {
        const p = Lnext.patterns.find((pp) => pp.id === this._selectedPatternId);
        if (!p) return;
        for (const r of targets) {
          const idx = p.cells.findIndex((c) => c.row === r && c.step === step);
          const cell = { row: r, step, velocity: this._defaultVelocity, length_steps: 1 };
          if (idx >= 0) p.cells[idx] = { ...p.cells[idx], ...cell };
          else p.cells.push(cell);
        }
      });
      // Drag-to-resize for the WHOLE chord. Extend each chord cell's
      // length together as the user drags right.
      this._beginChordResize(ev, targets, step);
      return;
    }

    // If clicking on an existing ON cell: enter velocity-drag mode.
    // Vertical drag adjusts velocity (up = louder); pure click with
    // no movement toggles the cell off. Moving out of the cell while
    // dragging falls through to paint mode.
    // If clicking on an OFF cell: paint mode (create + drag-paint).
    const startY = ev.clientY;
    const startX = ev.clientX;
    const startVel = wasOn ? this._velocityInPattern(pat, row, step) : this._defaultVelocity;
    let dragMode = wasOn ? "maybe-velocity" : "paint-on";
    let paintStarted = false;
    const commitVel = (v) => {
      const vel = Math.min(127, Math.max(1, Math.round(v)));
      this._setCell(row, step, true, vel);
    };

    if (!wasOn) {
      this._paintState = { mode: "on" };
      this._setCell(row, step, true, this._defaultVelocity);
      paintStarted = true;
      this._maybePreview(rowDef, this._defaultVelocity);
    } else {
      this._maybePreview(rowDef, startVel);
    }

    const onMove = (e) => {
      const dy = e.clientY - startY;
      const dx = e.clientX - startX;
      if (dragMode === "maybe-velocity") {
        // Promote to velocity-drag once the user crosses a small
        // vertical threshold. A big horizontal move before vertical
        // means they want to paint — demote to off-paint.
        if (Math.abs(dy) > 3 && Math.abs(dy) > Math.abs(dx)) {
          dragMode = "velocity";
        } else if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) {
          dragMode = "paint-off";
          this._paintState = { mode: "off" };
          this._setCell(row, step, false);
          paintStarted = true;
        }
      }
      if (dragMode === "velocity") {
        // 2 px = 1 velocity unit; up increases.
        const v = startVel - dy / 2;
        commitVel(v);
        return;
      }
      if (dragMode === "paint-on" || dragMode === "paint-off") {
        this._paintOnCellAt(e);
      }
    };
    const onUp = () => {
      if (dragMode === "maybe-velocity" && !paintStarted) {
        // Pure click on an existing cell → toggle off.
        this._setCell(row, step, false);
      }
      this._paintState = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  _maybePreview(rowDef, velocity) {
    if (!this._preview || !rowDef) return;
    try {
      playPreviewNote({
        pitch: rowDef.pitch,
        velocity: velocity ?? this._defaultVelocity,
        channel: rowDef.channel ?? 0,
      });
    } catch (e) { /* best-effort preview */ }
  }
  _paintOnCellAt(ev) {
    if (!this._paintState) return;
    const el = this.renderRoot.elementFromPoint
      ? this.renderRoot.elementFromPoint(ev.clientX, ev.clientY)
      : document.elementFromPoint(ev.clientX, ev.clientY);
    const cell = el?.closest?.(".cell");
    if (!cell) return;
    const row = Number(cell.dataset.row);
    const step = Number(cell.dataset.step);
    if (Number.isNaN(row) || Number.isNaN(step)) return;
    const pat = this._selectedPattern();
    const isOn = this._isOnInPattern(pat, row, step);
    const L = this._currentLayout();
    const rowDef = L.rows[row];
    if (this._paintState.mode === "on" && !isOn) {
      this._setCell(row, step, true);
      this._maybePreview(rowDef, this._defaultVelocity);
    } else if (this._paintState.mode === "off" && isOn) {
      this._setCell(row, step, false);
    }
  }
  _onGridWheel(ev) {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      const dir = ev.deltaY < 0 ? +1 : -1;
      const idx = Math.max(0, Math.min(
        CELL_WIDTHS.length - 1,
        CELL_WIDTHS.indexOf(this._cellW) + dir));
      if (CELL_WIDTHS[idx] !== this._cellW) this._cellW = CELL_WIDTHS[idx];
    }
  }
  _onCellWheel(ev, row, step) {
    if (ev.ctrlKey || ev.metaKey) return;
    if (!ev.shiftKey) return;
    ev.preventDefault();
    const pat = this._selectedPattern();
    if (!this._isOnInPattern(pat, row, step)) return;
    // Some browsers (Chrome/Edge on most OSes) swap the wheel
    // axis when Shift is held: deltaY goes to 0 and deltaX
    // carries the wheel direction. Other browsers (Firefox on
    // Linux) leave deltaY populated. Read whichever has a
    // non-zero magnitude, defaulting to deltaY so an
    // un-modified wheel still works. Without this, Shift-wheel
    // only ever got one direction on the axis-swapping path —
    // hence Rich's "only turns velocity down" report 2026-04-21.
    const delta = ev.deltaY !== 0 ? ev.deltaY : ev.deltaX;
    if (delta === 0) return;
    const v = this._velocityInPattern(pat, row, step);
    const next = Math.min(127, Math.max(1, v + (delta < 0 ? +4 : -4)));
    if (next !== v) this._setCell(row, step, true, next);
  }

  // ── render ───────────────────────────────────────────────────────
  render() {
    const L = this._currentLayout();
    const stripOpen = this._stripOpen;
    return html`
      <div class="root">
        <div class="main">
          ${this._renderToolbar(L)}
          ${this._renderTransportStrip()}
          ${L.active === false ? this._renderArchivedBanner() : null}
          ${this._renderSeekBar()}
          ${this._renderArrangement(L)}
          ${this._renderPatternEditor(L)}
        </div>
        <div class="side-strip ${stripOpen ? "open" : ""}"
             style=${stripOpen ? `--strip-w:${this._stripW}px` : ""}>
          <button class="strip-handle"
                  title=${stripOpen ? "Hide instruments + patches" : "Show instruments + patches for this track"}
                  @click=${() => this._toggleStrip()}>
            ${icon(stripOpen ? "chevron-right" : "chevron-left", 14)}
          </button>
          ${stripOpen ? html`
            <div class="strip-resize"
                 title="Drag to resize"
                 @pointerdown=${(e) => this._startStripResize(e)}></div>
            <foyer-midi-manager
              style="flex:1;min-height:0"
              .trackId=${this.trackId}
              .trackName=${this.regionName || ""}
            ></foyer-midi-manager>` : null}
        </div>
      </div>
      ${this._addDrum ? this._renderDrumPicker() : null}
      ${this._presetsOpen ? this._renderPresetsModal() : null}
    `;
  }

  _toggleStrip() {
    this._stripOpen = !this._stripOpen;
    try {
      localStorage.setItem("foyer.beat.strip-open", this._stripOpen ? "1" : "0");
    } catch { /* ignore */ }
    this.requestUpdate();
  }

  _clampStripWidth(next) {
    const hostW = this.getBoundingClientRect?.().width || 1200;
    const maxW = Math.max(STRIP_WIDTH_MIN + 20, Math.floor(hostW * 0.65));
    return Math.max(STRIP_WIDTH_MIN, Math.min(maxW, Math.round(next)));
  }

  _startStripResize(ev) {
    if (!this._stripOpen) return;
    ev.preventDefault();
    this._stripResizeActive = true;
    this._stripResizeStartX = ev.clientX;
    this._stripResizeStartW = this._stripW;
    this._onStripResizeMoveBound = (e) => this._onStripResizeMove(e);
    this._onStripResizeUpBound = () => this._stopStripResize(true);
    window.addEventListener("pointermove", this._onStripResizeMoveBound);
    window.addEventListener("pointerup", this._onStripResizeUpBound, { once: true });
  }

  _onStripResizeMove(ev) {
    if (!this._stripResizeActive) return;
    const delta = this._stripResizeStartX - ev.clientX;
    this._stripW = this._clampStripWidth(this._stripResizeStartW + delta);
    this.requestUpdate();
  }

  _stopStripResize(persist = false) {
    this._stripResizeActive = false;
    if (this._onStripResizeMoveBound) {
      window.removeEventListener("pointermove", this._onStripResizeMoveBound);
      this._onStripResizeMoveBound = null;
    }
    if (this._onStripResizeUpBound) {
      window.removeEventListener("pointerup", this._onStripResizeUpBound);
      this._onStripResizeUpBound = null;
    }
    if (persist) {
      try {
        localStorage.setItem(STRIP_WIDTH_KEY, String(this._stripW));
      } catch { /* ignore */ }
    }
  }

  _renderArchivedBanner() {
    return html`
      <div class="archived-banner">
        <span class="icon">⚠</span>
        <span class="text">
          This layout is <strong>archived</strong> — the region's notes
          are being edited as plain MIDI. Changes you make here will be
          saved, but they won't play back until you restore the sequencer.
          Restoring will overwrite any MIDI edits on the region.
        </span>
        <button title="Activate this sequencer and regenerate the region's notes from its layout"
                @click=${() => this._restoreSequencer()}>Restore sequencer</button>
      </div>
    `;
  }

  _renderDrumPicker() {
    return html`
      <div class="modal" @click=${(e) => { if (e.target === e.currentTarget) this._addDrum = false; }}>
        <div class="panel">
          <h3>Add drum / note to grid</h3>
          <div class="row-f">
            <span>Pitch</span>
            <select @change=${(e) => { this._drumPitch = Number(e.currentTarget.value); const hit = GM_DRUM_KIT.find((d) => d.pitch === this._drumPitch); if (hit) this._drumLabel = hit.label; }}>
              ${GM_DRUM_KIT.map((d) => html`
                <option value=${d.pitch} ?selected=${d.pitch === this._drumPitch}>${d.pitch} — ${d.label}</option>
              `)}
            </select>
            <input type="number" min="0" max="127" style="flex:0 0 70px"
                   .value=${String(this._drumPitch)}
                   @input=${(e) => { this._drumPitch = Number(e.currentTarget.value); }}>
          </div>
          <div class="row-f">
            <span>Label</span>
            <input type="text" .value=${this._drumLabel}
                   @input=${(e) => { this._drumLabel = e.currentTarget.value; }}>
          </div>
          <div class="actions">
            <button @click=${() => { this._addDrum = false; }}>Cancel</button>
            <button class="primary" @click=${() => this._confirmDrumPicker()}>Add</button>
          </div>
        </div>
      </div>
    `;
  }

  _renderPresetsModal() {
    const presets = this._loadPresets();
    return html`
      <div class="modal" @click=${(e) => { if (e.target === e.currentTarget) this._presetsOpen = false; }}>
        <div class="panel" style="min-width:420px">
          <h3>Beat presets</h3>
          <div class="row-f">
            <button class="primary" @click=${() => { this._saveAsPreset(); }}>Save current…</button>
            <button @click=${() => this._importPresetFile()}>Import .fybt…</button>
            <span style="flex:1"></span>
            <span style="font-size:10px">${presets.length} saved</span>
          </div>
          <div class="preset-list">
            ${presets.length === 0
              ? html`<div class="empty">No presets yet — click "Save current…" to stash this layout.</div>`
              : presets.map((p, i) => html`
                <div class="item">
                  <span title=${p.created || ""}>${p.name}</span>
                  <button @click=${() => { this._applyPreset(p); this._presetsOpen = false; }}>Load</button>
                  <button @click=${() => this._exportPreset(i)}>Export</button>
                  <button @click=${() => this._deletePreset(i)}>×</button>
                </div>
              `)}
          </div>
          <div class="actions">
            <button @click=${() => { this._presetsOpen = false; }}>Close</button>
          </div>
        </div>
      </div>
    `;
  }

  _isMaximized() {
    const win = this.closest?.("foyer-window");
    return !!(win && win.hasAttribute("maximized"));
  }

  _renderTransportStrip() {
    if (!this._isMaximized()) return null;
    const tempo = this._currentTempo();
    const playing = !!window.__foyer?.store?.state?.controls?.get?.("transport.playing");
    return html`
      <div class="transport-strip">
        <foyer-number
          label="Tempo"
          unit="BPM"
          .value=${tempo}
          .min=${20}
          .max=${300}
          .step=${1}
          .fineStep=${0.1}
          .coarseStep=${10}
          .precision=${1}
          .pxPerStep=${3}
          @input=${(e) => this._setTempo(e.detail?.value ?? e.target.value)}
          @change=${(e) => this._setTempo(e.detail?.value ?? e.target.value)}
        ></foyer-number>
        <button title=${playing ? "Pause" : "Play"}
                @click=${() => window.__foyer?.ws?.controlSet?.("transport.playing", playing ? 0 : 1)}>
          ${playing ? "❚❚" : "▶"}
        </button>
        <button title="Stop"
                @click=${() => window.__foyer?.ws?.controlSet?.("transport.playing", 0)}>
          ■
        </button>
      </div>
    `;
  }

  _renderToolbar(L) {
    return html`
      <div class="tb">
        <span class="title">Beat</span>
        <span>${this.regionName || "—"}</span>
        <label>Mode
          <select @change=${(e) => this._setMode(e.currentTarget.value)}>
            <option value="drum" ?selected=${L.mode === "drum"}>Drum</option>
            <option value="pitched" ?selected=${L.mode === "pitched"}>Pitched (piano roll)</option>
          </select>
        </label>
        <label>Steps/bar
          <select @change=${(e) => this._setSteps(Number(e.currentTarget.value))}>
            ${STEP_COUNTS.map((n) => html`
              <option value=${n} ?selected=${L.pattern_steps === n}>${n}</option>
            `)}
          </select>
        </label>
        <label>Res
          <select @change=${(e) => this._setResolution(Number(e.currentTarget.value))}>
            ${RESOLUTIONS.map((r) => html`
              <option value=${r.subdiv} ?selected=${L.resolution === r.subdiv}>${r.label}</option>
            `)}
          </select>
        </label>
        <label>Vel
          <input type="range" min="1" max="127" step="1"
                 .value=${String(this._defaultVelocity)}
                 @input=${(e) => { this._defaultVelocity = Number(e.currentTarget.value); this._tick++; }}>
          <span style="min-width:22px;text-align:right;color:var(--color-accent,#7c5cff);font-variant-numeric:tabular-nums">${this._defaultVelocity}</span>
        </label>
        <!-- Tempo + Play/Stop moved to the maximized-only transport
             strip below. Editing live mostly happens at normal window
             size, where transport is reachable from the main app's
             transport bar; surfacing them in-editor only when the
             user has full-screen real estate keeps the toolbar tight.
             (Rich, 2026-04-26.) -->
        <label class="chk" title="Play a short sound in the browser when you click a cell (browser-only; does not route through the DAW yet)">
          <input type="checkbox" .checked=${this._preview}
                 @change=${() => this._togglePreview()}>
          Preview
        </label>
        ${L.mode === "pitched" ? html`
          <label title="Scale used by chord-on-click (hold 3..9 + click)">
            Scale
            <select @change=${(e) => {
                      try { localStorage.setItem("foyer.midi.scale.root", e.currentTarget.value); } catch {}
                      this.requestUpdate();
                    }}>
              ${PITCH_CLASS_LABELS.map((lbl, i) => html`
                <option value=${i} ?selected=${i === this._readScaleRoot()}>${lbl}</option>
              `)}
            </select>
            <select @change=${(e) => {
                      try { localStorage.setItem("foyer.midi.scale.mode", e.currentTarget.value); } catch {}
                      this.requestUpdate();
                    }}>
              ${Object.entries(SCALES).map(([id, s]) => html`
                <option value=${id} ?selected=${id === this._readScaleMode()}>${s.label}</option>
              `)}
            </select>
          </label>
        ` : null}
        <button title="Beat loop presets" @click=${() => { this._presetsOpen = true; }}>Presets…</button>
        <button title="Clear selected pattern" @click=${() => this._clearSelectedPattern()}>Clear</button>
        <button title="Undo (Ctrl+Z) — client-side only"
                ?disabled=${!(this._undoStack?.length)}
                @click=${() => this.undo()}>
          ${icon("arrow-uturn-left", 12)}
        </button>
        <button title="Redo (Ctrl+Shift+Z / Ctrl+Y) — client-side only"
                ?disabled=${!(this._redoStack?.length)}
                @click=${() => this.redo()}>
          ${icon("arrow-uturn-right", 12)}
        </button>
        <button title=${this._stripOpen ? "Hide instruments + patches" : "Show instruments + patches for this track"}
                @click=${() => this._toggleStrip()}>
          ${icon(this._stripOpen ? "chevron-right" : "musical-note", 12)}
        </button>
      </div>
    `;
  }

  _renderSeekBar() {
    const len = this._sessionLengthSamples();
    const pos = this._playheadSamples();
    const ratio = len > 0 ? Math.min(1, Math.max(0, pos / len)) : 0;
    const regions = this.trackRegions || [];
    return html`
      <div class="seek" @click=${(e) => this._onSeekClick(e)}
           title="Click to seek · current ${(pos / this._sampleRate()).toFixed(1)}s">
        <div class="track"></div>
        ${regions.map((r) => {
          if (!len) return null;
          const left = 100 * (r.start_samples || 0) / len;
          const width = 100 * Math.max(0.2, (r.length_samples || 0) / len);
          return html`
            <div class="region-marker ${r.id === this.regionId ? "active" : ""}"
                 style="left:${left}%;width:${width}%"></div>
          `;
        })}
        <div class="ph" style="left:${ratio * 100}%"></div>
      </div>
    `;
  }

  _renderArrangement(L) {
    // Ensure the visible bar count is at least one past the highest
    // populated bar so the user always sees a "next bar" they can
    // click into. Capped so a giant arrangement scrolls instead of
    // exploding the layout.
    const maxBar = L.arrangement.reduce((m, s) => Math.max(m, s.bar), -1);
    const cols = Math.max(this._arrCols, maxBar + 4);
    const cellPx = 16;
    return html`
      <div class="arr" style="height:${this._arrH}px">
        <div class="arr-head">
          <button class="add add-pattern" title="Add a new empty pattern"
                  @click=${() => this._addPattern()}>+ Pattern</button>
          <span>Arrangement · ${L.patterns.length} pattern${L.patterns.length === 1 ? "" : "s"} · ${maxBar + 1} bar${maxBar + 1 === 1 ? "" : "s"}</span>
          <button class="add"
                  title="Loop the full populated arrangement on the transport"
                  ?disabled=${maxBar < 0}
                  @click=${() => this._loopArrangement()}>Loop arr</button>
          <button class="add bars" title="Show more bars in the arrangement"
                  @click=${() => { this._arrCols = Math.min(cols + 8, 256); }}>+ 8 bars</button>
        </div>
        <div class="arr-body" style="--arr-cols-tpl:repeat(${cols}, ${cellPx}px)">
          <div class="arr-pat-list">
            ${L.patterns.map((p) => html`
              <div class="arr-pat ${p.id === this._selectedPatternId ? "active" : ""}"
                   @click=${() => { this._selectedPatternId = p.id; this._tick++; }}>
                <span class="swatch" style="background:${p.color || pickPatternColor(0)}"></span>
                <input class="name" .value=${p.name}
                       @click=${(e) => e.stopPropagation()}
                       @change=${(e) => this._renamePattern(p.id, e.currentTarget.value)}>
                <button class="x" title="Delete pattern"
                        @click=${(e) => { e.stopPropagation(); this._deletePattern(p.id); }}>×</button>
              </div>
            `)}
          </div>
          <div class="arr-grid" style="grid-template-rows:repeat(${L.patterns.length}, 22px)">
            ${L.patterns.map((p) => html`
              ${Array.from({ length: cols }).map((_, b) => {
                const on = this._isPatternAtBar(p.id, b);
                return html`
                  <div class="arr-cell ${on ? "on" : ""} ${(b + 1) % 4 === 0 ? "beat-edge" : ""}"
                       style=${on ? `--cell-color:${p.color || pickPatternColor(0)}` : ""}
                       title="bar ${b + 1} — click navigates the transport; shift-click loops from the last bar; alt-click loops just this bar"
                       @click=${(ev) => this._onArrCellClick(ev, p.id, b)}></div>
                `;
              })}
            `)}
          </div>
        </div>
        <div class="arr-resize" title="Drag to resize the arrangement panel"
             @pointerdown=${(e) => this._startArrResize(e)}></div>
      </div>
    `;
  }

  _renderPatternEditor(L) {
    const pat = this._selectedPattern();
    if (!pat) return html`<div class="hint">No pattern selected.</div>`;
    const rowH = L.mode === "pitched" ? 18 : 28;
    const steps = L.pattern_steps;
    const beatEvery = Math.max(1, L.resolution || 4);
    const gridTpl = `repeat(${steps}, ${this._cellW}px)`;
    return html`
      <div class="body ${L.mode === "pitched" ? "pitched" : ""}" style="--row-h:${rowH}px"
           @wheel=${(e) => this._onGridWheel(e)}>
        <div class="rows">
          ${L.rows.map((row, i) => {
            const black = L.mode === "pitched" && isBlackKey(row.pitch);
            const cRow = L.mode === "pitched" && (row.pitch % 12 === 0);
            return html`
              <div class="row-head ${black ? "black-key" : ""} ${cRow ? "c-row" : ""}"
                   @contextmenu=${(e) => this._onRowHeadContext(e, i, row)}>
                <button class="mute ${row.muted ? "on" : ""}"
                        title="Mute this row"
                        @click=${() => this._toggleRowFlag(i, "muted")}>M</button>
                <button class="solo ${row.soloed ? "on" : ""}"
                        title="Solo this row"
                        @click=${() => this._toggleRowFlag(i, "soloed")}>S</button>
                <div class="label" title="pitch ${row.pitch} · ch ${row.channel + 1} · right-click to remove">${row.label}</div>
              </div>
            `;
          })}
          ${L.mode === "drum" ? html`
            <div class="add-drum-row" title="Add a custom drum / hit to the grid"
                 @click=${() => this._openDrumPicker()}>+ Drum</div>
          ` : null}
        </div>
        <div class="grid">
          ${L.rows.map((row, i) => {
            const black = L.mode === "pitched" && isBlackKey(row.pitch);
            // Compute which step-cells are "under" a preceding long
            // note so we don't render them as separate cells — the
            // long note's grid-column span covers them instead.
            const covered = new Set();
            for (const c of pat?.cells || []) {
              if (c.row !== i) continue;
              const len = Math.max(1, Number(c.length_steps) || 1);
              for (let k = 1; k < len; k++) covered.add(c.step + k);
            }
            const isPitched = L.mode === "pitched";
            return html`
              <div class="grid-row ${black ? "black-key" : ""}"
                   style="grid-template-columns:${gridTpl};--row-color:${row.color || "var(--color-accent, #7c5cff)"}">
                ${Array.from({ length: steps }).map((_, s) => {
                  if (covered.has(s)) return null;
                  const on = this._isOnInPattern(pat, i, s);
                  const vel = on ? this._velocityInPattern(pat, i, s) : 0;
                  const alpha = on ? 0.55 + (vel / 127) * 0.45 : 1;
                  const lenSteps = on ? Math.max(1, Number(this._cellLenSteps(pat, i, s)) || 1) : 1;
                  const spanStyle = lenSteps > 1 ? `;grid-column:span ${lenSteps}` : "";
                  return html`
                    <div class="cell ${on ? "on" : ""} ${(s + 1) % beatEvery === 0 ? "beat" : ""}"
                         data-row=${i} data-step=${s}
                         style=${on ? `opacity:${alpha}${spanStyle}` : ""}
                         @pointerdown=${(e) => this._onCellDown(e, i, s)}
                         @wheel=${(e) => this._onCellWheel(e, i, s)}>
                      ${on ? html`<div class="vel" style="height:${Math.round(40 + vel / 127 * 40)}%"></div>` : null}
                      ${on && isPitched ? html`
                        <div class="resize-r" data-grip="right" data-row=${i} data-step=${s}
                             @pointerdown=${(e) => this._onNoteResizeStart(e, i, s)}></div>
                      ` : null}
                    </div>
                  `;
                })}
              </div>
            `;
          })}
        </div>
      </div>
      <div class="velocity" style="grid-template-columns:${gridTpl}">
        ${Array.from({ length: steps }).map((_, s) => {
          // One mini-bar per row that has a cell at this step,
          // colored with that row's color. If more than one row
          // fires on the same step (kick + hat, snare + tom, etc.)
          // each gets its own column so the user can see the
          // individual velocities instead of just the max.
          const hits = [];
          for (const c of pat?.cells || []) {
            if (c.step !== s) continue;
            const row = L.rows[c.row];
            if (!row) continue;
            hits.push({ v: c.velocity ?? this._defaultVelocity, color: row.color || "var(--color-accent,#7c5cff)" });
          }
          hits.sort((a, b) => b.v - a.v);
          return html`
            <div class="vel-col">
              ${hits.map((h) => html`
                <div class="bar" style="height:${(h.v / 127) * 100}%;background:${h.color}"
                     title="vel ${h.v}"></div>
              `)}
            </div>
          `;
        })}
      </div>
      <div class="hint">
        Editing <strong>${pat.name}</strong> · click an empty cell = add · click+drag = paint/erase · drag up/down on a cell = velocity · Shift-wheel = velocity · Ctrl-wheel = zoom${L.mode === "pitched" ? " · drag right edge = extend note" : ""}
      </div>
    `;
  }
}
customElements.define("foyer-beat-sequencer", BeatSequencer);
