//! `/sessions/upload` + `/sessions/export` — project archive endpoints.
//!
//! Both flows operate inside the sidecar's filesystem jail so a tunnel
//! guest can't write outside the configured project root. LAN
//! connections skip the tunnel-token check (mirroring `files.rs`)
//! because LAN is the trusted listener.
//!
//! ## Trust boundary
//!
//! Uploaded archives are **not** trusted. Ardour's session loader
//! has documented RCE vectors (auto-executed `<Script>` blocks,
//! unsanitized region paths, libarchive without the secure flags),
//! and the rest of its filesystem stack assumes friendly input. We
//! never hand a raw uploaded archive to Ardour.
//!
//! Defenses, in order of where they trip:
//!
//!  1. **Magic-byte format gate** — only zip / tar.gz / tar.zst
//!     accepted. Rejects anything else with a 400 before a single
//!     byte is decompressed.
//!  2. **Hardened extractor** (this module): rejects symlinks,
//!     hardlinks, char/block/fifo entries; caps total uncompressed
//!     bytes (zip-bomb defense); caps entry count; refuses any
//!     path component containing `..` or rooted at `/`.
//!  3. **XML scrubber** ([`crate::session_scrub`]): every
//!     `*.ardour` file in the extracted tree gets its `<Script>` /
//!     `<LuaScripts>` blocks stripped before the project lands in
//!     the jail. The scrubber also rejects path-bearing attributes
//!     that look like exploits (absolute, `..`, drive letters).
//!  4. **Atomic rename** — extraction lands in a tempdir alongside
//!     the destination; only after both extraction + scrubbing
//!     succeed does the project move into its final name. Failures
//!     leave the jail untouched.
//!
//! Tunnel guests need a valid token (mirrors `files.rs`). LAN is
//! trusted so a desktop owner doesn't have to fish a token out of a
//! URL to upload a project.
//!
//! ## Upload
//!
//! `POST /sessions/upload?dest=<jail-relative-folder>`
//!
//! Body is the raw bytes of a `.zip`, `.tar.gz`, or `.tar.zst`.
//! Server extracts, scrubs, then renames into a fresh subfolder
//! under `dest`. Collisions get a numeric suffix (`my-session-2`).
//!
//! Returns JSON describing the resulting project path so the UI can
//! offer a one-click `launch_project` after upload finishes.
//!
//! ## Export
//!
//! `GET /sessions/export?path=<jail-relative-folder>`
//!
//! Server tars + gzips the directory and streams it back. We don't
//! save here — the UI sends `save_session` first and waits for
//! the dirty flag to clear before kicking off the download.

use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::Serialize;

use crate::session_scrub::{self, ScrubError};
use crate::AppState;

/// Cap on the compressed (wire) upload size. 1 GiB is a generous
/// ceiling for an Ardour project — compressed audio + the XML
/// session file rarely exceed a few hundred MB even with hours of
/// material. Trips before we touch the decompressor, so a maliciously
/// large stream never gets the chance to expand.
const MAX_UPLOAD_BYTES: usize = 1024 * 1024 * 1024;

/// Cap on the *uncompressed* total. Every file we write counts
/// against this. Catches zip bombs that make it past
/// `MAX_UPLOAD_BYTES` (a 10 MB compressed stream that expands to
/// 10 GB of zeros). 4 GiB is the realistic ceiling for a session's
/// audio + peak data.
const MAX_TOTAL_UNCOMPRESSED: u64 = 4 * 1024 * 1024 * 1024;

/// Per-archive entry-count cap. Real sessions have ~50 audio takes
/// and a handful of MIDI files; 50_000 is a generous ceiling that
/// still bounds memory + filesystem-call overhead from a "tar full
/// of zero-byte files" DoS.
const MAX_ENTRY_COUNT: u32 = 50_000;

#[derive(Serialize)]
struct UploadReply {
    /// Jail-relative path of the resulting project folder, ready to
    /// hand straight to `launch_project`.
    path: String,
    /// Human-friendly name (last path component).
    name: String,
    /// Archive format detected on the wire — useful to surface in the
    /// "Imported as <foo>" toast. Never affects the response shape.
    format: &'static str,
    /// Number of `.ardour` files the scrubber rewrote — surfaces in
    /// the UI as "scrubbed N session files" so the user knows we
    /// touched their data and what we did.
    files_scrubbed: usize,
    /// `<Script>` / `<LuaScripts>` / video-tooling blocks
    /// quarantined during scrub. Zero is the common case; a non-zero
    /// count is worth flagging in the UI because it means the
    /// upload would have run code (or smuggled commands into a
    /// helper process's stdin) if we hadn't intercepted them.
    scripts_removed: usize,
    /// History / instant.xml files deleted from the upload. These
    /// hit the libxml2 `XML_PARSE_HUGE` parser when Ardour reads
    /// them; they're regenerated on next save, so dropping is safe.
    files_deleted: usize,
}

#[derive(Serialize)]
struct ApiError {
    error: String,
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(ApiError { error: msg.into() })).into_response()
}

pub(crate) async fn upload(
    Query(q): Query<HashMap<String, String>>,
    State(state): State<Arc<AppState>>,
    tunnel_origin: Option<Extension<crate::ws::TunnelOrigin>>,
    body: Bytes,
) -> Response {
    if tunnel_origin.is_some() {
        let token = q.get("token").map(String::as_str);
        let authorized = match token {
            Some(t) => crate::tunnel::verify_token(&state, t).await.is_some(),
            None => false,
        };
        if !authorized {
            return err(StatusCode::UNAUTHORIZED, "auth required");
        }
    }

    let Some(jail) = state.jail.as_ref() else {
        return err(StatusCode::FORBIDDEN, "no jail configured");
    };

    if body.len() > MAX_UPLOAD_BYTES {
        return err(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("archive larger than {} bytes", MAX_UPLOAD_BYTES),
        );
    }

    let dest_rel = q.get("dest").cloned().unwrap_or_default();
    let dest_dir = match resolve_jail_dir(jail.root(), &dest_rel) {
        Ok(p) => p,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    if let Err(e) = std::fs::create_dir_all(&dest_dir) {
        return err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("create dest dir: {e}"),
        );
    }

    let format = match detect_format(&body) {
        Some(f) => f,
        None => {
            return err(
                StatusCode::BAD_REQUEST,
                "unrecognized archive (need .zip, .tar.gz, or .tar.zst)",
            )
        }
    };

    // Hint name from a query param so the UI can pass through the
    // original filename without forcing it into the folder layout.
    // Falls back to "imported" when nothing's provided.
    let hint = q
        .get("filename")
        .and_then(|f| sanitize_name_hint(f))
        .unwrap_or_else(|| "imported".to_string());

    // Extract into a tempdir under dest, then rename into the unique
    // final name once we're confident the archive was well-formed +
    // the XML scrubber accepted every .ardour file. tempfile cleans
    // up on Drop so a partial unpack never lands in the jail.
    let tmp = match tempfile::Builder::new()
        .prefix(".foyer-upload-")
        .tempdir_in(&dest_dir)
    {
        Ok(t) => t,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("temp dir: {e}")),
    };
    let staging = tmp.path().to_path_buf();

    let extract_result = tokio::task::spawn_blocking({
        let staging = staging.clone();
        let bytes = body.clone();
        move || -> Result<(), ExtractError> {
            match format {
                "zip" => extract_zip(&bytes, &staging),
                "tar.gz" => extract_tar(GzDecoder::new(Cursor::new(&bytes[..])), &staging),
                "tar.zst" => {
                    let dec = zstd::stream::read::Decoder::new(Cursor::new(&bytes[..]))
                        .map_err(|e| ExtractError::Format(format!("zstd: {e}")))?;
                    extract_tar(dec, &staging)
                }
                _ => unreachable!(),
            }
        }
    })
    .await;

    match extract_result {
        Ok(Ok(())) => {}
        Ok(Err(ExtractError::Format(detail))) => {
            return err(StatusCode::BAD_REQUEST, format!("extract: {detail}"))
        }
        Ok(Err(ExtractError::Unsafe(detail))) => {
            tracing::warn!("rejected unsafe archive contents: {}", detail);
            return err(StatusCode::BAD_REQUEST, format!("rejected: {detail}"));
        }
        Ok(Err(ExtractError::Io(e))) => {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("extract io: {e}"),
            )
        }
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("join: {e}")),
    }

    // Pick the project root: if the archive contained exactly one
    // top-level directory, treat that directory itself as the project
    // (avoids `imported/imported/...` nesting). Otherwise the staging
    // dir IS the project.
    let project_src = match single_top_level_dir(&staging) {
        Some(d) => d,
        None => staging.clone(),
    };

    // Scrub session-format files before the project leaves the
    // tempdir. A failure here aborts the upload — tempdir cleanup
    // erases the half-extracted tree. See `session_scrub.rs` for
    // what the Ardour scrubber accepts/rejects; other backends'
    // scrubbers (when added) are reachable via the same profile
    // registry without touching this dispatch.
    //
    // Today we route through the registry default (Ardour). Once
    // the upload endpoint gains a `?backend_id=` parameter (or the
    // body declares one), key off that instead so a Reaper upload
    // doesn't get walked by Ardour-only path validators.
    let profile = state.profiles().await.get_or_default("");
    let scrub_report = match tokio::task::spawn_blocking({
        let project_src = project_src.clone();
        move || match profile {
            Some(p) => p.scrub_project(&project_src),
            None => Ok(session_scrub::ScrubReport::default()),
        }
    })
    .await
    {
        Ok(Ok(r)) => r,
        Ok(Err(ScrubError::TooLarge { path, size, limit })) => {
            tracing::warn!(
                "session XML at {} is {size} bytes; refusing (limit {limit})",
                path.display()
            );
            return err(
                StatusCode::PAYLOAD_TOO_LARGE,
                format!(
                    "session XML at {} is {size} bytes (limit {limit})",
                    path.display()
                ),
            );
        }
        Ok(Err(ScrubError::UnsafePath { path, context })) => {
            tracing::warn!(
                "rejecting upload — {} contains unsafe path: {}",
                path.display(),
                context
            );
            return err(
                StatusCode::BAD_REQUEST,
                format!("session XML references unsafe path: {context}"),
            );
        }
        Ok(Err(ScrubError::Malformed { path, detail })) => {
            tracing::warn!(
                "rejecting upload — {} malformed: {}",
                path.display(),
                detail
            );
            return err(
                StatusCode::BAD_REQUEST,
                format!("session XML is malformed: {detail}"),
            );
        }
        Ok(Err(ScrubError::Io { path, source })) => {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("scrub io ({}): {source}", path.display()),
            );
        }
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("join: {e}")),
    };
    if scrub_report.scripts_removed > 0 || scrub_report.files_deleted > 0 {
        tracing::info!(
            "scrub: quarantined {} subtree(s) in {} .ardour file(s), deleted {} risk-prone state file(s)",
            scrub_report.scripts_removed,
            scrub_report.files_scrubbed,
            scrub_report.files_deleted,
        );
    }

    let final_dir = match unique_dir_name(&dest_dir, &hint) {
        Ok(p) => p,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("pick name: {e}")),
    };

    if let Err(e) = std::fs::rename(&project_src, &final_dir) {
        // Fall back to a recursive copy if rename fails (cross-fs is
        // unusual since tempdir lives under dest_dir, but a noatime
        // bind-mount can still trip rename). Tempdir cleanup handles
        // the staging tree on Drop either way.
        if let Err(e2) = copy_dir_recursive(&project_src, &final_dir) {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("install: rename={e}, copy={e2}"),
            );
        }
    }

    let rel = final_dir
        .strip_prefix(jail.root())
        .ok()
        .and_then(path_to_jail_string)
        .unwrap_or_default();
    let name = final_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("imported")
        .to_string();

    Json(UploadReply {
        path: rel,
        name,
        format,
        files_scrubbed: scrub_report.files_scrubbed,
        scripts_removed: scrub_report.scripts_removed,
        files_deleted: scrub_report.files_deleted,
    })
    .into_response()
}

pub(crate) async fn export(
    Query(q): Query<HashMap<String, String>>,
    State(state): State<Arc<AppState>>,
    tunnel_origin: Option<Extension<crate::ws::TunnelOrigin>>,
) -> Response {
    if tunnel_origin.is_some() {
        let token = q.get("token").map(String::as_str);
        let authorized = match token {
            Some(t) => crate::tunnel::verify_token(&state, t).await.is_some(),
            None => false,
        };
        if !authorized {
            return err(StatusCode::UNAUTHORIZED, "auth required");
        }
    }

    let Some(jail) = state.jail.as_ref() else {
        return err(StatusCode::FORBIDDEN, "no jail configured");
    };

    let path_rel = match q.get("path") {
        Some(p) if !p.trim().is_empty() => p.to_string(),
        _ => return err(StatusCode::BAD_REQUEST, "missing ?path="),
    };

    let abs = match resolve_jail_dir(jail.root(), &path_rel) {
        Ok(p) => p,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    if !abs.is_dir() {
        return err(StatusCode::NOT_FOUND, "not a directory");
    }

    let folder_name = abs
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project")
        .to_string();

    let bytes = match tokio::task::spawn_blocking({
        let abs = abs.clone();
        let folder_name = folder_name.clone();
        move || build_tar_gz(&abs, &folder_name)
    })
    .await
    {
        Ok(Ok(b)) => b,
        Ok(Err(e)) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("tar: {e}")),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("join: {e}")),
    };

    let filename = format!("{}.tar.gz", folder_name);
    let disposition = format!("attachment; filename=\"{}\"", filename.replace('"', ""));
    (
        [
            (header::CONTENT_TYPE, "application/gzip".to_string()),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        bytes,
    )
        .into_response()
}

fn detect_format(buf: &[u8]) -> Option<&'static str> {
    if buf.len() >= 4 && &buf[..4] == b"PK\x03\x04" {
        return Some("zip");
    }
    if buf.len() >= 2 && buf[0] == 0x1f && buf[1] == 0x8b {
        return Some("tar.gz");
    }
    if buf.len() >= 4 && buf[0] == 0x28 && buf[1] == 0xb5 && buf[2] == 0x2f && buf[3] == 0xfd {
        return Some("tar.zst");
    }
    None
}

fn sanitize_name_hint(raw: &str) -> Option<String> {
    let stem = Path::new(raw)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(raw);
    let stem = stem
        .strip_suffix(".tar.gz")
        .or_else(|| stem.strip_suffix(".tgz"))
        .or_else(|| stem.strip_suffix(".tar.zst"))
        .or_else(|| stem.strip_suffix(".tzst"))
        .or_else(|| stem.strip_suffix(".zip"))
        .or_else(|| stem.strip_suffix(".tar"))
        .unwrap_or(stem);
    let cleaned: String = stem
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
        .collect::<String>()
        .trim()
        .to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn resolve_jail_dir(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut clean = PathBuf::new();
    for c in Path::new(rel.trim_start_matches('/')).components() {
        match c {
            Component::Normal(s) => clean.push(s),
            Component::CurDir => {}
            _ => return Err("path must be jail-relative (no .. or absolute)".into()),
        }
    }
    let abs = root.join(&clean);
    let canon_root = root.canonicalize().map_err(|e| format!("jail root: {e}"))?;
    let mut probe = abs.clone();
    while !probe.exists() {
        if !probe.pop() {
            return Err("invalid jail path".into());
        }
    }
    let canon = probe
        .canonicalize()
        .map_err(|e| format!("canonicalize: {e}"))?;
    if !canon.starts_with(&canon_root) {
        return Err("path escapes jail".into());
    }
    Ok(abs)
}

fn unique_dir_name(parent: &Path, hint: &str) -> std::io::Result<PathBuf> {
    let candidate = parent.join(hint);
    if !candidate.exists() {
        return Ok(candidate);
    }
    for n in 2..=9999 {
        let attempt = parent.join(format!("{hint}-{n}"));
        if !attempt.exists() {
            return Ok(attempt);
        }
    }
    Err(std::io::Error::other(
        "ran out of suffixes finding a free name",
    ))
}

fn path_to_jail_string(p: &Path) -> Option<String> {
    let parts: Vec<String> = p
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => s.to_str().map(|s| s.to_string()),
            _ => None,
        })
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

#[derive(Debug, thiserror::Error)]
enum ExtractError {
    #[error("{0}")]
    Format(String),
    #[error("{0}")]
    Unsafe(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

/// Validate and clean a path string from an archive entry. Returns
/// `None` when the path is unsafe (absolute, has `..`, contains a
/// drive letter, etc.) so the caller can reject the whole archive.
fn safe_archive_path(raw: &Path) -> Option<PathBuf> {
    let mut clean = PathBuf::new();
    for c in raw.components() {
        match c {
            Component::Normal(s) => clean.push(s),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if clean.as_os_str().is_empty() {
        return None;
    }
    Some(clean)
}

fn extract_zip(bytes: &[u8], dest: &Path) -> Result<(), ExtractError> {
    extract_zip_with_caps(bytes, dest, MAX_TOTAL_UNCOMPRESSED, MAX_ENTRY_COUNT)
}

fn extract_zip_with_caps(
    bytes: &[u8],
    dest: &Path,
    max_total_bytes: u64,
    max_entries: u32,
) -> Result<(), ExtractError> {
    let cursor = Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| ExtractError::Format(format!("zip: {e}")))?;
    if archive.len() as u64 > max_entries as u64 {
        return Err(ExtractError::Unsafe(format!(
            "zip has {} entries (limit {})",
            archive.len(),
            max_entries
        )));
    }
    let mut total_bytes: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| ExtractError::Format(format!("zip entry: {e}")))?;
        // `enclosed_name()` already drops `..` and absolute paths,
        // but we also re-check via `safe_archive_path` so the rule
        // is consistent across formats.
        let raw_name = match entry.enclosed_name() {
            Some(n) => n,
            None => {
                return Err(ExtractError::Unsafe(format!(
                    "zip entry has unsafe name: {}",
                    entry.name()
                )))
            }
        };
        let cleaned = safe_archive_path(&raw_name).ok_or_else(|| {
            ExtractError::Unsafe(format!("zip entry has unsafe name: {}", entry.name()))
        })?;
        let target = dest.join(&cleaned);
        if !target.starts_with(dest) {
            return Err(ExtractError::Unsafe(format!(
                "zip entry escapes destination: {}",
                entry.name()
            )));
        }
        // Reject Unix symlinks recorded in the zip extras. zip
        // doesn't have a portable symlink concept, so this is
        // purely an attacker-only feature in archives produced by
        // `zip -y`.
        if let Some(mode) = entry.unix_mode() {
            const S_IFMT: u32 = 0o170000;
            const S_IFLNK: u32 = 0o120000;
            if mode & S_IFMT == S_IFLNK {
                return Err(ExtractError::Unsafe(format!(
                    "zip entry is a symlink: {}",
                    entry.name()
                )));
            }
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Cap the total uncompressed payload so a zip bomb that got
        // past `MAX_UPLOAD_BYTES` (high compression ratio) can't
        // exhaust disk. `zip::read::ZipFile` impls `Read`; wrapping
        // it in `take()` enforces the budget per-entry while we
        // accumulate against the global cap.
        let remaining = max_total_bytes.checked_sub(total_bytes).ok_or_else(|| {
            ExtractError::Unsafe(format!(
                "uncompressed payload exceeds {} bytes",
                max_total_bytes
            ))
        })?;
        let mut f = std::fs::File::create(&target)?;
        let mut limited = (&mut entry).take(remaining + 1);
        let n = std::io::copy(&mut limited, &mut f)?;
        total_bytes = total_bytes.saturating_add(n);
        if total_bytes > max_total_bytes {
            return Err(ExtractError::Unsafe(format!(
                "uncompressed payload exceeds {} bytes",
                max_total_bytes
            )));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                // Strip setuid/setgid/sticky bits — none of those
                // are legitimately set inside a session archive.
                let mode = mode & 0o7777 & !0o7000;
                let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode));
            }
        }
    }
    Ok(())
}

/// Generic safe tar extraction. Used by the tar.gz and tar.zst
/// paths via different `Read` adapters. Refuses anything other
/// than regular files + directories; caps total size + entry count;
/// validates every path against `safe_archive_path`.
fn extract_tar<R: Read>(reader: R, dest: &Path) -> Result<(), ExtractError> {
    extract_tar_with_caps(reader, dest, MAX_TOTAL_UNCOMPRESSED, MAX_ENTRY_COUNT)
}

fn extract_tar_with_caps<R: Read>(
    reader: R,
    dest: &Path,
    max_total_bytes: u64,
    max_entries: u32,
) -> Result<(), ExtractError> {
    let mut tar = tar::Archive::new(reader);
    let mut total_bytes: u64 = 0;
    let mut entries_seen: u32 = 0;

    let entries = tar
        .entries()
        .map_err(|e| ExtractError::Format(format!("tar: {e}")))?;
    for entry_result in entries {
        let mut entry =
            entry_result.map_err(|e| ExtractError::Format(format!("tar entry: {e}")))?;
        entries_seen = entries_seen.saturating_add(1);
        if entries_seen > max_entries {
            return Err(ExtractError::Unsafe(format!(
                "tar exceeds {max_entries} entries"
            )));
        }
        let raw_path = entry
            .path()
            .map_err(|e| ExtractError::Format(format!("tar path: {e}")))?
            .into_owned();
        let cleaned = safe_archive_path(&raw_path).ok_or_else(|| {
            ExtractError::Unsafe(format!("tar entry has unsafe path: {}", raw_path.display()))
        })?;
        let target = dest.join(&cleaned);
        if !target.starts_with(dest) {
            return Err(ExtractError::Unsafe(format!(
                "tar entry escapes destination: {}",
                raw_path.display()
            )));
        }
        // Snapshot every header field we need up front so we can
        // re-borrow `entry` mutably (for `Read::take`) below without
        // tripping the borrow checker on a still-live `header` ref.
        let entry_type = entry.header().entry_type();
        // Only consumed by the cfg(unix) permissions block below —
        // allow the dead binding on Windows rather than cfg-gating
        // the read (keeping the header snapshot unconditional keeps
        // the borrow-checker dance above it identical on every OS).
        #[cfg_attr(not(unix), allow(unused_variables))]
        let mode_bits = entry.header().mode().ok();
        match entry_type {
            tar::EntryType::Directory => {
                std::fs::create_dir_all(&target)?;
            }
            tar::EntryType::Regular | tar::EntryType::Continuous => {
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let remaining = max_total_bytes.checked_sub(total_bytes).ok_or_else(|| {
                    ExtractError::Unsafe(format!(
                        "uncompressed payload exceeds {} bytes",
                        max_total_bytes
                    ))
                })?;
                let mut file = std::fs::File::create(&target)?;
                let mut limited = (&mut entry).take(remaining + 1);
                let n = std::io::copy(&mut limited, &mut file)?;
                total_bytes = total_bytes.saturating_add(n);
                if total_bytes > max_total_bytes {
                    return Err(ExtractError::Unsafe(format!(
                        "uncompressed payload exceeds {} bytes",
                        max_total_bytes
                    )));
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Some(mode) = mode_bits {
                        let mode = mode & 0o7777 & !0o7000;
                        let _ = std::fs::set_permissions(
                            &target,
                            std::fs::Permissions::from_mode(mode),
                        );
                    }
                }
            }
            tar::EntryType::Symlink | tar::EntryType::Link => {
                return Err(ExtractError::Unsafe(format!(
                    "tar entry is a {:?} (refusing): {}",
                    entry_type,
                    raw_path.display()
                )));
            }
            tar::EntryType::Char | tar::EntryType::Block | tar::EntryType::Fifo => {
                // Drop device nodes silently — they're never
                // legitimate in a session archive, but a tar from
                // `tar -cpf` of a system directory can pick them up
                // accidentally.
                continue;
            }
            _ => {
                // GNU long-name / pax extensions / sparse markers
                // are surface artifacts of the format; tar-rs handles
                // them transparently for the underlying entries we
                // care about.
                continue;
            }
        }
    }
    Ok(())
}

fn build_tar_gz(src: &Path, top_name: &str) -> std::io::Result<Vec<u8>> {
    let buf: Vec<u8> = Vec::new();
    let enc = GzEncoder::new(buf, Compression::default());
    let mut builder = tar::Builder::new(enc);
    builder.follow_symlinks(false);
    builder
        .append_dir_all(top_name, src)
        .map_err(|e| std::io::Error::other(format!("append: {e}")))?;
    let enc = builder
        .into_inner()
        .map_err(|e| std::io::Error::other(format!("finish tar: {e}")))?;
    let mut buf = enc
        .finish()
        .map_err(|e| std::io::Error::other(format!("finish gzip: {e}")))?;
    buf.shrink_to_fit();
    Ok(buf)
}

fn single_top_level_dir(p: &Path) -> Option<PathBuf> {
    let mut found: Option<PathBuf> = None;
    let rd = std::fs::read_dir(p).ok()?;
    for ent in rd.flatten() {
        if found.is_some() {
            return None;
        }
        let ft = ent.file_type().ok()?;
        if !ft.is_dir() {
            return None;
        }
        found = Some(ent.path());
    }
    found
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for ent in std::fs::read_dir(src)? {
        let ent = ent?;
        let ft = ent.file_type()?;
        let from = ent.path();
        let to = dst.join(ent.file_name());
        if ft.is_symlink() {
            // Mirror the extractor's "no symlinks" stance — if
            // anything got here despite the extractor's checks, drop
            // it on the floor rather than copy it through.
            continue;
        }
        if ft.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use std::io::Write;
    use tar::{Builder, Header};

    /// Build a tar.gz with a single regular-file entry.
    fn tar_gz_single_file(name: &str, contents: &[u8]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let enc = GzEncoder::new(&mut buf, flate2::Compression::default());
            let mut tb = Builder::new(enc);
            let mut h = Header::new_gnu();
            h.set_path(name).unwrap();
            h.set_size(contents.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            tb.append(&h, contents).unwrap();
            tb.into_inner().unwrap().finish().unwrap();
        }
        buf
    }

    /// Build a single-entry tar by hand, using a raw 512-byte header
    /// plus null-padded body. We use this for path-traversal cases
    /// (`..`, absolute) because `tar::Header::set_path` refuses them
    /// at *write* time — quite reasonably — which prevents us from
    /// generating the malicious tarballs an attacker would. A real
    /// attacker uses GNU `tar` (which has no such qualms) or rolls
    /// their own bytes; mirroring that here lets us exercise the
    /// extractor's defenses.
    fn raw_tar_gz_with_path(unsafe_path: &str, body: &[u8]) -> Vec<u8> {
        let mut header = [0u8; 512];

        // name (0..100). Truncate if too long; in tests we never
        // exceed.
        let name = unsafe_path.as_bytes();
        let name_len = name.len().min(100);
        header[..name_len].copy_from_slice(&name[..name_len]);

        // mode (100..108): "0000644\0"
        header[100..108].copy_from_slice(b"0000644\0");
        // uid (108..116): "0000000\0"
        header[108..116].copy_from_slice(b"0000000\0");
        // gid (116..124): "0000000\0"
        header[116..124].copy_from_slice(b"0000000\0");
        // size (124..136): octal, NUL-terminated
        let size_str = format!("{:011o}\0", body.len());
        header[124..136].copy_from_slice(size_str.as_bytes());
        // mtime (136..148): "00000000000\0"
        header[136..148].copy_from_slice(b"00000000000\0");
        // chksum (148..156): set to spaces for the chksum computation
        header[148..156].copy_from_slice(b"        ");
        // typeflag (156): '0' = regular file
        header[156] = b'0';
        // magic + version (257..265): "ustar\000"
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");

        // Compute checksum: sum of every byte in the (cksum-as-spaces) header.
        let cksum: u32 = header.iter().map(|&b| b as u32).sum();
        // Format as 6-digit octal + NUL + space, per ustar.
        let cksum_str = format!("{:06o}\0 ", cksum);
        header[148..156].copy_from_slice(cksum_str.as_bytes());

        let mut raw = Vec::new();
        raw.extend_from_slice(&header);
        // Body, then pad to 512.
        raw.extend_from_slice(body);
        let pad = (512 - body.len() % 512) % 512;
        raw.extend(std::iter::repeat(0u8).take(pad));
        // Two 512-byte zero blocks = end-of-archive.
        raw.extend(std::iter::repeat(0u8).take(1024));

        // Wrap in gzip.
        let mut gz = Vec::new();
        {
            let mut enc = GzEncoder::new(&mut gz, flate2::Compression::default());
            enc.write_all(&raw).unwrap();
            enc.finish().unwrap();
        }
        gz
    }

    #[test]
    fn rejects_tar_with_dotdot_path() {
        let bytes = raw_tar_gz_with_path("../etc/passwd", b"x");
        let dir = tempfile::tempdir().unwrap();
        let res = extract_tar(GzDecoder::new(Cursor::new(&bytes[..])), dir.path());
        assert!(matches!(res, Err(ExtractError::Unsafe(_))), "{:?}", res);
    }

    #[test]
    fn rejects_tar_with_absolute_path() {
        let bytes = raw_tar_gz_with_path("/etc/passwd", b"x");
        let dir = tempfile::tempdir().unwrap();
        let res = extract_tar(GzDecoder::new(Cursor::new(&bytes[..])), dir.path());
        assert!(matches!(res, Err(ExtractError::Unsafe(_))), "{:?}", res);
    }

    #[test]
    fn rejects_tar_with_symlink_entry() {
        // Build a tar with a symlink header by hand. tar-rs's
        // Header::set_entry_type lets us pick the type.
        let mut buf = Vec::new();
        {
            let enc = GzEncoder::new(&mut buf, flate2::Compression::default());
            let mut tb = Builder::new(enc);
            let mut h = Header::new_gnu();
            h.set_path("link").unwrap();
            h.set_size(0);
            h.set_entry_type(tar::EntryType::Symlink);
            h.set_link_name("/etc/passwd").unwrap();
            h.set_cksum();
            tb.append(&h, std::io::empty()).unwrap();
            tb.into_inner().unwrap().finish().unwrap();
        }
        let dir = tempfile::tempdir().unwrap();
        let res = extract_tar(GzDecoder::new(Cursor::new(&buf[..])), dir.path());
        assert!(matches!(res, Err(ExtractError::Unsafe(_))), "{:?}", res);
    }

    /// Build a tar.gz containing a single file with `body_size`
    /// bytes of zeros declared in the header. Caller picks the size
    /// so a bomb test can trip a low cap without paying to push 4
    /// GiB through the gzip encoder.
    fn tar_gz_zero_file(body_size: u64) -> Vec<u8> {
        let mut buf = Vec::new();
        let enc = GzEncoder::new(&mut buf, flate2::Compression::default());
        let mut tb = Builder::new(enc);
        let mut h = Header::new_gnu();
        h.set_path("big").unwrap();
        h.set_size(body_size);
        h.set_mode(0o644);
        h.set_cksum();
        let zeros = std::io::repeat(0u8).take(body_size);
        tb.append(&h, zeros).unwrap();
        tb.into_inner().unwrap().finish().unwrap();
        buf
    }

    #[test]
    fn extract_tar_trips_uncompressed_cap() {
        // Drive the cap path with a small budget so the test runs in
        // milliseconds. Same code path that defends against zip-
        // bombs in production with the 4 GiB cap.
        let bytes = tar_gz_zero_file(8 * 1024); // 8 KiB body
        let dir = tempfile::tempdir().unwrap();
        let res = extract_tar_with_caps(
            GzDecoder::new(Cursor::new(&bytes[..])),
            dir.path(),
            1024, // 1 KiB cap — well under the 8 KiB body
            MAX_ENTRY_COUNT,
        );
        assert!(matches!(res, Err(ExtractError::Unsafe(_))), "{:?}", res);
    }

    #[test]
    fn extract_tar_trips_entry_count_cap() {
        // 5 entries; cap at 3.
        let mut buf = Vec::new();
        {
            let enc = GzEncoder::new(&mut buf, flate2::Compression::default());
            let mut tb = Builder::new(enc);
            for i in 0..5 {
                let mut h = Header::new_gnu();
                h.set_path(format!("f{i}")).unwrap();
                h.set_size(0);
                h.set_mode(0o644);
                h.set_cksum();
                tb.append(&h, std::io::empty()).unwrap();
            }
            tb.into_inner().unwrap().finish().unwrap();
        }
        let dir = tempfile::tempdir().unwrap();
        let res = extract_tar_with_caps(
            GzDecoder::new(Cursor::new(&buf[..])),
            dir.path(),
            MAX_TOTAL_UNCOMPRESSED,
            3,
        );
        assert!(matches!(res, Err(ExtractError::Unsafe(_))), "{:?}", res);
    }

    #[test]
    fn extracts_clean_tar_normally() {
        let bytes = tar_gz_single_file("project/file.txt", b"hello");
        let dir = tempfile::tempdir().unwrap();
        extract_tar(GzDecoder::new(Cursor::new(&bytes[..])), dir.path()).unwrap();
        let body = std::fs::read(dir.path().join("project/file.txt")).unwrap();
        assert_eq!(body, b"hello");
    }
}
