// Right-hand dock region. Holds pinnable panels — actions (menu tree),
// a notes/preview panel, and a slot for the agent when it's docked there.
// Collapsible + resizable. Persists open state + width in localStorage.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { scrollbarStyles } from "foyer-ui-core/shared-styles.js";
import "foyer-ui-core/widgets/window-list.js";

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
    ${scrollbarStyles}
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
    // Expose self on the global so shadow-DOM-hidden siblings (FABs,
    // tile-leaf tear-outs) can call methods on us without trying to
    // querySelector past a shadow root boundary.
    if (window.__foyer) window.__foyer.rightDock = this;
    this._refreshMinimized();
  }
  disconnectedCallback() {
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    window.__foyer?.store?.removeEventListener("change", this._storeHandler);
    window.__foyer?.layout?.removeEventListener("change", this._layoutHandler);
    if (window.__foyer?.rightDock === this) window.__foyer.rightDock = null;
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

  /**
   * Rect of the ENTIRE right-dock surface, rail + expanded panel +
   * anything else we render. The workspace uses this to compute the
   * usable area — when the dock's panel opens, the workspace shrinks,
   * and docked floats re-flow to match.
   */
  outerRect() {
    return this.getBoundingClientRect();
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

  /** Fire after any change that affects how much horizontal space the
   *  dock consumes, so layouts that reserve the workspace rect can
   *  reflow on this tick. */
  _announceDockChanged() {
    this.dispatchEvent(
      new CustomEvent("resize", { bubbles: true, composed: true })
    );
    window.dispatchEvent(new CustomEvent("foyer:dock-resized"));
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
    this._announceDockChanged();
  }

  _startResize(ev) {
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = this._width;
    const move = (e) => {
      const dx = startX - e.clientX;
      this._width = Math.max(200, Math.min(600, startW + dx));
      // Announce mid-drag so slot-clamped floats ride the resize live
      // instead of only snapping into the new size on release.
      this._announceDockChanged();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this._persist();
      this._announceDockChanged();
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
        <button class=${this._open && this._panel === "windows" ? "active" : ""}
                @click=${() => this._toggle("windows")}
                title="Open windows — click to focus, × to close">
          ${icon("squares-2x2", 16)}
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
            title="${meta.label || id} — click to open · drag off rail to undock · right-click menu"
            @pointerdown=${(ev) => this._onFabIconPointerDown(ev, id)}
            @contextmenu=${(ev) => this._onFabIconContext(ev, id)}
          >
            ${icon(meta.icon || "squares-2x2", 16)}
          </button>
        `
      )}
    `;
  }

  /**
   * Unified pointer handler: a small drag is a click (open panel); a
   * big drag off the rail tears the FAB out as a floating button again.
   */
  _onFabIconPointerDown(ev, id) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const iconTop = ev.currentTarget.getBoundingClientRect().top;
    const TEAR_THRESHOLD = 18;
    let tore = false;

    const move = (e) => {
      if (tore) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Drag left off the rail (dx < -threshold) or any distance past
      // threshold squared → tear out.
      if (dx < -TEAR_THRESHOLD || dx * dx + dy * dy > TEAR_THRESHOLD * TEAR_THRESHOLD) {
        tore = true;
        cleanup();
        this._tearFabFromRail(id, e.clientX, e.clientY);
      }
    };
    const up = () => {
      if (!tore) {
        // It was a tap — open the FAB's content inside the right-dock
        // panel, matching the Actions / Session / Windows pattern.
        // Old behavior (floating popover anchored to the rail icon)
        // is still reachable via the FAB's own `openFromDock` for
        // FABs that opt out of dock-panel rendering.
        this._toggle(`fab:${id}`);
        // Let the FAB know it's been opened from the dock so any
        // one-shot setup (layout presets fetch, agent connect, …)
        // runs exactly once per show.
        const fab = window.__foyer?.layout?.fabInstance?.(id);
        fab?.onDockPanelOpen?.();
        // Best-effort close of the legacy floating panel if it was
        // left open by a prior interaction.
        if (fab?._open) fab.closeFromDock?.();
        void iconTop;
      }
      cleanup();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  /**
   * Undock a rail FAB and keep it glued to the cursor until the user
   * releases. The pointer is already down when this fires, so we hook
   * window-level pointermove/pointerup and drive the FAB's `(right,
   * bottom)` anchors directly — effectively "hand off the drag" without
   * the user having to re-click.
   */
  _tearFabFromRail(id, x, y) {
    const layout = window.__foyer?.layout;
    if (!layout) return;
    const fab = layout.fabInstance?.(id);
    layout.undockFab(id);
    if (!fab) return;

    const size = 48;
    const place = (cx, cy) => {
      const right = Math.max(0, Math.min(window.innerWidth - size, window.innerWidth - cx - size / 2));
      const bottom = Math.max(0, Math.min(window.innerHeight - size, window.innerHeight - cy - size / 2));
      fab._fabRight = right;
      fab._fabBottom = bottom;
      fab._open = false;
      fab.requestUpdate?.();
    };
    place(x, y);

    const move = (e) => place(e.clientX, e.clientY);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      fab._persist?.();
      fab.requestUpdate?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  _onFabIconContext(ev, id) {
    ev.preventDefault();
    // Right-click undocks and closes the popup. Same as drag-off but via
    // keyboard-friendly gesture.
    window.__foyer?.layout?.undockFab(id);
    const fab = window.__foyer?.layout?.fabInstance?.(id);
    fab?.closeFromDock?.();
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
    if (this._panel === "windows") return html`<foyer-window-list></foyer-window-list>`;
    // Docked FABs render their content inline in the dock panel so
    // clicking a docked "Layouts" or "Agent" icon behaves the same as
    // Actions / Session / Windows — slide-out rather than floating
    // popover anchored to the icon.
    if (this._panel?.startsWith("fab:")) {
      const id = this._panel.slice(4);
      const fab = window.__foyer?.layout?.fabInstance?.(id);
      const meta = window.__foyer?.layout?.fabMeta?.(id) || {};
      if (!fab) return html`<header>${meta.label || id}</header>`;
      // Prefer the dedicated `dockPanelContent()` method if the FAB
      // exposes one; fall back to its normal `_renderPanelContent()`.
      const content =
        typeof fab.dockPanelContent === "function"
          ? fab.dockPanelContent()
          : typeof fab._renderPanelContent === "function"
            ? fab._renderPanelContent()
            : html``;
      return html`
        <header>${meta.label || id}</header>
        <div class="content">${content}</div>
      `;
    }
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
