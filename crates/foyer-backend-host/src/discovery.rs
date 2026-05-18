//! Discover running shims by scanning the advertisement directory.
//!
//! The Ardour shim writes `<dir>/ardour-<pid>.json` + `<dir>/ardour-<pid>.sock`
//! when it starts. `<dir>` is `$XDG_RUNTIME_DIR/foyer` if set, else
//! `/tmp/foyer`. A sidecar that wants to connect without being told can scan
//! the directory and pick a live advertisement.
//!
//! A "live" shim is one whose advertisement file still exists AND whose
//! socket file still exists AND whose pid is still running (best-effort).
//! Stale advertisements from crashed shims are ignored (and can be swept
//! separately).
//!
//! No assumption that the entries are Ardour-specific — future shims (Reaper,
//! custom) are expected to drop their own `<host>-<pid>.json` files in the
//! same directory.
//!
//! Keep this pure Rust std + serde — no network, no async. Callers spawn
//! connect attempts themselves.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Deserialize;

/// One running shim advertisement.
#[derive(Debug, Clone, Deserialize)]
pub struct Advertisement {
    /// Socket path the sidecar should connect to.
    pub socket: PathBuf,
    /// PID of the shim process — used for liveness checks.
    pub pid: u32,
    /// Host session name, best-effort.
    #[serde(default)]
    pub session: String,
    /// Absolute project directory the shim is hosting. Empty when the
    /// shim hasn't reached `set_active(true)` with a loaded session
    /// (early launcher) or the host doesn't expose it. The spawner
    /// uses this to detect "you already have an Ardour open for this
    /// project — reuse it" so the second open of an existing project
    /// doesn't race a fresh spawn against the live one.
    #[serde(default)]
    pub project_path: String,
    /// ISO-8601 timestamp the shim was started (UTC).
    #[serde(default)]
    pub started: String,
    /// File the advertisement was read from — set by the scanner, not the shim.
    #[serde(skip)]
    pub advert_path: PathBuf,
    /// mtime of the advertisement file — tiebreaker for "most recent" picks.
    #[serde(skip)]
    pub mtime: Option<SystemTime>,
}

/// Resolve the discovery directory from the environment (XDG first, then /tmp).
pub fn discovery_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("foyer");
        }
    }
    PathBuf::from("/tmp/foyer")
}

/// Scan the default discovery directory for advertisements.
pub fn scan() -> Vec<Advertisement> {
    scan_in(&discovery_dir())
}

/// Scan a specific directory for advertisements. Returns live entries sorted
/// by mtime (newest first). Stale entries (pid dead OR socket missing) are
/// filtered out.
pub fn scan_in(dir: &Path) -> Vec<Advertisement> {
    let Ok(entries) = fs::read_dir(dir) else {
        return vec![];
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(data) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(mut ad) = serde_json::from_str::<Advertisement>(&data) else {
            continue;
        };
        ad.advert_path = path.clone();
        ad.mtime = entry.metadata().ok().and_then(|m| m.modified().ok());
        if !is_alive(&ad) {
            continue;
        }
        out.push(ad);
    }
    out.sort_by_key(|ad| std::cmp::Reverse(ad.mtime));
    out
}

/// Best-effort liveness: socket file exists AND (pid directory in /proc is
/// readable OR we're not on Linux, in which case just trust the socket).
fn is_alive(ad: &Advertisement) -> bool {
    if !ad.socket.exists() {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        let proc_path = format!("/proc/{}", ad.pid);
        if !Path::new(&proc_path).exists() {
            return false;
        }
    }
    true
}

/// Find a live shim already hosting `project_path` (or any prefix
/// match — the shim writes its `session().path()` which is the project
/// directory, not the .ardour file). Used by the launcher to detect
/// "Ardour is already running this project, just reattach" instead of
/// spawning a second instance that races for the lock file. Returns
/// `None` when nothing matches.
pub fn find_for_project(project_path: &Path) -> Option<Advertisement> {
    let target = match project_path.canonicalize() {
        Ok(p) => p,
        Err(_) => project_path.to_path_buf(),
    };
    for ad in scan() {
        if ad.project_path.is_empty() {
            continue;
        }
        let pp = PathBuf::from(&ad.project_path);
        let pp_canon = pp.canonicalize().unwrap_or(pp);
        if pp_canon == target {
            return Some(ad);
        }
        // Ardour reports `session.path()` as the project dir; the
        // caller may pass either the dir OR the `.ardour` file. Treat
        // either side being a parent of the other as a match.
        if pp_canon.starts_with(&target) || target.starts_with(&pp_canon) {
            return Some(ad);
        }
    }
    None
}

/// Convenience: scan and return exactly-one or an error describing the
/// ambiguity. Useful for CLI paths that want "auto-pick when unambiguous,
/// yell when not".
pub fn pick_single() -> Result<Advertisement, DiscoveryError> {
    let mut found = scan();
    match found.len() {
        0 => Err(DiscoveryError::NoShim),
        // Use `pop()` rather than `into_iter().next().unwrap()` so the
        // exactly-one branch has zero panic surface — match exhausted
        // the other cases, so found has a single element.
        1 => found.pop().ok_or(DiscoveryError::NoShim),
        _ => Err(DiscoveryError::Ambiguous(found)),
    }
}

#[derive(thiserror::Error, Debug)]
pub enum DiscoveryError {
    #[error("no running shim found in {}", discovery_dir().display())]
    NoShim,
    #[error("multiple shims found — pick one with --socket=PATH; available: {}", format_shims(.0))]
    Ambiguous(Vec<Advertisement>),
}

fn format_shims(ads: &[Advertisement]) -> String {
    ads.iter()
        .map(|a| {
            format!(
                "{} (pid {}, session \"{}\")",
                a.socket.display(),
                a.pid,
                a.session
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}
