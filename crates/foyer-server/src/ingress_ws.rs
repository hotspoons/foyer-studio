//! Binary-WS handler for ingress audio.
//!
//! Clients connect to `/ws/ingress/:stream_id` after receiving an
//! `AudioIngressOpened` event. Each inbound message is raw f32-le
//! interleaved PCM payload (no header — the stream_id is in the URL).
//! The task unpacks the bytes into `PcmFrame` and forwards them to
//! the `AppState::ingress_senders[stream_id]` channel, which is fed
//! into the active backend's `open_ingress` sink.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::IntoResponse;
// futures::StreamExt not needed — we only drain recv().

use foyer_backend::PcmFrame;

use crate::AppState;

pub async fn upgrade(
    ws: WebSocketUpgrade,
    Path(stream_id): Path<u32>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle(socket, state, stream_id))
}

async fn handle(mut socket: WebSocket, state: Arc<AppState>, stream_id: u32) {
    tracing::info!("/ws/ingress/{stream_id} upgrade OK, waiting for sender registry");
    // The sender is registered by the WS command handler when
    // `AudioIngressOpen` is acknowledged. Poll briefly to tolerate
    // any handshake race.
    let mut tx = None;
    for i in 0..60 {
        if let Some(t) = state.ingress_senders.lock().await.get(&stream_id).cloned() {
            tracing::info!("/ws/ingress/{stream_id} sender bound after {} ms", i * 100);
            tx = Some(t);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let Some(tx) = tx else {
        tracing::warn!("/ws/ingress/{stream_id} no sender registered after 6 s; close");
        let _ = socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 4404,
                reason: "ingress sink not open".into(),
            })))
            .await;
        return;
    };

    // Drain inbound binary frames, convert to PcmFrame, forward.
    // Close on any non-binary message (client signalling end) or
    // channel send error (backend dropped).
    while let Some(msg) = socket.recv().await {
        match msg {
            Ok(Message::Binary(buf)) => {
                if buf.len() % 4 != 0 {
                    tracing::warn!(
                        "/ws/ingress/{stream_id} misaligned binary len={}",
                        buf.len()
                    );
                    continue;
                }
                let samples: Vec<f32> = buf
                    .chunks_exact(4)
                    .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                    .collect();
                let frame = PcmFrame { stream_id, samples };
                if tx.send(frame).await.is_err() {
                    tracing::info!("/ws/ingress/{stream_id} backend channel closed");
                    break;
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {
                // Ignore text/ping/pong; keep draining binary.
                continue;
            }
        }
    }
    let _ = socket.close().await;
}
