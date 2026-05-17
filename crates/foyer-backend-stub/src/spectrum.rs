//! Synthesised spectrum frames for the stub backend.
//!
//! Real shims compute FFTs over the engine's audio buffers. The stub
//! has no audio engine, so it fabricates plausible frames that change
//! over time: a few sine peaks (the "track tones") plus pink noise.
//! Enough variation that demos, screenshots, and the Playwright spec
//! see a realistic-looking spectrogram waterfall — not a flat line.
//!
//! Per-track variation: each track gets a deterministic tone-pitch
//! derived from its id hash, so a session with multiple tracks
//! produces visibly distinct spectra. Master/monitor sum the tracks.

use std::sync::Arc;
use std::time::{Duration, Instant};

use foyer_schema::{
    Event, SpectrumChannel, SpectrumFrame, SpectrumOpts, SpectrumTarget, SpectrumWindow,
};
use tokio::sync::{broadcast, Mutex};

use crate::state::StubState;

/// One active subscription. The producer task reads this list every
/// hop and emits a `SpectrumFrame` per entry.
pub struct Subscription {
    pub target: SpectrumTarget,
    pub opts: SpectrumOpts,
    /// When the subscription was opened — drives phase / sweep in the
    /// synthesised data so successive frames aren't identical.
    pub started: Instant,
}

/// Registry of active subscriptions plus the background task that
/// produces frames. Cheap to share — the task only runs while there's
/// at least one active subscription.
#[derive(Clone)]
pub struct SpectrumHub {
    inner: Arc<Mutex<HubInner>>,
}

struct HubInner {
    subs: Vec<Subscription>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl SpectrumHub {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HubInner {
                subs: Vec::new(),
                task: None,
            })),
        }
    }

    /// Add a subscription. Returns the clamped opts the producer will
    /// actually use. Spawns the producer task if it wasn't running.
    pub async fn subscribe(
        &self,
        target: SpectrumTarget,
        opts: SpectrumOpts,
        tx: broadcast::Sender<Event>,
        state: Arc<Mutex<StubState>>,
        sample_rate: u32,
    ) -> SpectrumOpts {
        let clamped = clamp_opts(&opts);
        let mut guard = self.inner.lock().await;
        // Replace existing subscription on the same target so a
        // second subscribe with different opts wins.
        guard.subs.retain(|s| s.target != target);
        guard.subs.push(Subscription {
            target: target.clone(),
            opts: clamped.clone(),
            started: Instant::now(),
        });
        if guard.task.is_none() {
            let hub = self.clone();
            let tx = tx.clone();
            let state = state.clone();
            guard.task = Some(tokio::spawn(producer_task(hub, tx, state, sample_rate)));
        }
        drop(guard);
        // Acknowledge.
        let _ = tx.send(Event::SpectrumSubscribed {
            target,
            applied: clamped.clone(),
        });
        clamped
    }

    /// Remove a subscription. If no subscriptions remain, the producer
    /// task winds down naturally (it bails on empty subs).
    pub async fn unsubscribe(&self, target: SpectrumTarget, tx: broadcast::Sender<Event>) {
        let mut guard = self.inner.lock().await;
        guard.subs.retain(|s| s.target != target);
        if guard.subs.is_empty() {
            if let Some(handle) = guard.task.take() {
                handle.abort();
            }
        }
        drop(guard);
        let _ = tx.send(Event::SpectrumUnsubscribed {
            target,
            reason: None,
        });
    }

    /// Synthesize a one-shot frame for the snapshot path. Doesn't open
    /// a subscription, doesn't emit any events.
    pub async fn snapshot(
        &self,
        target: SpectrumTarget,
        opts: SpectrumOpts,
        state: &Arc<Mutex<StubState>>,
        sample_rate: u32,
    ) -> SpectrumFrame {
        let opts = clamp_opts(&opts);
        let tracks = collect_track_seeds(state).await;
        synthesise_frame(&target, &opts, sample_rate, &tracks, 0.0)
    }
}

impl Default for SpectrumHub {
    fn default() -> Self {
        Self::new()
    }
}

/// Per-track seed: an id-derived tone in Hz + an amplitude factor.
/// Computed once per producer iteration so adding tracks mid-stream
/// shows up on the spectrum.
#[derive(Clone, Copy)]
struct TrackSeed {
    track_hash: u64,
    /// Linear gain inferred from the track's `gain.db` control.
    /// `1.0` = unity. Muted/unset tracks contribute 0.
    gain_linear: f32,
}

async fn collect_track_seeds(state: &Arc<Mutex<StubState>>) -> Vec<TrackSeed> {
    let session = state.lock().await.session_clone();
    let mut out = Vec::with_capacity(session.tracks.len());
    for t in &session.tracks {
        let mut hash: u64 = 1469598103934665603;
        for b in t.id.as_str().bytes() {
            hash ^= u64::from(b);
            hash = hash.wrapping_mul(1099511628211);
        }
        // The Track struct carries gain/mute as `Parameter`s with the
        // current value embedded — pull them straight off rather than
        // walking a `controls` map.
        let gain_db = t.gain.value.as_f64().unwrap_or(0.0);
        // Bool-ish: anything that's >=0.5 in float form. as_f64 maps
        // Bool(true) → 1.0 already so this catches both wire shapes.
        let muted = t.mute.value.as_f64().unwrap_or(0.0) >= 0.5;
        let gain_linear = if muted {
            0.0
        } else {
            10f32.powf((gain_db / 20.0) as f32)
        };
        out.push(TrackSeed {
            track_hash: hash,
            gain_linear,
        });
    }
    out
}

async fn producer_task(
    hub: SpectrumHub,
    tx: broadcast::Sender<Event>,
    state: Arc<Mutex<StubState>>,
    sample_rate: u32,
) {
    // 50 Hz default — fast enough for a smooth waterfall, slow enough
    // to keep the WS quiet. Subscription's `fft_size / hop_size`
    // ratio drives the perceived rate; we just tick at 20 ms here.
    let mut ticker = tokio::time::interval(Duration::from_millis(20));
    loop {
        ticker.tick().await;
        let tracks = collect_track_seeds(&state).await;
        let subs: Vec<Subscription> = {
            let guard = hub.inner.lock().await;
            if guard.subs.is_empty() {
                return;
            }
            // Clone the entries so we don't hold the lock during the
            // (potentially many) frame emits below.
            guard
                .subs
                .iter()
                .map(|s| Subscription {
                    target: s.target.clone(),
                    opts: s.opts.clone(),
                    started: s.started,
                })
                .collect()
        };
        for sub in &subs {
            let elapsed_secs = sub.started.elapsed().as_secs_f32();
            let frame =
                synthesise_frame(&sub.target, &sub.opts, sample_rate, &tracks, elapsed_secs);
            let _ = tx.send(Event::SpectrumFrame {
                frame: Box::new(frame),
            });
        }
    }
}

fn clamp_opts(opts: &SpectrumOpts) -> SpectrumOpts {
    let mut clamped = opts.clone();
    // FFT size — power of two between 256 and 16384.
    let n = clamped.fft_size.clamp(256, 16384);
    clamped.fft_size = n.next_power_of_two().min(16384);
    if let Some(h) = clamped.hop_size {
        clamped.hop_size = Some(h.clamp(64, clamped.fft_size));
    }
    if clamped.min_db.is_nan() || clamped.min_db > -10.0 {
        clamped.min_db = -100.0;
    }
    if clamped.min_db < -160.0 {
        clamped.min_db = -160.0;
    }
    if let Some(b) = clamped.max_bins {
        clamped.max_bins = Some(b.clamp(16, clamped.fft_size / 2));
    }
    clamped
}

/// Plausible-looking synthesised frame. The shape:
///   - "pink-ish" noise floor that slowly modulates over time.
///   - One peak per track at a id-hash-derived frequency, attenuated
///     by the track's gain. The peak slowly sweeps so the waterfall
///     shows visible motion.
///   - Per-channel: channel 0 gets the raw mix, channel 1 (if
///     `per_channel`) gets a slightly-detuned variant for stereo
///     interest.
fn synthesise_frame(
    target: &SpectrumTarget,
    opts: &SpectrumOpts,
    sample_rate: u32,
    tracks: &[TrackSeed],
    elapsed_secs: f32,
) -> SpectrumFrame {
    let bins = opts
        .max_bins
        .unwrap_or(opts.fft_size / 2)
        .max(16)
        .min(opts.fft_size / 2);
    let nyquist = sample_rate as f32 / 2.0;
    let bin_hz = nyquist / bins as f32;
    let min_db = opts.min_db;
    let channel_count: u16 = if opts.per_channel { 2 } else { 1 };

    // Filter tracks based on target. For master/monitor we sum every
    // track; for Track{id} we only render that one.
    let target_filter: Option<usize> = match target {
        SpectrumTarget::Master | SpectrumTarget::Monitor => None,
        SpectrumTarget::Track { id } => tracks
            .iter()
            .enumerate()
            .find(|(_, t)| {
                // Same fnv hash — we don't have the id string handy
                // here, but the caller already filtered the seed list
                // by hash matching, so we just always use the first
                // matching seed. To keep it simple, treat Track as
                // "render all but downscale" — the FE never asks for
                // a specific id in the stub fixtures anyway.
                let mut h: u64 = 1469598103934665603;
                for b in id.as_str().bytes() {
                    h ^= u64::from(b);
                    h = h.wrapping_mul(1099511628211);
                }
                h == t.track_hash
            })
            .map(|(i, _)| i),
    };

    let mut channels = Vec::with_capacity(channel_count as usize);
    for ch in 0..channel_count {
        let detune = if ch == 0 { 1.0 } else { 1.0025 };
        let mut mags = vec![min_db; bins as usize];
        // Pink-ish noise floor: -65 dB at DC, sloping down by 3 dB/oct.
        for (i, m) in mags.iter_mut().enumerate() {
            let hz = (i as f32) * bin_hz + 1.0;
            let oct = (hz / 60.0).log2().max(0.0);
            let floor = -65.0 - 3.0 * oct + (((i as f32 * 0.37) + elapsed_secs * 1.2).sin() * 1.5);
            *m = (*m).max(floor);
        }
        // Track peaks.
        for (i, t) in tracks.iter().enumerate() {
            if let Some(only) = target_filter {
                if i != only {
                    continue;
                }
            }
            if t.gain_linear <= 1e-6 {
                continue;
            }
            // Tone frequency: hash → 80 Hz..6 kHz, slow sweep.
            let base_hz = 80.0 + ((t.track_hash % 5000) as f32) * 1.15;
            let sweep = (elapsed_secs * 0.4 + i as f32 * 0.7).sin() * 30.0;
            let hz = (base_hz + sweep) * detune;
            let bin_f = hz / bin_hz;
            let center = bin_f.round() as i32;
            // Gaussian-ish peak ~3 bins wide.
            for d in -4i32..=4 {
                let b = center + d;
                if b < 0 || (b as u32) >= bins {
                    continue;
                }
                let dist = (bin_f - b as f32).abs();
                let mag_linear = (-(dist * dist) / 2.0).exp() * t.gain_linear;
                let mag_db = 20.0 * mag_linear.max(1e-6).log10();
                let m = mags[b as usize];
                mags[b as usize] = m.max(mag_db.clamp(min_db, 0.0));
            }
        }
        // Clamp + sanitise.
        for m in mags.iter_mut() {
            if !m.is_finite() {
                *m = min_db;
            }
            if *m < min_db {
                *m = min_db;
            }
            if *m > 0.0 {
                *m = 0.0;
            }
        }
        channels.push(SpectrumChannel {
            channel: ch,
            magnitudes_db: mags,
        });
    }

    let window = match opts.window {
        SpectrumWindow::Hann
        | SpectrumWindow::Hamming
        | SpectrumWindow::BlackmanHarris
        | SpectrumWindow::Rectangular => opts.window,
    };

    SpectrumFrame {
        target: target.clone(),
        bins,
        sample_rate,
        window,
        min_db,
        channels,
        server_mono_ns: {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0)
        },
    }
}
