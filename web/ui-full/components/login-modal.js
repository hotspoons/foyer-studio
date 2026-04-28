// Tunnel sign-in modal.
//
// Shown when the server's ClientGreeting marks this connection as
// `is_tunnel && !is_authenticated` — i.e. the guest reached the
// tunnel URL without a valid `?token=` query parameter. Collects
// username (email) + password, POSTs them to `/login` where the
// server runs `verify_credentials` (hash the inputs with the same
// pepper used at invite time, match against the stored
// `token_hash`). On success the server returns the digest URL token,
// which we plug into `?token=` and reload — the WS handshake then
// authorizes via the normal token path.
//
// We deliberately do NOT compute the digest client-side: keeping the
// hashing on the server keeps the pepper out of the browser bundle
// and lets the auth algorithm evolve without a client release. The
// trade-off is that the typed password crosses the wire — fine for
// our threat model (TLS terminates at the Cloudflare edge for tunnel
// guests, and LAN guests are on the same network anyway).
//
// The modal is non-dismissible — until the user signs in or navigates
// away the WS layer can't accept any commands, so showing a
// dismissible overlay would leave the app in a half-broken state.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";

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

  async _submit() {
    const email = this._email.trim();
    const pw = this._password;
    if (!email || !pw) {
      this._error = "Enter both an email and a password.";
      return;
    }
    this._busy = true;
    this._error = "";
    let token;
    try {
      const res = await fetch("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: pw }),
      });
      if (res.status === 401) {
        this._error = "Email or password is incorrect.";
        this._busy = false;
        return;
      }
      if (!res.ok) {
        this._error = `Sign-in failed (${res.status}).`;
        this._busy = false;
        return;
      }
      const body = await res.json();
      token = body.token;
    } catch (e) {
      this._error = "Network error — try again.";
      this._busy = false;
      return;
    }
    if (!token) {
      this._error = "Server returned no token.";
      this._busy = false;
      return;
    }
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
