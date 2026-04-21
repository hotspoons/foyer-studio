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
/// + color swatch. Rows in a drum layout default to General MIDI
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
}

/// Beat-sequencer layout attached to a MIDI region. All fields
/// default to sensible values so partial payloads from the shim
/// (e.g. an old-format region that only sets `steps`) still parse.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SequencerLayout {
    #[serde(default = "sequencer_default_version")]
    pub version: u32,
    /// "drum" or "pitched" — controls the default row set + note
    /// length semantics. The typed schema is the same either way.
    #[serde(default = "sequencer_default_mode")]
    pub mode: String,
    /// Steps per beat (1/4 = 1, 1/8 = 2, 1/16 = 4, 1/32 = 8). The
    /// grid holds `steps` columns spanning a whole pattern length.
    #[serde(default = "sequencer_default_resolution")]
    pub resolution: u32,
    /// Total number of columns in the grid. Matched to the region's
    /// length on the shim side — the grid is laid out to fill it.
    #[serde(default = "sequencer_default_steps")]
    pub steps: u32,
    /// Row definitions, top-to-bottom as displayed.
    #[serde(default)]
    pub rows: Vec<SequencerRow>,
    /// Populated cells only — empty positions are implied off.
    #[serde(default)]
    pub cells: Vec<SequencerCell>,
}

fn sequencer_default_version() -> u32 { 1 }
fn sequencer_default_mode() -> String { "drum".into() }
fn sequencer_default_resolution() -> u32 { 4 }
fn sequencer_default_steps() -> u32 { 16 }

impl Default for SequencerLayout {
    fn default() -> Self {
        Self {
            version: 1,
            mode: "drum".into(),
            resolution: 4,
            steps: 16,
            rows: default_gm_drum_rows(),
            cells: Vec::new(),
        }
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
        row(36, "Kick",     "#f59e0b"),
        row(38, "Snare",    "#a78bfa"),
        row(37, "Rimshot",  "#6ee7b7"),
        row(42, "HH closed", "#22d3ee"),
        row(46, "HH open",   "#67e8f9"),
        row(44, "HH pedal",  "#38bdf8"),
        row(49, "Crash",     "#fb7185"),
        row(51, "Ride",      "#fda4af"),
        row(41, "Low tom",   "#fbbf24"),
        row(45, "Mid tom",   "#fcd34d"),
        row(50, "Hi tom",    "#fde68a"),
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
