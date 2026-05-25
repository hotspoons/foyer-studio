// SPDX-License-Identifier: Apache-2.0
//! WebSocket server + client fan-out for Foyer.
//!
//! Owns a single `Backend` (any type that implements [`foyer_backend::Backend`]),
//! subscribes to it once, and fans events out to all connected WebSocket clients.
//! Incoming `Command`s from clients are routed back to the backend.
//!
//! Sequencing: the server assigns a monotonic `seq` to every outgoing envelope. A
//! bounded ring buffer of recent envelopes allows clients reconnecting with
//! `?since=<seq>` to replay missed events instead of forcing a full snapshot.

#![forbid(unsafe_code)]

mod agent_render;
pub mod asset_packs;
mod session_director;
mod spectrum;
mod spectrum_director;
mod ui_director;

/// Public re-export so the CLI can fire the chromium boot probe.
/// Keeps the rest of `agent_render` private (its `pub fn`s take
/// `Weak<AppState>`, an internal-only type).
pub fn probe_headless_chromium_at_boot() {
    agent_render::probe_headless_chromium_at_boot();
}

/// Print a copy-paste `.mcp.json` snippet pointing at this server's
/// `/mcp` endpoint. Called at boot RIGHT AFTER the listener binds so
/// the user sees it inline with the "listening on …" line and can
/// drop it into Claude Code / Codex / any MCP client without having
/// to guess the URL.
///
/// No-op when MCP isn't attached (eg. tests that build a `Server`
/// without `attach_agent`).
async fn log_mcp_connection_snippet(
    state: &Arc<AppState>,
    listen: std::net::SocketAddr,
    tls: bool,
) {
    if state.mcp.read().await.is_none() {
        return;
    }
    let scheme = if tls { "https" } else { "http" };
    // Bind addresses are often 0.0.0.0 / [::]; print loopback in the
    // snippet so an MCP client running on the same host connects
    // without guessing the public IP. The port comes from the actual
    // bind so a non-default --listen propagates.
    let port = listen.port();
    let url = format!("{scheme}://127.0.0.1:{port}/mcp");
    let snippet = serde_json::json!({
        "mcpServers": {
            "foyer-studio": {
                "type": "http",
                "url": url,
            }
        }
    });
    let pretty = serde_json::to_string_pretty(&snippet).unwrap_or_default();
    tracing::info!(
        "\n\n\
         ╔══════════════════════════════════════════════════════════╗\n\
         ║  MCP READY — paste this into Claude Code / Codex          ║\n\
         ║  (~/.mcp.json or the client's MCP config)                 ║\n\
         ╚══════════════════════════════════════════════════════════╝\n\
         {pretty}\n"
    );
}
mod agent_ws;
mod archive;
mod audio;
mod audio_opus;
mod audio_ws;
pub mod backend_profile;
mod calibration;
mod capabilities;
pub(crate) mod chat;
mod cloudflare_api;
mod cloudflare_provider;
mod cloudflared_dl;
mod dev;
mod files;
mod import_audio;
mod ingress_latency;
mod ingress_ws;
mod jail;
mod midi_latency;
mod openai_proxy;
pub mod orphans;
mod plugin_gui_ws;
mod recents;
mod ring;
pub mod session_recovery;
mod session_scrub;
mod sessions;
mod tunnel;
mod tunnel_provider;
mod webllm_bridge;
pub(crate) mod ws;

pub use backend_profile::{ArdourProfile, BackendProfile, BackendProfileRegistry, StubProfile};
pub use jail::{Jail, JailError};
pub use session_scrub::{restore_quarantined_xml, ScrubXmlError};

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use foyer_backend::{Backend, PcmTx};
use foyer_schema::{BackendInfo, EntityId, Envelope, Event, SCHEMA_VERSION};

use crate::sessions::SessionRegistry;
use futures::StreamExt;
use tokio::sync::{broadcast, Mutex, RwLock};
use tokio::task::JoinHandle;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

pub use ring::DeltaRing;

/// Plug-in point: when the WS layer receives `LaunchProject`, it calls
/// `BackendSpawner::launch` to build a fresh backend. The sidecar (CLI or
/// desktop wrapper) implements this so the server doesn't need to know
/// anything about process spawning, config files, or shim discovery.
#[async_trait::async_trait]
pub trait BackendSpawner: Send + Sync + 'static {
    /// Describe the backends this spawner knows about (for the picker UI).
    fn list(&self) -> Vec<BackendInfo>;

    /// Build a new backend. `project_path` is jail-relative (or absolute
    /// — the spawner decides how to resolve it). `sample_rate` is an optional
    /// hint for stub launches / demos; Ardour ignores it today.
    ///
    /// `recover_crash` carries the user's decision from the browser's
    /// crash-recovery prompt for sessions that had a live `.pending`
    /// file at probe time:
    ///   - `Some(true)`  → Recover. Spawner sets
    ///     `FOYER_CRASH_RECOVERY=recover` in the Ardour env; the shim
    ///     auto-clicks the native recovery dialog when it opens.
    ///   - `Some(false)` → Discard. The WS layer already deleted the
    ///     `.pending` file before this call, so the dialog won't open
    ///     — the env var is still set as a belt-and-braces for the
    ///     shim's logging.
    ///   - `None`        → no artifacts; spawn normally.
    /// Stub spawners ignore it.
    async fn launch(
        &self,
        backend_id: &str,
        project_path: Option<&Path>,
        sample_rate: Option<u32>,
        recover_crash: Option<bool>,
    ) -> anyhow::Result<LaunchedBackend>;

    /// Connect to an existing host process by its IPC socket — the
    /// orphan-reattach path. Used when the server detects an Ardour
    /// shim still listening on a registry-recorded socket but with no
    /// matching session in our map (Foyer crashed; Ardour didn't).
    /// Default impl bails so spawners that have nothing to attach to
    /// (the stub) don't have to override.
    ///
    /// `process: None` on the returned `LaunchedBackend` is intentional
    /// for reattach — Foyer didn't fork this Ardour, so we have no
    /// authority to SIGTERM/SIGKILL it on close. The user can quit
    /// Ardour manually if they want; closing the foyer session just
    /// drops the IPC channel.
    async fn reattach(&self, _backend_id: &str, _socket: &Path) -> anyhow::Result<LaunchedBackend> {
        anyhow::bail!("this spawner does not implement reattach")
    }
}

/// Result of `BackendSpawner::launch`. `process` is `Some` when the
/// spawner forked a child whose lifetime is tied to this session —
/// the registry holds it and runs the graceful-quit / SIGTERM /
/// SIGKILL escalation on close. `None` for in-process backends (stub).
pub struct LaunchedBackend {
    pub backend: Arc<dyn Backend>,
    pub process: Option<Box<dyn ProcessHandle>>,
    /// HTTP URL of the upstream DAW's MCP endpoint, when one is
    /// available for this specific session. `None` means either the
    /// spawned DAW build doesn't ship an MCP surface (Ardour 9.2 and
    /// older) or the spawner didn't try to pin a port (stub backends,
    /// reattach to an orphan shim Foyer didn't fork).
    /// Populated by the spawner; consumed by `swap_backend` which
    /// stashes it on the session registry entry so the `daw_proxy`
    /// agent tool can route per-session calls to the right port.
    pub mcp_endpoint: Option<String>,
}

impl LaunchedBackend {
    pub fn new(backend: Arc<dyn Backend>) -> Self {
        Self {
            backend,
            process: None,
            mcp_endpoint: None,
        }
    }

    pub fn with_process(backend: Arc<dyn Backend>, p: Box<dyn ProcessHandle>) -> Self {
        Self {
            backend,
            process: Some(p),
            mcp_endpoint: None,
        }
    }

    /// Tag the launch with the upstream MCP URL. Chainable.
    pub fn with_mcp_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.mcp_endpoint = Some(endpoint.into());
        self
    }
}

/// Handle to a spawned host process so the registry can wait on it
/// and signal it during the close-session escalation. Defined here
/// (not in `tokio::process` directly) so foyer-server stays
/// process-runtime-agnostic; the CLI's `CliSpawner` provides the
/// concrete impl.
#[async_trait::async_trait]
pub trait ProcessHandle: Send + Sync {
    /// Wait up to `timeout` for the process to exit on its own.
    /// Returns `true` if it exited within the window, `false` on
    /// timeout. Implementations must be idempotent on repeated calls
    /// after exit.
    async fn wait(&mut self, timeout: std::time::Duration) -> bool;
    /// Send SIGTERM (or platform equivalent). No-op if already exited.
    async fn sigterm(&mut self);
    /// Send SIGKILL. No-op if already exited.
    async fn sigkill(&mut self);
}

/// Capacity of the server-wide broadcast channel. Bounds how far a slow client can lag
/// before it's dropped from fan-out.
const BROADCAST_CAP: usize = 4096;

/// How many recent envelopes to retain for reconnecting clients.
const RING_CAP: usize = 2048;

#[derive(Debug, Clone)]
pub struct Config {
    pub listen: SocketAddr,
    /// Directory of static web assets to serve at `/`. `None` disables static serving.
    pub web_root: Option<PathBuf>,
    /// Extra web-asset directories layered on top of `web_root`.
    /// Earlier entries win over later entries; `web_root` is the
    /// final fallback. Used to stage a UI variant that lives
    /// outside the main repo without editing the base tree.
    /// `/variants.json` scans every root so dropped-in `ui-*/`
    /// folders surface in the boot.js variant list automatically.
    pub web_overlays: Vec<PathBuf>,
    /// Filesystem jail for the browser / session picker. When `None`, remote
    /// clients cannot browse the host's filesystem at all — `BrowsePath`
    /// returns an error.
    pub jail_root: Option<PathBuf>,
    /// Optional TLS pair. When present, the server serves HTTPS (and
    /// WSS for the WebSocket routes) instead of plain HTTP. Required
    /// when exposing the sidecar over a LAN IP to mobile browsers —
    /// AudioWorklet refuses to load outside a secure context, so the
    /// mixer's Listen button just errors out on `http://<lan>:...`.
    /// Self-signed certs work; browsers surface a one-time warning
    /// the user accepts and then mark the origin as "trusted enough"
    /// for Worklet + most APIs.
    pub tls: Option<TlsConfig>,
}

/// Filesystem paths to a PEM-encoded certificate chain + private key.
/// Loaded on startup; hot-reload isn't supported (an expired cert
/// means the user restarts foyer-cli with fresh files).
#[derive(Debug, Clone)]
pub struct TlsConfig {
    pub cert: PathBuf,
    pub key: PathBuf,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen: "127.0.0.1:3838"
                .parse()
                .expect("hardcoded default socket addr is statically valid"),
            web_root: None,
            web_overlays: Vec::new(),
            jail_root: None,
            tls: None,
        }
    }
}

/// Per-client tunable audio prefs that other clients shouldn't
/// share. Held in `AppState.peer_audio_prefs` keyed by peer id and
/// captured by reference onto each `IngressSink` at open time so the
/// per-packet ingress hot path reads only one atomic (no map lookup).
/// Updates via `SetIngressManualOffsetMs` from a given peer flow only
/// into THAT peer's struct, so two clients with different offsets
/// don't fight each other.
pub(crate) struct PeerAudioPrefs {
    /// User-tuned manual offset added on top of the empirical
    /// ingress capture-latency measurement, in milliseconds.
    pub ingress_manual_offset_ms: std::sync::atomic::AtomicI32,
}

impl Default for PeerAudioPrefs {
    fn default() -> Self {
        Self {
            ingress_manual_offset_ms: std::sync::atomic::AtomicI32::new(0),
        }
    }
}

impl AppState {
    /// Get-or-create the audio-prefs struct for `peer_id`. Returns
    /// a clone of the Arc so callers can hold a reference without
    /// keeping the map locked.
    pub(crate) async fn peer_prefs_for(&self, peer_id: &str) -> Arc<PeerAudioPrefs> {
        let mut g = self.peer_audio_prefs.lock().await;
        g.entry(peer_id.to_string())
            .or_insert_with(|| Arc::new(PeerAudioPrefs::default()))
            .clone()
    }
}

/// Metadata for a single live WS connection. Multiple `ConnectionMeta`
/// rows can point at the same `peer_id` (multi-window — see
/// `ConnectionRole`). Used to route role-gated commands and to
/// enumerate sibling windows of a logical peer (pane handoff +
/// "primary closed, promote a secondary" follow-ups).
#[allow(dead_code)] // fields read by upcoming multi-window routing
#[derive(Clone, Debug)]
pub(crate) struct ConnectionMeta {
    pub peer_id: String,
    pub role: foyer_schema::ConnectionRole,
}

/// Browser → engine ingress registration: PCM sink plus rates for optional resampling.
#[derive(Clone)]
pub(crate) struct IngressSink {
    pub tx: PcmTx,
    pub client_sample_rate: u32,
    pub engine_sample_rate: u32,
    pub channels: u16,
    /// Engine-level port name the backend allocated for this
    /// stream (e.g. `ardour:foyer-ingress-browser-123`). Used to
    /// resolve `Command::SetTrackInput { port_name }` back to a
    /// `stream_id` so we can record which track a take is
    /// flowing into. The recorded mapping drives auto-stamping
    /// of `Region.ingress_latency_ms` at take-commit time.
    pub port_name: Option<String>,
    /// Per-client prefs (currently just the manual capture offset).
    /// Shared `Arc` with `AppState.peer_audio_prefs` so a
    /// `SetIngressManualOffsetMs` from the owning peer is observed
    /// here on the next packet without any map lookup.
    pub peer_audio_prefs: Arc<PeerAudioPrefs>,
}

#[derive(thiserror::Error, Debug)]
pub enum ServerError {
    #[error("backend: {0}")]
    Backend(#[from] foyer_backend::BackendError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Shared server state. Held by every connection task via `Arc`.
pub(crate) struct AppState {
    /// Snapshot-shaped envelope ready to send to new subscribers. Updated whenever a
    /// `SessionSnapshot` event flows through.
    pub(crate) cached_snapshot: RwLock<Option<Envelope<Event>>>,
    /// Broadcast of all outgoing envelopes.
    pub(crate) tx: broadcast::Sender<Envelope<Event>>,
    /// Ring buffer for `?since=` resync.
    pub(crate) ring: Arc<RwLock<DeltaRing>>,
    /// Monotonic sequence counter.
    pub(crate) next_seq: Arc<AtomicU64>,
    /// Active backend. Wrapped in RwLock so the sidecar can swap
    /// backends at runtime (e.g. picker → open project → spawn Ardour
    /// → swap). WS handlers call `backend().await` to get a cheap
    /// `Arc<dyn Backend>` clone without holding the lock across an
    /// async backend call.
    ///
    /// With multi-session this points to the *most-recently-added*
    /// session's backend. It's still here for two reasons: (1) legacy
    /// callers (CLI bootstrap, tests) that haven't been migrated to
    /// the sessions map, and (2) commands without an explicit
    /// `session_id` that need somewhere to route.
    pub(crate) backend: RwLock<Arc<dyn Backend>>,
    /// Id of the active backend (matches `BackendInfo.id`). Tracks which
    /// entry in the spawner's list is currently live so the picker UI
    /// can highlight it.
    pub(crate) active_backend_id: RwLock<Option<String>>,
    /// Optional spawner so clients can launch/swap backends over WS.
    pub(crate) spawner: Option<Arc<dyn BackendSpawner>>,
    /// Per-backend filesystem profile registry. Consulted at moments
    /// when there's no live `Backend` to ask — orphan scan, jail
    /// browse, upload sanitizer, crash-recovery prompt before
    /// launch. Populated by the embedder (CLI / desktop) at startup
    /// with the profiles it bundles. Default-initialized to the
    /// builtin set (`ardour` + `stub`) so test harnesses and
    /// in-process tooling that skip the explicit registration step
    /// still get sensible behavior.
    pub(crate) profiles: Arc<RwLock<Arc<BackendProfileRegistry>>>,
    /// Background task that pumps events from the current backend into
    /// the broadcast channel. Stored so `swap_backend` can abort and
    /// respawn it when the backend changes.
    pub(crate) pump_handle: Mutex<Option<JoinHandle<()>>>,
    /// Optional filesystem jail for the session picker.
    pub(crate) jail: Option<Jail>,
    /// Socket path of the shim the *initial* (auto-attached) backend
    /// is talking to, when applicable. The CLI sets this when it
    /// boots and auto-attaches to an already-running Ardour shim
    /// (`adv.socket` from discovery). Used by `Command::ReattachOrphan`
    /// to detect "the orphan you're trying to reattach is already
    /// the implicit backend" and adopt the existing connection
    /// instead of opening a second IPC channel — the shim only
    /// services one client at a time, so a second connect would sit
    /// in the kernel's accept queue forever and silently break event
    /// flow.
    pub(crate) attached_socket: RwLock<Option<PathBuf>>,
    /// Port this server is listening on — snapshotted from `Config::listen`
    /// at `run()` time so the WS handler can include it in the client
    /// greeting for share-session URLs.
    pub(crate) listen_port: std::sync::atomic::AtomicU16,
    /// True when the server is serving HTTPS (i.e. `Config::tls` was
    /// set). Drives the scheme the client greeting advertises — a
    /// mismatched scheme would hand out dead URLs.
    pub(crate) tls_enabled: std::sync::atomic::AtomicBool,
    /// M6a audio egress hub. Holds live encoder pipelines keyed by
    /// `stream_id`; the `/ws/audio/:stream_id` route subscribes to
    /// its broadcasts. Shared across all connections.
    pub(crate) audio_hub: Arc<audio::AudioHub>,
    /// Server-side spectrum analyser. Used as a fallback when the
    /// active backend advertises `spectrum.available = false` (the
    /// Ardour shim today) — we tap its audio egress and run the FFT
    /// in Rust so the FE / agent get usable spectrum frames without
    /// waiting on the shim's native pipeline.
    pub(crate) spectrum_svc: spectrum::SpectrumService,
    /// M6b ingress senders. Keyed by `stream_id`; browser pushes
    /// binary PCM to `/ws/ingress/:stream_id`, and the task there
    /// forwards frames into this sink. Dropping the entry
    /// (on `AudioIngressClose` or server restart) closes the channel
    /// and the backend tears the sink down from its side.
    pub(crate) ingress_senders: Mutex<HashMap<u32, IngressSink>>,
    /// Per-stream ingress latency samples. The ingress WS handler
    /// records `(server_recv_mono_ns - client_send_mono_ns)` from
    /// each binary frame's header (after subtracting the
    /// most-recent clock-probe offset). Recording-finalize reads
    /// the median to stamp the resulting region with
    /// `Region.ingress_latency_ms`. See `ingress_latency.rs`.
    pub(crate) ingress_latency: Arc<ingress_latency::IngressLatencyTracker>,
    /// Bench-only fake latency injected on the ingress audio path,
    /// in ms. Read by `ingress_ws::handle` on every packet (branched
    /// out on 0). Initially seeded from
    /// `FOYER_INGRESS_FAKE_LATENCY_MS`; runtime-tunable via
    /// `Command::SetFakeLatency`. See diagnostics Timing tab.
    pub(crate) fake_ingress_latency_ms: std::sync::atomic::AtomicU32,
    /// Sibling for the egress (server → browser) audio path. Read
    /// by `audio_ws::handle` per packet. Same semantics.
    pub(crate) fake_egress_latency_ms: std::sync::atomic::AtomicU32,
    /// Per-peer audio prefs (currently the manual capture offset).
    /// Each connected peer gets a stable entry on first use; updates
    /// from `SetIngressManualOffsetMs` write into THAT peer's atomic
    /// only, and any ingress sink opened by that peer holds an Arc
    /// to the same struct so per-packet reads stay lock-free.
    /// Avoids the cross-client interference an `AppState`-global
    /// atomic would create (last writer wins, every client's
    /// ingress sees the offset).
    pub(crate) peer_audio_prefs: Mutex<HashMap<String, Arc<PeerAudioPrefs>>>,
    /// Speaker→mic loopback calibration manager. Created idle;
    /// `Command::StartIngressCalibration` arms it, the egress encode
    /// + ingress decode hooks drive it, `Event::CalibrationProgress`
    /// + `Event::CalibrationResult` surface progress to the UI.
    pub(crate) calibration: Arc<calibration::CalibrationManager>,
    /// Per-track MIDI roundtrip-latency samples. Browser `MidiInput`
    /// commands carry an `echo_server_mono_ns` echo timestamp; the
    /// server records `recv - echo` per track here and the dispatch
    /// path checks the rolling median to decide whether to emit a
    /// `SetMidiCaptureLatency` to the shim. See `midi_latency.rs`.
    pub(crate) midi_latency: Arc<midi_latency::MidiLatencyTracker>,
    /// Last MIDI capture-latency value pushed per track id, in
    /// samples. Used to threshold subsequent `SetMidiCaptureLatency`
    /// emissions so we don't kick the shim on every MIDI event.
    pub(crate) midi_latency_last_applied: Arc<Mutex<HashMap<EntityId, u32>>>,
    /// Track id → ingress stream id. Populated when a
    /// `SetTrackInput` succeeds against a known ingress sink port,
    /// dropped on `AudioIngressClose`. Read by the per-session
    /// event pump to look up which stream's latency stat applies
    /// to a freshly-committed region. Shared by Arc with the
    /// SessionRegistry so the pumps don't need a back-reference
    /// to AppState.
    pub(crate) track_ingress: Arc<Mutex<HashMap<EntityId, u32>>>,
    /// Smoothed `(client_mono_ns - server_mono_ns)` from the most-
    /// recent `Command::ClockProbe`. Updated on every probe handle.
    /// Stored as i64 because the offset can swing either direction
    /// depending on which side's clock was started first. Atomic so
    /// the ingress hot path can read without locking.
    pub(crate) clock_offset_ns: std::sync::atomic::AtomicI64,
    /// Per-stream integral state for the egress drift-correction
    /// controller. Keyed by `stream_id`; each entry holds the
    /// running sum of `(buffered - target)` errors observed so the
    /// PI control law's I-term has memory across feedback ticks.
    /// Populated lazily on the first `AudioBufferReport` for a
    /// stream and dropped when the stream closes (the audio_hub's
    /// `close_stream` doesn't touch it; the entry just lives until
    /// next sidecar restart, which is fine because the
    /// `nudge_stream_ratio` call short-circuits on missing streams).
    pub(crate) drift_integral: Mutex<HashMap<u32, f64>>,
    /// In-app chat + PTT state. Decoupled from the DAW — messages and
    /// push-to-talk audio fan out purely client-to-client via the
    /// sidecar. See `chat.rs` for the wire format.
    pub(crate) chat: chat::ChatState,
    /// Track id → peer id assignment. When a row is present the named
    /// peer's browser is expected to act as the audio source for that
    /// track (mic capture over the existing `/ws/ingress/` pipe). Not
    /// persisted across sidecar restarts; the host re-assigns per
    /// session.
    pub(crate) track_browser_sources: RwLock<HashMap<foyer_schema::EntityId, String>>,
    /// Static `mcp_proxies:` from config.yaml — upstream MCP servers
    /// Foyer didn't spawn (e.g. a Reaper instance the user started
    /// separately). The `daw_proxy` agent tool merges these with
    /// per-session entries (from `Session.mcp_endpoint`) at query
    /// time. Held in a RwLock so a hot-reload of config could update
    /// it without restarting the runtime.
    pub(crate) mcp_proxies: RwLock<Vec<foyer_config::McpProxyConfig>>,
    /// Broadcast for PTT binary frames. Separate channel from the
    /// JSON envelope bus so the writer loop can forward it as a
    /// `Message::Binary` without re-encoding. Each connection
    /// subscribes; the sender's own frames are filtered by matching
    /// the embedded peer id.
    pub(crate) ptt_tx: broadcast::Sender<Vec<u8>>,
    /// Multi-session registry. Holds every currently-open session
    /// keyed by its UUID; each has its own backend Arc + event pump.
    /// `add_session`/`close_session` on this registry broadcasts
    /// lifecycle events to all connected clients.
    pub(crate) sessions: Arc<SessionRegistry>,
    /// Orphans detected on sidecar startup. Kept so new clients can
    /// retrieve the list on their first connect (vs. having to have
    /// been attached when the scan happened). Cleared entries are
    /// pruned when the user reattaches or dismisses.
    pub(crate) orphans: RwLock<Vec<foyer_schema::OrphanInfo>>,
    /// Which session the "default" command route targets when an
    /// envelope arrives without an explicit `session_id`. Set by
    /// `Command::SelectSession`; defaults to the most-recently-opened
    /// session. Single-focus is good enough for the one-browser-
    /// window-per-sidecar case today; a per-connection override can
    /// layer on top later without breaking this default.
    pub(crate) focus_session_id: RwLock<Option<EntityId>>,

    // ─── remote-access tunnel state ────────────────────────────────────
    /// In-memory tunnel manifest (connections, roles, enabled flag).
    /// Backed by `$XDG_DATA_HOME/foyer/tunnel-manifest.json`.
    pub(crate) tunnel_manifest: Arc<RwLock<foyer_schema::TunnelManifest>>,
    /// Active tunnel provider (ngrok, cloudflared, …).  Held in an
    /// Arc<Mutex<…>> so the provider-specific shutdown logic runs
    /// polymorphically without the caller knowing which one it is.
    pub(crate) tunnel_provider: Mutex<Option<SharedTunnelProvider>>,
    /// Hostname reported by the active tunnel.
    pub(crate) tunnel_hostname: RwLock<Option<String>>,
    /// Configuration snapshot from config.yaml (tunnel.ngrok, tunnel.cloudflare).
    /// Injected by the CLI after it reads the file so WS handlers can start
    /// tunnels with stored tokens rather than env vars.
    pub(crate) tunnel_cfg: RwLock<foyer_config::TunnelConfig>,
    /// Directory of static web assets. Captured into AppState so the
    /// tunnel-auth listener can rebuild the same router (with the same
    /// static fallback) as the main LAN listener. Set by `Server::run`
    /// from `Config::web_root` before either listener comes up.
    pub(crate) web_root: RwLock<Option<PathBuf>>,
    /// Extra web-asset dirs layered on top of `web_root`. Earlier
    /// entries win; `web_root` is the last-resort fallback.
    /// `/variants.json` scans the full chain so fork-dev variants
    /// (under their own sibling dir) show up in boot.js without any
    /// edits to the main repo. See `ServerConfig::web_overlays`.
    pub(crate) web_overlays: RwLock<Vec<PathBuf>>,
    /// RBAC policy loaded from `$XDG_DATA_HOME/foyer/roles.yaml`
    /// (seeded from the binary on first run). Queried on each
    /// tunnel-origin command dispatch; LAN connections skip it. Stored
    /// in an RwLock so the CLI's `--reload-roles` path (future) can
    /// hot-swap without restarting the server.
    pub(crate) roles_policy: RwLock<foyer_config::RolesConfig>,
    /// Logical-peer roster, keyed by `peer_id`. One entry per logical
    /// user (regardless of how many browser windows / WS connections
    /// they hold). `PeerInfo.connection_count` reflects the active
    /// window count; we broadcast `PeerJoined` only on the 0→1
    /// transition and `PeerLeft` only on the N→0 transition, so
    /// adding a second window for an existing peer is invisible to
    /// other clients' rosters.
    pub(crate) peers: RwLock<HashMap<String, foyer_schema::PeerInfo>>,
    /// Whitelist + state for foreign-content asset packs (sprunki
    /// game assets, future mod packs). Constructed once at boot;
    /// per-pack state lives behind its own RwLock inside the
    /// manager. WS layer calls into it via the FetchAssetPack /
    /// ListAssetPacks command handlers and the greeting bundle
    /// reads `list()` for the initial state. The HTTP layer mounts
    /// `/asset-packs/` as a ServeDir on `asset_packs::root_dir()`.
    pub(crate) asset_packs: Arc<asset_packs::AssetPackManager>,
    /// Per-connection registry, keyed by the server-assigned
    /// `connection_id`. Distinct from `peers`: this is one row per
    /// open WS, so secondary windows of the same logical user each
    /// get an entry pointing at the shared `peer_id`. Read on
    /// command dispatch to determine `ConnectionRole` (audio I/O is
    /// `Primary`-only). Pruned on disconnect.
    pub(crate) connections: RwLock<HashMap<String, ConnectionMeta>>,
    /// Operator pin for the UI variant every browser should load —
    /// e.g. `Some("touch")` on a kiosk deployment, `Some("kids")` on
    /// a family workstation. `None` lets each browser pick via
    /// `?ui=` URL override, localStorage preference, or its own
    /// heuristic match. Broadcast in `ClientGreeting.default_ui_variant`.
    pub(crate) default_ui_variant: Option<String>,
    /// Whether the server has xpra installed for native plugin GUI
    /// projection (`/ws/plugin-gui` proxy + `/_xpra/` static mount
    /// both require it). Probed once at startup; if false the
    /// `native_plugin_gui` feature flag is sent as `false` in
    /// `ClientGreeting.features` so the UI hides the toggle. We
    /// don't re-probe at runtime — installing xpra without
    /// restarting the server is rare enough not to optimize for.
    pub(crate) xpra_available: bool,
    /// Per-client-IP login attempt counter for the `/login` endpoint.
    /// Sliding-window rate limiter — without this, an attacker on the
    /// public tunnel can brute-force credentials at line speed.
    pub(crate) login_gate: tokio::sync::Mutex<HashMap<IpAddr, LoginAttempts>>,
    /// Per-region debounce + idempotency state for `SetSequencerLayout`.
    /// Each WS frame from a beat-sequencer cell click would otherwise run
    /// the full pipeline (XML persist + `replace_region_notes`), and the
    /// shim's `replace_region_notes` rewrites the live MIDI model via
    /// `apply_diff_command_as_commit` — which fires `ContentsChanged`
    /// and invalidates Ardour's playback iterators mid-bar. Result was
    /// hit-or-miss note playback while the editor was open. We coalesce
    /// here: bump the per-region version on arrival, defer the regen,
    /// and skip outright when the layout matches the last one rendered.
    pub(crate) sequencer_coalescer: Arc<Mutex<HashMap<EntityId, SequencerCoalesceState>>>,

    /// AI agent runtime. `None` until `attach_agent` is called by
    /// `foyer-cli` at startup; absent in tests that don't need the
    /// agent surface. The browser FAB + MCP transports both read
    /// through this slot.
    pub(crate) agent: RwLock<Option<std::sync::Arc<foyer_agent::AgentRuntime>>>,

    /// rmcp Model Context Protocol bridge. Wraps the same agent tool
    /// registry that the in-process agent uses, exposing it over
    /// `/mcp` (streamable HTTP) to external clients like Claude Code
    /// and Codex. `None` in builds that don't link foyer-mcp or in
    /// tests that don't need it.
    pub(crate) mcp: RwLock<Option<foyer_mcp::FoyerMcpServer>>,

    /// WebLLM bridge — accepts `/llm/v1/*` HTTP traffic and relays
    /// it to whichever browser tab is currently registered via
    /// `/ws/webllm`. The agent harness points its config here when
    /// the user picks WebLLM as the LLM transport.
    pub(crate) webllm_bridge: std::sync::Arc<webllm_bridge::WebLlmBridge>,

    /// FE-attached renderer for the `visualize` agent tool.
    /// `None` until `attach_agent()` runs.
    pub(crate) fe_renderer: RwLock<Option<std::sync::Arc<agent_render::FeRendererImpl>>>,

    /// FE-attached UI director for the `ui` agent tool. Round-trips
    /// `Event::UiAction` / `Command::UiActionResult` against any
    /// attached browser tab.
    pub(crate) ui_director: RwLock<Option<std::sync::Arc<ui_director::UiDirectorImpl>>>,

    /// API key required on the OpenAI-compatible endpoint exposed at
    /// `/v1/*`. `None` = open (no auth). When set, every `/v1/*`
    /// request must carry `Authorization: Bearer <key>` or it's
    /// rejected with `401`. Seeded by `foyer-cli` from the CLI flag
    /// / env var / `config.yaml` chain.
    pub(crate) openai_proxy_api_key: RwLock<Option<String>>,

    /// Whether the OpenAI-compatible `/v1/chat/completions` endpoint
    /// should surface tool calls (start + result lines) to external
    /// callers. Default `false` so callers see Foyer as a "smarter
    /// chat model" — flip to `true` (via config or
    /// `FOYER_OPENAI_PROXY_SHOW_TOOL_CALLS=1`) when you want the
    /// upstream proxy / chat UI to see what tools the agent fired.
    pub(crate) openai_proxy_expose_tool_calls: std::sync::atomic::AtomicBool,
}

/// Tracking state for the sequencer SetSequencerLayout coalescer.
/// One entry per region that has ever been edited this session.
#[derive(Default)]
pub(crate) struct SequencerCoalesceState {
    /// Last layout we successfully shipped to the shim. An incoming
    /// SetSequencerLayout that compares equal to this is dropped on
    /// the floor — neither the XML persist nor the notes regen runs.
    /// Tempo-change auto-persists ([beat-sequencer.js] `_onStoreControl`)
    /// re-emit the same layout on every tempo tick; this is the gate
    /// that keeps those from thrashing the MIDI model.
    pub last_rendered: Option<foyer_schema::SequencerLayout>,
    /// Bumped on every SetSequencerLayout arrival. Each debounced
    /// task captures the version at scheduling time and aborts on
    /// fire if a newer arrival has bumped it again, so a fast drag
    /// across cells produces exactly one regen at the end.
    pub version: u64,
}

/// One IP's recent login attempt count. Reset when the window expires.
#[derive(Debug)]
pub(crate) struct LoginAttempts {
    pub count: u32,
    pub window_start: Instant,
}

/// Cap login attempts at this many per `LOGIN_WINDOW`. Picked to allow
/// a few mistypes without locking out a legitimate user, but small
/// enough that an online dictionary attack is hopeless.
pub(crate) const LOGIN_MAX_PER_WINDOW: u32 = 10;
pub(crate) const LOGIN_WINDOW: Duration = Duration::from_secs(60);

impl AppState {
    fn next_seq(&self) -> u64 {
        self.next_seq.fetch_add(1, Ordering::Relaxed)
    }

    /// Helper to build an `Envelope<Event>` tagged for the server
    /// origin with a freshly-minted seq. Used by command dispatch
    /// for error replies, lifecycle broadcasts, etc.
    pub(crate) fn envelope(&self, body: Event, session_id: Option<EntityId>) -> Envelope<Event> {
        Envelope {
            schema: SCHEMA_VERSION,
            api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
            seq: self.next_seq(),
            origin: Some("server".into()),
            session_id,
            body,
        }
    }

    pub(crate) async fn current_snapshot(&self) -> Option<Envelope<Event>> {
        self.cached_snapshot.read().await.clone()
    }

    /// Cheap clone of the current backend-profile registry. Release
    /// the read lock before any long-running filesystem op so a
    /// concurrent `set_profile_registry` doesn't stall.
    pub(crate) async fn profiles(&self) -> Arc<BackendProfileRegistry> {
        self.profiles.read().await.clone()
    }

    /// Get a cheap clone of the current backend trait-object. Release
    /// the read lock before awaiting anything on the returned `Arc`
    /// so a concurrent `swap_backend` isn't blocked on us.
    ///
    /// With multi-session enabled, this prefers the focused session's
    /// backend (set via `Command::SelectSession`) over the legacy
    /// `backend` field. Falls through to the legacy field when no
    /// session is focused or the focused session's been closed,
    /// which keeps the stub / launcher-mode path working.
    pub(crate) async fn backend(&self) -> Arc<dyn Backend> {
        if let Some(id) = self.focus_session_id.read().await.clone() {
            if let Some(be) = self.sessions.backend(&id).await {
                return be;
            }
        }
        self.backend.read().await.clone()
    }

    /// Replace `state.backend` with `next` AND re-point the agent
    /// runtime at the new Arc. The agent holds a `Weak<dyn Backend>`
    /// captured at attach time; dropping the previous Arc here (via
    /// `RwLock::write` overwrite) would otherwise leave that Weak
    /// dangling and every agent tool call would return `BackendGone`.
    /// Call this from every site that swaps the active backend.
    pub(crate) async fn install_active_backend(&self, next: Arc<dyn Backend>) {
        *self.backend.write().await = next.clone();
        if let Some(agent) = self.agent.read().await.clone() {
            agent.attach_backend(std::sync::Arc::downgrade(&next)).await;
        }
        // Keep the MCP bridge tracking the same backend the in-process
        // agent points at — external clients (Claude Code, Codex)
        // would otherwise see "backend not attached" after a session
        // swap until the next mcp restart.
        if let Some(mcp) = self.mcp.read().await.clone() {
            mcp.attach_backend(std::sync::Arc::downgrade(&next)).await;
        }
    }

    /// Test-only: replace `state.backend` with a fresh `StubBackend`
    /// and respawn the legacy event pump so its events flow with
    /// `session_id: None`. The Playwright `_boot.js::bootTimeline`
    /// helper invokes this (via `Command::TestResetState`) to give
    /// each spec a stable, freshly-seeded launcher baseline.
    ///
    /// Why we re-spawn the legacy pump instead of just resetting in
    /// place: after any earlier `swap_backend` call (every agent
    /// `session.new` triggers one), the original legacy pump has
    /// been aborted, and the now-current `state.backend` Arc is the
    /// agent-created session's stub — also registered in the
    /// `SessionRegistry`, so its events come tagged with that
    /// session's id and the client store filters them out when the
    /// freshly-loaded page's `currentSessionId` doesn't match.
    /// Spawning a fresh stub + a fresh untagged pump fixes both
    /// halves: the new stub starts with a seeded fixture (no
    /// accumulated mutations), and the new pump tags everything
    /// `session_id: None` which bypasses the client's session-scoped
    /// filter unconditionally.
    ///
    /// Leaves the `SessionRegistry` alone — `scripts-panel` and
    /// `spectrum` specs that don't go through `bootTimeline` keep
    /// their existing session focus and don't see this operation.
    /// `focus_session_id` is cleared so subsequent `state.backend()`
    /// lookups land on the fresh launcher, not a stale registry
    /// entry.
    pub(crate) async fn reset_to_fresh_launcher_for_test(self: &Arc<Self>) {
        // Abort the current legacy pump if it's still alive (it
        // usually isn't, since `swap_backend` would have killed it
        // earlier in the run).
        {
            let mut slot = self.pump_handle.lock().await;
            if let Some(h) = slot.take() {
                h.abort();
            }
        }
        // Mint a fresh launcher. The boot path passes config-driven
        // sample-rate / test-tone / jail; this reset deliberately
        // doesn't — we want the baseline every spec sees, not the
        // operator-tweaked one. Tests that need a specific
        // configuration can build their own backend and inject it.
        let fresh: Arc<dyn Backend> = Arc::new(foyer_backend_stub::StubBackend::new());
        self.install_active_backend(fresh.clone()).await;
        // Spawn a new legacy pump pointed at the fresh backend.
        // `event_pump` tags every emitted envelope with
        // `session_id: None`, which is what bypasses the client's
        // session-scoped filter and lets the test's `list_regions`
        // / `duplicate_region` round-trips actually update
        // `_regionsByTrack`.
        let s = self.clone();
        let backend_for_pump = fresh.clone();
        let handle = tokio::spawn(async move {
            if let Err(e) = event_pump(backend_for_pump, s).await {
                tracing::error!("test-reset legacy pump died: {e}");
            }
        });
        *self.pump_handle.lock().await = Some(handle);
        // Drop the focus pointer so subsequent `state.backend()`
        // lookups fall through to the freshly-installed launcher.
        *self.focus_session_id.write().await = None;
        // The launcher's `subscribe()` will deliver an initial
        // snapshot through the new pump on its first read, but we
        // don't wait for it — the WS handler's caller already
        // assumes async settling.
    }

    /// Same key set as [`Event::ClientGreeting`]: backend [`Backend::features`]
    /// merged with server-only flags (e.g. `native_plugin_gui`).
    pub(crate) async fn merged_feature_map(&self) -> std::collections::BTreeMap<String, bool> {
        let mut feat = self.backend().await.features();
        feat.insert("native_plugin_gui".into(), self.xpra_available);
        feat
    }

    /// Swap the active backend. Aborts the old event pump, starts a new
    /// one subscribed to `next`, drops the cached snapshot (so the next
    /// `SessionSnapshot` from the new backend re-seeds it), and emits a
    /// `BackendSwapped` event to all connected clients.
    ///
    /// With multi-session enabled this also registers the new backend
    /// in the sessions map so the switcher sees it. Existing sessions
    /// are left alone — callers that want to *close* an old session
    /// before swapping must call `sessions.close()` explicitly. The
    /// `session_id` argument is the UUID the shim pre-generated and
    /// wrote into the .ardour file; when `None` we synthesize a
    /// random id for stub/anonymous backends.
    // Crossed clippy's 7-arg threshold once mcp_endpoint joined the
    // signature. A struct wrapper here would force every WS dispatch
    // path + spawner callback through an extra builder for a record
    // that's already serialized whole onto `SessionInfo`. Skipping the
    // lint is cheaper than the churn.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn swap_backend(
        self: &Arc<Self>,
        backend_id: String,
        project_path: Option<String>,
        next: Arc<dyn Backend>,
        session_id: Option<EntityId>,
        session_name: Option<String>,
        process: Option<Box<dyn ProcessHandle>>,
        mcp_endpoint: Option<String>,
    ) {
        self.install_active_backend(next.clone()).await;
        *self.active_backend_id.write().await = Some(backend_id.clone());
        *self.cached_snapshot.write().await = None;
        // Drop the sequencer-regen coalescer's per-region cache.
        // `last_rendered` is a "we already shipped this layout to the
        // shim" mark, which is meaningful only for the OLD session's
        // shim state. Carrying it across a swap means an idempotent
        // tickle for the new session (sent because the new project's
        // MidiModel hasn't been re-expanded yet) gets falsely
        // skipped, leaving the timeline mini-strip blank until the
        // user opens the sequencer manually.
        self.sequencer_coalescer.lock().await.clear();

        // Abort the legacy one-shot pump if any. New sessions get
        // their own pump spawned by the registry, so we don't
        // re-spawn here.
        let mut slot = self.pump_handle.lock().await;
        if let Some(h) = slot.take() {
            h.abort();
        }
        drop(slot);

        // Register the new session so the switcher + multi-session
        // command routing sees it. Falls back to a synthetic id when
        // the caller didn't supply one (stub backends, legacy tests).
        let sid = session_id
            .unwrap_or_else(|| EntityId::new(format!("session.{}", uuid::Uuid::new_v4().simple())));
        let name = session_name.unwrap_or_else(|| {
            project_path
                .as_deref()
                .and_then(|p| {
                    std::path::Path::new(p)
                        .file_stem()?
                        .to_str()
                        .map(String::from)
                })
                .unwrap_or_else(|| backend_id.clone())
        });
        // Canonicalize the path before stashing it in the session
        // registry. Clients send a mix of relative ("sessions/foo")
        // and absolute ("/workspaces/…/sessions/foo") paths; without
        // normalization the same project shows up twice in recents
        // and the "already open?" match in launch_project misses.
        // Fall back to the original string if canonicalize fails
        // (e.g. path is a URI or a not-yet-created session dir).
        let path = project_path
            .as_deref()
            .map(|p| {
                std::path::Path::new(p)
                    .canonicalize()
                    .ok()
                    .and_then(|c| c.to_str().map(String::from))
                    .unwrap_or_else(|| p.to_string())
            })
            .unwrap_or_default();
        self.sessions
            .clone()
            .add(
                sid.clone(),
                backend_id.clone(),
                next,
                path,
                name,
                process,
                mcp_endpoint,
            )
            .await;
        // Newly-opened session automatically becomes the focus
        // target so untagged commands flow to it. User can switch
        // away via `SelectSession`.
        *self.focus_session_id.write().await = Some(sid);

        // Tell all clients to re-snapshot. The swap event goes through
        // the same broadcast + ring as every other event so `?since=`
        // reconnects replay it. Strip the jail prefix from the path
        // so the UI keeps its "no absolute paths" guarantee
        // (PLAN 162).
        let display_path = match project_path.as_deref() {
            Some(p) => Some(self.sessions.jail_display_path(p).await),
            None => None,
        };
        let env = self.envelope(
            Event::BackendSwapped {
                backend_id,
                project_path: display_path,
            },
            None,
        );
        self.ring.write().await.push(env.clone());
        let _ = self.tx.send(env);
    }
}

pub struct Server {
    state: Arc<AppState>,
}

impl Server {
    /// Build a server around a concrete backend — convenience wrapper
    /// that erases to `Arc<dyn Backend>` internally. Legacy call sites
    /// (and tests) use this form.
    pub fn new<B: Backend + 'static>(backend: B) -> Self {
        Self::new_dyn(Arc::new(backend))
    }

    /// Build a server around an already-erased backend trait-object.
    /// Use this when you plan to support live swaps via `LaunchProject`.
    pub fn new_dyn(backend: Arc<dyn Backend>) -> Self {
        Self::with_spawner(backend, None)
    }

    /// Full constructor: erased backend plus a spawner so the WS layer
    /// can build and swap in new backends on `LaunchProject`.
    pub fn with_spawner(
        backend: Arc<dyn Backend>,
        spawner: Option<Arc<dyn BackendSpawner>>,
    ) -> Self {
        let (tx, _) = broadcast::channel(BROADCAST_CAP);
        let (ptt_tx, _) = broadcast::channel::<Vec<u8>>(BROADCAST_CAP);
        let ring = Arc::new(RwLock::new(DeltaRing::new(RING_CAP)));
        let next_seq = Arc::new(AtomicU64::new(1));
        let ingress_latency = Arc::new(ingress_latency::IngressLatencyTracker::new());
        let calibration = Arc::new(calibration::CalibrationManager::new());
        let midi_latency = Arc::new(midi_latency::MidiLatencyTracker::new());
        let midi_latency_last_applied: Arc<Mutex<HashMap<EntityId, u32>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let track_ingress = Arc::new(Mutex::new(HashMap::<EntityId, u32>::new()));
        let sessions = Arc::new(SessionRegistry::new(
            tx.clone(),
            ring.clone(),
            next_seq.clone(),
            ingress_latency.clone(),
            track_ingress.clone(),
        ));
        let state = Arc::new(AppState {
            cached_snapshot: RwLock::new(None),
            tx,
            ring,
            next_seq,
            backend: RwLock::new(backend),
            active_backend_id: RwLock::new(None),
            spawner,
            profiles: Arc::new(RwLock::new(Arc::new(
                BackendProfileRegistry::with_builtins(),
            ))),
            pump_handle: Mutex::new(None),
            jail: None,
            attached_socket: RwLock::new(None),
            listen_port: std::sync::atomic::AtomicU16::new(0),
            tls_enabled: std::sync::atomic::AtomicBool::new(false),
            audio_hub: Arc::new(audio::AudioHub::new(calibration.clone())),
            spectrum_svc: spectrum::SpectrumService::new(),
            ingress_senders: Mutex::new(HashMap::new()),
            ingress_latency,
            fake_ingress_latency_ms: std::sync::atomic::AtomicU32::new(
                std::env::var("FOYER_INGRESS_FAKE_LATENCY_MS")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
            ),
            fake_egress_latency_ms: std::sync::atomic::AtomicU32::new(
                std::env::var("FOYER_EGRESS_FAKE_LATENCY_MS")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
            ),
            peer_audio_prefs: Mutex::new(HashMap::new()),
            calibration,
            midi_latency,
            midi_latency_last_applied,
            track_ingress,
            clock_offset_ns: std::sync::atomic::AtomicI64::new(0),
            drift_integral: Mutex::new(HashMap::new()),
            chat: chat::ChatState::new(),
            track_browser_sources: RwLock::new(HashMap::new()),
            mcp_proxies: RwLock::new(Vec::new()),
            ptt_tx,
            sessions,
            orphans: RwLock::new(Vec::new()),
            focus_session_id: RwLock::new(None),
            tunnel_manifest: Arc::new(RwLock::new(foyer_schema::TunnelManifest::default())),
            tunnel_provider: Mutex::new(None),
            tunnel_hostname: RwLock::new(None),
            tunnel_cfg: RwLock::new(foyer_config::TunnelConfig::default()),
            web_root: RwLock::new(None),
            web_overlays: RwLock::new(Vec::new()),
            // Bundled default keeps the server usable even if the CLI
            // forgets to call `load_roles_policy` — fails closed on
            // bad inputs, permissive on admin, which matches the
            // "LAN is trusted" baseline.
            roles_policy: RwLock::new(foyer_config::RolesConfig::bundled_default()),
            peers: RwLock::new(HashMap::new()),
            asset_packs: Arc::new(asset_packs::AssetPackManager::new()),
            connections: RwLock::new(HashMap::new()),
            default_ui_variant: None,
            xpra_available: probe_xpra_available(),
            login_gate: tokio::sync::Mutex::new(HashMap::new()),
            sequencer_coalescer: Arc::new(Mutex::new(HashMap::new())),
            agent: RwLock::new(None),
            mcp: RwLock::new(None),
            webllm_bridge: std::sync::Arc::new(webllm_bridge::WebLlmBridge::new()),
            fe_renderer: RwLock::new(None),
            ui_director: RwLock::new(None),
            openai_proxy_api_key: RwLock::new(None),
            openai_proxy_expose_tool_calls: std::sync::atomic::AtomicBool::new(env_truthy(
                "FOYER_OPENAI_PROXY_SHOW_TOOL_CALLS",
            )),
        });
        Self { state }
    }

    /// Attach the agent runtime. Called by foyer-cli after the
    /// AppState is constructed so the agent's filesystem store has a
    /// chance to fail gracefully without blocking the rest of the
    /// server from coming up. `mcp_proxies` is the list of upstream
    /// MCP backends the agent's `daw_proxy` tool will speak to;
    /// usually fed from `foyer_config::Config.mcp_proxies`.
    pub async fn attach_agent(
        &self,
        mcp_proxies: Vec<foyer_config::McpProxyConfig>,
    ) -> Result<std::sync::Arc<foyer_agent::AgentRuntime>, foyer_agent::store::StoreError> {
        // Stash the static proxy list on AppState so the SessionDirector
        // can merge it with per-session live entries when the agent
        // queries `daw_proxy.list_backends`. Runtime gets it too as a
        // boot-time fallback for thin dispatch paths that don't have a
        // director attached.
        *self.state.mcp_proxies.write().await = mcp_proxies.clone();
        let store = std::sync::Arc::new(foyer_agent::store::AgentStore::open_default().await?);
        let runtime = foyer_agent::AgentRuntime::with_store_and_proxies(store, mcp_proxies).await?;
        let backend = self.state.backend.read().await.clone();
        runtime
            .attach_backend(std::sync::Arc::downgrade(&backend))
            .await;
        *self.state.agent.write().await = Some(runtime.clone());
        // Bring up the MCP bridge alongside the runtime. Same tools,
        // same backend Weak — external clients (Claude Code / Codex)
        // see what the in-process agent sees.
        let mcp = foyer_mcp::FoyerMcpServer::new(runtime.clone());
        mcp.attach_backend(std::sync::Arc::downgrade(&backend))
            .await;
        *self.state.mcp.write().await = Some(mcp);
        // Renderer installation is deferred to `run()` — see
        // `install_agent_renderers` below. Each renderer holds a
        // `Weak<AppState>`, and `Arc::get_mut` (which `run()` uses
        // to install the jail) requires BOTH zero other strong refs
        // AND zero weak refs. Creating renderers here would leak
        // Weaks into the AppState refcount and crash boot.
        // NOTE: we deliberately do NOT spawn the forwarder here.
        // `run()` calls `Arc::get_mut(&mut self.state)` to install
        // the jail, which requires a strong refcount of 1. Any task
        // we spawn before `run()` could be scheduled in between and
        // briefly hold an `Arc::upgrade()`, causing the get_mut to
        // panic. `run()` spawns the forwarder itself after the
        // get_mut succeeds.
        Ok(runtime)
    }

    /// Re-attach the (possibly-swapped) backend reference into the
    /// agent runtime. Called by the backend-swap path.
    pub async fn attach_agent_backend(&self) {
        let agent = match self.state.agent.read().await.clone() {
            Some(a) => a,
            None => return,
        };
        let backend = self.state.backend.read().await.clone();
        agent
            .attach_backend(std::sync::Arc::downgrade(&backend))
            .await;
    }

    /// Install the visualize renderers onto the live agent runtime.
    /// Called from `run()` AFTER the `Arc::get_mut` jail install
    /// because both renderers hold `Weak<AppState>` references and
    /// any outstanding Weak would defeat the get_mut.
    async fn install_agent_renderers(&self) {
        let Some(agent) = self.state.agent.read().await.clone() else {
            return;
        };
        let fe_renderer = agent_render::FeRendererImpl::new(std::sync::Arc::downgrade(&self.state));
        *self.state.fe_renderer.write().await = Some(fe_renderer.clone());
        let headless_renderer =
            agent_render::HeadlessChromeRendererImpl::new(std::sync::Arc::downgrade(&self.state));
        agent_render::attach_renderers(
            &agent,
            fe_renderer as std::sync::Arc<dyn foyer_agent::tools::FeRenderer>,
            headless_renderer as std::sync::Arc<dyn foyer_agent::tools::HeadlessRenderer>,
        )
        .await;

        // Same shape for the UI director: build it once, stash on
        // AppState (so the WS dispatcher can resolve UiActionResult
        // replies), and hand it to the agent runtime.
        let ui_director = ui_director::UiDirectorImpl::new(std::sync::Arc::downgrade(&self.state));
        *self.state.ui_director.write().await = Some(ui_director.clone());
        agent
            .set_ui_director(Some(
                ui_director as std::sync::Arc<dyn foyer_agent::tools::UiDirector>,
            ))
            .await;

        // Session director — gives the `session` agent tool access to
        // open / new / close / list_open / recents / browse / backends.
        // No AppState slot needed (the impl holds Weak<AppState> and
        // doesn't need a correlation table like the UI director's),
        // so we only hand it to the runtime.
        let session_dir =
            session_director::SessionDirectorImpl::new(std::sync::Arc::downgrade(&self.state));
        agent
            .set_session_director(Some(
                session_dir as std::sync::Arc<dyn foyer_agent::tools::SessionDirector>,
            ))
            .await;

        // Spectrum director — lets `spectrum.capture_at` /
        // `capture_window` drive transport for offline FFT capture.
        // Same pattern as session director: weak ref to AppState, no
        // correlation table.
        let spectrum_dir =
            spectrum_director::SpectrumDirectorImpl::new(std::sync::Arc::downgrade(&self.state));
        agent
            .set_spectrum_director(Some(
                spectrum_dir as std::sync::Arc<dyn foyer_agent::tools::SpectrumDirector>,
            ))
            .await;
    }

    /// Load tunnel configuration from the parsed config.yaml so WS handlers
    /// can read tokens without env vars.
    pub async fn load_tunnel_config(&self, cfg: &foyer_config::TunnelConfig) {
        *self.state.tunnel_cfg.write().await = cfg.clone();
        tracing::info!(
            "tunnel config loaded — ngrok: {}, cloudflare: {}",
            if cfg.ngrok.is_some() { "yes" } else { "no" },
            if cfg.cloudflare.is_some() {
                "yes"
            } else {
                "no"
            }
        );
    }

    /// Seed the API key gating the OpenAI-compatible endpoint at
    /// `/v1/*`. `None` (or an empty string) leaves the endpoint open;
    /// any non-empty value requires `Authorization: Bearer <key>` on
    /// every `/v1/*` request. Called by `foyer-cli` once it has
    /// resolved the CLI/env/config precedence chain.
    pub async fn set_openai_proxy_api_key(&self, key: Option<String>) {
        let normalized = key.filter(|k| !k.is_empty());
        let was_set = normalized.is_some();
        *self.state.openai_proxy_api_key.write().await = normalized;
        if was_set {
            tracing::info!("/v1/* OpenAI proxy: API key required");
        } else {
            tracing::info!("/v1/* OpenAI proxy: open (no API key)");
        }
    }

    /// Control whether the `/v1/chat/completions` endpoint surfaces
    /// tool calls (`ToolStart` + `ToolEnd` lines interleaved with
    /// assistant content) to external callers. Default at construction
    /// is "off unless `FOYER_OPENAI_PROXY_SHOW_TOOL_CALLS=1`"; the CLI
    /// may override based on `config.yaml`. Independent of the API-key
    /// gate — operators that share a proxy with multiple upstream
    /// observers can keep auth on AND tool-call visibility on.
    pub fn set_openai_proxy_expose_tool_calls(&self, expose: bool) {
        self.state
            .openai_proxy_expose_tool_calls
            .store(expose, std::sync::atomic::Ordering::Relaxed);
        tracing::info!(
            "/v1/* OpenAI proxy: tool calls {}",
            if expose {
                "visible to caller"
            } else {
                "hidden"
            }
        );
    }

    /// Install the RBAC policy. CLI calls this at startup with the
    /// seeded-or-loaded `roles.yaml` contents. See `foyer_config::roles`.
    pub async fn load_roles_policy(&self, cfg: foyer_config::RolesConfig) {
        let role_ids: Vec<&str> = cfg.roles.iter().map(|r| r.id.as_str()).collect();
        tracing::info!("RBAC policy loaded — roles: [{}]", role_ids.join(", "));
        *self.state.roles_policy.write().await = cfg;
    }

    /// Replace the default backend-profile registry. The CLI calls
    /// this after collecting profiles from config so multi-DAW
    /// builds can register a Reaper / Bitwig profile alongside the
    /// builtin Ardour + Stub. Idempotent — last writer wins.
    pub async fn set_profile_registry(&self, registry: BackendProfileRegistry) {
        *self.state.profiles.write().await = Arc::new(registry);
    }

    /// Record which backend entry is currently live. Called by the CLI
    /// after it builds the initial backend from config so the picker UI
    /// knows what's active.
    pub async fn set_active_backend(&self, backend_id: impl Into<String>) {
        *self.state.active_backend_id.write().await = Some(backend_id.into());
    }

    /// Record the socket path that the initial (auto-attached) backend
    /// is talking to, when applicable. Set by the CLI when its boot
    /// path discovers an already-running shim and connects via
    /// `HostBackend::connect`. The orphan-reattach path consults this
    /// to avoid opening a duplicate IPC connection to the same shim
    /// (the shim only services one client at a time).
    pub async fn set_attached_socket(&self, path: PathBuf) {
        *self.state.attached_socket.write().await = Some(path);
    }

    /// Populate the orphan list from the session registry directory.
    /// Called by the CLI at startup so the first client to connect
    /// sees a live orphan roll-up. The server also ensures the
    /// registry directory exists so the shim's write-on-startup step
    /// doesn't race on an uncreated parent.
    pub async fn scan_orphans(&self) {
        if let Err(e) = orphans::ensure_registry_dir() {
            tracing::warn!("orphan registry dir not usable: {e}");
        }
        let profiles = self.state.profiles().await;
        let orphans = orphans::scan_orphans(profiles).await;
        if !orphans.is_empty() {
            tracing::info!("detected {} orphan session(s)", orphans.len());
        }
        *self.state.orphans.write().await = orphans;
    }

    pub async fn run(mut self, config: Config) -> Result<(), ServerError> {
        // Attach the jail if configured. Errors here are fatal — a misconfigured
        // jail should refuse to boot rather than silently allow everything.
        if let Some(root) = &config.jail_root {
            let mut jail = Jail::new(root.clone())
                .map_err(|e| ServerError::Io(std::io::Error::other(e.to_string())))?;
            // Apply the registered profiles' session extensions so
            // the picker labels Reaper / Bitwig / etc. folders too,
            // not just `.ardour` ones.
            let profiles = self.state.profiles().await;
            jail.set_session_extensions(
                profiles
                    .all_session_extensions()
                    .into_iter()
                    .map(|s| s.to_string())
                    .collect(),
            );
            Arc::get_mut(&mut self.state)
                .expect("AppState not yet shared")
                .jail = Some(jail);
            // Now safe to spawn long-lived background tasks AND
            // install renderers — `Arc::get_mut` requires zero
            // weak refs too, and the renderers each hold one.
            agent_ws::spawn_forwarder(std::sync::Arc::downgrade(&self.state));
            self.install_agent_renderers().await;
            // Canonicalize the jail root so SessionRegistry can strip
            // it from UI-facing paths. We use the canonical form
            // because `swap_backend` also canonicalizes the project
            // path — only matching forms produce a clean prefix
            // strip.
            let canonical = root.canonicalize().unwrap_or_else(|_| root.clone());
            *self.state.sessions.jail_root.write().await = Some(canonical);
            tracing::info!("file jail rooted at {}", root.display());
        } else {
            // No jail to install means no get_mut; spawn the agent
            // forwarder + install renderers here so they land
            // regardless of jail config.
            agent_ws::spawn_forwarder(std::sync::Arc::downgrade(&self.state));
            self.install_agent_renderers().await;
        }

        // Kick off the initial backend→broadcast pump and stash its
        // handle so `swap_backend` can abort it later.
        {
            let initial = self.state.backend.read().await.clone();
            let s = self.state.clone();
            let handle = tokio::spawn(async move {
                if let Err(e) = event_pump(initial, s).await {
                    tracing::error!("event pump died: {e}");
                }
            });
            *self.state.pump_handle.lock().await = Some(handle);
        }

        // Stash web_root + overlays on state so the tunnel-auth
        // listener can rebuild the same router without a separate
        // Config handoff.
        *self.state.web_root.write().await = config.web_root.clone();
        *self.state.web_overlays.write().await = config.web_overlays.clone();
        if let Some(root) = &config.web_root {
            tracing::info!("serving static files from {}", root.display());
        }
        for overlay in &config.web_overlays {
            tracing::info!("web overlay on top: {}", overlay.display());
        }

        let router = build_http_router(self.state.clone()).await;

        self.state
            .listen_port
            .store(config.listen.port(), std::sync::atomic::Ordering::Relaxed);
        self.state
            .tls_enabled
            .store(config.tls.is_some(), std::sync::atomic::Ordering::Relaxed);

        // `into_make_service_with_connect_info` lets the WS handler
        // receive the caller's `SocketAddr` via `ConnectInfo` — the
        // `upgrade` fn uses that to decide whether a client is local
        // (loopback / link-local) or remote. Without this extractor the
        // handler would have no way to see the peer address.
        let service = router.into_make_service_with_connect_info::<std::net::SocketAddr>();

        if let Some(tls) = &config.tls {
            // Pin the rustls crypto provider to `ring` so the TLS path
            // doesn't panic when multiple providers are present in the
            // dependency tree (e.g. `aws-lc-rs` pulled by another crate).
            let _ = rustls::crypto::ring::default_provider().install_default();
            // HTTPS / WSS path — required for mobile browsers on LAN
            // IPs because AudioWorklet refuses to load outside a
            // secure context. `axum-server` with `tls-rustls` uses
            // pure-Rust rustls + ring under the hood; no libssl
            // dependency, musl-clean.
            let tls_config =
                axum_server::tls_rustls::RustlsConfig::from_pem_file(&tls.cert, &tls.key)
                    .await
                    .map_err(|e| {
                        ServerError::Io(std::io::Error::other(format!(
                            "load TLS pair (cert={}, key={}): {}",
                            tls.cert.display(),
                            tls.key.display(),
                            e
                        )))
                    })?;
            tracing::info!("foyer-server listening on https://{}", config.listen);
            log_mcp_connection_snippet(&self.state, config.listen, true).await;
            axum_server::bind_rustls(config.listen, tls_config)
                .serve(service)
                .await?;
        } else {
            let listener = tokio::net::TcpListener::bind(config.listen).await?;
            tracing::info!("foyer-server listening on http://{}", config.listen);
            log_mcp_connection_snippet(&self.state, config.listen, false).await;
            axum::serve(listener, service).await?;
        }
        Ok(())
    }
}

/// Build the HTTP+WS router that both the main LAN listener and the
/// tunnel-auth listener serve. Centralizing this is what makes "tunnel
/// traffic sees the real Foyer UI, not a stub" work without
/// duplicating every route — both listeners share `AppState`, so
/// commands from either route into the same backend.
///
/// RBAC layer (future): when it lands, it will be a middleware
/// applied *only to the router instance served on the auth port* —
/// e.g. `tunnel_router.layer(TunnelRbacLayer::new(state))`. The main
/// listener's router stays untouched, preserving "LAN = trusted"
/// without a shared-surface regression risk. See DECISION 37.
pub(crate) async fn build_http_router(state: Arc<AppState>) -> Router {
    let mut router = Router::new()
        .route("/ws", get(ws::upgrade))
        .route("/ws/audio/:stream_id", get(audio_ws::upgrade))
        .route("/ws/ingress/:stream_id", get(ingress_ws::upgrade))
        // One shared WS for ALL plugin GUIs — xpra's protocol
        // already multiplexes N windows over a single connection,
        // so even with multiple editors open we hold one slot.
        // Bidirectional byte pump to local xpra TCP (default
        // 127.0.0.1:14500, override via FOYER_XPRA_ADDR).
        // Both with / without trailing slash because xpra-html5's
        // path construction is idiosyncratic across versions.
        .route("/ws/plugin-gui", get(plugin_gui_ws::upgrade))
        .route("/ws/plugin-gui/", get(plugin_gui_ws::upgrade))
        // WebLLM bridge — browser registers itself as an OpenAI-
        // compatible inference target. See DECISIONS.md 49.
        .route("/ws/webllm", get(webllm_bridge::ws_upgrade))
        .route(
            "/llm/v1/chat/completions",
            axum::routing::post(webllm_bridge::chat_completions),
        )
        .route("/llm/v1/models", get(webllm_bridge::list_models))
        .route(
            "/llm/v1/responses",
            axum::routing::post(webllm_bridge::responses_unsupported),
        )
        // OpenAI-compatible surface for the in-process agent. Lets
        // external apps (Cursor, OpenWebUI, ad-hoc Python clients,
        // …) point at Foyer like any other OpenAI endpoint and
        // inherit the full agent — tool registry, system prompt,
        // skills/memory. Auth is `Authorization: Bearer <key>` when
        // `openai_proxy_api_key` is set on AppState; open otherwise.
        .route(
            "/v1/chat/completions",
            axum::routing::post(openai_proxy::chat_completions),
        )
        .route("/v1/models", get(openai_proxy::list_models))
        .route("/files/*path", get(files::serve_file))
        // Project archive surface: upload accepts a zip or tar.gz body
        // and extracts under the jail; export tar.gz's a project
        // directory and streams it back. Both gated on jail config +
        // tunnel auth (LAN connections trusted; mirrors files.rs).
        // 1 GiB cap matches `archive::MAX_UPLOAD_BYTES` so a misuploaded
        // multi-gig audio set fails fast at the request layer instead
        // of OOM'ing during decompression.
        .route(
            "/sessions/upload",
            post(archive::upload).layer(axum::extract::DefaultBodyLimit::max(1024 * 1024 * 1024)),
        )
        .route(
            "/sessions/import_audio",
            post(import_audio::import_audio)
                .layer(axum::extract::DefaultBodyLimit::max(256 * 1024 * 1024)),
        )
        .route("/sessions/export", get(archive::export))
        .route("/console", get(console_tail))
        .route("/qr", get(qr_svg))
        // Form-login bridge for tunnel guests who reached the URL
        // without `?token=...`. POST `{email, password}` → server
        // hashes them with the same pepper, matches against the
        // tunnel manifest, and returns the matching digest token
        // (`base64url(sha256(email:password|pepper))`) on success.
        // The client then redirects with `?token=...` and the WS
        // handshake authorizes via the normal token path. Two surface
        // entry points (form, URL token); one server-side comparison.
        .route("/login", post(login_post))
        // Discovery endpoint for web UI variants — `boot.js` calls
        // this to learn which `ui-*/package.js` packages are available
        // under the served web_root, so users can drop a new variant
        // folder without editing the index.html's import map.
        .route("/variants.json", get(variants_json))
        .route("/capabilities", get(capabilities::get_capabilities))
        .route(
            "/capabilities/diff",
            post(capabilities::post_capabilities_diff),
        );

    // Dev-only integration probe harness. Gated on FOYER_DEV=1 so
    // production runs don't expose a side-channel for backend
    // mutation. Probes (see `dev.rs`) exercise the backend via the
    // same paths the WS handler uses, plus event-broadcast observation.
    if dev::enabled() {
        tracing::info!("FOYER_DEV=1 — mounting /dev/run-tests + /dev/list-tests");
        router = router
            .route("/dev/run-tests", get(dev::run_tests))
            .route("/dev/list-tests", get(dev::list_tests));
    }

    let web_root = state.web_root.read().await.clone();
    let overlays = state.web_overlays.read().await.clone();
    // Mount the MCP bridge under `/mcp` if it's been attached
    // (`attach_agent` brings it up). The mcp router carries its own
    // axum state (the FoyerMcpServer), so we nest BEFORE
    // `with_state(state)` to avoid a state-type collision.
    let mcp_route = state.mcp.read().await.clone();
    let mut router = router.with_state(state);
    if let Some(mcp) = mcp_route {
        router = router.nest("/mcp", foyer_mcp::mcp_router(mcp));
    }
    let mut router = router
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive());

    // Mount xpra's HTML5 client at `/_xpra/*` so the plugin-native-
    // ui-window's iframe can load it same-origin (no cross-origin
    // block, no second exposed port). The path is configurable via
    // FOYER_XPRA_HTML5_DIR — defaults to /usr/share/xpra/www where
    // Debian's xpra package lands the dist. If the dir doesn't
    // exist (e.g. running on a host without xpra), we skip the
    // mount; the iframe will 404 and that's the correct signal.
    let xpra_html_dir = std::env::var("FOYER_XPRA_HTML5_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/usr/share/xpra/www"));
    if xpra_html_dir.is_dir() {
        tracing::info!(
            "mounting xpra HTML5 client at /_xpra/ from {}",
            xpra_html_dir.display()
        );
        router = router.nest_service("/_xpra", ServeDir::new(&xpra_html_dir));
    } else {
        tracing::info!(
            "xpra HTML5 dir {} not present — skipping /_xpra/ mount",
            xpra_html_dir.display()
        );
    }
    // Foreign asset-pack mount. ServeDir is created against the
    // shared root dir; subpacks live at `<root>/<pack-name>/...`,
    // matching the schema's expected URL shape. ServeDir is
    // tolerant of the dir not existing yet (returns 404 for
    // everything underneath), so we can register it even on a
    // first-run install where no packs have been downloaded —
    // ServeDir will start serving the moment the asset_packs
    // module finishes an extract.
    let asset_pack_dir = asset_packs::root_dir();
    std::fs::create_dir_all(&asset_pack_dir).ok();
    tracing::info!(
        "mounting asset-pack ServeDir at /asset-packs from {}",
        asset_pack_dir.display()
    );
    router = router.nest_service("/asset-packs", ServeDir::new(&asset_pack_dir));
    // Static-asset fallback: overlays are tried first (in flag order),
    // then `web_root` as the last resort. Each overlay is composed
    // into the chain via `ServeDir::fallback`, so a miss in overlay[0]
    // cascades to overlay[1], …, then web_root. Nesting reverses the
    // iteration order because the outermost `ServeDir` is the one
    // the router hits first.
    if web_root.is_some() || !overlays.is_empty() {
        let base_path = web_root.unwrap_or_else(|| PathBuf::from("/var/empty"));
        let base = ServeDir::new(&base_path);
        // tower-http's `ServeDir::fallback` consumes self + the new
        // fallback and returns a distinctly-typed `ServeDir<F>`. For
        // N overlays that's an N-deep generic tree. We match on
        // overlay count to produce a concrete type per branch rather
        // than fight type inference in a loop. Four overlays is
        // already overkill for anyone who isn't stacking UI themes;
        // push farther via symlinked content inside a single overlay.
        match overlays.as_slice() {
            [] => {
                router = router.fallback_service(base);
            }
            [a] => {
                router = router.fallback_service(ServeDir::new(a).fallback(base));
            }
            [a, b] => {
                router = router
                    .fallback_service(ServeDir::new(a).fallback(ServeDir::new(b).fallback(base)));
            }
            [a, b, c] => {
                router = router.fallback_service(
                    ServeDir::new(a)
                        .fallback(ServeDir::new(b).fallback(ServeDir::new(c).fallback(base))),
                );
            }
            [a, b, c, d, ..] => {
                if overlays.len() > 4 {
                    tracing::warn!(
                        "{} web overlays passed; only the first 4 layer through ServeDir \
                         (symlink inside an overlay if you really need more)",
                        overlays.len()
                    );
                }
                router = router.fallback_service(
                    ServeDir::new(a).fallback(
                        ServeDir::new(b)
                            .fallback(ServeDir::new(c).fallback(ServeDir::new(d).fallback(base))),
                    ),
                );
            }
        }
    }
    router
}

/// Background task: subscribe to the backend and funnel every event into the broadcast,
/// tagging each with a server-assigned seq number and updating the snapshot cache.
async fn event_pump(
    backend: Arc<dyn Backend>,
    state: Arc<AppState>,
) -> Result<(), foyer_backend::BackendError> {
    // Capture the backend id at pump start so we can report it in a
    // BackendLost event if this pump exits naturally (not via abort()
    // from swap_backend). Early-exit here is a disconnect from the
    // client's point of view — the DAW crashed, the shim socket
    // broke, or something similar. Without the event the browser
    // sits on stale state silently.
    let pump_backend_id = state
        .active_backend_id
        .read()
        .await
        .clone()
        .unwrap_or_else(|| "unknown".to_string());

    let subscribe_result = backend.subscribe().await;
    let mut stream = match subscribe_result {
        Ok(s) => s,
        Err(e) => {
            // subscribe() failed at startup — we never got a stream.
            // Still a backend-lost from the client's POV.
            emit_backend_lost(
                &state,
                &pump_backend_id,
                format!("backend.subscribe() failed: {e}"),
            )
            .await;
            return Err(e);
        }
    };

    while let Some(event) = stream.next().await {
        let seq = state.next_seq();
        let env = Envelope {
            schema: SCHEMA_VERSION,
            api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
            seq,
            origin: Some("backend".to_string()),
            // Legacy bootstrap pump — the initial stub/launcher
            // backend isn't registered as a real session so events
            // are emitted session-less. Once a real session opens
            // (via swap_backend → registry.add), that session's
            // pump tags its own events.
            session_id: None,
            body: event,
        };
        if matches!(env.body, Event::SessionSnapshot { .. }) {
            *state.cached_snapshot.write().await = Some(env.clone());
        }
        state.ring.write().await.push(env.clone());
        // broadcast::send returns err only if there are no receivers — fine.
        let _ = state.tx.send(env);
    }

    // Stream ended cleanly. From the pump's perspective that's a lost
    // backend — the other side closed. Emit the crash event IF we're
    // still the active backend (a swap_backend would have called
    // abort() on this task before reaching here, so this check is
    // belt-and-braces in the face of an accidental race).
    let still_active = {
        let active = state.active_backend_id.read().await;
        active.as_deref() == Some(pump_backend_id.as_str())
    };
    if still_active {
        emit_backend_lost(
            &state,
            &pump_backend_id,
            "backend event stream closed".to_string(),
        )
        .await;
    }
    Ok(())
}

/// Broadcast a `BackendLost` event to every connected client.
/// Persists into the ring so late-joining clients (`?since=`) still
/// see it in the replay.
async fn emit_backend_lost(state: &Arc<AppState>, backend_id: &str, reason: String) {
    tracing::warn!(
        "backend `{}` lost — notifying clients: {}",
        backend_id,
        reason
    );
    let env = Envelope {
        schema: SCHEMA_VERSION,
        api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
        seq: state.next_seq(),
        origin: Some("server".into()),
        session_id: None,
        body: Event::BackendLost {
            backend_id: backend_id.to_string(),
            reason,
        },
    };
    state.ring.write().await.push(env.clone());
    let _ = state.tx.send(env);
}

/// Axum handler state extractor used by the ws module.
pub(crate) type SharedState = State<Arc<AppState>>;

/// Shared handle to the currently-running tunnel provider. `Arc` so
/// shutdown can be initiated from any task; `tokio::sync::Mutex` so
/// async provider methods can hold the lock across await points.
pub(crate) type SharedTunnelProvider =
    std::sync::Arc<tokio::sync::Mutex<Box<dyn crate::tunnel_provider::TunnelProvider>>>;

/// `GET /console?since=<byte-offset>` — tail the DAW stdout/stderr log.
/// Returns a JSON blob with the current file size and any bytes newer
/// than `since` (capped so a multi-megabyte log can't nuke a browser).
/// The console view polls this at a low cadence to feel live without a
/// WS upgrade just for log text.
#[derive(serde::Deserialize)]
struct ConsoleQuery {
    /// Byte offset the caller already has. Start with 0.
    #[serde(default)]
    since: u64,
}

#[derive(serde::Serialize)]
struct ConsoleReply {
    /// Total size of the log file right now.
    size: u64,
    /// Offset the next poll should pass as `since` to get only new bytes.
    next_since: u64,
    /// UTF-8 lossy chunk between `since` and `next_since`.
    chunk: String,
    /// Absolute path of the log, for debugging.
    path: String,
    /// True if the file doesn't exist yet (nothing has been logged).
    missing: bool,
}

/// `/variants.json` handler — scans the served `web_root` for
/// folders matching `ui-*` that contain a `package.js`, and returns
/// their ids. `boot.js` in the browser consumes this to dynamically
/// import each variant's package without requiring the user to edit
/// the import-map in index.html.
///
/// Shape:
/// ```json
/// { "variants": ["ui-full", "ui-touch"] }
/// ```
/// Empty list when the web_root is unset or nothing matches. Order
/// is not stable — the browser doesn't depend on order (each
/// variant's `match` score decides which one wins).
/// `POST /login` — convert a form-typed `{email, password}` into the
/// digest URL token. Server runs `verify_credentials` (hash inputs +
/// match against the tunnel manifest); on success returns the
/// `base64url(sha256(...))` token the client redirects with. On
/// failure returns 401 — no enumeration distinction between bad
/// password and unknown email, deliberately. Tunnels-disabled also
/// returns 401 to avoid leaking that detail.
///
/// This is the second entry point into the tunnel auth surface. The
/// first is the URL `?token=<digest>` query parameter consumed at WS
/// handshake. Both converge at the same stored hash comparison; the
/// difference is just which side derives the digest.
#[derive(serde::Deserialize)]
struct LoginRequest {
    email: String,
    password: String,
}

#[derive(serde::Serialize)]
struct LoginReply {
    token: String,
}

async fn login_post(
    State(state): SharedState,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<SocketAddr>,
    tunnel_origin: Option<axum::extract::Extension<crate::ws::TunnelOrigin>>,
    headers: axum::http::HeaderMap,
    axum::Json(req): axum::Json<LoginRequest>,
) -> impl IntoResponse {
    use axum::http::StatusCode;
    use axum::Json;

    // Rate-limit per-IP. On the tunnel listener every TCP peer is
    // `127.0.0.1` (cloudflared talks to us over loopback), so we
    // resolve the real client from `Cf-Connecting-IP` — cloudflared
    // sets this for every tunnel request and ignores attempts from
    // the public side to override it. We only honor proxy headers
    // when the request actually arrived via the tunnel listener; on
    // LAN we always use the connection peer, so a malicious LAN
    // client can't spoof the header to dodge the gate.
    let is_tunnel = tunnel_origin.is_some();
    let client_ip = if is_tunnel {
        client_ip_from_tunnel(&headers, peer.ip())
    } else {
        peer.ip()
    };
    if !check_login_rate(&state, client_ip).await {
        tracing::warn!("login rate limit hit for {client_ip}");
        return (StatusCode::TOO_MANY_REQUESTS, Json(serde_json::json!({}))).into_response();
    }

    if crate::tunnel::verify_credentials(&state, &req.email, &req.password)
        .await
        .is_none()
    {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({}))).into_response();
    }
    let token = crate::tunnel::token_for_credentials(&req.email, &req.password);
    (StatusCode::OK, Json(LoginReply { token })).into_response()
}

/// Extract the real tunnel client IP from `Cf-Connecting-IP`, or
/// `X-Forwarded-For` as a last resort. Cloudflare's edge always sets
/// `cf-connecting-ip` to the originating client and strips any value
/// the public side tried to inject, so it's the trustworthy header
/// here. Only call this when we know the request came in via the
/// tunnel listener.
/// Probe `$PATH` (and a small set of common absolute paths) for an
/// `xpra` executable. Native plugin GUI projection requires xpra:
///   * `/ws/plugin-gui` proxy connects to a localhost xpra TCP
///     socket xpra is expected to be running on
///   * `/_xpra/` static mount serves xpra's HTML5 dist
///
/// If absent we still boot fine — we just hide the toggle in the UI
/// via the `native_plugin_gui` feature flag. Logged once at startup
/// with an install link so users on a fresh machine know what to do.
/// Boolean read of an env var — "1", "true", "yes", "on" (case
/// insensitive) → true. Anything else (including unset) → false.
/// Used by config flags that default off but can be flipped via env.
fn env_truthy(name: &str) -> bool {
    matches!(
        std::env::var(name)
            .ok()
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

fn probe_xpra_available() -> bool {
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':').filter(|d| !d.is_empty()) {
            let candidate = std::path::Path::new(dir).join("xpra");
            if candidate.is_file() {
                tracing::info!(
                    "native plugin GUI projection: xpra found at {}",
                    candidate.display()
                );
                return true;
            }
        }
    }
    for p in &["/usr/bin/xpra", "/usr/local/bin/xpra", "/opt/xpra/bin/xpra"] {
        if std::path::Path::new(p).is_file() {
            tracing::info!("native plugin GUI projection: xpra found at {p}");
            return true;
        }
    }
    tracing::info!(
        "native plugin GUI projection: xpra NOT found on PATH — \
         the Native GUI toggle will be hidden in the UI. To enable, \
         install xpra (https://xpra.org/install.html). \
         Quick install:\n  \
           Debian/Ubuntu:  sudo apt install xpra xpra-html5  (Debian trixie: see docs/USAGE.md for the xpra.org repo)\n  \
           Fedora/RHEL:    sudo dnf install xpra\n  \
           Arch:           sudo pacman -S xpra\n  \
           macOS:          brew install --cask xpra"
    );
    false
}

fn client_ip_from_tunnel(headers: &axum::http::HeaderMap, peer: IpAddr) -> IpAddr {
    if let Some(v) = headers
        .get("cf-connecting-ip")
        .and_then(|v| v.to_str().ok())
    {
        if let Ok(ip) = v.parse() {
            return ip;
        }
    }
    if let Some(v) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = v.split(',').next() {
            if let Ok(ip) = first.trim().parse() {
                return ip;
            }
        }
    }
    peer
}

/// Returns true if this IP is allowed to attempt a login right now.
/// Sliding window: bucket resets after `LOGIN_WINDOW` has elapsed
/// since the first attempt in the current window.
async fn check_login_rate(state: &AppState, ip: IpAddr) -> bool {
    let mut gate = state.login_gate.lock().await;
    let now = Instant::now();
    let entry = gate.entry(ip).or_insert(LoginAttempts {
        count: 0,
        window_start: now,
    });
    if now.duration_since(entry.window_start) > LOGIN_WINDOW {
        entry.count = 0;
        entry.window_start = now;
    }
    entry.count = entry.count.saturating_add(1);
    // Best-effort housekeeping: drop entries from IPs that haven't
    // been seen in a while so the map can't grow without bound from
    // a slow scan attack.
    if gate.len() > 1024 {
        gate.retain(|_, e| now.duration_since(e.window_start) <= LOGIN_WINDOW);
    }
    let allowed = gate
        .get(&ip)
        .map(|e| e.count <= LOGIN_MAX_PER_WINDOW)
        .unwrap_or(true);
    allowed
}

async fn variants_json(State(state): SharedState) -> impl IntoResponse {
    use axum::Json;
    #[derive(serde::Serialize)]
    struct Reply {
        variants: Vec<String>,
    }
    // Scan order mirrors asset-serve priority: overlays first (in
    // flag order) then web_root. A `ui-*` dropped into an overlay
    // surfaces in boot.js without editing the main repo; duplicates
    // dedup so an overlay that shadows a base variant wins (handled
    // by the serve layer) and still only appears once in the
    // discovery list.
    let overlays = state.web_overlays.read().await.clone();
    let base = state.web_root.read().await.clone();
    let roots: Vec<PathBuf> = overlays.into_iter().chain(base).collect();
    if roots.is_empty() {
        return Json(Reply { variants: vec![] });
    }
    let mut seen = std::collections::BTreeSet::new();
    for root in &roots {
        let Ok(iter) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in iter.flatten() {
            let Ok(ty) = entry.file_type() else { continue };
            if !ty.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let Some(name_str) = name.to_str() else {
                continue;
            };
            if !name_str.starts_with("ui-") {
                continue;
            }
            // Reserved names that share the "ui-" prefix but aren't
            // UI variants (they're shared primitives / utility
            // folders). The discovery contract is purely name-based
            // so alt-UI authors don't have to grep code to know
            // which ids are safe.
            if matches!(name_str, "ui-core" | "ui-tests") {
                continue;
            }
            if !entry.path().join("package.js").is_file() {
                continue;
            }
            seen.insert(name_str.to_string());
        }
    }
    Json(Reply {
        variants: seen.into_iter().collect(),
    })
}

async fn console_tail(
    State(_state): SharedState,
    axum::extract::Query(q): axum::extract::Query<ConsoleQuery>,
) -> impl IntoResponse {
    use axum::Json;
    // Log path mirrors what foyer-cli writes to. Kept in sync manually
    // — both resolve `$XDG_STATE_HOME/foyer/daw.log`. Hard-wired here
    // instead of plumbing through CLI config because the server is the
    // natural HTTP surface and the cost of a re-resolve is a syscall.
    let base = dirs::state_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let path = base.join("foyer").join("daw.log");
    let size = match std::fs::metadata(&path) {
        Ok(m) => m.len(),
        Err(_) => {
            return Json(ConsoleReply {
                size: 0,
                next_since: 0,
                chunk: String::new(),
                path: path.display().to_string(),
                missing: true,
            });
        }
    };
    let from = q.since.min(size);
    // Cap per-poll read so a huge log can't stall the client. The next
    // poll picks up the tail.
    const MAX_CHUNK: u64 = 256 * 1024;
    let to = (from + MAX_CHUNK).min(size);
    let chunk = match read_range(&path, from, to) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => String::new(),
    };
    Json(ConsoleReply {
        size,
        next_since: to,
        chunk,
        path: path.display().to_string(),
        missing: false,
    })
}

/// `GET /qr?data=<url>` — render the provided text as a QR code SVG.
/// Used by the "share session" button: client picks the URL (which can
/// include the sidecar's LAN IP), hits this endpoint, gets back an SVG
/// it can drop into a modal. Server-side so there's no QR library to
/// vendor for the browser.
#[derive(serde::Deserialize)]
struct QrQuery {
    data: String,
}

async fn qr_svg(
    State(_state): SharedState,
    axum::extract::Query(q): axum::extract::Query<QrQuery>,
) -> impl IntoResponse {
    use qrcode::render::svg;
    use qrcode::{EcLevel, QrCode};

    // Low error-correction is fine for connection URLs (short payload,
    // high-quality on-screen rendering). Size the SVG module to something
    // that reads well at ~300px on a phone screen.
    let svg = match QrCode::with_error_correction_level(q.data.as_bytes(), EcLevel::L) {
        Ok(code) => code
            .render::<svg::Color<'_>>()
            .min_dimensions(256, 256)
            .dark_color(svg::Color("#f8fafc"))
            .light_color(svg::Color("#0f172a"))
            .build(),
        Err(e) => format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 240 240\">\
             <rect width=\"240\" height=\"240\" fill=\"#0f172a\"/>\
             <text x=\"20\" y=\"120\" fill=\"#ef4444\" font-family=\"monospace\" font-size=\"10\">\
             qr error: {e}</text></svg>"
        ),
    };
    ([(axum::http::header::CONTENT_TYPE, "image/svg+xml")], svg)
}

fn read_range(path: &std::path::Path, from: u64, to: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    if from > 0 {
        f.seek(SeekFrom::Start(from))?;
    }
    let mut buf = vec![0u8; (to - from) as usize];
    let n = f.read(&mut buf)?;
    buf.truncate(n);
    Ok(buf)
}
