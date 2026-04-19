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
