//! Per-stream ingress roundtrip-latency tracker.
//!
//! Each browser → DAW audio packet carries an 8-byte header of
//! `i64 LE echo_server_mono_ns` — the source-side `CLOCK_MONOTONIC`
//! timestamp of the audio coming out of the speakers when the
//! browser captured this sample (most recent egress sentinel, shifted
//! back by `playbackDelayMs`). When the packet arrives the sidecar
//! reads its own monotonic clock and computes the FULL round-trip:
//!
//! ```text
//!   recv_mono_ns  = monotonic_nanos()
//!   roundtrip_ns  = recv_mono_ns - echo_server_mono_ns
//! ```
//!
//! Because the echo and `recv_mono_ns` are sampled from the SAME
//! clock (same host, `CLOCK_MONOTONIC`), no clock-offset reconciliation
//! is needed — the math is direct. `-1` (or non-positive) in the
//! header means the browser hadn't observed any egress sentinel yet
//! (cold start, record-armed-without-playback); we skip recording.
//!
//! The shim consumes the same value independently from the IPC audio
//! frame's `transport_pos` slot and applies it as `_capture_offset`
//! on the matching ingress port so the recorded take lands at the
//! engine frame the user was hearing. The tracker here keeps the
//! number around for diagnostics + the `IngressLatencyReport` reply.

use std::collections::HashMap;
use std::sync::Mutex;

/// Cap per stream — 256 packets covers ~5 s of recording at 20 ms
/// frames, which is plenty for a stable median.
const RING_CAP: usize = 256;

#[derive(Default)]
pub struct IngressLatencyTracker {
    streams: Mutex<HashMap<u32, Ring>>,
}

#[derive(Default)]
struct Ring {
    samples_ns: Vec<i64>,
    write: usize,
    filled: usize,
}

impl IngressLatencyTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one observation. `latency_ns` is signed: a negative
    /// value means the client's clock reads ahead of the server's
    /// after offset correction (clock-probe noise; the median
    /// absorbs it).
    pub fn record(&self, stream_id: u32, latency_ns: i64) {
        let mut g = self
            .streams
            .lock()
            .expect("ingress latency streams mutex not poisoned");
        let r = g.entry(stream_id).or_default();
        if r.samples_ns.len() < RING_CAP {
            r.samples_ns.push(latency_ns);
            r.filled = r.samples_ns.len();
        } else {
            r.samples_ns[r.write] = latency_ns;
            r.filled = RING_CAP;
        }
        r.write = (r.write + 1) % RING_CAP;
    }

    /// Median latency for a stream in milliseconds, or `None` if
    /// fewer than 8 samples have been recorded (too few to be a
    /// useful signal). The median absorbs occasional spikes from
    /// GC / network jitter without skewing the result the way a
    /// mean would.
    pub fn median_ms(&self, stream_id: u32) -> Option<f32> {
        let g = self
            .streams
            .lock()
            .expect("ingress latency streams mutex not poisoned");
        let r = g.get(&stream_id)?;
        if r.filled < 8 {
            return None;
        }
        let mut buf: Vec<i64> = r.samples_ns[..r.filled].to_vec();
        buf.sort_unstable();
        let mid = buf[buf.len() / 2];
        Some(mid as f32 / 1_000_000.0)
    }

    /// Drop a stream's history. Call when the ingress closes so
    /// stale samples don't bleed into the next stream that happens
    /// to reuse the same id.
    pub fn drop_stream(&self, stream_id: u32) {
        let mut g = self
            .streams
            .lock()
            .expect("ingress latency streams mutex not poisoned");
        g.remove(&stream_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn median_returns_none_until_min_samples() {
        let t = IngressLatencyTracker::new();
        for i in 0..7 {
            t.record(1, i * 1_000_000);
        }
        assert_eq!(t.median_ms(1), None);
        t.record(1, 7_000_000);
        let m = t.median_ms(1).expect("eight samples");
        // Median of 0..=7 ms is 4 ms.
        assert!((m - 4.0).abs() < 1e-3, "got {m}");
    }

    #[test]
    fn ring_wraps_and_keeps_recent_samples() {
        let t = IngressLatencyTracker::new();
        // Fill with low values, then overwrite with high values.
        for _ in 0..RING_CAP {
            t.record(1, 1_000_000);
        }
        for _ in 0..RING_CAP {
            t.record(1, 100_000_000);
        }
        let m = t.median_ms(1).unwrap();
        // Every old sample was overwritten, so the median is now ~100 ms.
        assert!((m - 100.0).abs() < 1e-3, "got {m}");
    }

    #[test]
    fn drop_stream_clears() {
        let t = IngressLatencyTracker::new();
        for _ in 0..16 {
            t.record(7, 5_000_000);
        }
        assert!(t.median_ms(7).is_some());
        t.drop_stream(7);
        assert_eq!(t.median_ms(7), None);
    }
}
