// SPDX-License-Identifier: Apache-2.0
//! UI director — server side of the `ui` agent tool.
//!
//! The agent calls `UiTool` (in foyer-agent) which dispatches through
//! this director. We broadcast `Event::UiAction { request_id, action_json }`
//! over the control plane; the first attached browser to handle it
//! replies via `Command::UiActionResult { request_id, ok, state_json, error }`
//! and the awaiting oneshot resolves.
//!
//! Modeled on `FeRendererImpl` (same broadcast-fan-out + correlation
//! pattern). The two could share a generic round-trip helper, but
//! keeping them as siblings means each can evolve its own timeout +
//! payload shape without coupling.

use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use foyer_agent::tools::{UiDirector, UiDirectorError};
use foyer_schema::Event;
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

use crate::AppState;

/// Most UI actions resolve in tens of milliseconds — they're just
/// FE-side method calls. Allow generous headroom for slower paths
/// (e.g. `open` triggers a dynamic-import of the heavy editor module).
const UI_ACTION_TIMEOUT_SECS: u64 = 10;

/// Reply oneshot for a pending `Event::UiAction`. The string payload
/// is the FE's `state_json` (on success — empty when not a query) or
/// the error message (on failure).
type UiReply = oneshot::Sender<Result<String, UiDirectorError>>;

pub struct UiDirectorImpl {
    state: Weak<AppState>,
    pending: Mutex<HashMap<String, UiReply>>,
}

impl UiDirectorImpl {
    pub fn new(state: Weak<AppState>) -> Arc<Self> {
        Arc::new(Self {
            state,
            pending: Mutex::new(HashMap::new()),
        })
    }

    /// Resolve a pending oneshot from a `Command::UiActionResult`
    /// dispatch. Called from `ws::dispatch_command`.
    pub async fn resolve(
        &self,
        request_id: &str,
        ok: bool,
        state_json: String,
        error: Option<String>,
    ) {
        let Some(tx) = self.pending.lock().await.remove(request_id) else {
            tracing::debug!("ui_action: no pending request {request_id}");
            return;
        };
        let result = if ok {
            Ok(state_json)
        } else {
            Err(UiDirectorError::Execution(error.unwrap_or_else(|| {
                "ui action failed without an error message".into()
            })))
        };
        let _ = tx.send(result);
    }
}

#[async_trait]
impl UiDirector for UiDirectorImpl {
    async fn dispatch(&self, action_json: String) -> Result<String, UiDirectorError> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| UiDirectorError::Execution("server shutting down".into()))?;
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(request_id.clone(), tx);
        crate::ws::broadcast_event(
            &state,
            Event::UiAction {
                request_id: request_id.clone(),
                action_json,
            },
        )
        .await;
        let timeout = Duration::from_secs(UI_ACTION_TIMEOUT_SECS);
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(UiDirectorError::Execution(
                "ui director: oneshot cancelled before reply".into(),
            )),
            Err(_) => {
                self.pending.lock().await.remove(&request_id);
                Err(UiDirectorError::Execution(format!(
                    "ui action timed out after {UI_ACTION_TIMEOUT_SECS}s — no Foyer browser tab attached?"
                )))
            }
        }
    }
}
