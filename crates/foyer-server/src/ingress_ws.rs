//! Binary-WS handler for ingress audio.
//!
//! Clients connect to `/ws/ingress/:stream_id` after receiving an
//! `AudioIngressOpened` event. Each inbound message has an 8-byte
//! header followed by f32-le interleaved PCM:
//!
//! ```text
//!   ┌──────────────────────┬──────────────────────────────┐
//!   │ i64 little-endian    │ Float32 LE interleaved PCM   │
//!   │ echo_server_mono_ns  │ (one or more frames)         │
//!   │ (or -1 if unknown)   │                              │
//!   └──────────────────────┴──────────────────────────────┘
//! ```
//!
//! The header carries the source-side `CLOCK_MONOTONIC` timestamp
//! corresponding to the audio coming out of the user's speakers when
//! this sample was captured (the browser stamps with the most-recent
//! egress sentinel's `serverMonoNs`, shifted back by `playbackDelayMs`
//! to account for the Web Audio playback queue). The server reads
//! its own monotonic clock on receipt and computes the FULL round-
//! trip directly — `recv_mono_ns - echo_server_mono_ns`. No clock-
//! offset reconciliation is needed because both values come from the
//! same monotonic clock (same host).
//!
//! The same handler then dispatches `SetIngressCaptureLatency
//! { samples }` to the shim whenever the rolling median moves
//! past a small apply-threshold; the shim adds its own internal
//! contribution (ring prime + engine cycle, knowable only locally)
//! before writing the value to `Port::set_private_latency_range`,
//! which Ardour then propagates to `DiskWriter::_capture_offset`.
//! Lock-in (freeze the value while transport is recording) is also
//! shim-side because that's where `RecordStateChanged` is visible.
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

    // Test-only ingress latency injection. Consulted on every
    // packet from the AppState atomic so toggling via
    // `Command::SetFakeLatency` takes effect without reconnecting.
    // `0` short-circuits.

    // Engine sample rate captured once per stream; used to convert
    // the per-packet round-trip into samples for the shim. Falls
    // back to the schema default if the snapshot isn't ready yet
    // — converges within ~hundreds of ms regardless.
    let engine_sample_rate: u32 = sink.engine_sample_rate;

    // Throttle SetIngressCaptureLatency: only re-emit when the
    // current median is > THRESHOLD_SAMPLES different from the
    // value last applied. Avoids hammering the shim (and Ardour's
    // `latency_callback`, which kicks the entire signal-latency
    // recompute) with sub-millisecond shifts that are within
    // measurement noise.
    const APPLY_THRESHOLD_SAMPLES: i32 = 240; // 5 ms at 48 kHz
    let mut last_applied_samples: Option<u32> = None;

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
                // `echo_ns` is the source-clock timestamp of the
                // audio coming out of the user's speakers when this
                // PCM chunk was captured (browser-stamped from the
                // most-recent egress sentinel, shifted back by
                // `playbackDelayMs`). Negative or zero means "no
                // echo yet" — record-armed before any playback
                // sentinels have flowed back; we skip the sample
                // and let the additive fallback take over.
                let echo_ns = i64::from_le_bytes(hdr);
                if echo_ns > 0 {
                    let roundtrip_ns = recv_mono_ns as i64 - echo_ns;
                    if roundtrip_ns >= 0 {
                        latency_tracker.record(stream_id, roundtrip_ns);
                        // Re-evaluate whether we need to push a new
                        // SetIngressCaptureLatency. Median requires
                        // 8 samples before returning Some, so the
                        // first push lags the stream open by ~160 ms
                        // (8 packets at 20 ms each). After that it
                        // updates whenever the median shifts past
                        // the apply threshold.
                        if let Some(median_ms) = latency_tracker.median_ms(stream_id) {
                            // Stack the user's manual offset on top of
                            // the empirical median. Positive offset
                            // lengthens `_capture_offset` (shifts the
                            // recording earlier on the timeline) — the
                            // intended way to dial in any residual the
                            // echo-roundtrip math can't observe.
                            let manual_offset_ms = state
                                .ingress_manual_offset_ms
                                .load(std::sync::atomic::Ordering::Relaxed);
                            let effective_ms = (median_ms as f64) + manual_offset_ms as f64;
                            let new_samples = ((effective_ms / 1000.0)
                                * engine_sample_rate as f64)
                                .max(0.0) as u32;
                            let push = match last_applied_samples {
                                None => true,
                                Some(prev) => (new_samples as i32 - prev as i32).abs()
                                    >= APPLY_THRESHOLD_SAMPLES,
                            };
                            if push {
                                last_applied_samples = Some(new_samples);
                                let backend = state.backend().await;
                                if let Err(e) = backend
                                    .set_ingress_capture_latency(stream_id, new_samples)
                                    .await
                                {
                                    tracing::debug!(
                                        "/ws/ingress/{stream_id} empirical capture-latency push failed: {e}"
                                    );
                                } else {
                                    tracing::debug!(
                                        "/ws/ingress/{stream_id} empirical capture latency → {new_samples} samples (median {median_ms:.1} ms)"
                                    );
                                }
                                // Surface the new median to the UI
                                // even between explicit RequestIngressLatency
                                // polls, so the Timing tab updates live
                                // as the value converges and shifts.
                                crate::ws::broadcast_event(
                                    &state,
                                    foyer_schema::Event::IngressLatencyReport {
                                        stream_id,
                                        median_ms: Some(median_ms),
                                    },
                                )
                                .await;
                            }
                        }
                    }
                }

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
                let inject_ms = state
                    .fake_ingress_latency_ms
                    .load(std::sync::atomic::Ordering::Relaxed);
                if inject_ms > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(inject_ms as u64)).await;
                }
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
        // The number on the wire now is full round-trip
        // (browser-stamped echo → server recv) — capture-offset is
        // applied in the shim from the same value, so this is purely
        // a diagnostics line confirming the empirical measurement
        // converged.
        tracing::info!(
            "/ws/ingress/{stream_id} closed; median round-trip latency = {median_ms:.1} ms"
        );
    }
    latency_tracker.drop_stream(stream_id);
    let _ = socket.close().await;
}
