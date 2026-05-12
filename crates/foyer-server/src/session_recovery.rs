//! Detect + dispose of Ardour crash-recovery artifacts.
//!
//! Ardour writes two breadcrumbs next to a session file, with very
//! different semantics:
//!
//!   - `<session>.history` — the persisted undo stack from the most
//!     recent clean autosave. Present in every session the user has
//!     edited; loaded silently on reopen, never prompts. Foyer must
//!     leave this file alone — deleting it costs the user their
//!     undo history.
//!   - `<session>.pending` — the dirty-state delta written between
//!     autosaves so a crash doesn't lose the user's last few edits.
//!     Only present when Ardour shut down uncleanly (segfault,
//!     SIGKILL, oom-kill, host yanked, …). Its presence is what
//!     triggers Ardour's `AskAboutPendingState` signal at session
//!     load — which the `gtk2_ardour` layer answers with a modal
//!     "Recover from crash / Ignore crash data" dialog.
//!
//! That modal is fatal in headless container deploys (no human to
//! click it). Foyer's solution is two-pronged:
//!
//!   1. **Probe before launch.** `probe()` reports live `.pending`
//!      files so the browser can ask the user "Recover or Discard?"
//!      via `Event::SessionRecoveryAvailable`.
//!   2. **Dispatch the choice cleanly.**
//!      - Discard: `discard_pending()` deletes the `.pending` file
//!        before the Ardour spawn — no dialog appears at all.
//!      - Recover: leave the file in place; the Ardour shim auto-
//!        clicks the "Recover" button when the dialog opens, via
//!        the `FOYER_CRASH_RECOVERY=recover` env var + a GTK
//!        toplevel-watcher installed in `shims/ardour`.
//!
//! No archive subfolder, no destructive sweeps. `.history` is
//! preserved verbatim across launches.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use foyer_schema::SessionRecoveryArtifact;

/// Resolve `project_path` (a `.ardour` file, a session directory, or
/// anything in between) to the directory that should be scanned for
/// `.pending` files. Returns `None` if the path doesn't exist or
/// the resolved location isn't a directory.
fn session_dir_for(project_path: &Path) -> Option<PathBuf> {
    let canon = std::fs::canonicalize(project_path).ok()?;
    if canon.is_dir() {
        Some(canon)
    } else {
        canon.parent().map(Path::to_path_buf)
    }
}

/// List live `.pending` recovery artifacts in `project_path`'s
/// directory. Empty list = the launch can proceed silently. `.history`
/// files are intentionally NOT reported — they're regular undo state,
/// not crash data, and Ardour doesn't prompt about them.
pub fn probe(project_path: &Path) -> Vec<SessionRecoveryArtifact> {
    let Some(dir) = session_dir_for(project_path) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<SessionRecoveryArtifact> = Vec::new();
    for entry in entries.flatten() {
        let name_os = entry.file_name();
        let Some(name) = name_os.to_str() else {
            continue;
        };
        if !name.to_lowercase().ends_with(".pending") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let mtime_unix_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(SessionRecoveryArtifact {
            name: name.to_string(),
            kind: "pending".to_string(),
            size_bytes: meta.len(),
            mtime_unix_ms,
            archived: false,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Delete every live `.pending` file next to `project_path`. Returns
/// the count removed. Used when the user picked Discard at the
/// recovery prompt — Ardour boots without the `AskAboutPendingState`
/// signal firing, so no dialog appears. `.history` files are
/// untouched (preserves undo).
pub fn discard_pending(project_path: &Path) -> usize {
    let Some(dir) = session_dir_for(project_path) else {
        return 0;
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return 0,
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name_os = entry.file_name();
        let Some(name) = name_os.to_str() else {
            continue;
        };
        if !name.to_lowercase().ends_with(".pending") {
            continue;
        }
        let path = entry.path();
        match std::fs::remove_file(&path) {
            Ok(()) => {
                removed += 1;
                tracing::info!(
                    "session_recovery: discarded crash-pending file {}",
                    path.display(),
                );
            }
            Err(e) => {
                tracing::warn!(
                    "session_recovery: failed to discard {}: {e}",
                    path.display(),
                );
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    fn touch(p: &Path, body: &[u8]) {
        let mut f = File::create(p).unwrap();
        f.write_all(body).unwrap();
    }

    #[test]
    fn probe_returns_empty_for_clean_session() {
        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("Session.ardour"), b"<ardour/>");
        let found = probe(&tmp.path().join("Session.ardour"));
        assert!(found.is_empty());
    }

    #[test]
    fn probe_ignores_history_file() {
        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("Session.ardour"), b"<ardour/>");
        touch(&tmp.path().join("Session.history"), b"history-data");
        // .history alone is normal undo state — no prompt.
        let found = probe(&tmp.path().join("Session.ardour"));
        assert!(found.is_empty());
    }

    #[test]
    fn probe_reports_pending_only() {
        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("Session.ardour"), b"<ardour/>");
        touch(&tmp.path().join("Session.history"), b"history-data");
        touch(&tmp.path().join("Session.pending"), b"pending-data");
        let found = probe(&tmp.path().join("Session.ardour"));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, "pending");
        assert!(!found[0].archived);
    }

    #[test]
    fn discard_pending_removes_pending_only() {
        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("Session.ardour"), b"<ardour/>");
        touch(&tmp.path().join("Session.history"), b"hh");
        touch(&tmp.path().join("Session.pending"), b"pp");

        let n = discard_pending(&tmp.path().join("Session.ardour"));
        assert_eq!(n, 1);
        assert!(!tmp.path().join("Session.pending").exists());
        // History is preserved.
        assert!(tmp.path().join("Session.history").exists());
        assert!(tmp.path().join("Session.ardour").exists());
    }

    #[test]
    fn discard_pending_is_noop_when_clean() {
        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("Session.ardour"), b"<ardour/>");
        let n = discard_pending(&tmp.path().join("Session.ardour"));
        assert_eq!(n, 0);
    }

    #[test]
    fn probe_resolves_directory_paths() {
        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("Session.pending"), b"pp");
        let found = probe(tmp.path());
        assert_eq!(found.len(), 1);
    }
}
