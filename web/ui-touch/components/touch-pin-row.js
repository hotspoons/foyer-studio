// SPDX-License-Identifier: Apache-2.0
// Quick-access chip row for pinned panels. Hidden when the user
// has no pins. Lives above the active panel area so it's reachable
// without going back to the bottom nav.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";

import { getPins, panelById, setActivePanel, onPinsChange } from "../panels.js";

export class TouchPinRow extends LitElement {
  static properties = {
    activeId: { type: String },
    _pins: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      flex: 0 0 auto;
    }
    .row {
      display: flex; gap: 8px;
      overflow-x: auto;
      padding: 8px 12px;
      background: var(--color-bg);
      border-bottom: 1px solid var(--color-border);
      -webkit-overflow-scrolling: touch;
    }
    .row:empty { display: none; }
    button {
      display: flex; align-items: center; gap: 6px;
      flex: 0 0 auto;
      padding: 8px 14px;
      border-radius: 999px;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      min-height: 36px;
      transition: background 100ms, color 100ms;
    }
    button[aria-current="page"] {
      background: var(--color-accent, #60a5fa);
      color: white;
      border-color: var(--color-accent, #60a5fa);
    }
    button:active { transform: scale(0.96); }
  `;

  constructor() {
    super();
    this.activeId = "";
    this._pins = getPins();
    this._unsub = null;
  }
  connectedCallback() {
    super.connectedCallback();
    this._unsub = onPinsChange((pins) => { this._pins = pins; });
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
  }

  render() {
    if (!this._pins || this._pins.length === 0) {
      // `:empty` CSS hides this element entirely.
      return html`<div class="row"></div>`;
    }
    const items = this._pins.map((id) => panelById(id)).filter(Boolean);
    return html`
      <div class="row">
        ${items.map((p) => html`
          <button
            aria-current=${this.activeId === p.id ? "page" : "false"}
            @click=${() => setActivePanel(p.id)}>
            ${icon(p.icon, 16)}<span>${p.label}</span>
          </button>
        `)}
      </div>
    `;
  }
}

customElements.define("foyer-touch-pin-row", TouchPinRow);
