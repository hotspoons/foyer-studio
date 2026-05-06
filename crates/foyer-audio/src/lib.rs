//! Utilities for Foyer audio paths (ingress / egress). Keeps rubato usage
//! localized so `foyer-server` stays thin.
//!
//! [`InterleavedResampler::nudge_ratio_relative`] exposes rubato's runtime
//! ratio adjustment so the egress encoder can compensate for slow drift
//! between the engine's audio clock and the browser's `AudioContext` clock
//! (10–50 ppm of crystal skew accumulates to seconds over a long session).
//! See `crates/foyer-server/src/audio.rs` for how the egress encoder
//! consumes browser-side buffer-level feedback to drive the loop.

use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

/// Fixed input chunk size per channel passed to [`rubato::SincFixedIn`]. Larger
/// values reduce overhead; 1024 frames ≈ 21 ms @ 48 kHz.
const DEFAULT_CHUNK_FRAMES: usize = 1024;

fn sinc_params() -> SincInterpolationParameters {
    SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    }
}

/// Multi-channel f32 resampler for **interleaved** PCM (`[L0,R0,L1,R1,…]`).
///
/// When input and output rates match, construct nothing — this type is only for
/// mismatched rates.
pub struct InterleavedResampler {
    inner: SincFixedIn<f32>,
    channels: usize,
    pending: Vec<f32>,
    chunk_frames: usize,
    /// Nominal ratio (out_hz / in_hz). `nudge_ratio_relative`
    /// multiplies this by a small factor; we keep both the base and
    /// the current multiplicative offset so successive nudges
    /// compose instead of overwriting.
    base_ratio: f64,
    /// Current multiplicative offset applied to `base_ratio`. 1.0 =
    /// nominal. Drifts a few hundred ppm in steady state on a
    /// long-running stream as the controller absorbs clock skew.
    current_relative: f64,
}

impl InterleavedResampler {
    /// `in_hz` / `out_hz` are sample rates; `channels` is the interleaved channel count.
    pub fn new(in_hz: u32, out_hz: u32, channels: u16) -> Result<Self, String> {
        if in_hz == 0 || out_hz == 0 || channels == 0 {
            return Err("resampler: invalid rate or zero channels".into());
        }
        if in_hz == out_hz {
            return Err("resampler: equal rates — bypass instead".into());
        }
        let channels = usize::from(channels);
        let ratio = f64::from(out_hz) / f64::from(in_hz);
        // `max_resample_ratio_relative = 2.0` means runtime nudges
        // can swing the actual ratio between `ratio / 2.0` and
        // `ratio * 2.0`. Drift compensation only ever needs ±100
        // ppm — we pick 2.0 because rubato uses it to size internal
        // buffers and a tiny window (e.g. 1.001) would make even
        // generous safety margins refuse the next nudge. The cost
        // is a one-time allocation, not a per-sample cost.
        let inner =
            SincFixedIn::<f32>::new(ratio, 2.0, sinc_params(), DEFAULT_CHUNK_FRAMES, channels)
                .map_err(|e| format!("rubato init: {e}"))?;
        Ok(Self {
            inner,
            channels,
            pending: Vec::new(),
            chunk_frames: DEFAULT_CHUNK_FRAMES,
            base_ratio: ratio,
            current_relative: 1.0,
        })
    }

    /// Multiply the resample ratio by `(1.0 + delta_ppm * 1e-6)`.
    /// `delta_ppm` is signed and CUMULATIVE — pass +1.0 to nudge a
    /// hair faster than nominal, −1.0 to nudge slower; clamped so
    /// the ratio stays inside the headroom set in `new()`.
    /// The ramp boolean smooths the transition over the next
    /// rubato chunk (~21 ms @ 48 kHz) instead of a hard step.
    ///
    /// Returns the absolute ratio in effect after the nudge, in
    /// case the caller wants to log the trajectory.
    pub fn nudge_ratio_relative(&mut self, delta_ppm: f64) -> f32 {
        // Clamp to ±1000 ppm per call so a buggy controller can't
        // make the audio sound like a tape player after one tick.
        // Real-world steady-state corrections are <50 ppm.
        let clamped = delta_ppm.clamp(-1000.0, 1000.0);
        let next_relative = (self.current_relative * (1.0 + clamped * 1e-6)).clamp(0.5, 2.0);
        self.current_relative = next_relative;
        let _ = self.inner.set_resample_ratio_relative(next_relative, true);
        (self.base_ratio * next_relative) as f32
    }

    /// Current effective ratio (base × current relative nudge).
    /// Useful for diagnostics + the watchdog's drift-rate calculation.
    pub fn current_ratio(&self) -> f64 {
        self.base_ratio * self.current_relative
    }

    /// Push interleaved samples; returns **all** output produced (interleaved).
    /// Partial input is buffered until a full rubato chunk is available.
    #[allow(clippy::needless_range_loop)]
    pub fn push(&mut self, interleaved: &[f32]) -> Result<Vec<f32>, String> {
        self.pending.extend_from_slice(interleaved);
        let ch = self.channels;
        let need = self.chunk_frames * ch;
        let mut out_all = Vec::new();
        while self.pending.len() >= need {
            let chunk: Vec<f32> = self.pending.drain(..need).collect();
            let waves_in: Vec<Vec<f32>> = (0..ch)
                .map(|ci| {
                    chunk
                        .iter()
                        .skip(ci)
                        .step_by(ch)
                        .copied()
                        .collect::<Vec<f32>>()
                })
                .collect();
            let waves_out = self
                .inner
                .process(&waves_in, None)
                .map_err(|e| format!("rubato process: {e}"))?;
            if waves_out.is_empty() {
                continue;
            }
            let frames = waves_out[0].len();
            for wi in &waves_out {
                if wi.len() != frames {
                    return Err("rubato: mismatched channel lengths".into());
                }
            }
            for fi in 0..frames {
                for ci in 0..ch {
                    out_all.push(waves_out[ci][fi]);
                }
            }
        }
        Ok(out_all)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_48k_to_96k() {
        let mut r = InterleavedResampler::new(48_000, 96_000, 1).unwrap();
        let sil = vec![0.0_f32; DEFAULT_CHUNK_FRAMES];
        let out = r.push(&sil).unwrap();
        assert!(out.len() >= DEFAULT_CHUNK_FRAMES);
        let peak = out.iter().map(|s| s.abs()).fold(0.0_f32, f32::max);
        assert!(peak < 1e-6);
    }

    #[test]
    fn nudge_ratio_composes() {
        let mut r = InterleavedResampler::new(48_000, 44_100, 1).unwrap();
        let base = r.current_ratio();
        // +100 ppm three times → effective ratio ≈ base × 1.0003.
        for _ in 0..3 {
            r.nudge_ratio_relative(100.0);
        }
        let after = r.current_ratio();
        assert!(after > base);
        assert!((after / base - 1.0).abs() < 5e-4);
        // Reverse direction.
        for _ in 0..3 {
            r.nudge_ratio_relative(-100.0);
        }
        let back = r.current_ratio();
        assert!((back - base).abs() / base < 1e-6);
    }
}
