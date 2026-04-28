// Named slot placements for floating windows.
//
// The slot-picker popover lets the user hand a new window a semantic location
// instead of a raw (x,y,w,h). Each slot is computed fresh against the
// *workspace* rectangle (below the top chrome, to the left of the right-dock)
// so docked windows never overlap the status bar, main menu, transport bar,
// or the right rail.
//
// The slot id is also remembered per-view-type (localStorage) so the next time
// you open the same view with no explicit slot, it returns to the same place.

/**
 * Default keyboard shortcuts per slot. Modeled on Rectangle for macOS
 * (the de-facto standard for window-placement chords), with one key
 * change: we layer in `Shift` to keep the chord set free of Foyer's
 * existing `Ctrl+Alt+H/J/K/L` tile-focus family.
 *
 * - **Halves:** `Ctrl+Alt+Shift+Arrow` — the mental model that every
 *   Rectangle / Magnet / Windows-PowerToys-FancyZones user shares.
 * - **Quadrants:** `U/I/J/K` (Rectangle's native mapping; physically
 *   grouped on the keyboard, easy to grow into without remembering).
 * - **Thirds:** `1/2/3` + `4/5` for two-thirds — rough parity with
 *   Rectangle's D/F/G/E/T, but numeric keys are more discoverable
 *   for a new user.
 * - **Center / Fullscreen:** `C` and `F`, matching Rectangle verbatim.
 *
 * The runtime installer is in `web/src/layout/slot-keybinds.js`. All
 * bindings are rewirable at runtime (future slot editor) — these are
 * defaults, not destiny.
 */
export const SLOT_SHORTCUTS = {
  "left-half":       "Ctrl+Alt+Shift+Left",
  "right-half":      "Ctrl+Alt+Shift+Right",
  "top-half":        "Ctrl+Alt+Shift+Up",
  "bottom-half":     "Ctrl+Alt+Shift+Down",
  "left-third":      "Ctrl+Alt+Shift+1",
  "center-third":    "Ctrl+Alt+Shift+2",
  "right-third":     "Ctrl+Alt+Shift+3",
  "left-two-thirds": "Ctrl+Alt+Shift+4",
  "right-two-thirds":"Ctrl+Alt+Shift+5",
  "tl":              "Ctrl+Alt+Shift+U",
  "tr":              "Ctrl+Alt+Shift+I",
  "bl":              "Ctrl+Alt+Shift+J",
  "br":              "Ctrl+Alt+Shift+K",
  "center":          "Ctrl+Alt+Shift+C",
  "full":            "Ctrl+Alt+Shift+F",
};

/**
 * Resolve the usable workspace rect. The app shell registers
 * `window.__foyer.workspaceRect()` at boot; before that's ready we fall
 * back to the full viewport.
 */
function workspace() {
  const fn = typeof window !== "undefined" ? window.__foyer?.workspaceRect : null;
  if (typeof fn === "function") {
    const r = fn();
    if (r && r.width > 0 && r.height > 0) return r;
  }
  return {
    top: 0,
    left: 0,
    right: typeof window !== "undefined" ? window.innerWidth : 1280,
    bottom: typeof window !== "undefined" ? window.innerHeight : 720,
    width: typeof window !== "undefined" ? window.innerWidth : 1280,
    height: typeof window !== "undefined" ? window.innerHeight : 720,
  };
}

function mkRect(x, y, w, h) {
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * Every preset bundles a display-friendly grid for the slot picker and a
 * function that computes its rect for the current workspace.
 *
 * `row`/`col` are 1-based positions on a 4×3 grid the picker renders;
 * `span` determines how many cells the tile covers.
 *
 * Pad defaults to 0 — docked windows fit flush to the workspace edges.
 */
export const SLOT_PRESETS = [
  {
    id: "full",
    label: "Fullscreen",
    row: 1, col: 1, rowSpan: 3, colSpan: 4,
    bounds: (pad = 0) => {
      const w = workspace();
      return mkRect(w.left + pad, w.top + pad, w.width - 2 * pad, w.height - 2 * pad);
    },
  },

  // ── halves ────────────────────────────────────────────────────────────
  {
    id: "left-half",
    label: "Left Half",
    row: 1, col: 1, rowSpan: 3, colSpan: 2,
    bounds: (pad = 0) => {
      const w = workspace();
      const half = Math.floor((w.width - (pad > 0 ? 3 * pad : 0)) / 2);
      return mkRect(w.left + pad, w.top + pad, half, w.height - 2 * pad);
    },
  },
  {
    id: "right-half",
    label: "Right Half",
    row: 1, col: 3, rowSpan: 3, colSpan: 2,
    bounds: (pad = 0) => {
      const w = workspace();
      const half = Math.floor((w.width - (pad > 0 ? 3 * pad : 0)) / 2);
      return mkRect(w.right - half - pad, w.top + pad, half, w.height - 2 * pad);
    },
  },
  {
    id: "top-half",
    label: "Top Half",
    row: 1, col: 1, rowSpan: 1, colSpan: 4,
    bounds: (pad = 0) => {
      const w = workspace();
      const half = Math.floor((w.height - (pad > 0 ? 3 * pad : 0)) / 2);
      return mkRect(w.left + pad, w.top + pad, w.width - 2 * pad, half);
    },
  },
  {
    id: "bottom-half",
    label: "Bottom Half",
    row: 3, col: 1, rowSpan: 1, colSpan: 4,
    bounds: (pad = 0) => {
      const w = workspace();
      const half = Math.floor((w.height - (pad > 0 ? 3 * pad : 0)) / 2);
      return mkRect(w.left + pad, w.bottom - half - pad, w.width - 2 * pad, half);
    },
  },

  // ── thirds (ultrawide) ────────────────────────────────────────────────
  {
    id: "left-third",
    label: "Left Third",
    row: 1, col: 1, rowSpan: 3, colSpan: 1,
    bounds: (pad = 0) => {
      const w = workspace();
      const third = Math.floor((w.width - (pad > 0 ? 4 * pad : 0)) / 3);
      return mkRect(w.left + pad, w.top + pad, third, w.height - 2 * pad);
    },
  },
  {
    id: "center-third",
    label: "Center Third",
    row: 1, col: 2, rowSpan: 3, colSpan: 1,
    bounds: (pad = 0) => {
      const w = workspace();
      const third = Math.floor((w.width - (pad > 0 ? 4 * pad : 0)) / 3);
      return mkRect(w.left + Math.floor((w.width - third) / 2), w.top + pad, third, w.height - 2 * pad);
    },
  },
  {
    id: "right-third",
    label: "Right Third",
    row: 1, col: 4, rowSpan: 3, colSpan: 1,
    bounds: (pad = 0) => {
      const w = workspace();
      const third = Math.floor((w.width - (pad > 0 ? 4 * pad : 0)) / 3);
      return mkRect(w.right - third - pad, w.top + pad, third, w.height - 2 * pad);
    },
  },
  {
    id: "left-two-thirds",
    label: "Left 2/3",
    row: 1, col: 1, rowSpan: 3, colSpan: 2,
    bounds: (pad = 0) => {
      const w = workspace();
      const third = Math.floor((w.width - (pad > 0 ? 4 * pad : 0)) / 3);
      return mkRect(w.left + pad, w.top + pad, third * 2 + (pad > 0 ? pad : 0), w.height - 2 * pad);
    },
  },
  {
    id: "right-two-thirds",
    label: "Right 2/3",
    row: 1, col: 3, rowSpan: 3, colSpan: 2,
    bounds: (pad = 0) => {
      const w = workspace();
      const third = Math.floor((w.width - (pad > 0 ? 4 * pad : 0)) / 3);
      const width = third * 2 + (pad > 0 ? pad : 0);
      return mkRect(w.right - width - pad, w.top + pad, width, w.height - 2 * pad);
    },
  },

  // ── quadrants ─────────────────────────────────────────────────────────
  {
    id: "tl",
    label: "Top-Left",
    row: 1, col: 1, rowSpan: 1, colSpan: 2,
    bounds: (pad = 0) => {
      const w = workspace();
      const halfW = Math.floor((w.width - (pad > 0 ? 3 * pad : 0)) / 2);
      const halfH = Math.floor((w.height - (pad > 0 ? 3 * pad : 0)) / 2);
      return mkRect(w.left + pad, w.top + pad, halfW, halfH);
    },
  },
  {
    id: "tr",
    label: "Top-Right",
    row: 1, col: 3, rowSpan: 1, colSpan: 2,
    bounds: (pad = 0) => {
      const w = workspace();
      const halfW = Math.floor((w.width - (pad > 0 ? 3 * pad : 0)) / 2);
      const halfH = Math.floor((w.height - (pad > 0 ? 3 * pad : 0)) / 2);
      return mkRect(w.right - halfW - pad, w.top + pad, halfW, halfH);
    },
  },
  {
    id: "bl",
    label: "Bottom-Left",
    row: 3, col: 1, rowSpan: 1, colSpan: 2,
    bounds: (pad = 0) => {
      const w = workspace();
      const halfW = Math.floor((w.width - (pad > 0 ? 3 * pad : 0)) / 2);
      const halfH = Math.floor((w.height - (pad > 0 ? 3 * pad : 0)) / 2);
      return mkRect(w.left + pad, w.bottom - halfH - pad, halfW, halfH);
    },
  },
  {
    id: "br",
    label: "Bottom-Right",
    row: 3, col: 3, rowSpan: 1, colSpan: 2,
    bounds: (pad = 0) => {
      const w = workspace();
      const halfW = Math.floor((w.width - (pad > 0 ? 3 * pad : 0)) / 2);
      const halfH = Math.floor((w.height - (pad > 0 ? 3 * pad : 0)) / 2);
      return mkRect(w.right - halfW - pad, w.bottom - halfH - pad, halfW, halfH);
    },
  },

  // ── center floating ───────────────────────────────────────────────────
  {
    id: "center",
    label: "Center",
    row: 2, col: 2, rowSpan: 1, colSpan: 2,
    bounds: (_pad = 0) => {
      const w = workspace();
      const ww = Math.min(760, Math.floor(w.width * 0.6));
      const hh = Math.min(520, Math.floor(w.height * 0.6));
      return mkRect(w.left + Math.floor((w.width - ww) / 2), w.top + Math.floor((w.height - hh) / 2), ww, hh);
    },
  },
];

/**
 * Rect for a named slot, or `null` if the name is unknown.
 *
 * The legacy `(vw, vh, pad)` signature is accepted for back-compat with
 * callers that pre-date the workspaceRect switchover; those args are
 * ignored — `pad` is honored though, and defaults to 0 (flush docking).
 */
export function slotBounds(id, _vw, _vh, pad = 0) {
  const s = SLOT_PRESETS.find((x) => x.id === id);
  return s ? s.bounds(pad) : null;
}

/**
 * Find a slot whose current bounds match `rect` within `tolerance` px on
 * every edge. Returns `{ id, bounds }` for the best match, or `null` if
 * no slot fits within the tolerance.
 *
 * Rich's framing: a window pinned to a relative slot (left-half / tl /
 * center-third / etc.) stays relative while the user resizes it, as long
 * as the resized rect still matches one of the slots. If the drag takes
 * it off every slot mapping, we fall back to absolute (slot: null) so
 * subsequent workspace resizes don't pull it around.
 *
 * Tolerance defaults to ~4% of the workspace's shorter dimension (min
 * 16 px, max 64 px) which feels right for mouse dragging on a 4K display
 * without being so loose that "close enough" overrides user intent.
 */
export function slotForRect(rect, tolerance) {
  if (!rect) return null;
  if (tolerance === undefined) {
    const anyBounds = SLOT_PRESETS[0].bounds(0);
    const base = Math.min(anyBounds?.w ?? 1280, anyBounds?.h ?? 720);
    tolerance = Math.max(16, Math.min(64, Math.round(base * 0.04)));
  }
  let best = null;
  let bestDelta = Infinity;
  for (const s of SLOT_PRESETS) {
    const b = s.bounds(0);
    if (!b) continue;
    const dx = Math.abs(rect.x - b.x);
    const dy = Math.abs(rect.y - b.y);
    const dw = Math.abs(rect.w - b.w);
    const dh = Math.abs(rect.h - b.h);
    const max = Math.max(dx, dy, dw, dh);
    if (max <= tolerance && max < bestDelta) {
      bestDelta = max;
      best = { id: s.id, bounds: b };
    }
  }
  return best;
}
