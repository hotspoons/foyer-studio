//! Utilities for Foyer audio paths (ingress / egress). Keeps rubato usage
//! localized so `foyer-server` stays thin.

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
        let inner =
            SincFixedIn::<f32>::new(ratio, 2.0, sinc_params(), DEFAULT_CHUNK_FRAMES, channels)
                .map_err(|e| format!("rubato init: {e}"))?;
        Ok(Self {
            inner,
            channels,
            pending: Vec::new(),
            chunk_frames: DEFAULT_CHUNK_FRAMES,
        })
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
}
