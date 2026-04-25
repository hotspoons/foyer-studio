// Plugin-float layer — a dedicated window surface for plugin parameter panels.
//
// Per DECISIONS.md #12: plugin windows are architecturally separate from the
// tile grid and from generic floating-tiles. They don't participate in slot
// snapping; they auto-place themselves via the packer. A global show/hide
// toggle hides every plugin window at once — useful for A/Bing a mix
// without closing every plugin by hand.
//
// Position model: plugin floats carry only `{ plugin_id, w, h }` in the
// store. Actual (x,y) is computed fresh on every render via `packShelves`
// so a layout save→load reproduces positions deterministically without
// having to serialize them.
//
// Drag to resize: each window has corner handles that update its `w`/`h`
// through `layout.setPluginFloatSize()`. Dragging to MOVE is intentionally
// disabled — moving breaks the packer's tidy fill. If you want a plugin
// window somewhere specific, the right gesture is to rearrange open
// plugins (future: drag-to-reorder their shelf position).

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { showContextMenu } from "foyer-ui-core/widgets/context-menu.js";
import { scrollbarStyles } from "foyer-ui-core/shared-styles.js";

// The <foyer-plugin-panel> tag is registered by the active UI
// package (foyer-ui/components/plugin-panel.js). An alternate UI
// that wants its own plugin surface just imports its own tag with
// the same name and re-defines the custom element before this
// layer mounts.
import { packShelves, heuristicSize } from "./plugin-packer.js";

export class PluginLayer extends LitElement {
  static properties = {
    store: { type: Object },
    _entries: { state: true, type: Array },
    _visible: { state: true, type: Boolean },
    _placed: { state: true, type: Array },
  };

  static styles = css`
    ${scrollbarStyles}
    :host {
      position: fixed;
      inset: 0;
      pointer-events: none;
      /* Just below the generic floating-tiles layer (900) so system
       * windows (mixer, timeline, session) float ABOVE plugin windows
       * when present — matches every other DAW's layering. */
      z-index: 850;
    }
    :host([hidden]) { display: none; }

    .pwin {
      position: absolute;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-panel);
      display: flex; flex-direction: column;
      overflow: hidden;
      pointer-events: auto;
      /* No transition on left/top. Plugin floats are "dumb like
       * foyer-window" — every frame during drag sets inline left/top,
       * and any 180ms transition turned that into rubber-banding.
       * Width/height also stays un-transitioned so the corner resize
       * doesn't feel laggy on narrow windows. */
    }
    .pwin:hover {
      border-color: color-mix(in oklab, var(--color-accent) 40%, var(--color-border));
    }
    header {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 8px;
      background: var(--color-surface-elevated);
      border-bottom: 1px solid var(--color-border);
      user-select: none;
      cursor: grab;
    }
    header.dragging { cursor: grabbing; }
    header .label {
      flex: 1; min-width: 0;
      font-family: var(--font-sans);
      font-size: 10px; font-weight: 600;
      letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--color-text);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    header button {
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--color-text-muted);
      padding: 2px 5px;
      font-size: 10px;
      cursor: pointer;
      height: 20px;
      display: inline-flex; align-items: center;
    }
    header button:hover { color: var(--color-text); border-color: var(--color-border); }

    .body { flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; }

    /* Invisible corner hit-area. Matches foyer-window — the cursor
     * change is the affordance, no drawn L. The previous treatment
     * (two bright borders in --color-text-muted) looked like a
     * bright white gash against the dark plugin body and stood out
     * against the surrounding theme. */
    .h.se {
      position: absolute;
      right: 0; bottom: 0;
      width: 14px; height: 14px;
      cursor: nwse-resize;
      z-index: 2;
    }
  `;

  constructor() {
    super();
    this._entries = [];
    this._placed = [];
    this._visible = true;
    this._onChange = () => this._refresh();
    this._onResize = () => this._repack();
    this._onDataChange = () => this.requestUpdate();
    this._onDockResized = () => this._repack();
    // Document-capture pointerdown so clicks deep inside a plugin's
    // controls (knobs, dropdowns, nested shadow roots) still bubble
    // the "raise this window" intent up to the layer. Matches what
    // floating-tiles does for system windows.
    this._onDocPointerDown = (ev) => this._handleRaise(ev);
  }

  _handleRaise(ev) {
    if (ev.button !== 0) return;
    const path = ev.composedPath ? ev.composedPath() : [];
    const root = this.renderRoot;
    for (const n of path) {
      if (!n || !n.classList) continue;
      if (n.classList.contains("pwin") && root?.contains(n)) {
        const pid = n.getAttribute("data-plugin-id");
        if (pid) this.store?.raisePluginFloat?.(pid);
        return;
      }
    }
  }

  connectedCallback() {
    super.connectedCallback();
    this.store?.addEventListener("change", this._onChange);
    window.addEventListener("resize", this._onResize);
    window.addEventListener("foyer:dock-resized", this._onDockResized);
    window.__foyer?.store?.addEventListener("change", this._onDataChange);
    document.addEventListener("pointerdown", this._onDocPointerDown, true);
    this._refresh();
  }
  disconnectedCallback() {
    this.store?.removeEventListener("change", this._onChange);
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("foyer:dock-resized", this._onDockResized);
    window.__foyer?.store?.removeEventListener("change", this._onDataChange);
    document.removeEventListener("pointerdown", this._onDocPointerDown, true);
    super.disconnectedCallback();
  }

  _refresh() {
    this._entries = this.store?.pluginFloats?.() || [];
    // Plugin layer hides when EITHER its own toggle is off (legacy
    // "hide all plugin windows" gesture) OR the umbrella widgets-layer
    // is hidden. Both feed the same `_visible` so existing render
    // paths and the right-click context-menu copy don't need to know
    // which axis flipped.
    const ownVisible = this.store?.pluginFloatsVisible?.() ?? true;
    const layerVisible = this.store?.widgetsVisible?.() ?? true;
    this._visible = ownVisible && layerVisible;
    this._repack();
  }

  _repack() {
    const ws = window.__foyer?.workspaceRect?.() || {
      top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight,
      width: window.innerWidth, height: window.innerHeight,
    };
    // Reserve a little margin on each side so plugin windows don't sit flush
    // against docked system windows.
    const pad = 8;
    const manual = [];
    const auto = [];
    for (const e of this._entries) {
      if (Number.isFinite(e.x) && Number.isFinite(e.y)) manual.push(e);
      else auto.push(e);
    }
    const packed = packShelves(
      auto.map((e) => ({ id: e.plugin_id, w: e.w, h: e.h })),
      { x: ws.left + pad, y: ws.top + pad, w: Math.max(0, ws.width - 2 * pad), h: Math.max(0, ws.height - 2 * pad) },
      { gap: 8 },
    );
    // No bounds clamp on manually-positioned windows. Clamping here
    // is what caused the "snap back from the edge" rubber-banding
    // users complained about — the drag would end off-screen, the
    // store would save the off-screen coords, the next re-render
    // would clamp them back into bounds, and the window would
    // visibly jump. Keep it dumb: whatever the user dragged to is
    // exactly where it renders. Off-screen recovery is handled by
    // raising / visibility toggle / "reset plugin positions".
    const passthroughManual = manual.map((e) => ({
      id: e.plugin_id,
      w: e.w,
      h: e.h,
      x: e.x,
      y: e.y,
    }));
    this._placed = [...passthroughManual, ...packed];
  }

  render() {
    if (!this._visible) {
      this.setAttribute("hidden", "");
      return html``;
    }
    this.removeAttribute("hidden");
    return html`
      ${this._placed.map((p) => this._renderWindow(p))}
    `;
  }

  _renderWindow(p) {
    const info = this._locatePlugin(p.id);
    const label = info ? `${info.trackName} · ${info.plugin.name}` : "Plugin";
    // Pull the stored `z` for this plugin float (see `raisePluginFloat`).
    // Plugins share a stacking context at host `z-index: 850`; inside
    // that, we layer per-window z so click-to-raise lifts the clicked
    // plugin above its peers. Offset of 10 keeps the resize handle's
    // `z-index: 2` below the plugin body when rest.
    const storedZ = this._entries.find((e) => e.plugin_id === p.id)?.z | 0;
    const style = `left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px;z-index:${10 + storedZ}`;
    return html`
      <div class="pwin"
           style=${style}
           data-plugin-id=${p.id}
           @pointerdown=${() => this.store.raisePluginFloat(p.id)}
           @contextmenu=${(ev) => this._contextMenu(ev, p.id)}>
        <header @pointerdown=${(ev) => { if (ev.target?.closest?.("button")) return; this._startDrag(ev, p); }}>
          <span class="label">${label}</span>
          <button title="Close plugin window"
                  @click=${() => this.store.closePluginFloat(p.id)}>
            ${icon("x-mark", 12)}
          </button>
        </header>
        <div class="body">
          ${info
            ? html`<foyer-plugin-panel
                .plugin=${info.plugin}
                .trackName=${info.trackName}
                @natural-size=${(ev) => this._onNaturalSize(ev, p.id)}
              ></foyer-plugin-panel>`
            : html`<div style="padding:20px;color:var(--color-text-muted)">
                Plugin no longer in session.
              </div>`}
        </div>
        <div class="h se"
             @pointerdown=${(ev) => this._startResize(ev, p)}></div>
      </div>
    `;
  }

  /** Plugin panel reports its content's natural size; adopt it if the
   *  user hasn't already resized this plugin window manually. */
  _onNaturalSize(ev, pluginId) {
    const { pluginId: id, w, h } = ev.detail || {};
    if (id !== pluginId) return;
    const entry = this._entries.find((e) => e.plugin_id === pluginId);
    if (!entry) return;
    // Only adopt if the existing size looks like a heuristic default —
    // i.e. the user hasn't dragged the corner handle yet. Heuristic:
    // if width is still the baseline from `heuristicSize`, accept.
    if (entry._userResized) return;
    this.store.setPluginFloatSize(pluginId, w, h);
  }

  _locatePlugin(pluginId) {
    const session = window.__foyer?.store?.state?.session;
    if (!session) return null;
    for (const t of session.tracks || []) {
      for (const pi of t.plugins || []) {
        if (pi.id === pluginId) return { plugin: pi, trackName: t.name };
      }
    }
    return null;
  }

  _contextMenu(ev, plugin_id) {
    ev.preventDefault();
    ev.stopPropagation();
    showContextMenu(ev, [
      { heading: this._locatePlugin(plugin_id)?.plugin?.name ?? "Plugin" },
      {
        label: this._visible ? "Hide all plugin windows" : "Show all plugin windows",
        icon: this._visible ? "eye-slash" : "eye",
        shortcut: "Ctrl+Shift+P",
        action: () => this.store.togglePluginFloats(),
      },
      {
        label: "Re-pack windows",
        icon: "arrow-path",
        action: () => this._repack(),
      },
      { separator: true },
      {
        label: "Close plugin window",
        icon: "x-mark",
        tone: "danger",
        action: () => this.store.closePluginFloat(plugin_id),
      },
    ]);
  }

  /* ── resize ─────────────────────────────────────────────────────── */
  _startResize(ev, placed) {
    ev.preventDefault();
    ev.stopPropagation();
    const win = ev.currentTarget.closest(".pwin");
    if (!win) return;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startW = placed.w;
    const startH = placed.h;
    const move = (e) => {
      const nw = Math.max(180, startW + (e.clientX - startX));
      const nh = Math.max(160, startH + (e.clientY - startY));
      win.style.width  = `${nw}px`;
      win.style.height = `${nh}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const nw = parseFloat(win.style.width)  || placed.w;
      const nh = parseFloat(win.style.height) || placed.h;
      this.store.setPluginFloatSize(placed.id, nw, nh);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /* ── drag ──────────────────────────────────────────────────────────
   * Same pattern as foyer-window.js: manipulate the .pwin's inline
   * style directly during the drag (zero Lit or store churn), then
   * persist the final position to the layout store on pointerup.
   */
  _startDrag(ev, placed) {
    ev.preventDefault();
    ev.stopPropagation();
    const header = ev.currentTarget;
    const win = header.closest(".pwin");
    if (!win) return;
    header.classList.add("dragging");
    const startX = ev.clientX;
    const startY = ev.clientY;
    const ox = placed.x;
    const oy = placed.y;
    const move = (e) => {
      const nx = ox + (e.clientX - startX);
      const ny = oy + (e.clientY - startY);
      win.style.left = `${nx}px`;
      win.style.top  = `${ny}px`;
    };
    const up = () => {
      header.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const nx = parseFloat(win.style.left) || placed.x;
      const ny = parseFloat(win.style.top)  || placed.y;
      this.store.setPluginFloatPosition(placed.id, nx, ny);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
}
customElements.define("foyer-plugin-layer", PluginLayer);

/**
 * Helper used by outside code (plugin-strip, command palette) to open a
 * plugin float using the layer's auto-sizing heuristic. Handles the
 * "already open — just raise / do nothing" case.
 */
export function openPluginFloat(pluginInstance) {
  const layout = window.__foyer?.layout;
  if (!layout || !pluginInstance?.id) return;
  if (!layout.pluginFloatsVisible()) layout.setPluginFloatsVisible(true);
  const size = heuristicSize(pluginInstance);
  layout.openPluginFloat(pluginInstance.id, size);
}
