// Channel strip: color swatch · name · kind · plugin strip · M/S/R · fader + meter.

import { LitElement, html, css } from "lit";

import "./fader.js";
import "./toggle.js";
import "./meter.js";
import "./plugin-strip.js";
import { ControlController } from "../store.js";

function normToDb(n) {
  n = Math.max(0, Math.min(1, n));
  if (n <= 0.0001) return -60;
  if (n <= 0.75) return -60 + (n / 0.75) * 60;
  return (n - 0.75) / 0.25 * 6;
}
function dbToNorm(db) {
  if (db <= -60) return 0;
  if (db <= 0) return ((db + 60) / 60) * 0.75;
  return 0.75 + Math.min(6, db) / 6 * 0.25;
}

export class TrackStrip extends LitElement {
  static properties = {
    track: { type: Object },
    density: { type: Object },
    widthMode: { type: String },
    overrideWidth: { type: Number },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      padding: 8px 6px;
      gap: 6px;
      border-right: 1px solid var(--color-border);
      background: linear-gradient(180deg, var(--color-surface-elevated), var(--color-surface));
      transition: background 0.15s ease;
      min-width: 0;
      overflow: hidden;
      position: relative;
    }
    :host(:hover) {
      background: linear-gradient(180deg, var(--color-surface-muted), var(--color-surface-elevated));
    }
    .channel-resize {
      position: absolute;
      top: 0; bottom: 0; right: -3px;
      width: 6px;
      cursor: ew-resize;
      z-index: 5;
      transition: background 0.12s ease;
    }
    .channel-resize:hover,
    :host([resizing]) .channel-resize {
      background: color-mix(in oklab, var(--color-accent) 45%, transparent);
    }
    .name {
      font-family: var(--font-sans);
      font-weight: 600;
      text-align: center;
      color: var(--color-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .kind {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--color-text-muted);
      text-align: center;
    }
    .row {
      display: flex;
      gap: 4px;
      justify-content: center;
      flex-wrap: wrap;
    }
    .body { display: flex; gap: 6px; align-items: flex-end; justify-content: center; flex: 1 1 auto; min-height: 0; }
    .swatch {
      height: 3px;
      border-radius: 2px;
      margin: 0 2px;
      background: var(--color-accent);
    }
    foyer-plugin-strip { flex: 0 0 auto; }
  `;

  constructor() {
    super();
    this.track = null;
    this.density = null;
    this.widthMode = "relative";
    this.overrideWidth = null;
    this._gainCtl = null;
    this._muteCtl = null;
    this._soloCtl = null;
    this._recCtl = null;
    this._meterCtl = null;
  }

  willUpdate(changed) {
    if (changed.has("track") && this.track) {
      const store = window.__foyer.store;
      this._gainCtl = new ControlController(this, store, this.track.gain?.id);
      this._muteCtl = new ControlController(this, store, this.track.mute?.id);
      this._soloCtl = new ControlController(this, store, this.track.solo?.id);
      if (this.track.record_arm?.id) {
        this._recCtl = new ControlController(this, store, this.track.record_arm.id);
      }
      if (this.track.peak_meter) {
        this._meterCtl = new ControlController(this, store, this.track.peak_meter);
      }
    }
    // Apply width via inline styles so the mixer's layout mode can drive us.
    if (changed.has("density") || changed.has("widthMode") || changed.has("overrideWidth")) {
      this._applyWidth();
    }
  }

  _applyWidth() {
    const d = this.density || { trackWidth: 96 };
    // Per-channel override always wins — if the user has explicitly sized
    // this strip, we honor that regardless of the mixer's global width mode.
    if (this.overrideWidth) {
      this.style.flex = "0 0 auto";
      this.style.width = `${this.overrideWidth}px`;
      this.style.minWidth = `${this.overrideWidth}px`;
      return;
    }
    if (this.widthMode === "absolute") {
      this.style.flex = "0 0 auto";
      this.style.width = `${d.trackWidth}px`;
      this.style.minWidth = `${d.trackWidth}px`;
    } else {
      this.style.flex = "1 1 0";
      this.style.width = "auto";
      this.style.minWidth = `${Math.max(32, Math.floor(d.trackWidth * 0.8))}px`;
    }
  }

  render() {
    if (!this.track) return html``;
    const d = this.density || {
      trackWidth: 96, plugins: true, pluginsLines: 3, meterWidth: 8,
      showKind: true, showColorBar: true, labelSize: 11,
    };
    const t = this.track;
    const gainDb = Number(this._gainCtl?.value ?? t.gain?.value ?? 0);
    const gainNorm = dbToNorm(gainDb);
    const gainLabel = `${gainDb.toFixed(1)} dB`;

    const mute = !!(this._muteCtl?.value ?? t.mute?.value);
    const solo = !!(this._soloCtl?.value ?? t.solo?.value);
    const rec  = !!(this._recCtl?.value  ?? t.record_arm?.value);
    const meterDb = Number(this._meterCtl?.value ?? -60);

    const swatchStyle = t.color
      ? `background:${t.color}`
      : `background:linear-gradient(90deg, var(--color-accent), var(--color-accent-2))`;
    const nameStyle = `font-size:${d.labelSize}px`;

    return html`
      ${d.showColorBar ? html`<div class="swatch" style=${swatchStyle}></div>` : null}
      <div class="name" style=${nameStyle} title=${t.name}>${t.name}</div>
      ${d.showKind ? html`<div class="kind">${t.kind}</div>` : null}
      ${d.plugins ? html`
        <foyer-plugin-strip
          .plugins=${t.plugins || []}
          .maxLines=${d.pluginsLines}
        ></foyer-plugin-strip>
      ` : null}
      <div class="row">
        <foyer-toggle tone="mute" label="M" .on=${mute} @input=${(e) => this._setBool(t.mute?.id, e.detail.value)}></foyer-toggle>
        <foyer-toggle tone="solo" label="S" .on=${solo} @input=${(e) => this._setBool(t.solo?.id, e.detail.value)}></foyer-toggle>
        ${t.record_arm ? html`
          <foyer-toggle tone="rec" label="●" .on=${rec} @input=${(e) => this._setBool(t.record_arm.id, e.detail.value)}></foyer-toggle>
        ` : null}
      </div>
      <div class="body">
        <foyer-fader
          .value=${gainNorm}
          .label=${gainLabel}
          @input=${(e) => this._setGain(e.detail.value)}
          @reset=${() => this._setGain(dbToNorm(0))}
        ></foyer-fader>
        <foyer-meter .value=${meterDb} height="140"></foyer-meter>
      </div>
      <div class="channel-resize"
           title="Drag to resize this channel · double-click to clear override"
           @pointerdown=${(e) => this._startChannelResize(e)}
           @dblclick=${() => this._clearChannelOverride()}></div>
    `;
  }

  _startChannelResize(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startW = this.getBoundingClientRect().width;
    this.setAttribute("resizing", "");
    const minW = 28;
    const maxW = 360;
    const tick = (e) => {
      const w = Math.max(minW, Math.min(maxW, startW + (e.clientX - startX)));
      this.overrideWidth = w;
      this._applyWidth();
      this.dispatchEvent(new CustomEvent("channel-resize", {
        detail: { trackId: this.track?.id, width: Math.round(w), final: false },
        bubbles: true,
        composed: true,
      }));
    };
    const up = () => {
      window.removeEventListener("pointermove", tick);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      this.removeAttribute("resizing");
      this.dispatchEvent(new CustomEvent("channel-resize", {
        detail: { trackId: this.track?.id, width: Math.round(this.overrideWidth || 0), final: true },
        bubbles: true,
        composed: true,
      }));
    };
    window.addEventListener("pointermove", tick);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  _clearChannelOverride() {
    this.overrideWidth = null;
    this._applyWidth();
    this.dispatchEvent(new CustomEvent("channel-resize", {
      detail: { trackId: this.track?.id, width: 0, final: true },
      bubbles: true,
      composed: true,
    }));
  }

  _setGain(norm) {
    if (!this.track?.gain?.id) return;
    const db = normToDb(norm);
    window.__foyer.ws.controlSet(this.track.gain.id, db);
  }
  _setBool(id, v) {
    if (!id) return;
    window.__foyer.ws.controlSet(id, v ? 1 : 0);
  }
}
customElements.define("foyer-track-strip", TrackStrip);
