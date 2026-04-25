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
use axum::extract::{ConnectInfo, Extension, Query, State};
use axum::response::IntoResponse;
use foyer_schema::{
    Command, ControlUpdate, Envelope, Event, TunnelProviderConfig, TunnelProviderKind,
    SCHEMA_VERSION,
};
use futures::{SinkExt, StreamExt};
use std::net::{IpAddr, SocketAddr};
use tokio::sync::broadcast::error::RecvError;

use crate::{AppState, SharedState};

/// Marker inserted as a request extension by the tunnel-auth listener.
/// Presence means "this request came in over the public tunnel"; absence
/// means "LAN listener, trusted". The WS upgrade reads it to decide
/// whether to enforce RBAC.
#[derive(Clone, Copy, Debug)]
pub(crate) struct TunnelOrigin;

pub(crate) async fn upgrade(
    ws: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): SharedState,
    tunnel_origin: Option<Extension<TunnelOrigin>>,
) -> impl IntoResponse {
    let since: Option<u64> = params.get("since").and_then(|s| s.parse().ok());
    let origin = params.get("origin").cloned();
    let token = params.get("token").cloned();
    let is_tunnel = tunnel_origin.is_some();

    // Resolve the per-connection role before the upgrade completes.
    //   · LAN listener (is_tunnel=false): skip RBAC entirely.
    //   · Tunnel listener, valid token: attach the token's role.
    //   · Tunnel listener, missing/bad token: upgrade anyway, but tag
    //     the connection as "auth-required" so the client can render
    //     a login UI and retry with a token.
    let auth = if is_tunnel {
        resolve_tunnel_auth(&state, token.as_deref()).await
    } else {
        ConnectionAuth::Lan
    };

    ws.on_upgrade(move |sock| handle(sock, state, since, origin, peer, auth))
}

/// Per-connection authentication state. Drives the RBAC gate in
/// `dispatch_command`.
#[derive(Clone, Debug)]
pub(crate) enum ConnectionAuth {
    /// Trusted LAN listener — RBAC off, all commands allowed.
    Lan,
    /// Tunnel listener, token verified. `role_id` matches a `RoleDef`
    /// entry in the loaded `RolesConfig`. `recipient` is the invite's
    /// display name (usually the guest's email) — piped into the
    /// greeting so the UI can say "logged in as Alice".
    Authenticated { role_id: String, recipient: String },
    /// Tunnel listener, no valid token. Client sees the greeting with
    /// `auth_required: true` and surfaces a login modal. Until they
    /// re-connect with a token, every command is rejected.
    Unauthenticated,
}

impl ConnectionAuth {
    pub fn is_tunnel(&self) -> bool {
        !matches!(self, ConnectionAuth::Lan)
    }
    pub fn is_authenticated(&self) -> bool {
        matches!(
            self,
            ConnectionAuth::Lan | ConnectionAuth::Authenticated { .. }
        )
    }
}

async fn resolve_tunnel_auth(state: &AppState, token: Option<&str>) -> ConnectionAuth {
    let Some(token) = token else {
        return ConnectionAuth::Unauthenticated;
    };
    // The URL token is `base64url(sha256_bytes(email:password|pepper))`
    // — the *digest* of the credentials, not the credentials themselves.
    // `verify_token` decodes it back to a hex hash and matches the
    // tunnel manifest directly. The form-login path
    // (`verify_credentials`) hashes the typed inputs and matches the
    // same stored hash — both flows arrive at the same comparison.
    match crate::tunnel::verify_token(state, token).await {
        Some(conn) => {
            // Role enum → policy id. TunnelRole serde renames to
            // snake_case which matches the roles.yaml ids.
            let role_id = match conn.role {
                foyer_schema::TunnelRole::Admin => "admin",
                foyer_schema::TunnelRole::SessionController => "session_controller",
                foyer_schema::TunnelRole::Performer => "performer",
                foyer_schema::TunnelRole::Viewer => "viewer",
            };
            ConnectionAuth::Authenticated {
                role_id: role_id.to_string(),
                recipient: conn.recipient,
            }
        }
        None => ConnectionAuth::Unauthenticated,
    }
}

/// Enumerate URLs the sidecar is likely reachable at from other machines
/// on the same LAN. Used for "share session" QR generation — the first
/// entry is the one we expect to Just Work; the rest are alternates
/// (IPv6, additional NICs). We skip loopback so the list is empty when
/// nothing outside the current host could connect — the client uses that
/// emptiness as a signal that share-session won't work here.
fn reachable_urls(hostname: &str, port: u16, tls: bool) -> Vec<String> {
    use local_ip_address::list_afinet_netifas;
    let mut urls = Vec::new();
    if port == 0 {
        return urls;
    }
    // Match the sidecar's actual scheme so the QR round-trips to a
    // working origin — serving HTTPS but advertising `http://` URLs
    // would hand out dead links (connection refused), and vice
    // versa browsers reject a worklet load.
    let scheme = if tls { "https" } else { "http" };
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
            urls.push(format!("{scheme}://{host}:{port}/"));
        }
    }
    // Hostname URL last — most portable but depends on the other machine's
    // mDNS / DNS resolving it. Real IPs first so QR scans "just work."
    if !hostname.is_empty() {
        urls.push(format!("{scheme}://{hostname}:{port}/"));
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
    auth: ConnectionAuth,
) {
    let (mut tx_ws, mut rx_ws) = sock.split();
    let mut rx_broadcast = state.tx.subscribe();

    // Unicast greeting: tells this specific client whether it's local or
    // remote. Sent before any catch-up / snapshot so the UI can paint
    // with the right context from frame one. Also includes the server's
    // reachable URLs so a local client can build a QR to share with a
    // phone or another machine on the LAN.
    let is_local = is_local_addr(&peer);

    // Mint a stable per-connection id — used in the greeting so the
    // client can filter itself out of the peer list, and in every
    // PeerJoined / PeerLeft broadcast.
    let peer_id = uuid::Uuid::new_v4().simple().to_string();
    let connection_role_id = match &auth {
        ConnectionAuth::Authenticated { role_id, .. } => Some(role_id.clone()),
        _ => None,
    };
    let peer_label = match &auth {
        ConnectionAuth::Authenticated { recipient, .. } => recipient.clone(),
        _ => {
            if is_local {
                "host".to_string()
            } else {
                peer.to_string()
            }
        }
    };
    let peer_info = foyer_schema::PeerInfo {
        id: peer_id.clone(),
        label: peer_label,
        remote_addr: peer.to_string(),
        is_local,
        is_tunnel: auth.is_tunnel(),
        role_id: connection_role_id.clone(),
        connected_at: now_ms(),
    };

    {
        let server_host = std::env::var("FOYER_SERVER_HOSTNAME")
            .or_else(|_| hostname::get().map(|h| h.to_string_lossy().into_owned()))
            .unwrap_or_default();
        let port = state.listen_port.load(Ordering::Relaxed);
        let tls = state.tls_enabled.load(Ordering::Relaxed);
        let server_urls = reachable_urls(&server_host, port, tls);
        // Compute the allow-list for this connection's role once at
        // handshake time, so the client can hide/disable disallowed
        // controls without re-implementing pattern matching.
        let (role_id, role_allow, recipient) = match &auth {
            ConnectionAuth::Lan => (None, Vec::new(), None),
            ConnectionAuth::Authenticated { role_id, recipient } => {
                let policy = state.roles_policy.read().await;
                let allow = policy
                    .role(role_id)
                    .map(|r| r.allow.clone())
                    .unwrap_or_default();
                (Some(role_id.clone()), allow, Some(recipient.clone()))
            }
            ConnectionAuth::Unauthenticated => (None, Vec::new(), None),
        };
        let greeting = Envelope {
            schema: SCHEMA_VERSION,
            seq: state.next_seq.fetch_add(1, Ordering::Relaxed),
            origin: Some("server".into()),
            session_id: None,
            body: Event::ClientGreeting {
                remote_addr: peer.to_string(),
                is_local,
                server_host,
                server_port: port,
                server_urls,
                is_tunnel: auth.is_tunnel(),
                is_authenticated: auth.is_authenticated(),
                role_id,
                role_allow,
                recipient,
                peer_id: peer_id.clone(),
                // Capability snapshot — whatever the active backend
                // implementation says it supports. Mirrored on the
                // client into foyer-core's feature registry so the
                // UI can gate surfaces for DAWs with narrower feature
                // sets than Ardour (mixing/matching backends is a
                // medium-term goal — see DECISION 40).
                features: state.backend.read().await.features(),
                // No host-level pin by default. An operator can set
                // `Config::default_ui_variant` to force all browsers
                // onto `touch`, `kids`, `lite`, or a third-party UI.
                default_ui_variant: state.default_ui_variant.clone(),
            },
        };
        let _ = send_env(&mut tx_ws, &greeting).await;
    }

    // Seed the new client with the current roster BEFORE registering
    // ourselves, so the just-joined PeerJoined that we broadcast below
    // doesn't arrive before the snapshot list (which would look like a
    // duplicate on the client side — our own entry both in the list
    // and in a join event).
    {
        let roster: Vec<foyer_schema::PeerInfo> =
            state.peers.read().await.values().cloned().collect();
        let env = Envelope {
            schema: SCHEMA_VERSION,
            seq: state.next_seq.fetch_add(1, Ordering::Relaxed),
            origin: Some("server".into()),
            session_id: None,
            body: Event::PeerList { peers: roster },
        };
        let _ = send_env(&mut tx_ws, &env).await;
    }

    // Unicast the current track → browser-source routing so a late-
    // joining browser knows which tracks it is expected to source
    // audio for without having to ask after greeting.
    {
        let entries: Vec<_> = state
            .track_browser_sources
            .read()
            .await
            .iter()
            .map(|(tid, pid)| foyer_schema::TrackBrowserSourceEntry {
                track_id: tid.clone(),
                peer_id: pid.clone(),
            })
            .collect();
        let env = Envelope {
            schema: SCHEMA_VERSION,
            seq: state.next_seq.fetch_add(1, Ordering::Relaxed),
            origin: Some("server".into()),
            session_id: None,
            body: Event::TrackBrowserSourcesSnapshot { entries },
        };
        let _ = send_env(&mut tx_ws, &env).await;
    }

    // Register + broadcast PeerJoined. Every client (including the one
    // that just connected) receives the join through the broadcast
    // channel; the new client filters its own entry via `peer_id` from
    // the greeting.
    state
        .peers
        .write()
        .await
        .insert(peer_id.clone(), peer_info.clone());
    {
        let env = Envelope {
            schema: SCHEMA_VERSION,
            seq: state.next_seq.fetch_add(1, Ordering::Relaxed),
            origin: Some("server".into()),
            session_id: None,
            body: Event::PeerJoined {
                peer: peer_info.clone(),
            },
        };
        let _ = state.tx.send(env);
    }

    // Initial session roll-up: send the current list of open sessions
    // and any orphans discovered at sidecar startup, so the client's
    // welcome screen / switcher can paint immediately instead of
    // waiting for the first ListSessions round-trip.
    {
        let sessions = state.sessions.list().await;
        let sess_env = Envelope {
            schema: SCHEMA_VERSION,
            seq: state.next_seq.fetch_add(1, Ordering::Relaxed),
            origin: Some("server".into()),
            session_id: None,
            body: Event::SessionList { sessions },
        };
        let _ = send_env(&mut tx_ws, &sess_env).await;
        let orphans = state.orphans.read().await.clone();
        if !orphans.is_empty() {
            let orph_env = Envelope {
                schema: SCHEMA_VERSION,
                seq: state.next_seq.fetch_add(1, Ordering::Relaxed),
                origin: Some("server".into()),
                session_id: None,
                body: Event::OrphansDetected { orphans },
            };
            let _ = send_env(&mut tx_ws, &orph_env).await;
        }
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
    let reader_auth = auth.clone();
    let reader_peer_id = peer_id.clone();
    let reader_peer_label = peer_info.label.clone();
    let reader = tokio::spawn(async move {
        while let Some(frame) = rx_ws.next().await {
            let Ok(msg) = frame else { break };
            match msg {
                Message::Text(t) => {
                    if let Err(e) = dispatch_command(
                        &reader_state,
                        reader_origin.as_deref(),
                        &reader_auth,
                        &reader_peer_id,
                        &reader_peer_label,
                        &t,
                    )
                    .await
                    {
                        tracing::warn!("client command rejected: {e}");
                    }
                }
                Message::Binary(b) => {
                    // Binary frames on the control WS carry push-to-talk
                    // audio. The chat module inspects the prefix byte and
                    // fans the frame out to every peer (minus the sender)
                    // as another binary message. See `chat::handle_binary`
                    // for the wire format.
                    crate::chat::handle_binary(
                        &reader_state,
                        &reader_peer_id,
                        &reader_peer_label,
                        &b,
                    )
                    .await;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // Writer loop — interleaves JSON envelopes (control-plane) with
    // PTT binary frames (push-to-talk audio) over the same WS. The
    // sender filters its own PTT frames by matching the embedded
    // peer id so the speaker doesn't hear itself echo back through
    // the server.
    let mut rx_ptt = state.ptt_tx.subscribe();
    let self_peer_id = peer_id.clone();
    loop {
        tokio::select! {
            biased;
            env_result = rx_broadcast.recv() => match env_result {
                Ok(env) => {
                    // Outbound RBAC filter: events that describe tunnel
                    // admin state (token minted, tunnel started, etc.)
                    // should only reach connections that could have
                    // initiated them. Unauthenticated tunnel guests see
                    // nothing but the greeting + error stream until they
                    // log in.
                    if !should_forward_event(&env.body, &auth, &state).await {
                        continue;
                    }
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
            },
            ptt_result = rx_ptt.recv() => match ptt_result {
                Ok(frame) => {
                    // Skip self-echo. The outbound framing embeds the
                    // speaker's peer id at bytes 10..42 so the comparison
                    // is cheap.
                    if frame.len() >= 42 && &frame[10..42] == self_peer_id.as_bytes() {
                        continue;
                    }
                    use futures::SinkExt;
                    if tx_ws
                        .send(axum::extract::ws::Message::Binary(frame))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            },
        }
    }

    reader.abort();

    // Remove from the peer roster + broadcast PeerLeft so everyone
    // else's status bar prunes us.
    state.peers.write().await.remove(&peer_id);
    let env = Envelope {
        schema: SCHEMA_VERSION,
        seq: state.next_seq.fetch_add(1, Ordering::Relaxed),
        origin: Some("server".into()),
        session_id: None,
        body: Event::PeerLeft {
            peer_id: peer_id.clone(),
        },
    };
    let _ = state.tx.send(env);
    // A host-selected "browser source = this peer" assignment stops
    // making sense the moment the peer leaves — drop those entries
    // and notify everyone so the track editor's selector flips back
    // to "off" for the relevant tracks.
    clear_track_sources_for_peer(&state, &peer_id).await;
    // Also release any PTT hold held by this peer (leaving mid-speech
    // should free the slot).
    crate::chat::handle_ptt_stop(&state, &peer_id).await;
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Decide whether a broadcast event should reach a given connection.
///
/// Rules:
///   · LAN + Authenticated: everything except tunnel-admin events
///     the role can't invoke. Prevents a Viewer from watching invite
///     tokens roll past.
///   · Unauthenticated: only `ClientGreeting` + `Error` + peer-roster
///     events (for UI shell). Everything else is suppressed so a
///     stranger hitting the tunnel URL without a token doesn't leak
///     session content before logging in.
///
/// Events minted unicast via `send_env` (greeting, initial session
/// list, PeerList snapshot) bypass this check — they only reach the
/// connection they're intended for.
async fn should_forward_event(event: &Event, auth: &ConnectionAuth, state: &AppState) -> bool {
    match auth {
        ConnectionAuth::Unauthenticated => {
            matches!(
                event,
                Event::ClientGreeting { .. }
                    | Event::Error { .. }
                    | Event::PeerJoined { .. }
                    | Event::PeerLeft { .. }
                    | Event::PeerList { .. }
            )
        }
        ConnectionAuth::Lan => true,
        ConnectionAuth::Authenticated { role_id, .. } => {
            if is_tunnel_admin_event(event) {
                // Gate tunnel-admin events on the same permission
                // that'd be required to *initiate* them. If the role
                // can't create tokens, it shouldn't be watching them
                // being minted by the host either.
                state
                    .roles_policy
                    .read()
                    .await
                    .allows(role_id, "tunnel_create_token")
            } else {
                true
            }
        }
    }
}

fn is_tunnel_admin_event(e: &Event) -> bool {
    matches!(
        e,
        Event::TunnelState { .. }
            | Event::TunnelUp { .. }
            | Event::TunnelDown { .. }
            | Event::TunnelTokenCreated { .. }
    )
}

async fn send_env<S>(sink: &mut S, env: &Envelope<Event>) -> Result<(), axum::Error>
where
    S: futures::Sink<Message, Error = axum::Error> + Unpin,
{
    let text = serde_json::to_string(env).map_err(axum::Error::new)?;
    sink.send(Message::Text(text)).await
}

/// Pull the wire-format "type" tag off a `Command`. This is the snake-
/// case name serde emits (`Command` is `#[serde(tag = "type",
/// rename_all = "snake_case")]`) — the same string the RBAC policy
/// matches against. Falls back to `"unknown"` if serialization fails,
/// which only happens for non-serializable inner state — effectively
/// never in practice.
fn command_tag(cmd: &Command) -> &'static str {
    // Small match against the discriminant — the set of variants is
    // closed and stable, so handwriting this keeps the hot path free
    // of per-dispatch JSON allocation. Any new `Command` variant must
    // be added here or it'll fall through to "unknown" and be denied
    // for every non-admin role (safer than accidentally allowing).
    match cmd {
        Command::Subscribe => "subscribe",
        Command::RequestSnapshot => "request_snapshot",
        Command::UndoGroupBegin { .. } => "undo_group_begin",
        Command::UndoGroupEnd => "undo_group_end",
        Command::ControlSet { .. } => "control_set",
        Command::AudioEgressStart { .. } => "audio_egress_start",
        Command::AudioEgressStop { .. } => "audio_egress_stop",
        Command::AudioIngressOpen { .. } => "audio_ingress_open",
        Command::AudioIngressClose { .. } => "audio_ingress_close",
        Command::LatencyProbe { .. } => "latency_probe",
        Command::ListActions => "list_actions",
        Command::InvokeAction { .. } => "invoke_action",
        Command::ListRegions { .. } => "list_regions",
        Command::ListPlugins => "list_plugins",
        Command::BrowsePath { .. } => "browse_path",
        Command::OpenSession { .. } => "open_session",
        Command::SaveSession { .. } => "save_session",
        Command::UpdateRegion { .. } => "update_region",
        Command::DeleteRegion { .. } => "delete_region",
        Command::CreateRegion { .. } => "create_region",
        Command::DuplicateRegion { .. } => "duplicate_region",
        Command::ListWaveform { .. } => "list_waveform",
        Command::ClearWaveformCache { .. } => "clear_waveform_cache",
        Command::ListBackends => "list_backends",
        Command::LaunchProject { .. } => "launch_project",
        Command::ListSessions => "list_sessions",
        Command::SelectSession { .. } => "select_session",
        Command::CloseSession { .. } => "close_session",
        Command::ReattachOrphan { .. } => "reattach_orphan",
        Command::DismissOrphan { .. } => "dismiss_orphan",
        Command::UpdateTrack { .. } => "update_track",
        Command::DeleteTrack { .. } => "delete_track",
        Command::ReorderTracks { .. } => "reorder_tracks",
        Command::CreateGroup { .. } => "create_group",
        Command::UpdateGroup { .. } => "update_group",
        Command::DeleteGroup { .. } => "delete_group",
        Command::AddPlugin { .. } => "add_plugin",
        Command::RemovePlugin { .. } => "remove_plugin",
        Command::MovePlugin { .. } => "move_plugin",
        Command::ListPluginPresets { .. } => "list_plugin_presets",
        Command::LoadPluginPreset { .. } => "load_plugin_preset",
        Command::SavePluginPreset { .. } => "save_plugin_preset",
        Command::OpenPluginGui { .. } => "open_plugin_gui",
        Command::ClosePluginGui { .. } => "close_plugin_gui",
        Command::AddNote { .. } => "add_note",
        Command::UpdateNote { .. } => "update_note",
        Command::DeleteNote { .. } => "delete_note",
        Command::ReplaceRegionNotes { .. } => "replace_region_notes",
        Command::AddPatchChange { .. } => "add_patch_change",
        Command::UpdatePatchChange { .. } => "update_patch_change",
        Command::DeletePatchChange { .. } => "delete_patch_change",
        Command::SetSequencerLayout { .. } => "set_sequencer_layout",
        Command::ClearSequencerLayout { .. } => "clear_sequencer_layout",
        Command::SetTrackInput { .. } => "set_track_input",
        Command::ListPorts { .. } => "list_ports",
        Command::AddSend { .. } => "add_send",
        Command::RemoveSend { .. } => "remove_send",
        Command::SetSendLevel { .. } => "set_send_level",
        Command::Undo => "undo",
        Command::Redo => "redo",
        Command::SetAutomationMode { .. } => "set_automation_mode",
        Command::AddAutomationPoint { .. } => "add_automation_point",
        Command::UpdateAutomationPoint { .. } => "update_automation_point",
        Command::DeleteAutomationPoint { .. } => "delete_automation_point",
        Command::ReplaceAutomationLane { .. } => "replace_automation_lane",
        Command::Locate { .. } => "locate",
        Command::SetLoopRange { .. } => "set_loop_range",
        Command::AudioStreamOpen { .. } => "audio_stream_open",
        Command::AudioStreamClose { .. } => "audio_stream_close",
        Command::AudioSdpAnswer { .. } => "audio_sdp_answer",
        Command::AudioIceCandidate { .. } => "audio_ice_candidate",
        Command::TunnelCreateToken { .. } => "tunnel_create_token",
        Command::TunnelRevokeToken { .. } => "tunnel_revoke_token",
        Command::TunnelSetEnabled { .. } => "tunnel_set_enabled",
        Command::TunnelStart { .. } => "tunnel_start",
        Command::TunnelStop => "tunnel_stop",
        Command::TunnelRequestState => "tunnel_request_state",
        Command::ChatSend { .. } => "chat_send",
        Command::ChatClear => "chat_clear",
        Command::ChatHistoryRequest => "chat_history_request",
        Command::ChatSnapshot { .. } => "chat_snapshot",
        Command::PttStart => "ptt_start",
        Command::PttStop => "ptt_stop",
        Command::SetTrackBrowserSource { .. } => "set_track_browser_source",
        Command::ListTrackBrowserSources => "list_track_browser_sources",
    }
}

async fn dispatch_command(
    state: &std::sync::Arc<AppState>,
    origin: Option<&str>,
    auth: &ConnectionAuth,
    peer_id: &str,
    peer_label: &str,
    text: &str,
) -> Result<(), DispatchError> {
    let env: Envelope<Command> = serde_json::from_str(text).map_err(DispatchError::Parse)?;

    // ─── RBAC gate ───────────────────────────────────────────────────
    // LAN connections pass through. Tunnel connections without a valid
    // token are rejected outright (client should show its login modal).
    // Authenticated tunnel connections get their role's allow/deny list
    // checked against the command's wire tag.
    if auth.is_tunnel() {
        let tag = command_tag(&env.body);
        match auth {
            ConnectionAuth::Unauthenticated => {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "auth_required".into(),
                        message: format!(
                            "unauthenticated guest attempted '{tag}' — must sign in first"
                        ),
                    },
                )
                .await;
                return Ok(());
            }
            ConnectionAuth::Authenticated { role_id, recipient } => {
                let allowed = state.roles_policy.read().await.allows(role_id, tag);
                if !allowed {
                    tracing::warn!("RBAC: '{recipient}' (role '{role_id}') denied '{tag}'");
                    // Include recipient + role in the message so the
                    // host (who sees all error broadcasts in the
                    // startup-errors banner) can tell which specific
                    // guest tripped the rule. The same message reaches
                    // the offender — slightly redundant for them but
                    // consistent and harmless.
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "forbidden_for_role".into(),
                            message: format!(
                                "{recipient} (role '{role_id}') is not permitted to invoke '{tag}'"
                            ),
                        },
                    )
                    .await;
                    return Ok(());
                }
            }
            ConnectionAuth::Lan => unreachable!("is_tunnel() guarded"),
        }
    }

    match env.body {
        Command::UndoGroupBegin { name } => {
            if let Err(e) = state.backend().await.undo_group_begin(name).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "undo_group_begin_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::UndoGroupEnd => {
            if let Err(e) = state.backend().await.undo_group_end().await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "undo_group_end_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
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
                session_id: None,
                body: Event::SessionSnapshot {
                    session: Box::new(snapshot),
                },
            };
            *state.cached_snapshot.write().await = Some(out.clone());
            state.ring.write().await.push(out.clone());
            let _ = state.tx.send(out);
        }
        Command::ControlSet { id, value } => {
            state
                .backend()
                .await
                .set_control(id.clone(), value.clone())
                .await?;
            // The backend's event stream will reflect the change; we also emit a
            // synthetic ControlUpdate tagged with the caller's origin so the UI
            // knows who moved the fader.
            let seq = state.next_seq.fetch_add(1, Ordering::Relaxed);
            let out = Envelope {
                schema: SCHEMA_VERSION,
                seq,
                origin: origin.map(str::to_string),
                session_id: None,
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
        Command::UpdateRegion { id, patch } => {
            match state.backend().await.update_region(id, patch).await {
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
            }
        }
        Command::DeleteRegion { id } => {
            let region_id = id.clone();
            match state.backend().await.delete_region(id).await {
                Ok(track_id) => {
                    broadcast_event(
                        state,
                        Event::RegionRemoved {
                            track_id,
                            region_id,
                        },
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
        Command::ListWaveform {
            region_id,
            samples_per_peak,
        } => {
            match state
                .backend()
                .await
                .load_waveform(region_id, samples_per_peak)
                .await
            {
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
                Ok(dropped) => {
                    broadcast_event(state, Event::WaveformCacheCleared { dropped }).await
                }
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
        Command::AudioIngressOpen {
            stream_id,
            source,
            format,
        } => {
            match state
                .backend()
                .await
                .open_ingress(stream_id, source.clone(), format)
                .await
            {
                Ok(tx) => {
                    state.ingress_senders.lock().await.insert(stream_id, tx);
                    broadcast_event(
                        state,
                        Event::AudioIngressOpened {
                            stream_id,
                            source,
                            format,
                            port_name: None,
                        },
                    )
                    .await;
                }
                Err(e) => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "ingress_open_failed".into(),
                            message: e.to_string(),
                        },
                    )
                    .await;
                }
            }
        }
        Command::AudioIngressClose { stream_id } => {
            // Dropping the sender from the registry closes the mpsc
            // channel; the backend's ingress loop exits and the port
            // (or stub capture) tears down from its side.
            state.ingress_senders.lock().await.remove(&stream_id);
            broadcast_event(state, Event::AudioIngressClosed { stream_id }).await;
        }
        Command::AudioEgressStart { .. }
        | Command::AudioEgressStop { .. }
        | Command::LatencyProbe { .. } => {
            // M6 egress/latency territory — acknowledge with an error so
            // the tester UI sees it. Ingress above is now wired.
            broadcast_event(
                state,
                Event::Error {
                    code: "not_implemented".into(),
                    message: "audio command not yet wired".into(),
                },
            )
            .await;
        }
        Command::ListBackends => {
            let backends = state.spawner.as_ref().map(|s| s.list()).unwrap_or_default();
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
            let path = project_path.as_deref().map(std::path::Path::new);
            // "Already open by path" short-circuit. If the user clicks
            // Open on a project whose path matches an already-
            // registered session, focus that session instead of
            // spawning a second Ardour process. Match against BOTH
            // the raw jail-relative string the client sent (which is
            // what swap_backend stored verbatim) and the canonical
            // absolute form — that way future callers that store an
            // absolute path still match.
            if let Some(raw) = project_path.as_deref() {
                let canonical = path
                    .and_then(|p| p.canonicalize().ok())
                    .and_then(|c| c.to_str().map(String::from));
                let mut existing = state.sessions.find_by_path(raw).await;
                if existing.is_none() {
                    if let Some(c) = canonical.as_deref() {
                        existing = state.sessions.find_by_path(c).await;
                    }
                }
                if let Some(existing_id) = existing {
                    tracing::info!(
                        "launch_project: {raw} already open as {existing_id:?} — probing backend health"
                    );
                    if let Some(be) = state.sessions.backend(&existing_id).await {
                        match be.snapshot().await {
                            Ok(snap) => {
                                // Healthy existing session: focus it.
                                *state.focus_session_id.write().await = Some(existing_id.clone());
                                *state.backend.write().await = be;

                                // Emit a session list refresh + snapshot so the
                                // client repaints without a round-trip.
                                let sessions = state.sessions.list().await;
                                broadcast_event(state, Event::SessionList { sessions }).await;
                                let out = Envelope {
                                    schema: SCHEMA_VERSION,
                                    seq: state.next_seq.fetch_add(1, Ordering::Relaxed),
                                    origin: Some("backend".into()),
                                    session_id: Some(existing_id),
                                    body: Event::SessionSnapshot {
                                        session: Box::new(snap),
                                    },
                                };
                                *state.cached_snapshot.write().await = Some(out.clone());
                                state.ring.write().await.push(out.clone());
                                let _ = state.tx.send(out);
                                return Ok(());
                            }
                            Err(e) => {
                                // Stale registry entry: close and fall through to
                                // a fresh launch instead of falsely "focusing".
                                tracing::warn!(
                                    "launch_project: existing session {existing_id:?} is stale (snapshot failed: {e}); closing stale entry and relaunching"
                                );
                                let _ = state.sessions.close(&existing_id).await;
                            }
                        }
                    } else {
                        tracing::warn!(
                            "launch_project: existing session {existing_id:?} has no backend; closing stale entry and relaunching"
                        );
                        let _ = state.sessions.close(&existing_id).await;
                    }
                }
            }
            match spawner.launch(&backend_id, path).await {
                Ok(new_backend) => {
                    // swap_backend synthesizes a session UUID when
                    // the caller doesn't supply one. Once the
                    // shim-side UUID plumbing lands (reading from
                    // the .ardour file's extra_xml on hello), the
                    // CLI spawner will set it on the backend before
                    // returning and we can pass it through here.
                    state
                        .swap_backend(backend_id, project_path, new_backend, None, None)
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
        Command::DeleteTrack { id } => {
            if let Err(e) = state.backend().await.delete_track(id).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "delete_track_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::ReorderTracks { ordered_ids } => {
            if let Err(e) = state.backend().await.reorder_tracks(ordered_ids).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "reorder_tracks_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::SetTrackInput {
            track_id,
            port_name,
        } => {
            // Track-kind vs port-kind mismatch check. A MIDI track
            // wired to an audio port produces silent frames and lets
            // clients accidentally route a mic capture to a MIDI
            // track. Reject up front before it hits the backend so
            // alt-UIs and CLI drivers can't bypass the UI-side filter
            // (PLAN 155). Empty `port_name` restores default
            // auto-connect; skip the check in that case.
            let backend = state.backend().await;
            let mismatch = if let Some(name) = port_name.as_deref().filter(|s| !s.is_empty()) {
                let session = backend.snapshot().await.ok();
                let track = session
                    .as_ref()
                    .and_then(|s| s.tracks.iter().find(|t| t.id == track_id));
                let ports = backend.list_ports(None).await.unwrap_or_default();
                let port = ports.iter().find(|p| p.name == name);
                match (track, port) {
                    (Some(t), Some(p)) => {
                        use foyer_schema::TrackKind;
                        let track_is_midi = matches!(t.kind, TrackKind::Midi);
                        if track_is_midi != p.is_midi {
                            let want = if track_is_midi { "MIDI" } else { "audio" };
                            let got = if p.is_midi { "MIDI" } else { "audio" };
                            Some(format!(
                                "track '{}' is {} but port '{}' is {}",
                                t.name, want, name, got,
                            ))
                        } else {
                            None
                        }
                    }
                    _ => None,
                }
            } else {
                None
            };
            if let Some(message) = mismatch {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "set_track_input_mismatch".into(),
                        message,
                    },
                )
                .await;
            } else if let Err(e) = backend.set_track_input(track_id, port_name).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "set_track_input_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::ListPorts { direction } => {
            match state.backend().await.list_ports(direction).await {
                Ok(ports) => {
                    broadcast_event(state, Event::PortsListed { ports }).await;
                }
                Err(e) => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "list_ports_failed".into(),
                            message: e.to_string(),
                        },
                    )
                    .await;
                }
            }
        }
        Command::AddSend {
            track_id,
            target_track_id,
            pre_fader,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .add_send(track_id, target_track_id, pre_fader)
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "add_send_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::RemoveSend { send_id } => {
            if let Err(e) = state.backend().await.remove_send(send_id).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "remove_send_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::SetSendLevel { send_id, level } => {
            if let Err(e) = state.backend().await.set_send_level(send_id, level).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "set_send_level_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        // Plugin lifecycle — HostBackend forwards the Command::AddPlugin /
        // RemovePlugin to the shim which runs it against `Route::add_processor`
        // / `Route::remove_processor` on the event loop.
        Command::AddPlugin {
            track_id,
            plugin_uri,
            index,
            clone_from,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .add_plugin(track_id, plugin_uri, index, clone_from)
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
                Err(foyer_backend::BackendError::AudioEgressUnavailable) => {
                    // Typed "this backend has nothing to play" signal
                    // (e.g. stub backend with test tone disabled).
                    // Surface a clean error to the client and DON'T
                    // fall back to the sidecar test tone — the user
                    // wants silence, not a 440 Hz reference, when
                    // there's no DAW connected.
                    tracing::info!(
                        "open_egress stream_id={stream_id}: backend declined audio (silent)"
                    );
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "audio_egress_unavailable".into(),
                            message: "backend has no audio source — connect a DAW to listen".into(),
                        },
                    )
                    .await;
                    return Ok(());
                }
                Err(e) => {
                    // Any other backend error — treat the same as
                    // `AudioEgressUnavailable`: surface a clean error
                    // and stay silent. Falling back to the sidecar
                    // test tone (the prior behavior) was obnoxious
                    // when Ardour briefly errored on session swap or
                    // when the shim's writer queue closed during a
                    // reconnect: every "Listen" click landed on a
                    // 440 Hz sine instead of just being quiet.
                    // (Rich, 2026-04-26.)
                    tracing::warn!(
                        "open_egress stream_id={stream_id} failed ({e}); staying silent"
                    );
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "audio_egress_unavailable".into(),
                            message: format!("audio source unavailable: {e}"),
                        },
                    )
                    .await;
                    return Ok(());
                }
            };
            match state
                .audio_hub
                .open_stream(stream_id, source.clone(), format, rx)
                .await
            {
                Ok(_) => {
                    broadcast_event(state, Event::AudioEgressStarted { stream_id }).await;
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
        Command::SetLoopRange {
            start_samples,
            end_samples,
            enabled,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .set_loop_range(start_samples, end_samples, enabled)
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "set_loop_range_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::AudioStreamClose { stream_id } => {
            // Best-effort: tell the backend to tear the tap down, and
            // close the sidecar-side fan-out regardless.
            let _ = state.backend().await.close_egress(stream_id).await;
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
        Command::DeleteNote { region_id, note_id } => {
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

        Command::AddPatchChange {
            region_id,
            patch_change,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .add_patch_change(region_id, patch_change)
                .await
            {
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
        Command::UpdatePatchChange {
            region_id,
            patch_change_id,
            patch,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .update_patch_change(region_id, patch_change_id, patch)
                .await
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
        Command::DeletePatchChange {
            region_id,
            patch_change_id,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .delete_patch_change(region_id, patch_change_id)
                .await
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

        Command::DuplicateRegion {
            source_region_id,
            at_samples,
            length_samples,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .duplicate_region(source_region_id, at_samples, length_samples)
                .await
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

        Command::CreateRegion {
            track_id,
            at_samples,
            length_samples,
            kind,
            name,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .create_region(track_id, at_samples, length_samples, kind, name)
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "create_region_failed".into(),
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
            // PPQN MUST match what Ardour uses internally
            // (`Temporal::ticks_per_beat = 1920`). Earlier code
            // passed 960 here and the shim's resize math also used
            // 960 — both wrong by a factor of 2 vs Ardour's actual
            // tick scale, so notes played at double-time and the
            // region length came out half the intended duration.
            //
            // `active == false` means the client is *deactivating*
            // the sequencer (converting to MIDI) — persist the
            // metadata but DON'T regenerate notes. The region's
            // current notes stay in place and become the
            // authoritative content. `active == true` (default)
            // keeps the old behavior: regen notes from the layout.
            let is_active = layout.active;
            let notes = foyer_schema::expand_sequencer_layout(&layout, 1920);
            // Region length = arrangement extent in ticks → samples
            // at the session's sample rate. We don't know the SR
            // here for sure (each backend may answer differently);
            // use a tempo-aware conversion via 480 ticks/quarter
            // standard PPQN at 120 bpm = 4 ticks per ms = 4
            // samples/ms at 1 kHz; for MIDI ticks → audio samples
            // we let the shim handle the conversion since it knows
            // the session's tempo map. Pass the tick count through
            // a special-cased RegionPatch the shim interprets.
            let length_ticks = foyer_schema::sequencer_layout_length_ticks(&layout, 1920);
            if let Err(e) = state
                .backend()
                .await
                .set_sequencer_layout(region_id.clone(), layout)
                .await
            {
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
                "sequencer regenerate: region={region_id:?} active={is_active} notes={} length_ticks={length_ticks}",
                notes.len(),
            );
            // Only regenerate notes when the layout is active.
            // Deactivation (active=false) leaves existing notes
            // untouched so piano-roll edits can take over.
            if is_active {
                if let Err(e) = state
                    .backend()
                    .await
                    .replace_region_notes(region_id, notes)
                    .await
                {
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
        }
        Command::ReplaceRegionNotes { region_id, notes } => {
            if let Err(e) = state
                .backend()
                .await
                .replace_region_notes(region_id, notes)
                .await
            {
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
            if let Err(e) = state
                .backend()
                .await
                .clear_sequencer_layout(region_id)
                .await
            {
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

        // ─── automation lane edit (Phase B) ─────────────────────────
        Command::SetAutomationMode { lane_id, mode } => {
            if let Err(e) = state
                .backend()
                .await
                .set_automation_mode(lane_id, mode)
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "set_automation_mode_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::AddAutomationPoint { lane_id, point } => {
            if let Err(e) = state
                .backend()
                .await
                .add_automation_point(lane_id, point)
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "add_automation_point_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::UpdateAutomationPoint {
            lane_id,
            original_time_samples,
            new_time_samples,
            value,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .update_automation_point(lane_id, original_time_samples, new_time_samples, value)
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "update_automation_point_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::DeleteAutomationPoint {
            lane_id,
            time_samples,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .delete_automation_point(lane_id, time_samples)
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "delete_automation_point_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::ReplaceAutomationLane { lane_id, points } => {
            if let Err(e) = state
                .backend()
                .await
                .replace_automation_lane(lane_id, points)
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "replace_automation_lane_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }

        Command::ListPluginPresets { plugin_id } => {
            match state
                .backend()
                .await
                .list_plugin_presets(plugin_id.clone())
                .await
            {
                Ok(presets) => {
                    broadcast_event(state, Event::PluginPresetsListed { plugin_id, presets }).await;
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
        Command::LoadPluginPreset {
            plugin_id,
            preset_id,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .load_plugin_preset(plugin_id, preset_id)
                .await
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

        // Transport seek — translate to a `transport.position`
        // ControlSet so backends that already wire that control
        // (the Ardour shim does) get a seek without needing a
        // separate Locate trait method. The beat sequencer's seek
        // bar uses this; previously fell through the
        // command_unimplemented arm and surfaced as a startup-toast
        // for every click on the timeline.
        Command::Locate { samples } => {
            use foyer_schema::{ControlValue, EntityId};
            if let Err(e) = state
                .backend()
                .await
                .set_control(
                    EntityId::new("transport.position"),
                    ControlValue::Float(samples as f64),
                )
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "locate_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }

        // ─── multi-session control plane ────────────────────────────
        Command::ListSessions => {
            let sessions = state.sessions.list().await;
            broadcast_event(state, Event::SessionList { sessions }).await;
            let orphans = state.orphans.read().await.clone();
            if !orphans.is_empty() {
                broadcast_event(state, Event::OrphansDetected { orphans }).await;
            }
        }
        Command::SelectSession { session_id } => {
            // Single-focus: update the sidecar-wide focused session
            // so subsequent commands without explicit session_id route
            // to this one's backend. A per-connection override could
            // layer on later for multi-browser-window scenarios.
            *state.focus_session_id.write().await = Some(session_id.clone());
            // Immediately re-snapshot against the newly-focused
            // backend so the browser sees the switched-to session's
            // tracks/regions.
            if let Ok(snap) = state.backend().await.snapshot().await {
                let out = Envelope {
                    schema: SCHEMA_VERSION,
                    seq: state.next_seq.fetch_add(1, Ordering::Relaxed),
                    origin: Some("backend".into()),
                    session_id: Some(session_id),
                    body: Event::SessionSnapshot {
                        session: Box::new(snap),
                    },
                };
                *state.cached_snapshot.write().await = Some(out.clone());
                state.ring.write().await.push(out.clone());
                let _ = state.tx.send(out);
            }
        }
        Command::CloseSession { session_id } => {
            match state.sessions.close(&session_id).await {
                Some(_info) => {
                    // If we just closed the focused session, fall
                    // through to the next-most-recent one (or clear
                    // focus when there's nothing left). Also mirror
                    // the backend pointer so plain commands still
                    // land on a live backend.
                    {
                        let mut focus = state.focus_session_id.write().await;
                        if focus.as_ref() == Some(&session_id) {
                            *focus = None;
                        }
                    }
                    if let Some(fallback_id) = state.sessions.most_recent_id().await {
                        if let Some(be) = state.sessions.backend(&fallback_id).await {
                            *state.backend.write().await = be;
                            *state.focus_session_id.write().await = Some(fallback_id);
                        }
                    }
                }
                None => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "session_not_found".into(),
                            message: format!("no open session with id {session_id:?}"),
                        },
                    )
                    .await;
                }
            }
        }
        Command::ReattachOrphan { orphan_id } => {
            let mut orphans = state.orphans.write().await;
            if let Some(pos) = orphans.iter().position(|o| o.id == orphan_id) {
                let info = orphans.remove(pos);
                drop(orphans);
                // Stub for now: without the spawner's "attach to
                // existing socket" path we can't reach the orphan.
                // Emit the error + clear it from the registry so the
                // user can at least dismiss.
                broadcast_event(
                    state,
                    Event::Error {
                        code: "reattach_unimplemented".into(),
                        message: format!(
                            "reattach to orphan {} at {} is not yet wired; you can dismiss it for now",
                            info.name, info.socket.as_deref().unwrap_or("?"),
                        ),
                    },
                )
                .await;
            } else {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "orphan_not_found".into(),
                        message: format!("no orphan with id {orphan_id:?}"),
                    },
                )
                .await;
            }
        }
        Command::DismissOrphan { orphan_id } => {
            let mut orphans = state.orphans.write().await;
            if let Some(pos) = orphans.iter().position(|o| o.id == orphan_id) {
                let info = orphans.remove(pos);
                drop(orphans);
                let _ = crate::orphans::remove_entry(info.id.as_str()).await;
                // Send an updated orphan list so UIs can tear down
                // the "dismiss" chip.
                let remaining = state.orphans.read().await.clone();
                broadcast_event(state, Event::OrphansDetected { orphans: remaining }).await;
            }
        }

        Command::CreateGroup {
            name,
            color,
            members,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .create_group(name, color, members)
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "create_group_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::UpdateGroup { id, patch } => {
            if let Err(e) = state.backend().await.update_group(id, patch).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "update_group_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::DeleteGroup { id } => {
            if let Err(e) = state.backend().await.delete_group(id).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "delete_group_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }

        // ─── Tunnel / remote access ─────────────────────────────────────
        Command::TunnelCreateToken { recipient, role } => {
            match crate::tunnel::create_token(state, recipient.clone(), role).await {
                Ok((conn, token, password)) => {
                    let url = conn
                        .tunnel_url
                        .clone()
                        .unwrap_or_else(|| format!("http://localhost:3838/?token={token}"));
                    tracing::info!("tunnel token created for {recipient}: {url}");
                    broadcast_event(
                        state,
                        Event::TunnelTokenCreated {
                            connection: conn,
                            token,
                            password,
                            url,
                        },
                    )
                    .await;
                }
                Err(e) => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "tunnel_create_failed".into(),
                            message: e.to_string(),
                        },
                    )
                    .await;
                }
            }
        }
        Command::TunnelRevokeToken { id } => {
            if let Err(e) = crate::tunnel::revoke_token(state, &id).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "tunnel_revoke_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::TunnelSetEnabled { enabled } => {
            {
                let mut m = state.tunnel_manifest.write().await;
                m.enabled = enabled;
                let _ = crate::tunnel::save_manifest(&m).await;
            }
            crate::tunnel::broadcast_tunnel_state(state).await;
        }
        Command::TunnelStart { provider } => {
            let tunnel_cfg = state.tunnel_cfg.read().await.clone();
            let config = match provider {
                TunnelProviderKind::Ngrok => TunnelProviderConfig::Ngrok {
                    auth_token: tunnel_cfg.ngrok.as_ref().and_then(|c| c.auth_token.clone()),
                    region: tunnel_cfg.ngrok.as_ref().and_then(|c| c.region.clone()),
                    subdomain: tunnel_cfg.ngrok.as_ref().and_then(|c| c.subdomain.clone()),
                    domain: tunnel_cfg.ngrok.as_ref().and_then(|c| c.domain.clone()),
                },
                TunnelProviderKind::Cloudflare => TunnelProviderConfig::Cloudflare {
                    api_token: tunnel_cfg
                        .cloudflare
                        .as_ref()
                        .and_then(|c| c.api_token.clone()),
                    account_id: tunnel_cfg
                        .cloudflare
                        .as_ref()
                        .and_then(|c| c.account_id.clone()),
                    zone_id: tunnel_cfg
                        .cloudflare
                        .as_ref()
                        .and_then(|c| c.zone_id.clone()),
                    tunnel_name: tunnel_cfg
                        .cloudflare
                        .as_ref()
                        .and_then(|c| c.tunnel_name.clone()),
                    hostname: tunnel_cfg
                        .cloudflare
                        .as_ref()
                        .and_then(|c| c.hostname.clone()),
                    tunnel_token: tunnel_cfg
                        .cloudflare
                        .as_ref()
                        .and_then(|c| c.tunnel_token.clone()),
                },
            };
            if let Err(e) = crate::tunnel::start_tunnel(state.clone(), provider, &config).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "tunnel_start_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }
        Command::TunnelStop => {
            crate::tunnel::stop_tunnel(state).await;
        }
        Command::TunnelRequestState => {
            crate::tunnel::broadcast_tunnel_state(state).await;
        }

        Command::ChatSend { body } => {
            crate::chat::handle_send(state, peer_id, peer_label, body).await;
        }
        Command::ChatClear => {
            crate::chat::handle_clear(state, peer_id, peer_label, auth).await;
        }
        Command::ChatHistoryRequest => {
            crate::chat::handle_history_request(state).await;
        }
        Command::ChatSnapshot { filename } => {
            crate::chat::handle_snapshot(state, auth, filename).await;
        }
        Command::PttStart => {
            crate::chat::handle_ptt_start(state, peer_id, peer_label).await;
        }
        Command::PttStop => {
            crate::chat::handle_ptt_stop(state, peer_id).await;
        }
        Command::SetTrackBrowserSource {
            track_id,
            peer_id: assigned_peer,
        } => {
            set_track_browser_source(state, track_id, assigned_peer).await;
        }
        Command::ListTrackBrowserSources => {
            broadcast_track_browser_sources(state).await;
        }

        Command::MovePlugin {
            plugin_id,
            new_index,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .move_plugin(plugin_id, new_index)
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "move_plugin_failed".into(),
                        message: e.to_string(),
                    },
                )
                .await;
            }
        }

        Command::SavePluginPreset { .. }
        | Command::OpenPluginGui { .. }
        | Command::ClosePluginGui { .. }
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
        session_id: None,
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

/// Apply a "which peer is the source for this track" assignment.
/// Empty `assigned_peer` clears. Also sets the track's `monitoring`
/// to `false` so the assigned user doesn't try to live-monitor
/// themselves over a high-latency browser leg.
async fn set_track_browser_source(
    state: &std::sync::Arc<AppState>,
    track_id: foyer_schema::EntityId,
    assigned_peer: String,
) {
    let peer_id = if assigned_peer.is_empty() {
        None
    } else {
        Some(assigned_peer)
    };
    {
        let mut map = state.track_browser_sources.write().await;
        match &peer_id {
            Some(p) => {
                map.insert(track_id.clone(), p.clone());
            }
            None => {
                map.remove(&track_id);
            }
        }
    }
    broadcast_event(
        state,
        Event::TrackBrowserSourceChanged {
            track_id: track_id.clone(),
            peer_id: peer_id.clone(),
        },
    )
    .await;

    // Disable live monitoring on any track that has a browser source —
    // a 100–300 ms round trip would make hearing yourself unusable.
    // Best-effort: ignore backend errors (the schema change still gets
    // out to clients so the UI hides the Listen control regardless).
    if peer_id.is_some() {
        // `monitoring` is a semantic enum on the wire ("off" / "cue" /
        // "input"); forcing "off" matches the policy documented in
        // SetTrackBrowserSource's schema comment. Latency over the
        // browser leg would make live monitoring unusable.
        let monitor_patch = foyer_schema::session::TrackPatch {
            monitoring: Some("off".to_string()),
            ..Default::default()
        };
        let backend = state.backend().await;
        if let Err(e) = backend.update_track(track_id.clone(), monitor_patch).await {
            tracing::debug!(
                "set_track_browser_source: backend.update_track(monitoring=off) failed: {e}"
            );
        }
    }
}

/// Broadcast the current routing table. Sent on `ListTrackBrowserSources`
/// and piggybacked by the connect handshake so a fresh browser immediately
/// knows which tracks it is on the hook for.
async fn broadcast_track_browser_sources(state: &std::sync::Arc<AppState>) {
    let entries: Vec<_> = state
        .track_browser_sources
        .read()
        .await
        .iter()
        .map(|(tid, pid)| foyer_schema::TrackBrowserSourceEntry {
            track_id: tid.clone(),
            peer_id: pid.clone(),
        })
        .collect();
    broadcast_event(state, Event::TrackBrowserSourcesSnapshot { entries }).await;
}

/// Called from the WS disconnect path so a peer leaving clears any
/// track assignments that pointed at them — otherwise the host would
/// see "Alice" still listed as the source for a track long after she
/// closed her browser.
pub(crate) async fn clear_track_sources_for_peer(state: &std::sync::Arc<AppState>, peer_id: &str) {
    let cleared: Vec<_> = {
        let mut map = state.track_browser_sources.write().await;
        let tids: Vec<_> = map
            .iter()
            .filter(|(_, pid)| *pid == peer_id)
            .map(|(tid, _)| tid.clone())
            .collect();
        for tid in &tids {
            map.remove(tid);
        }
        tids
    };
    for tid in cleared {
        broadcast_event(
            state,
            Event::TrackBrowserSourceChanged {
                track_id: tid,
                peer_id: None,
            },
        )
        .await;
    }
}
