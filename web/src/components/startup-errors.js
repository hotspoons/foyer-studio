// Collects server-side error events that arrive during the "startup"
// window (connect + first few seconds after a backend swap) and shows
// them in a dismissable banner. The goal isn't to show every error
// ever — just the ones that accumulate on session load (missing
// plugins, shim init warnings, etc.) so the user has ONE place to
// acknowledge them instead of being confronted with a toast storm.
//
// After dismissal, further errors are ignored until the next swap —
// the DAW console view is the live surface for those.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";

/** Window (ms) after connect/swap during which errors are collected. */
const CAPTURE_MS = 4000;

/** Max errors held. Beyond this we collapse the tail. */
const MAX_ERRORS = 40;

export class StartupErrors extends LitElement {
  static properties = {
    _errors:   { state: true, type: Array },
    _dismissed:{ state: true, type: Boolean },
    // `backend_lost` events used to render as an inline crash card
    // here. They now own their own blocking modal
    // (backend-lost-modal.js) so they can offer recover/main-menu/
    // ignore actions instead of just "X this away" — disconnects
    // are almost always actionable. This component keeps handling
    // bulk startup errors only.
  };

  static styles = css`
    :host {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 5600;
      max-width: min(560px, calc(100vw - 24px));
      pointer-events: none;
      font-family: var(--font-sans);
    }
    .card {
      pointer-events: auto;
      background: var(--color-surface-elevated);
      border: 1px solid color-mix(in oklab, var(--color-danger) 55%, var(--color-border));
      border-radius: var(--radius-md, 8px);
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45);
      overflow: hidden;
      animation: foyer-slide-in 0.18s ease;
    }
    /* Crash = full-severity. Pulse the border so the eye catches it. */
    .card.crash {
      border-color: var(--color-danger);
      border-width: 2px;
      animation: foyer-slide-in 0.18s ease, foyer-crash-pulse 1.6s ease-in-out infinite;
    }
    @keyframes foyer-crash-pulse {
      0%, 100% { box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45); }
      50%      { box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45),
                              0 0 0 4px color-mix(in oklab, var(--color-danger) 30%, transparent); }
    }
    @keyframes foyer-slide-in {
      from { transform: translateY(-8px); opacity: 0; }
      to   { transform: translateY(0);    opacity: 1; }
    }
    header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      background: color-mix(in oklab, var(--color-danger) 12%, transparent);
      border-bottom: 1px solid color-mix(in oklab, var(--color-danger) 30%, transparent);
      color: var(--color-danger);
    }
    header .title {
      flex: 1;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      font-weight: 700;
    }
    header button {
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--color-text-muted);
      padding: 2px 6px;
      cursor: pointer;
    }
    header button:hover { color: var(--color-text); border-color: var(--color-border); }
    .list {
      max-height: 260px;
      overflow: auto;
      padding: 6px 0;
    }
    .row {
      display: flex;
      gap: 10px;
      padding: 6px 14px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-text);
      border-top: 1px solid color-mix(in oklab, var(--color-border) 40%, transparent);
    }
    .row:first-child { border-top: none; }
    .row .code {
      color: var(--color-warning);
      min-width: 120px;
      white-space: nowrap;
    }
    .row .msg { flex: 1; word-break: break-word; }
    footer {
      padding: 8px 14px 10px;
      font-size: 10px;
      color: var(--color-text-muted);
      border-top: 1px solid color-mix(in oklab, var(--color-border) 40%, transparent);
    }
  `;

  constructor() {
    super();
    this._errors = [];
    this._dismissed = false;
    this._captureUntil = 0;
    this._onEnvelope = (ev) => this._onEnv(ev.detail);
  }

  connectedCallback() {
    super.connectedCallback();
    // Open a capture window immediately on mount — catches errors that
    // arrive during the initial catch-up / snapshot stream.
    this._openCaptureWindow();
    window.__foyer?.ws?.addEventListener("envelope", this._onEnvelope);
  }
  disconnectedCallback() {
    window.__foyer?.ws?.removeEventListener("envelope", this._onEnvelope);
    super.disconnectedCallback();
  }

  _openCaptureWindow() {
    this._captureUntil = Date.now() + CAPTURE_MS;
    this._dismissed = false;
  }

  _onEnv(env) {
    const body = env?.body;
    if (!body) return;
    if (body.type === "backend_swapped") {
      // Fresh session loading — collect its errors too.
      this._errors = [];
      this._openCaptureWindow();
      return;
    }
    if (body.type === "backend_lost") {
      // Handled by backend-lost-modal.js — skip here.
      return;
    }
    if (body.type !== "error") return;
    if (this._dismissed && Date.now() > this._captureUntil) return;
    // Keep a bounded ring so a spammy backend doesn't OOM the modal.
    const next = this._errors.concat([{ code: body.code || "error", message: body.message || "" }]);
    this._errors = next.slice(-MAX_ERRORS);
  }

  _dismiss = () => {
    this._dismissed = true;
    this._errors = [];
  };

  render() {
    if (this._dismissed) return null;
    if (this._errors.length === 0) return null;
    return html`
      <div class="card">
        <header>
          ${icon("exclamation-triangle", 14)}
          <span class="title">${this._errors.length} issue${this._errors.length === 1 ? "" : "s"} on load</span>
          <button title="Dismiss" @click=${this._dismiss}>${icon("x-mark", 12)}</button>
        </header>
        <div class="list">
          ${this._errors.map((e) => html`
            <div class="row">
              <span class="code">${e.code}</span>
              <span class="msg">${e.message}</span>
            </div>
          `)}
        </div>
        <footer>
          Further errors after dismissal will only appear in the DAW console.
        </footer>
      </div>
    `;
  }
}
customElements.define("foyer-startup-errors", StartupErrors);
