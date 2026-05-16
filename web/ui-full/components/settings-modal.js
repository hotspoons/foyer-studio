// Client-side preferences modal. The only setting that lives here is
// the browser audio stream config (codec + sample rate) — everything
// else has a more direct home in the UI:
//   * transport return-on-stop  → cycle button on the transport bar
//   * waveform style / palette  → the timeline view's settings popover
//   * mixer density / width      → Mixer menu on the mixer toolbar
// DAW-side settings (buffer size, plugin paths, etc.) belong in a
// separate modal that round-trips through the shim; this one is
// intentionally client-only.
//
// Opened from Session → Preferences…, the command palette, or
// Cmd+, / Ctrl+, (global shortcut from main-menu).

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { readAudioPrefs, writeAudioPrefs } from "foyer-core/audio/audio-listener.js";
import { multiWindow } from "foyer-core/multi-window.js";
import { identifyAllWindows } from "foyer-core/multi-window-identify.js";
import {
  listProfiles, getActiveProfileId, setActiveProfile,
} from "foyer-core/keymap/index.js";

export class SettingsModal extends LitElement {
  static properties = {
    _tick: { state: true, type: Number },
    _calibration: { state: true },
  };

  static styles = css`
    :host {
      position: fixed; inset: 0; z-index: 910;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(3px);
      font-family: var(--font-sans);
    }
    .card {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
      width: min(640px, 92vw);
      max-height: 82vh;
      display: flex; flex-direction: column; overflow: hidden;
    }
    header {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--color-border);
    }
    header h2 {
      margin: 0; font-size: 14px; font-weight: 600;
      letter-spacing: 0.04em; color: var(--color-text);
    }
    header .close {
      margin-left: auto;
      background: transparent; border: 0; cursor: pointer;
      color: var(--color-text-muted); padding: 4px;
      border-radius: var(--radius-sm);
    }
    header .close:hover { color: var(--color-text); background: var(--color-surface-elevated); }
    .body { padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; }
    .section {
      display: flex; flex-direction: column; gap: 6px;
    }
    .section h3 {
      margin: 0; font-size: 10px; font-weight: 600;
      letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--color-text-muted);
    }
    .row {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 10px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
    }
    .row label { font-size: 12px; color: var(--color-text); flex: 1; }
    .row select, .row input[type="text"] {
      background: var(--color-surface);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 3px 6px;
      font: inherit; font-size: 11px;
    }
    .chip-row { display: flex; flex-wrap: wrap; gap: 4px; }
    .chip {
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-text-muted);
      padding: 3px 8px;
      font: inherit; font-size: 10px;
      letter-spacing: 0.04em;
      border-radius: var(--radius-sm);
      cursor: pointer;
    }
    .chip.active {
      color: #fff;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      border-color: transparent;
    }
    /* Slider replacement for chip-rows that have a continuous range. */
    .slider-row { display: flex; align-items: center; gap: 10px; min-width: 220px; }
    .slider-row input[type="range"] {
      flex: 1 1 auto;
      min-width: 120px;
      height: 4px;
      -webkit-appearance: none;
      appearance: none;
      background: color-mix(in oklab, var(--color-border) 70%, var(--color-surface));
      border-radius: var(--radius-sm);
      cursor: pointer;
    }
    .slider-row input[type="range"]::-webkit-slider-runnable-track {
      height: 4px;
      border-radius: var(--radius-sm);
      background: color-mix(in oklab, var(--color-border) 70%, var(--color-surface));
    }
    .slider-row input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 12px; height: 12px; margin-top: -4px;
      border-radius: 50%;
      background: var(--color-accent);
      border: 2px solid var(--color-surface-elevated);
      box-shadow: 0 1px 3px rgba(0,0,0,0.35);
    }
    .slider-row input[type="range"]::-moz-range-thumb {
      width: 12px; height: 12px;
      border-radius: 50%;
      background: var(--color-accent);
      border: 2px solid var(--color-surface-elevated);
      box-shadow: 0 1px 3px rgba(0,0,0,0.35);
    }
    .slider-row .val {
      font-size: 11px;
      color: var(--color-text);
      font-variant-numeric: tabular-nums;
      min-width: 4.5em;
      text-align: right;
    }
    .slider-row .num {
      flex: 0 0 auto;
      width: 4.5em;
      background: var(--color-surface);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 2px 6px;
      font: inherit; font-size: 11px;
      font-variant-numeric: tabular-nums;
      text-align: right;
      -moz-appearance: textfield;
    }
    .slider-row .num::-webkit-outer-spin-button,
    .slider-row .num::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }
    .slider-row .unit {
      font-size: 10px;
      color: var(--color-text-muted);
      letter-spacing: 0.04em;
    }
    footer {
      padding: 10px 18px;
      border-top: 1px solid var(--color-border);
      display: flex; justify-content: flex-end; gap: 8px;
    }
    footer button {
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-text);
      padding: 4px 12px; cursor: pointer;
      border-radius: var(--radius-sm);
      font: inherit; font-size: 12px;
    }
    footer button.primary {
      color: #fff;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      border-color: transparent;
    }
  `;

  constructor() {
    super();
    this._tick = 0;
    /** @type {null | {status: "running"|"done"|"failed", n?: number, total?: number, recent?: number[], result?: object, error?: string}} */
    this._calibration = null;
    this._keyHandler = (ev) => { if (ev.key === "Escape") this._close(); };
    this._envHandler = (ev) => this._onEnvelope(ev?.detail);
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this._keyHandler);
    const ws = globalThis.__foyer?.ws;
    if (ws) ws.addEventListener("envelope", this._envHandler);
    // Keep the Windows section live as siblings arrive / depart while
    // the modal is open.
    this._onMw = () => this._refresh();
    multiWindow.addEventListener("sibling-hello", this._onMw);
    multiWindow.addEventListener("sibling-bye", this._onMw);
    multiWindow.addEventListener("ready", this._onMw);
  }
  disconnectedCallback() {
    document.removeEventListener("keydown", this._keyHandler);
    const ws = globalThis.__foyer?.ws;
    if (ws) ws.removeEventListener("envelope", this._envHandler);
    multiWindow.removeEventListener("sibling-hello", this._onMw);
    multiWindow.removeEventListener("sibling-bye", this._onMw);
    multiWindow.removeEventListener("ready", this._onMw);
    super.disconnectedCallback();
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (!body) return;
    if (body.type === "calibration_progress") {
      const prev = this._calibration || {};
      const recent = (prev.recent || []).slice();
      recent.push(body.measured_ms);
      this._calibration = {
        ...prev,
        status: "running",
        stage: "running",
        n: body.n,
        total: body.total,
        recent,
      };
    } else if (body.type === "calibration_result") {
      this._calibration = {
        ...(this._calibration || {}),
        status: "done",
        stage: "done",
        result: body,
      };
    }
  }

  async _startCalibration() {
    const ws = globalThis.__foyer?.ws;
    const audio = globalThis.__foyer?.audio;
    if (!ws || !audio) return;

    this._calibration = { status: "running", stage: "setup", n: 0, total: 5, recent: [] };
    this.requestUpdate();

    let listenWasOn = !!audio._on;
    let ephemeralIngress = null;
    let createdListen = false;

    try {
      // 1) Listen — start if off, remember so we can restore.
      if (!listenWasOn) {
        await audio.start({ silent: true });
        createdListen = true;
        // Wait briefly for the listener to handshake + the worklet
        // to start running so the first click has a complete path
        // to the speakers.
        await new Promise((r) => setTimeout(r, 500));
      }
      const egressId = audio?._listener?.streamId;
      if (!egressId) throw new Error("Listen failed to start");

      // 2) Ingress — reuse a running one (track-mic) if present;
      //    otherwise mint an ephemeral one purely for calibration.
      //    The ephemeral ingress doesn't connect to any track — we
      //    just need the audio bytes to land on the server so the
      //    detector sees the reflection.
      let ingressId = null;
      const mics = globalThis.__foyerTrackMics;
      if (mics) {
        for (const [, mic] of mics) {
          if (mic?.ingress?._running) { ingressId = mic.ingress.streamId; break; }
        }
      }
      if (!ingressId) {
        const { AudioIngress } = await import("foyer-core/audio/audio-ingress.js");
        const baseUrl = location.origin.replace(/^http/, "ws");
        ephemeralIngress = new AudioIngress({ ws, baseUrl });
        await ephemeralIngress.start();
        ingressId = ephemeralIngress.streamId;
      }

      // 3) Fire the calibration and await the result event.
      // Server timing: 1 s settling + 5 clicks × 800 ms = 5 s
      // emission, plus ≤700 ms for the last click's reflection.
      // 10 s gives ~3 s slack for slow ingress handshakes / cold
      // worklet starts.
      const resultPromise = new Promise((resolve, reject) => {
        const onEnv = (ev) => {
          const body = ev?.detail?.body;
          if (body?.type === "calibration_result") {
            clearTimeout(timer);
            ws.removeEventListener("envelope", onEnv);
            resolve(body);
          }
        };
        const timer = setTimeout(() => {
          ws.removeEventListener("envelope", onEnv);
          reject(new Error("No click detections — speaker may be muted or mic too quiet."));
        }, 10000);
        ws.addEventListener("envelope", onEnv);
      });

      this._calibration = { ...this._calibration, stage: "running" };
      this.requestUpdate();

      ws.send({
        type: "start_ingress_calibration",
        egress_stream_id: egressId,
        ingress_stream_id: ingressId,
        clicks: 5,
      });

      await resultPromise;
      // _onEnvelope has already stashed the result in this._calibration.
    } catch (e) {
      this._calibration = {
        ...(this._calibration || {}),
        status: "failed",
        error: e.message,
      };
      // Best-effort server-side abort in case clicks are still queued.
      try {
        const egressId = audio?._listener?.streamId;
        if (egressId) ws.send({ type: "stop_ingress_calibration", egress_stream_id: egressId });
      } catch {}
    } finally {
      // 4) Tear down ONLY what we created.
      if (ephemeralIngress) {
        try { await ephemeralIngress.stop(); } catch {}
      }
      if (createdListen) {
        try { await audio.stop({ silent: true }); } catch {}
      }
      this.requestUpdate();
    }
  }

  _applyCalibration() {
    const r = this._calibration?.result;
    if (!r) return;
    // Use the suggested value verbatim — calibration might find a
    // larger speaker→mic loop than the 0–350 slider range, or a
    // negative one if the empirical stack already over-counts.
    // The numeric input next to the slider lets the user dial it
    // further if needed; clamping here would lose information.
    this._setManualOffset(r.suggested_offset_ms);
    this._calibration = { ...this._calibration, status: "applied" };
  }

  _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }
  _refresh() { this._tick++; }

  _onBackdrop(ev) { if (ev.target === this) this._close(); }

  createRenderRoot() {
    const root = super.createRenderRoot();
    this.addEventListener("click", (e) => this._onBackdrop(e));
    return root;
  }

  _renderAudioSection() {
    const a = readAudioPrefs();
    const rates = [44_100, 48_000, 88_200, 96_000, 176_400, 192_000];
    const hint = a.codec === "opus" && a.sampleRate > 48_000
      ? html`<div style="font-size:10px;color:var(--color-warning,#f59e0b);padding:4px 0">
               Opus tops out at 48 kHz — the stream will automatically fall back to raw when you
               start a higher-rate listen. Switch codec to raw for predictable behavior.
             </div>`
      : null;
    const hint2 = (a.sampleRate > 48_000)
      ? html`<div style="font-size:10px;color:var(--color-text-muted);padding:4px 0">
               Higher-rate streaming uses lossless raw PCM (Opus is capped at 48 kHz). The sidecar
               resamples engine PCM to the rate you pick when it differs from the project.
             </div>`
      : null;
    const driftMs = Number(a.sentinelDriftMs) || 0;
    return html`
      <div class="section">
        <h3>Browser audio stream</h3>
        <div class="row">
          <label>Codec</label>
          <div class="chip-row">
            <button class="chip ${a.codec === "opus" ? "active" : ""}"
                    @click=${() => { writeAudioPrefs({ codec: "opus" }); this._refresh(); }}>
              Opus (compressed)
            </button>
            <button class="chip ${a.codec === "raw_f32_le" ? "active" : ""}"
                    @click=${() => { writeAudioPrefs({ codec: "raw_f32_le" }); this._refresh(); }}>
              Raw PCM (lossless)
            </button>
          </div>
        </div>
        <div class="row">
          <label>Sample rate</label>
          <select @change=${(e) => { writeAudioPrefs({ sampleRate: Number(e.currentTarget.value) }); this._refresh(); }}
                  style="background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-border);border-radius:4px;padding:2px 6px">
            ${rates.map((r) => html`
              <option value=${r} ?selected=${r === a.sampleRate}>${(r / 1000).toFixed(1)} kHz</option>
            `)}
          </select>
        </div>
        <div class="row">
          <label title="Reopen the audio stream when sentinel events arrive more than this many ms after their matching audio frame. 0 = never auto-restart.">
            Auto-restart on drift
          </label>
          <div class="chip-row">
            ${[0, 200, 300, 500, 800].map((ms) => html`
              <button class="chip ${driftMs === ms ? "active" : ""}"
                      title=${ms === 0
                        ? "Disable auto-restart — Foyer will never tear down the stream on drift, only on a network drop."
                        : `Reopen when sentinel drift exceeds ${ms} ms while transport is paused.`}
                      @click=${() => { writeAudioPrefs({ sentinelDriftMs: ms }); this._refresh(); }}>
                ${ms === 0 ? "Off" : `${ms} ms`}
              </button>
            `)}
          </div>
        </div>
        ${hint}
        ${hint2}
      </div>
      ${this._renderRecordStopSection(a)}
    `;
  }

  _renderRecordStopSection(a) {
    const backendMs = Number(a.recordStopBackendMs) || 0;
    const ringMs    = Number(a.shimIngressRingPrimeMs) || 0;
    const offsetMs  = Number(a.ingressManualOffsetMs) || 0;
    const BUFFER_TIP =
      "How much audio the shim's per-stream ingress buffer holds before draining " +
      "into Ardour's record source. Bigger absorbs more browser GC + WS reorder " +
      "jitter at the cost of higher live-monitoring latency. Recordings are auto-" +
      "shifted for this depth, so only the foreground mix you hear through the " +
      "engine is delayed. 80 ms suits a tunnel; loopback / LAN setups commonly " +
      "drop to 20–30 ms. This value also doubles as the record-stop cushion — " +
      "anything still in flight when you press stop has at most this much time " +
      "to land before the engine halts. Takes effect on the next Listen / record " +
      "stream you open.";
    const SECTION_TIP =
      "When you hit stop while recording browser audio, Foyer waits before the engine " +
      "actually halts so the last in-flight bytes reach Ardour's record source. " +
      "Total delay = capture + network + backend + ingress buffer depth; the first " +
      "two are measured live (browser baseLatency + ingress one-way median), the " +
      "last two are tunable in this section and the next. Last computed breakdown " +
      "shows in Diagnostics → Timing.";
    const BACKEND_TIP =
      "IPC + one engine process cycle + record-write. The ingress buffer (next " +
      "section) is added on top, so this number doesn't need to include it. " +
      "Defaults to 100 ms which suits both the in-process dummy backend and a " +
      "small-buffer JACK setup. Drop to ~90 ms on a tight buffer (JACK 64 samples); " +
      "raise to 150+ on a loaded tunnel.";
    const OFFSET_TIP =
      "Signed millisecond offset added on top of the empirical browser↔server " +
      "round-trip the server measures from your ingress packets. Use this to " +
      "dial in any residual the echo math can't observe — typically the mic-to-" +
      "browser-stack hop and any platform output-latency that's under-reported by " +
      "the browser. Positive shifts recordings earlier (longer _capture_offset); " +
      "negative shifts later. Sing along to an existing track, eyeball the offset " +
      "in the timeline, and dial this until the new take lines up. Live — applies " +
      "on the next packet without restarting the stream.";
    const fmtSigned = (n) => (n > 0 ? `+${n} ms` : `${n} ms`);
    return html`
      <div class="section">
        <h3 title=${SECTION_TIP}>Record stop delay</h3>
        <div class="row">
          <label title=${BACKEND_TIP}>Backend (IPC + Ardour cycle)</label>
          <div class="slider-row" title=${BACKEND_TIP}>
            <input type="range" min="60" max="300" step="10"
                   .value=${String(backendMs)}
                   @input=${(e) => {
                     const ms = Math.round(Number(e.target.value));
                     writeAudioPrefs({ recordStopBackendMs: ms });
                     this._refresh();
                   }}>
            <span class="val">${backendMs} ms</span>
          </div>
        </div>
      </div>
      <div class="section">
        <h3 title="Tuning for the browser→shim audio path. Drives both the ingress buffer depth (Ardour shim) and the empirical capture-offset stack.">
          Recording alignment
        </h3>
        <div class="row">
          <label title=${BUFFER_TIP}>Ingress jitter buffer</label>
          <div class="slider-row" title=${BUFFER_TIP}>
            <input type="range" min="20" max="200" step="10"
                   .value=${String(ringMs)}
                   @input=${(e) => {
                     const ms = Math.round(Number(e.target.value));
                     writeAudioPrefs({ shimIngressRingPrimeMs: ms });
                     this._refresh();
                   }}>
            <span class="val">${ringMs} ms</span>
          </div>
        </div>
        <div class="row">
          <label title=${OFFSET_TIP}>Manual capture offset</label>
          <div class="slider-row" title=${OFFSET_TIP}>
            <input type="range" min="0" max="350" step="20"
                   .value=${String(Math.max(0, Math.min(350, offsetMs)))}
                   @input=${(e) => {
                     const ms = Math.round(Number(e.target.value) / 20) * 20;
                     this._setManualOffset(ms);
                   }}>
            <input type="number" class="num" step="1"
                   .value=${String(offsetMs)}
                   @change=${(e) => {
                     const raw = Number(e.target.value);
                     if (!Number.isFinite(raw)) return;
                     this._setManualOffset(Math.round(raw));
                   }}>
            <span class="unit">ms</span>
          </div>
        </div>
        ${this._renderCalibrationRow()}
      </div>
    `;
  }

  _renderCalibrationRow() {
    const CAL_TIP =
      "Plays a sequence of brief 4 kHz clicks out the egress audio (your speakers) " +
      "and listens for the reflection on the ingress (your mic). The measured speaker→" +
      "mic round-trip is the GROUND-TRUTH capture latency that the empirical echo " +
      "math can't see directly. The result becomes the suggested Manual capture offset. " +
      "Auto-starts Listen and opens a temporary mic stream if neither is already on, " +
      "then restores their previous state. ~3 s total.";
    const c = this._calibration;
    const status = c?.status;
    const stage = c?.stage;
    const result = c?.result;
    let line;
    if (status === "running" && stage === "setup") {
      line = html`<span class="val" style="min-width:9em">Setting up…</span>`;
    } else if (status === "running") {
      const n = c?.n ?? 0, total = c?.total ?? 5;
      const recent = (c?.recent ?? []).slice(-3).map((m) => `${Math.round(m)}`).join(", ");
      line = html`<span class="val" style="min-width:9em">${n}/${total} (${recent || "—"} ms)</span>`;
    } else if (status === "done" && result) {
      line = html`
        <span class="val" style="min-width:11em">
          median ${result.median_ms.toFixed(0)} ms · suggest +${result.suggested_offset_ms} ms
        </span>
        <button class="chip active" @click=${() => this._applyCalibration()}>Apply</button>
      `;
    } else if (status === "applied") {
      line = html`<span class="val" style="min-width:11em;color:var(--color-accent)">Applied</span>`;
    } else if (status === "failed") {
      line = html`<span class="val" style="min-width:11em;color:var(--color-warning,#f59e0b);font-size:10px">${c.error}</span>`;
    } else {
      line = html`<span class="val"></span>`;
    }
    return html`
      <div class="row">
        <label title=${CAL_TIP}>Auto-calibrate</label>
        <div class="slider-row" title=${CAL_TIP} style="justify-content:flex-end">
          ${line}
          <button class="chip" ?disabled=${status === "running"}
                  @click=${() => this._startCalibration()}>
            ${status === "running" ? "Running…" : "Calibrate"}
          </button>
        </div>
      </div>
    `;
  }

  _setManualOffset(ms) {
    writeAudioPrefs({ ingressManualOffsetMs: ms });
    const ws = globalThis.__foyer?.ws;
    try { ws?.send({ type: "set_ingress_manual_offset_ms", ms }); } catch {}
    this._refresh();
  }

  render() {
    return html`
      <div class="card" @click=${(e) => e.stopPropagation()}>
        <header>
          <h2>Preferences</h2>
          <button class="close" title="Close" @click=${this._close}>${icon("x-mark", 16)}</button>
        </header>
        <div class="body">
          ${this._renderEditorConventionsSection()}
          ${this._renderAudioSection()}
          ${this._renderWindowsSection()}
        </div>
        <footer>
          <button class="primary" @click=${this._close}>Done</button>
        </footer>
      </div>
    `;
  }

  /**
   * "Editor conventions" — DAW-flavoured keyboard + mouse-wheel
   * profile. Default is Foyer's native scheme (wheel-zoom-at-cursor,
   * =/- zoom). Picking another profile swaps the wheel behaviour
   * across the timeline body / ruler / overview and the keyboard
   * shortcuts for transport, undo/redo, zoom, split, and mute. See
   * `web/core/keymap/profiles.js` for the per-profile spec.
   */
  _renderEditorConventionsSection() {
    const active = getActiveProfileId();
    const profiles = listProfiles();
    const current = profiles.find((p) => p.id === active) || profiles[0];
    return html`
      <div class="section">
        <h3>Editor conventions</h3>
        <div class="row">
          <label title="DAW-style keyboard shortcuts and mouse-wheel behaviour. Affects the timeline body, ruler, overview strip, and transport keys.">
            Profile
          </label>
          <select
            style="background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-border);border-radius:4px;padding:2px 6px"
            @change=${(e) => { setActiveProfile(e.currentTarget.value); this._refresh(); }}>
            ${profiles.map((p) => html`
              <option value=${p.id} ?selected=${p.id === active}>${p.label}</option>
            `)}
          </select>
        </div>
        <div style="font-size:10px;color:var(--color-text-muted);padding:4px 0 0 2px;line-height:1.5">
          ${current.description}
        </div>
      </div>
    `;
  }

  /**
   * Spawn / identify controls for the multi-window family. The
   * "+ New window" affordance used to live in the status bar but
   * most users open another window once and never touch the control
   * again, so it migrated here to keep the toolbar quiet. The same
   * action is bound to `Ctrl+Alt+W` (`Cmd+Alt+W` on macOS) — see
   * `web/ui-full/components/app.js` for the binding.
   */
  _renderWindowsSection() {
    if (typeof BroadcastChannel !== "function") {
      // Sibling sync needs BroadcastChannel; skip the section in
      // browsers that lack it. The keyboard shortcut also no-ops.
      return null;
    }
    const myNum = multiWindow.windowNumber;
    const myRole = multiWindow.role;
    const siblings = (multiWindow.siblings || [])
      .slice()
      .sort((a, b) => Number(a.slot ?? 0) - Number(b.slot ?? 0));
    const isSecondary = multiWindow.isSecondary;
    return html`
      <div class="section">
        <h3>Windows</h3>
        <div class="row">
          <label title="This browser tab/window's place in the multi-window family. All windows share session state; audio I/O is owned by the spawning (Primary) window.">
            This window
          </label>
          <div class="slider-row" style="justify-content:flex-end">
            <span class="val" style="min-width:11em">
              Window ${myNum ?? "•"} ·
              ${myRole === "primary" ? "Primary" : "Secondary"}
            </span>
            <button class="chip" title="Flash 'Window N' on every open window so you can match labels to physical screens"
                    @click=${this._identifyWindows}>
              Identify
            </button>
          </div>
        </div>
        <div class="row">
          <label title=${isSecondary
            ? "Secondary windows ask their Primary to spawn the new window — same family, fresh slot."
            : "Spawn a new browser window attached to this Foyer session. Audio stays on this (Primary) window."}>
            Open new window
          </label>
          <div class="slider-row" style="justify-content:flex-end">
            <span class="val" style="font-size:10px;color:var(--color-text-muted)">
              Ctrl+Alt+W
            </span>
            <button class="chip" @click=${this._openNewWindow}>
              + New window
            </button>
          </div>
        </div>
        ${siblings.length > 0 ? html`
          <div class="row" style="align-items:flex-start">
            <label>Other windows</label>
            <div class="slider-row" style="justify-content:flex-end;flex-wrap:wrap;gap:6px">
              ${siblings.map((s) => {
                const n = multiWindow.siblingWindowNumber(s.slot);
                return html`
                  <span class="val" style="border:1px solid var(--color-border);border-radius:4px;padding:2px 8px">
                    Window ${n ?? "•"} · ${s.role}
                  </span>
                `;
              })}
            </div>
          </div>
        ` : null}
        <div class="row">
          <label title="Drop every saved window for the current monitor layout. Use this if you see weird slot numbers (Window 7 with no Window 2-6) — stale entries from dev sessions get wiped and the next + New window starts from Window 2 again.">
            Reset saved layout
          </label>
          <div class="slider-row" style="justify-content:flex-end">
            <button class="chip" @click=${this._forgetWindows}>
              Forget saved windows
            </button>
          </div>
        </div>
      </div>
    `;
  }

  _forgetWindows = async () => {
    const wr = globalThis.__foyer?.windowRestore;
    if (!wr?.forgetAllWindows) return;
    await wr.forgetAllWindows();
    this._refresh();
  };

  _openNewWindow = async () => {
    try {
      await multiWindow.openSecondary({ width: 1280, height: 820 });
      this._refresh();
    } catch (err) {
      console.warn("[settings] open secondary failed", err);
    }
  };

  _identifyWindows = () => {
    identifyAllWindows({ durationMs: 4000 });
  };
}
customElements.define("foyer-settings-modal", SettingsModal);

export function openSettings() {
  const el = document.createElement("foyer-settings-modal");
  const close = () => { el.remove(); };
  el.addEventListener("close", close);
  document.body.appendChild(el);
  return close;
}
