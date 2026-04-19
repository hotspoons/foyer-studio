//! Mutable region store for the stub backend.
//!
//! Gives the timeline something to drag around and persist between calls.
//! Regions are generated deterministically per track (non-overlapping, spaced)
//! the first time that track's list is requested, then cached. Subsequent
//! `update_region` calls mutate the cached copy.

use std::collections::HashMap;

use foyer_schema::{EntityId, Region};

pub(crate) struct RegionStore {
    /// track_id → regions (in timeline order)
    by_track: HashMap<String, Vec<Region>>,
}

impl RegionStore {
    pub fn new() -> Self {
        Self {
            by_track: HashMap::new(),
        }
    }

    /// Get-or-synthesize the region list for a track.
    pub fn regions_for(&mut self, track_id: &EntityId) -> &Vec<Region> {
        let key = track_id.as_str().to_string();
        self.by_track
            .entry(key.clone())
            .or_insert_with(|| synthesize_for(track_id))
    }

    pub fn update(&mut self, id: &EntityId, patch: &foyer_schema::RegionPatch) -> Option<Region> {
        for (_track, list) in self.by_track.iter_mut() {
            if let Some(r) = list.iter_mut().find(|r| r.id == *id) {
                if let Some(s) = patch.start_samples {
                    r.start_samples = s;
                }
                if let Some(l) = patch.length_samples {
                    r.length_samples = l.max(4_800); // at least 0.1s
                }
                if let Some(n) = &patch.name {
                    r.name = n.clone();
                }
                if let Some(m) = patch.muted {
                    r.muted = m;
                }
                return Some(r.clone());
            }
        }
        None
    }
}

fn synthesize_for(track_id: &EntityId) -> Vec<Region> {
    let slug = track_id.as_str().rsplit('.').next().unwrap_or("x").to_string();
    // Non-overlapping: 4 regions of 6s each, 2s gaps, offset so tracks don't
    // all start at 0.
    let seed: u64 = track_id
        .as_str()
        .bytes()
        .fold(0u64, |a, b| a.wrapping_mul(131).wrapping_add(b as u64));
    let start_offset = (seed % 4) as u64 * 48_000;
    let gap = 2 * 48_000; // 2 seconds
    let dur = 6 * 48_000; // 6 seconds
    let mut out = Vec::new();
    for i in 0..4u64 {
        let start = start_offset + i * (dur + gap);
        out.push(Region {
            id: EntityId::new(format!("region.{slug}.{i}")),
            track_id: track_id.clone(),
            name: format!("{slug} {}", i + 1),
            start_samples: start,
            length_samples: dur,
            color: None,
            muted: false,
        });
    }
    out
}
