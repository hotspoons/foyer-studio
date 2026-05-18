// Linear editor. Each track is a horizontal lane; regions are laid at their
// sample positions with waveform peaks rendered inside each region.
//
// Features:
//   - Zoom slider (2..4000 px/s) — 4 k px/s = sample-level at 48 kHz
//   - Playhead rendered from transport.position, click ruler to seek
//   - Major (every 5s) + minor (every 1s) grid lines
//   - Drag region body to move; drag edges to resize — optimistic + UpdateRegion
//   - Ctrl/Cmd + edge drag: time-stretch via StretchRegion (Ardour: MidiStretch /
//     RBStretch). Overlay: "elastic" with no modifier (pitch-preserving); "tape" while
//     Shift is held (varispeed). `preserve_pitch` is the inverse of Shift on pointer-up.
//     MIDI ignores preserve_pitch.
//   - S: split selected regions at the hover cursor line when the pointer
//        is over the grid, else at the playhead (SplitRegion)
//   - Waveforms via WaveformCache; resolution picked from current zoom level
//
// All sample-math uses `sample_rate` from the TimelineMeta payload so
// different sessions with different rates render correctly.

import { LitElement, html, css, svg } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { WaveformCache } from "foyer-ui-core/layout/waveform-cache.js";
import "foyer-ui-core/viz/waveform-gl.js";
import "./midi-strip.js";
import "./automation-lane.js";
// `t` is shadowed all over this file as the per-track lambda param —
// import the translator under `tr` to avoid the collision.
import { t as tr, onLocaleChange } from "/core/i18n.js";
import "foyer-ui-core/viz/viz-picker.js";
import { getVizPref, getVizPrefs, setVizPref } from "foyer-ui-core/viz/viz-settings.js";
import { resolveWheel, zoomFactorFromWheel } from "foyer-core/keymap/index.js";
import {
  timelineStyles,
  RULER_HEIGHT,
  HEAD_WIDTH,
  EDGE_GRAB,
} from "./timeline-view.styles.js";
import { showContextMenu } from "foyer-ui-core/widgets/context-menu.js";
import { toast } from "foyer-ui-core/widgets/toast.js";
import { promptText } from "foyer-ui-core/widgets/prompt-modal.js";
import { icon } from "foyer-ui-core/icons.js";
import { sessionScopedKey } from "foyer-core/session-scope.js";

const LANE_HEIGHT_DEFAULT = 52;
const LANE_HEIGHT_MIN = 28;
const LANE_HEIGHT_MAX = 240;
// Sample-level detail at extreme zoom requires finer waveform tiers; see
// WaveformCache / waveform-gl for decoding resolution.

const LANE_HEIGHT_KEY = "foyer.timeline.lane-heights.v1";
const SNAP_PREFS_KEY = "foyer.timeline.snap.v1";

/** Beat subdivisions for quant grid / snap (value = denominator slots per bar in 4/4 terms). */
const QUANT_SUBDIV_OPTIONS = [
  { v: 4, label: "1/4" },
  { v: 8, label: "1/8" },
  { v: 16, label: "1/16" },
  { v: 32, label: "1/32" },
  { v: 6, label: "1/8T" },
  { v: 12, label: "1/16T" },
];

function defaultSnapPrefs() {
  return {
    grid: true,
    regionEdges: true,
    markers: true,
    playhead: false,
  };
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
    /** @type {{ grid: boolean, regionEdges: boolean, markers: boolean, playhead: boolean }} */
    _snapPrefs: { state: true, type: Object },
    /** Drop-target preview while a cross-track region move is in
     *  flight. `null` when no drag is active or the cursor's lane
     *  matches the source. When set, the destination lane renders
     *  a dashed outline at the preview position so the user sees
     *  WHERE the region will land before releasing. Shape:
     *    { destTrackId, regions: [{ id, startSamples, lengthSamples }] }
     *  Multiple entries support group / multi-selection drags. */
    _crossTrackGhost: { state: true, type: Object },
    /** Drop-target preview while an audio-pool drag is over a lane.
     *  Same visual shape as `_crossTrackGhost` — single region in
     *  flight, sized to the pool source's length. Shape:
     *    { destTrackId, startSamples, lengthSamples, name } */
    _poolDropGhost: { state: true, type: Object },
    /** When set, renders a thin event-density strip across the named
     *  track's lane. Hidden in normal interactive use; the headless
     *  `visualize.event_heatmap` MCP call flips it on through
     *  `setEventHeatmap(trackId)` so the screenshot has a focused
     *  "events on track X over time" presentation. `null` = no
     *  overlay (default). */
    _eventHeatmapTrackId: { state: true, type: String },
    /** Live mirror of `.scroll.scrollLeft` and `.scroll.clientWidth`
     *  for the overview-strip's viewport rectangle. Updated from a
     *  `scroll` listener + a one-shot read in `firstUpdated`. */
    _scrollX: { state: true, type: Number },
    _scrollViewW: { state: true, type: Number },
    /** In-flight strip height during a top-edge resize. Persisted
     *  to viz prefs on drag end (overviewStripHeight). */
    _overviewHeight: { state: true, type: Number },
  };

  static styles = timelineStyles;

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
    // Track id whose event-density strip is currently overlaid.
    // Set via `setEventHeatmap(trackId)` from the headless renderer;
    // null in normal interactive use.
    this._eventHeatmapTrackId = null;
    // Overview strip — live scroll mirror + persisted height.
    this._scrollX = 0;
    this._scrollViewW = 1;
    this._overviewHeight = Number.isFinite(getVizPref("overviewStripHeight"))
      ? getVizPref("overviewStripHeight")
      : 90;
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
    // Quant overlay defaults on (`quantGridOn`); time grid defaults off.
    // Visibility (`_quantOn`) is mirrored to the viz prefs
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
    this._snapPrefs = this._loadSnapPrefs();
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
    // Keyboard nav lives on the host so the keybinds.js global
    // handler can gate region-nudge on "is the timeline currently
    // focused?" via the standard `:focus-within` / `composedPath`
    // checks instead of guessing from selection state. `tabindex=-1`
    // would suppress tab-into; 0 keeps it in the natural tab order
    // so a keyboard-only user can land here without a mouse click.
    if (!this.hasAttribute("tabindex")) this.setAttribute("tabindex", "0");
    this.setAttribute("data-foyer-focus-domain", "timeline");
    this._onHostKey = (ev) => this._onTimelineKey(ev);
    this.addEventListener("keydown", this._onHostKey);
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
    // rAF tick so the audio-derived playhead animates smoothly
    // between control updates while transport is playing. Cheap
    // (one repaint per frame, gated below); skipped when nothing
    // would change visually.
    const playheadTick = () => {
      this._playheadRaf = requestAnimationFrame(playheadTick);
      const playing = !!window.__foyer?.store?.state?.controls?.get("transport.playing");
      const haveAudio = !!window.__foyer?.audioClock?.snapshot()?.hasAudioClock;
      if (playing && haveAudio) this.requestUpdate();
    };
    this._playheadRaf = requestAnimationFrame(playheadTick);
    // Re-render on locale change so context-menu labels, tooltips,
    // and the lane-head chrome flip languages live.
    this._i18nDispose = onLocaleChange(() => this.requestUpdate());
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

  /// Host-level keyboard navigation. Only fires when the timeline (or
  /// something inside it) actually holds focus — `keybinds.js`'s global
  /// region-nudge yields to this handler so a left/right press while
  /// the mixer / agent panel is focused doesn't accidentally move the
  /// user's regions.
  ///
  /// Map (when the timeline is focused):
  ///   ArrowUp / ArrowDown        — move track selection (channel nav)
  ///   Shift+Up/Down              — extend selection to that track
  ///   Enter                      — open the focused track's editor
  ///   Ctrl/Cmd+Enter             — toggle the focused track in the
  ///                                multi-selection (additive)
  ///   ArrowLeft / ArrowRight     — region nudge (delegates to
  ///                                `nudgeSelectedRegions`); identical
  ///                                modifier semantics to keybinds.js
  ///                                so a user who started with the
  ///                                global binding doesn't relearn it
  _onTimelineKey(ev) {
    if (ev.defaultPrevented) return;
    if (ev.altKey && (ev.key === "ArrowLeft" || ev.key === "ArrowRight"
                       || ev.key === "ArrowUp" || ev.key === "ArrowDown")) {
      // Alt+arrow is the tile-focus chord — leave it alone.
      return;
    }
    const tracks = window.__foyer?.store?.state?.session?.tracks || [];
    const tids = tracks.map((t) => t.id);
    if (!tids.length) return;
    const store = window.__foyer?.store;
    const current = Array.from(store?.state?.selectedTrackIds || []);
    const anchor = current[current.length - 1] || tids[0];
    const idx = Math.max(0, tids.indexOf(anchor));
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      const next = ev.key === "ArrowDown"
        ? Math.min(tids.length - 1, idx + 1)
        : Math.max(0, idx - 1);
      if (tids[next] === anchor) return;
      ev.preventDefault();
      ev.stopPropagation();
      store?.selectTrack(tids[next], ev.shiftKey ? "extend" : "replace");
      // Scroll the new selection into view so the user can see what
      // their arrow just landed on.
      this._scrollTrackIntoView(tids[next]);
      return;
    }
    if (ev.key === "Enter") {
      if (!current.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.ctrlKey || ev.metaKey) {
        store?.selectTrack(anchor, "toggle");
      } else {
        import("./track-editor-modal.js").then((m) => m.openTrackEditor(anchor));
      }
      return;
    }
    // ArrowLeft / ArrowRight: region nudge. We re-implement the same
    // behaviour `keybinds.js` had as a global capture, but scoped to
    // "timeline is actually focused". Without this any random app
    // surface (mixer toolbar, agent panel, sessions list) would still
    // receive ←/→ and nudge regions.
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      if (!this._selectedRegionIds || !this._selectedRegionIds.size) return;
      const fine = !!(ev.ctrlKey || ev.metaKey);
      const beat = !!ev.shiftKey && !fine;
      const dir = ev.key === "ArrowLeft" ? "left" : "right";
      if (typeof this.nudgeSelectedRegions === "function"
          && this.nudgeSelectedRegions(dir, { fine, beat })) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    }
  }

  /// Scroll the track row for `trackId` into the visible portion of
  /// the timeline scroller so keyboard navigation doesn't strand the
  /// user looking at the wrong track. Best-effort — falls back to a
  /// no-op when the lane element isn't in the DOM yet (e.g. just
  /// after the track was created and lit hasn't rendered).
  _scrollTrackIntoView(trackId) {
    if (!trackId) return;
    const scroller = this.renderRoot?.querySelector?.(".scroll");
    if (!scroller) return;
    const lane = this.renderRoot?.querySelector?.(`[data-track-id="${CSS.escape(trackId)}"]`);
    if (!lane) return;
    const laneRect = lane.getBoundingClientRect();
    const scrollRect = scroller.getBoundingClientRect();
    if (laneRect.top < scrollRect.top) {
      scroller.scrollTop -= scrollRect.top - laneRect.top + 8;
    } else if (laneRect.bottom > scrollRect.bottom) {
      scroller.scrollTop += laneRect.bottom - scrollRect.bottom + 8;
    }
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
    if (this._onHostKey) this.removeEventListener("keydown", this._onHostKey);
    if (this._i18nDispose) { this._i18nDispose(); this._i18nDispose = null; }
    if (this._onVizPrefsChanged) window.removeEventListener("foyer:viz-prefs-changed", this._onVizPrefsChanged);
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    window.__foyer?.ws?.removeEventListener("transport_seek_request", this._seekHandler);
    this._wfCache?.removeEventListener("update", this._onWfUpdate);
    this._wfCache?.dispose();
    window.__foyer?.store?.removeEventListener("control", this._onStoreControl);
    window.__foyer?.store?.removeEventListener("selection", this._onStoreSelection);
    if (this._playheadRaf) {
      cancelAnimationFrame(this._playheadRaf);
      this._playheadRaf = null;
    }
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
        label: tr("Open piano roll…"),
        icon: "sparkles",
        action: () => this._openMidiEditorForTrack(track),
      });
      items.push({
        label: tr("Open beat sequencer…"),
        icon: "queue-list",
        action: () => this._openBeatSequencerForTrack(track),
      });
      items.push({
        label: tr("Add region at playhead"),
        icon: "plus",
        action: () => this._addRegionAtPlayhead(track),
      });
      items.push({
        label: tr("MIDI patches & banks…"),
        icon: "queue-list",
        action: () => this._openMidiManager(track),
      });
      items.push({ separator: true });
    }
    items.push({
      label: tr("Track editor…"),
      icon: "adjustments-horizontal",
      action: () => import("./track-editor-modal.js")
                      .then((m) => m.openTrackEditor(track.id)),
    });
    items.push({
      label: tr("Automation editor…"),
      icon: "chart-bar",
      title: tr("Open the full-screen automation editor for this track."),
      action: () => this._openAutomationModal(track.id),
    });
    items.push({
      label: tr("Move track up"),
      icon: "arrow-up",
      action: () => this._moveTrackBy(track.id, -1),
    });
    items.push({
      label: tr("Move track down"),
      icon: "arrow-down",
      action: () => this._moveTrackBy(track.id, 1),
    });
    items.push({
      label: tr("Delete track…"),
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
    if (!track) return;
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
    const meta = this._metaChord();
    const items = [
      { heading: `${track.name} · ${(atSamples / sr).toFixed(2)}s` },
    ];
    // Per-region creation is MIDI-only today (audio needs a source
    // picker we don't have yet). Show the entries up top so the
    // typical "click empty space, add a region" workflow stays
    // one-click. Audio tracks get straight to paste options.
    if (track.kind === "midi") {
      items.push({
        label: tr("Add region here"),
        icon: "plus",
        action: () => this._createRegionAt(track, atSamples),
      });
      items.push({
        label: tr("Add region at playhead"),
        icon: "play",
        action: () => this._addRegionAtPlayhead(track),
      });
      items.push({ separator: true });
    }
    // Paste lands the clipboard contents on THIS lane at the
    // right-click point. We stash the anchor + dest track so
    // `pasteRegions({at:"mouse"})` lines up with the right-click,
    // not with the last hover position the timeline tracked. The
    // kind-compat check inside pasteRegions toasts on mismatch.
    const grid = this.renderRoot.querySelector(".grid");
    const captureAnchor = () => {
      if (grid) {
        const r = grid.getBoundingClientRect();
        this._lastMouseGridX = ev.clientX - r.left;
      }
      this._lastMouseClientY = ev.clientY;
    };
    items.push({
      label: tr("Paste here"),
      icon: "clipboard",
      shortcut: `${meta}+V`,
      disabled: !this.hasClipboard(),
      title: this.hasClipboard()
        ? tr("Paste clipboard contents at %{seconds}s on %{track}.", {
            seconds: (atSamples / sr).toFixed(2),
            track: track.name,
          })
        : tr("Clipboard is empty — copy or cut a region first."),
      action: () => {
        captureAnchor();
        // Explicit dest so cut→paste between same-kind tracks lands
        // on THIS lane even though `at:"mouse"` would normally pick
        // it up from `_trackAtMouseY` (defensive against any stale
        // hover state).
        this.pasteRegions({ at: "mouse", targetTrackId: track.id });
      },
    });
    items.push({
      label: tr("Paste at playhead"),
      icon: "clipboard",
      shortcut: `${meta}+Shift+V`,
      disabled: !this.hasClipboard(),
      action: () => {
        // `at:"playhead"` by itself drops the destination resolution
        // and falls back to the clip's source track — so a cut from
        // Track A and a right-click on Track B's empty space used to
        // paste back into Track A. Pass the right-clicked lane
        // explicitly so it lands here.
        this.pasteRegions({ at: "playhead", targetTrackId: track.id });
      },
    });
    showContextMenu(ev, items);
  }

  /** Does this DataTransfer carry an audio-pool drag? Safe to call
   *  during dragover (only reads `types`, which is the only thing
   *  most browsers expose during the drag — `getData()` returns ""
   *  until drop for security reasons). */
  _isPoolDrag(dt) {
    if (!dt) return false;
    const types = Array.from(dt.types || []);
    return types.includes("application/x-foyer-audio-pool-source");
  }

  /** Parse the audio-pool drag payload. ONLY callable from a `drop`
   *  handler — `getData()` is gated until then. Returns the parsed
   *  source row or null. */
  _readPoolDragPayload(dt) {
    if (!dt) return null;
    try {
      const raw = dt.getData("application/x-foyer-audio-pool-source");
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  /** Whether this lane can accept a pool-row drop. Pool sources are
   *  audio-only today; MIDI tracks reject. */
  _laneAcceptsPoolDrop(track) {
    return !!track && track.kind === "audio";
  }

  _onLaneDragOver(ev, track) {
    // Bail on non-pool drags so we don't preventDefault on, e.g.,
    // a region marquee drag or a browser-native text drag.
    if (!this._isPoolDrag(ev.dataTransfer)) return;
    // Always preventDefault on dragover to mark the lane as a valid
    // drop target — without this the browser refuses to fire `drop`.
    // We can't read the payload yet (getData returns "" during drag
    // in every modern browser); the kind-compat toast lives in the
    // drop handler. Effect hint is best-effort.
    ev.preventDefault();
    if (this._laneAcceptsPoolDrop(track)) {
      ev.dataTransfer.dropEffect = "copy";
      ev.currentTarget.classList.add("pool-drop-target");
      // Ghost preview: same idea as the cross-track drag ghost.
      // The pool stashes its row payload on `window.__foyer._poolDrag`
      // at dragstart so we can read the source length without
      // touching getData (gated until drop). Resolve drop-X from the
      // current cursor and update on every dragover so the ghost
      // tracks the pointer in real time.
      const stash = window.__foyer?._poolDrag;
      if (stash) {
        const scroll = this.renderRoot?.querySelector?.(".scroll");
        if (scroll) {
          const bounds = scroll.getBoundingClientRect();
          const contentX = ev.clientX - bounds.left + scroll.scrollLeft - HEAD_WIDTH;
          const sr = this._sampleRate();
          const atSamples = Math.max(0, Math.round((contentX / this._zoom) * sr));
          this._poolDropGhost = {
            destTrackId: track.id,
            startSamples: atSamples,
            lengthSamples: Number(stash.length_samples) || sr,
            name: stash.name || "",
          };
        }
      }
    } else {
      ev.dataTransfer.dropEffect = "none";
    }
  }

  _onLaneDragLeave(ev, _track) {
    // The dragleave fires while moving over children too; only clear
    // the indicator when the cursor truly leaves the lane element.
    if (ev.target === ev.currentTarget) {
      ev.currentTarget.classList.remove("pool-drop-target");
      // Clear the ghost only when leaving the lane that owned it.
      if (this._poolDropGhost
          && this._poolDropGhost.destTrackId === ev.currentTarget?.dataset?.trackId) {
        this._poolDropGhost = null;
      }
    }
  }

  _onLaneDrop(ev, track) {
    if (!this._isPoolDrag(ev.dataTransfer)) return;
    const payload = this._readPoolDragPayload(ev.dataTransfer);
    if (!payload) return;
    ev.preventDefault();
    ev.currentTarget.classList.remove("pool-drop-target");
    this._poolDropGhost = null;
    if (!this._laneAcceptsPoolDrop(track)) {
      toast(`Can't drop an audio source onto a ${track.kind} track.`, { tone: "warn", ttl: 2800 });
      return;
    }
    // Resolve the drop sample from the grid X position. The lane's
    // scroll container is .scroll on the host; the grid is offset
    // from the scroll's left edge by HEAD_WIDTH.
    const scroll = this.renderRoot?.querySelector?.(".scroll");
    if (!scroll) return;
    const bounds = scroll.getBoundingClientRect();
    const contentX = ev.clientX - bounds.left + scroll.scrollLeft - HEAD_WIDTH;
    const sr = this._sampleRate();
    const atSamples = Math.max(0, Math.round((contentX / this._zoom) * sr));
    // Snap to the active grid if enabled so dragged regions line up
    // with beat/bar markers (matches the paste / nudge paths).
    const snapped = this._snapLeaderStart
      ? this._snapLeaderStart(atSamples, new Set(), ev.altKey)
      : atSamples;
    const ws = window.__foyer?.ws;
    if (!ws) return;
    ws.send({
      type: "create_region",
      track_id: track.id,
      at_samples: snapped,
      length_samples: Math.max(1, Number(payload.length_samples) || 0),
      source_path: payload.path || undefined,
      name: payload.name || undefined,
      kind: "audio",
    });
    toast(`Inserted ${payload.name || "audio"} on ${track.name}`, { tone: "info", ttl: 2000 });
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
        // Flag layout as backend-sourced so the tempo-change
        // re-persist path doesn't refuse to fire on real edits.
        seq._layoutFromBackend = !!r?.foyer_sequencer;
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
          if (fresh.foyer_sequencer) {
            seq.layout = fresh.foyer_sequencer;
            seq._layoutFromBackend = true;
          }
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
        viewKind: "beat-sequencer",
        viewProps: { regionId: region?.id, trackId },
        // Same reasoning as the MIDI editor — retarget the live
        // sequencer to the new region rather than spawning a dup.
        onReuse: (existingSeq) => {
          if (!existingSeq) return;
          existingSeq.regionId = seq.regionId;
          existingSeq.regionName = seq.regionName;
          existingSeq.notes = seq.notes;
          existingSeq.layout = seq.layout;
          existingSeq._layoutFromBackend = seq._layoutFromBackend;
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

  /**
   * Horizontal zoom-in/out step driven by a keyboard shortcut. Anchors
   * around the playhead if it's currently visible (matches what users
   * mean by "zoom into where I'm playing"), otherwise around the
   * scrollLeft viewport center.
   * @param {number} step — multiplicative factor; >1 zooms in, <1 zooms out.
   */
  zoomStepH(step) {
    const scroll = this.renderRoot?.querySelector?.(".scroll");
    if (!scroll) return false;
    const sr = this._sampleRate();
    const visiblePx = Math.max(50, scroll.clientWidth - HEAD_WIDTH);
    // Anchor sample: playhead if visible, else viewport center.
    const phPx = (this._playheadSamples / sr) * this._zoom;
    const phVisible =
      phPx >= scroll.scrollLeft - HEAD_WIDTH
      && phPx <= scroll.scrollLeft - HEAD_WIDTH + visiblePx;
    const anchorPx = phVisible
      ? phPx
      : (scroll.scrollLeft - HEAD_WIDTH) + visiblePx / 2;
    const anchorSamples = (anchorPx / this._zoom) * sr;
    const next = Math.max(2, Math.min(4000, Math.round(this._zoom * step)));
    if (next === this._zoom) return false;
    this._zoom = next;
    this.updateComplete.then(() => {
      const sc = this.renderRoot.querySelector(".scroll");
      if (!sc) return;
      const newAnchorPx = (anchorSamples / sr) * this._zoom;
      sc.scrollLeft = Math.max(0, newAnchorPx - (anchorPx - (scroll.scrollLeft - HEAD_WIDTH)));
    });
    return true;
  }

  /**
   * Vertical lane-height zoom step applied uniformly to every track.
   * Keyboard counterpart of Alt-wheel; resizes the per-track override
   * map relative to each track's current height.
   * @param {number} step — multiplicative factor; >1 grows, <1 shrinks.
   */
  zoomStepV(step) {
    const tracks = this.session?.tracks || [];
    if (!tracks.length) return false;
    const next = { ...this._laneHeights };
    let changed = false;
    for (const t of tracks) {
      const cur = this._laneHeightFor(t.id);
      const n = Math.max(LANE_HEIGHT_MIN, Math.min(LANE_HEIGHT_MAX, Math.round(cur * step)));
      if (n !== cur) {
        next[t.id] = n;
        changed = true;
      }
    }
    if (!changed) return false;
    this._laneHeights = next;
    this._saveLaneHeights();
    this.requestUpdate();
    requestAnimationFrame(() => this._repaintWaveforms());
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

  // ── programmatic focus (MCP visualize entry points) ───────────────
  //
  // These public methods exist so the headless renderer can pose the
  // timeline for a specific shot. The interactive UI uses the same
  // zoom mechanics but driven from user gestures; everything here
  // composes the existing primitives (selection + zoomToSelection +
  // scrollLeft).

  /** Zoom + scroll so a single region fills the visible timeline.
   *  Walks the loaded `_regionsByTrack` map to find the region by id,
   *  sets `_selection` to its time range, then calls `zoomToSelection`.
   *  Returns `true` on success, `false` if the region isn't loaded. */
  focusOnRegion(regionId) {
    if (!regionId || !this._regionsByTrack) return false;
    for (const [_tid, list] of Object.entries(this._regionsByTrack)) {
      const r = (list || []).find((x) => x.id === regionId);
      if (r) {
        const start = r.start_samples ?? 0;
        const len = r.length_samples ?? 0;
        this._selection = {
          startSamples: start,
          endSamples: start + Math.max(1, len),
        };
        this.requestUpdate();
        // Wait for the selection ribbon to render so the
        // zoomToSelection scroll math sees the correct DOM.
        this.updateComplete.then(() => this.zoomToSelection());
        return true;
      }
    }
    return false;
  }

  /** Zoom + scroll so all regions on a track fit the viewport, then
   *  scroll the lane into view vertically. Returns false if the track
   *  has no regions. */
  focusOnTrack(trackId) {
    if (!trackId || !this._regionsByTrack) return false;
    const regions = this._regionsByTrack[trackId] || [];
    if (!regions.length) return false;
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of regions) {
      const s = r.start_samples ?? 0;
      const e = s + (r.length_samples ?? 0);
      if (s < lo) lo = s;
      if (e > hi) hi = e;
    }
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return false;
    this._selection = { startSamples: lo, endSamples: hi };
    this.requestUpdate();
    this.updateComplete.then(() => {
      this.zoomToSelection();
      // Scroll the lane row into view vertically.
      const head = this.renderRoot?.querySelector(
        `[data-track-id="${CSS.escape(trackId)}"]`,
      );
      head?.scrollIntoView?.({ block: "center", behavior: "instant" });
    });
    return true;
  }

  /** Enable / disable the event-heatmap overlay for a track. When set,
   *  a dim strip above the track lane shows region density (Audio /
   *  MIDI region count per time bin). Hidden by default; only the
   *  MCP `visualize.event_heatmap` path turns it on. */
  setEventHeatmap(trackId) {
    this._eventHeatmapTrackId = trackId || null;
    this.requestUpdate();
  }

  // ── overview strip ────────────────────────────────────────────────
  //
  // Bottom-pinned summary view: every track rendered as a thin lane
  // showing region coverage across the whole session, plus a draggable
  // viewport rectangle mirroring the main `.scroll` container. Drag
  // the rect to pan; drag its left/right edges to zoom. Double-click
  // anywhere to recenter on that point. Modeled on Ardour's editor
  // summary (the bottom strip).

  firstUpdated() {
    // Seed scroll mirror immediately so the first paint sizes the
    // viewport rect correctly. Lit only fires `firstUpdated` once,
    // after the initial render lands.
    this._syncScrollMirror();
    // ResizeObserver picks up window / sibling layout changes (the
    // mixer takes / yields width when the user drags the pane
    // divider) without us having to wire a global resize listener.
    if (typeof ResizeObserver === "function") {
      this._scrollObserver = new ResizeObserver(() => this._syncScrollMirror());
      const scroll = this.renderRoot?.querySelector?.(".scroll");
      if (scroll) this._scrollObserver.observe(scroll);
    }
    this._onVizPrefsChange = () => {
      const h = getVizPref("overviewStripHeight");
      if (Number.isFinite(h) && h !== this._overviewHeight) {
        this._overviewHeight = h;
      }
      this.requestUpdate();
    };
    window.addEventListener("foyer:viz-prefs-changed", this._onVizPrefsChange);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._scrollObserver?.disconnect?.();
    if (this._onVizPrefsChange) {
      window.removeEventListener("foyer:viz-prefs-changed", this._onVizPrefsChange);
    }
  }

  _onScrollChanged() {
    this._syncScrollMirror();
  }

  _syncScrollMirror() {
    const scroll = this.renderRoot?.querySelector?.(".scroll");
    if (!scroll) return;
    const x = scroll.scrollLeft;
    const w = Math.max(1, scroll.clientWidth - HEAD_WIDTH);
    if (x !== this._scrollX) this._scrollX = x;
    if (w !== this._scrollViewW) this._scrollViewW = w;
  }

  _renderOverviewStrip(tracks, totalSec) {
    if (getVizPref("overviewStripOn") === false) return null;
    const sr = this._sampleRate();
    const sessionSamples = Math.max(1, totalSec * sr);
    const stripHeight = Math.max(40, Math.min(240, this._overviewHeight || 90));
    // Lane rows fill everything below a 12 px ruler band.
    const rulerH = 12;
    const visibleTracks = (tracks || []).filter((t) => t.kind !== "Master");
    const laneCount = Math.max(1, visibleTracks.length);
    const lanesH = stripHeight - rulerH;
    const laneH = Math.max(2, lanesH / laneCount);
    const stripWidthPx = 1000; // SVG viewBox; the actual width fills via CSS.
    const xOfSamples = (s) => (s / sessionSamples) * stripWidthPx;

    // Viewport rect — mirror of main timeline's visible range.
    // scrollLeft is in main-grid px including HEAD_WIDTH; subtract
    // so we're working in content-px (samples × zoom).
    const contentX = Math.max(0, this._scrollX - HEAD_WIDTH);
    const visibleSec0 = contentX / Math.max(1, this._zoom);
    const visibleSecW = this._scrollViewW / Math.max(1, this._zoom);
    const vpLeft = (visibleSec0 / totalSec) * stripWidthPx;
    const vpW = Math.max(2, (visibleSecW / totalSec) * stripWidthPx);

    // Per-track region rectangles.
    const trackRects = visibleTracks.map((t, idx) => {
      const y = rulerH + idx * laneH;
      const regions = this._regionsByTrack?.[t.id] || [];
      const kindClass = t.kind === "Midi"
        ? regions.some((r) => r.kind === "sequencer") ? "sequencer" : "midi"
        : t.kind === "Master" ? "master" : "audio";
      return svg`
        <g class="overview-track-row ${kindClass}">
          ${regions.map((r) => {
            const start = Number(r.start_samples) || 0;
            const len = Number(r.length_samples) || 0;
            const x = xOfSamples(start);
            const w = Math.max(0.5, xOfSamples(start + len) - x);
            return svg`<rect x=${x.toFixed(2)} y=${(y + 1).toFixed(2)}
                              width=${w.toFixed(2)} height=${(laneH - 2).toFixed(2)}
                              rx="0.5" />`;
          })}
        </g>
      `;
    });

    // Playhead.
    const playheadX = xOfSamples(this._playheadSamples || 0);

    // Ruler ticks every nice-second-step.
    const tickStep = totalSec <= 30 ? 5 : totalSec <= 90 ? 10 : 30;
    const ticks = [];
    for (let t = 0; t <= totalSec; t += tickStep) {
      const x = (t / totalSec) * stripWidthPx;
      ticks.push(svg`<line x1=${x} y1="0" x2=${x} y2=${rulerH}
                          stroke="color-mix(in oklab, var(--color-border) 60%, transparent)"
                          stroke-width="0.5" />`);
      if (t > 0) {
        ticks.push(svg`<text x=${x + 2} y="9" font-size="8"
                          fill="var(--color-text-muted)"
                          font-family="var(--font-mono)">${t}s</text>`);
      }
    }

    return html`
      <div class="overview-strip" style="height:${stripHeight}px"
           title="Drag the highlighted viewport to scroll; drag its edges to zoom; wheel to zoom (shift/ctrl-wheel scrolls); double-click to recenter">
        <div class="overview-resize"
             @pointerdown=${(e) => this._startOverviewResize(e)}></div>
        <svg class="overview-svg"
             viewBox="0 0 ${stripWidthPx} ${stripHeight}"
             preserveAspectRatio="none"
             @pointerdown=${(e) => this._onOverviewPointerDown(e, stripWidthPx, totalSec)}
             @dblclick=${(e) => this._onOverviewDoubleClick(e, stripWidthPx, totalSec)}
             @wheel=${(e) => this._onOverviewWheel(e, stripWidthPx, totalSec)}>
          ${ticks}
          ${trackRects}
          <line class="overview-playhead"
                x1=${playheadX.toFixed(2)} y1="0"
                x2=${playheadX.toFixed(2)} y2=${stripHeight} />
          <rect class="overview-viewport"
                x=${vpLeft.toFixed(2)} y="0"
                width=${vpW.toFixed(2)} height=${stripHeight}
                rx="2"
                @pointerdown=${(e) => this._startOverviewDrag(e, "pan", stripWidthPx, totalSec)} />
          <rect class="overview-viewport-edge"
                x=${(vpLeft - 4).toFixed(2)} y="0"
                width="8" height=${stripHeight}
                @pointerdown=${(e) => this._startOverviewDrag(e, "left", stripWidthPx, totalSec)} />
          <rect class="overview-viewport-edge"
                x=${(vpLeft + vpW - 4).toFixed(2)} y="0"
                width="8" height=${stripHeight}
                @pointerdown=${(e) => this._startOverviewDrag(e, "right", stripWidthPx, totalSec)} />
        </svg>
      </div>
    `;
  }

  /** SVG `x` is in viewBox units; convert pointer event to that. */
  _overviewClientToVbX(ev, stripWidthPx) {
    const svgEl = ev.currentTarget.closest?.("svg") || ev.currentTarget;
    const rect = svgEl.getBoundingClientRect();
    const ratio = stripWidthPx / Math.max(1, rect.width);
    return (ev.clientX - rect.left) * ratio;
  }

  _onOverviewPointerDown(ev, stripWidthPx, totalSec) {
    // Anywhere on the SVG that isn't a viewport rect / edge handle
    // (those stopPropagation in their own handlers): recenter on the
    // clicked sample, then continue as a pan drag so the user can
    // fine-tune without releasing — Ardour summary-strip behavior.
    ev.preventDefault();
    const x = this._overviewClientToVbX(ev, stripWidthPx);
    this._recenterOverview(x, stripWidthPx, totalSec);
    this._startOverviewDrag(ev, "pan", stripWidthPx, totalSec);
  }

  _onOverviewDoubleClick(ev, stripWidthPx, totalSec) {
    ev.preventDefault();
    const x = this._overviewClientToVbX(ev, stripWidthPx);
    this._recenterOverview(x, stripWidthPx, totalSec);
  }

  _recenterOverview(targetVbX, stripWidthPx, totalSec) {
    const sr = this._sampleRate();
    const sampleAtX = (targetVbX / stripWidthPx) * totalSec * sr;
    const scroll = this.renderRoot?.querySelector?.(".scroll");
    if (!scroll) return;
    const visiblePx = Math.max(50, scroll.clientWidth - HEAD_WIDTH);
    const targetPx = (sampleAtX / sr) * this._zoom;
    scroll.scrollLeft = Math.max(0, targetPx - visiblePx / 2);
  }

  _startOverviewDrag(ev, mode, stripWidthPx, totalSec) {
    ev.preventDefault();
    ev.stopPropagation();
    // Cache the SVG's client rect ONCE at gesture start. The window
    // `pointermove` listener sees `currentTarget === window`, so the
    // generic _overviewClientToVbX helper (which does .closest("svg"))
    // fails partway through every drag — every move computed NaN
    // before this fix, which is why pan/zoom-edge drags appeared dead.
    const svgEl =
      ev.currentTarget?.closest?.("svg") ||
      this.renderRoot?.querySelector?.(".overview-svg");
    if (!svgEl) return;
    const svgRect = svgEl.getBoundingClientRect();
    const clientToVbX = (clientX) =>
      ((clientX - svgRect.left) / Math.max(1, svgRect.width)) * stripWidthPx;
    const scroll = this.renderRoot?.querySelector?.(".scroll");
    if (!scroll) return;
    const visiblePx = Math.max(50, scroll.clientWidth - HEAD_WIDTH);
    const startVbX = clientToVbX(ev.clientX);
    const startScrollX = scroll.scrollLeft;
    const startZoom = this._zoom;
    const startVpLeftSec = (startScrollX - HEAD_WIDTH) / Math.max(1, startZoom);
    const startVpWSec = visiblePx / Math.max(1, startZoom);
    const move = (e) => {
      const vbX = clientToVbX(e.clientX);
      const deltaSec =
        ((vbX - startVbX) / stripWidthPx) * totalSec;
      if (mode === "pan") {
        const newLeftSec = Math.max(0, startVpLeftSec + deltaSec);
        scroll.scrollLeft = newLeftSec * this._zoom + HEAD_WIDTH;
      } else if (mode === "right") {
        // Right edge: viewport keeps its left anchor; width grows
        // with drag. New zoom maps visiblePx to the new viewport
        // width in seconds. Clamp to the engine's zoom range.
        const newWSec = Math.max(0.05, startVpWSec + deltaSec);
        const newZoom = Math.max(2, Math.min(4000, visiblePx / newWSec));
        this._zoom = newZoom;
        // Lit re-render → scrollLeft must stay anchored to the
        // viewport's left edge in seconds, recomputed under the
        // new zoom.
        this.updateComplete.then(() => {
          scroll.scrollLeft = startVpLeftSec * this._zoom + HEAD_WIDTH;
        });
      } else if (mode === "left") {
        // Left edge: viewport keeps its right anchor.
        const startVpRightSec = startVpLeftSec + startVpWSec;
        const newLeftSec = Math.max(0, startVpLeftSec + deltaSec);
        const newWSec = Math.max(0.05, startVpRightSec - newLeftSec);
        const newZoom = Math.max(2, Math.min(4000, visiblePx / newWSec));
        this._zoom = newZoom;
        this.updateComplete.then(() => {
          scroll.scrollLeft = newLeftSec * this._zoom + HEAD_WIDTH;
        });
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Mouse wheel over the overview strip. The keymap profile decides what
  // plain/shift/ctrl/alt + wheel means here — default (Foyer/Ardour) is
  // plain=zoom-at-cursor and shift/ctrl=hscroll, matching Ardour's editor
  // summary. Pro Tools / Cubase profiles swap to "scroll first, ctrl zooms".
  _onOverviewWheel(ev, stripWidthPx, totalSec) {
    const scroll = this.renderRoot?.querySelector?.(".scroll");
    if (!scroll) return;
    const op = resolveWheel("timeline_overview", ev);
    if (op === "hscroll") {
      ev.preventDefault();
      ev.stopPropagation();
      const delta = (ev.deltaY || 0) + (ev.deltaX || 0);
      scroll.scrollLeft = Math.max(0, scroll.scrollLeft + delta);
      return;
    }
    if (op === "vscroll" || op === "none") {
      return;
    }
    // op === "hzoom" — zoom anchored at the strip-x sample under the cursor.
    ev.preventDefault();
    ev.stopPropagation();
    const sr = this._sampleRate();
    const visiblePx = Math.max(50, scroll.clientWidth - HEAD_WIDTH);
    const svgEl = ev.currentTarget;
    const rect = svgEl.getBoundingClientRect();
    const vbX = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * stripWidthPx;
    const fraction = Math.max(0, Math.min(1, vbX / stripWidthPx));
    const sampleAtCursor = fraction * totalSec * sr;
    const factor = zoomFactorFromWheel(ev.deltaY);
    this._zoom = Math.max(2, Math.min(4000, this._zoom * factor));
    this.updateComplete.then(() => {
      const targetPx = (sampleAtCursor / sr) * this._zoom;
      scroll.scrollLeft = Math.max(0, targetPx - visiblePx / 2 + HEAD_WIDTH);
    });
  }

  _startOverviewResize(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const startY = ev.clientY;
    const startH = this._overviewHeight;
    const move = (e) => {
      // Drag UP shrinks; drag DOWN grows. Inverted from naive math
      // because the resize handle sits at the strip's TOP edge.
      const delta = startY - e.clientY;
      this._overviewHeight = Math.max(40, Math.min(240, startH + delta));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setVizPref("overviewStripHeight", this._overviewHeight);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
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
  pasteRegions({ at = "mouse", targetTrackId = null } = {}) {
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
    // Resolve a destination track. Three sources, in priority order:
    //   1. Explicit `targetTrackId` (the lane context menu passes the
    //      right-clicked track for both "Paste here" and "Paste at
    //      playhead" so cross-lane paste works for keyboard-style
    //      gestures too).
    //   2. `at === "mouse"` → resolve lane under the cursor (legacy).
    //   3. Otherwise: no destination → paste lands on each clip
    //      item's source track (back-compat for Ctrl+V / Ctrl+Shift+V).
    let destTrackByItem = null;
    const explicitDest = targetTrackId
      ? (this.session?.tracks || []).find((t) => t.id === targetTrackId)
      : null;
    const destTrack = explicitDest
      || (at === "mouse" ? this._trackAtMouseY() : null);
    if (destTrack) {
      // Validate the entire clipboard against the destination kind.
      // The clipboard captured each item's source track id; mixing
      // kinds in one paste is rare but possible, so we require every
      // source to match the destination's kind.
      const tracks = this.session?.tracks || [];
      const incompat = clip.items.filter((it) => {
        const src = tracks.find((t) => t.id === it.track_id);
        return src && src.kind !== destTrack.kind;
      });
      if (incompat.length) {
        toast(
          `Can't paste ${incompat.length === clip.items.length ? "" : "some "}` +
            `${incompat[0] && (tracks.find((t) => t.id === incompat[0].track_id)?.kind) || "audio"} ` +
            `region(s) onto a ${destTrack.kind} track.`,
          { tone: "warn", ttl: 3000 },
        );
        return 0;
      }
      destTrackByItem = destTrack.id;
    }
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
          ...(destTrackByItem ? { target_track_id: destTrackByItem } : {}),
        });
      } else {
        ws?.send({
          type: "duplicate_region",
          source_region_id: it.region_id,
          at_samples,
          length_samples: it.length_samples,
          ...(destTrackByItem ? { target_track_id: destTrackByItem } : {}),
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
   * Find the track whose lane element contains the last-known mouse
   * Y position. Returns the Track object, or `null` when the
   * cursor isn't currently over any lane (mouse never moved, mouse
   * is outside the scroll viewport, etc.). Used by cross-track
   * paste to figure out the destination track at paste-time.
   */
  _trackAtMouseY() {
    return this._trackAtClientY(this._lastMouseClientY);
  }

  /** Like `_trackAtMouseY` but takes an explicit Y so live-drag
   *  handlers can resolve the destination from their pointermove
   *  events without relying on the hover-cache. */
  _trackAtClientY(y) {
    if (!Number.isFinite(y)) return null;
    const lanes = this.renderRoot.querySelectorAll(".lane");
    const tracks = this.session?.tracks || [];
    for (let i = 0; i < lanes.length; i++) {
      const r = lanes[i].getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) {
        return tracks[i] || null;
      }
    }
    return null;
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
        <label class="zoom-toolbar">
          <span class="zoom-label">Zoom</span>
          <input type="range" class="zoom-range" min="0" max="1000" step="1"
                 title="Timeline scale (pixels per second)"
                 .value=${String(Math.round(Math.log(this._zoom / 2) / Math.log(4000 / 2) * 1000))}
                 @input=${(e) => {
                   const t = Number(e.currentTarget.value) / 1000;
                   this._zoom = Math.max(2, Math.min(4000, Math.round(2 * Math.pow(4000 / 2, t))));
                 }}>
        </label>
        ${this._selection ? html`
          <button
            @click=${() => this.zoomToSelection()}
            title="Zoom to the current timeline selection"
          >${icon("magnifying-glass", 12)}<span>Zoom</span></button>
          <button
            @click=${() => this._setLoopToSelection()}
            title="Set loop start/end from current selection"
          >${icon("loop", 12)}<span>Loop</span></button>
        ` : null}
        <span style="flex:1"></span>
        ${this._renderRegionToolsMenu()}
        ${this._renderSnapMenu()}
        ${this._renderQuantSubdivMenu()}
        <foyer-viz-picker></foyer-viz-picker>
        ${this._diagEnabled() ? html`
          <span>
            drops: seq=${this._transportDropStats.stale_seq || 0}
            back=${this._transportDropStats.backward_jump || 0}
          </span>
        ` : null}
      </div>
      <div class="scroll"
           @wheel=${(e) => this._onWheel(e)}
           @pointerdown=${(e) => this._onScrollPointerDown(e)}
           @scroll=${() => this._onScrollChanged()}
           @auxclick=${(e) => { if (e.button === 1) e.preventDefault(); }}>
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
      ${this._renderOverviewStrip(tracks, totalSec)}
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
    // Cross-track paste needs the destination track too — capture
    // the clientY at every move so `pasteRegions()` can resolve
    // "which lane is the cursor over" without re-running pointer-
    // event plumbing on the keybind path.
    this._lastMouseClientY = ev.clientY;
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

  _loadSnapPrefs() {
    try {
      const raw = localStorage.getItem(SNAP_PREFS_KEY);
      const p = raw ? JSON.parse(raw) : {};
      return { ...defaultSnapPrefs(), ...p };
    } catch {
      return defaultSnapPrefs();
    }
  }

  _persistSnapPrefs() {
    try {
      localStorage.setItem(SNAP_PREFS_KEY, JSON.stringify(this._snapPrefs));
    } catch {}
  }

  _gridStepSamples() {
    const sr = this._sampleRate();
    const ctls = window.__foyer?.store?.state?.controls;
    const tempo = Number(ctls?.get?.("transport.tempo")) || 120;
    if (!Number.isFinite(tempo) || tempo <= 0) return null;
    const tsDen = Math.max(1, Math.round(Number(ctls?.get?.("transport.ts.den")) || 4));
    const beatSec = (60 / tempo) * (4 / tsDen);
    const div = Math.max(1, this._quantDiv | 0);
    const subsPerBeat = Math.max(1, Math.round(div / tsDen));
    const stepSec = beatSec / subsPerBeat;
    return Math.max(1, Math.round(stepSec * sr));
  }

  _snapSampleToGrid(samples) {
    const step = this._gridStepSamples();
    if (!step) return Math.round(samples);
    return Math.round(samples / step) * step;
  }

  /** Session marker positions in samples (empty until the schema grows markers). */
  _sessionMarkerSamples() {
    const m = this.session?.markers;
    if (!Array.isArray(m)) return [];
    const out = [];
    for (const x of m) {
      const s = Number(x?.position_samples ?? x?.samples ?? x);
      if (Number.isFinite(s)) out.push(Math.round(s));
    }
    return out;
  }

  _snapThresholdSamples() {
    const sr = this._sampleRate();
    const px = Math.max(1e-6, this._zoom);
    const samplesPerPx = sr / px;
    return Math.max(48, Math.round(samplesPerPx * 10));
  }

  _collectSnapTargets(excludeIds, rawLeaderStart) {
    const p = this._snapPrefs || defaultSnapPrefs();
    const points = [];
    const thresh = this._snapThresholdSamples();
    if (p.grid) {
      const step = this._gridStepSamples();
      if (step) points.push(this._snapSampleToGrid(rawLeaderStart));
    }
    if (p.playhead) {
      points.push(Math.round(Number(this._playheadSamples) || 0));
    }
    if (p.markers) {
      for (const s of this._sessionMarkerSamples()) points.push(s);
    }
    if (p.regionEdges) {
      const skip = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
      for (const list of Object.values(this._regionsByTrack || {})) {
        for (const r of list || []) {
          if (!r?.id || skip.has(r.id)) continue;
          const st = Math.round(Number(r.start_samples) || 0);
          const en = st + Math.max(0, Math.round(Number(r.length_samples) || 0));
          points.push(st, en);
        }
      }
    }
    let best = rawLeaderStart;
    let bestD = thresh + 1;
    for (const q of points) {
      const d = Math.abs(q - rawLeaderStart);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
    if (bestD > thresh) return rawLeaderStart;
    return best;
  }

  /** Alt during region move bypasses magnetic snap. */
  _snapLeaderStart(leaderRawStart, movingIds, altHeld) {
    if (altHeld) return leaderRawStart;
    const exclude = new Set(movingIds);
    return this._collectSnapTargets(exclude, leaderRawStart);
  }

  _selectedRegionObjects() {
    const ids = this._selectedRegionIds;
    const out = [];
    for (const id of ids) {
      const r = this._regionForId(id);
      if (r) out.push(r);
    }
    return out;
  }

  _trackKind(trackId) {
    const tracks = this.session?.tracks || [];
    const t = tracks.find((x) => x.id === trackId);
    return t?.kind || "audio";
  }

  _quantizeSelectedRegionsToGrid() {
    const step = this._gridStepSamples();
    if (!step) {
      toast("Set a valid tempo to quantize to the beat grid.", { tone: "warn" });
      return;
    }
    const ws = window.__foyer?.ws;
    if (!ws) return;
    for (const id of this._selectedRegionIds) {
      const r = this._regionForId(id);
      if (!r) continue;
      const snapped = this._snapSampleToGrid(Number(r.start_samples) || 0);
      if (snapped === Math.round(Number(r.start_samples) || 0)) continue;
      ws.send({
        type: "update_region",
        id: r.id,
        patch: { start_samples: snapped },
      });
    }
  }

  /**
   * Begin a fade-handle drag. `side` is `"in"` or `"out"`, `anchor` is the
   * region the handle belongs to. Moves the fade endpoint horizontally
   * — fade length grows as the user drags inward, shrinks back to zero
   * if they overshoot the corner. Shape stays put unless the user
   * holds Alt (cycles through Ardour's five shapes).
   *
   * Local-only preview during drag (no `update_region` until pointer-up)
   * matches the single-undo-entry contract the move/resize handlers
   * already use. Crossfades render automatically from the resulting
   * fade fields whenever two same-track audio regions overlap.
   */
  _startFadeDrag(ev, region, side) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (this._trackKind(region.track_id) !== "audio") return;
    const sr = this._sampleRate();
    const pxPerSec = this._zoom;
    const startX = ev.clientX;
    const origInSamples = Math.max(0, Number(region.fade_in_samples) || 0);
    const origOutSamples = Math.max(0, Number(region.fade_out_samples) || 0);
    const origShape = side === "in"
      ? (region.fade_in_shape || "linear")
      : (region.fade_out_shape || "linear");
    // Local copy of shape, mutable by Alt+drag; commits on pointer-up.
    this._fadeDragShape = origShape;
    const regionEl = this.renderRoot.querySelector(`.region[data-id="${region.id}"]`);
    const handleEl = ev.currentTarget;
    handleEl?.classList?.add("dragging");
    regionEl?.classList?.add("fade-dragging");
    try { handleEl?.setPointerCapture?.(ev.pointerId); } catch {}
    const lenSamples = Math.max(1, Number(region.length_samples) || 1);
    const minFade = 0;
    // Cap each fade so it can't swallow more than (length - 480 samples)
    // — same hard floor as the previous menu-driven step paths.
    const maxFade = Math.max(0, lenSamples - 480);
    let lastFade = side === "in" ? origInSamples : origOutSamples;
    const move = (e) => {
      const dxPx = e.clientX - startX;
      const dxSamples = Math.round((dxPx / pxPerSec) * sr);
      // Drag direction: fade-in grows as the pointer moves to the
      // right; fade-out grows as the pointer moves to the left. So
      // the fade length delta is +dx for "in" and -dx for "out".
      const delta = side === "in" ? dxSamples : -dxSamples;
      const orig = side === "in" ? origInSamples : origOutSamples;
      let fade = Math.max(minFade, Math.min(maxFade, orig + delta));
      // When dragging both fades on the same region they may NOT
      // overlap — otherwise Ardour's fade engine produces a click. If
      // we're sizing the "in" handle and there's a fixed fade-out, cap
      // accordingly; same for the inverse.
      const other = side === "in" ? origOutSamples : origInSamples;
      const room = Math.max(0, lenSamples - other - 1);
      fade = Math.min(fade, room);
      if (e.altKey && !this._fadeDragAltConsumed) {
        // Alt cycles the shape on the way DOWN of a single press
        // (not on each pointermove sample). The flag is reset on
        // Alt-release below.
        this._fadeDragShape = this._cycleFadeShape(this._fadeDragShape);
        this._fadeDragAltConsumed = true;
      } else if (!e.altKey && this._fadeDragAltConsumed) {
        this._fadeDragAltConsumed = false;
      }
      lastFade = fade;
      const preview = { ...region };
      if (side === "in") {
        preview.fade_in_samples = fade > 0 ? fade : null;
        preview.fade_in_shape = fade > 0 ? this._fadeDragShape : null;
      } else {
        preview.fade_out_samples = fade > 0 ? fade : null;
        preview.fade_out_shape = fade > 0 ? this._fadeDragShape : null;
      }
      this._patchRegionLocally(preview);
    };
    const up = () => {
      handleEl?.classList?.remove("dragging");
      regionEl?.classList?.remove("fade-dragging");
      try { handleEl?.releasePointerCapture?.(ev.pointerId); } catch {}
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      this._fadeDragAltConsumed = false;
      // Commit once at the end.
      const r = this._regionForId(region.id);
      if (!r) return;
      const patch = side === "in"
        ? {
            fade_in_samples: lastFade,
            ...(lastFade > 0 ? { fade_in_shape: this._fadeDragShape } : {}),
          }
        : {
            fade_out_samples: lastFade,
            ...(lastFade > 0 ? { fade_out_shape: this._fadeDragShape } : {}),
          };
      // Skip the round-trip if nothing actually changed.
      const wasSamples = side === "in" ? origInSamples : origOutSamples;
      if (wasSamples === lastFade && this._fadeDragShape === origShape) return;
      // Region-group fanout: apply the same fade patch to every
      // group sibling so a fade tweak propagates linked-edit-style.
      // Wrap in an undo group so one Ctrl+Z restores every member.
      const group = this._groupOf(r);
      const targets = group
        ? this._regionsInGroup(group).filter((s) => this._trackKind(s.track_id) === "audio")
        : [r];
      if (targets.length > 1) {
        window.__foyer?.ws?.send({ type: "undo_group_begin", name: "Foyer group fade" });
      }
      for (const t of targets) {
        window.__foyer?.ws?.send({
          type: "update_region",
          id: t.id,
          patch,
        });
      }
      if (targets.length > 1) {
        window.__foyer?.ws?.send({ type: "undo_group_end" });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  /** Cycle through Ardour's fade-shape enum on Alt+fade-drag. */
  _cycleFadeShape(s) {
    const order = ["linear", "fast", "slow", "constant_power", "symmetric"];
    const i = order.indexOf(s);
    return order[(i < 0 ? 0 : (i + 1) % order.length)];
  }

  /**
   * Shift-click on a fade handle clears that fade. Cheap shortcut
   * since the drag-to-zero path requires careful aim.
   */
  _clearFade(region, side) {
    const ws = window.__foyer?.ws;
    if (!ws || !region) return;
    if (this._trackKind(region.track_id) !== "audio") return;
    const patch = side === "in"
      ? { fade_in_samples: 0 }
      : { fade_out_samples: 0 };
    const group = this._groupOf(region);
    const targets = group
      ? this._regionsInGroup(group).filter((s) => this._trackKind(s.track_id) === "audio")
      : [region];
    if (targets.length > 1) {
      ws.send({ type: "undo_group_begin", name: "Foyer group clear fade" });
    }
    for (const t of targets) {
      ws.send({ type: "update_region", id: t.id, patch });
    }
    if (targets.length > 1) ws.send({ type: "undo_group_end" });
  }

  /**
   * Pair of overlapping audio regions on the same track, in timeline
   * order, for crossfade rendering. Returns null when nothing overlaps.
   * Includes the overlap span (in samples) so the renderer can shape
   * the X curve.
   */
  _overlappingPairsForTrack(trackId) {
    if (this._trackKind(trackId) !== "audio") return [];
    const list = (this._regionsByTrack[trackId] || [])
      .slice()
      .sort((a, b) => Number(a.start_samples) - Number(b.start_samples));
    const pairs = [];
    for (let i = 0; i + 1 < list.length; i++) {
      const L = list[i];
      const R = list[i + 1];
      const sL = Math.round(Number(L.start_samples) || 0);
      const eL = sL + Math.max(0, Math.round(Number(L.length_samples) || 0));
      const sR = Math.round(Number(R.start_samples) || 0);
      const eR = sR + Math.max(0, Math.round(Number(R.length_samples) || 0));
      const inter = Math.min(eL, eR) - Math.max(sL, sR);
      if (inter > 0) pairs.push({ L, R, sL, eL, sR, eR, inter });
    }
    return pairs;
  }

  /** Auto-snap the fades on a pair of overlapping audio regions to
   *  match the overlap. Useful from the contextual menu when the user
   *  drops one region onto another and wants Ardour to actually mix
   *  them, not pick one. */
  _applyCrossfadeToSelection() {
    const ws = window.__foyer?.ws;
    if (!ws) {
      toast("Not connected.", { tone: "warn" });
      return;
    }
    // Walk every track that has overlapping audio regions among the
    // current selection. Without this the menu only worked on
    // exactly two regions (the legacy crossfade behavior).
    let applied = 0;
    const trackIds = new Set();
    for (const id of this._selectedRegionIds) {
      const r = this._regionForId(id);
      if (r) trackIds.add(r.track_id);
    }
    ws.send({ type: "undo_group_begin", name: "Foyer crossfade" });
    for (const tid of trackIds) {
      const pairs = this._overlappingPairsForTrack(tid);
      for (const p of pairs) {
        const inSel = this._selectedRegionIds.has(p.L.id) && this._selectedRegionIds.has(p.R.id);
        if (!inSel) continue;
        const ov = Math.floor(p.inter);
        ws.send({
          type: "update_region",
          id: p.L.id,
          patch: { fade_out_samples: ov, fade_out_shape: "symmetric" },
        });
        ws.send({
          type: "update_region",
          id: p.R.id,
          patch: { fade_in_samples: ov, fade_in_shape: "symmetric" },
        });
        applied++;
      }
    }
    ws.send({ type: "undo_group_end" });
    if (!applied) {
      toast(
        "Select two or more overlapping audio regions on the same track.",
        { tone: "warn" },
      );
    } else {
      toast(applied === 1 ? "Crossfade applied." : `${applied} crossfades applied.`, { tone: "info" });
    }
  }

  /**
   * Per-region gain drag. Source amplitude in Ardour is a linear
   * coefficient — drag the strip up/down for a logarithmic dB
   * response (1 dB per 10 px) so the gesture feels musical.
   */
  _startGainDrag(ev, region) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (this._trackKind(region.track_id) !== "audio") return;
    const startY = ev.clientY;
    const startLinear = Math.max(0, Number(region.gain_linear ?? 1));
    const startDb = startLinear > 0 ? 20 * Math.log10(startLinear) : -60;
    const strip = ev.currentTarget;
    strip?.classList?.add("dragging");
    try { strip?.setPointerCapture?.(ev.pointerId); } catch {}
    let lastLinear = startLinear;
    const move = (e) => {
      // Up = louder. 10 px per dB; Shift = fine (50 px per dB).
      const pxPerDb = e.shiftKey ? 50 : 10;
      const dDb = (startY - e.clientY) / pxPerDb;
      // Clamp to roughly the Ardour fader range to keep things sane:
      // −60 dB silence floor, +6 dB unity-plus headroom.
      const newDb = Math.max(-60, Math.min(6, startDb + dDb));
      const linear = newDb <= -60 ? 0 : Math.pow(10, newDb / 20);
      lastLinear = linear;
      this._patchRegionLocally({ ...region, gain_linear: linear });
    };
    const up = () => {
      strip?.classList?.remove("dragging");
      try { strip?.releasePointerCapture?.(ev.pointerId); } catch {}
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (Math.abs(lastLinear - startLinear) < 1e-4) return;
      const group = this._groupOf(region);
      const targets = group
        ? this._regionsInGroup(group).filter((s) => this._trackKind(s.track_id) === "audio")
        : [region];
      if (targets.length > 1) {
        window.__foyer?.ws?.send({ type: "undo_group_begin", name: "Foyer group gain" });
      }
      for (const t of targets) {
        window.__foyer?.ws?.send({
          type: "update_region",
          id: t.id,
          patch: { gain_linear: lastLinear },
        });
      }
      if (targets.length > 1) {
        window.__foyer?.ws?.send({ type: "undo_group_end" });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  /** Double-click a gain strip resets the region to unity gain. */
  _resetGain(region) {
    if (!region) return;
    const cur = Number(region.gain_linear);
    if (!Number.isFinite(cur) || Math.abs(cur - 1) < 1e-4) return;
    const ws = window.__foyer?.ws;
    if (!ws) return;
    const group = this._groupOf(region);
    const targets = group
      ? this._regionsInGroup(group).filter((s) => this._trackKind(s.track_id) === "audio")
      : [region];
    if (targets.length > 1) {
      ws.send({ type: "undo_group_begin", name: "Foyer group reset gain" });
    }
    for (const t of targets) {
      ws.send({
        type: "update_region",
        id: t.id,
        patch: { gain_linear: 1 },
      });
    }
    if (targets.length > 1) ws.send({ type: "undo_group_end" });
  }

  /** Crop every selected region to the carved time selection. Mirror of
   *  the Cut menu entry but destructive — the slice REPLACES each
   *  selected region instead of leaving the head + tail. Operates
   *  per-region: if the selection misses a region entirely it stays put.
   */
  cropSelectedRegionsToSelection() {
    if (!this._selection) {
      toast("Drag a range on the ruler first.", { tone: "warn" });
      return;
    }
    const ws = window.__foyer?.ws;
    if (!ws) {
      toast("Not connected.", { tone: "warn" });
      return;
    }
    const lo = Math.min(this._selection.startSamples, this._selection.endSamples);
    const hi = Math.max(this._selection.startSamples, this._selection.endSamples);
    if (hi - lo < 1) {
      toast("Selection is empty.", { tone: "warn" });
      return;
    }
    const ids = [...this._selectedRegionIds];
    if (!ids.length) {
      toast("Select at least one region.", { tone: "warn" });
      return;
    }
    let cropped = 0;
    ws.send({ type: "undo_group_begin", name: "Foyer crop region(s)" });
    for (const id of ids) {
      const r = this._regionForId(id);
      if (!r) continue;
      const start = Math.round(Number(r.start_samples) || 0);
      const len = Math.max(0, Math.round(Number(r.length_samples) || 0));
      const end = start + len;
      const overlapStart = Math.max(start, lo);
      const overlapEnd = Math.min(end, hi);
      if (overlapEnd - overlapStart < 480) continue; // need at least 10 ms
      const sourceOffset = Math.max(0, Number(r.source_offset_samples) || 0);
      const newStart = overlapStart;
      const newLen = overlapEnd - overlapStart;
      const newSourceOffset = sourceOffset + (overlapStart - start);
      ws.send({
        type: "update_region",
        id: r.id,
        patch: {
          start_samples: newStart,
          length_samples: newLen,
          source_offset_samples: newSourceOffset,
        },
      });
      cropped++;
    }
    ws.send({ type: "undo_group_end" });
    if (!cropped) {
      toast("Selection doesn't overlap the selected regions.", { tone: "warn" });
    } else {
      this._selection = null;
      toast(cropped === 1 ? "Region cropped." : `${cropped} regions cropped.`, { tone: "info" });
    }
  }

  /** Arrow-key nudge for selected regions. Distance modifiers:
   *   - bare: 1 grid step (or 50 ms when no grid)
   *   - Shift: 1 beat
   *   - Ctrl/Cmd: 1 sample
   * Returns true if anything actually moved (so callers can preventDefault). */
  nudgeSelectedRegions(dir, modifiers) {
    if (!this._selectedRegionIds.size) return false;
    const ws = window.__foyer?.ws;
    if (!ws) return false;
    const sr = this._sampleRate();
    let step;
    if (modifiers?.fine) {
      step = 1; // one sample
    } else if (modifiers?.beat) {
      const ctls = window.__foyer?.store?.state?.controls;
      const tempo = Number(ctls?.get?.("transport.tempo")) || 120;
      const tsDen = Math.max(1, Math.round(Number(ctls?.get?.("transport.ts.den")) || 4));
      const beatSec = (60 / Math.max(1, tempo)) * (4 / tsDen);
      step = Math.max(1, Math.round(beatSec * sr));
    } else {
      step = this._gridStepSamples() || Math.round(sr * 0.05);
    }
    const delta = dir === "right" ? step : -step;
    ws.send({ type: "undo_group_begin", name: "Foyer nudge region(s)" });
    for (const id of this._selectedRegionIds) {
      const r = this._regionForId(id);
      if (!r) continue;
      const next = Math.round(Number(r.start_samples) || 0) + delta;
      ws.send({
        type: "update_region",
        id: r.id,
        patch: { start_samples: next },
      });
    }
    ws.send({ type: "undo_group_end" });
    return true;
  }

  /** Timeline order (left to right) for currently selected regions. */
  _sortedSelectedRegionsByTimeline() {
    const regs = this._selectedRegionObjects();
    return [...regs].sort(
      (a, b) => Number(a.start_samples) - Number(b.start_samples),
    );
  }

  /** ≥2 regions, all on the same track — valid for `combine_regions`. */
  _combineRegionSelection() {
    if (this._selectedRegionIds.size < 2) return null;
    const regs = this._sortedSelectedRegionsByTimeline();
    const tid = regs[0]?.track_id;
    if (!tid || !regs.every((r) => r.track_id === tid)) return null;
    return { track_id: tid, regs };
  }

  _reverseSelectedAudioRegions() {
    const ws = window.__foyer?.ws;
    if (!ws) {
      toast("Not connected.", { tone: "warn" });
      return;
    }
    const audioRegs = this._sortedSelectedRegionsByTimeline().filter(
      (r) => this._trackKind(r.track_id) === "audio",
    );
    if (!audioRegs.length) {
      toast("Select at least one audio region.", { tone: "warn" });
      return;
    }
    ws.send({ type: "undo_group_begin", name: "Foyer reverse audio" });
    for (const r of audioRegs) {
      ws.send({ type: "reverse_region", id: r.id });
    }
    ws.send({ type: "undo_group_end" });
  }

  _combineSelectedRegions() {
    const ws = window.__foyer?.ws;
    if (!ws) {
      toast("Not connected.", { tone: "warn" });
      return;
    }
    const sel = this._combineRegionSelection();
    if (!sel) {
      toast("Glue needs two or more regions on the same track.", { tone: "warn" });
      return;
    }
    ws.send({
      type: "combine_regions",
      region_ids: sel.regs.map((r) => r.id),
    });
  }

  _stripSilenceSelectedAudioRegions() {
    const ws = window.__foyer?.ws;
    if (!ws) {
      toast("Not connected.", { tone: "warn" });
      return;
    }
    const audioRegs = this._sortedSelectedRegionsByTimeline().filter(
      (r) => this._trackKind(r.track_id) === "audio",
    );
    if (!audioRegs.length) {
      toast("Select at least one audio region.", { tone: "warn" });
      return;
    }
    ws.send({ type: "undo_group_begin", name: "Foyer strip silence" });
    for (const r of audioRegs) {
      ws.send({ type: "strip_silence_region", id: r.id });
    }
    ws.send({ type: "undo_group_end" });
  }

  async _pitchShiftSelectedRegions() {
    const ws = window.__foyer?.ws;
    if (!ws) {
      toast("Not connected.", { tone: "warn" });
      return;
    }
    const regs = this._selectedRegionObjects();
    if (!regs.length) {
      toast("Select a region.", { tone: "warn" });
      return;
    }
    const raw = await promptText({
      title: "Pitch shift",
      message:
        "Semitone offset. Audio uses Rubber Band; MIDI transposes notes.",
      inputKind: "slider",
      sliderMin: -24,
      sliderMax: 24,
      sliderStep: 0.1,
      defaultValue: "0",
      placeholder: "±24",
      confirmLabel: "Apply",
      cancelLabel: "Cancel",
    });
    if (raw == null) return;
    const semitones = Number.parseFloat(String(raw).trim());
    if (!Number.isFinite(semitones)) {
      toast("Enter a valid number of semitones.", { tone: "warn" });
      return;
    }
    if (semitones === 0) {
      toast("No change (0 semitones).", { tone: "info" });
      return;
    }
    ws.send({ type: "undo_group_begin", name: "Foyer pitch shift" });
    for (const r of regs) {
      ws.send({ type: "pitch_shift_region", id: r.id, semitones });
    }
    ws.send({ type: "undo_group_end" });
  }

  /**
   * Region groups (linked-edit). Helpers + commands. A group is
   * identified by an opaque string `group_id` carried on every
   * member region; `null` / missing = ungrouped. Members may live
   * on different tracks (matches Ardour's RegionGroup model).
   */
  _freshGroupId() {
    const rand = Math.random().toString(36).slice(2, 10);
    const t = Date.now().toString(36);
    return `group.${t}.${rand}`;
  }

  /** Every region currently in `groupId`, across all tracks. */
  _regionsInGroup(groupId) {
    if (!groupId) return [];
    const out = [];
    for (const list of Object.values(this._regionsByTrack || {})) {
      for (const r of list || []) {
        if (r.group_id && r.group_id === groupId) out.push(r);
      }
    }
    return out;
  }

  /** group_id for a region (or null). */
  _groupOf(region) {
    if (!region) return null;
    const g = region.group_id;
    if (!g || typeof g !== "string" || g === "") return null;
    return g;
  }

  /**
   * Expand a set of region ids to include every group sibling of
   * every member. Used by selection fanout + drag fanout so a
   * single-region pick acts on the whole group.
   */
  _expandIdsToGroups(ids) {
    const out = new Set(ids);
    for (const id of ids) {
      const r = this._regionForId(id);
      const g = this._groupOf(r);
      if (!g) continue;
      for (const s of this._regionsInGroup(g)) out.add(s.id);
    }
    return out;
  }

  /** Group selected regions under a fresh group_id (≥2 regions). */
  groupSelectedRegions() {
    const ids = [...this._selectedRegionIds];
    if (ids.length < 2) {
      toast("Pick two or more regions to group.", { tone: "warn" });
      return;
    }
    const ws = window.__foyer?.ws;
    if (!ws) return;
    // If any member is already in a group, reuse the first-seen id so
    // "extend an existing group" works without a separate command.
    let groupId = null;
    for (const id of ids) {
      const r = this._regionForId(id);
      const g = this._groupOf(r);
      if (g) { groupId = g; break; }
    }
    if (!groupId) groupId = this._freshGroupId();
    ws.send({ type: "undo_group_begin", name: "Foyer group regions" });
    for (const id of ids) {
      ws.send({
        type: "update_region",
        id,
        patch: { group_id: groupId },
      });
    }
    ws.send({ type: "undo_group_end" });
    toast(`Grouped ${ids.length} regions.`, { tone: "info", ttl: 2400 });
  }

  /** Clear group_id on every selected region (and every sibling
   *  of those, so "ungroup any member" dissolves the whole group). */
  ungroupSelectedRegions() {
    const ids = [...this._selectedRegionIds];
    if (!ids.length) return;
    const ws = window.__foyer?.ws;
    if (!ws) return;
    // Collapse every selected member's group → set of region ids to
    // clear. Walking the union, not just the selection, so picking
    // one member of a 4-region group dissolves all 4.
    const toClear = new Set();
    for (const id of ids) {
      const r = this._regionForId(id);
      const g = this._groupOf(r);
      if (!g) continue;
      for (const s of this._regionsInGroup(g)) toClear.add(s.id);
    }
    if (!toClear.size) {
      toast("Selected regions aren't in a group.", { tone: "warn" });
      return;
    }
    ws.send({ type: "undo_group_begin", name: "Foyer ungroup regions" });
    for (const id of toClear) {
      // Empty-string sentinel = clear (see RegionPatch.group_id docs).
      ws.send({
        type: "update_region",
        id,
        patch: { group_id: "" },
      });
    }
    ws.send({ type: "undo_group_end" });
    toast(`Ungrouped ${toClear.size} regions.`, { tone: "info", ttl: 2400 });
  }

  /** Stable color from a group_id. Same id → same hue across renders. */
  _colorForGroup(groupId) {
    if (!groupId) return null;
    let h = 0;
    for (let i = 0; i < groupId.length; i++) {
      h = (h * 31 + groupId.charCodeAt(i)) & 0xffff;
    }
    const hue = h % 360;
    return `hsl(${hue}, 78%, 62%)`;
  }

  /**
   * Layer / z-order ops. Per-track operations: compute new layer
   * values for the selected regions relative to their siblings on
   * the same track and emit a single `update_region { layer }`
   * patch per region. `mode` is `"front"`, `"back"`, `"forward"`,
   * or `"backward"`.
   */
  _adjustSelectedRegionLayers(mode) {
    const ws = window.__foyer?.ws;
    if (!ws) {
      toast("Not connected.", { tone: "warn" });
      return;
    }
    // Group by track — layering only makes sense relative to siblings.
    const byTrack = new Map();
    for (const id of this._selectedRegionIds) {
      const r = this._regionForId(id);
      if (!r) continue;
      const list = byTrack.get(r.track_id) || [];
      list.push(r);
      byTrack.set(r.track_id, list);
    }
    if (!byTrack.size) return;
    const labels = {
      front: "Foyer bring to front",
      back: "Foyer send to back",
      forward: "Foyer bring forward",
      backward: "Foyer send backward",
    };
    ws.send({ type: "undo_group_begin", name: labels[mode] || "Foyer layer" });
    for (const [trackId, selectedOnTrack] of byTrack) {
      const all = (this._regionsByTrack[trackId] || []).slice();
      const layerOf = (r) => Number(r.layer) || 0;
      const selIds = new Set(selectedOnTrack.map((r) => r.id));
      const others = all.filter((r) => !selIds.has(r.id));
      let assignments;
      if (mode === "front") {
        // Stack the selection above every non-selected region.
        const top = others.length ? Math.max(...others.map(layerOf)) : 0;
        assignments = selectedOnTrack
          .slice()
          .sort((a, b) => layerOf(a) - layerOf(b))
          .map((r, i) => [r, top + 1 + i]);
      } else if (mode === "back") {
        const bottom = others.length ? Math.min(...others.map(layerOf)) : 0;
        assignments = selectedOnTrack
          .slice()
          .sort((a, b) => layerOf(a) - layerOf(b))
          .map((r, i) => [r, bottom - 1 - (selectedOnTrack.length - 1 - i)]);
      } else if (mode === "forward") {
        // Find each selected region's immediate higher neighbor and
        // bump above it by setting layer = neighbor+1. Works pairwise
        // so a multi-selection bubbles up cleanly without all members
        // landing on the same layer.
        const sorted = all.slice().sort((a, b) => layerOf(a) - layerOf(b));
        const layers = new Map(sorted.map((r) => [r.id, layerOf(r)]));
        const orderIdx = new Map(sorted.map((r, i) => [r.id, i]));
        assignments = [];
        for (const r of selectedOnTrack) {
          const idx = orderIdx.get(r.id);
          if (idx == null || idx >= sorted.length - 1) continue;
          const above = sorted[idx + 1];
          if (selIds.has(above.id)) continue;
          const newLayer = (layers.get(above.id) ?? 0) + 1;
          assignments.push([r, newLayer]);
          layers.set(r.id, newLayer);
        }
      } else if (mode === "backward") {
        const sorted = all.slice().sort((a, b) => layerOf(a) - layerOf(b));
        const layers = new Map(sorted.map((r) => [r.id, layerOf(r)]));
        const orderIdx = new Map(sorted.map((r, i) => [r.id, i]));
        assignments = [];
        for (const r of selectedOnTrack) {
          const idx = orderIdx.get(r.id);
          if (idx == null || idx <= 0) continue;
          const below = sorted[idx - 1];
          if (selIds.has(below.id)) continue;
          const newLayer = (layers.get(below.id) ?? 0) - 1;
          assignments.push([r, newLayer]);
          layers.set(r.id, newLayer);
        }
      }
      // Optimistic local update — patch the region's layer in
      // `_regionsByTrack` immediately so the visual stack reorders
      // on the next render. Without this, the user sees no change
      // until the backend echoes back: stub is fast (~10 ms) but
      // the Ardour shim was previously dropping the field entirely,
      // which made the menu feel broken. Server echo overwrites
      // this on arrival.
      const tracksTouched = new Set();
      for (const [r, newLayer] of assignments || []) {
        if (newLayer === layerOf(r)) continue;
        ws.send({
          type: "update_region",
          id: r.id,
          patch: { layer: newLayer },
        });
        const list = this._regionsByTrack[r.track_id];
        if (list) {
          const idx = list.findIndex((x) => x.id === r.id);
          if (idx >= 0) {
            const copy = list.slice();
            copy[idx] = { ...copy[idx], layer: newLayer };
            this._regionsByTrack = { ...this._regionsByTrack, [r.track_id]: copy };
            tracksTouched.add(r.track_id);
          }
        }
      }
      if (tracksTouched.size) this.requestUpdate();
    }
    ws.send({ type: "undo_group_end" });
  }

  _regionEditMenuActions() {
    const nSel = this._selectedRegionIds.size;
    const combineSel = this._combineRegionSelection();
    const anyAudio = [...this._selectedRegionIds].some((id) => {
      const r = this._regionForId(id);
      return r && this._trackKind(r.track_id) === "audio";
    });
    // Crossfade is available whenever at least one selected audio region
    // overlaps another selected audio region on the same track. The new
    // drag-handle fades produce a crossfade automatically — the menu
    // entry is a one-click "snap fades to the overlap" affordance.
    let canCrossfade = false;
    {
      const seenTracks = new Set();
      for (const id of this._selectedRegionIds) {
        const r = this._regionForId(id);
        if (r) seenTracks.add(r.track_id);
      }
      for (const tid of seenTracks) {
        const pairs = this._overlappingPairsForTrack(tid);
        if (pairs.some((p) =>
          this._selectedRegionIds.has(p.L.id)
          && this._selectedRegionIds.has(p.R.id)
        )) {
          canCrossfade = true;
          break;
        }
      }
    }
    const hasTimeSelection = !!this._selection
      && Math.abs(
        (this._selection.startSamples || 0) - (this._selection.endSamples || 0),
      ) > 0;

    const items = [];
    items.push({
      label: tr("Quantize start to grid"),
      icon: "bars-3-bottom-left",
      disabled: !this._gridStepSamples(),
      action: () => this._quantizeSelectedRegionsToGrid(),
    });
    items.push({
      label: tr("Crop to time selection"),
      icon: "scissors",
      disabled: !hasTimeSelection || nSel === 0,
      title: !hasTimeSelection
        ? tr("Drag a range on the ruler to enable.")
        : tr("Replace each selected region with the slice inside the time selection."),
      action: () => this.cropSelectedRegionsToSelection(),
    });
    items.push({
      label: tr("Snap fades to overlap (crossfade)"),
      icon: "arrows-pointing-in",
      disabled: !canCrossfade,
      title: canCrossfade
        ? tr("Set symmetric fades across every overlap among the selected audio regions.")
        : tr("Drag two audio regions on the same track so they share time."),
      action: () => this._applyCrossfadeToSelection(),
    });
    items.push({
      label: tr("Clear fades"),
      icon: "x-mark",
      disabled: !anyAudio,
      title: anyAudio
        ? tr("Remove fade-in and fade-out from every selected audio region.")
        : tr("Select at least one audio region."),
      action: () => {
        const ws = window.__foyer?.ws;
        if (!ws) return;
        ws.send({ type: "undo_group_begin", name: "Foyer clear fades" });
        for (const id of this._selectedRegionIds) {
          const r = this._regionForId(id);
          if (!r || this._trackKind(r.track_id) !== "audio") continue;
          ws.send({
            type: "update_region",
            id: r.id,
            patch: { fade_in_samples: 0, fade_out_samples: 0 },
          });
        }
        ws.send({ type: "undo_group_end" });
      },
    });
    items.push({
      label: tr("Reset region gain to 0 dB"),
      icon: "speaker-wave",
      disabled: !anyAudio,
      title: anyAudio
        ? tr("Restore unity gain (scale_amplitude = 1.0) on selected audio regions.")
        : tr("Select at least one audio region."),
      action: () => {
        const ws = window.__foyer?.ws;
        if (!ws) return;
        ws.send({ type: "undo_group_begin", name: "Foyer reset region gain" });
        for (const id of this._selectedRegionIds) {
          const r = this._regionForId(id);
          if (!r || this._trackKind(r.track_id) !== "audio") continue;
          ws.send({
            type: "update_region",
            id: r.id,
            patch: { gain_linear: 1 },
          });
        }
        ws.send({ type: "undo_group_end" });
      },
    });
    if (combineSel) {
      items.push({ separator: true });
      items.push({
        label: tr("Glue regions"),
        icon: "circle-stack",
        disabled: false,
        title: tr("Combine selected regions on this track into one (Ardour playlist combine)."),
        action: () => this._combineSelectedRegions(),
      });
    }
    items.push({ separator: true });
    items.push({
      label: tr("Reverse audio"),
      icon: "arrow-uturn-left",
      disabled: !anyAudio,
      title: anyAudio
        ? tr("Reverse each selected audio region in time.")
        : tr("Select at least one audio region."),
      action: () => this._reverseSelectedAudioRegions(),
    });
    items.push({
      label: tr("Strip silence…"),
      icon: "scissors",
      disabled: !anyAudio,
      title: anyAudio
        ? tr("Detect silence and remove it (uses default threshold / fade; Ardour strip silence).")
        : tr("Select at least one audio region."),
      action: () => this._stripSilenceSelectedAudioRegions(),
    });
    items.push({
      label: tr("Pitch shift…"),
      icon: "musical-note",
      disabled: nSel === 0,
      title:
        nSel === 0
          ? tr("Select a region.")
          : tr("Shift pitch for audio (Rubber Band) or transpose MIDI notes."),
      action: () => this._pitchShiftSelectedRegions(),
    });
    items.push({ separator: true });
    // Region groups
    {
      const anyGrouped = [...this._selectedRegionIds].some((id) => {
        const r = this._regionForId(id);
        return !!this._groupOf(r);
      });
      items.push({
        label: anyGrouped ? tr("Add to group") : tr("Group regions"),
        icon: "link",
        disabled: nSel < 2,
        title: nSel < 2
          ? tr("Pick two or more regions to link them.")
          : anyGrouped
            ? tr("Extend the existing group with the newly-selected regions.")
            : tr("Link selected regions so move / trim / fade / delete cascades to siblings."),
        action: () => this.groupSelectedRegions(),
      });
      items.push({
        label: tr("Ungroup"),
        icon: "no-symbol",
        disabled: !anyGrouped,
        title: anyGrouped
          ? tr("Dissolve the group(s) the selection belongs to.")
          : tr("No grouped region in the selection."),
        action: () => this.ungroupSelectedRegions(),
      });
    }
    items.push({ separator: true });
    items.push({
      label: tr("Bring to front"),
      icon: "arrow-up",
      disabled: nSel === 0,
      title: tr("Stack selected regions above every other region on their track."),
      action: () => this._adjustSelectedRegionLayers("front"),
    });
    items.push({
      label: tr("Bring forward"),
      icon: "chevron-up",
      disabled: nSel === 0,
      title: tr("Move selected regions one layer above the next neighbor."),
      action: () => this._adjustSelectedRegionLayers("forward"),
    });
    items.push({
      label: tr("Send backward"),
      icon: "chevron-down",
      disabled: nSel === 0,
      title: tr("Move selected regions one layer below the previous neighbor."),
      action: () => this._adjustSelectedRegionLayers("backward"),
    });
    items.push({
      label: tr("Send to back"),
      icon: "arrow-down",
      disabled: nSel === 0,
      title: tr("Stack selected regions below every other region on their track."),
      action: () => this._adjustSelectedRegionLayers("back"),
    });
    return items;
  }

  _renderSnapMenu() {
    const p = this._snapPrefs || defaultSnapPrefs();
    const toggle = (key) => (ev) => {
      const on = !!ev.target.checked;
      this._snapPrefs = { ...this._snapPrefs, [key]: on };
      this._persistSnapPrefs();
      this.requestUpdate();
    };
    return html`
      <details class="tb-menu" @click=${(e) => e.stopPropagation()}>
        <summary>${icon("arrows-pointing-in", 12)}<span>Snap</span></summary>
        <div class="tb-panel" @click=${(e) => e.stopPropagation()}>
          <div class="tb-row">
            <label><input type="checkbox" .checked=${p.grid}
              @change=${toggle("grid")}> Quant grid</label>
          </div>
          <div class="tb-row">
            <label><input type="checkbox" .checked=${p.regionEdges}
              @change=${toggle("regionEdges")}> Region starts / ends</label>
          </div>
          <div class="tb-row">
            <label><input type="checkbox" .checked=${p.markers}
              @change=${toggle("markers")}> Markers</label>
          </div>
          <div class="tb-row">
            <label><input type="checkbox" .checked=${p.playhead}
              @change=${toggle("playhead")}> Playhead</label>
          </div>
          <div class="tb-hint">
            Hold <kbd>Alt</kbd> while dragging a region to bypass magnetic snap.
            Marker snapping activates when the session exposes markers.
          </div>
        </div>
      </details>
    `;
  }

  _quantSubdivSummaryLabel() {
    const d = this._quantDiv;
    const hit = QUANT_SUBDIV_OPTIONS.find((o) => o.v === d);
    return hit?.label ?? "1/16";
  }

  _renderQuantSubdivMenu() {
    const d = this._quantDiv;
    const onPick = (v) => (ev) => {
      if (!ev.target.checked) {
        ev.target.checked = true;
        return;
      }
      this._setQuantDiv(v);
      const det = ev.target.closest("details");
      if (det) det.open = false;
      this.requestUpdate();
    };
    return html`
      <details class="tb-menu" @click=${(e) => e.stopPropagation()}>
        <summary title="Beat subdivision (per quarter): magnetic snap, region quantize, and BPM quant grid when on in Viz">
          ${icon("squares-2x2", 12)}<span>${this._quantSubdivSummaryLabel()}</span>
        </summary>
        <div class="tb-panel" @click=${(e) => e.stopPropagation()}>
          ${QUANT_SUBDIV_OPTIONS.map(
            (o) => html`
              <div class="tb-row">
                <label><input type="checkbox" .checked=${d === o.v} @change=${onPick(o.v)}> ${o.label}</label>
              </div>
            `,
          )}
          <div class="tb-hint">Same step as magnetic snap (Quant grid) and region quantize.</div>
        </div>
      </details>
    `;
  }

  _renderRegionToolsMenu() {
    const has = this._selectedRegionIds.size > 0;
    if (!has) return null;
    const nSel = this._selectedRegionIds.size;
    const combineSel = this._combineRegionSelection();
    const anyAudio = [...this._selectedRegionIds].some((id) => {
      const r = this._regionForId(id);
      return r && this._trackKind(r.track_id) === "audio";
    });
    const hasTimeSelection = !!this._selection
      && Math.abs(
        (this._selection.startSamples || 0) - (this._selection.endSamples || 0),
      ) > 0;

    return html`
      <details class="tb-menu" @click=${(e) => e.stopPropagation()}>
        <summary>${icon("square-3-stack-3d", 12)}<span>Regions</span></summary>
        <div class="tb-panel" @click=${(e) => e.stopPropagation()}>
          <button class="mi" ?disabled=${!this._gridStepSamples()}
            @click=${() => this._quantizeSelectedRegionsToGrid()}>
            Quantize start to grid
          </button>
          <button class="mi" ?disabled=${!hasTimeSelection || nSel === 0}
            title=${!hasTimeSelection
              ? "Drag a range on the ruler to enable."
              : "Replace each selected region with the slice inside the range."}
            @click=${() => this.cropSelectedRegionsToSelection()}>
            Crop to time selection
          </button>
          <button class="mi" ?disabled=${!anyAudio}
            title="Set symmetric fades across any overlap among the selected audio regions."
            @click=${() => this._applyCrossfadeToSelection()}>
            Snap fades to overlap
          </button>
          <button class="mi" ?disabled=${!anyAudio}
            title="Drag the triangle handles on the lozenge corners to shape fades. Hold Alt while dragging to cycle shape."
            @click=${() => {
              const ws = window.__foyer?.ws;
              if (!ws) return;
              ws.send({ type: "undo_group_begin", name: "Foyer clear fades" });
              for (const id of this._selectedRegionIds) {
                const r = this._regionForId(id);
                if (!r || this._trackKind(r.track_id) !== "audio") continue;
                ws.send({ type: "update_region", id: r.id, patch: { fade_in_samples: 0, fade_out_samples: 0 } });
              }
              ws.send({ type: "undo_group_end" });
            }}>
            Clear fades
          </button>
          ${combineSel
            ? html`
              <button
                class="mi"
                title="Combine selected regions on this track (timeline order)."
                @click=${() => this._combineSelectedRegions()}
              >
                Glue regions
              </button>
            `
            : null}
          <button
            class="mi"
            ?disabled=${!anyAudio}
            title=${!anyAudio
              ? "Select at least one audio region."
              : "Reverse each selected audio region in time."}
            @click=${() => this._reverseSelectedAudioRegions()}
          >
            Reverse audio
          </button>
          <button
            class="mi"
            ?disabled=${!anyAudio}
            title=${!anyAudio
              ? "Select at least one audio region."
              : "Remove silence using default detection settings."}
            @click=${() => this._stripSilenceSelectedAudioRegions()}
          >
            Strip silence…
          </button>
          <button
            class="mi"
            ?disabled=${nSel === 0}
            title=${nSel === 0
              ? "Select a region."
              : "Prompt for semitones; audio uses Rubber Band, MIDI transposes notes."}
            @click=${() => this._pitchShiftSelectedRegions()}
          >
            Pitch shift…
          </button>
          <div class="tb-hint">
            Drag the triangle handles to set fades. <kbd>Alt</kbd>+drag rotates
            shape. <kbd>Shift</kbd>+click clears. Top strip = region gain.
          </div>
        </div>
      </details>
    `;
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
    // Prefer the audio-derived position when available — it tracks
    // the speaker output rather than the control-plane echo, so the
    // visible playhead lines up with what the user is hearing
    // instead of leading by 200–400 ms (encode + WS hop + jitter
    // buffer + worklet quantum). Falls back to control-plane
    // `_playheadSamples` when the audio path isn't running.
    const audio = globalThis.__foyer?.audioClock?.derivedPositionSamples?.();
    const samples = (Number.isFinite(audio) && audio != null)
      ? audio : this._playheadSamples;
    const x = HEAD_WIDTH + (samples / sr) * this._zoom;
    return html`<div class="playhead" style="left:${x}px"></div>`;
  }

  /** Pixels for the live recording span (punch-in cursor → playhead), or null. */
  _recordingSpanPixels(controls) {
    if (!controls || !controls.get("transport.recording")) return null;
    // Only render while transport is actually advancing. If the user
    // is record-armed but paused (or just rewound), there's no
    // in-progress take to visualise — a stale anchor + a rewound
    // playhead would otherwise produce a bar stretching from 0 to
    // wherever the user last recorded, which reads as "we're
    // recording the whole timeline" (reported 2026-05-08).
    if (!controls.get("transport.playing")) {
      this._recordingAnchorSamples = null;
      return null;
    }
    const sr = this._sampleRate();
    this._syncRecordingAnchor();
    let recStart = this._recordingAnchorSamples;
    if (!Number.isFinite(recStart)) recStart = controls.get("transport.record_position");
    if (!Number.isFinite(recStart)) recStart = Math.max(0, this._playheadSamples - sr);
    const playhead = this._playheadSamples;
    // If the playhead is behind the anchor (locate / rewind mid-take),
    // the take we were tracking is over — reset the anchor so the
    // placeholder restarts from the new position rather than
    // back-painting a range we didn't actually record.
    if (Number.isFinite(recStart) && playhead < recStart) {
      this._recordingAnchorSamples = playhead;
      recStart = playhead;
    }
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
    // Sort by (layer ASC, source order) so a later DOM position
    // means a higher layer — the region rendered last paints on
    // top. With per-region `isolation: isolate` (see CSS) this is
    // load-bearing for the layering commands to actually change
    // what the user sees in an overlap.
    const rawRegions = this._regionsByTrack[track.id] || [];
    const regions = [...rawRegions]
      .map((r, i) => [r, i])
      .sort((a, b) => {
        const la = Number(a[0].layer) || 0;
        const lb = Number(b[0].layer) || 0;
        return la - lb || a[1] - b[1];
      })
      .map((pair) => pair[0]);
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
           data-track-id=${track.id}
           @contextmenu=${(e) => this._onLaneContext(e, track)}
           @dragover=${(e) => this._onLaneDragOver(e, track)}
           @dragleave=${(e) => this._onLaneDragLeave(e, track)}
           @drop=${(e) => this._onLaneDrop(e, track)}>
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
                   @click=${(e) => { e.stopPropagation(); this._toggleTrackBool(track.record_arm?.id); }}>●</div>
            ` : html`
              <!-- Placeholder so M/S [R] A stay visually aligned with
                   tracks that DO have a record-arm control (master,
                   buses, MIDI thru). Same flex weight as a real
                   lane-ctl-btn but rendered as an empty box so the
                   user reads "no record arm here" instead of "missing
                   button shifted my layout." -->
              <div class="lane-ctl-btn placeholder" aria-hidden="true"></div>
            `}
            ${(track.automation_lanes && track.automation_lanes.length > 0) ? html`
              <div class="lane-ctl-btn auto ${this._automationOpen(track.id) ? "on" : ""}"
                   title="Toggle automation overlay · double-click to open editor"
                   @click=${(e) => { e.stopPropagation(); this._toggleAutomation(track.id); }}
                   @dblclick=${(e) => { e.stopPropagation(); this._openAutomationModal(track.id); }}>A</div>
            ` : html`
              <div class="lane-ctl-btn placeholder" aria-hidden="true"></div>
            `}
          </div>
        </div>
        ${this._automationOpen(track.id) ? this._renderAutomationOverlay(track, sr, h) : null}
        ${this._eventHeatmapTrackId === track.id
          ? this._renderEventHeatmap(track, regions, sr)
          : null}
        ${repeat(regions, (r) => r.id, (r) => {
          // Keyed render: when the layer-sort reorders this array,
          // Lit physically moves the DOM nodes instead of reusing
          // them positionally. With per-region `isolation: isolate`,
          // DOM order IS paint order, so this is what makes
          // bring-to-front / send-to-back actually move regions in
          // the visual stack rather than just rewriting attrs in
          // place. (Rich, 2026-05-14: layer ops were a no-op without
          // this swap.)
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
          // Audio-only affordances: fades + per-region gain. Skip on
          // MIDI lozenges — Ardour's set_scale_amplitude/set_fade_*
          // aren't meaningful for MIDI regions.
          const fadeOverlay = !isMidi
            ? this._renderRegionFadeOverlay(r, widthPx)
            : null;
          const fadeHandles = !isMidi
            ? this._renderRegionFadeHandles(r, widthPx)
            : null;
          const gainStrip = !isMidi
            ? this._renderRegionGainStrip(r)
            : null;
          const groupId = this._groupOf(r);
          const groupColor = groupId ? this._colorForGroup(groupId) : null;
          const groupBar = groupColor
            ? html`<div class="group-bar" style="background:${groupColor}"
                        title=${`Region group · click any member to select all (Alt+click to break)`}></div>`
            : null;
          return html`
            <div class="region ${regionSelected ? "selected" : ""}" data-id=${r.id}
                 tabindex="0"
                 style="left:${leftPx}px;width:${widthPx}px;top:4px;bottom:4px"
                 @pointerdown=${(e) => {
                   if (e.button === 2) {
                     this._onRegionPointerDownSecondary(e, r);
                     return;
                   }
                   if (e.button !== 0) return;
                   this._onRegionPointerDown(e, r);
                   this._startDrag(e, r, "move");
                 }}
                 @keydown=${(e) => this._onRegionKeydown(e, r)}
                 @dblclick=${(e) => { e.stopPropagation(); this._openRegionEditor(r); }}
                 @contextmenu=${(e) => this._regionContextMenu(e, r)}>
              ${isMidi
                ? html`<foyer-midi-strip class="viz" .notes=${r.notes || []} .region=${r} .color=${track.color || ""}></foyer-midi-strip>`
                : html`<foyer-waveform-gl class="viz" data-id=${r.id}></foyer-waveform-gl>`}
              ${fadeOverlay}
              ${cutOverlay}
              ${groupBar}
              <div class="name">${r.name}</div>
              ${gainStrip}
              ${fadeHandles}
              <div class="edge left"  @pointerdown=${(e) => {
                 if (e.button !== 0) return;
                 this._startDrag(e, r, "resize-left");
               }}></div>
              <div class="edge right" @pointerdown=${(e) => {
                 if (e.button !== 0) return;
                 this._startDrag(e, r, "resize-right");
               }}></div>
            </div>
          `;
        })}
        ${this._renderCrossfadeOverlaysForTrack(track, sr)}
        ${this._renderCrossTrackGhostForLane(track, sr)}
        ${this._renderPoolDropGhostForLane(track, sr)}
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
   * Fade-curve overlay drawn inside the region lozenge. Uses a single
   * SVG so the same coordinate system handles both ends (and so a wide
   * fade-in + wide fade-out can meet in the middle without overdraw).
   *
   * The path covers the still-attenuated portion of the region in a
   * semi-transparent fill; the curve outline runs along the gain
   * envelope. We let the SVG scale to the region's width — the actual
   * shape function is sampled at fixed N points which is fine since
   * regions rarely show <30 px of fade body before a user widens them.
   */
  _renderRegionFadeOverlay(region, widthPx) {
    const inSamples = Math.max(0, Number(region.fade_in_samples) || 0);
    const outSamples = Math.max(0, Number(region.fade_out_samples) || 0);
    if (!inSamples && !outSamples) return null;
    const sr = this._sampleRate();
    const lenSamples = Math.max(1, Number(region.length_samples) || 1);
    const wPx = Math.max(1, widthPx);
    // Render into a fixed-height coordinate so we don't have to know
    // the real region pixel height (CSS scales the SVG). 100 is just
    // a tidy unit count.
    const H = 100;
    const inFracX = Math.min(1, inSamples / lenSamples);
    const outFracX = Math.min(1, outSamples / lenSamples);
    const inPx = wPx * inFracX;
    const outPxStart = wPx * (1 - outFracX);
    // Clamp the two if they collide so the visual matches the playback
    // engine's "no overlap on fade endpoints" contract.
    const clampedInPx = Math.min(inPx, outPxStart);
    const clampedOutStart = Math.max(outPxStart, clampedInPx);
    const samples = 24; // points per curve
    const inShape = region.fade_in_shape || "linear";
    const outShape = region.fade_out_shape || "linear";
    const curve = (shape, t) => {
      // t in [0,1] → gain in [0,1]
      switch (shape) {
        case "fast":           return t * t;
        case "slow":           return Math.sqrt(t);
        case "constant_power": return Math.sin((t * Math.PI) / 2);
        case "symmetric":      return 0.5 - 0.5 * Math.cos(t * Math.PI);
        case "linear":
        default:               return t;
      }
    };
    const sr2 = sr; void sr2; // (kept for future shape-vs-samples tweaks)
    // Build fill polygon over the attenuated regions + outline path.
    let fillPath = "";
    let linePath = "";
    if (inSamples) {
      // Fill: polygon from top-left across the curve down to bottom-left.
      // Line: top-left → curve → (inPx, 0). Coord system: y=0 is top
      // (full gain), y=H is silence.
      const pts = [];
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const gain = curve(inShape, t);
        const x = t * clampedInPx;
        const y = H - gain * H;
        pts.push([x, y]);
      }
      // Fill below the curve (the "silent" wedge that's being faded in)
      // shaded so the user can see the fade extent. The wedge sits
      // between the curve and the LEFT edge of the region.
      fillPath += `M 0 ${H} L 0 0 `;
      for (const [x, y] of pts) fillPath += `L ${x.toFixed(2)} ${y.toFixed(2)} `;
      fillPath += `L 0 ${H} Z `;
      linePath += `M 0 ${H} `;
      for (const [x, y] of pts) linePath += `L ${x.toFixed(2)} ${y.toFixed(2)} `;
    }
    if (outSamples) {
      const pts = [];
      const span = wPx - clampedOutStart;
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        // gain decreases from 1 → 0 across the span.
        const gain = curve(outShape, 1 - t);
        const x = clampedOutStart + t * span;
        const y = H - gain * H;
        pts.push([x, y]);
      }
      fillPath += `M ${wPx.toFixed(2)} ${H} `;
      for (let i = pts.length - 1; i >= 0; i--) {
        const [x, y] = pts[i];
        fillPath += `L ${x.toFixed(2)} ${y.toFixed(2)} `;
      }
      fillPath += `L ${wPx.toFixed(2)} 0 L ${wPx.toFixed(2)} ${H} Z `;
      const start = pts[0];
      linePath += `M ${start[0].toFixed(2)} ${start[1].toFixed(2)} `;
      for (let i = 1; i < pts.length; i++) {
        const [x, y] = pts[i];
        linePath += `L ${x.toFixed(2)} ${y.toFixed(2)} `;
      }
    }
    return html`
      <svg class="fade-svg" viewBox="0 0 ${wPx} ${H}" preserveAspectRatio="none">
        <path class="fade-fill" d=${fillPath}></path>
        <path class="fade-line" d=${linePath}></path>
      </svg>
    `;
  }

  /**
   * Two triangular grab handles, one at each inside-fade endpoint. When
   * no fade exists, the handle sits flush against the corner so the
   * user can drag it inward to create the fade in the first place.
   * Shift-click clears; Alt-drag rotates curve shape mid-drag.
   */
  _renderRegionFadeHandles(region, widthPx) {
    const sr = this._sampleRate();
    const lenSamples = Math.max(1, Number(region.length_samples) || 1);
    const inSamples = Math.max(0, Number(region.fade_in_samples) || 0);
    const outSamples = Math.max(0, Number(region.fade_out_samples) || 0);
    const inPx = Math.max(0, Math.min(widthPx, widthPx * (inSamples / lenSamples)));
    const outPx = Math.max(0, Math.min(widthPx, widthPx * (outSamples / lenSamples)));
    const inActive = inSamples > 0;
    const outActive = outSamples > 0;
    const inLabel = inSamples > 0
      ? `${Math.round((inSamples / sr) * 1000)} ms · ${region.fade_in_shape || "linear"}`
      : "drag inward to fade in";
    const outLabel = outSamples > 0
      ? `${Math.round((outSamples / sr) * 1000)} ms · ${region.fade_out_shape || "linear"}`
      : "drag inward to fade out";
    return html`
      <div class="fade-handle in ${inActive ? "active" : ""}"
           style="left:${inPx}px"
           title=${`Fade in: ${inLabel} — Alt+drag = shape, Shift+click = clear`}
           @pointerdown=${(e) => this._startFadeDrag(e, region, "in")}
           @click=${(e) => {
             if (!e.shiftKey) return;
             e.preventDefault(); e.stopPropagation();
             this._clearFade(region, "in");
           }}></div>
      <div class="fade-handle out ${outActive ? "active" : ""}"
           style="right:${outPx}px"
           title=${`Fade out: ${outLabel} — Alt+drag = shape, Shift+click = clear`}
           @pointerdown=${(e) => this._startFadeDrag(e, region, "out")}
           @click=${(e) => {
             if (!e.shiftKey) return;
             e.preventDefault(); e.stopPropagation();
             this._clearFade(region, "out");
           }}></div>
    `;
  }

  /**
   * Top-edge strip with the region's gain in dB. Hidden until the user
   * hovers the region or the value diverges from unity — keeps the
   * lozenge clean for the common 1.0 case while making non-unity
   * regions visually distinct.
   */
  _renderRegionGainStrip(region) {
    const cur = Number(region.gain_linear);
    const hasGain = Number.isFinite(cur) && cur >= 0;
    const linear = hasGain ? cur : 1;
    const nonUnity = Math.abs(linear - 1) > 1e-3;
    const db = linear <= 0 ? -Infinity : 20 * Math.log10(linear);
    const dbLabel = !Number.isFinite(db)
      ? "−∞ dB"
      : `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`;
    return html`
      <div class="gain-strip ${nonUnity ? "nonunity" : ""}"
           title=${`Region gain: ${dbLabel}. Drag up/down to adjust (Shift = fine). Double-click resets to 0 dB.`}
           @pointerdown=${(e) => this._startGainDrag(e, region)}
           @dblclick=${(e) => { e.stopPropagation(); this._resetGain(region); }}></div>
      ${nonUnity
        ? html`<div class="gain-readout">${dbLabel}</div>`
        : null}
    `;
  }

  /**
   * Crossfade overlays — for every neighboring overlapping pair of
   * audio regions on a track, draw an X curve in the overlap band so
   * the user can see how the mix is going to behave. The curves are
   * derived from the actual `fade_out_samples` / `fade_in_samples` on
   * each region; if the fades don't cover the whole overlap we show
   * a faint guide rect over the orphan band as a hint to snap fades.
   */
  /** Drop-target ghost for a cross-track region drag. Returns
   *  nothing when no drag is in flight or this lane isn't the
   *  destination. Renders a dashed outline lozenge per moving
   *  region at the live preview position so the user can sight
   *  the landing layout before releasing. */
  _renderCrossTrackGhostForLane(track, sr) {
    const ghost = this._crossTrackGhost;
    if (!ghost || ghost.destTrackId !== track.id) return null;
    const tracks = this.session?.tracks || [];
    const srcTrack = tracks.find((t) => t.kind === track.kind);
    return ghost.regions.map((g) => {
      const leftPx = HEAD_WIDTH + (Number(g.startSamples) / sr) * this._zoom;
      const widthPx = Math.max(10, (Number(g.lengthSamples) / sr) * this._zoom);
      return html`
        <div class="cross-track-ghost"
             style="left:${leftPx}px;width:${widthPx}px"
             title=${`Drop onto ${track.name}`}>
          <span class="ghost-label">→ ${track.name}</span>
        </div>
      `;
    });
  }

  /** Ghost preview for an audio-pool drag hovering over this lane.
   *  Reuses the cross-track ghost element style — same dashed
   *  outline + pill label, sized to the source's length and tracking
   *  the live drop position. */
  _renderPoolDropGhostForLane(track, sr) {
    const ghost = this._poolDropGhost;
    if (!ghost || ghost.destTrackId !== track.id) return null;
    const leftPx = HEAD_WIDTH + (Number(ghost.startSamples) / sr) * this._zoom;
    const widthPx = Math.max(10, (Number(ghost.lengthSamples) / sr) * this._zoom);
    return html`
      <div class="cross-track-ghost"
           style="left:${leftPx}px;width:${widthPx}px">
        <span class="ghost-label">+ ${ghost.name || "audio"}</span>
      </div>
    `;
  }

  _renderCrossfadeOverlaysForTrack(track, sr) {
    const pairs = this._overlappingPairsForTrack(track.id);
    if (!pairs.length) return null;
    const out = [];
    const H = 100;
    for (const p of pairs) {
      const overlapStart = Math.max(p.sL, p.sR);
      const overlapEnd = Math.min(p.eL, p.eR);
      const overlapSamples = overlapEnd - overlapStart;
      if (overlapSamples <= 0) continue;
      const leftPx = HEAD_WIDTH + (overlapStart / sr) * this._zoom;
      const widthPx = Math.max(1, (overlapSamples / sr) * this._zoom);
      // Fade lengths inside the overlap. Cap by the overlap so a fade
      // that runs past the overlap doesn't draw outside its bounds.
      const lFadeOut = Math.min(
        overlapSamples,
        Math.max(0, Number(p.L.fade_out_samples) || 0),
      );
      const rFadeIn = Math.min(
        overlapSamples,
        Math.max(0, Number(p.R.fade_in_samples) || 0),
      );
      const lShape = p.L.fade_out_shape || "linear";
      const rShape = p.R.fade_in_shape || "linear";
      const curve = (shape, t) => {
        switch (shape) {
          case "fast":           return t * t;
          case "slow":           return Math.sqrt(t);
          case "constant_power": return Math.sin((t * Math.PI) / 2);
          case "symmetric":      return 0.5 - 0.5 * Math.cos(t * Math.PI);
          case "linear":
          default:               return t;
        }
      };
      const samples = 24;
      // Left region's fade-out: gain goes 1→0 across lFadeOut samples,
      // anchored at the overlap start (where L's fade-out begins
      // depends on the offset from the L-end → overlap start, but for
      // a clean visual we anchor it from `overlapEnd − lFadeOut` since
      // Ardour's playlist places the fade-out at the tail). Drop to
      // overlap-start when the fade is wider than the overlap.
      let lOutPath = "";
      if (lFadeOut > 0) {
        const fadeStartSample = Math.max(0, overlapSamples - lFadeOut);
        const fadeSpan = overlapSamples - fadeStartSample;
        const pts = [];
        for (let i = 0; i <= samples; i++) {
          const t = i / samples;
          const sampleOffset = fadeStartSample + t * fadeSpan;
          const gain = curve(lShape, 1 - t);
          const x = (sampleOffset / overlapSamples) * widthPx;
          const y = H - gain * H;
          pts.push([x, y]);
        }
        lOutPath += `M 0 0 L ${pts[0][0].toFixed(2)} 0 `;
        for (const [x, y] of pts) lOutPath += `L ${x.toFixed(2)} ${y.toFixed(2)} `;
      }
      let rInPath = "";
      if (rFadeIn > 0) {
        const fadeSpan = rFadeIn;
        const pts = [];
        for (let i = 0; i <= samples; i++) {
          const t = i / samples;
          const sampleOffset = t * fadeSpan;
          const gain = curve(rShape, t);
          const x = (sampleOffset / overlapSamples) * widthPx;
          const y = H - gain * H;
          pts.push([x, y]);
        }
        rInPath += "";
        for (let i = 0; i < pts.length; i++) {
          const [x, y] = pts[i];
          rInPath += i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)} ` : `L ${x.toFixed(2)} ${y.toFixed(2)} `;
        }
      }
      // Diagonal-hatch fill for the overlap zone — gives the band a
      // distinct visual identity even when both regions paint the
      // same waveform underneath. Color cue: white-on-dark when fades
      // cover the whole overlap (clean crossfade), amber when there's
      // a gap (call-to-action: "Snap fades to overlap").
      const incomplete = (lFadeOut < overlapSamples) || (rFadeIn < overlapSamples);
      // Pattern id has to be unique per overlap or two SVGs in the
      // same lane share the same defs and one wins.
      const patternId = `xfade-hatch-${p.L.id}-${p.R.id}`.replace(/[^a-zA-Z0-9_-]/g, "_");
      const hatchColor = incomplete ? "rgba(255, 209, 102, 0.45)" : "rgba(255, 255, 255, 0.32)";
      const overlapMs = Math.max(1, Math.round((overlapSamples / sr) * 1000));
      const badgeLabel = `${p.L.name} ⟷ ${p.R.name} · ${overlapMs} ms`;
      out.push(html`
        <svg class="crossfade-svg"
             style="left:${leftPx}px;top:4px;height:calc(100% - 8px);width:${widthPx}px"
             viewBox="0 0 ${widthPx} ${H}"
             preserveAspectRatio="none">
          <defs>
            <pattern id=${patternId}
                     patternUnits="userSpaceOnUse"
                     width="8" height="8"
                     patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="8" stroke=${hatchColor} stroke-width="2"></line>
            </pattern>
          </defs>
          <rect class="xfade-zone ${incomplete ? "incomplete" : ""}"
                x="0" y="0" width=${widthPx} height=${H}
                fill="url(#${patternId})"></rect>
          ${lOutPath ? html`<path class="xfade-line-out" d=${lOutPath}></path>` : null}
          ${rInPath ? html`<path class="xfade-line-in" d=${rInPath}></path>` : null}
        </svg>
        <div class="crossfade-badge ${incomplete ? "incomplete" : ""}"
             style="left:${leftPx + widthPx / 2}px;transform:translate(-50%, -100%)">
          ${badgeLabel}
        </div>
      `);
    }
    return out;
  }

  /**
   * Stable color from an automation lane's control_id. Reuses the
   * group-color hash with a different seed so automation lines and
   * region group bars sit in distinct palette bands.
   */
  _colorForAutomationLane(controlId) {
    if (!controlId) return "var(--color-accent)";
    // Core lanes get fixed palette positions so users build muscle
    // memory across sessions (Gain = orange, Pan = teal, etc.).
    const suffix = String(controlId).split(".").pop();
    const fixed = {
      gain: "#f59e0b",
      pan: "#22d3ee",
      mute: "#fbbf24",
      solo: "#f87171",
    };
    if (fixed[suffix]) return fixed[suffix];
    let h = 1234;
    for (let i = 0; i < controlId.length; i++) {
      h = (h * 31 + controlId.charCodeAt(i)) & 0xffff;
    }
    return `hsl(${h % 360}, 70%, 60%)`;
  }

  /**
   * Automation overlay — color-coded polylines drawn ON TOP of the
   * region row (one per active automation lane on the track). Lines
   * span the lane's full height between the ruler and the lane-resize
   * grip so curves are readable even at thin lane heights.
   *
   * Distinct from the lane-stack model: no extra vertical space
   * eaten under the regions. Hover surfaces a label tooltip with
   * `Track → Control` so multiple lines on one track stay legible.
   * Click any line opens the automation modal scoped to that lane.
   *
   * Opacity + stroke width come from the viz prefs
   * (`automationOverlayAlpha`, `automationOverlayWidth`) so users
   * can dial the overlay into the background without disabling it
   * entirely.
   */
  _renderAutomationOverlay(track, sr, laneHeight) {
    const lanes = track.automation_lanes || [];
    if (!lanes.length) return null;
    const totalSamples = Math.max(1, Number(this._timeline?.length_samples) || sr * 60);
    const prefs = getVizPrefs();
    const alpha = Number.isFinite(prefs?.automationOverlayAlpha)
      ? prefs.automationOverlayAlpha
      : 0.7;
    const strokeWidth = Number.isFinite(prefs?.automationOverlayWidth)
      ? prefs.automationOverlayWidth
      : 1.5;
    // Total content width in px = HEAD_WIDTH gap + timeline px.
    const contentWidth = (totalSamples / sr) * this._zoom;
    // Lane SVG sits inside the lane content area (after HEAD_WIDTH).
    // Height matches the lane minus its top/bottom region padding so
    // a polyline that hits gain=1 lines up visually with the top of
    // the region row.
    const H = Math.max(20, laneHeight - 8);
    // Per-control y-range mapping. Core controls use the same ranges
    // the inline lane editor exposes; everything else falls back to
    // 0..1.
    const META = {
      gain:  { min: -60, max: 6 },
      pan:   { min: -1,  max: 1 },
      mute:  { min: 0,   max: 1 },
      solo:  { min: 0,   max: 1 },
    };
    const pathFor = (lane) => {
      const pts = lane.points || [];
      if (!pts.length) return "";
      const suffix = String(lane.control_id || "").split(".").pop();
      const m = META[suffix] || { min: 0, max: 1 };
      const range = m.max - m.min || 1;
      let d = "";
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const x = (Number(p.time_samples) / totalSamples) * contentWidth;
        const norm = (Number(p.value) - m.min) / range;
        const y = H - Math.max(0, Math.min(1, norm)) * H;
        d += i === 0
          ? `M ${x.toFixed(2)} ${y.toFixed(2)} `
          : `L ${x.toFixed(2)} ${y.toFixed(2)} `;
      }
      return d;
    };
    const paths = [];
    // Skip lanes that are inert — Off mode and no points means the
    // user hasn't engaged this control yet. The stub seeds an empty
    // AutomationLane per Parameter (including every plugin param)
    // so the wire commands have a target to mutate; if we paint a
    // polyline for each one we'd draw 80+ idle paths per track and
    // bury the active automations.
    const activeLanes = lanes.filter((l) =>
      (l.points || []).length > 0
      || String(l.mode || "off").toLowerCase() !== "off"
    );
    for (const lane of activeLanes) {
      const d = pathFor(lane);
      const suffix = String(lane.control_id || "").split(".").pop();
      const color = this._colorForAutomationLane(lane.control_id);
      const labelText = `${track.name} → ${suffix}`;
      paths.push(html`
        <path d=${d}
              fill="none"
              stroke=${color}
              stroke-width=${strokeWidth}
              stroke-linecap="round"
              stroke-linejoin="round"
              opacity=${alpha}
              vector-effect="non-scaling-stroke"
              style="pointer-events:stroke;cursor:pointer"
              @click=${(e) => {
                e.stopPropagation();
                this._openAutomationModal(track.id, lane.control_id);
              }}
              @pointerenter=${(e) => {
                e.currentTarget.setAttribute("stroke-width", String(strokeWidth + 1));
                e.currentTarget.setAttribute("opacity", "1");
              }}
              @pointerleave=${(e) => {
                e.currentTarget.setAttribute("stroke-width", String(strokeWidth));
                e.currentTarget.setAttribute("opacity", String(alpha));
              }}>
          <title>${labelText}</title>
        </path>
      `);
    }
    return html`
      <svg class="automation-overlay"
           style="left:${HEAD_WIDTH}px;top:4px;width:${contentWidth}px;height:${H}px"
           viewBox="0 0 ${contentWidth} ${H}"
           preserveAspectRatio="none">
        ${paths}
      </svg>
    `;
  }

  /**
   * Event-density strip across a track's lane. Bins time into ~120
   * columns spanning the rendered timeline width and colors each
   * bin by the count of regions (or, for MIDI regions, embedded
   * notes) that fall within it. Hidden by default; the headless
   * `visualize.event_heatmap` path turns it on via
   * `setEventHeatmap(trackId)` so the screenshot has a clear
   * "events on track X" presentation overlayed on the timeline.
   */
  _renderEventHeatmap(track, regions, sr) {
    if (!sr || !regions) return null;
    const totalSamples = Math.max(
      1,
      Number(this._timeline?.length_samples) || sr * 60,
    );
    const baseSec = Math.max(30, totalSamples / sr);
    const totalSec = Math.max(baseSec, this._zoomPadSec || 0);
    const contentWidth = Math.max(1, totalSec * this._zoom);
    const BIN_COUNT = 120;
    const binSamples = totalSamples / BIN_COUNT;
    const counts = new Array(BIN_COUNT).fill(0);
    // For audio regions count region presence; for MIDI regions
    // count embedded notes (more meaningful "events on track over
    // time"). MIDI note arrays live on `region.notes` when the
    // backend ships them inline; fall back to region density when
    // the array is absent.
    for (const r of regions || []) {
      const start = Number(r.start_samples) || 0;
      const len = Number(r.length_samples) || 0;
      if (Array.isArray(r.notes) && r.notes.length) {
        for (const n of r.notes) {
          const t = start + (Number(n.time_samples) || 0);
          const bin = Math.min(BIN_COUNT - 1, Math.floor(t / binSamples));
          if (bin >= 0) counts[bin] += 1;
        }
      } else {
        const a = Math.floor(start / binSamples);
        const b = Math.min(
          BIN_COUNT - 1,
          Math.floor((start + len) / binSamples),
        );
        for (let i = Math.max(0, a); i <= b; i += 1) counts[i] += 1;
      }
    }
    const maxCount = counts.reduce((m, c) => (c > m ? c : m), 0) || 1;
    const STRIP_H = 18;
    const rects = counts.map((c, i) => {
      if (c <= 0) return null;
      const x = (i * contentWidth) / BIN_COUNT;
      const w = Math.max(1, contentWidth / BIN_COUNT - 0.5);
      const t = c / maxCount;
      // accent → warm gradient: cool blue at low density, hot
      // orange at peak. opacity scales with density so empty-ish
      // tracks stay readable.
      const hue = Math.round(220 - t * 200); // 220 (cool) → 20 (warm)
      const sat = 90;
      const lit = Math.round(60 - t * 25);
      const op = 0.35 + t * 0.55;
      return html`<rect x=${x.toFixed(1)} y="0" width=${w.toFixed(1)}
                        height=${STRIP_H} fill=${`hsl(${hue} ${sat}% ${lit}%)`}
                        opacity=${op.toFixed(2)} />`;
    });
    return html`
      <svg class="event-heatmap-overlay"
           style="left:${HEAD_WIDTH}px;top:0px;width:${contentWidth}px;height:${STRIP_H}px;position:absolute;pointer-events:none;z-index:6"
           viewBox="0 0 ${contentWidth} ${STRIP_H}"
           preserveAspectRatio="none">
        <rect x="0" y="0" width=${contentWidth} height=${STRIP_H}
              fill="rgba(0,0,0,0.35)" />
        ${rects}
        <text x="6" y="13" font-size="10" font-weight="600"
              fill="rgba(255,255,255,0.85)"
              style="font-family:var(--font-mono);letter-spacing:0.04em">
          EVENTS · ${track.name} · max ${maxCount}/bin
        </text>
      </svg>
    `;
  }

  /**
   * Open the automation editor modal scoped to a track (and an
   * optional initial control_id to focus). Lazy-loads the modal
   * module so the timeline boot stays light.
   */
  _openAutomationModal(trackId, focusControlId) {
    import("./automation-modal.js").then((m) => {
      m.openAutomationModal({ trackId, focusControlId });
    });
  }

  /**
   * Mouse-wheel zoom. The keymap profile (Preferences → Editor conventions)
   * decides what plain/shift/ctrl/alt + wheel means in this zone. Default
   * (Foyer / Ardour) is plain=zoom-at-cursor, shift/ctrl=hpan, alt=vzoom.
   *
   * We only preventDefault when we actually consume the event so a "vscroll"
   * op falls through to the browser's native scroll on the ancestor.
   */
  _onWheel(ev) {
    const dy = ev.deltaY;
    const dx = ev.deltaX || 0;
    if (!dy && !dx) return;
    // Wheel over the sticky lane-head column should scroll the
    // track list vertically — Rich's report 2026-04-21: "should do
    // vertical scrolling, not timeline zoom" when the pointer is
    // over the labels. Hold Shift to override and zoom from the
    // lane-head (matches "modifier to scroll a long list" ask).
    const overHead = !!ev.target?.closest?.(".lane-head");
    if (overHead && !ev.shiftKey) {
      return;
    }
    const op = resolveWheel("timeline_main", ev);
    if (op === "vzoom") {
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
      requestAnimationFrame(() => this._repaintWaveforms());
      return;
    }
    if (op === "hscroll") {
      ev.preventDefault();
      const scroll = ev.currentTarget;
      const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      scroll.scrollLeft = Math.max(0, scroll.scrollLeft + delta);
      return;
    }
    if (op === "vscroll" || op === "none") {
      // Yield to the browser's native vertical scroll on the .scroll ancestor.
      return;
    }
    // op === "hzoom" — fall through into the temporal-zoom path below.
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
    const factor = zoomFactorFromWheel(dy);
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
    const nHead = this._selectedRegionIds.size;
    const multiHead =
      nHead > 1 && this._selectedRegionIds.has(region.id);
    const items = [
      {
        heading: multiHead
          ? tr("%{count} regions", { count: nHead })
          : (region.name || region.id),
      },
      {
        label: region.muted ? tr("Unmute") : tr("Mute"),
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
        label: active ? tr("Open piano roll (read-only)…") : tr("Open piano roll…"),
        icon: "sparkles",
        action: () => this._openMidiEditor(region),
      });
      items.push({
        label: active ? tr("Open beat sequencer…")
             : archived ? tr("Restore beat sequencer…")
             : tr("Convert to beat sequencer…"),
        icon: "queue-list",
        action: () => this._openBeatSequencer(region),
      });
    }
    items.push({ separator: true });
    items.push({
      label: tr("Automation editor…"),
      icon: "chart-bar",
      title: tr("Open the full-screen automation editor for this region's track."),
      action: () => this._openAutomationModal(region.track_id),
    });
    items.push({ separator: true });
    items.push(...this._regionEditMenuActions());
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
      label: tr("Cut"),
      icon: "scissors",
      shortcut: `${meta}+X`,
      action: () => { ensureSelection(); this.cutRegionSelection(); },
    });
    items.push({
      label: tr("Copy"),
      icon: "document-duplicate",
      shortcut: `${meta}+C`,
      action: () => { ensureSelection(); this.copyRegionSelection(); },
    });
    items.push({
      label: tr("Paste at cursor"),
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
      label: tr("Paste at playhead"),
      icon: "clipboard",
      shortcut: `${meta}+Shift+V`,
      disabled: !this.hasClipboard(),
      action: () => this.pasteRegions({ at: "playhead" }),
    });
    items.push({
      label: tr("Duplicate"),
      icon: "plus",
      shortcut: `${meta}+D`,
      action: () => { ensureSelection(); this.duplicateRegionSelection(); },
    });
    items.push({ separator: true });
    items.push({
      label: tr("Delete region"),
      icon: "trash",
      tone: "danger",
      shortcut: "Del",
      action: () => {
        ensureSelection();
        this.deleteSelectedRegions();
      },
    });
    showContextMenu(ev, items);
  }

  /** Platform meta-key glyph for menu hints. Mac → ⌘, else → Ctrl. */
  _metaChord() {
    return navigator.platform?.startsWith?.("Mac") ? "⌘" : "Ctrl";
  }

  /** Right-click before context menu: never collapse a multi-selection. */
  _onRegionPointerDownSecondary(ev, region) {
    if (ev.button !== 2 || !region?.id) return;
    if (this._selectedRegionIds.has(region.id)) return;
    this._selectedRegionIds.clear();
    this._selectedRegionIds.add(region.id);
    this._pendingDemoteRegionId = null;
    this._reconcileCutPending();
    this.requestUpdate();
  }

  /// Region-element keydown. Regions are tab-stops (`tabindex="0"`)
  /// so a keyboard-only user can step through them with Tab; this
  /// handler then turns Enter into a select (replace) and Ctrl/Cmd+
  /// Enter into a toggle (additive multi-select). Delete still flows
  /// through the global keybinds handler because we want it to act
  /// on the click-selection set, which already includes whatever the
  /// user just selected via these keys.
  _onRegionKeydown(ev, region) {
    if (!region?.id) return;
    if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.ctrlKey || ev.metaKey) {
        // Additive toggle — Ctrl+Enter on an already-selected region
        // removes it from the set, otherwise adds it. Matches
        // pointer-down's shift/ctrl behavior so muscle memory carries
        // over between mouse + keyboard flows.
        if (this._selectedRegionIds.has(region.id)) {
          this._selectedRegionIds.delete(region.id);
        } else {
          this._selectedRegionIds.add(region.id);
        }
      } else {
        this._selectedRegionIds.clear();
        const g = this._groupOf(region);
        if (g) {
          for (const s of this._regionsInGroup(g)) this._selectedRegionIds.add(s.id);
        } else {
          this._selectedRegionIds.add(region.id);
        }
      }
      this._pendingDemoteRegionId = null;
      this._reconcileCutPending();
      this.requestUpdate();
    }
  }

  _onRegionPointerDown(ev, region) {
    if (ev.button !== 0 || !region?.id) return;
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
    // collapse to just this region — UNLESS it's a member of a region
    // group, in which case selection fans out to every sibling so
    // subsequent edits (drag, trim, fade, delete) act on the group as
    // a unit. Hold Alt to break the link for this click and pick a
    // single grouped region.
    this._selectedRegionIds.clear();
    const g = this._groupOf(region);
    if (g && !ev.altKey) {
      for (const s of this._regionsInGroup(g)) {
        this._selectedRegionIds.add(s.id);
      }
    } else {
      this._selectedRegionIds.add(region.id);
    }
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
        viewKind: "midi-editor",
        viewProps: { regionId: region?.id, trackId },
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
   * Wheel over the ruler. Default profile scrolls horizontally (the ruler is a
   * navigation surface, not a zoom one), but Pro Tools / Cubase users expect
   * Ctrl-wheel here to zoom in at the cursor — the keymap profile decides.
   * Stop propagation so the outer `.scroll` wheel handler doesn't double-fire.
   */
  _onRulerWheel(ev) {
    const scroll = this.renderRoot.querySelector(".scroll");
    if (!scroll) return;
    const dx = ev.deltaX || 0;
    const dy = ev.deltaY || 0;
    if (!dx && !dy) return;
    const op = resolveWheel("timeline_ruler", ev);
    if (op === "hzoom") {
      // Anchor zoom around the pointer's current time.
      ev.preventDefault();
      ev.stopPropagation();
      const bounds = scroll.getBoundingClientRect();
      const pointerScreenX = ev.clientX - bounds.left;
      const pointerContentX = pointerScreenX + scroll.scrollLeft - HEAD_WIDTH;
      const t0 = pointerContentX / this._zoom;
      const factor = zoomFactorFromWheel(dy);
      const next = Math.max(2, Math.min(4000, Math.round(this._zoom * factor)));
      if (next === this._zoom) return;
      this._zoom = next;
      const newPointerContentX = t0 * next;
      const targetScrollLeft = newPointerContentX - (pointerScreenX - HEAD_WIDTH);
      requestAnimationFrame(() => { scroll.scrollLeft = Math.max(0, targetScrollLeft); });
      return;
    }
    if (op === "vscroll" || op === "none") {
      return;  // yield to the browser
    }
    // "hscroll" (default) — what the ruler historically did.
    ev.preventDefault();
    ev.stopPropagation();
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

  /**
   * Middle-click + drag inside the scroll area = grab-pan in BOTH
   * axes — `clientX` delta drives `scrollLeft` (time), `clientY`
   * delta drives `scrollTop` (track list). Mirrors the gesture every
   * other DAW timeline + most maps / image viewers use.
   *
   * Only fires for `button === 1`; left/right clicks fall through to
   * region drag, marquee select, context menu, etc. The cursor
   * flips to `grabbing` for the duration so the user has visual
   * feedback that they're in pan mode (otherwise a slow drag with no
   * visible change reads as "did the click register?").
   *
   * `auxclick` and `pointerdown` both `preventDefault` the middle
   * button so the browser doesn't pop its native auto-scroll widget
   * (the round dot anchor that hijacks the cursor until you click
   * again — useless here and confusing next to our own pan).
   */
  _onScrollPointerDown(ev) {
    if (ev.button !== 1) return;
    const scroll = ev.currentTarget;
    if (!scroll) return;
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const origLeft = scroll.scrollLeft;
    const origTop = scroll.scrollTop;
    try { scroll.setPointerCapture?.(ev.pointerId); } catch {}
    const prevCursor = scroll.style.cursor;
    scroll.style.cursor = "grabbing";
    const move = (e) => {
      scroll.scrollLeft = origLeft - (e.clientX - startX);
      scroll.scrollTop  = origTop  - (e.clientY - startY);
    };
    const up = () => {
      scroll.style.cursor = prevCursor;
      try { scroll.releasePointerCapture?.(ev.pointerId); } catch {}
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  _startDrag(ev, region, mode) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const isMulti = this._selectedRegionIds.has(region.id) && this._selectedRegionIds.size > 1;
    // Region groups expand the moving set for ALL drag modes — not
    // just `mode === "move"` — so trim/resize/stretch on a single
    // grouped region cascades to siblings with the same delta. The
    // multi-select branch keeps its existing semantics (move-only).
    // Alt during the click bypassed group selection in
    // `_onRegionPointerDown`, so a deliberate solo-drag stays solo.
    let movingIds;
    if (isMulti && mode === "move") {
      movingIds = [...this._selectedRegionIds];
    } else {
      const group = this._groupOf(region);
      if (group) {
        movingIds = this._regionsInGroup(group).map((r) => r.id);
        if (!movingIds.includes(region.id)) movingIds.push(region.id);
      } else {
        movingIds = [region.id];
      }
    }
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
        trackId: r.track_id,
      });
    }
    // Cross-track move: track which lane the cursor is currently
    // over so a "drop region on a different lane" gesture can commit
    // `track_id` on pointer-up. Only meaningful for `mode === "move"`
    // (edge resize stays within the source track). Updated on every
    // pointermove; the commit path validates kind compatibility
    // before writing.
    let destTrackId = null;
    const trackKindByLeader = this._trackKind(region.track_id);

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
      for (const el of els) {
        el.classList.toggle("stretch-active", stretchResize);
        if (stretchResize) {
          el.dataset.stretchMode = e.shiftKey ? "tape" : "elastic";
        } else {
          delete el.dataset.stretchMode;
        }
      }
      let moveSnapAdj = 0;
      if (mode === "move") {
        const oLead = origs.get(region.id);
        if (oLead) {
          const rawLeader = oLead.start + dxSamples;
          const snapped = this._snapLeaderStart(rawLeader, movingIds, e.altKey);
          moveSnapAdj = snapped - rawLeader;
        }
        // Resolve the lane under the cursor for cross-track move. Kind
        // mismatches (audio→midi, etc.) skip — the original lane wins
        // so the user gets visible feedback that the drop won't take.
        const trackUnder = this._trackAtClientY(e.clientY);
        if (trackUnder && trackUnder.id !== region.track_id
            && trackUnder.kind === trackKindByLeader) {
          destTrackId = trackUnder.id;
          for (const el of els) el.classList.add("cross-track-pending");
          // Ghost outline on the destination lane. Drawn for every
          // moving region — for a group / multi-select drag, the
          // destination lane is the leader's; sibling regions also
          // show ghosts there so the user can sight the whole
          // landing layout at once.
          const ghostRegions = [];
          for (const id of movingIds) {
            const o = origs.get(id);
            if (!o) continue;
            ghostRegions.push({
              id,
              startSamples: o.start + dxSamples + moveSnapAdj,
              lengthSamples: o.len,
            });
          }
          this._crossTrackGhost = { destTrackId, regions: ghostRegions };
        } else {
          destTrackId = null;
          for (const el of els) el.classList.remove("cross-track-pending");
          if (this._crossTrackGhost) this._crossTrackGhost = null;
        }
      }
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
          preview.start_samples = o.start + dxSamples + moveSnapAdj;
        } else if (mode === "resize-right") {
          let newLen = Math.max(4800, o.len + dxSamples);
          if (!stretchResize && !e.altKey) {
            const rawEnd = o.start + newLen;
            const snappedEnd = this._collectSnapTargets(new Set(movingIds), rawEnd);
            newLen = Math.max(4800, snappedEnd - o.start);
          }
          preview.length_samples = newLen;
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
          let dx = Math.max(minDx, Math.min(maxDx, dxSamples));
          if (!e.altKey) {
            const rawStart = o.start + dx;
            const snappedStart = this._collectSnapTargets(new Set(movingIds), rawStart);
            dx = Math.max(minDx, Math.min(maxDx, snappedStart - o.start));
          }
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
        el.classList.remove("cross-track-pending");
        delete el.dataset.stretchMode;
      }
      // Drop the cross-track drop preview regardless of which branch
      // commits — the dispatched update_region / duplicate_region
      // will land the region on the destination lane on its own.
      if (this._crossTrackGhost) this._crossTrackGhost = null;
      // Drop the waveform freeze + placeholder. The post-commit
      // RegionUpdated event will invalidate the wf cache and the
      // next ensure() call refetches peaks for the new offset+length.
      teardownLeftTrimPreview();
      const edgeResize = mode === "resize-left" || mode === "resize-right";
      const commitStretch =
        didDrag && edgeResize && !!(upEv.ctrlKey || upEv.metaKey);
      // Ctrl/Cmd+move = duplicate. The original stays put and a clone
      // lands at the drop position (and on the destination track when
      // the drag crossed lanes). Standard Reaper / Pro Tools modifier;
      // Logic uses Option instead but Option/Alt is already overloaded
      // here (skip-group-cascade on click, fine-snap on drag), so we
      // pick Ctrl/Cmd to avoid collisions. Only fires for a real
      // move-mode drag — edge resize keeps its existing Ctrl=stretch
      // meaning.
      const commitDuplicate =
        didDrag && mode === "move" && !!(upEv.ctrlKey || upEv.metaKey);
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
      // Ctrl/Cmd+move = duplicate. Roll back the optimistic move on
      // each dragged region so the originals snap back to their
      // pre-drag positions, then fire one `duplicate_region` per
      // moving region with the destination offset baked in. The
      // dispatch is wrapped in an undo group so a multi-region
      // Ctrl+drag-duplicate reverses as one entry.
      if (commitDuplicate) {
        // Restore original positions in the local store. The
        // post-RegionUpdated echoes from the new clones won't touch
        // the originals.
        for (const id of movingIds) {
          const o = origs.get(id);
          if (!o) continue;
          const cur = this._regionForId(id);
          if (!cur) continue;
          this._patchRegionLocally({
            ...cur,
            start_samples: o.start,
            length_samples: o.len,
            source_offset_samples: o.offset,
            track_id: o.trackId,
          });
        }
        const ws = window.__foyer?.ws;
        const groupLabel = movingIds.length === 1
          ? "Foyer duplicate region"
          : `Foyer duplicate ${movingIds.length} regions`;
        ws?.send({ type: "undo_group_begin", name: groupLabel });
        for (const id of movingIds) {
          const o = origs.get(id);
          if (!o) continue;
          // Use the leader's destTrackId for the leader; siblings
          // dropped together carry their source track (matches the
          // same-direction-only cross-track move semantics above).
          const leader = id === region.id;
          const targetTrack = leader && destTrackId && destTrackId !== o.trackId
            ? destTrackId
            : null;
          // The clone lands at the optimistic preview's start. We
          // read it BEFORE the rollback above clobbered it? No — we
          // already rolled back. Re-derive from the original + drag
          // delta + (snap adjustment already applied during move).
          // Simpler: take origs.get(id).start + (dxAtUp). dxAtUp is
          // upEv.clientX - startX in samples. moveSnapAdj only
          // matters for the leader; siblings track raw delta.
          const dxSamplesUp = ((upEv.clientX - startX) / pxPerSec) * sr;
          const newStart = Math.round(o.start + dxSamplesUp);
          ws?.send({
            type: "duplicate_region",
            source_region_id: id,
            at_samples: newStart,
            length_samples: o.len,
            ...(targetTrack ? { target_track_id: targetTrack } : {}),
          });
        }
        ws?.send({ type: "undo_group_end" });
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        return;
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
            preserve_pitch: !upEv.shiftKey,
          });
          continue;
        }
        const newOffset = Number(r.source_offset_samples || 0);
        const offsetMoved = newOffset !== o.offset;
        // Cross-track move: when the drop landed on a different
        // lane (and the kind check passed during the drag),
        // include `track_id` in the patch so the backend relocates
        // the region. Only applies to the leader region — group
        // siblings on other tracks shouldn't be dragged along to
        // the new lane just because the leader moved.
        const movedTrack = mode === "move"
          && id === region.id
          && destTrackId
          && destTrackId !== o.trackId;
        // Skip the round-trip if nothing actually moved (e.g. the
        // user click-dragged but landed back at the start).
        if (
          r.start_samples === o.start
          && r.length_samples === o.len
          && !offsetMoved
          && !movedTrack
        ) continue;
        const patch = {
          start_samples: r.start_samples,
          length_samples: r.length_samples,
        };
        if (offsetMoved) patch.source_offset_samples = newOffset;
        if (movedTrack) patch.track_id = destTrackId;
        window.__foyer?.ws?.send({
          type: "update_region",
          id: r.id,
          patch,
        });
        // Sequencer-owned regions: extending the region's right edge
        // grows the timeline lozenge but the layout's arrangement is
        // still bounded by its old bar count, so `expand_sequencer_layout`
        // only emits notes for the original extent and the new portion
        // plays silent. Loop the existing arrangement to fill the new
        // bars — Hydrogen-style "more of the same beat" — and ship a
        // set_sequencer_layout. Server-side coalescer will absorb it
        // into the same regen the update_region above triggers.
        if (mode === "resize-right"
            && r.length_samples > o.len
            && r.foyer_sequencer
            && r.foyer_sequencer.active !== false) {
          const extended = this._loopSequencerArrangementToFit(
            r.foyer_sequencer, r.length_samples,
          );
          if (extended) {
            window.__foyer?.ws?.send({
              type: "set_sequencer_layout",
              region_id: r.id,
              layout: extended,
            });
          }
        }
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

  /**
   * Repeat a sequencer layout's arrangement until it covers
   * `newLengthSamples` of region. Returns a fresh layout object the
   * caller can ship via `set_sequencer_layout`, or `null` when no
   * extension is needed (or the inputs aren't enough to compute bars).
   *
   * Bar duration is derived from `pattern_steps`/`resolution` plus the
   * session tempo + sample rate — same beat math as `_renderQuantGrid`.
   * The original arrangement's extent (`maxBar + 1`) is the loop unit;
   * each subsequent loop copies every original slot at `slot.bar +
   * loop * extent`. Truncates at the bar that crosses
   * `newLengthSamples` so we don't write slots past the visible region.
   */
  _loopSequencerArrangementToFit(layout, newLengthSamples) {
    if (!layout || layout.active === false) return null;
    const arr = Array.isArray(layout.arrangement) ? layout.arrangement : [];
    if (arr.length === 0) return null;
    const patternSteps = Math.max(1, Math.round(Number(layout.pattern_steps) || 16));
    const resolution = Math.max(1, Math.round(Number(layout.resolution) || 4));
    const ctls = window.__foyer?.store?.state?.controls;
    const tempo = Number(ctls?.get?.("transport.tempo")) || 120;
    if (!Number.isFinite(tempo) || tempo <= 0) return null;
    const sr = this._sampleRate();
    if (!sr) return null;
    const beatSec = 60 / tempo;
    const barBeats = patternSteps / resolution;
    const barSamples = barBeats * beatSec * sr;
    if (!Number.isFinite(barSamples) || barSamples <= 0) return null;
    const newTotalBars = Math.max(1, Math.ceil(newLengthSamples / barSamples));
    let curMaxBar = -1;
    for (const s of arr) {
      const b = Number(s?.bar) || 0;
      if (b > curMaxBar) curMaxBar = b;
    }
    const curExtent = curMaxBar + 1;
    if (curExtent <= 0) return null;
    if (newTotalBars <= curExtent) return null;

    // Find the smallest period `P` such that the existing arrangement
    // is a CLEAN repetition of bars [0, P) — every bar in
    // [P, curExtent) is identical to its counterpart `period` bars
    // earlier, and `curExtent % P === 0` (the existing arrangement
    // covers exactly K full repetitions of the unit).
    //
    // If no such P exists, the arrangement isn't a loopable
    // pattern and we return null — caller leaves the new bars empty
    // rather than smearing a non-repeating arrangement past its
    // intended end (the user's "we'll get dubious patterning"
    // concern, 2026-05-07).
    const sigOf = (b) => {
      const slots = [];
      for (const s of arr) {
        if ((Number(s?.bar) || 0) !== b) continue;
        slots.push(`${s.pattern_id}|${Number(s.arrangement_row) || 0}`);
      }
      slots.sort();
      return slots.join(",");
    };
    let period = null;
    if (curExtent === 1) {
      // Trivial loop — a single-bar arrangement is treated as a
      // 1-bar unit that repeats. The strict "must show ≥2 reps"
      // rule below would block this (period === curExtent), but
      // a single drum bar IS what the user means by "the loop".
      period = 1;
    } else {
      // Otherwise require period ≤ curExtent / 2 — i.e. the existing
      // arrangement must contain at least two full repetitions of
      // the unit. Without that, what we'd be "looping" is a
      // one-shot arrangement the user composed once with no
      // intention of repeating, and extending produces the
      // dubious patterning Rich called out (2026-05-07).
      const maxPeriod = Math.floor(curExtent / 2);
      for (let p = 1; p <= maxPeriod; p++) {
        if (curExtent % p !== 0) continue;
        let ok = true;
        for (let b = p; b < curExtent; b++) {
          if (sigOf(b) !== sigOf(b - p)) { ok = false; break; }
        }
        if (ok) { period = p; break; }
      }
    }
    if (period === null) return null;

    // Extend by full periods only — no partial trailing unit. If the
    // new region length is, say, 7.3 bars and the period is 2, we
    // fill bars [0, 6) and leave [6, 7.3) empty. The user resizes
    // again or shrinks the region to lock in the loop count.
    const numUnits = Math.floor(newTotalBars / period);
    const filledBars = numUnits * period;
    if (filledBars <= curExtent) return null;

    // Capture the canonical unit (slots in bars [0, period)) and
    // replicate forward.
    const unitSlots = arr.filter((s) => (Number(s.bar) || 0) < period);
    const next = JSON.parse(JSON.stringify(layout));
    const startUnit = curExtent / period;
    for (let unitIdx = startUnit; unitIdx < numUnits; unitIdx++) {
      for (const slot of unitSlots) {
        const newBar = (Number(slot.bar) || 0) + unitIdx * period;
        next.arrangement.push({
          pattern_id: slot.pattern_id,
          bar: newBar,
          arrangement_row: Number(slot.arrangement_row) || 0,
        });
      }
    }
    return next;
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
