//! Multi-session registry.
//!
//! Holds every currently-attached backend keyed by session UUID. The
//! WS layer uses this to route commands by `session_id` and the event
//! pump layer uses it to tag outbound events with their source
//! session. One pump runs per session; all pumps fan into the same
//! broadcast channel so the existing fan-out infrastructure stays
//! unchanged.
//!
//! Session IDs are canonical `EntityId`s that match the UUID the shim
//! writes into the `.ardour` file's extra_xml. Reopening the same
//! project from disk always resolves to the same session id, so
//! "already open" detection is just a path → session_id lookup in
//! this registry.
//!
//! Lifecycle:
//!   * `add(...)` — inserts a new session, spawns its event pump,
//!     emits `Event::SessionOpened`.
//!   * `close(id)` — aborts the pump, drops the backend, emits
//!     `Event::SessionClosed`. Event pump never closes the backend
//!     itself; only explicit `close()` calls or the backend's own
//!     natural disconnect do.
//!   * `find_by_path(...)` — for the "already open" check.
//!
//! Per-connection state (which session the WS connection is currently
//! viewing) lives in the WS handler, not here — this registry is
//! server-wide shared state.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use foyer_backend::Backend;
use foyer_schema::{EntityId, Envelope, Event, SessionInfo, SCHEMA_VERSION};
use futures::StreamExt;
use tokio::sync::{broadcast, RwLock};
use tokio::task::JoinHandle;

use crate::ring::DeltaRing;

pub(crate) struct SessionEntry {
    pub id: EntityId,
    pub backend_id: String,
    pub backend: Arc<dyn Backend>,
    pub path: String,
    pub name: String,
    pub opened_at: u64,
    pub dirty: Arc<AtomicBool>,
    pump: JoinHandle<()>,
}

impl SessionEntry {
    pub(crate) fn to_info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            backend_id: self.backend_id.clone(),
            path: self.path.clone(),
            name: self.name.clone(),
            opened_at: self.opened_at,
            dirty: self.dirty.load(Ordering::Relaxed),
        }
    }
}

pub(crate) struct SessionRegistry {
    pub(crate) sessions: RwLock<HashMap<EntityId, SessionEntry>>,
    pub(crate) tx: broadcast::Sender<Envelope<Event>>,
    pub(crate) ring: Arc<RwLock<DeltaRing>>,
    pub(crate) next_seq: Arc<AtomicU64>,
    /// Jail root for this session registry. Kept so outbound paths
    /// can be stripped to jail-relative form on the wire even
    /// though the registry stores canonical absolutes internally.
    /// `None` = no jail → leave paths as-is.
    pub(crate) jail_root: RwLock<Option<PathBuf>>,
}

impl SessionRegistry {
    pub(crate) fn new(
        tx: broadcast::Sender<Envelope<Event>>,
        ring: Arc<RwLock<DeltaRing>>,
        next_seq: Arc<AtomicU64>,
    ) -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            tx,
            ring,
            next_seq,
            jail_root: RwLock::new(None),
        }
    }

    /// Convert an absolute (or already-relative) path to the
    /// jail-relative form UI consumers should ever see. Absolute
    /// paths outside the jail, or paths that don't start with the
    /// jail prefix, fall through unchanged — that's better than
    /// silently returning an empty string.
    pub(crate) async fn jail_display_path(&self, path: &str) -> String {
        let root = self.jail_root.read().await.clone();
        let Some(root) = root else {
            return path.to_string();
        };
        let Some(root_str) = root.to_str() else {
            return path.to_string();
        };
        if let Some(stripped) = path.strip_prefix(root_str) {
            return stripped.trim_start_matches('/').to_string();
        }
        path.to_string()
    }

    /// Append a new session. Spawns the event pump against this
    /// backend and broadcasts `Event::SessionOpened`. Returns the
    /// session's id (caller-supplied so the shim can pre-generate
    /// UUIDs and persist them into the .ardour file before the
    /// sidecar knows they exist).
    pub(crate) async fn add(
        self: &Arc<Self>,
        id: EntityId,
        backend_id: String,
        backend: Arc<dyn Backend>,
        path: String,
        name: String,
    ) -> EntityId {
        let opened_at = now_secs();
        let dirty = Arc::new(AtomicBool::new(false));
        let pump = {
            let backend = backend.clone();
            let id = id.clone();
            let reg = self.clone();
            let dirty = dirty.clone();
            tokio::spawn(async move {
                if let Err(e) = pump_session(backend, reg, id, dirty).await {
                    tracing::warn!("session pump exited with error: {e}");
                }
            })
        };
        let entry = SessionEntry {
            id: id.clone(),
            backend_id: backend_id.clone(),
            backend,
            path,
            name,
            opened_at,
            dirty,
            pump,
        };
        // Strip the jail prefix before we broadcast — UI-facing paths
        // never include the jail root (PLAN 162). Internal lookups
        // (find_by_path during "already open?") still use the
        // stored canonical absolute, so both relative and absolute
        // callers land on the same session entry.
        let mut info = entry.to_info();
        info.path = self.jail_display_path(&info.path).await;
        self.sessions.write().await.insert(id.clone(), entry);
        // Broadcast open + updated list so UIs can slot the new
        // session into the switcher without a full refresh.
        self.broadcast_event(Event::SessionOpened { session: info })
            .await;
        self.broadcast_event(Event::SessionList {
            sessions: self.list().await,
        })
        .await;
        id
    }

    /// Remove a session. Aborts its pump and drops its backend.
    /// Emits `Event::SessionClosed` + an updated `Event::SessionList`.
    pub(crate) async fn close(&self, id: &EntityId) -> Option<SessionInfo> {
        let removed = self.sessions.write().await.remove(id);
        match removed {
            Some(entry) => {
                entry.pump.abort();
                let info = entry.to_info();
                // Drop the backend (last Arc release closes the shim
                // socket when the backend's own Drop runs).
                drop(entry.backend);
                self.broadcast_event(Event::SessionClosed {
                    session_id: id.clone(),
                })
                .await;
                self.broadcast_event(Event::SessionList {
                    sessions: self.list().await,
                })
                .await;
                Some(info)
            }
            None => None,
        }
    }

    /// Remove a session after its backend stream ended naturally.
    /// Unlike `close()`, this does not abort the pump task because the
    /// caller is the pump itself.
    async fn close_after_disconnect(&self, id: &EntityId) -> Option<SessionInfo> {
        let removed = self.sessions.write().await.remove(id);
        match removed {
            Some(entry) => {
                let info = entry.to_info();
                drop(entry.backend);
                self.broadcast_event(Event::SessionClosed {
                    session_id: id.clone(),
                })
                .await;
                self.broadcast_event(Event::SessionList {
                    sessions: self.list().await,
                })
                .await;
                Some(info)
            }
            None => None,
        }
    }

    /// Look up a session by its canonical path. Used so opening the
    /// same project twice just raises the existing session instead of
    /// launching a second shim. Compares with a simple string equality
    /// after the caller canonicalizes.
    #[allow(dead_code)] // wired in with the "already open" detection slice
    pub(crate) async fn find_by_path(&self, path: &str) -> Option<EntityId> {
        self.sessions
            .read()
            .await
            .values()
            .find(|e| e.path == path)
            .map(|e| e.id.clone())
    }

    /// Get the backend for a specific session, or `None` if no such
    /// session. Used by the WS command router.
    pub(crate) async fn backend(&self, id: &EntityId) -> Option<Arc<dyn Backend>> {
        self.sessions
            .read()
            .await
            .get(id)
            .map(|e| e.backend.clone())
    }

    /// Get a live snapshot of every session, suitable for
    /// `Event::SessionList`.
    pub(crate) async fn list(&self) -> Vec<SessionInfo> {
        let mut infos: Vec<_> = self
            .sessions
            .read()
            .await
            .values()
            .map(SessionEntry::to_info)
            .collect();
        // Strip jail prefix on the way out — UI never sees absolute
        // paths (PLAN 162). Do this after collecting so we release
        // the read lock before calling jail_display_path (which
        // takes the jail_root RwLock).
        for info in &mut infos {
            info.path = self.jail_display_path(&info.path).await;
        }
        infos.sort_by_key(|i| i.opened_at);
        infos
    }

    /// Returns the *most recently opened* session id (or `None`).
    /// Used when a WS connection hasn't explicitly picked one — we
    /// default it to whatever was most recently added.
    pub(crate) async fn most_recent_id(&self) -> Option<EntityId> {
        let map = self.sessions.read().await;
        map.values()
            .max_by_key(|e| e.opened_at)
            .map(|e| e.id.clone())
    }

    /// Returns true if the session with `id` still exists. Used by the
    /// WS layer to validate a client's currently-selected session
    /// after events that might have closed it.
    #[allow(dead_code)] // wired in with per-connection selection routing
    pub(crate) async fn has(&self, id: &EntityId) -> bool {
        self.sessions.read().await.contains_key(id)
    }

    async fn broadcast_event(&self, body: Event) {
        let env = Envelope {
            schema: SCHEMA_VERSION,
            seq: self.next_seq.fetch_add(1, Ordering::Relaxed),
            origin: Some("server".into()),
            session_id: None,
            body,
        };
        self.ring.write().await.push(env.clone());
        let _ = self.tx.send(env);
    }
}

/// Per-session event pump. Subscribes to the backend and fans events
/// into the global broadcast, tagging each envelope with
/// `session_id`. On graceful stream close (natural disconnect), emits
/// `Event::BackendLost` + `Event::SessionClosed` so the UI can react.
///
/// When the stream exits naturally we remove the session entry so
/// "already open by path" checks cannot focus a dead backend.
async fn pump_session(
    backend: Arc<dyn Backend>,
    reg: Arc<SessionRegistry>,
    session_id: EntityId,
    dirty: Arc<AtomicBool>,
) -> Result<(), foyer_backend::BackendError> {
    let mut stream = backend.subscribe().await?;
    while let Some(event) = stream.next().await {
        // Mirror dirty-state changes onto the entry so
        // `SessionInfo.dirty` stays fresh without polling.
        if let Event::SessionDirtyChanged { dirty: d } = &event {
            dirty.store(*d, Ordering::Relaxed);
        }
        let seq = reg.next_seq.fetch_add(1, Ordering::Relaxed);
        let env = Envelope {
            schema: SCHEMA_VERSION,
            seq,
            origin: Some("backend".into()),
            session_id: Some(session_id.clone()),
            body: event,
        };
        reg.ring.write().await.push(env.clone());
        let _ = reg.tx.send(env);
    }
    // Stream ended — shim disconnected or similar. Emit BackendLost
    // so the UI can show "lost connection" for this tile, and also
    // broadcast an updated session list so the switcher can fall
    // through to another session.
    let lost = Envelope {
        schema: SCHEMA_VERSION,
        seq: reg.next_seq.fetch_add(1, Ordering::Relaxed),
        origin: Some("server".into()),
        session_id: Some(session_id.clone()),
        body: Event::BackendLost {
            backend_id: "unknown".into(),
            reason: "backend event stream closed".into(),
        },
    };
    reg.ring.write().await.push(lost.clone());
    let _ = reg.tx.send(lost);
    let _ = reg.close_after_disconnect(&session_id).await;
    Ok(())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
