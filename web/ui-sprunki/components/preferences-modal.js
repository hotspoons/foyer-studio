// Sprunki preferences modal — slimmed for the patch-based model.
//
// The v1 modal exposed per-category instrument + GM-program
// pickers; with patches now first-class, per-tile instrument
// override is a follow-up (the patch IS the picker). Today this
// modal just surfaces scary-mode + the "clear everything" reset.

import { LitElement, html, css } from "lit";
import { sprunkiStore, resetSprunkiStore } from "../state-store.js";

export class SprunkiPreferencesModal extends LitElement {
  static properties = {
    _rev: { type: Number, state: true },
  };
  static styles = css`
    :host {
      position: fixed; inset: 0;
      display: grid; place-items: center;
      background: rgba(8, 10, 16, 0.78);
      z-index: 9999;
      font-family: system-ui, sans-serif;
      color: #e5e8ee;
    }
    .panel {
      width: min(520px, 92vw);
      background: #161b22;
      border: 1px solid #2a3140;
      border-radius: 10px;
      padding: 18px 22px;
      box-shadow: 0 30px 80px rgba(0,0,0,0.5);
    }
    h2 { margin: 0 0 8px 0; font-size: 17px; }
    .row {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 0;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .row:last-child { border-bottom: 0; }
    .row-label { flex: 1; }
    button {
      background: #2a2e44; border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px; color: #eee; padding: 6px 14px;
      cursor: pointer; font-size: 13px;
    }
    button:hover { background: #353a55; }
    button.danger { background: #4a1d1d; border-color: #7a2a2a; }
    button.danger:hover { background: #6b2a2a; }
    .close {
      position: absolute; top: 12px; right: 12px;
      width: 32px; height: 32px; border-radius: 999px;
      background: rgba(255,255,255,0.08); color: #fff;
      font-size: 18px; border: none; cursor: pointer;
    }
    .small { font-size: 11px; color: rgba(255,255,255,0.55); }
  `;
  constructor() {
    super();
    this._store = sprunkiStore();
    this._rev = 0;
    this._listener = () => { this._rev++; this.requestUpdate(); };
  }
  connectedCallback() {
    super.connectedCallback();
    this._store.addEventListener("scary-mode-changed", this._listener);
    this._store.addEventListener("parental-changed", this._listener);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._store.removeEventListener("scary-mode-changed", this._listener);
    this._store.removeEventListener("parental-changed", this._listener);
  }

  _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }
  _onToggleScary() {
    if (this._store.scaryMode) {
      this._store.setScaryMode(false);
      return;
    }
    if (!this._store.parentalUnlocked) {
      this.dispatchEvent(new CustomEvent("request-parental-gate", {
        bubbles: true, composed: true,
      }));
      return;
    }
    this._store.setScaryMode(true);
  }
  _onClearAll() {
    if (!confirm("Clear ALL boards and reset the stage? This can't be undone.")) return;
    resetSprunkiStore();
    location.reload();
  }

  render() {
    const scary = this._store.scaryMode;
    return html`
      <div class="panel">
        <button class="close" @click=${this._close}>×</button>
        <h2>Preferences</h2>
        <div class="row">
          <div class="row-label">
            Scary mode
            <div class="small">Surfaces horror / "evil" sprunki content (parents only)</div>
          </div>
          <button @click=${this._onToggleScary}>${scary ? "Disable" : "Enable…"}</button>
        </div>
        <div class="row">
          <div class="row-label">
            Reset everything
            <div class="small">Wipes the stage, all section loops, and saved preferences</div>
          </div>
          <button class="danger" @click=${this._onClearAll}>Clear all</button>
        </div>
      </div>
    `;
  }
}

customElements.define("sprunki-preferences-modal", SprunkiPreferencesModal);
