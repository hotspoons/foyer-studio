// Plugin picker modal. Opens when the user clicks the "+" slot on a
// track's plugin strip, lets them search the host plugin catalog, and
// sends an `add_plugin` command with the chosen URI + track.
//
// Fires `close` on backdrop-click / Escape / successful insert.
// Fires `plugin-added` when the shim acknowledges — but today we
// close optimistically on click since the backend echoes via
// `track_updated` and the user will see the chain grow regardless.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";

export class PluginPickerModal extends LitElement {
  static properties = {
    trackId:   { type: String, attribute: "track-id" },
    trackName: { type: String, attribute: "track-name" },
    _entries:  { state: true, type: Array },
    _loading:  { state: true, type: Boolean },
    _query:    { state: true, type: String },
    _format:   { state: true, type: String },
    _role:     { state: true, type: String },
  };

  static styles = css`
    :host {
      position: fixed; inset: 0; z-index: 900;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(3px);
      font-family: var(--font-sans);
    }
    .card {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
      width: min(780px, 92vw);
      max-height: 82vh;
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    header {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--color-border);
    }
    header h2 {
      margin: 0; font-size: 14px; font-weight: 600;
      letter-spacing: 0.04em; color: var(--color-text);
    }
    header .target {
      font-size: 11px; color: var(--color-text-muted);
      margin-left: 6px;
    }
    header .close {
      margin-left: auto;
      background: transparent; border: 0; cursor: pointer;
      color: var(--color-text-muted); padding: 4px;
      border-radius: var(--radius-sm);
    }
    header .close:hover { color: var(--color-text); background: var(--color-surface-elevated); }
    .toolbar {
      display: flex; gap: 10px; align-items: center;
      padding: 10px 18px;
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
    }
    .search {
      flex: 1; display: flex; align-items: center; gap: 6px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 4px 8px;
      color: var(--color-text-muted);
    }
    .search input {
      flex: 1; background: transparent; border: 0; outline: none;
      font: inherit; font-size: 12px; color: var(--color-text);
    }
    select {
      background: var(--color-surface-elevated);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 3px 6px;
      font: inherit; font-size: 11px;
    }
    .list { flex: 1 1 auto; overflow: auto; padding: 10px 18px; }
    .group-title {
      font-size: 10px; font-weight: 600; letter-spacing: 0.1em;
      text-transform: uppercase; color: var(--color-text-muted);
      margin: 10px 0 6px;
    }
    .row {
      display: flex; align-items: center; gap: 12px;
      padding: 8px 10px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      margin-bottom: 4px;
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .row:hover { border-color: var(--color-accent); transform: translateY(-1px); }
    .row .name { font-weight: 600; color: var(--color-text); font-size: 12px; }
    .row .vendor { font-size: 10px; color: var(--color-text-muted); }
    .row .badges { display: flex; gap: 4px; margin-left: auto; }
    .badge {
      font-size: 9px; font-weight: 600; letter-spacing: 0.08em;
      text-transform: uppercase; padding: 2px 6px;
      border-radius: var(--radius-sm);
      background: var(--color-surface-muted); color: var(--color-text-muted);
    }
    .empty, .status {
      padding: 24px; color: var(--color-text-muted); font-size: 12px;
      text-align: center;
    }
    footer {
      padding: 10px 18px;
      border-top: 1px solid var(--color-border);
      color: var(--color-text-muted); font-size: 11px;
      display: flex; gap: 12px; align-items: center;
    }
    footer button {
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      color: var(--color-text-muted);
      padding: 4px 10px; cursor: pointer;
      font: inherit; font-size: 11px;
      letter-spacing: 0.06em; text-transform: uppercase;
    }
    footer button:hover { color: var(--color-text); border-color: var(--color-accent); }
    footer .spacer { flex: 1; }
  `;

  constructor() {
    super();
    this.trackId = "";
    this.trackName = "";
    this._entries = [];
    this._loading = true;
    this._query = "";
    this._format = "all";
    this._role = "all";
    this._envelopeHandler = (ev) => this._onEnvelope(ev.detail);
    this._keyHandler = (ev) => { if (ev.key === "Escape") this._close(); };
  }

  connectedCallback() {
    super.connectedCallback();
    const ws = window.__foyer?.ws;
    if (ws) {
      ws.addEventListener("envelope", this._envelopeHandler);
      ws.send({ type: "list_plugins" });
    }
    document.addEventListener("keydown", this._keyHandler);
  }
  disconnectedCallback() {
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    document.removeEventListener("keydown", this._keyHandler);
    super.disconnectedCallback();
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (body?.type === "plugins_list") {
      this._entries = body.entries || [];
      this._loading = false;
    }
  }

  _filtered() {
    const q = this._query.trim().toLowerCase();
    return this._entries.filter((e) => {
      if (this._format !== "all" && e.format !== this._format) return false;
      if (this._role   !== "all" && e.role   !== this._role)   return false;
      if (!q) return true;
      return (e.name || "").toLowerCase().includes(q)
          || (e.vendor || "").toLowerCase().includes(q);
    });
  }

  _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  _onBackdrop(ev) {
    if (ev.target === this) this._close();
  }

  _insert(p) {
    const ws = window.__foyer?.ws;
    if (!ws || !this.trackId || !p?.uri) return;
    ws.send({
      type: "add_plugin",
      track_id: this.trackId,
      plugin_uri: p.uri,
    });
    this._close();
  }

  _rescan() {
    window.__foyer?.ws?.send({ type: "invoke_action", id: "plugin.rescan" });
    this._loading = true;
    // Ask the backend to re-list after a short delay so users get the
    // fresh catalog once the shim-side scan completes.
    setTimeout(() => {
      window.__foyer?.ws?.send({ type: "list_plugins" });
    }, 500);
  }

  render() {
    const filtered = this._filtered();
    const byRole = {};
    for (const e of filtered) (byRole[e.role || "other"] ||= []).push(e);
    return html`
      <div class="card" @click=${(e) => e.stopPropagation()}>
        <header>
          <h2>Insert plugin</h2>
          <span class="target">→ ${this.trackName || this.trackId || "track"}</span>
          <button class="close" title="Close" @click=${this._close}>${icon("x-mark", 16)}</button>
        </header>
        <div class="toolbar">
          <div class="search">
            ${icon("magnifying-glass", 14)}
            <input type="text" autofocus placeholder="Search plugins…"
                   .value=${this._query}
                   @input=${(e) => { this._query = e.currentTarget.value; }}>
          </div>
          <select @change=${(e) => { this._format = e.currentTarget.value; }}>
            <option value="all">All formats</option>
            <option value="lv2">LV2</option>
            <option value="vst3">VST3</option>
            <option value="vst2">VST2</option>
            <option value="au">AU</option>
            <option value="internal">Internal</option>
          </select>
          <select @change=${(e) => { this._role = e.currentTarget.value; }}>
            <option value="all">All roles</option>
            <option value="effect">Effect</option>
            <option value="instrument">Instrument</option>
            <option value="generator">Generator</option>
            <option value="analyzer">Analyzer</option>
            <option value="utility">Utility</option>
          </select>
        </div>
        <div class="list">
          ${this._loading && this._entries.length === 0
            ? html`<div class="status">Loading catalog…</div>`
            : filtered.length === 0
              ? html`<div class="empty">No plugins match.</div>`
              : Object.entries(byRole).map(([role, items]) => html`
                  <div class="group-title">${role} (${items.length})</div>
                  ${items.map((p) => html`
                    <div class="row" @click=${() => this._insert(p)}>
                      ${icon("puzzle-piece", 16)}
                      <div>
                        <div class="name">${p.name}</div>
                        <div class="vendor">${p.vendor || ""}</div>
                      </div>
                      <div class="badges">
                        <span class="badge">${p.format}</span>
                        <span class="badge">${p.role}</span>
                      </div>
                    </div>
                  `)}
                `)
          }
        </div>
        <footer>
          ${this._entries.length} plugins in catalog
          <span class="spacer"></span>
          <button @click=${this._rescan} title="Ask the host DAW to rescan its plugin directories">Rescan</button>
          <button @click=${this._close}>Close</button>
        </footer>
      </div>
    `;
  }

  createRenderRoot() {
    const root = super.createRenderRoot();
    this.addEventListener("click", (e) => this._onBackdrop(e));
    return root;
  }
}
customElements.define("foyer-plugin-picker-modal", PluginPickerModal);

/** Convenience: open the modal as a detached overlay attached to
 * `<body>`, anchored to the given track. Returns a `close()` handle. */
export function openPluginPicker({ trackId, trackName }) {
  const el = document.createElement("foyer-plugin-picker-modal");
  el.trackId = trackId || "";
  el.trackName = trackName || "";
  const close = () => { el.remove(); };
  el.addEventListener("close", close);
  document.body.appendChild(el);
  return close;
}
