// SPDX-License-Identifier: Apache-2.0
//! Agent Client Protocol bridge for Foyer Studio.
//!
//! Serves the in-process [`foyer_agent::AgentRuntime`] to external
//! **ACP clients** — Zed, JetBrains, any agent UI — over protocol
//! **v1** (stable) and **v2** (draft), picked per-connection at
//! `initialize` by the SDK's [`AgentProtocolRouter`]. The mirror
//! image of [`foyer-mcp`]: MCP hands Foyer's *tools* to external
//! agents; ACP hands Foyer's *agent* to external clients.
//!
//! Same containment rule as the MCP bridge: all protocol ceremony
//! lives here, `foyer-agent` carries zero ACP types. The runtime's
//! own primitives line up 1:1 —
//!
//! * `session/prompt` → [`AgentRuntime::send_user_message`] (which
//!   resolves when the turn ends),
//! * `session/update` ← the runtime's broadcast [`AgentEvent`]s,
//! * `session/request_permission` ← the autonomy gate's
//!   `AwaitingConfirm` + [`AgentRuntime::confirm_tool`],
//! * `session/cancel` → [`AgentRuntime::stop_current_turn`].
//!
//! Transport: [`ws_router`] mounts an ACP-over-WebSocket endpoint
//! (one JSON-RPC message per text frame) into foyer-server's axum
//! app at `/acp/ws`. Editors that only spawn stdio subprocesses use
//! the `foyer acp` relay, which pipes stdio lines onto that socket
//! without parsing them. See [docs/ACP.md].
//!
//! [`foyer-mcp`]: ../foyer_mcp/index.html
//! [docs/ACP.md]: https://github.com/hotspoons/foyer-studio/blob/main/docs/ACP.md
//! [`AgentRuntime`]: foyer_agent::AgentRuntime
//! [`AgentRuntime::send_user_message`]: foyer_agent::AgentRuntime::send_user_message
//! [`AgentRuntime::confirm_tool`]: foyer_agent::AgentRuntime::confirm_tool
//! [`AgentRuntime::stop_current_turn`]: foyer_agent::AgentRuntime::stop_current_turn
//! [`AgentEvent`]: foyer_agent::AgentEvent
//! [`AgentProtocolRouter`]: agent_client_protocol::AgentProtocolRouter

#![forbid(unsafe_code)]

mod common;
mod v1;
mod v2;

use std::sync::Arc;

use agent_client_protocol::{self as acp, ConnectTo as _};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use foyer_agent::AgentRuntime;
use futures::{SinkExt, StreamExt};

/// Shared bridge state — one per server, cloned per connection.
#[derive(Clone)]
pub struct FoyerAcpServer {
    runtime: Arc<AgentRuntime>,
}

impl FoyerAcpServer {
    pub fn new(runtime: Arc<AgentRuntime>) -> Self {
        Self { runtime }
    }

    /// One connection's worth of agent: the version router with a
    /// fresh v1 chain and a fresh v2 chain behind it. The router
    /// reads the client's `initialize`, hands the connection to the
    /// matching chain, and rejects versions we don't speak.
    pub fn connector(&self) -> impl acp::ConnectTo<acp::Client> {
        acp::Agent
            .protocol_router()
            .with_v1(v1::chain(self.runtime.clone()))
            .with_v2(v2::chain(self.runtime.clone()))
    }

    /// Serve one ACP connection over any SDK transport. The future
    /// resolves when the peer disconnects.
    pub async fn serve_transport(
        &self,
        transport: impl acp::ConnectTo<acp::Agent>,
    ) -> Result<(), acp::Error> {
        self.connector().connect_to(transport).await
    }

    async fn serve_socket(self, socket: WebSocket) {
        let (sink, stream) = socket.split();
        // One JSON-RPC message per WS text frame ↔ one line on the
        // SDK's line transport. Binary frames are tolerated (some WS
        // clients send text as binary); everything else is dropped —
        // axum answers pings on its own.
        let outgoing = sink
            .sink_map_err(std::io::Error::other)
            .with(|line: String| async move { Ok::<Message, std::io::Error>(Message::Text(line)) });
        let incoming = stream.filter_map(|msg| async move {
            match msg {
                Ok(Message::Text(s)) => Some(Ok(s)),
                Ok(Message::Binary(b)) => Some(Ok(String::from_utf8_lossy(&b).into_owned())),
                Ok(_) => None,
                Err(e) => Some(Err(std::io::Error::other(e))),
            }
        });
        let transport = acp::Lines::new(Box::pin(outgoing), Box::pin(incoming));
        if let Err(e) = self.serve_transport(transport).await {
            // Peer hangups arrive as transport errors — routine.
            tracing::debug!("acp: connection ended: {e}");
        }
    }
}

/// Axum router exposing the ACP WebSocket endpoint at `/ws`
/// (mounted by foyer-server under `/acp`). Carries its own state,
/// so nest it before the main router's `with_state` — same dance as
/// `foyer_mcp::mcp_router`.
pub fn ws_router(server: FoyerAcpServer) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .with_state(server)
}

async fn ws_handler(
    State(server): State<FoyerAcpServer>,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| server.serve_socket(socket))
}
