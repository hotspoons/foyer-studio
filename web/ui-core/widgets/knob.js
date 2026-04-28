// Circular knob for plugin parameters.
//
// SVG-rendered, drag-vertically-to-turn, double-click to reset. Internally
// works in normalized UI-space [0..1]; the caller provides the parameter's
// range/scale and receives both the raw native value and the normalized one on
// `input` events.
//
// Intentionally dumb: no store access, no ws. The parent (param-control /
// plugin-panel) binds value and dispatches ControlSet.

import { LitElement, html, css } from "lit";

import { toNorm, fromNorm, formatValue, clamp } from "foyer-core/param-scale.js";

const ARC_START = -135; // deg, 7-o'clock
const ARC_END = 135; // deg, 5-o'clock
const ARC_SPAN = ARC_END - ARC_START;

function polar(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx, cy, r, start, end) {
  // `start`/`end` are degrees in screen-space where 0deg points right.
  // We rotate so 0deg points UP: i.e. screen-angle = deg - 90.
  const s = start - 90;
  const e = end - 90;
  const [sx, sy] = polar(cx, cy, r, s);
  const [ex, ey] = polar(cx, cy, r, e);
  const large = Math.abs(end - start) > 180 ? 1 : 0;
  const sweep = end > start ? 1 : 0;
  return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${ex.toFixed(2)} ${ey.toFixed(2)}`;
}

export class Knob extends LitElement {
  static properties = {
    value: { type: Number },
    range: { type: Array },
    scale: { type: String },
    unit: { type: String },
    label: { type: String },
    size: { type: Number },
    defaultValue: { type: Number },
    // Internal
    _dragging: { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      user-select: none;
      color: var(--color-text);
      font-family: var(--font-sans);
    }
    .label {
      font-size: 9px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--color-text-muted);
    }
    svg {
      display: block;
      touch-action: none;
      cursor: ns-resize;
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
    }
    :host([_dragging]) svg {
      filter: drop-shadow(0 2px 6px color-mix(in oklab, var(--color-accent) 40%, black));
    }
    .val {
      font-family: var(--font-mono);
      font-size: 9px;
      font-variant-numeric: tabular-nums;
      color: var(--color-text-muted);
      min-height: 12px;
    }
    :host([_dragging]) .val { color: var(--color-accent-3); }
  `;

  constructor() {
    super();
    this.value = 0;
    this.range = [0, 1];
    this.scale = "linear";
    this.unit = "";
    this.label = "";
    this.size = 44;
    this.defaultValue = undefined;
    this._dragging = false;
    this._startY = 0;
    this._startNorm = 0;
  }

  updated(changed) {
    if (changed.has("_dragging")) {
      if (this._dragging) this.setAttribute("_dragging", "");
      else this.removeAttribute("_dragging");
    }
  }

  render() {
    const s = this.size;
    const r = s / 2 - 3;
    const cx = s / 2;
    const cy = s / 2;
    const rng = this.range?.length === 2 ? this.range : [0, 1];
    const n = clamp(toNorm(this.value, rng, this.scale), 0, 1);
    const angle = ARC_START + ARC_SPAN * n;
    const [ix, iy] = polar(cx, cy, r - 4, angle - 90);
    // Background arc (full span). Foreground arc (0..value).
    const bg = arcPath(cx, cy, r, ARC_START, ARC_END);
    const fg = arcPath(cx, cy, r, ARC_START, angle);

    return html`
      <div class="label">${this.label || ""}</div>
      <svg
        width=${s}
        height=${s}
        viewBox="0 0 ${s} ${s}"
        @pointerdown=${this._down}
        @pointermove=${this._move}
        @pointerup=${this._up}
        @pointercancel=${this._up}
        @dblclick=${this._reset}
        @wheel=${this._wheel}
      >
        <defs>
          <linearGradient id="knobfill-${this._uid()}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--color-surface-elevated)" />
            <stop offset="100%" stop-color="var(--color-surface-muted, var(--color-surface))" />
          </linearGradient>
          <linearGradient id="knoba-${this._uid()}" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="var(--color-accent)" />
            <stop offset="100%" stop-color="var(--color-accent-2)" />
          </linearGradient>
        </defs>
        <circle cx=${cx} cy=${cy} r=${r - 5}
                fill="url(#knobfill-${this._uid()})"
                stroke="var(--color-border)" stroke-width="1"/>
        <path d=${bg} fill="none"
              stroke="color-mix(in oklab, var(--color-border) 80%, transparent)"
              stroke-width="2" stroke-linecap="round"/>
        <path d=${fg} fill="none"
              stroke="url(#knoba-${this._uid()})"
              stroke-width="2.5" stroke-linecap="round"/>
        <line x1=${cx} y1=${cy} x2=${ix.toFixed(2)} y2=${iy.toFixed(2)}
              stroke="var(--color-text)" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx=${cx} cy=${cy} r="1.5" fill="var(--color-text)"/>
      </svg>
      <div class="val">${formatValue(this.value, this.unit, this.scale)}</div>
    `;
  }

  _uid() {
    if (!this.__uid) this.__uid = Math.random().toString(36).slice(2, 8);
    return this.__uid;
  }

  _down(ev) {
    ev.preventDefault();
    ev.currentTarget.setPointerCapture(ev.pointerId);
    this._dragging = true;
    this._startY = ev.clientY;
    const rng = this.range?.length === 2 ? this.range : [0, 1];
    this._startNorm = clamp(toNorm(this.value, rng, this.scale), 0, 1);
    this._shifted = ev.shiftKey;
  }

  _move(ev) {
    if (!this._dragging) return;
    const dy = this._startY - ev.clientY;
    const travel = ev.shiftKey ? 400 : 150; // px = full range. Shift = fine.
    const delta = dy / travel;
    const rng = this.range?.length === 2 ? this.range : [0, 1];
    const n = clamp(this._startNorm + delta, 0, 1);
    const raw = fromNorm(n, rng, this.scale);
    this.value = raw;
    this._emit(raw, n);
  }

  _up(ev) {
    this._dragging = false;
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch {}
    this.dispatchEvent(new CustomEvent("change", {
      detail: { value: this.value },
      bubbles: true,
      composed: true,
    }));
  }

  _reset() {
    if (this.defaultValue === undefined) return;
    this.value = this.defaultValue;
    const rng = this.range?.length === 2 ? this.range : [0, 1];
    const n = toNorm(this.defaultValue, rng, this.scale);
    this._emit(this.defaultValue, n);
    this.dispatchEvent(new CustomEvent("change", {
      detail: { value: this.defaultValue },
      bubbles: true,
      composed: true,
    }));
  }

  _wheel(ev) {
    ev.preventDefault();
    const rng = this.range?.length === 2 ? this.range : [0, 1];
    const n0 = clamp(toNorm(this.value, rng, this.scale), 0, 1);
    const step = ev.shiftKey ? 0.005 : 0.02;
    const n = clamp(n0 + (ev.deltaY < 0 ? step : -step), 0, 1);
    const raw = fromNorm(n, rng, this.scale);
    this.value = raw;
    this._emit(raw, n);
  }

  _emit(raw, norm) {
    this.dispatchEvent(new CustomEvent("input", {
      detail: { value: raw, norm },
      bubbles: true,
      composed: true,
    }));
  }
}
customElements.define("foyer-knob", Knob);
