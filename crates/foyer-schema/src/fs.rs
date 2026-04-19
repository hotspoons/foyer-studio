//! Filesystem introspection — what clients browse when picking sessions.
//!
//! All paths are **relative to the Foyer CLI's configured jail directory**; the
//! server must refuse anything that would escape the jail. The schema itself
//! doesn't enforce this — that's the sidecar's job, because a shim speaking
//! this protocol may be running out-of-process and shouldn't be trusted to
//! sanitize client-supplied paths.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FsEntryKind {
    File,
    Dir,
    /// Directory that contains a DAW session (e.g. an Ardour dir with a
    /// `*.ardour` file inside). Clients render these with a session-y icon.
    SessionDir,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FsEntry {
    /// File or directory name (no slashes).
    pub name: String,
    /// Path relative to the jail root, using `/` as separator.
    pub path: String,
    pub kind: FsEntryKind,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub size_bytes: Option<u64>,
    /// Seconds since Unix epoch; None for unknown.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub modified_secs: Option<u64>,
    /// For `SessionDir`, the session-name (without `.ardour` extension).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub session_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PathListing {
    pub path: String,
    pub entries: Vec<FsEntry>,
    /// True if this path is the jail root. Clients render `..` differently.
    pub is_root: bool,
}
