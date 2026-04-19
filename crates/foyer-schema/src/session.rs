//! Session structure: the tree of tracks, buses, plugins, and transport state.
//!
//! These types describe "what exists right now." They're the payload of
//! `session.snapshot` messages and the targets of `session.patch` structural deltas.

use serde::{Deserialize, Serialize};

use crate::{EntityId, Parameter};

/// Distinguishes audio/MIDI tracks from internal buses. Kept coarse on purpose; more
/// host-specific flavors map to the nearest neighbor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackKind {
    Audio,
    Midi,
    /// Group/submix/bus — anything that aggregates other tracks without carrying input.
    Bus,
    /// Master/main output.
    Master,
    /// Monitor/control-room bus.
    Monitor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginInstance {
    pub id: EntityId,
    pub name: String,
    /// Source identifier, e.g. "lv2:http://…", "vst3:…". Opaque string.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub uri: Option<String>,
    pub bypassed: bool,
    pub params: Vec<Parameter>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Send {
    pub id: EntityId,
    pub target_track: EntityId,
    pub level: Parameter,
    pub pre_fader: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Track {
    pub id: EntityId,
    pub name: String,
    pub kind: TrackKind,
    /// RGB hex color like "#8888aa", or None if the host doesn't carry a color.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub color: Option<String>,
    pub gain: Parameter,
    pub pan: Parameter,
    pub mute: Parameter,
    pub solo: Parameter,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub record_arm: Option<Parameter>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub sends: Vec<Send>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub plugins: Vec<PluginInstance>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub peak_meter: Option<EntityId>,
}

/// Alias for readability in code paths that semantically talk about buses; structurally
/// identical to a `Track` with `kind = Bus | Master | Monitor`.
pub type Bus = Track;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transport {
    pub playing: Parameter,
    pub recording: Parameter,
    pub looping: Parameter,
    pub tempo: Parameter,
    pub time_signature_num: Parameter,
    pub time_signature_den: Parameter,
    /// Playhead position in beats. Read-mostly; updated at ~30 Hz via `control.update`.
    pub position_beats: Parameter,
}

/// The full session snapshot. Shipped on connect and on demand for resync.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub schema_version: (u16, u16),
    pub transport: Transport,
    pub tracks: Vec<Track>,
    /// Optional free-form metadata: project name, sample rate, etc.
    #[serde(default)]
    pub meta: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::{ControlKind, ControlValue, ScaleCurve};

    fn fader(id: &str, v: f64) -> Parameter {
        Parameter {
            id: EntityId::new(id),
            kind: ControlKind::Continuous,
            label: "Gain".into(),
            range: Some([-60.0, 6.0]),
            scale: ScaleCurve::Decibels,
            unit: Some("dB".into()),
            enum_labels: vec![],
            group: None,
            value: ControlValue::Float(v),
        }
    }

    fn toggle(id: &str, label: &str) -> Parameter {
        Parameter {
            id: EntityId::new(id),
            kind: ControlKind::Trigger,
            label: label.into(),
            range: None,
            scale: ScaleCurve::Linear,
            unit: None,
            enum_labels: vec![],
            group: None,
            value: ControlValue::Bool(false),
        }
    }

    #[test]
    fn snapshot_round_trips() {
        let session = Session {
            schema_version: crate::SCHEMA_VERSION,
            transport: Transport {
                playing: toggle("transport.playing", "Play"),
                recording: toggle("transport.recording", "Record"),
                looping: toggle("transport.looping", "Loop"),
                tempo: Parameter {
                    id: EntityId::new("transport.tempo"),
                    kind: ControlKind::Continuous,
                    label: "Tempo".into(),
                    range: Some([20.0, 300.0]),
                    scale: ScaleCurve::Linear,
                    unit: Some("BPM".into()),
                    enum_labels: vec![],
                    group: None,
                    value: ControlValue::Float(120.0),
                },
                time_signature_num: Parameter {
                    id: EntityId::new("transport.ts.num"),
                    kind: ControlKind::Discrete,
                    label: "TS Num".into(),
                    range: Some([1.0, 32.0]),
                    scale: ScaleCurve::Linear,
                    unit: None,
                    enum_labels: vec![],
                    group: None,
                    value: ControlValue::Int(4),
                },
                time_signature_den: Parameter {
                    id: EntityId::new("transport.ts.den"),
                    kind: ControlKind::Discrete,
                    label: "TS Den".into(),
                    range: Some([1.0, 32.0]),
                    scale: ScaleCurve::Linear,
                    unit: None,
                    enum_labels: vec![],
                    group: None,
                    value: ControlValue::Int(4),
                },
                position_beats: Parameter {
                    id: EntityId::new("transport.position"),
                    kind: ControlKind::Meter,
                    label: "Position".into(),
                    range: None,
                    scale: ScaleCurve::Linear,
                    unit: Some("beats".into()),
                    enum_labels: vec![],
                    group: None,
                    value: ControlValue::Float(0.0),
                },
            },
            tracks: vec![Track {
                id: EntityId::new("track.abc"),
                name: "Kick".into(),
                kind: TrackKind::Audio,
                color: Some("#c04040".into()),
                gain: fader("track.abc.gain", -6.0),
                pan: Parameter {
                    id: EntityId::new("track.abc.pan"),
                    kind: ControlKind::Continuous,
                    label: "Pan".into(),
                    range: Some([-1.0, 1.0]),
                    scale: ScaleCurve::Linear,
                    unit: None,
                    enum_labels: vec![],
                    group: None,
                    value: ControlValue::Float(0.0),
                },
                mute: toggle("track.abc.mute", "Mute"),
                solo: toggle("track.abc.solo", "Solo"),
                record_arm: Some(toggle("track.abc.rec", "Rec")),
                sends: vec![],
                plugins: vec![],
                peak_meter: Some(EntityId::new("track.abc.meter")),
            }],
            meta: serde_json::json!({"project": "demo", "sample_rate": 48000}),
        };

        let j = serde_json::to_string(&session).unwrap();
        let back: Session = serde_json::from_str(&j).unwrap();
        assert_eq!(session, back);
    }
}
