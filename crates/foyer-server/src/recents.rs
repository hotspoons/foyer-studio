//! Server-tracked "recently opened projects" list.
//!
//! Replaces the per-browser `localStorage` recents the welcome screen
//! used to read. Per-browser meant a fresh devcontainer or a different
//! profile saw an empty list, AND a stale list pointing at projects
//! that lived on a previous container's disk and no longer existed.
//! Anchoring this on the sidecar fixes both — the recents list now
//! travels with whatever volume the sidecar's data dir is on.
//!
//! Storage: a single JSON file at
//!   `$XDG_DATA_HOME/foyer/recents.json` (default `~/.local/share/foyer`).
//! Schema is just `Vec<RecentEntry>` — most-recent first, capped to
//! `MAX_ENTRIES`. Reads tolerate missing / unparseable files (returns
//! `[]`).
//!
//! Mutations are coarse — every touch / forget / clear writes the
//! whole list back to disk. The list is small (≤25 entries) so this is
//! cheaper than a real DB and avoids a partial-write window.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use foyer_schema::RecentEntry;
use tokio::sync::Mutex;

/// Cap on how many entries we persist. Past this, the oldest entries
/// get evicted. Matches the previous browser-side `setRecentsCap`
/// upper bound so behavior doesn't shift when the storage moves.
const MAX_ENTRIES: usize = 25;

/// Path of the recents JSON file. Same XDG location as the orphans
/// registry so users only have one "foyer state" directory to know
/// about.
fn recents_path() -> PathBuf {
    let dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from("/tmp/foyer"));
    dir.join("foyer").join("recents.json")
}

/// In-process serialization point — writes are coarse (full file
/// rewrite each mutation) and we don't want two concurrent
/// LaunchProject events racing each other into a corrupt file.
static FILE_LOCK: Mutex<()> = Mutex::const_new(());

/// Normalize a path string to the form we want to store + ship: an
/// absolute filesystem path canonicalized through `std::fs::canonicalize`
/// (resolves `..`, symlinks, double slashes), then stripped of the
/// jail prefix so what hits the wire is jail-relative.
///
/// Two things this fixes:
///   * **Duplicates.** `/workspaces/foyer-studio/sessions/asdf` and
///     `foyer-studio/sessions/asdf` were two separate keys in the
///     recents store; the user saw the same project twice in their
///     list. After normalization both collapse to `sessions/asdf`.
///   * **Path leakage.** Absolute paths like
///     `/workspaces/foyer-studio/sessions/asdf` carry information
///     about the host filesystem layout that the UI has no business
///     seeing. The jail-relative form is the contract every other
///     UI-facing path on the wire already uses (see
///     `SessionRegistry::jail_display_path`).
///
/// Falls through to the original input string when canonicalization
/// fails (path doesn't exist on disk yet, e.g. a stub session
/// created via `BrowsePath` that the user hasn't touched). The
/// fallback won't dedupe a deleted-and-recreated project but it
/// also won't lose the entry, which is the right tradeoff.
pub fn normalize_path(path: &str, jail_root: Option<&Path>) -> String {
    if path.is_empty() {
        return String::new();
    }
    let absolute: PathBuf = match std::fs::canonicalize(path) {
        Ok(p) => p,
        Err(_) => {
            // No disk reality to canonicalize against. Try a poor-man's
            // canonicalize: if the input is jail-relative, prefix the
            // jail; if absolute, leave it. Then run the same prefix
            // strip below so empty-jail inputs still produce something
            // sensible.
            let p = Path::new(path);
            if p.is_absolute() {
                p.to_path_buf()
            } else if let Some(root) = jail_root {
                root.join(p)
            } else {
                return path.to_string();
            }
        }
    };
    if let Some(root) = jail_root {
        if let Ok(rel) = absolute.strip_prefix(root) {
            return rel.to_string_lossy().into_owned();
        }
    }
    absolute.to_string_lossy().into_owned()
}

/// Read the on-disk list. Missing file → `[]`. Parse errors → `[]` +
/// a tracing warn. Never panics.
///
/// Note: existing entries are NOT migrated — Rich made the call to
/// let the on-disk file self-heal as users touch entries (project
/// only lives on his dev machine right now, so the cost of stale
/// duplicates is low). New entries route through `normalize_path`
/// at touch time.
pub async fn load() -> Vec<RecentEntry> {
    let path = recents_path();
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            tracing::warn!("recents: read failed for {}: {e}", path.display());
            return Vec::new();
        }
    };
    match serde_json::from_slice::<Vec<RecentEntry>>(&bytes) {
        Ok(list) => list,
        Err(e) => {
            tracing::warn!("recents: parse failed for {}: {e}", path.display());
            Vec::new()
        }
    }
}

/// Persist `list`, capping at `MAX_ENTRIES` and writing atomically via
/// a tempfile + rename. Errors are logged but not bubbled — a failed
/// write loses ordering, never breaks the launch flow.
async fn save(list: &[RecentEntry]) {
    let _g = FILE_LOCK.lock().await;
    let path = recents_path();
    if let Some(dir) = path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(dir).await {
            tracing::warn!("recents: mkdir {} failed: {e}", dir.display());
            return;
        }
    }
    // Temp file in the same directory so the rename is atomic on the
    // same filesystem. If the rename fails the previous file stays
    // intact — better to lose the new entry than corrupt history.
    let tmp = path.with_extension("json.tmp");
    let bytes = match serde_json::to_vec_pretty(&list[..list.len().min(MAX_ENTRIES)]) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("recents: serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = tokio::fs::write(&tmp, &bytes).await {
        tracing::warn!("recents: write {} failed: {e}", tmp.display());
        return;
    }
    if let Err(e) = tokio::fs::rename(&tmp, &path).await {
        tracing::warn!(
            "recents: rename {} → {} failed: {e}",
            tmp.display(),
            path.display()
        );
    }
}

/// Promote (or insert) `entry` to the head of the list. If an entry
/// with the same `path` already exists it's removed first so we don't
/// have duplicates. Returns the updated list so callers can broadcast
/// without an extra read.
///
/// `default_backend_id` fills in `entry.backend_id` when the caller
/// hasn't set one — typically the registered profile-registry
/// default (currently `"ardour"`). Passed in rather than hardcoded
/// so a multi-DAW build with a different default doesn't write
/// misleading rows.
pub async fn touch(mut entry: RecentEntry, default_backend_id: Option<&str>) -> Vec<RecentEntry> {
    if entry.path.is_empty() {
        // Skip path-less launches (stub backend with no path) — they'd
        // collide with each other on the empty-string key.
        return load().await;
    }
    if entry.opened_at == 0 {
        entry.opened_at = now_secs();
    }
    if entry.name.is_empty() {
        entry.name = path_tail(&entry.path);
    }
    if entry.backend_id.is_empty() {
        if let Some(id) = default_backend_id {
            entry.backend_id = id.to_string();
        }
    }
    let mut list = load().await;
    list.retain(|e| e.path != entry.path);
    list.insert(0, entry);
    if list.len() > MAX_ENTRIES {
        list.truncate(MAX_ENTRIES);
    }
    save(&list).await;
    list
}

/// Drop a single entry by path. No-op if the path isn't in the list.
pub async fn forget(path: &str) -> Vec<RecentEntry> {
    let mut list = load().await;
    let before = list.len();
    list.retain(|e| e.path != path);
    if list.len() != before {
        save(&list).await;
    }
    list
}

/// Empty the list entirely.
pub async fn clear() -> Vec<RecentEntry> {
    save(&[]).await;
    Vec::new()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn path_tail(p: &str) -> String {
    p.rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}
