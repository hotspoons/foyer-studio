// Drop-zone overlay for tear-out + window drag.
//
// Shows a pointer-following HUD with slot targets (left-half, center, right-
// half, top-half, bottom-half, corners, float). During an active drag the
// caller drives `update(clientX, clientY)` on every pointermove; we hit-test
// the pointer against target regions and expose `current()` which returns
// the slot id under the pointer (or null). The caller then asks for
// `slotBounds(id, ...)` when the user releases.
//
// Zero allocation during drag — we reuse the same element for the entire
// drag session via show()/update()/hide().
//
// Visual note: left/right/top/bottom targets are stripe regions anchored to
// the edges of the viewport, thirds are vertical bars, and "float" is the
// center neutral zone that means "just place at release point."

import { SLOT_PRESETS, slotBounds } from "./slots.js";

// Subset of SLOT_PRESETS we expose as drop targets. The ergonomic set — not
// every preset is a useful drop target during a drag. Order matters: earlier
// entries are tested first.
const DROP_TARGETS = [
  "left-third",
  "center-third",
  "right-third",
  "left-half",
  "right-half",
  "top-half",
  "bottom-half",
  "tl",
  "tr",
  "bl",
  "br",
  "full",
];

class DropZonesOverlay {
  constructor() {
    this.el = null;
    this.current = null;
    this.highlights = new Map();
  }

  ensure() {
    if (this.el) return this.el;
    const root = document.createElement("div");
    root.className = "foyer-dropzones";
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "5500",
      display: "none",
    });

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 24;
    for (const id of DROP_TARGETS) {
      const b = slotBounds(id, vw, vh, pad);
      if (!b) continue;
      const cell = document.createElement("div");
      const meta = SLOT_PRESETS.find((x) => x.id === id);
      const label = meta?.label || id;
      Object.assign(cell.style, {
        position: "absolute",
        left: b.x + "px",
        top: b.y + "px",
        width: b.w + "px",
        height: b.h + "px",
        border: "2px dashed color-mix(in oklab, var(--color-accent) 40%, transparent)",
        background: "color-mix(in oklab, var(--color-accent) 6%, transparent)",
        borderRadius: "10px",
        opacity: "0",
        transition: "opacity 0.12s ease, background 0.12s ease",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--color-text)",
        fontFamily: "var(--font-sans)",
        fontSize: "10px",
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        boxSizing: "border-box",
      });
      cell.dataset.slot = id;
      cell.textContent = label;
      root.appendChild(cell);
      this.highlights.set(id, cell);
    }
    document.body.appendChild(root);
    this.el = root;
    return root;
  }

  show() {
    const root = this.ensure();
    this._relayout();
    root.style.display = "block";
    this.current = null;
  }

  hide() {
    if (!this.el) return;
    this.el.style.display = "none";
    for (const [, cell] of this.highlights) cell.style.opacity = "0";
    this.current = null;
  }

  /** Rebuild positions if the viewport changed. */
  _relayout() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 24;
    for (const [id, cell] of this.highlights) {
      const b = slotBounds(id, vw, vh, pad);
      if (!b) continue;
      cell.style.left = b.x + "px";
      cell.style.top = b.y + "px";
      cell.style.width = b.w + "px";
      cell.style.height = b.h + "px";
    }
  }

  /** Drive from pointermove — returns the currently-highlighted slot id (or null). */
  update(x, y) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 24;
    // Pick the smallest-area region containing (x,y). "Smallest" because
    // corner-quadrants nest inside halves which nest inside fullscreen —
    // user intent is usually the most specific.
    let best = null;
    let bestArea = Infinity;
    for (const id of DROP_TARGETS) {
      const b = slotBounds(id, vw, vh, pad);
      if (!b) continue;
      if (x < b.x || x > b.x + b.w) continue;
      if (y < b.y || y > b.y + b.h) continue;
      const area = b.w * b.h;
      if (area < bestArea) {
        best = id;
        bestArea = area;
      }
    }
    if (best !== this.current) {
      if (this.current) {
        const prev = this.highlights.get(this.current);
        if (prev) {
          prev.style.opacity = "0";
          prev.style.background =
            "color-mix(in oklab, var(--color-accent) 6%, transparent)";
        }
      }
      this.current = best;
      if (best) {
        const el = this.highlights.get(best);
        if (el) {
          el.style.opacity = "0.9";
          el.style.background =
            "color-mix(in oklab, var(--color-accent) 22%, transparent)";
        }
      }
    }
    return best;
  }

  currentSlot() {
    return this.current;
  }
}

let _singleton = null;

/** Get (or create) the shared drop-zone overlay. */
export function dropZones() {
  if (!_singleton) _singleton = new DropZonesOverlay();
  return _singleton;
}
