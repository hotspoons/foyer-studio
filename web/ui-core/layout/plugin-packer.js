// Auto-packer for plugin-float windows.
//
// Plugin windows are deliberately NOT part of the tile/slot grid — they carry
// their own natural sizes (EQ is tall, compressor is wide, reverb is small)
// and the user shouldn't be snapping each one into a thirds-and-halves grid
// by hand. Instead, they get auto-placed like parts on a 3D-printer's build
// plate: we shelf-pack them into the workspace, largest-height first,
// filling rows left-to-right.
//
// Input: array of `{ id, w, h }` — natural sizes per plugin window, plus
// a workspace rect `{ x, y, w, h }` (available area).
//
// Output: array of `{ id, x, y, w, h }` — concrete positions. `w`/`h` may be
// shrunk to fit the workspace; nothing will spill past the right edge. If
// the input set can't fit without overflow, the last row may extend below
// the workspace (and the user can scroll or pin).
//
// Properties:
//   · Deterministic — same input set always produces the same layout, so a
//     saved layout reopens to the same plugin positions.
//   · O(n log n) — sort + single placement pass.
//   · No gaps between windows; optional `gap` param controls spacing.

export function packShelves(items, workspace, { gap = 8 } = {}) {
  if (!items || items.length === 0) return [];
  const ws = {
    x: workspace?.x ?? 0,
    y: workspace?.y ?? 0,
    w: Math.max(0, workspace?.w ?? 0),
    h: Math.max(0, workspace?.h ?? 0),
  };
  // Cap any single item at the workspace width; tall items stay tall (we
  // just accept scroll on the last row).
  const prepared = items.map((it) => ({
    id: it.id,
    w: Math.max(160, Math.min(it.w, Math.max(160, ws.w))),
    h: Math.max(120, it.h),
  }));
  // Height desc so tall windows anchor each shelf; ties broken by id for
  // determinism.
  prepared.sort((a, b) => b.h - a.h || (a.id < b.id ? -1 : 1));

  const out = [];
  let cursorX = ws.x;
  let cursorY = ws.y;
  let shelfHeight = 0;
  for (const it of prepared) {
    // If this item doesn't fit on the current shelf, wrap.
    if (cursorX + it.w > ws.x + ws.w && cursorX > ws.x) {
      cursorY += shelfHeight + gap;
      cursorX = ws.x;
      shelfHeight = 0;
    }
    // Place.
    out.push({ id: it.id, x: cursorX, y: cursorY, w: it.w, h: it.h });
    cursorX += it.w + gap;
    if (it.h > shelfHeight) shelfHeight = it.h;
  }
  return out;
}

/** Default natural size for a plugin window when the panel hasn't told us
 *  yet. Tuned to hold a single-column param layout for an average plugin
 *  (three groups × three knobs each). Users can drag to resize and the new
 *  size sticks per plugin. */
export const DEFAULT_PLUGIN_SIZE = { w: 320, h: 360 };

/** Heuristic natural size per plugin category. Used before the panel has
 *  rendered and reported its actual `offsetWidth/Height`. The packer uses
 *  these as first-pass widths; ultimately the DOM measurement wins. */
export function heuristicSize(pluginInstance) {
  const paramCount = (pluginInstance?.params?.length ?? 0);
  // ~4 continuous controls fit per 80px of height.
  const height = Math.max(280, Math.min(560, 160 + Math.ceil(paramCount / 3) * 90));
  // Single-column panels stay narrow; a very-dense plugin grows a bit.
  const width = paramCount > 20 ? 420 : paramCount > 12 ? 360 : 320;
  return { w: width, h: height };
}
