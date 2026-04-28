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

import { LitElement, html, css } from "lit";
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
      stroke-width: 1;
      cursor: grab;
      pointer-events: all;
    }
    svg .point:hover { r: 5; }
    svg .point:active { cursor: grabbing; }
    svg .live {
      fill: #fff;
      stroke: var(--lane-color, var(--color-accent, #7c5cff));
      stroke-width: 2;
      pointer-events: none;
    }
    svg .hit-surface {
      fill: transparent;
      pointer-events: all;
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
    this._drag = null;
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

  disconnectedCallback() {
    super.disconnectedCallback();
    this._endDrag();
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
  _yForValue(v) {
    const m = metaFor(this.lane?.control_id);
    const clamped = Math.max(m.min, Math.min(m.max, v));
    const norm = (clamped - m.min) / Math.max(0.0001, m.max - m.min);
    const usable = LANE_HEIGHT - PAD_Y * 2;
    return LANE_HEIGHT - PAD_Y - norm * usable;
  }
  _valueForY(y) {
    const m = metaFor(this.lane?.control_id);
    const norm = (LANE_HEIGHT - PAD_Y - y) / Math.max(0.0001, LANE_HEIGHT - PAD_Y * 2);
    const clamped = Math.max(0, Math.min(1, norm));
    return m.min + clamped * (m.max - m.min);
  }

  // ─── hit testing ──────────────────────────────────────────────────

  _nearestPoint(clientX) {
    const rect = this.getBoundingClientRect();
    const x = clientX - rect.left;
    const pts = Array.isArray(this.lane?.points) ? this.lane.points : [];
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
    const rect = this.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    // Usability: placing a point at the very start of the lane is a
    // common first gesture; prefer "add at t=0" over grabbing a nearby
    // first point when the click is inside the left-edge gutter.
    if (x <= HIT_RADIUS * 1.5) {
      this._addPointAt(ev);
      return;
    }
    const { point, dist } = this._nearestPoint(ev.clientX);
    if (point && dist <= HIT_RADIUS) {
      this._startDrag(ev, point);
    } else {
      this._addPointAt(ev);
    }
  }

  _startDrag(ev, point) {
    this._drag = {
      original: { ...point },
      current: point,
      startX: ev.clientX,
      startY: ev.clientY,
    };
    window.addEventListener("pointermove", this._onMove);
    window.addEventListener("pointerup", this._onUp);
  }

  _onMove = (ev) => {
    if (!this._drag) return;
    const d = this._drag;
    const rect = this.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    d.current.time_samples = Math.max(0, Math.min(this.totalSamples, this._sampleForX(x)));
    d.current.value = this._valueForY(y);
    this.requestUpdate();
  };

  _onUp = (_ev) => {
    if (!this._drag) return;
    const d = this._drag;
    const sameTime = d.current.time_samples === d.original.time_samples;
    const sameValue = Math.abs(d.current.value - d.original.value) < 0.0001;
    if (!sameTime || !sameValue) {
      this._sendCommand("update_automation_point", {
        lane_id: this.lane.control_id,
        original_time_samples: d.original.time_samples,
        new_time_samples: d.current.time_samples,
        value: d.current.value,
      });
    }
    this._endDrag();
  };

  _endDrag() {
    this._drag = null;
    window.removeEventListener("pointermove", this._onMove);
    window.removeEventListener("pointerup", this._onUp);
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
    }
  }

  _cycleMode() {
    const cur = String(this.lane?.mode || "off").toLowerCase();
    const idx = MODE_CYCLE.indexOf(cur);
    const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
    this._sendCommand("set_automation_mode", {
      lane_id: this.lane.control_id,
      mode: next,
    });
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
    const m = metaFor(lane.control_id);
    const mode = lane.mode || "off";
    const pts = Array.isArray(lane.points) ? lane.points : [];
    const sorted = [...pts].sort((a, b) => (a.time_samples || 0) - (b.time_samples || 0));
    const color = this.color || m.color;

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
      for (const p of sorted) {
        parts.push(`L ${this._xForSample(p.time_samples || 0)} ${this._yForValue(p.value)}`);
        areaParts.push(`L ${this._xForSample(p.time_samples || 0)} ${this._yForValue(p.value)}`);
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

    return html`
      <div class="label" style="--lane-color:${color}">
        ${m.label}
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
      </div>
      <svg style="--lane-color:${color}"
           @pointerdown=${this._onPointerDown}
           @contextmenu=${this._onContextMenu}>
        <rect class="hit-surface" width="100%" height="100%" />
        <line class="grid" x1="0" x2="100%" y1="${y0}" y2="${y0}" />
        <path class="area" d="${areaPath}" />
        <path class="line" d="${linePath}" />
        ${sorted.map((p) => html`
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
