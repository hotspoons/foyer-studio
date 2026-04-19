//! Mutable state for the stub backend. Held behind a single `Mutex`.

use std::collections::HashMap;

use foyer_backend::BackendError;
use foyer_schema::{ControlUpdate, ControlValue, EntityId, Parameter, Session};

use crate::fixtures;

pub(crate) struct StubState {
    session: Session,
    /// Meter parameters indexed for fast tick updates. Not included in `session.tracks`
    /// directly (they're referenced via `Track::peak_meter`), but UIs read them via
    /// `ControlUpdate` events.
    meters: HashMap<EntityId, Parameter>,
    tick: u64,
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
        }
    }

    pub(crate) fn session_clone(&self) -> Session {
        self.session.clone()
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
        let playing = matches!(self.session.transport.playing.value, ControlValue::Bool(true));
        if playing {
            // Ticker runs every ~33ms; sample_rate=48_000. Advance by one
            // tick's worth of samples per tick.
            let sr: f64 = self
                .session
                .meta
                .get("sample_rate")
                .and_then(|v| v.as_f64())
                .unwrap_or(48_000.0);
            let step = sr * 0.033;
            let pos = &mut self.session.transport.position_beats;
            let current = match pos.value {
                ControlValue::Float(f) => f,
                ControlValue::Int(i) => i as f64,
                _ => 0.0,
            };
            let length_samples: f64 = 48_000.0 * 60.0; // 60s demo timeline
            let next = (current + step) % length_samples;
            pos.value = ControlValue::Float(next);
            out.push(ControlUpdate {
                id: pos.id.clone(),
                value: pos.value.clone(),
            });
        }
        out
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
}
