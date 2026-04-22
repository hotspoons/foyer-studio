// Plugins manager — lists the host's plugin catalog. Search bar, format/role
// filters, grouped by role. Clicking a plugin is a TODO (insert into selected
// track), flagged as a placeholder.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";

export class PluginsView extends LitElement {
  static properties = {
    _entries: { state: true, type: Array },
    _query:   { state: true, type: String },
    _format:  { state: true, type: String },
    _role:    { state: true, type: String },
  };

  static styles = css`
    :host { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
    .toolbar {
      display: flex; gap: 10px; align-items: center;
      padding: 8px 14px;
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
    }
    .search {
      flex: 1 1 320px;
      display: flex; align-items: center; gap: 6px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 4px 8px;
      color: var(--color-text-muted);
    }
    .search input {
      flex: 1; background: transparent; border: 0; outline: none;
      font: inherit; font-family: var(--font-sans); font-size: 12px;
      color: var(--color-text);
    }
    select {
      background: var(--color-surface-elevated);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 3px 6px;
      font: inherit; font-size: 11px;
    }
    .list { flex: 1; overflow: auto; padding: 10px 14px; }
    .group-title {
      font-size: 11px; font-weight: 600; letter-spacing: 0.1em;
      text-transform: uppercase; color: var(--color-text-muted);
      margin: 10px 0 6px;
    }
    .card {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 12px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      margin-bottom: 6px;
      transition: all 0.15s ease;
      cursor: pointer;
    }
    .card:hover {
      border-color: var(--color-accent);
      transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(99, 102, 241, 0.2);
    }
    .card .name { font-weight: 600; color: var(--color-text); font-size: 12px; }
    .card .vendor { font-size: 10px; color: var(--color-text-muted); }
    .card .badges { display: flex; gap: 4px; margin-left: auto; }
    .badge {
      font-size: 9px; font-weight: 600; letter-spacing: 0.08em;
      text-transform: uppercase; padding: 2px 6px;
      border-radius: var(--radius-sm);
      background: var(--color-surface-muted);
      color: var(--color-text-muted);
    }
    .empty {
      padding: 24px;
      color: var(--color-text-muted);
      font-size: 13px;
    }
  `;

  constructor() {
    super();
    this._entries = [];
    this._query = "";
    this._format = "all";
    this._role = "all";
    this._envelopeHandler = (ev) => this._onEnvelope(ev.detail);
  }

  connectedCallback() {
    super.connectedCallback();
    const ws = window.__foyer?.ws;
    if (ws) {
      ws.addEventListener("envelope", this._envelopeHandler);
      ws.send({ type: "list_plugins" });
    }
  }
  disconnectedCallback() {
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    super.disconnectedCallback();
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (body?.type === "plugins_list") {
      this._entries = body.entries || [];
    }
  }

  _filtered() {
    const q = this._query.trim().toLowerCase();
    return this._entries.filter(e => {
      if (this._format !== "all" && e.format !== this._format) return false;
      if (this._role !== "all" && e.role !== this._role) return false;
      if (!q) return true;
      return e.name.toLowerCase().includes(q) || (e.vendor || "").toLowerCase().includes(q);
    });
  }

  render() {
    const filtered = this._filtered();
    const byRole = {};
    for (const e of filtered) (byRole[e.role] ||= []).push(e);
    return html`
      <div class="toolbar">
        <div class="search">
          ${icon("magnifying-glass", 14)}
          <input
            type="text"
            placeholder="Search plugins…"
            .value=${this._query}
            @input=${(e) => { this._query = e.currentTarget.value; }}>
        </div>
        <label style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--color-text-muted)">Format
          <select @change=${(e) => { this._format = e.currentTarget.value; }}>
            <option value="all">All</option>
            <option value="lv2">LV2</option>
            <option value="vst3">VST3</option>
            <option value="vst2">VST2</option>
            <option value="au">AU</option>
            <option value="ladspa">LADSPA</option>
            <option value="lua">Lua</option>
            <option value="internal">Internal</option>
          </select>
        </label>
        <label style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--color-text-muted)">Role
          <select @change=${(e) => { this._role = e.currentTarget.value; }}>
            <option value="all">All</option>
            <option value="effect">Effect</option>
            <option value="instrument">Instrument</option>
            <option value="generator">Generator</option>
            <option value="analyzer">Analyzer</option>
            <option value="utility">Utility</option>
          </select>
        </label>
      </div>
      <div class="list">
        ${filtered.length === 0
          ? html`<div class="empty">No plugins match.</div>`
          : Object.entries(byRole).map(([role, items]) => html`
              <div class="group-title">${role} (${items.length})</div>
              ${items.map(p => this._renderCard(p))}
            `)}
      </div>
    `;
  }

  _renderCard(p) {
    return html`
      <div class="card" @click=${() => this._select(p)}>
        ${icon("puzzle-piece", 18)}
        <div>
          <div class="name">${p.name}</div>
          <div class="vendor">${p.vendor || ""}</div>
        </div>
        <div class="badges">
          <span class="badge">${p.format}</span>
          <span class="badge">${p.role}</span>
        </div>
      </div>
    `;
  }

  _select(p) {
    // Placeholder — "insert into selected track" lands with plugin-insert
    // commands.
    this.dispatchEvent(new CustomEvent("plugin-select", {
      detail: p, bubbles: true, composed: true,
    }));
  }
}
customElements.define("foyer-plugins-view", PluginsView);
