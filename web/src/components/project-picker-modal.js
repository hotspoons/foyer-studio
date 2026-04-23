// Modal wrapper around the project browser for the Session → Open / New
// menu actions. Same scrim pattern as preview-modal.js: mount on demand,
// Esc / click-scrim dismiss.
//
// Two modes:
//   · "open" — embed <foyer-session-view> directly. Clicking a
//     session_dir fires `launch_project` (existing flow). Modal closes
//     automatically when `backend_swapped` arrives.
//
//   · "new" — same picker, but direct session_dir clicks only *navigate
//     into* the folder. A "Create here" row at the bottom takes a name
//     input and fires `launch_project` with `<current path>/<name>` —
//     Ardour will create the session if it doesn't exist. (The stub
//     falls through to its open_session handler, which is a no-op but
//     harmless.)

import { LitElement, html, css } from "lit";

import "./session-view.js";
import { icon } from "../icons.js";
import { launchProjectGuarded } from "../session-launch.js";

export class ProjectPickerModal extends LitElement {
  static properties = {
    mode:            { type: String },
    _currentPath:    { state: true, type: String },
    _newName:        { state: true, type: String },
    _activeBackend:  { state: true, type: String },
    _backends:       { state: true, type: Array },
    _error:          { state: true, type: String },
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
    .create-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-top: 1px solid var(--color-border);
      background: var(--color-surface);
    }
    .create-row .label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--color-text-muted);
    }
    .create-row .parent {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-accent-3);
      max-width: 240px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .create-row input {
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
    .create-row input:focus {
      border-color: var(--color-accent);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-accent) 30%, transparent);
    }
    .create-row button.primary {
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
    .create-row button.primary:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .create-row button.primary:not(:disabled):hover { filter: brightness(1.1); }
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
    this.mode = "open";
    this._currentPath = "";
    this._newName = "";
    this._activeBackend = null;
    this._backends = [];
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
    } else if (body.type === "backends_listed") {
      this._backends = body.backends || [];
      this._activeBackend = body.active || null;
    } else if (body.type === "backend_swapped") {
      // Project opened successfully — close the modal. Let the existing
      // app chrome respond to the swap for snapshot refresh.
      this._close();
    } else if (body.type === "error" && body.code === "launch_failed") {
      this._error = body.message;
    }
  }

  _titleFor() {
    return this.mode === "new" ? "New session" : "Open session";
  }

  _onPick(ev) {
    // In "new" mode, intercept the session-view's launch_project — we
    // don't want a double-click on a session_dir to bypass the "pick a
    // parent then name it" flow. Session-view fires `launch_project`
    // directly via WS; there's no cancel hook, so instead we listen for
    // clicks on session-view at the modal level and stop them when the
    // mode is "new" + the click was on a session_dir row. Cleaner path
    // is a dedicated @pick event on session-view — deferred.
    void ev;
  }

  _createHere() {
    const name = this._newName.trim();
    if (!name) return;
    // Build the project path as parent/name. Leading slash stripped so
    // it stays jail-relative.
    const parent = this._currentPath || "";
    const path = parent ? `${parent}/${name}` : name;
    const backendId = this._pickBackend();
    this._error = "";
    launchProjectGuarded({
      backend_id: backendId,
      project_path: path,
    });
  }

  _pickBackend() {
    // Prefer the active backend (the config's default); fall back to the
    // first project-capable entry. Matches session-view's inference.
    if (this._activeBackend) return this._activeBackend;
    const list = this._backends || [];
    return (list.find((b) => b.requires_project && b.enabled)
      || list.find((b) => b.enabled))?.id || "ardour";
  }

  render() {
    return html`
      <div class="scrim" @click=${this._close}></div>
      <div class="modal" @click=${(e) => e.stopPropagation()}>
        <header>
          <span class="title">${this._titleFor()}</span>
          <button title="Close (Esc)" @click=${this._close}>${icon("x-mark", 14)}</button>
        </header>
        <div class="body">
          <foyer-session-view @click=${this._onPick}></foyer-session-view>
        </div>
        ${this.mode === "new" ? html`
          <div class="create-row">
            <span class="label">Create in</span>
            <span class="parent" title=${this._currentPath || "(jail root)"}>
              ${this._currentPath || "(jail root)"}
            </span>
            <input
              type="text"
              placeholder="new session name…"
              .value=${this._newName}
              @input=${(e) => { this._newName = e.target.value; }}
              @keydown=${(e) => { if (e.key === "Enter") { e.preventDefault(); this._createHere(); } }}
            />
            <button
              class="primary"
              ?disabled=${!this._newName.trim()}
              @click=${this._createHere}
            >Create here</button>
          </div>
        ` : null}
        ${this._error ? html`<div class="err">${this._error}</div>` : null}
      </div>
    `;
  }

  _close = () => {
    this.remove();
  };
}
customElements.define("foyer-project-picker-modal", ProjectPickerModal);

/**
 * Open a project-picker modal. Mode is `"open"` (default) or `"new"`.
 * Returns the element so the caller can tear it down early.
 */
export function showProjectPicker(mode = "open") {
  const el = document.createElement("foyer-project-picker-modal");
  el.mode = mode;
  document.body.appendChild(el);
  return el;
}

/** Alias — friendlier name used by the welcome screen + session
 *  switcher. Always opens in "open" mode. */
export function openProjectPicker() {
  return showProjectPicker("open");
}
