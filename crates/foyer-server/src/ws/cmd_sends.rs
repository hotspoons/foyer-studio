// SPDX-License-Identifier: Apache-2.0
//! Send routing — AddSend / RemoveSend / SetSendLevel. Thin
//! wrappers around the backend trait that emit `Event::Error` on
//! failure so the mixer's send strip can show a toast instead of
//! a silent no-op.

use std::sync::Arc;

use foyer_schema::{EntityId, Event};

use super::broadcast_event;
use crate::AppState;

pub(super) async fn add_send(
    state: &Arc<AppState>,
    track_id: EntityId,
    target_track_id: EntityId,
    pre_fader: bool,
) {
    if let Err(e) = state
        .backend()
        .await
        .add_send(track_id, target_track_id, pre_fader)
        .await
    {
        broadcast_event(
            state,
            Event::Error {
                code: "add_send_failed".into(),
                message: e.to_string(),
                target_peer_id: None,
                localized: None,
            },
        )
        .await;
    }
}

pub(super) async fn remove_send(state: &Arc<AppState>, send_id: EntityId) {
    if let Err(e) = state.backend().await.remove_send(send_id).await {
        broadcast_event(
            state,
            Event::Error {
                code: "remove_send_failed".into(),
                message: e.to_string(),
                target_peer_id: None,
                localized: None,
            },
        )
        .await;
    }
}

pub(super) async fn set_send_level(state: &Arc<AppState>, send_id: EntityId, level: f64) {
    if let Err(e) = state.backend().await.set_send_level(send_id, level).await {
        broadcast_event(
            state,
            Event::Error {
                code: "set_send_level_failed".into(),
                message: e.to_string(),
                target_peer_id: None,
                localized: None,
            },
        )
        .await;
    }
}
