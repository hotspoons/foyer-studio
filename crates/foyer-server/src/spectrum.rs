// SPDX-License-Identifier: Apache-2.0
//! Server-side spectrum analyser.
//!
//! When a backend advertises `spectrum.available = false` (the Ardour
//! shim currently does — its native FFT pipeline is a substantial C++
//! piece of work and isn't shipped yet), the server transparently
//! falls back to this module: open a PCM tap on the same egress the
//! audio hub uses, run a Hann-windowed FFT on each hop, and emit the
//! `Event::SpectrumFrame` from Rust so the FE / agent never know the
//! analyser isn't living inside the shim.
//!
//! The FFT is an inline iterative Cooley–Tukey — no new deps, and the
//! sizes we use (256..16384 samples) run in fractions of a
//! millisecond. The wrapper handles:
//!
//!   - resampling-free buffering: PCM frames arrive at whatever
//!     `frame_size` the backend hands out; we accumulate into a fixed
//!     `fft_size` ring and shift by `hop_size` per emit.
//!   - per-channel: deinterleaves into N parallel ring buffers,
//!     FFTs each independently, ships per-channel magnitudes.
//!   - magnitude in dBFS clamped to `min_db`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use foyer_backend::{Backend, PcmFrame};
use foyer_schema::{
    AudioCodec, AudioFormat, AudioSource, ControlValue, EntityId, Event, SampleFormat,
    SpectrumChannel, SpectrumFrame, SpectrumOpts, SpectrumTarget, SpectrumWindow, TrackKind,
};
use tokio::sync::Mutex;

use crate::AppState;

/// Cap on simultaneous server-side spectrum subscriptions. Each
/// subscription opens its own egress tap and runs a per-hop FFT;
/// 32 is more than any realistic UI surface would mount.
const MAX_ACTIVE_SUBS: usize = 32;

/// Unique stream-id space for analyser-only egress taps. Starts well
/// above the existing audio-stream id range to avoid collisions in
/// shared HashMaps. Each new sub increments.
const STREAM_ID_BASE: u32 = 0xA0BA_0000;

/// One active analyser. Holds the abort handle for the producer task
/// so unsubscribe drops it cleanly.
struct Analyser {
    stream_id: u32,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Clone, Default)]
pub struct SpectrumService {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    subs: HashMap<String, Analyser>,
    next_stream_id: u32,
}

impl SpectrumService {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                subs: HashMap::new(),
                next_stream_id: STREAM_ID_BASE,
            })),
        }
    }

    /// Open a fallback analyser against `target`. Returns the
    /// SpectrumOpts the analyser actually applied (after clamping).
    pub async fn subscribe(
        &self,
        state: Arc<AppState>,
        backend: Arc<dyn Backend>,
        target: SpectrumTarget,
        opts: SpectrumOpts,
        sample_rate: u32,
    ) -> Result<SpectrumOpts, String> {
        let applied = clamp_opts(&opts);
        let key = target.slug();
        let mut guard = self.inner.lock().await;
        if guard.subs.contains_key(&key) {
            // Re-subscribe: tear the old one down first so the new
            // opts take effect.
            if let Some(prev) = guard.subs.remove(&key) {
                prev.task.abort();
                // Try to close the stream on the backend too — best
                // effort, the backend may have already dropped it.
                let b = backend.clone();
                let sid = prev.stream_id;
                tokio::spawn(async move {
                    let _ = b.close_egress(sid).await;
                });
            }
        }
        if guard.subs.len() >= MAX_ACTIVE_SUBS {
            return Err(format!(
                "server-side spectrum subscription cap ({MAX_ACTIVE_SUBS}) reached"
            ));
        }
        let stream_id = guard.next_stream_id;
        guard.next_stream_id = guard.next_stream_id.wrapping_add(1);
        drop(guard);

        let source = match &target {
            SpectrumTarget::Master => AudioSource::Master,
            SpectrumTarget::Monitor => AudioSource::Monitor,
            SpectrumTarget::Track { id } => AudioSource::Track { id: id.clone() },
        };
        // Frame size matters less for analysis than for streaming —
        // 960 (20 ms at 48 kHz) keeps the producer task ticking at a
        // reasonable rate.
        let format = AudioFormat {
            sample_rate,
            channels: 2,
            format: SampleFormat::F32Le,
            frame_size: 960,
            codec: AudioCodec::RawF32Le,
        };
        let rx = backend
            .open_egress(stream_id, source, format)
            .await
            .map_err(|e| format!("open_egress failed: {e}"))?;

        let state_clone = state.clone();
        let target_clone = target.clone();
        let opts_clone = applied.clone();
        let channels = format.channels.max(1) as usize;
        let task = tokio::spawn(async move {
            run_analyser(
                rx,
                state_clone,
                target_clone,
                opts_clone,
                sample_rate,
                channels,
            )
            .await;
        });
        self.inner
            .lock()
            .await
            .subs
            .insert(key, Analyser { stream_id, task });

        // Acknowledge per the protocol.
        emit(
            &state,
            Event::SpectrumSubscribed {
                target,
                applied: applied.clone(),
            },
        );
        Ok(applied)
    }

    pub async fn unsubscribe(
        &self,
        state: Arc<AppState>,
        backend: Arc<dyn Backend>,
        target: SpectrumTarget,
    ) {
        let key = target.slug();
        let prev = self.inner.lock().await.subs.remove(&key);
        if let Some(prev) = prev {
            prev.task.abort();
            let b = backend.clone();
            let sid = prev.stream_id;
            tokio::spawn(async move {
                let _ = b.close_egress(sid).await;
            });
        }
        emit(
            &state,
            Event::SpectrumUnsubscribed {
                target,
                reason: None,
            },
        );
    }

    /// Best-effort one-shot snapshot. Opens an egress, waits for a
    /// single frame, closes. Used by the agent's `spectrum.snapshot`
    /// path when the backend's own snapshot returned Unsupported.
    #[allow(dead_code)]
    pub async fn snapshot(
        &self,
        backend: Arc<dyn Backend>,
        target: SpectrumTarget,
        opts: SpectrumOpts,
        sample_rate: u32,
    ) -> Result<SpectrumFrame, String> {
        let applied = clamp_opts(&opts);
        let stream_id = {
            let mut guard = self.inner.lock().await;
            let id = guard.next_stream_id;
            guard.next_stream_id = guard.next_stream_id.wrapping_add(1);
            id
        };
        let source = match &target {
            SpectrumTarget::Master => AudioSource::Master,
            SpectrumTarget::Monitor => AudioSource::Monitor,
            SpectrumTarget::Track { id } => AudioSource::Track { id: id.clone() },
        };
        let format = AudioFormat {
            sample_rate,
            channels: 2,
            format: SampleFormat::F32Le,
            frame_size: 960,
            codec: AudioCodec::RawF32Le,
        };
        let mut rx = backend
            .open_egress(stream_id, source, format)
            .await
            .map_err(|e| format!("open_egress failed: {e}"))?;
        let mut accum: Vec<Vec<f32>> = Vec::new(); // [channel][samples]
        let want_samples = applied.fft_size as usize;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        let snapshot_channels = format.channels.max(1) as usize;
        while accum.first().map(|c| c.len()).unwrap_or(0) < want_samples {
            let timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
            if timeout.is_zero() {
                break;
            }
            let frame = match tokio::time::timeout(timeout, rx.recv()).await {
                Ok(Some(f)) => f,
                _ => break,
            };
            push_frame(&frame, &mut accum, applied.per_channel, snapshot_channels);
        }
        let _ = backend.close_egress(stream_id).await;
        let frame = build_frame(&accum, &target, &applied, sample_rate);
        Ok(frame)
    }

    /// "Instant" capture: drive transport to `at_samples`, briefly
    /// play, capture exactly one FFT window worth, then restore the
    /// previous transport state. Optionally mute the master bus during
    /// capture so the user (and any other connected clients) don't
    /// hear the scrub. Use this when the agent wants to answer
    /// "what's the spectrum at time T?" without requiring the user
    /// to drive playback themselves.
    ///
    /// Multi-client caveat: this MUTATES shared session state for the
    /// duration of the capture (position + playing + master mute).
    /// Other connected clients WILL see playback move. Callers
    /// (agent tool) should warn the user when they invoke this; the
    /// underlying mechanism is unavoidable until backends expose
    /// offline bounce.
    #[allow(clippy::too_many_arguments)]
    pub async fn capture_at(
        &self,
        backend: Arc<dyn Backend>,
        target: SpectrumTarget,
        opts: SpectrumOpts,
        at_samples: u64,
        sample_rate: u32,
        mute_master: bool,
    ) -> Result<SpectrumFrame, String> {
        capture_window(
            &backend,
            target,
            opts,
            at_samples,
            at_samples, // single FFT window — let run_capture grab one frame
            0.0,
            sample_rate,
            mute_master,
        )
        .await
    }

    /// "Time-slice" capture: drive transport from `start_samples`
    /// through `end_samples`, accumulating FFT hops along the way
    /// with exponential-moving-average smoothing (`decay` in
    /// 0.0..=1.0; 0.0 = each hop overwrites, ~0.85 = strong
    /// smoothing). Returns the final aggregated frame. Same
    /// transport-mutation caveat as `capture_at`.
    #[allow(clippy::too_many_arguments)]
    pub async fn capture_window(
        &self,
        backend: Arc<dyn Backend>,
        target: SpectrumTarget,
        opts: SpectrumOpts,
        start_samples: u64,
        end_samples: u64,
        decay: f32,
        sample_rate: u32,
        mute_master: bool,
    ) -> Result<SpectrumFrame, String> {
        capture_window(
            &backend,
            target,
            opts,
            start_samples,
            end_samples,
            decay,
            sample_rate,
            mute_master,
        )
        .await
    }
}

/// Snapshot the controls we mutate, locate transport to `start`,
/// optionally mute the master, play, accumulate FFT bins from the
/// egress until `end` is reached (or we time out), then stop and
/// restore everything. Returns the aggregated frame. `decay == 0`
/// means "one FFT window, no smoothing" (used by capture_at).
#[allow(clippy::too_many_arguments)]
async fn capture_window(
    backend: &Arc<dyn Backend>,
    target: SpectrumTarget,
    opts: SpectrumOpts,
    start_samples: u64,
    end_samples: u64,
    decay: f32,
    sample_rate: u32,
    mute_master: bool,
) -> Result<SpectrumFrame, String> {
    let applied = clamp_opts(&opts);
    let snap = backend
        .snapshot()
        .await
        .map_err(|e| format!("snapshot failed: {e}"))?;
    let prev_position = snap.transport.position_beats.value.as_f64().unwrap_or(0.0) as i64;
    let prev_playing = matches!(snap.transport.playing.value, ControlValue::Bool(true));
    let transport_pos_id = snap.transport.position_beats.id.clone();
    let transport_play_id = snap.transport.playing.id.clone();
    let master = snap
        .tracks
        .iter()
        .find(|t| matches!(t.kind, TrackKind::Master));
    let master_mute_id = master.map(|t| t.mute.id.clone());
    let prev_master_mute = master.map(|t| matches!(t.mute.value, ControlValue::Bool(true)));
    let snapshot_channels = 2_usize;

    // ── Save state implicitly captured above; mutate forward.
    if mute_master {
        if let (Some(id), Some(false)) = (&master_mute_id, prev_master_mute) {
            let _ = backend
                .set_control(id.clone(), ControlValue::Bool(true))
                .await;
        }
    }
    let _ = backend
        .set_control(
            transport_pos_id.clone(),
            ControlValue::Int(start_samples as i64),
        )
        .await;
    // Give the shim a tick to actually locate before we start the egress.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let _ = backend
        .set_control(transport_play_id.clone(), ControlValue::Bool(true))
        .await;

    // ── Capture loop.
    let result = run_capture_loop(
        backend.clone(),
        target.clone(),
        applied.clone(),
        start_samples,
        end_samples,
        decay,
        sample_rate,
        snapshot_channels,
    )
    .await;

    // ── Restore state, best-effort. Order matters: stop first so the
    // remaining frames in the egress don't bleed into anything.
    let _ = backend
        .set_control(transport_play_id, ControlValue::Bool(prev_playing))
        .await;
    let _ = backend
        .set_control(transport_pos_id, ControlValue::Int(prev_position))
        .await;
    if mute_master {
        if let (Some(id), Some(prev)) = (master_mute_id, prev_master_mute) {
            let _ = backend.set_control(id, ControlValue::Bool(prev)).await;
        }
    }
    result
}

/// Run the actual FFT-accumulation loop against an egress. Pulled out
/// of `capture_window` so the restore-state block always runs even
/// when an FFT step errors.
#[allow(clippy::too_many_arguments)]
async fn run_capture_loop(
    backend: Arc<dyn Backend>,
    target: SpectrumTarget,
    opts: SpectrumOpts,
    start_samples: u64,
    end_samples: u64,
    decay: f32,
    sample_rate: u32,
    snapshot_channels: usize,
) -> Result<SpectrumFrame, String> {
    let stream_id = {
        // Use the same id pattern as snapshot — a one-shot id is fine.
        STREAM_ID_BASE
            .wrapping_add(0xCAFE)
            .wrapping_add(start_samples as u32)
    };
    let format = AudioFormat {
        sample_rate,
        channels: 2,
        format: SampleFormat::F32Le,
        frame_size: 960,
        codec: AudioCodec::RawF32Le,
    };
    let source = match &target {
        SpectrumTarget::Master => AudioSource::Master,
        SpectrumTarget::Monitor => AudioSource::Monitor,
        SpectrumTarget::Track { id } => AudioSource::Track { id: id.clone() },
    };
    let mut rx = backend
        .open_egress(stream_id, source, format)
        .await
        .map_err(|e| format!("open_egress failed: {e}"))?;

    let want_samples = opts.fft_size as usize;
    let span_samples = end_samples
        .saturating_sub(start_samples)
        .max(want_samples as u64);
    // 1 s of safety margin past the span so we don't truncate the
    // final FFT window when transport drifts a few ms.
    let deadline_ms = ((span_samples as f64 / sample_rate as f64) * 1000.0) as u64 + 1000;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(deadline_ms.max(2000));

    // Aggregator state: one EMA buffer per channel + bin (built lazily).
    let mut ema: Option<SpectrumFrame> = None;
    let mut accum: Vec<Vec<f32>> = Vec::new();
    let alpha = decay.clamp(0.0, 0.999) as f64;

    while tokio::time::Instant::now() < deadline {
        let frame = match tokio::time::timeout(
            deadline.saturating_duration_since(tokio::time::Instant::now()),
            rx.recv(),
        )
        .await
        {
            Ok(Some(f)) => f,
            _ => break,
        };
        push_frame(&frame, &mut accum, opts.per_channel, snapshot_channels);
        // Drain full FFT windows until the buffers shrink below want_samples.
        while accum
            .first()
            .map(|c| c.len() >= want_samples)
            .unwrap_or(false)
        {
            let next = build_frame(&accum, &target, &opts, sample_rate);
            ema = Some(blend_frames(ema.as_ref(), &next, alpha));
            // For pure "instant" mode (decay=0), one window is enough.
            if alpha == 0.0 {
                let _ = backend.close_egress(stream_id).await;
                return ema.ok_or_else(|| "no frames captured".into());
            }
            // Hop by half the window for time-slice averaging.
            let hop = want_samples / 2;
            for ch in accum.iter_mut() {
                ch.drain(..hop.min(ch.len()));
            }
        }
    }
    let _ = backend.close_egress(stream_id).await;
    ema.ok_or_else(|| {
        "no spectrum frames received during capture (is the backend producing audio?)".into()
    })
}

/// Exponential-moving-average bin merge: `prev = alpha * prev + (1-alpha) * next`.
/// alpha=0 means "use next as-is"; alpha→1 means "ignore next".
fn blend_frames(prev: Option<&SpectrumFrame>, next: &SpectrumFrame, alpha: f64) -> SpectrumFrame {
    let Some(prev) = prev else {
        return next.clone();
    };
    if prev.channels.len() != next.channels.len() {
        return next.clone();
    }
    let mut out = next.clone();
    for (cdst, csrc_prev) in out.channels.iter_mut().zip(prev.channels.iter()) {
        if cdst.magnitudes_db.len() != csrc_prev.magnitudes_db.len() {
            continue;
        }
        for (b, p) in cdst
            .magnitudes_db
            .iter_mut()
            .zip(csrc_prev.magnitudes_db.iter())
        {
            *b = (alpha * (*p as f64) + (1.0 - alpha) * (*b as f64)) as f32;
        }
    }
    out
}

/// Wrap a body in an envelope and ship it through the broadcast tx.
/// Mirrors the inline `state.envelope(...)` + `state.tx.send(...)`
/// pattern used in ws.rs.
fn emit(state: &AppState, body: Event) {
    let env = state.envelope(body, None);
    let _ = state.tx.send(env);
}

fn clamp_opts(opts: &SpectrumOpts) -> SpectrumOpts {
    let mut o = opts.clone();
    o.fft_size = o.fft_size.clamp(256, 16384).next_power_of_two().min(16384);
    if let Some(h) = o.hop_size {
        o.hop_size = Some(h.clamp(64, o.fft_size));
    }
    if !o.min_db.is_finite() || o.min_db > -10.0 {
        o.min_db = -100.0;
    }
    if o.min_db < -160.0 {
        o.min_db = -160.0;
    }
    if let Some(b) = o.max_bins {
        o.max_bins = Some(b.clamp(16, o.fft_size / 2));
    }
    o
}

async fn run_analyser(
    mut rx: foyer_backend::PcmRx,
    state: Arc<AppState>,
    target: SpectrumTarget,
    opts: SpectrumOpts,
    sample_rate: u32,
    channels: usize,
) {
    // Per-channel sample ring. We use a Vec<Vec<f32>> drained at hop
    // boundaries — simple and the fft sizes we care about (2k–8k)
    // are small enough that reallocating per hop isn't measurable.
    let mut accum: Vec<Vec<f32>> = Vec::new();
    let want_samples = opts.fft_size as usize;
    let hop = opts
        .hop_size
        .map(|h| h as usize)
        .unwrap_or(want_samples / 2)
        .max(1);
    while let Some(frame) = rx.recv().await {
        push_frame(&frame, &mut accum, opts.per_channel, channels);
        while accum.first().map(|c| c.len()).unwrap_or(0) >= want_samples {
            let out = build_frame(&accum, &target, &opts, sample_rate);
            emit(
                &state,
                Event::SpectrumFrame {
                    frame: Box::new(out),
                },
            );
            // Slide the windows forward by `hop` samples per channel.
            for ch in accum.iter_mut() {
                ch.drain(..hop.min(ch.len()));
            }
        }
    }
}

fn push_frame(frame: &PcmFrame, accum: &mut Vec<Vec<f32>>, per_channel: bool, channels: usize) {
    let channels = channels.max(1);
    let interleaved = &frame.samples;
    let target_channels = if per_channel { channels } else { 1 };
    if accum.len() < target_channels {
        accum.resize(target_channels, Vec::new());
    }
    if per_channel {
        for i in 0..interleaved.len() / channels {
            for ch in 0..channels {
                let s = interleaved[i * channels + ch];
                if let Some(buf) = accum.get_mut(ch) {
                    buf.push(s);
                }
            }
        }
    } else {
        // Mono fold.
        for i in 0..interleaved.len() / channels {
            let mut sum = 0.0f32;
            for ch in 0..channels {
                sum += interleaved[i * channels + ch];
            }
            accum[0].push(sum / channels as f32);
        }
    }
}

fn build_frame(
    accum: &[Vec<f32>],
    target: &SpectrumTarget,
    opts: &SpectrumOpts,
    sample_rate: u32,
) -> SpectrumFrame {
    let fft_size = opts.fft_size as usize;
    let bin_count = opts
        .max_bins
        .map(|b| b as usize)
        .unwrap_or(fft_size / 2)
        .max(16)
        .min(fft_size / 2);
    let window = window_coeffs(fft_size, opts.window);
    let mut channels = Vec::with_capacity(accum.len().max(1));
    for (ch_idx, samples) in accum.iter().enumerate() {
        // Pad with zeros if we don't have a full FFT window yet (used
        // by the one-shot snapshot path).
        let mut buf: Vec<f32> = samples.iter().take(fft_size).copied().collect();
        if buf.len() < fft_size {
            buf.resize(fft_size, 0.0);
        }
        for (i, w) in window.iter().enumerate() {
            buf[i] *= *w;
        }
        let mags = fft_magnitudes_db(&buf, bin_count, opts.min_db);
        channels.push(SpectrumChannel {
            channel: ch_idx as u16,
            magnitudes_db: mags,
        });
    }
    SpectrumFrame {
        target: target.clone(),
        bins: bin_count as u32,
        sample_rate,
        window: opts.window,
        min_db: opts.min_db,
        channels,
        server_mono_ns: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0),
    }
}

fn window_coeffs(n: usize, window: SpectrumWindow) -> Vec<f32> {
    let mut out = Vec::with_capacity(n);
    let nm1 = (n - 1).max(1) as f32;
    for i in 0..n {
        let x = i as f32 / nm1;
        let w = match window {
            SpectrumWindow::Hann => 0.5 - 0.5 * (2.0 * std::f32::consts::PI * x).cos(),
            SpectrumWindow::Hamming => 0.54 - 0.46 * (2.0 * std::f32::consts::PI * x).cos(),
            SpectrumWindow::BlackmanHarris => {
                0.35875 - 0.48829 * (2.0 * std::f32::consts::PI * x).cos()
                    + 0.14128 * (4.0 * std::f32::consts::PI * x).cos()
                    - 0.01168 * (6.0 * std::f32::consts::PI * x).cos()
            }
            SpectrumWindow::Rectangular => 1.0,
        };
        out.push(w);
    }
    out
}

/// Compute |FFT|² → dBFS magnitudes for `bin_count` linearly-spaced
/// bins from DC to Nyquist. Uses an inline Cooley–Tukey iterative FFT;
/// `samples.len()` must be a power of two and matches `fft_size`.
fn fft_magnitudes_db(samples: &[f32], bin_count: usize, min_db: f32) -> Vec<f32> {
    let n = samples.len();
    // FFT input as complex.
    let mut re: Vec<f32> = samples.to_vec();
    let mut im: Vec<f32> = vec![0.0; n];
    fft_in_place(&mut re, &mut im);
    // Magnitude bins from 0..n/2 (the non-redundant half), down-
    // sampled (or pass-through) to bin_count entries.
    let nyquist_bins = n / 2;
    let scale = 1.0 / (n as f32);
    let mut bins_full: Vec<f32> = Vec::with_capacity(nyquist_bins);
    for k in 0..nyquist_bins {
        let r = re[k];
        let i = im[k];
        let mag2 = (r * r + i * i) * scale * scale;
        // dBFS: 10 log10(mag²) since mag is already |FFT|/N.
        let db = 10.0 * (mag2.max(1e-12)).log10();
        bins_full.push(db);
    }
    // Resample bins_full → bin_count using a peak-hold over each
    // sub-range (so small narrow peaks don't get averaged away).
    let mut out = Vec::with_capacity(bin_count);
    if bin_count == nyquist_bins {
        out = bins_full;
    } else {
        for j in 0..bin_count {
            let start = (j * nyquist_bins) / bin_count;
            let end = ((j + 1) * nyquist_bins) / bin_count;
            let end = end.max(start + 1).min(nyquist_bins);
            let mut peak = min_db;
            for v in &bins_full[start..end] {
                if *v > peak {
                    peak = *v;
                }
            }
            out.push(peak);
        }
    }
    for v in out.iter_mut() {
        if !v.is_finite() {
            *v = min_db;
        }
        if *v < min_db {
            *v = min_db;
        }
        if *v > 0.0 {
            *v = 0.0;
        }
    }
    out
}

/// Iterative Cooley–Tukey radix-2 FFT, in place. `re.len()` must be a
/// power of two and equal to `im.len()`. No external deps; the work
/// for the spectrum sizes we use (256..16k) runs in well under a
/// millisecond.
fn fft_in_place(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    debug_assert_eq!(n, im.len());
    debug_assert!(n.is_power_of_two());
    if n <= 1 {
        return;
    }
    // Bit reversal permutation.
    let bits = n.trailing_zeros();
    for i in 0..n {
        let j = (i as u32).reverse_bits() >> (32 - bits);
        let j = j as usize;
        if j > i {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    // Butterflies.
    let mut size = 2usize;
    while size <= n {
        let half = size / 2;
        let theta = -2.0 * std::f32::consts::PI / size as f32;
        let w_re_step = theta.cos();
        let w_im_step = theta.sin();
        let mut start = 0;
        while start < n {
            let mut w_re = 1.0f32;
            let mut w_im = 0.0f32;
            for k in 0..half {
                let i = start + k;
                let j = i + half;
                let t_re = w_re * re[j] - w_im * im[j];
                let t_im = w_re * im[j] + w_im * re[j];
                let u_re = re[i];
                let u_im = im[i];
                re[i] = u_re + t_re;
                im[i] = u_im + t_im;
                re[j] = u_re - t_re;
                im[j] = u_im - t_im;
                // w *= step
                let new_w_re = w_re * w_re_step - w_im * w_im_step;
                let new_w_im = w_re * w_im_step + w_im * w_re_step;
                w_re = new_w_re;
                w_im = new_w_im;
            }
            start += size;
        }
        size *= 2;
    }
}

// `EntityId` is currently unused but reserved for per-track target
// resolution; keep the import explicit so future track-specific
// analyser work doesn't trip a "missing import" warning.
#[allow(dead_code)]
fn _unused_id(_: EntityId) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fft_matches_simple_sine_peak() {
        // 1024-sample sine at bin 100. Confirm the FFT picks it up
        // there as the dominant magnitude bin.
        let n = 1024usize;
        let mut re: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * 100.0 * i as f32 / n as f32).sin())
            .collect();
        let mut im = vec![0.0f32; n];
        fft_in_place(&mut re, &mut im);
        let mut best_bin = 0;
        let mut best_mag = 0.0f32;
        for k in 0..n / 2 {
            let m = (re[k] * re[k] + im[k] * im[k]).sqrt();
            if m > best_mag {
                best_mag = m;
                best_bin = k;
            }
        }
        assert_eq!(best_bin, 100);
    }

    #[test]
    fn clamp_keeps_fft_size_in_bounds() {
        let opts = SpectrumOpts {
            fft_size: 100,
            ..Default::default()
        };
        assert_eq!(clamp_opts(&opts).fft_size, 256);
        let opts = SpectrumOpts {
            fft_size: 50_000,
            ..Default::default()
        };
        assert_eq!(clamp_opts(&opts).fft_size, 16384);
        let opts = SpectrumOpts {
            fft_size: 1500,
            ..Default::default()
        };
        // 1500 → power-of-2 → 2048
        assert_eq!(clamp_opts(&opts).fft_size, 2048);
    }
}
