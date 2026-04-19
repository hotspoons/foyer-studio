//! WebSocket handler: one task per connection.
//!
//! Protocol (JSON, UTF-8 text frames):
//!
//! ```text
//!  Server → Client:   Envelope<Event>
//!  Client → Server:   Envelope<Command>
//! ```
//!
//! Query params on `/ws`:
//! - `since=<seq>` — replay ring entries newer than `seq` before live stream. If the
//!   requested seq is older than anything we still have, the server sends a fresh
//!   snapshot instead.
//! - `origin=<string>` — free-form identifier attached to messages originated by this
//!   client; shows up in `control.update` echoes so clients can detect self-echoes.

use std::collections::HashMap;
use std::sync::atomic::Ordering;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use foyer_schema::{Command, ControlUpdate, Envelope, Event, SCHEMA_VERSION};
use futures::{SinkExt, StreamExt};
use tokio::sync::broadcast::error::RecvError;

use crate::{AppState, SharedState};

pub(crate) async fn upgrade(
    ws: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
    State(state): SharedState,
) -> impl IntoResponse {
    let since: Option<u64> = params.get("since").and_then(|s| s.parse().ok());
    let origin = params.get("origin").cloned();
    ws.on_upgrade(move |sock| handle(sock, state, since, origin))
}

async fn handle(
    sock: WebSocket,
    state: std::sync::Arc<AppState>,
    since: Option<u64>,
    origin: Option<String>,
) {
    let (mut tx_ws, mut rx_ws) = sock.split();
    let mut rx_broadcast = state.tx.subscribe();

    // Initial catch-up: either replay from ring or send snapshot.
    if let Some(since_seq) = since {
        let replay = state.ring.read().await.since(since_seq);
        match replay {
            Some(items) => {
                for env in items {
                    if send_env(&mut tx_ws, &env).await.is_err() {
                        return;
                    }
                }
            }
            None => {
                if let Some(snap) = state.current_snapshot().await {
                    if send_env(&mut tx_ws, &snap).await.is_err() {
                        return;
                    }
                }
            }
        }
    } else if let Some(snap) = state.current_snapshot().await {
        if send_env(&mut tx_ws, &snap).await.is_err() {
            return;
        }
    }

    let origin_tag = origin.clone();

    // Split pump: incoming commands (reader) vs outgoing events (writer).
    let reader_state = state.clone();
    let reader_origin = origin_tag.clone();
    let reader = tokio::spawn(async move {
        while let Some(frame) = rx_ws.next().await {
            let Ok(msg) = frame else { break };
            match msg {
                Message::Text(t) => {
                    if let Err(e) =
                        dispatch_command(&reader_state, reader_origin.as_deref(), &t).await
                    {
                        tracing::warn!("client command rejected: {e}");
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // Writer loop.
    loop {
        match rx_broadcast.recv().await {
            Ok(env) => {
                if send_env(&mut tx_ws, &env).await.is_err() {
                    break;
                }
            }
            Err(RecvError::Lagged(n)) => {
                tracing::warn!("client lagged {n} messages; sending snapshot");
                if let Some(snap) = state.current_snapshot().await {
                    if send_env(&mut tx_ws, &snap).await.is_err() {
                        break;
                    }
                }
            }
            Err(RecvError::Closed) => break,
        }
    }

    reader.abort();
}

async fn send_env<S>(sink: &mut S, env: &Envelope<Event>) -> Result<(), axum::Error>
where
    S: futures::Sink<Message, Error = axum::Error> + Unpin,
{
    let text = serde_json::to_string(env).map_err(axum::Error::new)?;
    sink.send(Message::Text(text)).await
}

async fn dispatch_command(
    state: &AppState,
    origin: Option<&str>,
    text: &str,
) -> Result<(), DispatchError> {
    let env: Envelope<Command> = serde_json::from_str(text).map_err(DispatchError::Parse)?;

    match env.body {
        Command::Subscribe | Command::RequestSnapshot => {
            // Easy case: produce a fresh snapshot synchronously and push into the
            // broadcast stream. All connected clients will see it — not just the asker
            // — which is the correct fan-out behavior.
            let snapshot = state.backend.snapshot().await?;
            let seq = state.next_seq.fetch_add(1, Ordering::Relaxed);
            let out = Envelope {
                schema: SCHEMA_VERSION,
                seq,
                origin: Some("backend".to_string()),
                body: Event::SessionSnapshot {
                    session: Box::new(snapshot),
                },
            };
            *state.cached_snapshot.write().await = Some(out.clone());
            state.ring.write().await.push(out.clone());
            let _ = state.tx.send(out);
        }
        Command::ControlSet { id, value } => {
            state.backend.set_control(id.clone(), value.clone()).await?;
            // The backend's event stream will reflect the change; we also emit a
            // synthetic ControlUpdate tagged with the caller's origin so the UI
            // knows who moved the fader.
            let seq = state.next_seq.fetch_add(1, Ordering::Relaxed);
            let out = Envelope {
                schema: SCHEMA_VERSION,
                seq,
                origin: origin.map(str::to_string),
                body: Event::ControlUpdate {
                    update: ControlUpdate { id, value },
                },
            };
            state.ring.write().await.push(out.clone());
            let _ = state.tx.send(out);
        }
        Command::ListActions => {
            let actions = state.backend.list_actions().await?;
            broadcast_event(state, Event::ActionsList { actions }).await;
        }
        Command::InvokeAction { id } => {
            state.backend.invoke_action(id).await?;
        }
        Command::ListRegions { track_id } => {
            let (timeline, regions) = state.backend.list_regions(track_id.clone()).await?;
            broadcast_event(
                state,
                Event::RegionsList {
                    track_id,
                    timeline,
                    regions,
                },
            )
            .await;
        }
        Command::ListPlugins => {
            let entries = state.backend.list_plugins().await?;
            broadcast_event(state, Event::PluginsList { entries }).await;
        }
        Command::BrowsePath { path } => match &state.jail {
            Some(jail) => match jail.browse(&path) {
                Ok(listing) => broadcast_event(state, Event::PathListed { listing }).await,
                Err(e) => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "browse_failed".into(),
                            message: e.to_string(),
                        },
                    )
                    .await;
                }
            },
            None => {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "no_jail".into(),
                        message: "filesystem browsing is disabled (no --jail configured)".into(),
                    },
                )
                .await;
            }
        },
        Command::OpenSession { path } => match state.backend.open_session(&path).await {
            Ok(()) => {
                broadcast_event(
                    state,
                    Event::SessionChanged {
                        path: Some(path.clone()),
                    },
                )
                .await;
                // Follow up with a fresh snapshot so the UI repopulates.
                let snapshot = state.backend.snapshot().await?;
                broadcast_event(
                    state,
                    Event::SessionSnapshot {
                        session: Box::new(snapshot),
                    },
                )
                .await;
            }
            Err(e) => {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "open_session_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        },
        Command::SaveSession { as_path } => {
            if let Err(e) = state.backend.save_session(as_path.as_deref()).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "save_session_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::UpdateRegion { id, patch } => match state.backend.update_region(id, patch).await {
            Ok(region) => broadcast_event(state, Event::RegionUpdated { region }).await,
            Err(e) => {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "update_region_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        },
        Command::DeleteRegion { id } => {
            let region_id = id.clone();
            match state.backend.delete_region(id).await {
                Ok(track_id) => {
                    broadcast_event(
                        state,
                        Event::RegionRemoved { track_id, region_id },
                    )
                    .await;
                }
                Err(e) => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "delete_region_failed".into(),
                            message: e.to_string(),
                        },
                    )
                    .await;
                }
            }
        }
        Command::ListWaveform { region_id, samples_per_peak } => {
            match state.backend.load_waveform(region_id, samples_per_peak).await {
                Ok(peaks) => broadcast_event(state, Event::WaveformData { peaks }).await,
                Err(e) => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "waveform_failed".into(),
                            message: e.to_string(),
                        },
                    )
                    .await;
                }
            }
        }
        Command::ClearWaveformCache { region_id } => {
            match state.backend.clear_waveform_cache(region_id).await {
                Ok(dropped) => broadcast_event(state, Event::WaveformCacheCleared { dropped }).await,
                Err(e) => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "clear_cache_failed".into(),
                            message: e.to_string(),
                        },
                    )
                    .await;
                }
            }
        }
        Command::AudioEgressStart { .. }
        | Command::AudioEgressStop { .. }
        | Command::AudioIngressOpen { .. }
        | Command::AudioIngressClose { .. }
        | Command::LatencyProbe { .. } => {
            // M6 territory — acknowledge with an error so the tester UI sees it.
            broadcast_event(
                state,
                Event::Error {
                    code: "not_implemented".into(),
                    message: "audio commands land in M6".into(),
                },
            )
            .await;
        }
    }
    Ok(())
}

/// Wrap an event in an envelope (with fresh seq), cache to the ring, and
/// broadcast to all subscribers.
async fn broadcast_event(state: &AppState, event: Event) {
    let seq = state.next_seq.fetch_add(1, Ordering::Relaxed);
    let is_snapshot = matches!(event, Event::SessionSnapshot { .. });
    let env = Envelope {
        schema: SCHEMA_VERSION,
        seq,
        origin: Some("backend".to_string()),
        body: event,
    };
    if is_snapshot {
        *state.cached_snapshot.write().await = Some(env.clone());
    }
    state.ring.write().await.push(env.clone());
    let _ = state.tx.send(env);
}

#[derive(thiserror::Error, Debug)]
enum DispatchError {
    #[error("parse: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("backend: {0}")]
    Backend(#[from] foyer_backend::BackendError),
}
