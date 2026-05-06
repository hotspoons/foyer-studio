//! Timeline primitives — regions/clips on tracks.
//!
//! Regions are what a linear editor view renders: colored lozenges laid along
//! tracks by sample position + length. They are not shipped inline in the
//! session snapshot (there can be thousands); clients request them per-track
//! via `Command::ListRegions`.

use serde::{Deserialize, Serialize};

use crate::{
    midi::{MidiNote, PatchChange, SequencerLayout},
    EntityId,
};

/// Fade curve shape for audio regions (`AudioRegion` in Ardour). Matches
/// `ARDOUR::FadeShape` enum order / naming on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum FadeShape {
    #[default]
    Linear,
    Fast,
    Slow,
    ConstantPower,
    Symmetric,
}

/// One contiguous slice of a file on disk. Used for compound / glued clips
/// whose Ardour source is a `PlaylistSource` (no single `source_path`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioSourceSegment {
    pub path: String,
    pub offset_samples: u64,
    pub length_samples: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Region {
    pub id: EntityId,
    pub track_id: EntityId,
    pub name: String,
    /// Start position in audio samples at the session's sample rate.
    /// Signed because regions can be dragged before the timeline's
    /// zero mark — Ardour and other DAWs display the lozenge
    /// extending into pre-roll, with playback effectively starting
    /// `-start_samples` into the source on transport-roll. Sign
    /// matters for the shim's set_position write and for client
    /// rendering (left-edge can be left of x=0).
    pub start_samples: i64,
    pub length_samples: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub color: Option<String>,
    pub muted: bool,
    /// Absolute path to the audio source file backing this region, when
    /// the shim knows it. Used by the sidecar to decode + decimate on
    /// demand (see `foyer-backend`'s fallback peak-generation path).
    /// Stub backends and DAWs that can't expose their source layout
    /// leave this `None` — the sidecar then falls back to synthesized
    /// placeholder peaks.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source_path: Option<String>,
    /// Offset into `source_path` where this region starts, in source
    /// samples. Lets the sidecar skip past parts of the file that
    /// belong to other regions on the same source.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source_offset_samples: Option<u64>,
    /// Ordered file slices for playlist-backed (e.g. glued) audio. Empty
    /// when `source_path` alone describes the backing.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub source_segments: Vec<AudioSourceSegment>,
    /// For MIDI regions: the sequence of notes contained in this
    /// region, in tick-relative coordinates (see `foyer_schema::midi`).
    /// Audio regions leave this empty. Piano-roll clients render
    /// directly from this list; listing-only clients (like the main
    /// timeline lozenges) can ignore it.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub notes: Vec<MidiNote>,
    /// For MIDI regions: program/bank change events embedded in the
    /// region. Audio regions leave this empty.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub patch_changes: Vec<PatchChange>,
    /// Optional Foyer beat-sequencer layout. Persisted on the shim
    /// side inside the region's `_extra_xml` sub-tree; when present
    /// the client's piano roll flips to read-only and the beat
    /// sequencer owns the note list.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub foyer_sequencer: Option<SequencerLayout>,
    /// Per-region linear gain (Ardour `scale_amplitude`, ~1.0 = unity). Audio only.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub gain_linear: Option<f64>,
    /// Fade-in length in session samples; `None` / omitted = not reported or off.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fade_in_samples: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fade_out_samples: Option<u64>,
    /// Last-applied fade shape (stub / round-trip); omit when unknown.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fade_in_shape: Option<FadeShape>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fade_out_shape: Option<FadeShape>,
    /// Median one-way ingress latency observed (browser → DAW) while
    /// recording the take this region came from, in milliseconds.
    /// Carried so post-recording auto-shift can subtract the
    /// transport latency without the user calibrating manually. The
    /// sidecar measures it from per-packet `client_send_ms` headers
    /// against a clock-probe-estimated client/server offset; absent
    /// for regions not sourced from a browser ingress capture.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ingress_latency_ms: Option<f32>,
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
    pub start_samples: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub length_samples: Option<u64>,
    /// Source-media offset (Ardour's `Region::start`). Carried in the
    /// patch so a trim-from-left edge drag can advance the offset
    /// without losing the source material — the timeline lozenge
    /// shrinks AND the content slides forward atomically. `None` =
    /// leave the offset untouched.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source_offset_samples: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub muted: Option<bool>,
    /// Length in samples; `Some(0)` clears the fade (Ardour: inactive + default curve).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fade_in_samples: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fade_out_samples: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fade_in_shape: Option<FadeShape>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fade_out_shape: Option<FadeShape>,
    /// Linear gain coefficient (`AudioRegion::set_scale_amplitude`).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub gain_linear: Option<f64>,
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
            source_path: None,
            source_offset_samples: None,
            source_segments: vec![],
            notes: vec![],
            patch_changes: vec![],
            foyer_sequencer: None,
            gain_linear: None,
            fade_in_samples: None,
            fade_out_samples: None,
            fade_in_shape: None,
            fade_out_shape: None,
            ingress_latency_ms: None,
        };
        let j = serde_json::to_string(&r).unwrap();
        let back: Region = serde_json::from_str(&j).unwrap();
        assert_eq!(r, back);
    }
}
