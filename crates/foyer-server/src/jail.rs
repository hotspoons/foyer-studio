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
    /// File extensions (no leading dot) that mark a directory as a
    /// session. Snapshot of every registered backend profile's
    /// `session_file_extensions()` at the moment the Jail is built;
    /// `Server` refreshes it whenever the profile registry changes.
    /// Empty = no folders ever flagged as `SessionDir` (the picker
    /// just shows them as plain directories).
    session_extensions: Vec<String>,
}

impl Jail {
    pub fn new(root: PathBuf) -> Result<Self, JailError> {
        let root_canon = root
            .canonicalize()
            .map_err(|e| JailError::Io(format!("jail root {}: {e}", root.display())))?;
        Ok(Self {
            root: root_canon.clone(),
            root_canon,
            // Default to recognizing `.ardour` so call sites that
            // build a bare `Jail::new(...)` (tests, embedders that
            // haven't touched the profile registry) match the old
            // hardcoded behavior. The runtime path on `Server::run`
            // overwrites this from the registered profile registry.
            session_extensions: vec!["ardour".to_string()],
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Replace the session-file extensions the jail considers when
    /// labeling folders as `SessionDir`. Called by `Server::run`
    /// after the profile registry has been populated so the picker
    /// reflects whichever DAW profiles the embedder has registered.
    pub fn set_session_extensions(&mut self, exts: Vec<String>) {
        self.session_extensions = exts;
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
                Err(_) => {
                    // `metadata()` can fail on some FUSE / VM subtrees while
                    // `file_type()` still works — still list the row so real
                    // folders don't vanish from the picker.
                    let is_dir = dent.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    let rel_path = path_join_rel(&rel, &name);
                    let (kind, session_name) = if is_dir {
                        if let Some(sn) = find_session_in(&entry_path, &self.session_extensions) {
                            (FsEntryKind::SessionDir, Some(sn))
                        } else {
                            (FsEntryKind::Dir, None)
                        }
                    } else {
                        (FsEntryKind::File, None)
                    };
                    entries.push(FsEntry {
                        name,
                        path: rel_path,
                        kind,
                        size_bytes: None,
                        modified_secs: None,
                        session_name,
                    });
                    continue;
                }
            };
            let mut kind = if meta.is_dir() {
                FsEntryKind::Dir
            } else {
                FsEntryKind::File
            };
            let mut session_name = None;
            if meta.is_dir() {
                if let Some(sn) = find_session_in(&entry_path, &self.session_extensions) {
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

    /// True when `rel` (jail-relative, normalized) points at an existing path
    /// that cannot be used as a fresh "Save session as" target: either a file
    /// already sits there, or the directory already holds a session file in
    /// any registered backend's format. Missing paths return false.
    pub fn existing_session_save_conflict(&self, rel: &Path) -> Result<bool, JailError> {
        if rel.as_os_str().is_empty() {
            return Ok(false);
        }
        let abs = self.root.join(rel);
        let canon = match abs.canonicalize() {
            Ok(c) => c,
            Err(_) => return Ok(false),
        };
        if !canon.starts_with(&self.root_canon) {
            return Err(JailError::OutsideJail(rel.display().to_string()));
        }
        if !canon.is_dir() {
            return Ok(true);
        }
        Ok(find_session_in(&canon, &self.session_extensions).is_some())
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

/// Walk `dir` looking for any file whose extension matches one of
/// `extensions` (no leading dot). Returns the file stem of the
/// preferred match, or `None` if nothing matched. Backend-agnostic
/// — caller supplies which extensions to recognize via the
/// jail's registered profile registry.
fn find_session_in(dir: &Path, extensions: &[String]) -> Option<String> {
    if extensions.is_empty() {
        return None;
    }
    let dir_stem = dir.file_name()?.to_str()?.to_string();
    let rd = std::fs::read_dir(dir).ok()?;
    let mut stems: Vec<String> = Vec::new();
    for dent in rd.flatten() {
        let n = dent.file_name().to_string_lossy().into_owned();
        for ext in extensions {
            let suffix = format!(".{ext}");
            if let Some(stem) = n.strip_suffix(&suffix) {
                stems.push(stem.to_string());
                break;
            }
        }
    }
    if stems.is_empty() {
        return None;
    }
    // Prefer `session_dir/session_dir.<ext>` — one folder often accumulates
    // several project files (templates, "Save As" leftovers). Readdir order
    // is unstable; without this the picker label can hide the folder identity.
    if let Some(p) = stems.iter().find(|s| *s == &dir_stem) {
        return Some((*p).clone());
    }
    stems.sort();
    Some(stems.into_iter().next().expect("non-empty"))
}
