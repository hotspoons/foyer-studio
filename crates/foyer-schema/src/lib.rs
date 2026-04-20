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
pub mod value;

pub use action::{Action, ActionCategory};
pub use audio::{
    AudioCodec, AudioFormat, AudioSource, AudioTransport, IceCandidate, LatencyReport,
    SampleFormat, SdpPayload,
};
pub use fs::{FsEntry, FsEntryKind, PathListing};
pub use id::EntityId;
pub use io::{IoDirection, IoPort};
pub use message::{BackendInfo, Command, ControlUpdate, Envelope, Event, Patch, Seq};
pub use midi::{MidiNote, MidiNotePatch};
pub use plugin::{PluginCatalogEntry, PluginFormat, PluginPreset, PluginRole};
pub use session::{
    Bus, Group, GroupPatch, PluginInstance, Send, Session, Track, TrackKind, TrackPatch, Transport,
};
pub use timeline::{Region, RegionPatch, TimelineMeta, WaveformPeaks, WaveformRequest};
pub use value::{ControlKind, ControlValue, Parameter, ScaleCurve};

/// Current wire-schema version. Major bump = breaking; minor = additive.
pub const SCHEMA_VERSION: (u16, u16) = (0, 2);
