// SPDX-License-Identifier: Apache-2.0
//! Session director — server side of the `session` agent tool's
//! sidecar-state subcommands.
//!
//! The agent's `session` tool calls into [`SessionDirector`] (defined
//! in `foyer-agent::tools`) for any subcommand that's not a pure
//! action on the currently-loaded `Backend`: `open`, `new`, `close`,
//! `list_open`, `recents`, `forget_recent`, `browse`, `backends`.
//!
//! This impl reaches back into `AppState` and calls the same helpers
//! the WS dispatcher uses (`state.sessions.*`, `state.spawner.launch`,
//! `state.swap_backend`, `recents::*`). That keeps the agent's
//! "open this project" path indistinguishable from a click on the
//! project picker — same recents entry, same `BackendSwapped`
//! broadcast, same `RecentsList` event for the FE to mirror.

use std::path::Path;
use std::sync::{Arc, Weak};

use async_trait::async_trait;
use foyer_agent::tools::{BackendsListing, LaunchOutcome, SessionDirector, SessionDirectorError};
use foyer_schema::{Event, PathListing, RecentEntry, SessionInfo};

use crate::recents;
use crate::AppState;

pub struct SessionDirectorImpl {
    state: Weak<AppState>,
}

impl SessionDirectorImpl {
    pub fn new(state: Weak<AppState>) -> Arc<Self> {
        Arc::new(Self { state })
    }

    fn state(&self) -> Result<Arc<AppState>, SessionDirectorError> {
        self.state
            .upgrade()
            .ok_or_else(|| SessionDirectorError::Execution("server shutting down".into()))
    }
}

#[async_trait]
impl SessionDirector for SessionDirectorImpl {
    async fn list_open(&self) -> Result<Vec<SessionInfo>, SessionDirectorError> {
        Ok(self.state()?.sessions.list().await)
    }

    async fn close(&self, session_id: &str) -> Result<(), SessionDirectorError> {
        let state = self.state()?;
        let id = foyer_schema::EntityId::new(session_id);
        // Same teardown the WS Close handler runs, minus the WS-only
        // broadcast (we still publish the registry-level events
        // through `state.tx` for the FE).
        let Some(_info) = state.sessions.close(&id).await else {
            return Err(SessionDirectorError::Execution(format!(
                "no session with id `{session_id}`"
            )));
        };
        let was_focused = {
            let mut focus = state.focus_session_id.write().await;
            if focus.as_ref() == Some(&id) {
                *focus = None;
                true
            } else {
                false
            }
        };
        // Fall back focus to whatever's still open so plain commands
        // don't dead-end.
        if was_focused {
            if let Some(fallback_id) = state.sessions.most_recent_id().await {
                if let Some(be) = state.sessions.backend(&fallback_id).await {
                    state.install_active_backend(be).await;
                    *state.focus_session_id.write().await = Some(fallback_id);
                }
            }
        }
        // Tell connected clients. We don't have a borrow of `state` as
        // a fn(&state) so just publish the event via the broadcast tx.
        let sessions = state.sessions.list().await;
        crate::ws::broadcast_event(&state, Event::SessionClosed { session_id: id }).await;
        crate::ws::broadcast_event(&state, Event::SessionList { sessions }).await;
        Ok(())
    }

    async fn launch_project(
        &self,
        backend_id: &str,
        project_path: Option<&str>,
        sample_rate: Option<u32>,
    ) -> Result<LaunchOutcome, SessionDirectorError> {
        let state = self.state()?;
        let Some(spawner) = state.spawner.clone() else {
            return Err(SessionDirectorError::Unsupported(
                "no backend spawner configured in this sidecar".into(),
            ));
        };
        // Resolve "auto" / "" to the currently-active backend, or the
        // first spawner-listed backend if nothing's up yet.
        let resolved_backend_id = if backend_id.is_empty() || backend_id == "auto" {
            state
                .active_backend_id
                .read()
                .await
                .clone()
                .or_else(|| spawner.list().into_iter().next().map(|b| b.id))
                .ok_or_else(|| {
                    SessionDirectorError::Execution(
                        "no backend currently active and spawner has no entries".into(),
                    )
                })?
        } else {
            backend_id.to_string()
        };
        let path = project_path.map(Path::new);
        let launched = spawner
            .launch(&resolved_backend_id, path, sample_rate, None)
            .await
            .map_err(|e| SessionDirectorError::Execution(e.to_string()))?;
        // Synthesize a session uuid here so we can return it to the
        // caller before `swap_backend` runs.
        let session_id =
            foyer_schema::EntityId::new(format!("session.{}", uuid::Uuid::new_v4().simple()));
        state
            .swap_backend(
                resolved_backend_id.clone(),
                project_path.map(str::to_string),
                launched.backend,
                Some(session_id.clone()),
                None,
                launched.process,
            )
            .await;
        // Push the project onto recents so the picker's most-recent
        // entry agrees with what the agent just opened. Mirrors the
        // WS handler's recents touch.
        if let Some(p) = project_path {
            let jail_root = state.sessions.jail_root.read().await.clone();
            let profiles = state.profiles().await;
            let recents = recents::touch(
                RecentEntry {
                    path: recents::normalize_path(p, jail_root.as_deref()),
                    name: String::new(),
                    backend_id: resolved_backend_id.clone(),
                    opened_at: 0,
                },
                profiles.default_id(),
            )
            .await;
            crate::ws::broadcast_event(&state, Event::RecentsList { recents }).await;
        }
        Ok(LaunchOutcome {
            session_id: session_id.as_str().to_string(),
            backend_id: resolved_backend_id,
            project_path: project_path.map(str::to_string),
        })
    }

    async fn list_recents(&self) -> Result<Vec<RecentEntry>, SessionDirectorError> {
        Ok(recents::load().await)
    }

    async fn forget_recent(&self, path: &str) -> Result<(), SessionDirectorError> {
        let state = self.state()?;
        let recents = recents::forget(path).await;
        crate::ws::broadcast_event(&state, Event::RecentsList { recents }).await;
        Ok(())
    }

    async fn browse_path(
        &self,
        path: &str,
        show_hidden: bool,
    ) -> Result<PathListing, SessionDirectorError> {
        let state = self.state()?;
        let Some(jail) = state.jail.as_ref() else {
            return Err(SessionDirectorError::Unsupported(
                "filesystem browsing is disabled (no --jail configured)".into(),
            ));
        };
        jail.browse(path, show_hidden)
            .map_err(|e| SessionDirectorError::Execution(e.to_string()))
    }

    async fn list_backends(&self) -> Result<BackendsListing, SessionDirectorError> {
        let state = self.state()?;
        let backends = state.spawner.as_ref().map(|s| s.list()).unwrap_or_default();
        let active = state.active_backend_id.read().await.clone();
        Ok(BackendsListing { backends, active })
    }
}
