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
use axum::extract::{ConnectInfo, Query, State};
use axum::response::IntoResponse;
use std::net::{IpAddr, SocketAddr};
use foyer_schema::{Command, ControlUpdate, Envelope, Event, SCHEMA_VERSION};
use futures::{SinkExt, StreamExt};
use tokio::sync::broadcast::error::RecvError;

use crate::{AppState, SharedState};

pub(crate) async fn upgrade(
    ws: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): SharedState,
) -> impl IntoResponse {
    let since: Option<u64> = params.get("since").and_then(|s| s.parse().ok());
    let origin = params.get("origin").cloned();
    ws.on_upgrade(move |sock| handle(sock, state, since, origin, peer))
}

/// Enumerate URLs the sidecar is likely reachable at from other machines
/// on the same LAN. Used for "share session" QR generation — the first
/// entry is the one we expect to Just Work; the rest are alternates
/// (IPv6, additional NICs). We skip loopback so the list is empty when
/// nothing outside the current host could connect — the client uses that
/// emptiness as a signal that share-session won't work here.
fn reachable_urls(hostname: &str, port: u16) -> Vec<String> {
    use local_ip_address::list_afinet_netifas;
    let mut urls = Vec::new();
    if port == 0 {
        return urls;
    }
    if let Ok(ifaces) = list_afinet_netifas() {
        for (_name, ip) in ifaces {
            if ip.is_loopback() {
                continue;
            }
            // Skip IPv6 link-local — user-hostile addresses with zone ids.
            if let IpAddr::V6(v6) = ip {
                if (v6.segments()[0] & 0xffc0) == 0xfe80 {
                    continue;
                }
            }
            let host = match ip {
                IpAddr::V4(v4) => v4.to_string(),
                IpAddr::V6(v6) => format!("[{v6}]"),
            };
            urls.push(format!("http://{host}:{port}/"));
        }
    }
    // Hostname URL last — most portable but depends on the other machine's
    // mDNS / DNS resolving it. Real IPs first so QR scans "just work."
    if !hostname.is_empty() {
        urls.push(format!("http://{hostname}:{port}/"));
    }
    urls
}

/// True for loopback / link-local IPs — i.e. "same machine" or "same LAN
/// segment where no DNS / routing happened." Drives the client-side
/// `is_local` flag: remote clients see a "share session" prompt instead
/// of the local-only controls, and a future gateway mode can enforce
/// stricter auth when `is_local` is false.
fn is_local_addr(addr: &SocketAddr) -> bool {
    match addr.ip() {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_link_local() || v4.is_private(),
        IpAddr::V6(v6) => {
            v6.is_loopback()
                // fe80::/10 — IPv6 link-local. No stdlib helper, hand-check.
                || (v6.segments()[0] & 0xffc0 == 0xfe80)
                // Unique-local fc00::/7 (approx private).
                || (v6.segments()[0] & 0xfe00 == 0xfc00)
        }
    }
}

async fn handle(
    sock: WebSocket,
    state: std::sync::Arc<AppState>,
    since: Option<u64>,
    origin: Option<String>,
    peer: SocketAddr,
) {
    let (mut tx_ws, mut rx_ws) = sock.split();
    let mut rx_broadcast = state.tx.subscribe();

    // Unicast greeting: tells this specific client whether it's local or
    // remote. Sent before any catch-up / snapshot so the UI can paint
    // with the right context from frame one. Also includes the server's
    // reachable URLs so a local client can build a QR to share with a
    // phone or another machine on the LAN.
    {
        let is_local = is_local_addr(&peer);
        let server_host = std::env::var("FOYER_SERVER_HOSTNAME")
            .or_else(|_| hostname::get().map(|h| h.to_string_lossy().into_owned()))
            .unwrap_or_default();
        let port = state.listen_port.load(Ordering::Relaxed);
        let server_urls = reachable_urls(&server_host, port);
        let greeting = Envelope {
            schema: SCHEMA_VERSION,
            seq: state.next_seq.fetch_add(1, Ordering::Relaxed),
            origin: Some("server".into()),
            body: Event::ClientGreeting {
                remote_addr: peer.to_string(),
                is_local,
                server_host,
                server_port: port,
                server_urls,
            },
        };
        let _ = send_env(&mut tx_ws, &greeting).await;
    }

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
                    // reader_state is Arc<AppState>, takes &Arc by ref
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
    state: &std::sync::Arc<AppState>,
    origin: Option<&str>,
    text: &str,
) -> Result<(), DispatchError> {
    let env: Envelope<Command> = serde_json::from_str(text).map_err(DispatchError::Parse)?;

    match env.body {
        Command::Subscribe | Command::RequestSnapshot => {
            // Easy case: produce a fresh snapshot synchronously and push into the
            // broadcast stream. All connected clients will see it — not just the asker
            // — which is the correct fan-out behavior.
            let snapshot = state.backend().await.snapshot().await?;
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
            state.backend().await.set_control(id.clone(), value.clone()).await?;
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
            let actions = state.backend().await.list_actions().await?;
            broadcast_event(state, Event::ActionsList { actions }).await;
        }
        Command::InvokeAction { id } => {
            // Route to the backend. If the action is unknown (shim hasn't
            // wired it up yet) we translate the error into a user-visible
            // `Event::Error` so the startup-errors modal / console view
            // pick it up — silently WARN-logging meant the UI had no idea
            // the click did nothing. Transport actions land via the
            // trait-default translation to set_control so they keep
            // working even against a shim that doesn't know about them.
            let id_str = id.as_str().to_string();
            match state.backend().await.invoke_action(id).await {
                Ok(()) => {}
                Err(foyer_backend::BackendError::UnknownAction(_)) => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "action_unimplemented".into(),
                            message: format!(
                                "Action `{id_str}` isn't wired up in the current backend yet."
                            ),
                        },
                    )
                    .await;
                }
                Err(e) => return Err(DispatchError::Backend(e)),
            }
        }
        Command::ListRegions { track_id } => {
            let (timeline, regions) = state.backend().await.list_regions(track_id.clone()).await?;
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
            let entries = state.backend().await.list_plugins().await?;
            broadcast_event(state, Event::PluginsList { entries }).await;
        }
        Command::BrowsePath { path, show_hidden } => match &state.jail {
            Some(jail) => match jail.browse(&path, show_hidden) {
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
        Command::OpenSession { path } => match state.backend().await.open_session(&path).await {
            Ok(()) => {
                broadcast_event(
                    state,
                    Event::SessionChanged {
                        path: Some(path.clone()),
                    },
                )
                .await;
                // Follow up with a fresh snapshot so the UI repopulates.
                let snapshot = state.backend().await.snapshot().await?;
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
            if let Err(e) = state.backend().await.save_session(as_path.as_deref()).await {
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
        Command::UpdateRegion { id, patch } => match state.backend().await.update_region(id, patch).await {
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
            match state.backend().await.delete_region(id).await {
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
            match state.backend().await.load_waveform(region_id, samples_per_peak).await {
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
            match state.backend().await.clear_waveform_cache(region_id).await {
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
        Command::ListBackends => {
            let backends = state
                .spawner
                .as_ref()
                .map(|s| s.list())
                .unwrap_or_default();
            let active = state.active_backend_id.read().await.clone();
            broadcast_event(state, Event::BackendsListed { backends, active }).await;
        }
        Command::LaunchProject {
            backend_id,
            project_path,
        } => {
            let Some(spawner) = state.spawner.clone() else {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "no_spawner".into(),
                        message: "this sidecar has no backend spawner configured".into(),
                    },
                )
                .await;
                return Ok(());
            };
            let path = project_path
                .as_deref()
                .map(std::path::Path::new);
            match spawner.launch(&backend_id, path).await {
                Ok(new_backend) => {
                    // Swap atomically. `swap_backend` aborts the old
                    // pump, spawns a new one for `new_backend`, drops
                    // the cached snapshot, and emits `BackendSwapped`.
                    state
                        .swap_backend(backend_id, project_path, new_backend)
                        .await;
                }
                Err(e) => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "launch_failed".into(),
                            message: e.to_string(),
                        },
                    )
                    .await;
                }
            }
        }

        // ─── schema-defined but not yet wired commands ─────────────────
        // These landed as part of the schema push; each will grow a real
        // match arm as it gets integrated. Until then the sidecar tells
        // the client "we know about this but haven't hooked it up yet"
        // instead of silently dropping it.
        Command::UpdateTrack { id, patch } => {
            match state.backend().await.update_track(id, patch).await {
                Ok(track) => {
                    broadcast_event(
                        state,
                        Event::TrackUpdated {
                            track: Box::new(track),
                        },
                    )
                    .await;
                }
                Err(e) => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "update_track_failed".into(),
                            message: e.to_string(),
                        },
                    )
                    .await;
                }
            }
        }
        // Plugin lifecycle — HostBackend forwards the Command::AddPlugin /
        // RemovePlugin to the shim which runs it against `Route::add_processor`
        // / `Route::remove_processor` on the event loop.
        Command::AddPlugin {
            track_id,
            plugin_uri,
            index,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .add_plugin(track_id, plugin_uri, index)
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "add_plugin_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::RemovePlugin { plugin_id } => {
            if let Err(e) = state.backend().await.remove_plugin(plugin_id).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "remove_plugin_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }

        // M6a audio egress: open + close land directly on the sidecar
        // audio hub. For now we're sourcing PCM from a test-tone
        // generator so the browser end can validate the Opus + binary
        // WS path; when the shim's `Route::output()` tap lands, swap
        // the source to `backend.open_egress(...)`'s receiver.
        Command::AudioStreamOpen {
            stream_id,
            source,
            format,
            transport: _transport,
        } => {
            tracing::info!(
                "AudioStreamOpen stream_id={stream_id} source={source:?} \
                 format=({} ch, {} Hz)",
                format.channels,
                format.sample_rate,
            );
            // Try the real backend first. The host backend's
            // `open_egress` forwards an `AudioStreamOpen` IPC command
            // to the shim, which installs a MasterTap processor on the
            // master route and returns a PcmRx that yields live
            // samples (see shims/ardour/src/master_tap.cc). The stub
            // backend's `open_egress` returns a synthetic sine.
            //
            // If the backend call fails (unsupported source, shim not
            // advertising audio yet, etc.), fall back to the
            // sidecar-side test tone so the "Listen" button still
            // makes noise — important while M6a rolls out.
            let rx_res = state
                .backend()
                .await
                .open_egress(stream_id, source.clone(), format)
                .await;
            let rx = match rx_res {
                Ok(be_rx) => {
                    tracing::info!(
                        "open_egress stream_id={stream_id} → real backend (shim master tap)"
                    );
                    be_rx
                }
                Err(e) => {
                    tracing::warn!(
                        "open_egress failed ({e}); falling back to sidecar test tone"
                    );
                    // 1-hour cap is a liveness guard, not a UX
                    // timer — the tone exits immediately when the
                    // subscriber drops (stream close), so in
                    // practice it plays as long as Rich is
                    // listening.
                    state
                        .audio_hub
                        .spawn_test_tone_source(format, std::time::Duration::from_secs(3600))
                }
            };
            match state
                .audio_hub
                .open_stream(stream_id, source.clone(), format, rx)
                .await
            {
                Ok(_) => {
                    broadcast_event(
                        state,
                        Event::AudioEgressStarted { stream_id },
                    )
                    .await;
                }
                Err(e) => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "audio_stream_open_failed".into(),
                            message: e,
                        },
                    )
                    .await;
                }
            }
        }
        Command::AudioStreamClose { stream_id } => {
            // Best-effort: tell the backend to tear the tap down, and
            // close the sidecar-side fan-out regardless.
            let _ = state
                .backend()
                .await
                .close_egress(stream_id)
                .await;
            state.audio_hub.close_stream(stream_id).await;
            broadcast_event(state, Event::AudioEgressStopped { stream_id }).await;
        }

        // MIDI note edits — fire-and-forget to the backend. The host
        // backend forwards the command to the shim, which applies it to
        // Ardour's MidiModel and emits a RegionUpdated event. The web
        // UI does optimistic updates and reconciles on RegionUpdated.
        Command::AddNote { region_id, note } => {
            if let Err(e) = state.backend().await.add_midi_note(region_id, note).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "add_note_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::UpdateNote {
            region_id,
            note_id,
            patch,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .update_midi_note(region_id, note_id, patch)
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "update_note_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::DeleteNote {
            region_id,
            note_id,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .delete_midi_note(region_id, note_id)
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "delete_note_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }

        Command::AddPatchChange { region_id, patch_change } => {
            if let Err(e) = state.backend().await.add_patch_change(region_id, patch_change).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "add_patch_change_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::UpdatePatchChange { region_id, patch_change_id, patch } => {
            if let Err(e) = state.backend().await
                .update_patch_change(region_id, patch_change_id, patch).await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "update_patch_change_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::DeletePatchChange { region_id, patch_change_id } => {
            if let Err(e) = state.backend().await
                .delete_patch_change(region_id, patch_change_id).await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "delete_patch_change_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }

        Command::DuplicateRegion { source_region_id, at_samples, length_samples } => {
            if let Err(e) = state.backend().await
                .duplicate_region(source_region_id, at_samples, length_samples).await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "duplicate_region_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }

        Command::SetSequencerLayout { region_id, layout } => {
            // Three-phase: (1) persist the layout metadata on the
            // host (writes into the region's `_extra_xml`),
            // (2) resize the region to fit the arrangement extent
            // so the song timeline reflects pattern placements,
            // (3) expand the layout into notes and ship a single
            // ReplaceRegionNotes so the region's MIDI matches.
            //
            // Keeping generation server-side per Rich's 2026-04-21
            // redesign: layout is the source of truth; notes (and
            // length) are derived. Every connected client sees the
            // same notes because they all reconcile off the same
            // `RegionUpdated` echo from the shim.
            let notes = foyer_schema::expand_sequencer_layout(&layout, 960);
            // Region length = arrangement extent in ticks → samples
            // at the session's sample rate. We don't know the SR
            // here for sure (each backend may answer differently);
            // use a tempo-aware conversion via 480 ticks/quarter
            // standard PPQN at 120 bpm = 4 ticks per ms = 4
            // samples/ms at 1 kHz; for MIDI ticks → audio samples
            // we let the shim handle the conversion since it knows
            // the session's tempo map. Pass the tick count through
            // a special-cased RegionPatch the shim interprets.
            let length_ticks = foyer_schema::sequencer_layout_length_ticks(&layout, 960);
            if let Err(e) = state.backend().await.set_sequencer_layout(region_id.clone(), layout).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "set_sequencer_layout_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
                return Ok(());
            }
            // Best-effort resize. Tick-to-sample lives in the shim;
            // pass the tick count under a separate field in the
            // RegionPatch so the shim's UpdateRegion handler can
            // convert with the live tempo map. UpdateRegion
            // currently takes `length_samples` only — until the
            // schema gains `length_ticks`, the frontend's job is to
            // size the pattern in seconds and let the user adjust
            // via the timeline. For now we log the desired length
            // so it shows up in diagnostics; native resize lands
            // alongside `length_ticks` schema support.
            tracing::debug!(
                "sequencer regenerate: region={region_id:?} notes={} length_ticks={length_ticks}",
                notes.len(),
            );
            if let Err(e) = state.backend().await.replace_region_notes(region_id, notes).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "replace_region_notes_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::ReplaceRegionNotes { region_id, notes } => {
            if let Err(e) = state.backend().await.replace_region_notes(region_id, notes).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "replace_region_notes_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::ClearSequencerLayout { region_id } => {
            if let Err(e) = state.backend().await.clear_sequencer_layout(region_id).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "clear_sequencer_layout_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }

        Command::Undo => {
            if let Err(e) = state.backend().await.undo().await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "undo_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::Redo => {
            if let Err(e) = state.backend().await.redo().await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "redo_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }

        Command::ListPluginPresets { plugin_id } => {
            match state.backend().await.list_plugin_presets(plugin_id.clone()).await {
                Ok(presets) => {
                    broadcast_event(
                        state,
                        Event::PluginPresetsListed { plugin_id, presets },
                    )
                    .await;
                }
                Err(e) => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "list_plugin_presets_failed".into(),
                            message: e.to_string(),
                        },
                    )
                    .await;
                }
            }
        }
        Command::LoadPluginPreset { plugin_id, preset_id } => {
            if let Err(e) = state.backend().await
                .load_plugin_preset(plugin_id, preset_id).await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "load_plugin_preset_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }

        Command::CreateGroup { .. }
        | Command::UpdateGroup { .. }
        | Command::DeleteGroup { .. }
        | Command::MovePlugin { .. }
        | Command::SavePluginPreset { .. }
        | Command::OpenPluginGui { .. }
        | Command::ClosePluginGui { .. }
        | Command::Locate { .. }
        | Command::AudioSdpAnswer { .. }
        | Command::AudioIceCandidate { .. } => {
            broadcast_event(
                state,
                Event::Error {
                    code: "command_unimplemented".into(),
                    message: format!(
                        "command {:?} accepted by schema but not yet wired to the backend",
                        std::mem::discriminant(&env.body)
                    ),
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
