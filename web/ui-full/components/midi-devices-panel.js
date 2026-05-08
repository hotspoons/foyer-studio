// Per-client Web MIDI configuration panel.
//
// Listed devices come from `core/midi/web-midi.js` — the singleton
// service that owns `navigator.requestMIDIAccess()` and forwards
// transformed events to the WS. This panel is the user surface for:
//
//   * Enabling Web MIDI (the access prompt is opt-in; we don't ask
//     the browser until the user clicks the "Enable" button).
//   * Per-device toggle (enabled/disabled) and channel handling
//     (passthrough = ship the device's own channel, or force-remap
//     to a chosen 1..16 channel before send).
//   * Per-device transpose (-24..+24 semitones) and velocity curve
//     (linear / soft / hard).
//
// Routing of "which Ardour MIDI track receives the bytes" lives in
// the JACK graph the user wires up against the shim's "Foyer Web
// MIDI" port — that's session state, owned by Ardour. This panel
// only shapes what we send.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { getWebMidiService } from "foyer-core/midi/web-midi.js";

const VELOCITY_CURVES = [
  { id: "linear", label: "Linear" },
  { id: "soft",   label: "Soft" },
  { id: "hard",   label: "Hard" },
];

export class MidiDevicesPanel extends LitElement {
  static properties = {
    _devices: { state: true, type: Array },
    _granted: { state: true, type: Boolean },
    _unsupported: { state: true, type: Boolean },
    _localMonitor: { state: true, type: Boolean },
    _localMonitorState: { state: true, type: String },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%; height: 100%;
      color: var(--color-text);
      font-size: var(--font-size-sm, 13px);
    }
    .empty {
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 24px;
      gap: 12px;
      text-align: center;
      flex: 1 1 auto;
      color: var(--color-text-muted);
    }
    .empty p { margin: 0; max-width: 360px; line-height: 1.4; }
    button.primary {
      padding: 8px 16px;
      border-radius: var(--radius-sm, 4px);
      border: 1px solid var(--color-accent);
      background: var(--color-accent);
      color: var(--color-on-accent, #fff);
      cursor: pointer;
      font: inherit;
    }
    button.primary:hover { filter: brightness(1.1); }
    .devices {
      display: flex; flex-direction: column;
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 8px 12px;
      gap: 8px;
    }
    .device {
      display: flex; flex-direction: column;
      gap: 6px;
      padding: 10px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm, 4px);
      background: var(--color-surface-2, var(--color-surface));
    }
    .device.disabled { opacity: 0.55; }
    .device-head {
      display: flex; align-items: center; gap: 8px;
    }
    .device-name {
      flex: 1 1 auto;
      font-weight: 600;
    }
    .device-mfr {
      color: var(--color-text-muted);
      font-size: 11px;
    }
    .row {
      display: grid;
      grid-template-columns: 96px 1fr;
      gap: 8px;
      align-items: center;
    }
    label.toggle {
      display: inline-flex; align-items: center; gap: 6px;
      cursor: pointer;
    }
    select, input[type="number"] {
      background: var(--color-surface);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-xs, 3px);
      padding: 2px 6px;
      font: inherit;
    }
    input[type="number"] { width: 64px; }
    .controls {
      display: flex; flex-wrap: wrap; gap: 12px;
      margin-top: 4px;
    }
    .footer {
      padding: 8px 12px;
      border-top: 1px solid var(--color-border);
      display: flex; justify-content: space-between; align-items: center;
      color: var(--color-text-muted);
      font-size: 11px;
    }
    .pill {
      display: inline-flex; align-items: center;
      padding: 1px 6px;
      border-radius: 999px;
      font-size: 10px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      color: var(--color-text-muted);
    }
    .pill.live {
      color: var(--color-success, #2e8b57);
      border-color: currentColor;
    }
    .monitor-row {
      display: flex; gap: 10px; align-items: center;
      padding: 8px 12px;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface-2, var(--color-surface));
    }
    .monitor-row .title {
      flex: 1 1 auto;
      display: flex; flex-direction: column; gap: 2px;
    }
    .monitor-row .title small {
      color: var(--color-text-muted);
      font-size: 11px;
    }
    .banner {
      padding: 8px 12px;
      border-bottom: 1px solid var(--color-border);
      color: var(--color-text-muted);
      font-size: 12px;
      display: flex; gap: 10px; align-items: center;
    }
    .banner button.primary {
      flex: 0 0 auto;
      padding: 4px 10px;
      border-radius: var(--radius-sm, 4px);
      border: 1px solid var(--color-accent);
      background: var(--color-accent);
      color: var(--color-on-accent, #fff);
      cursor: pointer;
      font: inherit;
    }
  `;

  constructor() {
    super();
    this._svc = getWebMidiService();
    this._devices = [];
    this._granted = !!this._svc?.granted;
    this._unsupported = !!this._svc?.unsupported;
    this._localMonitor = !!this._svc?.localMonitor;
    this._localMonitorState = "";
    this._onChange = () => this._refresh();
  }

  connectedCallback() {
    super.connectedCallback();
    this._svc.addEventListener("change", this._onChange);
    this._refresh();
  }

  disconnectedCallback() {
    this._svc.removeEventListener("change", this._onChange);
    super.disconnectedCallback();
  }

  _refresh() {
    this._granted = this._svc.granted;
    this._unsupported = this._svc.unsupported;
    this._devices = this._svc.listDevices();
    this._localMonitor = !!this._svc.localMonitor;
  }

  async _toggleLocalMonitor(ev) {
    const next = !!ev.target.checked;
    const state = await this._svc.setLocalMonitor(next);
    this._localMonitor = next;
    this._localMonitorState = state || "";
    this.requestUpdate();
  }

  async _enable() {
    const ok = await this._svc.requestAccess();
    if (!ok && !this._svc.unsupported) {
      console.warn("[midi-devices-panel] Web MIDI permission denied or unavailable");
    }
    this._refresh();
  }

  _setDeviceField(id, key, value) {
    this._svc.setDeviceConfig(id, { [key]: value });
  }

  render() {
    return html`
      ${this._renderHeaderBanner()}
      ${this._renderMonitorRow()}
      <div class="devices">
        ${this._devices.map((d) => this._renderDevice(d))}
      </div>
      <div class="footer">
        <span>${this._devices.length} device${this._devices.length === 1 ? "" : "s"}</span>
        <span>Routing: connect <strong>Foyer Web MIDI</strong>
          to a track input in Ardour.</span>
      </div>`;
  }

  _renderHeaderBanner() {
    if (this._unsupported) {
      return html`
        <div class="banner">
          <span>Hardware MIDI isn't exposed in this browser.
          The on-screen keyboard still works — drag a track
          input from <strong>Foyer Web MIDI</strong> in Ardour.</span>
        </div>`;
    }
    if (!this._granted) {
      return html`
        <div class="banner">
          <span>Plug in a controller? Grant access to enumerate
          hardware MIDI inputs.</span>
          <button class="primary" @click=${this._enable}>
            ${icon("musical-note", 14)} Enable Web MIDI
          </button>
        </div>`;
    }
    return null;
  }

  _renderMonitorRow() {
    // Surface the local-monitor toggle + a hint about why it
    // matters. Per-client preference: nothing in this row crosses
    // the WS, so we don't gate on RBAC here.
    const stateNote = this._localMonitor && this._localMonitorState
      && this._localMonitorState !== "running" && this._localMonitorState !== "idle"
      ? html`<small style="color:var(--color-warning,#c09040)">
          Audio context: ${this._localMonitorState} — try clicking the
          on-screen keyboard once to start playback.
        </small>`
      : null;
    return html`
      <label class="monitor-row">
        <input type="checkbox"
          .checked=${this._localMonitor}
          @change=${(e) => this._toggleLocalMonitor(e)}>
        <span class="title">
          <span>Hear notes locally (low-latency monitor)</span>
          <small>
            While a track is armed, render every note you play in this
            browser using a built-in synth — bypasses the 200 ms+ engine
            round-trip. The backend mutes its own monitor for armed
            tracks so you don't hear yourself twice.
          </small>
          ${stateNote}
        </span>
      </label>`;
  }

  _renderDevice(d) {
    const cfg = d.config;
    const live = d.connection === "open" && cfg.enabled;
    return html`
      <div class="device ${cfg.enabled ? "" : "disabled"}">
        <div class="device-head">
          <span class="device-name">${d.name}</span>
          ${d.manufacturer
            ? html`<span class="device-mfr">${d.manufacturer}</span>`
            : null}
          <span class="pill ${live ? "live" : ""}">${live ? "live" : d.state}</span>
        </div>
        <label class="toggle">
          <input type="checkbox" .checked=${cfg.enabled}
            @change=${(e) => this._setDeviceField(d.id, "enabled", e.target.checked)}>
          Forward events from this device
        </label>
        <div class="controls">
          <div class="row">
            <span>Channel</span>
            <span>
              <label class="toggle" style="margin-right: 12px;">
                <input type="radio" name="ch-${d.id}"
                  .checked=${cfg.channelMode === "passthrough"}
                  @change=${() => this._setDeviceField(d.id, "channelMode", "passthrough")}>
                Pass-through
              </label>
              <label class="toggle">
                <input type="radio" name="ch-${d.id}"
                  .checked=${cfg.channelMode === "force"}
                  @change=${() => this._setDeviceField(d.id, "channelMode", "force")}>
                Force →
                <select .value=${String(cfg.forceChannel)}
                  ?disabled=${cfg.channelMode !== "force"}
                  @change=${(e) => this._setDeviceField(d.id, "forceChannel", Number(e.target.value))}>
                  ${Array.from({ length: 16 }, (_, i) => html`
                    <option value=${i} ?selected=${cfg.forceChannel === i}>${i + 1}</option>`)}
                </select>
              </label>
            </span>
          </div>
          <div class="row">
            <span>Transpose</span>
            <span>
              <input type="number" min="-24" max="24" step="1"
                .value=${String(cfg.transpose)}
                @change=${(e) => this._setDeviceField(d.id, "transpose", Number(e.target.value))}>
              semitones
            </span>
          </div>
          <div class="row">
            <span>Velocity</span>
            <select .value=${cfg.velocityCurve}
              @change=${(e) => this._setDeviceField(d.id, "velocityCurve", e.target.value)}>
              ${VELOCITY_CURVES.map((c) => html`
                <option value=${c.id} ?selected=${cfg.velocityCurve === c.id}>${c.label}</option>`)}
            </select>
          </div>
        </div>
      </div>`;
  }
}

customElements.define("foyer-midi-devices-panel", MidiDevicesPanel);
