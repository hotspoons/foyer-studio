// SPDX-License-Identifier: Apache-2.0
//! Agent + UI-director `Command` handlers. Each function is the
//! body of a former `dispatch_command` match arm — the arms in
//! `mod.rs` call into here. Two RBAC-gated arms (`UploadSkill`,
//! `SessionDelete`) thread `auth` through; the rest just need
//! `state` + the variant fields.

use std::sync::Arc;

use foyer_schema::{
    agent::{AgentAttachment, AgentAutonomy},
    EntityId, Event,
};

use super::{broadcast_event, ConnectionAuth};
use crate::AppState;

pub(super) async fn send(state: &Arc<AppState>, body: String, attachments: Vec<AgentAttachment>) {
    crate::agent_ws::handle_agent_send(state, body, attachments).await;
}

pub(super) async fn stop(state: &Arc<AppState>) {
    if let Some(agent) = state.agent.read().await.clone() {
        agent.stop_current_turn().await;
    }
}

pub(super) async fn clear_history(state: &Arc<AppState>) {
    if let Some(agent) = state.agent.read().await.clone() {
        agent.clear_history().await;
    }
}

pub(super) async fn set_autonomy(state: &Arc<AppState>, autonomy: AgentAutonomy) {
    if let Some(agent) = state.agent.read().await.clone() {
        agent.set_autonomy(autonomy).await;
    }
}

pub(super) async fn set_config(
    state: &Arc<AppState>,
    endpoint: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    ui_locale: Option<String>,
) {
    if let Some(agent) = state.agent.read().await.clone() {
        agent.set_config(endpoint, model, api_key).await;
        if let Some(loc) = ui_locale {
            let normalised = loc.trim().to_string();
            // Empty string is the FE's way of clearing the override
            // back to English-default — match that intent rather than
            // treating it as a no-op set.
            agent
                .set_ui_locale(if normalised.is_empty() {
                    None
                } else {
                    Some(normalised)
                })
                .await;
        }
    }
}

pub(super) async fn confirm_tool(state: &Arc<AppState>, call_id: String, approve: bool) {
    if let Some(agent) = state.agent.read().await.clone() {
        agent.confirm_tool(&call_id, approve).await;
    }
}

pub(super) async fn history_request(state: &Arc<AppState>) {
    crate::agent_ws::send_history_to(state).await;
}

pub(super) async fn list_skills(state: &Arc<AppState>) {
    crate::agent_ws::list_skills(state).await;
}

pub(super) async fn upload_skill(
    state: &Arc<AppState>,
    auth: &ConnectionAuth,
    peer_id: &str,
    name: String,
    body: String,
) {
    // Admin-gated on tunneled connections; LAN is trusted per
    // DECISION 38. Reject silently on remote viewers rather than
    // echoing back, since the FE hides the upload UI for them
    // already.
    let allowed = match auth {
        ConnectionAuth::Lan => true,
        ConnectionAuth::Authenticated { role_id, .. } => role_id == "admin",
        ConnectionAuth::Unauthenticated => false,
    };
    if !allowed {
        broadcast_event(
            state,
            Event::Error {
                code: "forbidden_for_role".into(),
                message: "uploading skills requires admin".into(),
                target_peer_id: Some(peer_id.into()),
                localized: None,
            },
        )
        .await;
    } else if let Some(agent) = state.agent.read().await.clone() {
        agent.upload_skill(&name, &body).await;
    }
}

pub(super) async fn set_skill_enabled(state: &Arc<AppState>, name: String, enabled: bool) {
    if let Some(agent) = state.agent.read().await.clone() {
        agent.set_skill_enabled(&name, enabled).await;
    }
}

pub(super) async fn list_memories(state: &Arc<AppState>) {
    crate::agent_ws::list_memories(state).await;
}

pub(super) async fn save_memory(state: &Arc<AppState>, name: String, body: String) {
    if let Some(agent) = state.agent.read().await.clone() {
        agent.save_memory(&name, &body).await;
    }
}

pub(super) async fn forget_memory(state: &Arc<AppState>, name: String) {
    if let Some(agent) = state.agent.read().await.clone() {
        agent.forget_memory(&name).await;
    }
}

pub(super) async fn list_templates(state: &Arc<AppState>) {
    crate::agent_ws::list_templates(state).await;
}

pub(super) async fn render_result(
    state: &Arc<AppState>,
    request_id: String,
    png_b64: Option<String>,
    error: Option<String>,
) {
    if let Some(renderer) = state.fe_renderer.read().await.clone() {
        renderer.resolve(&request_id, png_b64, error).await;
    }
}

pub(super) async fn ui_action_result(
    state: &Arc<AppState>,
    request_id: String,
    ok: bool,
    state_json: String,
    error: Option<String>,
) {
    if let Some(d) = state.ui_director.read().await.clone() {
        d.resolve(&request_id, ok, state_json, error).await;
    }
}

pub(super) async fn session_list(state: &Arc<AppState>) {
    if let Some(agent) = state.agent.read().await.clone() {
        agent.broadcast_sessions().await;
    }
}

pub(super) async fn session_new(state: &Arc<AppState>, title: Option<String>) {
    if let Some(agent) = state.agent.read().await.clone() {
        agent.new_session(title).await;
    }
}

pub(super) async fn session_load(state: &Arc<AppState>, id: String) {
    if let Some(agent) = state.agent.read().await.clone() {
        agent.load_session(id).await;
    }
}

pub(super) async fn session_delete(
    state: &Arc<AppState>,
    auth: &ConnectionAuth,
    peer_id: &str,
    id: String,
) {
    let allowed = match auth {
        ConnectionAuth::Lan => true,
        ConnectionAuth::Authenticated { role_id, .. } => role_id == "admin",
        ConnectionAuth::Unauthenticated => false,
    };
    if !allowed {
        broadcast_event(
            state,
            Event::Error {
                code: "forbidden_for_role".into(),
                message: "deleting sessions requires admin".into(),
                target_peer_id: Some(peer_id.into()),
                localized: None,
            },
        )
        .await;
    } else if let Some(agent) = state.agent.read().await.clone() {
        agent.delete_session(id).await;
    }
}

pub(super) async fn session_rename(state: &Arc<AppState>, id: String, title: String) {
    if let Some(agent) = state.agent.read().await.clone() {
        agent.rename_session(id, title).await;
    }
}

// EntityId import kept available for future agent ops that take ids.
const _PIN: Option<EntityId> = None;
