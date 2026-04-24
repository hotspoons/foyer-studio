// Right-hand dock region. Holds pinnable panels — actions (menu tree),
// a notes/preview panel, and a slot for the agent when it's docked there.
// Collapsible + resizable. Persists open state + width in localStorage.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { scrollbarStyles } from "foyer-ui-core/shared-styles.js";
import "foyer-ui-core/widgets/window-list.js";

const VIEW_ICON = {
  mixer: "adjustments-horizontal",
  timeline: "list-bullet",
  plugins: "puzzle-piece",
  session: "folder-open",
  preview: "document",
  plugin_panel: "puzzle-piece",
};

export class RightDock extends LitElement {
  static properties = {
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

  `;

  constructor() {
    super();
    this._minimized = [];
    this._dropHighlight = false;
    this._storeHandler = () => this.requestUpdate();
    this._layoutHandler = () => this._refreshMinimized();
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.store?.addEventListener("change", this._storeHandler);
    window.__foyer?.layout?.addEventListener("change", this._layoutHandler);
    // Expose self on the global so shadow-DOM-hidden siblings (FABs,
    // tile-leaf tear-outs) can call methods on us without trying to
    // querySelector past a shadow root boundary.
    if (window.__foyer) window.__foyer.rightDock = this;
    this._refreshMinimized();
  }
  disconnectedCallback() {
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

  /** Fire after any change that affects how much horizontal space the
   *  dock consumes, so layouts that reserve the workspace rect can
   *  reflow on this tick. Still useful for external listeners even
   *  though the rail itself no longer resizes — docked FAB panels
   *  appear to the left of the rail and may overlap with floats.
   */
  _announceDockChanged() {
    this.dispatchEvent(
      new CustomEvent("resize", { bubbles: true, composed: true })
    );
    window.dispatchEvent(new CustomEvent("foyer:dock-resized"));
  }

  render() {
    // The right-dock is now rail-only — docked FABs render their
    // own panels (see `chat-panel.js#_renderPanelBody({compact:true})`
    // + `quadrant-fab.js#_renderDockedPanel()`). The rail lists docked
    // FABs first, then a separator, then minimized floats.
    return html`
      <div class="rail">
        ${this._renderDockedFabs({ leadingSep: false })}
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

  _renderDockedFabs({ leadingSep = true } = {}) {
    const fabs = window.__foyer?.layout?.dockedFabs?.() || [];
    if (fabs.length === 0) return null;
    // Stable, deterministic order so the rail doesn't reshuffle on
    // reload — docked FABs come in via Map iteration order which
    // reflects registration order (non-deterministic across dynamic
    // imports). Core/app-critical FABs pinned to the top.
    const ORDER = [
      "foyer.actions",
      "foyer.session-info",
      "foyer.windows",
      "foyer.agent",
      "foyer.chat",
      "foyer.layout-fab.v1",
    ];
    const rank = (id) => {
      const i = ORDER.indexOf(id);
      return i < 0 ? ORDER.length : i;
    };
    const sorted = [...fabs].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
    return html`
      ${leadingSep ? html`<div class="rail-sep"></div>` : null}
      ${sorted.map(
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
        // Tap: let the FAB render its OWN docked panel (pos:fixed,
        // anchored next to the rail). We used to render the FAB's
        // content inside the right-dock's own panel div, but that
        // stripped the FAB's shadow-DOM styles and produced double
        // headers. Delegating keeps the docked presentation visually
        // identical to the floating one and makes tear-out a
        // simple state flip.
        const fab = window.__foyer?.layout?.fabInstance?.(id);
        if (fab) {
          // Close any other docked FAB panels so only one is up at
          // a time — matches the old "slide-out" panel feel.
          const others = (window.__foyer?.layout?.dockedFabs?.() || [])
            .filter((f) => f.id !== id);
          for (const o of others) {
            const otherFab = window.__foyer?.layout?.fabInstance?.(o.id);
            if (otherFab?._open) otherFab.closeFromDock?.();
          }
          fab.toggleFromDock?.(iconTop);
          if (fab._open) fab.onDockPanelOpen?.();
          this._announceDockChanged();
        }
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
    // Collapse the FAB's own docked panel — it's about to fly away
    // as a floating button, and leaving `_open=true` would leave a
    // ghost copy pinned at the old rail anchor.
    if (fab?._open) fab.closeFromDock?.();
    this._announceDockChanged();
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
    // Right-click undocks the FAB and closes its docked panel. Same
    // effect as drag-off but via keyboard-friendly gesture.
    window.__foyer?.layout?.undockFab(id);
    const fab = window.__foyer?.layout?.fabInstance?.(id);
    fab?.closeFromDock?.();
    this._announceDockChanged();
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
    // Docked FABs render their own pos:fixed panel next to the rail
    // (anchored via their `_dockStyle()` / `_renderDockedPanel()` —
    // see `quadrant-fab.js` + `chat-panel.js`). The right-dock's own
    // panel is no longer used for anything post-FAB-migration.
    return null;
  }
}
customElements.define("foyer-right-dock", RightDock);
