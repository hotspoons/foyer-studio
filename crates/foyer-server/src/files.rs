//! `/files/<jail-relative-path>` — raw file bytes for the text-preview
//! component. Paths are resolved through the same `Jail` that `browse_path`
//! uses, so the same symlink-escape protection applies.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Path as AxumPath, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::AppState;

pub(crate) async fn serve_file(
    AxumPath(raw): AxumPath<String>,
    State(state): State<Arc<AppState>>,
) -> Response {
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
    let mime = guess_mime(&canon);
    ([(header::CONTENT_TYPE, mime)], bytes).into_response()
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
        "xml" | "ardour" | "svg" => "application/xml; charset=utf-8",
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
