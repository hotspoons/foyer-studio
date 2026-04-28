//! Audio-stream metadata shared across both wire protocols.
//!
//! Binary PCM frames themselves travel out-of-band in `foyer-ipc` (length-prefixed
//! binary envelope) and via WebRTC on the browser side; this module only describes
//! the control-plane types.

use serde::{Deserialize, Serialize};

use crate::EntityId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SampleFormat {
    /// 32-bit float, native endianness, interleaved frames.
    F32Le,
}

/// Which compression the sidecar should apply before forwarding
/// audio. `Opus` is the default for WAN-friendly monitoring;
/// `RawF32Le` ships the PCM samples uncompressed for lossless
/// tracking-grade monitoring on fast local links. Lossless roughly
/// 6× the bandwidth of Opus 96 kbps — fine for gigabit, not fine
/// for coffee-shop wifi.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AudioCodec {
    #[default]
    Opus,
    RawF32Le,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub format: SampleFormat,
    /// Samples per channel per frame (the "block size"). 128 matches Web Audio
    /// AudioWorklet; host DAWs typically use 64/128/256/512.
    pub frame_size: u32,
    /// Compression applied by the sidecar. Clients that want lossless
    /// (gigabit LAN, tracking sessions) ask for `RawF32Le`; everyone
    /// else gets Opus 96 kbps and the same UX with 1/6 the bandwidth.
    #[serde(default)]
    pub codec: AudioCodec,
}

impl AudioFormat {
    pub const fn new(sample_rate: u32, channels: u16, frame_size: u32) -> Self {
        Self {
            sample_rate,
            channels,
            format: SampleFormat::F32Le,
            frame_size,
            codec: AudioCodec::Opus,
        }
    }

    pub const fn new_with_codec(
        sample_rate: u32,
        channels: u16,
        frame_size: u32,
        codec: AudioCodec,
    ) -> Self {
        Self {
            sample_rate,
            channels,
            format: SampleFormat::F32Le,
            frame_size,
            codec,
        }
    }
}

/// What the shim is being asked to tap (egress) or which virtual input a caller wants
/// to deliver to (ingress).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AudioSource {
    /// The master/main bus.
    Master,
    /// A specific track or bus, referenced by its schema ID.
    Track { id: EntityId },
    /// The monitor/control-room bus.
    Monitor,
    /// A named virtual input port on the host (ingress).
    VirtualInput { name: String },
    /// A specific I/O port (see `foyer_schema::io::IoPort`). Used for
    /// tracking-grade remote mics/instruments that need to address an
    /// exact port rather than the aggregated track.
    Port { id: EntityId },
}

/// How PCM frames for an audio stream move between sidecar and browser.
///
/// Control-plane negotiation (format, `stream_id`) still travels over the
/// WebSocket regardless of transport. Only the PCM payload path differs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AudioTransport {
    /// Binary WebSocket frames. Simplest path — works everywhere, no
    /// TURN/STUN, but has browser buffering characteristics that add ~40
    /// ms of effective latency. Good for monitoring, not for tracking.
    WebSocket,
    /// WebRTC PeerConnection (datachannel for opus, or RTP audio track).
    /// The shim emits an `AudioSdpOffer` event in reply; the client
    /// answers with `Command::AudioSdpAnswer`. ICE candidates travel via
    /// `AudioIceCandidate` events/commands.
    WebRtc,
}

/// Signaling payload exchanged during WebRTC setup. Kept opaque so we
/// don't try to re-implement browser SDP semantics server-side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SdpPayload {
    pub sdp: String,
    /// `"offer"` | `"answer"` | `"pranswer"` — matches `RTCSdpType` on the
    /// browser side verbatim.
    #[serde(rename = "type")]
    pub sdp_type: String,
}

/// A single WebRTC ICE candidate as emitted/consumed by the browser's
/// `RTCPeerConnection`. The shim treats this payload opaquely — it just
/// relays candidates through to the peer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IceCandidate {
    pub candidate: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sdp_mid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sdp_m_line_index: Option<u16>,
}

/// Round-trip latency measurement produced by an audio-path calibration probe.
/// Locked into the shim's input delay compensation for the duration of a tracking
/// session — not chased dynamically (jitter would cause timeline drift).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LatencyReport {
    /// Full round-trip: browser capture + WebRTC + sidecar + IPC + host input buffer
    /// (and back for the probe), measured in samples at the host's rate.
    pub round_trip_samples: u64,
    /// Host sample rate the measurement was taken at.
    pub sample_rate: u32,
    /// Confidence/jitter indicator; lower is better.
    pub jitter_samples: u32,
}

impl LatencyReport {
    pub fn one_way_ms(&self) -> f64 {
        (self.round_trip_samples as f64 / 2.0) * 1000.0 / self.sample_rate as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_way_latency_from_round_trip() {
        // 4800 samples round-trip at 48k = 100 ms RT → 50 ms one-way.
        let r = LatencyReport {
            round_trip_samples: 4800,
            sample_rate: 48_000,
            jitter_samples: 8,
        };
        assert!((r.one_way_ms() - 50.0).abs() < 1e-9);
    }

    #[test]
    fn audio_source_round_trips() {
        let s = AudioSource::Track {
            id: EntityId::new("track.abc"),
        };
        let j = serde_json::to_string(&s).unwrap();
        assert!(j.contains(r#""kind":"track""#));
        let back: AudioSource = serde_json::from_str(&j).unwrap();
        assert_eq!(s, back);
    }
}
