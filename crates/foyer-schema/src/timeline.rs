//! Timeline primitives — regions/clips on tracks.
//!
//! Regions are what a linear editor view renders: colored lozenges laid along
//! tracks by sample position + length. They are not shipped inline in the
//! session snapshot (there can be thousands); clients request them per-track
//! via `Command::ListRegions`.

use serde::{Deserialize, Serialize};

use crate::EntityId;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Region {
    pub id: EntityId,
    pub track_id: EntityId,
    pub name: String,
    /// Start position in audio samples at the session's sample rate.
    pub start_samples: u64,
    pub length_samples: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub color: Option<String>,
    pub muted: bool,
}

/// Minimal viewport/scale info UIs need to lay out regions consistently.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TimelineMeta {
    pub sample_rate: u32,
    /// Current session length in samples (for horizontal extent).
    pub length_samples: u64,
}

/// A pre-decimated peak series for a single region.
///
/// `samples_per_peak` controls resolution — larger values = coarser (each
/// peak covers more source samples). Clients request a resolution appropriate
/// for current zoom and the sidecar serves the closest cached tier (or
/// synthesizes on demand).
///
/// Payload layout is interleaved min/max per-channel per-bucket:
///   `[bucket0_ch0_min, bucket0_ch0_max, bucket0_ch1_min, bucket0_ch1_max,
///     bucket1_ch0_min, ...]`
/// in f32 units (normalized −1..+1). Kept as a flat Vec for tight on-wire
/// encoding and cheap WebGL/canvas handoff on the browser side.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WaveformPeaks {
    pub region_id: crate::EntityId,
    pub channels: u16,
    pub samples_per_peak: u32,
    pub peaks: Vec<f32>,
    /// How many buckets the `peaks` vector holds per channel. Redundant with
    /// `peaks.len() / (channels * 2)` but lets clients size arrays without
    /// arithmetic.
    pub bucket_count: u32,
}

impl WaveformPeaks {
    /// Total samples this peak series covers. Useful for verifying that a
    /// server response matches the client's expectation.
    pub fn covered_samples(&self) -> u64 {
        self.bucket_count as u64 * self.samples_per_peak as u64
    }
}

/// What the client wants — a region sliced at a given resolution. The server
/// picks the nearest-power-of-two cache tier ≤ the request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WaveformRequest {
    pub region_id: crate::EntityId,
    pub samples_per_peak: u32,
}

/// Patch set for updating a region. None-valued fields are left unchanged.
/// Keeps the wire shape small for drag/resize events.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RegionPatch {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub start_samples: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub length_samples: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub muted: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn region_round_trips() {
        let r = Region {
            id: EntityId::new("region.abc"),
            track_id: EntityId::new("track.kick"),
            name: "Kick 01".into(),
            start_samples: 48_000,
            length_samples: 96_000,
            color: Some("#c04040".into()),
            muted: false,
        };
        let j = serde_json::to_string(&r).unwrap();
        let back: Region = serde_json::from_str(&j).unwrap();
        assert_eq!(r, back);
    }
}
