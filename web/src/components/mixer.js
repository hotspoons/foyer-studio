// Mixer surface. Wraps a row of track strips with a density toolbar that
// lets the user flip between Wide / Normal / Compact / Narrow presets and
// choose whether strip widths scale with the container (Relative) or lock
// to a fixed pixel width (Absolute) that horizontally scrolls.
//
// Settings persist via mixer-density.js.

import { LitElement, html, css } from "lit";
import "./track-strip.js";
import { DENSITIES, loadMixerSettings, saveMixerSettings } from "../mixer-density.js";
import { scrollbarStyles } from "../shared-styles.js";

export class Mixer extends LitElement {
  static properties = {
    session: { type: Object },
    _density: { state: true, type: String },
    _widthMode: { state: true, type: String },
    _widthOverrides: { state: true, type: Object },
  };

  static styles = css`
    ${scrollbarStyles}
    :host { display: flex; flex: 1 1 auto; flex-direction: column; overflow: hidden; background: var(--color-surface); }
    .toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 14px;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text-muted);
      font-size: 11px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .toolbar .group {
      display: inline-flex;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }
    .toolbar .group button {
      background: transparent;
      border: 0;
      font: inherit; font-family: var(--font-sans);
      font-size: 10px; font-weight: 500;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      padding: 3px 8px;
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .toolbar .group button + button { border-left: 1px solid var(--color-border); }
    .toolbar .group button:hover { color: var(--color-text); background: var(--color-surface-elevated); }
    .toolbar .group button.active {
      color: #fff;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
    }
    .strips {
      flex: 1 1 auto;
      display: flex;
      align-items: stretch;
      overflow-x: auto;
      overflow-y: hidden;
    }
    .empty {
      padding: 24px;
      color: var(--color-text-muted);
    }
  `;

  constructor() {
    super();
    this.session = null;
    const s = loadMixerSettings();
    this._density = s.density;
    this._widthMode = s.widthMode;
    this._widthOverrides = s.widthOverrides || {};
  }

  _save() {
    saveMixerSettings({
      density: this._density,
      widthMode: this._widthMode,
      widthOverrides: this._widthOverrides,
    });
  }

  _setDensity(k) { this._density = k; this._save(); }
  _setMode(m)    { this._widthMode = m; this._save(); }

  _onChannelResize(ev) {
    const { trackId, width, final } = ev.detail || {};
    if (!trackId) return;
    // A zero width means "clear my override and follow the global setting."
    const next = { ...this._widthOverrides };
    if (!width) delete next[trackId];
    else next[trackId] = width;
    this._widthOverrides = next;
    if (final) this._save();
  }

  _resetAllOverrides() {
    this._widthOverrides = {};
    this._save();
  }

  render() {
    const tracks = this.session?.tracks ?? [];
    const density = DENSITIES[this._density] || DENSITIES.normal;
    return html`
      <div class="toolbar">
        <span>Density</span>
        <div class="group">
          ${Object.entries(DENSITIES).map(([k, v]) => html`
            <button class=${this._density === k ? "active" : ""}
                    @click=${() => this._setDensity(k)}>${v.label}</button>
          `)}
        </div>
        <span style="margin-left:10px">Width</span>
        <div class="group">
          <button class=${this._widthMode === "relative" ? "active" : ""}
                  @click=${() => this._setMode("relative")}>Relative</button>
          <button class=${this._widthMode === "absolute" ? "active" : ""}
                  @click=${() => this._setMode("absolute")}>Absolute</button>
        </div>
        <span style="flex:1"></span>
        ${Object.keys(this._widthOverrides).length
          ? html`<button
              @click=${this._resetAllOverrides}
              title="Clear every per-channel width override"
              style="background:transparent;border:1px solid var(--color-border);border-radius:var(--radius-sm);color:var(--color-text-muted);font-size:10px;padding:3px 8px;cursor:pointer;font-family:var(--font-sans);"
            >Reset widths</button>`
          : null}
        <span>${tracks.length} tracks · ${density.trackWidth}px</span>
      </div>
      ${tracks.length === 0
        ? html`<div class="empty">Waiting for session…</div>`
        : html`
          <div class="strips" @channel-resize=${(e) => this._onChannelResize(e)}>
            ${tracks.map(t => html`
              <foyer-track-strip
                .track=${t}
                .density=${density}
                .widthMode=${this._widthMode}
                .overrideWidth=${this._widthOverrides[t.id] || null}
              ></foyer-track-strip>
            `)}
          </div>
        `}
    `;
  }
}
customElements.define("foyer-mixer", Mixer);
