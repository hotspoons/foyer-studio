// "Share session" modal — shows a QR code + click-to-copy URL so another
// device on the LAN can open the same session. The QR is rendered
// server-side at `GET /qr?data=<url>` so we don't need to vendor a QR
// library in the browser. Only useful when the sidecar's `ClientGreeting`
// includes reachable URLs (i.e. it's bound to non-loopback interfaces);
// the trigger button is hidden otherwise.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";

export class ShareModal extends LitElement {
  static properties = {
    urls:       { type: Array },
    _selected:  { state: true, type: Number },
    _copied:    { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 5500;
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
      background: rgba(2, 6, 23, 0.55);
      backdrop-filter: blur(3px);
    }
    .modal {
      position: relative;
      width: min(440px, 92vw);
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
      background: transparent; border: 1px solid transparent;
      border-radius: var(--radius-sm); color: var(--color-text-muted);
      padding: 2px 6px; cursor: pointer;
    }
    header button:hover { color: var(--color-text); border-color: var(--color-border); }
    .body {
      padding: 18px 20px 14px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
    }
    .qr {
      width: 256px; height: 256px;
      border-radius: var(--radius-md);
      background: var(--color-surface);
      padding: 10px;
      box-shadow: 0 0 0 1px var(--color-border);
    }
    .qr img { width: 100%; height: 100%; display: block; }
    .url-row {
      display: flex;
      align-items: stretch;
      width: 100%;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }
    .url-row input {
      flex: 1;
      min-width: 0;
      font: inherit;
      font-family: var(--font-mono);
      font-size: 12px;
      padding: 8px 10px;
      background: var(--color-surface);
      color: var(--color-text);
      border: 0;
      outline: none;
    }
    .url-row button {
      font: inherit;
      font-family: var(--font-sans);
      font-size: 11px;
      padding: 6px 14px;
      background: var(--color-surface-elevated);
      color: var(--color-text-muted);
      border: 0;
      border-left: 1px solid var(--color-border);
      cursor: pointer;
      min-width: 80px;
    }
    .url-row button:hover { color: var(--color-text); background: var(--color-surface-muted); }
    .url-row button.copied {
      color: var(--color-success);
    }
    .alternates {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .alternates label {
      font-size: 10px;
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 4px;
    }
    .alternates button {
      text-align: left;
      font: inherit;
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 4px 8px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--color-text-muted);
      cursor: pointer;
    }
    .alternates button:hover { color: var(--color-text); border-color: var(--color-border); }
    .alternates button.selected {
      color: var(--color-accent-3);
      border-color: color-mix(in oklab, var(--color-accent) 40%, transparent);
      background: color-mix(in oklab, var(--color-accent) 10%, transparent);
    }
    .hint {
      font-size: 10px;
      color: var(--color-text-muted);
      text-align: center;
      line-height: 1.5;
    }
  `;

  constructor() {
    super();
    this.urls = [];
    this._selected = 0;
    this._copied = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this._onKey = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); this._close(); } };
    window.addEventListener("keydown", this._onKey, true);
  }
  disconnectedCallback() {
    window.removeEventListener("keydown", this._onKey, true);
    super.disconnectedCallback();
  }

  _currentUrl() {
    return this.urls[this._selected] || this.urls[0] || "";
  }

  _copy = async () => {
    const url = this._currentUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this._copied = true;
      setTimeout(() => { this._copied = false; }, 1500);
    } catch {
      // Clipboard API not available (non-secure context, etc.) — fall
      // back to selecting the input so the user can Ctrl+C.
      const input = this.renderRoot.querySelector("input");
      input?.select();
    }
  };

  _close = () => { this.remove(); };

  render() {
    const url = this._currentUrl();
    const qrSrc = url ? `/qr?data=${encodeURIComponent(url)}` : "";
    return html`
      <div class="scrim" @click=${this._close}></div>
      <div class="modal" @click=${(e) => e.stopPropagation()}>
        <header>
          <span class="title">Share this session</span>
          <button title="Close (Esc)" @click=${this._close}>${icon("x-mark", 14)}</button>
        </header>
        <div class="body">
          <div class="qr">
            ${qrSrc ? html`<img src=${qrSrc} alt="QR code">` : null}
          </div>
          <div class="url-row">
            <input readonly .value=${url} @focus=${(e) => e.target.select()}>
            <button
              class=${this._copied ? "copied" : ""}
              @click=${this._copy}
            >${this._copied ? "Copied" : "Copy"}</button>
          </div>
          ${this.urls.length > 1 ? html`
            <div class="alternates">
              <label>Other reachable URLs</label>
              ${this.urls.map((u, i) => html`
                <button
                  class=${i === this._selected ? "selected" : ""}
                  @click=${() => { this._selected = i; this._copied = false; }}
                >${u}</button>
              `)}
            </div>
          ` : null}
          <div class="hint">
            Point a phone camera at the QR, or paste the URL on another
            device on the same network. This session is un-authenticated —
            anyone who can reach the URL can control it.
          </div>
        </div>
      </div>
    `;
  }
}
customElements.define("foyer-share-modal", ShareModal);

/** Open the share-session modal with the given list of reachable URLs. */
export function showShareModal(urls) {
  if (!urls?.length) return null;
  const el = document.createElement("foyer-share-modal");
  el.urls = urls;
  document.body.appendChild(el);
  return el;
}
