// Top-of-screen main menu — dropdowns grouped by action category, driven by
// the shim's action catalog (via `list_actions`). DAW-agnostic: any host that
// populates its menus into actions shows up here.

import { LitElement, html, css } from "lit";

// Category → menu label + order. Categories not listed are skipped.
const MENU_ORDER = [
  { cat: "session",   label: "Session"   },
  { cat: "edit",      label: "Edit"      },
  { cat: "transport", label: "Transport" },
  { cat: "view",      label: "View"      },
  { cat: "track",     label: "Track"     },
  { cat: "plugin",    label: "Plugin"    },
  { cat: "settings",  label: "Settings"  },
];

export class MainMenu extends LitElement {
  static properties = {
    _actions: { state: true, type: Array },
    _openMenu: { state: true, type: String },
  };

  static styles = css`
    :host {
      display: flex;
      align-items: stretch;
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
      position: relative;
      z-index: 500;
    }
    .btn {
      background: transparent;
      border: 0;
      color: var(--color-text-muted);
      font-family: var(--font-sans);
      font-size: 11px;
      font-weight: 500;
      padding: 6px 10px;
      cursor: pointer;
      transition: all 0.1s ease;
    }
    .btn:hover, .btn.open {
      color: var(--color-text);
      background: var(--color-surface-elevated);
    }
    .dropdown {
      position: absolute;
      top: 100%;
      min-width: 220px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-top: 0;
      box-shadow: var(--shadow-panel);
      padding: 4px;
      z-index: 600;
      border-radius: 0 0 var(--radius-md) var(--radius-md);
    }
    .item {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px;
      font-family: var(--font-sans);
      font-size: 12px;
      color: var(--color-text);
      cursor: pointer;
      border-radius: var(--radius-sm);
    }
    .item:hover { background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2)); color: #fff; }
    .item .label { flex: 1; }
    .item .shortcut {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--color-text-muted);
    }
    .item:hover .shortcut { color: rgba(255,255,255,0.85); }
    .item.disabled { opacity: 0.4; cursor: default; }
  `;

  constructor() {
    super();
    this._actions = [];
    this._openMenu = "";
    this._envelopeHandler = (ev) => this._onEnvelope(ev.detail);
    this._onDocDown = (e) => {
      if (!this.renderRoot.host.contains(e.target)) this._openMenu = "";
    };
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this._onDocDown, true);
    const ws = window.__foyer?.ws;
    if (ws) {
      ws.addEventListener("envelope", this._envelopeHandler);
      ws.send({ type: "list_actions" });
    }
  }
  disconnectedCallback() {
    document.removeEventListener("pointerdown", this._onDocDown, true);
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    super.disconnectedCallback();
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (body?.type === "actions_list") {
      this._actions = body.actions || [];
    }
  }

  _byCategory(cat) {
    return this._actions.filter(a => a.category === cat);
  }

  _invoke(a) {
    if (!a.enabled) return;
    this._openMenu = "";
    window.__foyer?.ws?.send({ type: "invoke_action", id: a.id });
  }

  render() {
    return html`
      ${MENU_ORDER.map(({ cat, label }) => {
        const items = this._byCategory(cat);
        if (!items.length) return null;
        return this._renderMenu(cat, label, items);
      })}
    `;
  }

  _renderMenu(cat, label, items) {
    const open = this._openMenu === cat;
    return html`
      <button class="btn ${open ? 'open' : ''}"
              @click=${() => { this._openMenu = open ? "" : cat; }}
              @mouseenter=${() => { if (this._openMenu) this._openMenu = cat; }}>
        ${label}
      </button>
      ${open ? html`
        <div class="dropdown" style="left:${this._menuLeftFor(cat)}px">
          ${items.map(a => html`
            <div class="item ${a.enabled ? '' : 'disabled'}"
                 @click=${() => this._invoke(a)}>
              <span class="label">${a.label}</span>
              ${a.shortcut ? html`<span class="shortcut">${a.shortcut}</span>` : null}
            </div>
          `)}
        </div>
      ` : null}
    `;
  }

  _menuLeftFor(cat) {
    // Measure each preceding button's width so the dropdown aligns.
    const btns = Array.from(this.renderRoot.querySelectorAll(".btn"));
    let x = 0;
    for (const b of btns) {
      if (b.textContent.trim().toLowerCase() === cat) break;
      x += b.offsetWidth;
    }
    return x;
  }
}
customElements.define("foyer-main-menu", MainMenu);
