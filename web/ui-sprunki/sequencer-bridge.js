// Sequencer bridge — turn the player-authored stage (slots + their
// per-section boards) into the schema-correct `SequencerLayout`
// blobs the backend expects, and ship one per slot's region.
//
// One slot ↔ one backend MIDI track ↔ one region ↔ one
// SequencerLayout. The patch the slot is holding determines the
// rows (and their pitch/channel) and the slot's `boards` hold the
// per-section step authoring.
//
// Chord-awareness: pitched rows that carry `chord_tone` or
// `scale_degree` get resolved per-section against the active
// chord via `theory.resolveNote`. Each pattern in the emitted
// layout gets its own `free_notes[]` with explicit MIDI pitches
// so the four sections (Intro / Verse / Chorus / Drop) can voice
// the same character data against four different chords.
//
// Drum-mode patches emit `cells[]` instead of `free_notes[]`; the
// row's absolute `pitch` is shipped on `rows[].pitch` and the
// schema/shim expander reads `cell.row → row_def.pitch`.

import {
  DEFAULT_PATTERNS,
  STEPS_PER_PATTERN,
  DEFAULT_RESOLUTION,
} from "./components/sound-catalog.js";
import { resolveNote } from "./theory.js";
import { getPatch } from "./patches.js";

const DEFAULT_VELOCITY = 100;
/** Ardour's internal MIDI tick scale (`Temporal::ticks_per_beat`).
 *  Must match the `ppq` value foyer-server passes to
 *  `expand_sequencer_layout`. */
const TICKS_PER_BEAT = 1920;
const STEP_TICKS = TICKS_PER_BEAT / DEFAULT_RESOLUTION;

/** Resolve a patch row's pitch given the section's chord context.
 *  Drum-mode rows ship absolute pitch; pitched rows resolve
 *  chord_tone / scale_degree via theory.resolveNote. */
function pitchForRow(row, mode, key, chord) {
  if (mode !== "pitched") return row.pitch ?? 60;
  if (typeof row.pitch === "number") return row.pitch;
  if (row.chord_tone || typeof row.scale_degree === "number") {
    return resolveNote(
      {
        chord_tone: row.chord_tone,
        scale_degree: row.scale_degree,
        octave_offset: row.octave_offset ?? 0,
      },
      key,
      chord,
    );
  }
  return 60;
}

/** Build a SequencerLayout for one slot — i.e. one backend
 *  region — given the slot's patch + its per-section authored
 *  step boards + the global harmony.
 *
 * @param {object} slot     — { id, patch_id, boards, … }
 * @param {object} harmony  — { key, sectionChords }
 * @returns {object|null}   — a SequencerLayout, or null when the
 *                            slot has no patch (caller should
 *                            push a `clear_sequencer_layout` then).
 */
export function buildSlotLayout(slot, harmony) {
  if (!slot?.patch_id) return null;
  const patch = getPatch(slot.patch_id);
  if (!patch) return null;
  const isDrum = patch.mode === "drum";

  // rows[] mirrors the patch's voices. For drums, `rows[].pitch`
  // carries the GM percussion pitch; for pitched, we still need a
  // pitch value but the per-section `free_notes` will override it
  // bar by bar.
  const rows = patch.rows.map((r) => ({
    pitch: typeof r.pitch === "number" ? r.pitch : 60,
    label: r.label,
    channel: patch.gm_channel,
    color: r.color || patch.color,
  }));

  const patterns = DEFAULT_PATTERNS.map((p) => {
    const board = slot.boards?.[p.id] || {};
    const chord = harmony?.sectionChords?.[p.id] || { degree: 0, quality: "major" };
    const cells = [];
    const free_notes = [];
    patch.rows.forEach((row, rowIdx) => {
      const steps = board[row.id] || [];
      if (isDrum) {
        for (const step of steps) {
          if (step < 0 || step >= STEPS_PER_PATTERN) continue;
          cells.push({ row: rowIdx, step, velocity: DEFAULT_VELOCITY });
        }
      } else {
        const pitch = pitchForRow(row, patch.mode, harmony?.key, chord);
        for (const step of steps) {
          if (step < 0 || step >= STEPS_PER_PATTERN) continue;
          free_notes.push({
            id: `tmp.${slot.id}.${p.id}.${row.id}.${step}`,
            pitch,
            channel: patch.gm_channel,
            start_ticks: step * STEP_TICKS,
            length_ticks: STEP_TICKS,
            velocity: DEFAULT_VELOCITY,
          });
        }
      }
    });
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      cells,
      free_notes,
    };
  });

  const arrangement = DEFAULT_PATTERNS.map((p, idx) => ({
    pattern_id: p.id,
    bar: p.bar,
    arrangement_row: idx,
  }));

  return {
    version: 2,
    mode: patch.mode,
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

/** Push every slot's layout to its backend region. Slots without a
 *  patch get a `clear_sequencer_layout` so the region falls back
 *  to silent piano-roll. The server-side coalescer drops identical
 *  layouts, so calling this on every drag tick is safe. */
export function pushAllLayouts(ws, stage, harmony) {
  if (!ws || !Array.isArray(stage)) return 0;
  let sent = 0;
  for (const slot of stage) {
    if (!slot?.region_id) continue;
    if (!slot.patch_id) {
      ws.send({ type: "clear_sequencer_layout", region_id: slot.region_id });
      sent++;
      continue;
    }
    const layout = buildSlotLayout(slot, harmony);
    if (!layout) continue;
    ws.send({
      type: "set_sequencer_layout",
      region_id: slot.region_id,
      layout,
    });
    sent++;
  }
  return sent;
}

/** Push just one slot's layout — cheaper for cell-by-cell edits. */
export function pushSlotLayout(ws, slot, harmony) {
  if (!ws || !slot?.region_id) return false;
  if (!slot.patch_id) {
    ws.send({ type: "clear_sequencer_layout", region_id: slot.region_id });
    return true;
  }
  const layout = buildSlotLayout(slot, harmony);
  if (!layout) return false;
  ws.send({
    type: "set_sequencer_layout",
    region_id: slot.region_id,
    layout,
  });
  return true;
}
