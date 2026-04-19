// Right-hand dock region. Holds pinnable panels — actions (menu tree),
// a notes/preview panel, and a slot for the agent when it's docked there.
// Collapsible + resizable. Persists open state + width in localStorage.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";

const KEY = "foyer.rightdock.v1";

const VIEW_ICON = {
  mixer: "adjustments-horizontal",
  timeline: "list-bullet",
  plugins: "puzzle-piece",
  session: "folder-open",
  preview: "document",
  plugin_panel: "puzzle-piece",
};

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { return {}; }
}
function save(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

export class RightDock extends LitElement {
  static properties = {
    _open:   { state: true, type: Boolean },
    _width:  { state: true, type: Number },
    _panel:  { state: true, type: String },
    _actions:{ state: true, type: Array },
    _minimized: { state: true, type: Array },
    _dropHighlight: { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      display: flex;
      height: 100%;
      background: var(--color-surface);
      border-left: 1px solid var(--color-border);
    }
    :host([collapsed]) { border-left: 0; }

    .rail {
      display: flex; flex-direction: column; align-items: center;
      gap: 4px;
      padding: 8px 4px;
      background: var(--color-surface);
      border-left: 1px solid var(--color-border);
    }
    .rail button {
      width: 32px; height: 32px;
      display: flex; align-items: center; justify-content: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--color-text-muted);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .rail button:hover {
      color: var(--color-text);
      border-color: var(--color-border);
    }
    .rail button.active {
      color: #fff;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      border-color: transparent;
    }

    /* Drop-target hint when a window is being dragged. */
    :host([drop-ready]) .rail {
      outline: 2px dashed color-mix(in oklab, var(--color-accent) 60%, transparent);
      outline-offset: -2px;
    }

    /* Divider between dock-icons (minimized floats) and primary rail buttons. */
    .rail-sep {
      width: 24px;
      height: 1px;
      background: var(--color-border);
      opacity: 0.5;
      margin: 4px 0;
    }
    .rail button.dock-icon {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.08em;
    }

    .panel {
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--color-border);
      overflow: hidden;
      min-width: 180px;
    }
    header {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
      font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--color-text-muted);
      font-family: var(--font-sans); font-weight: 600;
    }
    .content { flex: 1; overflow: auto; padding: 8px 10px; font-family: var(--font-sans); }

    .action-group-title {
      font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--color-text-muted);
      margin: 8px 0 2px;
    }
    .action-item {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 6px;
      font-size: 11px; color: var(--color-text);
      cursor: pointer;
      border-radius: var(--radius-sm);
    }
    .action-item:hover { background: var(--color-surface-elevated); color: var(--color-accent-3); }

    .resize {
      width: 4px; cursor: col-resize;
      background: transparent;
    }
    .resize:hover { background: var(--color-accent); }
  `;

  constructor() {
    super();
    const s = load();
    this._open = s.open !== false;
    this._width = s.width || 280;
    this._panel = s.panel || "actions";
    this._actions = [];
    this._minimized = [];
    this._dropHighlight = false;
    this._envelopeHandler = (ev) => this._onEnvelope(ev.detail);
    this._storeHandler = () => this.requestUpdate();
    this._layoutHandler = () => this._refreshMinimized();
    this._updateAttrs();
  }

  connectedCallback() {
    super.connectedCallback();
    const ws = window.__foyer?.ws;
    if (ws) {
      ws.addEventListener("envelope", this._envelopeHandler);
      ws.send({ type: "list_actions" });
    }
    window.__foyer?.store?.addEventListener("change", this._storeHandler);
    window.__foyer?.layout?.addEventListener("change", this._layoutHandler);
    this._refreshMinimized();
  }
  disconnectedCallback() {
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    window.__foyer?.store?.removeEventListener("change", this._storeHandler);
    window.__foyer?.layout?.removeEventListener("change", this._layoutHandler);
    super.disconnectedCallback();
  }

  _refreshMinimized() {
    const entries = window.__foyer?.layout?.floating?.() || [];
    this._minimized = entries.filter((e) => e.minimized);
  }

  /** Rect of the rail, used by floating-tiles to hit-test for rail docking. */
  railRect() {
    const rail = this.renderRoot?.querySelector(".rail");
    return rail ? rail.getBoundingClientRect() : null;
  }

  setDropHighlight(on) {
    this._dropHighlight = !!on;
    if (on) this.setAttribute("drop-ready", "");
    else this.removeAttribute("drop-ready");
  }

  /** Minimize the given floating window and stash it in the rail. */
  dockFloat(id) {
    window.__foyer?.layout?.floatSet(id, { minimized: true });
  }

  _updateAttrs() {
    if (this._open) this.removeAttribute("collapsed");
    else this.setAttribute("collapsed", "");
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (body?.type === "actions_list") this._actions = body.actions || [];
  }

  _persist() {
    save({ open: this._open, width: this._width, panel: this._panel });
  }

  _toggle(panel) {
    if (this._open && this._panel === panel) {
      this._open = false;
    } else {
      this._open = true;
      this._panel = panel;
    }
    this._updateAttrs();
    this._persist();
    this.dispatchEvent(new CustomEvent("resize", { bubbles: true, composed: true }));
  }

  _startResize(ev) {
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = this._width;
    const move = (e) => {
      const dx = startX - e.clientX;
      this._width = Math.max(200, Math.min(600, startW + dx));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this._persist();
      this.dispatchEvent(new CustomEvent("resize", { bubbles: true, composed: true }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  render() {
    const style = this._open ? `width:${this._width}px` : "width:0";
    return html`
      ${this._open ? html`
        <div class="resize" @pointerdown=${this._startResize}></div>
        <div class="panel" style=${style}>
          ${this._renderPanel()}
        </div>
      ` : null}
      <div class="rail">
        <button class=${this._open && this._panel === "actions" ? "active" : ""}
                @click=${() => this._toggle("actions")} title="Actions">
          ${icon("list-bullet", 16)}
        </button>
        <button class=${this._open && this._panel === "session" ? "active" : ""}
                @click=${() => this._toggle("session")} title="Session info">
          ${icon("folder-open", 16)}
        </button>
        ${this._renderDockedFabs()}
        ${this._minimized.length ? html`<div class="rail-sep"></div>` : null}
        ${this._minimized.map(
          (e) => html`
            <button
              class="dock-icon"
              title="Restore ${this._labelFor(e)}"
              @click=${() => window.__foyer?.layout?.floatSet(e.id, { minimized: false })}
              @contextmenu=${(ev) => this._onDockContextMenu(ev, e)}
            >
              ${icon(VIEW_ICON[e.view] || "document", 16)}
            </button>
          `
        )}
      </div>
    `;
  }

  _renderDockedFabs() {
    const fabs = window.__foyer?.layout?.dockedFabs?.() || [];
    if (fabs.length === 0) return null;
    return html`
      <div class="rail-sep"></div>
      ${fabs.map(
        ({ id, meta }) => html`
          <button
            class="dock-icon fab-dock"
            title="${meta.label || id} — click to open · right-click to undock"
            @click=${(ev) => this._onFabIconClick(ev, id)}
            @contextmenu=${(ev) => this._onFabIconContext(ev, id)}
          >
            ${icon(meta.icon || "squares-2x2", 16)}
          </button>
        `
      )}
    `;
  }

  _onFabIconClick(ev, id) {
    const top = ev.currentTarget.getBoundingClientRect().top;
    // Find the FAB component that registered this id.
    const fab = this._findFabInstance(id);
    fab?.toggleFromDock?.(top);
  }

  _onFabIconContext(ev, id) {
    ev.preventDefault();
    // Right-click undocks, popping the FAB back to its last free position.
    window.__foyer?.layout?.undockFab(id);
    const fab = this._findFabInstance(id);
    fab?.closeFromDock?.();
  }

  _findFabInstance(storageKey) {
    // Scan custom elements that extend QuadrantFab by their `storageKey`.
    const candidates = document.querySelectorAll("*");
    for (const el of candidates) {
      if (el.storageKey === storageKey && typeof el.toggleFromDock === "function") {
        return el;
      }
    }
    return null;
  }

  _labelFor(e) {
    if (e.view === "plugin_panel") {
      const pid = e.props?.plugin_id;
      const session = window.__foyer?.store?.state?.session;
      if (pid && session) {
        for (const t of session.tracks || []) {
          for (const p of t.plugins || []) {
            if (p.id === pid) return p.name;
          }
        }
      }
      return "Plugin";
    }
    return e.view;
  }

  _onDockContextMenu(ev, e) {
    ev.preventDefault();
    // Close the floating window entirely.
    window.__foyer?.layout?.removeFloat(e.id);
  }

  _renderPanel() {
    if (this._panel === "actions") return this._renderActions();
    if (this._panel === "session") return this._renderSession();
    return null;
  }

  _renderActions() {
    const byCat = {};
    for (const a of this._actions) (byCat[a.category] ||= []).push(a);
    const cats = Object.keys(byCat).sort();
    return html`
      <header>Actions</header>
      <div class="content">
        ${cats.map(c => html`
          <div class="action-group-title">${c}</div>
          ${byCat[c].map(a => html`
            <div class="action-item" @click=${() => window.__foyer.ws.send({ type: "invoke_action", id: a.id })}>
              <span style="flex:1">${a.label}</span>
              ${a.shortcut ? html`<span style="font-family:var(--font-mono);font-size:10px;color:var(--color-text-muted)">${a.shortcut}</span>` : null}
            </div>
          `)}
        `)}
      </div>
    `;
  }

  _renderSession() {
    const s = window.__foyer?.store?.state.session;
    if (!s) return html`<header>Session</header><div class="content" style="color:var(--color-text-muted)">No session loaded.</div>`;
    return html`
      <header>Session</header>
      <div class="content" style="font-family:var(--font-mono);font-size:11px">
        <div>schema: ${s.schema_version?.[0]}.${s.schema_version?.[1]}</div>
        <div>tracks: ${s.tracks?.length ?? 0}</div>
        ${s.tracks?.map(t => html`
          <div style="margin-top:8px">
            <div style="color:var(--color-accent-3);font-weight:600">${t.name}</div>
            <div style="color:var(--color-text-muted)">${t.kind} · ${t.id}</div>
          </div>
        `)}
      </div>
    `;
  }
}
customElements.define("foyer-right-dock", RightDock);
