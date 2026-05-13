// SPDX-License-Identifier: Apache-2.0
//! DAW-agnostic domain schema for Foyer Studio.
//!
//! Nothing in this crate knows about any specific host DAW. Types here are the neutral
//! currency both the IPC protocol (shim ↔ sidecar) and the WebSocket protocol
//! (sidecar ↔ browser) speak. See `docs/PLAN.md` §4 and §5.

#![forbid(unsafe_code)]

pub mod action;
pub mod audio;
pub mod fs;
pub mod id;
pub mod io;
pub mod message;
pub mod midi;
pub mod plugin;
pub mod session;
pub mod timeline;
pub mod tunnel;
pub mod value;

pub use action::{Action, ActionCategory};
pub use audio::{
    AudioCodec, AudioFormat, AudioPoolSource, AudioSource, AudioTransport, IceCandidate,
    LatencyReport, SampleFormat, SdpPayload,
};
pub use fs::{FsEntry, FsEntryKind, PathListing};
pub use id::EntityId;
pub use io::{EnginePort, IoDirection, IoPort};
pub use message::{
    BackendInfo, ChatMessageRecord, Command, ConnectionRole, ControlUpdate, Envelope, Event,
    OrphanInfo, Patch, PeerInfo, PttSpeaker, RecentEntry, Seq, SessionInfo,
    SessionRecoveryArtifact, TrackBrowserSourceEntry,
};
pub use midi::{
    default_gm_drum_rows, expand_sequencer_layout, sequencer_layout_length_ticks, ArrangementSlot,
    MidiNote, MidiNotePatch, MidiPatchBank, MidiPatchNames, MidiPatchProgram, PatchChange,
    PatchChangePatch, SequencerCell, SequencerLayout, SequencerPattern, SequencerRow,
};
pub use plugin::{PluginCatalogEntry, PluginFormat, PluginPreset, PluginRole};
pub use session::{
    Bus, Group, GroupPatch, MidiPatchState, PluginInstance, Send, Session, Track, TrackKind,
    TrackPatch, Transport, DEFAULT_SAMPLE_RATE,
};
pub use timeline::{
    AudioSourceSegment, FadeShape, Region, RegionPatch, TimelineMeta, WaveformPeaks,
    WaveformRequest,
};
pub use tunnel::{
    TunnelConnection, TunnelCreateToken, TunnelManifest, TunnelProviderConfig, TunnelProviderKind,
    TunnelRevokeToken, TunnelRole, TunnelState, TunnelUp,
};
pub use value::{
    AutomationLane, AutomationMode, AutomationPoint, ControlKind, ControlValue, Parameter,
    ScaleCurve,
};

/// Current wire-schema version. Major bump = breaking; minor = additive.
pub const SCHEMA_VERSION: (u16, u16) = (0, 4);

/// Kubernetes-style named API revision for control-plane envelopes (IPC shim ↔ sidecar
/// and WebSocket). Evolve `v1alpha1` in place during development; promote to `v1beta1` /
/// `v1` when stabilizing breaking changes. The numeric [`SCHEMA_VERSION`] tuple tracks
/// finer-grained wire compatibility.
pub const CONTROL_PLANE_API_VERSION: &str = "foyer.sh/v1alpha1";
