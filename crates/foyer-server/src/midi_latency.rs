//! Per-track MIDI ingress roundtrip-latency tracker.
//!
//! Sibling of `ingress_latency` but keyed on `EntityId` (track id)
//! instead of `u32` stream id. Each browser → DAW `MidiInput`
//! envelope can carry an `echo_server_mono_ns` field; the server
//! computes `monotonic_nanos() - echo` to get the full browser↔
//! server round trip and feeds the sample here. The dispatcher
//! consults `median_ms` to decide whether to emit a
//! `SetMidiCaptureLatency` to the shim.
//!
//! Mirrors the audio ingress design: the SAME process samples both
//! sides of the comparison (sentinel emit + ingress recv), so no
//! cross-clock offset reconciliation is needed.
//!
//! `RING_CAP` is smaller than the audio tracker's because MIDI
//! events arrive sparsely (one note-on per keystroke vs. 50 Hz
//! audio chunks). 64 samples is enough to median over ~10 s of
//! steady playing.

use std::collections::HashMap;
use std::sync::Mutex;

use foyer_schema::EntityId;

const RING_CAP: usize = 64;

#[derive(Default)]
pub struct MidiLatencyTracker {
    tracks: Mutex<HashMap<EntityId, Ring>>,
}

#[derive(Default)]
struct Ring {
    samples_ns: Vec<i64>,
    write: usize,
    filled: usize,
}

impl MidiLatencyTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one roundtrip observation for a track.
    pub fn record(&self, track_id: &EntityId, latency_ns: i64) {
        let mut g = self.tracks.lock().unwrap();
        let r = g.entry(track_id.clone()).or_default();
        if r.samples_ns.len() < RING_CAP {
            r.samples_ns.push(latency_ns);
            r.filled = r.samples_ns.len();
        } else {
            r.samples_ns[r.write] = latency_ns;
            r.filled = RING_CAP;
        }
        r.write = (r.write + 1) % RING_CAP;
    }

    /// Median latency for a track in milliseconds. Returns `None`
    /// until at least 4 samples have accumulated (MIDI streams in
    /// less data than audio so we converge with fewer samples).
    pub fn median_ms(&self, track_id: &EntityId) -> Option<f32> {
        let g = self.tracks.lock().unwrap();
        let r = g.get(track_id)?;
        if r.filled < 4 {
            return None;
        }
        let mut buf: Vec<i64> = r.samples_ns[..r.filled].to_vec();
        buf.sort_unstable();
        let mid = buf[buf.len() / 2];
        Some(mid as f32 / 1_000_000.0)
    }

    /// Drop a track's history. Call when the track is destroyed or
    /// its source-user assignment is cleared so the next claimant
    /// starts fresh.
    #[allow(dead_code)]
    pub fn drop_track(&self, track_id: &EntityId) {
        let mut g = self.tracks.lock().unwrap();
        g.remove(track_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn median_returns_none_until_min_samples() {
        let t = MidiLatencyTracker::new();
        let tid = EntityId::new("track.a");
        for i in 0..3 {
            t.record(&tid, i * 1_000_000);
        }
        assert_eq!(t.median_ms(&tid), None);
        t.record(&tid, 3_000_000);
        let m = t.median_ms(&tid).expect("four samples");
        assert!((m - 2.0).abs() < 1e-3, "got {m}");
    }

    #[test]
    fn ring_wraps_keeping_recent() {
        let t = MidiLatencyTracker::new();
        let tid = EntityId::new("track.a");
        for _ in 0..RING_CAP {
            t.record(&tid, 1_000_000);
        }
        for _ in 0..RING_CAP {
            t.record(&tid, 100_000_000);
        }
        let m = t.median_ms(&tid).unwrap();
        assert!((m - 100.0).abs() < 1e-3, "got {m}");
    }

    #[test]
    fn drop_track_clears() {
        let t = MidiLatencyTracker::new();
        let tid = EntityId::new("track.a");
        for _ in 0..8 {
            t.record(&tid, 5_000_000);
        }
        assert!(t.median_ms(&tid).is_some());
        t.drop_track(&tid);
        assert_eq!(t.median_ms(&tid), None);
    }
}
