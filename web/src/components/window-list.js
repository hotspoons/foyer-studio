// Global window list.
//
// One surface that shows every open window — floating tiles, minimized
// tiles, docked FABs (Agent / Layouts), and plugin-layer floats — grouped
// by kind. Click a row to raise/restore; the × closes it. Lives in the
// right-dock rail as another panel, reachable via a new icon button.
//
// This is the "where did my mixer go" answer: in a dozen-window mixing
// session, opening this panel tells you instantly what's where and lets
// you jump to anything without hunting behind other windows.

import { LitElement, html, css } from "lit";

import { icon } from "../icons.js";
import { scrollbarStyles } from "../shared-styles.js";

const KIND_META = {
  mixer:        { icon: "adjustments-horizontal", label: "Mixer" },
  timeline:     { icon: "list-bullet",            label: "Timeline" },
  plugins:      { icon: "puzzle-piece",           label: "Plugins" },
  session:      { icon: "folder-open",            label: "Projects" },
  preview:      { icon: "document",               label: "Preview" },
  plugin_panel: { icon: "puzzle-piece",           label: "Plugin" },
};

export class WindowList extends LitElement {
  static properties = {
    _refreshTick: { state: true, type: Number },
  };

  static styles = [
    scrollbarStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        font-family: var(--font-sans);
        color: var(--color-text);
        font-size: 11px;
      }
      header {
        padding: 8px 12px;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-surface-elevated);
        font-size: 10px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--color-text-muted);
        font-weight: 600;
      }
      .content {
        flex: 1 1 auto;
        overflow: auto;
        padding: 6px 4px;
      }
      .group {
        margin: 4px 0 8px;
      }
      .group-title {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 8px;
        color: var(--color-accent-3);
        font-size: 9px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        font-weight: 600;
      }
      .group-title .count {
        margin-left: auto;
        color: var(--color-text-muted);
        font-family: var(--font-mono);
        font-weight: 500;
        letter-spacing: 0;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 8px;
        margin: 1px 4px;
        border-radius: var(--radius-sm);
        cursor: pointer;
        transition: background 0.1s ease, color 0.1s ease;
      }
      .row:hover {
        background: color-mix(in oklab, var(--color-accent) 20%, transparent);
      }
      .row.active {
        background: color-mix(in oklab, var(--color-accent) 14%, transparent);
        color: var(--color-accent-3);
      }
      .row .icon-chip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px; height: 18px;
        border-radius: 4px;
        color: var(--color-accent-3);
        flex: 0 0 auto;
      }
      .row .label {
        flex: 1 1 auto;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .row .tag {
        font-family: var(--font-mono);
        font-size: 9px;
        color: var(--color-text-muted);
        padding: 1px 5px;
        border: 1px solid color-mix(in oklab, var(--color-border) 70%, transparent);
        border-radius: 3px;
      }
      .row button {
        background: transparent;
        border: 0;
        color: var(--color-text-muted);
        padding: 2px 4px;
        border-radius: var(--radius-sm);
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.1s ease, color 0.1s ease;
      }
      .row:hover button { opacity: 1; }
      .row button:hover { color: var(--color-danger); }
      .empty {
        padding: 14px;
        color: var(--color-text-muted);
        font-style: italic;
        text-align: center;
      }
    `,
  ];

  constructor() {
    super();
    this._refreshTick = 0;
    this._onChange = () => { this._refreshTick++; };
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.layout?.addEventListener("change", this._onChange);
  }
  disconnectedCallback() {
    window.__foyer?.layout?.removeEventListener("change", this._onChange);
    super.disconnectedCallback();
  }

  render() {
    void this._refreshTick;
    const layout = window.__foyer?.layout;
    if (!layout) return html`<div class="empty">No layout available.</div>`;

    const floats = layout.floating() || [];
    const pluginFloats = layout.pluginFloats?.() || [];
    const tree = layout.tree;
    const tiles = this._collectTiles(tree);
    const dockedFabs = layout.dockedFabs?.() || [];

    const allEmpty =
      tiles.length === 0 &&
      floats.length === 0 &&
      pluginFloats.length === 0 &&
      dockedFabs.length === 0;

    return html`
      <header>Windows</header>
      <div class="content">
        ${allEmpty
          ? html`<div class="empty">No windows open — use the "New" menu.</div>`
          : html`
              ${this._renderTiles(tiles)}
              ${this._renderFloats(floats)}
              ${this._renderPluginFloats(pluginFloats)}
              ${this._renderDockedFabs(dockedFabs)}
            `}
      </div>
    `;
  }

  _collectTiles(node) {
    const out = [];
    const walk = (n) => {
      if (!n) return;
      if (n.kind === "leaf") out.push(n);
      else (n.children || []).forEach(walk);
    };
    walk(node);
    return out;
  }

  _renderTiles(tiles) {
    if (tiles.length === 0) return null;
    const focusId = window.__foyer?.layout?.focusId;
    return html`
      <div class="group">
        <div class="group-title">
          <span>Tiled</span>
          <span class="count">${tiles.length}</span>
        </div>
        ${tiles.map((t) => {
          const meta = KIND_META[t.view] || { icon: "document", label: t.view };
          return html`
            <div
              class="row ${t.id === focusId ? "active" : ""}"
              @click=${() => window.__foyer.layout.focus(t.id)}
            >
              <span class="icon-chip">${icon(meta.icon, 12)}</span>
              <span class="label">${meta.label}</span>
              <button
                title="Close tile"
                @click=${(ev) => {
                  ev.stopPropagation();
                  window.__foyer.layout.removeLeaf(t.id, { allowEmpty: true });
                }}
              >${icon("x-mark", 10)}</button>
            </div>
          `;
        })}
      </div>
    `;
  }

  _renderFloats(floats) {
    if (floats.length === 0) return null;
    const shown = floats.filter((f) => !f.minimized);
    const minimized = floats.filter((f) => f.minimized);
    return html`
      ${shown.length
        ? html`
            <div class="group">
              <div class="group-title">
                <span>Floating</span>
                <span class="count">${shown.length}</span>
              </div>
              ${shown.map((f) => this._renderFloatRow(f))}
            </div>
          `
        : null}
      ${minimized.length
        ? html`
            <div class="group">
              <div class="group-title">
                <span>Minimized</span>
                <span class="count">${minimized.length}</span>
              </div>
              ${minimized.map((f) => this._renderFloatRow(f, true))}
            </div>
          `
        : null}
    `;
  }

  _renderFloatRow(f, wasMinimized = false) {
    const meta = KIND_META[f.view] || { icon: "document", label: f.view };
    const label = f.view === "plugin_panel"
      ? (this._pluginName(f.props?.plugin_id) || meta.label)
      : meta.label;
    return html`
      <div
        class="row"
        @click=${() => {
          if (wasMinimized) window.__foyer.layout.floatSet(f.id, { minimized: false });
          window.__foyer.layout.raiseFloat(f.id);
        }}
      >
        <span class="icon-chip">${icon(meta.icon, 12)}</span>
        <span class="label">${label}</span>
        ${f.slot ? html`<span class="tag">${f.slot}</span>` : null}
        <button
          title="Close window"
          @click=${(ev) => {
            ev.stopPropagation();
            window.__foyer.layout.removeFloat(f.id);
          }}
        >${icon("x-mark", 10)}</button>
      </div>
    `;
  }

  _renderPluginFloats(entries) {
    if (entries.length === 0) return null;
    const visible = window.__foyer?.layout?.pluginFloatsVisible?.() ?? true;
    return html`
      <div class="group">
        <div class="group-title">
          <span>Plugins ${visible ? "" : "(hidden)"}</span>
          <span class="count">${entries.length}</span>
        </div>
        ${entries.map((e) => {
          const name = this._pluginName(e.plugin_id) || "Plugin";
          return html`
            <div class="row">
              <span class="icon-chip">${icon("puzzle-piece", 12)}</span>
              <span class="label">${name}</span>
              <button
                title="Close plugin window"
                @click=${(ev) => {
                  ev.stopPropagation();
                  window.__foyer.layout.closePluginFloat(e.plugin_id);
                }}
              >${icon("x-mark", 10)}</button>
            </div>
          `;
        })}
      </div>
    `;
  }

  _renderDockedFabs(fabs) {
    if (fabs.length === 0) return null;
    return html`
      <div class="group">
        <div class="group-title">
          <span>Docked FABs</span>
          <span class="count">${fabs.length}</span>
        </div>
        ${fabs.map(
          ({ id, meta }) => html`
            <div
              class="row"
              @click=${() => {
                const fab = window.__foyer.layout.fabInstance(id);
                fab?.toggleFromDock?.(120);
              }}
            >
              <span class="icon-chip">${icon(meta.icon || "squares-2x2", 12)}</span>
              <span class="label">${meta.label || id}</span>
              <button
                title="Undock"
                @click=${(ev) => {
                  ev.stopPropagation();
                  window.__foyer.layout.undockFab(id);
                }}
              >${icon("arrow-top-right-on-square", 10)}</button>
            </div>
          `
        )}
      </div>
    `;
  }

  _pluginName(pluginId) {
    if (!pluginId) return "";
    const session = window.__foyer?.store?.state?.session;
    if (!session) return "";
    for (const t of session.tracks || []) {
      for (const p of t.plugins || []) {
        if (p.id === pluginId) return `${t.name} · ${p.name}`;
      }
    }
    return "";
  }
}
customElements.define("foyer-window-list", WindowList);
