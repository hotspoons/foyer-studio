// Inline MIDI region visualization — the rectangle that sits inside a
// timeline region lozenge for MIDI tracks. Draws the actual note list
// as small horizontal bars at their proper time position / pitch row.
//
// Replaces the synthesized-audio-waveform fallback that previously
// filled MIDI region rectangles (the `synth_waveform` fake peaks in
// the host backend would paint a convincing-looking sine even on a
// MIDI region, which is visually lying about what's there).
//
// Sizing: fills the parent region container at whatever width the
// timeline laid it out in. Notes are auto-ranged by pitch (min → max)
// with one pixel-ish band per pitch row so dense drum kits and sparse
// melodies both read well.

import { LitElement, html, css } from "lit";
import { resolveMidiNoteColor, getVizPref } from "../viz/viz-settings.js";

export class MidiStrip extends LitElement {
  static properties = {
    notes: { attribute: false },
    color: { type: String },
  };

  static styles = css`
    :host {
      display: block;
      width: 100%; height: 100%;
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    canvas {
      width: 100%; height: 100%;
      display: block;
    }
  `;

  constructor() {
    super();
    this.notes = null;
    this.color = "";
    this._ro = null;
    this._onPrefs = () => this._draw();
  }

  firstUpdated() {
    this._canvas = this.renderRoot.querySelector("canvas");
    this._ro = new ResizeObserver(() => this._draw());
    this._ro.observe(this);
    window.addEventListener("foyer:viz-prefs-changed", this._onPrefs);
    this._draw();
  }

  updated() { this._draw(); }

  disconnectedCallback() {
    this._ro?.disconnect();
    window.removeEventListener("foyer:viz-prefs-changed", this._onPrefs);
    super.disconnectedCallback();
  }

  _draw() {
    const c = this._canvas;
    if (!c) return;
    const rect = this.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(rect.width  * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, w, h);

    const notes = this.notes || [];
    if (notes.length === 0) return;

    // Determine time bounds (we plot note start + length against the
    // region's own timeline, which starts at start_ticks=0).
    let tMax = 0;
    let pLo = 127, pHi = 0;
    for (const n of notes) {
      const end = (n.start_ticks || 0) + (n.length_ticks || 0);
      if (end > tMax) tMax = end;
      if (n.pitch < pLo) pLo = n.pitch;
      if (n.pitch > pHi) pHi = n.pitch;
    }
    if (tMax <= 0) return;
    // Pad pitch range a hair so notes aren't flush to edges.
    if (pHi - pLo < 1) { pLo = Math.max(0, pLo - 1); pHi = Math.min(127, pHi + 1); }
    const pRange = pHi - pLo;

    const rowH = Math.max(1, Math.floor(h / (pRange + 1)));
    const color = resolveMidiNoteColor(this.color || "");
    const shading = Math.min(1, Math.max(0, getVizPref("midiVelocityShading") ?? 0.6));
    ctx.fillStyle = color;

    for (const n of notes) {
      const x0 = Math.floor(((n.start_ticks || 0) / tMax) * w);
      const x1 = Math.max(x0 + 1, Math.floor(((n.start_ticks + n.length_ticks) / tMax) * w));
      const y  = Math.floor((pHi - n.pitch) * rowH);
      const nh = Math.max(1, rowH - 1);
      // Alpha: 1-shading baseline + shading × velocity/127 so at
      // shading=0 every note is full-strength (flat), and at
      // shading=1 velocity fully modulates.
      const vel = Math.min(127, Math.max(0, n.velocity || 0));
      ctx.globalAlpha = (1 - shading) + shading * (vel / 127);
      ctx.fillRect(x0, y, x1 - x0, nh);
    }
    ctx.globalAlpha = 1;
  }

  render() {
    return html`<canvas></canvas>`;
  }
}
customElements.define("foyer-midi-strip", MidiStrip);
