//! Binary-WS handler for ingress audio.
//!
//! Clients connect to `/ws/ingress/:stream_id` after receiving an
//! `AudioIngressOpened` event. Each inbound message has an 8-byte
//! header followed by f32-le interleaved PCM:
//!
//! ```text
//!   ┌──────────────────────┬──────────────────────────────┐
//!   │ f64 little-endian    │ Float32 LE interleaved PCM   │
//!   │ client_send_ms       │ (one or more frames)         │
//!   │ (performance.now())  │                              │
//!   └──────────────────────┴──────────────────────────────┘
//! ```
//!
//! The header carries the client's monotonic timestamp at
//! `postMessage` time. The server records its own monotonic clock on
//! receipt and computes one-way latency as
//! `recv_mono_ns - (client_send_ms*1e6 - clock_offset_ns)`, where
//! `clock_offset_ns` comes from the most-recent `Command::ClockProbe`
//! exchange. The median of those samples is what
//! `Region.ingress_latency_ms` is stamped with at recording-finalize
//! time so the browser-recorded take auto-aligns with the rest of
//! the timeline (browser ingress → DAW transport latency is the
//! dominant cause of recorded clips landing too late).
//!
//! When the browser capture rate differs from the session engine
//! rate, this task resamples to the engine rate before forwarding
//! PCM into the backend's ingress sink ([`crate::IngressSink`]).

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

    const HEADER_BYTES: usize = 8;
    let latency_tracker = state.ingress_latency.clone();

    while let Some(msg) = socket.recv().await {
        match msg {
            Ok(Message::Binary(buf)) => {
                let recv_mono_ns = crate::audio::monotonic_nanos();
                if buf.len() < HEADER_BYTES + 4 || (buf.len() - HEADER_BYTES) % 4 != 0 {
                    tracing::warn!(
                        "/ws/ingress/{stream_id} misaligned binary len={}",
                        buf.len()
                    );
                    continue;
                }
                let mut hdr = [0u8; 8];
                hdr.copy_from_slice(&buf[..HEADER_BYTES]);
                let client_send_ms = f64::from_le_bytes(hdr);
                // Convert client_send_ms onto the server's monotonic
                // timeline by subtracting the offset estimated by
                // the clock-probe handshake. If the offset hasn't
                // been seeded yet (no probe round-trip done) the
                // computation still runs but the latency will be
                // dominated by the offset error — the median tracker
                // is robust against that as long as the probe
                // arrives in the next second or two.
                let offset_ns = state
                    .clock_offset_ns
                    .load(std::sync::atomic::Ordering::Relaxed);
                let send_mono_ns = (client_send_ms * 1_000_000.0) as i64 - offset_ns;
                let latency_ns = recv_mono_ns as i64 - send_mono_ns;
                latency_tracker.record(stream_id, latency_ns);

                let pcm_bytes = &buf[HEADER_BYTES..];
                let samples: Vec<f32> = pcm_bytes
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
                let frame = PcmFrame::untimed(stream_id, chunk);
                if tx.send(frame).await.is_err() {
                    tracing::info!("/ws/ingress/{stream_id} backend channel closed");
                    break;
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => continue,
        }
    }
    if let Some(median_ms) = latency_tracker.median_ms(stream_id) {
        // Surface the observed transport latency on close. Real
        // takes will consume this via the recording-finalize path
        // once that's wired (the value lands in
        // `Region.ingress_latency_ms` so the timeline can shift the
        // recorded clip into temporal alignment); for now logging
        // it makes the calibration measurable.
        tracing::info!(
            "/ws/ingress/{stream_id} closed; median one-way ingress latency = {median_ms:.1} ms"
        );
    }
    latency_tracker.drop_stream(stream_id);
    let _ = socket.close().await;
}
