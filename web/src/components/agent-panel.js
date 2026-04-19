// Floating quadrant-based agent panel + draggable FAB.
//
// Adapted from the Patapsco AI Platform's platform-agent-panel (same idea,
// trimmed for Foyer's current scope). The panel anchors to the opposite corner
// of whichever quadrant the FAB is in — drag the FAB anywhere and the panel
// follows with the correct geometry. Resize handles appear on the edges facing
// away from the FAB so the panel always grows INTO the screen.
//
// MCP wiring (M8) will replace the placeholder send handler with real agent
// round-trips. For now the transcript echoes what you type so the UX is
// exercised end-to-end.

import { LitElement, html, css, nothing } from "lit";
import { icon } from "../icons.js";
import "./agent-settings-modal.js";

const FAB_SIZE = 48;
const GAP = 8;
const LS_KEY = "foyer.agent.panel.v1";
const DEFAULT_STATE = {
  fabRight: 24,
  fabBottom: 24,
  panelWidth: 420,
  panelHeight: 520,
  open: false,
};

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const p = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...p };
  } catch {
    return { ...DEFAULT_STATE };
  }
}
function saveState(s) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {}
}

export class AgentPanel extends LitElement {
  static properties = {
    _fabRight:     { state: true, type: Number },
    _fabBottom:    { state: true, type: Number },
    _panelWidth:   { state: true, type: Number },
    _panelHeight:  { state: true, type: Number },
    _open:         { state: true, type: Boolean },
    _input:        { state: true, type: String },
    _transcript:   { state: true, type: Array },
    _settingsOpen: { state: true, type: Boolean },
  };

  static styles = css`
    :host { display: contents; }

    /* FAB — gradient accent, always on top, draggable. */
    .fab {
      position: fixed;
      width: ${FAB_SIZE}px;
      height: ${FAB_SIZE}px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
      border: none;
      cursor: grab;
      box-shadow: var(--shadow-fab);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      transition: box-shadow 0.15s ease, transform 0.15s ease;
      touch-action: none;
      user-select: none;
    }
    .fab:hover {
      box-shadow: var(--shadow-fab-hover);
      transform: scale(1.04);
    }
    .fab.dragging { cursor: grabbing; transition: none; }
    .fab.open {
      background: linear-gradient(135deg, var(--color-accent-2), var(--color-accent-3));
    }
    .fab svg {
      width: 22px; height: 22px; stroke: currentColor; fill: none;
      stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
    }

    /* Panel — position set via inline style, bounded by viewport. */
    .panel {
      position: fixed;
      min-width: 320px;
      min-height: 280px;
      max-width: calc(100vw - 2.5rem);
      max-height: calc(100vh - 5rem);
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-panel);
      display: flex;
      flex-direction: column;
      z-index: 999;
      color: var(--color-text);
      overflow: hidden;
    }

    .panel header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--color-border);
      cursor: grab;
      background: linear-gradient(180deg, var(--color-surface-muted), var(--color-surface-elevated));
    }
    .panel header.dragging { cursor: grabbing; }
    .panel header .title {
      font-family: var(--font-sans);
      font-weight: 600;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      background: linear-gradient(135deg, var(--color-accent-3), var(--color-accent-2));
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .panel header .spacer { flex: 1; }
    .panel header button {
      background: transparent;
      color: var(--color-text-muted);
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      padding: 3px 6px;
      font: inherit;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .panel header button:hover {
      color: var(--color-text);
      border-color: var(--color-border);
    }

    .transcript {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-size: 12px;
      line-height: 1.5;
      scrollbar-width: thin;
      scrollbar-color: var(--color-border) transparent;
    }
    .msg {
      max-width: 80%;
      padding: 8px 10px;
      border-radius: var(--radius-md);
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .msg.user {
      align-self: flex-end;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
      border-bottom-right-radius: 2px;
    }
    .msg.agent {
      align-self: flex-start;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-bottom-left-radius: 2px;
      color: var(--color-text);
    }
    .welcome {
      color: var(--color-text-muted);
      font-size: 12px;
      padding: 16px;
      text-align: center;
    }
    .welcome strong {
      display: block;
      margin-bottom: 6px;
      color: var(--color-text);
      font-weight: 600;
    }

    .input-area {
      display: flex;
      gap: 6px;
      padding: 10px 12px;
      border-top: 1px solid var(--color-border);
      background: var(--color-surface);
    }
    .input-area textarea {
      flex: 1;
      background: var(--color-surface-elevated);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 6px 8px;
      font-family: var(--font-sans);
      font-size: 12px;
      resize: none;
      min-height: 36px;
      max-height: 140px;
      transition: border-color 0.15s ease;
    }
    .input-area textarea:focus {
      outline: none;
      border-color: var(--color-accent);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-accent) 30%, transparent);
    }
    .input-area button {
      width: 36px;
      height: 36px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
      border: none;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .input-area button:hover:not(:disabled) {
      filter: brightness(1.12);
      transform: translateY(-1px);
    }
    .input-area button:disabled { opacity: 0.45; cursor: not-allowed; }
    .input-area button svg {
      width: 16px; height: 16px; stroke: currentColor; fill: none;
      stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
    }

    /* Resize handle (single corner, opposite the FAB). */
    .resize {
      position: absolute;
      width: 14px; height: 14px;
      z-index: 2;
    }
    .resize.nw { top: 0; left: 0;   cursor: nw-resize; }
    .resize.ne { top: 0; right: 0;  cursor: ne-resize; }
    .resize.sw { bottom: 0; left: 0; cursor: sw-resize; }
    .resize.se { bottom: 0; right: 0; cursor: se-resize; }
  `;

  constructor() {
    super();
    const s = loadState();
    this._fabRight = s.fabRight;
    this._fabBottom = s.fabBottom;
    this._panelWidth = s.panelWidth;
    this._panelHeight = s.panelHeight;
    this._open = s.open;
    this._input = "";
    this._transcript = [];
    this._settingsOpen = false;
    this._dragState = null;
    this._resizeState = null;
    this._onWindowPointerMove = this._onWindowPointerMove.bind(this);
    this._onWindowPointerUp = this._onWindowPointerUp.bind(this);
    this._onWindowResize = this._onWindowResize.bind(this);
  }

  storageKey = "foyer.agent";

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("pointermove", this._onWindowPointerMove);
    window.addEventListener("pointerup", this._onWindowPointerUp);
    window.addEventListener("pointercancel", this._onWindowPointerUp);
    window.addEventListener("resize", this._onWindowResize);
    // Register with the layout store so the right-dock can show a rail icon
    // while we're docked. Wider default dock width — the agent panel needs
    // room for conversation turns.
    this._onLayoutChange = () => this.requestUpdate();
    window.__foyer?.layout?.addEventListener("change", this._onLayoutChange);
    window.__foyer?.layout?.registerFab(this.storageKey, {
      label: "Agent",
      icon: "sparkles",
      accent: "accent",
      expandsRail: true,
      dockWidth: 400,
    });
  }
  disconnectedCallback() {
    window.removeEventListener("pointermove", this._onWindowPointerMove);
    window.removeEventListener("pointerup", this._onWindowPointerUp);
    window.removeEventListener("pointercancel", this._onWindowPointerUp);
    window.removeEventListener("resize", this._onWindowResize);
    window.__foyer?.layout?.removeEventListener("change", this._onLayoutChange);
    window.__foyer?.layout?.unregisterFab(this.storageKey);
    super.disconnectedCallback();
  }

  _isDocked() {
    return !!window.__foyer?.layout?.isFabDocked(this.storageKey);
  }

  _isOverRail(x, y) {
    const rd = document.querySelector("foyer-right-dock");
    const r = rd?.railRect?.();
    return !!(r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  }

  openFromDock(top) { this._dockIconTop = top; this._open = true; this._persist(); this.requestUpdate(); }
  closeFromDock()   { this._open = false; this._persist(); this.requestUpdate(); }
  toggleFromDock(t) { if (this._open) this.closeFromDock(); else this.openFromDock(t); }

  _persist() {
    saveState({
      fabRight: this._fabRight,
      fabBottom: this._fabBottom,
      panelWidth: this._panelWidth,
      panelHeight: this._panelHeight,
      open: this._open,
    });
  }

  _onWindowResize() {
    // Clamp FAB + panel into the new viewport.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this._fabRight = Math.max(0, Math.min(vw - FAB_SIZE, this._fabRight));
    this._fabBottom = Math.max(0, Math.min(vh - FAB_SIZE, this._fabBottom));
    this._persist();
  }

  // ─── FAB drag / toggle ─────────────────────────────────────────────────

  _onFabDown(ev) {
    ev.preventDefault();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this._dragState = {
      kind: "fab",
      startX: ev.clientX,
      startY: ev.clientY,
      origRight: this._fabRight,
      origBottom: this._fabBottom,
      vw, vh,
      moved: false,
      pointerId: ev.pointerId,
    };
    ev.currentTarget.setPointerCapture(ev.pointerId);
    this.requestUpdate();
  }

  _onWindowPointerMove(ev) {
    if (this._dragState?.kind === "fab") {
      const ds = this._dragState;
      const dx = ev.clientX - ds.startX;
      const dy = ev.clientY - ds.startY;
      if (!ds.moved && Math.hypot(dx, dy) > 4) ds.moved = true;
      this._fabRight = Math.max(0, Math.min(ds.vw - FAB_SIZE, ds.origRight - dx));
      this._fabBottom = Math.max(0, Math.min(ds.vh - FAB_SIZE, ds.origBottom - dy));
      // Hint the dock that a drop here would dock the agent.
      document.querySelector("foyer-right-dock")
        ?.setDropHighlight?.(this._isOverRail(ev.clientX, ev.clientY));
      this.requestUpdate();
    } else if (this._dragState?.kind === "panel-header") {
      // Panel drag actually moves the FAB (since panel position is derived
      // from FAB quadrant). Update fab position directly.
      const ds = this._dragState;
      const dx = ev.clientX - ds.startX;
      const dy = ev.clientY - ds.startY;
      this._fabRight = Math.max(0, Math.min(ds.vw - FAB_SIZE, ds.origRight - dx));
      this._fabBottom = Math.max(0, Math.min(ds.vh - FAB_SIZE, ds.origBottom - dy));
      this.requestUpdate();
    } else if (this._resizeState) {
      const rs = this._resizeState;
      const dx = ev.clientX - rs.startX;
      const dy = ev.clientY - rs.startY;
      const wSign = rs.corner.includes("e") === rs.panelGrowsE ? 1 : -1;
      const hSign = rs.corner.includes("s") === rs.panelGrowsS ? 1 : -1;
      this._panelWidth = Math.max(320, rs.origW + dx * wSign);
      this._panelHeight = Math.max(280, rs.origH + dy * hSign);
      this.requestUpdate();
    }
  }

  _onWindowPointerUp(ev) {
    if (this._dragState?.kind === "fab") {
      const ds = this._dragState;
      const wasMoved = ds.moved;
      this._dragState = null;
      document.querySelector("foyer-right-dock")?.setDropHighlight?.(false);
      if (!wasMoved) {
        this._toggle();
      } else if (ev && this._isOverRail(ev.clientX, ev.clientY)) {
        // Dock to the right rail and close the floating presentation.
        window.__foyer?.layout?.dockFab(this.storageKey);
        this._open = false;
      }
      this._persist();
      this.requestUpdate();
    } else if (this._dragState?.kind === "panel-header") {
      this._dragState = null;
      this._persist();
    } else if (this._resizeState) {
      this._resizeState = null;
      this._persist();
    }
    void ev;
  }

  _toggle() {
    this._open = !this._open;
    this._persist();
  }

  _onPanelHeaderDown(ev) {
    ev.preventDefault();
    this._dragState = {
      kind: "panel-header",
      startX: ev.clientX,
      startY: ev.clientY,
      origRight: this._fabRight,
      origBottom: this._fabBottom,
      vw: window.innerWidth,
      vh: window.innerHeight,
      pointerId: ev.pointerId,
    };
  }

  _onResizeDown(ev, corner) {
    ev.preventDefault();
    ev.stopPropagation();
    const { isLeft, isTop } = this._quadrant();
    // Panel grows away from the FAB. If FAB is in the left half, panel is to
    // the right of it, so dragging further right grows width.
    const panelGrowsE = !isLeft; // panel is to the right of FAB ⇒ grows east
    const panelGrowsS = !isTop;  // panel is below FAB ⇒ grows south
    this._resizeState = {
      corner,
      startX: ev.clientX,
      startY: ev.clientY,
      origW: this._panelWidth,
      origH: this._panelHeight,
      panelGrowsE,
      panelGrowsS,
    };
  }

  // ─── Quadrant / anchor computation (Patapsco algorithm) ─────────────────

  _quadrant() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fabCenterX = vw - this._fabRight - FAB_SIZE / 2;
    const fabCenterY = vh - this._fabBottom - FAB_SIZE / 2;
    return {
      isTop: fabCenterY < vh / 2,
      isLeft: fabCenterX < vw / 2,
    };
  }

  _panelStyle() {
    const { isTop, isLeft } = this._quadrant();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fabTop = vh - this._fabBottom - FAB_SIZE;

    const pos = [];
    if (isTop)  pos.push(`top: ${fabTop + FAB_SIZE + GAP}px`);
    else        pos.push(`bottom: ${this._fabBottom + FAB_SIZE + GAP}px`);

    if (isLeft) pos.push(`left: ${vw - this._fabRight - FAB_SIZE}px`);
    else        pos.push(`right: ${this._fabRight}px`);

    // Clamp width so the panel never overlaps the FAB.
    const fabLeftEdge  = vw - this._fabRight - FAB_SIZE;
    const fabRightEdge = vw - this._fabRight;
    const maxW = isLeft
      ? Math.max(320, vw - fabLeftEdge - 16)
      : Math.max(320, fabRightEdge - 16);
    const maxH = isTop
      ? Math.max(280, vh - fabTop - FAB_SIZE - GAP - 16)
      : Math.max(280, vh - this._fabBottom - FAB_SIZE - GAP - 16);

    const w = Math.min(this._panelWidth, maxW);
    const h = Math.min(this._panelHeight, maxH);
    pos.push(`width: ${w}px`, `height: ${h}px`);
    return { style: pos.join("; "), isTop, isLeft };
  }

  // ─── Messaging (placeholder; M8 wires to MCP) ───────────────────────────

  _onInputKey(ev) {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      this._send();
    }
  }
  _send() {
    const text = this._input.trim();
    if (!text) return;
    this._transcript = [
      ...this._transcript,
      { role: "user", text },
      { role: "agent", text: "(agent bridge lands in M8 — MCP-backed replies will show up here.)" },
    ];
    this._input = "";
  }
  _clear() {
    this._transcript = [];
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  render() {
    // While docked to the right rail, the FAB is rendered in the rail by
    // <foyer-right-dock>; our panel (when open) anchors next to the rail.
    if (this._isDocked()) {
      return html`
        ${this._open ? this._renderDockedPanel() : nothing}
        <foyer-agent-settings-modal
          ?open=${this._settingsOpen}
          @save=${() => { this._settingsOpen = false; }}
        ></foyer-agent-settings-modal>
      `;
    }

    const fabStyle = `right: ${this._fabRight}px; bottom: ${this._fabBottom}px`;
    const fabClasses = [
      "fab",
      this._open ? "open" : "",
      this._dragState?.kind === "fab" ? "dragging" : "",
    ].filter(Boolean).join(" ");

    return html`
      <button
        class=${fabClasses}
        style=${fabStyle}
        @pointerdown=${this._onFabDown}
        aria-label=${this._open ? "Close agent" : "Open agent"}
        title=${this._open ? "Close agent" : "Open agent"}
      >
        ${this._open
          ? html`<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>`
          : html`<svg viewBox="0 0 24 24"><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6l2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6l2.1-2.1"/><circle cx="12" cy="12" r="4"/></svg>`}
      </button>

      ${this._open ? this._renderPanel() : nothing}
      <foyer-agent-settings-modal
        ?open=${this._settingsOpen}
        @save=${() => { this._settingsOpen = false; }}
      ></foyer-agent-settings-modal>
    `;
  }

  /**
   * Docked presentation: the panel anchors to the right rail instead of to
   * the floating FAB position. The rail itself stays thin; we extend LEFT
   * from the rail with the agent's preferred width so long conversation
   * turns get readable line length.
   */
  _renderDockedPanel() {
    const rd = document.querySelector("foyer-right-dock");
    const rail = rd?.railRect?.();
    const right = rail ? window.innerWidth - rail.left + 8 : 60;
    const top = Math.max(16, this._dockIconTop || 120);
    const vh = window.innerHeight;
    const w = Math.min(this._panelWidth, Math.max(360, window.innerWidth - right - 16));
    const h = Math.min(this._panelHeight, Math.max(360, vh - top - 16));
    const style = `position:fixed;right:${right}px;top:${top}px;width:${w}px;height:${h}px`;
    // Re-use the existing panel DOM so chat, settings, header all work.
    // The resize corner has no meaningful direction in docked mode, so we
    // just omit it — docked width is controlled by the rail.
    return html`
      <div class="panel" role="dialog" aria-label="Foyer agent" style=${style}>
        <header>
          <div class="title">Agent</div>
          <div class="spacer"></div>
          <button @click=${() => { this._settingsOpen = true; }} title="Settings">
            ${icon("cog", 14)}
          </button>
          <button @click=${() => window.__foyer?.layout?.undockFab(this.storageKey)}
                  title="Undock">
            ${icon("arrow-top-right-on-square", 14)}
          </button>
          <button @click=${this.closeFromDock} title="Close">
            ${icon("x-mark", 14)}
          </button>
        </header>
        <div class="transcript">
          ${this._transcript.length === 0
            ? html`<div class="empty">Docked agent — conversation will appear here.</div>`
            : this._transcript.map((t) => html`<div class="msg ${t.role}">${t.text}</div>`)}
        </div>
        <div class="composer">
          <textarea
            placeholder="Ask the agent…"
            .value=${this._input}
            @input=${(e) => { this._input = e.target.value; }}
            @keydown=${this._onInputKey}
          ></textarea>
          <button @click=${this._send} title="Send">${icon("paper-airplane", 14)}</button>
        </div>
      </div>
    `;
  }

  _renderPanel() {
    const { style, isTop, isLeft } = this._panelStyle();
    // The resize corner is the one pointing AWAY from the FAB.
    const corner = `${isTop ? "s" : "n"}${isLeft ? "e" : "w"}`;
    return html`
      <div class="panel" role="dialog" aria-label="Foyer agent" style=${style}>
        <div class="resize ${corner}" @pointerdown=${(e) => this._onResizeDown(e, corner)}></div>
        <header @pointerdown=${this._onPanelHeaderDown}>
          <div class="title">Agent</div>
          <div class="spacer"></div>
          <button @pointerdown=${(e) => e.stopPropagation()}
                  @click=${() => { this._settingsOpen = true; }}
                  title="LLM settings">
            ${icon("cog", 14)}
          </button>
          <button @pointerdown=${(e) => e.stopPropagation()} @click=${this._clear}>Clear</button>
        </header>
        <div class="transcript">
          ${this._transcript.length === 0
            ? html`<div class="welcome"><strong>Foyer Agent</strong>Ask the agent to move faders, arm tracks, or explain the mix. MCP bridge lands in M8.</div>`
            : this._transcript.map(m => html`<div class="msg ${m.role}">${m.text}</div>`)}
        </div>
        <div class="input-area">
          <textarea
            placeholder="Ask the agent…"
            .value=${this._input}
            @input=${(e) => { this._input = e.target.value; }}
            @keydown=${this._onInputKey}
          ></textarea>
          <button @click=${this._send} ?disabled=${!this._input.trim()} title="Send">
            <svg viewBox="0 0 24 24"><path d="M4 12l16-8-8 16-2-7-6-1z"/></svg>
          </button>
        </div>
      </div>
    `;
  }
}
customElements.define("foyer-agent-panel", AgentPanel);
