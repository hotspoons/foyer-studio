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
import { repeat } from "lit/directives/repeat.js";
import { icon } from "foyer-ui-core/icons.js";

// View custom-element tags (foyer-mixer, foyer-timeline-view, etc.)
// are registered by whichever UI variant is currently active —
// foyer-ui/app.js imports them so they're defined by the time a
// float renders. Alternate UIs register their own, and tile-leaf /
// floating-tiles create elements by tag at render time via the
// view registry. No hardcoded list here.
import "./text-preview.js";
import "./slot-picker.js";

import { slotBounds, slotForRect, SLOT_PRESETS, SLOT_SHORTCUTS } from "./slots.js";
import { dropZones } from "./drop-zones.js";
import { showContextMenu } from "foyer-ui-core/widgets/context-menu.js";

/** Usable workspace rect — below top chrome, left of right-dock. */
function workspaceRect() {
  const fn = window.__foyer?.workspaceRect;
  if (typeof fn === "function") {
    const r = fn();
    if (r && r.width > 0 && r.height > 0) return r;
  }
  return {
    top: 0, left: 0,
    right: window.innerWidth, bottom: window.innerHeight,
    width: window.innerWidth, height: window.innerHeight,
  };
}

/**
 * Clamp a window so at least the header strip and a thumb-width of body
 * stay reachable inside the workspace. Prevents the "window is off-screen
 * and I can't click its close button" trap.
 */
function clampToWorkspace(rect) {
  const ws = workspaceRect();
  const headerStrip = 28;
  const minVisibleX = 40;
  const w = Math.min(rect.w, ws.width);
  const h = Math.min(rect.h, ws.height);
  const x = Math.max(ws.left - (w - minVisibleX), Math.min(ws.right - minVisibleX, rect.x));
  const y = Math.max(ws.top, Math.min(ws.bottom - headerStrip, rect.y));
  return { x, y, w, h };
}

const VIEW_LABELS = {
  mixer: "Mixer",
  timeline: "Timeline",
  plugins: "Plugins",
  console: "Console",
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
    header .slot-tag-btn {
      font-size: 9px;
      font-family: var(--font-mono);
      padding: 1px 6px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      color: var(--color-text-muted);
      background: transparent;
      cursor: pointer;
      height: 20px;
    }
    header .slot-tag-btn:hover {
      color: var(--color-text);
      border-color: var(--color-accent);
      background: color-mix(in oklab, var(--color-accent) 12%, transparent);
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

    /* 8 resize handles — four edges + four corners. Z-index high enough
     * to beat any internal widget that uses position:relative/absolute
     * with its own stacking context (track-strip's channel-resize handle
     * was the original offender). */
    .h {
      position: absolute;
      z-index: 50;
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
    this._onResize = () => {
      // Browser viewport changed (half-screen ↔ full-screen on an
      // ultrawide, window resize, rotate). Re-flow every slot-pinned
      // window AND clamp every absolute window back inside the new
      // workspace so nothing lands off-screen.
      this._reflowSlots();
      this._clampAllFloats();
      this._refresh();
    };
    // Plugin panels render live session data; re-render on snapshot arrival.
    this._onDataChange = () => this.requestUpdate();
    // Right-dock width changed → any window pinned to a slot should
    // re-compute its bounds against the new workspace rect.
    this._onDockResized = () => this._reflowSlots();

    // Click-to-raise. Inline `@pointerdown` on `.window` works most of the
    // time but fails when a deeply-nested child (fader, track strip,
    // etc.) lives in its own shadow root and the pointerdown gets absorbed
    // before the outer `.window` sees it. This document-level capture
    // listener walks the composed event path looking for a `.window`
    // element from our shadow root, and raises whichever window's entry
    // it belongs to. Guaranteed to fire before child handlers.
    this._onDocPointerDown = (ev) => this._handleRaise(ev);
  }

  /**
   * Find the `.window` element on the event's composed path that belongs
   * to THIS floating-tiles shadow root, and raise the corresponding
   * floating entry to the top of the z-stack.
   */
  _handleRaise(ev) {
    if (ev.button !== 0) return;
    const path = ev.composedPath ? ev.composedPath() : [];
    const myMenu = this.renderRoot;
    for (const n of path) {
      if (!n || !n.classList) continue;
      if (n.classList.contains("window") && myMenu?.contains(n)) {
        // data-float-id set in the render; fallback to DOM order if missing.
        const fid = n.getAttribute("data-float-id");
        if (fid) this.store?.raiseFloat(fid);
        return;
      }
    }
  }

  connectedCallback() {
    super.connectedCallback();
    this.store?.addEventListener("change", this._onChange);
    window.addEventListener("resize", this._onResize);
    window.__foyer?.store?.addEventListener("change", this._onDataChange);
    // Click-to-raise listener — document-level capture beats whatever
    // child absorbs the pointerdown before it reaches our .window handler.
    document.addEventListener("pointerdown", this._onDocPointerDown, true);
    window.addEventListener("foyer:dock-resized", this._onDockResized);
    // Expose on the global so shadow-DOM-hidden components can call
    // us without document.querySelector piercing.
    if (window.__foyer) window.__foyer.floatingTiles = this;
    this._refresh();
  }
  disconnectedCallback() {
    this.store?.removeEventListener("change", this._onChange);
    window.removeEventListener("resize", this._onResize);
    window.__foyer?.store?.removeEventListener("change", this._onDataChange);
    document.removeEventListener("pointerdown", this._onDocPointerDown, true);
    window.removeEventListener("foyer:dock-resized", this._onDockResized);
    if (window.__foyer?.floatingTiles === this) window.__foyer.floatingTiles = null;
    super.disconnectedCallback();
  }

  /**
   * Re-apply any window's slot to the current workspace rect. Called when
   * the right-dock's width changes OR the viewport resizes — a window
   * pinned to "left-half" must shrink if the dock panel opens, and grow
   * back when it closes; both should also follow a browser resize from
   * half-screen to full-screen on an ultrawide.
   */
  _reflowSlots() {
    const entries = this.store?.floating?.() || [];
    for (const e of entries) {
      if (!e.slot) continue;
      const rect = slotBounds(e.slot);
      if (rect) this.store.floatSet(e.id, { ...rect });
    }
  }

  /** Clamp every floating window back inside the current workspace rect.
   *  For absolute windows, preserves their size if it fits and nudges x/y
   *  back on-screen. Keeps slot-pinned windows alone — `_reflowSlots()`
   *  already handled those. */
  _clampAllFloats() {
    const entries = this.store?.floating?.() || [];
    for (const e of entries) {
      if (e.slot) continue;
      const r = clampToWorkspace({ x: e.x, y: e.y, w: e.w, h: e.h });
      if (r.x !== e.x || r.y !== e.y || r.w !== e.w || r.h !== e.h) {
        this.store.floatSet(e.id, r);
      }
    }
  }

  _refresh() {
    // Sort by z so DOM order matches paint order.
    const arr = (this.store?.floating?.() || []).slice();
    arr.sort((a, b) => (a.z | 0) - (b.z | 0));
    this._entries = arr;
  }

  render() {
    // Tile-class floats (Mixer, Timeline tear-outs, etc.) always
    // render — they belong to the mature tile-grid surface and
    // aren't subject to the widgets-layer visibility flag. Only
    // widget-class entries (Console, Diagnostics, Track editor,
    // Beat sequencer, …) respect `widgetsVisible` (DECISION 42).
    const layerVisible = this.store?.widgetsVisible?.() ?? true;
    const showWidget = (e) => e.kind !== "widget" || layerVisible;
    const shown = this._entries.filter((e) => !e.minimized && showWidget(e));
    const minimized = this._entries.filter((e) => e.minimized && showWidget(e));
    const topId = shown.length ? shown[shown.length - 1].id : null;
    return html`
      ${repeat(
        shown,
        (e) => e.id,
        (e) => this._renderWindow(e, e.id === topId),
      )}
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

  /**
   * Right-click anywhere on a floating window pops a rescue/utility menu.
   * Especially useful when the header controls have been dragged off-screen —
   * the entire body is always a valid right-click target, so the user can
   * always recover.
   */
  _windowContextMenu(ev, e) {
    ev.preventDefault();
    ev.stopPropagation();
    const items = [
      { heading: this._titleFor(e) },
      {
        label: "Bring back on-screen",
        icon: "arrows-pointing-in",
        action: () => {
          const r = clampToWorkspace({ x: e.x, y: e.y, w: e.w, h: e.h });
          this.store.floatSet(e.id, { ...r, slot: null });
          this.store.raiseFloat(e.id);
        },
      },
      {
        label: "Bring to front",
        icon: "arrow-top-right-on-square",
        action: () => this.store.raiseFloat(e.id),
      },
      { separator: true },
      { heading: "Snap to slot" },
      ...SLOT_PRESETS.slice(0, 9).map((s) => ({
        label: s.label,
        icon: "squares-2x2",
        shortcut: SLOT_SHORTCUTS[s.id] || "",
        action: () => {
          const rect = slotBounds(s.id);
          if (rect) this.store.floatSet(e.id, { ...rect, slot: s.id });
        },
      })),
      { separator: true },
      {
        label: e.minimized ? "Restore" : "Minimize to dock",
        icon: e.minimized ? "arrow-top-right-on-square" : "minus",
        action: () => this.store.floatSet(e.id, { minimized: !e.minimized }),
      },
      {
        label: "Dock back into tiles",
        icon: "arrow-down-left-on-square",
        action: () => this.store.dockFloat(e.id),
      },
      {
        label: "Close",
        icon: "x-mark",
        tone: "danger",
        action: () => this.store.removeFloat(e.id),
      },
    ];
    showContextMenu(ev, items);
  }

  /**
   * Clickable slot-tag in the window header: pops a menu of every slot with
   * its keyboard shortcut annotated. Rich's ask — "if you click on the
   * position (like tl or center-third) it should show a little menu with
   * highlighted keyboard shortcuts to place the window."
   */
  _slotTagMenu(ev, entry) {
    ev.preventDefault();
    ev.stopPropagation();
    const items = [
      { heading: `${this._titleFor(entry)} · slot` },
      ...SLOT_PRESETS.map((s) => ({
        label: s.label,
        icon: entry.slot === s.id ? "check" : "squares-2x2",
        shortcut: SLOT_SHORTCUTS[s.id] || "",
        action: () => {
          const rect = slotBounds(s.id);
          if (rect) this.store.floatSet(entry.id, { ...rect, slot: s.id });
        },
      })),
      { separator: true },
      {
        label: "Unslot (go absolute)",
        icon: "x-mark",
        action: () => this.store.floatSet(entry.id, { slot: null }),
        disabled: !entry.slot,
      },
    ];
    showContextMenu(ev, items);
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
        data-float-id=${e.id}
        @pointerdown=${() => this.store.raiseFloat(e.id)}
        @contextmenu=${(ev) => this._windowContextMenu(ev, e)}
      >
        <header @pointerdown=${(ev) => this._startMove(ev, e)}>
          <span class="label">${this._titleFor(e)}</span>
          <button
            class="slot-tag-btn"
            title="Re-slot — shows keyboard shortcuts"
            @pointerdown=${(ev) => ev.stopPropagation()}
            @click=${(ev) => this._slotTagMenu(ev, e)}
          >
            ${e.slot ?? "no slot"}
          </button>
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
      // `session` (Projects browser) is no longer a tile-class view.
      // It still exists as a modal body inside `<foyer-project-picker-modal>`
      // — the canonical "open project" UI. Spawning it as a free-floating
      // widget produced a redundant surface (the screenshot Rich nuked),
      // so we removed the case. Anyone who has a stale `session` entry
      // in their saved float list falls through to the empty default
      // arm below, which is a safe no-op.
      case "console":
        return html`<foyer-console-view></foyer-console-view>`;
      case "diagnostics":
        return html`<foyer-diagnostics></foyer-diagnostics>`;
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
    const rightDock = window.__foyer?.rightDock;
    let overRail = false;
    const isOverRail = (x, y) => {
      const r = rightDock?.railRect?.();
      return !!(r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
    };
    // Hold any of Alt/Ctrl/Shift during the drag to hide the slot grid and
    // place the window at raw pixel coordinates — releasing while held
    // commits the absolute rect without snapping. Modifier state is polled
    // every pointermove so the user can grab & release mid-drag.
    const isBypass = (e) => !!(e && (e.altKey || e.ctrlKey || e.shiftKey));
    const move = (e) => {
      const nowOverRail = isOverRail(e.clientX, e.clientY);
      if (nowOverRail !== overRail) {
        overRail = nowOverRail;
        rightDock?.setDropHighlight?.(overRail);
      }
      const clamped = clampToWorkspace({
        x: ox + (e.clientX - startX),
        y: oy + (e.clientY - startY),
        w: entry.w,
        h: entry.h,
      });
      this.store.floatSet(entry.id, { x: clamped.x, y: clamped.y, slot: null });
      if (isBypass(e)) {
        zones.setBypassed(true);
      } else {
        zones.setBypassed(false);
        zones.update(e.clientX, e.clientY);
      }
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
      // Alt/Ctrl/Shift held at release means "no snapping, I meant those pixels."
      const altBypass = isBypass(e);
      if (snap && !altBypass) {
        const rect = slotBounds(snap);
        if (rect) {
          this.store.floatSet(entry.id, { ...rect, slot: snap });
          try {
            localStorage.setItem(`foyer.layout.sticky.${entry.view}`, snap);
          } catch {}
        }
        return;
      }
      if (altBypass) return; // keep the absolute rect we committed during drag
      // No explicit drop-zone target. If the release rect still matches a
      // slot (within tolerance), re-adopt that slot — small nudges on a
      // slot-pinned window stay relative. Otherwise the window is absolute.
      const finalEntry = this.store.floating().find((x) => x.id === entry.id);
      if (finalEntry) {
        const match = slotForRect({
          x: finalEntry.x, y: finalEntry.y,
          w: finalEntry.w, h: finalEntry.h,
        });
        if (match) {
          this.store.floatSet(entry.id, { ...match.bounds, slot: match.id });
        }
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Find visible floats whose opposite edge sits flush with `entry`'s
   *  `dir` edge (within `tol` px). These are the "splitter partners":
   *  when the user drags the shared edge, both sides move together so
   *  a clean 50/50 split resizes like a Figma/Rectangle divider. */
  _collectResizePartners(entry, dir, tol = 8) {
    const partners = [];
    const eN = entry.y;
    const eS = entry.y + entry.h;
    const eW = entry.x;
    const eE = entry.x + entry.w;
    for (const other of this._entries) {
      if (!other || other.id === entry.id || other.minimized) continue;
      const oN = other.y;
      const oS = other.y + other.h;
      const oW = other.x;
      const oE = other.x + other.w;
      // Share the east border of `entry` ↔ west border of `other`.
      const overlapsV = Math.max(eN, oN) < Math.min(eS, oS) - 4;
      const overlapsH = Math.max(eW, oW) < Math.min(eE, oE) - 4;
      if (dir.includes("e") && overlapsV && Math.abs(eE - oW) <= tol) {
        partners.push({ entry: other, edge: "w", ox: oW, ow: other.w });
      }
      if (dir.includes("w") && overlapsV && Math.abs(eW - oE) <= tol) {
        partners.push({ entry: other, edge: "e", ox: oW, ow: other.w });
      }
      if (dir.includes("s") && overlapsH && Math.abs(eS - oN) <= tol) {
        partners.push({ entry: other, edge: "n", oy: oN, oh: other.h });
      }
      if (dir.includes("n") && overlapsH && Math.abs(eN - oS) <= tol) {
        partners.push({ entry: other, edge: "s", oy: oN, oh: other.h });
      }
    }
    return partners;
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

    // Paired-window resize: any other visible window whose opposite edge
    // touches OUR resize edge (within 8px tolerance) grows or shrinks
    // opposite our drag. "Two adjacent windows sharing a border act like
    // a splitter." Holding Alt disables pairing.
    const partners = ev.altKey ? [] : this._collectResizePartners(entry, dir, 8);

    // Resize model (per Rich): a slot-pinned window stays RELATIVE through
    // the drag — as long as the resized rect still matches some slot (within
    // tolerance) we keep it tagged with that slot so workspace reflows
    // follow. Only if the drag pulls it off every slot mapping does it
    // commit to an absolute rect (slot: null).
    let lastSlot = null;

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
      // Hold Alt (Option on macOS), Ctrl, or Shift to bypass slot snapping
      // — same chord family as every design tool. The resize commits raw
      // pixels regardless of whether the rect matches a slot.
      const bypass = e.altKey || e.ctrlKey || e.shiftKey;
      const match = bypass ? null : slotForRect({ x: nx, y: ny, w: nw, h: nh });
      if (match) {
        // Snap to the slot's canonical bounds so the window crisply
        // settles onto rails during a slot-compatible drag.
        lastSlot = match.id;
        this.store.floatSet(entry.id, { ...match.bounds, slot: match.id });
      } else {
        lastSlot = null;
        this.store.floatSet(entry.id, { x: nx, y: ny, w: nw, h: nh, slot: null });
      }
      // Move the partners. A dragged E edge pushes the partner's W
      // edge by the same dx; the partner grows or shrinks to match.
      // Symmetric for the other three edges. Slots break on the
      // partner the moment its rect leaves its own slot (the
      // splitter drag inherently "frees" the layout, per Rich).
      if (!e.altKey && partners.length) {
        for (const p of partners) {
          if (p.edge === "w") {
            const newX = p.ox + dx;
            const newW = Math.max(minW, p.ow - dx);
            this.store.floatSet(p.entry.id, { x: newX, w: newW, slot: null });
          } else if (p.edge === "e") {
            const newW = Math.max(minW, p.ow + dx);
            this.store.floatSet(p.entry.id, { w: newW, slot: null });
          } else if (p.edge === "n") {
            const newY = p.oy + dy;
            const newH = Math.max(minH, p.oh - dy);
            this.store.floatSet(p.entry.id, { y: newY, h: newH, slot: null });
          } else if (p.edge === "s") {
            const newH = Math.max(minH, p.oh + dy);
            this.store.floatSet(p.entry.id, { h: newH, slot: null });
          }
        }
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      void lastSlot; // already committed per-move; kept for readability
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  _onSlotPicked(slotId) {
    const id = this._slotPickerFor;
    this._slotPickerFor = null;
    if (!id) return;
    const rect = slotBounds(slotId);
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
