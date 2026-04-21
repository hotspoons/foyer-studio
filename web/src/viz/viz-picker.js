// Lightweight viz settings popover — a chip in the timeline toolbar
// that lets the user flip between waveform styles + palettes without
// leaving the editing surface. Saves through `viz-settings.js` which
// dispatches `foyer:viz-prefs-changed`; all mounted `<foyer-waveform-gl>`
// instances listen + redraw.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";
import {
  WAVEFORM_STYLES,
  WAVEFORM_PALETTES,
  MIDI_PALETTES,
  getVizPrefs,
  setVizPref,
} from "./viz-settings.js";

export class VizPicker extends LitElement {
  static properties = {
    _open: { state: true, type: Boolean },
    _prefs: { state: true, type: Object },
  };

  static styles = css`
    :host { position: relative; display: inline-flex; }
    button {
      font-family: var(--font-sans);
      font-size: 10px; font-weight: 600;
      letter-spacing: 0.05em;
      padding: 4px 8px;
      border-radius: 3px;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text-muted);
      cursor: pointer;
      transition: all 0.1s ease;
      display: inline-flex; align-items: center; gap: 4px;
    }
    button:hover { color: var(--color-text); border-color: var(--color-accent); }
    .popover {
      position: absolute;
      top: 110%;
      right: 0;
      min-width: 220px;
      z-index: 20;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-panel);
      padding: 10px;
      font-size: 11px;
      color: var(--color-text);
    }
    .row {
      display: flex; flex-direction: column; gap: 4px;
      margin-bottom: 10px;
    }
    .row:last-child { margin-bottom: 0; }
    .label {
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--color-text-muted);
    }
    .segs {
      display: flex;
      border: 1px solid var(--color-border);
      border-radius: 3px;
      overflow: hidden;
    }
    .seg {
      flex: 1;
      background: transparent;
      border: 0;
      padding: 3px 6px;
      font-size: 10px;
      color: var(--color-text-muted);
      cursor: pointer;
      text-transform: capitalize;
    }
    .seg + .seg { border-left: 1px solid var(--color-border); }
    .seg:hover { color: var(--color-text); background: var(--color-surface); }
    .seg.active {
      color: #fff;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
    }
    .swatches { display: flex; flex-wrap: wrap; gap: 6px; }
    .swatch {
      width: 26px; height: 20px;
      border-radius: 3px;
      border: 2px solid transparent;
      cursor: pointer;
      transition: border-color 0.1s ease;
    }
    .swatch.active { border-color: var(--color-text); }
    .slider-row {
      display: flex; align-items: center; gap: 6px;
    }
    .slider-row input[type=range] { flex: 1; }
    .num { font-family: var(--font-mono); font-size: 10px; color: var(--color-text-muted); min-width: 30px; text-align: right; }
  `;

  constructor() {
    super();
    this._open = false;
    this._prefs = getVizPrefs();
    this._refresh = () => { this._prefs = getVizPrefs(); };
    this._onDocClick = (e) => {
      if (!this._open) return;
      if (!this.renderRoot.contains(e.composedPath?.()[0] || e.target)) {
        this._open = false;
      }
    };
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("foyer:viz-prefs-changed", this._refresh);
    document.addEventListener("pointerdown", this._onDocClick);
  }
  disconnectedCallback() {
    window.removeEventListener("foyer:viz-prefs-changed", this._refresh);
    document.removeEventListener("pointerdown", this._onDocClick);
    super.disconnectedCallback();
  }

  _set(key, value) { setVizPref(key, value); }

  render() {
    return html`
      <button title="Waveform visualization settings"
              @click=${() => this._open = !this._open}>
        ${icon("sparkles", 12)}
        <span>Viz</span>
      </button>
      ${this._open ? html`
        <div class="popover">
          <div class="row">
            <div class="label">Style</div>
            <div class="segs">
              ${Object.entries(WAVEFORM_STYLES).map(([id, s]) => html`
                <button class="seg ${this._prefs.waveformStyle === id ? "active" : ""}"
                        @click=${() => this._set("waveformStyle", id)}>${s.label}</button>
              `)}
            </div>
          </div>
          <div class="row">
            <div class="label">Palette</div>
            <div class="swatches">
              ${Object.entries(WAVEFORM_PALETTES).map(([name, p]) => html`
                <div class="swatch ${this._prefs.palette === name ? "active" : ""}"
                     title=${name}
                     style="background:linear-gradient(135deg, ${p.fill}, ${p.edge})"
                     @click=${() => this._set("palette", name)}></div>
              `)}
            </div>
          </div>
          <div class="row">
            <div class="label">Glow</div>
            <div class="slider-row">
              <input type="range" min="0" max="1" step="0.05"
                     .value=${String(this._prefs.glow)}
                     @input=${(e) => this._set("glow", Number(e.currentTarget.value))}>
              <span class="num">${this._prefs.glow.toFixed(2)}</span>
            </div>
          </div>
          <div class="row">
            <div class="label">Clip threshold</div>
            <div class="slider-row">
              <input type="range" min="0.5" max="1" step="0.01"
                     .value=${String(this._prefs.clipThreshold)}
                     @input=${(e) => this._set("clipThreshold", Number(e.currentTarget.value))}>
              <span class="num">${this._prefs.clipThreshold.toFixed(2)}</span>
            </div>
          </div>

          <div class="row" style="border-top:1px solid var(--color-border);padding-top:10px;margin-top:4px">
            <div class="label">MIDI note color</div>
            <div class="swatches">
              ${Object.entries(MIDI_PALETTES).map(([name, p]) => {
                const fill = p.note || "linear-gradient(135deg, var(--color-accent), var(--color-accent-2))";
                return html`
                  <div class="swatch ${this._prefs.midiPalette === name ? "active" : ""}"
                       title=${p.label}
                       style=${p.note
                         ? `background:${fill}`
                         : `background-image:repeating-linear-gradient(45deg, var(--color-surface), var(--color-surface) 3px, var(--color-border) 3px, var(--color-border) 5px)`}
                       @click=${() => this._set("midiPalette", name)}></div>
                `;
              })}
            </div>
          </div>
          <div class="row">
            <div class="label">MIDI velocity shading</div>
            <div class="slider-row">
              <input type="range" min="0" max="1" step="0.05"
                     .value=${String(this._prefs.midiVelocityShading ?? 0.6)}
                     @input=${(e) => this._set("midiVelocityShading", Number(e.currentTarget.value))}>
              <span class="num">${(this._prefs.midiVelocityShading ?? 0.6).toFixed(2)}</span>
            </div>
          </div>
        </div>
      ` : null}
    `;
  }
}
customElements.define("foyer-viz-picker", VizPicker);
