// Free-floating tiles.
//
// A tile that's been "detached" from the tiling tree becomes an entry in the
// layout store's `floating` array. This component renders each entry with:
//
//   - 8-handle resize (four corners + four edges)
//   - Drag-to-move from the title bar
//   - Click-anywhere-to-raise (z-order owned by the store)
//   - Minimize → dock FAB, restore, re-slot via slot picker, dock-back, close
//
// Minimized floats show as square FABs on the right edge.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";

// Stub for rendering the same views the tile-leaf knows how to render.
import "../components/mixer.js";
import "../components/timeline-view.js";
import "../components/plugins-view.js";
import "../components/session-view.js";
import "../components/plugin-panel.js";
import "./text-preview.js";
import "./slot-picker.js";

import { slotBounds } from "./slots.js";
import { dropZones } from "./drop-zones.js";

const VIEW_LABELS = {
  mixer: "Mixer",
  timeline: "Timeline",
  plugins: "Plugins",
  session: "Session",
  preview: "Preview",
  plugin_panel: "Plugin",
};

export class FloatingTiles extends LitElement {
  static properties = {
    store: { type: Object },
    _entries: { state: true, type: Array },
    _slotPickerFor: { state: true, type: String },
  };

  static styles = css`
    :host {
      position: fixed; inset: 0;
      pointer-events: none;
      z-index: 900;
    }
    .window {
      position: absolute;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-panel);
      display: flex; flex-direction: column;
      overflow: hidden;
      pointer-events: auto;
    }
    .window.active {
      border-color: color-mix(in oklab, var(--color-accent) 50%, var(--color-border));
      box-shadow:
        0 0 0 1px color-mix(in oklab, var(--color-accent) 30%, transparent),
        var(--shadow-panel);
    }
    header {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 8px;
      background: var(--color-surface-elevated);
      border-bottom: 1px solid var(--color-border);
      cursor: grab;
      user-select: none;
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
    header .slot-tag {
      font-size: 9px;
      font-family: var(--font-mono);
      padding: 1px 6px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      color: var(--color-text-muted);
    }
    header button {
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--color-text-muted);
      padding: 2px 5px;
      font-size: 10px;
      cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      height: 20px;
    }
    header button:hover { color: var(--color-text); border-color: var(--color-border); }
    .body { flex: 1; min-height: 0; display: flex; overflow: hidden; }

    /* 8 resize handles — four edges + four corners. */
    .h {
      position: absolute;
      z-index: 3;
    }
    .h.n { top: -3px; left: 8px; right: 8px; height: 8px; cursor: ns-resize; }
    .h.s { bottom: -3px; left: 8px; right: 8px; height: 8px; cursor: ns-resize; }
    .h.w { top: 8px; bottom: 8px; left: -3px; width: 8px; cursor: ew-resize; }
    .h.e { top: 8px; bottom: 8px; right: -3px; width: 8px; cursor: ew-resize; }
    .h.nw { top: -3px; left: -3px; width: 12px; height: 12px; cursor: nwse-resize; }
    .h.ne { top: -3px; right: -3px; width: 12px; height: 12px; cursor: nesw-resize; }
    .h.sw { bottom: -3px; left: -3px; width: 12px; height: 12px; cursor: nesw-resize; }
    .h.se { bottom: -3px; right: -3px; width: 12px; height: 12px; cursor: nwse-resize; }
    .h.se::after {
      content: "";
      position: absolute; right: 2px; bottom: 2px;
      width: 8px; height: 8px;
      border-right: 2px solid var(--color-text-muted);
      border-bottom: 2px solid var(--color-text-muted);
      border-bottom-right-radius: 2px;
    }

    .dock {
      position: fixed;
      right: 12px;
      bottom: 120px;
      display: flex; flex-direction: column-reverse; gap: 8px;
      pointer-events: auto;
      z-index: 1001;
    }
    .dock button {
      width: 44px; height: 44px;
      border-radius: var(--radius-md);
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      color: var(--color-text-muted);
      cursor: pointer;
      font-family: var(--font-sans);
      font-size: 9px; font-weight: 700;
      letter-spacing: 0.1em; text-transform: uppercase;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.12s ease;
    }
    .dock button:hover {
      color: var(--color-text);
      border-color: var(--color-accent);
      transform: translateY(-1px);
    }
  `;

  constructor() {
    super();
    this._entries = [];
    this._slotPickerFor = null;
    this._onChange = () => this._refresh();
    this._onResize = () => this._refresh();
    // Plugin panels render live session data; re-render on snapshot arrival.
    this._onDataChange = () => this.requestUpdate();
  }

  connectedCallback() {
    super.connectedCallback();
    this.store?.addEventListener("change", this._onChange);
    window.addEventListener("resize", this._onResize);
    window.__foyer?.store?.addEventListener("change", this._onDataChange);
    this._refresh();
  }
  disconnectedCallback() {
    this.store?.removeEventListener("change", this._onChange);
    window.removeEventListener("resize", this._onResize);
    window.__foyer?.store?.removeEventListener("change", this._onDataChange);
    super.disconnectedCallback();
  }

  _refresh() {
    // Sort by z so DOM order matches paint order.
    const arr = (this.store?.floating?.() || []).slice();
    arr.sort((a, b) => (a.z | 0) - (b.z | 0));
    this._entries = arr;
  }

  render() {
    const shown = this._entries.filter((e) => !e.minimized);
    const minimized = this._entries.filter((e) => e.minimized);
    const topId = shown.length ? shown[shown.length - 1].id : null;
    return html`
      ${shown.map((e) => this._renderWindow(e, e.id === topId))}
      ${minimized.length
        ? html`
            <div class="dock">
              ${minimized.map(
                (e) => html`
                  <button
                    title=${this._titleFor(e)}
                    @click=${() => this.store.floatSet(e.id, { minimized: false })}
                  >
                    ${this._titleFor(e).slice(0, 3)}
                  </button>
                `
              )}
            </div>
          `
        : null}
      ${this._slotPickerFor
        ? html`
            <foyer-slot-picker
              @pick=${(ev) => this._onSlotPicked(ev.detail.slot)}
              @close=${() => (this._slotPickerFor = null)}
            ></foyer-slot-picker>
          `
        : null}
    `;
  }

  _titleFor(e) {
    if (e.view === "plugin_panel") {
      const p = this._locatePlugin(e.props?.plugin_id);
      return p ? p.name : "Plugin";
    }
    return VIEW_LABELS[e.view] || e.view;
  }

  _renderWindow(e, isTop) {
    const style = `left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;z-index:${
      (e.z | 0) + 900
    }`;
    return html`
      <div
        class="window ${isTop ? "active" : ""}"
        style=${style}
        @pointerdown=${() => this.store.raiseFloat(e.id)}
      >
        <header @pointerdown=${(ev) => this._startMove(ev, e)}>
          <span class="label">${this._titleFor(e)}</span>
          ${e.slot ? html`<span class="slot-tag" title="Current slot">${e.slot}</span>` : null}
          <button
            title="Re-slot"
            @pointerdown=${(ev) => ev.stopPropagation()}
            @click=${() => (this._slotPickerFor = e.id)}
          >
            ${icon("squares-2x2", 12)}
          </button>
          <button
            title="Minimize to FAB"
            @pointerdown=${(ev) => ev.stopPropagation()}
            @click=${() => this.store.floatSet(e.id, { minimized: true })}
          >
            ${icon("minus", 12)}
          </button>
          <button
            title="Dock back into tile tree"
            @pointerdown=${(ev) => ev.stopPropagation()}
            @click=${() => this.store.dockFloat(e.id)}
          >
            ${icon("arrow-down-left-on-square", 12)}
          </button>
          <button
            title="Close"
            @pointerdown=${(ev) => ev.stopPropagation()}
            @click=${() => this.store.removeFloat(e.id)}
          >
            ${icon("x-mark", 12)}
          </button>
        </header>
        <div class="body">${this._renderView(e)}</div>

        <div class="h n" @pointerdown=${(ev) => this._startResize(ev, e, "n")}></div>
        <div class="h s" @pointerdown=${(ev) => this._startResize(ev, e, "s")}></div>
        <div class="h w" @pointerdown=${(ev) => this._startResize(ev, e, "w")}></div>
        <div class="h e" @pointerdown=${(ev) => this._startResize(ev, e, "e")}></div>
        <div class="h nw" @pointerdown=${(ev) => this._startResize(ev, e, "nw")}></div>
        <div class="h ne" @pointerdown=${(ev) => this._startResize(ev, e, "ne")}></div>
        <div class="h sw" @pointerdown=${(ev) => this._startResize(ev, e, "sw")}></div>
        <div class="h se" @pointerdown=${(ev) => this._startResize(ev, e, "se")}></div>
      </div>
    `;
  }

  _renderView(e) {
    const session = window.__foyer?.store?.state?.session || null;
    switch (e.view) {
      case "mixer":
        return html`<foyer-mixer .session=${session}></foyer-mixer>`;
      case "timeline":
        return html`<foyer-timeline-view .session=${session}></foyer-timeline-view>`;
      case "plugins":
        return html`<foyer-plugins-view></foyer-plugins-view>`;
      case "session":
        return html`<foyer-session-view></foyer-session-view>`;
      case "preview":
        return html`<foyer-text-preview .path=${e.props?.path || ""}></foyer-text-preview>`;
      case "plugin_panel": {
        const info = this._locatePlugin(e.props?.plugin_id);
        if (!info) {
          return html`<div
            style="padding:20px;color:var(--color-text-muted)"
          >
            Plugin no longer exists in the current session.
          </div>`;
        }
        return html`<foyer-plugin-panel
          .plugin=${info.plugin}
          .trackName=${info.trackName}
        ></foyer-plugin-panel>`;
      }
      default:
        return html`<div style="padding:20px;color:var(--color-text-muted)">
          Unknown view: ${e.view}
        </div>`;
    }
  }

  _locatePlugin(pluginId) {
    if (!pluginId) return null;
    const session = window.__foyer?.store?.state?.session;
    if (!session) return null;
    for (const t of session.tracks || []) {
      for (const p of t.plugins || []) {
        if (p.id === pluginId) return { plugin: p, trackName: t.name };
      }
    }
    return null;
  }

  _startMove(ev, entry) {
    ev.preventDefault();
    const hdr = ev.currentTarget;
    hdr.classList.add("dragging");
    const startX = ev.clientX;
    const startY = ev.clientY;
    const ox = entry.x;
    const oy = entry.y;
    this.store.raiseFloat(entry.id);
    const zones = dropZones();
    zones.show();
    const rightDock = document.querySelector("foyer-right-dock");
    let overRail = false;
    const isOverRail = (x, y) => {
      const r = rightDock?.railRect?.();
      return !!(r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
    };
    const move = (e) => {
      const nowOverRail = isOverRail(e.clientX, e.clientY);
      if (nowOverRail !== overRail) {
        overRail = nowOverRail;
        rightDock?.setDropHighlight?.(overRail);
      }
      this.store.floatSet(entry.id, {
        x: Math.max(0, ox + (e.clientX - startX)),
        y: Math.max(0, oy + (e.clientY - startY)),
        slot: null,
      });
      zones.update(e.clientX, e.clientY);
    };
    const up = (e) => {
      hdr.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const releasedOverRail = isOverRail(e.clientX, e.clientY);
      rightDock?.setDropHighlight?.(false);
      const snap = zones.currentSlot();
      zones.hide();
      if (releasedOverRail) {
        // Dock into the right rail: minimize the floating window.
        this.store.floatSet(entry.id, { minimized: true });
        return;
      }
      if (snap) {
        const rect = slotBounds(snap, window.innerWidth, window.innerHeight, 24);
        if (rect) {
          this.store.floatSet(entry.id, { ...rect, slot: snap });
          try {
            localStorage.setItem(`foyer.layout.sticky.${entry.view}`, snap);
          } catch {}
        }
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  _startResize(ev, entry, dir) {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const ox = entry.x;
    const oy = entry.y;
    const ow = entry.w;
    const oh = entry.h;
    const minW = 240;
    const minH = 160;

    this.store.raiseFloat(entry.id);

    const move = (e) => {
      let dx = e.clientX - startX;
      let dy = e.clientY - startY;
      let nx = ox, ny = oy, nw = ow, nh = oh;
      if (dir.includes("e")) nw = Math.max(minW, ow + dx);
      if (dir.includes("s")) nh = Math.max(minH, oh + dy);
      if (dir.includes("w")) {
        const w = Math.max(minW, ow - dx);
        nx = ox + (ow - w);
        nw = w;
      }
      if (dir.includes("n")) {
        const h = Math.max(minH, oh - dy);
        ny = oy + (oh - h);
        nh = h;
      }
      this.store.floatSet(entry.id, { x: nx, y: ny, w: nw, h: nh, slot: null });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  _onSlotPicked(slotId) {
    const id = this._slotPickerFor;
    this._slotPickerFor = null;
    if (!id) return;
    const rect = slotBounds(slotId, window.innerWidth, window.innerHeight, 24);
    if (!rect) return;
    this.store.floatSet(id, { ...rect, slot: slotId });
    // Persist "sticky" for this view type so next open returns here.
    const e = this._entries.find((x) => x.id === id);
    if (e) {
      try {
        localStorage.setItem(`foyer.layout.sticky.${e.view}`, slotId);
      } catch {}
    }
  }
}
customElements.define("foyer-floating-tiles", FloatingTiles);
