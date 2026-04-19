//! Synthetic waveform peaks + tier cache.
//!
//! We generate deterministic peaks from a region id so reloads look the same
//! and tests are reproducible. The cache is keyed by `(region_id, tier)`
//! where `tier` is the rounded-down power-of-two resolution in
//! samples-per-peak. Clients typically ask for arbitrary resolutions; we pick
//! the nearest tier ≤ request and serve that.

use std::collections::HashMap;

use foyer_schema::{EntityId, Region, WaveformPeaks};

const CHANNELS: u16 = 1; // stub = mono
const TIERS: [u32; 8] = [64, 128, 256, 512, 1024, 2048, 4096, 8192];

pub(crate) struct WaveformCache {
    entries: HashMap<(String, u32), WaveformPeaks>,
}

impl WaveformCache {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Fetch-or-synthesize peaks at the nearest tier ≤ `requested`.
    pub fn get_or_compute(&mut self, region: &Region, requested: u32) -> WaveformPeaks {
        let tier = pick_tier(requested);
        let key = (region.id.as_str().to_string(), tier);
        if let Some(cached) = self.entries.get(&key) {
            return cached.clone();
        }
        let peaks = synthesize(region, tier);
        self.entries.insert(key, peaks.clone());
        peaks
    }

    /// Clear all tiers for a region. Returns count of tiers dropped.
    pub fn clear_region(&mut self, region_id: &EntityId) -> u32 {
        let needle = region_id.as_str();
        let before = self.entries.len();
        self.entries.retain(|(id, _tier), _| id != needle);
        (before - self.entries.len()) as u32
    }

    /// Clear everything. Returns the number of entries dropped.
    pub fn clear_all(&mut self) -> u32 {
        let n = self.entries.len();
        self.entries.clear();
        n as u32
    }
}

fn pick_tier(requested: u32) -> u32 {
    // Largest tier ≤ requested, falling back to smallest tier if request is
    // smaller than any available.
    let mut best = TIERS[0];
    for &t in TIERS.iter() {
        if t <= requested {
            best = t;
        }
    }
    best
}

fn synthesize(region: &Region, samples_per_peak: u32) -> WaveformPeaks {
    let bucket_count = ((region.length_samples + samples_per_peak as u64 - 1)
        / samples_per_peak as u64) as u32;
    let mut peaks = Vec::with_capacity((bucket_count as usize) * 2 * CHANNELS as usize);
    // Seed derived from region id so peaks are stable.
    let seed: u64 = region
        .id
        .as_str()
        .bytes()
        .fold(0u64, |a, b| a.wrapping_mul(131).wrapping_add(b as u64));
    // A few sine components + a long envelope + low-freq noise so the shape
    // looks plausible for a drum/synth/vocal-ish clip.
    let mut rng_state = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    for i in 0..bucket_count {
        for _ch in 0..CHANNELS {
            let t = i as f32 / bucket_count.max(1) as f32;
            // Envelope: fast attack, long decay.
            let env = if t < 0.02 { t / 0.02 } else { (1.0 - t).powf(1.5) };
            let osc = ((t * 84.0).sin() + (t * 27.0).sin() * 0.4).tanh();
            let jitter = ((rng_next(&mut rng_state) as f32) / u32::MAX as f32 - 0.5) * 0.4;
            let amp = (osc + jitter).clamp(-1.0, 1.0) * env;
            let min = -amp.abs().min(1.0);
            let max = amp.abs().min(1.0);
            peaks.push(min);
            peaks.push(max);
        }
    }
    WaveformPeaks {
        region_id: region.id.clone(),
        channels: CHANNELS,
        samples_per_peak,
        peaks,
        bucket_count,
    }
}

fn rng_next(state: &mut u64) -> u32 {
    // xorshift64*
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *state = x;
    (x.wrapping_mul(2685821657736338717) >> 32) as u32
}
