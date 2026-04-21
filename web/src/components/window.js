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
import { icon } from "../icons.js";

const STORAGE_PREFIX = "foyer.window:";
const MIN_W = 320;
const MIN_H = 200;

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
    storageKey:  { type: String, attribute: "storage-key" },
    backdrop:    { type: Boolean, reflect: true },
    maximized:   { type: Boolean, reflect: true },
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
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg, 8px);
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
      overflow: hidden;
      pointer-events: auto;
      min-width: ${MIN_W}px;
      min-height: ${MIN_H}px;
    }
    :host([maximized]) .win {
      top: 0 !important; left: 0 !important;
      width: 100vw !important; height: 100vh !important;
      border-radius: 0;
    }
    header {
      flex: 0 0 auto;
      display: flex; align-items: center; gap: 10px;
      padding: 8px 10px 8px 14px;
      background: var(--color-surface-elevated);
      border-bottom: 1px solid var(--color-border);
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
      background: var(--color-surface);
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
    this.initWidth = 960;
    this.initHeight = 640;

    this._x = 0; this._y = 0;
    this._w = this.initWidth; this._h = this.initHeight;

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
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("keydown", this._onKeydown);
  }

  _emitClose() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  _clampToViewport() {
    const maxX = Math.max(0, window.innerWidth  - 80);
    const maxY = Math.max(0, window.innerHeight - 40);
    this._x = Math.min(Math.max(-this._w + 80, this._x), maxX);
    this._y = Math.min(Math.max(0, this._y), maxY);
    this._w = Math.max(MIN_W, Math.min(this._w, window.innerWidth));
    this._h = Math.max(MIN_H, Math.min(this._h, window.innerHeight));
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
 */
export function openWindow({ title, icon, storageKey, content, width, height, backdrop = false }) {
  const w = document.createElement("foyer-window");
  if (title) w.title = title;
  if (icon) w.icon = icon;
  if (storageKey) w.storageKey = storageKey;
  if (width) w.initWidth = width;
  if (height) w.initHeight = height;
  if (backdrop) w.backdrop = true;
  if (content) w.appendChild(content);
  const close = () => { w.remove(); };
  w.addEventListener("close", close);
  document.body.appendChild(w);
  return close;
}
