// Per-track vertical plugin insert strip.
//
// Each row shows an insert with its name and a bypass toggle. Clicking the
// name opens the generated plugin panel in a floating window (sticky-slotted
// per the user's last choice). Right-click or the menu affordance prompts the
// slot picker. The bypass button sends `ControlSet` on the plugin's synthetic
// `.bypass` parameter so the authoritative state stays on the backend; the UI
// re-renders when the echo arrives.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";
import { openPluginFloat } from "../layout/plugin-layer.js";

export class PluginStrip extends LitElement {
  static properties = {
    plugins: { type: Array },
    maxLines: { type: Number },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 4px 3px;
      min-width: 0;
      border-top: 1px solid var(--color-border);
      border-bottom: 1px solid var(--color-border);
      background: color-mix(in oklab, var(--color-surface-muted) 30%, var(--color-surface));
    }
    .row {
      display: flex; align-items: center; gap: 3px;
      padding: 1px 3px;
      min-width: 0;
      height: 17px;
      border-radius: 3px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      font-family: var(--font-sans);
      font-size: 9px;
      color: var(--color-text);
      overflow: hidden;
      cursor: pointer;
      transition: all 0.1s ease;
    }
    .row:hover {
      border-color: var(--color-accent);
      color: var(--color-accent-3);
    }
    .row.bypassed { opacity: 0.45; }
    .row .name {
      flex: 1; min-width: 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      letter-spacing: 0.01em;
    }
    .row button {
      flex: 0 0 auto;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 2px;
      color: var(--color-text-muted);
      padding: 0 3px;
      font-size: 9px;
      cursor: pointer;
      display: inline-flex; align-items: center;
    }
    .row button.by { font-weight: 700; font-family: var(--font-mono); letter-spacing: 0.08em; }
    .row button:hover { color: var(--color-text); border-color: var(--color-border); }
    .row.bypassed button.by { color: var(--color-warning); }
    .slot {
      display: flex; align-items: center; justify-content: center;
      height: 13px;
      font-size: 10px;
      color: var(--color-text-muted);
      border: 1px dashed var(--color-border);
      border-radius: 3px;
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .slot:hover { color: var(--color-accent-3); border-color: var(--color-accent); }
    .empty { color: var(--color-text-muted); font-size: 9px; padding: 1px; text-align: center; font-style: italic; }
  `;

  constructor() {
    super();
    this.plugins = [];
    this.maxLines = 3;
  }

  render() {
    const plugs = this.plugins || [];
    const extra = Math.max(0, plugs.length - this.maxLines);
    const shown = plugs.slice(0, this.maxLines);
    return html`
      ${shown.map(
        (p) => html`
          <div
            class="row ${this._isBypassed(p) ? "bypassed" : ""}"
            title="Click to open ${p.name}"
            @click=${() => this._openPanel(p)}
            @contextmenu=${(ev) => this._onContextMenu(ev, p)}
          >
            <span class="name">${p.name}</span>
            <button
              class="by"
              title=${this._isBypassed(p) ? "Enable" : "Bypass"}
              @click=${(ev) => this._toggleBypass(ev, p)}
            >
              by
            </button>
          </div>
        `
      )}
      ${extra > 0 ? html`<div class="empty">+${extra} more</div>` : null}
      <div class="slot" @click=${this._addSlot} title="Open plugin picker">
        ${icon("plus", 10)}
      </div>
    `;
  }

  _isBypassed(p) {
    const bypassParam = (p.params || []).find((x) => x.id.endsWith(".bypass"));
    if (bypassParam) {
      const store = window.__foyer?.store;
      const live = store?.get(bypassParam.id);
      if (live !== undefined) return live === true || live === 1 || live?.Bool === true;
      if (typeof bypassParam.value === "boolean") return bypassParam.value;
    }
    return !!p.bypassed;
  }

  _toggleBypass(ev, p) {
    ev.stopPropagation();
    const bypassParam = (p.params || []).find((x) => x.id.endsWith(".bypass"));
    const ws = window.__foyer?.ws;
    const on = !this._isBypassed(p);
    if (bypassParam && ws) {
      ws.controlSet(bypassParam.id, on);
    } else {
      // Legacy path: no bypass param on this plugin instance. Flip local state
      // so the gesture still registers; backend will catch up once params are
      // wired.
      p.bypassed = on;
      this.requestUpdate();
    }
    this.dispatchEvent(
      new CustomEvent("bypass", {
        detail: { plugin: p, bypassed: on },
        bubbles: true,
        composed: true,
      })
    );
  }

  _openPanel(p) {
    // Plugin windows live on their own auto-layout layer — they are NOT
    // floating-tiles. See docs/DECISIONS.md #12.
    openPluginFloat(p);
  }

  _onContextMenu(ev, p) {
    ev.preventDefault();
    // Right-click still just opens (no slot picker — plugin layer doesn't
    // use slots). Future: show close/minimize/hide-all in a context menu
    // when the plugin is already open.
    openPluginFloat(p);
  }

  _addSlot() {
    location.hash = "plugins";
  }
}
customElements.define("foyer-plugin-strip", PluginStrip);
