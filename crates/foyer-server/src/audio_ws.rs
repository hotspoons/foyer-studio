//! Binary-WS handler for egress audio.
//!
//! Clients connect to `/ws/audio/:stream_id` after receiving an
//! `AudioStreamOpened` event. Each outbound message is a single
//! packet in the wire format defined at the top of `audio.rs`:
//!
//!   u32 be  stream_id
//!   u64 be  capture timestamp (microseconds since Unix epoch)
//!   bytes   payload (opus or raw f32 LE, per the stream's codec)
//!
//! We don't read inbound messages — the control plane stays on
//! `/ws`. If the client wants to stop the stream it sends
//! `Command::AudioStreamClose` over the control WS.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::IntoResponse;
use futures::{SinkExt, StreamExt};
use tokio::sync::broadcast::error::RecvError;

use crate::audio::pack_wire;
use crate::AppState;

pub async fn upgrade(
    ws: WebSocketUpgrade,
    Path(stream_id): Path<u32>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle(socket, state, stream_id))
}

async fn handle(socket: WebSocket, state: Arc<AppState>, stream_id: u32) {
    let Some(mut rx) = state.audio_hub.subscribe(stream_id).await else {
        tracing::warn!("/ws/audio/{stream_id} requested but hub has no such stream");
        // Let the socket close with a polite code.
        let _ = socket
            .close_with(axum::extract::ws::CloseFrame {
                code: 4404,
                reason: "stream not open".into(),
            })
            .await;
        return;
    };

    let (mut sink, _reader) = socket.split();
    loop {
        match rx.recv().await {
            Ok(pkt) => {
                let bytes = pack_wire(&pkt);
                if sink.send(Message::Binary(bytes)).await.is_err() {
                    break;
                }
            }
            Err(RecvError::Lagged(n)) => {
                tracing::debug!("/ws/audio/{stream_id} lagged by {n}; resync expected");
                // Lagging means the client is falling behind the
                // broadcast's ring. Drop the burst, keep going — the
                // jitter buffer on the browser side decides whether
                // to flush or interpolate.
                continue;
            }
            Err(RecvError::Closed) => {
                // Encode loop exited (stream closed).
                break;
            }
        }
    }
    let _ = sink.close().await;
}

// Helper trait so we can call `.close_with(...)` on the split sink in
// the "stream not open" path above. Axum's WebSocket split yields a
// SplitSink that has a `.send(Message::Close(..))` — we wrap that into
// a friendlier API mirroring tungstenite's `close_with`.
trait CloseWith {
    fn close_with(
        self,
        frame: axum::extract::ws::CloseFrame<'static>,
    ) -> impl std::future::Future<Output = Result<(), axum::Error>> + Send;
}

impl CloseWith for WebSocket {
    async fn close_with(
        mut self,
        frame: axum::extract::ws::CloseFrame<'static>,
    ) -> Result<(), axum::Error> {
        self.send(Message::Close(Some(frame))).await
    }
}
