// Automation lane — read-only polyline renderer for Phase A, editable for Phase B.
//
// Takes an `AutomationLane` from `track.automation_lanes` and paints
// its points against the timeline's px-per-sample scale. The lane
// sits beneath the track's region strip and shares the same x-axis
// so a point at `time_samples = N` lines up with the waveform at
// sample N.
//
// Phase B interactions:
//   · Click empty space → add a point.
//   · Drag a point → move time + value.
//   · Right-click a point → delete.
//   · Click mode chip → cycle Off → Play → Write → Touch → Latch → Off.
//
// Commands fire via `window.__foyer.ws.send({ type: "...", ... })`.

import { LitElement, html, svg, css } from "lit";
import { ControlController } from "foyer-core/store.js";
import { confirmAction } from "foyer-ui-core/widgets/confirm-modal.js";

const LANE_HEIGHT = 48;
const PAD_Y = 4;
const HIT_RADIUS = 6;

/** Lane label + range hints per control id. Keeps the Y-axis mapping
 *  sane without having to round-trip the Parameter.range field. Extra
 *  control ids fall through to a 0..1 default. */
const LANE_META = {
  gain:  { label: "Gain", min: -60, max: 6, unit: "dB", color: "var(--color-accent, #7c5cff)" },
  pan:   { label: "Pan",  min: -1,  max: 1, unit: "",   color: "#22d3ee" },
  mute:  { label: "Mute", min: 0,   max: 1, unit: "",   color: "#fbbf24" },
  solo:  { label: "Solo", min: 0,   max: 1, unit: "",   color: "#f87171" },
};

const MODE_CYCLE = ["off", "play", "write", "touch", "latch"];

function metaFor(controlId) {
  const suffix = String(controlId || "").split(".").pop();
  return LANE_META[suffix] || { label: suffix || "param", min: 0, max: 1, unit: "", color: "var(--color-accent)" };
}

export class AutomationLane extends LitElement {
  static properties = {
    lane: { attribute: false },
    totalSamples: { type: Number, attribute: "total-samples" },
    pxPerSec: { type: Number, attribute: "px-per-sec" },
    sampleRate: { type: Number, attribute: "sample-rate" },
    color: { type: String },
    /** Parameter struct for the underlying control, used to detect
     *  discrete/enum/trigger kinds → stepped curve rendering + snap.
     *  Optional; absence falls back to continuous behavior. */
    parameter: { attribute: false },
    /** List of `Region` objects on this track. Used to mark the
     *  auto-pinned start/end automation points at each region edge
     *  with a square glyph + "Start"/"End" labels so the user can
     *  adjust the value at region boundaries without first creating
     *  a point. Optional. */
    regions: { attribute: false },
    _liveValue: { state: true, type: Number },
    _selectedTimes: { state: true, type: Object },
    _marquee: { state: true, type: Object },
  };

  static styles = css`
    :host {
      display: block;
      position: relative;
      /* Default height — the modal overrides this via its card-body
       * styles (resize: vertical) so users can drag a lane taller
       * for finer dB-per-pixel control on continuous params. The
       * inline timeline overlay sized lane stack is gone so this
       * default only applies when the lane is used in isolation. */
      height: 100%;
      min-height: ${LANE_HEIGHT}px;
      background: color-mix(in oklab, var(--color-surface-elevated) 80%, transparent);
      border-top: 1px solid color-mix(in oklab, var(--color-border) 50%, transparent);
      overflow: hidden;
      font-family: var(--font-sans);
      user-select: none;
    }
    .label {
      position: absolute;
      top: 2px; left: 6px;
      font-size: 9px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      pointer-events: none;
      z-index: 2;
    }
    .label .mode {
      margin-left: 6px;
      padding: 0 5px;
      border-radius: 3px;
      background: color-mix(in oklab, var(--color-accent) 20%, transparent);
      color: var(--color-accent);
      font-size: 8px;
      cursor: pointer;
      pointer-events: auto;
      user-select: none;
    }
    .label .mode.off { background: transparent; color: var(--color-text-muted); }
    .label .reset {
      margin-left: 6px;
      padding: 0 5px;
      border-radius: 3px;
      background: color-mix(in oklab, var(--color-danger) 20%, transparent);
      color: var(--color-danger);
      font-size: 8px;
      cursor: pointer;
      pointer-events: auto;
      user-select: none;
      opacity: 0.7;
      transition: opacity 0.1s;
    }
    .label .reset:hover { opacity: 1; }
    svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    svg .grid {
      stroke: color-mix(in oklab, var(--color-border) 50%, transparent);
      stroke-width: 1;
      stroke-dasharray: 2 4;
    }
    svg .line {
      stroke: var(--lane-color, var(--color-accent, #7c5cff));
      stroke-width: 1.5;
      fill: none;
      pointer-events: stroke;
    }
    svg .area {
      fill: var(--lane-color, var(--color-accent, #7c5cff));
      fill-opacity: 0.12;
      pointer-events: none;
    }
    svg .point {
      fill: var(--lane-color, var(--color-accent, #7c5cff));
      stroke: var(--color-surface);
      stroke-width: 1.5;
      cursor: grab;
      pointer-events: all;
    }
    svg .point:hover {
      r: 6;
      stroke: #fff;
      stroke-width: 2;
      filter: drop-shadow(0 0 4px var(--lane-color, var(--color-accent)));
    }
    svg .point:active { cursor: grabbing; }
    /* Wide invisible hit halo around each point — extends the
     * grabbable area to ~14 px diameter without changing the visual
     * size. Sits in front of the line stroke so hover/grab gestures
     * are predictable, but transparent so the actual point dot still
     * reads as the focus. */
    svg .point-halo {
      fill: transparent;
      stroke: transparent;
      cursor: grab;
      pointer-events: all;
    }
    svg .live {
      fill: #fff;
      stroke: var(--lane-color, var(--color-accent, #7c5cff));
      stroke-width: 2;
      pointer-events: none;
    }
    svg .hit-surface {
      fill: transparent;
      /* Empty-grid clicks add points; click+drag here draws (pen
       * mode) or marquees (Cmd/Ctrl). Crosshair tells the user the
       * surface is interactive — without it the curve area looks
       * passive and the user assumes "I have to click exactly on a
       * point" which is exactly the issue Rich hit. */
      cursor: crosshair;
      pointer-events: all;
    }
    svg:focus { outline: none; }
    svg .point.endpoint {
      fill: var(--lane-color, var(--color-accent, #7c5cff));
      stroke: var(--color-surface);
      stroke-width: 1.5;
      cursor: ns-resize;
      pointer-events: all;
    }
    svg .point.endpoint.selected,
    svg .point.selected {
      stroke: #fff;
      stroke-width: 2;
      filter: drop-shadow(0 0 4px var(--lane-color, var(--color-accent)));
    }
    svg .endpoint-label {
      fill: var(--color-text-muted);
      font-size: 8px;
      font-family: var(--font-mono);
      pointer-events: none;
      user-select: none;
    }
    svg .marquee {
      /* Solid rgba (not color-mix) so it renders identically across
       * browsers + can't get blown away by any oklab fallback path.
       * Bumped fill + stroke so the box is unmistakable. */
      fill: rgba(124, 92, 255, 0.18);
      stroke: #a78bfa;
      stroke-width: 2;
      stroke-dasharray: 5 3;
      pointer-events: none;
    }
    .discrete-chip {
      display: inline-block;
      margin-left: 6px;
      padding: 0 5px;
      border-radius: 3px;
      background: color-mix(in oklab, var(--color-accent-2, #22d3ee) 24%, transparent);
      color: var(--color-accent-2, #22d3ee);
      font-size: 8px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .sel-chip {
      display: inline-block;
      margin-left: 6px;
      padding: 0 5px;
      border-radius: 3px;
      background: color-mix(in oklab, var(--color-accent) 28%, transparent);
      color: var(--color-accent);
      font-size: 8px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    /* Always-visible gesture toolbar in the lane header. Beats a
     * hover-only question-mark chip for discoverability — the user
     * can actually see what they can do at a glance. Each gesture
     * chip has a tooltip with the full description. Hover state
     * pops the chip to make it readable when scanning. */
    .label .gesture-bar {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 10px;
      pointer-events: auto;
    }
    .label .gesture {
      padding: 1px 5px;
      border-radius: 3px;
      background: color-mix(in oklab, var(--color-border) 50%, transparent);
      color: var(--color-text-muted);
      font-size: 8px;
      letter-spacing: 0.04em;
      cursor: help;
      user-select: none;
      transition: background 0.1s ease, color 0.1s ease;
    }
    .label .gesture:hover {
      background: color-mix(in oklab, var(--color-accent-2, #22d3ee) 30%, transparent);
      color: var(--color-text);
    }
  `;

  constructor() {
    super();
    this.lane = null;
    this.totalSamples = 48_000 * 60;
    this.pxPerSec = 60;
    this.sampleRate = 48_000;
    this.color = "";
    this.parameter = null;
    this.regions = null;
    this._liveValue = null;
    this._controlCtl = null;
    this._drag = null;
    /** Time-keyed selection set (matches point time_samples). Drag /
     *  delete ops act on the whole selection when non-empty. */
    this._selectedTimes = new Set();
    /** Active marquee rect ({x0,y0,x1,y1}) during a Cmd/Ctrl+drag.
     *  Null when no rubber-band is in flight. */
    this._marquee = null;
    /** Pen-mode buffer: array of {time, value} added during a free-
     *  draw drag. Committed in one replace_automation_lane on pointer-
     *  up so the user gets a single undo entry per pen stroke. */
    this._pen = null;
    /**
     * Sticky local override of the lane's point list. Set whenever
     * we commit a write (pen-mode replace, drag-move, alt-delete,
     * keyboard-delete) so the render path keeps showing the user's
     * change immediately, even when the backend never echoes back
     * — which is the case for plugin-parameter lanes on Ardour
     * today, since the shim hasn't been taught to seed AutomationLane
     * entries for them. Cleared in `updated()` the moment a fresh
     * `lane` prop arrives with different points (i.e. the server
     * accepted and broadcast a real update).
     *
     * Without this, every pen-draw against an unsupported lane
     * visually "snapped back" the instant the user released the
     * mouse, which made plugin automation look fundamentally broken
     * — even though the wire commands were firing correctly. Now
     * the points stay on screen; if the backend silently dropped
     * them, the user at least sees what they drew (and can save
     * the session to preserve it once the shim catches up).
     */
    this._localCommitted = null;
  }

  updated(changed) {
    if (changed.has("lane")) {
      if (this.lane?.control_id) {
        const store = window.__foyer?.store;
        if (store) {
          this._controlCtl?.hostDisconnected?.();
          this._controlCtl = new ControlController(this, store, this.lane.control_id);
        }
      }
      // Clear the local-committed override the moment a fresh `lane`
      // prop arrives whose points differ from our pending override.
      // That's the signal the backend echoed and the canonical state
      // is now ahead of (or equal to) our optimistic state. If the
      // echoed list matches ours exactly, the override is harmless to
      // keep, but clearing avoids carrying a stale snapshot forward.
      const oldLane = changed.get("lane");
      const oldLen = oldLane?.points?.length ?? -1;
      const newLen = this.lane?.points?.length ?? 0;
      if (Array.isArray(this._localCommitted) && oldLen !== newLen) {
        this._localCommitted = null;
      }
    }
  }

  connectedCallback() {
    super.connectedCallback();
    // Re-render on vertical resize so the SVG paths recompute for
    // the new lane height (otherwise the curve stays at the old
    // pixel positions and floats away from the bottom of a taller
    // lane). ResizeObserver is the right tool here — `resize`
    // events only fire for `window`, not arbitrary elements.
    this._resizeObs = new ResizeObserver(() => this.requestUpdate());
    this._resizeObs.observe(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._endDrag();
    this._resizeObs?.disconnect();
    this._resizeObs = null;
  }

  // ─── coordinate helpers ───────────────────────────────────────────

  _xForSample(sample) {
    const sr = this.sampleRate || 48_000;
    return (sample / sr) * (this.pxPerSec || 60);
  }
  _sampleForX(x) {
    const sr = this.sampleRate || 48_000;
    return Math.round((x / (this.pxPerSec || 60)) * sr);
  }
  /** Effective lane height in CSS pixels — reads the host's live
   *  offsetHeight so the lane responds to user vertical-resize
   *  (the modal's `.card-body` is `resize: vertical`). Falls back
   *  to `LANE_HEIGHT` until the element is laid out. */
  _laneH() {
    const h = this.offsetHeight || LANE_HEIGHT;
    return Math.max(LANE_HEIGHT, h);
  }
  _yForValue(v) {
    const m = this._metaForLane();
    const clamped = Math.max(m.min, Math.min(m.max, v));
    const norm = (clamped - m.min) / Math.max(0.0001, m.max - m.min);
    const H = this._laneH();
    const usable = H - PAD_Y * 2;
    return H - PAD_Y - norm * usable;
  }
  _valueForY(y) {
    const m = this._metaForLane();
    const H = this._laneH();
    const norm = (H - PAD_Y - y) / Math.max(0.0001, H - PAD_Y * 2);
    const clamped = Math.max(0, Math.min(1, norm));
    const raw = m.min + clamped * (m.max - m.min);
    return this._snapValue(raw);
  }

  /** Resolve display range + label from either the Parameter struct
   *  (preferred — gives accurate ranges for plugin params) or the
   *  hardcoded LANE_META fallback for core controls. */
  _metaForLane() {
    const p = this.parameter;
    if (p) {
      const kind = String(p.kind || "continuous");
      // Triggers / mute / solo: 0..1 boolean.
      if (kind === "trigger") {
        return { ...metaFor(this.lane?.control_id), min: 0, max: 1 };
      }
      // Enums: 0..N-1 integer.
      if (kind === "enum") {
        const n = Math.max(1, (p.enum_labels || []).length) - 1;
        return { ...metaFor(this.lane?.control_id), min: 0, max: n };
      }
      // Discrete / continuous: use the parameter's stated range.
      const r = Array.isArray(p.range) ? p.range : null;
      if (r && r.length === 2) {
        return { ...metaFor(this.lane?.control_id), min: r[0], max: r[1] };
      }
    }
    return metaFor(this.lane?.control_id);
  }

  /** True when this lane edits a finite/discrete control. The curve
   *  renders stepped and edited values snap to the nearest option. */
  _isDiscrete() {
    const k = String(this.parameter?.kind || "");
    if (k === "trigger" || k === "enum" || k === "discrete") return true;
    // Heuristic: mute/solo are core controls that are conceptually
    // boolean even when the Parameter isn't present (e.g. the stub
    // backend ships them as 0..1 floats).
    const suffix = String(this.lane?.control_id || "").split(".").pop() || "";
    return suffix === "mute" || suffix === "solo";
  }

  /** Allowed values for a discrete lane, or null when continuous. */
  _discreteOptions() {
    if (!this._isDiscrete()) return null;
    const p = this.parameter;
    if (p && String(p.kind) === "enum") {
      const n = (p.enum_labels || []).length;
      return Array.from({ length: Math.max(1, n) }, (_, i) => i);
    }
    if (p && String(p.kind) === "discrete" && Array.isArray(p.range)) {
      const lo = Math.round(p.range[0]);
      const hi = Math.round(p.range[1]);
      const out = [];
      for (let v = lo; v <= hi; v++) out.push(v);
      return out;
    }
    // Default fallback: 0 / 1 (trigger, mute, solo).
    return [0, 1];
  }

  /** Snap an arbitrary value to the nearest allowed option when the
   *  lane is discrete. No-op for continuous lanes. */
  _snapValue(raw) {
    const opts = this._discreteOptions();
    if (!opts) return raw;
    let best = opts[0];
    let bestD = Math.abs(raw - opts[0]);
    for (const o of opts) {
      const d = Math.abs(raw - o);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  /** Map a region edge to "Start" / "End" — used to render the
   *  pinned endpoints with a distinct glyph + label. Returns
   *  `null` for points that aren't sitting on a region edge. */
  _endpointKind(timeSamples) {
    const regions = Array.isArray(this.regions) ? this.regions : [];
    for (const r of regions) {
      const start = Math.round(Number(r.start_samples) || 0);
      const end = start + Math.max(0, Math.round(Number(r.length_samples) || 0));
      if (timeSamples === start) return { kind: "start", region: r };
      if (timeSamples === end) return { kind: "end", region: r };
    }
    return null;
  }

  // ─── hit testing ──────────────────────────────────────────────────

  _nearestPoint(clientX) {
    const rect = this.getBoundingClientRect();
    const x = clientX - rect.left;
    const pts = this._effectivePoints();
    let best = null;
    let bestDist = Infinity;
    for (const p of pts) {
      const px = this._xForSample(p.time_samples || 0);
      const d = Math.abs(px - x);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return { point: best, dist: bestDist };
  }

  // ─── interaction handlers ─────────────────────────────────────────

  _onPointerDown(ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const { point, dist } = this._nearestPoint(ev.clientX);
    const onPoint = !!(point && dist <= HIT_RADIUS);

    // Alt+click on a point → delete it. Faster than right-click for
    // mouse-only workflows the user called out.
    if (onPoint && ev.altKey) {
      this._sendCommand("delete_automation_point", {
        lane_id: this.lane.control_id,
        time_samples: point.time_samples,
      });
      this._selectedTimes.delete(point.time_samples);
      this.requestUpdate();
      return;
    }

    // Shift+click on a point → toggle it in the multi-selection.
    // Lets the user build a selection one point at a time without
    // having to draw a marquee that happens to land on each one.
    // Skips the drag handler so the point doesn't grab on the same
    // gesture.
    if (onPoint && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      if (this._selectedTimes.has(point.time_samples)) {
        this._selectedTimes.delete(point.time_samples);
      } else {
        this._selectedTimes.add(point.time_samples);
      }
      this.requestUpdate();
      return;
    }

    // Cmd/Ctrl always means "marquee select" regardless of where
    // the drag starts. Wins over the on-point grab path so a Cmd-
    // drag from a point's screen position still rubber-bands.
    if (ev.ctrlKey || ev.metaKey) {
      this._startMarquee(ev);
      return;
    }

    if (!onPoint) {
      // Modifier-less click+drag on empty grid enters pen-mode after
      // ~3 px of travel; until then it behaves like the old "click to
      // add a single point" gesture.
      this._startPenOrPoint(ev);
      return;
    }

    // Click on a point — drag it. If the point is part of the current
    // selection, drag the whole selection.
    this._startDrag(ev, point);
  }

  _startDrag(ev, point) {
    const inSelection = this._selectedTimes.has(point.time_samples);
    // Single-point click: collapse selection unless modifier wants
    // additive behavior. We don't currently support shift-extend on
    // points (the marquee handles multi-pick) so the simple model
    // is: drag a selected point → group drag; drag an unselected
    // point → clear selection + grab just this one.
    if (!inSelection) this._selectedTimes.clear();
    const points = Array.isArray(this.lane?.points) ? this.lane.points : [];
    // Snapshot every point currently in the selection (or just the
    // grabbed one) so deltas are applied uniformly on pointermove.
    const targets = inSelection
      ? points.filter((p) => this._selectedTimes.has(p.time_samples))
      : [point];
    this._drag = {
      anchor: { ...point },
      members: targets.map((p) => ({
        original: { time_samples: p.time_samples, value: p.value },
        live: { time_samples: p.time_samples, value: p.value },
      })),
      startX: ev.clientX,
      startY: ev.clientY,
    };
    window.addEventListener("pointermove", this._onMove);
    window.addEventListener("pointerup", this._onUp);
  }

  _onMove = (ev) => {
    if (this._marquee) {
      this._updateMarquee(ev);
      return;
    }
    if (this._pen) {
      this._updatePen(ev);
      return;
    }
    if (!this._drag) return;
    const d = this._drag;
    const rect = this.getBoundingClientRect();
    const dxSamples = this._sampleForX(ev.clientX - d.startX);
    // For value, we drop the anchor's original y and use the current
    // pointer y (delta-y feels unnatural for value editing — users
    // expect "the curve follows my cursor here").
    const yLocal = ev.clientY - rect.top;
    const valueAtCursor = this._valueForY(yLocal);
    const valueDelta = valueAtCursor - d.anchor.value;
    for (const m of d.members) {
      m.live.time_samples = Math.max(0, Math.min(this.totalSamples,
        m.original.time_samples + dxSamples));
      m.live.value = this._snapValue(m.original.value + valueDelta);
    }
    this.requestUpdate();
  };

  _onUp = (upEv) => {
    if (this._marquee) {
      this._finishMarquee(upEv);
      return;
    }
    if (this._pen) {
      this._finishPen(upEv);
      return;
    }
    if (!this._drag) {
      this._endDrag();
      return;
    }
    const d = this._drag;
    // Send one update per moved point. Wrap in an undo group so the
    // whole drag (single or multi-select) is one undo entry.
    const ws = window.__foyer?.ws;
    const moved = d.members.filter((m) =>
      m.live.time_samples !== m.original.time_samples
        || Math.abs(m.live.value - m.original.value) > 0.0001);
    if (moved.length > 1) ws?.send({ type: "undo_group_begin", name: "Foyer move automation points" });
    for (const m of moved) {
      this._sendCommand("update_automation_point", {
        lane_id: this.lane.control_id,
        original_time_samples: m.original.time_samples,
        new_time_samples: m.live.time_samples,
        value: m.live.value,
      });
    }
    if (moved.length > 1) ws?.send({ type: "undo_group_end" });
    // Reflect the new times in the selection so subsequent ops stay
    // on the right points.
    if (moved.length && this._selectedTimes.size) {
      const next = new Set();
      for (const m of moved) next.add(m.live.time_samples);
      // Carry over un-moved selection members too (shouldn't happen
      // in practice since every selected member was a target, but be
      // defensive).
      for (const t of this._selectedTimes) {
        if (!d.members.find((m) => m.original.time_samples === t)) next.add(t);
      }
      this._selectedTimes = next;
    }
    this._endDrag();
  };

  _endDrag() {
    this._drag = null;
    window.removeEventListener("pointermove", this._onMove);
    window.removeEventListener("pointerup", this._onUp);
    this.requestUpdate();
  }

  /** Single-point add OR start of a pen-mode free-draw. Threshold
   *  on movement decides which: clicks resolve to one point; drags
   *  past ~3 px enter pen mode and add a string of points along the
   *  cursor path until pointer-up. Pen-mode points are quantized to
   *  a coarse pixel grid (~6 px) so a free-draw produces a workable
   *  number of points rather than 60+ per second. */
  _startPenOrPoint(ev) {
    const rect = this.getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    this._pen = {
      pending: true,
      startX,
      startY,
      lastSampledX: ev.clientX,
      lastSampledY: ev.clientY,
      // Buffer holds the raw points we'll commit on pointer-up,
      // including the starting click so a single click still lays
      // down one point.
      buffer: [{
        time_samples: Math.max(0, Math.min(this.totalSamples,
          this._sampleForX(ev.clientX - rect.left))),
        value: this._valueForY(ev.clientY - rect.top),
      }],
    };
    window.addEventListener("pointermove", this._onMove);
    window.addEventListener("pointerup", this._onUp);
  }
  _updatePen(ev) {
    const p = this._pen;
    if (!p) return;
    const dx = Math.abs(ev.clientX - p.startX);
    const dy = Math.abs(ev.clientY - p.startY);
    if (p.pending && (dx > 3 || dy > 3)) {
      // Crossed the threshold — committed to a drag.
      p.pending = false;
    }
    if (p.pending) return;
    // Sample on EITHER axis crossing its threshold. Earlier this
    // only checked x movement, which meant a user drawing a value
    // curve by mostly moving vertically (e.g. dialing in gain at a
    // narrow x range) lost almost every point — only a handful
    // would survive because pointer-y moves alone never triggered
    // a buffer entry. The y threshold is tighter than x because
    // value changes per pixel are typically more sensitive than
    // time changes per pixel at common zoom levels.
    const movedX = Math.abs(ev.clientX - p.lastSampledX) >= 6;
    const movedY = Math.abs(ev.clientY - p.lastSampledY) >= 3;
    if (!movedX && !movedY) return;
    p.lastSampledX = ev.clientX;
    p.lastSampledY = ev.clientY;
    const rect = this.getBoundingClientRect();
    p.buffer.push({
      time_samples: Math.max(0, Math.min(this.totalSamples,
        this._sampleForX(ev.clientX - rect.left))),
      value: this._valueForY(ev.clientY - rect.top),
    });
    this.requestUpdate();
  }
  _finishPen(_upEv) {
    const p = this._pen;
    this._pen = null;
    window.removeEventListener("pointermove", this._onMove);
    window.removeEventListener("pointerup", this._onUp);
    if (!p) return;
    // Use whatever the render path was showing (lane.points OR the
    // local-committed override) as the merge base — without this the
    // second pen stroke on an unsupported lane would lose the first
    // stroke's points because we'd merge against the empty
    // lane.points instead of the user's accumulated draft.
    const existing = Array.isArray(this._effectivePoints())
      ? this._effectivePoints()
      : [];
    if (p.pending) {
      // No drag — commit a single point (the original "click adds a
      // point" behavior).
      const single = p.buffer[0];
      this._sendCommand("add_automation_point", {
        lane_id: this.lane.control_id,
        point: single,
      });
      // Optimistic local apply.
      const byTime = new Map();
      for (const e of existing) byTime.set(e.time_samples, { ...e });
      byTime.set(single.time_samples, single);
      this._localCommitted = [...byTime.values()]
        .sort((a, b) => a.time_samples - b.time_samples);
      this.requestUpdate();
      return;
    }
    // Pen-mode commit: replace the lane with the existing points
    // PLUS our buffer, deduped by time. We use replace_automation_lane
    // for one atomic write + one undo entry.
    const byTime = new Map();
    for (const e of existing) byTime.set(e.time_samples, { ...e });
    for (const np of p.buffer) byTime.set(np.time_samples, np);
    const merged = [...byTime.values()]
      .sort((a, b) => a.time_samples - b.time_samples);
    this._sendCommand("replace_automation_lane", {
      lane_id: this.lane.control_id,
      points: merged,
    });
    // Sticky local override so the points stay on screen even when
    // the backend doesn't echo — Ardour plugin-param lanes today,
    // for example. Cleared when a real echo arrives (see `updated`).
    this._localCommitted = merged;
    this.requestUpdate();
  }

  /**
   * Current effective points list — the local-committed override
   * if set (post-commit, pre-echo), else the lane prop's points.
   * Use this anywhere render/edit logic needs "what the user is
   * actually seeing right now".
   */
  _effectivePoints() {
    if (Array.isArray(this._localCommitted)) return this._localCommitted;
    return Array.isArray(this.lane?.points) ? this.lane.points : [];
  }

  /** Cmd/Ctrl + click+drag → rubber-band select. Sets every point
   *  contained in the band into `_selectedTimes` on release. */
  _startMarquee(ev) {
    const rect = this.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    this._marquee = { x0: x, y0: y, x1: x, y1: y };
    window.addEventListener("pointermove", this._onMove);
    window.addEventListener("pointerup", this._onUp);
  }
  _updateMarquee(ev) {
    if (!this._marquee) return;
    const rect = this.getBoundingClientRect();
    this._marquee = {
      ...this._marquee,
      x1: ev.clientX - rect.left,
      y1: ev.clientY - rect.top,
    };
    this.requestUpdate();
  }
  _finishMarquee(_upEv) {
    const m = this._marquee;
    this._marquee = null;
    window.removeEventListener("pointermove", this._onMove);
    window.removeEventListener("pointerup", this._onUp);
    if (!m) return;
    const xLo = Math.min(m.x0, m.x1);
    const xHi = Math.max(m.x0, m.x1);
    const yLo = Math.min(m.y0, m.y1);
    const yHi = Math.max(m.y0, m.y1);
    const next = new Set();
    for (const p of this._effectivePoints()) {
      const px = this._xForSample(p.time_samples || 0);
      const py = this._yForValue(p.value);
      if (px >= xLo && px <= xHi && py >= yLo && py <= yHi) {
        next.add(p.time_samples);
      }
    }
    this._selectedTimes = next;
    this.requestUpdate();
  }

  _addPointAt(ev) {
    const rect = this.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const snappedX = x <= HIT_RADIUS * 1.5 ? 0 : x;
    const time = Math.max(0, Math.min(this.totalSamples, this._sampleForX(snappedX)));
    const value = this._valueForY(y);
    this._sendCommand("add_automation_point", {
      lane_id: this.lane.control_id,
      point: { time_samples: time, value },
    });
  }

  _onContextMenu(ev) {
    ev.preventDefault();
    const { point, dist } = this._nearestPoint(ev.clientX);
    if (point && dist <= HIT_RADIUS) {
      this._sendCommand("delete_automation_point", {
        lane_id: this.lane.control_id,
        time_samples: point.time_samples,
      });
      this._selectedTimes.delete(point.time_samples);
      this.requestUpdate();
    }
  }

  _onKeyDown(ev) {
    if (!this._selectedTimes.size) return;
    if (ev.key === "Delete" || ev.key === "Backspace") {
      ev.preventDefault();
      const ws = window.__foyer?.ws;
      const ids = [...this._selectedTimes];
      if (ids.length > 1) ws?.send({ type: "undo_group_begin", name: "Foyer delete automation points" });
      for (const t of ids) {
        this._sendCommand("delete_automation_point", {
          lane_id: this.lane.control_id,
          time_samples: t,
        });
      }
      if (ids.length > 1) ws?.send({ type: "undo_group_end" });
      this._selectedTimes.clear();
      this.requestUpdate();
    } else if (ev.key === "Escape") {
      this._selectedTimes.clear();
      this.requestUpdate();
    }
  }

  _cycleMode() {
    const cur = String(this.lane?.mode || "off").toLowerCase();
    const idx = MODE_CYCLE.indexOf(cur);
    const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
    const wasOff = cur === "off";
    const becomingActive = next !== "off";
    const noPoints = !(this.lane?.points?.length);
    this._sendCommand("set_automation_mode", {
      lane_id: this.lane.control_id,
      mode: next,
    });
    // First-time activation: seed start + end points at every region
    // boundary on the track so the user has explicit handles at the
    // places where the automation will actually run. The current
    // control value is used so the lane starts "flat" instead of
    // jumping. Skip if the lane already has points (the user
    // composed them) or there are no regions to anchor against.
    if (wasOff && becomingActive && noPoints) {
      const regions = Array.isArray(this.regions) ? this.regions : [];
      if (regions.length) {
        const ws = window.__foyer?.ws;
        const curValue = Number.isFinite(this._liveValue)
          ? this._liveValue
          : (this._metaForLane().min + this._metaForLane().max) / 2;
        // Build a deduplicated time-list of every region edge — when
        // regions abut, one edge serves both as end-of-N and start-of-
        // N+1, so only one point is needed.
        const times = new Set();
        for (const r of regions) {
          const start = Math.round(Number(r.start_samples) || 0);
          const end = start + Math.max(0, Math.round(Number(r.length_samples) || 0));
          times.add(start);
          times.add(end);
        }
        const sorted = [...times].sort((a, b) => a - b);
        if (sorted.length) {
          ws?.send({ type: "undo_group_begin", name: "Foyer seed automation endpoints" });
          for (const t of sorted) {
            this._sendCommand("add_automation_point", {
              lane_id: this.lane.control_id,
              point: { time_samples: t, value: this._snapValue(curValue) },
            });
          }
          ws?.send({ type: "undo_group_end" });
        }
      }
    }
  }

  async _confirmReset() {
    const count = Array.isArray(this.lane?.points) ? this.lane.points.length : 0;
    if (count === 0) return;
    const confirmed = await confirmAction({
      title: "Clear automation points?",
      message:
        `Clear all ${count} automation point${count === 1 ? "" : "s"} for `
        + `${metaFor(this.lane.control_id).label}?`,
      confirmLabel: "Clear",
      cancelLabel: "Cancel",
      tone: "warning",
    });
    if (confirmed) {
      this._sendCommand("replace_automation_lane", {
        lane_id: this.lane.control_id,
        points: [],
      });
    }
  }

  _sendCommand(type, body) {
    const ws = window.__foyer?.ws;
    if (ws) ws.send({ type, ...body });
  }

  // ─── render ───────────────────────────────────────────────────────

  render() {
    const lane = this.lane;
    if (!lane) return html``;
    const m = this._metaForLane();
    const mode = lane.mode || "off";
    // Use the effective points list (local-committed override wins
    // until the backend echoes), so a pen-stroke whose wire commit
    // got silently dropped (Ardour plugin-param lanes today) doesn't
    // visually evaporate on the user.
    const pts = this._effectivePoints();
    // If a drag is in flight, replace the dragged points' positions
    // with their `live` values so the curve follows the cursor before
    // the server echo lands.
    let renderPts;
    if (this._drag?.members?.length) {
      const liveById = new Map(this._drag.members.map((mm) =>
        [mm.original.time_samples, mm.live]));
      renderPts = pts.map((p) =>
        liveById.has(p.time_samples)
          ? { ...p, ...liveById.get(p.time_samples) }
          : p);
    } else {
      renderPts = pts;
    }
    // Pen-mode in flight: merge the buffer into the rendered points
    // so the user sees their pen stroke before pointer-up.
    if (this._pen && this._pen.buffer && !this._pen.pending) {
      const byTime = new Map(renderPts.map((p) => [p.time_samples, p]));
      for (const np of this._pen.buffer) byTime.set(np.time_samples, np);
      renderPts = [...byTime.values()];
    }
    const sorted = [...renderPts].sort((a, b) => (a.time_samples || 0) - (b.time_samples || 0));
    const color = this.color || m.color;
    const discrete = this._isDiscrete();

    const liveV = this._liveValue ?? (sorted.length > 0 ? sorted[0].value : (m.min + m.max) / 2);
    let linePath = "";
    let areaPath = "";
    const y0 = this._yForValue(m.min);
    if (sorted.length === 0) {
      const y = this._yForValue(liveV);
      linePath = `M 0 ${y} L ${this._xForSample(this.totalSamples)} ${y}`;
      areaPath = `M 0 ${y} L ${this._xForSample(this.totalSamples)} ${y} L ${this._xForSample(this.totalSamples)} ${y0} L 0 ${y0} Z`;
    } else {
      const parts = [];
      const areaParts = [];
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const yFirst = this._yForValue(first.value);
      parts.push(`M 0 ${yFirst}`);
      areaParts.push(`M 0 ${y0} L 0 ${yFirst}`);
      if (discrete) {
        // Stepped/state-machine curve: hold each value until the next
        // point, then jump vertically. Matches how discrete controls
        // actually behave at runtime (no interpolation between
        // steps).
        let prevY = yFirst;
        for (const p of sorted) {
          const xCur = this._xForSample(p.time_samples || 0);
          const yCur = this._yForValue(p.value);
          // Horizontal hold from previous to this x at the previous
          // value, then vertical jump to the new value.
          parts.push(`L ${xCur} ${prevY}`);
          parts.push(`L ${xCur} ${yCur}`);
          areaParts.push(`L ${xCur} ${prevY}`);
          areaParts.push(`L ${xCur} ${yCur}`);
          prevY = yCur;
        }
      } else {
        for (const p of sorted) {
          parts.push(`L ${this._xForSample(p.time_samples || 0)} ${this._yForValue(p.value)}`);
          areaParts.push(`L ${this._xForSample(p.time_samples || 0)} ${this._yForValue(p.value)}`);
        }
      }
      const xEnd = this._xForSample(this.totalSamples);
      const yLast = this._yForValue(last.value);
      parts.push(`L ${xEnd} ${yLast}`);
      areaParts.push(`L ${xEnd} ${yLast} L ${xEnd} ${y0} Z`);
      linePath = parts.join(" ");
      areaPath = areaParts.join(" ");
    }

    const store = window.__foyer?.store;
    const posSamples = Number(store?.get?.("transport.position") ?? 0);
    const liveX = this._xForSample(posSamples);
    const liveY = this._yForValue(liveV);

    const hasPoints = Array.isArray(this.lane?.points) && this.lane.points.length > 0;

    // Marquee rect for the rubber-band overlay (Cmd/Ctrl + drag).
    let marqueeRect = null;
    if (this._marquee) {
      const xLo = Math.min(this._marquee.x0, this._marquee.x1);
      const xHi = Math.max(this._marquee.x0, this._marquee.x1);
      const yLo = Math.min(this._marquee.y0, this._marquee.y1);
      const yHi = Math.max(this._marquee.y0, this._marquee.y1);
      marqueeRect = { x: xLo, y: yLo, w: xHi - xLo, h: yHi - yLo };
    }

    return html`
      <div class="label" style="--lane-color:${color}">
        ${m.label}${discrete ? html` <span class="discrete-chip" title="Discrete control — values snap to allowed steps">${this._discreteOptions()?.length || 0}-state</span>` : null}
        <span class="mode ${mode === "off" ? "off" : ""}"
              @click=${(e) => { e.stopPropagation(); this._cycleMode(); }}>
          ${mode.toUpperCase()}
        </span>
        ${hasPoints ? html`
          <span class="reset"
                title="Clear all automation points"
                @click=${(e) => { e.stopPropagation(); this._confirmReset(); }}>
            CLR
          </span>
        ` : null}
        ${this._selectedTimes.size ? html`
          <span class="sel-chip" title="Backspace / Delete to remove · Escape to clear">${this._selectedTimes.size} selected · Del removes · Esc clears</span>
        ` : null}
        <span class="gesture-bar">
          <span class="gesture" title="Click on empty grid + drag to free-draw a curve">draw</span>
          <span class="gesture" title="Cmd/Ctrl + drag to marquee-select multiple points">⌘drag = pick</span>
          <span class="gesture" title="Shift + click a point to toggle it in the selection">⇧click = add</span>
          <span class="gesture" title="Click any selected point and drag to move the whole selection">drag = move</span>
          <span class="gesture" title="Alt + click a point to delete it">⌥click = del</span>
        </span>
      </div>
      <svg style="--lane-color:${color}"
           tabindex="0"
           @pointerdown=${this._onPointerDown}
           @contextmenu=${this._onContextMenu}
           @keydown=${(e) => this._onKeyDown(e)}>
        <rect class="hit-surface" width="100%" height="100%" />
        <line class="grid" x1="0" x2="100%" y1="${y0}" y2="${y0}" />
        <path class="area" d="${areaPath}" />
        <path class="line" d="${linePath}" />
        ${sorted.map((p) => {
          const endpoint = this._endpointKind(p.time_samples || 0);
          const cx = this._xForSample(p.time_samples || 0);
          const cy = this._yForValue(p.value);
          const selected = this._selectedTimes.has(p.time_samples);
          // Wider invisible "halo" circle in front of each point
          // gives a ~14 px hit target instead of the 6 px visible
          // dot. Without this the cursor barely changes (`grab`)
          // over the actual visible dot and the user thinks the
          // points aren't grabbable. Halo is transparent so the
          // visual size stays small.
          // CRITICAL: nested templates inside an SVG parent must
          // use Lit's `svg` tag, NOT `html`. Lit's html template
          // creates elements in the XHTML namespace by default; an
          // <rect> in the xhtml namespace is just a no-render
          // unknown element, which is why earlier the marquee box
          // looked rendered (attrs in DOM) but was actually
          // invisible (`getBBox()` returned null, `getBoundingClientRect`
          // reported 0×0). Discovered 2026-05-15 — the user could
          // see selection counters update but never see the rubber
          // band. (Same fix applied to every nested template inside
          // the lane's outer <svg>.)
          const halo = svg`
            <circle class="point-halo"
                    cx="${cx}" cy="${cy}" r="9"></circle>
          `;
          if (endpoint) {
            return svg`
              ${halo}
              <rect class="point endpoint ${selected ? "selected" : ""}"
                    x="${cx - 4}" y="${cy - 4}" width="8" height="8"
                    rx="1"></rect>
              <text class="endpoint-label"
                    x="${cx}" y="${cy - 7}"
                    text-anchor="middle">${endpoint.kind === "start" ? "▶" : "■"}</text>
            `;
          }
          return svg`
            ${halo}
            <circle class="point ${selected ? "selected" : ""}"
                    cx="${cx}" cy="${cy}"
                    r="${selected ? 6 : 4}"></circle>
          `;
        })}
        <circle class="live"
                cx="${liveX}"
                cy="${liveY}"
                r="3.5"></circle>
        ${marqueeRect ? svg`
          <rect class="marquee"
                x="${marqueeRect.x}" y="${marqueeRect.y}"
                width="${marqueeRect.w}" height="${marqueeRect.h}"></rect>
        ` : null}
      </svg>
    `;
  }
}
customElements.define("foyer-automation-lane", AutomationLane);
