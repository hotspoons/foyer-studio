//! Orphaned session detection and registry persistence.
//!
//! When the shim starts up it writes a registry entry at
//! `~/.local/share/foyer/sessions/<session_uuid>.json` describing
//! itself (socket path, pid, project path, etc). On clean exit the
//! shim removes its entry. On sidecar startup, anything left behind
//! is either a running orphan (shim still live, Foyer died and
//! reopened) or a crashed session (shim pid dead, leftover entry is
//! our only record).
//!
//! This module reads those entries, classifies them, and builds the
//! `OrphanInfo` vector the WS layer surfaces to clients on first
//! attach.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use foyer_schema::{EntityId, OrphanInfo};
use serde::{Deserialize, Serialize};

/// On-disk shape of a session registry entry. The shim writes this
/// and the sidecar reads it. Kept deliberately flat + forward-compat
/// (unknown fields are tolerated via `#[serde(default)]`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryEntry {
    /// Session UUID, matches what's stored inside the .ardour file's
    /// extra_xml. Stable across reopens.
    pub session_id: String,
    /// "ardour" / "stub" — the backend adapter that hosts this shim.
    #[serde(default)]
    pub backend_id: String,
    /// Absolute canonical path of the opened session file/dir.
    #[serde(default)]
    pub project_path: String,
    /// Display name. Usually basename of project_path.
    #[serde(default)]
    pub project_name: String,
    /// IPC socket path. On Linux / Unix this is a Unix domain socket;
    /// absent for backends that use other transports.
    #[serde(default)]
    pub socket_path: String,
    /// Pid of the shim process. `0` means "unknown / don't liveness
    /// check" (stub/unit-test entries).
    #[serde(default)]
    pub pid: u32,
    /// Unix epoch seconds when the entry was first written.
    #[serde(default)]
    pub started_at: u64,
    /// Unix epoch seconds of the last heartbeat / update. Used to
    /// age-out stale entries — an entry more than 7 days old with a
    /// dead pid is considered crash debris and gets collected.
    #[serde(default)]
    pub last_updated: u64,
}

/// Location the shim writes session registry entries into. Shared
/// across the sidecar (reads) and the shim (writes). XDG_DATA_HOME
/// is the right place for "user data that persists across reboots
/// but isn't config" — matches where we already store other Foyer
/// state.
pub fn registry_dir() -> PathBuf {
    if let Some(dir) = dirs::data_dir() {
        return dir.join("foyer").join("sessions");
    }
    PathBuf::from("/tmp/foyer/sessions")
}

/// Ensure the registry directory exists. Idempotent.
pub fn ensure_registry_dir() -> std::io::Result<PathBuf> {
    let dir = registry_dir();
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Scan the registry directory, classify each entry, return the
/// resulting `OrphanInfo` list. IO errors are logged but not fatal —
/// a missing / unreadable directory just means "no orphans".
pub async fn scan_orphans() -> Vec<OrphanInfo> {
    let dir = registry_dir();
    let mut out = Vec::new();
    let entries = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return out,
        Err(e) => {
            tracing::warn!("session registry scan failed: {e}");
            return out;
        }
    };
    let mut entries = entries;
    while let Ok(Some(ent)) = entries.next_entry().await {
        let path = ent.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let entry = match read_entry(&path).await {
            Some(e) => e,
            None => continue,
        };
        // Classify: pid alive? socket reachable?
        let pid_alive = entry.pid > 0 && pid_is_alive(entry.pid);
        let socket_reachable = pid_alive
            && !entry.socket_path.is_empty()
            && Path::new(&entry.socket_path).exists();
        let kind = if pid_alive && socket_reachable {
            "running"
        } else if pid_alive && !socket_reachable {
            // Race: pid exists but socket disappeared. Shim is
            // shutting down; treat as crashed so the user can decide
            // to reopen instead of attempting a doomed reattach.
            "crashed"
        } else {
            // Stale entry from a dead process. Age it out if it's very
            // old so the list doesn't grow unbounded over weeks of
            // crashes the user never dismissed.
            let age = now_secs().saturating_sub(entry.last_updated.max(entry.started_at));
            if age > 7 * 24 * 3600 {
                // Quietly remove — the user never came back to it.
                let _ = tokio::fs::remove_file(&path).await;
                continue;
            }
            "crashed"
        };
        out.push(OrphanInfo {
            id: EntityId::new(&entry.session_id),
            backend_id: if entry.backend_id.is_empty() {
                "ardour".into()
            } else {
                entry.backend_id.clone()
            },
            path: entry.project_path,
            name: if entry.project_name.is_empty() {
                entry.session_id.clone()
            } else {
                entry.project_name
            },
            kind: kind.into(),
            pid: if entry.pid > 0 { Some(entry.pid) } else { None },
            socket: if entry.socket_path.is_empty() {
                None
            } else {
                Some(entry.socket_path)
            },
            started_at: entry.started_at,
        });
    }
    out
}

/// Remove an orphan's registry entry (used by `DismissOrphan`).
pub async fn remove_entry(session_id: &str) -> std::io::Result<()> {
    let path = registry_dir().join(format!("{session_id}.json"));
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Look up a specific registry entry by session id. Used when the
/// client fires `ReattachOrphan` — we need the socket path.
pub async fn load_entry(session_id: &str) -> Option<RegistryEntry> {
    let path = registry_dir().join(format!("{session_id}.json"));
    read_entry(&path).await
}

async fn read_entry(path: &Path) -> Option<RegistryEntry> {
    let bytes = tokio::fs::read(path).await.ok()?;
    serde_json::from_slice::<RegistryEntry>(&bytes)
        .map_err(|e| {
            tracing::warn!("session registry: couldn't parse {}: {e}", path.display());
            e
        })
        .ok()
}

fn pid_is_alive(pid: u32) -> bool {
    // /proc/<pid> existence is the cheapest Linux liveness check. On
    // other Unixes fall through to a signal(0) probe. Windows isn't
    // a supported target for the sidecar today — if it becomes one
    // this should gain a cfg branch.
    #[cfg(target_os = "linux")]
    {
        return Path::new(&format!("/proc/{pid}")).exists();
    }
    #[cfg(not(target_os = "linux"))]
    {
        // signal(0) to the pid is a no-op that only verifies the
        // caller has permission to signal; if the pid is gone we
        // get ESRCH. Good enough for an existence check.
        use std::process::Command;
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
