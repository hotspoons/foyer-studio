// Jail browser for Session → Save As: pick a parent folder and a new session
// folder name (no overwrite of existing entries; session dirs are not opened).

import { LitElement, html, css } from "lit";

import "./session-view.js";
import { icon } from "foyer-ui-core/icons.js";

export class SaveSessionAsModal extends LitElement {
  static properties = {
    _currentPath: { state: true, type: String },
    _entries:     { state: true, type: Array },
    _newName:     { state: true, type: String },
    _error:       { state: true, type: String },
  };

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 5400;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: auto;
      font-family: var(--font-sans);
      color: var(--color-text);
    }
    .scrim {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(3px);
    }
    .modal {
      position: relative;
      width: min(880px, 92vw);
      height: min(720px, 86vh);
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg, 10px);
      box-shadow: var(--shadow-panel);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--color-border);
      background: linear-gradient(180deg, var(--color-surface-muted), var(--color-surface-elevated));
    }
    header .title {
      flex: 1;
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-weight: 700;
      background: linear-gradient(135deg, var(--color-accent-3), var(--color-accent-2));
      -webkit-background-clip: text; background-clip: text;
      color: transparent;
    }
    header button {
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--color-text-muted);
      padding: 2px 6px;
      cursor: pointer;
    }
    header button:hover {
      color: var(--color-text);
      border-color: var(--color-border);
    }
    .body {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
    }
    foyer-session-view {
      flex: 1;
      min-height: 0;
    }
    .save-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-top: 1px solid var(--color-border);
      background: var(--color-surface);
    }
    .save-row .label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--color-text-muted);
    }
    .save-row .parent {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-accent-3);
      max-width: 240px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .save-row input {
      flex: 1;
      min-width: 0;
      font: inherit;
      font-size: 12px;
      padding: 6px 10px;
      background: var(--color-surface-elevated);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      outline: none;
      transition: border-color 0.12s, box-shadow 0.12s;
    }
    .save-row input:focus {
      border-color: var(--color-accent);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-accent) 30%, transparent);
    }
    .save-row button.primary {
      font: inherit;
      font-family: var(--font-sans);
      font-size: 11px;
      letter-spacing: 0.06em;
      padding: 6px 14px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
      border: 1px solid transparent;
      font-weight: 600;
      transition: filter 0.12s;
    }
    .save-row button.primary:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .save-row button.primary:not(:disabled):hover { filter: brightness(1.1); }
    .hint-line {
      padding: 6px 14px 10px;
      font-size: 10px;
      color: var(--color-text-muted);
      border-top: 1px solid var(--color-border);
      background: var(--color-surface);
    }
    .err {
      padding: 8px 14px;
      color: var(--color-danger);
      font-family: var(--font-mono);
      font-size: 11px;
      background: color-mix(in oklab, var(--color-danger) 8%, transparent);
      border-top: 1px solid var(--color-border);
    }
  `;

  constructor() {
    super();
    this._currentPath = "";
    this._entries = [];
    this._newName = "";
    this._error = "";
    this._envelopeHandler = (ev) => this._onEnvelope(ev.detail);
  }

  connectedCallback() {
    super.connectedCallback();
    this._onKey = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); this._close(); }
    };
    window.addEventListener("keydown", this._onKey, true);
    window.__foyer?.ws?.addEventListener("envelope", this._envelopeHandler);
  }

  disconnectedCallback() {
    window.removeEventListener("keydown", this._onKey, true);
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    super.disconnectedCallback();
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (!body) return;
    if (body.type === "path_listed") {
      this._currentPath = body.listing?.path || "";
      this._entries = body.listing?.entries || [];
    } else if (body.type === "error" && body.code === "save_session_failed") {
      this._error = body.message;
    }
  }

  _save() {
    const ws = window.__foyer?.ws;
    if (!ws) return;
    const name = this._newName.trim();
    if (!name) return;
    if (/[/\\]/.test(name) || name === ".." || name === ".") {
      this._error = "Use a single folder name with no slashes.";
      return;
    }
    const parent = this._currentPath || "";
    const path = parent ? `${parent}/${name}` : name;
    const conflict = (this._entries || []).some((e) => e.name === name);
    if (conflict) {
      this._error = "That name already exists in this folder — pick a new name.";
      return;
    }
    this._error = "";
    ws.send({ type: "save_session", as_path: path });
  }

  render() {
    return html`
      <div class="scrim" @click=${this._close}></div>
      <div class="modal" @click=${(e) => e.stopPropagation()}>
        <header>
          <span class="title">Save session as</span>
          <button title="Close (Esc)" @click=${this._close}>${icon("x-mark", 14)}</button>
        </header>
        <div class="body">
          <foyer-session-view mode="save_as"></foyer-session-view>
        </div>
        <div class="hint-line">
          Choose a folder, then enter a new session folder name.
          Existing session folders stay closed — save as always creates a sibling.
        </div>
        <div class="save-row">
          <span class="label">Save into</span>
          <span class="parent" title=${this._currentPath || "(jail root)"}>
            ${this._currentPath || "(jail root)"}
          </span>
          <input
            type="text"
            placeholder="new folder name…"
            .value=${this._newName}
            @input=${(e) => { this._newName = e.target.value; }}
            @keydown=${(e) => { if (e.key === "Enter") { e.preventDefault(); this._save(); } }}
          />
          <button
            class="primary"
            ?disabled=${!this._newName.trim()}
            @click=${this._save}
          >Save</button>
        </div>
        ${this._error ? html`<div class="err">${this._error}</div>` : null}
      </div>
    `;
  }

  _close = () => {
    this.remove();
  };
}
customElements.define("foyer-save-session-as-modal", SaveSessionAsModal);

/** Opens the jail browser for Save Session As. */
export function openSaveSessionAs() {
  const el = document.createElement("foyer-save-session-as-modal");
  document.body.appendChild(el);
  return el;
}
