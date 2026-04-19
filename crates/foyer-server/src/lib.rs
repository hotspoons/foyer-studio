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

mod files;
mod jail;
mod ring;
mod ws;

pub use jail::{Jail, JailError};

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::routing::get;
use axum::Router;
use foyer_backend::Backend;
use foyer_schema::{Envelope, Event, SCHEMA_VERSION};
use futures::StreamExt;
use tokio::sync::{broadcast, RwLock};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

pub use ring::DeltaRing;

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
    /// Client command dispatcher.
    pub(crate) backend: Arc<dyn Backend>,
    /// Optional filesystem jail for the session picker.
    pub(crate) jail: Option<Jail>,
}

impl AppState {
    fn next_seq(&self) -> u64 {
        self.next_seq.fetch_add(1, Ordering::Relaxed)
    }

    pub(crate) async fn current_snapshot(&self) -> Option<Envelope<Event>> {
        self.cached_snapshot.read().await.clone()
    }
}

pub struct Server {
    state: Arc<AppState>,
}

impl Server {
    pub fn new<B: Backend + 'static>(backend: B) -> Self {
        let (tx, _) = broadcast::channel(BROADCAST_CAP);
        let state = Arc::new(AppState {
            cached_snapshot: RwLock::new(None),
            tx,
            ring: RwLock::new(DeltaRing::new(RING_CAP)),
            next_seq: AtomicU64::new(1),
            backend: Arc::new(backend),
            jail: None,
        });
        Self { state }
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

        // Kick off the backend→broadcast pump.
        let pump_state = self.state.clone();
        let backend = self.state.backend.clone();
        tokio::spawn(async move {
            if let Err(e) = event_pump(backend, pump_state).await {
                tracing::error!("event pump died: {e}");
            }
        });

        let mut router = Router::new()
            .route("/ws", get(ws::upgrade))
            .route("/files/*path", get(files::serve_file))
            .with_state(self.state.clone())
            .layer(TraceLayer::new_for_http())
            .layer(CorsLayer::permissive());

        if let Some(root) = config.web_root.clone() {
            tracing::info!("serving static files from {}", root.display());
            router = router.fallback_service(ServeDir::new(root));
        }

        let listener = tokio::net::TcpListener::bind(config.listen).await?;
        tracing::info!("foyer-server listening on http://{}", config.listen);
        axum::serve(listener, router).await?;
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
