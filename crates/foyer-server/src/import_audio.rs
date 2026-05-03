//! `POST /sessions/import_audio` — upload PCM-friendly audio into the
//! current session's `interchange/<session>/audiofiles/` tree (Ardour layout),
//! returning the jail-relative path for a follow-up `ImportAudio` WebSocket command.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use axum::extract::{Extension, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::body::Bytes;
use serde::Serialize;
use std::sync::Arc;

use crate::AppState;

const MAX_IMPORT_BYTES: usize = 256 * 1024 * 1024;

#[derive(Serialize)]
struct ImportOk {
    path: String,
}

#[derive(Serialize)]
struct ApiError {
    error: String,
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (
        status,
        axum::Json(ApiError {
            error: msg.into(),
        }),
    )
        .into_response()
}

fn allowed_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "wav" | "wave" | "flac" | "aif" | "aiff" | "ogg" | "oga"
    )
}

fn session_audiofiles_dir(project_file: &str) -> PathBuf {
    let p = Path::new(project_file);
    let parent = p.parent().unwrap_or_else(|| Path::new("."));
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("session");
    parent.join("interchange").join(stem).join("audiofiles")
}

pub(crate) async fn import_audio(
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

    if body.len() > MAX_IMPORT_BYTES {
        return err(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("file larger than {} bytes", MAX_IMPORT_BYTES),
        );
    }

    let session_id = match q.get("session_id") {
        Some(s) => foyer_schema::EntityId::new(s.clone()),
        None => return err(StatusCode::BAD_REQUEST, "session_id required"),
    };

    let filename = q
        .get("filename")
        .map(String::as_str)
        .unwrap_or("audio.wav");
    let filename = filename.trim();
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') {
        return err(StatusCode::BAD_REQUEST, "invalid filename");
    }
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if !allowed_extension(ext) {
        return err(
            StatusCode::BAD_REQUEST,
            "unsupported extension — use WAV, FLAC, AIFF, or Ogg",
        );
    }

    let rel_for_session = {
        let Some(project_file) = state
            .sessions
            .project_file_abs_path(&session_id)
            .await
        else {
            return err(StatusCode::NOT_FOUND, "no such open session");
        };
        let audio_dir = session_audiofiles_dir(&project_file);
        if let Err(e) = std::fs::create_dir_all(&audio_dir) {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("create audiofiles dir: {e}"),
            );
        }
        let unique = format!(
            "foyer-import-{}-{}",
            uuid::Uuid::new_v4().simple(),
            filename
        );
        let dest_abs = audio_dir.join(&unique);
        if let Err(e) = std::fs::write(&dest_abs, &body[..]) {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("write file: {e}"),
            );
        }
        let jail_root = match jail.root().canonicalize() {
            Ok(p) => p,
            Err(e) => {
                return err(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("jail root: {e}"),
                )
            }
        };
        let canon_file = match dest_abs.canonicalize() {
            Ok(p) => p,
            Err(e) => {
                return err(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("canonicalize dest: {e}"),
                )
            }
        };
        if !canon_file.starts_with(&jail_root) {
            return err(StatusCode::INTERNAL_SERVER_ERROR, "path under jail");
        }
        path_to_jail_rel(&jail_root, &canon_file)
    };

    let Some(path) = rel_for_session else {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "could not build jail-relative path");
    };

    axum::Json(ImportOk { path }).into_response()
}

fn path_to_jail_rel(jail_root: &Path, file: &Path) -> Option<String> {
    let rel = file.strip_prefix(jail_root).ok()?;
    let s = rel.to_string_lossy().replace('\\', "/");
    Some(s.trim_start_matches('/').to_string())
}
