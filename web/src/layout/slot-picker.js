// Slot-picker popover.
//
// Visual grid of viewport placements. Slots overlap geometrically (a quadrant
// and the half it lives inside both want the same pixels), so we segment them
// into non-overlapping tabs — Halves, Thirds, Quadrants, Misc — and render
// only the current tab's slots in the grid. Every slot is always reachable as
// a chip at the bottom too, so power users who know what they want can click
// directly.
//
// Fires `pick` with { slot: <slot-id> } and `close` when dismissed.

import { LitElement, html, css } from "lit";

import { SLOT_PRESETS, SLOT_SHORTCUTS, slotBounds } from "./slots.js";

const TABS = [
  {
    id: "halves",
    label: "Halves",
    slots: ["left-half", "right-half", "top-half", "bottom-half"],
  },
  {
    id: "thirds",
    label: "Thirds",
    slots: ["left-third", "center-third", "right-third", "left-two-thirds", "right-two-thirds"],
  },
  {
    id: "quadrants",
    label: "Quadrants",
    slots: ["tl", "tr", "bl", "br"],
  },
  {
    id: "misc",
    label: "Misc",
    slots: ["full", "center"],
  },
];

function presetById(id) {
  return SLOT_PRESETS.find((p) => p.id === id) || null;
}

export class SlotPicker extends LitElement {
  static properties = {
    _hover: { state: true, type: String },
    _tab: { state: true, type: String },
  };

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 1100;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: auto;
    }
    .scrim {
      position: absolute;
      inset: 0;
      background: rgba(2, 6, 23, 0.55);
      backdrop-filter: blur(3px);
    }
    .preview {
      position: absolute;
      pointer-events: none;
      border: 2px dashed color-mix(in oklab, var(--color-accent) 60%, transparent);
      background: color-mix(in oklab, var(--color-accent) 10%, transparent);
      border-radius: var(--radius-md);
      transition: all 0.12s ease;
    }
    .panel {
      position: relative;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg, 10px);
      box-shadow: var(--shadow-panel);
      padding: 18px 22px;
      min-width: 620px;
      z-index: 2;
      font-family: var(--font-sans);
      color: var(--color-text);
    }
    header {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 10px;
    }
    h2 {
      margin: 0;
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--color-accent-3);
    }
    .hint {
      font-size: 10px;
      color: var(--color-text-muted);
    }
    .tabs {
      display: flex;
      gap: 2px;
      margin-bottom: 10px;
      border-bottom: 1px solid var(--color-border);
    }
    .tab {
      background: transparent;
      border: 0;
      border-bottom: 2px solid transparent;
      color: var(--color-text-muted);
      padding: 6px 12px;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.06em;
      cursor: pointer;
      transition: color 0.1s ease;
      font-family: var(--font-sans);
    }
    .tab:hover { color: var(--color-text); }
    .tab.active {
      color: var(--color-text);
      border-bottom-color: var(--color-accent);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      grid-template-rows: repeat(2, 1fr);
      gap: 8px;
      aspect-ratio: 21 / 9;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: 8px;
    }
    .grid.grid-halves {
      grid-template-columns: repeat(2, 1fr);
      grid-template-rows: repeat(2, 1fr);
    }
    .grid.grid-thirds {
      grid-template-columns: repeat(3, 1fr);
      grid-template-rows: 1fr;
    }
    .grid.grid-quadrants {
      grid-template-columns: repeat(2, 1fr);
      grid-template-rows: repeat(2, 1fr);
    }
    .grid.grid-misc {
      grid-template-columns: repeat(2, 1fr);
      grid-template-rows: 1fr;
    }
    .cell {
      position: relative;
      background: color-mix(in oklab, var(--color-surface-elevated) 40%, transparent);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      cursor: pointer;
      transition: all 0.1s ease;
      min-height: 0;
    }
    .cell:hover,
    .cell[data-active=""] {
      border-color: var(--color-accent);
      background: color-mix(in oklab, var(--color-accent) 22%, transparent);
      color: #fff;
      transform: translateY(-1px);
    }
    .cell .shortcut {
      font-family: var(--font-mono);
      font-size: 9px;
      color: color-mix(in oklab, var(--color-accent-3) 80%, var(--color-text-muted));
      letter-spacing: 0.04em;
      text-transform: none;
    }
    .cell:hover .shortcut,
    .cell[data-active=""] .shortcut {
      color: rgba(255, 255, 255, 0.9);
    }
    .legend {
      margin-top: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .chip {
      padding: 4px 8px;
      font-size: 10px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      color: var(--color-text);
      cursor: pointer;
      transition: all 0.12s ease;
      font-family: var(--font-sans);
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .chip:hover {
      border-color: var(--color-accent);
      color: var(--color-accent-3);
    }
    .chip .shortcut {
      font-family: var(--font-mono);
      font-size: 9px;
      color: var(--color-text-muted);
      padding: 1px 4px;
      border: 1px solid color-mix(in oklab, var(--color-border) 70%, transparent);
      border-radius: 3px;
    }
    .footer {
      margin-top: 10px;
      display: flex;
      gap: 10px;
      font-size: 10px;
      color: var(--color-text-muted);
    }
    .kbd {
      font-family: var(--font-mono);
      font-size: 9px;
      padding: 2px 6px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 3px;
    }
  `;

  constructor() {
    super();
    this._hover = null;
    this._tab = "halves";
    this._onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        this._close();
      }
    };
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this._onKey);
  }
  disconnectedCallback() {
    window.removeEventListener("keydown", this._onKey);
    super.disconnectedCallback();
  }

  render() {
    const preview = this._hover ? slotBounds(this._hover) : null;
    const tab = TABS.find((t) => t.id === this._tab) || TABS[0];
    return html`
      <div class="scrim" @click=${this._close}></div>
      ${preview
        ? html`<div
            class="preview"
            style="left:${preview.x}px;top:${preview.y}px;width:${preview.w}px;height:${preview.h}px"
          ></div>`
        : null}
      <div class="panel">
        <header>
          <h2>Place Window</h2>
          <span class="hint">Hover to preview · click to commit</span>
        </header>
        <div class="tabs">
          ${TABS.map(
            (t) => html`
              <button
                class="tab ${t.id === this._tab ? "active" : ""}"
                @click=${() => { this._tab = t.id; this._hover = null; }}
              >${t.label}</button>
            `
          )}
        </div>
        <div class="grid grid-${tab.id}">
          ${tab.slots.map((id) => this._renderCell(id))}
        </div>
        <div class="legend">
          ${SLOT_PRESETS.map((s) => {
            const chord = SLOT_SHORTCUTS[s.id];
            return html`
              <button
                class="chip"
                @mouseenter=${() => (this._hover = s.id)}
                @mouseleave=${() => (this._hover = null)}
                @click=${() => this._pick(s.id)}
              >
                <span>${s.label}</span>
                ${chord ? html`<span class="shortcut">${chord}</span>` : null}
              </button>
            `;
          })}
        </div>
        <div class="footer">
          <span>Cancel: <span class="kbd">Esc</span></span>
          <span style="flex:1"></span>
          <span>Tip: sticky sizing — same view reopens in its last slot.</span>
        </div>
      </div>
    `;
  }

  _renderCell(slotId) {
    const slot = presetById(slotId);
    if (!slot) return null;
    const chord = SLOT_SHORTCUTS[slotId];
    return html`
      <div
        class="cell"
        ?data-active=${this._hover === slotId}
        @mouseenter=${() => (this._hover = slotId)}
        @mouseleave=${() => (this._hover = null)}
        @click=${() => this._pick(slotId)}
      >
        <span>${slot.label}</span>
        ${chord ? html`<span class="shortcut">${chord}</span>` : null}
      </div>
    `;
  }

  _pick(slot) {
    this.dispatchEvent(
      new CustomEvent("pick", { detail: { slot }, bubbles: true, composed: true })
    );
  }

  _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }
}
customElements.define("foyer-slot-picker", SlotPicker);
