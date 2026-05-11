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

export class SettingsModal extends LitElement {
  static properties = {
    _tick: { state: true, type: Number },
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
    this._keyHandler = (ev) => { if (ev.key === "Escape") this._close(); };
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this._keyHandler);
  }
  disconnectedCallback() {
    document.removeEventListener("keydown", this._keyHandler);
    super.disconnectedCallback();
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
    const jitterMs  = Number(a.recordStopSafetyMs)  || 0;
    const ringMs    = Number(a.shimIngressRingPrimeMs) || 0;
    const RING_TIP =
      "Depth of the shim's per-stream audio jitter ring. Bigger absorbs more " +
      "browser GC + WS reorder jitter at the cost of higher live-monitoring " +
      "latency. Recordings are auto-shifted for this latency, so only the " +
      "foreground mix you hear through the engine is delayed. 80 ms suits a " +
      "tunnel; loopback / LAN setups commonly drop to 20–30 ms. Takes effect " +
      "on the next Listen / record stream you open.";
    const SECTION_TIP =
      "When you hit stop while recording browser audio, Foyer waits before the engine " +
      "actually halts so the last in-flight bytes reach Ardour's record source. " +
      "Total delay = capture + network + backend + jitter cushion; the first two are " +
      "measured live (browser baseLatency + ingress one-way median), these two are " +
      "tunable here. Last computed breakdown shows in Diagnostics → Timing. " +
      "Per-track record-shift compensation is a separate path that doesn't use these " +
      "prefs — the shim self-reports its internal latency there.";
    const BACKEND_TIP =
      "IPC + shim ring-prime (80 ms; absorbs WS jitter) + one engine process cycle + " +
      "record-write. The ring is the dominant term and is identical between the " +
      "in-process dummy backend and JACK, so 100 ms is a good default for both. Drop " +
      "to ~90 ms on a tight buffer (JACK 64 samples); raise to 150+ on a loaded tunnel.";
    const JITTER_TIP =
      "Cushion on top of the measured + estimated components. Raise if you still hear " +
      "the tail clipped — median latency under-represents the 95th percentile that " +
      "determines whether a packet missed the deadline.";
    return html`
      <div class="section">
        <h3 title=${SECTION_TIP}>Record stop delay</h3>
        <div class="row">
          <label title=${BACKEND_TIP}>Backend (IPC + Ardour cycle)</label>
          <div class="chip-row">
            ${[90, 100, 120, 150, 200].map((ms) => html`
              <button class="chip ${backendMs === ms ? "active" : ""}"
                      title=${BACKEND_TIP}
                      @click=${() => { writeAudioPrefs({ recordStopBackendMs: ms }); this._refresh(); }}>
                ${ms} ms
              </button>
            `)}
          </div>
        </div>
        <div class="row">
          <label title=${JITTER_TIP}>Jitter cushion</label>
          <div class="chip-row">
            ${[20, 60, 120, 200].map((ms) => html`
              <button class="chip ${jitterMs === ms ? "active" : ""}"
                      title=${JITTER_TIP}
                      @click=${() => { writeAudioPrefs({ recordStopSafetyMs: ms }); this._refresh(); }}>
                ${ms} ms
              </button>
            `)}
          </div>
        </div>
      </div>
      <div class="section">
        <h3 title="Tuning that only applies to the Ardour shim (no-op for the stub backend).">
          Ardour shim
        </h3>
        <div class="row">
          <label title=${RING_TIP}>Ingress jitter ring</label>
          <div class="chip-row">
            ${[20, 30, 50, 80, 120].map((ms) => html`
              <button class="chip ${ringMs === ms ? "active" : ""}"
                      title=${RING_TIP}
                      @click=${() => { writeAudioPrefs({ shimIngressRingPrimeMs: ms }); this._refresh(); }}>
                ${ms} ms
              </button>
            `)}
          </div>
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <div class="card" @click=${(e) => e.stopPropagation()}>
        <header>
          <h2>Preferences</h2>
          <button class="close" title="Close" @click=${this._close}>${icon("x-mark", 16)}</button>
        </header>
        <div class="body">
          ${this._renderAudioSection()}
        </div>
        <footer>
          <button class="primary" @click=${this._close}>Done</button>
        </footer>
      </div>
    `;
  }
}
customElements.define("foyer-settings-modal", SettingsModal);

export function openSettings() {
  const el = document.createElement("foyer-settings-modal");
  const close = () => { el.remove(); };
  el.addEventListener("close", close);
  document.body.appendChild(el);
  return close;
}
