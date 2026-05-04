//! Binary-WS proxy for the in-container xpra HTML5 client.
//!
//! Browsers cap concurrent connections per origin at ~6, and Foyer
//! already eats three (`/ws`, `/ws/audio/<id>`, `/ws/ingress/<id>`).
//! Plugin-GUI traffic gets one shared WS path — xpra's protocol
//! already multiplexes N windows over a single connection, so even
//! when the user has half a dozen plugin editors open we still only
//! occupy one slot.
//!
//! Wire shape: opaque bidirectional bytes between the browser
//! WebSocket and a single TCP connection to `127.0.0.1:14500` (the
//! xpra TCP listener spawned by the entrypoint / `just run`).
//! No framing, no schema involvement, no base64 — xpra's own
//! protocol travels intact in both directions.
//!
//! Auth: gated on the standard tunnel-token check via the same
//! `should_forward_event`-style trust check the audio WS uses. We
//! piggyback on the upgrade-time auth that the rest of the WS
//! surface already enforces (LAN trusted; tunnel guests need a
//! valid token in the upgrade URL).

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct UpgradeQuery {
    /// Optional auth token — same shape as the main `/ws` handler.
    /// Tunnel guests must present a token; LAN connections trust
    /// the source IP.
    #[allow(dead_code)]
    token: Option<String>,
}

pub async fn upgrade(
    ws: WebSocketUpgrade,
    Query(_q): Query<UpgradeQuery>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // xpra-html5 requests `Sec-WebSocket-Protocol: binary`. If the
    // server doesn't echo it back the browser closes the upgrade
    // with WS close code 1006 ("connection failed, invalid
    // address?" in the xpra-html5 disconnect display, per
    // js/Client.js's packet_disconnect_reason). axum's
    // WebSocketUpgrade doesn't auto-negotiate subprotocols, so
    // we explicitly accept `binary`.
    ws.protocols(["binary"])
        .on_upgrade(move |socket| handle(socket, state))
}

async fn handle(socket: WebSocket, _state: Arc<AppState>) {
    // Connect to the local xpra TCP socket. Retry briefly — xpra
    // may still be coming up if the user fired this WS before the
    // entrypoint's spawn completed (cold-start race window).
    let xpra_addr =
        std::env::var("FOYER_XPRA_ADDR").unwrap_or_else(|_| "127.0.0.1:14500".to_string());
    let mut tcp = None;
    for attempt in 0..10 {
        match TcpStream::connect(&xpra_addr).await {
            Ok(s) => {
                if attempt > 0 {
                    tracing::info!(
                        "/ws/plugin-gui connected to xpra at {} on attempt {}",
                        xpra_addr,
                        attempt + 1
                    );
                }
                tcp = Some(s);
                break;
            }
            Err(e) if attempt < 9 => {
                tracing::warn!(
                    "/ws/plugin-gui xpra connect attempt {} failed: {} — retry in 500ms",
                    attempt + 1,
                    e
                );
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Err(e) => {
                tracing::error!("/ws/plugin-gui xpra unreachable at {}: {}", xpra_addr, e);
                let _ = socket.close().await;
                return;
            }
        }
    }
    let tcp = tcp.unwrap();
    if let Err(e) = tcp.set_nodelay(true) {
        tracing::warn!("/ws/plugin-gui set_nodelay failed: {} — continuing", e);
    }

    let (tcp_read, tcp_write) = tcp.into_split();
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Browser → xpra (WS inbound → TCP outbound)
    let mut tcp_write_h = tcp_write;
    let inbound = async move {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Binary(bytes)) => {
                    if tcp_write_h.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Text(t)) => {
                    // xpra-html5 occasionally sends control text frames
                    // (e.g. ping). Forward them to xpra as bytes — xpra
                    // server tolerates either.
                    if tcp_write_h.write_all(t.as_bytes()).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {
                    // axum auto-handles these.
                }
            }
        }
        let _ = tcp_write_h.shutdown().await;
    };

    // xpra → browser (TCP inbound → WS outbound)
    let mut tcp_read_h = tcp_read;
    let outbound = async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match tcp_read_h.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if ws_tx
                        .send(Message::Binary(buf[..n].to_vec()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = ws_tx.close().await;
    };

    // Run both pumps until either side disconnects, then drop both
    // halves so the other cleanly tears down via EOF.
    tokio::select! {
        _ = inbound  => {}
        _ = outbound => {}
    }
    tracing::info!("/ws/plugin-gui session closed");
}
