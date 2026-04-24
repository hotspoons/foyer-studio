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

mod audio;
mod audio_opus;
mod audio_ws;
mod cloudflare_api;
mod cloudflare_provider;
mod cloudflared_dl;
mod dev;
mod files;
mod ingress_ws;
mod jail;
pub mod orphans;
mod ring;
mod sessions;
mod tunnel;
mod tunnel_provider;
pub(crate) mod ws;

pub use jail::{Jail, JailError};

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
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
    /// — the spawner decides how to resolve it).
    async fn launch(
        &self,
        backend_id: &str,
        project_path: Option<&Path>,
    ) -> anyhow::Result<Arc<dyn Backend>>;
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
            listen: "127.0.0.1:3838".parse().unwrap(),
            web_root: None,
            web_overlays: Vec::new(),
            jail_root: None,
            tls: None,
        }
    }
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
    /// Background task that pumps events from the current backend into
    /// the broadcast channel. Stored so `swap_backend` can abort and
    /// respawn it when the backend changes.
    pub(crate) pump_handle: Mutex<Option<JoinHandle<()>>>,
    /// Optional filesystem jail for the session picker.
    pub(crate) jail: Option<Jail>,
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
    /// M6b ingress senders. Keyed by `stream_id`; browser pushes
    /// binary PCM to `/ws/ingress/:stream_id`, and the task there
    /// forwards frames into this `mpsc::Sender`. Dropping the entry
    /// (on `AudioIngressClose` or server restart) closes the channel
    /// and the backend tears the sink down from its side.
    pub(crate) ingress_senders: Mutex<HashMap<u32, PcmTx>>,
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
    /// Live connection roster, keyed by the server-assigned
    /// connection id. Populated by the WS `handle()` on connect and
    /// pruned on disconnect; broadcast to every client via
    /// `PeerJoined` / `PeerLeft` / `PeerList` events. Gives the status
    /// bar a reliable "who's here" view that — unlike the old
    /// origin-sniffing — includes tunnel guests and quiet observers.
    pub(crate) peers: RwLock<HashMap<String, foyer_schema::PeerInfo>>,
    /// Operator pin for the UI variant every browser should load —
    /// e.g. `Some("touch")` on a kiosk deployment, `Some("kids")` on
    /// a family workstation. `None` lets each browser pick via
    /// `?ui=` URL override, localStorage preference, or its own
    /// heuristic match. Broadcast in `ClientGreeting.default_ui_variant`.
    pub(crate) default_ui_variant: Option<String>,
}

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
            seq: self.next_seq(),
            origin: Some("server".into()),
            session_id,
            body,
        }
    }

    pub(crate) async fn current_snapshot(&self) -> Option<Envelope<Event>> {
        self.cached_snapshot.read().await.clone()
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
    pub(crate) async fn swap_backend(
        self: &Arc<Self>,
        backend_id: String,
        project_path: Option<String>,
        next: Arc<dyn Backend>,
        session_id: Option<EntityId>,
        session_name: Option<String>,
    ) {
        *self.backend.write().await = next.clone();
        *self.active_backend_id.write().await = Some(backend_id.clone());
        *self.cached_snapshot.write().await = None;

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
        let path = project_path.clone().unwrap_or_default();
        self.sessions
            .clone()
            .add(sid.clone(), backend_id.clone(), next, path, name)
            .await;
        // Newly-opened session automatically becomes the focus
        // target so untagged commands flow to it. User can switch
        // away via `SelectSession`.
        *self.focus_session_id.write().await = Some(sid);

        // Tell all clients to re-snapshot. The swap event goes through
        // the same broadcast + ring as every other event so `?since=`
        // reconnects replay it.
        let env = self.envelope(
            Event::BackendSwapped {
                backend_id,
                project_path,
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
        let ring = Arc::new(RwLock::new(DeltaRing::new(RING_CAP)));
        let next_seq = Arc::new(AtomicU64::new(1));
        let sessions = Arc::new(SessionRegistry::new(
            tx.clone(),
            ring.clone(),
            next_seq.clone(),
        ));
        let state = Arc::new(AppState {
            cached_snapshot: RwLock::new(None),
            tx,
            ring,
            next_seq,
            backend: RwLock::new(backend),
            active_backend_id: RwLock::new(None),
            spawner,
            pump_handle: Mutex::new(None),
            jail: None,
            listen_port: std::sync::atomic::AtomicU16::new(0),
            tls_enabled: std::sync::atomic::AtomicBool::new(false),
            audio_hub: Arc::new(audio::AudioHub::new()),
            ingress_senders: Mutex::new(HashMap::new()),
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
            default_ui_variant: None,
        });
        Self { state }
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

    /// Install the RBAC policy. CLI calls this at startup with the
    /// seeded-or-loaded `roles.yaml` contents. See `foyer_config::roles`.
    pub async fn load_roles_policy(&self, cfg: foyer_config::RolesConfig) {
        let role_ids: Vec<&str> = cfg.roles.iter().map(|r| r.id.as_str()).collect();
        tracing::info!("RBAC policy loaded — roles: [{}]", role_ids.join(", "));
        *self.state.roles_policy.write().await = cfg;
    }

    /// Record which backend entry is currently live. Called by the CLI
    /// after it builds the initial backend from config so the picker UI
    /// knows what's active.
    pub async fn set_active_backend(&self, backend_id: impl Into<String>) {
        *self.state.active_backend_id.write().await = Some(backend_id.into());
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
        let orphans = orphans::scan_orphans().await;
        if !orphans.is_empty() {
            tracing::info!("detected {} orphan session(s)", orphans.len());
        }
        *self.state.orphans.write().await = orphans;
    }

    pub async fn run(mut self, config: Config) -> Result<(), ServerError> {
        // Attach the jail if configured. Errors here are fatal — a misconfigured
        // jail should refuse to boot rather than silently allow everything.
        if let Some(root) = &config.jail_root {
            let jail = Jail::new(root.clone())
                .map_err(|e| ServerError::Io(std::io::Error::other(e.to_string())))?;
            Arc::get_mut(&mut self.state)
                .expect("AppState not yet shared")
                .jail = Some(jail);
            tracing::info!("file jail rooted at {}", root.display());
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
            axum_server::bind_rustls(config.listen, tls_config)
                .serve(service)
                .await?;
        } else {
            let listener = tokio::net::TcpListener::bind(config.listen).await?;
            tracing::info!("foyer-server listening on http://{}", config.listen);
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
        .route("/files/*path", get(files::serve_file))
        .route("/console", get(console_tail))
        .route("/qr", get(qr_svg))
        // Discovery endpoint for web UI variants — `boot.js` calls
        // this to learn which `ui-*/package.js` packages are available
        // under the served web_root, so users can drop a new variant
        // folder without editing the index.html's import map.
        .route("/variants.json", get(variants_json));

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
    let mut router = router
        .with_state(state)
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive());
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
