//! Jailed filesystem browsing for the session picker / file surfaces.
//!
//! Lives in the sidecar, not the shim, because filesystem access is a sidecar
//! concern — the shim runs inside the DAW process and may not have the same
//! permissions (or even the same machine) as the user-facing sidecar. A shim
//! is not trusted to sanitize paths for browser clients.

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use foyer_schema::{FsEntry, FsEntryKind, PathListing};

#[derive(Debug, thiserror::Error)]
pub enum JailError {
    #[error("path escapes jail: {0}")]
    OutsideJail(String),
    #[error("no such path: {0}")]
    NoSuchPath(String),
    #[error("io: {0}")]
    Io(String),
}

pub struct Jail {
    root: PathBuf,
    root_canon: PathBuf,
}

impl Jail {
    pub fn new(root: PathBuf) -> Result<Self, JailError> {
        let root_canon = root
            .canonicalize()
            .map_err(|e| JailError::Io(format!("jail root {}: {e}", root.display())))?;
        Ok(Self {
            root: root_canon.clone(),
            root_canon,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn browse(&self, rel: &str, show_hidden: bool) -> Result<PathListing, JailError> {
        let rel = normalize_relative(rel);
        let abs = self.root.join(&rel);
        let canon = abs
            .canonicalize()
            .map_err(|_| JailError::NoSuchPath(rel.display().to_string()))?;
        if !canon.starts_with(&self.root_canon) {
            return Err(JailError::OutsideJail(rel.display().to_string()));
        }

        let mut entries = Vec::new();
        let mut hidden_count: u32 = 0;
        let rd = std::fs::read_dir(&canon).map_err(|e| JailError::Io(e.to_string()))?;
        for dent in rd.flatten() {
            let name = dent.file_name().to_string_lossy().to_string();
            if !show_hidden && name.starts_with('.') {
                hidden_count = hidden_count.saturating_add(1);
                continue;
            }
            let entry_path = canon.join(&name);
            let meta = match dent.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mut kind = if meta.is_dir() {
                FsEntryKind::Dir
            } else {
                FsEntryKind::File
            };
            let mut session_name = None;
            if meta.is_dir() {
                if let Some(sn) = find_session_in(&entry_path) {
                    kind = FsEntryKind::SessionDir;
                    session_name = Some(sn);
                }
            }
            let rel_path = path_join_rel(&rel, &name);
            entries.push(FsEntry {
                name,
                path: rel_path,
                kind,
                size_bytes: meta.is_file().then_some(meta.len()),
                modified_secs: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs()),
                session_name,
            });
        }
        entries.sort_by(|a, b| {
            // Dirs / session dirs first, then files; alphabetical within each group.
            let rank = |k: FsEntryKind| match k {
                FsEntryKind::SessionDir => 0,
                FsEntryKind::Dir => 1,
                FsEntryKind::File => 2,
            };
            rank(a.kind)
                .cmp(&rank(b.kind))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(PathListing {
            path: rel_to_wire(&rel),
            entries,
            is_root: rel.components().count() == 0,
            hidden_count,
        })
    }
}

fn normalize_relative(rel: &str) -> PathBuf {
    let trimmed = rel.trim_start_matches('/').trim();
    let mut out = PathBuf::new();
    for c in Path::new(trimmed).components() {
        if let Component::Normal(os) = c {
            out.push(os);
        }
    }
    out
}

fn rel_to_wire(rel: &Path) -> String {
    if rel.as_os_str().is_empty() {
        String::new()
    } else {
        rel.components()
            .filter_map(|c| match c {
                Component::Normal(s) => Some(s.to_string_lossy()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/")
    }
}

fn path_join_rel(rel: &Path, name: &str) -> String {
    let base = rel_to_wire(rel);
    if base.is_empty() {
        name.to_string()
    } else {
        format!("{base}/{name}")
    }
}

fn find_session_in(dir: &Path) -> Option<String> {
    let rd = std::fs::read_dir(dir).ok()?;
    for dent in rd.flatten() {
        let n = dent.file_name().to_string_lossy().into_owned();
        if let Some(stem) = n.strip_suffix(".ardour") {
            return Some(stem.to_string());
        }
    }
    None
}
