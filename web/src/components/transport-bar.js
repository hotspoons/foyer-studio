import { LitElement, html, css } from "lit";

import "./toggle.js";
import { ControlController } from "../store.js";

export class TransportBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 8px 14px;
      background: linear-gradient(180deg, var(--color-surface-elevated), var(--color-surface));
      border-bottom: 1px solid var(--color-border);
    }
    .tempo {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--color-text-muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .tempo input {
      width: 80px;
      background: var(--color-surface);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 4px 8px;
      font-family: var(--font-mono);
      font-size: 12px;
      text-align: right;
      transition: border-color 0.15s ease;
    }
    .tempo input:focus {
      outline: none;
      border-color: var(--color-accent);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-accent) 30%, transparent);
    }
    .spacer { flex: 1; }
    .meta {
      color: var(--color-text-muted);
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
  `;

  constructor() {
    super();
    this._playCtl = null;
    this._recCtl = null;
    this._loopCtl = null;
    this._tempoCtl = null;
  }

  connectedCallback() {
    super.connectedCallback();
    const store = window.__foyer.store;
    this._playCtl  = new ControlController(this, store, "transport.playing");
    this._recCtl   = new ControlController(this, store, "transport.recording");
    this._loopCtl  = new ControlController(this, store, "transport.looping");
    this._tempoCtl = new ControlController(this, store, "transport.tempo");
  }

  render() {
    const play = !!this._playCtl?.value;
    const rec  = !!this._recCtl?.value;
    const loop = !!this._loopCtl?.value;
    const tempo = Number(this._tempoCtl?.value ?? 120);

    return html`
      <foyer-toggle label="Play"   .on=${play}  @input=${(e) => this._set("transport.playing",   e.detail.value)}></foyer-toggle>
      <foyer-toggle tone="rec" label="Rec" .on=${rec} @input=${(e) => this._set("transport.recording", e.detail.value)}></foyer-toggle>
      <foyer-toggle label="Loop"   .on=${loop}  @input=${(e) => this._set("transport.looping",   e.detail.value)}></foyer-toggle>
      <div class="tempo">
        <span>Tempo</span>
        <input type="number" min="20" max="300" step="0.1"
               .value=${tempo.toFixed(1)}
               @change=${this._onTempo}>
        <span>BPM</span>
      </div>
      <span class="spacer"></span>
      <span class="meta">Foyer · M4 transport</span>
    `;
  }

  _set(id, v) {
    window.__foyer.ws.controlSet(id, v ? 1 : 0);
  }
  _onTempo(ev) {
    const v = Number(ev.currentTarget.value);
    if (Number.isFinite(v)) window.__foyer.ws.controlSet("transport.tempo", v);
  }
}
customElements.define("foyer-transport-bar", TransportBar);
