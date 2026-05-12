// Dev-only diagnostics panel. Dual-tab:
//   * Probes — calls the sidecar's `/dev/run-tests` endpoint (requires
//     `FOYER_DEV=1`) and renders a per-probe pass/fail list.
//   * Timing — subscribes to the running `audioController` sentinel
//     stream and shows real-time audio-vs-event drift, clock-sync
//     state, and audio-clock internals. This tab is always live even
//     when probes are disabled.
//
// Both tabs share the window.__foyer singleton set up by bootstrap.js
// so they don't need to import deeply into core.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { scrollbarStyles } from "foyer-ui-core/shared-styles.js";

export class DiagnosticsView extends LitElement {
  static properties = {
    _tab:        { state: true, type: String },
    _probes:     { state: true, type: Array },
    _results:    { state: true, type: Array },
    _running:    { state: true, type: Boolean },
    _disabled:   { state: true, type: Boolean },
    _error:      { state: true, type: String },
    _selected:   { state: true, type: Object }, // Set<id>
    _timing:     { state: true, type: Object },
  };

  static styles = css`
    ${scrollbarStyles}
    :host {
      display: flex; flex-direction: column;
      height: 100%;
      font-family: var(--font-sans);
      color: var(--color-text);
      background: transparent;
    }
    .toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
    }
    .title { font-weight: 600; font-size: 12px; letter-spacing: 0.05em; text-transform: uppercase; }
    .count { color: var(--color-text-muted); font-size: 11px; }
    .spacer { flex: 1; }
    button {
      font-family: var(--font-sans);
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 3px;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text);
      cursor: pointer;
      transition: all 0.12s ease;
    }
    button:hover { border-color: var(--color-accent); color: var(--color-accent); }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    button.primary {
      background: color-mix(in oklab, var(--color-accent) 25%, var(--color-surface));
      border-color: var(--color-accent);
    }
    button.tab {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      border-radius: 0;
      padding: 4px 8px;
    }
    button.tab.active {
      color: var(--color-accent);
      border-bottom-color: var(--color-accent);
    }
    .scroll {
      flex: 1; overflow: auto;
      padding: 8px 12px;
    }
    .row {
      display: grid;
      grid-template-columns: 24px 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 8px 10px;
      border-bottom: 1px solid var(--color-border);
      cursor: pointer;
      transition: background 0.1s ease;
    }
    .row:hover { background: var(--color-surface-elevated); }
    .row.selected { background: color-mix(in oklab, var(--color-accent) 10%, var(--color-surface)); }
    .status { width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; }
    .status.pass { color: var(--color-success, #5cd188); background: color-mix(in oklab, var(--color-success, #5cd188) 18%, transparent); }
    .status.fail { color: var(--color-danger, #d04040); background: color-mix(in oklab, var(--color-danger, #d04040) 22%, transparent); }
    .status.idle { color: var(--color-text-muted); }
    .status.running { color: var(--color-accent); animation: spin 0.9s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .probe-id { font-family: var(--font-mono); font-size: 11px; color: var(--color-text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .probe-desc { font-size: 11px; color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .probe-detail { font-family: var(--font-mono); font-size: 10px; color: var(--color-text-muted); margin-top: 2px; word-break: break-all; }
    .probe-detail.fail { color: color-mix(in oklab, var(--color-danger, #d04040) 80%, var(--color-text-muted)); }
    .elapsed { font-family: var(--font-mono); font-size: 10px; color: var(--color-text-muted); text-align: right; white-space: nowrap; }
    .banner {
      padding: 12px 16px;
      background: color-mix(in oklab, var(--color-warning, #d0a040) 12%, var(--color-surface));
      border-bottom: 1px solid color-mix(in oklab, var(--color-warning, #d0a040) 40%, var(--color-border));
      font-size: 11px;
      color: var(--color-text);
    }
    .banner code { font-family: var(--font-mono); background: var(--color-surface); padding: 1px 4px; border-radius: 2px; }
    .summary {
      display: flex; gap: 12px;
      padding: 10px 14px;
      border-top: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
      font-size: 11px;
    }
    .summary .pill {
      padding: 2px 8px;
      border-radius: 10px;
      font-family: var(--font-mono);
      font-weight: 600;
    }
    .summary .pill.pass { color: var(--color-success, #5cd188); background: color-mix(in oklab, var(--color-success, #5cd188) 14%, transparent); }
    .summary .pill.fail { color: var(--color-danger, #d04040);  background: color-mix(in oklab, var(--color-danger, #d04040) 16%, transparent); }
    .timing-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
      font-family: var(--font-mono);
    }
    .timing-table th {
      text-align: left;
      padding: 4px 8px;
      border-bottom: 1px solid var(--color-border);
      color: var(--color-text-muted);
    }
    .timing-table td {
      padding: 4px 8px;
      border-bottom: 1px solid var(--color-border);
      color: var(--color-text);
    }
    .timing-table tr:nth-child(even) { background: var(--color-surface-elevated); }
    .timing-val { white-space: nowrap; }
    .timing-val.warn { color: var(--color-warning, #d0a040); }
    .timing-val.danger { color: var(--color-danger, #d04040); }
    .timing-val.ok { color: var(--color-success, #5cd188); }
  `;

  constructor() {
    super();
    this._tab = "probes";
    this._probes = [];
    this._results = [];
    this._running = false;
    this._disabled = false;
    this._error = "";
    this._selected = new Set();
    this._timing = null;
    this._sentinelListener = null;
    this._tickTimer = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._loadProbes();
    this._attachTimingListeners();
    this._tickTimer = setInterval(() => this._refreshTiming(), 500);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._tickTimer) clearInterval(this._tickTimer);
    this._detachTimingListeners();
  }

  _attachTimingListeners() {
    const ctrl = globalThis.__foyer?.audio;
    if (ctrl) {
      this._sentinelListener = (ev) => this._onSentinel(ev.detail);
      ctrl.addEventListener("sentinel", this._sentinelListener);
    }
    const ws = globalThis.__foyer?.ws;
    if (ws) {
      this._envelopeListener = (ev) => this._onEnvelope(ev?.detail);
      ws.addEventListener("envelope", this._envelopeListener);
    }
  }

  _detachTimingListeners() {
    const ctrl = globalThis.__foyer?.audio;
    if (ctrl && this._sentinelListener) {
      ctrl.removeEventListener("sentinel", this._sentinelListener);
      this._sentinelListener = null;
    }
    const ws = globalThis.__foyer?.ws;
    if (ws && this._envelopeListener) {
      ws.removeEventListener("envelope", this._envelopeListener);
      this._envelopeListener = null;
    }
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (!body) return;
    if (body.type === "ingress_latency_report") {
      this._timing = {
        ...(this._timing || {}),
        empiricalIngress: {
          streamId: body.stream_id,
          medianMs: body.median_ms,
          updatedAt: performance.now(),
        },
      };
      this.requestUpdate();
    } else if (body.type === "midi_latency_report") {
      const map = new Map(this._timing?.empiricalMidi || []);
      map.set(body.track_id, {
        medianMs: body.median_ms,
        samples: body.samples_to_shim,
        updatedAt: performance.now(),
      });
      this._timing = {
        ...(this._timing || {}),
        empiricalMidi: Array.from(map.entries()),
      };
      this.requestUpdate();
    }
  }

  _setFakeLatency(which, raw) {
    const ms = Math.max(0, Math.min(2000, Number(raw) || 0));
    if (which === "ingress") this._fakeIngressInput = ms;
    else if (which === "egress") this._fakeEgressInput = ms;
    const ws = globalThis.__foyer?.ws;
    if (!ws) return;
    const body = { type: "set_fake_latency" };
    if (which === "ingress") body.ingress_ms = ms;
    if (which === "egress") body.egress_ms = ms;
    ws.send(body);
  }

  _onSentinel(detail) {
    // Dispatched by AudioController when it correlates an audio_sentinel
    // event with a matching audio frame.
    this._timing = {
      ...(this._timing || {}),
      lastSentinel: detail,
      sentinelHistory: globalThis.__foyer?.audio?._sentinelHistory?.slice(-10) || [],
    };
    this.requestUpdate();
  }

  _refreshTiming() {
    const ctrl = globalThis.__foyer?.audio;
    const clock = globalThis.__foyer?.audioClock;
    const sync = globalThis.__foyer?.clockSync;
    const ws = globalThis.__foyer?.ws;
    const store = globalThis.__foyer?.store;

    if (!clock && !sync) return;

    this._timing = {
      ...(this._timing || {}),
      audioClock: clock ? clock.snapshot() : null,
      clockSync: sync ? {
        offsetMs: sync.offsetMs,
        minRttMs: sync.minRttMs,
      } : null,
      wsStatus: ws?.status || "unknown",
      playing: !!store?.state?.controls?.get("transport.playing"),
      recording: !!store?.state?.controls?.get("transport.recording"),
      lastStopDelay: globalThis.__foyer?.lastStopDelay || null,
    };
    this.requestUpdate();
  }

  async _loadProbes() {
    try {
      const res = await fetch("/dev/list-tests");
      if (res.status === 404) {
        this._disabled = true;
        return;
      }
      const body = await res.json();
      this._probes = body.probes || [];
    } catch (e) {
      this._error = String(e);
    }
  }

  async _runAll() {
    this._run("");
  }
  async _runSelected() {
    if (!this._selected.size) return this._runAll();
    this._run(Array.from(this._selected).join(","));
  }
  async _run(idsParam) {
    if (this._running) return;
    this._running = true;
    this._error = "";
    try {
      const res = await fetch(
        idsParam ? `/dev/run-tests?ids=${encodeURIComponent(idsParam)}` : "/dev/run-tests",
      );
      const body = await res.json();
      const byId = new Map(this._results.map((r) => [r.id, r]));
      for (const r of body.results) byId.set(r.id, r);
      this._results = Array.from(byId.values());
    } catch (e) {
      this._error = String(e);
    } finally {
      this._running = false;
    }
  }

  _toggleSelected(id) {
    const s = new Set(this._selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    this._selected = s;
  }

  _setTab(t) {
    this._tab = t;
  }

  render() {
    return html`
      <div class="toolbar">
        <button class="tab ${this._tab === "probes" ? "active" : ""}" @click=${() => this._setTab("probes")}>Probes</button>
        <button class="tab ${this._tab === "timing" ? "active" : ""}" @click=${() => this._setTab("timing")}>Timing</button>
        <span class="spacer"></span>
      </div>
      ${this._tab === "probes" ? this._renderProbes() : this._renderTiming()}
    `;
  }

  _renderProbes() {
    if (this._disabled) {
      return html`
        <div class="banner">
          Dev probes aren't mounted on this server. Restart with <code>FOYER_DEV=1 just run</code>
          to enable <code>/dev/run-tests</code>.
        </div>
      `;
    }
    const resultsById = new Map(this._results.map((r) => [r.id, r]));
    const passed = this._results.filter((r) => r.pass).length;
    const failed = this._results.length - passed;
    return html`
      <div class="toolbar">
        <span class="count">${this._probes.length} probes</span>
        <span class="spacer"></span>
        <button @click=${this._runSelected} ?disabled=${this._running}>
          Run ${this._selected.size ? `selected (${this._selected.size})` : "all"}
        </button>
        <button class="primary" @click=${this._runAll} ?disabled=${this._running}>
          ${this._running ? "Running…" : "Run all"}
        </button>
      </div>
      ${this._error ? html`<div class="banner">error: ${this._error}</div>` : null}
      <div class="scroll">
        ${this._probes.map((p) => {
          const result = resultsById.get(p.id);
          const status = this._running
            ? "running"
            : result
              ? (result.pass ? "pass" : "fail")
              : "idle";
          const statusGlyph = status === "pass" ? icon("check-circle", 16)
            : status === "fail" ? icon("x-circle", 16)
            : status === "running" ? icon("arrow-path", 16)
            : icon("ellipsis-horizontal", 16);
          const selected = this._selected.has(p.id);
          return html`
            <div class="row ${selected ? "selected" : ""}"
                 @click=${() => this._toggleSelected(p.id)}
                 title="Click to select this probe for targeted re-runs">
              <span class="status ${status}">${statusGlyph}</span>
              <div class="meta">
                <div class="probe-id">${p.id}</div>
                <div class="probe-desc">${p.description}</div>
                ${result?.detail ? html`
                  <div class="probe-detail ${result.pass ? "" : "fail"}">${result.detail}</div>
                ` : null}
              </div>
              <div class="elapsed">${result ? `${result.elapsed_ms} ms` : "—"}</div>
            </div>
          `;
        })}
      </div>
      ${this._results.length ? html`
        <div class="summary">
          <span class="pill pass">${passed} passed</span>
          ${failed ? html`<span class="pill fail">${failed} failed</span>` : null}
          <span class="spacer"></span>
        </div>
      ` : null}
    `;
  }

  _renderTiming() {
    const t = this._timing || {};
    const sentinelHistory = t.sentinelHistory || [];
    const clock = t.audioClock || {};
    const sync = t.clockSync || {};

    const lastDrift = t.lastSentinel?.driftMs ?? null;
    const driftClass = lastDrift == null
      ? ""
      : lastDrift > 300 ? "danger"
      : lastDrift > 100 ? "warn"
      : "ok";

    return html`
      <div class="scroll">
        <table class="timing-table">
          <tbody>
            <tr><th colspan="2">Audio sentinel drift (last)</th></tr>
            <tr>
              <td>Drift</td>
              <td class="timing-val ${driftClass}">
                ${lastDrift != null ? `${lastDrift.toFixed(1)} ms` : "—"}
              </td>
            </tr>
            <tr>
              <td>Audio arrived</td>
              <td>${t.lastSentinel?.audioArrivedMs?.toFixed(1) ?? "—"}</td>
            </tr>
            <tr>
              <td>Sentinel arrived</td>
              <td>${t.lastSentinel?.sentinelArrivedMs?.toFixed(1) ?? "—"}</td>
            </tr>
            <tr><th colspan="2">Clock sync</th></tr>
            <tr>
              <td>Offset</td>
              <td>${sync.offsetMs != null ? `${sync.offsetMs.toFixed(2)} ms` : "—"}</td>
            </tr>
            <tr>
              <td>Min RTT</td>
              <td>${sync.minRttMs != null ? `${sync.minRttMs.toFixed(2)} ms` : "—"}</td>
            </tr>
            <tr><th colspan="2">Audio clock</th></tr>
            <tr>
              <td>Has audio clock</td>
              <td>${clock.hasAudioClock ? "yes" : "no"}</td>
            </tr>
            <tr>
              <td>Frames queued</td>
              <td>${clock.framesQueued ?? "—"}</td>
            </tr>
            <tr>
              <td>Playback delay</td>
              <td>${clock.playbackDelayMs != null ? `${clock.playbackDelayMs.toFixed(1)} ms` : "—"}</td>
            </tr>
            <tr>
              <td>Derived position</td>
              <td>${clock.derivedPositionSamples != null ? clock.derivedPositionSamples.toFixed(0) : "—"}</td>
            </tr>
            <tr>
              <td>Control position</td>
              <td>${clock.controlPositionSamples != null ? clock.controlPositionSamples.toFixed(0) : "—"}</td>
            </tr>
            <tr><th colspan="2">Transport</th></tr>
            <tr>
              <td>Playing</td>
              <td>${t.playing ? "yes" : "no"}</td>
            </tr>
            <tr>
              <td>Recording</td>
              <td>${t.recording ? "yes" : "no"}</td>
            </tr>
            <tr>
              <td>WS status</td>
              <td>${t.wsStatus}</td>
            </tr>
            ${t.lastStopDelay ? html`
              <tr><th colspan="2">Last record-stop delay</th></tr>
              <tr><td>Capture (mic + worklet)</td><td>${t.lastStopDelay.captureMs} ms</td></tr>
              <tr><td>Network (ingress one-way)</td><td>${t.lastStopDelay.networkMs} ms</td></tr>
              <tr><td>Backend (IPC + cycle + write)</td><td>${t.lastStopDelay.backendMs} ms</td></tr>
              <tr><td>Jitter cushion</td><td>${t.lastStopDelay.safetyMs} ms</td></tr>
              <tr><td><strong>Total</strong></td><td><strong>${t.lastStopDelay.totalMs} ms</strong></td></tr>
            ` : null}
            ${t.empiricalIngress ? html`
              <tr><th colspan="2">Audio capture compensation (empirical round-trip)</th></tr>
              <tr><td>Stream id</td><td>${t.empiricalIngress.streamId}</td></tr>
              <tr><td>Median (browser ↔ server)</td><td>
                ${t.empiricalIngress.medianMs != null
                  ? html`<strong>${t.empiricalIngress.medianMs.toFixed(1)} ms</strong>`
                  : "converging…"}
              </td></tr>
              <tr><td>Capture-offset lock</td><td>${t.recording
                ? html`<strong style="color:var(--color-warn)">engaged</strong> (frozen for the take)`
                : "released"}</td></tr>
              <tr><td colspan="2" style="font-size:10px;color:var(--color-text-muted)">
                Browser stamps each ingress packet with the source-clock ns of what's coming out of the speakers; server subtracts from its own monotonic clock. Shim adds its own ring-prime + engine cycle on top before writing to the port.
              </td></tr>
            ` : null}
            ${(t.empiricalMidi?.length || 0) > 0 ? html`
              <tr><th colspan="2">MIDI capture compensation (per track, empirical)</th></tr>
              ${t.empiricalMidi.map(([trackId, info]) => html`
                <tr>
                  <td>${trackId}</td>
                  <td><strong>${info.medianMs.toFixed(1)} ms</strong> → ${info.samples} samples</td>
                </tr>
              `)}
              <tr><td colspan="2" style="font-size:10px;color:var(--color-text-muted)">
                Each browser-armed MIDI track has its own virtual ingress port (foyer-midi-ingress-&lt;track_id&gt;) with capture latency driven from the same echo round-trip.
              </td></tr>
            ` : null}
            <tr><th colspan="2">Bench: injected fake latency</th></tr>
            <tr>
              <td>Ingress (audio)</td>
              <td>
                <input type="number" min="0" max="2000" step="10"
                       .value=${String(this._fakeIngressInput ?? 0)}
                       @change=${(e) => this._setFakeLatency("ingress", e.target.value)}
                       style="width:80px"> ms
              </td>
            </tr>
            <tr>
              <td>Egress (audio)</td>
              <td>
                <input type="number" min="0" max="2000" step="10"
                       .value=${String(this._fakeEgressInput ?? 0)}
                       @change=${(e) => this._setFakeLatency("egress", e.target.value)}
                       style="width:80px"> ms
              </td>
            </tr>
            <tr><td colspan="2" style="font-size:10px;color:var(--color-text-muted)">
              Adds an artificial tokio sleep on the respective WS path before forwarding. Useful for bench-testing capture-offset behaviour against asymmetric latency. 0 disables.
            </td></tr>
          </tbody>
        </table>

        ${sentinelHistory.length > 0 ? html`
          <table class="timing-table" style="margin-top: 12px;">
            <thead>
              <tr>
                <th>#</th>
                <th>Drift (ms)</th>
                <th>Server mono (ns ×1e-6)</th>
              </tr>
            </thead>
            <tbody>
              ${sentinelHistory.slice().reverse().map((s, i) => html`
                <tr>
                  <td>${sentinelHistory.length - i}</td>
                  <td class="timing-val ${s.driftMs > 300 ? "danger" : s.driftMs > 100 ? "warn" : "ok"}">
                    ${s.driftMs.toFixed(1)}
                  </td>
                  <td>${(s.serverMonoNs / 1e6).toFixed(1)}</td>
                </tr>
              `)}
            </tbody>
          </table>
        ` : html`<div class="banner">No sentinels received yet. Start Listen to generate timing data.</div>`}
      </div>
    `;
  }
}
customElements.define("foyer-diagnostics", DiagnosticsView);
