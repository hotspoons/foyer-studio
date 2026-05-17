// SPDX-License-Identifier: Apache-2.0
//! Undo / redo + undo-group bracketing. Tiny shims around the
//! backend's transactional surface — every failure becomes a
//! targeted toast on the FE.

use std::sync::Arc;

use foyer_schema::Event;

use super::broadcast_event;
use crate::AppState;

pub(super) async fn undo_group_begin(state: &Arc<AppState>, name: String) {
    if let Err(e) = state.backend().await.undo_group_begin(name).await {
        broadcast_event(
            state,
            Event::Error {
                code: "undo_group_begin_failed".into(),
                message: e.to_string(),
                target_peer_id: None,
                localized: None,
            },
        )
        .await;
    }
}

pub(super) async fn undo_group_end(state: &Arc<AppState>) {
    if let Err(e) = state.backend().await.undo_group_end().await {
        broadcast_event(
            state,
            Event::Error {
                code: "undo_group_end_failed".into(),
                message: e.to_string(),
                target_peer_id: None,
                localized: None,
            },
        )
        .await;
    }
}

pub(super) async fn undo(state: &Arc<AppState>) {
    if let Err(e) = state.backend().await.undo().await {
        broadcast_event(
            state,
            Event::Error {
                code: "undo_failed".into(),
                message: e.to_string(),
                target_peer_id: None,
                localized: None,
            },
        )
        .await;
    }
}

pub(super) async fn redo(state: &Arc<AppState>) {
    if let Err(e) = state.backend().await.redo().await {
        broadcast_event(
            state,
            Event::Error {
                code: "redo_failed".into(),
                message: e.to_string(),
                target_peer_id: None,
                localized: None,
            },
        )
        .await;
    }
}
