//! Jailed filesystem browser. Rejects any path that would escape the jail
//! root after symlink resolution.
//!
//! Also marks directories containing a `*.ardour` file as `SessionDir` so UIs
//! can surface them specially.

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use foyer_backend::BackendError;
use foyer_schema::{FsEntry, FsEntryKind, PathListing};

pub struct Jail {
    root: PathBuf,
}

impl Jail {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn browse(&self, rel: &str) -> Result<PathListing, BackendError> {
        let rel = normalize_relative(rel);
        let abs = self.root.join(&rel);
        let canon = abs
            .canonicalize()
            .map_err(|_| BackendError::NoSuchPath(rel.display().to_string()))?;
        let root_canon = self
            .root
            .canonicalize()
            .map_err(|e| BackendError::Other(format!("jail root: {e}")))?;
        if !canon.starts_with(&root_canon) {
            return Err(BackendError::OutsideJail(rel.display().to_string()));
        }

        let mut entries = Vec::new();
        let rd = std::fs::read_dir(&canon).map_err(|e| BackendError::Other(e.to_string()))?;
        for dent in rd.flatten() {
            let name = dent.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
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
        entries.sort_by(|a, b| match (a.kind, b.kind) {
            (FsEntryKind::File, FsEntryKind::File) | (_, FsEntryKind::File) => a.name.cmp(&b.name),
            (FsEntryKind::File, _) => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        });

        Ok(PathListing {
            path: rel_to_wire(&rel),
            entries,
            is_root: rel.components().count() == 0,
        })
    }
}

fn normalize_relative(rel: &str) -> PathBuf {
    let trimmed = rel.trim_start_matches('/').trim();
    let mut out = PathBuf::new();
    for c in Path::new(trimmed).components() {
        match c {
            Component::Normal(os) => out.push(os),
            _ => {}
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
        let name = dent.file_name();
        let n = name.to_string_lossy();
        if let Some(stem) = n.strip_suffix(".ardour") {
            return Some(stem.to_string());
        }
    }
    None
}
