// Vertical peak meter. Renders into a <canvas> at 30 Hz max. Clamps and decays
// between frames so the last meter reading doesn't look "stuck" when updates
// pause.

import { LitElement, html, css } from "lit";

const MIN_DB = -60;
const MAX_DB = 6;

export class Meter extends LitElement {
  static properties = {
    value: { type: Number }, // dB
    height: { type: Number },
  };

  static styles = css`
    :host { display: inline-block; }
    canvas { display: block; background: var(--color-bg); border: 1px solid var(--color-line); border-radius: 2px; }
  `;

  constructor() {
    super();
    this.value = MIN_DB;
    this.height = 140;
    this._current = MIN_DB;
    this._decay = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._decay = setInterval(() => {
      // 24 dB/sec decay
      const step = 24 / 30;
      if (this._current > this.value) this._current -= step;
      if (this._current < this.value) this._current = this.value;
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

  _paint() {
    const c = this.renderRoot.querySelector("canvas");
    if (!c) return;
    const w = c.width;
    const h = c.height;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, w, h);

    const v = Math.max(MIN_DB, Math.min(MAX_DB, Math.max(this._current, this.value)));
    const norm = (v - MIN_DB) / (MAX_DB - MIN_DB);
    const filled = Math.floor(norm * h);

    // Color gradient: green below -12, yellow -12..-3, red above.
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, "oklch(62% 0.17 150)");
    grad.addColorStop(0.55, "oklch(75% 0.15 70)");
    grad.addColorStop(0.85, "oklch(68% 0.22 25)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, h - filled, w, filled);
  }

  render() {
    return html`<canvas width="6" height="${this.height}"></canvas>`;
  }
}
customElements.define("foyer-meter", Meter);
