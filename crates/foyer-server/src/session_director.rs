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

        // Already-open match: if the requested project_path already has
        // a LIVE session on this backend, just refocus and return —
        // don't spawn a second copy. Matches existing reuse logic at
        // the shim-spawner level (`launch_and_wait_for_shim` →
        // `discovery::find_for_project`) and lifts it up so the agent
        // and WS dispatcher both benefit.
        //
        // We probe `Backend::is_alive` on the candidate before reusing:
        // a session entry can outlive its shim (Ardour crashed, JACK
        // hung, network blip) and reusing the dead entry would dead-
        // end the caller on the next tool call. Closing the stale
        // entry first lets the spawn path below build a fresh shim.
        let normalized_new_path = project_path.map(|p| {
            Path::new(p)
                .canonicalize()
                .ok()
                .and_then(|c| c.to_str().map(String::from))
                .unwrap_or_else(|| p.to_string())
        });
        if let Some(ref np) = normalized_new_path {
            for s in state.sessions.list().await {
                if s.backend_id == resolved_backend_id && &s.path == np {
                    let alive = matches!(
                        state.sessions.backend(&s.id).await,
                        Some(b) if b.is_alive()
                    );
                    if alive {
                        self.focus(s.id.as_str()).await?;
                        return Ok(LaunchOutcome {
                            session_id: s.id.as_str().to_string(),
                            backend_id: resolved_backend_id,
                            project_path: Some(s.path),
                        });
                    }
                    tracing::warn!(
                        "launch_project: session {} for {} is dead (shim gone) — \
                         closing stale entry before respawn",
                        s.id,
                        s.path,
                    );
                    if let Err(e) = self.close(s.id.as_str()).await {
                        tracing::warn!(
                            "launch_project: close of dead session {} failed (continuing): {e}",
                            s.id,
                        );
                    }
                    // Don't break — there could be multiple dead entries
                    // for the same path. Keep sweeping then fall through
                    // to spawn.
                }
            }
        }

        // Heavyweight-backend swap: when the requested launch is on a
        // non-stub backend (Ardour today) and there's already a session
        // alive on that same backend kind with a different project,
        // close the old one first. Spawning a second Ardour while the
        // first is alive doubles plugin-scan + JACK-init work and an
        // agent tool round can expire mid-spawn (observed: 10-minute
        // session.new call during the Kimi e2e drive). Closing first
        // sequentializes the OS work and frees the new spawn to take
        // the normal ~10–30 s. Stub backends are cheap to multiply so
        // we leave their sessions intact.
        let backend_kind = spawner
            .list()
            .into_iter()
            .find(|b| b.id == resolved_backend_id)
            .map(|b| b.kind);
        let heavyweight = matches!(backend_kind.as_deref(), Some(k) if k != "stub");
        if heavyweight {
            let stale: Vec<_> = state
                .sessions
                .list()
                .await
                .into_iter()
                .filter(|s| s.backend_id == resolved_backend_id)
                .map(|s| s.id.clone())
                .collect();
            for sid in stale {
                if let Err(e) = self.close(sid.as_str()).await {
                    tracing::warn!(
                        "launch_project: pre-spawn close of {sid} failed (continuing): {e}"
                    );
                }
            }
        }

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

    async fn focus(&self, session_id: &str) -> Result<(), SessionDirectorError> {
        let state = self.state()?;
        let id = foyer_schema::EntityId::new(session_id);
        let Some(backend) = state.sessions.backend(&id).await else {
            return Err(SessionDirectorError::Execution(format!(
                "no session with id `{session_id}` (open it first via session.open / session.new)"
            )));
        };
        // Mirror the WS-level `Command::SelectSession` path: stash the
        // focus pointer, mirror `state.backend()` to match, and broadcast
        // the change so other connected clients see the focus flip too.
        let prev = state.focus_session_id.write().await.replace(id.clone());
        state.install_active_backend(backend).await;
        if prev.as_ref() != Some(&id) {
            crate::ws::broadcast_event(
                &state,
                foyer_schema::Event::SessionFocusChanged {
                    session_id: Some(id.clone()),
                },
            )
            .await;
        }
        Ok(())
    }
}
