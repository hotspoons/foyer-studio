//! Where to land browser uploads before `Backend::import_audio`.
//!
//! IPC-host sessions created via the Ardour shim use this on-disk layout next to
//! the `.ardour` project file. Other [`foyer_backend::Backend`] implementations
//! can ignore this module and override [`foyer_backend::Backend::media_import_staging_dir_abs`].

use std::path::{Path, PathBuf};

/// Absolute path to the per-session `audiofiles` folder (creating parents is the caller's job).
pub(crate) fn staging_dir_abs(project_file_abs: &str) -> PathBuf {
    let p = Path::new(project_file_abs);
    let parent = p.parent().unwrap_or_else(|| Path::new("."));
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("session");
    parent.join("interchange").join(stem).join("audiofiles")
}
