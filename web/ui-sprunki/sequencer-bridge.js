// Sequencer bridge — turn the player-authored "boards" (per-pattern
// active-step lists) into the schema-correct `SequencerLayout` blob
// the backend expects, then ship one per category region.
//
// The layout shape (see crates/foyer-schema/src/midi.rs):
//   {
//     version: 2,
//     mode: "drum" | "pitched",
//     resolution: 4,          // 16th-note grid
//     pattern_steps: 16,      // 1 bar
//     rows: [{ pitch, label, channel, color }],
//     patterns: [{ id, name, color, cells: [{row, step, velocity}] }],
//     arrangement: [{ pattern_id, bar, arrangement_row }],
//     active: true,
//   }
//
// The previous Sprunki shell mis-shaped this — it put cells INSIDE
// each row object, which silently parses to an empty layout
// (SequencerRow has no `cells` field on the schema). That's why no
// notes ever played even though the WS round-trip looked fine.
// Here `cells` lives on each PATTERN with explicit `row` indices,
// matching `SequencerCell`.

import {
  CHARACTERS,
  CATEGORIES,
  DEFAULT_PATTERNS,
  STEPS_PER_PATTERN,
  DEFAULT_RESOLUTION,
  charactersInCategory,
  getCategory,
} from "./components/sound-catalog.js";

const DEFAULT_VELOCITY = 100;

/**
 * Build the SequencerLayout for a single category, drawing cells
 * from all four pattern boards in `state`.
 */
export function buildCategoryLayout(categoryId, boards) {
  const cat = getCategory(categoryId);
  if (!cat) throw new Error(`unknown sprunki category: ${categoryId}`);
  const chars = charactersInCategory(categoryId);

  const rows = chars.map((c) => ({
    pitch: c.pitch,
    label: c.name,
    channel: cat.default_gm_channel,
    color: c.color,
  }));

  const patterns = DEFAULT_PATTERNS.map((p) => {
    const board = boards[p.id] || {};
    const cells = [];
    chars.forEach((char, rowIdx) => {
      const steps = board[char.id] || [];
      for (const step of steps) {
        if (step < 0 || step >= STEPS_PER_PATTERN) continue;
        cells.push({
          row: rowIdx,
          step,
          velocity: DEFAULT_VELOCITY,
        });
      }
    });
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      cells,
      free_notes: [],
    };
  });

  // Arrangement: each pattern plays once at its declared bar.
  // "Play section" loops just the current bar; "Play all" loops the
  // arrangement span (set by the transport, not the layout).
  const arrangement = DEFAULT_PATTERNS.map((p, idx) => ({
    pattern_id: p.id,
    bar: p.bar,
    arrangement_row: idx,
  }));

  return {
    version: 2,
    mode: cat.mode,
    resolution: DEFAULT_RESOLUTION,
    pattern_steps: STEPS_PER_PATTERN,
    rows,
    patterns,
    arrangement,
    cells: [],
    free_notes: [],
    active: true,
  };
}

/**
 * Push the current boards as sequencer layouts to every category's
 * region. Returns a count of categories successfully shipped.
 *
 * Coalescing: this gets called on every cell click. The server side
 * already debounces identical layouts, so spamming it on rapid
 * edits is safe (180 ms reset-on-arrival window).
 */
export function pushAllLayouts(ws, ids, boards) {
  if (!ws || !ids) return 0;
  let sent = 0;
  for (const cat of CATEGORIES) {
    const entry = ids[cat.id];
    if (!entry?.region_id) continue;
    const layout = buildCategoryLayout(cat.id, boards);
    ws.send({
      type: "set_sequencer_layout",
      region_id: entry.region_id,
      layout,
    });
    sent++;
  }
  return sent;
}

/** Ship just one category's layout. Cheaper when the user toggled a
 *  single cell — only the category that owns that character needs
 *  to re-render. */
export function pushCategoryLayout(ws, ids, boards, categoryId) {
  if (!ws || !ids) return false;
  const entry = ids[categoryId];
  if (!entry?.region_id) return false;
  const layout = buildCategoryLayout(categoryId, boards);
  ws.send({
    type: "set_sequencer_layout",
    region_id: entry.region_id,
    layout,
  });
  return true;
}
