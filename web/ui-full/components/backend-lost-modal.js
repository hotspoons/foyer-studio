// DAW-disconnected modal — shown when the sidecar emits
// `Event::BackendLost`, which means the shim's event stream ended
// (Ardour crashed, was killed, or lost its socket).
//
// Replaces the old corner banner with a blocking modal that forces a
// choice, because "keep clicking faders while the DAW is dead" is
// near-always wrong — faders do nothing, meters freeze, and any
// in-flight edits are lost. Three actions:
//
//   1. Recover session  — re-launch the same project path via a
//      fresh shim. Closes the dead session first so the switcher
//      doesn't show two entries for the same path. Uses the
//      SessionInfo we cached in the store; gracefully degrades if
//      the info is missing (e.g. launcher-mode stub backend with
//      no `session_id` tag).
//
//   2. Main menu        — close the dead session. Store falls
//      through to welcome screen or the next-most-recent open
//      session.
//
//   3. Ignore           — dismiss the modal, leave the dead
//      session in the switcher. User can close it or retry from
//      the session switcher later.
//
// The modal is auto-dismissed if a fresh `backend_swapped` arrives
// (successful recovery), which is how the "recovered in background
// before you clicked anything" path plays out.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";

export class BackendLostModal extends LitElement {
  static properties = {
    _show:    { state: true, type: Boolean },
    _reason:  { state: true, type: String },
    _sessionId: { state: true, type: String },
    _sessionInfo: { state: true },
    _recovering: { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      position: fixed; inset: 0;
      z-index: 5700;
      display: none;
      pointer-events: auto;
      font-family: var(--font-sans);
    }
    :host([open]) { display: flex; align-items: center; justify-content: center; }
    .scrim {
      position: absolute; inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(3px);
    }
    .modal {
      position: relative;
      min-width: 440px; max-width: 580px;
      background: var(--color-surface-elevated);
      border: 2px solid var(--color-danger);
      border-radius: var(--radius-lg, 10px);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.65),
                  0 0 0 4px color-mix(in oklab, var(--color-danger) 22%, transparent);
      overflow: hidden;
      animation: foyer-lost-in 0.2s ease;
    }
    @keyframes foyer-lost-in {
      from { transform: translateY(-8px) scale(0.98); opacity: 0; }
      to   { transform: translateY(0)    scale(1);    opacity: 1; }
    }
    header {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 18px;
      background: color-mix(in oklab, var(--color-danger) 22%, var(--color-surface-elevated));
      border-bottom: 1px solid color-mix(in oklab, var(--color-danger) 40%, var(--color-border));
    }
    header .title {
      flex: 1;
      font-size: 12px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-weight: 700;
      color: var(--color-danger);
    }
    header .icon { color: var(--color-danger); }
    .body {
      padding: 16px 18px;
      color: var(--color-text);
      font-size: 13px;
      line-height: 1.5;
    }
    .body .name {
      font-weight: 600;
      color: var(--color-text);
    }
    .body .reason {
      margin-top: 10px;
      padding: 8px 10px;
      border-radius: 6px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-text-muted);
      word-break: break-word;
    }
    .body .caveat {
      margin-top: 10px;
      color: var(--color-text-muted);
      font-size: 11px;
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 10px 18px 14px;
    }
    button.btn {
      font: inherit; font-family: var(--font-sans);
      font-size: 11px;
      letter-spacing: 0.06em;
      padding: 7px 14px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text);
      transition: all 0.12s ease;
    }
    button.btn:hover:not([disabled]) {
      border-color: var(--color-accent);
      color: var(--color-accent-3);
    }
    button.btn[disabled] { opacity: 0.55; cursor: wait; }
    button.btn.primary {
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
      border-color: transparent;
      font-weight: 600;
    }
    button.btn.primary:hover:not([disabled]) { filter: brightness(1.1); }
    button.btn.danger {
      background: color-mix(in oklab, var(--color-danger) 20%, transparent);
      color: var(--color-danger);
      border-color: color-mix(in oklab, var(--color-danger) 60%, var(--color-border));
    }
    button.btn.danger:hover:not([disabled]) {
      background: color-mix(in oklab, var(--color-danger) 30%, transparent);
      border-color: var(--color-danger);
    }
    .kbd {
      font-family: var(--font-mono);
      font-size: 9px;
      padding: 1px 4px;
      margin-left: 6px;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.25);
      border-radius: 3px;
      color: rgba(255,255,255,0.9);
    }
    .spinner {
      display: inline-block;
      width: 12px; height: 12px;
      border: 2px solid rgba(255,255,255,0.25);
      border-top-color: currentColor;
      border-radius: 50%;
      animation: foyer-spin 0.8s linear infinite;
      margin-right: 6px;
      vertical-align: -2px;
    }
    @keyframes foyer-spin { to { transform: rotate(360deg); } }
  `;

  constructor() {
    super();
    this._show = false;
    this._reason = "";
    this._sessionId = "";
    this._sessionInfo = null;
    this._recovering = false;
    this._onEnvelope = (ev) => this._onEnv(ev.detail);
    this._onKey = (ev) => {
      if (!this._show) return;
      if (ev.key === "Escape") {
        ev.preventDefault();
        this._ignore();
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        this._recover();
      }
    };
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.ws?.addEventListener("envelope", this._onEnvelope);
    window.addEventListener("keydown", this._onKey, true);
  }
  disconnectedCallback() {
    window.__foyer?.ws?.removeEventListener("envelope", this._onEnvelope);
    window.removeEventListener("keydown", this._onKey, true);
    super.disconnectedCallback();
  }

  _onEnv(env) {
    const body = env?.body;
    if (!body) return;
    if (body.type === "backend_lost") {
      // Resolve the SessionInfo for the envelope's tagged session
      // so we know the path to re-launch. Falls back to the store's
      // currently-focused session when the envelope lacks a tag
      // (legacy stub-pump path, shouldn't happen for Ardour).
      const sid = env.session_id || window.__foyer?.store?.state?.currentSessionId || "";
      const sessions = window.__foyer?.store?.state?.sessions || [];
      const info = sessions.find((s) => s.id === sid) || null;
      this._sessionId = sid;
      this._sessionInfo = info;
      this._reason = body.reason || `${body.backend_id || "backend"} disconnected`;
      this._recovering = false;
      this._show = true;
      this.setAttribute("open", "");
    } else if (body.type === "backend_swapped" || body.type === "session_opened") {
      // Successful recovery — auto-dismiss.
      if (this._show) this._close();
    }
  }

  _close() {
    this._show = false;
    this.removeAttribute("open");
    this._recovering = false;
  }

  _recover = () => {
    const ws = window.__foyer?.ws;
    if (!ws || !this._sessionInfo?.path) {
      // No info to recover against — degrade to "main menu" so at
      // least the dead session gets dropped.
      this._mainMenu();
      return;
    }
    this._recovering = true;
    // Close the stale session first so the switcher doesn't flash a
    // duplicate entry while the new one loads. The close_session
    // command is tolerant of already-dead backends.
    if (this._sessionId) {
      ws.send({ type: "close_session", session_id: this._sessionId });
    }
    ws.send({
      type: "launch_project",
      backend_id: this._sessionInfo.backend_id || "ardour",
      project_path: this._sessionInfo.path,
    });
    // Modal stays up with the spinner until backend_swapped arrives
    // (auto-close in _onEnv). If the launch fails, backend_swapped
    // won't fire and the user can hit Main menu instead.
  };

  _mainMenu = () => {
    const ws = window.__foyer?.ws;
    if (ws && this._sessionId) {
      ws.send({ type: "close_session", session_id: this._sessionId });
    } else {
      // No session to close — just drop it out of the store so the
      // welcome screen takes over.
      const store = window.__foyer?.store;
      if (store && this._sessionId) {
        store.state.sessions = store.state.sessions.filter((s) => s.id !== this._sessionId);
        if (store.state.currentSessionId === this._sessionId) {
          store.state.currentSessionId = null;
          store.state.session = null;
        }
        store.dispatchEvent(new CustomEvent("sessions"));
        store.dispatchEvent(new CustomEvent("change"));
      }
    }
    this._close();
  };

  _ignore = () => {
    this._close();
  };

  render() {
    if (!this._show) return html``;
    const name = this._sessionInfo?.name || this._sessionId || "the session";
    const canRecover = !!this._sessionInfo?.path;
    return html`
      <div class="scrim" @click=${this._ignore}></div>
      <div class="modal" role="alertdialog" aria-modal="true" @click=${(e) => e.stopPropagation()}>
        <header>
          <span class="icon">${icon("exclamation-triangle", 16)}</span>
          <span class="title">DAW disconnected</span>
        </header>
        <div class="body">
          The DAW hosting <span class="name">${name}</span> stopped sending events.
          Ardour may have crashed, been killed, or lost its socket. Audio, metering,
          and transport events from this point on are stale — they won't reflect
          anything the DAW is actually doing.
          <div class="reason">${this._reason}</div>
          ${canRecover ? html`
            <div class="caveat">
              Recover will relaunch the project at
              <code style="font-family:var(--font-mono)">${this._sessionInfo.path}</code>
              in a fresh Ardour process and close this dead session.
            </div>
          ` : html`
            <div class="caveat">
              No project path was recorded for this session — Recover isn't
              available. Go back to the main menu and re-open from the picker.
            </div>
          `}
        </div>
        <footer>
          <button class="btn" @click=${this._ignore}>
            Ignore<span class="kbd">Esc</span>
          </button>
          <button class="btn danger" @click=${this._mainMenu}>
            Main menu
          </button>
          <button class="btn primary"
                  ?disabled=${!canRecover || this._recovering}
                  @click=${this._recover}>
            ${this._recovering
              ? html`<span class="spinner"></span>Recovering…`
              : html`Recover session<span class="kbd">⏎</span>`}
          </button>
        </footer>
      </div>
    `;
  }
}
customElements.define("foyer-backend-lost-modal", BackendLostModal);
