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

// Drop targets organized by band. Hit-testing picks from the band that
// matches the pointer's vertical position, so dragging in the middle of the
// viewport surfaces full-height thirds/columns instead of quadrants.
//
// - `top`    : pointer is in the top 25% → quadrants + top-half
// - `middle` : pointer is in the middle 50% → full-height columns
// - `bottom` : pointer is in the bottom 25% → quadrants + bottom-half
//
// The `full` target is always available as a final fallback.
const BAND_TARGETS = {
  top:    ["tl", "tr", "top-half", "left-half", "right-half", "full"],
  middle: ["left-third", "center-third", "right-third", "left-half", "right-half", "full"],
  bottom: ["bl", "br", "bottom-half", "left-half", "right-half", "full"],
};

/** Union of everything we might render. */
const ALL_TARGETS = Array.from(new Set(Object.values(BAND_TARGETS).flat()));

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
    for (const id of ALL_TARGETS) {
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

    // Which band is the pointer in? Top/bottom 25% → quadrant-style;
    // middle 50% → full-height columns.
    const topEdge = vh * 0.25;
    const bottomEdge = vh * 0.75;
    const band = y < topEdge ? "top" : y > bottomEdge ? "bottom" : "middle";
    const priorities = BAND_TARGETS[band];

    // Dim everything that's not in this band so the user sees only the
    // relevant options.
    const activeSet = new Set(priorities);
    for (const [id, cell] of this.highlights) {
      const isActive = activeSet.has(id);
      // Small visible hint for inactive-band targets; the in-band targets
      // get a clearer preview background once one is hit.
      if (!isActive) {
        cell.style.opacity = "0";
        continue;
      }
      // In-band baseline (dim but visible so the user knows where zones are).
      if (cell.style.opacity === "0" || cell.style.opacity === "") {
        cell.style.opacity = "0.22";
      }
    }

    // First in priority order that contains (x,y).
    let best = null;
    for (const id of priorities) {
      const b = slotBounds(id, vw, vh, pad);
      if (!b) continue;
      if (x < b.x || x > b.x + b.w) continue;
      if (y < b.y || y > b.y + b.h) continue;
      best = id;
      break;
    }
    if (best !== this.current) {
      if (this.current) {
        const prev = this.highlights.get(this.current);
        if (prev) {
          // Non-active in-band zones stay faintly visible so the user still
          // sees the grid. Out-of-band zones were already hidden above.
          const stillInBand = activeSet.has(this.current);
          prev.style.opacity = stillInBand ? "0.22" : "0";
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
