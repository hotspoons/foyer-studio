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
use foyer_agent::tools::{
    ArmIngressOutcome, BackendsListing, LaunchOutcome, McpProxyEntry, SessionDirector,
    SessionDirectorError,
};
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
        recover_crash: Option<bool>,
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
        // Honor the caller's recovery decision. Discard requires
        // deleting the live `.pending` file BEFORE spawning so
        // Ardour's native dialog never opens (the shim's
        // `FOYER_CRASH_RECOVERY=recover` env still rides along for
        // the recover branch). Mirrors the WS launch_project path —
        // both surfaces use the same profile method so the wire
        // contract stays identical whether a human clicked through
        // the FAB modal or the LLM picked via session(open,
        // recover_crash=false).
        if recover_crash == Some(false) {
            if let (Some(p), Some(state)) = (path, self.state().ok()) {
                let abs = match state.jail.as_ref() {
                    Some(jail) => jail
                        .root()
                        .join(p.to_string_lossy().trim_start_matches('/')),
                    None => p.to_path_buf(),
                };
                let profiles = state.profiles().await;
                // Recovery semantics are filesystem-level (the
                // profile that owns the project file extension knows
                // how to identify and delete `.pending`), not tied
                // to which backend is currently *launched*. The
                // agent path resolves `backend_id="auto"` to "stub"
                // during dev, but the .pending file still belongs
                // to Ardour's recovery model. Try the resolved
                // backend's profile first; if it has no recovery
                // model (returned 0), fall back to the registry's
                // default profile (typically Ardour) — same model
                // the probe step uses on the same path.
                let removed_via_resolved = profiles
                    .get_or_default(&resolved_backend_id)
                    .map(|prof| prof.discard_recovery(&abs))
                    .unwrap_or(0);
                let removed = if removed_via_resolved == 0 {
                    profiles
                        .get_or_default("")
                        .map(|prof| prof.discard_recovery(&abs))
                        .unwrap_or(0)
                } else {
                    removed_via_resolved
                };
                if removed > 0 {
                    tracing::info!(
                        "launch_project(via director): discarded {removed} pending \
                         crash-recovery file(s) at {} ({})",
                        abs.display(),
                        resolved_backend_id,
                    );
                }
            }
        }
        let launched = spawner
            .launch(&resolved_backend_id, path, sample_rate, recover_crash)
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
                launched.mcp_endpoint,
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

    async fn probe_recovery(
        &self,
        backend_id: &str,
        project_path: &str,
    ) -> Result<Vec<foyer_schema::SessionRecoveryArtifact>, SessionDirectorError> {
        // Resolve "auto" / empty to the registry default the same
        // way `launch_project` does — the WS `ProbeSessionRecovery`
        // path goes through `get_or_default("")` because that
        // command fires before any backend is attached. The agent
        // tool's probe runs in the same pre-launch window, so we
        // also lean on the default profile when the caller hasn't
        // explicitly named one.
        let state = self.state()?;
        let abs = match state.jail.as_ref() {
            Some(jail) => jail.root().join(project_path.trim_start_matches('/')),
            None => std::path::PathBuf::from(project_path),
        };
        let profile_key = if backend_id.is_empty() || backend_id == "auto" {
            ""
        } else {
            backend_id
        };
        let profiles = state.profiles().await;
        let artifacts = profiles
            .get_or_default(profile_key)
            .map(|prof| prof.probe_recovery(&abs))
            .unwrap_or_default();
        Ok(artifacts)
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

    async fn arm_track_for_browser_audio(
        &self,
        track_id: &str,
        peer_id: Option<&str>,
    ) -> Result<ArmIngressOutcome, SessionDirectorError> {
        let state = self.state()?;
        let tid = foyer_schema::EntityId::new(track_id);
        // Verify the track exists on the active backend before
        // committing the claim. Without this the map fills up with
        // dead ids and the broadcast bewilders connected clients.
        let snap = state
            .backend()
            .await
            .snapshot()
            .await
            .map_err(|e| SessionDirectorError::Execution(e.to_string()))?;
        let track = snap.tracks.iter().find(|t| t.id == tid).ok_or_else(|| {
            SessionDirectorError::Execution(format!(
                "unknown track_id `{track_id}` — call tracks.list to see live ids"
            ))
        })?;
        // Buses + master have no audio input — refuse the claim with a
        // clear message so the agent can pick a real track.
        if matches!(
            track.kind,
            foyer_schema::TrackKind::Bus
                | foyer_schema::TrackKind::Master
                | foyer_schema::TrackKind::Monitor
        ) {
            return Err(SessionDirectorError::Execution(format!(
                "track `{track_id}` is a {:?} — only audio/midi tracks can host browser ingress",
                track.kind
            )));
        }

        // Resolve the peer assignee. Empty string = "claimable by any
        // peer that opens an ingress next" (matches what the WS
        // SetTrackBrowserSource handler treats as "clear").
        let assigned = peer_id.unwrap_or("").to_string();
        {
            let mut map = state.track_browser_sources.write().await;
            if assigned.is_empty() {
                // Wipe any prior claim so a new browser tab can pick
                // this up. The agent is saying "any browser can fill
                // this track" — leave the slot open.
                map.remove(&tid);
            } else {
                map.insert(tid.clone(), assigned.clone());
            }
        }
        crate::ws::broadcast_event(
            &state,
            Event::TrackBrowserSourceChanged {
                track_id: tid.clone(),
                peer_id: if assigned.is_empty() {
                    None
                } else {
                    Some(assigned.clone())
                },
            },
        )
        .await;

        // Force monitoring=off — the browser round-trip (100–300 ms
        // typical, more on a tunnelled link) is audible as slap-back
        // if the user hears live input. Same policy the WS handler
        // applies on the manual Take chip path.
        let monitor_patch = foyer_schema::session::TrackPatch {
            monitoring: Some("off".to_string()),
            ..Default::default()
        };
        if let Err(e) = state.backend().await.update_track(tid, monitor_patch).await {
            tracing::debug!("arm_track_for_browser_audio: best-effort monitoring=off failed: {e}");
        }

        // Snapshot the live peer count so the agent can phrase its
        // reply usefully ("no browsers connected — open Foyer in a
        // tab" vs. "2 browsers connected — click Take on one of them").
        let connected_peer_count = state.peers.read().await.len();

        Ok(ArmIngressOutcome {
            track_id: track_id.to_string(),
            peer_id: assigned,
            connected_peer_count,
        })
    }

    async fn list_mcp_proxies(&self) -> Result<Vec<McpProxyEntry>, SessionDirectorError> {
        let state = self.state()?;
        let mut out: Vec<McpProxyEntry> = Vec::new();
        // Live sessions first — these are the per-session Ardour MCP
        // ports we pinned at spawn time. Their ids include the session
        // id so the agent can target a specific Ardour instance when
        // multiple are open.
        for entry in state.sessions.list().await {
            if let Some(endpoint) = entry.mcp_endpoint.as_deref() {
                let short = entry
                    .id
                    .as_str()
                    .rsplit_once('.')
                    .map(|(_, s)| s.chars().take(8).collect::<String>())
                    .unwrap_or_else(|| entry.id.to_string());
                let label = if entry.name.is_empty() {
                    format!("{} ({})", entry.backend_id, short)
                } else {
                    format!("{} ({})", entry.name, short)
                };
                out.push(McpProxyEntry {
                    id: format!("session.{short}"),
                    label,
                    endpoint: endpoint.to_string(),
                    enabled: true,
                    source: "session",
                    api_key: None,
                });
            }
        }
        // Static config entries — for upstream MCP servers Foyer
        // didn't spawn (a separate Reaper, an external Ardour, etc.).
        // De-duplicate against the live set by endpoint URL so we
        // don't list the same Ardour both as "session.xxx" and as
        // the user's hand-configured `ardour` entry.
        for cfg in state.mcp_proxies.read().await.iter() {
            if out.iter().any(|e| e.endpoint == cfg.endpoint) {
                continue;
            }
            let api_key =
                std::env::var(format!("FOYER_MCP_PROXY_{}_API_KEY", cfg.id.to_uppercase()))
                    .ok()
                    .or_else(|| cfg.api_key.clone());
            out.push(McpProxyEntry {
                id: cfg.id.clone(),
                label: cfg.label.clone().unwrap_or_else(|| cfg.id.clone()),
                endpoint: cfg.endpoint.clone(),
                enabled: cfg.enabled,
                source: "config",
                api_key,
            });
        }
        Ok(out)
    }

    async fn release_track_browser_audio(
        &self,
        track_id: &str,
    ) -> Result<(), SessionDirectorError> {
        let state = self.state()?;
        let tid = foyer_schema::EntityId::new(track_id);
        {
            let mut map = state.track_browser_sources.write().await;
            map.remove(&tid);
        }
        // Also strip any track→stream binding so a subsequent region
        // doesn't get auto-stamped with a stale latency report. The
        // browser side handles port_name cleanup on its own.
        {
            let mut tmap = state.track_ingress.lock().await;
            tmap.remove(&tid);
        }
        crate::ws::broadcast_event(
            &state,
            Event::TrackBrowserSourceChanged {
                track_id: tid,
                peer_id: None,
            },
        )
        .await;
        Ok(())
    }
}
