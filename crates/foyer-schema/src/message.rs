//! Message envelope and event/command types shared across `foyer-ipc` and
//! `foyer-ws`.
//!
//! The envelope adds `seq`, `origin`, and a schema version tag so consumers can detect
//! drops (by seq gap), attribute changes (for presence/UI), and reject incompatible
//! senders.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    audio::{AudioTransport, IceCandidate, SdpPayload},
    midi::{MidiNote, MidiNotePatch},
    session::{Group, GroupPatch, Track, TrackPatch},
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
        /// This connection's own id. Matches the `PeerInfo.id` that
        /// goes out in `PeerJoined` / `PeerList`; the client filters
        /// its own entry out of the displayed roster using this.
        #[serde(default, skip_serializing_if = "String::is_empty")]
        peer_id: String,
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
        /// Opaque `base64url(email_norm:password)` — what clients put
        /// in the `?token=` query parameter.
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
    /// Unix epoch seconds when the shim first wrote the registry
    /// entry. Used by the UI to group duplicate entries for the
    /// same project (e.g. multiple crashes before the user
    /// dismissed) and show "N attempts" metadata.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub started_at: u64,
}

fn is_zero_u64(n: &u64) -> bool {
    *n == 0
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
    /// Unix epoch ms when the connection came up.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub connected_at: u64,
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
            bus_assign: None,
            inputs: vec![],
            outputs: vec![],
            automation_lanes: vec![],
        };
        let patch = Patch::TrackAdded { track: Box::new(t) };
        let j = serde_json::to_string(&patch).unwrap();
        assert!(j.contains(r#""op":"track_added""#));
        let _: Patch = serde_json::from_str(&j).unwrap();

        let j2 = serde_json::to_string(&Patch::Reload).unwrap();
        assert_eq!(j2, r#"{"op":"reload"}"#);
    }
}
