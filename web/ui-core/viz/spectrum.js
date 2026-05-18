// SPDX-License-Identifier: Apache-2.0
//
// <foyer-spectrum> — real-time spectrum analyser widget.
//
// Subscribes to `Event::SpectrumFrame` for a given target (master /
// monitor / track id) and renders BOTH a current bar plot AND a
// waterfall history of the recent frames. Bars on top, waterfall
// below, sized to fill the host element.
//
// The widget owns its WS subscription lifecycle:
//   · connectedCallback   → SubscribeSpectrum
//   · disconnectedCallback → UnsubscribeSpectrum
//   · property change on `target` → re-subscribe
//
// Rendering is plain 2D canvas — the bar plot needs zero shader hardware
// and the waterfall scrolls cheaply by blitting last frame's image left.
// Color ramp is the same palette as `viz-settings.js`'s waveform fills
// so the surface visually belongs to the rest of the viz system.

import { LitElement, html, css } from "lit";

const HISTORY_FRAMES_MAX = 256;
const DEFAULT_FFT_SIZE = 2048;
const DEFAULT_MIN_DB = -100;

const FFT_SIZE_OPTIONS = [512, 1024, 2048, 4096, 8192];
const HISTORY_DEPTH_OPTIONS = [64, 128, 256, 512];

export class FoyerSpectrum extends LitElement {
  static properties = {
    /// Target serialised as the Rust enum: `{ kind: "master" }` /
    /// `{ kind: "monitor" }` / `{ kind: "track", id: "track.xxx" }`.
    target: { attribute: false },
    /// Channel index to render (0 = left/mono, 1 = right, …). `null`
    /// overlays every channel.
    channel: { type: Number },
    /// Optional override of the subscription's FFT size. Falls back to
    /// the backend's default when unset.
    fftSize: { type: Number },
    /// Display label. Falls back to the target's slug.
    label: { type: String },
    _connected: { state: true, type: Boolean },
    _lastFrame: { state: true },
    /// Toolbar state. Live max history depth in frames (acts as a
    /// time-zoom — smaller depth = denser per-column → finer time
    /// resolution at the cost of total span).
    _historyDepth: { state: true, type: Number },
    /// When true, the analyser stays subscribed but new frames are
    /// dropped, freezing the current waterfall so the user can pin a
    /// transient or screenshot it.
    _frozen: { state: true, type: Boolean },
    /// Latest known transport position in samples (for the absolute
    /// timestamp displayed at the `now` edge of the time ruler).
    _sessionPosSamples: { state: true, type: Number },
    /// Session sample-rate (Hz) so we can convert position → seconds.
    _sessionSampleRate: { state: true, type: Number },
  };

  static styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
      background: var(--color-surface-elevated, #15151b);
      color: var(--color-text, #e2e2e8);
      font-family: var(--font-sans, system-ui);
    }
    .root {
      width: 100%; height: 100%;
      display: flex; flex-direction: column;
      box-sizing: border-box;
    }
    .header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 4px 8px;
      font-size: 10px;
      color: var(--color-text-muted, #a1a1aa);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      border-bottom: 1px solid var(--color-border, #2e2e36);
    }
    .header .status.live::before {
      content: "";
      display: inline-block;
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--color-accent, #7c5cff);
      margin-right: 6px;
      vertical-align: middle;
      animation: pulse 1.4s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.45; }
      50%      { opacity: 1.0; }
    }
    canvas {
      display: block;
      width: 100%;
      flex: 1 1 auto;
      min-height: 0;
    }
    canvas.bars {
      flex: 0 0 38%;
    }
    canvas.waterfall {
      flex: 1 1 auto;
    }
    /* Time-axis ruler sits under the waterfall: a thin band with
       "−Ns / now" labels so agents (and humans) can correlate a
       column in the waterfall to wall-clock seconds-from-now. */
    canvas.time-ruler {
      flex: 0 0 22px;
      width: 100%;
      background: var(--color-surface, #0e0e12);
      border-top: 1px solid var(--color-border, #2e2e36);
    }
    /* Toolbar: FFT size selector + history-depth (zoom) selector +
       freeze button. Stays compact so it doesn't eat the analyser's
       visual real estate. */
    .toolbar {
      flex: 0 0 auto;
      display: flex; align-items: center; gap: 8px;
      padding: 4px 8px;
      font-size: 10px;
      color: var(--color-text-muted, #a1a1aa);
      border-bottom: 1px solid var(--color-border, #2e2e36);
      background: var(--color-surface, #0e0e12);
    }
    .toolbar label { display: inline-flex; align-items: center; gap: 4px; }
    .toolbar select {
      background: var(--color-surface-elevated, #18181d);
      color: var(--color-text, #e2e2e8);
      border: 1px solid var(--color-border, #2e2e36);
      border-radius: var(--radius-sm, 4px);
      padding: 1px 4px;
      font: inherit;
      font-size: 10px;
    }
    .toolbar .spacer { flex: 1; }
    .toolbar button {
      background: transparent;
      color: var(--color-text-muted, #a1a1aa);
      border: 1px solid var(--color-border, #2e2e36);
      border-radius: var(--radius-sm, 4px);
      padding: 1px 6px;
      font: inherit;
      font-size: 10px;
      cursor: pointer;
    }
    .toolbar button:hover { color: var(--color-text, #e2e2e8); }
    .toolbar button.active {
      background: color-mix(in oklab, var(--color-accent, #7c5cff) 30%, transparent);
      color: var(--color-text, #e2e2e8);
      border-color: color-mix(in oklab, var(--color-accent, #7c5cff) 50%, var(--color-border));
    }
    .empty {
      flex: 1 1 auto;
      display: flex; align-items: center; justify-content: center;
      color: var(--color-text-muted, #a1a1aa);
      font-size: 11px;
    }
  `;

  constructor() {
    super();
    this.target = null;
    this.channel = 0;
    this.fftSize = DEFAULT_FFT_SIZE;
    this.label = "";
    this._connected = false;
    this._lastFrame = null;
    this._history = [];
    this._waterfallDirty = true;
    this._barsCanvas = null;
    this._waterfallCanvas = null;
    this._timeRulerCanvas = null;
    this._onEnvelope = this._onEnvelope.bind(this);
    this._onResize = this._onResize.bind(this);
    this._onTransportChange = this._onTransportChange.bind(this);
    // Wall-clock interval between successive frames, smoothed by EMA so
    // a single jittery frame doesn't rescale the whole time ruler.
    // Initial guess: 20 ms (≈50 Hz analyser frame rate). Replaced once
    // we see at least two frames; clamped + reset on long gaps so the
    // ruler doesn't blow up when transport stops/starts.
    this._frameDtMs = 20;
    this._lastFrameAt = 0;
    // Whether the analyser is currently subscribed to the backend.
    // Gated on transport.playing so the waterfall doesn't keep
    // scrolling through silence frames after the user hits stop.
    this._subscribed = false;
    this._playing = false;
    // Toolbar defaults.
    this._historyDepth = HISTORY_FRAMES_MAX; // 256
    this._frozen = false;
    this._sessionPosSamples = 0;
    this._sessionSampleRate = 48000;
    // requestAnimationFrame coalescing: WS frames arrive at ~50 Hz
    // but the user's display is ~60 Hz and the waterfall repaint is
    // the heaviest thing this widget does. Flag the canvases dirty
    // when frames land, paint once per rAF. Without this the CPU
    // would spike on the JS thread doing ~700×256 pixel writes plus
    // ~1000 `putImageData` calls every 20 ms.
    this._rafHandle = 0;
    this._dirtyBars = false;
    this._dirtyWaterfall = false;
    this._dirtyTimeRuler = false;
    this._rafTick = this._rafTick.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    const ws = window.__foyer?.ws;
    if (ws?.addEventListener) {
      ws.addEventListener("envelope", this._onEnvelope);
    }
    window.addEventListener("resize", this._onResize);
    // Watch transport.playing so we can pause the subscription when
    // the user hits stop. Without this gate the server-side FFT
    // pipeline keeps tapping the egress, emits silence frames, and
    // the waterfall keeps "scrolling" through nothing — plus the
    // time-ruler labels wander because the inter-frame interval
    // goes irregular at the start/stop boundaries.
    this._readPlayingFromStore();
    const store = window.__foyer?.store;
    store?.addEventListener?.("change", this._onTransportChange);
    store?.addEventListener?.("control", this._onTransportChange);
    if (this._playing) this._subscribe();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    const ws = window.__foyer?.ws;
    if (ws?.removeEventListener) {
      ws.removeEventListener("envelope", this._onEnvelope);
    }
    window.removeEventListener("resize", this._onResize);
    const store = window.__foyer?.store;
    store?.removeEventListener?.("change", this._onTransportChange);
    store?.removeEventListener?.("control", this._onTransportChange);
    if (this._rafHandle) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = 0;
    }
    this._unsubscribe();
  }

  /// Read the live transport state from the data store. Defensive:
  /// the store shape has churned a few times; we try several known
  /// locations and fall through to "not playing" if none of them
  /// look right (which keeps the analyser idle by default — a safe
  /// failure mode given the alternative is "scrolls through silence
  /// forever").
  _readPlayingFromStore() {
    const s = window.__foyer?.store?.state;
    const controls = s?.controls;
    let playing = false;
    try {
      if (controls && typeof controls.get === "function") {
        const v = controls.get("transport.playing");
        playing = v === true || v === 1 || v === "true";
      } else if (controls && typeof controls === "object") {
        const v = controls["transport.playing"];
        playing = v === true || v === 1 || v === "true";
      }
    } catch {}
    this._playing = !!playing;
  }

  /// Read the current transport position + session sample rate so we
  /// can stamp every incoming frame with absolute session time. Used
  /// by the time ruler to label the `now` edge with a real timestamp
  /// (e.g. "00:01:23.456") rather than just "−0s".
  _readTransportSnapshot() {
    const s = window.__foyer?.store?.state;
    const session = s?.session;
    const controls = s?.controls;
    let pos = 0;
    try {
      if (controls && typeof controls.get === "function") {
        const v = controls.get("transport.position");
        if (typeof v === "number") pos = v;
      } else if (controls && typeof controls === "object") {
        const v = controls["transport.position"];
        if (typeof v === "number") pos = v;
      }
    } catch {}
    if (!pos && session?.transport?.position_beats?.value != null) {
      const v = Number(session.transport.position_beats.value);
      if (Number.isFinite(v)) pos = v;
    }
    this._sessionPosSamples = pos || 0;
    const sr = Number(session?.sample_rate);
    if (Number.isFinite(sr) && sr > 0) this._sessionSampleRate = sr;
  }

  _onTransportChange() {
    const wasPlaying = this._playing;
    this._readPlayingFromStore();
    if (this._playing === wasPlaying) return;
    if (this._playing) {
      // Re-arming: reset the dt EMA so the very-long gap between
      // the previous stop and now doesn't warp the time ruler.
      this._frameDtMs = 20;
      this._lastFrameAt = 0;
      this._subscribe();
    } else {
      this._unsubscribe();
      // Keep the existing waterfall content + ruler frozen so the
      // user can still read what they just played; the next play
      // starts a fresh history segment.
    }
  }

  updated(changed) {
    super.updated?.(changed);
    if (changed.has("target")) {
      this._history = [];
      this._waterfallDirty = true;
      this._frameDtMs = 20;
      this._lastFrameAt = 0;
      this._unsubscribePrevious();
      if (this._playing) this._subscribe();
    }
    // Re-grab the canvas refs only if they've moved (the bars /
    // waterfall / time-ruler elements are stable once the template
    // mounts). Skip the redraw work on every Lit re-render — repainting
    // the same state over and over wasn't strictly wrong, but it
    // amplified any layout jitter (canvas bounding-rect rounding +
    // resize bumps) into a visible "the spectrum keeps moving even
    // when nothing is happening" effect.
    const hadCanvases = !!this._waterfallCanvas;
    this._barsCanvas = this.renderRoot.querySelector("canvas.bars");
    this._waterfallCanvas = this.renderRoot.querySelector("canvas.waterfall");
    this._timeRulerCanvas = this.renderRoot.querySelector("canvas.time-ruler");
    if (!hadCanvases || changed.has("target")) {
      this._resizeCanvases();
      this._scheduleRedraw(true, true, true);
    }
  }

  _onResize() {
    this._resizeCanvases();
    this._waterfallDirty = true;
    this._scheduleRedraw(true, true, true);
  }

  _resizeCanvases() {
    for (const c of [this._barsCanvas, this._waterfallCanvas, this._timeRulerCanvas]) {
      if (!c) continue;
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(r.width * dpr));
      const h = Math.max(1, Math.round(r.height * dpr));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
        this._waterfallDirty = true;
      }
    }
  }

  _subscribe() {
    const ws = window.__foyer?.ws;
    if (!ws || !this.target) return;
    // Skip if transport isn't running — the analyser would just paint
    // silence and the time ruler would wander on irregular dt.
    if (!this._playing) return;
    // Already subscribed to the same target? No-op.
    if (
      this._subscribed &&
      this._targetsMatch(this._lastSubscribedTarget, this.target)
    ) {
      return;
    }
    this._lastSubscribedTarget = this.target;
    this._subscribed = true;
    try {
      ws.send({
        type: "subscribe_spectrum",
        target: this.target,
        opts: { fft_size: this.fftSize || DEFAULT_FFT_SIZE },
      });
    } catch (e) {
      console.warn("[foyer-spectrum] subscribe failed", e);
      this._subscribed = false;
    }
  }

  _unsubscribe() {
    const ws = window.__foyer?.ws;
    if (!this._lastSubscribedTarget) return;
    if (ws) {
      try {
        ws.send({
          type: "unsubscribe_spectrum",
          target: this._lastSubscribedTarget,
        });
      } catch {}
    }
    this._lastSubscribedTarget = null;
    this._subscribed = false;
    this._connected = false;
  }

  _unsubscribePrevious() {
    if (this._lastSubscribedTarget) {
      const ws = window.__foyer?.ws;
      try {
        ws?.send?.({
          type: "unsubscribe_spectrum",
          target: this._lastSubscribedTarget,
        });
      } catch {}
      this._lastSubscribedTarget = null;
      this._subscribed = false;
    }
  }

  _onEnvelope(ev) {
    const body = ev?.detail?.body;
    if (!body) return;
    if (body.type === "spectrum_subscribed") {
      if (!this._targetsMatch(body.target, this.target)) return;
      this._connected = true;
      return;
    }
    if (body.type === "spectrum_unsubscribed") {
      if (!this._targetsMatch(body.target, this.target)) return;
      this._connected = false;
      return;
    }
    if (body.type !== "spectrum_frame") return;
    const frame = body.frame;
    if (!frame || !this._targetsMatch(frame.target, this.target)) return;
    // If transport has been stopped, drop late-arriving frames on the
    // floor. Server-side buffering can keep emitting for up to ~10s
    // after stop while the egress queue drains; without this gate
    // those frames would keep pushing the waterfall left and the
    // time ruler would wobble.
    if (!this._playing) return;
    // Freeze: keep the subscription alive (so `_connected` stays
    // accurate) but drop new frames. The user wants the waterfall
    // pinned so they can read a transient.
    if (this._frozen) return;
    const now = (typeof performance !== "undefined" && performance.now)
      ? performance.now() : Date.now();
    frame._arrivedAt = now;
    // Snapshot the session position + sample rate at frame arrival so
    // the time ruler can label the `now` edge with absolute seconds —
    // agents (and humans) can correlate a column in the waterfall to
    // a specific bar/beat on the timeline instead of just "Ns ago".
    this._readTransportSnapshot();
    frame._sessionPosSamples = this._sessionPosSamples;
    frame._sessionSampleRate = this._sessionSampleRate;
    if (this._lastFrameAt) {
      const dtRaw = now - this._lastFrameAt;
      // Long-gap reset: anything > 500ms means we either resumed from
      // a stop, recovered from a reconnect, or the egress drained
      // weirdly. Throw out the existing dt EMA, start a fresh
      // history segment so the ruler doesn't pretend the new content
      // is contiguous with the old.
      if (dtRaw > 500) {
        this._frameDtMs = 20;
        this._history = [];
      } else {
        // Clamp to a sane range before EMA so a single jittery
        // 200ms frame can't peg the ruler to that scale.
        const dt = Math.max(1, Math.min(200, dtRaw));
        this._frameDtMs = this._frameDtMs * 0.85 + dt * 0.15;
      }
    }
    this._lastFrameAt = now;
    this._lastFrame = frame;
    this._history.push(frame);
    // Honor the user-selected zoom depth. Drop the oldest frames over
    // the cap; smaller depth = denser per-column on the canvas → finer
    // time resolution at the cost of total visible span.
    const cap = Math.max(8, Math.min(HISTORY_FRAMES_MAX, this._historyDepth || HISTORY_FRAMES_MAX));
    while (this._history.length > cap) {
      this._history.shift();
    }
    this._waterfallDirty = true;
    this._scheduleRedraw(true, true, true);
  }

  /// Mark canvases dirty and request an animation-frame coalesced
  /// repaint. WS frames arrive at ~50 Hz while the display is 60 Hz;
  /// without coalescing the heavy waterfall repaint runs more often
  /// than the screen even updates, which was the CPU spike during
  /// playback.
  _scheduleRedraw(bars, waterfall, ruler) {
    if (bars) this._dirtyBars = true;
    if (waterfall) this._dirtyWaterfall = true;
    if (ruler) this._dirtyTimeRuler = true;
    if (this._rafHandle) return;
    this._rafHandle = requestAnimationFrame(this._rafTick);
  }

  _rafTick() {
    this._rafHandle = 0;
    const wantBars = this._dirtyBars;
    const wantWaterfall = this._dirtyWaterfall;
    const wantRuler = this._dirtyTimeRuler;
    this._dirtyBars = this._dirtyWaterfall = this._dirtyTimeRuler = false;
    if (wantBars) this._redrawBars();
    if (wantWaterfall) this._redrawWaterfall();
    if (wantRuler) this._redrawTimeRuler();
  }

  _targetsMatch(a, b) {
    if (!a || !b) return false;
    if (a.kind !== b.kind) return false;
    if (a.kind === "track") return a.id === b.id;
    return true;
  }

  _channelMagnitudes(frame) {
    if (!frame || !Array.isArray(frame.channels) || frame.channels.length === 0) {
      return null;
    }
    if (this.channel == null) {
      // Overlay: average across channels for the bar plot, keep
      // channel-0 for the waterfall (waterfall already conveys
      // intensity well enough without channel splitting).
      const n = frame.bins;
      const out = new Float32Array(n);
      for (const ch of frame.channels) {
        for (let i = 0; i < n; i++) out[i] += ch.magnitudes_db[i] || frame.min_db;
      }
      const k = 1 / frame.channels.length;
      for (let i = 0; i < n; i++) out[i] *= k;
      return out;
    }
    const ch = frame.channels.find((c) => c.channel === this.channel)
      || frame.channels[0];
    return Float32Array.from(ch.magnitudes_db);
  }

  _redrawBars() {
    const canvas = this._barsCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const frame = this._lastFrame;
    const mags = this._channelMagnitudes(frame);
    if (!frame || !mags) {
      ctx.fillStyle = "rgba(140,140,160,0.45)";
      ctx.font = `${Math.round(11 * (window.devicePixelRatio || 1))}px var(--font-sans, system-ui)`;
      ctx.textAlign = "center";
      ctx.fillText("waiting for spectrum…", W / 2, H / 2);
      return;
    }
    const bins = frame.bins;
    const minDb = frame.min_db;
    // dB→0..1 mapping. 0 dBFS at top, min_db at bottom.
    const scale = (db) => Math.max(0, Math.min(1, (db - minDb) / (0 - minDb)));
    // Bar gradient: cool floor → warm peak.
    const grad = ctx.createLinearGradient(0, H, 0, 0);
    grad.addColorStop(0.0, "#312e81");
    grad.addColorStop(0.5, "#7c5cff");
    grad.addColorStop(0.85, "#ec4899");
    grad.addColorStop(1.0, "#fde047");
    ctx.fillStyle = grad;
    const barW = W / bins;
    for (let i = 0; i < bins; i++) {
      const v = scale(mags[i]);
      const bh = v * H;
      ctx.fillRect(i * barW, H - bh, Math.max(1, barW - 1), bh);
    }
    // Faint frequency grid: 1 kHz, 10 kHz markers at the right edge.
    const nyquist = (frame.sample_rate || 48000) / 2;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    for (const hz of [1000, 5000, 10000, 20000]) {
      if (hz >= nyquist) continue;
      const x = Math.round((hz / nyquist) * W) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
  }

  _redrawWaterfall() {
    // Stretched-history render. The previous design scrolled the
    // waterfall left by exactly one pixel per arriving frame; on a
    // freshly-mounted tile or a wide canvas, the left half stayed
    // black until ~10 s of frames had accumulated, which read as a
    // bug ("waterfall only renders on part of the screen").
    //
    // New behavior: paint the entire history STRETCHED to fill the
    // canvas. Each frame's column width = max(1, W / history.length).
    // Newest frame lands flush against the right edge; older frames
    // shift left as new ones arrive. Repaints on every frame — cheap
    // at our 256-frame max history.
    if (!this._waterfallCanvas) return;
    const ctx = this._waterfallCanvas.getContext("2d");
    if (!ctx) return;
    const W = this._waterfallCanvas.width;
    const H = this._waterfallCanvas.height;
    ctx.clearRect(0, 0, W, H);
    this._waterfallDirty = false;
    if (this._history.length === 0) return;
    const n = this._history.length;
    // Fractional column width — we round when emitting so each frame
    // gets at least one column, but the total adds up to ~W.
    const colW = W / n;
    // Build a SINGLE full-canvas ImageData and write packed RGBA
    // 32-bit values directly into its Uint32Array view. Single
    // `putImageData(img, 0, 0)` at the end replaces what used to be
    // ~1000 per-frame `putImageData` calls (one per stamped column),
    // and the packed writes are roughly 4× faster than the per-byte
    // Uint8 stores the old loop did. Net effect: ~5–10× faster
    // waterfall paint, which was the CPU hog during live playback.
    const img = ctx.createImageData(W, H);
    const buf32 = new Uint32Array(img.data.buffer);
    // Pre-compute y → log-mapped bin fraction once. With fft_size
    // 2048 the inner loop ran ~700×256 = 180k times every frame
    // recomputing the same `Math.pow(yFrac, 2.2)`; lifting the
    // mapping out cuts the inner work to a single multiply + index.
    const yBinFrac = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      const yFrac = 1 - y / Math.max(1, H - 1);
      yBinFrac[y] = Math.pow(yFrac, 2.2);
    }
    // Pre-compute per-column color ramp (one Uint32 per row) so the
    // inner double-loop just copies pixels.
    const colColors = new Uint32Array(H);
    for (let f = 0; f < n; f++) {
      const frame = this._history[f];
      const mags = this._channelMagnitudes(frame);
      if (!mags) continue;
      const bins = frame.bins;
      const minDb = frame.min_db;
      const xStart = Math.round(f * colW);
      const xEnd = Math.round((f + 1) * colW);
      const w = Math.max(1, xEnd - xStart);
      const invSpan = 1 / (0 - minDb); // (0 - minDb) > 0 always
      for (let y = 0; y < H; y++) {
        const idx = Math.min(bins - 1, Math.max(0, (yBinFrac[y] * (bins - 1)) | 0));
        const db = mags[idx];
        const t = db <= minDb ? 0 : db >= 0 ? 1 : (db - minDb) * invSpan;
        const [r, g, b] = magmaColor(t);
        // Pack little-endian: ABGR in memory == 0xFFBBGGRR.
        colColors[y] = (0xff << 24) | (b << 16) | (g << 8) | r;
      }
      for (let dx = 0; dx < w; dx++) {
        const x = xStart + dx;
        if (x < 0 || x >= W) continue;
        let row = x;
        for (let y = 0; y < H; y++) {
          buf32[row] = colColors[y];
          row += W;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    // Frequency labels on the right edge (overlaid on the waterfall).
    // Three log-scale markers: 100 Hz / 1 kHz / 10 kHz. Drawn AFTER
    // the heatmap so they stay legible against any column color.
    const last = this._history[this._history.length - 1];
    const nyquist = (last?.sample_rate || 48000) / 2;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.font = `${Math.round(10 * dpr)}px var(--font-mono, monospace)`;
    ctx.fillStyle = "rgba(255,255,255,0.78)";
    ctx.strokeStyle = "rgba(0,0,0,0.65)";
    ctx.lineWidth = Math.round(3 * dpr);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const hz of [100, 1000, 10000]) {
      if (hz >= nyquist) continue;
      const binFrac = hz / nyquist;
      // Inverse of the log-y mapping in the heatmap loop:
      //   binFrac = (1 - y/(H-1))^2.2  →  y = (H-1) * (1 - binFrac^(1/2.2))
      const yFrac = Math.pow(binFrac, 1 / 2.2);
      const y = Math.round((1 - yFrac) * (H - 1));
      const label = hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
      const x = W - Math.round(6 * dpr);
      ctx.strokeText(label, x, y);
      ctx.fillText(label, x, y);
    }
    ctx.restore();
  }

  /// Paint the bottom time-axis ruler. Labels are "−Ns" offsets from
  /// the newest frame, plus "now" flush against the right edge. The
  /// total span is `history.length * frame_dt_ms` — when only a few
  /// frames have arrived the ruler honestly shows a short window
  /// rather than pretending the canvas spans 10 s.
  _redrawTimeRuler() {
    if (!this._timeRulerCanvas) return;
    const ctx = this._timeRulerCanvas.getContext("2d");
    if (!ctx) return;
    const W = this._timeRulerCanvas.width;
    const H = this._timeRulerCanvas.height;
    ctx.clearRect(0, 0, W, H);
    const dpr = window.devicePixelRatio || 1;
    const n = this._history.length;
    const dtMs = Math.max(1, this._frameDtMs);
    const spanMs = Math.max(100, n * dtMs);
    // Pick a tick interval. Aim for ~6 ticks across the visible span.
    const candidates = [100, 250, 500, 1000, 2000, 5000, 10000, 30000];
    let tickMs = candidates[0];
    for (const c of candidates) {
      if (spanMs / c <= 8) { tickMs = c; break; }
      tickMs = c;
    }
    ctx.save();
    ctx.font = `${Math.round(9 * dpr)}px var(--font-mono, monospace)`;
    ctx.fillStyle = "rgba(225,225,235,0.78)";
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    ctx.textBaseline = "middle";
    // Draw "now" label flush right. If the newest history frame
    // carries a session-time stamp (from `_readTransportSnapshot`),
    // append an absolute timestamp in parens so the user can map this
    // column of the waterfall back to the session timeline (e.g.
    // "now 01:23.456"). Without the stamp (transport not reporting
    // position, headless mode, etc.) fall back to just "now".
    ctx.textAlign = "right";
    const last = this._history[this._history.length - 1];
    let nowLabel = "now";
    if (last && Number.isFinite(last._sessionPosSamples) && Number.isFinite(last._sessionSampleRate) && last._sessionSampleRate > 0) {
      nowLabel = `now ${_formatSessionTime(last._sessionPosSamples / last._sessionSampleRate)}`;
    }
    ctx.fillText(nowLabel, W - Math.round(4 * dpr), H / 2);
    // Draw left-going tick labels. Labels show BOTH the relative
    // offset (consistent UX, easy to read at a glance) AND, when we
    // have a session stamp, the corresponding absolute session time
    // — agents can quote the absolute timestamp to the user.
    ctx.textAlign = "center";
    const sr = last && Number.isFinite(last._sessionSampleRate) ? last._sessionSampleRate : 0;
    const nowSec = last && Number.isFinite(last._sessionPosSamples) && sr > 0
      ? last._sessionPosSamples / sr
      : null;
    for (let t = tickMs; t < spanMs; t += tickMs) {
      const x = Math.round(W * (1 - t / spanMs));
      if (x < Math.round(20 * dpr)) break; // avoid overlapping the left edge
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, Math.round(3 * dpr));
      ctx.stroke();
      const rel = t >= 1000 ? `−${(t / 1000).toFixed(t % 1000 === 0 ? 0 : 1)}s` : `−${t}ms`;
      // Append absolute timestamp on the larger tick marks (≥1s) so
      // the ruler stays readable but agents still have a quoteable
      // session-time at sane intervals.
      let label = rel;
      if (nowSec != null && t >= 1000) {
        const absSec = Math.max(0, nowSec - t / 1000);
        label = `${rel} (${_formatSessionTime(absSec)})`;
      }
      ctx.fillText(label, x, H / 2);
    }
    ctx.restore();
  }

  render() {
    const label = this.label
      || (this.target ? this._slug(this.target) : "spectrum");
    return html`
      <div class="root">
        <div class="header">
          <span>${label}</span>
          <span class=${`status ${this._connected ? "live" : ""}`}>
            ${this._connected ? "live" : "idle"}
          </span>
        </div>
        <div class="toolbar">
          <label title="FFT window size. Larger = finer frequency resolution, coarser time.">
            FFT
            <select
              .value=${String(this.fftSize || DEFAULT_FFT_SIZE)}
              @change=${(ev) => this._onFftSizeChange(Number(ev.currentTarget.value))}
            >
              ${FFT_SIZE_OPTIONS.map((n) => html`
                <option value=${String(n)} ?selected=${n === this.fftSize}>${n}</option>
              `)}
            </select>
          </label>
          <label title="Visible history depth (zoom). Smaller = denser per column → finer time detail.">
            Zoom
            <select
              .value=${String(this._historyDepth)}
              @change=${(ev) => this._onDepthChange(Number(ev.currentTarget.value))}
            >
              ${HISTORY_DEPTH_OPTIONS.map((n) => html`
                <option value=${String(n)} ?selected=${n === this._historyDepth}>
                  ${n} frames
                </option>
              `)}
            </select>
          </label>
          <span class="spacer"></span>
          <button
            class=${this._frozen ? "active" : ""}
            title=${this._frozen ? "Resume — drop new frames into the waterfall" : "Freeze the waterfall to pin a transient"}
            @click=${() => this._toggleFreeze()}
          >
            ${this._frozen ? "▶ Resume" : "⏸ Freeze"}
          </button>
        </div>
        <canvas class="bars" data-foyer-spectrum-bars></canvas>
        <canvas class="waterfall" data-foyer-spectrum-waterfall></canvas>
        <canvas class="time-ruler" data-foyer-spectrum-timeruler></canvas>
      </div>
    `;
  }

  _onFftSizeChange(n) {
    if (!Number.isFinite(n) || n < 256 || n > 16384) return;
    if (n === this.fftSize) return;
    this.fftSize = n;
    // Re-subscribe so the backend honours the new size. History
    // captured at the old size has a different bin count and would
    // render with a different log-y mapping, so we wipe it.
    this._history = [];
    this._waterfallDirty = true;
    this._unsubscribePrevious();
    if (this._playing) this._subscribe();
  }

  _onDepthChange(n) {
    if (!Number.isFinite(n) || n < 8) return;
    this._historyDepth = Math.min(HISTORY_FRAMES_MAX, Math.max(8, n));
    // Trim immediately so the new zoom takes effect without waiting
    // for the next incoming frame.
    while (this._history.length > this._historyDepth) {
      this._history.shift();
    }
    this._waterfallDirty = true;
    this._scheduleRedraw(false, true, true);
  }

  _toggleFreeze() {
    this._frozen = !this._frozen;
    // No subscribe/unsubscribe — keep the live connection so the user
    // can un-freeze without a fresh ramp-up time. `_onEnvelope` drops
    // frames while `_frozen` is true.
  }

  _slug(target) {
    if (!target) return "spectrum";
    if (target.kind === "master") return "master";
    if (target.kind === "monitor") return "monitor";
    if (target.kind === "track") return `track ${target.id || ""}`;
    return target.kind || "spectrum";
  }
}

/// Format a session-time in seconds as "MM:SS.mmm" (or "HH:MM:SS.mmm"
/// past an hour). Used by the time ruler to label absolute timeline
/// positions next to the relative "−Ns" ticks. Negative inputs are
/// clamped at 0 (the timeline can't run backwards).
function _formatSessionTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const ms = Math.round((total % 1) * 1000);
  const whole = Math.floor(total);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);
  const pad3 = (n) => (n < 10 ? `00${n}` : n < 100 ? `0${n}` : `${n}`);
  return h > 0
    ? `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad3(ms)}`
    : `${pad2(m)}:${pad2(s)}.${pad3(ms)}`;
}

/// Magma-ish 256-color ramp. Returns [r,g,b] for t in 0..1.
function magmaColor(t) {
  // Cheap analytic approximation of the matplotlib magma cmap.
  // Source: https://www.shadertoy.com/view/WlfXRN — fitted polynomials.
  const x = Math.max(0, Math.min(1, t));
  const c0 = [-0.002136, -0.000749, -0.005386];
  const c1 = [0.2516, 0.6775, 2.494];
  const c2 = [8.353, -3.577, 0.3293];
  const c3 = [-27.66, 14.26, -13.64];
  const c4 = [52.17, -27.94, 12.94];
  const c5 = [-50.76, 29.04, 4.236];
  const c6 = [18.65, -11.49, -5.601];
  const r = c0[0] + x * (c1[0] + x * (c2[0] + x * (c3[0] + x * (c4[0] + x * (c5[0] + x * c6[0])))));
  const g = c0[1] + x * (c1[1] + x * (c2[1] + x * (c3[1] + x * (c4[1] + x * (c5[1] + x * c6[1])))));
  const b = c0[2] + x * (c1[2] + x * (c2[2] + x * (c3[2] + x * (c4[2] + x * (c5[2] + x * c6[2])))));
  return [
    Math.max(0, Math.min(255, Math.round(r * 255))),
    Math.max(0, Math.min(255, Math.round(g * 255))),
    Math.max(0, Math.min(255, Math.round(b * 255))),
  ];
}

if (!customElements.get("foyer-spectrum")) {
  customElements.define("foyer-spectrum", FoyerSpectrum);
}
