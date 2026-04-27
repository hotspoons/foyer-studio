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

    /// Get-or-synthesize the region list for a track. Synthesized
    /// regions are scaled to `sample_rate` so tracks always look like
    /// "4 × 6-second clips with 2-second gaps" regardless of the
    /// session's configured SR.
    pub fn regions_for(&mut self, track_id: &EntityId, sample_rate: u32) -> &Vec<Region> {
        let key = track_id.as_str().to_string();
        self.by_track
            .entry(key.clone())
            .or_insert_with(|| synthesize_for(track_id, sample_rate))
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
                if let Some(off) = patch.source_offset_samples {
                    r.source_offset_samples = Some(off);
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

    /// Remove the region with the given id. Returns the track id it was on
    /// if found; `None` otherwise.
    pub fn delete(&mut self, id: &EntityId) -> Option<EntityId> {
        for (track_key, list) in self.by_track.iter_mut() {
            if let Some(pos) = list.iter().position(|r| r.id == *id) {
                list.remove(pos);
                return Some(EntityId::new(track_key.clone()));
            }
        }
        None
    }

    /// Find a region by id in any track. Returns `(track_id, region_clone)`.
    pub fn find(&self, id: &EntityId) -> Option<(EntityId, Region)> {
        for (track_key, list) in self.by_track.iter() {
            if let Some(r) = list.iter().find(|r| r.id == *id) {
                return Some((EntityId::new(track_key.clone()), r.clone()));
            }
        }
        None
    }

    /// Append `region` to the track-local list, in start-time order.
    /// `region.track_id` and `region.id` must already be set by the caller.
    pub fn insert(&mut self, region: Region) {
        let key = region.track_id.as_str().to_string();
        let list = self.by_track.entry(key).or_default();
        // Keep regions in start-time order so the timeline-side picker
        // (rs[0] = first region) is deterministic.
        let pos = list
            .iter()
            .position(|r| r.start_samples > region.start_samples)
            .unwrap_or(list.len());
        list.insert(pos, region);
    }
}

/// Generate a fresh region id distinct from any in the store. Format
/// matches the synthesized ones (`region.<n>`) so the timeline-side
/// region renderer doesn't have to special-case duplicates.
pub(crate) fn fresh_region_id(seed: u64) -> EntityId {
    EntityId::new(format!("region.dup.{seed}"))
}

fn synthesize_for(track_id: &EntityId, sample_rate: u32) -> Vec<Region> {
    let slug = track_id
        .as_str()
        .rsplit('.')
        .next()
        .unwrap_or("x")
        .to_string();
    // Non-overlapping: 4 regions of 6s each, 2s gaps, offset so tracks don't
    // all start at 0.
    let seed: u64 = track_id
        .as_str()
        .bytes()
        .fold(0u64, |a, b| a.wrapping_mul(131).wrapping_add(b as u64));
    let sr = u64::from(sample_rate);
    let start_offset = (seed % 4) * sr;
    let gap = 2 * sr; // 2 seconds
    let dur = 6 * sr; // 6 seconds
    let mut out = Vec::new();
    for i in 0..4u64 {
        let start = start_offset + i * (dur + gap);
        out.push(Region {
            id: EntityId::new(format!("region.{slug}.{i}")),
            track_id: track_id.clone(),
            name: format!("{slug} {}", i + 1),
            start_samples: start as i64,
            length_samples: dur,
            color: None,
            muted: false,
            source_path: None,
            source_offset_samples: None,
            notes: vec![],
            patch_changes: vec![],
            foyer_sequencer: None,
        });
    }
    out
}
