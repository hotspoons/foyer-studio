// SPDX-License-Identifier: Apache-2.0
//! Mixer scenes — named snapshots of every track's mix state.
//!
//! A "scene" is the entire mix in one row: fader, pan, mute, solo,
//! and outgoing send levels for every track. Recall flips the whole
//! mix in one operation. Common live + production use cases:
//! verse / chorus balance comparison, A/B between mixes, recall a
//! starting point after deep edits.
//!
//! Ardour's `Session::store_mixer_scene` / `recall_mixer_scene`
//! provide the same primitive natively; the Foyer schema mirrors
//! that shape so a session round-trips cleanly between the two.

use serde::{Deserialize, Serialize};

use crate::EntityId;

/// One outgoing send-level entry in a scene snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneSendLevel {
    pub target_track_id: EntityId,
    /// Send gain, in dB. -inf is represented as -120.0 by convention
    /// (matches the stub's mute-floor and Ardour's `dB_to_coefficient`
    /// underflow threshold).
    pub db: f64,
}

/// One row in the scene — every relevant mix value on a single track.
/// Tracks that don't have a given control (e.g. monitor bus has no
/// record_arm, master has no `mute`) simply omit it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneTrackSnapshot {
    pub track_id: EntityId,
    /// Track fader, in dB.
    pub gain_db: f64,
    /// Pan position in [-1.0, +1.0]. None for buses/master that have
    /// no pan (stub: omitted; Ardour: master has pan but it's a no-op).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pan: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mute: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solo: Option<bool>,
    /// Per-send levels. Empty when the track has no sends. Order
    /// matches the track's `sends` array on the session snapshot.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub send_levels: Vec<SceneSendLevel>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MixerScene {
    pub id: EntityId,
    pub name: String,
    /// Optional color (hex `#RRGGBB`) for the UI chip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Wall-clock unix seconds when the scene was last stored.
    /// Surfaces in the UI ("stored 5 minutes ago"); also lets the
    /// scene strip sort by recency.
    pub created_at_unix: i64,
    /// Per-track snapshot. Ordered, but not required to be ordered —
    /// recall is keyed by `track_id`, so reordering tracks doesn't
    /// invalidate the scene.
    pub snapshots: Vec<SceneTrackSnapshot>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let scene = MixerScene {
            id: EntityId::new("scene.verse"),
            name: "Verse balance".into(),
            color: Some("#80c0ff".into()),
            created_at_unix: 1_700_000_000,
            snapshots: vec![SceneTrackSnapshot {
                track_id: EntityId::new("track.kick"),
                gain_db: -6.0,
                pan: Some(0.0),
                mute: Some(false),
                solo: Some(false),
                send_levels: vec![SceneSendLevel {
                    target_track_id: EntityId::new("bus.reverb"),
                    db: -12.5,
                }],
            }],
        };
        let j = serde_json::to_string(&scene).unwrap();
        let back: MixerScene = serde_json::from_str(&j).unwrap();
        assert_eq!(scene, back);
    }
}
