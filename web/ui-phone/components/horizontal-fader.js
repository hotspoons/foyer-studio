// Horizontal touch fader. Phone-shaped — full row width, big drag
// target, dB curve. Lives here (not ui-core) because the shipping
// fader in ui-core is vertical with mouse-friendly proportions; the
// shape difference is why this is a sibling, not a config flag.
//
// Curve: matches the mixer's `normToDb` (0..0.75 → -60..0 dB,
// 0.75..1 → 0..+6 dB). Snap to unity (0 dB) when the cap passes
// within 4 % of the 0.75 detent so a thumb-drag can hit unity
// without hairline accuracy.

import { LitElement, html, css } from "lit";

export const SNAP_UNITY_TOLERANCE = 0.04;

/// Map a 0..1 fader position to dB. Two linear segments meet at
/// 0.75 / 0 dB so the visual midpoint of the fader = unity, the
/// engineering convention.
export function normToDb(n) {
  n = Math.max(0, Math.min(1, n));
  if (n <= 0.0001) return -60;
  if (n <= 0.75) return -60 + (n / 0.75) * 60;
  return ((n - 0.75) / 0.25) * 6;
}

/// Inverse of `normToDb` — used to set the cap from a backend echo.
export function dbToNorm(db) {
  if (db <= -60) return 0;
  if (db <= 0) return ((db + 60) / 60) * 0.75;
  return 0.75 + (Math.min(6, db) / 6) * 0.25;
}

export class PhoneHFader extends LitElement {
  static properties = {
    value: { type: Number },         // 0..1
    label: { type: String },
    _drag: { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      display: block;
      width: 100%;
      touch-action: pan-y;            /* Let vertical scroll keep working */
    }
    .track {
      position: relative;
      width: 100%;
      height: 36px;
      background: linear-gradient(180deg,
        rgba(15, 23, 42, 0.7),
        rgba(15, 23, 42, 0.5));
      border: 1px solid var(--color-border);
      border-radius: 18px;
      overflow: hidden;
      box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.35);
      cursor: ew-resize;
    }
    .fill {
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: var(--fill, 0%);
      background: linear-gradient(90deg,
        color-mix(in oklab, var(--color-accent) 75%, transparent),
        color-mix(in oklab, var(--color-accent-2) 70%, transparent));
      transition: width 0.05s linear;
    }
    /* Unity tick — visual reference at the 0 dB detent so the user
     * can find the snap target without dragging blind. */
    .unity-tick {
      position: absolute;
      left: 75%;
      top: 4px; bottom: 4px;
      width: 1px;
      background: rgba(255, 255, 255, 0.45);
      pointer-events: none;
    }
    .cap {
      position: absolute;
      top: -2px; bottom: -2px;
      width: 28px;
      transform: translateX(-50%);
      left: var(--cap, 0%);
      background: linear-gradient(180deg, #f1f5f9, #cbd5e1);
      border: 1px solid var(--color-border);
      border-radius: 14px;
      box-shadow:
        0 2px 6px rgba(0, 0, 0, 0.4),
        inset 0 1px 0 rgba(255, 255, 255, 0.5);
      pointer-events: none;
    }
    :host([drag]) .cap {
      background: linear-gradient(180deg, var(--color-accent-3), var(--color-accent-2));
      border-color: var(--color-accent);
    }
    .label {
      margin-top: 2px;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--color-text-muted);
      text-align: right;
    }
  `;

  constructor() {
    super();
    this.value = dbToNorm(0);
    this.label = "";
    this._drag = false;
  }

  render() {
    const v = Math.max(0, Math.min(1, this.value || 0));
    const pct = (v * 100).toFixed(1);
    return html`
      <div class="track"
           @pointerdown=${this._down}
           @pointermove=${this._move}
           @pointerup=${this._up}
           @pointercancel=${this._up}>
        <div class="fill" style="--fill:${pct}%"></div>
        <div class="unity-tick"></div>
        <div class="cap" style="--cap:${pct}%"></div>
      </div>
      <div class="label">${this.label}</div>
    `;
  }

  _xToNorm(ev, el) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return this.value;
    const raw = (ev.clientX - rect.left) / rect.width;
    let n = Math.max(0, Math.min(1, raw));
    if (Math.abs(n - 0.75) < SNAP_UNITY_TOLERANCE) n = 0.75;
    return n;
  }

  _emit(n) {
    this.dispatchEvent(new CustomEvent("input", {
      detail: { value: n, db: normToDb(n) },
      bubbles: true,
      composed: true,
    }));
  }

  _down = (ev) => {
    ev.preventDefault();
    this._drag = true;
    this.toggleAttribute("drag", true);
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
    const n = this._xToNorm(ev, ev.currentTarget);
    this.value = n;
    this._emit(n);
  };
  _move = (ev) => {
    if (!this._drag) return;
    const n = this._xToNorm(ev, ev.currentTarget);
    this.value = n;
    this._emit(n);
  };
  _up = (ev) => {
    if (!this._drag) return;
    this._drag = false;
    this.toggleAttribute("drag", false);
    ev.currentTarget.releasePointerCapture?.(ev.pointerId);
    this.dispatchEvent(new CustomEvent("change", {
      detail: { value: this.value, db: normToDb(this.value) },
      bubbles: true,
      composed: true,
    }));
  };
}
customElements.define("foyer-phone-hfader", PhoneHFader);
