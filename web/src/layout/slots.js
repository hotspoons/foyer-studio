// Named slot placements for floating windows.
//
// The slot-picker popover lets the user hand a new window a semantic location
// instead of a raw (x,y,w,h). Each slot is computed fresh against the current
// viewport so an ultrawide monitor vs. a laptop screen both feel right.
//
// The slot id is also remembered per-view-type (localStorage) so the next time
// you open the same view with no explicit slot, it returns to the same place.

/**
 * Every preset bundles a display-friendly grid for the slot picker and a
 * function that computes its rect for the current viewport.
 *
 * `row`/`col` are 1-based positions on a 4×3 grid the picker renders; `span`
 * determines how many cells the tile covers. This is rendering data only —
 * the `bounds(vw, vh, pad)` function is authoritative for placement.
 */
export const SLOT_PRESETS = [
  {
    id: "full",
    label: "Fullscreen",
    row: 1, col: 1, rowSpan: 3, colSpan: 4,
    bounds: (vw, vh, p) => ({ x: p, y: p, w: vw - 2 * p, h: vh - 2 * p }),
  },

  // ── halves ────────────────────────────────────────────────────────────
  {
    id: "left-half",
    label: "Left Half",
    row: 1, col: 1, rowSpan: 3, colSpan: 2,
    bounds: (vw, vh, p) => ({ x: p, y: p, w: Math.floor((vw - 3 * p) / 2), h: vh - 2 * p }),
  },
  {
    id: "right-half",
    label: "Right Half",
    row: 1, col: 3, rowSpan: 3, colSpan: 2,
    bounds: (vw, vh, p) => {
      const w = Math.floor((vw - 3 * p) / 2);
      return { x: vw - w - p, y: p, w, h: vh - 2 * p };
    },
  },
  {
    id: "top-half",
    label: "Top Half",
    row: 1, col: 1, rowSpan: 1, colSpan: 4,
    bounds: (vw, vh, p) => ({ x: p, y: p, w: vw - 2 * p, h: Math.floor((vh - 3 * p) / 2) }),
  },
  {
    id: "bottom-half",
    label: "Bottom Half",
    row: 3, col: 1, rowSpan: 1, colSpan: 4,
    bounds: (vw, vh, p) => {
      const h = Math.floor((vh - 3 * p) / 2);
      return { x: p, y: vh - h - p, w: vw - 2 * p, h };
    },
  },

  // ── thirds (ultrawide) ────────────────────────────────────────────────
  {
    id: "left-third",
    label: "Left Third",
    row: 1, col: 1, rowSpan: 3, colSpan: 1,
    bounds: (vw, vh, p) => ({ x: p, y: p, w: Math.floor((vw - 4 * p) / 3), h: vh - 2 * p }),
  },
  {
    id: "center-third",
    label: "Center Third",
    row: 1, col: 2, rowSpan: 3, colSpan: 1,
    bounds: (vw, vh, p) => {
      const w = Math.floor((vw - 4 * p) / 3);
      return { x: Math.floor((vw - w) / 2), y: p, w, h: vh - 2 * p };
    },
  },
  {
    id: "right-third",
    label: "Right Third",
    row: 1, col: 4, rowSpan: 3, colSpan: 1,
    bounds: (vw, vh, p) => {
      const w = Math.floor((vw - 4 * p) / 3);
      return { x: vw - w - p, y: p, w, h: vh - 2 * p };
    },
  },
  {
    id: "left-two-thirds",
    label: "Left 2/3",
    row: 1, col: 1, rowSpan: 3, colSpan: 2,
    bounds: (vw, vh, p) => {
      const third = Math.floor((vw - 4 * p) / 3);
      return { x: p, y: p, w: third * 2 + p, h: vh - 2 * p };
    },
  },
  {
    id: "right-two-thirds",
    label: "Right 2/3",
    row: 1, col: 3, rowSpan: 3, colSpan: 2,
    bounds: (vw, vh, p) => {
      const third = Math.floor((vw - 4 * p) / 3);
      const w = third * 2 + p;
      return { x: vw - w - p, y: p, w, h: vh - 2 * p };
    },
  },

  // ── quadrants ─────────────────────────────────────────────────────────
  {
    id: "tl",
    label: "Top-Left",
    row: 1, col: 1, rowSpan: 1, colSpan: 2,
    bounds: (vw, vh, p) => ({
      x: p, y: p,
      w: Math.floor((vw - 3 * p) / 2),
      h: Math.floor((vh - 3 * p) / 2),
    }),
  },
  {
    id: "tr",
    label: "Top-Right",
    row: 1, col: 3, rowSpan: 1, colSpan: 2,
    bounds: (vw, vh, p) => {
      const w = Math.floor((vw - 3 * p) / 2);
      const h = Math.floor((vh - 3 * p) / 2);
      return { x: vw - w - p, y: p, w, h };
    },
  },
  {
    id: "bl",
    label: "Bottom-Left",
    row: 3, col: 1, rowSpan: 1, colSpan: 2,
    bounds: (vw, vh, p) => {
      const w = Math.floor((vw - 3 * p) / 2);
      const h = Math.floor((vh - 3 * p) / 2);
      return { x: p, y: vh - h - p, w, h };
    },
  },
  {
    id: "br",
    label: "Bottom-Right",
    row: 3, col: 3, rowSpan: 1, colSpan: 2,
    bounds: (vw, vh, p) => {
      const w = Math.floor((vw - 3 * p) / 2);
      const h = Math.floor((vh - 3 * p) / 2);
      return { x: vw - w - p, y: vh - h - p, w, h };
    },
  },

  // ── center floating ───────────────────────────────────────────────────
  {
    id: "center",
    label: "Center",
    row: 2, col: 2, rowSpan: 1, colSpan: 2,
    bounds: (vw, vh, _p) => {
      const w = Math.min(760, Math.floor(vw * 0.6));
      const h = Math.min(520, Math.floor(vh * 0.6));
      return { x: Math.floor((vw - w) / 2), y: Math.floor((vh - h) / 2), w, h };
    },
  },
];

/** Rect for a named slot, or `null` if the name is unknown. */
export function slotBounds(id, vw, vh, pad = 24) {
  const s = SLOT_PRESETS.find((x) => x.id === id);
  return s ? s.bounds(vw, vh, pad) : null;
}
