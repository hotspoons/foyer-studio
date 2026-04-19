import { LitElement, html, css } from "lit";

import { icon } from "../icons.js";
import { cycleTheme, getTheme, onThemeChange, THEME_META } from "../theme.js";

export class StatusBar extends LitElement {
  static properties = {
    status: { type: String },
    _theme: { state: true, type: String },
    _fullscreen: { state: true, type: Boolean },
    _peers: { state: true, type: Array },
  };

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 14px;
      font-size: 11px;
      color: var(--color-text-muted);
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
    }
    .brand {
      font-family: var(--font-sans);
      font-weight: 700;
      font-size: 12px;
      letter-spacing: 0.14em;
      background: linear-gradient(135deg, var(--color-accent-3), var(--color-accent-2));
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--color-text-muted);
      box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.3);
    }
    .dot.open   { background: var(--color-success); box-shadow: 0 0 10px rgba(34, 197, 94, 0.45); }
    .dot.closed { background: var(--color-text-muted); }
    .dot.error  { background: var(--color-danger);  box-shadow: 0 0 10px rgba(239, 68, 68, 0.45); }
    .label { text-transform: uppercase; letter-spacing: 0.08em; font-size: 10px; }
    .spacer { flex: 1; }
    button {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font: inherit;
      font-size: 10px;
      font-family: var(--font-sans);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      padding: 2px 6px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    button:hover {
      color: var(--color-text);
      border-color: var(--color-border);
      background: var(--color-surface-elevated);
    }
    .peers {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--color-accent-3);
      padding: 2px 8px;
      border: 1px solid color-mix(in oklab, var(--color-accent) 40%, var(--color-border));
      border-radius: 999px;
      background: color-mix(in oklab, var(--color-accent) 10%, transparent);
    }
    .peer-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--color-accent-3);
      box-shadow: 0 0 6px color-mix(in oklab, var(--color-accent) 40%, transparent);
    }
  `;

  constructor() {
    super();
    this._theme = getTheme();
    this._fullscreen = !!document.fullscreenElement;
    this._peers = [];
    this._offThemeChange = null;
    this._onFsChange = () => { this._fullscreen = !!document.fullscreenElement; };
    this._onPeers = () => {
      const store = window.__foyer?.store;
      this._peers = store?.activePeers?.() || [];
    };
  }

  connectedCallback() {
    super.connectedCallback();
    this._offThemeChange = onThemeChange(() => { this._theme = getTheme(); });
    document.addEventListener("fullscreenchange", this._onFsChange);
    window.__foyer?.store?.addEventListener("peers", this._onPeers);
    this._peerTick = setInterval(this._onPeers, 3000);
  }
  disconnectedCallback() {
    this._offThemeChange?.();
    document.removeEventListener("fullscreenchange", this._onFsChange);
    window.__foyer?.store?.removeEventListener("peers", this._onPeers);
    clearInterval(this._peerTick);
    super.disconnectedCallback();
  }

  _toggleTheme() {
    this._theme = cycleTheme();
  }

  _toggleFullscreen() {
    if (this._fullscreen) {
      document.exitFullscreen?.();
    } else {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }

  render() {
    const s = this.status || "idle";
    const meta = THEME_META[this._theme] || THEME_META.dim;
    return html`
      <span class="brand">FOYER</span>
      <span class="dot ${s}"></span>
      <span class="label">${s}</span>
      ${this._peers.length
        ? html`<span
            class="peers"
            title=${this._peers.map((p) => p.origin).join(", ")}
          >
            <span class="peer-dot"></span>
            ${this._peers.length} peer${this._peers.length === 1 ? "" : "s"}
          </span>`
        : null}
      <span class="spacer"></span>
      ${this._fullscreen ? null : html`
        <button title="Enter fullscreen" @click=${this._toggleFullscreen}>
          ${icon("arrow-expand", 14)}
          <span>Full</span>
        </button>
      `}
      <button title="Theme: ${meta.label}" @click=${this._toggleTheme}>
        ${icon(meta.icon, 14)}
        <span>${meta.label}</span>
      </button>
    `;
  }
}
customElements.define("foyer-status-bar", StatusBar);
