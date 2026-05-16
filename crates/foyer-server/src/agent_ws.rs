// SPDX-License-Identifier: Apache-2.0
//! Glue between the `foyer-agent` runtime and the WS control plane.
//!
//! Two responsibilities:
//!
//!   1. **Forward**: subscribe to `AgentRuntime`'s broadcast feed and
//!      translate each `AgentEvent` into a `foyer_schema::Event` that
//!      the existing WS broadcast fans out to every connected client.
//!
//!   2. **Dispatch**: command handlers invoked from
//!      `ws::dispatch_command` translate `Command::Agent*` into
//!      method calls on the runtime.

use std::sync::{Arc, Weak};

use foyer_agent::AgentEvent;
use foyer_schema::Event;
use tokio::sync::broadcast::error::RecvError;

use crate::AppState;

/// Spawn the forwarder task — one per server boot. Holds a `Weak`
/// to AppState so it doesn't pin the strong refcount; `start()`
/// later swaps in the jail via `Arc::get_mut` and would panic if any
/// other strong reference were live. The forwarder upgrades the
/// Weak per iteration; if `start()` has dropped the server (or the
/// process is shutting down) the upgrade fails and the task exits.
pub fn spawn_forwarder(state: Weak<AppState>) {
    tokio::spawn(async move {
        // Wait briefly for the agent slot to populate — `attach_agent`
        // inserts the runtime BEFORE spawning the forwarder, so the
        // first upgrade should already see it.
        let agent = {
            let s = match state.upgrade() {
                Some(s) => s,
                None => return,
            };
            let g = s.agent.read().await;
            match g.clone() {
                Some(a) => a,
                None => {
                    tracing::debug!("agent_ws::forwarder: no agent attached, exiting");
                    return;
                }
            }
        };
        let mut rx = agent.subscribe();
        loop {
            match rx.recv().await {
                Ok(evt) => {
                    let Some(s) = state.upgrade() else {
                        return;
                    };
                    if let Some(out) = translate(evt) {
                        crate::ws::broadcast_event(&s, out).await;
                    }
                }
                Err(RecvError::Lagged(n)) => {
                    tracing::warn!("agent_ws: forwarder lagged by {n} events");
                }
                Err(RecvError::Closed) => break,
            }
        }
    });
}

fn translate(evt: AgentEvent) -> Option<Event> {
    Some(match evt {
        AgentEvent::Message(record) => Event::AgentMessage { record },
        AgentEvent::Token { message_id, delta } => Event::AgentToken { message_id, delta },
        AgentEvent::ToolUpdate {
            message_id,
            call_id,
            status,
            preview,
            result_json,
        } => Event::AgentToolUpdate {
            message_id,
            call_id,
            status,
            preview,
            result_json,
        },
        AgentEvent::State {
            config,
            busy,
            transcript_len,
        } => Event::AgentState {
            config,
            busy,
            transcript_len,
        },
        AgentEvent::Skills(skills) => Event::AgentSkillsListed { skills },
        AgentEvent::Memories(memories) => Event::AgentMemoriesListed { memories },
        AgentEvent::Templates(templates) => Event::AgentTemplatesListed { templates },
        AgentEvent::SessionsListed {
            sessions,
            active_id,
        } => Event::AgentSessionsListed {
            sessions,
            active_id,
        },
        AgentEvent::SessionActivated { id, title } => Event::AgentSessionActivated { id, title },
    })
}

pub async fn handle_agent_send(
    state: &Arc<AppState>,
    body: String,
    attachments: Vec<foyer_schema::agent::AgentAttachment>,
) {
    let agent = match state.agent.read().await.clone() {
        Some(a) => a,
        None => {
            crate::ws::broadcast_event(
                state,
                Event::Error {
                    code: "agent_unavailable".into(),
                    message: "agent runtime not attached".into(),
                    target_peer_id: None,
                },
            )
            .await;
            return;
        }
    };
    // Detach the engine turn so the WS dispatch can return promptly.
    // Streaming events arrive via the forwarder.
    let state_clone = state.clone();
    tokio::spawn(async move {
        if let Err(e) = agent.send_user_message(body, attachments).await {
            crate::ws::broadcast_event(
                &state_clone,
                Event::Error {
                    code: "agent_turn_failed".into(),
                    message: e.to_string(),
                    target_peer_id: None,
                },
            )
            .await;
        }
    });
}

pub async fn send_history_to(state: &Arc<AppState>) {
    let agent = match state.agent.read().await.clone() {
        Some(a) => a,
        None => return,
    };
    let records = agent.history().await;
    crate::ws::broadcast_event(state, Event::AgentHistory { records }).await;
    // Also push the live config snapshot. Without this, a client
    // that reconnects after a server restart only learns about its
    // (possibly different) persisted endpoint on the next state
    // mutation — which is why the settings modal "didn't auto-apply"
    // between refreshes.
    if let Some(evt) = translate(agent.snapshot_state().await) {
        crate::ws::broadcast_event(state, evt).await;
    }
    // Sessions list, too — FE picker repaints on reconnect.
    if let Some(evt) = translate(agent.list_sessions_event().await) {
        crate::ws::broadcast_event(state, evt).await;
    }
}

pub async fn list_skills(state: &Arc<AppState>) {
    if let Some(agent) = state.agent.read().await.clone() {
        let _ = agent.list_skills().await;
    }
}

pub async fn list_memories(state: &Arc<AppState>) {
    if let Some(agent) = state.agent.read().await.clone() {
        let _ = agent.list_memories().await;
    }
}

pub async fn list_templates(state: &Arc<AppState>) {
    if let Some(agent) = state.agent.read().await.clone() {
        let _ = agent.list_templates().await;
    }
}
