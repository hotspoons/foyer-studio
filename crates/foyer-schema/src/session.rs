//! Session structure: the tree of tracks, buses, plugins, and transport state.
//!
//! These types describe "what exists right now." They're the payload of
//! `session.snapshot` messages and the targets of `session.patch` structural deltas.

use serde::{Deserialize, Serialize};

use crate::{io::IoPort, EntityId, Parameter};

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
    /// URI of the preset most recently applied to this instance, or
    /// `None` when the plugin is in its native default state. Lets the
    /// preset selector pre-select the active preset's name on session
    /// reload without the user re-applying.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub current_preset: Option<String>,
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
    /// Monitoring mode: `"auto" | "input" | "disk" | "cue"`. Matches
    /// Ardour's `MonitorChoice`. Absent = host doesn't expose it
    /// (e.g. bus/master strips). Editable via `UpdateTrack { patch:
    /// { monitoring: Some(...) } }`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub monitoring: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub sends: Vec<Send>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub plugins: Vec<PluginInstance>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub peak_meter: Option<EntityId>,
    /// Which track/bus group this track belongs to, if any. Free-form
    /// reference — the shim populates it from its own group model
    /// (Ardour RouteGroup, Reaper track folder, etc.).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub group_id: Option<EntityId>,
    /// The bus this track's main output feeds into. `None` means
    /// "default" (master or whatever the host does by default);
    /// `Some("track.<bus-id>")` means the track's main output is wired
    /// to that bus's input. Editable via
    /// `UpdateTrack { patch: { bus_assign: Some(...) } }`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub bus_assign: Option<EntityId>,
    /// Addressable I/O ports. `inputs` are where the track records from
    /// (mic/instrument routing); `outputs` are where its signal goes
    /// post-fader. Clients use these as targets for remote streaming.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub inputs: Vec<IoPort>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub outputs: Vec<IoPort>,
    /// Automation lanes attached to this track's well-known controls
    /// (gain / pan / mute / solo). Plugin-parameter lanes live on
    /// the PluginInstance. Empty vec = no automation read yet (or
    /// host doesn't expose any). Phase A is read-only; writes land
    /// via dedicated commands in Phase B.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub automation_lanes: Vec<crate::AutomationLane>,
}

/// Group / submix metadata. Purely a display + drag-affinity hint for
/// clients — the actual audio routing is still expressed via `sends`
/// and each track's `outputs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Group {
    pub id: EntityId,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub color: Option<String>,
    /// Track ids that belong to this group. Order is display order.
    #[serde(default)]
    pub members: Vec<EntityId>,
}

/// Patch set for [`Command::UpdateTrack`]. `None` fields are left
/// unchanged. Named fields map directly onto shim-side setters; enum-like
/// fields (like `kind`) are deliberately missing — kind changes require
/// recreating the track.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TrackPatch {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub group_id: Option<EntityId>,
    /// Assign the track's main output to this bus. `Some("")` clears
    /// the assignment back to master.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub bus_assign: Option<EntityId>,
    /// Set the track's monitoring mode: `"auto" | "input" | "disk" | "cue"`.
    /// Maps to Ardour's `MonitorChoice`. `None` leaves the setting alone.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub monitoring: Option<String>,
    /// Re-route the track's audio input to a named port. `Some("")`
    /// clears custom routing and restores default auto-connect.
    /// `Some("foyer:ingress-...")` wires the track to a browser
    /// ingress stream. `None` leaves input routing untouched.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub input_port: Option<String>,
}

/// Patch set for [`Command::UpdateGroup`]. Same `None`-leaves-unchanged
/// shape as `TrackPatch`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GroupPatch {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub color: Option<String>,
    /// Replace the member list wholesale. For incremental membership
    /// changes use separate `Command::MoveTrackToGroup` (not in schema yet).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub members: Option<Vec<EntityId>>,
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
    /// Punch-in / punch-out enables. Boolean triggers; positions are
    /// expressed via the session's range markers (not in schema yet).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub punch_in: Option<Parameter>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub punch_out: Option<Parameter>,
    /// Audible metronome toggle.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub metronome: Option<Parameter>,
    /// External sync source ("internal" | "jack" | "mtc" | "ltc" | "mclk").
    /// Free-form so hosts that invent new sync modes can stream them
    /// through without a schema bump.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sync_source: Option<Parameter>,
}

/// The full session snapshot. Shipped on connect and on demand for resync.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub schema_version: (u16, u16),
    pub transport: Transport,
    pub tracks: Vec<Track>,
    /// Declared groups. Membership is also mirrored on each track's
    /// `group_id` for quick lookup, but `groups` is the authoritative
    /// ordering source when two clients race to rename / reorder.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub groups: Vec<Group>,
    /// Whether the host DAW considers the session to have unsaved
    /// changes. Updated via [`crate::Event::SessionDirtyChanged`].
    #[serde(default)]
    pub dirty: bool,
    /// Ticks per quarter note for MIDI data. `None` falls back to the
    /// MIDI de-facto 960 on the client side.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ppqn: Option<u32>,
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
                punch_in: None,
                punch_out: None,
                metronome: None,
                sync_source: None,
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
                monitoring: Some("auto".into()),
                sends: vec![],
                plugins: vec![],
                peak_meter: Some(EntityId::new("track.abc.meter")),
                group_id: None,
                bus_assign: None,
                inputs: vec![],
                outputs: vec![],
                automation_lanes: vec![],
            }],
            groups: vec![],
            dirty: false,
            ppqn: Some(960),
            meta: serde_json::json!({"project": "demo", "sample_rate": 48000}),
        };

        let j = serde_json::to_string(&session).unwrap();
        let back: Session = serde_json::from_str(&j).unwrap();
        assert_eq!(session, back);
    }
}
