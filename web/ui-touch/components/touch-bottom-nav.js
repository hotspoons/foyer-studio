// SPDX-License-Identifier: Apache-2.0
// Bottom navigation tab bar. Four fixed slots (Mixer / Timeline /
// Tracks / More) + up to one pinned-panel slot squeezed between
// Tracks and More when the user has pins. Wider pin shelves spill
// into the More screen instead.
//
// Tapping a slot routes via the panels module (hash-driven).

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";

import {
  listPanels,
  panelById,
  setActivePanel,
  getPins,
  onPinsChange,
} from "../panels.js";

const PRIMARY_TABS = ["mixer", "timeline", "tracks", "more"];

export class TouchBottomNav extends LitElement {
  static properties = {
    activeId: { type: String },
    _pins: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      flex: 0 0 auto;
      background: var(--color-surface, #1a2333);
      border-top: 1px solid var(--color-border, #2a3548);
      padding-bottom: env(safe-area-inset-bottom, 0);
    }
    nav {
      display: flex;
      flex-direction: row;
      align-items: stretch;
    }
    button {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      background: transparent;
      border: 0;
      color: var(--color-text-muted, #94a3b8);
      padding: 10px 4px;
      cursor: pointer;
      min-height: 64px;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.02em;
      transition: color 120ms, background 120ms;
    }
    button[aria-current="page"] {
      color: var(--color-accent, #60a5fa);
      background: rgba(96, 165, 250, 0.06);
    }
    button:active {
      transform: scale(0.96);
    }
    button .icon-wrap {
      display: flex; align-items: center; justify-content: center;
      width: 28px; height: 28px;
    }
    button .label {
      line-height: 1;
    }
  `;

  constructor() {
    super();
    this.activeId = "mixer";
    this._pins = getPins();
    this._unsubPins = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._unsubPins = onPinsChange((pins) => { this._pins = pins; });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubPins?.();
  }

  render() {
    // Cap the visible pin in the bottom bar at 1 — more than that
    // crowds the row and undermines "core nav is always in the
    // same place." The rest of the user's pins surface in the More
    // panel and in the dedicated pin row above the active panel.
    const extraPin = this._pins
      .map((id) => panelById(id))
      .filter(Boolean)
      .slice(0, 1);
    const tabs = [
      ...PRIMARY_TABS.slice(0, 3).map((id) => panelById(id)),
      ...extraPin,
      panelById("more"),
    ].filter(Boolean);
    return html`
      <nav>
        ${tabs.map((tab) => html`
          <button
            aria-current=${this.activeId === tab.id ? "page" : "false"}
            title=${tab.label}
            @click=${() => setActivePanel(tab.id)}>
            <span class="icon-wrap">${icon(tab.icon, 22)}</span>
            <span class="label">${tab.label}</span>
          </button>
        `)}
      </nav>
    `;
  }
}

customElements.define("foyer-touch-bottom-nav", TouchBottomNav);
