//! Speaker→mic loopback calibration for capture-offset.
//!
//! The empirical capture-offset path can't see two pieces of the loop:
//! the mic-to-browser-stack hop, and any platform output latency the
//! browser under-reports. Combined those leave a residual that the
//! user has to dial in manually. This module replaces the dial with
//! a one-shot measurement: emit known click patterns on an active
//! egress stream, watch for the click reflection on the matching
//! ingress stream, and compute the true round-trip directly.
//!
//! Click design — see `CLICK_FREQ_HZ` / `CLICK_DURATION_MS` /
//! `CLICK_AMPLITUDE`. A 5 ms 4 kHz tone burst is short enough to
//! place precisely (sub-millisecond), loud enough to detect above
//! ambient mic noise, distinctive enough that random speech / music
//! doesn't trigger false positives, and not so loud that it's painful
//! to listen to during a 2.5 s calibration window.
//!
//! State machine:
//!   * `start_run(...)` arms a `CalibrationRun` keyed by `egress_stream_id`.
//!   * The egress encode loop calls `maybe_overlay_egress_click()` on
//!     each outgoing PCM chunk; it returns `true` when a click was
//!     just stamped onto the buffer, and the caller stashes the emit
//!     timestamp via `note_click_emitted()`.
//!   * The ingress decode loop calls `scan_ingress_for_clicks()`
//!     during a run; each detection pops the oldest pending emit
//!     timestamp and adds a measurement to the run.
//!   * After `clicks` measurements (or when the user aborts), the run
//!     finalises and the result is read off via `take_result()`.
//!
//! All state goes through a single `Mutex` since neither path is hot
//! enough to need finer granularity (egress encode runs ~50 Hz,
//! ingress decode the same). Refractory period in
//! `scan_ingress_for_clicks` keeps a single click from triggering
//! multiple detections inside its 5 ms envelope.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

/// Tone-burst frequency. 4 kHz sits well above the bulk of vocal
/// energy (which tapers off above ~3 kHz) and well below the typical
/// 8 kHz sample-rate Nyquist; survives 48k / 44.1k resampling without
/// significant attenuation.
const CLICK_FREQ_HZ: f32 = 4000.0;
/// Tone-burst length. 5 ms = 240 samples at 48 kHz, easily resolved
/// inside a typical ingress chunk (~20 ms) and far shorter than the
/// inter-click gap.
const CLICK_DURATION_MS: f32 = 5.0;
/// Peak amplitude of the click. 0.4 is loud enough to detect above
/// ambient mic noise at typical listening volume but soft enough not
/// to be unpleasant. Adjust if the mic is far from the speaker.
const CLICK_AMPLITUDE: f32 = 0.4;
/// Detection threshold on the ingress side. A click playing through
/// real-world speakers and mic'd back is significantly attenuated;
/// 0.1 catches typical setups while rejecting typing / breathing
/// noise (sustained above 0.1 for > 2 ms is unusual for ambient
/// sound).
const DETECTION_THRESHOLD: f32 = 0.1;
/// How long the click sample must stay above threshold before we
/// accept it as a real click (vs an impulsive transient like a
/// keyboard click).
const DETECTION_SUSTAIN_SAMPLES: usize = 96; // 2 ms at 48 kHz
/// After a positive detection we ignore further samples for this many
/// to avoid multi-counting the same click's envelope.
const REFRACTORY_SAMPLES: usize = 1920; // 40 ms at 48 kHz
/// Gap between successive click emissions. Must exceed the maximum
/// realistic round-trip so each detection unambiguously points to ONE
/// emit. 800 ms accommodates Bluetooth speakers (~250–400 ms) plus
/// slack and still keeps the full run under 8 s.
pub const CLICK_INTERVAL_MS: u64 = 800;
/// Wait this long after `start_run` before emitting the first click.
/// The browser's worklet buffer needs time to flush whatever audio
/// was in flight before the calibration's egress silence took over;
/// without the delay, the first one or two clicks land while the
/// buffer is still mid-drain and get missed by the detector.
pub const SETTLING_MS: u64 = 1000;
/// Lower bound on a plausible round-trip — anything faster than this
/// is almost certainly a same-cycle artifact (echo cancellation
/// suppressor, internal feedback path) and we shouldn't count it.
pub const ACCEPT_MIN_MS: u64 = 30;
/// Upper bound on a plausible round-trip. Set below `CLICK_INTERVAL_MS`
/// so each detection can only match the immediately-preceding emit;
/// out-of-window detections are dropped instead of mis-matched to a
/// stale emit (which is how a missed click would otherwise corrupt
/// every subsequent measurement, producing the 2596 ms outliers we
/// were seeing).
pub const ACCEPT_MAX_MS: u64 = 700;
/// Default number of clicks per run.
pub const DEFAULT_CLICKS: u32 = 5;

/// One calibration session for an `egress_stream_id` / `ingress_stream_id`
/// pair.
struct CalibrationRun {
    egress_stream_id: u32,
    ingress_stream_id: u32,
    /// Engine sample rate captured at run start; used to convert
    /// click envelope samples and to feed `_capture_offset` math.
    sample_rate: u32,
    /// Total clicks requested.
    target_clicks: u32,
    /// Clicks emitted so far. Each emit drops a timestamp into
    /// `pending_emits`; ingress detection pops them.
    emitted: u32,
    /// `monotonic_nanos()` of the next eligible click emission.
    /// `None` means "emit immediately the next time the encode
    /// loop runs".
    next_emit_at_mono_ns: Option<u64>,
    /// FIFO of emit timestamps awaiting detection. Bounded by
    /// `target_clicks` so size is trivial; using VecDeque lets us
    /// pop the oldest cheaply.
    pending_emits: VecDeque<u64>,
    /// Detection refractory counter — samples until the ingress
    /// scanner is allowed to register another detection. Decremented
    /// per processed sample.
    refractory: usize,
    /// Sustain counter — number of consecutive above-threshold
    /// samples observed so far. Resets to 0 below threshold.
    sustain: usize,
    /// Measured round-trips (ms) — one entry per matched click.
    measurements_ms: Vec<f32>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CalibrationResult {
    pub stream_id: u32,
    pub median_ms: f32,
    pub samples_kept: u32,
    pub samples_requested: u32,
}

#[derive(Default)]
pub struct CalibrationManager {
    runs: Mutex<HashMap<u32, CalibrationRun>>,
}

impl CalibrationManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Begin a new run. Returns the actually-assigned click count.
    /// Replaces any in-flight run for the same `egress_stream_id`.
    pub fn start_run(
        &self,
        egress_stream_id: u32,
        ingress_stream_id: u32,
        sample_rate: u32,
        clicks: Option<u32>,
    ) -> u32 {
        let target = clicks.unwrap_or(DEFAULT_CLICKS).clamp(2, 20);
        let mut g = self.runs.lock().unwrap();
        g.insert(
            egress_stream_id,
            CalibrationRun {
                egress_stream_id,
                ingress_stream_id,
                sample_rate,
                target_clicks: target,
                emitted: 0,
                next_emit_at_mono_ns: None,
                pending_emits: VecDeque::new(),
                refractory: 0,
                sustain: 0,
                measurements_ms: Vec::with_capacity(target as usize),
            },
        );
        target
    }

    /// Stop a run, returning the partial result if any.
    pub fn stop_run(&self, egress_stream_id: u32) -> Option<CalibrationResult> {
        let mut g = self.runs.lock().unwrap();
        let run = g.remove(&egress_stream_id)?;
        Some(finalize(&run))
    }

    /// Reverse lookup: given an ingress stream id, find the egress
    /// run feeding it (if any). Lets `ingress_ws.rs` ask "is there
    /// a calibration run consuming my packets" without knowing
    /// the egress stream id.
    pub fn egress_for_ingress(&self, ingress_stream_id: u32) -> Option<u32> {
        self.runs
            .lock()
            .unwrap()
            .iter()
            .find(|(_, r)| r.ingress_stream_id == ingress_stream_id)
            .map(|(eid, _)| *eid)
    }

    /// Called by the egress encode loop on every chunk while a run
    /// is active. Always SILENCES the chunk for the duration of a
    /// run (engine music between clicks would bleed into the mic
    /// and produce spurious detections). When a click is due,
    /// additionally overlays the click envelope into the start of
    /// the chunk and returns `Some(emit_mono_ns)` so the caller can
    /// use it as the sentinel timestamp for the packet.
    ///
    /// `now_mono_ns` is passed in (not sampled internally) so the
    /// caller can correlate the emit time with whatever sentinel
    /// timestamp it's already producing for this chunk.
    pub fn maybe_overlay_egress_click(
        &self,
        egress_stream_id: u32,
        pcm: &mut [f32],
        channels: u32,
        sample_rate: u32,
        now_mono_ns: u64,
    ) -> Option<u64> {
        let mut g = self.runs.lock().unwrap();
        let run = g.get_mut(&egress_stream_id)?;
        // Step 1: ALWAYS silence the chunk while a run is active.
        // Even between clicks the egress should be quiet so the
        // ingress detector only sees the click envelopes, not engine
        // playback bleeding through the user's speakers/mic.
        for s in pcm.iter_mut() {
            *s = 0.0;
        }
        // Step 2: are we already done emitting?
        if run.emitted >= run.target_clicks {
            return None;
        }
        // Step 3: enforce the settling delay before the first click.
        // The first call to this fn after `start_run` initialises
        // `next_emit_at_mono_ns` to `now + SETTLING_MS`; the actual
        // emit waits for that deadline.
        let next_at = run
            .next_emit_at_mono_ns
            .unwrap_or(now_mono_ns + SETTLING_MS * 1_000_000);
        if run.next_emit_at_mono_ns.is_none() {
            run.next_emit_at_mono_ns = Some(next_at);
        }
        if now_mono_ns < next_at {
            return None;
        }

        // Step 4: overlay the click envelope onto the first
        // CLICK_DURATION_MS of the (now-silenced) chunk.
        let click_samples = ((CLICK_DURATION_MS / 1000.0) * sample_rate as f32) as usize;
        let total_frames = pcm.len() / channels.max(1) as usize;
        let ch = channels.max(1) as usize;
        let click_frames = click_samples.min(total_frames);
        for frame_idx in 0..click_frames {
            let phase =
                (frame_idx as f32 / sample_rate as f32) * CLICK_FREQ_HZ * std::f32::consts::TAU;
            // Hann window so the click has no DC step at start
            // or end — avoids the speaker driver making a "thump"
            // outside the 4 kHz band the detector is keying on.
            let win = 0.5
                * (1.0 - ((frame_idx as f32 / click_samples as f32) * std::f32::consts::TAU).cos());
            let s = phase.sin() * win * CLICK_AMPLITUDE;
            for c in 0..ch {
                pcm[frame_idx * ch + c] = s;
            }
        }

        run.emitted += 1;
        run.pending_emits.push_back(now_mono_ns);
        run.next_emit_at_mono_ns = Some(now_mono_ns + CLICK_INTERVAL_MS * 1_000_000);
        // Cap pending queue at 2× target_clicks — older emits are
        // beyond ACCEPT_MAX so they can never match anyway.
        while run.pending_emits.len() > (run.target_clicks as usize) * 2 {
            run.pending_emits.pop_front();
        }
        let _ = run.sample_rate.max(sample_rate); // Quiet unused-field if reordered.
        Some(now_mono_ns)
    }

    /// Scan ingress PCM for click detections during an active run.
    /// `recv_mono_ns` is `monotonic_nanos()` at the moment this chunk
    /// arrived at the server.
    ///
    /// Returns a list of `(measured_ms, n, target)` for each detection
    /// in this chunk. Caller emits the corresponding progress events
    /// and, when `n == target`, finalises via `take_result`.
    pub fn scan_ingress_for_clicks(
        &self,
        ingress_stream_id: u32,
        pcm: &[f32],
        channels: u32,
        sample_rate: u32,
        recv_mono_ns: u64,
    ) -> Vec<(f32, u32, u32)> {
        let mut hits: Vec<(f32, u32, u32)> = Vec::new();
        let mut g = self.runs.lock().unwrap();
        let egress_id = match g
            .iter()
            .find(|(_, r)| r.ingress_stream_id == ingress_stream_id)
            .map(|(eid, _)| *eid)
        {
            Some(e) => e,
            None => return hits,
        };
        let run = match g.get_mut(&egress_id) {
            Some(r) => r,
            None => return hits,
        };

        let ch = channels.max(1) as usize;
        let total_frames = pcm.len() / ch;
        let accept_min_ns = ACCEPT_MIN_MS * 1_000_000;
        let accept_max_ns = ACCEPT_MAX_MS * 1_000_000;
        // Walk frame-by-frame; for multi-channel streams just look
        // at channel 0 (the click was emitted to all channels and a
        // mono mic captures one — the detection is amplitude-based
        // so any channel works).
        for frame_idx in 0..total_frames {
            if run.refractory > 0 {
                run.refractory -= 1;
                continue;
            }
            let s = pcm[frame_idx * ch].abs();
            if s >= DETECTION_THRESHOLD {
                run.sustain += 1;
                if run.sustain >= DETECTION_SUSTAIN_SAMPLES {
                    // Compute the detection's monotonic timestamp.
                    // Sub-chunk offset: back from `recv_mono_ns` by
                    // the samples between the detected frame and
                    // the chunk's end, minus the SUSTAIN we waited
                    // before triggering.
                    let samples_from_chunk_end =
                        total_frames.saturating_sub(frame_idx + 1) + DETECTION_SUSTAIN_SAMPLES;
                    let ns_from_chunk_end =
                        (samples_from_chunk_end as u64 * 1_000_000_000) / sample_rate.max(1) as u64;
                    let detect_ns = recv_mono_ns.saturating_sub(ns_from_chunk_end);

                    // Time-windowed match: find the MOST RECENT emit
                    // whose gap to this detection falls in
                    // [ACCEPT_MIN, ACCEPT_MAX]. Iterating oldest →
                    // newest and always updating `candidate` (until
                    // an emit is later than detect) lands on the
                    // latest valid emit, which is the one this
                    // detection actually corresponds to even when
                    // earlier clicks were missed.
                    let mut candidate_idx: Option<usize> = None;
                    for (idx, emit_ns) in run.pending_emits.iter().enumerate() {
                        let emit = *emit_ns;
                        if emit > detect_ns {
                            // All later emits are in the future
                            // relative to this detect — stop.
                            break;
                        }
                        let gap = detect_ns - emit;
                        if gap >= accept_min_ns && gap <= accept_max_ns {
                            candidate_idx = Some(idx);
                        } else if gap < accept_min_ns {
                            // This emit is too NEW (< MIN means the
                            // detection happened too close to the
                            // emit to be a real round-trip) — break
                            // because subsequent emits would be even
                            // newer.
                            break;
                        }
                        // else: gap > MAX, this emit is stale; keep
                        // walking. We don't pop it here because a
                        // newer emit might still match.
                    }
                    if let Some(idx) = candidate_idx {
                        // Remove the matched emit and any STALER
                        // emits before it — those were the ones
                        // whose clicks we missed.
                        let matched = run.pending_emits.remove(idx);
                        // remove() returns None if idx OOB; should
                        // never happen since we just took it from
                        // iter().enumerate().
                        if let Some(emit_ns) = matched {
                            // Drop everything older than the match
                            // (FIFO ordering means they have lower
                            // indices than `idx`, but we just
                            // removed at idx so they're now at the
                            // FRONT of the deque). Pop while head <
                            // matched.
                            while let Some(&front) = run.pending_emits.front() {
                                if front < emit_ns {
                                    run.pending_emits.pop_front();
                                } else {
                                    break;
                                }
                            }
                            let gap_ns = detect_ns.saturating_sub(emit_ns);
                            let measured_ms = gap_ns as f32 / 1_000_000.0;
                            run.measurements_ms.push(measured_ms);
                            let n = run.measurements_ms.len() as u32;
                            hits.push((measured_ms, n, run.target_clicks));
                        }
                    }
                    // No-match: just drop the detection (noise spike,
                    // or detection arrived outside any valid window).
                    run.sustain = 0;
                    run.refractory = REFRACTORY_SAMPLES;
                }
            } else {
                run.sustain = 0;
            }
        }
        hits
    }

    /// Finalise and remove a completed run. Returns `None` if no run
    /// exists for this id.
    pub fn take_result(&self, egress_stream_id: u32) -> Option<CalibrationResult> {
        let mut g = self.runs.lock().unwrap();
        let run = g.remove(&egress_stream_id)?;
        Some(finalize(&run))
    }
}

fn finalize(run: &CalibrationRun) -> CalibrationResult {
    let mut measurements = run.measurements_ms.clone();
    let samples_kept = measurements.len() as u32;
    let median_ms = if measurements.is_empty() {
        0.0
    } else {
        measurements.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        measurements[measurements.len() / 2]
    };
    CalibrationResult {
        stream_id: run.egress_stream_id,
        median_ms,
        samples_kept,
        samples_requested: run.target_clicks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NS_PER_MS: u64 = 1_000_000;

    #[test]
    fn settling_delay_holds_first_click() {
        let mgr = CalibrationManager::new();
        mgr.start_run(1, 2, 48000, Some(3));
        let mut pcm = vec![0.5_f32; 480];
        // First call at t=100ms — still inside the settling window,
        // chunk should be silenced but no click emitted.
        let emit0 = mgr.maybe_overlay_egress_click(1, &mut pcm, 1, 48000, 100 * NS_PER_MS);
        assert!(
            emit0.is_none(),
            "first call inside settling window should NOT emit"
        );
        assert!(
            pcm.iter().all(|&s| s == 0.0),
            "chunk must be silenced even when no click emitted"
        );
        // Second call AFTER the settling deadline emits.
        let mut pcm2 = vec![0.5_f32; 480];
        let t1 = (100 + SETTLING_MS + 1) * NS_PER_MS;
        let emit1 = mgr
            .maybe_overlay_egress_click(1, &mut pcm2, 1, 48000, t1)
            .expect("click emitted after settling");
        assert_eq!(emit1, t1);
        let peak = pcm2[..240].iter().map(|s| s.abs()).fold(0.0_f32, f32::max);
        assert!(peak > 0.05, "click peak was {peak}");
        // Third call inside the inter-click gap is a no-op (but still
        // silences).
        let mut pcm3 = vec![0.5_f32; 480];
        let emit2 = mgr.maybe_overlay_egress_click(1, &mut pcm3, 1, 48000, t1 + NS_PER_MS);
        assert!(emit2.is_none());
        assert!(pcm3.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn window_matching_skips_stale_emits() {
        let mgr = CalibrationManager::new();
        mgr.start_run(1, 2, 48000, Some(3));
        // Manually emit three clicks at t=0, 800ms, 1600ms (bypass
        // settling for the test by reaching past it).
        let base = 10 * NS_PER_MS; // anything > 0
        for k in 0..3u64 {
            let t = base + SETTLING_MS * NS_PER_MS + k * CLICK_INTERVAL_MS * NS_PER_MS;
            let mut tx = vec![0.0_f32; 480];
            let _ = mgr.maybe_overlay_egress_click(1, &mut tx, 1, 48000, t);
        }
        // Now simulate detection of ONLY the third click, 200ms after
        // its emit (so detect time = base + SETTLING + 2 * INTERVAL +
        // 200ms). Earlier two clicks were "missed" — the matcher
        // should attribute the detection to the third emit (200 ms
        // gap), not the first (1800 ms gap, > ACCEPT_MAX).
        let third_emit_t = base + SETTLING_MS * NS_PER_MS + 2 * CLICK_INTERVAL_MS * NS_PER_MS;
        let detect_t = third_emit_t + 200 * NS_PER_MS;
        // Fabricate an ingress chunk containing a sustained spike at
        // the start; `recv_mono_ns` is set so the back-calc puts the
        // detection at `detect_t`.
        let mut rx = vec![0.0_f32; 4800];
        for i in 100..400 {
            rx[i] = 0.5;
        }
        // Detection back-calc: detect_ns = recv_mono_ns -
        // ns_from_chunk_end; we want detect_ns == detect_t, so
        // recv_mono_ns = detect_t + ns_from_chunk_end.
        let samples_from_chunk_end = 4800 - (100 + DETECTION_SUSTAIN_SAMPLES);
        let ns_from_chunk_end = (samples_from_chunk_end as u64 * 1_000_000_000) / 48_000u64;
        let recv = detect_t + ns_from_chunk_end;
        let hits = mgr.scan_ingress_for_clicks(2, &rx, 1, 48000, recv);
        assert_eq!(hits.len(), 1, "expected exactly one match");
        let (ms, _n, _) = hits[0];
        // Should be ~200ms, NOT ~1800ms (which is what greedy-oldest
        // would have produced).
        assert!((ms - 200.0).abs() < 5.0, "expected ~200ms, got {ms}");
    }
}
