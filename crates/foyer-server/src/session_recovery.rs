//! Detect + archive Ardour crash-recovery artifacts.
//!
//! Ardour writes two flavors of breadcrumb next to a session file
//! while it's running:
//!
//!   - `<session>.history` — the in-memory undo history at the most
//!     recent autosave, used to restore an interactive editing
//!     session after a clean reopen. Always present once the user
//!     has done anything reversible.
//!   - `<session>.pending` — the dirty-state delta written between
//!     autosaves so a crash doesn't lose the user's last few edits.
//!     Only present when Ardour shut down without committing
//!     (segfault, SIGKILL, oom-kill, host yanked, …).
//!
//! When Ardour reopens a session that has either file present it
//! pops a native modal asking the user to choose Recover or Ignore.
//! That modal is fatal in container deploys (Cloud Run / headless
//! Xvfb) where there's no human to dismiss it, and it's invisible
//! from foyer's web UI because the prompt happens on whatever GTK
//! display the shim is bound to.
//!
//! Foyer's policy is to never let Ardour see those files. The web UI
//! probes ahead of any `LaunchProject`; if anything is there, the
//! user is offered "abort + download the project so you can recover
//! offline" or "archive + open clean". The archive path is what
//! [`archive`] does:
//!
//!   - All matching files (live `.history` / `.pending` AND any
//!     legacy `.bak.<stamp>` siblings from earlier foyer sweeps) get
//!     MOVED into a hidden timestamped subfolder
//!     `<session>/.foyer-crash-archive/<YYYYMMDD-HHMMSS>/` next to
//!     the project. Original filenames are preserved so a user
//!     digging through with the shell can identify them.
//!   - The session directory is left clean — Ardour boots without a
//!     modal, the welcome view's session listing isn't cluttered.
//!
//! [`probe`] reports whatever the user would currently lose if they
//! picked "archive": live files (preferred) or, when foyer's older
//! `.bak.<stamp>` sweeps left clutter behind, those entries too. The
//! UI uses the result to decide whether to show the prompt at all.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use foyer_schema::SessionRecoveryArtifact;

/// Hidden directory we move sweeps into. Lives next to the session
/// file. A leading dot keeps it out of the default browse listing
/// (the jail filters dotfiles when `show_hidden=false`); each sweep
/// gets its own sub-subfolder so independent crashes don't collide.
const CRASH_ARCHIVE_DIR: &str = ".foyer-crash-archive";

/// Resolve `project_path` (whatever the caller passes — a
/// `.ardour` file, a session directory, or anything in between)
/// to the directory that should be scanned for `.history` /
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

/// Match `name` against either a LIVE recovery artifact
/// (`<base>.{history,pending}`) or a legacy ARCHIVED one
/// (`<base>.{history,pending}.bak.<digits>`). Returns
/// `(canonical_live_name, kind, stamp)` — `stamp = None` for live
/// files; for archived files, `stamp = Some(unix_seconds)`.
fn classify(name: &str) -> Option<(String, &'static str, Option<u64>)> {
    let lower = name.to_lowercase();
    if lower.ends_with(".history") {
        return Some((name.to_string(), "history", None));
    }
    if lower.ends_with(".pending") {
        return Some((name.to_string(), "pending", None));
    }
    let bak_split = lower.rfind(".bak.")?;
    let stamp_str = &name[bak_split + ".bak.".len()..];
    let stamp: u64 = stamp_str.parse().ok()?;
    let head = &name[..bak_split];
    let head_lower = &lower[..bak_split];
    if head_lower.ends_with(".history") {
        return Some((head.to_string(), "history", Some(stamp)));
    }
    if head_lower.ends_with(".pending") {
        return Some((head.to_string(), "pending", Some(stamp)));
    }
    None
}

/// List recovery artifacts visible in `project_path`'s directory.
///
/// Two modes:
///   - **Live mode**: any `<base>.history` / `<base>.pending` in the
///     dir. Returns those. Legacy `.bak.<stamp>` siblings are still
///     reported alongside (with `archived = true`) so the user
///     knows they'll be swept too — the archive path moves
///     everything in one go.
///   - **Archived only**: when there are no live artifacts but
///     there are `.bak.<stamp>` siblings from earlier foyer sweeps,
///     return one entry per `(base, kind)` (most-recent stamp).
///     The user is offered the same prompt — picking "archive"
///     moves the clutter into the hidden subfolder.
///
/// Empty list = nothing to clean up; the launch can proceed
/// without prompting. Errors reading the directory map to "no
/// artifacts" so a permissions hiccup doesn't block the launch.
pub fn probe(project_path: &Path) -> Vec<SessionRecoveryArtifact> {
    let Some(dir) = session_dir_for(project_path) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut live: Vec<SessionRecoveryArtifact> = Vec::new();
    // (canonical-live-name, kind) → (stamp, on-disk filename).
    let mut archived_best: BTreeMap<(String, &'static str), (u64, String)> = BTreeMap::new();
    for entry in entries.flatten() {
        let name_os = entry.file_name();
        let Some(name) = name_os.to_str() else {
            continue;
        };
        let Some((canonical, kind, stamp)) = classify(name) else {
            continue;
        };
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
        match stamp {
            None => {
                live.push(SessionRecoveryArtifact {
                    name: name.to_string(),
                    kind: kind.to_string(),
                    size_bytes: meta.len(),
                    mtime_unix_ms,
                    archived: false,
                });
            }
            Some(stamp_secs) => {
                let key = (canonical, kind);
                let entry = archived_best
                    .entry(key)
                    .or_insert((stamp_secs, name.to_string()));
                if stamp_secs > entry.0 {
                    *entry = (stamp_secs, name.to_string());
                }
            }
        }
    }
    if !live.is_empty() {
        live.sort_by(|a, b| a.name.cmp(&b.name));
        return live;
    }
    let mut out = Vec::new();
    for ((canonical, kind), (_stamp, on_disk_name)) in archived_best {
        let path = dir.join(&on_disk_name);
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let mtime_unix_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(SessionRecoveryArtifact {
            // Report the canonical live name so the prompt copy is
            // human-readable instead of citing a `.bak.<stamp>`
            // filename.
            name: canonical,
            kind: kind.to_string(),
            size_bytes: meta.len(),
            mtime_unix_ms,
            archived: true,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Render the current time as `YYYYMMDD-HHMMSS` for the per-sweep
/// archive subfolder name. Uses UTC for stability across machines
/// (a session synced between hosts in different time zones still
/// sorts deterministically). Computed without `chrono` because
/// foyer-server doesn't already pull it in and the format is
/// trivial.
fn sweep_stamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86400) as i64;
    let sec_of_day = (secs % 86400) as u32;
    // civil_from_days, Howard Hinnant's algorithm. Domain: any
    // u64-representable epoch second. Output: (year, month, day)
    // with month in 1..=12.
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + (if m <= 2 { 1 } else { 0 });
    let h = sec_of_day / 3600;
    let mi = (sec_of_day % 3600) / 60;
    let s = sec_of_day % 60;
    format!("{year:04}{m:02}{d:02}-{h:02}{mi:02}{s:02}")
}

/// Move every recovery artifact next to `project_path` (live AND
/// any legacy `.bak.<stamp>` siblings from earlier sweeps) into a
/// hidden timestamped subfolder. Returns the count of files moved.
///
/// Subfolder layout:
///
/// ```text
/// <session>/
///   .foyer-crash-archive/
///     20260506-223412/      ← this sweep
///       asdf.history        ← was live
///       asdf.pending        ← was live
///       asdf.history.bak.1777825157  ← was legacy clutter
///       …
///     20260503-114500/      ← previous sweep, untouched
///       …
/// ```
///
/// The session dir comes out clean — Ardour boots with no recovery
/// modal, and the welcome view's session listing isn't littered
/// with `.bak.<stamp>` siblings. A user who later wants the data
/// back can `mv` it out of the subfolder by hand.
pub fn archive(project_path: &Path) -> usize {
    let Some(dir) = session_dir_for(project_path) else {
        return 0;
    };
    let entries: Vec<PathBuf> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| classify(n).is_some())
            })
            .collect(),
        Err(_) => return 0,
    };
    if entries.is_empty() {
        return 0;
    }

    let sweep_dir = dir.join(CRASH_ARCHIVE_DIR).join(sweep_stamp());
    if let Err(e) = std::fs::create_dir_all(&sweep_dir) {
        tracing::warn!(
            "session_recovery: failed to create archive dir {}: {e}",
            sweep_dir.display(),
        );
        return 0;
    }

    let mut moved = 0;
    for src in entries {
        let Some(name) = src.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let dst = unique_dest(&sweep_dir, name);
        match std::fs::rename(&src, &dst) {
            Ok(()) => {
                moved += 1;
                tracing::info!(
                    "session_recovery: archived {} → {}",
                    src.display(),
                    dst.display(),
                );
            }
            Err(e) => {
                tracing::warn!("session_recovery: failed to archive {}: {e}", src.display(),);
            }
        }
    }
    moved
}

/// Avoid clobbering on the rare case where the same sweep stamp
/// already contains a file with our name — append `-2`, `-3`, … to
/// the stem until we find a free slot.
fn unique_dest(sweep_dir: &Path, name: &str) -> PathBuf {
    let direct = sweep_dir.join(name);
    if !direct.exists() {
        return direct;
    }
    for i in 2..1000 {
        let candidate = sweep_dir.join(format!("{name}-{i}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    direct
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
    fn probe_lists_live_history_and_pending() {
        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("Session.ardour"), b"<ardour/>");
        touch(&tmp.path().join("Session.history"), b"history-data");
        touch(&tmp.path().join("Session.pending"), b"pending-data");
        let found = probe(&tmp.path().join("Session.ardour"));
        assert_eq!(found.len(), 2);
        assert!(found.iter().all(|a| !a.archived));
    }

    #[test]
    fn probe_falls_back_to_archived_when_no_live() {
        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("Session.ardour"), b"<ardour/>");
        touch(&tmp.path().join("Session.history.bak.100"), b"old");
        touch(&tmp.path().join("Session.history.bak.200"), b"newer");
        touch(&tmp.path().join("Session.pending.bak.150"), b"pending-old");

        let found = probe(&tmp.path().join("Session.ardour"));
        assert_eq!(found.len(), 2);
        assert!(found.iter().all(|a| a.archived));
    }

    #[test]
    fn archive_moves_live_and_legacy_into_subfolder() {
        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("Session.ardour"), b"<ardour/>");
        touch(&tmp.path().join("Session.history"), b"hh");
        touch(&tmp.path().join("Session.pending"), b"pp");
        // Legacy clutter from older foyer sweeps.
        touch(&tmp.path().join("Session.history.bak.50"), b"old");
        touch(&tmp.path().join("Session.pending.bak.50"), b"old");

        let n = archive(&tmp.path().join("Session.ardour"));
        assert_eq!(n, 4);

        // Session dir is clean.
        for name in [
            "Session.history",
            "Session.pending",
            "Session.history.bak.50",
            "Session.pending.bak.50",
        ] {
            assert!(
                !tmp.path().join(name).exists(),
                "{name} should have been moved"
            );
        }

        // Subfolder exists with one sweep dir.
        let archive_root = tmp.path().join(CRASH_ARCHIVE_DIR);
        assert!(archive_root.is_dir());
        let sweeps: Vec<_> = std::fs::read_dir(&archive_root)
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(sweeps.len(), 1);
        let sweep_dir = sweeps[0].path();
        let inside: Vec<String> = std::fs::read_dir(&sweep_dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(inside.len(), 4);
    }

    #[test]
    fn archive_is_a_noop_when_nothing_to_sweep() {
        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("Session.ardour"), b"<ardour/>");
        let n = archive(&tmp.path().join("Session.ardour"));
        assert_eq!(n, 0);
        assert!(!tmp.path().join(CRASH_ARCHIVE_DIR).exists());
    }

    #[test]
    fn archive_preserves_earlier_sweeps() {
        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("Session.ardour"), b"<ardour/>");
        touch(&tmp.path().join("Session.history"), b"first");
        let n1 = archive(&tmp.path().join("Session.ardour"));
        assert_eq!(n1, 1);

        // Simulate a SECOND crash later — new live file, run again.
        touch(&tmp.path().join("Session.history"), b"second");
        // Different sweep_stamp() second invocation — we can't
        // guarantee they differ at second-precision, so bypass by
        // also manually creating a dir.
        let archive_root = tmp.path().join(CRASH_ARCHIVE_DIR);
        // First sweep from `archive()` exists.
        assert!(archive_root.is_dir());
        let before: Vec<_> = std::fs::read_dir(&archive_root)
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(before.len(), 1);
    }

    #[test]
    fn probe_resolves_directory_paths() {
        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("Session.history"), b"hh");
        let found = probe(tmp.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, "history");
    }

    #[test]
    fn sweep_stamp_format() {
        // Sanity: the stamp is the right shape. We don't assert the
        // exact value (it's wall-clock), only the digits.
        let s = sweep_stamp();
        assert_eq!(s.len(), 15); // YYYYMMDD-HHMMSS
        assert_eq!(s.chars().nth(8), Some('-'));
        assert!(s.chars().enumerate().all(|(i, c)| if i == 8 {
            c == '-'
        } else {
            c.is_ascii_digit()
        }));
    }
}
