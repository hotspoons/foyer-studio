//! Message envelope and event/command types shared across `foyer-ipc` and
//! `foyer-ws`.
//!
//! The envelope adds `seq`, `origin`, and a schema version tag so consumers can detect
//! drops (by seq gap), attribute changes (for presence/UI), and reject incompatible
//! senders.

use serde::{Deserialize, Serialize};

use crate::{
    audio::{AudioTransport, IceCandidate, SdpPayload},
    midi::{MidiNote, MidiNotePatch},
    session::{Group, GroupPatch, Track, TrackPatch},
    Action, AudioFormat, AudioSource, ControlValue, EntityId, LatencyReport, PathListing,
    PluginCatalogEntry, PluginInstance, PluginPreset, Region, RegionPatch, Session, TimelineMeta,
    WaveformPeaks,
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
    /// Which session this envelope belongs to. Outbound events carry
    /// the source session's id so multi-session clients can filter by
    /// their currently-viewed session. Inbound commands either carry
    /// an explicit target or fall back to the WS connection's
    /// currently-selected session (set via `Command::SelectSession`).
    /// `None` on either direction means "global" — control-plane
    /// messages that aren't tied to a specific session.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub session_id: Option<EntityId>,
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
    /// Reply to `Command::ListBackends`. Describes which backend adapters
    /// the sidecar's config has defined (e.g. "ardour", "stub").
    BackendsListed {
        backends: Vec<BackendInfo>,
        /// Which of them is currently live. Empty before any backend
        /// has been attached.
        active: Option<String>,
    },
    /// Emitted when the sidecar swaps its active backend (e.g. after the
    /// picker opens a project). Clients should re-request a snapshot.
    BackendSwapped {
        backend_id: String,
        /// Jail-relative path to the project, if any was opened.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        project_path: Option<String>,
    },
    /// Emitted when the DAW backend disconnects unexpectedly (shim crash,
    /// process killed, socket broken). Clients should surface this
    /// prominently — sessions can't be saved, controls won't actuate,
    /// and audio streaming will have fallen through to the sidecar
    /// test tone. The sidecar itself continues to run; relaunching the
    /// project from the picker rebuilds a fresh backend.
    BackendLost {
        backend_id: String,
        /// Human-readable reason as reported by the backend client
        /// (e.g. "frame read error: Connection reset by peer").
        reason: String,
    },
    /// Sent once to each newly-connected client so it can figure out
    /// whether its WebSocket arrived over loopback (same box as the
    /// sidecar) or from a remote host. Drives the "share session" UX
    /// and any privacy-sensitive affordances.
    ClientGreeting {
        remote_addr: String,
        is_local: bool,
        /// Human-friendly identifier for the sidecar host the client is
        /// attached to. Empty if not known.
        #[serde(default, skip_serializing_if = "String::is_empty")]
        server_host: String,
        /// Port the sidecar is listening on. Lets the client build
        /// share-URLs that match the server's actual config.
        #[serde(default, skip_serializing_if = "is_zero_u16")]
        server_port: u16,
        /// URLs the sidecar thinks it's reachable at (one per non-loopback
        /// interface). Usable as the payload of a "share session" QR. The
        /// first entry is the one most likely to work on a LAN; others
        /// are alternates (IPv6, additional NICs).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        server_urls: Vec<String>,
    },

    // ───── track / group / plugin lifecycle ─────────────────────────────
    TrackUpdated {
        track: Box<Track>,
    },
    GroupUpdated {
        group: Group,
    },
    /// A plugin instance has been inserted on a track. Clients should
    /// splice this into the track's `plugins` array.
    PluginAdded {
        track_id: EntityId,
        plugin: Box<PluginInstance>,
    },
    /// A plugin instance has been removed. Clients should drop it from
    /// the track's `plugins` array.
    PluginRemoved {
        track_id: EntityId,
        plugin_id: EntityId,
    },
    /// A plugin instance has been moved within a track's chain.
    PluginMoved {
        track_id: EntityId,
        plugin_id: EntityId,
        /// New slot index.
        index: u32,
    },
    /// The presets the plugin exposes, answering `Command::ListPluginPresets`.
    PluginPresetsListed {
        plugin_id: EntityId,
        presets: Vec<PluginPreset>,
    },
    /// Plugin GUI state changed — either opened by another user or
    /// closed by the host. Clients use this to keep the "Open/Close
    /// plugin editor" toggle in sync.
    PluginGuiState {
        plugin_id: EntityId,
        /// "floating" | "docked" | "closed".
        state: String,
    },

    // ───── MIDI ─────────────────────────────────────────────────────────
    /// One or more notes on a region changed. Matches the granularity
    /// piano-roll edits produce — a chord drag emits a single event
    /// with all affected notes in `notes`.
    RegionNotesUpdated {
        region_id: EntityId,
        notes: Vec<MidiNote>,
    },
    /// Specific notes were deleted from a region.
    RegionNotesRemoved {
        region_id: EntityId,
        note_ids: Vec<EntityId>,
    },

    // ───── session lifecycle ────────────────────────────────────────────
    /// The host DAW's dirty flag flipped. Surfaces in the status bar as
    /// a "•" chip next to the session name.
    SessionDirtyChanged {
        dirty: bool,
    },

    // ───── multi-session lifecycle ──────────────────────────────────────
    /// Snapshot of every session currently held by the sidecar. Emitted
    /// in response to `Command::ListSessions`, on the initial client
    /// greeting, and after any open/close so clients can refresh their
    /// session switcher without polling.
    SessionList {
        sessions: Vec<SessionInfo>,
    },
    /// A new session has been opened (or attached). Appended to the
    /// client's session list.
    SessionOpened {
        session: SessionInfo,
    },
    /// A session has been closed (shim process shut down cleanly or
    /// `CloseSession` fired). Client should remove it from the
    /// switcher and, if it was the one currently being viewed, either
    /// fall through to another open session or back to the welcome
    /// screen.
    SessionClosed {
        session_id: EntityId,
    },
    /// Sidecar found orphan session registry entries on startup — shim
    /// processes still running but not attached, or crashed shims
    /// with leftover registry/crash data. The UI offers reattach or
    /// reopen (or dismiss / delete the registry entry).
    OrphansDetected {
        orphans: Vec<OrphanInfo>,
    },

    // ───── audio streaming negotiation ──────────────────────────────────
    /// WebRTC SDP offer/answer from the shim. Client replies with
    /// `Command::AudioSdpAnswer` carrying its own SDP.
    AudioSdpOffer {
        stream_id: u32,
        sdp: SdpPayload,
    },
    AudioSdpAnswer {
        stream_id: u32,
        sdp: SdpPayload,
    },
    AudioIceCandidate {
        stream_id: u32,
        candidate: IceCandidate,
    },
}

fn is_zero_u16(n: &u16) -> bool { *n == 0 }

fn default_region_kind() -> String { "midi".to_string() }

/// One currently-open session as tracked by the sidecar. Multi-session
/// clients render this in the session switcher chip and in the
/// Session → Recent menu.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionInfo {
    /// UUID, stable across Foyer restarts — stored inside the .ardour
    /// file as `<Foyer><Session id="..."/></Foyer>`, so opening the
    /// same project from different machines still resolves to the
    /// same id.
    pub id: EntityId,
    /// Backend adapter id ("ardour", "stub", etc).
    pub backend_id: String,
    /// Absolute canonical path to the session file / directory. Empty
    /// for stub / scratch sessions.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub path: String,
    /// Display name. Usually the project's basename; falls back to
    /// the host's reported session name.
    pub name: String,
    /// Unix epoch seconds when this session was opened (or attached).
    pub opened_at: u64,
    /// Whether the session has unsaved changes. Mirrors
    /// `Event::SessionDirtyChanged` for convenience in the UI.
    #[serde(default)]
    pub dirty: bool,
}

/// An orphaned session discovered on sidecar startup. Either the shim
/// is still running but Foyer lost track of it (can reattach), or the
/// shim's pid is dead and we have leftover registry/crash data to
/// offer as a reopen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrphanInfo {
    pub id: EntityId,
    pub backend_id: String,
    pub path: String,
    pub name: String,
    /// "running" → shim process still alive, socket reachable
    ///     (offer Reattach). "crashed" → shim pid dead (offer Reopen).
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket: Option<String>,
}

/// Metadata for a single backend entry in the sidecar's config — what
/// the picker UI needs to render a "pick a DAW" dropdown.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BackendInfo {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub enabled: bool,
    /// True if launching this backend requires (or benefits from) a
    /// project path. The stub accepts `None`; Ardour needs one.
    pub requires_project: bool,
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
    /// `show_hidden` = `true` surfaces dotfile entries; default behavior
    /// hides them so the picker stays uncluttered.
    BrowsePath {
        path: String,
        #[serde(default)]
        show_hidden: bool,
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
    /// Create a brand-new empty region on `track_id` starting at
    /// `at_samples`. `length_samples` defaults to one bar at the
    /// session's current tempo if omitted. `kind` selects the
    /// region's media type — today only "midi" is wired (audio
    /// regions need a source file, which the UI doesn't yet have a
    /// picker for). Emits `RegionsList` for the track on success.
    CreateRegion {
        track_id: EntityId,
        at_samples: u64,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        length_samples: Option<u64>,
        #[serde(default = "default_region_kind")]
        kind: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        name: Option<String>,
    },
    /// Clone `source_region_id` into a new region on the same track,
    /// starting at `at_samples`. If `length_samples` is `None` the
    /// clone adopts the source's length. Carries over MIDI notes
    /// AND extra_xml (so Foyer sequencer layouts duplicate too).
    /// Emits a `RegionsList` echo for the track on success.
    DuplicateRegion {
        source_region_id: EntityId,
        at_samples: u64,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        length_samples: Option<u64>,
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

    /// Ask for the configured backend list. Answered with
    /// `Event::BackendsListed`.
    ListBackends,
    /// Launch the named backend (optionally with a project file), then
    /// atomically swap the sidecar's active backend. Answered with
    /// `Event::BackendSwapped` on success, `Event::Error` on failure.
    LaunchProject {
        backend_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        project_path: Option<String>,
    },

    // ───── multi-session control plane ──────────────────────────────────
    /// Ask the sidecar for its current session list. Answered with
    /// `Event::SessionList`. Usually used on reconnect to resync after
    /// a network hiccup — the initial client greeting already includes
    /// the list so first-load doesn't need this.
    ListSessions,
    /// Set which session this WS connection is currently viewing.
    /// Commands that arrive without an explicit `session_id` on the
    /// envelope route to this session. Events keep their own
    /// `session_id` tag; clients filter on the receiving side.
    SelectSession {
        session_id: EntityId,
    },
    /// Close an open session — shuts down the shim + backend and
    /// removes it from the sidecar's session map. If the closed
    /// session was the WS connection's selected session, the sidecar
    /// picks the next open session as the new current (or `None` if
    /// this was the last one). Emits `Event::SessionClosed`.
    CloseSession {
        session_id: EntityId,
    },
    /// Reattach to an orphaned running shim. Sidecar builds a fresh
    /// backend against the orphan's socket and promotes it to a full
    /// session (as if it had been opened normally). Emits
    /// `Event::SessionOpened`.
    ReattachOrphan {
        orphan_id: EntityId,
    },
    /// Remove an orphan's registry entry without reattaching. Used by
    /// the crash-recovery dialog's "Dismiss" button when the user
    /// doesn't want to restore a crashed session.
    DismissOrphan {
        orphan_id: EntityId,
    },

    // ───── track / group / plugin lifecycle ─────────────────────────────
    /// Mutate a track. Fields in `patch` that are `None` stay unchanged.
    /// Emits `Event::TrackUpdated` on success.
    UpdateTrack {
        id: EntityId,
        patch: TrackPatch,
    },
    /// Create a new group / submix. Answered with `Event::GroupUpdated`.
    CreateGroup {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        color: Option<String>,
        #[serde(default)]
        members: Vec<EntityId>,
    },
    UpdateGroup {
        id: EntityId,
        patch: GroupPatch,
    },
    DeleteGroup {
        id: EntityId,
    },

    /// Add a plugin to a track's effect chain at `index` (append if `None`).
    /// `plugin_uri` is a plugin catalog URI — see `PluginCatalogEntry`.
    AddPlugin {
        track_id: EntityId,
        plugin_uri: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        index: Option<u32>,
    },
    RemovePlugin {
        plugin_id: EntityId,
    },
    MovePlugin {
        plugin_id: EntityId,
        new_index: u32,
    },
    /// Ask the shim/host for the presets a plugin exposes. Answered with
    /// `Event::PluginPresetsListed`.
    ListPluginPresets {
        plugin_id: EntityId,
    },
    LoadPluginPreset {
        plugin_id: EntityId,
        preset_id: EntityId,
    },
    /// Capture the plugin's current parameter values as a new preset,
    /// stored alongside the session.
    SavePluginPreset {
        plugin_id: EntityId,
        name: String,
    },
    /// Ask the host to open the plugin's native GUI in its own window.
    /// Most hosts route this to the editor window they'd normally open
    /// on double-click in their mixer.
    OpenPluginGui {
        plugin_id: EntityId,
    },
    ClosePluginGui {
        plugin_id: EntityId,
    },

    // ───── MIDI ─────────────────────────────────────────────────────────
    AddNote {
        region_id: EntityId,
        note: MidiNote,
    },
    UpdateNote {
        region_id: EntityId,
        note_id: EntityId,
        patch: MidiNotePatch,
    },
    DeleteNote {
        region_id: EntityId,
        note_id: EntityId,
    },
    /// Replace every note in a MIDI region with the provided list in
    /// one atomic operation (single undo entry on the host). Used by
    /// the server's sequencer regeneration path — the backend
    /// expands a `SequencerLayout` into notes and ships them here,
    /// so the shim can swap them wholesale instead of firing N
    /// individual `DeleteNote` + M `AddNote` commands.
    ReplaceRegionNotes {
        region_id: EntityId,
        notes: Vec<MidiNote>,
    },
    /// Insert a program/bank change event into a MIDI region. The shim
    /// builds an Ardour `Evoral::PatchChange` at `start_ticks` on
    /// `channel` and ships it through `PatchChangeDiffCommand::add`.
    AddPatchChange {
        region_id: EntityId,
        patch_change: crate::midi::PatchChange,
    },
    UpdatePatchChange {
        region_id: EntityId,
        patch_change_id: EntityId,
        patch: crate::midi::PatchChangePatch,
    },
    DeletePatchChange {
        region_id: EntityId,
        patch_change_id: EntityId,
    },

    /// Install a beat-sequencer layout on a MIDI region. The shim
    /// persists it in the region's `_extra_xml` sub-tree so stock
    /// Ardour save/load cycles preserve it, and (re)generates the
    /// region's note list from the layout's cells. Passing this
    /// flips the region to "sequencer-owned" state.
    SetSequencerLayout {
        region_id: EntityId,
        layout: crate::midi::SequencerLayout,
    },
    /// Drop the beat-sequencer metadata from a region. Note list is
    /// left as-is — the user can keep editing in the piano roll.
    ClearSequencerLayout {
        region_id: EntityId,
    },

    // ───── session undo / redo ──────────────────────────────────────────
    /// Pop one step off the session's undo stack. In Ardour this is
    /// `Session::undo(1)`; other hosts should behave equivalently
    /// (reverse the most recent reversible command).
    Undo,
    /// Re-apply the most recently undone step.
    Redo,

    // ───── transport ────────────────────────────────────────────────────
    /// Move the playhead to the given sample position. Distinct from
    /// setting `transport.position` via `ControlSet` because it carries
    /// "stop and seek" semantics on hosts that distinguish.
    Locate {
        samples: u64,
    },

    // ───── audio streaming negotiation ──────────────────────────────────
    /// Open an audio stream with an explicit transport. Replaces the
    /// older `AudioEgressStart` / `AudioIngressOpen` when the client
    /// wants WebRTC — for plain WebSocket it's optional. Direction
    /// (ingress vs egress) is implicit in `source`: `Port` / `VirtualInput`
    /// are ingress sinks; `Master` / `Track` / `Monitor` are egress taps.
    AudioStreamOpen {
        stream_id: u32,
        source: AudioSource,
        format: AudioFormat,
        transport: AudioTransport,
    },
    AudioStreamClose {
        stream_id: u32,
    },
    /// Client's WebRTC answer in response to an `AudioSdpOffer`.
    AudioSdpAnswer {
        stream_id: u32,
        sdp: SdpPayload,
    },
    /// ICE candidate from the client, to be forwarded to the shim's
    /// peer-connection.
    AudioIceCandidate {
        stream_id: u32,
        candidate: IceCandidate,
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
            session_id: None,
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
            monitoring: None,
            sends: vec![],
            plugins: vec![],
            peak_meter: None,
            group_id: None,
            inputs: vec![],
            outputs: vec![],
        };
        let patch = Patch::TrackAdded { track: Box::new(t) };
        let j = serde_json::to_string(&patch).unwrap();
        assert!(j.contains(r#""op":"track_added""#));
        let _: Patch = serde_json::from_str(&j).unwrap();

        let j2 = serde_json::to_string(&Patch::Reload).unwrap();
        assert_eq!(j2, r#"{"op":"reload"}"#);
    }
}
