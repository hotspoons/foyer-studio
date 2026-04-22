// Automation lane — read-only polyline renderer for Phase A.
//
// Takes an `AutomationLane` from `track.automation_lanes` and paints
// its points against the timeline's px-per-sample scale. The lane
// sits beneath the track's region strip and shares the same x-axis
// so a point at `time_samples = N` lines up with the waveform at
// sample N.
//
// Phase A is read-only. The playhead-driven dot comes for free: we
// subscribe to the underlying `control_id` and plot a moving circle
// at the interpolated value whenever the parameter changes. No edit
// affordances yet.
//
// Phase B (edit) will reuse this render path and add pointer handlers
// for add/move/delete of points. Scaffolding is already sized for
// that — `_pointAtX`, `_xForSample`, `_yForValue` are the hooks.

import { LitElement, html, css } from "lit";
import { ControlController } from "../store.js";

const LANE_HEIGHT = 48;
const PAD_Y = 4;

/** Lane label + range hints per control id. Keeps the Y-axis mapping
 *  sane without having to round-trip the Parameter.range field. Extra
 *  control ids fall through to a 0..1 default. */
const LANE_META = {
  gain:  { label: "Gain", min: -60, max: 6, unit: "dB", color: "var(--color-accent, #7c5cff)" },
  pan:   { label: "Pan",  min: -1,  max: 1, unit: "",   color: "#22d3ee" },
  mute:  { label: "Mute", min: 0,   max: 1, unit: "",   color: "#fbbf24" },
  solo:  { label: "Solo", min: 0,   max: 1, unit: "",   color: "#f87171" },
};

function metaFor(controlId) {
  const suffix = String(controlId || "").split(".").pop();
  return LANE_META[suffix] || { label: suffix || "param", min: 0, max: 1, unit: "", color: "var(--color-accent)" };
}

export class AutomationLane extends LitElement {
  static properties = {
    /** The AutomationLane payload — { control_id, mode, points }. */
    lane: { attribute: false },
    /** Total timeline length in samples (for x-axis scaling). */
    totalSamples: { type: Number, attribute: "total-samples" },
    /** px-per-second zoom from the parent timeline. */
    pxPerSec: { type: Number, attribute: "px-per-sec" },
    /** Session sample rate — needed to turn time_samples into seconds. */
    sampleRate: { type: Number, attribute: "sample-rate" },
    /** Optional track color for the stroke tint. */
    color: { type: String },
    _liveValue: { state: true, type: Number },
  };

  static styles = css`
    :host {
      display: block;
      position: relative;
      height: ${LANE_HEIGHT}px;
      background: color-mix(in oklab, var(--color-surface-elevated) 80%, transparent);
      border-top: 1px solid color-mix(in oklab, var(--color-border) 50%, transparent);
      overflow: hidden;
      font-family: var(--font-sans);
    }
    .label {
      position: absolute;
      top: 2px; left: 6px;
      font-size: 9px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      pointer-events: none;
      z-index: 1;
    }
    .label .mode {
      margin-left: 6px;
      padding: 0 5px;
      border-radius: 3px;
      background: color-mix(in oklab, var(--color-accent) 20%, transparent);
      color: var(--color-accent);
      font-size: 8px;
    }
    .label .mode.off { background: transparent; color: var(--color-text-muted); }
    svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
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
    }
    svg .area {
      fill: var(--lane-color, var(--color-accent, #7c5cff));
      fill-opacity: 0.12;
    }
    svg .point {
      fill: var(--lane-color, var(--color-accent, #7c5cff));
      stroke: var(--color-surface);
      stroke-width: 1;
    }
    svg .live {
      fill: #fff;
      stroke: var(--lane-color, var(--color-accent, #7c5cff));
      stroke-width: 2;
    }
  `;

  constructor() {
    super();
    this.lane = null;
    this.totalSamples = 48_000 * 60;
    this.pxPerSec = 60;
    this.sampleRate = 48_000;
    this.color = "";
    this._liveValue = null;
    this._controlCtl = null;
  }

  updated(changed) {
    if (changed.has("lane") && this.lane?.control_id) {
      const store = window.__foyer?.store;
      if (store) {
        this._controlCtl?.hostDisconnected?.();
        this._controlCtl = new ControlController(this, store, this.lane.control_id);
      }
    }
  }

  _xForSample(sample) {
    const sr = this.sampleRate || 48_000;
    return (sample / sr) * (this.pxPerSec || 60);
  }
  _yForValue(v) {
    const m = metaFor(this.lane?.control_id);
    const clamped = Math.max(m.min, Math.min(m.max, v));
    const norm = (clamped - m.min) / Math.max(0.0001, m.max - m.min);
    const usable = LANE_HEIGHT - PAD_Y * 2;
    return LANE_HEIGHT - PAD_Y - norm * usable;
  }

  render() {
    const lane = this.lane;
    if (!lane) return html``;
    const m = metaFor(lane.control_id);
    const mode = lane.mode || "off";
    const points = Array.isArray(lane.points) ? lane.points : [];
    const color = this.color || m.color;

    // Build the polyline d-string. Even when there are zero points
    // we still paint the label/mode chip — the lane's value is
    // "whatever the static Parameter says", so show a flat line at
    // that current value if the control is live.
    const liveV = this._liveValue ?? (points.length > 0 ? points[0].value : (m.min + m.max) / 2);
    let linePath = "";
    let areaPath = "";
    const y0 = this._yForValue(m.min);
    if (points.length === 0) {
      const y = this._yForValue(liveV);
      linePath = `M 0 ${y} L ${this._xForSample(this.totalSamples)} ${y}`;
      areaPath = `M 0 ${y} L ${this._xForSample(this.totalSamples)} ${y} L ${this._xForSample(this.totalSamples)} ${y0} L 0 ${y0} Z`;
    } else {
      const parts = [];
      const areaParts = [];
      const sorted = [...points].sort((a, b) => (a.time_samples || 0) - (b.time_samples || 0));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const x0 = 0;
      const yFirst = this._yForValue(first.value);
      parts.push(`M ${x0} ${yFirst}`);
      areaParts.push(`M ${x0} ${y0} L ${x0} ${yFirst}`);
      for (const p of sorted) {
        const x = this._xForSample(p.time_samples || 0);
        const y = this._yForValue(p.value);
        parts.push(`L ${x} ${y}`);
        areaParts.push(`L ${x} ${y}`);
      }
      const xEnd = this._xForSample(this.totalSamples);
      const yLast = this._yForValue(last.value);
      parts.push(`L ${xEnd} ${yLast}`);
      areaParts.push(`L ${xEnd} ${yLast} L ${xEnd} ${y0} Z`);
      linePath = parts.join(" ");
      areaPath = areaParts.join(" ");
    }

    // Live playhead dot: sample the control's current value (which
    // flows in via control_update events) and drop a circle at the
    // current x = playhead. The x-position comes from the transport
    // position if the store has it.
    const store = window.__foyer?.store;
    const posSamples = Number(store?.get?.("transport.position") ?? 0);
    const liveX = this._xForSample(posSamples);
    const liveY = this._yForValue(liveV);

    return html`
      <div class="label" style="--lane-color:${color}">
        ${m.label}
        <span class="mode ${mode === "off" ? "off" : ""}">${mode.toUpperCase()}</span>
      </div>
      <svg style="--lane-color:${color}">
        <line class="grid" x1="0" x2="100%" y1="${y0}" y2="${y0}" />
        <path class="area" d="${areaPath}" />
        <path class="line" d="${linePath}" />
        ${points.map((p) => html`
          <circle class="point"
                  cx="${this._xForSample(p.time_samples || 0)}"
                  cy="${this._yForValue(p.value)}"
                  r="3"></circle>
        `)}
        <circle class="live"
                cx="${liveX}"
                cy="${liveY}"
                r="3.5"></circle>
      </svg>
    `;
  }
}
customElements.define("foyer-automation-lane", AutomationLane);
