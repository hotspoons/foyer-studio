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
                if let Some(g) = patch.gain_linear {
                    r.gain_linear = Some(g);
                }
                if let Some(f) = patch.fade_in_samples {
                    if f == 0 {
                        r.fade_in_samples = None;
                        r.fade_in_shape = None;
                    } else {
                        r.fade_in_samples = Some(f);
                        if let Some(s) = patch.fade_in_shape {
                            r.fade_in_shape = Some(s);
                        }
                    }
                } else if let Some(s) = patch.fade_in_shape {
                    r.fade_in_shape = Some(s);
                }
                if let Some(f) = patch.fade_out_samples {
                    if f == 0 {
                        r.fade_out_samples = None;
                        r.fade_out_shape = None;
                    } else {
                        r.fade_out_samples = Some(f);
                        if let Some(s) = patch.fade_out_shape {
                            r.fade_out_shape = Some(s);
                        }
                    }
                } else if let Some(s) = patch.fade_out_shape {
                    r.fade_out_shape = Some(s);
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

    /// Split `id` at timeline position `at` (samples). Replaces the region
    /// with two adjacent regions whose lengths sum to the original. Returns
    /// the affected track id.
    pub fn split_at(
        &mut self,
        id: &EntityId,
        at: i64,
        min_len: u64,
        left_id: EntityId,
        right_id: EntityId,
    ) -> Result<EntityId, String> {
        for (track_key, list) in self.by_track.iter_mut() {
            if let Some(idx) = list.iter().position(|r| r.id == *id) {
                let r = list[idx].clone();
                let start = r.start_samples;
                let len_i = r.length_samples as i64;
                let end = start.saturating_add(len_i);
                if at <= start || at >= end {
                    return Err("split_at: cut is not inside the region".into());
                }
                let left_len = (at - start) as u64;
                let right_len = (end - at) as u64;
                if left_len < min_len || right_len < min_len {
                    return Err("split_at: pieces would be shorter than min length".into());
                }
                let so = r.source_offset_samples.unwrap_or(0);
                let mut left = r.clone();
                left.id = left_id;
                left.start_samples = start;
                left.length_samples = left_len;
                left.source_offset_samples = Some(so);
                if !left.name.is_empty() {
                    left.name = format!("{} · A", r.name);
                }
                let mut right = r.clone();
                right.id = right_id;
                right.start_samples = at;
                right.length_samples = right_len;
                right.source_offset_samples = Some(so.saturating_add(left_len));
                if !right.name.is_empty() {
                    right.name = format!("{} · B", r.name);
                }
                list.remove(idx);
                list.insert(idx, left);
                list.insert(idx + 1, right);
                return Ok(EntityId::new(track_key.clone()));
            }
        }
        Err("split_at: unknown region".into())
    }

    /// Time-stretch stub: scales MIDI note ticks; leaves `source_offset`
    /// unchanged. Validates geometry against `anchor` (`"start"` | `"end"`).
    pub fn stretch_content(
        &mut self,
        id: &EntityId,
        new_start: i64,
        new_len: u64,
        anchor: &str,
        min_len: u64,
    ) -> Result<(EntityId, Region), String> {
        if new_len < min_len {
            return Err("stretch: new length too small".into());
        }
        let anchor = anchor.to_ascii_lowercase();
        if anchor != "start" && anchor != "end" {
            return Err("stretch: anchor must be start or end".into());
        }
        for (_track_key, list) in self.by_track.iter_mut() {
            if let Some(r) = list.iter_mut().find(|r| r.id == *id) {
                let old_len = r.length_samples;
                if old_len == 0 {
                    return Err("stretch: zero-length region".into());
                }
                let old_start = r.start_samples;
                let old_end = old_start.saturating_add(old_len as i64);
                if anchor == "start" && new_start != old_start {
                    return Err("stretch: start anchor requires fixed left edge".into());
                }
                if anchor == "end" {
                    let expect_start = old_end.saturating_sub(new_len as i64);
                    if new_start != expect_start {
                        return Err("stretch: end anchor requires fixed right edge".into());
                    }
                }
                let ratio_n = new_len;
                let ratio_d = old_len;
                for n in &mut r.notes {
                    n.start_ticks =
                        ((n.start_ticks as u128 * ratio_n as u128) / u128::from(ratio_d)) as u64;
                    n.length_ticks = u64::max(
                        1,
                        ((n.length_ticks as u128 * ratio_n as u128) / u128::from(ratio_d)) as u64,
                    );
                }
                r.start_samples = new_start;
                r.length_samples = new_len;
                let out = r.clone();
                return Ok((r.track_id.clone(), out));
            }
        }
        Err("stretch: unknown region".into())
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
            gain_linear: None,
            fade_in_samples: None,
            fade_out_samples: None,
            fade_in_shape: None,
            fade_out_shape: None,
        });
    }
    out
}
