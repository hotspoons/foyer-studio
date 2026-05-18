// SPDX-License-Identifier: Apache-2.0
//! Action-catalog + recents `Command` handlers. Two small, related
//! domains: the shim's parameterless action catalog (`list_actions`
//! / `invoke_action`) and the launcher's recent-projects ring
//! (`list_recents` / `forget_recent` / `clear_recents`).

use std::sync::Arc;

use foyer_schema::{EntityId, Event};

use super::{broadcast_event, DispatchError};
use crate::AppState;

pub(super) async fn list_actions(state: &Arc<AppState>) -> Result<(), DispatchError> {
    let actions = state.backend().await.list_actions().await?;
    broadcast_event(state, Event::ActionsList { actions }).await;
    Ok(())
}

pub(super) async fn invoke_action(
    state: &Arc<AppState>,
    id: EntityId,
) -> Result<(), DispatchError> {
    // Route to the backend. If the action is unknown (shim hasn't
    // wired it up yet) translate the error into a user-visible
    // `Event::Error` so the startup-errors modal / console view
    // pick it up — silently WARN-logging meant the UI had no idea
    // the click did nothing. Transport actions land via the
    // trait-default translation to set_control so they keep working
    // even against a shim that doesn't know about them.
    let id_str = id.as_str().to_string();
    match state.backend().await.invoke_action(id).await {
        Ok(()) => Ok(()),
        Err(foyer_backend::BackendError::UnknownAction(_)) => {
            broadcast_event(
                state,
                Event::Error {
                    code: "action_unimplemented".into(),
                    message: format!(
                        "Action `{id_str}` isn't wired up in the current backend yet."
                    ),
                    target_peer_id: None,
                    localized: None,
                },
            )
            .await;
            Ok(())
        }
        Err(e) => Err(DispatchError::Backend(e)),
    }
}

pub(super) async fn list_recents(state: &Arc<AppState>) {
    let recents = crate::recents::load().await;
    broadcast_event(state, Event::RecentsList { recents }).await;
}

pub(super) async fn forget_recent(state: &Arc<AppState>, path: String) {
    // Normalize the inbound path the same way `touch` does so a
    // Forget click from the UI lands on the canonical key even if
    // the client cached an absolute or differently-resolved string.
    // (Old recents files written before normalization may still hold
    // non-canonical entries — the Forget click sees the displayed
    // path, which IS canonical now, so this also matches new
    // entries.)
    let jail_root = state.sessions.jail_root.read().await.clone();
    let normalized = crate::recents::normalize_path(&path, jail_root.as_deref());
    let mut recents = crate::recents::forget(&normalized).await;
    // Defensive: if the click came in pre-normalization shape (e.g.
    // an old client tab that still has the absolute path cached),
    // retry with the raw input so the user can actually evict the
    // entry they're looking at.
    if normalized != path {
        recents = crate::recents::forget(&path).await;
    }
    broadcast_event(state, Event::RecentsList { recents }).await;
}

pub(super) async fn clear_recents(state: &Arc<AppState>) {
    let recents = crate::recents::clear().await;
    broadcast_event(state, Event::RecentsList { recents }).await;
}
