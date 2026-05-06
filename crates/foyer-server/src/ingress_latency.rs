//! Per-stream ingress latency tracker.
//!
//! Each browser → DAW audio packet now carries a `client_send_ms`
//! header (f64, milliseconds on the client's `performance.now()`
//! clock). When a packet arrives the sidecar reads its monotonic
//! clock, looks up the client/server offset most-recently estimated
//! via `Command::ClockProbe`, and computes one-way latency as
//!
//! ```text
//!   recv_mono_ns = monotonic_nanos()
//!   send_mono_ns = client_send_ms * 1e6 - offset_ns
//!   latency_ns   = recv_mono_ns - send_mono_ns
//! ```
//!
//! `offset_ns` is `client_mono_ns - server_mono_ns` from the probe,
//! so subtracting it converts the client-stamped send time into
//! server-monotonic units that line up with `recv_mono_ns`.
//!
//! Samples are kept in a small ring per stream so the median is
//! cheap to compute; the consumer (the recording-finalize path) asks
//! for the median when it commits a take's region metadata so the
//! browser-side recording can be auto-shifted by exactly the
//! transport latency without the user calibrating manually.

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
        let mut g = self.streams.lock().unwrap();
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
        let g = self.streams.lock().unwrap();
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
        let mut g = self.streams.lock().unwrap();
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
