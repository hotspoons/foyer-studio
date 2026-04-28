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

// Drop targets organized by (vertical band × horizontal band). The pointer's
// position picks which cluster is live; inside each cluster we walk in
// priority order and take the first containing target.
//
// Vertical bands:
//   · `top`    : pointer in top 25%    → quadrants + top-half
//   · `bottom` : pointer in bottom 25% → quadrants + bottom-half
//   · `middle` : pointer in middle 50% → full-height columns
//
// Horizontal bands (only consulted in the `middle` vertical band, where
// left/right halves and thirds compete for the same pixel space):
//   · `left-edge`  : x in outer 20% on the left   → left-half
//   · `right-edge` : x in outer 20% on the right  → right-half
//   · `center`     : everything else              → thirds
//
// `full` is the final fallback everywhere.
const TOP_TARGETS = ["tl", "tr", "top-half", "left-half", "right-half", "full"];
const BOTTOM_TARGETS = ["bl", "br", "bottom-half", "left-half", "right-half", "full"];

const MIDDLE_TARGETS = {
  "left-edge":  ["left-half", "left-third", "full"],
  "right-edge": ["right-half", "right-third", "full"],
  "center":     ["left-third", "center-third", "right-third", "full"],
};

/** Union of everything we might render. */
const ALL_TARGETS = Array.from(new Set([
  ...TOP_TARGETS,
  ...BOTTOM_TARGETS,
  ...Object.values(MIDDLE_TARGETS).flat(),
]));

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

    for (const id of ALL_TARGETS) {
      const b = slotBounds(id);
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

  /**
   * Temporarily hide the grid while the user holds a bypass modifier
   * (Alt/Ctrl/Shift during a drag). The overlay is not destroyed — the next
   * `update()` call after un-bypassing will repaint targets. We clear
   * `current` so a release while bypassed won't snap to a stale target.
   */
  setBypassed(bypassed) {
    if (!this.el) return;
    if (bypassed) {
      this.el.style.display = "none";
      for (const [, cell] of this.highlights) cell.style.opacity = "0";
      this.current = null;
    } else {
      this.el.style.display = "block";
    }
  }

  /** Rebuild positions if the viewport changed. */
  _relayout() {
    for (const [id, cell] of this.highlights) {
      const b = slotBounds(id);
      if (!b) continue;
      cell.style.left = b.x + "px";
      cell.style.top = b.y + "px";
      cell.style.width = b.w + "px";
      cell.style.height = b.h + "px";
    }
  }

  /** Drive from pointermove — returns the currently-highlighted slot id (or null). */
  update(x, y) {
    const ws = typeof window !== "undefined" && window.__foyer?.workspaceRect
      ? window.__foyer.workspaceRect()
      : { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight,
          width: window.innerWidth, height: window.innerHeight };

    // Vertical band within the WORKSPACE (not the full viewport) — so the
    // top chrome isn't mistaken for the bottom half of the drop area.
    const topEdge = ws.top + ws.height * 0.25;
    const bottomEdge = ws.top + ws.height * 0.75;
    let priorities;
    if (y < topEdge) {
      priorities = TOP_TARGETS;
    } else if (y > bottomEdge) {
      priorities = BOTTOM_TARGETS;
    } else {
      // Middle band — horizontal sub-band decides half-vs-third.
      const leftHalfEdge = ws.left + ws.width * 0.2;
      const rightHalfEdge = ws.left + ws.width * 0.8;
      const hBand =
        x < leftHalfEdge ? "left-edge" :
        x > rightHalfEdge ? "right-edge" :
        "center";
      priorities = MIDDLE_TARGETS[hBand];
    }

    // Pick the hover target first (highest-priority target containing the
    // pointer). We need this *before* the visibility pass so we can hide
    // any in-band sibling that's fully contained by it — e.g. when
    // right-half is the active target, we hide right-third which would
    // otherwise bleed through as a dimmed rectangle on top of it.
    let best = null;
    let bestRect = null;
    for (const id of priorities) {
      const b = slotBounds(id);
      if (!b) continue;
      if (x < b.x || x > b.x + b.w) continue;
      if (y < b.y || y > b.y + b.h) continue;
      best = id;
      bestRect = b;
      break;
    }

    const EPS = 1;
    const contained = (inner, outer) =>
      inner.x >= outer.x - EPS &&
      inner.y >= outer.y - EPS &&
      inner.x + inner.w <= outer.x + outer.w + EPS &&
      inner.y + inner.h <= outer.y + outer.h + EPS;

    const activeSet = new Set(priorities);
    for (const [id, cell] of this.highlights) {
      const isActive = activeSet.has(id);
      if (!isActive) { cell.style.opacity = "0"; continue; }
      if (id === best) continue; // handled below at 0.9
      // Suppress siblings that the active target fully contains so the hover
      // target reads as a clean highlight. Non-contained peers stay dim.
      if (best && bestRect) {
        const b = slotBounds(id);
        if (b && contained(b, bestRect)) { cell.style.opacity = "0"; continue; }
      }
      cell.style.opacity = "0.22";
      cell.style.background =
        "color-mix(in oklab, var(--color-accent) 6%, transparent)";
    }

    if (best !== this.current) {
      if (this.current && this.current !== best) {
        const prev = this.highlights.get(this.current);
        if (prev) {
          prev.style.background =
            "color-mix(in oklab, var(--color-accent) 6%, transparent)";
        }
      }
      this.current = best;
    }
    if (best) {
      const el = this.highlights.get(best);
      if (el) {
        el.style.opacity = "0.9";
        el.style.background =
          "color-mix(in oklab, var(--color-accent) 22%, transparent)";
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
