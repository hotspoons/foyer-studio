// Vertical peak meter. Renders into a <canvas> at 30 Hz with DPR
// scaling, a green-yellow-red gradient that matches pro-DAW
// conventions (-12 dB yellow knee, clip at 0 dB), a peak-hold
// marker that decays slower than the level, and tick marks so the
// fader's dB reading is legible at a glance.
//
// Input: `value` in dBFS. Everything outside [MIN_DB, MAX_DB] is
// clamped. `height` is the canvas backing height in CSS pixels.

import { LitElement, html, css } from "lit";

const MIN_DB = -60;
const MAX_DB = 6;
// Tick marks in dB. Only shown when the meter is tall enough.
const TICKS = [-48, -24, -12, -6, 0];

export class Meter extends LitElement {
  static properties = {
    value:  { type: Number },
    height: { type: Number },
  };

  static styles = css`
    :host {
      display: inline-block;
      line-height: 0;
    }
    canvas {
      display: block;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 3px;
    }
  `;

  constructor() {
    super();
    this.value = MIN_DB;
    this.height = 140;
    this._current = MIN_DB;
    this._peakHold = MIN_DB;
    this._peakHoldSetAt = 0;
    this._decay = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._decay = setInterval(() => {
      const now = performance.now();
      // Level: decay 48 dB/sec toward the live value (~16 ms steps
      // in this 30 Hz loop).
      const levelStep = 48 / 30;
      if (this.value > this._current) {
        this._current = this.value;             // rise instantly
      } else {
        this._current = Math.max(this.value, this._current - levelStep);
      }
      // Peak hold: latch the highest seen over the last ~1.5 s,
      // then decay 12 dB/sec so it drifts down visibly when
      // silence persists.
      if (this._current >= this._peakHold) {
        this._peakHold = this._current;
        this._peakHoldSetAt = now;
      } else if (now - this._peakHoldSetAt > 1500) {
        const peakStep = 12 / 30;
        this._peakHold = Math.max(MIN_DB, this._peakHold - peakStep);
      }
      this._paint();
    }, 33);
  }
  disconnectedCallback() {
    clearInterval(this._decay);
    super.disconnectedCallback();
  }

  updated(changed) {
    if (changed.has("value")) this._paint();
  }

  /** Convert a dB value to 0..1 along the meter's vertical axis. */
  _norm(db) {
    return Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)));
  }

  _paint() {
    const c = this.renderRoot.querySelector("canvas");
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = 10;
    const cssH = this.height;
    const w = cssW * dpr;
    const h = cssH * dpr;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      c.style.width = `${cssW}px`;
      c.style.height = `${cssH}px`;
    }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Baseline fill — a subtle dark inset so the meter has
    // visible "bounds" even when the level is at -60 dB and
    // there's nothing to draw on top.
    const grad = ctx.createLinearGradient(0, 0, 0, cssH);
    grad.addColorStop(0,    "rgba(255, 255, 255, 0.02)");
    grad.addColorStop(1,    "rgba(0, 0, 0, 0.18)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cssW, cssH);

    // Level bar: three-stop green → amber → red gradient, keyed
    // off absolute dB thresholds (not position) so the colors
    // don't shift when MIN_DB changes.
    const levelDb = Math.max(MIN_DB, Math.min(MAX_DB, this._current));
    const filledCssH = this._norm(levelDb) * cssH;
    if (filledCssH > 0) {
      const lg = ctx.createLinearGradient(0, cssH, 0, 0);
      // Stops: green up to -12, amber -12..-3, red above -3.
      const g12 = this._norm(-12);
      const g3  = this._norm(-3);
      lg.addColorStop(0,    "oklch(64% 0.18 150)");  // green
      lg.addColorStop(g12,  "oklch(68% 0.16 130)");  // green-yellow
      lg.addColorStop(g3,   "oklch(78% 0.18 85)");   // amber
      lg.addColorStop(1,    "oklch(68% 0.24 25)");   // hot red
      ctx.fillStyle = lg;
      ctx.fillRect(1, cssH - filledCssH, cssW - 2, filledCssH);
    }

    // Peak-hold marker — 1-pixel bright line at the highest
    // recent value.
    if (this._peakHold > MIN_DB) {
      const y = cssH - this._norm(this._peakHold) * cssH;
      const pkColor = this._peakHold >= -3
        ? "oklch(80% 0.24 25)"
        : this._peakHold >= -12
          ? "oklch(88% 0.16 80)"
          : "oklch(86% 0.16 150)";
      ctx.fillStyle = pkColor;
      ctx.fillRect(0, Math.max(0, Math.floor(y) - 0.5), cssW, 1.5);
    }

    // Horizontal ticks — thin white lines at each canonical dB.
    // Only drawn when the meter is tall enough for them to read
    // as reference rather than noise.
    if (cssH >= 60) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const db of TICKS) {
        const y = cssH - this._norm(db) * cssH;
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(cssW, Math.round(y) + 0.5);
      }
      ctx.stroke();
    }
  }

  render() {
    return html`<canvas></canvas>`;
  }
}
customElements.define("foyer-meter", Meter);
