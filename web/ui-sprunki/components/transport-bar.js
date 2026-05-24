// Transport Bar — play/stop, BPM control, position display.
//
// Directly calls `window.__foyer.ws.controlSet(...)` for transport
// commands. Subscribes to store changes for live transport state.

import { LitElement, html } from "lit";
import { transportStyles } from "../styles.js";
import { DEFAULT_BPM } from "./sound-catalog.js";

export class TransportBar extends LitElement {
  static styles = transportStyles;

  static properties = {
    playing: { type: Boolean },
    bpm: { type: Number },
    position: { type: String },
  };

  constructor() {
    super();
    this.playing = false;
    this.bpm = DEFAULT_BPM;
    this.position = "1.1.1";
  }

  connectedCallback() {
    super.connectedCallback();
    this._onChange = () => this._readState();
    window.__foyer?.store?.addEventListener?.("change", this._onChange);
    window.__foyer?.store?.addEventListener?.("control", this._onChange);
    this._readState();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.__foyer?.store?.removeEventListener?.("change", this._onChange);
    window.__foyer?.store?.removeEventListener?.("control", this._onChange);
  }

  _readState() {
    const s = window.__foyer?.store;
    this.playing = !!Number(s?.get?.("transport.playing") || 0);
    this.bpm = Number(s?.get?.("transport.tempo") || DEFAULT_BPM);
    
    // Convert samples → bars.beats.sixteenths (rough)
    const samples = Number(s?.get?.("transport.position") || 0);
    const sr = 48000; // approximate — real conversion would use PPQN
    const tempo = this.bpm || DEFAULT_BPM;
    const beatsPerSecond = tempo / 60;
    const seconds = samples / sr;
    const totalBeats = seconds * beatsPerSecond;
    const bars = Math.floor(totalBeats / 4) + 1;
    const beats = Math.floor(totalBeats % 4) + 1;
    const sixths = Math.floor(((totalBeats % 4) - (beats - 1)) * 4) + 1;
    this.position = `${bars}.${beats}.${sixths}`;
  }

  _togglePlay() {
    window.__foyer?.ws?.controlSet?.("transport.playing", this.playing ? 0 : 1);
  }

  _stop() {
    window.__foyer?.ws?.controlSet?.("transport.playing", 0);
    // Seek to start
    window.__foyer?.ws?.controlSet?.("transport.position", 0);
  }

  _setBpm(delta) {
    const next = Math.max(40, Math.min(300, this.bpm + delta));
    window.__foyer?.ws?.controlSet?.("transport.tempo", next);
  }

  render() {
    return html`
      <button class="transport-btn stop" @click=${this._stop} title="Stop">⏹</button>
      <button
        class="transport-btn play ${this.playing ? 'playing' : ''}"
        @click=${this._togglePlay}
        title=${this.playing ? 'Pause' : 'Play'}
      >
        ${this.playing ? '⏸' : '▶'}
      </button>

      <div class="bpm-display">
        <span class="bpm-label">BPM</span>
        <span class="bpm-value">${this.bpm}</span>
        <div class="bpm-buttons">
          <button @click=${() => this._setBpm(1)}>▲</button>
          <button @click=${() => this._setBpm(-1)}>▼</button>
        </div>
      </div>

      <div class="position-display">${this.position}</div>
    `;
  }
}

customElements.define("sprunki-transport-bar", TransportBar);
