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
use tokio::sync::{broadcast, Mutex, RwLock};
use tokio::task::JoinHandle;

use crate::ring::DeltaRing;
use crate::ProcessHandle;

pub(crate) struct SessionEntry {
    pub id: EntityId,
    pub backend_id: String,
    pub backend: Arc<dyn Backend>,
    pub path: String,
    pub name: String,
    pub opened_at: u64,
    pub dirty: Arc<AtomicBool>,
    pump: JoinHandle<()>,
    /// Handle to the host shim's child process, when the spawner
    /// forked one (Ardour). `None` for in-process backends. Held in
    /// a Mutex because `close()` takes ownership to drive the
    /// SIGTERM/SIGKILL escalation on a detached task — we don't want
    /// to block close() on the wait window.
    pub process: Mutex<Option<Box<dyn ProcessHandle>>>,
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
        process: Option<Box<dyn ProcessHandle>>,
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
            process: Mutex::new(process),
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

    /// Remove a session. Aborts its pump, asks the backend to quit
    /// (graceful IPC), drops its backend, and runs a SIGTERM/SIGKILL
    /// escalation on the spawner's child PID in a detached task so
    /// the close() call returns promptly. Emits `Event::SessionClosed`
    /// + an updated `Event::SessionList`.
    pub(crate) async fn close(&self, id: &EntityId) -> Option<SessionInfo> {
        let removed = self.sessions.write().await.remove(id);
        match removed {
            Some(entry) => {
                entry.pump.abort();
                let info = entry.to_info();
                // Politely ask the host process to exit before we
                // tear down its IPC channel. The Ardour shim raises
                // SIGTERM on its own pid; the stub no-ops.
                let _ = entry.backend.request_quit().await;
                // Drop the backend (last Arc release closes the shim
                // socket when the backend's own Drop runs). The
                // graceful-quit IPC was sent BEFORE this drop so the
                // shim got a chance to read it; closing the socket
                // afterwards just cleans up our end.
                drop(entry.backend);
                // Hand the terminator (if any) to a detached task so
                // we don't block close() on the up-to-~8s escalation
                // window. Safe because the entry's already removed
                // from the map — nothing else can race on the child.
                let mut proc_slot = entry.process.into_inner();
                if let Some(proc) = proc_slot.take() {
                    let session_id_for_log = id.clone();
                    tokio::spawn(async move {
                        shutdown_child(session_id_for_log, proc).await;
                    });
                }
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

    /// Canonical on-disk path to the session `.ardour` project file (not
    /// jail-stripped). Used by HTTP import to target `interchange/.../audiofiles`.
    pub(crate) async fn project_file_abs_path(&self, id: &EntityId) -> Option<String> {
        self.sessions.read().await.get(id).map(|e| e.path.clone())
    }

    /// Returns true if the session with `id` still exists. Used by the
    /// WS layer to validate a client's currently-selected session
    /// after events that might have closed it.
    #[allow(dead_code)] // wired in with per-connection selection routing
    pub(crate) async fn has(&self, id: &EntityId) -> bool {
        self.sessions.read().await.contains_key(id)
    }

    /// Backend adapter id for a session, if registered.
    pub(crate) async fn backend_id_of(&self, id: &EntityId) -> Option<String> {
        self.sessions
            .read()
            .await
            .get(id)
            .map(|e| e.backend_id.clone())
    }

    /// Update on-disk project path after Save Session As. Keeps the
    /// same session id; refreshes canonical `path`, display `name`
    /// (folder basename), and broadcasts [`Event::SessionList`].
    /// Returns `false` if `id` is not registered.
    pub(crate) async fn update_project_location(&self, id: &EntityId, new_path_abs: String) -> bool {
        {
            let mut map = self.sessions.write().await;
            let Some(entry) = map.get_mut(id) else {
                return false;
            };
            entry.path = new_path_abs.clone();
            let stem = std::path::Path::new(&new_path_abs)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("session");
            entry.name = stem.to_string();
        }
        self.broadcast_event(Event::SessionList {
            sessions: self.list().await,
        })
        .await;
        true
    }

    async fn broadcast_event(&self, body: Event) {
        let env = Envelope {
            schema: SCHEMA_VERSION,
            api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
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
            api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
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
        api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
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

/// Three-stage shutdown of a host child process after
/// `Backend::request_quit()` has already fired. Stages:
///   1. Wait up to 5s for the process to exit on its own (graceful
///      IPC + Ardour's SIGTERM handler doing the save-and-exit).
///   2. SIGTERM, wait 3s. Catches Ardour builds whose graceful path
///      hangs on a save dialog or a stuck plugin.
///   3. SIGKILL. Last resort — forces the kernel to reap.
async fn shutdown_child(session_id: EntityId, mut proc: Box<dyn ProcessHandle>) {
    use std::time::Duration;
    if proc.wait(Duration::from_secs(5)).await {
        tracing::info!("session {session_id} child exited gracefully after request_quit");
        return;
    }
    tracing::warn!("session {session_id} child still alive 5s after request_quit; sending SIGTERM");
    proc.sigterm().await;
    if proc.wait(Duration::from_secs(3)).await {
        tracing::info!("session {session_id} child exited after SIGTERM");
        return;
    }
    tracing::warn!("session {session_id} child still alive 3s after SIGTERM; sending SIGKILL");
    proc.sigkill().await;
    // SIGKILL can take a beat to land + reap; one more short wait so
    // the log has the final outcome. Don't fail the task on timeout —
    // the kernel will reap eventually and the spawner side has the
    // child handle dropped after this returns.
    if proc.wait(Duration::from_secs(2)).await {
        tracing::info!("session {session_id} child reaped after SIGKILL");
    } else {
        tracing::warn!("session {session_id} child unreaped after SIGKILL — leaking handle");
    }
}
