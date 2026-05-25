//! Message envelope and event/command types shared across `foyer-ipc` and
//! `foyer-ws`.
//!
//! The envelope adds `seq`, `origin`, numeric `schema`, Kubernetes-style `api_version`,
//! and a body so consumers can detect drops (by seq gap), attribute changes (for
//! presence/UI), reject incompatible senders, and gate coarse API evolution.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    audio::{AudioPoolSource, AudioTransport, IceCandidate, SdpPayload},
    midi::{MidiNote, MidiNotePatch, MidiPatchNames},
    session::{Group, GroupPatch, Track, TrackPatch},
    spectrum::{SpectrumFrame, SpectrumOpts, SpectrumTarget},
    Action, AudioFormat, AudioSource, ControlValue, EnginePort, EntityId, LatencyReport,
    PathListing, PluginCatalogEntry, PluginInstance, PluginPreset, Region, RegionPatch, Session,
    TimelineMeta, WaveformPeaks,
};

/// Monotonic, server-assigned sequence number. Drops/out-of-order packets are detected
/// by gaps; clients reconcile via a short ring buffer or full snapshot.
pub type Seq = u64;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope<T> {
    /// Schema version at send time. `(major, minor)` — major mismatches are hard errors.
    pub schema: (u16, u16),
    /// Named API line (`group/version`), Kubernetes-style. Prefer this for coarse
    /// compatibility; [`Self::schema`] remains the fine-grained tuple.
    #[serde(default = "default_control_plane_api_version")]
    pub api_version: String,
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

fn default_control_plane_api_version() -> String {
    crate::CONTROL_PLANE_API_VERSION.to_string()
}

impl<T> Envelope<T> {
    /// Envelope with [`crate::SCHEMA_VERSION`] and [`crate::CONTROL_PLANE_API_VERSION`].
    pub fn new(seq: Seq, origin: Option<String>, session_id: Option<EntityId>, body: T) -> Self {
        Self {
            schema: crate::SCHEMA_VERSION,
            api_version: crate::CONTROL_PLANE_API_VERSION.to_string(),
            seq,
            origin,
            session_id,
            body,
        }
    }
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
        /// Engine-level port name the shim actually registered (e.g.
        /// `ardour:foyer-ingress-browser-123`). The client needs this
        /// to patch a track's `input_port` — deriving it from the
        /// command's `name` doesn't work because the engine prepends
        /// its own client prefix on registration. Optional for
        /// back-compat with older shims.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        port_name: Option<String>,
    },
    AudioIngressClosed {
        stream_id: u32,
    },
    /// Periodic timing sentinel used to correlate the audio egress
    /// stream with the event/control stream. The server picks a frame
    /// from the audio encode loop (the `server_mono_ns` timestamp on
    /// that frame IS the correlation id), then broadcasts this event
    /// on the JSON event channel. The browser receives the audio frame
    /// and this event at different wall-clock moments; the delta
    /// between their arrival times (adjusted for the clock-probe
    /// offset) is the real-time audio-vs-event path skew.  Multiple
    /// seconds of skew means we should restart the audio stream.
    AudioSentinel {
        stream_id: u32,
        /// The server's monotonic clock at capture time — the same
        /// value carried in the matching audio frame's binary header.
        server_mono_ns: u64,
        /// Engine transport position at capture time, if known.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        transport_pos_samples: Option<u64>,
    },
    /// One FFT analysis frame produced by the shim's spectrogram
    /// pipeline. Streamed at the subscription's hop rate; clients
    /// render each frame as a column in a waterfall display OR as
    /// the latest bar plot in an instantaneous view. Tagged by
    /// `target` so a multiplexed connection can subscribe to several
    /// scopes (master + per-track) and demultiplex on the FE.
    SpectrumFrame {
        frame: Box<SpectrumFrame>,
    },
    /// Subscription confirmation — the shim acknowledges the
    /// requested `SpectrumOpts` and reports what it actually applied
    /// after clamping. Lets the FE update its UI hints without
    /// re-deriving the clamped values from the first frame.
    SpectrumSubscribed {
        target: SpectrumTarget,
        applied: SpectrumOpts,
    },
    /// Subscription closed — emitted in response to
    /// `Command::UnsubscribeSpectrum` or when the backend decides to
    /// tear it down (target gone, host overloaded, …).
    SpectrumUnsubscribed {
        target: SpectrumTarget,
        /// `None` = clean unsubscribe; `Some(_)` = host-initiated
        /// teardown with a reason for the FE to surface.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        reason: Option<String>,
    },
    /// Server → browser: reply to `RequestIngressLatency` and also
    /// broadcast whenever the server-side empirical roundtrip median
    /// shifts past the apply threshold (i.e. whenever the server is
    /// about to push `SetIngressCaptureLatency` to the shim). The
    /// median is now FULL ROUND-TRIP browser↔server, since the
    /// ingress header carries `echo_server_mono_ns` and the server
    /// compares against its own monotonic clock. `None` means too
    /// few samples to compute a stable median yet.
    IngressLatencyReport {
        stream_id: u32,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        median_ms: Option<f32>,
    },
    /// Per-click progress fired during an ingress calibration run.
    /// `n` is 1-indexed (`1`, `2`, …) so the UI can render `5/8`
    /// style progress. `measured_ms` is the raw round-trip for this
    /// individual click (NOT yet medianed).
    CalibrationProgress {
        stream_id: u32,
        n: u32,
        total: u32,
        measured_ms: f32,
    },
    /// Fired once at the end of a calibration run. `median_ms` is
    /// the empirically-measured speaker→mic round-trip; `samples_kept`
    /// is how many of the requested clicks were actually detected
    /// (the rest were missed — typically because of ambient noise
    /// or the user not playing the egress stream out their speakers).
    /// `suggested_offset_ms` is `median_ms − empirical_median_ms` —
    /// the value the Manual capture offset should be set to in
    /// order to close the gap. May be negative if the empirical
    /// stack happens to over-estimate.
    CalibrationResult {
        stream_id: u32,
        median_ms: f32,
        samples_kept: u32,
        samples_requested: u32,
        suggested_offset_ms: i32,
    },
    /// Server → browser: empirical MIDI roundtrip-latency report,
    /// keyed by track id. Broadcast whenever the server pushes a
    /// new `SetMidiCaptureLatency` to the shim for the track (i.e.
    /// after the per-track median has shifted past the apply
    /// threshold). Mirrors `IngressLatencyReport` for the MIDI
    /// path; the UI surfaces both side-by-side in the Timing tab.
    MidiLatencyReport {
        track_id: EntityId,
        median_ms: f32,
        samples_to_shim: u32,
    },
    /// Latest latency calibration result.
    LatencyReport {
        stream_id: u32,
        report: LatencyReport,
    },
    /// Generic error the peer should surface to the user.
    ///
    /// `target_peer_id`, when set, restricts the visibility of this
    /// error: the server forwards the event only to the connection(s)
    /// owned by that peer plus LAN / tunnel-admin connections. Most
    /// errors are session-wide (target = `None`); RBAC denials and
    /// other "addressed at the offender" diagnostics fill it in so
    /// other guests don't see denial banners flash by.
    Error {
        code: String,
        /// English (pre-localized) message. Always populated so older
        /// clients that don't grok `localized` still show something
        /// readable. New emit sites set BOTH fields via the
        /// `loc!(...)` macro from `foyer-i18n`.
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target_peer_id: Option<String>,
        /// Structured translation key + placeholder map. Clients
        /// prefer this when present so multi-locale collab sessions
        /// can render the same error in each viewer's own language.
        /// `None` is the legacy shape — `message` is rendered as-is.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        localized: Option<crate::LocalizedString>,
    },
    /// Reply to `Command::ProbeSessionRecovery`. `artifacts` is empty
    /// when the project has nothing to recover and the launch can
    /// proceed silently; non-empty when the user should be prompted
    /// to choose Recover or Ignore. The browser sets
    /// `LaunchProject.recover_crash` from the prompt's outcome.
    SessionRecoveryAvailable {
        project_path: String,
        artifacts: Vec<SessionRecoveryArtifact>,
    },
    /// Reply to `Command::ClockProbe`. Echoes the client's send
    /// timestamp verbatim so the requester can compute round-trip
    /// time, alongside the server's monotonic clock at the moment
    /// the request was handled. The client uses
    /// `(t_recv - t_send) / 2` as the one-way latency estimate and
    /// `server_mono_ns - (t_send + rtt/2 in ns)` as the offset
    /// between its `performance.now()` clock and the server's
    /// monotonic clock — same shape as a single-bounce NTP round.
    /// Sent as a unicast event to the requesting connection (not
    /// broadcast); other clients should not see it.
    ClockProbeReply {
        client_ts_ms: f64,
        server_mono_ns: u64,
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
    /// Reply to `Command::ListAudioPool`: pool entries backed by on-disk audio
    /// (typically one row per channel for multichannel files).
    AudioPoolListed {
        sources: Vec<AudioPoolSource>,
    },
    /// Reply to `Command::ListPlugins`.
    PluginsList {
        entries: Vec<PluginCatalogEntry>,
    },
    /// Reply to `Command::ListMidiPatchNames` for one MIDI track/channel.
    MidiPatchNamesListed {
        track_id: EntityId,
        names: MidiPatchNames,
    },
    /// Reply to `Command::ListPorts`. Contains the engine-level ports
    /// the shim enumerated (post-filter if the command specified a
    /// direction). Order is shim-provided — typically physical first,
    /// then session-owned, then foreign.
    PortsListed {
        ports: Vec<EnginePort>,
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
        region: Box<Region>,
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
        /// True when this connection arrived via the public tunnel
        /// (auth listener). LAN connections see `false`. Clients use
        /// this to decide whether to render remote-guest UX (login
        /// modal when unauthenticated, role-restricted controls when
        /// authenticated).
        #[serde(default, skip_serializing_if = "is_false")]
        is_tunnel: bool,
        /// True when the server has authenticated this connection —
        /// always true on LAN; on tunnel requires a valid `?token=`.
        /// `false` means the client should show its login UI; every
        /// command will fail with `auth_required` until reconnected
        /// with a valid token.
        #[serde(default = "yes_bool")]
        is_authenticated: bool,
        /// RBAC role id for this connection. `None` on LAN (no gating);
        /// on tunnel it matches a `RoleDef` in the roles config
        /// (`admin`, `session_controller`, `performer`, `viewer`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        role_id: Option<String>,
        /// List of action tags the role is allowed to invoke — the UI
        /// uses this to hide/disable disallowed controls for nicer UX.
        /// For admin this might be `["*"]`; for viewer a concrete
        /// enumeration. Server computes it from the policy at handshake
        /// so the client doesn't need to re-implement pattern matching.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        role_allow: Vec<String>,
        /// Invite recipient (usually email) — shown in the status bar
        /// as "signed in as …" for tunnel guests.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recipient: Option<String>,
        /// This connection's own peer id. Matches the `PeerInfo.id` that
        /// goes out in `PeerJoined` / `PeerList`; the client filters
        /// its own entry out of the displayed roster using this.
        ///
        /// Shared across all WS connections belonging to the same logical
        /// user (multi-window). The per-connection identity lives in
        /// `connection_id`.
        #[serde(default, skip_serializing_if = "String::is_empty")]
        peer_id: String,
        /// Per-connection identity (hex UUID). Unique even when two
        /// windows of the same logical user share a `peer_id`. Used
        /// for self-echo filtering on the client (so window A sees
        /// window B's control updates) and connection-scoped
        /// addressing on the wire.
        #[serde(default, skip_serializing_if = "String::is_empty")]
        connection_id: String,
        /// Whether this WS connection is the spawning ("Primary") window
        /// for the logical peer, or a secondary control-plane window.
        /// Audio ingress / egress is only permitted on `Primary` —
        /// secondaries get a typed error if they try to open one.
        #[serde(default)]
        connection_role: ConnectionRole,
        /// Backend-feature snapshot keyed by a stable feature id (e.g.
        /// `"sequencer"`, `"surround_pan"`, `"groups"`, `"sends"`,
        /// `"automation"`). `true` = supported, `false` = explicitly
        /// unsupported, absent = unknown (UI defaults to optimistic).
        /// Web core mirrors this into its feature registry so alt-UIs
        /// and shipping UI gate surfaces without command probing.
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        features: BTreeMap<String, bool>,
        /// Admin-pinned UI variant id, or `None` to let the client
        /// auto-pick (URL `?ui=` > localStorage > heuristic match). A
        /// host can pin a specific UI variant per deployment (e.g.
        /// "kiosk runs only `touch`") without baking that into each
        /// browser.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default_ui_variant: Option<String>,
        /// True when the backend's audio engine is a dummy (no host
        /// hardware path). The client uses this to decide whether
        /// the master-bus Listen toggle starts ON (dummy: browser is
        /// the only audio path) or OFF (real engine: the user
        /// already hears it through speakers, browser monitoring
        /// would duplicate). Tunnel guests bypass this — they
        /// always default to ON regardless.
        ///
        /// Resolution chain on the server:
        ///   1. `FOYER_ENGINE_DUMMY=1|0` env override (the container
        ///      entrypoint sets this in `gui-dummy` mode).
        ///   2. The active backend's `engine_is_dummy()` self-report.
        ///   3. Conservative default `false` — assume real audio so
        ///      a host-install user with JACK/CoreAudio doesn't
        ///      hear double on first connect.
        #[serde(default)]
        engine_is_dummy: bool,
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
    /// The sidecar's focus has shifted to a different open session
    /// (`Command::SelectSession`, or post-close fallback to the next
    /// session in the list). Carries the new focused session's id, or
    /// `None` if focus was cleared (last session closed). Distinct from
    /// `SessionSnapshot` so clients can tear down session-bound
    /// resources (audio listener stream, region caches, etc.) without
    /// having to track session_id transitions across every snapshot.
    SessionFocusChanged {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        session_id: Option<EntityId>,
    },
    /// Sidecar found orphan session registry entries on startup — shim
    /// processes still running but not attached, or crashed shims
    /// with leftover registry/crash data. The UI offers reattach or
    /// reopen (or dismiss / delete the registry entry).
    OrphansDetected {
        orphans: Vec<OrphanInfo>,
    },
    /// Recently-opened projects, server-tracked. The sidecar persists
    /// this list across restarts (one file in XDG_DATA_HOME) so each
    /// client doesn't carry its own per-browser fork that goes stale
    /// when the server moves between containers. Emitted on connect
    /// and after every touch / forget / clear so welcome screens +
    /// the Session → Open Recent submenu stay live.
    RecentsList {
        recents: Vec<RecentEntry>,
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

    // ───── tunnel / remote access ───────────────────────────────────────
    /// Full current tunnel state.  Emitted on connect and after any
    /// mutation (create/revoke/toggle/hostname change).
    TunnelState {
        state: crate::tunnel::TunnelState,
    },
    /// A new tunnel just came up — the server has a public hostname.
    TunnelUp {
        provider: crate::tunnel::TunnelProviderKind,
        hostname: String,
        url: String,
    },
    /// The tunnel went down (process exited, network lost, etc).
    TunnelDown {
        provider: crate::tunnel::TunnelProviderKind,
    },
    /// A newly-minted credential pair, shown ONCE to the creator. The
    /// server stores only the hash; these clear-text fields are never
    /// re-broadcast after this event.
    /// A peer (another open browser tab / connection) joined. Emitted
    /// on every WS `handle()` startup. Clients build a live "who's
    /// here" list from these plus `PeerLeft` events — more reliable
    /// than sniffing envelope origins (which only shows peers who
    /// have recently sent a command).
    PeerJoined {
        peer: PeerInfo,
    },
    /// A peer disconnected. Paired with `PeerJoined`.
    PeerLeft {
        peer_id: String,
    },
    /// Full roster of connected peers, sent to a newly-connected client
    /// so it starts with accurate state rather than waiting to observe
    /// joins. Includes the recipient's own entry — the client filters
    /// its own via `ClientGreeting.peer_id`.
    PeerList {
        peers: Vec<PeerInfo>,
    },
    TunnelTokenCreated {
        connection: crate::tunnel::TunnelConnection,
        /// Opaque `base64url(sha256(email_norm:password|pepper))` —
        /// the credential digest, base64'd. Goes in the `?token=`
        /// query parameter. Not reversible to the original credentials;
        /// the server matches it directly against the stored hash.
        token: String,
        /// Random password, shown once in the UI so the user can copy
        /// it into an email / password manager.
        password: String,
        /// Convenience: the full share URL with the token baked in.
        /// Everything a recipient needs to auto-log-in by clicking.
        url: String,
    },

    // ───── in-app chat / PTT (relay only — not audio-engine bound) ──────
    /// A chat message arrived. Fanned out to every connected peer.
    /// Persisted in the server's in-memory ring (cleared by admins or
    /// snapshotted to disk on demand).
    ChatMessage {
        record: ChatMessageRecord,
    },
    /// Reply to `Command::ChatHistoryRequest` — the current in-memory
    /// ring of recent chat messages in insertion order.
    ChatHistory {
        records: Vec<ChatMessageRecord>,
    },
    /// Chat history was wiped by an admin (or LAN user). All clients
    /// should drop their transcripts.
    ChatCleared {
        cleared_by_peer_id: String,
        cleared_by_label: String,
    },
    /// Chat was written to disk. `path` is jail-display-friendly
    /// (relative to `$XDG_DATA_HOME/foyer/chat/`).
    ChatSnapshotSaved {
        path: String,
        message_count: u32,
    },
    /// Who currently holds the PTT (or `None` when nobody is speaking).
    /// UI uses this to render a "🎙 Alice is speaking" banner + to gate
    /// the local press so two people can't clobber each other.
    PttState {
        speaker: Option<PttSpeaker>,
    },
    /// One entry in the track → browser-source routing table.
    /// `peer_id` is `None` when the assignment is cleared (no browser
    /// acts as source for this track). Emitted on every change and
    /// also proactively on peer disconnect (the server clears any
    /// assignments pointing at a peer who left).
    TrackBrowserSourceChanged {
        track_id: EntityId,
        peer_id: Option<String>,
    },
    /// Full snapshot of the track → browser-source routing map. Sent
    /// right after the client greeting so a late-joining browser
    /// sees which tracks it is already expected to source without
    /// having to wait for the next mutation.
    TrackBrowserSourcesSnapshot {
        entries: Vec<TrackBrowserSourceEntry>,
    },

    // ───── AI agent (foyer-agent harness; see crates/foyer-agent) ─────
    /// One transcript turn — user input, assistant reply, system
    /// note, or tool result. Fanned out to every connected client so
    /// multiple FABs / TUIs stay in sync. Persisted in-memory only;
    /// `Command::AgentClearHistory` wipes the ring.
    AgentMessage {
        record: crate::agent::AgentMessageRecord,
    },
    /// Streaming text delta for an in-flight assistant turn. `id`
    /// matches the eventual `AgentMessage.record.id` so the UI can
    /// stitch chunks into the live row. The final `AgentMessage`
    /// arrives once the LLM stream closes.
    AgentToken {
        message_id: u64,
        delta: String,
    },
    /// A tool call's status / preview changed. The matching
    /// `AgentMessageRecord` carries the tool name + args; this event
    /// is just the lifecycle update (`pending` → `awaiting_confirm`
    /// / `running` / `done` / `error`).
    AgentToolUpdate {
        message_id: u64,
        call_id: String,
        status: crate::agent::AgentToolStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preview: Option<String>,
        /// For `Done` / `Error` — the structured result blob (JSON
        /// string, may be empty). For other states, empty.
        #[serde(default, skip_serializing_if = "String::is_empty")]
        result_json: String,
    },
    /// Reply to `Command::AgentHistoryRequest` — full in-memory
    /// transcript in insertion order.
    AgentHistory {
        records: Vec<crate::agent::AgentMessageRecord>,
    },
    /// Snapshot of the live agent config + state. Broadcast on
    /// connect, on every mutation, and whenever the busy flag flips.
    AgentState {
        config: crate::agent::AgentConfigPublic,
        /// `true` while the harness is mid-turn (streaming, tool
        /// dispatch, or waiting on tool confirm). UI uses this to
        /// gate Send and show a busy spinner.
        busy: bool,
        /// Number of records currently in the transcript ring.
        transcript_len: u32,
    },
    /// Reply to `Command::AgentListSkills` — current state of the
    /// `$XDG_DATA_HOME/foyer/agent/skills/` directory.
    AgentSkillsListed {
        skills: Vec<crate::agent::AgentSkillInfo>,
    },
    /// Reply to `Command::AgentListMemories` — current state of the
    /// `$XDG_DATA_HOME/foyer/agent/memory/` directory.
    AgentMemoriesListed {
        memories: Vec<crate::agent::AgentMemoryInfo>,
    },
    /// Reply to `Command::AgentListTemplates` — current state of the
    /// `$XDG_DATA_HOME/foyer/agent/templates/` directory.
    AgentTemplatesListed {
        templates: Vec<crate::agent::AgentTemplateInfo>,
    },
    /// Server asks an attached browser to render one of the
    /// `visualize` tool's subcommands into a PNG and reply via
    /// `Command::AgentRenderResult`. The first peer to respond wins;
    /// other peers ignore the request. `request_json` is the same
    /// shape the `visualize` tool was called with — see
    /// `foyer_agent::tools::visualize`.
    AgentRenderRequest {
        request_id: String,
        request_json: String,
    },
    /// Reply to `Command::AgentSessionList` — current state of the
    /// `$XDG_DATA_HOME/foyer/agent/sessions/` directory. `active_id`
    /// is the session whose transcript is currently loaded into the
    /// runtime (and therefore visible in the FAB).
    AgentSessionsListed {
        sessions: Vec<crate::agent::AgentSessionInfo>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_id: Option<String>,
    },
    /// A session was switched (load / new / delete-active). The
    /// transcript ring on every client should drop and reload — the
    /// server follows up with an `AgentHistory` event carrying the
    /// new transcript.
    AgentSessionActivated {
        id: String,
        title: String,
    },

    // ───── DAW scripting (shim-declared, host-agnostic) ─────
    /// Full current list of persisted scripts. Sent on connect and
    /// after any structural change so a freshly attached client gets
    /// the whole set without having to diff.
    ScriptList {
        scripts: Vec<crate::scripting::Script>,
    },
    /// A script was added or modified. `script` carries the post-
    /// mutation state (id stamped if the save was a create).
    ScriptSaved {
        script: crate::scripting::Script,
    },
    /// A script was deleted.
    ScriptRemoved {
        id: EntityId,
    },
    /// Result of a manual `RunScript` invocation.
    ScriptRunResult {
        result: crate::scripting::ScriptRunResult,
    },
    /// Backend scripting capabilities changed (typically on backend
    /// swap — different shim advertises a different surface). The
    /// authoritative copy still lives on the session snapshot; this
    /// event lets already-connected clients refresh without forcing a
    /// full resync.
    ScriptingCapabilitiesChanged {
        capabilities: Option<crate::scripting::ScriptingCapabilities>,
    },

    /// Server → attached browser: dispatch a UI directive (open a
    /// window, focus a leaf, swap the tile tree, …). The first FE to
    /// reply with `Command::UiActionResult` wins; other peers ignore.
    /// Mirrors the AgentRenderRequest correlation shape — `request_id`
    /// uniquely correlates the reply to the awaiting oneshot.
    UiAction {
        request_id: String,
        /// JSON-encoded `UiAction` so the schema stays additive: a
        /// newer shim/agent can ship an action shape the FE on the
        /// other end of the wire doesn't understand yet, and the FE
        /// can reply with an error rather than rejecting the whole
        /// envelope at the decoder.
        action_json: String,
    },

    // ─── render / mixdown lifecycle ────────────────────────────────
    /// Backend accepted a `Command::RenderSession` and started
    /// encoding. Lets the UI flip its modal into a progress state
    /// before the first `RenderProgress` lands.
    RenderStarted {
        handle: String,
    },
    /// Mid-render progress tick. `percent` is 0..=100. Emitted at
    /// most a few times per second so a UI bar feels live without
    /// flooding the wire.
    RenderProgress {
        handle: String,
        percent: u8,
        /// Optional ETA in seconds. `None` when the backend hasn't
        /// computed one (very early in the run, or backends that
        /// don't surface an estimate).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        eta_seconds: Option<u32>,
    },
    /// Render finished cleanly. `outputs` holds one entry for a
    /// master-bus render or one entry per track for a stem render.
    /// When `RenderOptions::inline_bytes` was set, each output
    /// carries the encoded bytes inline; otherwise only paths are
    /// returned and the caller fetches via the file endpoint.
    RenderComplete {
        handle: String,
        outputs: Vec<crate::render::RenderOutput>,
    },
    /// Render failed. The `handle` lets the FE / agent match the
    /// failure to the original request so a parallel render's
    /// errors don't bleed into the wrong UI / tool result.
    RenderError {
        handle: String,
        message: String,
    },

    /// Snapshot of every known foreign-content asset pack the
    /// server can fetch. Emitted at greeting time and on
    /// `Command::ListAssetPacks`. Each entry's `state` reflects
    /// whatever is currently on disk; the client uses it to decide
    /// whether to show a consent prompt + Download button or just
    /// proceed with locally-cached assets.
    AssetPackList {
        packs: Vec<crate::asset_pack::AssetPackInfo>,
    },

    /// Single-pack state transition. Streamed during downloads
    /// (Downloading → Extracting → Ready / Failed). The browser
    /// can splice this into the cached `AssetPackList` view
    /// without re-fetching the full list.
    AssetPackUpdated {
        info: crate::asset_pack::AssetPackInfo,
    },
}

impl Event {
    /// Build an `Event::Error` from a structured [`LocalizedString`].
    /// Renders the English source as the legacy `message` field so
    /// pre-i18n clients still see something readable, AND stashes the
    /// structured form so new clients can translate at receive time.
    /// Most callers should reach for this instead of building the
    /// struct literal by hand.
    pub fn error_localized(
        code: impl Into<String>,
        loc: crate::LocalizedString,
        target_peer_id: Option<String>,
    ) -> Self {
        Event::Error {
            code: code.into(),
            message: loc.render_english(),
            target_peer_id,
            localized: Some(loc),
        }
    }
}

/// One chat message as stored in the server's in-memory ring.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessageRecord {
    /// Monotonically-assigned id (per-server). Lets clients dedupe and
    /// sort cheaply without relying on envelope `seq` (which may
    /// contain non-chat envelopes between messages).
    pub id: u64,
    /// Connection id of the sender — matches `PeerInfo.id`.
    pub from_peer_id: String,
    /// Display name (e.g. "host", invite email, or explicit label).
    pub from_label: String,
    /// Message body (markdown allowed; client renders).
    pub body: String,
    /// Unix epoch milliseconds of server-side receipt.
    pub ts_ms: u64,
}

/// Who currently holds the PTT key. Kept small because this is
/// broadcast on every hold/release.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PttSpeaker {
    pub peer_id: String,
    pub label: String,
    /// Unix epoch milliseconds when the speaker started holding.
    pub since_ms: u64,
}

/// One row of the track → browser-source assignment map.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrackBrowserSourceEntry {
    pub track_id: EntityId,
    pub peer_id: String,
}

fn is_zero_u16(n: &u16) -> bool {
    *n == 0
}
fn is_false(b: &bool) -> bool {
    !*b
}
fn yes_bool() -> bool {
    true
}

fn default_region_kind() -> String {
    "midi".to_string()
}

fn default_stretch_anchor() -> String {
    "start".to_string()
}

fn default_stretch_preserve_pitch() -> bool {
    true
}

fn default_strip_threshold_db() -> f32 {
    -48.0
}

fn default_strip_minimum_length_samples() -> u64 {
    2048
}

fn default_strip_fade_length_samples() -> u64 {
    64
}

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
    /// HTTP URL of the upstream DAW's MCP endpoint for this specific
    /// session, when one is available. Populated by the launcher when
    /// it pins a per-session port (Ardour 9.4+ `mcp_http` surface);
    /// `None` means either the DAW build doesn't ship an MCP surface
    /// (Ardour 9.2 and older), the spawner didn't try (stub backends,
    /// reattach to an orphan shim), or the post-spawn probe didn't
    /// answer. Read by the `daw_proxy` agent tool to enumerate the
    /// MCP-capable sessions and route per-session calls.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_endpoint: Option<String>,
}

/// One entry in the server-tracked "recently opened projects" list.
/// Persisted to disk so the list survives sidecar restarts and is
/// shared across browser profiles. The previous design kept this in
/// each browser's localStorage, which left stale entries pointing at
/// projects that didn't exist on whichever container was currently
/// hosting the sidecar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecentEntry {
    /// Jail-relative path stored on the wire (matches the form clients
    /// send to LaunchProject). Used as the unique key for touch /
    /// forget operations.
    pub path: String,
    /// Display name, defaults to the project file's basename.
    #[serde(default)]
    pub name: String,
    /// Backend adapter id ("ardour" / "stub"). Echoed back in the
    /// touch path so the next launch goes to the right adapter.
    #[serde(default)]
    pub backend_id: String,
    /// Unix epoch seconds the user last opened this project.
    #[serde(default)]
    pub opened_at: u64,
}

/// One Ardour crash-recovery artifact found next to a project file
/// (`.history` = autosaved undo state, `.pending` = uncommitted dirty
/// delta written between autosaves). The browser uses these entries
/// to render the "Recover or Ignore" prompt before launching.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionRecoveryArtifact {
    /// Filename relative to the project directory (e.g.
    /// `Sessionname.history`). Display-only — the server resolves
    /// the actual path itself when archiving.
    pub name: String,
    /// `"history"` or `"pending"`. The UI shows them differently
    /// because `.pending` data is more "actually unsaved work" while
    /// `.history` is the autosave-time snapshot.
    pub kind: String,
    pub size_bytes: u64,
    /// Last-modified time in Unix epoch milliseconds. Drives the
    /// "modified Xm ago" hint in the prompt so users can tell when
    /// the crash actually happened.
    pub mtime_unix_ms: u64,
    /// `true` when the file on disk is a `.bak.<stamp>` archive
    /// from a previous foyer sweep (no live file present). The
    /// browser still surfaces the recovery prompt but adapts the
    /// copy to "an earlier foyer run archived these — restore?".
    /// On Recover, the server renames the highest-stamped bak
    /// back to the live name before launching.
    #[serde(default)]
    pub archived: bool,
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
    /// Unix epoch seconds when the shim first wrote the registry
    /// entry. Used by the UI to group duplicate entries for the
    /// same project (e.g. multiple crashes before the user
    /// dismissed) and show "N attempts" metadata.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub started_at: u64,
    /// `true` when the project directory still has crash-recovery
    /// artifacts on disk (live `.history` / `.pending`, or legacy
    /// `.bak.<stamp>` clutter from earlier foyer sweeps). Drives
    /// the welcome-screen tag: rows with `has_recovery_data=true`
    /// keep the alarming "Crashed" label because there's
    /// genuinely something to recover; rows where this is `false`
    /// are stale registry leftovers from an earlier interruption
    /// whose data has already been archived, and get the softer
    /// "Was interrupted" label.
    #[serde(default)]
    pub has_recovery_data: bool,
}

fn is_zero_u64(n: &u64) -> bool {
    *n == 0
}

/// Role of a single WS connection relative to its logical peer.
///
/// One logical peer (one `peer_id`) can hold multiple WS connections —
/// one per browser window — for multi-monitor / multi-window use. The
/// first connection is `Primary`; subsequent connections opened with
/// `?parent=<peer_id>` against an existing peer are `Secondary`.
///
/// Audio ingress / egress (the `/ws/audio/*` and `/ws/ingress/*`
/// endpoints) is only valid on `Primary` connections. Secondaries are
/// control-plane only — they read state, dispatch commands, render UI,
/// but never own a microphone or speaker stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionRole {
    /// Spawning window. Owns audio I/O for the logical peer.
    #[default]
    Primary,
    /// Secondary window. Control-plane only; audio is rejected.
    Secondary,
}

/// One connected client. Tracked server-side and broadcast via
/// `PeerJoined` / `PeerLeft` / `PeerList` so every client sees a
/// consistent roster. `label` is the display string — `"host"` for
/// LAN connections (the studio owner), or the invite recipient's
/// email for tunnel guests.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PeerInfo {
    /// Server-assigned connection id (hex UUID). Stable for the
    /// lifetime of the WS connection, distinct from any session id.
    pub id: String,
    /// Human-facing label — "host" for local/LAN, email for tunnel.
    pub label: String,
    /// Remote peer address (`127.0.0.1:54123` etc.).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub remote_addr: String,
    /// True for loopback / LAN. Drives the "host" styling in the UI.
    pub is_local: bool,
    /// True when this peer connected via the public tunnel.
    pub is_tunnel: bool,
    /// RBAC role id, when the peer authenticated via tunnel. `None`
    /// for LAN (trusted, no role).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_id: Option<String>,
    /// Unix epoch ms when the FIRST connection of this logical peer
    /// came up. Stays stable when additional windows attach.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub connected_at: u64,
    /// Number of active WS connections (windows) this logical peer is
    /// holding open. `1` for a single-window peer; `>=2` once the user
    /// has popped out a second window. Defaults to `1` for older
    /// clients / wire compat.
    #[serde(default = "one_u32", skip_serializing_if = "is_one_u32")]
    pub connection_count: u32,
}

fn one_u32() -> u32 {
    1
}

fn is_one_u32(n: &u32) -> bool {
    *n == 1
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
    /// Probe the client↔server clock offset (NTP-style single bounce).
    /// `client_ts_ms` is the client's `performance.now()` (or any
    /// monotonic milliseconds clock) at send time. The server replies
    /// immediately with `Event::ClockProbeReply { client_ts_ms,
    /// server_mono_ns }` — `client_ts_ms` echoed verbatim so the
    /// requester can compute RTT, `server_mono_ns` sampled at handle
    /// time. Used by the browser to align audio-frame timecodes
    /// (which carry `server_mono_ns` in their header) with its own
    /// playback clock so the displayed transport position trails
    /// the audio stream rather than racing ahead of it. Cheap;
    /// expected to fire ~5 times on connect to seed the offset and
    /// then once every few minutes to track drift.
    ClockProbe {
        client_ts_ms: f64,
    },
    /// Ask the sidecar whether `project_path` has Ardour crash-
    /// recovery artifacts (`.history` / `.pending` files) that
    /// would block a clean launch. The server replies with
    /// `Event::SessionRecoveryAvailable`. Browser fires this
    /// before every `LaunchProject` so the user can choose to
    /// recover or discard the crash state instead of having
    /// Ardour pop its native (and headless-deploy-fatal) modal.
    ProbeSessionRecovery {
        project_path: String,
    },
    /// Periodic feedback from the browser's audio listener about
    /// the worklet jitter buffer's fill level on a given egress
    /// stream. The sidecar's egress encoder runs a slow PI loop
    /// against this signal and adjusts its resampler ratio (via
    /// `foyer_audio::InterleavedResampler::nudge_ratio_relative`)
    /// to absorb crystal skew between the engine's audio clock and
    /// the browser's `AudioContext` clock. Without this, a long-
    /// running session accumulates seconds of drift between the
    /// audio stream and the DAW state — visible as the playhead
    /// progressively falling behind.
    ///
    /// `buffered_samples` is the worklet ring's `available` count
    /// at observation time; `target_samples` is the priming-target
    /// the worklet aims for. The error `(buffered - target)`
    /// drives the controller: positive → buffer is filling →
    /// encoder is producing faster than client consumes → nudge
    /// resample ratio DOWN; negative → encoder lagging → nudge UP.
    /// Fired at 1 Hz once the audio stream is steady-state.
    AudioBufferReport {
        stream_id: u32,
        buffered_samples: u32,
        target_samples: u32,
    },
    /// Browser → server: "what is the current median one-way latency
    /// for my ingress stream?"  Used by transport-stop delay so the
    /// UI can delay the stop by exactly the buffer depth.  Replied
    /// with `Event::IngressLatencyReport`.
    RequestIngressLatency {
        stream_id: u32,
    },
    /// Browser → server → shim: declare the total capture-side
    /// latency for an ingress stream, in samples at the engine
    /// sample rate. The shim sets this on the underlying engine
    /// input port via `Port::set_private_latency_range`, then
    /// triggers `Session::update_latency_compensation` so Ardour
    /// shifts subsequent recordings earlier by this many samples.
    /// Without this the take lands late by browser-capture + WS +
    /// shim hop — visible as recorded waveforms sitting to the
    /// RIGHT of where the user was actually performing relative to
    /// the playback they heard.
    ///
    /// Idempotent / cheap; the browser may resend at any time as
    /// its measurements stabilise. Setting `samples = 0` clears
    /// any prior compensation for this stream.
    SetIngressCaptureLatency {
        stream_id: u32,
        samples: u32,
    },
    /// Browser → server → shim: tune the depth of the per-stream
    /// jitter ring inside `ShimInputPort`. Larger values absorb
    /// more WS / GC jitter at the cost of more capture latency
    /// (the latency is auto-compensated for recordings via the
    /// port latency API, but it still adds to the user's foreground
    /// monitoring delay). Default is 80 ms — appropriate for a
    /// remote tunnel; users on loopback or LAN typically drop to
    /// 20–30 ms. Session-wide: the cached value applies to every
    /// subsequent `AudioIngressOpen`. Backends without an ingress
    /// ring (stub) ignore.
    SetIngressRingPrimeMs {
        ms: u32,
    },
    /// Server → shim: declare the capture-side latency for a per-
    /// track MIDI ingress port, in samples at the engine sample
    /// rate. Mirrors `SetIngressCaptureLatency` but for the virtual
    /// MIDI input port the shim creates lazily on first
    /// `MidiInput { track_id }` for `track_id`. The shim adds its
    /// own internal contribution (engine cycle) on top before
    /// writing `Port::set_private_latency_range`; Ardour's
    /// `MidiDiskWriter` honours the resulting `_capture_offset` via
    /// `_accumulated_capture_offset` so recorded MIDI events land
    /// at the engine frame the user was hearing when they played.
    /// `samples = 0` clears any prior compensation for the track.
    SetMidiCaptureLatency {
        track_id: EntityId,
        samples: u32,
    },
    /// Test-only: inject artificial latency on the audio ingress
    /// and/or egress paths so the empirical capture-offset logic can
    /// be exercised against known asymmetric latency without
    /// physically routing through a tunnel. `0` clears that side's
    /// injection. The server stores the values in atomics that the
    /// per-stream tasks consult on every packet — toggling takes
    /// effect on the next packet without reconnecting. Bench knob;
    /// not surfaced in user-facing UI flows.
    SetFakeLatency {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        ingress_ms: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        egress_ms: Option<u32>,
    },
    /// User-tuned manual offset added on top of the empirical
    /// ingress capture-latency measurement, in milliseconds. Signed
    /// — positive shifts recordings earlier on the timeline (i.e.
    /// adds to `_capture_offset`), negative shifts later. Used to
    /// dial in any residual the echo-roundtrip math can't see (the
    /// mic-to-browser-stack hop, browser-specific output-latency
    /// under-reporting, etc.). Persisted in browser audio prefs;
    /// the server holds it in an atomic and adds it to the median
    /// before pushing `SetIngressCaptureLatency` to the shim.
    SetIngressManualOffsetMs {
        ms: i32,
    },
    /// Start a speaker→mic loopback calibration run on `stream_id`
    /// (must be an OPEN egress stream that the browser is also
    /// piping to its speakers, AND there must be an active ingress
    /// stream picking up the resulting audio). Server emits a short
    /// click pattern every 500 ms for the duration of the run,
    /// stamps each emit time, and watches the matching ingress
    /// stream for the click reflection. Progress events fire per
    /// detected click; when the run finishes the server emits a
    /// `CalibrationResult` with the median round-trip and a
    /// suggested manual offset (= measured − empirical-median).
    StartIngressCalibration {
        /// Egress stream that will carry the calibration clicks.
        egress_stream_id: u32,
        /// Ingress stream the mic is being piped through.
        ingress_stream_id: u32,
        /// Number of clicks to emit before finalising. 5 is a sane
        /// default; raising trades a longer calibration for tighter
        /// medians.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        clicks: Option<u32>,
    },
    /// Abort a calibration run early (user clicked Cancel, the
    /// browser closed the stream, etc.). Idempotent; safe to send
    /// when no calibration is active.
    StopIngressCalibration {
        egress_stream_id: u32,
    },
    /// Open a named undo group. Subsequent mutations (region delete,
    /// plugin move, etc.) land in the same `UndoTransaction` until a
    /// matching `UndoGroupEnd` is received. One undo step unwinds
    /// the whole batch. Without grouping each command would be its
    /// own undo step — users hitting Delete on 5 selected regions
    /// would need 5 Ctrl+Z presses to restore the full selection.
    /// `name` becomes the undo-history label. See PLAN 177.
    UndoGroupBegin {
        name: String,
    },
    /// Close the currently-open undo group. No-op if none is open.
    UndoGroupEnd,
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
    /// Open a spectrogram subscription on the named target. The shim
    /// starts a per-subscription analyser ring + FFT pipeline and
    /// emits `Event::SpectrumFrame` at the configured hop rate. The
    /// FE multiplexes by `target`; multiple subscriptions on the
    /// same connection don't interfere.
    SubscribeSpectrum {
        target: SpectrumTarget,
        #[serde(default)]
        opts: SpectrumOpts,
    },
    /// Tear down a spectrum subscription. The shim emits
    /// `Event::SpectrumUnsubscribed` once the pipeline is drained.
    UnsubscribeSpectrum {
        target: SpectrumTarget,
    },
    /// Open an ingress sink (subscriber → DAW) bound to a host input.
    ///
    /// `format.sample_rate` is the **client capture rate** (e.g. browser
    /// `AudioContext.sampleRate`). The sidecar translates to the session /
    /// engine rate before forwarding to the shim.
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
    /// Ask the shim for all audio file sources in the session pool.
    /// Answered with `Event::AudioPoolListed`. Stub returns an empty list.
    ListAudioPool,
    /// Import/register an on-disk audio file into the pool via Ardour's
    /// `SourceFactory::createExternal`. `path` must be an absolute filesystem
    /// path readable by the host.
    ImportAudio {
        path: String,
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

    /// Mix down the session to an audio file. `handle` is a
    /// client-chosen id (uuid string) that the server echoes back on
    /// every `RenderProgress` / `RenderComplete` / `RenderError`
    /// emission so concurrent renders ride the same broadcast bus
    /// without a separate subscribe channel. `opts` picks the
    /// encoder + range + target + bit depth.
    RenderSession {
        handle: String,
        opts: crate::render::RenderOptions,
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
    /// Create a brand-new region on `track_id` starting at
    /// `at_samples`. `length_samples` defaults to one bar at the
    /// session's current tempo if omitted. `kind` selects the
    /// region's media type. MIDI: empty note list, ready to edit.
    /// AUDIO: requires `source_path` pointing at a pool entry (the
    /// audio-pool drag-drop path uses this; the backend resolves the
    /// path to the matching source and creates a region referencing
    /// it). Emits `RegionsList` for the track on success.
    CreateRegion {
        track_id: EntityId,
        at_samples: u64,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        length_samples: Option<u64>,
        #[serde(default = "default_region_kind")]
        kind: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        name: Option<String>,
        /// Audio regions only: path to the source file in the
        /// session's pool. Required when `kind == "audio"`.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        source_path: Option<String>,
    },
    /// Clone `source_region_id` into a new region starting at
    /// `at_samples`. If `target_track_id` is set the clone lands on
    /// that track instead of the source's own — used by cross-track
    /// paste; backend MUST reject when the destination's kind is
    /// incompatible with the source (audio↔midi). If
    /// `length_samples` is `None` the clone adopts the source's
    /// length. Carries over MIDI notes AND extra_xml (so Foyer
    /// sequencer layouts duplicate too). Emits a `RegionsList` echo
    /// for the destination track on success.
    DuplicateRegion {
        source_region_id: EntityId,
        at_samples: u64,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        length_samples: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        target_track_id: Option<EntityId>,
    },
    /// Clone a SLICE of `source_region_id` — the contiguous range
    /// `[source_offset_samples, source_offset_samples + length_samples)`
    /// inside the source's content — into a new region on the same
    /// track, starting at `at_samples`. Used for the "select a time
    /// range, cut/copy from regions" DAW workflow where each captured
    /// region contributes only the bits that overlap the selection.
    /// MIDI notes inside the slice are carried; notes outside are
    /// dropped. Emits a `RegionsList` echo for the track on success.
    DuplicateRegionRange {
        source_region_id: EntityId,
        /// Offset INTO the source region (not into the source media).
        /// `0` means "start at the source's left edge" — same as
        /// `DuplicateRegion`. Bounded to the source's length on the
        /// backend; values past the end produce a zero-length region.
        source_offset_samples: u64,
        /// Length of the slice. Clamped to the source's remaining
        /// length from `source_offset_samples`. Must be > 0.
        length_samples: u64,
        /// Destination position on the timeline in samples.
        at_samples: u64,
        /// Destination track. `None` = same track as the source
        /// (back-compat). When set, backend MUST reject incompatible
        /// kinds (audio↔midi).
        #[serde(skip_serializing_if = "Option::is_none", default)]
        target_track_id: Option<EntityId>,
    },
    /// Time-stretch or squash region contents so they fill a new timeline
    /// span. `anchor` is `"start"` when the left edge stays fixed (typical
    /// right-edge drag) or `"end"` when the right edge stays fixed (left-edge
    /// drag). The Ardour shim applies MIDI via `MidiStretch` and audio via
    /// `RBStretch` (Rubber Band), then `replace_region` so the session owns the
    /// new source. Emits `RegionUpdated` / playlist echoes like other region
    /// mutations.
    ///
    /// For **audio**, `preserve_pitch` selects Rubber Band behavior: `true`
    /// keeps perceived pitch (editor "Time Stretch" default); `false` uses
    /// inverse pitch scale like Ardour's "resample / no pitch preserve" preset
    /// (varispeed / tape-style: longer → lower pitch). MIDI ignores this field.
    StretchRegion {
        id: EntityId,
        new_start_samples: i64,
        new_length_samples: u64,
        #[serde(default = "default_stretch_anchor")]
        anchor: String,
        #[serde(default = "default_stretch_preserve_pitch")]
        preserve_pitch: bool,
    },
    /// Split one region into two at an absolute timeline position (`at_samples`
    /// in session samples). The cut must fall strictly inside the region.
    /// Emits a fresh `RegionsList` for the track (stub + Ardour).
    SplitRegion {
        id: EntityId,
        at_samples: i64,
    },
    /// Reverse audio in time (`ARDOUR::Reverse`). MIDI regions are rejected.
    ReverseRegion {
        id: EntityId,
    },
    /// Combine regions on one track into one compound region (`Playlist::combine` in Ardour).
    CombineRegions {
        region_ids: Vec<EntityId>,
    },
    /// Run silence detection (`AudioRegion::find_silence`) then `StripSilence` (splits region).
    StripSilenceRegion {
        id: EntityId,
        #[serde(default = "default_strip_threshold_db")]
        threshold_db: f32,
        #[serde(default = "default_strip_minimum_length_samples")]
        minimum_length_samples: u64,
        #[serde(default = "default_strip_fade_length_samples")]
        fade_length_samples: u64,
    },
    /// Pitch-shift audio via Rubber Band (`RBStretch`); MIDI via per-note transpose.
    PitchShiftRegion {
        id: EntityId,
        semitones: f32,
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
        /// Optional engine sample rate for **new** sessions: applied when
        /// creating the `.ardour` file (stub backends use it directly;
        /// Ardour patches the session XML only when the session did not
        /// exist before launch).
        #[serde(skip_serializing_if = "Option::is_none", default)]
        sample_rate: Option<u32>,
        /// Disposition for `.pending` crash-recovery state when the
        /// browser detected it via `Event::SessionRecoveryAvailable`:
        ///   - `Some(true)`  → user picked Recover. Server leaves
        ///     `.pending` on disk and sets `FOYER_CRASH_RECOVERY=recover`
        ///     on the Ardour spawn so the shim auto-clicks the native
        ///     dialog's "Recover" button (the dialog still flashes
        ///     briefly inside Ardour but is dismissed before the user
        ///     can see it).
        ///   - `Some(false)` → user picked Discard. Server deletes
        ///     `.pending` pre-launch so Ardour never opens the dialog.
        ///   - `None` → no crash artifacts; nothing to do.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        recover_crash: Option<bool>,
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
    /// Ask the shim to quit its host process. The Ardour shim raises
    /// `SIGTERM` on its own pid so Ardour's stock signal handler runs
    /// the normal save-and-exit path. Sent by the sidecar as the first
    /// rung of the close-session escalation (graceful → SIGTERM →
    /// SIGKILL); fire-and-forget. Stub backends ignore it.
    ShimQuit,
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

    // ───── recents (server-tracked recent projects) ─────────────────────
    /// Ask the sidecar for its current recents list. Answered with
    /// `Event::RecentsList`. Sent eagerly on initial WS attach; clients
    /// can re-fire after a network blip to resync.
    ListRecents,
    /// Drop a single entry from the recents list. Persisted to disk.
    /// Emits an updated `Event::RecentsList`.
    ForgetRecent {
        path: String,
    },
    /// Drop every recents entry. Emits an updated (empty)
    /// `Event::RecentsList`.
    ClearRecents,

    // ───── track / group / plugin lifecycle ─────────────────────────────
    /// Create a new track. `kind` selects audio / midi / bus (master
    /// and monitor are not user-creatable). `color` is an optional CSS
    /// hex; `after_id` places the new track immediately after the
    /// given existing track (omit to append at the end).
    ///
    /// The remaining fields wire up plugins on the new track in one
    /// atomic step (wrapped in the same undo group as the track
    /// creation). Resolution order (first non-empty wins):
    /// 1. `copy_from_track_id` — duplicate the named track's plugin
    ///    chain (URIs + current params + active presets) onto the new
    ///    track. Use for "another track like X".
    /// 2. `plugins` — explicit URIs to insert in order.
    /// 3. `instrument_uri` — single-plugin shorthand. For MIDI tracks
    ///    the agent typically asks the user which instrument; this
    ///    field is the answer.
    CreateTrack {
        name: String,
        kind: crate::TrackKind,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        color: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        after_id: Option<EntityId>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        instrument_uri: Option<String>,
        #[serde(skip_serializing_if = "Vec::is_empty", default)]
        plugins: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        copy_from_track_id: Option<EntityId>,
        /// GM program (0–127) to set on the track's MIDI patch after
        /// the instrument lands. Atomic with the create. Ignored on
        /// audio + bus tracks.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        gm_program: Option<u8>,
        /// MIDI channel for `gm_program`. Defaults to 0 (CH1); use 9
        /// (CH10) for GM drums on gmsynth.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        gm_channel: Option<u8>,
    },
    /// Mutate a track. Fields in `patch` that are `None` stay unchanged.
    /// Emits `Event::TrackUpdated` on success.
    UpdateTrack {
        id: EntityId,
        patch: TrackPatch,
    },
    /// Delete a track by id. Backends should remove all regions/plugins
    /// owned by the track and emit updated session state.
    DeleteTrack {
        id: EntityId,
    },
    /// Reorder tracks according to the provided id list.
    /// Any track id omitted should keep relative order at the tail.
    ReorderTracks {
        ordered_ids: Vec<EntityId>,
    },
    /// Set a MIDI track's channel-filter mode + mask. `direction` is
    /// `"capture"` (inbound recording) or `"playback"` (outbound to
    /// the instrument). `mode` is `"all"` | `"filter"` | `"force"`.
    /// `mask` is a 16-bit channel bitmask (bit 0 = ch 1); in `"force"`
    /// mode the lowest set bit is the target channel. New MIDI tracks
    /// default to `mode="force", mask=0x0001` so a viewing app's
    /// channel selector stays hidden unless the user has explicitly
    /// opted into a multi-channel setup.
    SetTrackMidiChannelMode {
        track_id: EntityId,
        direction: String,
        mode: String,
        mask: u16,
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
        /// If set, the new plugin instance is seeded with the parameter
        /// values + bypass state of this existing plugin. Used by the
        /// drag-to-duplicate UI gesture. Plugin must be the same URI;
        /// the host clones at the param level (no XML round-trip), so
        /// type mismatches silently no-op the copy and you get a fresh
        /// default plugin on the target track.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        clone_from: Option<EntityId>,
    },
    /// Insert whatever instrument the backend resolves as a "sensible
    /// default" on `track_id`. The backend picks from its installed
    /// plugin catalog — see [`crate::foyer_backend::Backend::default_instrument_uri`]
    /// for the resolution order. Used by the empty-MIDI-track banner
    /// in the UI: the user doesn't know or care which synth lands,
    /// they just want sound. The host echoes a normal `PluginsList`
    /// after the insert; if no instrument is resolvable, an
    /// `Event::NoInstrumentsAvailable` fires instead so the UI can
    /// nudge the user toward installing one.
    AddDefaultInstrument {
        track_id: EntityId,
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
    /// Ask the shim/host for Midnam-backed patch names for a MIDI track.
    /// Answered with `Event::MidiPatchNamesListed`.
    ListMidiPatchNames {
        track_id: EntityId,
        /// MIDI channel 0..15.
        channel: u8,
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
    /// Set the live patch on a MIDI track/channel. This mirrors
    /// Ardour's patch selector: MIDI tracks update bank/program
    /// automation controls, while instrument inserts receive immediate
    /// MIDI bank/program events.
    SetTrackMidiPatch {
        track_id: EntityId,
        channel: u8,
        bank: i32,
        program: u8,
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

    /// Live MIDI bytes fed from a browser-attached Web MIDI device into
    /// the shim. With `track_id` unset the shim writes them onto the
    /// shared `Foyer Web MIDI` virtual source port (any track whose
    /// JACK input is connected to it picks them up). With `track_id`
    /// set the shim routes the bytes directly into THAT track's MIDI
    /// input — same model as the audio ingress path, where a track
    /// armed by its source-user receives the browser stream without
    /// the user having to wire JACK up by hand.
    ///
    /// `data` is the wire bytes EXACTLY as they should appear on the
    /// port (status byte's low nibble already encodes the destination
    /// channel — per-device channel-remap is applied client-side
    /// before send so the schema does not have to round-trip a
    /// channel-preference field). 1–3 bytes for channel voice
    /// messages; longer for SysEx (which the server may reject for
    /// safety in a future RBAC pass — TODO: cap at 3 bytes for now
    /// when wiring through). Fire-and-forget; no echo event.
    MidiInput {
        data: Vec<u8>,
        /// Target a specific MIDI track for direct injection. The
        /// server will only honour this when the sending peer matches
        /// the track's `track_browser_source` assignment, mirroring
        /// the audio ingress access rule.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        track_id: Option<EntityId>,
        /// Source-clock timestamp (server `monotonic_nanos`) of the
        /// audio coming out of the user's speakers when this MIDI
        /// event was produced. Mirrors the audio ingress echo: the
        /// browser stamps from `audio-clock.currentSpeakerSentinelNs`;
        /// the server subtracts it from its own `monotonic_nanos` on
        /// receipt to measure the full round-trip latency, then drives
        /// the matching MIDI ingress port's `_capture_offset`. `None`
        /// means "no playback sentinel seen yet" — pre-record-arm
        /// virtual-keyboard taps fall into this case.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        echo_server_mono_ns: Option<i64>,
    },

    /// Route a track's audio input to a named port. `port_name = None`
    /// restores default auto-connect. Shim calls `IO::disconnect()` then
    /// `IO::connect(port, port_name)` on the track's input.
    SetTrackInput {
        track_id: EntityId,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        port_name: Option<String>,
    },

    /// Enumerate the engine-level audio/MIDI ports the shim can see.
    /// Clients use the result to populate routing dropdowns (track
    /// input, bus assign, etc). `direction` filters: `Some("source")`
    /// returns readable ports (hardware mic ins, `foyer:ingress-*`,
    /// other apps' outputs); `Some("sink")` returns writable ports
    /// (hardware outs, other apps' inputs); `None` returns everything.
    /// Answered with [`Event::PortsListed`].
    ListPorts {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        direction: Option<String>,
    },

    /// Attach an internal aux send from `track_id` to `target_track_id`
    /// (a bus). `pre_fader` places the send before the track's fader
    /// processor. The shim calls `Route::add_aux_send` and echoes a
    /// [`Event::TrackUpdated`] so clients see the new `sends` entry.
    AddSend {
        track_id: EntityId,
        target_track_id: EntityId,
        #[serde(default)]
        pre_fader: bool,
    },
    /// Remove a previously-added aux send.
    RemoveSend {
        send_id: EntityId,
    },
    /// Set the gain of an aux send. `level` is linear (0.0 .. ~2.0).
    SetSendLevel {
        send_id: EntityId,
        level: f64,
    },

    // ───── session undo / redo ──────────────────────────────────────────
    /// Pop one step off the session's undo stack. In Ardour this is
    /// `Session::undo(1)`; other hosts should behave equivalently
    /// (reverse the most recent reversible command).
    Undo,
    /// Re-apply the most recently undone step.
    Redo,

    // ───── automation (Phase B) ─────────────────────────────────────────
    SetAutomationMode {
        lane_id: EntityId,
        mode: crate::value::AutomationMode,
    },
    AddAutomationPoint {
        lane_id: EntityId,
        point: crate::value::AutomationPoint,
    },
    UpdateAutomationPoint {
        lane_id: EntityId,
        original_time_samples: u64,
        new_time_samples: u64,
        value: f64,
    },
    DeleteAutomationPoint {
        lane_id: EntityId,
        time_samples: u64,
    },
    ReplaceAutomationLane {
        lane_id: EntityId,
        points: Vec<crate::value::AutomationPoint>,
    },

    // ───── transport ────────────────────────────────────────────────────
    /// Move the playhead to the given sample position. Distinct from
    /// setting `transport.position` via `ControlSet` because it carries
    /// "stop and seek" semantics on hosts that distinguish.
    Locate {
        samples: u64,
    },
    /// Set loop start/end from a timeline selection and optionally
    /// enable looping in one command.
    SetLoopRange {
        start_samples: u64,
        end_samples: u64,
        #[serde(default)]
        enabled: bool,
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

    // ───── tunnel / remote access ───────────────────────────────────────
    /// Create a new shareable token for remote access.  The server
    /// replies with the token (shown once) and a `TunnelState` event.
    TunnelCreateToken {
        recipient: String,
        role: crate::tunnel::TunnelRole,
    },
    /// Revoke a previously-created token.
    TunnelRevokeToken {
        id: EntityId,
    },
    /// Toggle the global tunnel enable flag.
    TunnelSetEnabled {
        enabled: bool,
    },
    /// Start or restart the active tunnel provider (e.g. cloudflared).
    TunnelStart {
        provider: crate::tunnel::TunnelProviderKind,
    },
    /// Stop the active tunnel (local-only mode).
    TunnelStop,
    /// Ask the server for a `TunnelState` snapshot.
    TunnelRequestState,

    // ───── in-app chat / PTT (relay only — not audio-engine bound) ──────
    /// Post a chat message. The server stamps it with the sender's
    /// peer id + label (from the connection's handshake) and fans out
    /// `Event::ChatMessage` to every connected peer.
    ChatSend {
        /// Raw message body. Markdown + fenced code blocks render
        /// client-side; server never parses.
        body: String,
    },
    /// Clear the server's in-memory chat ring. Admins (and every LAN
    /// user — LAN is trusted) may invoke. Emits `Event::ChatCleared`.
    ChatClear,
    /// Ask for the current in-memory chat history. Replied to the
    /// sender with `Event::ChatHistory`. Sent on chat-FAB open.
    ChatHistoryRequest,
    /// Write the current in-memory chat to
    /// `$XDG_DATA_HOME/foyer/chat/<filename>.jsonl` (one record per
    /// line). The server ignores any path separators in `filename` —
    /// only the basename is kept so clients can't escape the chat
    /// dir. `None` picks a default `chat-<unix_ts>.jsonl`.
    ChatSnapshot {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        filename: Option<String>,
    },
    /// Begin holding the push-to-talk key. The server records the
    /// caller as the current speaker and broadcasts `PttState`.
    /// Rejected (with a targeted error) if someone else is already
    /// speaking — two simultaneous PTT presses scramble each other.
    PttStart,
    /// Release the PTT key. Server clears the speaker slot and
    /// broadcasts `PttState { speaker: None }`.
    PttStop,
    /// Set (or clear) the browser peer that sources audio for
    /// `track_id`. `peer_id` empty string clears the assignment.
    /// The named peer's browser is expected to respond by showing a
    /// mic toolbar affordance the user can click to start ingress.
    /// Server also patches the track's `monitoring` to `false` —
    /// live monitoring over a remote browser would be unbearable
    /// (100-300ms round trip minimum), so browser-sourced tracks
    /// are strictly for layering onto existing takes.
    SetTrackBrowserSource {
        track_id: EntityId,
        #[serde(default)]
        peer_id: String,
    },
    /// Ask the server for the current track → browser-source map.
    /// Answered with `Event::TrackBrowserSourcesSnapshot`. The
    /// initial greeting already includes it, so this is only used
    /// when a client wants a fresh snapshot mid-session.
    ListTrackBrowserSources,

    // ───── AI agent (foyer-agent harness) ────────────────────────
    /// Send a user-authored message to the agent. The harness
    /// records the turn, kicks off the LLM call, and streams
    /// `AgentToken` events as it responds.
    ///
    /// Optional `attachments` carry inline media (images, mostly) for
    /// vision-capable models. When non-empty the engine emits the
    /// outgoing user message as an OpenAI multi-modal `content` array
    /// (`{type: "text"}` + `{type: "image_url"}` blocks) instead of a
    /// plain string — providers that don't speak the multi-modal shape
    /// will ignore the image parts and see the text alone.
    AgentSend {
        body: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<crate::agent::AgentAttachment>,
    },
    /// Interrupt the in-flight assistant turn. Closes the LLM
    /// stream and finalizes the partial message at the current
    /// point. No-op when the harness is idle.
    AgentStop,
    /// Wipe the transcript ring. Broadcasts `AgentHistory { [] }`
    /// + a fresh `AgentState`.
    AgentClearHistory,
    /// Switch the per-session autonomy mode. Defaults to `Safe`
    /// at server boot; the user has to opt back into looser modes
    /// each session.
    AgentSetAutonomy {
        autonomy: crate::agent::AgentAutonomy,
    },
    /// Update the agent's LLM transport config. Any field set to
    /// `None` keeps the current value. `api_key` is write-only
    /// (never echoed back); pass an empty string to clear it.
    AgentSetConfig {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        endpoint: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        api_key: Option<String>,
        /// BCP-47 code of the UI's current locale (`en`, `es`, `ja`).
        /// The agent uses this to bias its replies toward the user's
        /// chosen language (system-prompt directive). `None` leaves
        /// the current value alone; an explicit `Some("")` clears it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ui_locale: Option<String>,
    },
    /// Approve or reject a tool call that's parked in
    /// `AwaitingConfirm`. Ignored when the call's status is
    /// anything else (idempotent — late-arriving confirms after
    /// the user already approved on another FAB are no-ops).
    AgentConfirmTool {
        call_id: String,
        approve: bool,
    },
    /// Ask the server for the full transcript ring. Replied to the
    /// sender with `Event::AgentHistory`. Sent on FAB open.
    AgentHistoryRequest,

    // Skill / memory / template management — filesystem-backed under
    // `$XDG_DATA_HOME/foyer/agent/`.
    AgentListSkills,
    /// Upload a new skill file (markdown body) to the agent's skills
    /// directory. Admin-only on tunneled connections; LAN trusted as
    /// elsewhere. `name` is sanitized server-side.
    AgentUploadSkill {
        name: String,
        body: String,
    },
    AgentEnableSkill {
        name: String,
    },
    AgentDisableSkill {
        name: String,
    },
    AgentListMemories,
    /// Append a new memory file. `name` is sanitized server-side to
    /// a safe filename stem.
    AgentSaveMemory {
        name: String,
        body: String,
    },
    AgentForgetMemory {
        name: String,
    },
    AgentListTemplates,
    /// Browser reply to `Event::AgentRenderRequest`. Exactly one of
    /// `png_b64` / `error` should be set; the server keys the
    /// resolution on `request_id`. Late or duplicate replies are
    /// dropped (the oneshot is consumed by the first one).
    AgentRenderResult {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        png_b64: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },

    // ─── Chat sessions ───────────────────────────────────────────
    /// Ask the server for the list of saved sessions. Replied with
    /// `Event::AgentSessionsListed`.
    AgentSessionList,
    /// Spin up a fresh empty session and activate it. Optional title
    /// is sanitized server-side; an empty title gets an auto-generated
    /// one like "Session 2026-05-15 14:32".
    AgentSessionNew {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    /// Load an existing session by id. Replaces the live transcript;
    /// next `AgentHistory` event carries the loaded turns.
    AgentSessionLoad {
        id: String,
    },
    /// Delete a session. Admin-gated on tunneled connections; LAN
    /// trusted. Deleting the active session rolls forward into the
    /// most recently updated remaining session, or a fresh empty one
    /// if no others exist.
    AgentSessionDelete {
        id: String,
    },
    /// Rename a session's display title. No-op if id doesn't exist.
    AgentSessionRename {
        id: String,
        title: String,
    },

    // ─── DAW scripting (shim-declared, host-agnostic) ────────────
    /// Request the current list of persisted scripts. Replied with
    /// `Event::ScriptList`. Optional — clients normally receive a
    /// list at connect-time from the session snapshot's follow-up,
    /// but a fresh `ScriptList` is the canonical resync path.
    ListScripts,
    /// Insert or update a script. Empty `id` means create — the
    /// backend allocates an id, stamps `updated_at`, and echoes
    /// `Event::ScriptSaved` with the canonical post-save shape. The
    /// shim is responsible for translating special types (e.g.
    /// `dsp` → a luaproc plugin source) at save time.
    SaveScript {
        script: crate::scripting::Script,
    },
    /// Delete a script by id. Idempotent; unknown ids are a no-op.
    DeleteScript {
        id: EntityId,
    },
    /// Flip the enabled flag without touching the body. Also used to
    /// confirm a `disabled_on_upload` script after the user has
    /// audited the source.
    EnableScript {
        id: EntityId,
        enabled: bool,
    },
    /// Manually invoke a script. Result returned in
    /// `Event::ScriptRunResult`. `args_override` lets a caller bind
    /// fresh args without modifying the persisted script's args
    /// table — handy for editor "Run with these inputs…" UIs.
    RunScript {
        id: EntityId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args_override: Option<std::collections::BTreeMap<String, String>>,
    },
    /// Scan the backing project file for scripts that were stripped
    /// to disabled state on upload (the base64 payload is still in
    /// the file). Returns recovered scripts via the normal
    /// `Event::ScriptList` / `ScriptSaved` channel with
    /// `disabled_on_upload` set so the UI can flag them for review.
    /// No-op when the backend's caps don't set
    /// `features.can_recover_disabled`.
    RecoverDisabledScripts,

    /// FE → server: reply to an `Event::UiAction` dispatch. `state_json`
    /// is a structured snapshot of the FE's current UI (open windows,
    /// tile tree, available window kinds) when the action included a
    /// query; otherwise empty. `ok` flags whether the FE applied the
    /// action successfully. `error` carries a human-readable message
    /// the agent can surface to the user when something failed.
    UiActionResult {
        request_id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        state_json: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },

    /// Test-only: wipe the backend's mutable test fixtures so the next
    /// list_regions / list_tracks / etc. returns the original seeded
    /// state. Implemented only by the in-memory stub; real DAW
    /// backends reject with an error event.
    ///
    /// Surfaced for the Playwright `_boot.js::bootTimeline` helper so
    /// each spec starts from the same baseline regardless of what the
    /// preceding spec mutated. The server gates dispatch by inspecting
    /// the active backend — if it isn't stub, the command is logged
    /// and dropped without touching real session state.
    #[serde(rename = "test_reset_state")]
    TestResetState,

    /// Ask the server to send a fresh `AssetPackList` summarizing
    /// every known foreign-content pack and its current local
    /// state. Useful as an explicit refresh after a network blip.
    ListAssetPacks,

    /// Request the server start downloading + extracting the named
    /// pack from its hardcoded source URL. Caller is responsible
    /// for showing the user a consent prompt with the pack's
    /// `credits` / `license_note` / `source_url` first — the server
    /// just trusts that this command means "the user agreed".
    /// Progress is streamed via `Event::AssetPackUpdated`. Idempotent
    /// when the pack is already `Ready` (returns the current state
    /// without re-downloading).
    FetchAssetPack {
        name: String,
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
        let env = Envelope::new(
            42,
            Some("user:alice".into()),
            None,
            Command::ControlSet {
                id: EntityId::new("transport.tempo"),
                value: ControlValue::Float(128.0),
            },
        );
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
            bus_assign: None,
            inputs: vec![],
            outputs: vec![],
            automation_lanes: vec![],
            capture_channel_mode: None,
            capture_channel_mask: None,
            playback_channel_mode: None,
            playback_channel_mask: None,
            midi_patches: vec![],
        };
        let patch = Patch::TrackAdded { track: Box::new(t) };
        let j = serde_json::to_string(&patch).unwrap();
        assert!(j.contains(r#""op":"track_added""#));
        let _: Patch = serde_json::from_str(&j).unwrap();

        let j2 = serde_json::to_string(&Patch::Reload).unwrap();
        assert_eq!(j2, r#"{"op":"reload"}"#);
    }
}
