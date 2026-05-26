// Style picker — top-bar button that pops a combo of styles.
//
// Anatomy:
//   <sprunkadoo-style-picker>           ← inline button (sparkles icon)
//     [click] → popover combo box       ← portal'd menu just below
//       ↳ row per style:
//          [swatch] [Style label]  [bpm hint]
//     [pick] → emits `style-picked` { detail: { styleId } } to the app
//
// The button doubles as a visual indicator: when a style has been
// applied, the swatch fills with the style's color (the sparkles icon
// inherits its color via currentColor). The "currently applied"
// style is whatever the app shell pushes in on `activeStyleId`.
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
      padding: 6px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.12s, color 0.12s;
      box-sizing: border-box;
      color: rgba(255, 255, 255, 0.85);
    }
    .trigger:hover { background: rgba(255, 255, 255, 0.12); }
    .trigger:active { background: rgba(255, 255, 255, 0.22); }
    .trigger.has-style { color: var(--sc, #fff); }
    .trigger svg { width: 100%; height: 100%; display: block; }

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
        class="trigger ${active ? "has-style" : ""}"
        style=${active ? `--sc: ${active.color}` : ""}
        title=${active ? `Style: ${active.label}` : "Pick a style"}
        aria-expanded=${this._open ? "true" : "false"}
        @click=${this._toggle}
      >
        <!-- Heroicons v2 outline / SparklesIcon — "transform" / vibe -->
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="1.5"
             aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round"
                d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
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

/** Lightweight confirm modal used by the app shell when applying a
 *  style would clobber custom beats. Plain inline element so the app
 *  doesn't need a portal — Lit's z-index + position:fixed is enough.
 *
 *  Emits `confirm` (proceed) or `cancel` (bail). Caller renders this
 *  conditionally and removes it on either event. */
export class StyleConfirmModal extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(2px);
    }
    .card {
      background: #1a1d2e;
      color: #fff;
      border-radius: 12px;
      padding: 22px 24px;
      max-width: 380px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
      border: 1px solid rgba(255, 255, 255, 0.10);
    }
    h2 {
      margin: 0 0 8px;
      font: 800 18px/1.2 system-ui, sans-serif;
    }
    p {
      margin: 0 0 18px;
      font: 400 14px/1.4 system-ui, sans-serif;
      color: rgba(255, 255, 255, 0.78);
    }
    .swatch {
      display: inline-block;
      width: 12px;
      height: 12px;
      border-radius: 3px;
      background: var(--sc, #888);
      margin-right: 6px;
      vertical-align: middle;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.20);
    }
    .row {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
    }
    button {
      padding: 8px 14px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(255, 255, 255, 0.06);
      color: #fff;
      font: 700 13px/1 system-ui, sans-serif;
      cursor: pointer;
      transition: background 0.12s, transform 0.10s;
    }
    button:hover { background: rgba(255, 255, 255, 0.14); }
    button.primary {
      background: var(--sc, #4cbf56);
      border-color: transparent;
      color: #fff;
    }
    button.primary:hover { filter: brightness(1.1); }
  `;

  static properties = {
    style_: { type: Object },
  };

  _fire(type) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true }));
  }

  render() {
    const s = this.style_;
    if (!s) return "";
    return html`
      <div class="card" style="--sc: ${s.color}">
        <h2><span class="swatch"></span>Apply ${s.label}?</h2>
        <p>
          You've authored your own beats. Switching to
          <strong>${s.label}</strong> will replace every performer's
          loop with the new style. There's no undo.
        </p>
        <div class="row">
          <button @click=${() => this._fire("cancel")}>Keep my beats</button>
          <button class="primary" @click=${() => this._fire("confirm")}>
            Apply ${s.label}
          </button>
        </div>
      </div>
    `;
  }
}

customElements.define("sprunkadoo-style-confirm", StyleConfirmModal);
