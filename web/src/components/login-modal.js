// Tunnel sign-in modal.
//
// Shown when the server's ClientGreeting marks this connection as
// `is_tunnel && !is_authenticated` — i.e. the guest reached the
// tunnel URL without a valid `?token=` query parameter. Collects
// username (email) + password, encodes them into the URL token the
// server expects (`base64url(email:password)`), and reconnects by
// rewriting `window.location` so the WebSocket handshake picks up
// the new token automatically.
//
// The modal is non-dismissible — until the user signs in or navigates
// away the WS layer can't accept any commands, so showing a
// dismissible overlay would leave the app in a half-broken state.
//
// Email normalization (trim + ASCII-lowercase) matches the server's
// `normalize_email` in `crates/foyer-server/src/tunnel.rs` so the
// hash computed on either side matches.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";

export class LoginModal extends LitElement {
  static properties = {
    _show:      { state: true, type: Boolean },
    _email:     { state: true, type: String },
    _password:  { state: true, type: String },
    _error:     { state: true, type: String },
    _busy:      { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      position: fixed; inset: 0;
      z-index: 5800;
      display: none;
      pointer-events: auto;
      font-family: var(--font-sans);
    }
    :host([open]) { display: flex; align-items: center; justify-content: center; }
    .scrim {
      position: absolute; inset: 0;
      background: rgba(0, 0, 0, 0.72);
      backdrop-filter: blur(4px);
    }
    .modal {
      position: relative;
      width: 360px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg, 10px);
      padding: 22px 22px 18px;
      box-shadow: 0 18px 48px rgba(0,0,0,0.55);
    }
    h2 {
      margin: 0 0 4px; font-size: 15px; font-weight: 600;
      color: var(--color-text);
      display: flex; align-items: center; gap: 8px;
    }
    .sub { font-size: 11px; color: var(--color-text-muted); margin-bottom: 14px; }
    label {
      display: block;
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em;
      color: var(--color-text-muted); margin: 10px 0 4px;
    }
    input[type=text],
    input[type=password] {
      width: 100%;
      padding: 8px 10px;
      font: inherit; font-size: 13px;
      background: var(--color-surface);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      box-sizing: border-box;
    }
    input:focus { outline: none; border-color: var(--color-accent); }
    .error {
      margin-top: 10px;
      font-size: 11px;
      color: var(--color-danger);
      min-height: 14px;
    }
    .row {
      display: flex; justify-content: flex-end; gap: 8px;
      margin-top: 14px;
    }
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      border: 0; border-radius: var(--radius-sm);
      color: #fff; font: inherit; font-size: 12px; font-weight: 600;
      padding: 7px 16px; cursor: pointer;
    }
    .btn:disabled { opacity: 0.5; cursor: default; }
  `;

  constructor() {
    super();
    this._show = false;
    this._email = "";
    this._password = "";
    this._error = "";
    this._busy = false;
    this._onRbac = () => this._refreshFromStore();
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.store?.addEventListener("rbac", this._onRbac);
    this._refreshFromStore();
  }

  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("rbac", this._onRbac);
    super.disconnectedCallback();
  }

  _refreshFromStore() {
    const rbac = window.__foyer?.store?.rbac?.() || { isTunnel: false, isAuthenticated: true };
    const shouldShow = rbac.isTunnel && !rbac.isAuthenticated;
    this._show = shouldShow;
    if (shouldShow) {
      this.setAttribute("open", "");
    } else {
      this.removeAttribute("open");
      this._error = "";
      this._busy = false;
    }
  }

  /// URL-safe base64 encode a UTF-8 string (matches Rust's
  /// base64::URL_SAFE_NO_PAD). window.btoa operates on binary strings,
  /// so we UTF-8-encode first to get correct output for non-ASCII.
  _encodeToken(email, password) {
    const raw = `${email.trim().toLowerCase()}:${password}`;
    // UTF-8 → binary-string shim so btoa accepts multi-byte chars.
    const utf8 = unescape(encodeURIComponent(raw));
    return btoa(utf8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  _submit() {
    const email = this._email.trim();
    const pw = this._password;
    if (!email || !pw) {
      this._error = "Enter both an email and a password.";
      return;
    }
    this._busy = true;
    this._error = "";
    const token = this._encodeToken(email, pw);
    // Rewrite the URL so the WS layer picks up `?token=` on reconnect.
    // Full reload is intentional — the app's websocket + store state
    // should all restart against the new identity, and a reload is
    // the simplest way to get everything to re-handshake.
    const url = new URL(window.location.href);
    url.searchParams.set("token", token);
    window.location.replace(url.toString());
  }

  render() {
    if (!this._show) return html``;
    return html`
      <div class="scrim"></div>
      <div class="modal" role="dialog" aria-modal="true">
        <h2>${icon("shield-check", 14)} Sign in</h2>
        <div class="sub">
          This session is shared over a secure tunnel. Use the username
          and password that were sent to you to continue.
        </div>
        <label for="login-email">Email</label>
        <input id="login-email" type="text" autocomplete="username"
               .value=${this._email}
               @input=${(e) => (this._email = e.currentTarget.value)}
               @keydown=${(e) => { if (e.key === "Enter") this._submit(); }}>
        <label for="login-pw">Password</label>
        <input id="login-pw" type="password" autocomplete="current-password"
               .value=${this._password}
               @input=${(e) => (this._password = e.currentTarget.value)}
               @keydown=${(e) => { if (e.key === "Enter") this._submit(); }}>
        <div class="error">${this._error}</div>
        <div class="row">
          <button class="btn" ?disabled=${this._busy} @click=${this._submit}>
            ${icon("arrow-right-end-on-rectangle", 12)}
            ${this._busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </div>
    `;
  }
}

customElements.define("foyer-login-modal", LoginModal);
