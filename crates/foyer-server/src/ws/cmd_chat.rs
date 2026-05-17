// SPDX-License-Identifier: Apache-2.0
//! Chat + PTT + track-browser-source `Command` handlers. Tiny
//! one-liner wrappers around `crate::chat::*` / helpers in
//! `super::*`; live here so the chat-related arms cluster together
//! instead of getting scattered across the giant dispatch match.

use std::sync::Arc;

use foyer_schema::EntityId;

use super::{broadcast_track_browser_sources, set_track_browser_source, ConnectionAuth};
use crate::AppState;

pub(super) async fn send(state: &Arc<AppState>, peer_id: &str, peer_label: &str, body: String) {
    crate::chat::handle_send(state, peer_id, peer_label, body).await;
}

pub(super) async fn clear(
    state: &Arc<AppState>,
    peer_id: &str,
    peer_label: &str,
    auth: &ConnectionAuth,
) {
    crate::chat::handle_clear(state, peer_id, peer_label, auth).await;
}

pub(super) async fn history_request(state: &Arc<AppState>) {
    crate::chat::handle_history_request(state).await;
}

pub(super) async fn snapshot(
    state: &Arc<AppState>,
    auth: &ConnectionAuth,
    filename: Option<String>,
) {
    crate::chat::handle_snapshot(state, auth, filename).await;
}

pub(super) async fn ptt_start(state: &Arc<AppState>, peer_id: &str, peer_label: &str) {
    crate::chat::handle_ptt_start(state, peer_id, peer_label).await;
}

pub(super) async fn ptt_stop(state: &Arc<AppState>, peer_id: &str) {
    crate::chat::handle_ptt_stop(state, peer_id).await;
}

pub(super) async fn set_track_source(
    state: &Arc<AppState>,
    track_id: EntityId,
    assigned_peer: String,
) {
    set_track_browser_source(state, track_id, assigned_peer).await;
}

pub(super) async fn list_track_sources(state: &Arc<AppState>) {
    broadcast_track_browser_sources(state).await;
}
