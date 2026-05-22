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
//!   Honored only on LAN connections. On tunnel connections the server overrides
//!   it with the per-connection `connection_id` so a guest can't spoof another
//!   peer's origin label, and so multi-window peers can self-echo-filter at
//!   connection granularity (sibling windows see each other's control updates).
//! - `parent=<peer_id>` — multi-window opt-in. When set AND the named peer
//!   exists AND auth matches (same `role_id`/`recipient` or both LAN), this
//!   connection joins the existing logical peer as a `Secondary` window — it
//!   shares the parent's `peer_id`, `PeerAudioPrefs`, source-user
//!   assignments, MIDI ownership, etc. Audio ingress/egress is rejected on
//!   secondaries. Invalid parent (gone, auth mismatch) → falls back to a
//!   fresh `Primary` connection with a freshly-minted `peer_id`.

mod cmd_actions;
mod cmd_agent;
mod cmd_automation;
mod cmd_chat;
mod cmd_groups;
mod cmd_scripts;
mod cmd_sends;
mod cmd_tunnel;
mod cmd_undo;
mod command_tag;
use command_tag::command_tag;

use std::collections::HashMap;
use std::sync::atomic::Ordering;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Extension, Query, State};
use axum::response::IntoResponse;
use foyer_schema::{
    AudioFormat, Command, ControlUpdate, EntityId, Envelope, Event, SCHEMA_VERSION,
};
use futures::{SinkExt, StreamExt};
use std::net::{IpAddr, SocketAddr};
use tokio::sync::broadcast::error::RecvError;

use crate::{AppState, SharedState};

/// Re-shape the orphan list into the jail-relative form that hits the
/// wire. The on-disk `RegistryEntry.project_path` is whatever absolute
/// path the shim recorded at startup — fine for server-side
/// bookkeeping (the reattach path needs the absolute form to
/// canonicalize against), but a leak when broadcast verbatim because
/// every other UI-facing path on the wire is jail-relative
/// (`SessionInfo.path`, `BackendSwapped.project_path`,
/// `RecentEntry.path`). Without this stripper, the welcome-screen's
/// "Unfinished sessions found" banner displayed
/// `/workspaces/foyer-studio/sessions/asdf` while everything else
/// next to it read `foyer-studio/sessions/asdf` — same project, two
/// different labels, clearly an internal detail bleeding through.
async fn orphans_for_wire(state: &std::sync::Arc<AppState>) -> Vec<foyer_schema::OrphanInfo> {
    let mut orphans = state.orphans.read().await.clone();
    for o in &mut orphans {
        if !o.path.is_empty() {
            o.path = state.sessions.jail_display_path(&o.path).await;
        }
    }
    orphans
}

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
    let parent_peer_id = params.get("parent").cloned().filter(|s| !s.is_empty());
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

    ws.on_upgrade(move |sock| handle(sock, state, since, origin, peer, auth, parent_peer_id))
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
    parent_peer_id: Option<String>,
) {
    let (mut tx_ws, mut rx_ws) = sock.split();
    let mut rx_broadcast = state.tx.subscribe();

    // Unicast greeting: tells this specific client whether it's local or
    // remote. Sent before any catch-up / snapshot so the UI can paint
    // with the right context from frame one. Also includes the server's
    // reachable URLs so a local client can build a QR to share with a
    // phone or another machine on the LAN.
    let is_local = is_local_addr(&peer);

    let connection_id = uuid::Uuid::new_v4().simple().to_string();
    let connection_role_id = match &auth {
        ConnectionAuth::Authenticated { role_id, .. } => Some(role_id.clone()),
        _ => None,
    };
    let connection_recipient = match &auth {
        ConnectionAuth::Authenticated { recipient, .. } => Some(recipient.clone()),
        _ => None,
    };

    // Multi-window join: if `?parent=<peer_id>` was supplied AND the
    // parent peer exists AND its auth matches ours (same tunnel
    // role+recipient, or both LAN), reuse the parent's peer_id and
    // attach as a Secondary. Otherwise mint a fresh peer_id and run
    // as Primary. Auth mismatch silently falls back rather than
    // rejecting the connection — that way an outdated localStorage
    // hint can't strand the user.
    let (peer_id, connection_role) = {
        let mut peer_id = None;
        if let Some(ref pid) = parent_peer_id {
            let peers = state.peers.read().await;
            if let Some(parent) = peers.get(pid) {
                let parent_matches = parent.is_local == is_local
                    && parent.is_tunnel == auth.is_tunnel()
                    && parent.role_id == connection_role_id;
                // For tunnel guests we also require the recipient
                // (invite email) to match — otherwise a guest with
                // the same role could hijack another guest's window
                // family by guessing their peer_id.
                let recipient_ok = if auth.is_tunnel() {
                    match (&parent.label, &connection_recipient) {
                        (label, Some(r)) => label == r,
                        _ => false,
                    }
                } else {
                    true
                };
                if parent_matches && recipient_ok {
                    peer_id = Some(pid.clone());
                }
            }
        }
        match peer_id {
            Some(pid) => (pid, foyer_schema::ConnectionRole::Secondary),
            None => (
                uuid::Uuid::new_v4().simple().to_string(),
                foyer_schema::ConnectionRole::Primary,
            ),
        }
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

    // Origin label propagated into every ControlUpdate this connection
    // emits. On LAN we trust the user-supplied `?origin=` query param;
    // on tunnel connections we replace it with the server-minted
    // `connection_id` (not `peer_id`!) so a guest can't pretend to be
    // another peer in the audit trail AND so sibling windows of the
    // same logical user can self-echo-filter at connection granularity
    // (otherwise window A's controlSet would look like a self-echo to
    // window B because they share peer_id).
    let origin = if auth.is_tunnel() {
        Some(format!("conn:{connection_id}"))
    } else {
        origin
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
            api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
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
                connection_id: connection_id.clone(),
                connection_role,
                // Capability snapshot — whatever the active backend
                // implementation says it supports. Mirrored on the
                // client into foyer-core's feature registry so the
                // UI can gate surfaces for DAWs with narrower feature
                // sets than Ardour (mixing/matching backends is a
                // medium-term goal — see DECISION 40).
                features: state.merged_feature_map().await,
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
            api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
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
            api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
            seq: state.next_seq.fetch_add(1, Ordering::Relaxed),
            origin: Some("server".into()),
            session_id: None,
            body: Event::TrackBrowserSourcesSnapshot { entries },
        };
        let _ = send_env(&mut tx_ws, &env).await;
    }

    // Seed the new client with the current script list so the Scripts
    // panel (and external MCP clients that call `scripts.list` right
    // after attach) has data without an explicit refresh round-trip.
    // The session snapshot already carries `scripting` capabilities;
    // the persisted scripts are a separate stream.
    if let Ok(scripts) = state.backend().await.list_scripts().await {
        let env = Envelope {
            schema: SCHEMA_VERSION,
            api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
            seq: state.next_seq.fetch_add(1, Ordering::Relaxed),
            origin: Some("server".into()),
            session_id: None,
            body: Event::ScriptList { scripts },
        };
        let _ = send_env(&mut tx_ws, &env).await;
    }

    // Register the connection-level row first so command dispatch
    // can resolve `connection_id → ConnectionRole` (audio gate) the
    // moment we yield to the reader task.
    state.connections.write().await.insert(
        connection_id.clone(),
        crate::ConnectionMeta {
            peer_id: peer_id.clone(),
            role: connection_role,
        },
    );

    // Register the logical-peer row. For a Secondary connection
    // (existing peer_id), we bump `connection_count` and skip the
    // PeerJoined broadcast — other clients shouldn't see a "new peer"
    // for every window the host opens. Only the 0→1 transition fires
    // PeerJoined; subsequent windows are invisible to other peers'
    // rosters (modulo `connection_count`, which is just metadata).
    let (peer_info, is_first_connection) = {
        let mut peers = state.peers.write().await;
        match peers.get_mut(&peer_id) {
            Some(existing) => {
                existing.connection_count = existing.connection_count.saturating_add(1);
                (existing.clone(), false)
            }
            None => {
                let info = foyer_schema::PeerInfo {
                    id: peer_id.clone(),
                    label: peer_label,
                    remote_addr: peer.to_string(),
                    is_local,
                    is_tunnel: auth.is_tunnel(),
                    role_id: connection_role_id.clone(),
                    connected_at: now_ms(),
                    connection_count: 1,
                };
                peers.insert(peer_id.clone(), info.clone());
                (info, true)
            }
        }
    };

    if is_first_connection {
        let env = Envelope {
            schema: SCHEMA_VERSION,
            api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
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
    // waiting for the first ListSessions round-trip. RecentsList rides
    // along on the same paint so the welcome screen has everything it
    // needs before the user's first interaction.
    {
        let sessions = state.sessions.list().await;
        let sess_env = Envelope {
            schema: SCHEMA_VERSION,
            api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
            seq: state.next_seq.fetch_add(1, Ordering::Relaxed),
            origin: Some("server".into()),
            session_id: None,
            body: Event::SessionList { sessions },
        };
        let _ = send_env(&mut tx_ws, &sess_env).await;
        let orphans = orphans_for_wire(&state).await;
        if !orphans.is_empty() {
            let orph_env = Envelope {
                schema: SCHEMA_VERSION,
                api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
                seq: state.next_seq.fetch_add(1, Ordering::Relaxed),
                origin: Some("server".into()),
                session_id: None,
                body: Event::OrphansDetected { orphans },
            };
            let _ = send_env(&mut tx_ws, &orph_env).await;
        }
        let recents = crate::recents::load().await;
        let rec_env = Envelope {
            schema: SCHEMA_VERSION,
            api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
            seq: state.next_seq.fetch_add(1, Ordering::Relaxed),
            origin: Some("server".into()),
            session_id: None,
            body: Event::RecentsList { recents },
        };
        let _ = send_env(&mut tx_ws, &rec_env).await;
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
    let reader_connection_role = connection_role;
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
                        reader_connection_role,
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
                    if !should_forward_event(&env.body, &auth, &self_peer_id, &state).await {
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

    // Drop the connection-level row first. If this was the last
    // window for the logical peer, fall through to PeerLeft +
    // routing cleanup; otherwise the peer is still around (one of
    // their other windows is open) and we leave shared state alone.
    state.connections.write().await.remove(&connection_id);

    let last_connection = {
        let mut peers = state.peers.write().await;
        match peers.get_mut(&peer_id) {
            Some(info) => {
                info.connection_count = info.connection_count.saturating_sub(1);
                if info.connection_count == 0 {
                    peers.remove(&peer_id);
                    true
                } else {
                    false
                }
            }
            None => true,
        }
    };

    if last_connection {
        let env = Envelope {
            schema: SCHEMA_VERSION,
            api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
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
        // to "off" for the relevant tracks. Skipped when only one
        // window of a multi-window peer closed: the logical user is
        // still here, just with one less monitor.
        clear_track_sources_for_peer(&state, &peer_id).await;
        // Also release any PTT hold held by this peer (leaving mid-speech
        // should free the slot).
        crate::chat::handle_ptt_stop(&state, &peer_id).await;
    }
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
///   · Targeted errors (`Event::Error.target_peer_id == Some(..)`)
///     are visible only to the named peer plus LAN / tunnel-admin
///     connections. Used for RBAC denials so a viewer doesn't see
///     another viewer's banner flash by.
///
/// Events minted unicast via `send_env` (greeting, initial session
/// list, PeerList snapshot) bypass this check — they only reach the
/// connection they're intended for.
async fn should_forward_event(
    event: &Event,
    auth: &ConnectionAuth,
    self_peer_id: &str,
    state: &AppState,
) -> bool {
    // Scope: targeted errors stop at the offender + admins.
    if let Event::Error {
        target_peer_id: Some(target),
        ..
    } = event
    {
        if target == self_peer_id {
            return true;
        }
        // Admin proxy: LAN is always trusted; tunnel roles must be
        // permitted to mint invite tokens (same gate as
        // `is_tunnel_admin_event`).
        return match auth {
            ConnectionAuth::Lan => true,
            ConnectionAuth::Authenticated { role_id, .. } => state
                .roles_policy
                .read()
                .await
                .allows(role_id, "tunnel_create_token"),
            ConnectionAuth::Unauthenticated => false,
        };
    }
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

/// Sanitize optional save-as target, reject overwrite of existing session dirs
/// / files inside the jail, and return the path to pass to the backend: an
/// **absolute** filesystem path to the new session folder when a jail is
/// configured, otherwise a sanitized relative string (non-jail setups). `None` /
/// empty string means save-in-place (same as omitting `as_path` on the wire).
fn normalize_save_as_path(
    raw: Option<&str>,
    jail: Option<&crate::jail::Jail>,
) -> Result<Option<String>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let t = raw.trim();
    if t.is_empty() {
        return Ok(None);
    }
    let rel = crate::files::sanitize_relative_path(t);
    if rel.as_os_str().is_empty() {
        return Err("invalid save path".into());
    }
    if let Some(jail) = jail {
        match jail.existing_session_save_conflict(&rel) {
            Ok(true) => {
                return Err(
                    "that path already exists or contains a session — pick a new folder name"
                        .into(),
                );
            }
            Err(e) => return Err(e.to_string()),
            Ok(false) => {}
        }
        // Ardour expects an absolute filesystem path to the *new session folder*
        // (parent/name), not a Foyer jail-relative segment.
        let abs = jail.root().join(&rel);
        return Ok(Some(abs.to_string_lossy().into_owned()));
    }
    Ok(Some(crate::files::rel_path_wire(&rel)))
}

async fn dispatch_command(
    state: &std::sync::Arc<AppState>,
    origin: Option<&str>,
    auth: &ConnectionAuth,
    peer_id: &str,
    peer_label: &str,
    connection_role: foyer_schema::ConnectionRole,
    text: &str,
) -> Result<(), DispatchError> {
    let env: Envelope<Command> = serde_json::from_str(text).map_err(DispatchError::Parse)?;

    // ─── Audio-role gate ─────────────────────────────────────────────
    // Audio ingress/egress and the related WebRTC handshake belong to
    // the spawning (`Primary`) window. Secondary windows of a multi-
    // window peer are control-plane only — the browser security model
    // forbids moving AudioContext / MediaStream between windows, and
    // even if it didn't, every window opening its own mic would
    // duplicate the audio path. Reject loudly so the secondary's UI
    // can degrade gracefully rather than silently produce dead air.
    if matches!(connection_role, foyer_schema::ConnectionRole::Secondary) {
        let blocked = matches!(
            env.body,
            Command::AudioIngressOpen { .. }
                | Command::AudioIngressClose { .. }
                | Command::AudioEgressStart { .. }
                | Command::AudioEgressStop { .. }
                | Command::AudioStreamOpen { .. }
                | Command::AudioStreamClose { .. }
                | Command::AudioSdpAnswer { .. }
                | Command::AudioIceCandidate { .. }
        );
        if blocked {
            let tag = command_tag(&env.body);
            broadcast_event(
                state,
                Event::error_localized(
                    "secondary_window_audio",
                    foyer_i18n::loc!(
                        "Audio command '%{tag}' rejected: this is a secondary window — open it on the spawning window instead.",
                        tag = tag
                    ),
                    Some(peer_id.to_string()),
                ),
            )
            .await;
            return Ok(());
        }
    }

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
                    Event::error_localized(
                        "auth_required",
                        foyer_i18n::loc!(
                            "Unauthenticated guest attempted '%{tag}' — you must sign in first.",
                            tag = tag
                        ),
                        Some(peer_id.to_string()),
                    ),
                )
                .await;
                return Ok(());
            }
            ConnectionAuth::Authenticated { role_id, recipient } => {
                let allowed = state.roles_policy.read().await.allows(role_id, tag);
                if !allowed {
                    tracing::warn!("RBAC: '{recipient}' (role '{role_id}') denied '{tag}'");
                    // The message names the recipient + role so any
                    // admin/LAN console operator who receives it can
                    // attribute the denial to a specific guest. The
                    // event is targeted at the offender's peer_id so
                    // routing limits the broadcast to that peer +
                    // LAN/admin connections; other guests don't see
                    // another guest's denial banner flash by.
                    broadcast_event(
                        state,
                        Event::error_localized(
                            "forbidden_for_role",
                            foyer_i18n::loc!(
                                "%{recipient} (role '%{role_id}') is not permitted to invoke '%{tag}'.",
                                recipient = recipient,
                                role_id = role_id,
                                tag = tag
                            ),
                            Some(peer_id.to_string()),
                        ),
                    )
                    .await;
                    return Ok(());
                }
            }
            ConnectionAuth::Lan => unreachable!("is_tunnel() guarded"),
        }
    }

    match env.body {
        Command::UndoGroupBegin { name } => cmd_undo::undo_group_begin(state, name).await,
        Command::UndoGroupEnd => cmd_undo::undo_group_end(state).await,
        Command::ClockProbe { client_ts_ms } => {
            // NTP-style single bounce. Sample server's monotonic clock
            // ASAP, echo the client timestamp back so the requester
            // can compute (recv - send) / 2 as the one-way latency
            // estimate. Reply rides the broadcast bus (cheap — tiny
            // payload, ~5/connect) so we don't have to plumb a
            // unicast back-channel through dispatch_command; clients
            // filter the reply by matching the echoed `client_ts_ms`.
            let server_mono_ns = crate::audio::monotonic_nanos();
            // Best-effort offset cache: assume the probe round-trip
            // is symmetric and use the simplest one-bounce estimate
            // `client_mono - server_mono`. The browser refines its
            // own estimate over multiple probes; the server-side
            // cache exists so the ingress hot path has SOMETHING
            // to subtract before the browser has finished its first
            // probe round (otherwise the first second of a recording
            // would have wildly wrong latency stamps). Subsequent
            // probes overwrite this with the latest sample — no
            // smoothing on the server side, the median latency
            // tracker absorbs noise downstream.
            let client_ns = (client_ts_ms * 1_000_000.0) as i64;
            let offset_ns = client_ns.saturating_sub(server_mono_ns as i64);
            state.clock_offset_ns.store(offset_ns, Ordering::Relaxed);
            broadcast_event(
                state,
                Event::ClockProbeReply {
                    client_ts_ms,
                    server_mono_ns,
                },
            )
            .await;
        }
        Command::ProbeSessionRecovery { project_path } => {
            // Resolve `project_path` against the jail (when configured)
            // so we read the same file the host DAW will open. No
            // jail = dev/LAN mode, treat it as already-absolute. The
            // probe is a directory scan, no I/O over the wire and no
            // spawn — safe to run inline.
            //
            // Dispatch through the registry default profile rather
            // than calling Ardour-specific helpers directly. The
            // welcome screen fires this before any backend is
            // attached, so we have no `backend_id` to key on; the
            // registry's default (typically Ardour) is the right
            // answer for now. When the wire schema grows a
            // `backend_id` field on ProbeSessionRecovery, dispatch
            // off that instead.
            let abs = match state.jail.as_ref() {
                Some(jail) => jail.root().join(project_path.trim_start_matches('/')),
                None => std::path::PathBuf::from(&project_path),
            };
            let profiles = state.profiles().await;
            let artifacts = profiles
                .get_or_default("")
                .map(|p| p.probe_recovery(&abs))
                .unwrap_or_default();
            tracing::info!(
                "probe_session_recovery: path={} → resolved {} → {} artifact(s) found",
                project_path,
                abs.display(),
                artifacts.len(),
            );
            broadcast_event(
                state,
                Event::SessionRecoveryAvailable {
                    project_path,
                    artifacts,
                },
            )
            .await;
        }
        Command::AudioBufferReport {
            stream_id,
            buffered_samples,
            target_samples,
        } => {
            // Slow PI controller against the worklet's buffer-fill
            // signal. Goal: keep `buffered ≈ target` across long-
            // running sessions where engine-clock vs AudioContext-
            // clock skew (10–50 ppm) would otherwise drift the
            // queue toward overrun or underrun. We translate
            // observed error into a ratio nudge in ppm:
            //
            //   Kp = 0.2 ppm per 100-sample error (≈ 2 ms @ 48k)
            //   Ki = 0.02 ppm per (100-sample-second) accumulated
            //   deadband: ±960 samples (~20 ms) — below this the
            //   loop sleeps; the buffer naturally absorbs sub-frame
            //   variation.
            //
            // The numbers are conservative on purpose: the
            // controller only has to absorb ppm-level skew, not
            // chase short-term jitter. Reports come in at 1 Hz so
            // the loop converges in tens of seconds — well below
            // the timescale at which user-visible drift would
            // accumulate.
            let target = target_samples as f64;
            let buffered = buffered_samples as f64;
            let error = buffered - target;
            const DEADBAND_SAMPLES: f64 = 960.0;
            const KP_PPM_PER_100SAMPLES: f64 = 0.2;
            const KI_PPM_PER_100SAMPLE_S: f64 = 0.02;
            const I_CLAMP: f64 = 50_000.0; // bounds runaway integral
            let nudge_ppm = if error.abs() < DEADBAND_SAMPLES {
                0.0
            } else {
                let mut integ = state.drift_integral.lock().await;
                let i = integ.entry(stream_id).or_insert(0.0);
                *i = (*i + error).clamp(-I_CLAMP, I_CLAMP);
                let p_term = error / 100.0 * KP_PPM_PER_100SAMPLES;
                let i_term = *i / 100.0 * KI_PPM_PER_100SAMPLE_S;
                // Sign convention: when buffered > target the
                // browser is ahead of the encoder — encoder should
                // PRODUCE LESS audio per unit time → DOWN-rate the
                // effective ratio (out_hz / in_hz) → push fewer
                // output samples per input sample. So negative
                // nudge for positive error.
                -(p_term + i_term)
            };
            if nudge_ppm.abs() > 0.0 {
                let _ = state
                    .audio_hub
                    .nudge_stream_ratio(stream_id, nudge_ppm)
                    .await;
            }
        }
        Command::RequestIngressLatency { stream_id } => {
            // The ingress WS handler records per-stream latency
            // samples in a median tracker. Broadcast the result so
            // the requesting client (and diagnostics peers) can see it.
            let median_ms = state.ingress_latency.median_ms(stream_id);
            broadcast_event(
                state,
                Event::IngressLatencyReport {
                    stream_id,
                    median_ms,
                },
            )
            .await;
        }
        Command::SetIngressCaptureLatency { stream_id, samples } => {
            if let Err(e) = state
                .backend()
                .await
                .set_ingress_capture_latency(stream_id, samples)
                .await
            {
                tracing::debug!("set_ingress_capture_latency forwarding failed: {e}");
            }
        }
        Command::SetIngressRingPrimeMs { ms } => {
            if let Err(e) = state.backend().await.set_ingress_ring_prime_ms(ms).await {
                tracing::debug!("set_ingress_ring_prime_ms forwarding failed: {e}");
            }
        }
        Command::SetMidiCaptureLatency { track_id, samples } => {
            // Normally emitted server-internally from the MidiInput
            // handler when the per-track median moves; exposing the
            // dispatch arm lets tooling poke at the value directly
            // (parity with SetIngressCaptureLatency above).
            if let Err(e) = state
                .backend()
                .await
                .set_midi_capture_latency(track_id, samples)
                .await
            {
                tracing::debug!("set_midi_capture_latency forwarding failed: {e}");
            }
        }
        Command::SetFakeLatency {
            ingress_ms,
            egress_ms,
        } => {
            if let Some(v) = ingress_ms {
                state.fake_ingress_latency_ms.store(v, Ordering::Relaxed);
                tracing::info!("fake ingress latency set to {v} ms");
            }
            if let Some(v) = egress_ms {
                state.fake_egress_latency_ms.store(v, Ordering::Relaxed);
                tracing::info!("fake egress latency set to {v} ms");
            }
        }
        Command::SetIngressManualOffsetMs { ms } => {
            // Per-peer: a different client setting their offset
            // doesn't affect anyone else. The Arc is shared with
            // any IngressSink already opened by this peer so the
            // change is observed on the next ingress packet.
            let prefs = state.peer_prefs_for(peer_id).await;
            prefs.ingress_manual_offset_ms.store(ms, Ordering::Relaxed);
            tracing::info!("ingress manual offset for peer {peer_id} set to {ms} ms");
        }
        Command::StartIngressCalibration {
            egress_stream_id,
            ingress_stream_id,
            clicks,
        } => {
            let sr = state.backend().await.sample_rate();
            let target =
                state
                    .calibration
                    .start_run(egress_stream_id, ingress_stream_id, sr, clicks);
            tracing::info!(
                "calibration start: egress={egress_stream_id} ingress={ingress_stream_id} clicks={target}"
            );
        }
        Command::StopIngressCalibration { egress_stream_id } => {
            if let Some(result) = state.calibration.stop_run(egress_stream_id) {
                tracing::info!(
                    "calibration stop: kept {}/{} median {:.1} ms",
                    result.samples_kept,
                    result.samples_requested,
                    result.median_ms
                );
                broadcast_event(
                    state,
                    Event::CalibrationResult {
                        stream_id: result.stream_id,
                        median_ms: result.median_ms,
                        samples_kept: result.samples_kept,
                        samples_requested: result.samples_requested,
                        suggested_offset_ms: suggested_offset(state, result.median_ms),
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
                api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
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
                api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
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
        Command::ListActions => cmd_actions::list_actions(state).await?,
        Command::InvokeAction { id } => cmd_actions::invoke_action(state, id).await?,
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
        Command::ListAudioPool => {
            let Some(sid) = state.focus_session_id.read().await.clone() else {
                broadcast_event(state, Event::AudioPoolListed { sources: vec![] }).await;
                return Ok(());
            };
            let sources = state.backend().await.list_audio_pool(&sid).await?;
            broadcast_event(state, Event::AudioPoolListed { sources }).await;
        }
        Command::ImportAudio { path } => {
            let resolved = if let Some(jail) = state.jail.as_ref() {
                let rel = crate::files::sanitize_relative_path(&path);
                let abs = jail.root().join(rel);
                let canon = abs.canonicalize().map_err(|e| {
                    DispatchError::Backend(foyer_backend::BackendError::NoSuchPath(format!(
                        "import_audio path: {e}"
                    )))
                })?;
                let root = jail.root().canonicalize().map_err(|e| {
                    DispatchError::Backend(foyer_backend::BackendError::Other(format!(
                        "jail root: {e}"
                    )))
                })?;
                if !canon.starts_with(&root) {
                    return Err(DispatchError::Backend(
                        foyer_backend::BackendError::OutsideJail(path),
                    ));
                }
                canon.to_string_lossy().into_owned()
            } else {
                path
            };
            state.backend().await.import_audio(resolved).await?;
            // Broadcast a fresh pool listing so every connected client
            // sees the new source land without a manual refresh round-
            // trip. The FE used to chase this with a list_audio_pool
            // immediately after the import command, but that races the
            // Ardour shim's async slot pipeline (SourceFactory is
            // called from the shim's event loop, so the source isn't
            // yet visible when the next dispatch runs). Emitting from
            // the server AFTER `import_audio` resolves removes the
            // race entirely.
            if let Some(sid) = state.focus_session_id.read().await.clone() {
                if let Ok(sources) = state.backend().await.list_audio_pool(&sid).await {
                    broadcast_event(state, Event::AudioPoolListed { sources }).await;
                }
            }
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
                            target_peer_id: None,
                            localized: None,
                        },
                    )
                    .await;
                }
            },
            None => {
                broadcast_event(
                    state,
                    Event::error_localized(
                        "no_jail",
                        foyer_i18n::loc!("Filesystem browsing is disabled (no --jail configured)."),
                        None,
                    ),
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
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        },
        Command::SaveSession { as_path } => {
            let normalized = match normalize_save_as_path(as_path.as_deref(), state.jail.as_ref()) {
                Ok(n) => n,
                Err(message) => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "save_session_failed".into(),
                            message,
                            target_peer_id: None,
                            localized: None,
                        },
                    )
                    .await;
                    return Ok(());
                }
            };
            if let Err(e) = state
                .backend()
                .await
                .save_session(normalized.as_deref())
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "save_session_failed".into(),
                        message: e.to_string(),
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            } else if let Some(abs_raw) = normalized {
                // Save-as: Ardour switches the active session to the new folder.
                // Refresh registry paths, tell clients (session chip + recents),
                // and ship a snapshot so the name in the switcher matches Ardour.
                let canon = std::path::Path::new(&abs_raw)
                    .canonicalize()
                    .unwrap_or_else(|_| std::path::Path::new(&abs_raw).to_path_buf());
                let canon_str = canon.to_string_lossy().into_owned();
                let display_rel = state.sessions.jail_display_path(&canon_str).await;

                if let Some(sid) = state.focus_session_id.read().await.clone() {
                    if state.sessions.has(&sid).await {
                        let _ = state
                            .sessions
                            .update_project_location(&sid, canon_str.clone())
                            .await;
                    }
                }

                broadcast_event(
                    state,
                    Event::SessionChanged {
                        path: Some(display_rel.clone()),
                    },
                )
                .await;

                if let Some(jail_root) = state.sessions.jail_root.read().await.clone() {
                    let backend_id = if let Some(sid) = state.focus_session_id.read().await.as_ref()
                    {
                        match state.sessions.backend_id_of(sid).await {
                            Some(b) => b,
                            None => state
                                .active_backend_id
                                .read()
                                .await
                                .clone()
                                .unwrap_or_default(),
                        }
                    } else {
                        state
                            .active_backend_id
                            .read()
                            .await
                            .clone()
                            .unwrap_or_default()
                    };
                    let profiles = state.profiles().await;
                    let recents = crate::recents::touch(
                        foyer_schema::RecentEntry {
                            path: crate::recents::normalize_path(
                                &display_rel,
                                Some(jail_root.as_path()),
                            ),
                            name: String::new(),
                            backend_id,
                            opened_at: 0,
                        },
                        profiles.default_id(),
                    )
                    .await;
                    broadcast_event(state, Event::RecentsList { recents }).await;
                }

                match state.backend().await.snapshot().await {
                    Ok(snapshot) => {
                        broadcast_event(
                            state,
                            Event::SessionSnapshot {
                                session: Box::new(snapshot),
                            },
                        )
                        .await;
                    }
                    Err(e) => {
                        tracing::warn!("save_session ok but snapshot failed: {e}");
                    }
                }
            }
        }
        Command::RenderSession { handle, opts } => {
            // Acknowledge first so the FE can flip its modal into a
            // progress state before any encoding work starts.
            broadcast_event(
                state,
                Event::RenderStarted {
                    handle: handle.clone(),
                },
            )
            .await;
            // Wire the backend's `progress` callback into a periodic
            // RenderProgress broadcast. We rate-limit to one event per
            // ~250ms to keep the wire quiet — backends that pulse every
            // sample don't flood the broadcast bus, but the bar still
            // feels live to the user.
            let progress_tx = state.tx.clone();
            let progress_handle = handle.clone();
            let progress_next_seq = state.next_seq.clone();
            let last_emit_ms = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let last_emit_ms_for_cb = last_emit_ms.clone();
            let progress_cb: foyer_backend::ProgressFn = Box::new(move |percent: u8| {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let prev = last_emit_ms_for_cb.load(std::sync::atomic::Ordering::Relaxed);
                // Always let the 0% and 100% boundaries through so the
                // UI flips out of "indeterminate" cleanly even on very
                // short renders that finish under the rate-limit gap.
                if percent != 100 && now_ms.saturating_sub(prev) < 250 {
                    return;
                }
                last_emit_ms_for_cb.store(now_ms, std::sync::atomic::Ordering::Relaxed);
                let env = Envelope {
                    schema: SCHEMA_VERSION,
                    api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
                    seq: progress_next_seq.fetch_add(1, Ordering::Relaxed),
                    origin: Some("backend".into()),
                    session_id: None,
                    body: Event::RenderProgress {
                        handle: progress_handle.clone(),
                        percent,
                        eta_seconds: None,
                    },
                };
                let _ = progress_tx.send(env);
            });
            // Spawn the render so a long encode (eventually: Ardour's
            // ExportHandler can take many seconds on a large session)
            // doesn't block the WS command pump.
            let state_for_render = state.clone();
            tokio::spawn(async move {
                let backend = state_for_render.backend().await;
                match backend.render_session(opts, Some(progress_cb)).await {
                    Ok(outputs) => {
                        broadcast_event(
                            &state_for_render,
                            Event::RenderComplete { handle, outputs },
                        )
                        .await;
                    }
                    Err(e) => {
                        broadcast_event(
                            &state_for_render,
                            Event::RenderError {
                                handle,
                                message: e.to_string(),
                            },
                        )
                        .await;
                    }
                }
            });
        }
        Command::UpdateRegion { id, patch } => {
            match state.backend().await.update_region(id, patch).await {
                Ok(region) => {
                    broadcast_event(
                        state,
                        Event::RegionUpdated {
                            region: Box::new(region),
                        },
                    )
                    .await
                }
                Err(e) => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "update_region_failed".into(),
                            message: e.to_string(),
                            target_peer_id: None,
                            localized: None,
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
                            target_peer_id: None,
                            localized: None,
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
                            target_peer_id: None,
                            localized: None,
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
                            target_peer_id: None,
                            localized: None,
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
            let engine_sr = state.backend().await.sample_rate();
            let client_sr = format.sample_rate;
            let ch = format.channels.max(1);
            let engine_frame = u32::try_from(u64::from(engine_sr) * 20 / 1000)
                .unwrap_or(u32::MAX)
                .max(32);
            let shim_format = AudioFormat {
                sample_rate: engine_sr,
                channels: ch,
                format: format.format,
                frame_size: engine_frame,
                codec: format.codec,
            };
            match state
                .backend()
                .await
                .open_ingress(stream_id, source.clone(), shim_format)
                .await
            {
                Ok((tx, ack)) => {
                    let peer_prefs = state.peer_prefs_for(peer_id).await;
                    state.ingress_senders.lock().await.insert(
                        stream_id,
                        crate::IngressSink {
                            tx,
                            client_sample_rate: client_sr,
                            engine_sample_rate: engine_sr,
                            channels: ch,
                            port_name: ack.port_name.clone(),
                            peer_audio_prefs: peer_prefs,
                        },
                    );
                    broadcast_event(
                        state,
                        Event::AudioIngressOpened {
                            stream_id,
                            source,
                            format: ack.format,
                            port_name: ack.port_name,
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
                            target_peer_id: None,
                            localized: None,
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
            // Strip every track→stream entry that pointed at this
            // stream so subsequent regions on those tracks don't
            // get auto-stamped with a dead stream's stale latency.
            {
                let mut map = state.track_ingress.lock().await;
                map.retain(|_, sid| *sid != stream_id);
            }
            broadcast_event(state, Event::AudioIngressClosed { stream_id }).await;
        }
        Command::AudioEgressStart { .. }
        | Command::AudioEgressStop { .. }
        | Command::LatencyProbe { .. } => {
            // M6 egress/latency territory — acknowledge with an error so
            // the tester UI sees it. Ingress above is now wired.
            broadcast_event(
                state,
                Event::error_localized(
                    "not_implemented",
                    foyer_i18n::loc!("Audio command not yet wired."),
                    None,
                ),
            )
            .await;
        }
        Command::SubscribeSpectrum { target, opts } => {
            // Route preference: native (in-shim) FFT if the backend
            // advertises it; otherwise the server-side fallback
            // analyser that taps the same audio egress the audio hub
            // already streams from. The fallback means the spectrum
            // tile WORKS on the Ardour shim today even though its C++
            // FFT pipeline isn't shipped yet.
            let backend = state.backend().await;
            let native_supported = backend
                .spectrum_capabilities()
                .await
                .ok()
                .flatten()
                .map(|c| c.available)
                .unwrap_or(false);
            if native_supported {
                match backend.subscribe_spectrum(target.clone(), opts).await {
                    Ok(_applied) => {
                        // Backend emits SpectrumSubscribed itself.
                    }
                    Err(e) => {
                        broadcast_event(
                            state,
                            Event::Error {
                                code: "subscribe_spectrum_failed".into(),
                                message: e.to_string(),
                                target_peer_id: None,
                                localized: None,
                            },
                        )
                        .await;
                    }
                }
            } else {
                // Server-side fallback: open an egress tap, run FFTs
                // in Rust, broadcast SpectrumFrame events through the
                // same channel native subscriptions use.
                let sample_rate = backend.sample_rate();
                if let Err(e) = state
                    .spectrum_svc
                    .subscribe(
                        state.clone(),
                        backend.clone(),
                        target.clone(),
                        opts,
                        sample_rate,
                    )
                    .await
                {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "subscribe_spectrum_failed".into(),
                            message: e,
                            target_peer_id: None,
                            localized: None,
                        },
                    )
                    .await;
                }
            }
        }
        Command::UnsubscribeSpectrum { target } => {
            let backend = state.backend().await;
            let native_supported = backend
                .spectrum_capabilities()
                .await
                .ok()
                .flatten()
                .map(|c| c.available)
                .unwrap_or(false);
            if native_supported {
                if let Err(e) = backend.unsubscribe_spectrum(target.clone()).await {
                    tracing::warn!("unsubscribe_spectrum failed: {e}");
                }
            } else {
                state
                    .spectrum_svc
                    .unsubscribe(state.clone(), backend.clone(), target.clone())
                    .await;
            }
        }
        Command::ListBackends => {
            let backends = state.spawner.as_ref().map(|s| s.list()).unwrap_or_default();
            let active = state.active_backend_id.read().await.clone();
            broadcast_event(state, Event::BackendsListed { backends, active }).await;
        }
        Command::LaunchProject {
            backend_id,
            project_path,
            sample_rate,
            recover_crash,
        } => {
            let Some(spawner) = state.spawner.clone() else {
                broadcast_event(
                    state,
                    Event::error_localized(
                        "no_spawner",
                        foyer_i18n::loc!("This sidecar has no backend spawner configured."),
                        None,
                    ),
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
                                state.install_active_backend(be).await;

                                // Promote in recents — re-clicking an
                                // open project is still a "use" event
                                // and should bump it to the top.
                                // Normalize the path through the jail
                                // canonicalizer so absolute and
                                // jail-relative inputs collapse to
                                // the same key (no duplicates) and
                                // we never write a host-absolute
                                // path back to the UI.
                                let jail_root = state.sessions.jail_root.read().await.clone();
                                let profiles = state.profiles().await;
                                let recents = crate::recents::touch(
                                    foyer_schema::RecentEntry {
                                        path: crate::recents::normalize_path(
                                            raw,
                                            jail_root.as_deref(),
                                        ),
                                        name: String::new(),
                                        backend_id: backend_id.clone(),
                                        opened_at: 0,
                                    },
                                    profiles.default_id(),
                                )
                                .await;
                                broadcast_event(state, Event::RecentsList { recents }).await;

                                // Emit a session list refresh + snapshot so the
                                // client repaints without a round-trip.
                                let sessions = state.sessions.list().await;
                                broadcast_event(state, Event::SessionList { sessions }).await;
                                // Re-focusing an already-open session needs an
                                // explicit SessionFocusChanged so clients sync
                                // their `currentSessionId` to ours — without
                                // this, the store keeps its previous focus and
                                // filters out region/control envelopes routed
                                // through the newly-focused backend by tag
                                // mismatch. See store.js `session_focus_changed`.
                                broadcast_event(
                                    state,
                                    Event::SessionFocusChanged {
                                        session_id: Some(existing_id.clone()),
                                    },
                                )
                                .await;
                                let out = Envelope {
                                    schema: SCHEMA_VERSION,
                                    api_version: foyer_schema::CONTROL_PLANE_API_VERSION
                                        .to_string(),
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
            // Dispatch the user's crash-recovery choice (set on the
            // browser by `confirmCrashDataBeforeLaunch`). Two paths:
            //   - `Some(false)` (Discard): delete the live `.pending`
            //     file so Ardour's `AskAboutPendingState` signal
            //     doesn't fire, no dialog opens.
            //   - `Some(true)` (Recover): leave `.pending` in place;
            //     the Ardour shim auto-clicks the recovery dialog via
            //     `FOYER_CRASH_RECOVERY=recover` (set in the spawner).
            //   - `None`: no artifacts; nothing to do.
            // `.history` is never touched — it's regular undo state,
            // not crash data.
            if recover_crash == Some(false) {
                if let Some(p) = path {
                    let abs = match state.jail.as_ref() {
                        Some(jail) => jail
                            .root()
                            .join(p.to_string_lossy().trim_start_matches('/')),
                        None => p.to_path_buf(),
                    };
                    let profiles = state.profiles().await;
                    let n = profiles
                        .get_or_default(&backend_id)
                        .map(|prof| prof.discard_recovery(&abs))
                        .unwrap_or(0);
                    if n > 0 {
                        tracing::info!(
                            "launch_project: discarded {n} pending crash-recovery file(s) at {} ({})",
                            abs.display(),
                            backend_id,
                        );
                    }
                }
            }
            match spawner
                .launch(&backend_id, path, sample_rate, recover_crash)
                .await
            {
                Ok(launched) => {
                    // swap_backend synthesizes a session UUID when
                    // the caller doesn't supply one. Once the
                    // shim-side UUID plumbing lands (reading from
                    // the .ardour file's extra_xml on hello), the
                    // CLI spawner will set it on the backend before
                    // returning and we can pass it through here.
                    let touch_path = project_path.clone();
                    let touch_backend = backend_id.clone();
                    state
                        .swap_backend(
                            backend_id,
                            project_path,
                            launched.backend,
                            None,
                            None,
                            launched.process,
                            launched.mcp_endpoint,
                        )
                        .await;
                    // Promote the just-opened project to the top of
                    // recents. Persisted server-side so welcome
                    // screens across browser profiles see the same
                    // history.
                    if let Some(p) = touch_path {
                        // Same canonicalize-then-jail-strip we do on
                        // the "already-open" focus path above —
                        // without it a launch via `/abs/path` and a
                        // launch via `jail-relative/path` for the
                        // same project end up as two distinct
                        // recents.json entries.
                        let jail_root = state.sessions.jail_root.read().await.clone();
                        let profiles = state.profiles().await;
                        let recents = crate::recents::touch(
                            foyer_schema::RecentEntry {
                                path: crate::recents::normalize_path(&p, jail_root.as_deref()),
                                name: String::new(),
                                backend_id: touch_backend,
                                opened_at: 0,
                            },
                            profiles.default_id(),
                        )
                        .await;
                        broadcast_event(state, Event::RecentsList { recents }).await;
                    }
                }
                Err(e) => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "launch_failed".into(),
                            message: e.to_string(),
                            target_peer_id: None,
                            localized: None,
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
        Command::CreateTrack {
            name,
            kind,
            color,
            after_id,
            instrument_uri,
            plugins,
            copy_from_track_id,
            gm_program,
            gm_channel,
        } => {
            match state
                .backend()
                .await
                .create_track_full(
                    name,
                    kind,
                    color,
                    after_id,
                    instrument_uri,
                    plugins,
                    copy_from_track_id,
                    gm_program,
                    gm_channel,
                )
                .await
            {
                Ok(track) => {
                    // Force a snapshot reload so every connected client
                    // gets the new track id + its automation lanes;
                    // mirrors the stub backend's GroupUpdated path.
                    broadcast_event(
                        state,
                        Event::SessionPatch {
                            patch: foyer_schema::Patch::Reload,
                        },
                    )
                    .await;
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
                        Event::error_localized(
                            "create_track_failed",
                            foyer_i18n::loc!("Couldn't create track: %{reason}", reason = e),
                            None,
                        ),
                    )
                    .await;
                }
            }
        }
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
                            target_peer_id: None,
                            localized: None,
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
                        target_peer_id: None,
                        localized: None,
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
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        }
        Command::SetTrackMidiChannelMode {
            track_id,
            direction,
            mode,
            mask,
        } => {
            match state
                .backend()
                .await
                .set_track_midi_channel_mode(track_id, direction, mode, mask)
                .await
            {
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
                            code: "set_midi_channel_mode_failed".into(),
                            message: e.to_string(),
                            target_peer_id: None,
                            localized: None,
                        },
                    )
                    .await;
                }
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
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            } else {
                // Mirror the assignment into the track→ingress map
                // BEFORE the backend call so the auto-stamp path
                // sees it the moment a region commits. Find which
                // ingress sink owns this port_name; if none, clear
                // any prior mapping for the track. Empty port_name
                // also clears (auto-connect default — no longer
                // browser-sourced).
                {
                    let want_port = port_name.as_deref().filter(|s| !s.is_empty());
                    let mut map = state.track_ingress.lock().await;
                    if let Some(pn) = want_port {
                        let sinks = state.ingress_senders.lock().await;
                        let matched = sinks
                            .iter()
                            .find(|(_, s)| s.port_name.as_deref() == Some(pn))
                            .map(|(id, _)| *id);
                        match matched {
                            Some(sid) => {
                                map.insert(track_id.clone(), sid);
                            }
                            None => {
                                // Port belongs to something other
                                // than a browser ingress — strip
                                // any stale mapping for this
                                // track.
                                map.remove(&track_id);
                            }
                        }
                    } else {
                        map.remove(&track_id);
                    }
                }
                if let Err(e) = backend.set_track_input(track_id, port_name).await {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "set_track_input_failed".into(),
                            message: e.to_string(),
                            target_peer_id: None,
                            localized: None,
                        },
                    )
                    .await;
                }
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
                            target_peer_id: None,
                            localized: None,
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
        } => cmd_sends::add_send(state, track_id, target_track_id, pre_fader).await,
        Command::RemoveSend { send_id } => cmd_sends::remove_send(state, send_id).await,
        Command::SetSendLevel { send_id, level } => {
            cmd_sends::set_send_level(state, send_id, level).await
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
                        target_peer_id: None,
                        localized: None,
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
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        }
        Command::AddDefaultInstrument { track_id } => {
            let backend = state.backend().await;
            match backend.default_instrument_uri().await {
                Ok(Some(uri)) => {
                    tracing::info!(
                        "add_default_instrument: resolved '{uri}' for track {}",
                        track_id.as_str()
                    );
                    if let Err(e) = backend.add_plugin(track_id, uri, None, None).await {
                        broadcast_event(
                            state,
                            Event::Error {
                                code: "add_default_instrument_failed".into(),
                                message: e.to_string(),
                                target_peer_id: None,
                                localized: None,
                            },
                        )
                        .await;
                    }
                }
                Ok(None) => {
                    // Zero instruments installed (or none classify
                    // as instrument and the fuzzy match missed too).
                    // Tell the UI explicitly so it can swap the
                    // banner for an "install a synth plugin" hint
                    // instead of looking like the click did nothing.
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "no_instruments_installed".into(),
                            message: "No instrument plugins are installed. \
                                      Install at least one synth (e.g. gmsynth, \
                                      drumkv1, synthv1) and reload."
                                .into(),
                            target_peer_id: None,
                            localized: None,
                        },
                    )
                    .await;
                }
                Err(e) => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "default_instrument_resolve_failed".into(),
                            message: e.to_string(),
                            target_peer_id: None,
                            localized: None,
                        },
                    )
                    .await;
                }
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
                        Event::error_localized(
                            "audio_egress_unavailable",
                            foyer_i18n::loc!(
                                "Backend has no audio source — connect a DAW to listen."
                            ),
                            None,
                        ),
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
                            target_peer_id: None,
                            localized: None,
                        },
                    )
                    .await;
                    return Ok(());
                }
            };
            let backend_arc = state.backend().await;
            let pcm_source_rate = backend_arc.sample_rate();
            // Hand the encoder a Weak so it can poll
            // `transport_position_samples()` for frames the shim
            // hasn't tagged with sample-accurate timing. The Weak
            // dies cleanly when the backend is swapped, so a stale
            // encoder never pins an old backend.
            let backend_weak = std::sync::Arc::downgrade(&backend_arc);
            drop(backend_arc);
            // Sentinel channel: the encode loop fires
            // `Event::AudioSentinel` through this sender every few
            // seconds; a small forwarder task pumps them into the
            // main event broadcast so every client sees them.
            let (sentinel_tx, mut sentinel_rx) =
                tokio::sync::mpsc::channel::<foyer_schema::Event>(4);
            let sentinel_state = state.clone();
            tokio::spawn(async move {
                while let Some(ev) = sentinel_rx.recv().await {
                    broadcast_event(&sentinel_state, ev).await;
                }
            });
            match state
                .audio_hub
                .open_stream(
                    stream_id,
                    source.clone(),
                    format,
                    pcm_source_rate,
                    rx,
                    Some(backend_weak),
                    Some(sentinel_tx),
                )
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
                            target_peer_id: None,
                            localized: None,
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
                        target_peer_id: None,
                        localized: None,
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
            let backend = state.backend().await;
            ensure_region_fits_notes(&*backend, &region_id, std::slice::from_ref(&note)).await;
            let region_for_err = region_id.clone();
            if let Err(e) = backend.add_midi_note(region_id, note).await {
                broadcast_event(
                    state,
                    Event::error_localized(
                        "add_note_failed",
                        foyer_i18n::loc!(
                            "Couldn't add note to region %{region_id}: %{reason}",
                            region_id = region_for_err,
                            reason = e
                        ),
                        None,
                    ),
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
                        target_peer_id: None,
                        localized: None,
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
                        target_peer_id: None,
                        localized: None,
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
                        target_peer_id: None,
                        localized: None,
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
                        target_peer_id: None,
                        localized: None,
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
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        }
        Command::SetTrackMidiPatch {
            track_id,
            channel,
            bank,
            program,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .set_track_midi_patch(track_id, channel, bank, program)
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "set_track_midi_patch_failed".into(),
                        message: e.to_string(),
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        }

        Command::DuplicateRegion {
            source_region_id,
            at_samples,
            length_samples,
            target_track_id,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .duplicate_region(
                    source_region_id,
                    at_samples,
                    length_samples,
                    target_track_id,
                )
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "duplicate_region_failed".into(),
                        message: e.to_string(),
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        }
        Command::DuplicateRegionRange {
            source_region_id,
            source_offset_samples,
            length_samples,
            at_samples,
            target_track_id,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .duplicate_region_range(
                    source_region_id,
                    source_offset_samples,
                    length_samples,
                    at_samples,
                    target_track_id,
                )
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "duplicate_region_range_failed".into(),
                        message: e.to_string(),
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        }

        Command::StretchRegion {
            id,
            new_start_samples,
            new_length_samples,
            anchor,
            preserve_pitch,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .stretch_region(
                    id,
                    new_start_samples,
                    new_length_samples,
                    anchor,
                    preserve_pitch,
                )
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "stretch_region_failed".into(),
                        message: e.to_string(),
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        }

        Command::SplitRegion { id, at_samples } => {
            if let Err(e) = state.backend().await.split_region(id, at_samples).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "split_region_failed".into(),
                        message: e.to_string(),
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        }

        Command::ReverseRegion { id } => {
            if let Err(e) = state.backend().await.reverse_region(id).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "reverse_region_failed".into(),
                        message: e.to_string(),
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        }

        Command::CombineRegions { region_ids } => {
            if let Err(e) = state.backend().await.combine_regions(region_ids).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "combine_regions_failed".into(),
                        message: e.to_string(),
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        }

        Command::StripSilenceRegion {
            id,
            threshold_db,
            minimum_length_samples,
            fade_length_samples,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .strip_silence_region(
                    id,
                    threshold_db,
                    minimum_length_samples,
                    fade_length_samples,
                )
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "strip_silence_region_failed".into(),
                        message: e.to_string(),
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        }

        Command::PitchShiftRegion { id, semitones } => {
            if let Err(e) = state
                .backend()
                .await
                .pitch_shift_region(id, semitones)
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "pitch_shift_region_failed".into(),
                        message: e.to_string(),
                        target_peer_id: None,
                        localized: None,
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
            source_path,
        } => {
            if let Err(e) = state
                .backend()
                .await
                .create_region(
                    track_id,
                    at_samples,
                    length_samples,
                    kind,
                    name,
                    source_path,
                )
                .await
            {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "create_region_failed".into(),
                        message: e.to_string(),
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        }

        Command::SetSequencerLayout { region_id, layout } => {
            // Layout is the source of truth; notes are derived from it
            // by `expand_sequencer_layout`. Every connected client sees
            // the same notes because they all reconcile off the same
            // `RegionUpdated` echo from the shim.
            //
            // PPQN MUST match what Ardour uses internally
            // (`Temporal::ticks_per_beat = 1920`). Earlier code passed
            // 960 here and the shim's resize math also used 960 — both
            // wrong by a factor of 2 vs Ardour's actual tick scale, so
            // notes played at double-time and the region length came
            // out half the intended duration.
            //
            // **Idempotency + coalesce.** Earlier this handler ran the
            // full pipeline (XML persist + `replace_region_notes`) on
            // every WS frame from the editor — every cell click, every
            // velocity wheel tick, every tempo-tick auto-persist. The
            // shim's `replace_region_notes` rewrites the live MIDI
            // model via `apply_diff_command_as_commit`, which fires
            // `PropertyChange::ContentsChanged` and invalidates the
            // playback iterator mid-bar; that's why notes played hit-
            // or-miss while the sequencer view was open and only
            // settled after editing stopped. Convert-to-MIDI was
            // stable because it sets `active=false` and the regen path
            // skips itself. Now both paths skip when the layout is
            // unchanged, and both defer to a single per-region
            // debounce so a fast drag across cells produces exactly
            // one regen at the end.
            let coalescer = state.sequencer_coalescer.clone();
            let new_version = {
                let mut guard = coalescer.lock().await;
                let entry = guard.entry(region_id.clone()).or_default();
                if entry.last_rendered.as_ref() == Some(&layout) {
                    // Same layout we last shipped to the shim. Skip
                    // entirely — no XML write, no notes rewrite, no
                    // broadcast. This is the gate that catches tempo-
                    // tick auto-persists (the editor re-emits the
                    // current layout on every `transport.tempo`
                    // event) and any region_updated round-trip that
                    // bounces an unchanged blob back at us.
                    return Ok(());
                }
                entry.version = entry.version.wrapping_add(1);
                entry.version
            };

            let state_for_task = state.clone();
            let region_id_for_task = region_id;
            let layout_for_task = layout;
            tokio::spawn(async move {
                // Reset-on-arrival debounce: a follow-up edit within
                // this window bumps `version` again, and on fire we
                // bail because our captured `new_version` is no
                // longer the latest.
                tokio::time::sleep(std::time::Duration::from_millis(180)).await;
                {
                    let guard = state_for_task.sequencer_coalescer.lock().await;
                    if guard.get(&region_id_for_task).map(|s| s.version) != Some(new_version) {
                        return;
                    }
                }

                let is_active = layout_for_task.active;
                let notes = foyer_schema::expand_sequencer_layout(&layout_for_task, 1920);
                let length_ticks =
                    foyer_schema::sequencer_layout_length_ticks(&layout_for_task, 1920);
                tracing::debug!(
                    "sequencer regenerate: region={:?} active={} notes={} length_ticks={}",
                    region_id_for_task,
                    is_active,
                    notes.len(),
                    length_ticks,
                );

                let backend = state_for_task.backend().await;

                // Drum-mode auto-routing: when a layout flips to drum
                // mode (or is created in drum mode), force the track's
                // playback channel mask to ch9 (GM drum channel). This
                // is what made the test case land on piano — the
                // gmsynth track defaulted to channel 0/program 0
                // (Acoustic Grand) and per-cell `channel: 9` wasn't
                // honoured downstream. Setting `playback_channel_mode:
                // force, playback_channel_mask: 1 << 9` ensures every
                // note the expander emits is forced to GM channel 9
                // regardless of the per-row channel field.
                if is_active && layout_for_task.mode == "drum" {
                    if let Some((track_id, existing_mask)) =
                        find_region_track(&*backend, &region_id_for_task).await
                    {
                        let drum_mask: u16 = 1 << 9;
                        if existing_mask != Some(drum_mask) {
                            if let Err(e) = backend
                                .set_track_midi_channel_mode(
                                    track_id.clone(),
                                    "playback".into(),
                                    "force".into(),
                                    drum_mask,
                                )
                                .await
                            {
                                tracing::debug!(
                                    "drum auto-routing: set_track_midi_channel_mode \
                                     failed on {track_id}: {e}"
                                );
                            }
                        }
                    }
                }

                if let Err(e) = backend
                    .set_sequencer_layout(region_id_for_task.clone(), layout_for_task.clone())
                    .await
                {
                    broadcast_event(
                        &state_for_task,
                        Event::Error {
                            code: "set_sequencer_layout_failed".into(),
                            message: e.to_string(),
                            target_peer_id: None,
                            localized: None,
                        },
                    )
                    .await;
                    return;
                }
                if is_active {
                    let region_for_err = region_id_for_task.clone();
                    if let Err(e) = backend
                        .replace_region_notes(region_id_for_task.clone(), notes)
                        .await
                    {
                        broadcast_event(
                            &state_for_task,
                            Event::error_localized(
                                "replace_region_notes_failed",
                                foyer_i18n::loc!(
                                    "Couldn't replace notes on region %{region_id}: %{reason}",
                                    region_id = region_for_err,
                                    reason = e
                                ),
                                None,
                            ),
                        )
                        .await;
                        return;
                    }
                }
                // Mark the layout we just rendered as the new
                // baseline. Re-check the version under the lock —
                // if a newer arrival landed between our regen and
                // here, leave `last_rendered` alone so its task
                // doesn't get falsely idempotency-skipped.
                let mut guard = state_for_task.sequencer_coalescer.lock().await;
                if let Some(entry) = guard.get_mut(&region_id_for_task) {
                    if entry.version == new_version {
                        entry.last_rendered = Some(layout_for_task);
                    }
                }
            });
        }
        Command::ReplaceRegionNotes { region_id, notes } => {
            // Auto-extend: if any note extends past the region's current
            // length, grow the region first so the note isn't clipped.
            // Cheap WHEN we can find the owning track; silent no-op if
            // the lookup fails (we'd rather let the backend clip than
            // surface a confusing "couldn't auto-extend" error).
            let backend = state.backend().await;
            ensure_region_fits_notes(&*backend, &region_id, &notes).await;
            let region_for_err = region_id.clone();
            if let Err(e) = backend.replace_region_notes(region_id, notes).await {
                broadcast_event(
                    state,
                    Event::error_localized(
                        "replace_region_notes_failed",
                        foyer_i18n::loc!(
                            "Couldn't replace notes on region %{region_id}: %{reason}",
                            region_id = region_for_err,
                            reason = e
                        ),
                        None,
                    ),
                )
                .await;
            }
        }
        Command::ClearSequencerLayout { region_id } => {
            // Drop the coalescer entry so a future re-arm doesn't get
            // idempotency-skipped against a stale `last_rendered`. The
            // version bump matters too: any in-flight debounced regen
            // for this region will see a missing entry on fire and
            // bail (treating it as a stale capture).
            state.sequencer_coalescer.lock().await.remove(&region_id);
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
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        }

        Command::MidiInput {
            data,
            track_id,
            echo_server_mono_ns,
        } => {
            // SysEx and other long messages aren't supported through
            // the browser bridge yet — keep the wire-side enforcement
            // tight so a malicious client can't fan out a 64 KB sysex
            // dump across every connected backend on every key press.
            // Channel-voice is at most 3 bytes, real-time/SysEx-free.
            if data.is_empty() || data.len() > 3 {
                tracing::debug!("midi_input rejected: invalid length {}", data.len());
                return Ok(());
            }
            // Per-track injection requires the sending peer to be the
            // track's assigned source user (mirrors the audio ingress
            // ownership model). A peer that hasn't claimed the track
            // can still write to the shared port — strip the track_id
            // and forward — so the user gets feedback "you played
            // something" instead of a silent drop they'd debug.
            let resolved_track = match track_id {
                Some(tid) => {
                    let owner = state
                        .track_browser_sources
                        .read()
                        .await
                        .get(&tid)
                        .cloned()
                        .unwrap_or_default();
                    if owner == peer_id {
                        Some(tid)
                    } else {
                        tracing::debug!(
                            "midi_input track_id {} dropped: peer {} is not source-user (owner='{}')",
                            tid.as_str(), peer_id, owner
                        );
                        None
                    }
                }
                None => None,
            };
            // Empirical MIDI capture-latency: when both an echo
            // timestamp AND a resolved track exist, measure the full
            // browser↔server round-trip and threshold-push a
            // `SetMidiCaptureLatency` for that track when the
            // rolling median has moved past ~5 ms (240 samples at
            // 48 kHz) since the last applied value. Same gate as
            // the audio ingress path; shim's own lock keeps it
            // frozen mid-take.
            if let (Some(echo_ns), Some(tid)) = (echo_server_mono_ns, resolved_track.clone()) {
                if echo_ns > 0 {
                    let recv_mono_ns = crate::audio::monotonic_nanos();
                    let roundtrip_ns = recv_mono_ns as i64 - echo_ns;
                    if roundtrip_ns >= 0 {
                        state.midi_latency.record(&tid, roundtrip_ns);
                        if let Some(median_ms) = state.midi_latency.median_ms(&tid) {
                            let new_samples =
                                ((median_ms as f64 / 1000.0) * 48_000.0).max(0.0) as u32;
                            const APPLY_THRESHOLD_SAMPLES: i32 = 240;
                            let mut applied = state.midi_latency_last_applied.lock().await;
                            let push = match applied.get(&tid) {
                                None => true,
                                Some(prev) => {
                                    (new_samples as i32 - *prev as i32).abs()
                                        >= APPLY_THRESHOLD_SAMPLES
                                }
                            };
                            if push {
                                applied.insert(tid.clone(), new_samples);
                                drop(applied);
                                let backend = state.backend().await;
                                if let Err(e) = backend
                                    .set_midi_capture_latency(tid.clone(), new_samples)
                                    .await
                                {
                                    tracing::debug!(
                                        "midi capture-latency push failed for {}: {e}",
                                        tid.as_str()
                                    );
                                } else {
                                    tracing::debug!(
                                        "midi capture latency for {} → {new_samples} samples (median {median_ms:.1} ms)",
                                        tid.as_str()
                                    );
                                    broadcast_event(
                                        state,
                                        Event::MidiLatencyReport {
                                            track_id: tid.clone(),
                                            median_ms,
                                            samples_to_shim: new_samples,
                                        },
                                    )
                                    .await;
                                }
                            }
                        }
                    }
                }
            }
            if let Err(e) = state
                .backend()
                .await
                .send_midi_input(data, resolved_track, echo_server_mono_ns)
                .await
            {
                tracing::debug!("midi_input dropped: {e}");
            }
        }

        Command::Undo => cmd_undo::undo(state).await,
        Command::Redo => cmd_undo::redo(state).await,

        // ─── automation lane edit (Phase B) ─────────────────────────
        Command::SetAutomationMode { lane_id, mode } => {
            cmd_automation::set_mode(state, lane_id, mode).await
        }
        Command::AddAutomationPoint { lane_id, point } => {
            cmd_automation::add_point(state, lane_id, point).await
        }
        Command::UpdateAutomationPoint {
            lane_id,
            original_time_samples,
            new_time_samples,
            value,
        } => {
            cmd_automation::update_point(
                state,
                lane_id,
                original_time_samples,
                new_time_samples,
                value,
            )
            .await
        }
        Command::DeleteAutomationPoint {
            lane_id,
            time_samples,
        } => cmd_automation::delete_point(state, lane_id, time_samples).await,
        Command::ReplaceAutomationLane { lane_id, points } => {
            cmd_automation::replace_lane(state, lane_id, points).await
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
                            target_peer_id: None,
                            localized: None,
                        },
                    )
                    .await;
                }
            }
        }
        Command::ListMidiPatchNames { track_id, channel } => {
            match state
                .backend()
                .await
                .list_midi_patch_names(track_id.clone(), channel)
                .await
            {
                Ok(names) => {
                    broadcast_event(state, Event::MidiPatchNamesListed { track_id, names }).await;
                }
                Err(e) => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "list_midi_patch_names_failed".into(),
                            message: e.to_string(),
                            target_peer_id: None,
                            localized: None,
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
                        target_peer_id: None,
                        localized: None,
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
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        }

        // ─── multi-session control plane ────────────────────────────
        Command::ListSessions => {
            let sessions = state.sessions.list().await;
            broadcast_event(state, Event::SessionList { sessions }).await;
            let orphans = orphans_for_wire(state).await;
            if !orphans.is_empty() {
                broadcast_event(state, Event::OrphansDetected { orphans }).await;
            }
        }
        Command::SelectSession { session_id } => {
            // Single-focus: update the sidecar-wide focused session
            // so subsequent commands without explicit session_id route
            // to this one's backend. A per-connection override could
            // layer on later for multi-browser-window scenarios.
            let prev = state
                .focus_session_id
                .write()
                .await
                .replace(session_id.clone());
            // Mirror `state.backend` to match the new focus so plain
            // (untagged) commands route to the right backend. Without
            // this, the focus pointer says "session B" but
            // `state.backend()` still resolves to A's backend until a
            // new launch / swap touches it.
            if let Some(be) = state.sessions.backend(&session_id).await {
                state.install_active_backend(be).await;
            }
            // Audio streams opened against the prior session's
            // backend are now stale — their `pcm_rx` reads from a
            // backend the user is no longer watching. Tear them all
            // down so the client's listener gets `AudioEgressStopped`,
            // resets, and re-opens against the new focus. (Without
            // this, the listener kept playing audio from the old
            // session until the user toggled Listen off+on.)
            if prev.as_ref() != Some(&session_id) {
                let stream_ids: Vec<u32> = state
                    .audio_hub
                    .list()
                    .await
                    .into_iter()
                    .map(|(id, _, _)| id)
                    .collect();
                for stream_id in stream_ids {
                    state.audio_hub.close_stream(stream_id).await;
                    broadcast_event(state, Event::AudioEgressStopped { stream_id }).await;
                }
            }
            broadcast_event(
                state,
                Event::SessionFocusChanged {
                    session_id: Some(session_id.clone()),
                },
            )
            .await;
            // Immediately re-snapshot against the newly-focused
            // backend so the browser sees the switched-to session's
            // tracks/regions.
            if let Ok(snap) = state.backend().await.snapshot().await {
                let out = Envelope {
                    schema: SCHEMA_VERSION,
                    api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
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
                    let was_focused = {
                        let mut focus = state.focus_session_id.write().await;
                        if focus.as_ref() == Some(&session_id) {
                            *focus = None;
                            true
                        } else {
                            false
                        }
                    };
                    let mut new_focus: Option<EntityId> = None;
                    if let Some(fallback_id) = state.sessions.most_recent_id().await {
                        if let Some(be) = state.sessions.backend(&fallback_id).await {
                            state.install_active_backend(be).await;
                            *state.focus_session_id.write().await = Some(fallback_id.clone());
                            new_focus = Some(fallback_id);
                        }
                    }
                    if was_focused {
                        // Same teardown as Command::SelectSession —
                        // open audio streams were tied to the closed
                        // session's PCM rx and won't deliver more
                        // samples. Drop them so the client listener
                        // resets against the new focus (or sits silent
                        // if there's no fallback).
                        let stream_ids: Vec<u32> = state
                            .audio_hub
                            .list()
                            .await
                            .into_iter()
                            .map(|(id, _, _)| id)
                            .collect();
                        for stream_id in stream_ids {
                            state.audio_hub.close_stream(stream_id).await;
                            broadcast_event(state, Event::AudioEgressStopped { stream_id }).await;
                        }
                        broadcast_event(
                            state,
                            Event::SessionFocusChanged {
                                session_id: new_focus,
                            },
                        )
                        .await;
                    }
                }
                None => {
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "session_not_found".into(),
                            message: format!("no open session with id {session_id:?}"),
                            target_peer_id: None,
                            localized: None,
                        },
                    )
                    .await;
                }
            }
        }
        Command::ReattachOrphan { orphan_id } => {
            // Pull the orphan info out of the registry. We hold the
            // write lock just long enough to remove it; the rest of
            // the work happens with the lock dropped so a slow
            // shim handshake can't block other commands.
            let info = {
                let mut orphans = state.orphans.write().await;
                orphans
                    .iter()
                    .position(|o| o.id == orphan_id)
                    .map(|pos| orphans.remove(pos))
            };
            let Some(info) = info else {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "orphan_not_found".into(),
                        message: format!("no orphan with id {orphan_id:?}"),
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
                return Ok(());
            };

            // Need a spawner to call into — without one we can't build
            // a HostBackend (foyer-server stays adapter-agnostic). The
            // CLI provides the concrete `CliSpawner::reattach`.
            let Some(spawner) = state.spawner.clone() else {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "no_spawner".into(),
                        message: "this sidecar has no spawner; cannot reattach".into(),
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
                // Put the orphan back so the user can dismiss it.
                state.orphans.write().await.push(info);
                return Ok(());
            };
            let Some(socket_path) = info.socket.as_deref() else {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "reattach_no_socket".into(),
                        message: format!(
                            "orphan {} has no socket path on disk; can't reattach. Use Dismiss + Reopen to relaunch.",
                            info.name,
                        ),
                                            target_peer_id: None,
                                                                localized: None,
                    },
                )
                .await;
                state.orphans.write().await.push(info);
                return Ok(());
            };
            let socket = std::path::Path::new(socket_path);

            // Fast-path: if the CLI already auto-attached to this exact
            // shim socket on startup, the implicit backend in
            // `state.backend` IS this orphan — opening a second IPC
            // connection would deadlock (the shim only services one
            // client at a time, so the new connect would sit in the
            // kernel's accept queue forever and silently break event
            // flow). Adopt the existing backend by registering it in
            // the sessions map with the orphan's metadata.
            let attached = state.attached_socket.read().await.clone();
            let already_attached = attached.as_ref().is_some_and(|p| p.as_path() == socket);
            if already_attached && state.sessions.list().await.is_empty() {
                let existing = state.backend.read().await.clone();
                // Abort the legacy single-backend pump — the new
                // per-session pump that `sessions.add` spawns will
                // take over. Without this both pumps run and every
                // event fans out twice.
                if let Some(handle) = state.pump_handle.lock().await.take() {
                    handle.abort();
                }
                state
                    .sessions
                    .clone()
                    .add(
                        info.id.clone(),
                        info.backend_id.clone(),
                        existing,
                        info.path.clone(),
                        if info.name.is_empty() {
                            info.id.to_string()
                        } else {
                            info.name.clone()
                        },
                        None,
                        // Boot-time hello path: no spawner involved,
                        // so we have no idea what MCP port (if any)
                        // this Ardour was started on. Leave None;
                        // operator can re-attach via a fresh launch
                        // if they want MCP routing for this session.
                        None,
                    )
                    .await;
                *state.focus_session_id.write().await = Some(info.id.clone());
                let _ = crate::orphans::remove_entry(info.id.as_str()).await;
                let remaining = orphans_for_wire(state).await;
                broadcast_event(state, Event::OrphansDetected { orphans: remaining }).await;
                tracing::info!(
                    "reattach: adopted existing auto-attached backend at {} as session {}",
                    socket.display(),
                    info.id
                );
                return Ok(());
            }

            match spawner.reattach(&info.backend_id, socket).await {
                Ok(launched) => {
                    // Reuse the orphan's session id so the .ardour
                    // file's extra_xml UUID stays stable; the next
                    // crash + reattach round trip lands on the same
                    // identity.
                    state
                        .swap_backend(
                            info.backend_id.clone(),
                            if info.path.is_empty() {
                                None
                            } else {
                                Some(info.path.clone())
                            },
                            launched.backend,
                            Some(info.id.clone()),
                            if info.name.is_empty() {
                                None
                            } else {
                                Some(info.name.clone())
                            },
                            launched.process,
                            launched.mcp_endpoint,
                        )
                        .await;
                    // Remove the on-disk registry entry — the orphan
                    // is now an attached session, not crash debris.
                    let _ = crate::orphans::remove_entry(info.id.as_str()).await;
                    // Refresh the orphan list for clients.
                    let remaining = state.orphans.read().await.clone();
                    broadcast_event(state, Event::OrphansDetected { orphans: remaining }).await;
                }
                Err(e) => {
                    // Don't include the full socket path in the
                    // user-facing message — `/tmp/foyer/ardour-NNN.sock`
                    // is a server-side coordination detail. The full
                    // path lives in the server log if a developer
                    // needs to debug.
                    tracing::warn!(
                        "reattach to {} (socket {}) failed: {e}",
                        info.name,
                        socket.display(),
                    );
                    broadcast_event(
                        state,
                        Event::Error {
                            code: "reattach_failed".into(),
                            message: format!("reattach to {} failed: {e}", info.name,),
                            target_peer_id: None,
                            localized: None,
                        },
                    )
                    .await;
                    // Put the orphan back so the user can retry / dismiss.
                    state.orphans.write().await.push(info);
                }
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
                let remaining = orphans_for_wire(state).await;
                broadcast_event(state, Event::OrphansDetected { orphans: remaining }).await;
            }
        }

        Command::ListRecents => cmd_actions::list_recents(state).await,
        Command::ForgetRecent { path } => cmd_actions::forget_recent(state, path).await,
        Command::ClearRecents => cmd_actions::clear_recents(state).await,

        Command::CreateGroup {
            name,
            color,
            members,
        } => cmd_groups::create_group(state, name, color, members).await,
        Command::UpdateGroup { id, patch } => cmd_groups::update_group(state, id, patch).await,
        Command::DeleteGroup { id } => cmd_groups::delete_group(state, id).await,

        // ─── Tunnel / remote access ─────────────────────────────────────
        // ── Tunneling (token mint / revoke / start / stop) ────────────
        Command::TunnelCreateToken { recipient, role } => {
            cmd_tunnel::create_token(state, recipient, role).await
        }
        Command::TunnelRevokeToken { id } => cmd_tunnel::revoke_token(state, id).await,
        Command::TunnelSetEnabled { enabled } => cmd_tunnel::set_enabled(state, enabled).await,
        Command::TunnelStart { provider } => cmd_tunnel::start(state, provider).await,
        Command::TunnelStop => cmd_tunnel::stop(state).await,
        Command::TunnelRequestState => cmd_tunnel::request_state(state).await,

        // ── Chat + PTT + track-browser-source assignment ──────────────
        Command::ChatSend { body } => cmd_chat::send(state, peer_id, peer_label, body).await,
        Command::ChatClear => cmd_chat::clear(state, peer_id, peer_label, auth).await,
        Command::ChatHistoryRequest => cmd_chat::history_request(state).await,
        Command::ChatSnapshot { filename } => cmd_chat::snapshot(state, auth, filename).await,
        Command::PttStart => cmd_chat::ptt_start(state, peer_id, peer_label).await,
        Command::PttStop => cmd_chat::ptt_stop(state, peer_id).await,
        Command::SetTrackBrowserSource {
            track_id,
            peer_id: assigned_peer,
        } => cmd_chat::set_track_source(state, track_id, assigned_peer).await,
        Command::ListTrackBrowserSources => cmd_chat::list_track_sources(state).await,

        // ─── AI agent commands ───────────────────────────────────
        // ── AI agent surface (FAB + tools + skills + sessions) ───────
        // Bodies live in `cmd_agent.rs`. Two arms (UploadSkill,
        // SessionDelete) are RBAC-gated server-side so they thread
        // `auth` + `peer_id`; the rest just route fields through.
        Command::AgentSend { body, attachments } => cmd_agent::send(state, body, attachments).await,
        Command::AgentStop => cmd_agent::stop(state).await,
        Command::AgentClearHistory => cmd_agent::clear_history(state).await,
        Command::AgentSetAutonomy { autonomy } => cmd_agent::set_autonomy(state, autonomy).await,
        Command::AgentSetConfig {
            endpoint,
            model,
            api_key,
            ui_locale,
        } => cmd_agent::set_config(state, endpoint, model, api_key, ui_locale).await,
        Command::AgentConfirmTool { call_id, approve } => {
            cmd_agent::confirm_tool(state, call_id, approve).await
        }
        Command::AgentHistoryRequest => cmd_agent::history_request(state).await,
        Command::AgentListSkills => cmd_agent::list_skills(state).await,
        Command::AgentUploadSkill { name, body } => {
            cmd_agent::upload_skill(state, auth, peer_id, name, body).await
        }
        Command::AgentEnableSkill { name } => cmd_agent::set_skill_enabled(state, name, true).await,
        Command::AgentDisableSkill { name } => {
            cmd_agent::set_skill_enabled(state, name, false).await
        }
        Command::AgentListMemories => cmd_agent::list_memories(state).await,
        Command::AgentSaveMemory { name, body } => cmd_agent::save_memory(state, name, body).await,
        Command::AgentForgetMemory { name } => cmd_agent::forget_memory(state, name).await,
        Command::AgentListTemplates => cmd_agent::list_templates(state).await,
        Command::AgentRenderResult {
            request_id,
            png_b64,
            error,
        } => cmd_agent::render_result(state, request_id, png_b64, error).await,
        Command::UiActionResult {
            request_id,
            ok,
            state_json,
            error,
        } => cmd_agent::ui_action_result(state, request_id, ok, state_json, error).await,
        Command::AgentSessionList => cmd_agent::session_list(state).await,
        Command::AgentSessionNew { title } => cmd_agent::session_new(state, title).await,
        Command::AgentSessionLoad { id } => cmd_agent::session_load(state, id).await,
        Command::AgentSessionDelete { id } => {
            cmd_agent::session_delete(state, auth, peer_id, id).await
        }
        Command::AgentSessionRename { id, title } => {
            cmd_agent::session_rename(state, id, title).await
        }

        // ── Test-only: hot-swap a fresh launcher StubBackend in
        //    place of `state.backend` and respawn the legacy event
        //    pump so subsequent broadcasts flow with `session_id:
        //    None`. See `AppState::reset_to_fresh_launcher_for_test`
        //    for the full rationale.
        //
        //    Deliberately leaves the SessionRegistry intact — specs
        //    that don't go through `bootTimeline` (e.g.
        //    `scripts-panel`, `spectrum`) depend on the agent-
        //    created sessions still being reachable via the
        //    switcher. Only the "what does `state.backend()`
        //    return" anchor is reset.
        Command::TestResetState => {
            state.reset_to_fresh_launcher_for_test().await;
            tracing::info!("test_reset_state: hot-swapped a fresh launcher StubBackend");
        }

        // ── DAW scripting (shim-declared surface) ─────────────────────
        // Bodies live in `cmd_scripts.rs`; the arms route fields through.
        Command::ListScripts => cmd_scripts::list_scripts(state).await?,
        Command::SaveScript { script } => cmd_scripts::save_script(state, peer_id, script).await,
        Command::DeleteScript { id } => cmd_scripts::delete_script(state, peer_id, id).await,
        Command::EnableScript { id, enabled } => {
            cmd_scripts::enable_script(state, peer_id, id, enabled).await
        }
        Command::RunScript { id, args_override } => {
            cmd_scripts::run_script(state, peer_id, id, args_override).await
        }
        Command::RecoverDisabledScripts => {
            cmd_scripts::recover_disabled_scripts(state, peer_id).await
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
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        }

        Command::OpenPluginGui { plugin_id } => {
            // Forward to the backend. Ardour shim emits
            // `Processor::ShowUI` which gtk2_ardour's window proxy
            // catches and opens the plugin editor on whatever X
            // display the GUI Ardour binary is bound to. In container
            // deployments this is an in-container Xvfb that xpra is
            // capturing for browser projection.
            if let Err(e) = state.backend().await.show_plugin_gui(plugin_id).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "show_plugin_gui_failed".into(),
                        message: e.to_string(),
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        }

        Command::ClosePluginGui { plugin_id } => {
            if let Err(e) = state.backend().await.hide_plugin_gui(plugin_id).await {
                broadcast_event(
                    state,
                    Event::Error {
                        code: "hide_plugin_gui_failed".into(),
                        message: e.to_string(),
                        target_peer_id: None,
                        localized: None,
                    },
                )
                .await;
            }
        }

        Command::ShimQuit => {
            // Direct sidecar-side dispatch is rare (we usually invoke
            // request_quit via the registry close path), but expose it
            // to the WS so a debugging client can trigger a graceful
            // shim shutdown without going through CloseSession. The
            // backend dispatches it to the active focus.
            if let Err(e) = state.backend().await.request_quit().await {
                tracing::warn!("shim_quit forwarded but backend errored: {e}");
            }
        }
        Command::SavePluginPreset { .. }
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
                    target_peer_id: None,
                    localized: None,
                },
            )
            .await;
        }
    }
    Ok(())
}

/// Compute the suggested manual offset given a measured loopback
/// `median_ms`. The empirical capture-offset path is already setting
/// `_capture_offset` to the median of the browser↔server round-trip
/// from echo timestamps; the LOOPBACK measurement gives the TRUE
/// engine-emit to engine-record round-trip. The delta is exactly the
/// residual the user has to dial in by hand. Pulls the empirical
/// median across all active ingress streams (typically one).
pub(crate) fn suggested_offset(state: &AppState, loopback_median_ms: f32) -> i32 {
    // Find any active ingress stream's median (we typically have one).
    let empirical_ms: f32 = {
        // We don't have a direct "active stream" enumerator, so just
        // take whichever stream id has samples in the tracker. If
        // none, treat as 0.
        let g = state.ingress_senders.try_lock();
        if let Ok(g) = g {
            let mut found = 0.0_f32;
            for sid in g.keys() {
                if let Some(m) = state.ingress_latency.median_ms(*sid) {
                    found = m;
                    break;
                }
            }
            found
        } else {
            0.0
        }
    };
    (loopback_median_ms - empirical_ms).round() as i32
}

/// Wrap an event in an envelope (with fresh seq), cache to the ring, and
/// broadcast to all subscribers.
pub(crate) async fn broadcast_event(state: &AppState, event: Event) {
    let seq = state.next_seq.fetch_add(1, Ordering::Relaxed);
    let is_snapshot = matches!(event, Event::SessionSnapshot { .. });
    let env = Envelope {
        schema: SCHEMA_VERSION,
        api_version: foyer_schema::CONTROL_PLANE_API_VERSION.to_string(),
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

/// Auto-extend a region so it can hold every note in `notes`. The
/// shim's `replace_region_notes` / `add_midi_note` will silently clip
/// notes that fall past `region.length_samples`, which is a confusing
/// "I wrote 40 notes but only 30 came back" failure for the agent.
/// We convert the largest `start_ticks + length_ticks` to samples
/// using the session's tempo + ppqn, and if it exceeds the current
/// region length we `update_region { length_samples }` first.
///
/// Best-effort: if any of the lookups (track owner, current region
/// length, tempo) fail we let the backend take its normal path. The
/// backend's own clip-or-extend behaviour is then the fallback.
async fn ensure_region_fits_notes(
    backend: &dyn foyer_backend::Backend,
    region_id: &foyer_schema::EntityId,
    notes: &[foyer_schema::MidiNote],
) {
    if notes.is_empty() {
        return;
    }
    let max_end_ticks: u64 = notes
        .iter()
        .map(|n| n.start_ticks.saturating_add(n.length_ticks))
        .max()
        .unwrap_or(0);
    if max_end_ticks == 0 {
        return;
    }
    let snap = match backend.snapshot().await {
        Ok(s) => s,
        Err(_) => return,
    };
    let ppqn = snap.ppqn.unwrap_or(1920).max(1) as f64;
    let sample_rate = snap.sample_rate.max(1) as f64;
    let tempo_bpm = snap
        .transport
        .tempo
        .value
        .as_f64()
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(120.0);
    // ticks → seconds → samples.
    let seconds_per_tick = 60.0 / (tempo_bpm * ppqn);
    let needed_samples = (max_end_ticks as f64 * seconds_per_tick * sample_rate).ceil() as u64;

    // Find current region by walking the snapshot's tracks; saves a
    // tracks×list_regions roundtrip for backends that already carry
    // regions on snapshot. Fall back to list_regions if not.
    let (current_len, _track_id) = match find_region_in_snapshot(&snap, region_id) {
        Some(hit) => hit,
        None => match find_region_track(backend, region_id).await {
            Some((track_id, _)) => match backend.list_regions(track_id.clone()).await {
                Ok((_, regions)) => match regions.iter().find(|r| &r.id == region_id) {
                    Some(r) => (r.length_samples, track_id),
                    None => return,
                },
                Err(_) => return,
            },
            None => return,
        },
    };
    if needed_samples <= current_len {
        return;
    }
    // Pad by one beat at current tempo so subsequent appends have
    // headroom without us extending again. Kept modest so the user
    // doesn't see surprise "this region is huge" output.
    let beat_samples = (60.0 / tempo_bpm * sample_rate).ceil() as u64;
    let new_len = needed_samples.saturating_add(beat_samples);
    let patch = foyer_schema::RegionPatch {
        length_samples: Some(new_len),
        ..Default::default()
    };
    if let Err(e) = backend.update_region(region_id.clone(), patch).await {
        tracing::debug!(
            "ensure_region_fits_notes: update_region {region_id} → {new_len} failed: {e}"
        );
    }
}

/// Look for `region_id` among the regions implicitly carried in the
/// snapshot. Most backends don't ship regions in the snapshot
/// (`list_regions` is the canonical fetch path), so this returns
/// `None` for them and callers fall back to a list_regions scan.
fn find_region_in_snapshot(
    _snap: &foyer_schema::Session,
    _region_id: &foyer_schema::EntityId,
) -> Option<(u64, foyer_schema::EntityId)> {
    // Session.tracks doesn't currently carry per-track regions in the
    // wire schema; this helper is a forward-compat hook so when we
    // add `Track.regions` (or the agent's recent session.full
    // started including them) the fast path is one snapshot instead
    // of tracks × list_regions. Today it always returns None.
    None
}

/// Walk MIDI tracks looking for the one that owns `region_id`. Used
/// by the drum-mode auto-routing path on `SetSequencerLayout`. The
/// session snapshot doesn't carry regions, and `list_regions` is
/// per-track, so this is a tracks×ListRegions scan. Typical sessions
/// have <20 MIDI tracks so it's bounded; ran once per drum layout
/// flip (not per cell click thanks to the coalescer).
///
/// Returns `(track_id, current_playback_channel_mask)` so the caller
/// can skip the set if the mask already matches.
async fn find_region_track(
    backend: &dyn foyer_backend::Backend,
    region_id: &foyer_schema::EntityId,
) -> Option<(foyer_schema::EntityId, Option<u16>)> {
    let snap = backend.snapshot().await.ok()?;
    for t in &snap.tracks {
        if t.kind != foyer_schema::TrackKind::Midi {
            continue;
        }
        if let Ok((_, regions)) = backend.list_regions(t.id.clone()).await {
            if regions.iter().any(|r| &r.id == region_id) {
                return Some((t.id.clone(), t.playback_channel_mask));
            }
        }
    }
    None
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
