// SPDX-License-Identifier: Apache-2.0
//! Track-group `Command` handlers — `CreateGroup`, `UpdateGroup`,
//! `DeleteGroup`. Pure backend pass-through with toast-on-error.

use std::sync::Arc;

use foyer_schema::{EntityId, Event, GroupPatch};

use super::broadcast_event;
use crate::AppState;

pub(super) async fn create_group(
    state: &Arc<AppState>,
    name: String,
    color: Option<String>,
    members: Vec<EntityId>,
) {
    if let Err(e) = state
        .backend()
        .await
        .create_group(name, color, members)
        .await
    {
        broadcast_event(
            state,
            Event::Error {
                code: "create_group_failed".into(),
                message: e.to_string(),
                target_peer_id: None,
                localized: None,
            },
        )
        .await;
    }
}

pub(super) async fn update_group(state: &Arc<AppState>, id: EntityId, patch: GroupPatch) {
    if let Err(e) = state.backend().await.update_group(id, patch).await {
        broadcast_event(
            state,
            Event::Error {
                code: "update_group_failed".into(),
                message: e.to_string(),
                target_peer_id: None,
                localized: None,
            },
        )
        .await;
    }
}

pub(super) async fn delete_group(state: &Arc<AppState>, id: EntityId) {
    if let Err(e) = state.backend().await.delete_group(id).await {
        broadcast_event(
            state,
            Event::Error {
                code: "delete_group_failed".into(),
                message: e.to_string(),
                target_peer_id: None,
                localized: None,
            },
        )
        .await;
    }
}
