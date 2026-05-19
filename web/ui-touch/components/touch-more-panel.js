// SPDX-License-Identifier: Apache-2.0
// "More" — the progressive-disclosure hub for everything that isn't
// one of the four pinned bottom-nav tabs. Organized by category,
// with a star button on every row to toggle pinning (pin → it
// surfaces in the pin row above the active panel + the spill slot
// on the bottom nav).
//
// Also surfaces the UI variant chooser so the user can swap back
// to the full desktop UI without leaving this variant.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import {
  listUiVariants,
  setUserVariantPreference,
  getUserVariantPreference,
} from "foyer-core/registry/ui-variants.js";

import {
  listPanels,
  CATEGORIES,
  setActivePanel,
  isPinned,
  togglePin,
  onPinsChange,
  getPins,
  panelById,
} from "../panels.js";

export class TouchMorePanel extends LitElement {
  static properties = {
    _pinsTick: { state: true, type: Number },
  };

  static styles = css`
    :host {
      display: block; height: 100%;
      overflow: auto;
      -webkit-overflow-scrolling: touch;
      padding: 16px;
      background: var(--color-surface);
    }
    h2 {
      margin: 0 0 8px 0;
      font-size: 13px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      font-weight: 600;
    }
    section { margin-bottom: 24px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 8px;
    }
    .card {
      display: flex; align-items: center; gap: 12px;
      padding: 14px;
      background: var(--color-surface);
      border-radius: 12px;
      min-height: 60px;
      cursor: pointer;
      border: 0;
      color: var(--color-text);
      text-align: left;
      font: inherit;
      transition: transform 80ms;
    }
    .card:active { transform: scale(0.98); }
    .card .label { flex: 1; font-weight: 600; font-size: 14px; }
    .card .star {
      width: 36px; height: 36px;
      display: flex; align-items: center; justify-content: center;
      border: 0; background: transparent;
      color: var(--color-text-muted);
      border-radius: 8px;
      cursor: pointer;
      font-size: 22px;
      user-select: none;
    }
    .card .star.on {
      color: var(--color-warning, #f59e0b);
    }
    .card .star:active { transform: scale(0.9); }
    .pinned-chips {
      display: flex; flex-wrap: wrap; gap: 8px;
      margin-bottom: 16px;
    }
    .pinned-chips .chip {
      display: flex; align-items: center; gap: 6px;
      padding: 8px 14px;
      border-radius: 999px;
      background: var(--color-accent, #60a5fa);
      color: white;
      border: 0;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .variant-row {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px;
      padding: 14px;
      background: var(--color-surface);
      border-radius: 12px;
      margin-bottom: 8px;
    }
    .variant-row label { font-weight: 600; }
    select {
      padding: 10px 14px;
      border-radius: 10px;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text);
      font-size: 14px;
      min-height: 44px;
    }
  `;

  constructor() {
    super();
    this._pinsTick = 0;
    this._unsubPins = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._unsubPins = onPinsChange(() => { this._pinsTick++; });
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubPins?.();
  }

  _activate(panel) {
    if (panel.kind === "modal") {
      globalThis.dispatchEvent(new CustomEvent("foyer-touch:open-modal", { detail: { id: panel.id } }));
    } else {
      setActivePanel(panel.id);
    }
  }

  _renderCategory(cat) {
    const panels = listPanels().filter((p) => p.category === cat.id && p.kind !== "tab");
    if (panels.length === 0) return null;
    return html`
      <section>
        <h2>${cat.label}</h2>
        <div class="grid">
          ${panels.map((p) => html`
            <button class="card" @click=${() => this._activate(p)}>
              <span style="display:flex; width:28px; height:28px; align-items:center; justify-content:center">
                ${icon(p.icon, 22)}
              </span>
              <span class="label">${p.label}</span>
              ${p.kind === "panel" ? html`
                <span class="star ${isPinned(p.id) ? "on" : ""}"
                      role="button" tabindex="0"
                      title=${isPinned(p.id) ? "Unpin" : "Pin for quick access"}
                      @click=${(e) => { e.stopPropagation(); togglePin(p.id); }}
                      @keydown=${(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.stopPropagation(); e.preventDefault(); togglePin(p.id);
                        }
                      }}>${isPinned(p.id) ? "★" : "☆"}</span>
              ` : null}
            </button>
          `)}
        </div>
      </section>
    `;
  }

  _renderPinnedChips() {
    const pins = getPins();
    if (pins.length === 0) return null;
    return html`
      <section>
        <h2>Pinned</h2>
        <div class="pinned-chips">
          ${pins.map((id) => panelById(id)).filter(Boolean).map((p) => html`
            <button class="chip" @click=${() => this._activate(p)}>
              ${icon(p.icon, 14)}<span>${p.label}</span>
            </button>
          `)}
        </div>
      </section>
    `;
  }

  _renderVariantChooser() {
    const variants = listUiVariants();
    if (variants.length <= 1) return null;
    const current = getUserVariantPreference() || "touch";
    return html`
      <section>
        <h2>UI Variant</h2>
        <div class="variant-row">
          <label>Active variant</label>
          <select @change=${(e) => {
            const id = e.currentTarget.value;
            setUserVariantPreference(id);
            // Re-mount via core's variant runtime if possible; otherwise
            // a reload is the simplest reliable swap.
            if (window.__foyer?.mountVariant) {
              window.__foyer.mountVariant({ id });
            } else {
              globalThis.location.reload();
            }
          }}>
            ${variants.map((v) => html`
              <option value=${v.id} ?selected=${v.id === current}>${v.label}</option>
            `)}
          </select>
        </div>
        <p style="font-size: 12px; color: var(--color-text-muted); margin: 4px 4px 0; line-height: 1.5">
          Pick <strong>Foyer Full</strong> for the full desktop UI with
          tiles + floating windows. Touch stays selected on this device
          until you change it again.
        </p>
      </section>
    `;
  }

  render() {
    return html`
      ${this._renderPinnedChips()}
      ${CATEGORIES.map((c) => this._renderCategory(c))}
      ${this._renderVariantChooser()}
    `;
  }
}

customElements.define("foyer-touch-more-panel", TouchMorePanel);
