// Command palette — cmd+K / ctrl+K. Search across all actions the shim
// exposes via list_actions. Arrow keys navigate, enter invokes.

import { LitElement, html, css, nothing } from "lit";

export class CommandPalette extends LitElement {
  static properties = {
    _open:   { state: true, type: Boolean },
    _query:  { state: true, type: String },
    _actions:{ state: true, type: Array },
    _hover:  { state: true, type: Number },
  };

  static styles = css`
    :host {
      position: fixed; inset: 0;
      display: none;
      z-index: 2000;
      align-items: flex-start;
      justify-content: center;
      padding-top: 12vh;
      background: rgba(0, 0, 0, 0.5);
    }
    :host([open]) { display: flex; }

    .box {
      width: 560px; max-width: 92vw;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-panel);
      overflow: hidden;
      display: flex; flex-direction: column;
    }
    .input {
      padding: 12px 14px;
      border-bottom: 1px solid var(--color-border);
    }
    .input input {
      width: 100%;
      background: transparent;
      border: 0; outline: 0;
      font: inherit; font-family: var(--font-sans);
      font-size: 15px;
      color: var(--color-text);
    }
    .list { max-height: 50vh; overflow: auto; }
    .row {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 14px;
      cursor: pointer;
      font-family: var(--font-sans);
      font-size: 13px;
      color: var(--color-text);
    }
    .row.active {
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
    }
    .row .cat {
      font-size: 9px; font-weight: 600; letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      min-width: 72px;
    }
    .row.active .cat { color: rgba(255,255,255,0.75); }
    .row .label { flex: 1; }
    .row .shortcut {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--color-text-muted);
      padding: 2px 6px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
    }
    .row.active .shortcut { color: rgba(255,255,255,0.85); border-color: rgba(255,255,255,0.3); }
    .empty { padding: 24px; text-align: center; color: var(--color-text-muted); }
  `;

  constructor() {
    super();
    this._open = false;
    this._query = "";
    this._actions = [];
    this._hover = 0;
    this._onKey = this._onKey.bind(this);
    this._envelopeHandler = (ev) => this._onEnvelope(ev.detail);
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this._onKey);
    const ws = window.__foyer?.ws;
    if (ws) {
      ws.addEventListener("envelope", this._envelopeHandler);
      ws.send({ type: "list_actions" });
    }
  }
  disconnectedCallback() {
    document.removeEventListener("keydown", this._onKey);
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    super.disconnectedCallback();
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (body?.type === "actions_list") {
      this._actions = body.actions || [];
    }
  }

  _onKey(ev) {
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      this._toggle();
    } else if (this._open) {
      if (ev.key === "Escape") { ev.preventDefault(); this._close(); }
      else if (ev.key === "ArrowDown") {
        ev.preventDefault();
        const f = this._filtered();
        if (f.length) this._hover = (this._hover + 1) % f.length;
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        const f = this._filtered();
        if (f.length) this._hover = (this._hover - 1 + f.length) % f.length;
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        const f = this._filtered();
        if (f[this._hover]) this._invoke(f[this._hover]);
      }
    }
  }

  _toggle() {
    this._open = !this._open;
    if (this._open) {
      this.setAttribute("open", "");
      this._query = "";
      this._hover = 0;
      queueMicrotask(() => this.renderRoot.querySelector("input")?.focus());
      window.__foyer?.ws?.send({ type: "list_actions" });
    } else {
      this.removeAttribute("open");
    }
  }
  _close() { this._open = false; this.removeAttribute("open"); }

  _filtered() {
    const q = this._query.trim().toLowerCase();
    if (!q) return this._actions;
    return this._actions.filter(a =>
      a.label.toLowerCase().includes(q) ||
      a.category.toLowerCase().includes(q) ||
      a.id.toLowerCase().includes(q)
    );
  }

  _invoke(a) {
    window.__foyer?.ws?.send({ type: "invoke_action", id: a.id });
    this._close();
  }

  render() {
    if (!this._open) return nothing;
    const items = this._filtered();
    return html`
      <div class="box" @click=${(e) => e.stopPropagation()}>
        <div class="input">
          <input
            type="text"
            placeholder="Type an action… (play, open session, rescan plugins, …)"
            .value=${this._query}
            @input=${(e) => { this._query = e.currentTarget.value; this._hover = 0; }}>
        </div>
        <div class="list">
          ${items.length === 0
            ? html`<div class="empty">No matches.</div>`
            : items.map((a, i) => html`
              <div class="row ${i === this._hover ? 'active' : ''}"
                   @mouseenter=${() => { this._hover = i; }}
                   @click=${() => this._invoke(a)}>
                <div class="cat">${a.category}</div>
                <div class="label">${a.label}</div>
                ${a.shortcut ? html`<div class="shortcut">${a.shortcut}</div>` : null}
              </div>
            `)}
        </div>
      </div>
    `;
  }

  // Backdrop click closes the palette.
  firstUpdated() {
    this.addEventListener("click", (e) => {
      if (e.target === this) this._close();
    });
  }
}
customElements.define("foyer-command-palette", CommandPalette);
