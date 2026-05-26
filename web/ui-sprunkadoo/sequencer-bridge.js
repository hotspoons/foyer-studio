// Sequencer bridge — turn the player-authored stage (slots + their
// per-part boards + the song's timeline) into the schema-correct
// `SequencerLayout` blobs the backend expects, and ship one per
// slot's region.
//
// One slot ↔ one backend MIDI track ↔ one region ↔ one
// SequencerLayout. Inside that layout:
//   • `patterns[]` — one entry per PART in the palette (the
//     `arrangements` array). Each pattern holds the cells /
//     free_notes the kid authored for that part on this slot
//     (`slot.boards[partId][rowId]`). The part id becomes the
//     pattern_id.
//   • `arrangement[]` — one entry per TIMELINE slot, cursor-summed
//     to the running bar offset. The same part can appear multiple
//     times — the backend's `expand_sequencer_layout` re-emits its
//     pattern at each placement, so [A, A, B] plays A twice then B
//     with no extra authoring. Model copied from the main-UI's
//     timeline-view + beat-sequencer pair; Rich's call 2026-05-25:
//     "there's a fully functioning version of this for reference
//     in the main UI."
//
// Chord-awareness: pitched rows that carry `chord_tone` /
// `scale_degree` resolve via `theory.resolveNote` per part. v1
// uses the same chord for every part (`sectionChords[0]`);
// per-part chord overrides are a v2 follow-up.
//
// Drum-mode patches emit `cells[]` instead of `free_notes[]`; the
// row's absolute `pitch` ships on `rows[].pitch` and the shim's
// expander reads `cell.row → row_def.pitch`.

import {
  DEFAULT_PATTERNS,
  STEPS_PER_BAR,
  DEFAULT_RESOLUTION,
} from "./components/sound-catalog.js";
import { resolveNote } from "./theory.js";
import { getPatch } from "./patches.js";
import { sprunkiStore } from "./state-store.js";

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
 *  region — given the slot's patch + the song's parts palette +
 *  timeline.
 *
 *  Each PART (entry in `arrangements`) becomes one entry in
 *  `patterns[]`. The cells / free_notes come from
 *  `slot.boards[partId]`. The `arrangement[]` walks the TIMELINE,
 *  emitting one placement per slot, cursor-summed by the placed
 *  part's `length_bars`. The same part can appear multiple times
 *  in the timeline; the backend re-emits its pattern at each
 *  placement.
 *
 *  Pattern STEP count uses the LONGEST part's bar count so all
 *  cells in any part fit in the per-pattern step range. Shorter
 *  parts just leave their high-numbered steps empty; the
 *  `arrangement[]` schedules each placement with its own
 *  `length_bars` block so playback doesn't drift.
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

  // Source the song structure from the store. Always at least one
  // part + one timeline entry — the default seed.
  const store = sprunkiStore();
  const parts = store.arrangements;
  const timeline = store.timeline;
  if (!parts.length || !timeline.length) return null;
  // Use the FIRST part's chord (v1 — all parts share one chord);
  // v2 will allow per-part chord overrides.
  const chord = (harmony?.sectionChords && Object.values(harmony.sectionChords)[0])
    || { degree: 0, quality: "major" };

  // rows[] mirrors the patch's voices. For drums, `rows[].pitch`
  // carries the GM percussion pitch; for pitched, we still need a
  // pitch value but the per-pattern `free_notes` will override it
  // bar by bar.
  const rows = patch.rows.map((r) => ({
    pitch: typeof r.pitch === "number" ? r.pitch : 60,
    label: r.label,
    channel: patch.gm_channel,
    color: r.color || patch.color,
  }));

  // Pattern step count = longest part's bars × steps-per-bar. All
  // parts share the same step grid; shorter parts just don't fill
  // beyond their own length_bars × STEPS_PER_BAR.
  const longestBars = parts.reduce((m, p) => Math.max(m, p.length_bars || 1), 1);
  const patternSteps = longestBars * STEPS_PER_BAR;

  const patterns = parts.map((part) => {
    const board = slot.boards?.[part.id] || {};
    const cells = [];
    const free_notes = [];
    const maxStep = (part.length_bars || 1) * STEPS_PER_BAR;
    patch.rows.forEach((row, rowIdx) => {
      const steps = board[row.id] || [];
      if (isDrum) {
        for (const step of steps) {
          if (step < 0 || step >= maxStep) continue;
          cells.push({ row: rowIdx, step, velocity: DEFAULT_VELOCITY });
        }
      } else {
        const pitch = pitchForRow(row, patch.mode, harmony?.key, chord);
        for (const step of steps) {
          if (step < 0 || step >= maxStep) continue;
          free_notes.push({
            id: `tmp.${slot.id}.${part.id}.${row.id}.${step}`,
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
      id: part.id,
      name: `Part`,            // no per-part names; color is the identity
      color: part.color,
      cells,
      free_notes,
    };
  });

  // arrangement[] walks the timeline. Cursor advances by the
  // PLACED part's length_bars on each step. Missing parts (stale
  // timeline reference) are skipped silently — the sanitize layer
  // should have stripped them, but defending here keeps a stray
  // mid-flight mutation from desyncing the cursor.
  const arrangement = [];
  const partById = new Map(parts.map((p) => [p.id, p]));
  let cursorBar = 0;
  timeline.forEach((partId, idx) => {
    const part = partById.get(partId);
    if (!part) return;
    arrangement.push({
      pattern_id: partId,
      bar: cursorBar,
      arrangement_row: idx,
    });
    cursorBar += part.length_bars || 1;
  });

  return {
    version: 2,
    mode: patch.mode,
    resolution: DEFAULT_RESOLUTION,
    pattern_steps: patternSteps,
    rows,
    patterns,
    arrangement,
    cells: [],
    free_notes: [],
    active: true,
  };
}

/** Clear a region to true silence. `clear_sequencer_layout` alone
 *  only unhooks the layout binding — the notes that the prior
 *  set_sequencer_layout already wrote into the region keep playing.
 *  Following it with an empty `replace_region_notes` wipes the
 *  actual MIDI so the slot goes silent. Discovered 2026-05-26:
 *  clearing every sprunki with the red ✕ didn't stop the music.
 *  The clear messages were going out; the notes were still in the
 *  regions; the kid heard zombie audio. */
function silenceRegion(ws, regionId) {
  ws.send({ type: "clear_sequencer_layout", region_id: regionId });
  ws.send({ type: "replace_region_notes", region_id: regionId, notes: [] });
}

/** Push every slot's layout to its backend region. Slots without a
 *  patch get silenced (layout cleared + notes wiped). The server-
 *  side coalescer drops identical layouts, so calling this on
 *  every drag tick is safe. */
export function pushAllLayouts(ws, stage, harmony) {
  if (!ws || !Array.isArray(stage)) return 0;
  let sent = 0;
  for (const slot of stage) {
    if (!slot?.region_id) continue;
    if (!slot.patch_id) {
      silenceRegion(ws, slot.region_id);
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
    silenceRegion(ws, slot.region_id);
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
