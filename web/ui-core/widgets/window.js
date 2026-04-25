// Draggable / maximizable / resizable floating window.
//
// Lit component used as a chrome wrapper for any modal-ish UI that
// should feel like a real window — piano roll, track editor, MIDI
// manager, preview tiles, etc. Replaces the project's old pattern
// of manually spawning a `position:fixed` overlay for each modal.
//
// Features:
//   - Header with title + drag handle. Dragging the header moves
//     the whole window around the viewport.
//   - Maximize / restore toggle (double-click header also toggles).
//   - Close button (emits `close` event; parent removes the node).
//   - 8 resize handles (edges + corners), minimum 320×200.
//   - Position / size persisted per `storageKey` in localStorage.
//     Omit the key for a one-shot window that shouldn't remember.
//   - Optional `backdrop` attribute renders a dimmed click-off layer
//     behind the window (defaults to off — free-floating).
//   - Content via the default slot.
//
// Usage:
//   const w = document.createElement("foyer-window");
//   w.title = "MIDI — General MIDI Synth-3.1";
//   w.storageKey = "midi-editor";
//   w.appendChild(pianoRollEl);
//   w.addEventListener("close", () => w.remove());
//   document.body.appendChild(w);
//
// Keyboard:
//   Escape — close.
//   Double-click header — toggle maximize.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";

const STORAGE_PREFIX = "foyer.window:";
const MIN_W = 320;
const MIN_H = 200;
const CHROME_FALLBACK_PX = 100;

/**
 * Top edge below which a foyer-window must sit. Was a probe of
 * `foyer-main-menu` / `foyer-nav-bar` etc., but those live inside the
 * status-bar's shadow root so `document.querySelector` never found
 * them — every window fell back to the 100px default and the user
 * couldn't drag track-editor flush with the workspace top (Rich, 2026
 * -04-25). The right answer is the same authoritative rect that the
 * floating-tiles renderer uses, so widget-class windows from both
 * surfaces line up identically.
 */
function measureChromeTop() {
  const fn = (typeof window !== "undefined") && window.__foyer?.workspaceRect;
  if (typeof fn === "function") {
    const r = fn();
    if (r && Number.isFinite(r.top) && r.top >= 0) return Math.ceil(r.top);
  }
  return CHROME_FALLBACK_PX;
}

function loadBounds(key) {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const b = JSON.parse(raw);
    if (!b || typeof b !== "object") return null;
    return b;
  } catch { return null; }
}

function saveBounds(key, bounds) {
  if (!key) return;
  try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(bounds)); } catch {}
}

export class FoyerWindow extends LitElement {
  static properties = {
    title:       { type: String },
    icon:        { type: String },
    // `reflect: true` makes the property write back to the
    // `storage-key` attribute so `document.querySelector(
    //   'foyer-window[storage-key="…"]')` finds an existing window
    // and the idempotent reuse path in `openWindow` actually fires.
    // Without reflection the attribute stayed empty and every double-
    // click stacked another track editor (Rich, 2026-04-25).
    storageKey:  { type: String, attribute: "storage-key", reflect: true },
    backdrop:    { type: Boolean, reflect: true },
    maximized:   { type: Boolean, reflect: true },
    minimized:   { type: Boolean, reflect: true },
    // Default initial dimensions if nothing stored.
    initWidth:   { type: Number, attribute: "init-width" },
    initHeight:  { type: Number, attribute: "init-height" },
  };

  static styles = css`
    :host {
      position: fixed;
      /* Floating windows sit above normal tiles (900) but below the
         app's top menu (1300) so the user can still use the menu bar
         while a window is open. When the window is maximized we jump
         above the top menu so our own chrome (title, close, restore)
         isn't occluded — Rich's bug report: maximize used to hide the
         window's own header behind the app nav. */
      z-index: 1000;
      font-family: var(--font-sans);
      color: var(--color-text);
      pointer-events: none;
    }
    :host([maximized]) {
      z-index: 1400;
    }
    /* Widgets layer hides the foyer-window when widgetsVisible flips
     * false (auto-hide-on-tile-click + dock toggle). The "minimized"
     * attribute is the same idea but per-window: the dock can stash
     * a single window and restore it later. */
    :host([hidden-by-layer]),
    :host([minimized]) {
      display: none;
    }
    .backdrop { display: none; }
    :host([backdrop]) .backdrop {
      display: block;
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, 0.4);
      pointer-events: auto;
      z-index: -1;
    }
    .win {
      position: absolute;
      display: flex; flex-direction: column;
      /* Frosted-glass shell — widget-class windows read as visually
       * distinct from the opaque tile-class views (mixer, timeline)
       * underneath. The translucent background + backdrop-blur
       * surfaces context while keeping content legible. */
      background: color-mix(in oklab, var(--color-surface) 72%, transparent);
      backdrop-filter: blur(18px) saturate(130%);
      -webkit-backdrop-filter: blur(18px) saturate(130%);
      border: 1px solid color-mix(in oklab, var(--color-border) 70%, transparent);
      border-radius: var(--radius-lg, 8px);
      box-shadow:
        0 18px 50px rgba(0, 0, 0, 0.55),
        inset 0 1px 0 color-mix(in oklab, white 8%, transparent);
      overflow: hidden;
      pointer-events: auto;
      min-width: ${MIN_W}px;
      min-height: ${MIN_H}px;
    }
    :host([maximized]) .win {
      top: 0 !important; left: 0 !important;
      width: 100vw !important; height: 100vh !important;
      border-radius: 0;
      /* Maximized = fullscreen utility surface; frosted treatment
       * loses its purpose (nothing to see underneath), so we go
       * fully opaque to avoid the dimmed look. */
      background: var(--color-surface);
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
    header {
      flex: 0 0 auto;
      display: flex; align-items: center; gap: 10px;
      padding: 8px 10px 8px 14px;
      background: color-mix(in oklab, var(--color-surface-elevated) 82%, transparent);
      border-bottom: 1px solid color-mix(in oklab, var(--color-border) 60%, transparent);
      cursor: grab;
      user-select: none;
    }
    header.dragging { cursor: grabbing; }
    header .title-icon {
      color: var(--color-text-muted);
      display: flex; align-items: center;
    }
    header h2 {
      margin: 0; font-size: 13px; font-weight: 600;
      color: var(--color-text);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      min-width: 0;
    }
    header .spacer { flex: 1; min-width: 10px; }
    header button {
      background: transparent; border: 0; padding: 4px;
      color: var(--color-text-muted);
      border-radius: var(--radius-sm, 4px);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }
    header button:hover {
      background: var(--color-surface);
      color: var(--color-text);
    }
    .body {
      flex: 1; min-height: 0;
      display: flex; flex-direction: column;
      overflow: hidden;
      /* Transparent so the frosted shell shows through the gaps
       * between the slotted content's own opaque blocks. The
       * inner element (track-editor, midi-editor, etc.) brings
       * whatever density of background it wants. */
      background: transparent;
    }
    ::slotted(*) { flex: 1; min-height: 0; }

    /* Resize handles — 8 around the edges. Only rendered when not
       maximized. */
    .rh {
      position: absolute;
      z-index: 2;
    }
    :host([maximized]) .rh { display: none; }
    .rh.n  { top: 0; left: 8px; right: 8px; height: 6px; cursor: n-resize; }
    .rh.s  { bottom: 0; left: 8px; right: 8px; height: 6px; cursor: s-resize; }
    .rh.w  { top: 8px; bottom: 8px; left: 0; width: 6px; cursor: w-resize; }
    .rh.e  { top: 8px; bottom: 8px; right: 0; width: 6px; cursor: e-resize; }
    .rh.nw { top: 0; left: 0; width: 10px; height: 10px; cursor: nw-resize; }
    .rh.ne { top: 0; right: 0; width: 10px; height: 10px; cursor: ne-resize; }
    .rh.sw { bottom: 0; left: 0; width: 10px; height: 10px; cursor: sw-resize; }
    .rh.se { bottom: 0; right: 0; width: 10px; height: 10px; cursor: se-resize; }
  `;

  constructor() {
    super();
    this.title = "";
    this.icon = "";
    this.storageKey = "";
    this.backdrop = false;
    this.maximized = false;
    this.minimized = false;
    this.initWidth = 960;
    this.initHeight = 640;

    this._x = 0; this._y = 0;
    this._w = this.initWidth; this._h = this.initHeight;
    // Stable per-instance id used as the layout-store registration key.
    // Storage key is reused when present (dedupes a foyer-window opened
    // twice with the same identity to a single dock entry).
    this._layoutId = "";
    this._onWidgetsLayerChange = () => {
      const visible = window.__foyer?.layout?.widgetsVisible?.() ?? true;
      if (!visible) this.setAttribute("hidden-by-layer", "");
      else this.removeAttribute("hidden-by-layer");
    };

    this._onKeydown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this._emitClose();
      }
    };
  }

  connectedCallback() {
    super.connectedCallback();
    // Load stored bounds before first paint so we don't flash at the
    // default location.
    const stored = loadBounds(this.storageKey);
    if (stored) {
      this._x = stored.x ?? this._x;
      this._y = stored.y ?? this._y;
      this._w = stored.w ?? this._w;
      this._h = stored.h ?? this._h;
      if (stored.maximized) this.maximized = true;
    } else {
      this._w = this.initWidth;
      this._h = this.initHeight;
      this._x = Math.max(16, Math.round((window.innerWidth  - this._w) / 2));
      this._y = Math.max(16, Math.round((window.innerHeight - this._h) / 2));
    }
    this._clampToViewport();
    document.addEventListener("keydown", this._onKeydown);
    // Register with the widgets layer so the right-dock lists this
    // window and the layer's visibility/sticky/minimize-all controls
    // affect it. foyer-window instances are dialog-class widgets by
    // definition (track editor, MIDI editor, beat sequencer); they
    // belong in the dock alongside Console + Diagnostics.
    this._registerWithLayer();
    window.__foyer?.layout?.addEventListener?.("change", this._onWidgetsLayerChange);
    // Apply the current layer-visibility state on mount in case the
    // layer was already hidden when we opened.
    this._onWidgetsLayerChange();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("keydown", this._onKeydown);
    window.__foyer?.layout?.removeEventListener?.("change", this._onWidgetsLayerChange);
    this._unregisterFromLayer();
  }

  _registerWithLayer() {
    const layout = window.__foyer?.layout;
    if (!layout?.registerExternalWidget) return;
    this._layoutId =
      this.storageKey ||
      `foyer-window:${Math.random().toString(36).slice(2)}`;
    layout.registerExternalWidget(this._layoutId, {
      title: this.title || "Window",
      icon: this.icon || "document",
      view: this.title?.toLowerCase().split(" ")[0] || "widget",
      focus: () => {
        this.minimized = false;
        // Bring above siblings — the simplest portable z-bump that
        // works without managing a global stack ourselves.
        try { this.parentNode?.appendChild(this); } catch {}
        this._persist();
      },
      close: () => this._emitClose(),
      setMinimized: (on) => {
        this.minimized = !!on;
        this._persist();
      },
      tileTo: (rect) => {
        if (!rect) return;
        this._x = Math.round(rect.x);
        this._y = Math.round(rect.y);
        this._w = Math.max(MIN_W, Math.round(rect.w));
        this._h = Math.max(MIN_H, Math.round(rect.h));
        this.maximized = false;
        this.minimized = false;
        this._clampToViewport();
        this.requestUpdate();
        this._persist();
      },
    });
  }
  _unregisterFromLayer() {
    if (!this._layoutId) return;
    window.__foyer?.layout?.unregisterExternalWidget?.(this._layoutId);
    this._layoutId = "";
  }

  _emitClose() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  _clampToViewport() {
    // Window-rescue (Rich's 2026-04-21 ask): the title bar must
    // always be reachable. Two failure modes we've actually seen:
    //   1. Drag puts the title above the viewport.
    //   2. The app's top chrome (main menu + transport bar at
    //      z-index 1300) covers the title because the window's
    //      `y` is below the chrome height.
    // Measure the chrome height dynamically — fall back to 100px
    // if no element matches. The result becomes the minimum y.
    const chromeTop = measureChromeTop();
    const maxX = Math.max(0, window.innerWidth  - 80);
    const maxY = Math.max(chromeTop, window.innerHeight - 40);
    this._x = Math.min(Math.max(-this._w + 80, this._x), maxX);
    this._y = Math.min(Math.max(chromeTop, this._y), maxY);
    this._w = Math.max(MIN_W, Math.min(this._w, window.innerWidth));
    this._h = Math.max(MIN_H, Math.min(this._h, window.innerHeight - chromeTop));
  }

  /** Resize-rescue: any time the user drags a resize handle, also
   *  re-clamp so the title bar can't get pushed under the app
   *  chrome by a clipping resize. Called from the resize move/up
   *  handlers below. */
  _rescueOnResize() {
    this._clampToViewport();
  }

  _persist() {
    saveBounds(this.storageKey, {
      x: this._x, y: this._y, w: this._w, h: this._h,
      maximized: this.maximized,
    });
  }

  _toggleMax() {
    this.maximized = !this.maximized;
    this._persist();
  }

  _startDrag(ev) {
    if (this.maximized) return;
    if (ev.target.closest("button")) return; // don't drag from buttons
    ev.preventDefault();
    const startX = ev.clientX, startY = ev.clientY;
    const ox = this._x, oy = this._y;
    const header = this.renderRoot.querySelector("header");
    header?.classList.add("dragging");
    const move = (e) => {
      this._x = ox + (e.clientX - startX);
      this._y = oy + (e.clientY - startY);
      this._clampToViewport();
      this.requestUpdate();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      header?.classList.remove("dragging");
      this._persist();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  _startResize(ev, dirs) {
    if (this.maximized) return;
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX, startY = ev.clientY;
    const ox = this._x, oy = this._y, ow = this._w, oh = this._h;
    const move = (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let nx = ox, ny = oy, nw = ow, nh = oh;
      if (dirs.includes("e")) nw = Math.max(MIN_W, ow + dx);
      if (dirs.includes("s")) nh = Math.max(MIN_H, oh + dy);
      if (dirs.includes("w")) {
        nw = Math.max(MIN_W, ow - dx);
        nx = ox + (ow - nw);
      }
      if (dirs.includes("n")) {
        nh = Math.max(MIN_H, oh - dy);
        ny = oy + (oh - nh);
      }
      this._x = nx; this._y = ny; this._w = nw; this._h = nh;
      this._clampToViewport();
      this.requestUpdate();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this._persist();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  render() {
    const style = `left:${this._x}px;top:${this._y}px;width:${this._w}px;height:${this._h}px`;
    return html`
      <div class="backdrop" @pointerdown=${() => this._emitClose()}></div>
      <div class="win" style=${style}>
        <header @pointerdown=${(e) => this._startDrag(e)}
                @dblclick=${() => this._toggleMax()}>
          ${this.icon ? html`<span class="title-icon">${icon(this.icon, 14)}</span>` : null}
          <h2>${this.title || ""}</h2>
          <span class="spacer"></span>
          <button title="Minimize to dock"
                  @click=${() => { this.minimized = true; this._persist();
                    window.__foyer?.layout?.setExternalMinimized?.(this._layoutId, true); }}>
            ${icon("minus", 14)}
          </button>
          <button title=${this.maximized ? "Restore" : "Maximize"}
                  @click=${() => this._toggleMax()}>
            ${icon(this.maximized ? "arrows-pointing-in" : "arrows-pointing-out", 14)}
          </button>
          <button title="Close" @click=${() => this._emitClose()}>
            ${icon("x-mark", 14)}
          </button>
        </header>
        <div class="body"><slot></slot></div>
        <div class="rh n"  @pointerdown=${(e) => this._startResize(e, "n")}></div>
        <div class="rh s"  @pointerdown=${(e) => this._startResize(e, "s")}></div>
        <div class="rh w"  @pointerdown=${(e) => this._startResize(e, "w")}></div>
        <div class="rh e"  @pointerdown=${(e) => this._startResize(e, "e")}></div>
        <div class="rh nw" @pointerdown=${(e) => this._startResize(e, "nw")}></div>
        <div class="rh ne" @pointerdown=${(e) => this._startResize(e, "ne")}></div>
        <div class="rh sw" @pointerdown=${(e) => this._startResize(e, "sw")}></div>
        <div class="rh se" @pointerdown=${(e) => this._startResize(e, "se")}></div>
      </div>
    `;
  }
}
customElements.define("foyer-window", FoyerWindow);

/**
 * Convenience helper to open a window around a content element. Returns
 * a detach function that removes the window.
 *
 * Idempotent on `storageKey`: a second `openWindow` for an already-open
 * window focuses + un-minimizes the existing instance instead of stacking
 * a duplicate. Any new `content` passed on a re-open is dropped — the
 * caller is asked to mutate the existing inner element if it needs to
 * change state. (Track editor, MIDI editor, beat sequencer all share
 * this codepath.)
 */
// ── persistence: remember which kinds of windows were open across reloads ──
//
// `_floating` (in layout-store) used to persist Console + Diagnostics
// because they were tile-class floats. After moving them to the
// foyer-window chrome (2026-04-25), nothing remembered open windows on
// reload. We bring back the same UX with a tiny registry: each spawn
// site registers a kind + factory once, openWindow records the kind in
// localStorage on creation and removes it on close, and `rehydrateWindows`
// replays the list at boot. Track Editor / MIDI Editor / Beat Sequencer
// participate too; they need the live session to resolve track / region
// IDs, so the caller is expected to invoke `rehydrateWindows()` AFTER
// the first session snapshot has landed.
const PERSIST_KEY = "foyer.windows.open.v1";
const FACTORIES = new Map();

function _loadPersisted() {
  try { return JSON.parse(localStorage.getItem(PERSIST_KEY) || "[]") || []; }
  catch { return []; }
}
function _savePersisted(arr) {
  try { localStorage.setItem(PERSIST_KEY, JSON.stringify(arr)); } catch {}
}
function _persistKey(entry) {
  return `${entry.kind}::${entry.id ?? ""}`;
}

/** Add (or update) an entry in the persisted open-list. Idempotent on `(kind, id)`. */
function _recordOpen(persist) {
  const list = _loadPersisted();
  const key = _persistKey(persist);
  const idx = list.findIndex((e) => _persistKey(e) === key);
  if (idx >= 0) list[idx] = persist;
  else list.push(persist);
  _savePersisted(list);
}
function _recordClose(persist) {
  const key = _persistKey(persist);
  _savePersisted(_loadPersisted().filter((e) => _persistKey(e) !== key));
}

/**
 * Register a factory for a window kind. Called once at module load by
 * each spawn site (`right-dock.js` for console + diagnostics,
 * `track-editor-modal.js` for track editor, etc.). The factory
 * receives the `props` saved alongside the entry and is expected to
 * call `openWindow` itself (which idempotently dedupes by storageKey).
 */
export function registerWindowKind(kind, factory) {
  if (typeof factory === "function") FACTORIES.set(kind, factory);
}

/** Replay every persisted open window. Safe to call multiple times. */
export function rehydrateWindows() {
  const list = _loadPersisted();
  for (const entry of list) {
    const fn = FACTORIES.get(entry.kind);
    if (!fn) continue;
    try { fn(entry.props || {}); }
    catch (e) { console.warn("rehydrate failed for", entry.kind, e); }
  }
}

export function openWindow({ title, icon, storageKey, content, width, height, backdrop = false, onReuse, persist }) {
  if (storageKey) {
    const existing = document.querySelector(
      `foyer-window[storage-key="${CSS.escape(storageKey)}"]`,
    );
    if (existing) {
      existing.minimized = false;
      // If the caller passed fresh content, hand it to `onReuse` so the
      // caller can mutate the existing inner element instead of letting
      // us stack a duplicate (beat-sequencer, midi-editor reuse a single
      // storageKey across regions and need this hook to retarget).
      if (typeof onReuse === "function") {
        try {
          const existingContent = existing.firstElementChild;
          onReuse(existingContent, content);
        } catch (e) { console.warn("openWindow onReuse failed", e); }
      } else if (content && content !== existing.firstElementChild) {
        // No reuse hook + caller passed new content — replace inline.
        try {
          while (existing.firstChild) existing.removeChild(existing.firstChild);
          existing.appendChild(content);
        } catch {}
      }
      if (title) existing.title = title;
      try {
        document.body.appendChild(existing); // bump above siblings
      } catch {}
      try {
        const layoutId = existing._layoutId;
        if (layoutId) {
          window.__foyer?.layout?.setExternalMinimized?.(layoutId, false);
        }
      } catch {}
      if (persist?.kind) _recordOpen(persist);
      return () => existing.remove();
    }
  }
  const w = document.createElement("foyer-window");
  if (title) w.title = title;
  if (icon) w.icon = icon;
  if (storageKey) w.storageKey = storageKey;
  if (width) w.initWidth = width;
  if (height) w.initHeight = height;
  if (backdrop) w.backdrop = true;
  if (content) w.appendChild(content);
  if (persist?.kind) _recordOpen(persist);
  const close = () => {
    if (persist?.kind) _recordClose(persist);
    w.remove();
  };
  w.addEventListener("close", close);
  document.body.appendChild(w);
  return close;
}
