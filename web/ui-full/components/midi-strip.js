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
import { resolveMidiNoteColor, getVizPref } from "foyer-ui-core/viz/viz-settings.js";

export class MidiStrip extends LitElement {
  static properties = {
    notes: { attribute: false },
    color: { type: String },
    // Region the notes belong to. Needed so the strip can scale the
    // x axis by the REGION'S tick length instead of the last note's
    // tick position — without this, resizing the region (which keeps
    // the notes anchored in absolute time) would visibly stretch the
    // mini-viz because every note was being normalized against the
    // moving `tMax` (last-note end). Audio waveforms don't do this:
    // they paint at fixed sample offsets and just leave empty space
    // past the final transient. The MIDI strip should match.
    region: { attribute: false },
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
    this.region = null;
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

    // Pitch bounds straight from the note list — the y-axis is not
    // affected by region resize so it's safe to range over notes.
    let noteEndMax = 0;
    let pLo = 127, pHi = 0;
    for (const n of notes) {
      const end = (n.start_ticks || 0) + (n.length_ticks || 0);
      if (end > noteEndMax) noteEndMax = end;
      if (n.pitch < pLo) pLo = n.pitch;
      if (n.pitch > pHi) pHi = n.pitch;
    }
    // Time bounds: prefer the REGION'S length in ticks so the viz
    // behaves like a fixed window over the underlying notes (matching
    // how audio waveforms render — sample positions don't move when
    // the region's edge is dragged). Falls back to the last-note end
    // when we can't compute the region tick length, which preserves
    // the legacy behavior on hosts that don't surface a useful
    // region.length_samples + session tempo / sample rate / ppqn.
    const tMax = this._regionTicks() || noteEndMax;
    if (tMax <= 0) return;
    // Pad pitch range a hair so notes aren't flush to edges.
    if (pHi - pLo < 1) { pLo = Math.max(0, pLo - 1); pHi = Math.min(127, pHi + 1); }
    const pRange = pHi - pLo;

    const rowH = Math.max(1, Math.floor(h / (pRange + 1)));
    const color = resolveMidiNoteColor(this.color || "");
    const shading = Math.min(1, Math.max(0, getVizPref("midiVelocityShading") ?? 0.6));
    ctx.fillStyle = color;

    for (const n of notes) {
      const startTick = n.start_ticks || 0;
      const endTick = startTick + (n.length_ticks || 0);
      // Notes that fall past the region's right edge get clipped at
      // the canvas edge — same visual as a waveform when the region
      // is trimmed shorter than its source.
      const x0 = Math.floor(Math.min(1, startTick / tMax) * w);
      const x1Raw = Math.floor(Math.min(1, endTick / tMax) * w);
      const x1 = Math.max(x0 + 1, x1Raw);
      if (x0 >= w) continue;
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

  /**
   * Region's length expressed in MIDI ticks. Derived from
   * `region.length_samples` + the active session's tempo, sample
   * rate, and ppqn. Returns 0 when any of those aren't available
   * (the caller falls back to the last-note end so the strip still
   * paints something on legacy hosts that don't surface tempo).
   */
  _regionTicks() {
    const r = this.region;
    if (!r || !Number.isFinite(r.length_samples) || r.length_samples <= 0) return 0;
    const session = globalThis.__foyer?.store?.state?.session;
    if (!session) return 0;
    const sr = Number(session.sample_rate || session.meta?.sample_rate || 0);
    // PPQN default matches Ardour's `Temporal::ticks_per_beat` (1920)
    // — that's the scale `Beats::to_ticks()` and the server's
    // `expand_sequencer_layout` both encode notes at. The pre-2026-05
    // 960 fallback was off by 2x and showed up as notes positioned
    // at half their correct x inside the strip.
    const ppqn = Number(session.ppqn || 1920);
    const controls = globalThis.__foyer?.store?.state?.controls;
    const tempo = Number(controls?.get?.("transport.tempo") ?? session.transport?.tempo?.value ?? 0);
    if (!sr || !ppqn || !tempo) return 0;
    // ticks_per_sample = ppqn * tempo / (sr * 60)
    const ticksPerSample = (ppqn * tempo) / (sr * 60);
    return Number(r.length_samples) * ticksPerSample;
  }

  render() {
    return html`<canvas></canvas>`;
  }
}
customElements.define("foyer-midi-strip", MidiStrip);
