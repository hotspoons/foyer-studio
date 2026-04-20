//! Thin wrapper around `audiopus` that matches the shape
//! [`crate::audio`] needs — one-shot `encode(&[f32]) → Vec<u8>` on a
//! fixed frame size, init errors surfaced cleanly.
//!
//! We deliberately don't expose the full audiopus API — a mixing-surface
//! egress doesn't need FEC, DTX, or bandwidth hinting; the VBR default
//! at 96 kbps is the right knob for interactive monitoring without
//! blowing LAN budgets.

use audiopus::{coder::Encoder as OpusEncoder, Application, Channels, SampleRate, Signal};

/// Wraps an `audiopus::Encoder` configured for our fixed frame shape.
pub struct OpusFrameEncoder {
    inner: OpusEncoder,
    pub frame_size: usize,
    pub channels: u16,
    /// Output buffer scratch space. Opus max packet size is 4000
    /// bytes for a 120 ms frame; 20 ms frames fit in ~1400 bytes
    /// comfortably. 4 KB gives plenty of slack.
    scratch: Vec<u8>,
}

impl OpusFrameEncoder {
    pub fn new(sample_rate: u32, channels: u16, frame_size: usize) -> Result<Self, String> {
        let sr = match sample_rate {
            8_000 => SampleRate::Hz8000,
            12_000 => SampleRate::Hz12000,
            16_000 => SampleRate::Hz16000,
            24_000 => SampleRate::Hz24000,
            48_000 => SampleRate::Hz48000,
            _ => return Err(format!("opus rejects sample rate {sample_rate}")),
        };
        let ch = match channels {
            1 => Channels::Mono,
            2 => Channels::Stereo,
            n => return Err(format!("opus only supports mono/stereo, got {n}")),
        };
        // `Application::LowDelay` disables SILK entirely — the
        // encoder is CELT-only regardless of signal content. This
        // is the actual fix for the "~5 % chance of 440 Hz, ~95 %
        // chance of 220 Hz" flakiness: Opus' SILK mode internally
        // resamples to 8 / 12 / 16 kHz and hits a Chrome decoder
        // bug on strongly-correlated or tonal input that halves
        // pitch AND amplitude. With the default `Application::Audio`
        // libopus freely picks SILK or Hybrid mode for the early
        // frames before its VBR classifier commits to CELT — that's
        // the rare-success pattern Rich observed. `LowDelay` takes
        // that choice away.
        //
        // Previous attempts that did NOT work (documented so we
        // don't retry them):
        //   · `Signal::Music` — just a HINT to the classifier, not
        //     a hard pin.
        //   · `set_force_channels(Stereo)` — only controls whether
        //     packet emits mono-vs-stereo framing; doesn't disable
        //     MS coding within a stereo stream.
        //   · Decorrelating test-tone L/R (0.4 vs 0.39) — worked
        //     for the test tone but real Ardour master audio
        //     routinely has bit-identical channels (center-panned
        //     mono sources) so the decoder bug stayed.
        let mut enc = OpusEncoder::new(sr, ch, Application::LowDelay)
            .map_err(|e| format!("opus encoder init: {e:?}"))?;
        enc.set_signal(Signal::Music)
            .map_err(|e| format!("opus set_signal(Music): {e:?}"))?;
        Ok(Self {
            inner: enc,
            frame_size,
            channels,
            scratch: vec![0u8; 4096],
        })
    }

    /// Encode `pcm` (interleaved, `frame_size * channels` samples)
    /// into an Opus packet. Returns a fresh `Vec<u8>` sized to the
    /// packet. Errors reflect Opus rejecting the input (wrong length,
    /// NaN samples, etc).
    pub fn encode(&mut self, pcm: &[f32]) -> Result<Vec<u8>, String> {
        let expected = self.frame_size * self.channels as usize;
        if pcm.len() != expected {
            return Err(format!(
                "opus encode: expected {expected} samples, got {}",
                pcm.len()
            ));
        }
        let n = self
            .inner
            .encode_float(pcm, &mut self.scratch)
            .map_err(|e| format!("opus encode: {e:?}"))?;
        Ok(self.scratch[..n].to_vec())
    }
}

/// Return the Opus frame size (in samples per channel) for a given
/// sample rate + duration in ms, or `None` if the combination isn't
/// one of Opus's standardized frame sizes.
pub fn encoded_chunk_frame_size(sample_rate: u32, duration_ms: u32) -> Option<usize> {
    // Opus accepts 2.5 / 5 / 10 / 20 / 40 / 60 ms frames at each of
    // its supported sample rates. For simplicity we accept only
    // integer-ms durations. `samples = sr * ms / 1000`.
    let valid_ms = [10u32, 20, 40, 60];
    if !valid_ms.contains(&duration_ms) {
        return None;
    }
    match sample_rate {
        8_000 | 12_000 | 16_000 | 24_000 | 48_000 => {
            Some((sample_rate as usize * duration_ms as usize) / 1000)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_size_picks() {
        assert_eq!(encoded_chunk_frame_size(48_000, 20), Some(960));
        assert_eq!(encoded_chunk_frame_size(48_000, 10), Some(480));
        assert_eq!(encoded_chunk_frame_size(44_100, 20), None); // Opus doesn't take 44.1
    }

    #[test]
    fn encode_silence_round_trip() {
        let mut enc = OpusFrameEncoder::new(48_000, 2, 960).expect("init");
        let pcm = vec![0.0f32; 960 * 2];
        let packet = enc.encode(&pcm).expect("encode");
        assert!(!packet.is_empty(), "opus emits at least one byte even for silence");
    }

    #[test]
    fn encode_wrong_length_errors() {
        let mut enc = OpusFrameEncoder::new(48_000, 1, 960).expect("init");
        let too_short = vec![0.0f32; 100];
        assert!(enc.encode(&too_short).is_err());
    }
}
