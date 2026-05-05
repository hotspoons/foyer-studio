//! Binary-WS handler for ingress audio.
//!
//! Clients connect to `/ws/ingress/:stream_id` after receiving an
//! `AudioIngressOpened` event. Each inbound message is raw f32-le
//! interleaved PCM payload (no header — the stream_id is in the URL).
//! When the browser capture rate differs from the session engine rate,
//! this task resamples to the engine rate before forwarding PCM into the
//! backend's ingress sink ([`crate::IngressSink`]).

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::IntoResponse;

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
    tracing::info!("/ws/ingress/{stream_id} upgrade OK, waiting for sink registry");
    let mut sink_reg = None;
    for i in 0..60 {
        if let Some(t) = state.ingress_senders.lock().await.get(&stream_id).cloned() {
            tracing::info!("/ws/ingress/{stream_id} sink bound after {} ms", i * 100);
            sink_reg = Some(t);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let Some(sink) = sink_reg else {
        tracing::warn!("/ws/ingress/{stream_id} no sink registered after 6 s; close");
        let _ = socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 4404,
                reason: "ingress sink not open".into(),
            })))
            .await;
        return;
    };

    let mut resampler = if sink.client_sample_rate != sink.engine_sample_rate && sink.channels > 0 {
        match foyer_audio::InterleavedResampler::new(
            sink.client_sample_rate,
            sink.engine_sample_rate,
            sink.channels,
        ) {
            Ok(r) => Some(r),
            Err(e) => {
                tracing::warn!(
                    "/ws/ingress/{stream_id}: resampler disabled ({e}); forwarding PCM as-is"
                );
                None
            }
        }
    } else {
        None
    };

    let tx = sink.tx;
    let ch = usize::from(sink.channels);

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
                if ch > 0 && samples.len() % ch != 0 {
                    tracing::warn!(
                        "/ws/ingress/{stream_id} sample count {} not divisible by channels {}",
                        samples.len(),
                        ch
                    );
                    continue;
                }
                let chunk = if let Some(ref mut r) = resampler {
                    match r.push(&samples) {
                        Ok(v) => v,
                        Err(e) => {
                            tracing::warn!("/ws/ingress/{stream_id} resample: {e}");
                            continue;
                        }
                    }
                } else {
                    samples
                };
                if chunk.is_empty() {
                    continue;
                }
                let frame = PcmFrame {
                    stream_id,
                    samples: chunk,
                };
                if tx.send(frame).await.is_err() {
                    tracing::info!("/ws/ingress/{stream_id} backend channel closed");
                    break;
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => continue,
        }
    }
    let _ = socket.close().await;
}
