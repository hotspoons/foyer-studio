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
    /** True while `save_session` is in flight — blocks duplicate submits. */
    _busy:        { state: true, type: Boolean },
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
    .busy-overlay {
      position: absolute;
      inset: 0;
      z-index: 20;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      background: color-mix(in oklab, var(--color-surface-elevated) 82%, transparent);
      border-radius: inherit;
      pointer-events: all;
    }
    .busy-overlay .spinner {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: 3px solid var(--color-border);
      border-top-color: var(--color-accent);
      animation: fs-save-spin 0.65s linear infinite;
    }
    .busy-overlay .busy-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-text-muted);
    }
    @keyframes fs-save-spin {
      to { transform: rotate(360deg); }
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
    header button:disabled {
      opacity: 0.35;
      cursor: not-allowed;
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
    this._busy = false;
    /** @type {string} jail-relative path we sent with `save_session` */
    this._pendingWirePath = "";
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._saveTimer = null;
    this._envelopeHandler = (ev) => this._onEnvelope(ev.detail);
  }

  connectedCallback() {
    super.connectedCallback();
    this._onKey = (ev) => {
      if (ev.key === "Escape" && !this._busy) { ev.preventDefault(); this._close(); }
    };
    window.addEventListener("keydown", this._onKey, true);
    window.__foyer?.ws?.addEventListener("envelope", this._envelopeHandler);
  }

  disconnectedCallback() {
    window.removeEventListener("keydown", this._onKey, true);
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    this._clearSaveTimer();
    super.disconnectedCallback();
  }

  _normPath(p) {
    return (p || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  }

  /** True if the server-reported jail path matches what we sent Save As. */
  _pathsMatch(sent, got) {
    const a = this._normPath(sent);
    const b = this._normPath(got);
    if (!a || !b) return false;
    if (a === b) return true;
    const tail = a.split("/").filter(Boolean).pop();
    return tail !== undefined && (b === tail || b.endsWith(`/${tail}`));
  }

  _clearSaveTimer() {
    if (this._saveTimer != null) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
  }

  _armSaveTimer() {
    this._clearSaveTimer();
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (!this._busy) return;
      this._busy = false;
      this._pendingWirePath = "";
      this._error = "Save is taking too long — check Ardour for dialogs or errors.";
    }, 45_000);
  }

  _finishSaveOk() {
    this._clearSaveTimer();
    this._busy = false;
    this._pendingWirePath = "";
    this.remove();
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (!body) return;
    if (body.type === "path_listed") {
      this._currentPath = body.listing?.path || "";
      this._entries = body.listing?.entries || [];
    } else if (body.type === "error" && body.code === "save_session_failed") {
      this._clearSaveTimer();
      this._busy = false;
      this._pendingWirePath = "";
      this._error = body.message;
    } else if (
      body.type === "session_changed"
      && this._busy
      && body.path
      && this._pathsMatch(this._pendingWirePath, body.path)
    ) {
      this._finishSaveOk();
    }
  }

  _save() {
    const ws = window.__foyer?.ws;
    if (!ws) return;
    if (this._busy) return;
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
    this._busy = true;
    this._pendingWirePath = path;
    this._armSaveTimer();
    ws.send({ type: "save_session", as_path: path });
  }

  render() {
    return html`
      <div class="scrim" @click=${() => { if (!this._busy) this._close(); }}></div>
      <div class="modal" @click=${(e) => e.stopPropagation()}>
        ${this._busy ? html`
          <div class="busy-overlay" aria-busy="true" aria-live="polite">
            <div class="spinner"></div>
            <div class="busy-label">Saving session…</div>
          </div>
        ` : null}
        <header>
          <span class="title">Save session as</span>
          <button
            title=${this._busy ? "Wait for save to finish" : "Close (Esc)"}
            ?disabled=${this._busy}
            @click=${this._close}>${icon("x-mark", 14)}</button>
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
            ?disabled=${this._busy}
            .value=${this._newName}
            @input=${(e) => { this._newName = e.target.value; }}
            @keydown=${(e) => { if (e.key === "Enter") { e.preventDefault(); this._save(); } }}
          />
          <button
            class="primary"
            ?disabled=${!this._newName.trim() || this._busy}
            @click=${this._save}
          >Save</button>
        </div>
        ${this._error ? html`<div class="err">${this._error}</div>` : null}
      </div>
    `;
  }

  _close = () => {
    if (this._busy) return;
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
