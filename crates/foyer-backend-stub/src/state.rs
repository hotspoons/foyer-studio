//! Mutable state for the stub backend. Held behind a single `Mutex`.

use std::collections::HashMap;

use foyer_backend::BackendError;
use foyer_schema::{
    AutomationLane, AutomationMode, AutomationPoint, ControlUpdate, ControlValue, EntityId, Group,
    GroupPatch, Parameter, Session, Track, TrackKind, TrackPatch,
};

/// Enumerates the track-level controls that participate in group
/// linking. Mirrors the four `Group::link_*` flags 1:1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GroupField {
    Gain,
    Mute,
    Solo,
    Record,
}

/// Best-effort cast of a `ControlValue` to `f64`. Used by the gain
/// fan-out to compute relative deltas; non-numeric values fall back to
/// 0 (in practice gain is always `Float`, so the fallback never
/// triggers, but it lets the call sites stay total).
fn float_of(v: &ControlValue) -> f64 {
    match v {
        ControlValue::Float(f) => *f,
        ControlValue::Int(i) => *i as f64,
        ControlValue::Bool(true) => 1.0,
        _ => 0.0,
    }
}

use crate::fixtures;

pub(crate) struct StubState {
    session: Session,
    /// Meter parameters indexed for fast tick updates. Not included in `session.tracks`
    /// directly (they're referenced via `Track::peak_meter`), but UIs read them via
    /// `ControlUpdate` events.
    meters: HashMap<EntityId, Parameter>,
    tick: u64,
    /// How many `Backend::send_midi_input` calls landed since boot.
    /// Test-only observable; advanced from inside the stub's lock so
    /// readers see a consistent count alongside `last_midi_input`.
    pub(crate) midi_input_count: u64,
    /// Most recent MIDI bytes the stub received from the browser
    /// bridge. Same lifecycle / visibility rules as
    /// `midi_input_count`; lets tests assert byte-shape too.
    pub(crate) last_midi_input: Option<Vec<u8>>,
    /// Track id the most recent MIDI bytes were targeted at, or
    /// `None` if the message was a shared-port broadcast. Lets
    /// tests verify per-track routing decisions made client-side.
    pub(crate) last_midi_input_track: Option<EntityId>,
}

impl StubState {
    pub(crate) fn new() -> Self {
        let session = fixtures::initial_session();
        let meters: HashMap<_, _> = fixtures::seed_meters(&fixtures::peak_meter_ids(&session))
            .into_iter()
            .collect();
        Self {
            session,
            meters,
            tick: 0,
            midi_input_count: 0,
            last_midi_input: None,
            last_midi_input_track: None,
        }
    }

    /// Launcher mode — no tracks, no meters, transport only.
    pub(crate) fn empty() -> Self {
        Self {
            session: fixtures::empty_session(),
            meters: HashMap::new(),
            tick: 0,
            midi_input_count: 0,
            last_midi_input: None,
            last_midi_input_track: None,
        }
    }

    pub(crate) fn session_clone(&self) -> Session {
        self.session.clone()
    }

    /// Override the session's sample rate. Used by the stub's
    /// `with_sample_rate` builder so a CLI / config / env override
    /// reaches the snapshot consumers, not just the cached atomic.
    pub(crate) fn set_sample_rate(&mut self, sr: u32) {
        self.session.sample_rate = sr;
    }

    pub(crate) fn set_control(
        &mut self,
        id: &EntityId,
        value: ControlValue,
    ) -> Result<(), BackendError> {
        if let Some(p) = self.find_param_mut(id) {
            p.value = value.clone();
            // Keep `PluginInstance.bypassed` (the denormalized snapshot bool)
            // in sync with the `.bypass` parameter so client-side views that
            // read either surface stay coherent.
            if id.as_str().ends_with(".bypass") {
                self.sync_plugin_bypass(id, &value);
            }
            return Ok(());
        }
        if let Some(m) = self.meters.get_mut(id) {
            m.value = value;
            return Ok(());
        }
        Err(BackendError::UnknownId(id.clone()))
    }

    /// Apply a `set_control` and fan-out the same gesture to other
    /// members of the source track's group, when the group is `active`
    /// and the corresponding `link_*` flag is set. Returns the full
    /// list of `ControlUpdate`s produced — primary + any siblings —
    /// so the caller (`StubBackend::set_control`) can broadcast all of
    /// them.
    ///
    /// Semantics match the typical DAW edit-group convention:
    /// - **gain** is relative-delta: every member gets the same dB
    ///   delta as the source, preserving the mix balance the user had
    ///   when they enabled the link.
    /// - **mute / solo / record-arm** are absolute: every member ends
    ///   up in the same state as the source.
    pub(crate) fn set_control_with_fanout(
        &mut self,
        id: &EntityId,
        value: ControlValue,
    ) -> Result<Vec<ControlUpdate>, BackendError> {
        // Classify the target field BEFORE the write so we can compute
        // a relative-delta for gain. `field` is `None` for any control
        // that isn't a track-level link target (transport, plugin
        // params, automation lanes, …).
        let classification = self.classify_track_field(id);
        let old_value = match &classification {
            Some((_, GroupField::Gain)) => self.find_param_mut(id).map(|p| p.value.clone()),
            _ => None,
        };

        self.set_control(id, value.clone())?;
        let mut out = vec![ControlUpdate {
            id: id.clone(),
            value: value.clone(),
        }];

        let Some((source_track_id, field)) = classification else {
            return Ok(out);
        };
        let Some(group) = self.find_active_group(&source_track_id, field) else {
            return Ok(out);
        };
        let members: Vec<EntityId> = group
            .members
            .iter()
            .filter(|m| **m != source_track_id)
            .cloned()
            .collect();

        for member in members {
            let target_id = match self.member_param_id(&member, field) {
                Some(t) => t,
                None => continue,
            };
            // Compute the propagated value. Gain rides as a relative
            // delta; everything else is absolute.
            let propagated = match field {
                GroupField::Gain => {
                    let delta = float_of(&value) - float_of(old_value.as_ref().unwrap_or(&value));
                    let cur = self
                        .find_param_mut(&target_id)
                        .map(|p| float_of(&p.value))
                        .unwrap_or(0.0);
                    ControlValue::Float(cur + delta)
                }
                _ => value.clone(),
            };
            // Best-effort: if a sibling is missing the field (e.g. a
            // bus has no record_arm), skip silently rather than fail
            // the whole gesture.
            if self.find_param_mut(&target_id).is_some() {
                self.set_control(&target_id, propagated.clone())?;
                out.push(ControlUpdate {
                    id: target_id,
                    value: propagated,
                });
            }
        }
        Ok(out)
    }

    /// Identify whether `id` is a track-level link target and, if so,
    /// return the owning track id + which `GroupField` it represents.
    /// Walks `session.tracks` rather than parsing the id string so we
    /// don't hard-code the `track.<uuid>.<field>` convention here.
    fn classify_track_field(&self, id: &EntityId) -> Option<(EntityId, GroupField)> {
        for track in &self.session.tracks {
            if &track.gain.id == id {
                return Some((track.id.clone(), GroupField::Gain));
            }
            if &track.mute.id == id {
                return Some((track.id.clone(), GroupField::Mute));
            }
            if &track.solo.id == id {
                return Some((track.id.clone(), GroupField::Solo));
            }
            if let Some(ra) = track.record_arm.as_ref() {
                if &ra.id == id {
                    return Some((track.id.clone(), GroupField::Record));
                }
            }
        }
        None
    }

    /// Look up the group `track_id` belongs to *and* that's currently
    /// linking the given field. Returns `None` if the track is
    /// unaffiliated, the group is inactive, or the field's `link_*`
    /// flag is off — i.e. any reason the gesture should NOT fan out.
    fn find_active_group(&self, track_id: &EntityId, field: GroupField) -> Option<&Group> {
        let track = self.session.tracks.iter().find(|t| &t.id == track_id)?;
        let gid = track.group_id.as_ref()?;
        let g = self.session.groups.iter().find(|g| &g.id == gid)?;
        if !g.active {
            return None;
        }
        let linked = match field {
            GroupField::Gain => g.link_gain,
            GroupField::Mute => g.link_mute,
            GroupField::Solo => g.link_solo,
            GroupField::Record => g.link_record,
        };
        if linked {
            Some(g)
        } else {
            None
        }
    }

    /// Resolve a sibling track's parameter id for `field`. Returns
    /// `None` for buses/groups that don't expose `record_arm`.
    fn member_param_id(&self, member: &EntityId, field: GroupField) -> Option<EntityId> {
        let track = self.session.tracks.iter().find(|t| &t.id == member)?;
        Some(match field {
            GroupField::Gain => track.gain.id.clone(),
            GroupField::Mute => track.mute.id.clone(),
            GroupField::Solo => track.solo.id.clone(),
            GroupField::Record => track.record_arm.as_ref()?.id.clone(),
        })
    }

    pub(crate) fn create_group(
        &mut self,
        name: String,
        color: Option<String>,
        members: Vec<EntityId>,
    ) -> Group {
        // Mint a stable id from the name (slug + counter) so the UI's
        // `_groups` reactive read picks it up on the next snapshot.
        let mut slug: String = name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '_'
                }
            })
            .collect();
        if slug.is_empty() {
            slug.push_str("group");
        }
        let mut id = format!("group.{slug}");
        let mut suffix = 2;
        while self.session.groups.iter().any(|g| g.id.as_str() == id) {
            id = format!("group.{slug}_{suffix}");
            suffix += 1;
        }
        let group = Group {
            id: EntityId::new(id),
            name,
            color,
            members: members.clone(),
            active: true,
            link_gain: true,
            link_mute: true,
            link_solo: true,
            link_record: true,
        };
        // Mirror group_id onto every member track so `classify_track_field`
        // can find the link without iterating the groups list every time.
        for m in &members {
            if let Some(t) = self.session.tracks.iter_mut().find(|t| &t.id == m) {
                t.group_id = Some(group.id.clone());
            }
        }
        self.session.groups.push(group.clone());
        group
    }

    pub(crate) fn update_group(
        &mut self,
        id: &EntityId,
        patch: &GroupPatch,
    ) -> Result<(), BackendError> {
        let group = self
            .session
            .groups
            .iter_mut()
            .find(|g| &g.id == id)
            .ok_or_else(|| BackendError::UnknownId(id.clone()))?;
        if let Some(name) = patch.name.as_ref() {
            group.name = name.clone();
        }
        if let Some(color) = patch.color.as_ref() {
            group.color = if color.is_empty() {
                None
            } else {
                Some(color.clone())
            };
        }
        if let Some(active) = patch.active {
            group.active = active;
        }
        if let Some(v) = patch.link_gain {
            group.link_gain = v;
        }
        if let Some(v) = patch.link_mute {
            group.link_mute = v;
        }
        if let Some(v) = patch.link_solo {
            group.link_solo = v;
        }
        if let Some(v) = patch.link_record {
            group.link_record = v;
        }
        if let Some(members) = patch.members.as_ref() {
            // Resync every track's `group_id` mirror — clear from any
            // tracks that left, set on any tracks that joined.
            let new_set: std::collections::HashSet<&EntityId> = members.iter().collect();
            let gid = id.clone();
            for t in &mut self.session.tracks {
                let was_member = t.group_id.as_ref() == Some(&gid);
                let is_member = new_set.contains(&t.id);
                if was_member && !is_member {
                    t.group_id = None;
                } else if is_member {
                    t.group_id = Some(gid.clone());
                }
            }
            // Re-borrow `group` after the track loop dropped its mut
            // borrow — `find` again because the previous handle was
            // invalidated when we mutated `self.session.tracks`.
            if let Some(group) = self.session.groups.iter_mut().find(|g| &g.id == id) {
                group.members = members.clone();
            }
        }
        Ok(())
    }

    pub(crate) fn delete_group(&mut self, id: &EntityId) -> Result<(), BackendError> {
        let pos = self
            .session
            .groups
            .iter()
            .position(|g| &g.id == id)
            .ok_or_else(|| BackendError::UnknownId(id.clone()))?;
        self.session.groups.remove(pos);
        // Detach any tracks that pointed at the deleted group.
        for t in &mut self.session.tracks {
            if t.group_id.as_ref() == Some(id) {
                t.group_id = None;
            }
        }
        Ok(())
    }

    fn sync_plugin_bypass(&mut self, id: &EntityId, value: &ControlValue) {
        let on = matches!(value, ControlValue::Bool(true))
            || matches!(value, ControlValue::Int(i) if *i != 0)
            || matches!(value, ControlValue::Float(f) if *f >= 0.5);
        // id format: "plugin.<slug>.<pid>.bypass" — strip the trailing ".bypass"
        let Some(plugin_id_str) = id.as_str().strip_suffix(".bypass") else {
            return;
        };
        for track in &mut self.session.tracks {
            for plug in &mut track.plugins {
                if plug.id.as_str() == plugin_id_str {
                    plug.bypassed = on;
                    return;
                }
            }
        }
    }

    /// Rotate through meters and emit a batch of pseudo-random drifting values,
    /// plus advance `transport.position` while playing. Runs at ~30 Hz from
    /// `spawn_meter_tick`, so the playhead updates look smooth in the UI.
    pub(crate) fn tick_meters(&mut self) -> Vec<ControlUpdate> {
        self.tick = self.tick.wrapping_add(1);
        let mut out = Vec::with_capacity(self.meters.len() + 1);
        for (i, (id, p)) in self.meters.iter_mut().enumerate() {
            let phase = (self.tick as f64 * 0.07 + i as f64 * 1.3).sin();
            // map [-1, 1] → [-60, -6] dB
            let db = -33.0 + phase * 27.0;
            p.value = ControlValue::Float(db);
            out.push(ControlUpdate {
                id: id.clone(),
                value: p.value.clone(),
            });
        }
        // Playhead: advance when `transport.playing` is true, freeze when not.
        let playing = matches!(
            self.session.transport.playing.value,
            ControlValue::Bool(true)
        );
        if playing {
            // Ticker runs every ~33ms. Advance by one tick's worth of
            // samples at the session's actual rate, modding against
            // the same 60-second wall-clock window the stub timeline
            // exposes via `TimelineMeta`.
            let sr = f64::from(self.session.sample_rate);
            let step = sr * 0.033;
            let pos = &mut self.session.transport.position_beats;
            let current = match pos.value {
                ControlValue::Float(f) => f,
                ControlValue::Int(i) => i as f64,
                _ => 0.0,
            };
            let length_samples = sr * 60.0; // 60s demo timeline
            let next = (current + step) % length_samples;
            pos.value = ControlValue::Float(next);
            out.push(ControlUpdate {
                id: pos.id.clone(),
                value: pos.value.clone(),
            });
        }
        out
    }

    /// Apply a `TrackPatch` in place and return the updated track. Returns
    /// `None` if no track matches `id`. Mirrors the shim-side semantic:
    /// name/color changes update immediately; `group_id` is stored
    /// verbatim; `bus_assign` is a no-op in the stub until we model
    /// routing.
    pub(crate) fn update_track(&mut self, id: &EntityId, patch: &TrackPatch) -> Option<Track> {
        let t = self.session.tracks.iter_mut().find(|t| &t.id == id)?;
        if let Some(name) = patch.name.as_ref() {
            t.name = name.clone();
        }
        if let Some(color) = patch.color.as_ref() {
            // Empty string = "clear the color".
            t.color = if color.is_empty() {
                None
            } else {
                Some(color.clone())
            };
        }
        if let Some(group_id) = patch.group_id.as_ref() {
            t.group_id = if group_id.as_str().is_empty() {
                None
            } else {
                Some(group_id.clone())
            };
        }
        // bus_assign is intentionally not modeled in the stub — the real
        // shim does the routing; this backend is only about making the
        // UI repaint.
        Some(t.clone())
    }

    /// Apply a MIDI channel-mode change. Sets the chosen direction's
    /// `mode` + `mask`. Returns the updated track or `None` if no track
    /// matches `id`. Silently no-ops on non-MIDI tracks (the field set
    /// stays `None`) — clients should gate the command on `kind` first.
    pub(crate) fn set_track_midi_channel_mode(
        &mut self,
        id: &EntityId,
        direction: &str,
        mode: &str,
        mask: u16,
    ) -> Option<Track> {
        let t = self.session.tracks.iter_mut().find(|t| &t.id == id)?;
        if !matches!(t.kind, TrackKind::Midi) {
            return Some(t.clone());
        }
        match direction {
            "capture" => {
                t.capture_channel_mode = Some(mode.to_string());
                t.capture_channel_mask = Some(mask);
            }
            "playback" => {
                t.playback_channel_mode = Some(mode.to_string());
                t.playback_channel_mask = Some(mask);
            }
            _ => return Some(t.clone()),
        }
        Some(t.clone())
    }

    /// Read-only snapshot of `transport.position_beats` as samples
    /// (despite the name, the stub stores samples there). Returns
    /// `None` only when the field doesn't hold a numeric value —
    /// i.e. never, in practice; the option is just a defensive
    /// fallthrough so callers can map it to "no position known."
    pub(crate) fn position_samples_now(&self) -> Option<u64> {
        match self.session.transport.position_beats.value {
            ControlValue::Float(f) if f.is_finite() && f >= 0.0 => Some(f as u64),
            ControlValue::Int(i) if i >= 0 => Some(i as u64),
            _ => None,
        }
    }

    fn find_param_mut(&mut self, id: &EntityId) -> Option<&mut Parameter> {
        // Transport first.
        let t = &mut self.session.transport;
        for p in [
            &mut t.playing,
            &mut t.recording,
            &mut t.looping,
            &mut t.tempo,
            &mut t.time_signature_num,
            &mut t.time_signature_den,
            &mut t.position_beats,
        ] {
            if p.id == *id {
                // SAFETY-free rebinding to return the matching &mut.
                return Some(p);
            }
        }
        // Optional transport extras (only present on backends that
        // surface them — `return_mode` is the first one wired through
        // ControlSet, so its lookup has to live here too).
        if let Some(p) = t.return_mode.as_mut() {
            if p.id == *id {
                return Some(p);
            }
        }
        if let Some(p) = t.metronome.as_mut() {
            if p.id == *id {
                return Some(p);
            }
        }
        if let Some(p) = t.metronome_gain.as_mut() {
            if p.id == *id {
                return Some(p);
            }
        }
        for track in &mut self.session.tracks {
            for p in [
                &mut track.gain,
                &mut track.pan,
                &mut track.mute,
                &mut track.solo,
            ] {
                if p.id == *id {
                    return Some(p);
                }
            }
            if let Some(p) = track.record_arm.as_mut() {
                if p.id == *id {
                    return Some(p);
                }
            }
            for plugin in &mut track.plugins {
                for p in &mut plugin.params {
                    if p.id == *id {
                        return Some(p);
                    }
                }
            }
        }
        None
    }

    // ─── automation lane helpers ───────────────────────────────────────

    fn find_lane_mut(&mut self, lane_id: &EntityId) -> Option<&mut AutomationLane> {
        for track in &mut self.session.tracks {
            for lane in &mut track.automation_lanes {
                if lane.control_id == *lane_id {
                    return Some(lane);
                }
            }
        }
        None
    }

    pub(crate) fn set_automation_mode(
        &mut self,
        lane_id: &EntityId,
        mode: AutomationMode,
    ) -> Result<(), BackendError> {
        let lane = self
            .find_lane_mut(lane_id)
            .ok_or_else(|| BackendError::Other(format!("unknown lane {lane_id}")))?;
        lane.mode = mode;
        Ok(())
    }

    pub(crate) fn add_automation_point(
        &mut self,
        lane_id: &EntityId,
        point: AutomationPoint,
    ) -> Result<(), BackendError> {
        let lane = self
            .find_lane_mut(lane_id)
            .ok_or_else(|| BackendError::Other(format!("unknown lane {lane_id}")))?;
        lane.points.push(point);
        lane.points.sort_by_key(|p| p.time_samples);
        Ok(())
    }

    pub(crate) fn update_automation_point(
        &mut self,
        lane_id: &EntityId,
        original_time_samples: u64,
        new_time_samples: u64,
        value: f64,
    ) -> Result<(), BackendError> {
        let lane = self
            .find_lane_mut(lane_id)
            .ok_or_else(|| BackendError::Other(format!("unknown lane {lane_id}")))?;
        let pt = lane
            .points
            .iter_mut()
            .find(|p| p.time_samples == original_time_samples)
            .ok_or_else(|| {
                BackendError::Other(format!("point not found at {original_time_samples}"))
            })?;
        pt.time_samples = new_time_samples;
        pt.value = value;
        lane.points.sort_by_key(|p| p.time_samples);
        Ok(())
    }

    pub(crate) fn delete_automation_point(
        &mut self,
        lane_id: &EntityId,
        time_samples: u64,
    ) -> Result<(), BackendError> {
        let lane = self
            .find_lane_mut(lane_id)
            .ok_or_else(|| BackendError::Other(format!("unknown lane {lane_id}")))?;
        let old_len = lane.points.len();
        lane.points.retain(|p| p.time_samples != time_samples);
        if lane.points.len() == old_len {
            return Err(BackendError::Other(format!(
                "point not found at {time_samples}"
            )));
        }
        Ok(())
    }

    pub(crate) fn replace_automation_lane(
        &mut self,
        lane_id: &EntityId,
        points: Vec<AutomationPoint>,
    ) -> Result<(), BackendError> {
        let lane = self
            .find_lane_mut(lane_id)
            .ok_or_else(|| BackendError::Other(format!("unknown lane {lane_id}")))?;
        lane.points = points;
        Ok(())
    }
}
