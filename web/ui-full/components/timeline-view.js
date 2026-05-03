// Linear editor. Each track is a horizontal lane; regions are laid at their
// sample positions with waveform peaks rendered inside each region.
//
// Features:
//   - Zoom slider (2..4000 px/s) — 4 k px/s = sample-level at 48 kHz
//   - Playhead rendered from transport.position, click ruler to seek
//   - Major (every 5s) + minor (every 1s) grid lines
//   - Drag region body to move; drag edges to resize — optimistic + UpdateRegion
//   - Ctrl/Cmd + edge drag: time-stretch via StretchRegion (Ardour: MidiStretch /
//     RBStretch). Shift held: pitch-preserving elastic stretch (editor Time Stretch
//     default). No Shift (audio): varispeed / tape-style (pitch scales ~1/duration,
//     same idea as editor_timefx “resample without preserving pitch”). MIDI ignores
//     preserve_pitch.
//   - S: split selected regions at the hover cursor line when the pointer
//        is over the grid, else at the playhead (SplitRegion)
//   - Waveforms via WaveformCache; resolution picked from current zoom level
//
// All sample-math uses `sample_rate` from the TimelineMeta payload so
// different sessions with different rates render correctly.

import { LitElement, html, css } from "lit";
import { WaveformCache } from "foyer-ui-core/layout/waveform-cache.js";
import "foyer-ui-core/viz/waveform-gl.js";
import "./midi-strip.js";
import "./automation-lane.js";
import "foyer-ui-core/viz/viz-picker.js";
import { getVizPref, getVizPrefs, setVizPref } from "foyer-ui-core/viz/viz-settings.js";
import { scrollbarStyles } from "foyer-ui-core/shared-styles.js";
import { showContextMenu } from "foyer-ui-core/widgets/context-menu.js";
import { toast } from "foyer-ui-core/widgets/toast.js";
import { sessionScopedKey } from "foyer-core/session-scope.js";

const LANE_HEIGHT_DEFAULT = 52;
const LANE_HEIGHT_MIN = 28;
const LANE_HEIGHT_MAX = 240;
const RULER_HEIGHT = 26;
const HEAD_WIDTH = 140;
const EDGE_GRAB = 6;
// Sample-level detail at extreme zoom requires tiers smaller than 64 —
// at 4000 px/s on 48 kHz audio each pixel covers ~12 source samples, so
// a tier of 64 spreads one peak over 5+ pixels and the bar looks blocky.
// Adding 8/16/32 lets the decoder honor finer resolution when asked.
const TIERS = [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192];
const LANE_HEIGHT_KEY = "foyer.timeline.lane-heights.v1";

function pickTier(samplesPerPx) {
  let best = TIERS[0];
  for (const t of TIERS) if (t <= samplesPerPx) best = t;
  return best;
}

export class TimelineView extends LitElement {
  static properties = {
    session: { type: Object },
    _regionsByTrack: { state: true, type: Object },
    _timeline: { state: true, type: Object },
    _zoom: { state: true, type: Number },
    _playheadSamples: { state: true, type: Number },
    _selection: { state: true, type: Object },
    // Pointer-tracked sample position for the hover cursor line — null
    // when the mouse leaves the grid. Distinct from the playhead so
    // the user can sight a future seek or region edge.
    _hoverSamples: { state: true, type: Number },
    // BPM-aware quantization grid. Off by default; on, draws beat
    // subdivisions over the timeline at 1/<denominator> of a beat.
    _quantOn: { state: true, type: Boolean },
    _quantDiv: { state: true, type: Number },
  };

  static styles = css`
    ${scrollbarStyles}
    :host { display: flex; flex-direction: column; flex: 1; overflow: hidden; background: var(--color-surface); }
    .toolbar {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 14px;
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
      color: var(--color-text-muted);
      font-size: 11px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .toolbar input[type=range] { width: 200px; }
    .toolbar button,
    .toolbar select {
      font: inherit; font-size: 10px;
      color: var(--color-text-muted);
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 2px 8px;
      cursor: pointer;
      display: inline-flex; align-items: center;
      min-height: 22px;
    }
    .toolbar button:hover,
    .toolbar select:hover { color: var(--color-text); border-color: var(--color-accent); }
    .toolbar select { padding-right: 4px; }
    .toolbar label {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 10px; color: var(--color-text-muted);
    }
    /* Force border-box throughout this component. Tailwind sets it
       globally on the document, but Lit shadow DOM doesn't inherit
       that — so width:140px + padding + border was producing a
       163px-wide lane-head while regions positioned at 140px got
       covered by its opaque background. */
    :host, *, *::before, *::after { box-sizing: border-box; }
    .scroll { flex: 1; overflow: auto; }
    .grid { position: relative; min-width: 100%; }
    .ruler {
      position: sticky; top: 0; z-index: 3;
      height: ${RULER_HEIGHT}px;
      background: var(--color-surface-elevated);
      border-bottom: 1px solid var(--color-border);
      cursor: crosshair;
    }
    .ruler .tick {
      position: absolute;
      top: 0; bottom: 0;
      color: var(--color-text-muted);
      font-family: var(--font-mono);
      font-size: 10px;
      pointer-events: none;
    }
    .ruler .tick.major { border-left: 1px solid var(--color-border); padding-left: 4px; }
    .ruler .tick.minor { border-left: 1px solid color-mix(in oklab, var(--color-border) 50%, transparent); }
    .lane-gridlines {
      position: absolute;
      left: ${HEAD_WIDTH}px;
      top: ${RULER_HEIGHT}px;
      bottom: 0;
      pointer-events: none;
    }
    .lane-gridlines .gl {
      position: absolute; top: 0; bottom: 0;
      /* --foyer-time-grid is set on the host from viz prefs (Viz
       * menu → Timeline grid colors). Falls back to the prior
       * border-mix if unset. */
      border-left: 1px solid var(--foyer-time-grid, color-mix(in oklab, var(--color-border) 30%, transparent));
    }
    .lane-gridlines .gl.major {
      border-left-color: var(--foyer-time-grid-major, color-mix(in oklab, var(--color-border) 60%, transparent));
    }
    .lane {
      position: relative;
      border-bottom: 1px solid var(--color-border);
    }
    .lane-resize {
      position: absolute;
      left: 0; right: 0;
      bottom: -3px;
      height: 6px;
      cursor: ns-resize;
      z-index: 5;
    }
    .lane-resize:hover {
      background: color-mix(in oklab, var(--color-accent) 40%, transparent);
    }
    .lane-head {
      position: sticky; left: 0; z-index: 2;
      width: ${HEAD_WIDTH}px; height: 100%;
      display: flex; flex-direction: column; justify-content: center;
      padding: 0 10px;
      background: var(--color-surface-elevated);
      border-right: 1px solid var(--color-border);
      border-left: 3px solid transparent;
      gap: 3px;
      cursor: pointer;
      transition: background 0.1s ease, border-left-color 0.1s ease;
    }
    .lane-head:hover {
      background: color-mix(in oklab, var(--color-accent) 6%, var(--color-surface-elevated));
    }
    .lane.selected .lane-head {
      background: color-mix(in oklab, var(--color-accent) 14%, var(--color-surface-elevated));
      border-left-color: var(--color-accent);
    }
    .lane-name { font-size: 11px; font-weight: 600; color: var(--color-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .lane-kind {
      font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--color-text-muted);
      display: inline-flex; align-items: center; gap: 5px;
    }
    .seq-chip {
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.1em;
      padding: 1px 4px;
      border-radius: 3px;
      background: color-mix(in oklab, var(--color-accent) 24%, transparent);
      color: var(--color-accent);
    }
    .lane-controls {
      display: flex;
      gap: 3px;
      margin-top: 2px;
    }
    .lane-ctl-btn {
      flex: 1;
      font-family: var(--font-sans);
      font-size: 9px;
      font-weight: 700;
      padding: 2px 0;
      border-radius: 3px;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text-muted);
      cursor: pointer;
      user-select: none;
      transition: all 0.1s ease;
      text-align: center;
    }
    .lane-ctl-btn:hover {
      border-color: var(--color-accent);
      color: var(--color-text);
    }
    .lane-ctl-btn.on.mute {
      background: color-mix(in oklab, var(--color-warning) 35%, transparent);
      border-color: var(--color-warning);
      color: var(--color-warning);
    }
    .lane-ctl-btn.on.solo {
      background: color-mix(in oklab, #dece5c 35%, transparent);
      border-color: #dece5c;
      color: #dece5c;
    }
    .lane-ctl-btn.on.rec {
      background: color-mix(in oklab, var(--color-danger, #d04040) 35%, transparent);
      border-color: var(--color-danger, #d04040);
      color: var(--color-danger, #d04040);
    }
    .lane-ctl-btn.on.auto {
      background: color-mix(in oklab, var(--color-accent-2, #22d3ee) 35%, transparent);
      border-color: var(--color-accent-2, #22d3ee);
      color: var(--color-accent-2, #22d3ee);
    }
    .automation-stack {
      position: absolute;
      right: 0;
      bottom: 0;
      display: flex;
      flex-direction: column;
      pointer-events: auto;
      z-index: 1;
    }
    .automation-stack foyer-automation-lane { width: 100%; }
    .region {
      position: absolute;
      top: 4px; bottom: 4px;
      border-radius: 4px;
      background: color-mix(in oklab, var(--color-accent) 28%, var(--color-surface-elevated) 72%);
      border: 1px solid color-mix(in oklab, var(--color-accent-2) 60%, transparent);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
      overflow: hidden;
      cursor: grab;
      transition: filter 0.1s ease;
    }
    .region.dragging { cursor: grabbing; filter: brightness(1.15); }
    .region:hover { filter: brightness(1.08); }
    .region.selected {
      border-color: color-mix(in oklab, var(--color-accent-3) 75%, #fff 25%);
      box-shadow:
        0 0 0 1px color-mix(in oklab, var(--color-accent-3) 45%, transparent),
        0 1px 3px rgba(0, 0, 0, 0.35);
      filter: brightness(1.08);
    }
    /* Resize-preview placeholder: while a left-edge resize-drag is
     * extending the region beyond the source bounds we have peaks
     * for, the new (out-of-bounds) span paints as a striped
     * neutral-grey scrim. Mirrors the recording-placeholder pattern
     * but desaturated since this isn't a recording state — it's a
     * "no decoded data here yet" hint. */
    .region .resize-preview-placeholder {
      position: absolute;
      top: 4px; bottom: 4px;
      background: repeating-linear-gradient(
        45deg,
        rgba(255, 255, 255, 0.04),
        rgba(255, 255, 255, 0.04) 6px,
        rgba(255, 255, 255, 0.10) 6px,
        rgba(255, 255, 255, 0.10) 12px
      );
      border-left: 1px dashed rgba(255, 255, 255, 0.35);
      pointer-events: none;
      z-index: 1;
    }

    /* Cut-pending slice overlay: a translucent scrim positioned over
     * the slice the user has queued for delete-on-paste. For whole-
     * region cuts the overlay spans 0..100% and looks like the legacy
     * dim. For time-range slice cuts the overlay covers ONLY the
     * carved-out portion so the user can see exactly what's leaving
     * vs. what's staying behind. The dashed border is on the overlay
     * (not the region) so the lozenge boundary still reads cleanly. */
    .region .cut-slice-overlay {
      position: absolute;
      top: 0; bottom: 0;
      pointer-events: none;
      background: rgba(0, 0, 0, 0.55);
      border: 1px dashed rgba(255, 255, 255, 0.5);
      box-sizing: border-box;
      z-index: 2;
    }
    .region .name {
      position: absolute;
      top: 2px; left: 6px; right: 6px;
      /* Clip + ellipsize so the region name never spills past the
       * region container. Without max-width and overflow controls,
       * a long take name on a narrow region renders past the right
       * edge — and with absolutely-positioned viz children, that
       * spillover was visually poking over adjacent track header
       * strips. */
      max-width: calc(100% - 12px);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: var(--font-sans);
      font-size: 10px;
      font-weight: 600;
      color: #fff;
      text-shadow: 0 1px 1px rgba(0, 0, 0, 0.6);
      pointer-events: none;
      z-index: 2;
    }
    .region canvas {
      position: absolute;
      left: 0; top: 0; width: 100%; height: 100%;
      pointer-events: none;
    }
    .region .viz {
      position: absolute;
      left: 0; top: 0; right: 0; bottom: 0;
      pointer-events: none;
    }
    .region .edge {
      position: absolute;
      top: 0; bottom: 0;
      width: ${EDGE_GRAB}px;
      cursor: ew-resize;
      z-index: 3;
    }
    .region .edge.left  { left: 0; }
    .region .edge.right { right: 0; }
    .region.stretch-active {
      outline: 1px dashed color-mix(in oklab, var(--color-accent) 70%, transparent);
      z-index: 1;
    }
    .region.stretch-active::after {
      content: "stretch";
      position: absolute;
      top: 4px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 4px;
      background: color-mix(in oklab, var(--color-accent) 35%, transparent);
      color: var(--color-text);
      pointer-events: none;
      z-index: 4;
    }

    .playhead {
      position: absolute;
      top: 0; bottom: 0;
      width: 2px;
      background: linear-gradient(180deg, var(--color-danger), color-mix(in oklab, var(--color-danger) 40%, transparent));
      z-index: 4;
      pointer-events: none;
      box-shadow: 0 0 8px color-mix(in oklab, var(--color-danger) 60%, transparent);
    }
    .playhead::before {
      content: "";
      position: absolute; top: 0; left: -5px;
      border: 6px solid transparent;
      border-top-color: var(--color-danger);
    }

    /* Recording placeholder - full stack when no track is record-armed */
    .recording-placeholder {
      position: absolute;
      top: ${RULER_HEIGHT}px; bottom: 0;
      background: color-mix(in oklab, var(--color-danger) 12%, transparent);
      border-left: 2px solid var(--color-danger);
      z-index: 2;
      pointer-events: none;
      animation: rec-pulse 1s ease-in-out infinite;
    }
    /* Per-lane strip while recording into armed tracks */
    .recording-lane-fill {
      position: absolute;
      top: 4px;
      bottom: 4px;
      background: color-mix(in oklab, var(--color-danger) 14%, transparent);
      border-left: 2px solid var(--color-danger);
      z-index: 1;
      pointer-events: none;
      animation: rec-pulse 1s ease-in-out infinite;
    }
    @keyframes rec-pulse {
      0%, 100% { opacity: 0.6; }
      50% { opacity: 1; }
    }

    /* Left-click-drag selection range. Drawn in two pieces so the ruler
     * reads as a bright highlight while the body overlay is just a dim
     * wash — same pattern as pretty much every DAW's ruler selection. */
    .selection-body {
      position: absolute;
      top: ${RULER_HEIGHT}px;
      bottom: 0;
      background: color-mix(in oklab, var(--color-accent) 14%, transparent);
      border-left: 1px solid color-mix(in oklab, var(--color-accent) 70%, transparent);
      border-right: 1px solid color-mix(in oklab, var(--color-accent) 70%, transparent);
      pointer-events: none;
      z-index: 3;
    }
    .selection-ruler {
      position: absolute;
      top: 0;
      height: ${RULER_HEIGHT}px;
      background: color-mix(in oklab, var(--color-accent) 55%, transparent);
      border-left: 1px solid var(--color-accent);
      border-right: 1px solid var(--color-accent);
      pointer-events: none;
      z-index: 4;
    }
    /* Resize handles for the time-range selection. Visible only on
     * hover (the band itself stays visually quiet at rest); pointer-
     * events auto so the cursor flips to ew-resize. Drag mutates
     * selection.{start,end}Samples and fires a fresh
     * timeline-selection event on release. (Rich, TODO #51.) */
    .selection-handle {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 8px;
      cursor: ew-resize;
      pointer-events: auto;
      z-index: 5;
      background: transparent;
    }
    .selection-handle:hover,
    .selection-handle.dragging {
      background: color-mix(in oklab, var(--color-accent) 65%, transparent);
    }
    .selection-handle.left  { transform: translateX(-4px); }
    .selection-handle.right { transform: translateX(-4px); }
    /* Vertical line that follows the mouse pointer across the
     * timeline, distinct from the playhead so the user can sight a
     * future seek / region edge without committing. */
    .cursor-line {
      position: absolute;
      top: ${RULER_HEIGHT}px;
      bottom: 0;
      width: 1px;
      background: color-mix(in oklab, var(--color-text-muted) 60%, transparent);
      pointer-events: none;
      z-index: 2;
    }
    /* BPM-quantized grid lines, drawn over the time-based gridlines.
     * Beat boundaries are stronger; in-beat subdivisions are lighter. */
    .quant-line {
      position: absolute;
      top: ${RULER_HEIGHT}px;
      bottom: 0;
      width: 1px;
      pointer-events: none;
      z-index: 1;
    }
    .quant-line.bar {
      /* Bar boundaries are the strongest line. Twice the width of a
       * beat line so they stand out against the per-beat grid; uses
       * the same accent color so the user's viz prefs apply. */
      background: var(--foyer-quant-grid, var(--color-accent-2));
      width: 2px;
    }
    .quant-line.beat {
      /* --foyer-quant-grid is set from viz prefs as a full rgba() so
       * the user's chosen alpha is already baked in. Beat lines use
       * the value as-is; in-beat subdivisions (.sub) drop to 50% of
       * the user's alpha for a visible hierarchy. */
      background: var(--foyer-quant-grid, var(--color-accent-2));
    }
    .quant-line.sub {
      background: var(--foyer-quant-grid, var(--color-accent-2));
      opacity: 0.5;
    }
  `;

  constructor() {
    super();
    this._regionsByTrack = {};
    // Initial guess until the first regions_list event lands. Only
    // used for axis math before the backend has answered; the real
    // rate comes from `session.sample_rate` (typed field on the
    // Session schema since it was promoted out of `meta`) or the
    // per-region `TimelineMeta.sample_rate`. See `_sampleRate()`.
    this._timeline = { sample_rate: 48_000, length_samples: 48_000 * 60 };
    this._zoom = 60;
    // Virtual timeline-length extension in seconds; grows only when
    // the user scroll-zooms past the session's own length so that
    // pointer-anchored zoom can always seat its target sample under
    // the cursor without the browser clamping scrollLeft.
    this._zoomPadSec = 0;
    this._playheadSamples = 0;
    this._envelopeHandler = (ev) => this._onEnvelope(ev.detail);
    this._seekHandler = (ev) => this._onSeekRequest(ev.detail);
    this._wfCache = null;
    this._onWfUpdate = () => this._repaintWaveforms();
    this._drag = null;
    this._laneHeights = this._loadLaneHeights();
    // { startSamples, endSamples } — null when nothing is selected.
    this._selection = null;
    // Viewport back-stack: `zoomToSelection` pushes the prior {zoom,
    // scrollLeft} here so the user can pop back with "Zoom Previous".
    // Bounded so a trigger-happy user can't balloon memory.
    this._zoomStack = [];
    this._zoomStackMax = 32;
    // Region click selection (distinct from ruler time-range selection).
    this._selectedRegionIds = new Set();
    // Per-tab region clipboard for cut/copy/paste. `null` when empty.
    // Shape: { mode: "copy"|"cut", anchor_samples, items: [{ region_id,
    // track_id, offset_samples, length_samples, slice_start, slice_len }] }.
    // For whole-region copies, slice_start=0 and slice_len=length_samples;
    // for time-range slice ops slice_{start,len} carve out the active
    // sub-range and the wire command sends DuplicateRegionRange with
    // those offsets. We snapshot region IDs (not their bodies) — the
    // duplicate command on the server fans out a fresh region from the
    // live source. That means a cut can't be undone by clearing the
    // clipboard; the originals persist until paste actually fires the
    // delete. Matches Reaper's flow.
    this._regionClipboard = null;
    // Region IDs currently dimmed on the timeline because they're
    // queued for delete-on-paste. Stored as a Set for O(1) class-
    // decision lookup during render; reconciled to the click-selection
    // by `_reconcileCutPending()` whenever selection mutates AND
    // defensively at the top of render() to catch indirect mutations.
    // Last pointer X over the timeline grid in CSS px (relative to the
    // grid's bounding rect, includes the head-column offset). Used by
    // the default paste keybind to anchor at the mouse cursor instead
    // of the playhead. `null` when the pointer is outside the grid;
    // paste falls back to the playhead in that case.
    this._lastMouseGridX = null;
    // Last seq that updated transport.position; guards against stale
    // out-of-order position packets causing visible playhead jump-back.
    this._lastTransportSeq = 0;
    this._lastSeekAtMs = 0;
    this._recordingAnchorSamples = null;
    this._transportDropStats = { stale_seq: 0, backward_jump: 0 };
    // Quantization grid prefs persist per-browser. Default off so a
    // first-time user doesn't see extra lines they didn't ask for.
    // Visibility (`_quantOn`) is now mirrored to the viz prefs
    // (`quantGridOn`) so the Viz menu can toggle it alongside the
    // time-grid toggle. Subdivision (`_quantDiv`) stays in its own
    // localStorage key — it's a per-timeline setting that doesn't
    // belong in the broader viz prefs blob.
    this._quantOn = getVizPref("quantGridOn") === true;
    try {
      const d = parseInt(localStorage.getItem("foyer.timeline.quant.div") || "16", 10);
      this._quantDiv = [4, 8, 16, 32, 6, 12].includes(d) ? d : 16;
    } catch {
      this._quantDiv = 16;
    }
  }

  _laneHeightStorageKey() {
    // Lane heights are keyed by trackId inside the JSON value, and
    // trackIds (`track.<pbd>`) repeat across .ardour projects. Without
    // session scoping, opening project B reuses project A's heights
    // for whichever tracks happen to share an id (Rich, 2026-04-27).
    return sessionScopedKey(LANE_HEIGHT_KEY);
  }
  _loadLaneHeights() {
    try {
      return JSON.parse(localStorage.getItem(this._laneHeightStorageKey()) || "{}") || {};
    } catch {
      return {};
    }
  }
  _saveLaneHeights() {
    try {
      localStorage.setItem(
        this._laneHeightStorageKey(),
        JSON.stringify(this._laneHeights),
      );
    } catch {}
  }
  _laneHeightFor(trackId) {
    return this._laneHeights[trackId] || LANE_HEIGHT_DEFAULT;
  }

  connectedCallback() {
    super.connectedCallback();
    const ws = window.__foyer?.ws;
    if (ws) {
      ws.addEventListener("envelope", this._envelopeHandler);
      ws.addEventListener("transport_seek_request", this._seekHandler);
      this._wfCache = new WaveformCache(ws);
      this._wfCache.addEventListener("update", this._onWfUpdate);
    }
    // Timeline-wide re-render on any control change (mute/solo/rec
    // buttons on track heads depend on current control values). This is
    // coarse but timelines aren't re-rendered frequently and we don't
    // want to spin up a ControlController per track.
    this._onStoreControl = () => {
      this._syncRecordingAnchor();
      this.requestUpdate();
    };
    this._onStoreSelection = () => this.requestUpdate();
    window.__foyer?.store?.addEventListener("control", this._onStoreControl);
    window.__foyer?.store?.addEventListener("selection", this._onStoreSelection);
    // Apply user-configured grid colors (Viz menu → Timeline grid
    // colors). Pushed onto the host as CSS custom properties; the
    // existing rules on `.lane-gridlines .gl` and `.quant-line` read
    // them via `var(--foyer-time-grid)` / `var(--foyer-quant-grid)`.
    this._applyGridColors();
    this._onVizPrefsChanged = () => {
      // Mirror the quant-on toggle from the Viz menu so the timeline
      // re-renders when the user flips it from over there. Without
      // this the menu writes the pref but the timeline holds its
      // own stale `_quantOn` until something else triggers an
      // update. The time-grid render path reads `getVizPref` live
      // each render so it doesn't need a mirrored property.
      const next = getVizPref("quantGridOn") === true;
      if (next !== this._quantOn) {
        this._quantOn = next;
      }
      this._applyGridColors();
      this.requestUpdate();
    };
    window.addEventListener("foyer:viz-prefs-changed", this._onVizPrefsChanged);
  }

  _applyGridColors() {
    const p = getVizPrefs();
    const time = p.timeGridColor || "#3a3a44";
    const quant = p.quantGridColor || "#7c5cff";
    const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
    const timeA = clamp01(p.timeGridAlpha ?? 1);
    const quantA = clamp01(p.quantGridAlpha ?? 0.5);
    // Compose hex+alpha into rgba() so the existing CSS rules
    // (`var(--foyer-time-grid)`) get a single color value with the
    // user's alpha baked in. This keeps the rules simple while
    // letting users dim the grid without losing the hue.
    const rgba = (hex, a) => {
      const h = hex.replace(/^#/, "");
      const r = parseInt(h.slice(0, 2), 16) || 0;
      const g = parseInt(h.slice(2, 4), 16) || 0;
      const b = parseInt(h.slice(4, 6), 16) || 0;
      return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
    };
    this.style.setProperty("--foyer-time-grid", rgba(time, timeA));
    // Major time-tick stays the same hue but at a higher alpha so
    // 1s/5s ticks remain legible even when the user dims the body.
    this.style.setProperty(
      "--foyer-time-grid-major",
      rgba(time, Math.min(1, timeA + 0.4)),
    );
    this.style.setProperty("--foyer-quant-grid", rgba(quant, quantA));
  }

  /**
   * Sample position for split-at-playhead / split-at-cursor: the pointer-
   * tracked hover line when `_hoverSamples` is set (mouse over grid), else
   * transport playhead.
   */
  _splitAnchorSamples() {
    if (this._hoverSamples != null && Number.isFinite(Number(this._hoverSamples))) {
      return Math.round(Number(this._hoverSamples));
    }
    return Math.round(Number(this._playheadSamples) || 0);
  }

  /** Reaper-style: S splits each selected region at `_splitAnchorSamples()`. */
  splitSelectedRegionsAtPlayhead() {
    const ws = window.__foyer?.ws;
    if (!ws) return;
    const ph = this._splitAnchorSamples();
    const minPiece = 4800;
    for (const id of [...this._selectedRegionIds]) {
      const r = this._regionForId(id);
      if (!r) continue;
      const start = Number(r.start_samples) || 0;
      const len = Number(r.length_samples) || 0;
      const end = start + len;
      if (ph <= start || ph >= end) continue;
      const leftLen = ph - start;
      const rightLen = end - ph;
      if (leftLen < minPiece || rightLen < minPiece) continue;
      ws.send({ type: "split_region", id: r.id, at_samples: ph });
    }
  }

  disconnectedCallback() {
    if (this._onVizPrefsChanged) window.removeEventListener("foyer:viz-prefs-changed", this._onVizPrefsChanged);
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    window.__foyer?.ws?.removeEventListener("transport_seek_request", this._seekHandler);
    this._wfCache?.removeEventListener("update", this._onWfUpdate);
    this._wfCache?.dispose();
    window.__foyer?.store?.removeEventListener("control", this._onStoreControl);
    window.__foyer?.store?.removeEventListener("selection", this._onStoreSelection);
    super.disconnectedCallback();
  }

  updated(changed) {
    if (changed.has("session")) {
      // Lane heights are stored under a session-scoped key — reload
      // from the new session's slot so users see their saved per-
      // track heights instead of whatever the launcher / previous
      // session left in the "default" scope.
      this._laneHeights = this._loadLaneHeights();
      this._fetchRegions();
    }
    this._repaintWaveforms();
  }

  _fetchRegions() {
    const tracks = this.session?.tracks ?? [];
    const ws = window.__foyer?.ws;
    if (!ws) return;
    for (const t of tracks) ws.send({ type: "list_regions", track_id: t.id });
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (!body) return;
    const activeSessionId = window.__foyer?.store?.state?.currentSessionId || null;
    const envelopeSessionId = env?.session_id || null;
    const isSessionScoped =
      body.type === "regions_list"
      || body.type === "region_updated"
      || body.type === "region_removed"
      || body.type === "control_update"
      || body.type === "meter_batch";
    if (
      isSessionScoped
      && activeSessionId
      && envelopeSessionId
      && envelopeSessionId !== activeSessionId
    ) {
      return;
    }
    if (body.type === "regions_list") {
      this._regionsByTrack = { ...this._regionsByTrack, [body.track_id]: body.regions };
      this._timeline = body.timeline;
      this.dispatchEvent(new CustomEvent("foyer:regions-updated", { detail: { track_id: body.track_id } }));
    } else if (body.type === "region_updated") {
      const r = body.region;
      const list = this._regionsByTrack[r.track_id];
      if (list) {
        const idx = list.findIndex(x => x.id === r.id);
        if (idx >= 0) {
          const copy = list.slice();
          copy[idx] = r;
          this._regionsByTrack = { ...this._regionsByTrack, [r.track_id]: copy };
        } else {
          // New region (e.g. AddNote on a region the backend just
          // discovered) — append to the list so the editor sees it.
          this._regionsByTrack = { ...this._regionsByTrack, [r.track_id]: [...list, r] };
        }
      }
      this.dispatchEvent(new CustomEvent("foyer:regions-updated", { detail: { region_id: r.id, track_id: r.track_id } }));
    } else if (body.type === "region_removed") {
      const { track_id, region_id } = body;
      const list = this._regionsByTrack[track_id];
      if (list) {
        this._regionsByTrack = {
          ...this._regionsByTrack,
          [track_id]: list.filter((r) => r.id !== region_id),
        };
      }
      this._selectedRegionIds.delete(region_id);
      this.dispatchEvent(new CustomEvent("foyer:regions-updated", { detail: { region_id, track_id } }));
    } else if (body.type === "control_update" && body.update?.id === "transport.position") {
      const seq = Number(env?.seq || 0);
      const next = Number(body.update.value) || 0;
      if (!this._shouldAcceptTransportPosition(next, seq)) return;
      this._playheadSamples = this._positionOrPin(Number(body.update.value) || 0);
    } else if (body.type === "meter_batch" && Array.isArray(body.values)) {
      // Shim's tick thread batches transport.position in with tempo /
      // playing / recording updates at ~30 Hz while rolling. Pick out
      // the position entry so the playhead animates.
      for (const u of body.values) {
        if (u?.id === "transport.position") {
          const seq = Number(env?.seq || 0);
          const next = Number(u.value) || 0;
          if (this._shouldAcceptTransportPosition(next, seq)) {
            this._playheadSamples = this._positionOrPin(next);
          }
          break;
        }
      }
    }
  }

  _onSeekRequest(detail) {
    this._lastSeekAtMs = Number(detail?.at_ms) || Date.now();
  }

  _diagEnabled() {
    try {
      return localStorage.getItem("foyer.dev.transportDiag") === "1";
    } catch {
      return false;
    }
  }

  _noteTransportDrop(reason) {
    const key = reason === "stale_seq" ? "stale_seq" : "backward_jump";
    this._transportDropStats[key] = (this._transportDropStats[key] || 0) + 1;
    if (this._diagEnabled()) this.requestUpdate();
  }

  _syncRecordingAnchor() {
    const controls = window.__foyer?.store?.state?.controls;
    const recording = !!controls?.get("transport.recording");
    if (!recording) {
      this._recordingAnchorSamples = null;
      return;
    }
    if (this._recordingAnchorSamples != null) return;
    const recStart = Number(controls?.get("transport.record_position"));
    this._recordingAnchorSamples =
      Number.isFinite(recStart) && recStart >= 0
        ? recStart
        : Math.max(0, this._playheadSamples);
  }

  _shouldAcceptTransportPosition(next, seq) {
    if (seq && seq < this._lastTransportSeq) {
      this._noteTransportDrop("stale_seq");
      return false;
    }
    const store = window.__foyer?.store;
    const controls = store?.state?.controls;
    const playing = !!controls?.get("transport.playing");
    const looping = !!controls?.get("transport.looping");
    const seekRecent = Date.now() - (this._lastSeekAtMs || 0) < 1500;
    const backwardsBy = this._playheadSamples - next;
    const jitterThreshold = 2400; // ~50ms @ 48kHz

    if (playing && !looping && backwardsBy > jitterThreshold && !seekRecent) {
      this._noteTransportDrop("backward_jump");
      return false;
    }

    if (seq) this._lastTransportSeq = seq;
    return true;
  }

  /** Honor the front-end position lock when one is active (see
   *  `transport-return.js`). Returns the pinned target instead of the
   *  reported value while the user's return-on-stop is still settling. */
  _positionOrPin(reported) {
    const lock = window.__foyer?.store?.transportPositionLock?.();
    return lock == null ? reported : lock;
  }

  /** Authoritative engine sample rate, read in priority order:
   *  per-region `TimelineMeta.sample_rate` (most recent regions_list
   *  echo), `session.sample_rate` (typed field, promoted out of the
   *  legacy `meta.sample_rate` JSON convention), then 48k as the
   *  built-in last resort. Every place that needs px-per-sample math
   *  routes through this so the constant only lives in one place
   *  and a 96k Ardour session no longer renders at half-scale. */
  _sampleRate() {
    return Number(this._timeline?.sample_rate)
      || Number(this.session?.sample_rate)
      || 48_000;
  }

  _samplesPerPx() {
    const sr = this._sampleRate();
    return sr / Math.max(1, this._zoom);
  }

  _toggleTrackBool(id) {
    if (!id) return;
    const ws = window.__foyer?.ws;
    if (!ws) return;
    const cur = !!window.__foyer?.store?.state?.controls?.get(id);
    ws.controlSet(id, cur ? 0 : 1);
  }

  _onLaneHeadClick(ev, trackId) {
    const store = window.__foyer?.store;
    if (!store) return;
    this._selectedRegionIds.clear();
    let mode = "replace";
    if (ev.shiftKey) mode = "extend";
    else if (ev.ctrlKey || ev.metaKey) mode = "toggle";
    store.selectTrack(trackId, mode);
  }

  _onLaneHeadContext(ev, track) {
    ev.preventDefault();
    ev.stopPropagation();
    const items = [
      { heading: track.name },
    ];
    // MIDI-specific actions land at the TOP of the menu so
    // three-click access (right-click → read → click) hits the
    // piano roll / beat sequencer without scanning past track-
    // editor items. Track editor stays reachable but moves below
    // the MIDI-specific block.
    if (track.kind === "midi") {
      items.push({
        label: "Open piano roll…",
        icon: "sparkles",
        action: () => this._openMidiEditorForTrack(track),
      });
      items.push({
        label: "Open beat sequencer…",
        icon: "queue-list",
        action: () => this._openBeatSequencerForTrack(track),
      });
      items.push({
        label: "Add region at playhead",
        icon: "plus",
        action: () => this._addRegionAtPlayhead(track),
      });
      items.push({
        label: "MIDI patches & banks…",
        icon: "queue-list",
        action: () => this._openMidiManager(track),
      });
      items.push({ separator: true });
    }
    items.push({
      label: "Track editor…",
      icon: "adjustments-horizontal",
      action: () => import("./track-editor-modal.js")
                      .then((m) => m.openTrackEditor(track.id)),
    });
    items.push({
      label: "Move track up",
      icon: "arrow-up",
      action: () => this._moveTrackBy(track.id, -1),
    });
    items.push({
      label: "Move track down",
      icon: "arrow-down",
      action: () => this._moveTrackBy(track.id, 1),
    });
    items.push({
      label: "Delete track…",
      icon: "trash",
      tone: "danger",
      action: () => this._deleteTracksFromContext(track.id),
    });
    showContextMenu(ev, items);
  }

  _moveTrackBy(trackId, dir) {
    const tracks = this.session?.tracks || [];
    const idx = tracks.findIndex((t) => t.id === trackId);
    if (idx < 0) return;
    const next = idx + dir;
    if (next < 0 || next >= tracks.length) return;
    const order = tracks.map((t) => t.id);
    [order[idx], order[next]] = [order[next], order[idx]];
    console.log("[foyer] reorder_tracks sent:", order);
    window.__foyer?.ws?.send({ type: "reorder_tracks", ordered_ids: order });
  }

  async _deleteTracksFromContext(clickedTrackId) {
    const store = window.__foyer?.store;
    const selected = Array.from(store?.state?.selectedTrackIds || []);
    const ids = selected.length ? selected : [clickedTrackId];
    if (!ids.length) return;
    const { confirmAction } = await import("foyer-ui-core/widgets/confirm-modal.js");
    const ok = await confirmAction({
      title: "Delete track",
      message:
        ids.length === 1
          ? "Delete this track and all of its regions?"
          : `Delete ${ids.length} selected tracks and all of their regions?`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    const ws = window.__foyer?.ws;
    // Multi-track deletes land as a single undo step (PLAN 177).
    const label = ids.length === 1
      ? "Foyer delete track"
      : `Foyer delete ${ids.length} tracks`;
    ws?.send({ type: "undo_group_begin", name: label });
    for (const id of ids) ws?.send({ type: "delete_track", id });
    ws?.send({ type: "undo_group_end" });
  }

  _isSequencerTrack(trackId) {
    const ids = window.__foyer?.store?.state?.sequencerTrackIds;
    return ids ? ids.has(trackId) : false;
  }

  _automationOpen(trackId) {
    if (!this._autoOpen) this._autoOpen = new Set();
    return this._autoOpen.has(trackId);
  }
  _toggleAutomation(trackId) {
    if (!this._autoOpen) this._autoOpen = new Set();
    if (this._autoOpen.has(trackId)) this._autoOpen.delete(trackId);
    else this._autoOpen.add(trackId);
    this.requestUpdate();
  }

  _addRegionAtPlayhead(track) {
    if (!track || track.kind !== "midi") return;
    const store = window.__foyer?.store;
    const playhead = Number(store?.get?.("transport.position") ?? 0);
    this._createRegionAt(track, playhead);
  }

  /** Right-click on empty lane space. If the click fell through from
   *  a region or lane-head, those handlers already stopped
   *  propagation. So we only fire here for bona fide empty-lane
   *  clicks — which is exactly the spot "Add region here" should act
   *  on. Only shown for MIDI tracks (audio region creation needs a
   *  source picker we don't have yet). */
  _onLaneContext(ev, track) {
    if (track?.kind !== "midi") return;
    // If the event originated inside a region or lane-head, the
    // bubble reaches us but the original target is one of those
    // children; skip to avoid overriding the more specific menu.
    if (ev.target?.closest?.(".region") || ev.target?.closest?.(".lane-head")) return;
    ev.preventDefault();
    ev.stopPropagation();
    const scroll = this.renderRoot?.querySelector?.(".scroll");
    if (!scroll) return;
    const bounds = scroll.getBoundingClientRect();
    const contentX = ev.clientX - bounds.left + scroll.scrollLeft - HEAD_WIDTH;
    const sr = this._sampleRate();
    const atSamples = Math.max(0, Math.round((contentX / this._zoom) * sr));
    showContextMenu(ev, [
      { heading: `${track.name} · ${(atSamples / sr).toFixed(2)}s` },
      {
        label: "Add region here",
        icon: "plus",
        action: () => this._createRegionAt(track, atSamples),
      },
      {
        label: "Add region at playhead",
        icon: "play",
        action: () => this._addRegionAtPlayhead(track),
      },
    ]);
  }

  _createRegionAt(track, atSamples, lengthSamples = null) {
    const ws = window.__foyer?.ws;
    if (!ws || !track?.id) return;
    ws.send({
      type: "create_region",
      track_id: track.id,
      at_samples: Math.max(0, Math.round(atSamples)),
      length_samples: lengthSamples ? Math.round(lengthSamples) : undefined,
      kind: "midi",
    });
  }

  _openBeatSequencerForTrack(track) {
    if (!track) return;
    const regions = this._regionsByTrack[track.id] || [];
    const region = regions[0] || { id: `__empty.${track.id}`, track_id: track.id, name: track.name, notes: [] };
    this._openBeatSequencer(region);
  }

  _openBeatSequencer(region) {
    // Pre-open gate. Three states:
    //
    //   * Active sequencer layout → just open. The user is coming
    //     back to their beat; no warning needed.
    //   * Archived layout (active=false) → open in edit-archived
    //     mode silently. Safe (the layout is metadata-only until
    //     the user clicks "Restore sequencer" in the banner).
    //   * No layout + existing MIDI notes → confirm the
    //     overwrite. The first cell-click regenerates the note
    //     list and wipes the hand-authored MIDI.
    //
    // The archived "would you like to restore?" prompt was
    // removed per Rich's 2026-04-22 feedback — the distinction
    // between "edit archived" and "restore" is too subtle for a
    // blocking prompt. Users who want to restore click the
    // prominent "Restore sequencer" button in the banner after
    // the editor opens.
    const layout = region?.foyer_sequencer || null;
    const hasNotes = Array.isArray(region?.notes) && region.notes.length > 0;
    const open = () => this._doOpenBeatSequencer(region);
    if (!layout && hasNotes) {
      import("foyer-ui-core/widgets/confirm-modal.js").then(({ confirmAction }) => {
        confirmAction({
          title: "Convert region to beat sequencer?",
          message:
            "This region already has MIDI notes. Once you place a cell "
            + "in the sequencer and it saves, the region's note list will "
            + "be regenerated from the sequencer's arrangement and the "
            + "existing MIDI notes will be overwritten.\n\n"
            + "You can always come back with \"Convert to MIDI\" from "
            + "the piano roll to make the region editable again.",
          confirmLabel: "Convert to sequencer",
          tone: "warning",
        }).then((ok) => { if (ok) open(); });
      });
      return;
    }
    open();
  }

  _doOpenBeatSequencer(region) {
    Promise.all([
      import("./beat-sequencer.js"),
      import("foyer-ui-core/widgets/window.js"),
    ]).then(([, winMod]) => {
      const seq = document.createElement("foyer-beat-sequencer");
      const trackId  = region?.track_id;
      const bindRegion = (r) => {
        seq.regionId     = r?.id || "";
        seq.regionName   = r?.name || "";
        seq.notes        = Array.isArray(r?.notes) ? r.notes : [];
        seq.layout       = r?.foyer_sequencer || null;
        seq.trackId      = trackId || "";
        seq.trackRegions = this._regionsByTrack[trackId] || [];
      };
      bindRegion(region);
      const onUpdate = () => {
        const list = this._regionsByTrack[trackId] || [];
        // Keep the arrangement strip fresh — always push the
        // latest list. Also hunt for the currently-bound region
        // and refresh its notes/layout without rebinding.
        seq.trackRegions = list;
        const fresh = list.find((r) => r.id === seq.regionId);
        if (fresh) {
          seq.notes  = Array.isArray(fresh.notes) ? fresh.notes : [];
          if (fresh.foyer_sequencer) seq.layout = fresh.foyer_sequencer;
        }
      };
      this.addEventListener("foyer:regions-updated", onUpdate);
      // Arrangement strip click → rebind the editor to the picked
      // region without tearing the window down.
      seq.addEventListener("sequencer-switch-region", (ev) => {
        const list = this._regionsByTrack[trackId] || [];
        const next = list.find((r) => r.id === ev.detail?.regionId);
        if (next) bindRegion(next);
      });
      winMod.openWindow({
        title: `Beat — ${region?.name || region?.id || "region"}`,
        icon: "queue-list",
        storageKey: "beat-sequencer",
        content: seq,
        width: 1100,
        height: 560,
        persist: { kind: "beat-sequencer", id: "beat-sequencer", props: { regionId: region?.id } },
        // Same reasoning as the MIDI editor — retarget the live
        // sequencer to the new region rather than spawning a dup.
        onReuse: (existingSeq) => {
          if (!existingSeq) return;
          existingSeq.regionId = seq.regionId;
          existingSeq.regionName = seq.regionName;
          existingSeq.notes = seq.notes;
          existingSeq.layout = seq.layout;
          existingSeq.trackId = seq.trackId;
          existingSeq.trackRegions = seq.trackRegions;
        },
      });
      const win = seq.closest("foyer-window");
      win?.addEventListener("close", () => {
        this.removeEventListener("foyer:regions-updated", onUpdate);
      }, { once: true });
    });
  }

  _openMidiManager(track) {
    import("./track-editor-modal.js").then((m) => m.openTrackEditor(track.id, { tab: "midi" }));
  }

  // ── zoom stack ─────────────────────────────────────────────────────
  /** Push current viewport, then zoom the time-range selection to fill
   *  the scroll container (minus the sticky HEAD column). No-op if
   *  nothing is selected. */
  zoomToSelection() {
    if (!this._selection) return false;
    const sr = this._sampleRate();
    const a = Math.min(this._selection.startSamples, this._selection.endSamples);
    const b = Math.max(this._selection.startSamples, this._selection.endSamples);
    const selSec = Math.max(0.01, (b - a) / sr);
    const scroll = this.renderRoot.querySelector(".scroll");
    if (!scroll) return false;
    const visiblePx = Math.max(50, scroll.clientWidth - HEAD_WIDTH);
    // Leave ~6% padding on either side so the selection isn't flush.
    const target = (visiblePx * 0.88) / selSec;
    const nextZoom = Math.max(2, Math.min(4000, Math.round(target)));
    this._pushZoomSnapshot(scroll);
    this._zoom = nextZoom;
    // Let Lit repaint at new zoom, then scroll so the selection start
    // sits at ~6% from the left of the visible timeline area.
    this.updateComplete.then(() => {
      const sc = this.renderRoot.querySelector(".scroll");
      if (!sc) return;
      const startPx = (a / sr) * this._zoom;
      sc.scrollLeft = Math.max(0, startPx - visiblePx * 0.06);
    });
    return true;
  }

  /** Pop the last snapshot off the zoom stack. No-op on empty stack. */
  zoomPrevious() {
    const snap = this._zoomStack.pop();
    if (!snap) return false;
    this._zoom = snap.zoom;
    this.updateComplete.then(() => {
      const sc = this.renderRoot.querySelector(".scroll");
      if (sc) sc.scrollLeft = snap.scrollLeft;
    });
    return true;
  }

  _setLoopToSelection() {
    if (!this._selection) return false;
    const ws = window.__foyer?.ws;
    if (!ws) return false;
    const a = Math.min(this._selection.startSamples, this._selection.endSamples);
    const b = Math.max(this._selection.startSamples, this._selection.endSamples);
    ws.send({
      type: "set_loop_range",
      start_samples: a,
      end_samples: b,
      enabled: true,
    });
    return true;
  }

  _pushZoomSnapshot(scrollEl) {
    this._zoomStack.push({
      zoom: this._zoom,
      scrollLeft: scrollEl?.scrollLeft || 0,
    });
    if (this._zoomStack.length > this._zoomStackMax) this._zoomStack.shift();
  }

  // ── selection ops ───────────────────────────────────────────────────
  /**
   * Regions that fall under the current selection. The "selection" is:
   *   - tracks:  Store.selectedTrackIds (or ALL audio/midi tracks if empty)
   *   - range:   `_selection` if set, else the full timeline (open-ended ops)
   * Returns `[{region, track}]` tuples. Used by delete/mute/... menu items.
   */
  _regionsInSelection() {
    const store = window.__foyer?.store;
    const tracks = this.session?.tracks || [];
    const selTracks = store?.state?.selectedTrackIds;
    // If no tracks are explicitly selected, the op applies to every
    // track that could host a region — matches the menu wording ("Delete
    // selection") and mirrors what most DAWs do.
    const activeTrackIds = selTracks && selTracks.size
      ? new Set(selTracks)
      : new Set(tracks.filter(t => t.kind === "audio" || t.kind === "midi").map(t => t.id));
    // No time range = no ambiguity-free op. Bail so we don't nuke the
    // entire session by accident.
    if (!this._selection) return [];
    const a = Math.min(this._selection.startSamples, this._selection.endSamples);
    const b = Math.max(this._selection.startSamples, this._selection.endSamples);
    const out = [];
    for (const t of tracks) {
      if (!activeTrackIds.has(t.id)) continue;
      const rs = this._regionsByTrack[t.id] || [];
      for (const r of rs) {
        const rStart = Number(r.start_samples || 0);
        const rEnd = rStart + Number(r.length_samples || 0);
        // Include any region that overlaps the selection at all.
        if (rEnd > a && rStart < b) out.push({ region: r, track: t });
      }
    }
    return out;
  }

  /** Delete all regions overlapping the current selection on selected
   *  tracks. Fire-and-forget per-region DeleteRegion commands — the
   *  shim broadcasts RegionRemoved events which update the local state. */
  deleteSelection() {
    const hits = this._regionsInSelection();
    if (!hits.length) return 0;
    const ws = window.__foyer?.ws;
    for (const { region } of hits) {
      ws?.send({ type: "delete_region", id: region.id });
    }
    return hits.length;
  }

  getSelectedRegionIds() {
    return [...this._selectedRegionIds];
  }

  deleteSelectedRegions() {
    const ids = this.getSelectedRegionIds();
    if (!ids.length) return 0;
    const ws = window.__foyer?.ws;
    // Wrap the batch in an undo group so one Ctrl+Z restores the
    // entire selection rather than popping one region at a time.
    // PLAN 177.
    const groupLabel = ids.length === 1
      ? "Foyer delete region"
      : `Foyer delete ${ids.length} regions`;
    ws?.send({ type: "undo_group_begin", name: groupLabel });
    for (const id of ids) ws?.send({ type: "delete_region", id });
    ws?.send({ type: "undo_group_end" });
    this._selectedRegionIds.clear();
    this.requestUpdate();
    return ids.length;
  }

  // ── clipboard ops (cut/copy/paste/duplicate) ───────────────────────
  /**
   * Snapshot the current click-selection of regions into the clipboard.
   * Captures relative offsets so a multi-region paste preserves the
   * original spacing. Returns the count snapshotted.
   */
  copyRegionSelection({ mode = "copy", silent = false } = {}) {
    const ids = [...this._selectedRegionIds];
    if (!ids.length) {
      if (!silent) toast("Nothing selected — click a region first", { tone: "warn", ttl: 2400 });
      return 0;
    }
    const tracks = this.session?.tracks || [];
    // If the user has BOTH a region click-selection AND an active time
    // range, slice the regions to that range (each region contributes
    // only the bits that overlap the range). Otherwise capture the
    // whole region. The slice-start/len are stored in clipboard items
    // so paste can pick the right wire command.
    const tr = this._selection
      ? {
          start: Math.min(this._selection.startSamples, this._selection.endSamples),
          end: Math.max(this._selection.startSamples, this._selection.endSamples),
        }
      : null;
    const items = [];
    let anchor = Number.POSITIVE_INFINITY;
    for (const id of ids) {
      let region = null;
      let track = null;
      for (const t of tracks) {
        const r = (this._regionsByTrack[t.id] || []).find((r) => r.id === id);
        if (r) { region = r; track = t; break; }
      }
      if (!region) continue;
      const start = Number(region.start_samples || 0);
      const len = Number(region.length_samples || 0);
      const end = start + len;
      let sliceStart = 0;
      let sliceLen = len;
      let timelineAnchor = start;
      if (tr) {
        // Intersect [start, end] with [tr.start, tr.end].
        const overlapStart = Math.max(start, tr.start);
        const overlapEnd = Math.min(end, tr.end);
        if (overlapEnd <= overlapStart) continue; // no overlap; skip
        sliceStart = overlapStart - start; // offset INTO the source region
        sliceLen = overlapEnd - overlapStart;
        timelineAnchor = overlapStart;     // for paste-position offsets
      }
      anchor = Math.min(anchor, timelineAnchor);
      items.push({
        region_id: region.id,
        track_id: track.id,
        start_samples: timelineAnchor, // for offset bookkeeping below
        length_samples: sliceLen,
        slice_start: sliceStart,
        slice_len: sliceLen,
        full_length: len,
        region_start_samples: start, // timeline pos of the source region
      });
    }
    if (!items.length) {
      if (!silent) toast("Nothing selected — click a region first", { tone: "warn", ttl: 2400 });
      return 0;
    }
    // Re-key offsets from the earliest item so paste re-anchors to
    // the cursor while keeping internal spacing between captured items.
    for (const it of items) it.offset_samples = it.start_samples - anchor;
    const sliced = !!tr;
    this._regionClipboard = { mode, anchor_samples: anchor, items, sliced };
    // Visual marker for cut-pending regions. Replaces any prior cut
    // pending state — a fresh cut/copy supersedes the previous one.
    // Stored as Map(region_id -> {sliceStart, sliceLen, fullLength}) so
    // the renderer can dim only the slice (not the whole region) when
    // a time-range cut is queued. For whole-region cuts the slice
    // covers [0, fullLength] and the dim spans the entire lozenge as
    // before.
    if (mode === "cut") {
      this._cutPending = new Map(
        items.map((it) => [it.region_id, {
          sliceStart: it.slice_start,
          sliceLen: it.slice_len,
          fullLength: it.full_length,
        }]),
      );
    } else {
      this._cutPending = new Map();
    }
    this.requestUpdate();
    if (!silent) {
      const noun = items.length === 1 ? "region" : "regions";
      const sliceNote = sliced ? " (range slice)" : "";
      toast(
        mode === "cut"
          ? `Cut ${items.length} ${noun}${sliceNote} — paste to commit`
          : `Copied ${items.length} ${noun}${sliceNote}`,
        { tone: "info", ttl: 2400 },
      );
    }
    return items.length;
  }

  cutRegionSelection() {
    // Same snapshot as copy; the actual delete happens on paste so the
    // server-side region IDs stay valid until DuplicateRegion fires.
    // If the user never pastes, originals are preserved (intentional).
    return this.copyRegionSelection({ mode: "cut" });
  }

  /**
   * Paste the clipboard. The anchor sample defaults to the mouse's
   * current grid position so a Ctrl+V drops near the cursor — Reaper's
   * default. Pass `{ at: "playhead" }` (or `{ at: <samples> }`) for
   * other anchors (Ctrl+Shift+V is wired to playhead in keybinds.js).
   *
   * For sliced clipboards (region selection AND time range at capture
   * time), each item is sent as `duplicate_region_range` so the shim
   * can carve only the captured slice out of the source. Whole-region
   * captures fall back to plain `duplicate_region`.
   *
   * For cut-mode, the originals are deleted after the duplicates land.
   * Returns the number of regions written.
   */
  pasteRegions({ at = "mouse" } = {}) {
    const clip = this._regionClipboard;
    if (!clip || !clip.items.length) {
      toast("Clipboard is empty — copy a region first", { tone: "warn", ttl: 2400 });
      return 0;
    }
    const ws = window.__foyer?.ws;
    let anchorSamples;
    if (typeof at === "number") {
      anchorSamples = at;
    } else if (at === "playhead") {
      anchorSamples = Number(
        window.__foyer?.store?.state?.controls?.get("transport.position") || 0,
      );
    } else {
      // Default: mouse. Falls back to playhead if the pointer is off
      // the grid (e.g. user invoked the keybind with cursor over a FAB).
      const fromMouse = this._mouseAnchorSamples();
      anchorSamples = fromMouse != null
        ? fromMouse
        : Number(window.__foyer?.store?.state?.controls?.get("transport.position") || 0);
    }
    const cut = clip.mode === "cut";
    const groupLabel = cut
      ? `Foyer paste ${clip.items.length} regions (cut)`
      : `Foyer paste ${clip.items.length} regions`;
    ws?.send({ type: "undo_group_begin", name: groupLabel });
    for (const it of clip.items) {
      const at_samples = anchorSamples + it.offset_samples;
      if (clip.sliced) {
        ws?.send({
          type: "duplicate_region_range",
          source_region_id: it.region_id,
          source_offset_samples: it.slice_start,
          length_samples: it.slice_len,
          at_samples,
        });
      } else {
        ws?.send({
          type: "duplicate_region",
          source_region_id: it.region_id,
          at_samples,
          length_samples: it.length_samples,
        });
      }
    }
    if (cut) {
      // Split-around-slice for sliced cuts: the source region becomes
      // two pieces (the part BEFORE the slice + the part AFTER) so the
      // user gets a gap where the slice used to be — Reaper's standard
      // "cut a chunk out" behavior. Whole-region cuts collapse to the
      // simple delete path.
      //
      // Order matters: create the "after" clone FIRST so the source
      // region's full content is still available when the shim
      // dereferences `source_region_id`. Trimming/deleting the source
      // happens last.
      for (const it of clip.items) {
        const isSliced = clip.sliced
          && !(it.slice_start === 0 && it.slice_len >= it.full_length);
        if (!isSliced) {
          ws?.send({ type: "delete_region", id: it.region_id });
          continue;
        }
        const beforeLen = it.slice_start;
        const afterOffset = it.slice_start + it.slice_len;
        const afterLen = it.full_length - afterOffset;
        if (afterLen > 0) {
          ws?.send({
            type: "duplicate_region_range",
            source_region_id: it.region_id,
            source_offset_samples: afterOffset,
            length_samples: afterLen,
            at_samples: it.region_start_samples + afterOffset,
          });
        }
        if (beforeLen > 0) {
          ws?.send({
            type: "update_region",
            id: it.region_id,
            patch: { length_samples: beforeLen },
          });
        } else {
          // No "before" piece; the after-clone replaces the source.
          ws?.send({ type: "delete_region", id: it.region_id });
        }
      }
      // After a cut/paste, the clipboard slot is consumed so a second
      // paste doesn't re-delete already-gone originals. Clear it.
      this._regionClipboard = null;
      this._cutPending = new Map();
      this.requestUpdate();
    }
    ws?.send({ type: "undo_group_end" });
    const noun = clip.items.length === 1 ? "region" : "regions";
    toast(
      cut ? `Pasted ${clip.items.length} ${noun} (originals removed)`
          : `Pasted ${clip.items.length} ${noun}`,
      { tone: "info", ttl: 2400 },
    );
    return clip.items.length;
  }

  /** Back-compat shim — old callers (specs, agents) used the old name. */
  pasteRegionsAtPlayhead() {
    return this.pasteRegions({ at: "playhead" });
  }

  /**
   * Translate the last-known mouse position over the timeline grid
   * into a sample offset. Returns `null` when the cursor is outside
   * the content area or before the head column. Mirrors the inverse
   * of the leftPx math in `_renderLane` / region rects.
   */
  _mouseAnchorSamples() {
    if (this._lastMouseGridX == null) return null;
    const sr = this._sampleRate();
    const x = this._lastMouseGridX - HEAD_WIDTH;
    if (x < 0) return null;
    const samples = (x / this._zoom) * sr;
    return Math.max(0, Math.round(samples));
  }

  /**
   * Duplicate every region in the click-selection to a position right
   * after the original (start_samples + length_samples). Same-track
   * only — DuplicateRegion is keyed on source_region_id. Wrapped in
   * one undo group.
   */
  duplicateRegionSelection() {
    const ids = [...this._selectedRegionIds];
    if (!ids.length) {
      toast("Nothing selected — click a region first", { tone: "warn", ttl: 2400 });
      return 0;
    }
    const tracks = this.session?.tracks || [];
    const ws = window.__foyer?.ws;
    const groupLabel = ids.length === 1
      ? "Foyer duplicate region"
      : `Foyer duplicate ${ids.length} regions`;
    ws?.send({ type: "undo_group_begin", name: groupLabel });
    let written = 0;
    for (const id of ids) {
      let region = null;
      for (const t of tracks) {
        const r = (this._regionsByTrack[t.id] || []).find((r) => r.id === id);
        if (r) { region = r; break; }
      }
      if (!region) continue;
      ws?.send({
        type: "duplicate_region",
        source_region_id: region.id,
        at_samples: Number(region.start_samples || 0) + Number(region.length_samples || 0),
        length_samples: Number(region.length_samples || 0),
      });
      written += 1;
    }
    ws?.send({ type: "undo_group_end" });
    if (written > 0) {
      const noun = written === 1 ? "region" : "regions";
      toast(`Duplicated ${written} ${noun}`, { tone: "info", ttl: 2400 });
    }
    return written;
  }

  /**
   * Toggle mute on every region in the click-selection. Mirrors
   * `muteSelection()` (which works off time-range), so the user gets
   * a consistent op whether they shift-click regions or drag a range.
   */
  toggleMuteRegionSelection() {
    const ids = [...this._selectedRegionIds];
    if (!ids.length) {
      toast("Nothing selected — click a region first", { tone: "warn", ttl: 2400 });
      return 0;
    }
    const tracks = this.session?.tracks || [];
    const regions = [];
    for (const id of ids) {
      for (const t of tracks) {
        const r = (this._regionsByTrack[t.id] || []).find((r) => r.id === id);
        if (r) { regions.push(r); break; }
      }
    }
    if (!regions.length) return 0;
    const anyUnmuted = regions.some((r) => !r.muted);
    const target = anyUnmuted; // any unmuted → mute all; else unmute all
    const ws = window.__foyer?.ws;
    const groupLabel = regions.length === 1
      ? (target ? "Foyer mute region" : "Foyer unmute region")
      : `Foyer ${target ? "mute" : "unmute"} ${regions.length} regions`;
    ws?.send({ type: "undo_group_begin", name: groupLabel });
    for (const r of regions) {
      ws?.send({ type: "update_region", id: r.id, patch: { muted: target } });
    }
    ws?.send({ type: "undo_group_end" });
    const noun = regions.length === 1 ? "region" : "regions";
    toast(
      `${target ? "Muted" : "Unmuted"} ${regions.length} ${noun}`,
      { tone: "info", ttl: 2000 },
    );
    return regions.length;
  }

  /** Shallow status of the clipboard for UI affordances. */
  hasClipboard() {
    return !!(this._regionClipboard && this._regionClipboard.items?.length);
  }

  /** Toggle mute on regions overlapping the selection. If the set has
   *  any unmuted region, mute all. Otherwise unmute all. */
  muteSelection() {
    const hits = this._regionsInSelection();
    if (!hits.length) return 0;
    const anyUnmuted = hits.some((h) => !h.region.muted);
    const target = anyUnmuted; // if any unmuted, set all to muted=true
    const ws = window.__foyer?.ws;
    for (const { region } of hits) {
      ws?.send({
        type: "update_region",
        id: region.id,
        patch: { muted: target },
      });
    }
    return hits.length;
  }

  render() {
    // Defensive cut-pending reconcile: catches selection changes
    // routed through any of the half-dozen `_selectedRegionIds.clear()`
    // sites in this file without having to instrument each one.
    this._reconcileCutPending();
    const tracks = this.session?.tracks ?? [];
    const sr = this._sampleRate();
    // Base content length: session length (or 30s min). Extended on the
    // fly by `_zoomPadSec` when the user scroll-zooms past the natural
    // content edge, so anchored zoom keeps the cursor pinned to the
    // sample under it even in the dead-space case where there's no
    // region farther right to hold the scroll range open.
    const baseSec = Math.max(30, (this._timeline?.length_samples || sr * 30) / sr);
    const totalSec = Math.max(baseSec, this._zoomPadSec || 0);
    const widthPx = totalSec * this._zoom;
    const gridWidth = widthPx + HEAD_WIDTH;

    const majorEvery = this._zoom < 40 ? 10 : this._zoom < 100 ? 5 : 1;
    const minorEvery = majorEvery / 5;
    const ticks = [];
    for (let t = 0; t <= totalSec + 1e-6; t += minorEvery) {
      const major = Math.abs(t / majorEvery - Math.round(t / majorEvery)) < 1e-6;
      ticks.push({ t, major });
    }

    return html`
      <div class="toolbar">
        <span>Zoom</span>
        <input type="range" min="0" max="1000" step="1"
               .value=${String(Math.round(Math.log(this._zoom / 2) / Math.log(4000 / 2) * 1000))}
               @input=${(e) => {
                 const t = Number(e.currentTarget.value) / 1000;
                 this._zoom = Math.max(2, Math.min(4000, Math.round(2 * Math.pow(4000 / 2, t))));
               }}>
        <span>${this._zoom} px/s · tier=${pickTier(this._samplesPerPx())}</span>
        ${this._selection ? html`
          <button
            @click=${() => this.zoomToSelection()}
            title="Zoom to the current timeline selection"
          >Zoom to selection</button>
          <button
            @click=${() => this._setLoopToSelection()}
            title="Set loop start/end from current selection"
          >Loop selection</button>
        ` : null}
        <span style="flex:1"></span>
        ${this._quantOn ? html`
          <select title="Grid subdivision per quarter note (toggle visibility from the Viz menu)"
                  @change=${(e) => this._setQuantDiv(Number(e.currentTarget.value))}>
            <option value="4"  ?selected=${this._quantDiv === 4}>1/4</option>
            <option value="8"  ?selected=${this._quantDiv === 8}>1/8</option>
            <option value="16" ?selected=${this._quantDiv === 16}>1/16</option>
            <option value="32" ?selected=${this._quantDiv === 32}>1/32</option>
            <option value="6"  ?selected=${this._quantDiv === 6}>1/8T</option>
            <option value="12" ?selected=${this._quantDiv === 12}>1/16T</option>
          </select>
        ` : null}
        <foyer-viz-picker></foyer-viz-picker>
        ${this._diagEnabled() ? html`
          <span>
            drops: seq=${this._transportDropStats.stale_seq || 0}
            back=${this._transportDropStats.backward_jump || 0}
          </span>
        ` : null}
      </div>
      <div class="scroll" @wheel=${(e) => this._onWheel(e)}>
        <div class="grid" style="width:${gridWidth}px"
             @pointermove=${(e) => this._onGridHoverMove(e)}
             @pointerleave=${() => { this._hoverSamples = null; this._lastMouseGridX = null; }}>
          <div class="ruler"
               @wheel=${(e) => this._onRulerWheel(e)}
               @pointerdown=${(e) => this._onRulerPointerDown(e)}
               @contextmenu=${(e) => e.preventDefault()}>
            ${ticks.map(({ t, major }) => html`
              <span class="tick ${major ? 'major' : 'minor'}"
                    style="left:${HEAD_WIDTH + t * this._zoom}px">
                ${major ? html`<span style="padding-left:4px">${t.toFixed(0)}s</span>` : null}
              </span>
            `)}
          </div>
          ${getVizPref("timeGridOn") !== false ? html`
            <div class="lane-gridlines" style="width:${widthPx}px">
              ${ticks.map(({ t, major }) => html`
                <span class="gl ${major ? 'major' : ''}" style="left:${t * this._zoom}px"></span>
              `)}
            </div>
          ` : null}
          ${this._renderQuantGrid()}
          ${tracks.map(t => this._renderLane(t))}
          ${this._renderSelection()}
          ${this._renderHoverCursor()}
          ${this._renderPlayhead()}
          ${this._renderRecordingPlaceholder()}
        </div>
      </div>
    `;
  }

  _renderSelection() {
    if (!this._selection) return null;
    const sr = this._sampleRate();
    const a = Math.min(this._selection.startSamples, this._selection.endSamples);
    const b = Math.max(this._selection.startSamples, this._selection.endSamples);
    const leftPx = HEAD_WIDTH + (a / sr) * this._zoom;
    const rightPx = HEAD_WIDTH + (b / sr) * this._zoom;
    const widthPx = Math.max(1, ((b - a) / sr) * this._zoom);
    return html`
      <div class="selection-body" style="left:${leftPx}px;width:${widthPx}px"></div>
      <div class="selection-ruler" style="left:${leftPx}px;width:${widthPx}px"></div>
      <div class="selection-handle left"
           title="Drag to resize the start of the selection"
           style="left:${leftPx}px"
           @pointerdown=${(e) => this._startSelectionResize(e, "left")}></div>
      <div class="selection-handle right"
           title="Drag to resize the end of the selection"
           style="left:${rightPx}px"
           @pointerdown=${(e) => this._startSelectionResize(e, "right")}></div>
    `;
  }

  _onGridHoverMove(ev) {
    // Stash the grid-local pointer X for the mouse-anchored paste
    // keybind. Captured eagerly (no rAF gate) so a paste fired right
    // after a mouse move uses the latest position; cheap, just two
    // assignments + a rect lookup. Stored as the offset from the grid
    // element's left edge — `_mouseAnchorSamples()` subtracts the
    // head column to get the content-area position.
    const grid = this.renderRoot.querySelector(".grid");
    if (grid) {
      const r = grid.getBoundingClientRect();
      this._lastMouseGridX = ev.clientX - r.left;
    }
    // Throttle via rAF — pointermove fires at hardware rate and we
    // only need one update per paint frame.
    if (this._hoverRaf) return;
    this._hoverRaf = requestAnimationFrame(() => {
      this._hoverRaf = 0;
      const ruler = this.renderRoot.querySelector(".ruler");
      if (!ruler) return;
      const samples = this._samplesAtX(ev.clientX, ruler);
      if (Number.isFinite(samples)) this._hoverSamples = samples;
    });
  }

  _renderQuantGrid() {
    if (!this._quantOn) return null;
    const sr = this._sampleRate();
    const len = this._timeline?.length_samples || 0;
    const totalSec = len / sr;
    const ctls = window.__foyer?.store?.state?.controls;
    const tempo = Number(ctls?.get?.("transport.tempo")) || 120;
    if (!Number.isFinite(tempo) || tempo <= 0) return null;
    // Ardour treats `transport.tempo` as quarter-note BPM. ts.den says
    // which note value gets a beat — in 6/8 a beat is an eighth, so the
    // perceptual beat is half as long as the quarter-note implied by
    // tempo. Scale beatSec by 4/den so the visible beat lines reflect
    // what the metronome actually clicks.
    // Then ts.num gives beats-per-bar; every num-th beat gets a stronger
    // bar line. This is what was missing — the old grid drew every beat
    // with the same emphasis regardless of the time signature.
    const tsNum = Math.max(1, Math.round(Number(ctls?.get?.("transport.ts.num")) || 4));
    const tsDen = Math.max(1, Math.round(Number(ctls?.get?.("transport.ts.den")) || 4));
    const beatSec = (60 / tempo) * (4 / tsDen);
    const div = Math.max(1, this._quantDiv | 0);
    // Subdivisions per beat. Dropdown values are quarter-note relative
    // (1/4, 1/8, 1/16, …); convert to "per beat" given that a beat
    // might be an 8th note. div=4 (quarter-notes) ÷ tsDen → for 4/4
    // gives 1 sub/beat (just the beat itself), for 6/8 gives 0.5 which
    // we floor to 1.
    const subsPerBeat = Math.max(1, Math.round(div / tsDen));
    const stepSec = beatSec / subsPerBeat;
    const lines = [];
    let beatIndex = 0;
    let subIndex = 0;
    for (let t = 0; t <= totalSec + 1e-6; t += stepSec) {
      const onBeat = subIndex === 0;
      const onBar = onBeat && beatIndex % tsNum === 0;
      lines.push({ t, kind: onBar ? "bar" : onBeat ? "beat" : "sub" });
      subIndex += 1;
      if (subIndex >= subsPerBeat) {
        subIndex = 0;
        beatIndex += 1;
      }
      // Cap to keep the DOM sane on long sessions at high subdivisions.
      if (lines.length > 4000) break;
    }
    return html`${lines.map((l) => html`
      <span class="quant-line ${l.kind}"
            style="left:${HEAD_WIDTH + l.t * this._zoom}px"></span>
    `)}`;
  }

  _toggleQuantOn() {
    this._quantOn = !this._quantOn;
    // Mirror to the viz prefs so the Viz menu's checkbox reflects the
    // change. The legacy `foyer.timeline.quant.on` localStorage key
    // is no longer the source of truth — kept only as fallback for
    // anything that hasn't been migrated. setVizPref dispatches
    // `foyer:viz-prefs-changed`, which the timeline already listens
    // for via `_onVizPrefsChanged`.
    setVizPref("quantGridOn", this._quantOn);
  }
  _setQuantDiv(d) {
    this._quantDiv = d;
    try { localStorage.setItem("foyer.timeline.quant.div", String(d)); } catch {}
  }

  _renderHoverCursor() {
    if (this._hoverSamples == null) return null;
    const sr = this._sampleRate();
    const x = HEAD_WIDTH + (this._hoverSamples / sr) * this._zoom;
    return html`<div class="cursor-line" style="left:${x}px"></div>`;
  }

  _startSelectionResize(ev, edge) {
    if (ev.button !== 0) return;
    if (!this._selection) return;
    ev.preventDefault();
    ev.stopPropagation();
    const handle = ev.currentTarget;
    handle.classList.add("dragging");
    // Resolve which edge of the *visible* range we're on (start <= end
    // not guaranteed in raw _selection); find the ruler element to
    // compute samples-at-X.
    const ruler = this.renderRoot.querySelector(".ruler");
    const a = this._selection.startSamples;
    const b = this._selection.endSamples;
    const startEdge = edge === "left" ? Math.min(a, b) : Math.max(a, b);
    const fixedEdge = edge === "left" ? Math.max(a, b) : Math.min(a, b);
    void startEdge;
    const move = (e) => {
      if (!ruler) return;
      const samples = this._samplesAtX(e.clientX, ruler);
      this._selection = edge === "left"
        ? { startSamples: samples, endSamples: fixedEdge }
        : { startSamples: fixedEdge, endSamples: samples };
    };
    const up = () => {
      handle.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (this._selection) {
        const lo = Math.min(this._selection.startSamples, this._selection.endSamples);
        const hi = Math.max(this._selection.startSamples, this._selection.endSamples);
        if (Math.abs(lo - hi) < 1) {
          this._selection = null;
        } else {
          this.dispatchEvent(new CustomEvent("timeline-selection", {
            detail: { startSamples: lo, endSamples: hi },
            bubbles: true, composed: true,
          }));
          // Loop-follows-selection: if the transport is actively looping
          // when the user finishes resizing the selection, push the new
          // range to the engine so the loop tracks the visible band.
          // Scoped to *resize* (not initial selection drag) so an
          // unrelated selection gesture doesn't yank the loop.
          if (window.__foyer?.store?.state?.controls?.get?.("transport.looping")) {
            this._setLoopToSelection();
          }
        }
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  _renderPlayhead() {
    const sr = this._sampleRate();
    const x = HEAD_WIDTH + (this._playheadSamples / sr) * this._zoom;
    return html`<div class="playhead" style="left:${x}px"></div>`;
  }

  /** Pixels for the live recording span (punch-in cursor → playhead), or null. */
  _recordingSpanPixels(controls) {
    if (!controls || !controls.get("transport.recording")) return null;
    const sr = this._sampleRate();
    this._syncRecordingAnchor();
    let recStart = this._recordingAnchorSamples;
    if (!Number.isFinite(recStart)) recStart = controls.get("transport.record_position");
    if (!Number.isFinite(recStart)) recStart = Math.max(0, this._playheadSamples - sr);
    const playhead = this._playheadSamples;
    const leftPx = HEAD_WIDTH + (Math.min(recStart, playhead) / sr) * this._zoom;
    const widthPx = Math.max(1, (Math.abs(playhead - recStart) / sr) * this._zoom);
    return { leftPx, widthPx };
  }

  _renderRecordingPlaceholder() {
    const store = window.__foyer?.store;
    const controls = store?.state?.controls;
    const span = this._recordingSpanPixels(controls);
    if (!span) return null;
    const tracks = this.session?.tracks || [];
    const anyArmed = tracks.some((t) => {
      const id = t.record_arm?.id;
      return id && controls.get(id);
    });
    if (anyArmed) return null;
    return html`
      <div class="recording-placeholder" style="left:${span.leftPx}px;width:${span.widthPx}px"></div>
    `;
  }

  _renderLane(track) {
    const regions = this._regionsByTrack[track.id] || [];
    const sr = this._sampleRate();
    const h = this._laneHeightFor(track.id);
    const store = window.__foyer?.store;
    const controls = store?.state?.controls;
    const muted = !!(controls && controls.get(track.mute?.id));
    const soloed = !!(controls && controls.get(track.solo?.id));
    const armed = !!(controls && track.record_arm && controls.get(track.record_arm.id));
    const canArm = !!track.record_arm;
    const selected = !!store?.isTrackSelected?.(track.id);
    return html`
      <div class="lane ${selected ? "selected" : ""}" style="height:${h}px"
           @contextmenu=${(e) => this._onLaneContext(e, track)}>
        <div class="lane-head" style="height:${h}px"
             title="Click to select · double-click for track editor · right-click for more"
             @click=${(e) => this._onLaneHeadClick(e, track.id)}
             @dblclick=${(e) => { e.stopPropagation();
                   import("./track-editor-modal.js").then((m) => m.openTrackEditor(track.id)); }}
             @contextmenu=${(e) => this._onLaneHeadContext(e, track)}>
          <div class="lane-name" title=${track.name}>${track.name}</div>
          <div class="lane-kind">
            ${track.kind}${this._isSequencerTrack(track.id) ? html`<span class="seq-chip" title="Active beat-sequencer region">SEQ</span>` : null}
          </div>
          <div class="lane-controls"
               @dblclick=${(e) => e.stopPropagation()}>
            <!-- @dblclick stop on the wrapper so a fast double-tap on
                 any M/S/R/A button doesn't bubble to lane-head and
                 spawn the track editor (Rich, TODO #52). -->
            <div class="lane-ctl-btn mute ${muted ? "on" : ""}"
                 title="Mute (${muted ? "on" : "off"})"
                 @click=${(e) => { e.stopPropagation(); this._toggleTrackBool(track.mute?.id); }}>M</div>
            <div class="lane-ctl-btn solo ${soloed ? "on" : ""}"
                 title="Solo (${soloed ? "on" : "off"})"
                 @click=${(e) => { e.stopPropagation(); this._toggleTrackBool(track.solo?.id); }}>S</div>
            ${canArm ? html`
              <div class="lane-ctl-btn rec ${armed ? "on" : ""}"
                   title="Record arm (${armed ? "on" : "off"})"
                   @click=${(e) => { e.stopPropagation(); this._toggleTrackBool(track.record_arm?.id); }}>R</div>
            ` : null}
            ${(track.automation_lanes && track.automation_lanes.length > 0) ? html`
              <div class="lane-ctl-btn auto ${this._automationOpen(track.id) ? "on" : ""}"
                   title="Show / hide automation lanes"
                   @click=${(e) => { e.stopPropagation(); this._toggleAutomation(track.id); }}>A</div>
            ` : null}
          </div>
        </div>
        ${this._automationOpen(track.id) && track.automation_lanes?.length ? html`
          <div class="automation-stack" style="left:${HEAD_WIDTH}px">
            ${track.automation_lanes.map((lane) => html`
              <foyer-automation-lane
                .lane=${lane}
                .totalSamples=${this._timeline?.length_samples || 0}
                .pxPerSec=${this._zoom}
                .sampleRate=${sr}
                .color=${track.color || ""}
              ></foyer-automation-lane>
            `)}
          </div>
        ` : null}
        ${regions.map(r => {
          const leftPx = HEAD_WIDTH + (r.start_samples / sr) * this._zoom;
          const widthPx = Math.max(10, (r.length_samples / sr) * this._zoom);
          // MIDI regions paint their actual note list — audio regions
          // paint waveform peaks. The host backend would otherwise
          // fall through to synthesized sine peaks for MIDI regions
          // (no source_path → synth_waveform fallback in
          // foyer-backend-host/src/lib.rs:244), which is a visual lie.
          const isMidi = track.kind === "midi";
          const regionSelected = this._selectedRegionIds.has(r.id);
          const cutInfo = this._cutPending?.get(r.id);
          // For sliced cuts, dim only the slice (overlay div positioned
          // relative to the region). For whole-region cuts (slice covers
          // the whole region) the overlay matches the region's full
          // width, so we keep the same code path either way and skip
          // the legacy `cut-pending` class on the outer div — the
          // overlay handles the dim.
          const regionLen = Math.max(1, Number(r.length_samples) || 1);
          let cutOverlay = null;
          if (cutInfo) {
            const sliceStart = Math.max(0, Math.min(cutInfo.sliceStart, regionLen));
            const sliceEnd = Math.max(sliceStart, Math.min(sliceStart + cutInfo.sliceLen, regionLen));
            const leftPct = (sliceStart / regionLen) * 100;
            const rightPct = ((regionLen - sliceEnd) / regionLen) * 100;
            cutOverlay = html`
              <div class="cut-slice-overlay"
                   style="left:${leftPct}%;right:${rightPct}%"></div>
            `;
          }
          return html`
            <div class="region ${regionSelected ? "selected" : ""}" data-id=${r.id}
                 tabindex="0"
                 style="left:${leftPx}px;width:${widthPx}px;top:4px;bottom:4px;outline:none"
                 @pointerdown=${(e) => { this._onRegionPointerDown(e, r); this._startDrag(e, r, "move"); }}
                 @dblclick=${(e) => { e.stopPropagation(); this._openRegionEditor(r); }}
                 @contextmenu=${(e) => this._regionContextMenu(e, r)}>
              ${isMidi
                ? html`<foyer-midi-strip class="viz" .notes=${r.notes || []} .color=${track.color || ""}></foyer-midi-strip>`
                : html`<foyer-waveform-gl class="viz" data-id=${r.id}></foyer-waveform-gl>`}
              ${cutOverlay}
              <div class="name">${r.name}</div>
              <div class="edge left"  @pointerdown=${(e) => this._startDrag(e, r, "resize-left")}></div>
              <div class="edge right" @pointerdown=${(e) => this._startDrag(e, r, "resize-right")}></div>
            </div>
          `;
        })}
        ${(() => {
          const recording = !!(controls && controls.get("transport.recording"));
          const span = this._recordingSpanPixels(controls);
          if (!recording || !armed || !span) return null;
          return html`
            <div class="recording-lane-fill" style="left:${span.leftPx}px;width:${span.widthPx}px"></div>
          `;
        })()}
        <div class="lane-resize"
             title="Drag to resize lane"
             @pointerdown=${(e) => this._startLaneResize(e, track.id)}></div>
      </div>
    `;
  }

  /**
   * Mouse-wheel zoom. Plain wheel adjusts temporal zoom (px/s); Alt- or
   * Ctrl-wheel adjusts the lane height of whichever track the pointer is
   * over. Horizontal scroll still works by holding Shift (browser default)
   * or by scrolling on empty areas — we only preventDefault when we actually
   * consume the event so normal scroll in the lane area still works when
   * content overflows.
   */
  _onWheel(ev) {
    const dy = ev.deltaY;
    if (!dy) return;
    // Wheel over the sticky lane-head column should scroll the
    // track list vertically — Rich's report 2026-04-21: "should do
    // vertical scrolling, not timeline zoom" when the pointer is
    // over the labels. Hold Shift to override and zoom from the
    // lane-head (matches "modifier to scroll a long list" ask).
    const overHead = !!ev.target?.closest?.(".lane-head");
    if (overHead && !ev.shiftKey) {
      // Default: let the .scroll container's native vertical scroll
      // handle this. We don't preventDefault, so the browser
      // forwards the wheel to the scroll ancestor.
      return;
    }
    if (ev.altKey || ev.ctrlKey) {
      // Vertical (lane-height) zoom. Find the lane the pointer is over.
      const lane = ev.target?.closest?.(".lane");
      if (!lane) return;
      const trackId = this._trackIdForLane(lane);
      if (!trackId) return;
      ev.preventDefault();
      const cur = this._laneHeightFor(trackId);
      const step = Math.max(4, Math.round(cur * 0.12));
      const next = dy < 0
        ? Math.min(LANE_HEIGHT_MAX, cur + step)
        : Math.max(LANE_HEIGHT_MIN, cur - step);
      this._laneHeights = { ...this._laneHeights, [trackId]: next };
      this._saveLaneHeights();
      this.requestUpdate();
      // Give the canvas a beat to resize before repainting.
      requestAnimationFrame(() => this._repaintWaveforms());
      return;
    }
    // Temporal zoom — anchor around the pointer's current time so the
    // user's cursor stays over the same sample while the scale changes.
    //
    // Previously this set scrollLeft and let the browser clamp if the
    // target exceeded the content width. That clamp produced a visible
    // jump whenever the zoom operation moved the pointer's tick past
    // the content's right edge (Rich's "perfect until there's dead
    // space" bug). Fix: pre-compute the content width we'll need to
    // honor the anchor, bump `_zoomPadSec` to guarantee it, then set
    // the exact scrollLeft after layout settles.
    ev.preventDefault();
    const scroll = ev.currentTarget;
    const bounds = scroll.getBoundingClientRect();
    const pointerScreenX = ev.clientX - bounds.left;   // viewport-relative
    const pointerContentX = pointerScreenX + scroll.scrollLeft - HEAD_WIDTH;
    const t0 = pointerContentX / this._zoom;
    const factor = dy < 0 ? 1.18 : 1 / 1.18;
    const next = Math.max(2, Math.min(4000, Math.round(this._zoom * factor)));
    if (next === this._zoom) return;
    this._zoom = next;

    // Compute the target scrollLeft that keeps t0 under the pointer.
    const newPointerContentX = t0 * next;
    const targetScrollLeft = newPointerContentX - (pointerScreenX - HEAD_WIDTH);
    // Content width needed so the target is reachable: enough room for
    // scrollLeft + viewport (minus the sticky HEAD column). Also keep
    // a small buffer past the right edge so zoom-out near the tail
    // doesn't clamp.
    const viewportRest = scroll.clientWidth - HEAD_WIDTH;
    const neededContentPx = targetScrollLeft + viewportRest + 80;
    const neededSec = Math.max(0, neededContentPx / next);
    const baseSec = Math.max(30, (this._timeline?.length_samples || (this._sampleRate() * 30)) / this._sampleRate());
    if (neededSec > baseSec) {
      this._zoomPadSec = Math.max(this._zoomPadSec || 0, neededSec);
    } else {
      // Below base — no pad needed. Preserve any larger pad the user
      // built up by zooming out recently, though; it's harmless.
    }
    requestAnimationFrame(() => {
      scroll.scrollLeft = Math.max(0, targetScrollLeft);
    });
  }

  /** Which track does a given lane DOM element belong to? */
  _trackIdForLane(laneEl) {
    const tracks = this.session?.tracks || [];
    const lanes = this.renderRoot.querySelectorAll(".lane");
    const idx = Array.prototype.indexOf.call(lanes, laneEl);
    return idx >= 0 ? tracks[idx]?.id : null;
  }

  _regionContextMenu(ev, region) {
    ev.preventDefault();
    ev.stopPropagation();
    const items = [
      { heading: region.name || region.id },
      {
        label: region.muted ? "Unmute" : "Mute",
        icon: region.muted ? "speaker-wave" : "speaker-x-mark",
        shortcut: "M",
        action: () => window.__foyer?.ws?.send({
          type: "update_region",
          id: region.id,
          patch: { muted: !region.muted },
        }),
      },
    ];
    // Offer piano roll for any region on a MIDI track. Checking by
    // owning track kind (rather than `Array.isArray(region.notes)`)
    // keeps the option visible for empty regions and survives a
    // post-update envelope that hasn't carried notes yet.
    //
    // The label wording makes the region's state explicit at the
    // menu level so the user knows what they're about to open:
    //
    //   * no sequencer layout     → "Open piano roll…"
    //                                "Convert to beat sequencer…" (warns on open)
    //   * active sequencer        → "Open piano roll (read-only)…"
    //                                "Open beat sequencer…" (normal)
    //   * archived sequencer      → "Open piano roll…" (editable, MIDI is authoritative)
    //                                "Restore beat sequencer…" (warns → overwrites MIDI)
    if (this._isMidiRegion(region)) {
      const layout = region.foyer_sequencer;
      const active = !!(layout && layout.active !== false);
      const archived = !!(layout && layout.active === false);
      items.push({
        label: active ? "Open piano roll (read-only)…" : "Open piano roll…",
        icon: "sparkles",
        action: () => this._openMidiEditor(region),
      });
      items.push({
        label: active ? "Open beat sequencer…"
             : archived ? "Restore beat sequencer…"
             : "Convert to beat sequencer…",
        icon: "queue-list",
        action: () => this._openBeatSequencer(region),
      });
    }
    items.push({ separator: true });
    // Treat any context-click on a region as "this region is the
    // selection" if it isn't already part of the multi-selection. That
    // way the clipboard ops act on what the user clicked, not on a
    // stale prior selection invisible behind the menu.
    const inSelection = this._selectedRegionIds.has(region.id);
    const ensureSelection = () => {
      if (!inSelection) {
        this._selectedRegionIds.clear();
        this._selectedRegionIds.add(region.id);
        this.requestUpdate();
      }
    };
    const meta = this._metaChord();
    items.push({
      label: "Cut",
      icon: "scissors",
      shortcut: `${meta}+X`,
      action: () => { ensureSelection(); this.cutRegionSelection(); },
    });
    items.push({
      label: "Copy",
      icon: "document-duplicate",
      shortcut: `${meta}+C`,
      action: () => { ensureSelection(); this.copyRegionSelection(); },
    });
    items.push({
      label: "Paste at cursor",
      icon: "clipboard",
      shortcut: `${meta}+V`,
      disabled: !this.hasClipboard(),
      action: (ev) => {
        // The context-click already supplied a clientX/Y on the grid;
        // use it as the paste anchor instead of the last hovered grid
        // X (which is stale once the menu opens and intercepts pointer
        // events). Falls back to mouse-anchor → playhead chain.
        const clientX = ev?.clientX;
        if (Number.isFinite(clientX)) {
          const grid = this.renderRoot.querySelector(".grid");
          if (grid) {
            const r = grid.getBoundingClientRect();
            this._lastMouseGridX = clientX - r.left;
          }
        }
        this.pasteRegions({ at: "mouse" });
      },
    });
    items.push({
      label: "Paste at playhead",
      icon: "clipboard",
      shortcut: `${meta}+Shift+V`,
      disabled: !this.hasClipboard(),
      action: () => this.pasteRegions({ at: "playhead" }),
    });
    items.push({
      label: "Duplicate",
      icon: "plus",
      shortcut: `${meta}+D`,
      action: () => { ensureSelection(); this.duplicateRegionSelection(); },
    });
    items.push({ separator: true });
    items.push({
      label: "Delete region",
      icon: "trash",
      tone: "danger",
      shortcut: "Del",
      action: () => window.__foyer?.ws?.send({ type: "delete_region", id: region.id }),
    });
    showContextMenu(ev, items);
  }

  /** Platform meta-key glyph for menu hints. Mac → ⌘, else → Ctrl. */
  _metaChord() {
    return navigator.platform?.startsWith?.("Mac") ? "⌘" : "Ctrl";
  }

  _onRegionPointerDown(ev, region) {
    if (!region?.id) return;
    if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
      if (this._selectedRegionIds.has(region.id)) this._selectedRegionIds.delete(region.id);
      else this._selectedRegionIds.add(region.id);
      this._pendingDemoteRegionId = null;
      this._reconcileCutPending();
      this.requestUpdate();
      return;
    }
    // Unmodified click on a region that's ALREADY in the multi-selection:
    // keep the selection so the drag handler in `_startDrag` can move
    // the whole group. We arm a "demote" flag — if the user releases
    // without dragging, the click resolves to "select just this one"
    // (standard finder / DAW behavior). The flag is cleared inside
    // `_startDrag`'s pointermove once a real drag begins, and consumed
    // in pointerup if it was never cleared.
    if (this._selectedRegionIds.has(region.id) && this._selectedRegionIds.size > 1) {
      this._pendingDemoteRegionId = region.id;
      return;
    }
    // Otherwise (single-select replace, or click on an unselected region):
    // collapse to just this region.
    this._selectedRegionIds.clear();
    this._selectedRegionIds.add(region.id);
    this._pendingDemoteRegionId = null;
    this._reconcileCutPending();
    this.requestUpdate();
  }

  /**
   * Drop cut-pending state for any region that's no longer part of
   * the click-selection. If that empties the cut-pending set, also
   * abandon the clipboard — the user's "next" cut transaction starts
   * fresh, and a stale cut clipboard would otherwise delete random
   * regions on a later paste.
   */
  _reconcileCutPending() {
    if (!this._cutPending) {
      this._cutPending = new Map();
      return;
    }
    if (this._cutPending.size === 0) return;
    let changed = false;
    for (const id of [...this._cutPending.keys()]) {
      if (!this._selectedRegionIds.has(id)) {
        this._cutPending.delete(id);
        changed = true;
      }
    }
    if (changed && this._cutPending.size === 0
        && this._regionClipboard?.mode === "cut") {
      // The user navigated away from every cut-pending region; treat
      // that as cancelling the cut. Without this, the next paste would
      // try to delete regions the user no longer cares about.
      this._regionClipboard = null;
    }
  }

  _isMidiRegion(region) {
    if (Array.isArray(region?.notes)) return true;
    const tracks = this.session?.tracks || [];
    const track = tracks.find((t) => t.id === region?.track_id);
    return track?.kind === "midi";
  }

  _openMidiEditor(region) {
    Promise.all([
      import("./midi-editor.js"),
      import("foyer-ui-core/widgets/window.js"),
    ]).then(([, winMod]) => {
      const editor = document.createElement("foyer-midi-editor");
      editor.notes      = Array.isArray(region?.notes) ? region.notes : [];
      editor.regionId   = region?.id || "";
      editor.regionName = region?.name || "";
      // If the region is sequencer-owned (active layout), the
      // piano roll boots in read-only mode + shows a banner. The
      // banner's "Convert to MIDI" button flips active=false,
      // after which the next regions-updated echo reads through
      // to editor.readOnly = false and unlocks editing.
      editor.sequencerLayout = region?.foyer_sequencer || null;
      editor.readOnly = !!(region?.foyer_sequencer && region.foyer_sequencer.active !== false);
      const trackId = region?.track_id;
      // Propagate to the editor so its side-strip (instruments +
      // patches) can show the right track's state. PLAN 154.
      editor.trackId = trackId || "";
      // Keep the editor in sync with the live region list — when the
      // backend echoes a RegionUpdated for this region, push the fresh
      // note list in. Without this the editor would show the snapshot
      // from open-time and drift as the user edits.
      const onUpdate = () => {
        const list = this._regionsByTrack[trackId] || [];
        const fresh = list.find((r) => r.id === editor.regionId);
        if (fresh) {
          editor.notes = Array.isArray(fresh.notes) ? fresh.notes : [];
          editor.regionName = fresh.name || editor.regionName;
          editor.sequencerLayout = fresh.foyer_sequencer || null;
          editor.readOnly = !!(fresh.foyer_sequencer && fresh.foyer_sequencer.active !== false);
        }
      };
      this.addEventListener("foyer:regions-updated", onUpdate);
      const close = winMod.openWindow({
        title: `MIDI — ${region?.name || region?.id || "region"}`,
        icon: "sparkles",
        storageKey: "midi-editor",
        content: editor,
        width: 1040,
        height: 680,
        persist: { kind: "midi-editor", id: "midi-editor", props: { regionId: region?.id } },
        // Reusing an already-open MIDI editor: retarget the live
        // editor element to the newly-clicked region instead of
        // letting openWindow swap nodes (which would orphan the
        // editor's internal state — selection, scroll, undo). The
        // newly-created `editor` arg is discarded.
        onReuse: (existingEditor) => {
          if (!existingEditor) return;
          existingEditor.notes = editor.notes;
          existingEditor.regionId = editor.regionId;
          existingEditor.regionName = editor.regionName;
          existingEditor.sequencerLayout = editor.sequencerLayout;
          existingEditor.readOnly = editor.readOnly;
          existingEditor.trackId = editor.trackId;
        },
      });
      // foyer-window dispatches `close` when the user clicks X /
      // presses Escape / clicks the backdrop. Clean up our listener
      // then so we don't keep stale closures alive forever.
      const win = editor.closest("foyer-window");
      const unsub = () => this.removeEventListener("foyer:regions-updated", onUpdate);
      win?.addEventListener("close", unsub, { once: true });
      // (We also return the `close` fn for parity with other openWindow
      // callers, though none of timeline's menu items need it.)
      void close;
    });
  }

  _openRegionEditor(region) {
    if (!region) return;
    const track = (this.session?.tracks || []).find((t) => t.id === region.track_id);
    if (!track) return;
    if (track.kind === "midi") {
      if (region?.foyer_sequencer && region.foyer_sequencer.active !== false) this._openBeatSequencer(region);
      else this._openMidiEditor(region);
    }
  }

  _openMidiEditorForTrack(track) {
    if (!track) return;
    const list = this._regionsByTrack[track.id] || [];
    // Prefer the first region so the editor has something to show;
    // fall back to a synthetic empty region rooted at zero so the
    // piano roll still opens with its empty-state messaging.
    const region = list[0] || {
      id: `__empty.${track.id}`,
      track_id: track.id,
      name: track.name,
      notes: [],
    };
    this._openMidiEditor(region);
  }

  _startLaneResize(ev, trackId) {
    ev.preventDefault();
    ev.stopPropagation();
    const start = ev.clientY;
    const tracks = this.session?.tracks || [];
    // Resize-target picker, in priority order:
    //   1. Shift held → resize EVERY lane (uniform pass).
    //   2. Multi-track selection that includes the dragged track → resize
    //      every selected track. Mirrors the common DAW expectation that
    //      bulk-edit operations apply to the selection.
    //   3. Otherwise → resize just the dragged lane.
    const sel = window.__foyer?.store?.state?.selectedTrackIds;
    const dragInSelection = sel && sel.size > 1 && sel.has(trackId);
    const resizeAll = ev.shiftKey;
    let targetIds;
    if (resizeAll) {
      targetIds = tracks.map((t) => t.id);
    } else if (dragInSelection) {
      targetIds = tracks.filter((t) => sel.has(t.id)).map((t) => t.id);
    } else {
      targetIds = [trackId];
    }
    const origHeights = Object.fromEntries(
      targetIds.map((id) => [id, this._laneHeightFor(id)]),
    );
    const move = (e) => {
      const dy = e.clientY - start;
      const next = { ...this._laneHeights };
      for (const [id, h0] of Object.entries(origHeights)) {
        next[id] = Math.max(LANE_HEIGHT_MIN, Math.min(LANE_HEIGHT_MAX, h0 + dy));
      }
      this._laneHeights = next;
      this.requestUpdate();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this._saveLaneHeights();
      this._repaintWaveforms();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  _repaintWaveforms() {
    // Push peaks into every `<foyer-waveform-gl>` for the currently
    // rendered regions. The viz component owns its own GL state + AA
    // + clip markers — we just keep its .peaks prop in sync with what
    // the cache has at the current zoom tier.
    //
    // `setPeaks` is a dedicated setter on the component that forces a
    // re-upload + redraw even when the object reference hasn't changed
    // (Lit's default hasChanged would skip it — a cache hit returns
    // the same object, and nothing would repaint).
    const vizEls = this.renderRoot.querySelectorAll(".region foyer-waveform-gl");
    const spp = this._samplesPerPx();
    for (const el of vizEls) {
      const id = el.dataset.id;
      if (!id) continue;
      const peaks = this._wfCache?.ensure(id, spp);
      if (peaks) {
        if (typeof el.setPeaks === "function") el.setPeaks(peaks);
        else el.peaks = peaks;
      }
    }
  }

  /** Convert a clientX into a sample position in the timeline. */
  _samplesAtX(clientX, rulerEl) {
    const rect = rulerEl.getBoundingClientRect();
    const x = clientX - rect.left - HEAD_WIDTH;
    const sr = this._sampleRate();
    return Math.max(0, Math.round((x / this._zoom) * sr));
  }

  /**
   * Wheel over the ruler scrolls horizontally instead of zooming — the
   * ruler is a navigation surface, the waveforms underneath are for zoom.
   * Stop propagation so the outer `.scroll` wheel handler doesn't zoom.
   */
  _onRulerWheel(ev) {
    const scroll = this.renderRoot.querySelector(".scroll");
    if (!scroll) return;
    ev.preventDefault();
    ev.stopPropagation();
    const dx = ev.deltaX || 0;
    const dy = ev.deltaY || 0;
    scroll.scrollLeft += (Math.abs(dx) > Math.abs(dy) ? dx : dy);
  }

  /**
   * Unified pointer-down on the ruler:
   *   · button 0 (left)      — seek-or-select. If the pointer moves >2px
   *                            before release, it becomes a selection
   *                            range drag; otherwise it's a simple click
   *                            seek (and clears any prior selection).
   *   · button 1 (middle)    — pan the view horizontally.
   *   · button 2 (right)     — pan the view horizontally.
   *
   * The two-intent left-click — "click to seek, drag to select" — is the
   * standard ruler gesture in most DAWs. The 2px threshold is just
   * enough to separate a real drag from hand shake on a click.
   */
  _onRulerPointerDown(ev) {
    if (ev.button === 1 || ev.button === 2) {
      this._startRulerPan(ev);
      return;
    }
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();

    const target = ev.currentTarget;
    const startClientX = ev.clientX;
    const startSamples = this._samplesAtX(ev.clientX, target);
    let moved = false;
    try { target.setPointerCapture?.(ev.pointerId); } catch {}

    const move = (e) => {
      const dx = e.clientX - startClientX;
      if (!moved && Math.abs(dx) > 2) {
        moved = true;
        // Crossing the threshold: we're now in selection mode. Drop the
        // seek-on-release intent by clearing the playhead-follow state.
      }
      if (moved) {
        const endSamples = this._samplesAtX(e.clientX, target);
        this._selection = { startSamples, endSamples };
      }
    };
    const up = (e) => {
      try { target.releasePointerCapture?.(ev.pointerId); } catch {}
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!moved) {
        // Simple click — seek and clear any prior selection. If a
        // return-on-stop lock is still running, cancel it so the user's
        // explicit seek wins.
        this._selection = null;
        this._selectedRegionIds.clear();
        window.__foyer?.store?.releaseTransportPositionLock?.();
        const samples = this._samplesAtX(e.clientX, target);
        this._playheadSamples = samples;
        window.__foyer?.ws?.controlSet("transport.position", samples);
        return;
      }
      // Finalize selection. If the user dragged a single point (e.g.
      // mouse jitter), drop it to avoid a zero-width band.
      if (this._selection) {
        const { startSamples: a, endSamples: b } = this._selection;
        if (Math.abs(a - b) < 1) {
          this._selection = null;
        } else {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          this.dispatchEvent(new CustomEvent("timeline-selection", {
            detail: { startSamples: lo, endSamples: hi },
            bubbles: true, composed: true,
          }));
        }
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  /** Middle/right-button pan — drag the ruler to scroll the view. */
  _startRulerPan(ev) {
    const scroll = this.renderRoot.querySelector(".scroll");
    if (!scroll) return;
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const origScroll = scroll.scrollLeft;
    const target = ev.currentTarget;
    try { target.setPointerCapture?.(ev.pointerId); } catch {}
    const prevCursor = target.style.cursor;
    target.style.cursor = "grabbing";
    const move = (e) => {
      scroll.scrollLeft = origScroll - (e.clientX - startX);
    };
    const up = () => {
      target.style.cursor = prevCursor;
      try { target.releasePointerCapture?.(ev.pointerId); } catch {}
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  _startDrag(ev, region, mode) {
    ev.preventDefault();
    ev.stopPropagation();
    const isMulti = this._selectedRegionIds.has(region.id) && this._selectedRegionIds.size > 1;
    const movingIds = isMulti && mode === "move"
      ? [...this._selectedRegionIds]
      : [region.id];
    const els = [];
    for (const id of movingIds) {
      const el = this.renderRoot.querySelector(`.region[data-id="${id}"]`);
      if (el) { el.classList.add("dragging"); els.push(el); }
    }
    const sr = this._sampleRate();
    const startX = ev.clientX;
    const pxPerSec = this._zoom;

    const origs = new Map();
    for (const id of movingIds) {
      const r = this._regionForId(id);
      if (r) origs.set(id, {
        start: Number(r.start_samples) || 0,
        len: Number(r.length_samples) || 0,
        offset: Number(r.source_offset_samples || 0),
      });
    }

    // For resize-left we freeze the waveform at its pre-drag pixel
    // resolution (`origPeaksPx`) and slide it under the region's
    // `overflow:hidden` clip — so as the user trims, the waveform
    // doesn't compress horizontally (which read as "time-stretch")
    // but instead the trimmed portion crops off the left. Extending
    // the start (only possible when `o.offset > 0`) shifts the peaks
    // right and surfaces a striped placeholder in the gap, since we
    // don't have peaks for the source span we just exposed. The
    // freeze is reverted in `up` so the post-RegionUpdated peak
    // refetch repaints normally. Initialized on first real drag motion
    // when the mode is left-trim (not stretch); see `move` below.
    let resizeLeftPreview = null;

    // During the drag we only update the local preview — no
    // `update_region` commands are sent until pointer-up. Why: each
    // server-side `update_region` opens a reversible-command commit
    // (`begin_reversible_command` + `StatefulDiffCommand` +
    // `commit_reversible_command`), and the previous 80 ms throttle
    // produced 60+ undo entries during a typical multi-second drag.
    // On a heavily-loaded shim that pile-up timed out and crashed
    // Ardour. One undo entry per drag is also what every native DAW
    // does. (Rich, 2026-04-26.)
    // Track whether the pointer actually moved enough to count as a
    // drag. `_onRegionPointerDown` armed `_pendingDemoteRegionId` if
    // the user clicked on an already-multi-selected region; if no
    // real drag happens we treat the click as "demote to single".
    // 3 px threshold matches typical OS drag-start hysteresis.
    let didDrag = false;
    const DRAG_PX_THRESHOLD = 3;
    const teardownLeftTrimPreview = () => {
      if (!resizeLeftPreview) return;
      resizeLeftPreview.wfEl.unfreezeViewport();
      resizeLeftPreview.placeholder.remove();
      resizeLeftPreview = null;
    };
    const ensureLeftTrimPreview = () => {
      if (resizeLeftPreview || mode !== "resize-left") return;
      const o = origs.get(region.id);
      const regionEl = this.renderRoot.querySelector(`.region[data-id="${region.id}"]`);
      const wfEl = regionEl?.querySelector("foyer-waveform-gl");
      if (o && regionEl && wfEl) {
        const origPeaksPx = (o.len / sr) * pxPerSec;
        wfEl.freezeViewport(origPeaksPx);
        const placeholder = document.createElement("div");
        placeholder.className = "resize-preview-placeholder";
        placeholder.style.left = "0px";
        placeholder.style.width = "0px";
        placeholder.style.display = "none";
        regionEl.appendChild(placeholder);
        resizeLeftPreview = { wfEl, placeholder, origPeaksPx };
      }
    };
    const move = (e) => {
      const dxPx = e.clientX - startX;
      const dxSamples = Math.round((dxPx / pxPerSec) * sr);
      if (!didDrag && Math.abs(dxPx) >= DRAG_PX_THRESHOLD) {
        didDrag = true;
        // Real drag started — keep the multi-selection; demote is off.
        this._pendingDemoteRegionId = null;
      }
      const edgeResize = mode === "resize-left" || mode === "resize-right";
      const stretchResize =
        didDrag && edgeResize && !!(e.ctrlKey || e.metaKey);
      if (didDrag && mode === "resize-left") {
        if (stretchResize) teardownLeftTrimPreview();
        else ensureLeftTrimPreview();
      }
      for (const el of els) el.classList.toggle("stretch-active", stretchResize);
      for (const id of movingIds) {
        const o = origs.get(id);
        if (!o) continue;
        const r = this._regionForId(id);
        if (!r) continue;
        const preview = { ...r };
        if (mode === "move") {
          // Allow regions to move before the timeline's zero mark.
          // Schema's `start_samples` is signed (i64) — Ardour displays
          // the lozenge with its left edge in the pre-roll area, and
          // playback starts the source `-start_samples` in.
          preview.start_samples = o.start + dxSamples;
        } else if (mode === "resize-right") {
          preview.length_samples = Math.max(4800, o.len + dxSamples);
        } else if (mode === "resize-left") {
          if (stretchResize) {
            const minDx = -o.offset;
            const maxDx = o.len - 4_800;
            const dx = Math.max(minDx, Math.min(maxDx, dxSamples));
            preview.start_samples = o.start + dx;
            preview.length_samples = o.len - dx;
            preview.source_offset_samples = o.offset;
          } else {
          // Trim from the start: advance the source-media offset by
          // the same amount the timeline edge moves, so the lozenge
          // shrinks AND the underlying content slides forward (rather
          // than the whole region translating, which is what the
          // earlier code did). Clamp:
          //   * dxSamples >= -o.offset  → can't trim past the
          //     source's actual start
          //   * newLen >= 4800          → can't shrink to nothing
          // The right edge stays anchored at o.start + o.len.
          const minDx = -o.offset;            // most we can trim leftward
          const maxDx = o.len - 4_800;         // most we can trim rightward
          const dx = Math.max(minDx, Math.min(maxDx, dxSamples));
          preview.start_samples = o.start + dx;
          preview.length_samples = o.len - dx;
          preview.source_offset_samples = o.offset + dx;
          // Slide the frozen waveform under the region's clip so
          // peaks stay at fixed pixel-per-sample. dx > 0 (trim):
          // peaks shift left and crop. dx < 0 (extend): peaks shift
          // right and the new gap gets a striped placeholder.
          if (resizeLeftPreview && id === region.id) {
            const dxPx = (dx / sr) * pxPerSec;
            const wf = resizeLeftPreview.wfEl;
            const ph = resizeLeftPreview.placeholder;
            wf.style.left = `${-dxPx}px`;
            wf.style.right = "auto";
            wf.style.width = `${resizeLeftPreview.origPeaksPx}px`;
            if (dx < 0) {
              ph.style.display = "";
              ph.style.left = "0px";
              ph.style.width = `${-dxPx}px`;
            } else {
              ph.style.display = "none";
            }
          }
          }
        }
        this._patchRegionLocally(preview);
      }
    };
    const up = (upEv) => {
      for (const el of els) {
        el.classList.remove("dragging");
        el.classList.remove("stretch-active");
      }
      // Drop the waveform freeze + placeholder. The post-commit
      // RegionUpdated event will invalidate the wf cache and the
      // next ensure() call refetches peaks for the new offset+length.
      teardownLeftTrimPreview();
      const edgeResize = mode === "resize-left" || mode === "resize-right";
      const commitStretch =
        didDrag && edgeResize && !!(upEv.ctrlKey || upEv.metaKey);
      // Click without drag on a member of a multi-selection collapses
      // the selection to just that member — standard "click is a
      // single-select; drag preserves multi" behavior.
      if (!didDrag && this._pendingDemoteRegionId) {
        const demoteId = this._pendingDemoteRegionId;
        this._pendingDemoteRegionId = null;
        this._selectedRegionIds.clear();
        this._selectedRegionIds.add(demoteId);
        this._reconcileCutPending();
        this.requestUpdate();
      }
      // Single committed update per region, with the final position +
      // length (+ source offset for left-trim drags). The shim wraps
      // each in a reversible command, so the user gets one undo entry
      // per drag.
      for (const id of movingIds) {
        const r = this._regionForId(id);
        if (!r) continue;
        const o = origs.get(id);
        if (!o) continue;
        if (commitStretch) {
          if (
            r.start_samples === o.start
            && r.length_samples === o.len
          ) continue;
          window.__foyer?.ws?.send({
            type: "stretch_region",
            id: r.id,
            new_start_samples: r.start_samples,
            new_length_samples: r.length_samples,
            anchor: mode === "resize-left" ? "end" : "start",
            preserve_pitch: !!upEv.shiftKey,
          });
          continue;
        }
        const newOffset = Number(r.source_offset_samples || 0);
        const offsetMoved = newOffset !== o.offset;
        // Skip the round-trip if nothing actually moved (e.g. the
        // user click-dragged but landed back at the start).
        if (
          r.start_samples === o.start
          && r.length_samples === o.len
          && !offsetMoved
        ) continue;
        const patch = {
          start_samples: r.start_samples,
          length_samples: r.length_samples,
        };
        if (offsetMoved) patch.source_offset_samples = newOffset;
        window.__foyer?.ws?.send({
          type: "update_region",
          id: r.id,
          patch,
        });
      }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  _regionForId(id) {
    for (const list of Object.values(this._regionsByTrack)) {
      const f = list.find(r => r.id === id);
      if (f) return f;
    }
    return null;
  }

  _patchRegionLocally(region) {
    const list = this._regionsByTrack[region.track_id];
    if (!list) return;
    const idx = list.findIndex(r => r.id === region.id);
    if (idx < 0) return;
    const copy = list.slice();
    copy[idx] = region;
    this._regionsByTrack = { ...this._regionsByTrack, [region.track_id]: copy };
  }

}
customElements.define("foyer-timeline-view", TimelineView);
