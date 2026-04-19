// Slot-picker popover.
//
// A modal-ish overlay that shows a visual grid of viewport placements. The
// user hovers a cell, sees a live preview outline appear where the window
// would land, and clicks to commit. Fires `pick` with { slot: <slot-id> }
// and `close` when dismissed.
//
// This is the widget Rich asked for: "pops open a menu and prompts for a slot
// to put the window." Intended for ultrawide workflows where
// left-third/center-third/right-third slotting beats freehand drag every
// time.

import { LitElement, html, css } from "lit";

import { SLOT_PRESETS, slotBounds } from "./slots.js";

export class SlotPicker extends LitElement {
  static properties = {
    _hover: { state: true, type: String },
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
      min-width: 560px;
      z-index: 2;
      font-family: var(--font-sans);
      color: var(--color-text);
    }
    header {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 14px;
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
    .grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      grid-template-rows: repeat(3, 1fr);
      gap: 6px;
      aspect-ratio: 21 / 9;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: 6px;
    }
    .cell {
      position: relative;
      background: color-mix(in oklab, var(--color-surface-elevated) 40%, transparent);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      cursor: pointer;
      transition: all 0.1s ease;
    }
    .cell:hover,
    .cell[data-active=""] {
      border-color: var(--color-accent);
      background: color-mix(in oklab, var(--color-accent) 20%, transparent);
      color: var(--color-text);
      transform: translateY(-1px);
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
    }
    .chip:hover {
      border-color: var(--color-accent);
      color: var(--color-accent-3);
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
    const preview = this._hover
      ? slotBounds(this._hover, window.innerWidth, window.innerHeight, 24)
      : null;
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
        <div class="grid">
          ${SLOT_PRESETS.map((s) => this._renderCell(s))}
        </div>
        <div class="legend">
          ${SLOT_PRESETS.map(
            (s) => html`
              <button
                class="chip"
                @mouseenter=${() => (this._hover = s.id)}
                @mouseleave=${() => (this._hover = null)}
                @click=${() => this._pick(s.id)}
              >
                ${s.label}
              </button>
            `
          )}
        </div>
        <div class="footer">
          <span>Cancel: <span class="kbd">Esc</span></span>
          <span style="flex:1"></span>
          <span>Tip: sticky sizing — same view reopens in its last slot.</span>
        </div>
      </div>
    `;
  }

  _renderCell(slot) {
    const style = `grid-row:${slot.row} / span ${slot.rowSpan};grid-column:${slot.col} / span ${slot.colSpan}`;
    return html`
      <div
        class="cell"
        style=${style}
        ?data-active=${this._hover === slot.id}
        @mouseenter=${() => (this._hover = slot.id)}
        @mouseleave=${() => (this._hover = null)}
        @click=${() => this._pick(slot.id)}
      >
        ${slot.label}
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
