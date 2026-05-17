// SPDX-License-Identifier: Apache-2.0
//! DAW-scripting `Command` handlers — `ListScripts`, `SaveScript`,
//! `DeleteScript`, `EnableScript`, `RunScript`,
//! `RecoverDisabledScripts`. Split out of `mod.rs`'s monolithic
//! `dispatch_command` match so the per-family logic lives close to
//! the related backend trait surface. Each function returns the
//! arm's body verbatim; the caller match arm is one line.

use std::sync::Arc;

use foyer_schema::{EntityId, Event, Script};

use super::broadcast_event;
use crate::AppState;

pub(super) async fn list_scripts(state: &Arc<AppState>) -> Result<(), super::DispatchError> {
    let scripts = state.backend().await.list_scripts().await?;
    broadcast_event(state, Event::ScriptList { scripts }).await;
    Ok(())
}

pub(super) async fn save_script(state: &Arc<AppState>, peer_id: &str, script: Script) {
    let script_id_for_err = script.id.clone();
    if let Err(e) = state.backend().await.save_script(script).await {
        broadcast_event(
            state,
            Event::error_localized(
                "save_script_failed",
                foyer_i18n::loc!(
                    "Script %{id} couldn't be saved: %{reason}",
                    id = script_id_for_err,
                    reason = e
                ),
                Some(peer_id.into()),
            ),
        )
        .await;
    }
    // Backend echoes `ScriptSaved` on success via its event stream.
}

pub(super) async fn delete_script(state: &Arc<AppState>, peer_id: &str, id: EntityId) {
    if let Err(e) = state.backend().await.delete_script(id).await {
        broadcast_event(
            state,
            Event::Error {
                code: "delete_script_failed".into(),
                message: e.to_string(),
                target_peer_id: Some(peer_id.into()),
                localized: None,
            },
        )
        .await;
    }
}

pub(super) async fn enable_script(
    state: &Arc<AppState>,
    peer_id: &str,
    id: EntityId,
    enabled: bool,
) {
    if let Err(e) = state.backend().await.enable_script(id, enabled).await {
        broadcast_event(
            state,
            Event::Error {
                code: "enable_script_failed".into(),
                message: e.to_string(),
                target_peer_id: Some(peer_id.into()),
                localized: None,
            },
        )
        .await;
    }
}

pub(super) async fn run_script(
    state: &Arc<AppState>,
    peer_id: &str,
    id: EntityId,
    args_override: Option<std::collections::BTreeMap<String, String>>,
) {
    match state
        .backend()
        .await
        .run_script(id.clone(), args_override)
        .await
    {
        Ok(result) => {
            // Backend tx already fanned out; emit explicitly too so
            // callers that don't subscribe to the snapshot stream
            // (one-shot HTTP-ish clients) still get the reply.
            // Duplicates are harmless — the UI dedupes on
            // `result.id` + monotonic seq.
            broadcast_event(state, Event::ScriptRunResult { result }).await;
        }
        Err(e) => {
            broadcast_event(
                state,
                Event::Error {
                    code: "run_script_failed".into(),
                    message: e.to_string(),
                    target_peer_id: Some(peer_id.into()),
                    localized: None,
                },
            )
            .await;
        }
    }
}

pub(super) async fn recover_disabled_scripts(state: &Arc<AppState>, peer_id: &str) {
    match state.backend().await.recover_disabled_scripts().await {
        Ok(recovered) => {
            // Re-emit the full list so clients pick up the recovered
            // entries with `disabled_on_upload=true`.
            if !recovered.is_empty() {
                if let Ok(scripts) = state.backend().await.list_scripts().await {
                    broadcast_event(state, Event::ScriptList { scripts }).await;
                }
            }
        }
        Err(e) => {
            broadcast_event(
                state,
                Event::Error {
                    code: "recover_disabled_scripts_failed".into(),
                    message: e.to_string(),
                    target_peer_id: Some(peer_id.into()),
                    localized: None,
                },
            )
            .await;
        }
    }
}
