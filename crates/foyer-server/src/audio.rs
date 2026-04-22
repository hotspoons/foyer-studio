//! M6a audio egress — sidecar-side Opus encoder + stream hub.
//!
//! End-to-end picture for DAW → browser audio forwarding:
//!
//! ```text
//! Ardour RT thread ──► shim tap (Route::output()) ──► IPC audio frames
//!                                                          │
//!                                                          ▼
//!                                          ┌─────────────────────────┐
//!                                          │ sidecar HostBackend     │
//!                                          │  reads PcmFrame stream  │
//!                                          └─────────┬───────────────┘
//!                                                    │ f32 interleaved
//!                                                    ▼
//!                                          ┌─────────────────────────┐
//!                                          │ AudioHub::encode_loop   │
//!                                          │  · rubato resample      │
//!                                          │  · audiopus encode      │
//!                                          └─────────┬───────────────┘
//!                                                    │ opus packets
//!                                                    ▼
//!                                          /ws/audio/:stream_id (binary)
//!                                                    │
//!                                                    ▼
//!                                     Browser: AudioDecoder → AudioWorklet
//! ```
//!
//! This module wires the **sidecar half** end-to-end. The shim tap is
//! a separate C++ task (see the HANDOFF doc) — until it lands, the
//! hub is ready to accept PCM from any `tokio::sync::mpsc::Receiver`
//! source: a test-tone generator, a file-backed stub, or the real
//! `HostBackend::open_egress` stream.
//!
//! The wire framing on `/ws/audio/:stream_id` is:
//!   ┌────────────────┬────────────────────┬─────────────────┐
//!   │ u32 big-endian │ u64 big-endian     │ opus payload    │
//!   │ stream_id      │ capture timestamp  │ (variable size) │
//!   │                │ (microseconds)     │                 │
//!   └────────────────┴────────────────────┴─────────────────┘
//!
//! Browser side reads `stream_id`, feeds `timestamp` to WebCodecs
//! (`EncodedAudioChunk.timestamp`), decodes via `AudioDecoder`, pumps
//! into an `AudioWorklet` for playback.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use foyer_schema::{AudioCodec, AudioFormat, AudioSource};
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio::task::JoinHandle;

use crate::audio_opus::{encoded_chunk_frame_size, OpusFrameEncoder};

/// One Opus-encoded packet, ready to send to WS subscribers.
#[derive(Debug, Clone)]
pub struct EncodedPacket {
    pub stream_id: u32,
    /// Wall-clock timestamp at capture, microseconds since Unix epoch.
    /// Browser uses this to line up decoded frames against its own
    /// media clock — drift is dealt with by the AudioWorklet's jitter
    /// buffer, not here.
    pub timestamp_us: u64,
    pub opus: Vec<u8>,
}

/// Per-stream metadata + the broadcast channel subscribers attach to.
#[allow(dead_code)] // source/format are surfaced via AudioHub::list()
pub struct StreamState {
    pub source: AudioSource,
    pub format: AudioFormat,
    pub packets: broadcast::Sender<EncodedPacket>,
    /// Encode task — dropping the hub handle drops this, which
    /// triggers the mpsc close + encode_loop exit.
    encode_task: JoinHandle<()>,
}

/// Sidecar-owned registry of live egress streams. One `AudioHub` per
/// `AppState`; open/close cycles are keyed by the client-assigned
/// `stream_id` (consistent with the existing `AudioEgressStart` /
/// `AudioEgressStop` commands).
pub struct AudioHub {
    streams: Mutex<HashMap<u32, Arc<StreamState>>>,
    /// Size of each stream's fan-out ring. 256 packets × 20 ms = 5 s
    /// of back-pressure tolerance before the laggiest subscriber
    /// starts seeing `Lagged` errors and has to resynchronize.
    broadcast_depth: usize,
}

impl AudioHub {
    pub fn new() -> Self {
        Self {
            streams: Mutex::new(HashMap::new()),
            broadcast_depth: 256,
        }
    }

    /// Register a new egress stream. `pcm_rx` is where encoded-upstream
    /// PCM frames (interleaved f32) land — in production this is the
    /// receiver returned by `HostBackend::open_egress`. Returns the
    /// broadcast sender so WS handlers can `.subscribe()` to it.
    ///
    /// Subsequent calls with the same `stream_id` close the prior
    /// stream first (stream IDs are client-assigned and we want idempotency).
    pub async fn open_stream(
        &self,
        stream_id: u32,
        source: AudioSource,
        format: AudioFormat,
        mut pcm_rx: mpsc::Receiver<foyer_backend::PcmFrame>,
    ) -> Result<broadcast::Sender<EncodedPacket>, String> {
        let mut streams = self.streams.lock().await;
        if streams.contains_key(&stream_id) {
            // Caller restart — drop old state before opening new one.
            let _ = streams.remove(&stream_id);
        }

        // 20 ms frame at the client's requested rate. audiopus requires
        // one of the canonical Opus frame sizes (2.5, 5, 10, 20, 40,
        // or 60 ms). 20 ms is the sweet spot for interactive latency
        // without doubling the encode CPU cost. For RawF32Le we still
        // batch on 20 ms boundaries so the browser's jitter buffer
        // can stay identical across codec choices.
        let frame_size = match format.codec {
            AudioCodec::Opus => encoded_chunk_frame_size(format.sample_rate, 20)
                .ok_or_else(|| format!("unsupported sample rate {} for opus", format.sample_rate))?,
            AudioCodec::RawF32Le => ((format.sample_rate as usize) * 20) / 1000,
        };

        let mut encoder = match format.codec {
            AudioCodec::Opus => Some(
                OpusFrameEncoder::new(format.sample_rate, format.channels, frame_size)
                    .map_err(|e| format!("opus encoder init: {e}"))?,
            ),
            AudioCodec::RawF32Le => None,
        };

        let (tx, _) = broadcast::channel(self.broadcast_depth);
        let tx_for_task = tx.clone();
        let codec = format.codec;

        // Encode loop: batch incoming PCM into `frame_size`-sample
        // chunks, encode (or repack verbatim for RawF32Le), broadcast.
        // When `pcm_rx` closes (source gone) the task exits and the
        // broadcast's receivers see `RecvError::Closed` and tidy up.
        let encode_task = tokio::spawn(async move {
            let channels = format.channels as usize;
            let samples_per_frame = frame_size * channels;
            let mut pending: Vec<f32> = Vec::with_capacity(samples_per_frame * 2);
            let mut chunks_seen: u64 = 0;
            while let Some(frame) = pcm_rx.recv().await {
                pending.extend_from_slice(&frame.samples);
                while pending.len() >= samples_per_frame {
                    let chunk: Vec<f32> = pending.drain(..samples_per_frame).collect();
                    // Source-side diagnostic: peak + zero-crossings on
                    // channel 0 of the pre-encode buffer. Tells us
                    // what the SHIM is actually handing the server.
                    // Rich observed octave-down output on BOTH
                    // Opus and raw_f32_le codec paths, which rules
                    // out encoder/decoder faults — whatever is
                    // mangling the signal is upstream of here. This
                    // log nails down "is the shim sending 440 Hz
                    // at 0.4 and something downstream is halving,
                    // or is the shim already sending 220 Hz at
                    // 0.2?".  Once confirmed, remove.
                    chunks_seen += 1;
                    if chunks_seen == 1 || chunks_seen % 100 == 0 {
                        let mut peak: f32 = 0.0;
                        let mut zero_xings: u32 = 0;
                        let mut prev = chunk[0];
                        for i in (channels..chunk.len()).step_by(channels) {
                            let v = chunk[i];
                            let a = v.abs();
                            if a > peak {
                                peak = a;
                            }
                            if (prev >= 0.0 && v < 0.0) || (prev < 0.0 && v >= 0.0) {
                                zero_xings += 1;
                            }
                            prev = v;
                        }
                        tracing::debug!(
                            "audio hub stream {stream_id} chunk #{chunks_seen} pre-encode ch0 \
                             peak={peak:.4} zeroXings={zero_xings} \
                             (expect 18 for 440 Hz / 9 for 220 Hz per 960-sample frame)"
                        );
                    }
                    let payload = match codec {
                        AudioCodec::Opus => match encoder.as_mut().unwrap().encode(&chunk) {
                            Ok(b) => b,
                            Err(e) => {
                                tracing::warn!("opus encode failed on stream {stream_id}: {e}");
                                continue;
                            }
                        },
                        AudioCodec::RawF32Le => {
                            // f32 interleaved → bytes. Browser side decodes
                            // with `new Float32Array(buffer, 12)` after
                            // reading the 12-byte header.
                            let mut buf = Vec::with_capacity(chunk.len() * 4);
                            for s in &chunk {
                                buf.extend_from_slice(&s.to_le_bytes());
                            }
                            buf
                        }
                    };
                    let pkt = EncodedPacket {
                        stream_id,
                        timestamp_us: epoch_micros(),
                        opus: payload,
                    };
                    let _ = tx_for_task.send(pkt);
                }
            }
            tracing::debug!("audio hub: encode loop for stream {stream_id} exited");
        });

        streams.insert(
            stream_id,
            Arc::new(StreamState {
                source,
                format,
                packets: tx.clone(),
                encode_task,
            }),
        );
        Ok(tx)
    }

    /// Close a stream. Cancels the encode task; WS subscribers get
    /// `Closed` on their broadcast receiver.
    pub async fn close_stream(&self, stream_id: u32) {
        let mut streams = self.streams.lock().await;
        if let Some(s) = streams.remove(&stream_id) {
            s.encode_task.abort();
        }
    }

    /// Subscribe to the broadcast stream for an open egress. Returns
    /// `None` if the stream hasn't been opened.
    pub async fn subscribe(&self, stream_id: u32) -> Option<broadcast::Receiver<EncodedPacket>> {
        let streams = self.streams.lock().await;
        streams.get(&stream_id).map(|s| s.packets.subscribe())
    }

    /// Snapshot of currently-open streams. Useful for the
    /// `/dev/list-audio-streams` debug endpoint + for reconciliation
    /// after a backend swap.
    #[allow(dead_code)]
    pub async fn list(&self) -> Vec<(u32, AudioSource, AudioFormat)> {
        let streams = self.streams.lock().await;
        streams
            .iter()
            .map(|(id, s)| (*id, s.source.clone(), s.format))
            .collect()
    }

    /// Generate a test tone as a synthetic PCM source. Used by the
    /// diagnostics probes so we can verify the encode + WS path
    /// without a live Ardour attachment. Emits a 440 Hz sine wave
    /// at the requested format for `duration`, then closes the
    /// source so the stream tears down cleanly.
    pub fn spawn_test_tone_source(
        &self,
        format: AudioFormat,
        duration: Duration,
    ) -> mpsc::Receiver<foyer_backend::PcmFrame> {
        let (tx, rx) = mpsc::channel(32);
        tokio::spawn(async move {
            let start = Instant::now();
            let frame_samples = 960usize; // ~20 ms at 48 kHz
            let channels = format.channels as usize;
            let sr = format.sample_rate as f32;
            let mut phase: f32 = 0.0;
            let twopi_f_over_sr = 2.0 * std::f32::consts::PI * 440.0 / sr;
            // Per-channel gains that are NOT bit-identical. When L==R
            // exactly, Opus' stereo coupling promotes the signal to
            // pure mid-channel (side=0), which Chrome's decoder then
            // reconstructs at half amplitude with frequency halved —
            // the exact "octave-down, -6 dB" artifact we kept chasing.
            // Breaking correlation by ≤1 % is inaudible but forces
            // Opus to keep true L/R coding. Real Ardour audio is
            // always naturally decorrelated so this only matters for
            // the synthetic tone.
            const CH_GAINS: [f32; 2] = [0.4, 0.39];
            // `tokio::time::sleep(20 ms)` drifts noticeably — the
            // timer wheel's coarse resolution plus the cost of the
            // frame-build loop means actual cadence is ~23 ms,
            // yielding ~43 frames/sec instead of 50. Downstream
            // (browser AudioWorklet consuming at 48 kHz exactly),
            // that's a 14 % samples/s deficit which drains the ring
            // buffer and produces constant small underruns. An
            // `interval` self-corrects: `tick().await` returns
            // immediately if we've fallen behind. `Burst` behavior
            // (the default) emits any missed ticks back-to-back to
            // catch up, which is what we want.
            let mut ticker = tokio::time::interval(Duration::from_millis(20));
            while start.elapsed() < duration {
                ticker.tick().await;
                let mut samples = Vec::with_capacity(frame_samples * channels);
                for _ in 0..frame_samples {
                    let s = phase.sin();
                    phase += twopi_f_over_sr;
                    if phase > std::f32::consts::TAU {
                        phase -= std::f32::consts::TAU;
                    }
                    for c in 0..channels {
                        let gain = CH_GAINS.get(c).copied().unwrap_or(0.4);
                        samples.push(s * gain);
                    }
                }
                let pcm = foyer_backend::PcmFrame {
                    stream_id: 0,
                    samples,
                };
                if tx.send(pcm).await.is_err() {
                    break;
                }
            }
        });
        rx
    }
}

impl Default for AudioHub {
    fn default() -> Self {
        Self::new()
    }
}

fn epoch_micros() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}

/// Serialize an `EncodedPacket` into the binary wire format documented
/// at the top of this file. Used by the WS audio handler.
pub fn pack_wire(packet: &EncodedPacket) -> Vec<u8> {
    let mut out = Vec::with_capacity(12 + packet.opus.len());
    out.extend_from_slice(&packet.stream_id.to_be_bytes());
    out.extend_from_slice(&packet.timestamp_us.to_be_bytes());
    out.extend_from_slice(&packet.opus);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_roundtrip() {
        let pkt = EncodedPacket {
            stream_id: 42,
            timestamp_us: 0xdeadbeefcafe,
            opus: vec![1, 2, 3, 4, 5],
        };
        let bytes = pack_wire(&pkt);
        assert_eq!(bytes.len(), 12 + 5);
        assert_eq!(&bytes[..4], &42u32.to_be_bytes());
        assert_eq!(&bytes[4..12], &0xdeadbeefcafe_u64.to_be_bytes());
        assert_eq!(&bytes[12..], &[1u8, 2, 3, 4, 5]);
    }

    #[tokio::test]
    async fn hub_open_and_close() {
        let hub = AudioHub::new();
        let fmt = AudioFormat::new(48_000, 2, 128);
        let (_tx, rx) = mpsc::channel(4);
        let bcast = hub
            .open_stream(7, AudioSource::Master, fmt, rx)
            .await
            .expect("open");
        assert!(bcast.receiver_count() == 0);
        let streams = hub.list().await;
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0].0, 7);
        hub.close_stream(7).await;
        let streams = hub.list().await;
        assert!(streams.is_empty());
    }
}
