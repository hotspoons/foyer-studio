import { LitElement, html, css } from "lit";

import "./toggle.js";
import "./number-scrub.js";
import { ControlController } from "../store.js";
import { getTransportPref } from "../transport-settings.js";

export class TransportBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 8px 14px;
      background: linear-gradient(180deg, var(--color-surface-elevated), var(--color-surface));
      border-bottom: 1px solid var(--color-border);
      position: relative;
      z-index: 1200;
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
      <foyer-number
        label="Tempo"
        unit="BPM"
        .value=${tempo}
        .min=${20}
        .max=${300}
        .step=${1}
        .fineStep=${0.1}
        .coarseStep=${10}
        .precision=${1}
        .pxPerStep=${3}
        @input=${this._onTempo}
        @change=${this._onTempo}
      ></foyer-number>
      <span class="spacer"></span>
      <span class="meta">Foyer · M4 transport</span>
    `;
  }

  _set(id, v) {
    const ws = window.__foyer.ws;
    ws.controlSet(id, v ? 1 : 0);
    // Return-to-start-on-stop pref: when play is toggled off (v=false) and
    // the user wants the playhead reset, snap transport.position to 0.
    if (id === "transport.playing" && !v && getTransportPref("returnOnStop")) {
      ws.controlSet("transport.position", 0);
    }
  }
  _onTempo = (ev) => {
    const v = Number(ev.detail?.value);
    if (Number.isFinite(v)) window.__foyer.ws.controlSet("transport.tempo", v);
  };
}
customElements.define("foyer-transport-bar", TransportBar);
