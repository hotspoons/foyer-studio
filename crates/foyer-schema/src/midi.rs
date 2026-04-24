//! MIDI notes + per-note edits.
//!
//! A MIDI region's payload is a list of [`MidiNote`]s. Regions carry them
//! inline on the timeline (so the piano roll can render without a second
//! round trip) but clients that only want region lozenges can ignore the
//! `notes` field entirely.
//!
//! Ticks (not samples) are the time unit for notes — MIDI time is musical
//! time, and the host's tempo map maps ticks → samples at render time. One
//! beat = 960 ticks by default (PPQN). Clients should not hard-code PPQN;
//! `Session.ppqn` will carry it when the shim starts emitting it.

use serde::{Deserialize, Serialize};

use crate::EntityId;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MidiNote {
    /// Stable per-region id. Used as the target of note-level mutations.
    pub id: EntityId,
    /// MIDI pitch 0..127 (60 = middle C).
    pub pitch: u8,
    /// MIDI velocity 0..127.
    pub velocity: u8,
    /// Note-on position relative to the region's start, in ticks.
    pub start_ticks: u64,
    /// Duration in ticks.
    pub length_ticks: u64,
    /// 0..15 (General MIDI channel). Most sessions only use channel 0.
    #[serde(default)]
    pub channel: u8,
}

/// Patch set for mutating a note. `None` fields are left unchanged.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MidiNotePatch {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub pitch: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub velocity: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub start_ticks: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub length_ticks: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub channel: Option<u8>,
}

/// A program/bank-change event attached to a MIDI region. Ardour
/// stores three underlying events (bank MSB + LSB + program change)
/// at a single time; we present them as one logical primitive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchChange {
    /// Stable id — "patchchange.<region-pbd>.<event_id>" when the
    /// shim emits, "patchchange.opt.<rnd>" for optimistic inserts.
    pub id: EntityId,
    /// Channel 0..15.
    #[serde(default)]
    pub channel: u8,
    /// 0..127.
    pub program: u8,
    /// 0..16383 (MSB<<7 | LSB) or negative for "no bank" (Ardour
    /// sentinel — map to `-1` on the wire).
    #[serde(default)]
    pub bank: i32,
    /// Position relative to the region start, in ticks.
    pub start_ticks: u64,
}

/// Patch set for an existing PatchChange. All `None` fields stay put.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchChangePatch {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub channel: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub program: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub bank: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub start_ticks: Option<u64>,
}

// ────────────────── Foyer beat-sequencer layout ──────────────────
//
// Persisted verbatim into the owning MIDI region's `_extra_xml` as a
// `<Foyer><Sequencer>` sub-node on the shim side. Stock Ardour open-
// save-close cycles preserve this by design (the Stateful base class
// round-trips unknown `<Extra>` children intact —
// `libs/pbd/stateful.cc:94-108`). A region with `foyer_sequencer =
// Some(...)` is considered "beat-sequencer-owned" and the piano roll
// switches to a read-only view for it.

/// One row in a beat-sequencer grid — a fixed pitch + label + channel
/// and color swatch. Rows in a drum layout default to General MIDI
/// percussion (channel 9, pitches 35..=81); pitched layouts can use
/// any pitch/channel assignment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SequencerRow {
    /// MIDI pitch 0..127.
    pub pitch: u8,
    /// Human label — "Kick", "Snare", "HH closed", "C4", etc.
    pub label: String,
    /// Channel 0..15 — General-MIDI drums live on channel 9.
    #[serde(default)]
    pub channel: u8,
    /// Optional CSS color used to tint this row in the grid.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub color: Option<String>,
    /// Optional per-row mute / solo flags — UI-only today, the shim
    /// still emits all notes; a follow-up can skip muted rows during
    /// the note-regeneration pass.
    #[serde(default, skip_serializing_if = "core::ops::Not::not")]
    pub muted: bool,
    #[serde(default, skip_serializing_if = "core::ops::Not::not")]
    pub soloed: bool,
}

/// One cell in the grid — (row, step) → (on, velocity). Stored as
/// a flat list instead of a map for serde-msgpack friendliness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SequencerCell {
    pub row: u32,
    pub step: u32,
    #[serde(default)]
    pub velocity: u8,
    /// How many consecutive steps this cell spans. `0` or missing is
    /// treated as `1` — the common drum-grid case. Pitched mode uses
    /// values > 1 so a piano-roll-style long note can cross beats
    /// without leaving the sequencer region.
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub length_steps: u32,
}

fn is_zero_u32(n: &u32) -> bool {
    *n == 0
}

/// One named beat pattern — a (rowIdx, stepIdx, velocity) cell list
/// the user authored. Patterns are reused across the song timeline
/// via `ArrangementSlot`s: a pattern can play at any bar zero or
/// more times.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SequencerPattern {
    /// Stable id within the region. Frontend assigns; shim treats
    /// as opaque.
    pub id: String,
    /// Display name — "Verse", "Chorus", "Fill", etc.
    pub name: String,
    /// Optional CSS color for the arrangement-grid block + the
    /// pattern label. Picks a default when empty.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub color: Option<String>,
    /// Cells populated in this pattern. Empty cells = silence.
    #[serde(default)]
    pub cells: Vec<SequencerCell>,
    /// Free-form notes for this pattern (Alt-drag in pitched mode).
    #[serde(default)]
    pub free_notes: Vec<MidiNote>,
}

/// One slot on the song timeline — "play pattern X starting at
/// bar Y". Each slot occupies `pattern_steps` (one bar's worth of)
/// steps from its `bar`. Multiple slots can stack (different
/// patterns at the same bar layer their notes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArrangementSlot {
    pub pattern_id: String,
    pub bar: u32,
    /// Optional row in the arrangement grid (Hydrogen-style: rows
    /// usually map 1:1 with patterns, but the user can stack a
    /// pattern on multiple rows for visual separation). Defaults
    /// to whatever row the editor was on when placing.
    #[serde(default)]
    pub arrangement_row: u32,
}

/// Beat-sequencer layout attached to a MIDI region. All fields
/// default to sensible values so partial payloads (e.g. legacy v1
/// blobs that only carry `cells` at the top level) still parse.
///
/// Two-level organization:
///   * `patterns` — named cell-grids the user authored.
///   * `arrangement` — when each pattern plays in the song.
///
/// Migration: if `patterns` is empty but `cells` is non-empty
/// (legacy v1 layout), `expand_sequencer_layout` synthesizes a
/// single "Pattern 1" containing those cells, played at bar 0.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SequencerLayout {
    #[serde(default = "sequencer_default_version")]
    pub version: u32,
    /// "drum" or "pitched" — controls the default row set + note
    /// length semantics. The typed schema is the same either way.
    #[serde(default = "sequencer_default_mode")]
    pub mode: String,
    /// Steps per beat (1/4 = 1, 1/8 = 2, 1/16 = 4, 1/32 = 8).
    #[serde(default = "sequencer_default_resolution")]
    pub resolution: u32,
    /// Number of cells per pattern (one bar at this resolution).
    #[serde(default = "sequencer_default_steps", alias = "steps")]
    pub pattern_steps: u32,
    /// Row definitions, top-to-bottom as displayed (shared by all
    /// patterns).
    #[serde(default)]
    pub rows: Vec<SequencerRow>,
    /// Named patterns the user can arrange. Empty for v1 legacy
    /// layouts (handled at expand-time).
    #[serde(default)]
    pub patterns: Vec<SequencerPattern>,
    /// Song timeline: which pattern plays at which bar.
    #[serde(default)]
    pub arrangement: Vec<ArrangementSlot>,
    /// Legacy v1 per-cell field — read-only on v2 layouts. New
    /// layouts populate `patterns` instead. Kept on the struct so
    /// old saved blobs round-trip cleanly.
    #[serde(default)]
    pub cells: Vec<SequencerCell>,
    /// Legacy v1 free-form notes. Same migration story.
    #[serde(default)]
    pub free_notes: Vec<MidiNote>,
    /// When true (default), the server regenerates notes from this
    /// layout whenever `SetSequencerLayout` arrives. When false,
    /// the layout is *archived* — the notes on the region are
    /// treated as authoritative MIDI, piano-roll edits are live,
    /// and the sequencer layout sits alongside as a restorable
    /// snapshot.
    ///
    /// Two-way conversion:
    ///   - "Convert to MIDI" in the piano roll → sets active=false.
    ///     Region notes stay exactly as the sequencer last emitted
    ///     them; user can edit them freely.
    ///   - "Restore sequencer" in the piano roll → sets active=true.
    ///     Server regenerates notes from the layout, overwriting
    ///     any manual edits.
    #[serde(default = "sequencer_default_active")]
    pub active: bool,
}

fn sequencer_default_active() -> bool {
    true
}

fn sequencer_default_version() -> u32 {
    2
}
fn sequencer_default_mode() -> String {
    "drum".into()
}
fn sequencer_default_resolution() -> u32 {
    4
}
fn sequencer_default_steps() -> u32 {
    16
}

impl Default for SequencerLayout {
    fn default() -> Self {
        Self {
            version: 2,
            mode: "drum".into(),
            resolution: 4,
            pattern_steps: 16,
            rows: default_gm_drum_rows(),
            patterns: vec![SequencerPattern {
                id: "p1".into(),
                name: "Pattern 1".into(),
                color: Some("#7c5cff".into()),
                cells: Vec::new(),
                free_notes: Vec::new(),
            }],
            arrangement: vec![ArrangementSlot {
                pattern_id: "p1".into(),
                bar: 0,
                arrangement_row: 0,
            }],
            cells: Vec::new(),
            free_notes: Vec::new(),
            active: true,
        }
    }
}

/// Expand a SequencerLayout into the MIDI notes the region should
/// contain. Pure function — no IO, no backend calls. Called by the
/// sidecar on every `SetSequencerLayout` to regenerate the region's
/// note list, so a sequencer-owned region's notes are always a
/// deterministic function of its layout metadata (Rich's redesign
/// ask on 2026-04-21: sequencer state *drives* note generation,
/// not the other way around).
///
/// * `ppqn` is the project's ticks-per-quarter (always 960 in
///   Ardour as of 9.x; pulled from session state if that ever
///   changes).
/// * Cells whose row index falls outside the declared rows array
///   are silently dropped — they'd be stale data from an earlier
///   layout.
///
/// Free-form notes on the layout (ad-hoc piano-roll-style
/// placements in "pitched" mode) are emitted alongside the cell
/// grid. That lets pitched mode carry notes the grid can't
/// represent (off-grid starts, arbitrary lengths).
pub fn expand_sequencer_layout(layout: &SequencerLayout, ppqn: u32) -> Vec<MidiNote> {
    // Archived / inactive layouts don't generate notes — the
    // region's current notes are authoritative. Callers that want
    // to *restore* an archived layout must explicitly set
    // `active = true` on the layout before expansion.
    if !layout.active {
        return Vec::new();
    }
    let ppqn = ppqn.max(1);
    let resolution = layout.resolution.max(1);
    let step_ticks = (ppqn / resolution) as u64;
    let note_ticks = ((step_ticks as f64) * 0.9).round().max(1.0) as u64;
    let pattern_steps = layout.pattern_steps.max(1);
    let bar_ticks = (pattern_steps as u64) * step_ticks;

    // Migration: a legacy v1 layout has top-level `cells` but no
    // `patterns` / `arrangement`. Synthesize a single pattern from
    // those cells, played at bar 0, so the same expander handles
    // both shapes. Always owned storage so the borrow checker is
    // happy across the migration / passthrough branches.
    let (patterns_owned, arrangement_owned): (Vec<SequencerPattern>, Vec<ArrangementSlot>) =
        if !layout.patterns.is_empty() {
            let arr = if layout.arrangement.is_empty() {
                // v2 layout but no arrangement — default to playing
                // the first pattern at bar 0 so the user hears
                // something even before they touch the song grid.
                vec![ArrangementSlot {
                    pattern_id: layout.patterns[0].id.clone(),
                    bar: 0,
                    arrangement_row: 0,
                }]
            } else {
                layout.arrangement.clone()
            };
            (layout.patterns.clone(), arr)
        } else if !layout.cells.is_empty() || !layout.free_notes.is_empty() {
            (
                vec![SequencerPattern {
                    id: "p1".into(),
                    name: "Pattern 1".into(),
                    color: None,
                    cells: layout.cells.clone(),
                    free_notes: layout.free_notes.clone(),
                }],
                vec![ArrangementSlot {
                    pattern_id: "p1".into(),
                    bar: 0,
                    arrangement_row: 0,
                }],
            )
        } else {
            return Vec::new();
        };
    let patterns = &patterns_owned[..];
    let arrangement = &arrangement_owned[..];

    let mut out: Vec<MidiNote> = Vec::new();
    for slot in arrangement {
        let Some(pat) = patterns.iter().find(|p| p.id == slot.pattern_id) else {
            continue;
        };
        let bar_offset = (slot.bar as u64) * bar_ticks;
        for cell in &pat.cells {
            let row = cell.row as usize;
            let Some(row_def) = layout.rows.get(row) else {
                continue;
            };
            if row_def.muted {
                continue;
            }
            if layout.rows.iter().any(|r| r.soloed) && !row_def.soloed {
                continue;
            }
            let start = bar_offset + (cell.step as u64) * step_ticks;
            // length_steps > 1 = pitched-mode long note. A cell with
            // length_steps == N fills N consecutive steps visually;
            // the emitted MIDI note's length_ticks covers N*step_ticks
            // minus a tiny gap so adjacent notes don't chord. The
            // default (0/missing/1) keeps the drum-grid behavior:
            // one short note per cell at `note_ticks` length.
            let len_steps = cell.length_steps.max(1) as u64;
            let length = if len_steps > 1 {
                (len_steps * step_ticks)
                    .saturating_sub(step_ticks / 10)
                    .max(1)
            } else {
                note_ticks
            };
            let id_str = format!(
                "note.seq.{}.{}.{}.{}",
                slot.bar, slot.pattern_id, cell.row, cell.step
            );
            out.push(MidiNote {
                id: EntityId::new(id_str),
                pitch: row_def.pitch,
                velocity: cell.velocity.max(1),
                start_ticks: start,
                length_ticks: length,
                channel: row_def.channel,
            });
        }
        for (i, n) in pat.free_notes.iter().enumerate() {
            let mut cloned = n.clone();
            cloned.start_ticks = bar_offset + n.start_ticks;
            cloned.id = EntityId::new(format!(
                "note.seq.free.{}.{}.{i}",
                slot.bar, slot.pattern_id
            ));
            out.push(cloned);
        }
    }
    out
}

/// Compute the region length in ticks needed to hold the entire
/// arrangement. Returns 0 if there's no arrangement at all.
pub fn sequencer_layout_length_ticks(layout: &SequencerLayout, ppqn: u32) -> u64 {
    let ppqn = ppqn.max(1);
    let resolution = layout.resolution.max(1);
    let step_ticks = (ppqn / resolution) as u64;
    let pattern_steps = layout.pattern_steps.max(1);
    let bar_ticks = (pattern_steps as u64) * step_ticks;
    let last_bar = layout.arrangement.iter().map(|s| s.bar).max();
    match last_bar {
        Some(b) => (b as u64 + 1) * bar_ticks,
        None if !layout.cells.is_empty() => bar_ticks, // legacy v1
        None => 0,
    }
}

/// General-MIDI percussion map — the rows users expect when they
/// open a drum sequencer for the first time. Matches what Hydrogen
/// ships by default.
pub fn default_gm_drum_rows() -> Vec<SequencerRow> {
    fn row(pitch: u8, label: &str, color: &str) -> SequencerRow {
        SequencerRow {
            pitch,
            label: label.into(),
            channel: 9,
            color: Some(color.into()),
            muted: false,
            soloed: false,
        }
    }
    vec![
        row(36, "Kick", "#f59e0b"),
        row(38, "Snare", "#a78bfa"),
        row(37, "Rimshot", "#6ee7b7"),
        row(42, "HH closed", "#22d3ee"),
        row(46, "HH open", "#67e8f9"),
        row(44, "HH pedal", "#38bdf8"),
        row(49, "Crash", "#fb7185"),
        row(51, "Ride", "#fda4af"),
        row(41, "Low tom", "#fbbf24"),
        row(45, "Mid tom", "#fcd34d"),
        row(50, "Hi tom", "#fde68a"),
        row(39, "Hand clap", "#94a3b8"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_round_trips() {
        let n = MidiNote {
            id: EntityId::new("note.abc"),
            pitch: 60,
            velocity: 100,
            start_ticks: 0,
            length_ticks: 480,
            channel: 0,
        };
        let j = serde_json::to_string(&n).unwrap();
        let back: MidiNote = serde_json::from_str(&j).unwrap();
        assert_eq!(n, back);
    }

    #[test]
    fn patch_skips_nones() {
        let p = MidiNotePatch {
            pitch: Some(62),
            ..Default::default()
        };
        let j = serde_json::to_string(&p).unwrap();
        assert!(j.contains("pitch"));
        assert!(!j.contains("velocity"));
    }
}
