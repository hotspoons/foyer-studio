// Style picker — top-bar button that pops a combo of styles.
//
// Anatomy:
//   <sprunkadoo-style-picker>           ← inline button (vinyl-record glyph)
//     [click] → popover combo box       ← portal'd menu just below
//       ↳ row per style:
//          [swatch] [Style label]  [bpm hint]
//     [pick] → emits `style-picked` { detail: { styleId } } to the app
//
// Glyph design: a black 7" 45-rpm record with a colored center
// label. The center swaps to the active style's color (or stays
// neutral when nothing is picked), so the button doubles as a
// visual indicator of which style is loaded. Reads as "music
// style/genre" instantly without leaning on AI/magic iconography.
//
// We DO NOT confirm here — that's the app shell's job, because only
// it knows whether the kid has authored beats. The picker is a pure
// selector; the parent decides whether the selection is destructive.

import { LitElement, html, css } from "lit";
import { STYLES, getStyle } from "../style-catalog.js";

export class StylePicker extends LitElement {
  static styles = css`
    :host {
      position: relative;
      display: inline-flex;
      align-items: center;
    }
    .trigger {
      width: 32px;
      height: 32px;
      padding: 4px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.12s, transform 0.18s;
      box-sizing: border-box;
    }
    .trigger:hover { background: rgba(255, 255, 255, 0.12); }
    .trigger:hover svg { animation: spin 1.4s linear infinite; }
    .trigger:active { background: rgba(255, 255, 255, 0.22); }
    .trigger svg {
      width: 100%; height: 100%; display: block;
      transform-origin: 50% 50%;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    /* Vinyl center label uses the active-style color so the
       button reads as "loaded" at a glance. Stays neutral when
       no style is picked. */
    .label-disc { fill: var(--sc, #888); }

    .menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 50;
      min-width: 200px;
      padding: 6px;
      background: rgba(18, 20, 32, 0.97);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .menu-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 6px;
      background: transparent;
      border: 0;
      color: #fff;
      cursor: pointer;
      text-align: left;
      font: 600 13px/1.1 system-ui, sans-serif;
      transition: background 0.12s;
    }
    .menu-row:hover { background: rgba(255, 255, 255, 0.08); }
    .menu-row.active { background: rgba(255, 255, 255, 0.14); }
    .swatch {
      width: 14px;
      height: 14px;
      border-radius: 4px;
      background: var(--sc, #888);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.20);
      flex: 0 0 14px;
    }
    .label { flex: 1; }
    .bpm {
      font-variant-numeric: tabular-nums;
      font-weight: 700;
      color: rgba(255, 255, 255, 0.55);
      font-size: 11px;
    }
  `;

  static properties = {
    /** Style id currently applied, or null. Drives the trigger tint
     *  + the active-row indicator in the popover. */
    activeStyleId: { type: String },
    _open: { type: Boolean, state: true },
  };

  constructor() {
    super();
    this.activeStyleId = null;
    this._open = false;
    this._onDocClick = (e) => {
      if (!this._open) return;
      if (!this.contains(e.target) && !this.shadowRoot?.contains(e.target)) {
        this._open = false;
      }
    };
  }
  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this._onDocClick, true);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("pointerdown", this._onDocClick, true);
  }

  _toggle = () => { this._open = !this._open; };
  _pick = (styleId) => {
    this._open = false;
    this.dispatchEvent(new CustomEvent("style-picked", {
      detail: { styleId },
      bubbles: true, composed: true,
    }));
  };

  render() {
    const active = this.activeStyleId ? getStyle(this.activeStyleId) : null;
    return html`
      <button
        type="button"
        class="trigger"
        style=${active ? `--sc: ${active.color}` : ""}
        title=${active ? `Style: ${active.label}` : "Pick a style"}
        aria-expanded=${this._open ? "true" : "false"}
        @click=${this._toggle}
      >
        <!-- 45-rpm vinyl record. Black disc with concentric grooves
             and a colored center label; the label fills with the
             active style's color via --sc so the button reads as
             "currently loaded". Hover-spin handled in CSS. -->
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <!-- Disc -->
          <circle cx="12" cy="12" r="11" fill="#0d0d0f" stroke="#000" stroke-width="0.6"/>
          <!-- Grooves -->
          <circle cx="12" cy="12" r="9.2" fill="none" stroke="#2a2a30" stroke-width="0.4"/>
          <circle cx="12" cy="12" r="7.8" fill="none" stroke="#2a2a30" stroke-width="0.4"/>
          <circle cx="12" cy="12" r="6.4" fill="none" stroke="#2a2a30" stroke-width="0.4"/>
          <!-- Light-glint highlight: a thin arc on the upper-left
               that gives the disc the "shiny vinyl" feel without
               needing a gradient (Lit's css block can't carry
               SVG <defs>). -->
          <path d="M5 8 A 8 8 0 0 1 11 4" fill="none" stroke="#3a3a44" stroke-width="0.6" stroke-linecap="round"/>
          <!-- Center label, painted in the active-style color -->
          <circle cx="12" cy="12" r="4.4" class="label-disc"
                  stroke="rgba(0,0,0,0.55)" stroke-width="0.5"/>
          <!-- Spindle hole -->
          <circle cx="12" cy="12" r="0.85" fill="#0d0d0f"/>
        </svg>
      </button>
      ${this._open ? html`
        <div class="menu" role="listbox" aria-label="Pick a style">
          ${STYLES.map((s) => html`
            <button
              type="button"
              role="option"
              class="menu-row ${s.id === this.activeStyleId ? "active" : ""}"
              style="--sc: ${s.color}"
              aria-selected=${s.id === this.activeStyleId ? "true" : "false"}
              @click=${() => this._pick(s.id)}
            >
              <span class="swatch"></span>
              <span class="label">${s.label}</span>
              <span class="bpm">${s.bpm} bpm</span>
            </button>
          `)}
        </div>
      ` : ""}
    `;
  }
}

customElements.define("sprunkadoo-style-picker", StylePicker);
