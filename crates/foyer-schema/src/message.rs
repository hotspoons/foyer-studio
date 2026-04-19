//! Message envelope and event/command types shared across `foyer-ipc` and
//! `foyer-ws`.
//!
//! The envelope adds `seq`, `origin`, and a schema version tag so consumers can detect
//! drops (by seq gap), attribute changes (for presence/UI), and reject incompatible
//! senders.

use serde::{Deserialize, Serialize};

use crate::{
    Action, AudioFormat, AudioSource, ControlValue, EntityId, LatencyReport, PathListing,
    PluginCatalogEntry, Region, RegionPatch, Session, TimelineMeta, WaveformPeaks,
};

/// Monotonic, server-assigned sequence number. Drops/out-of-order packets are detected
/// by gaps; clients reconcile via a short ring buffer or full snapshot.
pub type Seq = u64;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope<T> {
    /// Schema version at send time. `(major, minor)` — major mismatches are hard errors.
    pub schema: (u16, u16),
    pub seq: Seq,
    /// Free-form origin tag, e.g. `"shim"`, `"user:alice"`, `"sidecar"`. Used for
    /// presence displays and to let clients ignore echoes of their own changes.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub origin: Option<String>,
    pub body: T,
}

/// Value update for a single control — produced whenever an authoritative side observes
/// a change (shim observes the host; sidecar observes `control.set` requests being
/// applied).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlUpdate {
    pub id: EntityId,
    pub value: ControlValue,
}

/// Structural delta: something was added, removed, renamed, or reshaped.
///
/// These are coarse by design — most UIs will just request a fresh snapshot when a
/// `session.patch` arrives unless they care about the specific operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Patch {
    TrackAdded {
        track: Box<crate::Track>,
    },
    TrackRemoved {
        id: EntityId,
    },
    PluginAdded {
        track_id: EntityId,
        plugin: Box<crate::PluginInstance>,
    },
    PluginRemoved {
        id: EntityId,
    },
    /// Hint to re-request a full snapshot; used when a coarse change makes per-op
    /// patching uneconomical (e.g., session load).
    Reload,
}

/// Everything the authoritative side can emit. `foyer-ipc` and `foyer-ws` share this
/// vocabulary with just the audio-frame transport differing (binary framing on IPC,
/// WebRTC out-of-band on WS).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    /// Full current session. Produced on connect and on demand.
    SessionSnapshot {
        session: Box<Session>,
    },
    /// Structural delta.
    SessionPatch {
        patch: Patch,
    },
    /// Single-control value change.
    ControlUpdate {
        update: ControlUpdate,
    },
    /// Bundled meter readings — use this on the hot path at ~30 Hz.
    MeterBatch {
        values: Vec<ControlUpdate>,
    },
    /// Shim announces an egress stream is available in the given format.
    AudioEgressOffer {
        stream_id: u32,
        source: AudioSource,
        format: AudioFormat,
    },
    /// Shim confirms a start or reports its current running egress streams.
    AudioEgressStarted {
        stream_id: u32,
    },
    AudioEgressStopped {
        stream_id: u32,
    },
    /// Shim reports an ingress sink is ready (or it closed).
    AudioIngressOpened {
        stream_id: u32,
        source: AudioSource,
        format: AudioFormat,
    },
    AudioIngressClosed {
        stream_id: u32,
    },
    /// Latest latency calibration result.
    LatencyReport {
        stream_id: u32,
        report: LatencyReport,
    },
    /// Generic error the peer should surface to the user.
    Error {
        code: String,
        message: String,
    },

    // ───── introspection responses ───────────────────────────────────────
    /// Reply to `Command::ListActions`. Clients use this to populate menus,
    /// command palettes, and the agent's tool surface.
    ActionsList {
        actions: Vec<Action>,
    },
    /// Reply to `Command::ListRegions`. `timeline` carries length + sample
    /// rate; `regions` is the current set for `track_id`.
    RegionsList {
        track_id: EntityId,
        timeline: TimelineMeta,
        regions: Vec<Region>,
    },
    /// Reply to `Command::ListPlugins`.
    PluginsList {
        entries: Vec<PluginCatalogEntry>,
    },
    /// Reply to `Command::BrowsePath`.
    PathListed {
        listing: PathListing,
    },
    /// Reply to `Command::OpenSession` or `Command::SaveSession` — or an
    /// unprompted emission if the host switches sessions.
    SessionChanged {
        /// Jail-relative path to the session file or `None` for "closed".
        path: Option<String>,
    },

    /// A region was mutated. Clients should patch it in place (same id).
    RegionUpdated {
        region: Region,
    },
    /// A region was removed from the session. Clients should drop it from
    /// their per-track region list.
    RegionRemoved {
        track_id: EntityId,
        region_id: EntityId,
    },
    /// Reply to `Command::ListWaveform` with pre-decimated peak data.
    WaveformData {
        peaks: WaveformPeaks,
    },
    /// Emitted after `Command::ClearWaveformCache` completes.
    WaveformCacheCleared {
        /// Number of regions whose cached peaks were dropped.
        dropped: u32,
    },
}

/// Everything a subscriber (sidecar speaking to a shim, or browser speaking to the
/// sidecar) can request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    /// Initial handshake; answered with `session.snapshot`.
    Subscribe,
    /// Request a fresh snapshot (resync).
    RequestSnapshot,
    /// Apply a value change.
    ControlSet {
        id: EntityId,
        value: ControlValue,
    },
    /// Start a new egress stream (DAW → subscriber).
    AudioEgressStart {
        stream_id: u32,
        source: AudioSource,
        format: AudioFormat,
    },
    AudioEgressStop {
        stream_id: u32,
    },
    /// Open an ingress sink (subscriber → DAW) bound to a host input.
    AudioIngressOpen {
        stream_id: u32,
        source: AudioSource,
        format: AudioFormat,
    },
    AudioIngressClose {
        stream_id: u32,
    },
    /// Ask the shim to run a round-trip latency probe on the given stream pair.
    LatencyProbe {
        stream_id: u32,
    },

    // ───── introspection requests ────────────────────────────────────────
    /// Ask the shim (or stub) for its current action catalog. Replied to with
    /// `Event::ActionsList`.
    ListActions,
    /// Execute a named action.
    InvokeAction {
        id: EntityId,
    },
    /// Ask for regions on a given track.
    ListRegions {
        track_id: EntityId,
    },
    /// Ask for the plugin catalog.
    ListPlugins,
    /// Browse a path inside the jail. `""` / `"/"` / `"."` mean root.
    BrowsePath {
        path: String,
    },
    /// Load a session at `path` (jail-relative).
    OpenSession {
        path: String,
    },
    /// Save the currently-loaded session. Optional `as_path` for "save as".
    SaveSession {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        as_path: Option<String>,
    },

    /// Mutate a region. Fields in `patch` that are `None` stay unchanged.
    UpdateRegion {
        id: EntityId,
        patch: RegionPatch,
    },
    /// Remove a region from its track. Emits `RegionRemoved` on success.
    DeleteRegion {
        id: EntityId,
    },
    /// Ask for decimated peaks for `region_id` at the given resolution. The
    /// sidecar rounds the request to the nearest cached tier.
    ListWaveform {
        region_id: EntityId,
        samples_per_peak: u32,
    },
    /// Drop waveform caches. If `region_id` is `None`, drops all.
    ClearWaveformCache {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        region_id: Option<EntityId>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::{ControlKind, ScaleCurve};
    use crate::Parameter;

    fn tempo_param(bpm: f64) -> Parameter {
        Parameter {
            id: EntityId::new("transport.tempo"),
            kind: ControlKind::Continuous,
            label: "Tempo".into(),
            range: Some([20.0, 300.0]),
            scale: ScaleCurve::Linear,
            unit: Some("BPM".into()),
            enum_labels: vec![],
            group: None,
            value: ControlValue::Float(bpm),
        }
    }

    #[test]
    fn event_control_update_round_trip() {
        let ev = Event::ControlUpdate {
            update: ControlUpdate {
                id: EntityId::new("track.abc.gain"),
                value: ControlValue::Float(-3.0),
            },
        };
        let j = serde_json::to_string(&ev).unwrap();
        assert!(j.contains(r#""type":"control_update""#));
        let back: Event = serde_json::from_str(&j).unwrap();
        assert_eq!(ev, back);
    }

    #[test]
    fn envelope_carries_seq_and_origin() {
        let env = Envelope {
            schema: crate::SCHEMA_VERSION,
            seq: 42,
            origin: Some("user:alice".into()),
            body: Command::ControlSet {
                id: EntityId::new("transport.tempo"),
                value: ControlValue::Float(128.0),
            },
        };
        let j = serde_json::to_string(&env).unwrap();
        let back: Envelope<Command> = serde_json::from_str(&j).unwrap();
        assert_eq!(env, back);
    }

    #[test]
    fn patch_variants_tagged_by_op() {
        let t = crate::Track {
            id: EntityId::new("track.new"),
            name: "Aux".into(),
            kind: crate::TrackKind::Bus,
            color: None,
            gain: tempo_param(0.0),
            pan: tempo_param(0.0),
            mute: tempo_param(0.0),
            solo: tempo_param(0.0),
            record_arm: None,
            sends: vec![],
            plugins: vec![],
            peak_meter: None,
        };
        let patch = Patch::TrackAdded { track: Box::new(t) };
        let j = serde_json::to_string(&patch).unwrap();
        assert!(j.contains(r#""op":"track_added""#));
        let _: Patch = serde_json::from_str(&j).unwrap();

        let j2 = serde_json::to_string(&Patch::Reload).unwrap();
        assert_eq!(j2, r#"{"op":"reload"}"#);
    }
}
