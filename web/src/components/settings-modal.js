// Client-side preferences modal. Covers the settings that live in
// localStorage — transport return-on-stop mode, waveform viz style +
// palette, mixer density (read-only here, flip from the mixer toolbar).
// DAW-side settings (buffer size, plugin paths, etc.) belong in a
// separate modal that round-trips through the shim; this one is
// intentionally client-only.
//
// Opened by the `settings.preferences` action in the main menu, or
// `Cmd+,` / `Ctrl+,`.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";
import { getTransportPref, setTransportPref } from "../transport-settings.js";
import { getReturnMode, setReturnMode, RETURN_MODES, RETURN_MODE_LABELS } from "../transport-return.js";
import {
  WAVEFORM_STYLES, WAVEFORM_PALETTES,
  getVizPref, setVizPref,
} from "../viz/viz-settings.js";
import { loadMixerSettings } from "../mixer-density.js";

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

  render() {
    const returnMode = getReturnMode();
    const wfStyle = getVizPref("waveformStyle");
    const wfPalette = getVizPref("palette");
    const glow = getVizPref("glow");
    const mixer = loadMixerSettings();
    return html`
      <div class="card" @click=${(e) => e.stopPropagation()}>
        <header>
          <h2>Preferences</h2>
          <button class="close" title="Close" @click=${this._close}>${icon("x-mark", 16)}</button>
        </header>
        <div class="body">
          <div class="section">
            <h3>Transport</h3>
            <div class="row">
              <label>Return-on-stop behavior</label>
              <div class="chip-row">
                ${RETURN_MODES.map((m) => html`
                  <button class="chip ${m === returnMode ? "active" : ""}"
                          @click=${() => { setReturnMode(m); this._refresh(); }}>
                    ${RETURN_MODE_LABELS[m]}
                  </button>
                `)}
              </div>
            </div>
          </div>
          <div class="section">
            <h3>Waveform visualization</h3>
            <div class="row">
              <label>Style</label>
              <div class="chip-row">
                ${Object.entries(WAVEFORM_STYLES).map(([id, s]) => html`
                  <button class="chip ${id === wfStyle ? "active" : ""}"
                          @click=${() => { setVizPref("waveformStyle", id); this._refresh(); }}>
                    ${s.label}
                  </button>
                `)}
              </div>
            </div>
            <div class="row">
              <label>Palette</label>
              <div class="chip-row">
                ${Object.entries(WAVEFORM_PALETTES).map(([id, p]) => html`
                  <button class="chip ${id === wfPalette ? "active" : ""}"
                          @click=${() => { setVizPref("palette", id); this._refresh(); }}>
                    ${p.label}
                  </button>
                `)}
              </div>
            </div>
          </div>
          <div class="section">
            <h3>Mixer</h3>
            <div class="row">
              <label>Current density · width</label>
              <span style="color:var(--color-text-muted);font-size:11px">${mixer.density} · ${mixer.widthMode}</span>
            </div>
            <div class="row">
              <label style="color:var(--color-text-muted);font-size:11px">Change in the mixer toolbar.</label>
            </div>
          </div>
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
