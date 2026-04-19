// Shared quadrant-anchored FAB + panel.
//
// Rich's ask: the agent-panel's quadrant-based layout is the right shape for
// Foyer's floating surfaces (layout manager, future ones). Extract the algo
// so every FAB in the app behaves the same way. Subclasses provide the
// FAB icon SVG and the panel body; this class owns drag, resize, and all the
// geometry needed to anchor a panel to the opposite corner of whichever
// quadrant the FAB currently lives in.
//
// Subclass hooks:
//   - `_renderFabContent()` — what goes inside the round FAB
//   - `_renderPanelContent()` — what goes inside the popover panel
//   - `_fabTitle` (prop) — tooltip on the FAB
//   - `_fabAccent` ("accent" | "accent-2") — gradient tone override
//
// Persistence: every instance needs a unique `storageKey` prop so its FAB
// position + panel size survive reloads.

import { LitElement, html, css } from "lit";

const FAB_SIZE = 48;
const GAP = 8;

const DEFAULTS = {
  fabRight: 24,
  fabBottom: 24,
  panelWidth: 360,
  panelHeight: 420,
  open: false,
};

function loadState(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveState(key, s) {
  try {
    localStorage.setItem(key, JSON.stringify(s));
  } catch {}
}

/**
 * Compute panel position and size given FAB coordinates. Returns
 * `{ style, isTop, isLeft }` — a CSS cssText for the panel + quadrant info.
 */
export function computePanelLayout({
  fabRight,
  fabBottom,
  panelWidth,
  panelHeight,
  fabSize = FAB_SIZE,
  gap = GAP,
} = {}) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fabCenterX = vw - fabRight - fabSize / 2;
  const fabCenterY = vh - fabBottom - fabSize / 2;
  const isTop = fabCenterY < vh / 2;
  const isLeft = fabCenterX < vw / 2;
  const fabTop = vh - fabBottom - fabSize;

  const parts = [];
  if (isTop) parts.push(`top:${fabTop + fabSize + gap}px`);
  else parts.push(`bottom:${fabBottom + fabSize + gap}px`);
  if (isLeft) parts.push(`left:${vw - fabRight - fabSize}px`);
  else parts.push(`right:${fabRight}px`);

  const fabLeftEdge = vw - fabRight - fabSize;
  const fabRightEdge = vw - fabRight;
  const maxW = isLeft
    ? Math.max(280, vw - fabLeftEdge - 16)
    : Math.max(280, fabRightEdge - 16);
  const maxH = isTop
    ? Math.max(240, vh - fabTop - fabSize - gap - 16)
    : Math.max(240, vh - fabBottom - fabSize - gap - 16);
  const w = Math.min(panelWidth, maxW);
  const h = Math.min(panelHeight, maxH);
  parts.push(`width:${w}px`, `height:${h}px`);
  return { style: parts.join(";"), isTop, isLeft };
}

export class QuadrantFab extends LitElement {
  static properties = {
    storageKey: { type: String },
    _fabRight: { state: true, type: Number },
    _fabBottom: { state: true, type: Number },
    _panelWidth: { state: true, type: Number },
    _panelHeight: { state: true, type: Number },
    _open: { state: true, type: Boolean },
  };

  static styles = css`
    :host { display: contents; }

    .fab {
      position: fixed;
      width: ${FAB_SIZE}px;
      height: ${FAB_SIZE}px;
      border-radius: 50%;
      color: #fff;
      border: none;
      cursor: grab;
      box-shadow: var(--shadow-fab);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000;
      transition: box-shadow 0.15s ease, transform 0.15s ease;
      touch-action: none;
      user-select: none;
    }
    .fab[data-accent="accent"] {
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
    }
    .fab[data-accent="accent-2"] {
      background: linear-gradient(135deg, var(--color-accent-2), var(--color-accent-3));
    }
    .fab:hover {
      box-shadow: var(--shadow-fab-hover);
      transform: scale(1.04);
    }
    .fab.dragging { cursor: grabbing; transition: none; }
    .fab.open[data-accent="accent"] {
      background: linear-gradient(135deg, var(--color-accent-2), var(--color-accent-3));
    }
    .fab.open[data-accent="accent-2"] {
      background: linear-gradient(135deg, var(--color-accent-3), var(--color-accent));
    }
    .fab svg { width: 22px; height: 22px; stroke: currentColor; fill: none;
               stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

    .panel {
      position: fixed;
      min-width: 280px;
      min-height: 240px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-panel);
      color: var(--color-text);
      z-index: 999;
      overflow: hidden;
      display: flex; flex-direction: column;
    }

    .panel header.grip {
      padding: 10px 12px;
      border-bottom: 1px solid var(--color-border);
      cursor: grab;
      background: linear-gradient(180deg, var(--color-surface-muted), var(--color-surface-elevated));
      font-family: var(--font-sans);
      font-size: 11px; font-weight: 600;
      letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--color-text-muted);
      user-select: none;
    }
    .panel header.grip.dragging { cursor: grabbing; }

    .panel .body { flex: 1 1 auto; min-height: 0; overflow: auto; }

    .resize {
      position: absolute; width: 14px; height: 14px;
      z-index: 2;
    }
    .resize.br { right: 0; bottom: 0; cursor: nwse-resize; }
    .resize.bl { left: 0; bottom: 0; cursor: nesw-resize; }
    .resize.tr { right: 0; top: 0; cursor: nesw-resize; }
    .resize.tl { left: 0; top: 0; cursor: nwse-resize; }
  `;

  constructor() {
    super();
    this.storageKey = "foyer.quadrant-fab";
    this._fabAccent = "accent";
    this._fabTitle = "";
    this._hydrate();
    this._dragState = null;
    this._resizeState = null;
    this._onPointerMove = (ev) => this._onMove(ev);
    this._onPointerUp = (ev) => this._onUp(ev);
    this._onWindowResize = () => this._clamp();
  }

  _hydrate() {
    const s = loadState(this.storageKey);
    this._fabRight = s.fabRight;
    this._fabBottom = s.fabBottom;
    this._panelWidth = s.panelWidth;
    this._panelHeight = s.panelHeight;
    this._open = s.open;
  }

  /** Subclasses supply metadata used by the right-dock rail. */
  _dockMeta() {
    return {
      label: this._fabTitle || "FAB",
      icon: "squares-2x2",
      accent: this._fabAccent,
      expandsRail: false,
    };
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("pointermove", this._onPointerMove);
    window.addEventListener("pointerup", this._onPointerUp);
    window.addEventListener("pointercancel", this._onPointerUp);
    window.addEventListener("resize", this._onWindowResize);
    this._layoutHandler = () => this.requestUpdate();
    window.__foyer?.layout?.addEventListener("change", this._layoutHandler);
    window.__foyer?.layout?.registerFab(this.storageKey, this._dockMeta(), this);
    this._clamp();
  }
  disconnectedCallback() {
    window.removeEventListener("pointermove", this._onPointerMove);
    window.removeEventListener("pointerup", this._onPointerUp);
    window.removeEventListener("pointercancel", this._onPointerUp);
    window.removeEventListener("resize", this._onWindowResize);
    window.__foyer?.layout?.removeEventListener("change", this._layoutHandler);
    window.__foyer?.layout?.unregisterFab(this.storageKey);
    super.disconnectedCallback();
  }

  _isDocked() {
    return !!window.__foyer?.layout?.isFabDocked(this.storageKey);
  }

  _isOverRail(x, y) {
    const rd = window.__foyer?.rightDock;
    const r = rd?.railRect?.();
    return !!(r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  }

  _persist() {
    saveState(this.storageKey, {
      fabRight: this._fabRight,
      fabBottom: this._fabBottom,
      panelWidth: this._panelWidth,
      panelHeight: this._panelHeight,
      open: this._open,
    });
  }

  _clamp() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this._fabRight = Math.max(0, Math.min(vw - FAB_SIZE, this._fabRight));
    this._fabBottom = Math.max(0, Math.min(vh - FAB_SIZE, this._fabBottom));
  }

  // ── subclass hooks ────────────────────────────────────────────────────

  _renderFabContent() {
    return html`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></svg>`;
  }
  _renderPanelContent() {
    return html``;
  }

  render() {
    // When docked to the right rail the button is rendered by <foyer-right-dock>,
    // not here. The panel still lives in this component — but only when the
    // dock has routed us open (via the `open` property).
    if (this._isDocked()) {
      if (!this._open) return html``;
      return this._renderDockedPanel();
    }
    const quadrant = computePanelLayout({
      fabRight: this._fabRight,
      fabBottom: this._fabBottom,
      panelWidth: this._panelWidth,
      panelHeight: this._panelHeight,
    });
    const fabStyle = `right:${this._fabRight}px;bottom:${this._fabBottom}px`;
    return html`
      <button
        class="fab ${this._open ? "open" : ""} ${this._dragState?.kind === "fab" ? "dragging" : ""}"
        style=${fabStyle}
        data-accent=${this._fabAccent}
        title=${this._fabTitle}
        @pointerdown=${(e) => this._onFabDown(e)}
      >
        ${this._renderFabContent()}
      </button>
      ${this._open
        ? html`
            <div
              class="panel"
              style=${quadrant.style}
              @click=${(e) => e.stopPropagation()}
            >
              <header
                class="grip ${this._dragState?.kind === "panel" ? "dragging" : ""}"
                @pointerdown=${(e) => this._onGripDown(e)}
              >
                ${this._fabTitle}
              </header>
              <div class="body">${this._renderPanelContent()}</div>
              ${this._renderResizeHandles(quadrant)}
            </div>
          `
        : null}
    `;
  }

  /** Rendered as a pop-out sheet anchored to the right-dock rail when docked. */
  _renderDockedPanel() {
    const rd = window.__foyer?.rightDock;
    const rail = rd?.railRect?.();
    const right = rail ? window.innerWidth - rail.left + 8 : 60;
    const top = Math.max(16, this._dockIconTop || 120);
    const w = Math.max(280, Math.min(this._panelWidth, window.innerWidth - right - 16));
    const h = Math.max(240, Math.min(this._panelHeight, window.innerHeight - top - 16));
    const style = `right:${right}px;top:${top}px;width:${w}px;height:${h}px`;
    return html`
      <div class="panel" style=${style} @click=${(e) => e.stopPropagation()}>
        <header class="grip" style="cursor:default;display:flex;align-items:center;gap:8px">
          <span style="flex:1">${this._fabTitle}</span>
          <button
            title="Undock — return to floating FAB"
            @click=${() => this._undock()}
            style="background:transparent;border:1px solid var(--color-border);border-radius:var(--radius-sm);color:var(--color-text-muted);font-size:10px;padding:2px 8px;cursor:pointer;font-family:var(--font-sans);letter-spacing:0.06em;text-transform:uppercase"
          >Undock</button>
          <button
            title="Close"
            @click=${() => this.closeFromDock()}
            style="background:transparent;border:1px solid transparent;border-radius:var(--radius-sm);color:var(--color-text-muted);padding:2px 6px;cursor:pointer;font-size:14px;line-height:1"
          >×</button>
        </header>
        <div class="body">${this._renderPanelContent()}</div>
      </div>
    `;
  }

  /** Pop this FAB out of the rail and restore it to its last floating
   *  position. Used by the Undock button in the docked-panel header. */
  _undock() {
    const layout = window.__foyer?.layout;
    if (!layout) return;
    layout.undockFab(this.storageKey);
    this._open = false;
    this._persist();
    this.requestUpdate();
  }

  /** Called by the right-dock when the user clicks this FAB's rail icon. */
  openFromDock(iconTop) {
    this._dockIconTop = iconTop;
    this._open = true;
    this._persist();
    this.requestUpdate();
  }
  closeFromDock() {
    this._open = false;
    this._persist();
    this.requestUpdate();
  }
  toggleFromDock(iconTop) {
    if (this._open) this.closeFromDock();
    else this.openFromDock(iconTop);
  }

  _renderResizeHandles(q) {
    // Place a single handle at the panel corner facing away from the FAB.
    const corner = `${q.isTop ? "b" : "t"}${q.isLeft ? "r" : "l"}`;
    return html`<div class="resize ${corner}" @pointerdown=${(e) => this._onResizeDown(e, corner)}></div>`;
  }

  // ── pointer handling ──────────────────────────────────────────────────

  _onFabDown(ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.currentTarget.setPointerCapture(ev.pointerId);
    this._dragState = {
      kind: "fab",
      startX: ev.clientX,
      startY: ev.clientY,
      origRight: this._fabRight,
      origBottom: this._fabBottom,
      moved: false,
    };
    this.requestUpdate();
  }

  _onGripDown(ev) {
    ev.preventDefault();
    this._dragState = {
      kind: "panel",
      startX: ev.clientX,
      startY: ev.clientY,
      origRight: this._fabRight,
      origBottom: this._fabBottom,
    };
    this.requestUpdate();
  }

  _onResizeDown(ev, corner) {
    ev.preventDefault();
    ev.stopPropagation();
    this._resizeState = {
      corner,
      startX: ev.clientX,
      startY: ev.clientY,
      origW: this._panelWidth,
      origH: this._panelHeight,
    };
  }

  _onMove(ev) {
    if (this._dragState?.kind === "fab" || this._dragState?.kind === "panel") {
      const ds = this._dragState;
      const dx = ev.clientX - ds.startX;
      const dy = ev.clientY - ds.startY;
      if (ds.kind === "fab" && !ds.moved && Math.hypot(dx, dy) > 4) ds.moved = true;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      this._fabRight = Math.max(0, Math.min(vw - FAB_SIZE, ds.origRight - dx));
      this._fabBottom = Math.max(0, Math.min(vh - FAB_SIZE, ds.origBottom - dy));
      // Rail hover highlight so the user can see the drop target.
      const over = this._isOverRail(ev.clientX, ev.clientY);
      window.__foyer?.rightDock?.setDropHighlight?.(over);
      this.requestUpdate();
    } else if (this._resizeState) {
      const rs = this._resizeState;
      const dx = ev.clientX - rs.startX;
      const dy = ev.clientY - rs.startY;
      // Grow AWAY from the FAB: if corner is "br" (bottom-right), dragging
      // right/down grows width/height.
      const wSign = rs.corner.includes("r") ? 1 : -1;
      const hSign = rs.corner.includes("b") ? 1 : -1;
      this._panelWidth = Math.max(280, rs.origW + dx * wSign);
      this._panelHeight = Math.max(240, rs.origH + dy * hSign);
      this.requestUpdate();
    }
  }

  _onUp(ev) {
    if (this._dragState?.kind === "fab") {
      const wasMoved = this._dragState.moved;
      this._dragState = null;
      if (!wasMoved) {
        // Tap: toggle.
        this._toggle();
      } else if (ev && this._isOverRail(ev.clientX, ev.clientY)) {
        // Drop over the right-dock rail → dock.
        window.__foyer?.rightDock?.setDropHighlight?.(false);
        window.__foyer?.layout?.dockFab(this.storageKey);
        this._open = false;
      } else {
        window.__foyer?.rightDock?.setDropHighlight?.(false);
      }
      this._persist();
      this.requestUpdate();
    } else if (this._dragState?.kind === "panel") {
      this._dragState = null;
      this._persist();
    } else if (this._resizeState) {
      this._resizeState = null;
      this._persist();
    }
  }

  _toggle() {
    this._open = !this._open;
    this._persist();
  }
}
