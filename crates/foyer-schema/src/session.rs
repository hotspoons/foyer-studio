//! Session structure: the tree of tracks, buses, plugins, and transport state.
//!
//! These types describe "what exists right now." They're the payload of
//! `session.snapshot` messages and the targets of `session.patch` structural deltas.

use serde::{Deserialize, Serialize};

use crate::{io::IoPort, scripting::ScriptingCapabilities, EntityId, Parameter};

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
    /// True when the backend can host a native UI for this plugin
    /// (LV2 has a `ui:`, VST3 reports an IPlugView, etc.). Phase 1
    /// only advertises the capability — actual streaming arrives in
    /// a later phase. Absent / `None` is the same as `Some(false)`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub has_native_gui: Option<bool>,
    /// Format hint used as a UI label only (`"lv2"`, `"vst3"`,
    /// `"vst2"`, `"au"`, …). Routing of the framebuffer stream is
    /// keyed off `id`; this is purely so the toggle can read
    /// "Show native VST3 GUI" instead of a generic label.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub native_gui_kind: Option<String>,
    /// True when the plugin insert exists but the underlying binary
    /// is missing / unloadable. The UI should show a warning instead
    /// of an empty parameter panel.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub missing: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Send {
    pub id: EntityId,
    pub target_track: EntityId,
    pub level: Parameter,
    pub pre_fader: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MidiPatchState {
    /// MIDI channel 0..15.
    pub channel: u8,
    /// Current 14-bit bank (MSB << 7 | LSB), or -1 if unset/unknown.
    pub bank: i32,
    /// Current program 0..127.
    pub program: u8,
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
    /// MIDI inbound channel handling: how the track filters incoming
    /// channel data. `"all"` = pass everything through, `"filter"` =
    /// keep only channels set in `capture_channel_mask`, `"force"` =
    /// rewrite every event onto the single channel encoded in
    /// `capture_channel_mask`. `None` for non-MIDI tracks. New MIDI
    /// tracks default to `"force"` at channel 1 (mask = `0x0001`) so
    /// the channel selector stays hidden unless the user opts into a
    /// multi-channel setup. Mirrors Ardour's `ChannelMode` enum.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub capture_channel_mode: Option<String>,
    /// 16-bit bitmask, bit 0 = MIDI channel 1. In `"force"` mode the
    /// lowest set bit is the target channel; in `"filter"` mode every
    /// set bit is an enabled channel. `None` for non-MIDI tracks.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub capture_channel_mask: Option<u16>,
    /// MIDI playback channel handling, same shape as
    /// `capture_channel_mode` but applied on the playback side.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub playback_channel_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub playback_channel_mask: Option<u16>,
    /// Projected live MIDI patch state by channel. This is the track-level
    /// instrument/program state, distinct from region-embedded patch-change
    /// events. Empty for non-MIDI tracks or hosts that do not expose it.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub midi_patches: Vec<MidiPatchState>,
}

/// Group / submix metadata. Carries display + drag-affinity hints for
/// clients, plus a set of link flags that determine which control
/// gestures (gain, mute, solo, record-arm) propagate across member
/// tracks. The actual audio routing is still expressed via `sends`
/// and each track's `outputs` — groups don't sum signal, they link
/// gestures, the way Ardour's `RouteGroup` and most DAW edit-groups
/// do. Backends that own a native group concept (Ardour `RouteGroup`)
/// mirror these flags onto their own primitive; the stub backend
/// implements propagation in-process. Either way the wire contract
/// is the same: a `ControlSet` on a member track triggers per-member
/// `ControlUpdate`s for every track in the group.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Group {
    pub id: EntityId,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub color: Option<String>,
    /// Track ids that belong to this group. Order is display order.
    #[serde(default)]
    pub members: Vec<EntityId>,
    /// Master enable. If `false`, no gestures propagate, regardless of
    /// the per-flag state. Lets a user temporarily un-link without
    /// having to re-enter all four flags.
    #[serde(default = "default_true")]
    pub active: bool,
    /// Whether changes to a member's gain propagate (relative-delta —
    /// the same dB delta is applied to every member, so the mix
    /// balance set at the moment the link was enabled is preserved).
    #[serde(default = "default_true")]
    pub link_gain: bool,
    /// Whether toggling mute on a member propagates (absolute — every
    /// member ends up in the new state).
    #[serde(default = "default_true")]
    pub link_mute: bool,
    /// Whether toggling solo on a member propagates (absolute).
    #[serde(default = "default_true")]
    pub link_solo: bool,
    /// Whether toggling record-arm on a member propagates (absolute).
    #[serde(default = "default_true")]
    pub link_record: bool,
}

fn default_true() -> bool {
    true
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
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub link_gain: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub link_mute: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub link_solo: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub link_record: Option<bool>,
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
    /// Audible metronome toggle. When truthy, the click is enabled at the
    /// engine; the UI also uses this to gate the dedicated metronome
    /// mixer strip. The strip's "M" button writes back to the same id
    /// — there's no separate click-mute concept in Ardour, and a
    /// duplicate-purpose parameter would just drift.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub metronome: Option<Parameter>,
    /// Metronome click gain (dB). Independent of `metronome` so the
    /// strip's fader can ride alongside the on/off toggle.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub metronome_gain: Option<Parameter>,
    /// Metronome click peak meter id. Drives the strip's level meter
    /// alongside the fader; backends without a click bus leave this
    /// `None`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub metronome_peak: Option<EntityId>,
    /// External sync source ("internal" | "jack" | "mtc" | "ltc" | "mclk").
    /// Free-form so hosts that invent new sync modes can stream them
    /// through without a schema bump.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sync_source: Option<Parameter>,
    /// What to do with the playhead when the user hits stop.
    /// Free-form string so future modes (`"play_end"`, `"locate_marker"`,
    /// …) don't need a schema bump. Known values today:
    ///   * `"leave"`      — keep the playhead where stop landed
    ///   * `"zero"`       — return to sample 0
    ///   * `"play_start"` — return to wherever play was last pressed
    ///
    /// Lives on the wire (not just in browser localStorage) so the
    /// host's choice travels to every connected client — the phone
    /// performer at the kit shouldn't see a different return mode
    /// than the engineer at the desktop did, and the desktop user
    /// shouldn't be surprised when stop behaves differently after a
    /// remote toggle.
    ///
    /// `None` when the backend doesn't track this concept yet
    /// (legacy snapshots, hosts that haven't been updated). Clients
    /// fall back to a localStorage cache + a "leave" default in
    /// that case.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub return_mode: Option<Parameter>,
}

/// Default session sample rate when no DAW has reported one yet. Matches
/// what every other layer (audio engine spawns, default Opus codec
/// negotiation, the standalone stub) assumes — exposed as a constant
/// so the assumption is one-name-grep'able if it ever needs to change.
pub const DEFAULT_SAMPLE_RATE: u32 = 48_000;

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
    /// Engine sample rate, in Hz. Sourced from `Session::sample_rate()`
    /// on the Ardour side and from the stub's configured value
    /// otherwise. Promoted out of the free-form `meta` blob so every
    /// consumer (timeline pixel math, automation lanes, transport
    /// clock) reads from one typed field instead of fishing through
    /// JSON. Defaults to [`DEFAULT_SAMPLE_RATE`] when the snapshot
    /// pre-dates this field — that matches the legacy hard-coded 48k
    /// every layer was already assuming.
    #[serde(default = "default_sample_rate")]
    pub sample_rate: u32,
    /// Ticks per quarter note for MIDI data. `None` falls back to the
    /// MIDI de-facto 960 on the client side.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ppqn: Option<u32>,
    /// Optional free-form metadata: project name, etc. Sample rate
    /// USED to live here as a JSON `sample_rate` key — that path is
    /// retired in favor of the typed field above. Keep `meta` for
    /// open-ended host-specific extras that don't deserve a schema
    /// bump.
    #[serde(default)]
    pub meta: serde_json::Value,
    /// Backend-advertised scripting surface (script types, languages,
    /// hooks). `None` when the active backend has no scripting layer.
    /// Drives the script-manager UI without baking shim-specific
    /// taxonomy into the FE.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scripting: Option<ScriptingCapabilities>,
}

const fn default_sample_rate() -> u32 {
    DEFAULT_SAMPLE_RATE
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
                metronome_gain: None,
                metronome_peak: None,
                sync_source: None,
                return_mode: None,
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
                capture_channel_mode: None,
                capture_channel_mask: None,
                playback_channel_mode: None,
                playback_channel_mask: None,
                midi_patches: vec![],
            }],
            groups: vec![],
            dirty: false,
            sample_rate: 96_000,
            ppqn: Some(1920),
            meta: serde_json::json!({ "project": "demo" }),
            scripting: None,
        };

        let j = serde_json::to_string(&session).unwrap();
        let back: Session = serde_json::from_str(&j).unwrap();
        assert_eq!(session, back);
    }
}
