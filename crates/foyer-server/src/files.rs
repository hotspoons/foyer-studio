//! `/files/<jail-relative-path>` — raw file bytes for the text-preview
//! component. Paths are resolved through the same `Jail` that `browse_path`
//! uses, so the same symlink-escape protection applies.
//!
//! When the request arrives over the tunnel listener (carrying a
//! `TunnelOrigin` extension), we additionally require a valid `?token=`
//! query parameter that matches an authenticated tunnel connection.
//! LAN connections (no `TunnelOrigin`) skip the check, mirroring how
//! the WS upgrade treats LAN as trusted.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Extension, Path as AxumPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::AppState;

pub(crate) async fn serve_file(
    AxumPath(raw): AxumPath<String>,
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
            return (StatusCode::UNAUTHORIZED, "auth required").into_response();
        }
    }

    let Some(jail) = state.jail.as_ref() else {
        return (StatusCode::FORBIDDEN, "no jail configured").into_response();
    };

    let sanitized = sanitize(&raw);
    let abs = jail.root().join(&sanitized);
    let canon = match abs.canonicalize() {
        Ok(p) => p,
        Err(_) => return (StatusCode::NOT_FOUND, "no such file").into_response(),
    };
    let root_canon = match jail.root().canonicalize() {
        Ok(p) => p,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "bad jail").into_response(),
    };
    if !canon.starts_with(&root_canon) {
        return (StatusCode::FORBIDDEN, "path escapes jail").into_response();
    }
    let bytes = match tokio::fs::read(&canon).await {
        Ok(b) => b,
        Err(_) => return (StatusCode::NOT_FOUND, "couldn't read").into_response(),
    };
    // Profiles get first crack at the MIME type so a backend can
    // claim its own project file extension (`.ardour` →
    // `application/xml`); fall back to the generic guesser for
    // common non-DAW extensions.
    let ext_lower = canon
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let profiles = state.profiles().await;
    let mime = profiles
        .iter()
        .find_map(|p| p.mime_for_extension(&ext_lower))
        .unwrap_or_else(|| guess_mime(&canon));
    ([(header::CONTENT_TYPE, mime)], bytes).into_response()
}

/// Jail-safe relative path: strip leading slashes, drop `..` and other
/// non-normal components. Used by `/files/*` and import-audio resolution.
pub(crate) fn sanitize_relative_path(raw: &str) -> PathBuf {
    sanitize(raw)
}

/// Forward-slash jail-relative path for WS / backend (no leading slash).
pub(crate) fn rel_path_wire(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn sanitize(raw: &str) -> PathBuf {
    let trimmed = raw.trim_start_matches('/').trim();
    let mut out = PathBuf::new();
    for c in Path::new(trimmed).components() {
        if let Component::Normal(os) = c {
            out.push(os);
        }
    }
    out
}

fn guess_mime(p: &Path) -> &'static str {
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "md" | "markdown" => "text/markdown; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "xml" | "svg" => "application/xml; charset=utf-8",
        "yaml" | "yml" => "application/yaml; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "lua" | "toml" | "txt" | "log" | "patch" => "text/plain; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}
