//! Audio I/O ports — the connection points through which audio enters or
//! leaves a track.
//!
//! Every audio/midi track has a set of **inputs** (where recorded signal
//! comes from) and **outputs** (where its post-fader signal goes). These
//! are the handles remote clients use to request egress taps or supply
//! ingress streams — a remote mic feeding `track.vox.input.0` is the same
//! wire-format as an Ardour input port.
//!
//! For now we model only what remote IO needs to address:
//! - a stable `EntityId` per port
//! - a direction + channel count
//! - whether the port is currently bound to a remote peer
//!
//! Richer routing (Ardour's port-matrix: who-connects-to-whom between
//! tracks) is out of scope until we see a concrete use-case; the matrix
//! can still be rendered from `sends` + `output` lists without needing a
//! dedicated graph type.

use serde::{Deserialize, Serialize};

use crate::EntityId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IoDirection {
    Input,
    Output,
}

/// One audio or midi port on a track/bus/master.
///
/// `channels` is the number of discrete channels this port carries
/// (1 = mono, 2 = stereo, etc). Remote streams must match this when
/// negotiating an egress/ingress format.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IoPort {
    /// `track.<id>.input.<n>` or `track.<id>.output.<n>`.
    pub id: EntityId,
    /// Human-readable label, e.g. "Mic In", "Bus Out L".
    pub name: String,
    pub direction: IoDirection,
    pub channels: u16,
    /// When a remote client is currently streaming to/from this port,
    /// the peer id is recorded here so other clients see who has it.
    /// None = unclaimed.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub bound_peer: Option<String>,
    /// True for MIDI ports; most Foyer UI surfaces treat those differently
    /// from audio (no level meter, no pan).
    #[serde(default)]
    pub is_midi: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_port_round_trips() {
        let p = IoPort {
            id: EntityId::new("track.vox.input.0"),
            name: "Mic In".into(),
            direction: IoDirection::Input,
            channels: 1,
            bound_peer: None,
            is_midi: false,
        };
        let j = serde_json::to_string(&p).unwrap();
        assert!(j.contains(r#""direction":"input""#));
        let back: IoPort = serde_json::from_str(&j).unwrap();
        assert_eq!(p, back);
    }
}
