// Render / mixdown dialog.
//
// User flow:
//   1. Session menu → Render Audio… → this modal opens.
//   2. Backend's advertised RenderCapabilities (on session snapshot)
//      drive the format / bit-depth / sample-rate pickers — anything
//      the backend can't produce is hidden, not greyed out.
//   3. User picks options and clicks Render.
//   4. We mint a uuid handle and send `Command::RenderSession`.
//   5. Backend streams `Event::RenderProgress` (% over time) and
//      lands on `Event::RenderComplete { outputs }` or
//      `Event::RenderError { message }`.
//   6. On complete we trigger a browser download from the file path
//      via the session-export endpoint shape (`/sessions/file?path=…`),
//      with a fallback that decodes the inline base64 bytes when
//      the backend chose to ship them inline.
//
// The modal stays open through the render so a user can cancel or
// kick off another render once the first finishes; closing the modal
// mid-render does NOT cancel — that would race against the backend
// writing the file and is the wrong UX for an export operation. We
// just disconnect from the event stream and let the render finish in
// the background.

import { LitElement, html, svg, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { toast } from "foyer-ui-core/widgets/toast.js";

const BIT_DEPTH_LABELS = {
  int16: "16-bit PCM",
  int24: "24-bit PCM",
  int32: "32-bit PCM",
  float32: "32-bit float",
};

function randomHandle() {
  // Browser uuid; the server treats this as opaque — no need for
  // crypto-strength entropy.
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `render-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function formatTime(samples, sampleRate) {
  if (!sampleRate || sampleRate <= 0) return "0:00";
  const totalSec = Math.max(0, samples / sampleRate);
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  const sStr = s < 10 ? `0${s.toFixed(2)}` : s.toFixed(2);
  return `${m}:${sStr}`;
}

function parseTime(str, sampleRate) {
  // Accept "mm:ss[.frac]" or plain seconds. Returns samples, or NaN.
  if (!sampleRate || !str) return NaN;
  const t = String(str).trim();
  if (!t) return NaN;
  const m = t.match(/^(\d+):([0-9.]+)$/);
  let seconds;
  if (m) {
    seconds = Number(m[1]) * 60 + Number(m[2]);
  } else {
    seconds = Number(t);
  }
  if (!Number.isFinite(seconds) || seconds < 0) return NaN;
  return Math.round(seconds * sampleRate);
}

/** Compute session length in samples from the store's region cache.
 *  Falls back to a 60-second sentinel when no regions are loaded yet
 *  (the modal sends a `list_regions` request on open so this
 *  resolves on the next tick for sessions with content). */
function sessionLengthSamples(store) {
  const sr = Number(store?.state?.session?.sample_rate || 48000);
  const minLen = sr * 60;
  let max = 0;
  const cache = store?.state?.regionsByTrack;
  if (cache && typeof cache.values === "function") {
    for (const list of cache.values()) {
      for (const r of list || []) {
        const end = Number(r.start_samples || 0) + Number(r.length_samples || 0);
        if (end > max) max = end;
      }
    }
  }
  return max > 0 ? max : minLen;
}

export class RenderModal extends LitElement {
  static properties = {
    _caps:        { state: true, type: Object },
    _formatId:    { state: true, type: String },
    _bitDepth:    { state: true, type: String },
    _sampleRate:  { state: true, type: Number },
    _quality:     { state: true, type: Number },
    _rangeMode:   { state: true, type: String },     // "session" | "range" | "loop"
    _rangeStart:  { state: true, type: Number },     // samples
    _rangeEnd:    { state: true, type: Number },     // samples
    _sessionLen:  { state: true, type: Number },     // cached session length in samples
    _state:       { state: true, type: String },     // idle | running | done | error
    _progress:    { state: true, type: Number },
    _result:      { state: true, type: Object },     // RenderOutput
    _error:       { state: true, type: String },
    _handle:      { state: true, type: String },
  };

  static styles = css`
    :host {
      position: fixed; inset: 0; z-index: 5400;
      display: flex; align-items: center; justify-content: center;
      pointer-events: auto;
      font-family: var(--font-sans); color: var(--color-text);
    }
    .scrim {
      position: absolute; inset: 0;
      background: rgba(0,0,0,0.55);
      backdrop-filter: blur(3px);
    }
    .modal {
      position: relative;
      width: min(560px, 92vw);
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg, 10px);
      box-shadow: var(--shadow-panel);
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    header {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface);
    }
    header h1 { font-size: 14px; font-weight: 600; margin: 0; flex: 1; }
    header button.close {
      background: transparent; border: 0; cursor: pointer;
      color: var(--color-text-muted);
      padding: 4px; border-radius: var(--radius-sm, 4px);
      display: flex; align-items: center;
    }
    header button.close:hover { background: var(--color-surface-hover); color: var(--color-text); }
    .body {
      padding: 16px 18px;
      display: flex; flex-direction: column; gap: 14px;
      font-size: 13px;
    }
    .field {
      display: flex; flex-direction: column; gap: 4px;
    }
    .field label {
      font-size: 11px;
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .field select, .field input[type="range"], .field input[type="text"] {
      width: 100%;
      font: inherit;
      padding: 6px 8px;
      border-radius: var(--radius-sm, 6px);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      color: var(--color-text);
    }
    .field select:focus, .field input[type="text"]:focus {
      outline: 1px solid var(--color-accent);
    }
    .field-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .seg {
      display: inline-flex;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm, 6px);
      overflow: hidden;
      background: var(--color-surface);
    }
    .seg button {
      flex: 1;
      padding: 6px 10px;
      font: inherit; font-size: 12px;
      border: 0; background: transparent; color: var(--color-text);
      cursor: pointer;
    }
    .seg button.on {
      background: var(--color-accent);
      color: #fff;
    }
    .range-strip {
      position: relative;
      width: 100%;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm, 6px);
      cursor: pointer;
      user-select: none;
      touch-action: none;
      overflow: hidden;
    }
    .range-strip svg {
      display: block;
      width: 100%;
    }
    .range-strip[data-disabled="1"] {
      opacity: 0.5;
      pointer-events: none;
    }
    .range-strip svg .ruler-tick {
      stroke: color-mix(in oklab, var(--color-border) 60%, transparent);
      stroke-width: 0.5;
    }
    .range-strip svg .ruler-text {
      fill: var(--color-text-muted);
      font-family: var(--font-mono, ui-monospace);
      font-size: 8px;
    }
    .range-strip svg .region-audio {
      fill: color-mix(in oklab, var(--color-accent) 55%, transparent);
    }
    .range-strip svg .region-midi {
      fill: color-mix(in oklab, var(--color-accent-2, var(--color-accent)) 55%, transparent);
    }
    .range-strip svg .region-sequencer {
      fill: color-mix(in oklab, var(--color-accent-2, var(--color-accent)) 65%, transparent);
    }
    .range-strip svg .region-master {
      fill: color-mix(in oklab, var(--color-text) 30%, transparent);
    }
    .range-strip svg .selection-fill {
      fill: color-mix(in oklab, var(--color-accent) 25%, transparent);
    }
    .range-strip svg .selection-edge {
      stroke: var(--color-accent);
      stroke-width: 1;
    }
    .range-strip svg .selection-handle {
      fill: var(--color-accent);
      cursor: ew-resize;
    }
    .range-times {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 8px;
      align-items: end;
    }
    .range-times .field input {
      font-variant-numeric: tabular-nums;
    }
    .range-times .duration {
      font-size: 11px;
      color: var(--color-text-muted);
      text-align: right;
      padding-bottom: 8px;
    }
    .progress {
      width: 100%; height: 8px;
      background: var(--color-surface);
      border-radius: 99px;
      overflow: hidden;
      border: 1px solid var(--color-border);
    }
    .progress > div {
      height: 100%;
      background: linear-gradient(90deg, var(--color-accent), var(--color-accent-2, var(--color-accent)));
      transition: width 120ms ease-out;
    }
    .status {
      font-size: 12px;
      color: var(--color-text-muted);
    }
    .status.err { color: var(--color-danger, #d44); }
    footer {
      display: flex; justify-content: flex-end; gap: 8px;
      padding: 10px 14px;
      border-top: 1px solid var(--color-border);
      background: var(--color-surface);
    }
    button.primary, button.secondary {
      font: inherit; font-size: 13px;
      padding: 7px 14px;
      border-radius: var(--radius-sm, 6px);
      cursor: pointer;
      border: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
      color: var(--color-text);
    }
    button.primary {
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2, var(--color-accent)));
      color: #fff;
      border-color: transparent;
      font-weight: 600;
    }
    button.primary[disabled], button.secondary[disabled] {
      opacity: 0.5; cursor: not-allowed;
    }
    .result-card {
      padding: 10px 12px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm, 6px);
      background: var(--color-surface);
      display: flex; align-items: center; gap: 10px;
    }
    .result-card .meta {
      flex: 1; display: flex; flex-direction: column; gap: 2px;
      font-size: 12px;
    }
    .result-card .name { font-weight: 600; }
    .result-card .sub  { color: var(--color-text-muted); font-size: 11px; }
    audio { width: 100%; }
  `;

  constructor() {
    super();
    this._caps = null;
    this._formatId = "";
    this._bitDepth = "";
    this._sampleRate = 0;
    // Default lossy quality near max — most users picking Ogg/MP3
    // through this dialog want "good enough for sharing", not
    // "smallest file". 9/10 is transparent for both Vorbis and MP3
    // on typical music material.
    this._quality = 9;
    this._rangeMode = "session";
    this._rangeStart = 0;
    this._rangeEnd = 0;
    this._sessionLen = 0;
    this._state = "idle";
    this._progress = 0;
    this._result = null;
    this._error = "";
    this._handle = "";
    this._onEnvelope = this._onEnvelope.bind(this);
    this._onChange = () => {
      this._refreshCaps();
      this._refreshSessionLen();
    };
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.ws?.addEventListener("envelope", this._onEnvelope);
    window.__foyer?.store?.addEventListener("change", this._onChange);
    this._refreshCaps();
    this._refreshSessionLen();
    // Ask the backend for every track's regions so `sessionLengthSamples`
    // has data even when the timeline view has never mounted in this
    // session. The handler in the store will populate
    // `regionsByTrack`, which we observe through the `change` listener
    // above. Idempotent — sending duplicate `list_regions` is cheap.
    const ws = window.__foyer?.ws;
    const tracks = window.__foyer?.store?.state?.session?.tracks || [];
    if (ws && tracks.length) {
      for (const t of tracks) {
        if (t?.id) ws.send({ type: "list_regions", track_id: t.id });
      }
    }
  }
  disconnectedCallback() {
    window.__foyer?.ws?.removeEventListener("envelope", this._onEnvelope);
    window.__foyer?.store?.removeEventListener("change", this._onChange);
    super.disconnectedCallback();
  }

  _refreshCaps() {
    const caps = window.__foyer?.store?.state?.session?.render || null;
    if (!caps) {
      this._caps = null;
      return;
    }
    this._caps = caps;
    // Seed defaults from the backend's advertised set on the first
    // arrival; once the user has picked something, leave their choice
    // alone even if the snapshot re-emits.
    if (!this._formatId && caps.formats?.length) {
      this._formatId = caps.formats[0].id;
    }
    if (!this._bitDepth && caps.bit_depths?.length) {
      // Prefer 24-bit when offered — that's the common "release master"
      // default everyone in the Foyer user base will reach for first.
      this._bitDepth = caps.bit_depths.includes("int24") ? "int24" : caps.bit_depths[0];
    }
    if (!this._sampleRate) {
      // Default to the session rate — that's what the user is working at
      // and matches the engine's internal mix bus, so we ship that unless
      // they explicitly pick a different rate.
      const sessionSr = Number(window.__foyer?.store?.state?.session?.sample_rate || 0);
      if (sessionSr > 0) {
        this._sampleRate = sessionSr;
      } else if (caps.sample_rates?.length) {
        this._sampleRate = caps.sample_rates[0];
      }
    }
  }

  _refreshSessionLen() {
    const store = window.__foyer?.store;
    const len = sessionLengthSamples(store);
    if (len === this._sessionLen) return;
    this._sessionLen = len;
    // First time we learn the session length, snap the range to the
    // whole session. Subsequent updates (a new region pushes the end
    // out further) move the trailing handle if the user hadn't moved
    // it off the end yet.
    if (this._rangeEnd === 0 || this._rangeEnd === Math.min(len, this._sessionLen)) {
      this._rangeEnd = len;
    }
    if (this._rangeStart < 0 || this._rangeStart > len) this._rangeStart = 0;
    if (this._rangeEnd > len) this._rangeEnd = len;
  }

  _onEnvelope(ev) {
    const body = ev?.detail?.body;
    if (!body || !this._handle) return;
    if (body.handle !== this._handle) return;
    if (body.type === "render_started") {
      this._state = "running";
      this._progress = 0;
    } else if (body.type === "render_progress") {
      this._state = "running";
      this._progress = Number(body.percent) || 0;
    } else if (body.type === "render_complete") {
      this._state = "done";
      this._progress = 100;
      this._result = body.outputs?.[0] || null;
      if (this._result) this._triggerDownload(this._result);
    } else if (body.type === "render_error") {
      this._state = "error";
      this._error = body.message || "render failed";
    }
  }

  _triggerDownload(output) {
    if (!output) return;
    const name = (output.path?.split("/").pop()) || `render.${output.format_id || "wav"}`;
    // The UI path always asks the backend for `inline_bytes=true`
    // (see `_onRender`) so the audio rides back on the
    // `RenderComplete` envelope without a follow-up fetch. Long
    // renders (Ardour mixdowns of a full song) can be MB-scale —
    // when the Ardour shim lands we'll add a `/sessions/file`
    // endpoint and let the modal fall back to that route. For the
    // stub backend's seconds-long sweep, base64 over the WS is
    // cheap and avoids a second auth round trip.
    if (!output.bytes_b64) {
      toast("Render finished but the backend didn't return the bytes — check the exports/ folder on the server.", { tone: "warn" });
      return;
    }
    const bin = atob(output.bytes_b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(
      new Blob([arr], { type: output.mime || "application/octet-stream" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Free the blob URL once the download starts. A small delay
    // ensures the click navigation has copied the bytes into the
    // browser's download pipeline.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  _onClose = () => {
    // Closing while a render is in-flight just hides the dialog;
    // the WS layer keeps streaming progress to other clients, and
    // the file still lands on disk. Re-opening the dialog won't
    // re-attach to the in-flight handle (we don't track open handles
    // across reloads); that's a future improvement.
    this.remove();
  };

  _onRender = () => {
    if (!this._caps || !this._formatId) return;
    const ws = window.__foyer?.ws;
    if (!ws) {
      toast("Not connected — try again in a moment.", { tone: "warn" });
      return;
    }
    const handle = randomHandle();
    this._handle = handle;
    this._state = "running";
    this._progress = 0;
    this._result = null;
    this._error = "";
    const fmt = this._caps.formats.find((f) => f.id === this._formatId);
    let range;
    if (this._rangeMode === "range") {
      // Clamp / sanity-check before sending so a typo doesn't reach
      // the shim's range validator.
      const len = this._sessionLen || 0;
      let s = Math.max(0, Math.round(this._rangeStart));
      let e = Math.max(s + 1, Math.round(this._rangeEnd));
      if (len > 0) e = Math.min(e, len);
      range = { kind: "range", start_samples: s, end_samples: e };
    } else if (this._rangeMode === "loop") {
      range = { kind: "loop" };
    } else {
      range = { kind: "session" };
    }
    ws.send({
      type: "render_session",
      handle,
      opts: {
        format_id: this._formatId,
        sample_rate: this._sampleRate || null,
        bit_depth: this._bitDepth || null,
        // Stub clamps anything past stereo; trust the backend cap.
        channels: Math.min(2, this._caps.max_channels || 2),
        quality: fmt?.lossy ? this._quality : null,
        target: { kind: "master" },
        range,
        normalize_to_master: true,
        target_path: null,
        // UI download path: ask the backend to inline the encoded
        // bytes on `RenderComplete` so the modal can build a Blob
        // URL and start the browser download without a second
        // round-trip. When the Ardour shim lands and renders get
        // big enough to make WS-base64 painful, we'll flip this to
        // false and fetch via a `/sessions/file` endpoint instead.
        inline_bytes: true,
      },
    });
  };

  // ─── range strip drag ───────────────────────────────────────────
  // Two draggable handles on a horizontal track. Click anywhere on
  // the strip to start a drag (the closer handle wins). pointermove
  // updates the active handle; pointerup releases. Coordinates are
  // mapped from clientX → fraction of strip → samples.
  _onStripPointerDown = (ev) => {
    if (this._rangeMode !== "range") return;
    if (!this._sessionLen) return;
    const strip = this.renderRoot.querySelector(".range-strip");
    if (!strip) return;
    const rect = strip.getBoundingClientRect();
    const fracAt = (clientX) => (clientX - rect.left) / Math.max(1, rect.width);
    const samplesAt = (clientX) => {
      const f = Math.max(0, Math.min(1, fracAt(clientX)));
      return Math.round(f * this._sessionLen);
    };
    const startSamples = this._rangeStart;
    const endSamples   = this._rangeEnd;
    const pos = samplesAt(ev.clientX);
    // Closer handle wins. Snap clicks on empty area to the closer one.
    const handle = (Math.abs(pos - startSamples) <= Math.abs(pos - endSamples))
      ? "start" : "end";
    const move = (mv) => {
      let v = samplesAt(mv.clientX);
      if (handle === "start") {
        v = Math.max(0, Math.min(v, this._rangeEnd - 1));
        this._rangeStart = v;
      } else {
        v = Math.max(this._rangeStart + 1, Math.min(v, this._sessionLen));
        this._rangeEnd = v;
      }
    };
    move(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    ev.preventDefault();
  };

  _onTimeInput = (which, ev) => {
    const sr = Number(this._sampleRate) || Number(window.__foyer?.store?.state?.session?.sample_rate) || 48000;
    const samples = parseTime(ev.target.value, sr);
    if (!Number.isFinite(samples)) return;
    if (which === "start") {
      this._rangeStart = Math.max(0, Math.min(samples, this._rangeEnd - 1));
    } else {
      this._rangeEnd = Math.max(this._rangeStart + 1, Math.min(samples, this._sessionLen));
    }
  };

  _renderRangePicker() {
    const sr = Number(this._sampleRate) || Number(window.__foyer?.store?.state?.session?.sample_rate) || 48000;
    const len = Math.max(1, this._sessionLen);
    const startFrac = Math.max(0, Math.min(1, this._rangeStart / len));
    const endFrac   = Math.max(0, Math.min(1, this._rangeEnd / len));
    const disabled  = this._rangeMode !== "range" || !this._sessionLen;
    const isBusy    = this._state === "running";

    // Gantt rows — one per non-empty track (any track that has at
    // least one region in the store's region cache, OR the master
    // bus which we always show as a thin context row). Each region
    // is a horizontal bar positioned by its `start_samples` /
    // `length_samples` against the session length.
    const tracks = (window.__foyer?.store?.state?.session?.tracks || []).filter(Boolean);
    const regionsByTrack = window.__foyer?.store?.state?.regionsByTrack;
    const trackEntries = tracks
      .map((t) => {
        const list = regionsByTrack?.get?.(t.id) || [];
        return { track: t, regions: list };
      })
      .filter((row) => row.regions.length > 0 || row.track?.kind === "Master")
      .slice(0, 8); // cap so a 40-track session doesn't blow the modal height

    // Layout: 100px viewBox width is the natural scale; height is
    // ruler (10) + row_h * track_count (min 1). preserveAspectRatio
    // is "none" so the strip stretches to the container width.
    const rulerH = 12;
    const rowH = trackEntries.length > 0 ? Math.max(6, Math.min(14, 80 / trackEntries.length)) : 12;
    const bodyH = Math.max(rowH, rowH * trackEntries.length);
    const totalH = rulerH + bodyH;
    const VB_W = 100; // arbitrary; preserveAspectRatio=none stretches horizontally

    const xOf = (samples) => (samples / len) * VB_W;

    // Ruler ticks every nice second-step.
    const totalSec = len / sr;
    const tickStep = totalSec <= 30 ? 5 : totalSec <= 90 ? 10 : 30;
    const ticks = [];
    for (let t = 0; t <= totalSec; t += tickStep) {
      const xx = (t / totalSec) * VB_W;
      ticks.push(svg`<line class="ruler-tick" x1=${xx} y1="0" x2=${xx} y2=${rulerH}/>`);
      if (t > 0) {
        ticks.push(svg`<text class="ruler-text" x=${xx + 1} y="9">${t}s</text>`);
      }
    }

    const trackRows = trackEntries.map((row, i) => {
      const y = rulerH + i * rowH;
      const cls = row.track.kind === "Master"
        ? "region-master"
        : row.track.kind === "Midi"
          ? (row.regions.some((r) => r.kind === "sequencer") ? "region-sequencer" : "region-midi")
          : "region-audio";
      return svg`
        <g>
          ${row.regions.map((r) => {
            const x = xOf(Number(r.start_samples) || 0);
            const w = Math.max(0.3, xOf(Number(r.length_samples) || 0));
            return svg`<rect class=${cls}
                              x=${x.toFixed(3)} y=${(y + 0.5).toFixed(2)}
                              width=${w.toFixed(3)} height=${(rowH - 1).toFixed(2)}
                              rx="0.3" />`;
          })}
        </g>
      `;
    });

    // Selection overlay (drawn last so it sits on top of the gantt).
    const selLeft = (startFrac * VB_W).toFixed(3);
    const selRight = (endFrac * VB_W).toFixed(3);
    const selWidth = Math.max(0.001, (endFrac - startFrac) * VB_W).toFixed(3);
    const handleHalfW = 0.5;

    return html`
      <div class="field">
        <label>Range</label>
        <div class="seg">
          <button
            class=${this._rangeMode === "session" ? "on" : ""}
            ?disabled=${isBusy}
            @click=${() => (this._rangeMode = "session")}>Whole session</button>
          <button
            class=${this._rangeMode === "range" ? "on" : ""}
            ?disabled=${isBusy}
            @click=${() => (this._rangeMode = "range")}>Custom range</button>
          <button
            class=${this._rangeMode === "loop" ? "on" : ""}
            ?disabled=${isBusy}
            @click=${() => (this._rangeMode = "loop")}>Loop range</button>
        </div>
      </div>
      <div class="range-strip"
           data-disabled=${disabled ? "1" : "0"}
           style="height:${totalH * 2}px"
           @pointerdown=${this._onStripPointerDown}>
        <svg viewBox="0 0 ${VB_W} ${totalH}" preserveAspectRatio="none"
             style="height:100%">
          ${ticks}
          ${trackRows}
          <rect class="selection-fill"
                x=${selLeft} y="0"
                width=${selWidth} height=${totalH} />
          <line class="selection-edge"
                x1=${selLeft} y1="0" x2=${selLeft} y2=${totalH} />
          <line class="selection-edge"
                x1=${selRight} y1="0" x2=${selRight} y2=${totalH} />
          <rect class="selection-handle"
                x=${(Number(selLeft) - handleHalfW).toFixed(3)}
                y="0" width=${(handleHalfW * 2).toFixed(3)} height=${totalH} />
          <rect class="selection-handle"
                x=${(Number(selRight) - handleHalfW).toFixed(3)}
                y="0" width=${(handleHalfW * 2).toFixed(3)} height=${totalH} />
        </svg>
      </div>
      <div class="range-times">
        <div class="field">
          <label>Start</label>
          <input type="text"
                 .value=${formatTime(this._rangeStart, sr)}
                 ?disabled=${disabled || isBusy}
                 @change=${(e) => this._onTimeInput("start", e)}>
        </div>
        <div class="field">
          <label>End</label>
          <input type="text"
                 .value=${formatTime(this._rangeEnd, sr)}
                 ?disabled=${disabled || isBusy}
                 @change=${(e) => this._onTimeInput("end", e)}>
        </div>
        <div class="duration">
          ${this._rangeMode === "loop"
            ? "Uses the session's current loop range"
            : `Length: ${formatTime(Math.max(0, this._rangeEnd - this._rangeStart), sr)}`}
        </div>
      </div>
    `;
  }

  render() {
    if (!this._caps || !this._caps.formats?.length) {
      return html`
        <div class="scrim" @click=${this._onClose}></div>
        <div class="modal" @click=${(e) => e.stopPropagation()}>
          <header>
            <h1>Render Audio</h1>
            <button class="close" @click=${this._onClose} title="Close">${icon("x-mark", 16)}</button>
          </header>
          <div class="body">
            <p class="status">This backend doesn't advertise any render encoders. Open a project first, or attach a backend that supports mixdown.</p>
          </div>
          <footer>
            <button class="secondary" @click=${this._onClose}>Close</button>
          </footer>
        </div>
      `;
    }
    const fmt = this._caps.formats.find((f) => f.id === this._formatId);
    const isBusy = this._state === "running";
    return html`
      <div class="scrim" @click=${this._onClose}></div>
      <div class="modal" @click=${(e) => e.stopPropagation()}>
        <header>
          <h1>Render Audio</h1>
          <button class="close" @click=${this._onClose} title="Close">${icon("x-mark", 16)}</button>
        </header>
        <div class="body">
          <div class="field-row">
            <div class="field">
              <label>Format</label>
              <select .value=${this._formatId} @change=${(e) => (this._formatId = e.target.value)} ?disabled=${isBusy}>
                ${this._caps.formats.map((f) => html`<option value=${f.id}>${f.label}${f.lossy ? " (lossy)" : ""}</option>`)}
              </select>
            </div>
            <div class="field">
              <label>Sample rate</label>
              <select
                .value=${String(this._sampleRate)}
                @change=${(e) => (this._sampleRate = Number(e.target.value))}
                ?disabled=${isBusy || !this._caps.sample_rates?.length}>
                ${(() => {
                  const list = [...(this._caps.sample_rates || [])];
                  const sessionSr = Number(window.__foyer?.store?.state?.session?.sample_rate || 0);
                  if (sessionSr > 0 && !list.includes(sessionSr)) list.unshift(sessionSr);
                  return list.map((sr) => html`<option value=${sr}>${(sr / 1000).toFixed(1)} kHz</option>`);
                })()}
              </select>
            </div>
          </div>
          ${fmt?.lossy
            ? html`
                <div class="field">
                  <label>Quality (${this._quality})</label>
                  <input type="range" min="0" max="10" step="1"
                         .value=${String(this._quality)}
                         @input=${(e) => (this._quality = Number(e.target.value))}
                         ?disabled=${isBusy}>
                </div>
              `
            : html`
                <div class="field">
                  <label>Bit depth</label>
                  <select
                    .value=${this._bitDepth}
                    @change=${(e) => (this._bitDepth = e.target.value)}
                    ?disabled=${isBusy || !this._caps.bit_depths?.length}>
                    ${(this._caps.bit_depths || []).map((bd) => html`<option value=${bd}>${BIT_DEPTH_LABELS[bd] || bd}</option>`)}
                  </select>
                </div>
              `}

          ${this._renderRangePicker()}

          ${this._state === "idle" || this._state === "done" || this._state === "error"
            ? html`<div class="status">${this._state === "done" ? "Render complete — your browser is downloading the file." : "Master bus output."}</div>`
            : html`
                <div class="progress"><div style="width:${this._progress}%"></div></div>
                <div class="status">Encoding… ${this._progress}%</div>
              `}

          ${this._state === "error"
            ? html`<div class="status err">${this._error}</div>`
            : null}

          ${this._state === "done" && this._result
            ? html`
                <div class="result-card">
                  ${icon("speaker-wave", 18)}
                  <div class="meta">
                    <div class="name">${this._result.path?.split("/").pop()}</div>
                    <div class="sub">${(this._result.size_bytes / 1024).toFixed(1)} KB · ${this._result.mime}</div>
                  </div>
                  <button class="secondary" @click=${() => this._triggerDownload(this._result)}>Download again</button>
                </div>
              `
            : null}
        </div>
        <footer>
          <button class="secondary" @click=${this._onClose} ?disabled=${isBusy}>${this._state === "done" ? "Close" : "Cancel"}</button>
          <button class="primary" @click=${this._onRender} ?disabled=${isBusy}>${isBusy ? "Rendering…" : "Render"}</button>
        </footer>
      </div>
    `;
  }
}
customElements.define("foyer-render-modal", RenderModal);

/** Mount the render modal as a sibling of <foyer-app>. */
export function openRenderModal() {
  const el = document.createElement("foyer-render-modal");
  document.body.appendChild(el);
  return el;
}
