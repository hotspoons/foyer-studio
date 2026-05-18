// SPDX-License-Identifier: Apache-2.0
//! Polymorphic time arguments for the agent tool surface.
//!
//! Musicians and AI agents think in BBT ("bar 4, beat 2"); audio
//! engineers think in samples or seconds. Rather than forking every
//! time-taking tool into `_samples` and `_bbt` variants, Foyer accepts
//! ONE [`TimeArg`] that carries whichever form is natural for the
//! caller. The server picks the populated field, validates exactly
//! one is set, and converts to samples using the live session's
//! tempo + time-signature + sample-rate.
//!
//! The conversion model assumes a single global tempo + meter (which
//! is what every Foyer-managed session is today). When `tempo_map`
//! authoring lands and Ardour's full tempo-map gets exposed, the
//! resolver should grow a `position` lookup instead of multiplying
//! by a constant BPM.
//!
//! BPM convention: `bpm` is quarter notes per minute (Ardour's
//! `Temporal::Tempo::quarter_notes_per_minute`). A `beat` is
//! `(4/denominator)` quarter notes — the meter-aware beat. So
//! a 6/8 session at 120 BPM gives 240 (eighth-note) beats per minute.
//!
//! PPQN (`ticks_per_quarter`) defaults to 1920 to match Ardour 9.x's
//! `Temporal::ticks_per_beat`. Callers can override per-session via
//! [`TempoMap::ticks_per_quarter`].

use serde::{Deserialize, Serialize};

/// Bar/beat/tick triple. Bars and beats are 1-based to match how
/// musicians count ("bar 1 is the first bar"); ticks are 0-based
/// fractional positions inside a beat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Bbt {
    /// 1-based bar number. Bar 1 = transport position 0.
    pub bar: u32,
    /// 1-based beat number within the bar. Beat 1 = bar start.
    pub beat: u32,
    /// 0-based tick offset within the beat. 0 ≤ tick < ppqn * (4/denom).
    /// Overshoot wraps into the next beat / bar — the resolver
    /// normalizes rather than rejecting, so an agent that says
    /// "bar 1, beat 1, tick 3840" gets bar 1 beat 3 of 4/4 at
    /// ppqn=1920.
    pub tick: u32,
}

impl Bbt {
    pub fn new(bar: u32, beat: u32, tick: u32) -> Self {
        Self { bar, beat, tick }
    }
}

/// Polymorphic time. EXACTLY one of `samples`, `seconds`, `bbt` is
/// expected on the wire; the resolver errors if zero or more than
/// one is set.
///
/// Negative samples are intentionally NOT supported here — every
/// caller that needs pre-roll (e.g. `regions.move(start_samples)`)
/// keeps its existing signed-int parameter; this type is the
/// positive-position-in-the-session common case.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct TimeArg {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub samples: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bbt: Option<Bbt>,
}

impl TimeArg {
    pub fn from_samples(samples: u64) -> Self {
        Self {
            samples: Some(samples),
            ..Default::default()
        }
    }
    pub fn from_seconds(seconds: f64) -> Self {
        Self {
            seconds: Some(seconds),
            ..Default::default()
        }
    }
    pub fn from_bbt(bbt: Bbt) -> Self {
        Self {
            bbt: Some(bbt),
            ..Default::default()
        }
    }

    /// How many of the three fields are set. The resolver requires
    /// exactly 1; tests + UI use this to render the right error.
    pub fn populated_count(&self) -> usize {
        usize::from(self.samples.is_some())
            + usize::from(self.seconds.is_some())
            + usize::from(self.bbt.is_some())
    }
}

/// Minimal tempo + meter snapshot needed to resolve [`TimeArg`] to
/// samples. The agent tools pull these four values from the live
/// session and hand them to the resolver — keeps `TimeArg`'s
/// conversion logic pure (no `&Session` dependency) and trivially
/// unit-testable.
#[derive(Debug, Clone, Copy)]
pub struct TempoMap {
    pub sample_rate: u32,
    /// Quarter notes per minute.
    pub bpm: f64,
    /// Time signature numerator (beats per bar).
    pub time_sig_num: u32,
    /// Time signature denominator (note value: 1 / 2 / 4 / 8 / 16 / 32).
    pub time_sig_den: u32,
    /// Ticks per quarter note. Ardour 9.x = 1920; MIDI files vary.
    pub ticks_per_quarter: u32,
}

impl TempoMap {
    /// Quarter notes per beat under this meter. 4/4 → 1; 6/8 → 0.5;
    /// 4/2 → 2. Stays an f64 because meters like 4/12 (rare but
    /// representable) aren't powers of two.
    pub fn quarters_per_beat(&self) -> f64 {
        4.0 / (self.time_sig_den.max(1) as f64)
    }

    /// Seconds per quarter note. Stays in f64 — sample-rounding
    /// happens at the very end of the resolution chain.
    pub fn seconds_per_quarter(&self) -> f64 {
        60.0 / self.bpm.max(f64::EPSILON)
    }

    /// Convert a BBT triple to samples. Bars and beats overshoot the
    /// meter freely (bar 1 beat 99 is just 98 beats past bar 1's
    /// downbeat); ticks also overshoot the beat. The resolver doesn't
    /// reject — DAWs accept arithmetic-overflow BBT all the time and
    /// agents shouldn't be forced to know the exact meter.
    pub fn bbt_to_samples(&self, bbt: Bbt) -> u64 {
        let bar_idx = bbt.bar.saturating_sub(1) as f64;
        let beat_idx = bbt.beat.saturating_sub(1) as f64;
        let tick_frac = bbt.tick as f64 / (self.ticks_per_quarter.max(1) as f64);

        let qpb = self.quarters_per_beat();
        let quarters = bar_idx * (self.time_sig_num as f64) * qpb + beat_idx * qpb + tick_frac;
        let seconds = quarters * self.seconds_per_quarter();
        (seconds * self.sample_rate as f64).round().max(0.0) as u64
    }

    /// Convert samples to BBT. Inverse of [`Self::bbt_to_samples`]
    /// under the same single-tempo assumption. Used by the agent's
    /// reply summaries (so it can echo back "bar 4 beat 2" after
    /// receiving samples).
    pub fn samples_to_bbt(&self, samples: u64) -> Bbt {
        if self.sample_rate == 0 {
            return Bbt::new(1, 1, 0);
        }
        let seconds = samples as f64 / self.sample_rate as f64;
        let total_quarters = seconds / self.seconds_per_quarter();
        let qpb = self.quarters_per_beat().max(f64::EPSILON);
        let total_beats = total_quarters / qpb;
        let num = self.time_sig_num.max(1) as f64;
        let bar_idx = (total_beats / num).floor();
        let beat_in_bar = total_beats - bar_idx * num;
        let beat_idx = beat_in_bar.floor();
        let tick_frac = (beat_in_bar - beat_idx) * (self.ticks_per_quarter as f64);
        Bbt {
            bar: (bar_idx as u32).saturating_add(1),
            beat: (beat_idx as u32).saturating_add(1),
            tick: tick_frac.round().max(0.0) as u32,
        }
    }
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum TimeResolveError {
    #[error("expected exactly one of {{samples, seconds, bbt}}; got none")]
    Empty,
    #[error("expected exactly one of {{samples, seconds, bbt}}; got {0}")]
    Multiple(usize),
    #[error("sample_rate is zero — cannot resolve {{seconds, bbt}}")]
    NoSampleRate,
    #[error("bpm is zero or non-finite — cannot resolve bbt")]
    NoTempo,
}

impl TimeArg {
    /// Resolve to absolute samples. Errors if none / multiple fields
    /// are set, or if the tempo map is degenerate.
    pub fn to_samples(&self, map: &TempoMap) -> Result<u64, TimeResolveError> {
        match (self.samples, self.seconds, self.bbt) {
            (Some(s), None, None) => Ok(s),
            (None, Some(secs), None) => {
                if map.sample_rate == 0 {
                    return Err(TimeResolveError::NoSampleRate);
                }
                Ok((secs.max(0.0) * map.sample_rate as f64).round() as u64)
            }
            (None, None, Some(b)) => {
                if map.sample_rate == 0 {
                    return Err(TimeResolveError::NoSampleRate);
                }
                if !map.bpm.is_finite() || map.bpm <= 0.0 {
                    return Err(TimeResolveError::NoTempo);
                }
                Ok(map.bbt_to_samples(b))
            }
            (None, None, None) => Err(TimeResolveError::Empty),
            _ => Err(TimeResolveError::Multiple(self.populated_count())),
        }
    }

    /// Same as [`Self::to_samples`] but returns `i64` so callers like
    /// `regions.move(start_samples: i64)` can preserve pre-roll
    /// negatives if they're carrying a signed sample value. The BBT
    /// + seconds paths always produce non-negative outputs.
    pub fn to_samples_signed(&self, map: &TempoMap) -> Result<i64, TimeResolveError> {
        self.to_samples(map).map(|s| s as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map_44_120bpm() -> TempoMap {
        TempoMap {
            sample_rate: 48_000,
            bpm: 120.0,
            time_sig_num: 4,
            time_sig_den: 4,
            ticks_per_quarter: 1920,
        }
    }

    #[test]
    fn samples_passthrough() {
        let m = map_44_120bpm();
        let t = TimeArg::from_samples(96_000);
        assert_eq!(t.to_samples(&m).unwrap(), 96_000);
    }

    #[test]
    fn seconds_round_trip() {
        let m = map_44_120bpm();
        // 1.0 s @ 48 kHz = 48000 samples
        assert_eq!(TimeArg::from_seconds(1.0).to_samples(&m).unwrap(), 48_000);
    }

    #[test]
    fn bbt_bar_2_is_one_bar_of_quarters() {
        let m = map_44_120bpm();
        // 120 BPM 4/4: one bar = 4 quarters = 2.0 s = 96 000 samples
        let t = TimeArg::from_bbt(Bbt::new(2, 1, 0));
        assert_eq!(t.to_samples(&m).unwrap(), 96_000);
    }

    #[test]
    fn bbt_beat_advances_by_one_quarter() {
        let m = map_44_120bpm();
        // bar 1 beat 2: one quarter = 0.5 s = 24 000 samples
        let t = TimeArg::from_bbt(Bbt::new(1, 2, 0));
        assert_eq!(t.to_samples(&m).unwrap(), 24_000);
    }

    #[test]
    fn bbt_tick_subdivides_beat() {
        let m = map_44_120bpm();
        // bar 1 beat 1 tick 960 (half a quarter at ppqn=1920) = 12 000 samples
        let t = TimeArg::from_bbt(Bbt::new(1, 1, 960));
        assert_eq!(t.to_samples(&m).unwrap(), 12_000);
    }

    #[test]
    fn bbt_in_68_time() {
        // 6/8 at 120 BPM: a beat is an 8th note = 0.25 s
        // bar 2 = 6 beats = 1.5 s = 72 000 samples @ 48k
        let m = TempoMap {
            sample_rate: 48_000,
            bpm: 120.0,
            time_sig_num: 6,
            time_sig_den: 8,
            ticks_per_quarter: 1920,
        };
        let t = TimeArg::from_bbt(Bbt::new(2, 1, 0));
        assert_eq!(t.to_samples(&m).unwrap(), 72_000);
    }

    #[test]
    fn empty_errors() {
        let m = map_44_120bpm();
        let t = TimeArg::default();
        assert!(matches!(t.to_samples(&m), Err(TimeResolveError::Empty)));
    }

    #[test]
    fn multiple_errors() {
        let m = map_44_120bpm();
        let t = TimeArg {
            samples: Some(0),
            seconds: Some(0.0),
            bbt: None,
        };
        assert!(matches!(
            t.to_samples(&m),
            Err(TimeResolveError::Multiple(2))
        ));
    }

    #[test]
    fn round_trip_samples_to_bbt() {
        let m = map_44_120bpm();
        // 96 000 samples = bar 2 beat 1 tick 0
        let bbt = m.samples_to_bbt(96_000);
        assert_eq!(bbt, Bbt::new(2, 1, 0));
    }
}
