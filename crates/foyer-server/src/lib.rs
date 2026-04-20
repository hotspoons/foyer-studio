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
mod dev;
mod files;
mod jail;
mod ring;
mod ws;

pub use jail::{Jail, JailError};

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use foyer_backend::Backend;
use foyer_schema::{BackendInfo, Envelope, Event, SCHEMA_VERSION};
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
    /// Filesystem jail for the browser / session picker. When `None`, remote
    /// clients cannot browse the host's filesystem at all — `BrowsePath`
    /// returns an error.
    pub jail_root: Option<PathBuf>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen: "127.0.0.1:3838".parse().unwrap(),
            web_root: None,
            jail_root: None,
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
    pub(crate) ring: RwLock<DeltaRing>,
    /// Monotonic sequence counter.
    pub(crate) next_seq: AtomicU64,
    /// Active backend. Wrapped in RwLock so the sidecar can swap
    /// backends at runtime (e.g. picker → open project → spawn Ardour
    /// → swap). WS handlers call `backend().await` to get a cheap
    /// `Arc<dyn Backend>` clone without holding the lock across an
    /// async backend call.
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
    /// M6a audio egress hub. Holds live encoder pipelines keyed by
    /// `stream_id`; the `/ws/audio/:stream_id` route subscribes to
    /// its broadcasts. Shared across all connections.
    pub(crate) audio_hub: Arc<audio::AudioHub>,
}

impl AppState {
    fn next_seq(&self) -> u64 {
        self.next_seq.fetch_add(1, Ordering::Relaxed)
    }

    pub(crate) async fn current_snapshot(&self) -> Option<Envelope<Event>> {
        self.cached_snapshot.read().await.clone()
    }

    /// Get a cheap clone of the current backend trait-object. Release
    /// the read lock before awaiting anything on the returned `Arc`
    /// so a concurrent `swap_backend` isn't blocked on us.
    pub(crate) async fn backend(&self) -> Arc<dyn Backend> {
        self.backend.read().await.clone()
    }

    /// Swap the active backend. Aborts the old event pump, starts a new
    /// one subscribed to `next`, drops the cached snapshot (so the next
    /// `SessionSnapshot` from the new backend re-seeds it), and emits a
    /// `BackendSwapped` event to all connected clients.
    pub(crate) async fn swap_backend(
        self: &Arc<Self>,
        backend_id: String,
        project_path: Option<String>,
        next: Arc<dyn Backend>,
    ) {
        *self.backend.write().await = next.clone();
        *self.active_backend_id.write().await = Some(backend_id.clone());
        *self.cached_snapshot.write().await = None;

        // Restart pump against the new backend.
        let mut slot = self.pump_handle.lock().await;
        if let Some(h) = slot.take() {
            h.abort();
        }
        let s = self.clone();
        *slot = Some(tokio::spawn(async move {
            if let Err(e) = event_pump(next, s).await {
                tracing::error!("event pump died: {e}");
            }
        }));
        drop(slot);

        // Tell all clients to re-snapshot. The swap event goes through
        // the same broadcast + ring as every other event so `?since=`
        // reconnects replay it.
        let env = Envelope {
            schema: SCHEMA_VERSION,
            seq: self.next_seq(),
            origin: Some("server".into()),
            body: Event::BackendSwapped {
                backend_id,
                project_path,
            },
        };
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
        let state = Arc::new(AppState {
            cached_snapshot: RwLock::new(None),
            tx,
            ring: RwLock::new(DeltaRing::new(RING_CAP)),
            next_seq: AtomicU64::new(1),
            backend: RwLock::new(backend),
            active_backend_id: RwLock::new(None),
            spawner,
            pump_handle: Mutex::new(None),
            jail: None,
            listen_port: std::sync::atomic::AtomicU16::new(0),
            audio_hub: Arc::new(audio::AudioHub::new()),
        });
        Self { state }
    }

    /// Record which backend entry is currently live. Called by the CLI
    /// after it builds the initial backend from config so the picker UI
    /// knows what's active.
    pub async fn set_active_backend(&self, backend_id: impl Into<String>) {
        *self.state.active_backend_id.write().await = Some(backend_id.into());
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

        let mut router = Router::new()
            .route("/ws", get(ws::upgrade))
            .route("/ws/audio/:stream_id", get(audio_ws::upgrade))
            .route("/files/*path", get(files::serve_file))
            .route("/console", get(console_tail))
            .route("/qr", get(qr_svg));

        // Dev-only integration probe harness. Gated on FOYER_DEV=1 so
        // production runs don't expose a side-channel for backend
        // mutation. Probes (see `dev.rs`) exercise the backend via
        // the same paths the WS handler uses, plus event-broadcast
        // observation where applicable.
        if dev::enabled() {
            tracing::info!("FOYER_DEV=1 — mounting /dev/run-tests + /dev/list-tests");
            router = router
                .route("/dev/run-tests", get(dev::run_tests))
                .route("/dev/list-tests", get(dev::list_tests));
        }

        let mut router = router
            .with_state(self.state.clone())
            .layer(TraceLayer::new_for_http())
            .layer(CorsLayer::permissive());

        if let Some(root) = config.web_root.clone() {
            tracing::info!("serving static files from {}", root.display());
            router = router.fallback_service(ServeDir::new(root));
        }

        let listener = tokio::net::TcpListener::bind(config.listen).await?;
        self.state
            .listen_port
            .store(config.listen.port(), std::sync::atomic::Ordering::Relaxed);
        tracing::info!("foyer-server listening on http://{}", config.listen);
        // `into_make_service_with_connect_info` lets the WS handler
        // receive the caller's `SocketAddr` via `ConnectInfo` — the
        // `upgrade` fn uses that to decide whether a client is local
        // (loopback / link-local) or remote. Without this extractor the
        // handler would have no way to see the peer address.
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await?;
        Ok(())
    }
}

/// Background task: subscribe to the backend and funnel every event into the broadcast,
/// tagging each with a server-assigned seq number and updating the snapshot cache.
async fn event_pump(
    backend: Arc<dyn Backend>,
    state: Arc<AppState>,
) -> Result<(), foyer_backend::BackendError> {
    let mut stream = backend.subscribe().await?;
    while let Some(event) = stream.next().await {
        let seq = state.next_seq();
        let env = Envelope {
            schema: SCHEMA_VERSION,
            seq,
            origin: Some("backend".to_string()),
            body: event,
        };
        if matches!(env.body, Event::SessionSnapshot { .. }) {
            *state.cached_snapshot.write().await = Some(env.clone());
        }
        state.ring.write().await.push(env.clone());
        // broadcast::send returns err only if there are no receivers — fine.
        let _ = state.tx.send(env);
    }
    Ok(())
}

/// Axum handler state extractor used by the ws module.
pub(crate) type SharedState = State<Arc<AppState>>;

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
    (
        [(axum::http::header::CONTENT_TYPE, "image/svg+xml")],
        svg,
    )
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
