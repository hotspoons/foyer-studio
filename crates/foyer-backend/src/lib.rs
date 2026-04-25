// SPDX-License-Identifier: Apache-2.0
//! The `Backend` trait is the sidecar's view of the world. Implementations:
//!
//! - `foyer-backend-stub` — in-memory fake session for development and demo mode.
//! - `foyer-backend-host` — IPC client that talks to any shim speaking `foyer-ipc`.
//!
//! Nothing above this trait knows which kind of backend is attached.

#![forbid(unsafe_code)]

mod actions;
pub use actions::default_daw_actions;

use std::pin::Pin;

use async_trait::async_trait;
use foyer_schema::{
    Action, AudioFormat, AudioSource, ControlValue, EnginePort, EntityId, Event, LatencyReport,
    MidiNote, MidiNotePatch, PatchChange, PatchChangePatch, PathListing, PluginCatalogEntry,
    PluginPreset, Region, RegionPatch, SequencerLayout, Session, TimelineMeta, Track, TrackPatch,
    WaveformPeaks,
};
use futures::Stream;
use thiserror::Error;
use tokio::sync::mpsc;

#[derive(Debug, Error)]
pub enum BackendError {
    #[error("unknown control id: {0}")]
    UnknownId(EntityId),
    #[error("unsupported audio format: {0}")]
    UnsupportedFormat(String),
    #[error("stream {0} not found")]
    UnknownStream(u32),
    #[error("latency calibration required before arming ingress for record")]
    LatencyNotCalibrated,
    #[error("path escapes jail: {0}")]
    OutsideJail(String),
    #[error("no such path: {0}")]
    NoSuchPath(String),
    #[error("unknown action: {0}")]
    UnknownAction(EntityId),
    #[error("{0}")]
    Other(String),
}

/// A PCM audio frame in the host's native format, interleaved.
#[derive(Debug, Clone)]
pub struct PcmFrame {
    pub stream_id: u32,
    pub samples: Vec<f32>,
}

/// Receiver half used for egress streams (backend → sidecar).
pub type PcmRx = mpsc::Receiver<PcmFrame>;
/// Sender half used for ingress streams (sidecar → backend).
pub type PcmTx = mpsc::Sender<PcmFrame>;

/// The union of everything the sidecar can observe from a backend.
pub type EventStream = Pin<Box<dyn Stream<Item = Event> + Send>>;

#[async_trait]
pub trait Backend: Send + Sync + 'static {
    // ─── state ──────────────────────────────────────────────────────────

    /// Short human-readable identifier for logs / diagnostics. Default is
    /// "unknown" so old backend impls keep compiling; real backends
    /// override (e.g. "stub", "stub-launcher", "host"). Let us tell
    /// whether a given `open_egress` is being served by a connected
    /// shim or by a fallback without hunting through wiring code.
    fn kind_str(&self) -> &'static str {
        "unknown"
    }

    async fn snapshot(&self) -> Result<Session, BackendError>;
    async fn subscribe(&self) -> Result<EventStream, BackendError>;
    async fn set_control(&self, id: EntityId, value: ControlValue) -> Result<(), BackendError>;

    /// Capability snapshot — map of `feature_id → supported`. Emitted in
    /// `ClientGreeting.features` so clients can gate UI for back-ends
    /// with narrower feature sets than Ardour. The default assumes a
    /// full-featured DAW; slim backends (stub, mobile control-surface
    /// adapters) override this to disable specific ids and the
    /// shipping UI hides those surfaces automatically.
    ///
    /// Conventions (non-exhaustive): `"sequencer"`, `"midi"`,
    /// `"surround_pan"`, `"automation"`, `"groups"`, `"sends"`,
    /// `"plugins"`, `"recording"`, `"export"`. Present + `false`
    /// = explicit hide; absent = unknown (UI is optimistic).
    fn features(&self) -> std::collections::BTreeMap<String, bool> {
        use std::collections::BTreeMap;
        let mut f = BTreeMap::new();
        for id in [
            "sequencer",
            "midi",
            "surround_pan",
            "automation",
            "groups",
            "sends",
            "plugins",
            "recording",
            "export",
        ] {
            f.insert(id.into(), true);
        }
        f
    }

    // ─── introspection ──────────────────────────────────────────────────
    //
    // Default implementations return empty results so a backend that hasn't
    // implemented these yet (early shim, or a minimal port of a second DAW)
    // still compiles and runs.

    async fn list_actions(&self) -> Result<Vec<Action>, BackendError> {
        // Common DAW verbs — every backend gets these for free, shims can
        // override to add their own or replace with a curated set.
        Ok(default_daw_actions())
    }
    async fn invoke_action(&self, id: EntityId) -> Result<(), BackendError> {
        // Transport actions map 1:1 onto control sets — every backend has
        // transport.playing / recording / looping / position controls,
        // so wiring these through the generic control plane means the
        // host backend gets Play/Stop/Record/Loop support without the
        // shim implementing an action dispatch table. Shims can still
        // override `invoke_action` to take precedence when they want
        // richer behavior (e.g. Ardour's "goto_start" may do more than
        // just zero the position).
        use foyer_schema::ControlValue;
        let s = id.as_str();
        match s {
            "transport.play" => {
                return self
                    .set_control(EntityId::new("transport.playing"), ControlValue::Bool(true))
                    .await;
            }
            "transport.stop" => {
                return self
                    .set_control(
                        EntityId::new("transport.playing"),
                        ControlValue::Bool(false),
                    )
                    .await;
            }
            "transport.record" => {
                return self
                    .set_control(
                        EntityId::new("transport.recording"),
                        ControlValue::Bool(true),
                    )
                    .await;
            }
            "transport.loop" => {
                // Toggle isn't expressible as a bare `set_control` — we
                // flip to true here and rely on shim-side smarts to
                // interpret a second invocation. Good enough until a
                // dedicated toggle action lands.
                return self
                    .set_control(EntityId::new("transport.looping"), ControlValue::Bool(true))
                    .await;
            }
            "transport.goto_start" => {
                return self
                    .set_control(
                        EntityId::new("transport.position"),
                        ControlValue::Float(0.0),
                    )
                    .await;
            }
            _ => {}
        }
        Err(BackendError::UnknownAction(id))
    }
    async fn list_regions(
        &self,
        _track_id: EntityId,
    ) -> Result<(TimelineMeta, Vec<Region>), BackendError> {
        Ok((
            TimelineMeta {
                sample_rate: 48_000,
                length_samples: 0,
            },
            Vec::new(),
        ))
    }
    async fn list_plugins(&self) -> Result<Vec<PluginCatalogEntry>, BackendError> {
        Ok(Vec::new())
    }
    async fn add_plugin(
        &self,
        _track_id: EntityId,
        _plugin_uri: String,
        _index: Option<u32>,
        _clone_from: Option<EntityId>,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other("add_plugin not supported".into()))
    }
    async fn remove_plugin(&self, _plugin_id: EntityId) -> Result<(), BackendError> {
        Err(BackendError::Other("remove_plugin not supported".into()))
    }
    async fn move_plugin(
        &self,
        _plugin_id: EntityId,
        _new_index: u32,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other("move_plugin not supported".into()))
    }
    async fn browse_path(
        &self,
        _path: &str,
        _show_hidden: bool,
    ) -> Result<PathListing, BackendError> {
        Err(BackendError::Other("browsing not supported".into()))
    }
    async fn open_session(&self, path: &str) -> Result<(), BackendError> {
        Err(BackendError::Other(format!(
            "open_session not supported (requested: {path})"
        )))
    }
    async fn save_session(&self, _as_path: Option<&str>) -> Result<(), BackendError> {
        Err(BackendError::Other("save_session not supported".into()))
    }
    async fn update_region(
        &self,
        _id: EntityId,
        _patch: RegionPatch,
    ) -> Result<Region, BackendError> {
        Err(BackendError::Other("update_region not supported".into()))
    }
    /// Mutate a track's metadata (name, color, group, bus assignment).
    /// Fields in `patch` that are `None` stay unchanged. On success the
    /// backend returns the updated `Track` so the server can rebroadcast
    /// it — that's authoritative even if the shim applies the change
    /// asynchronously (e.g. after clamping).
    async fn update_track(&self, _id: EntityId, _patch: TrackPatch) -> Result<Track, BackendError> {
        Err(BackendError::Other("update_track not supported".into()))
    }
    async fn delete_track(&self, _id: EntityId) -> Result<(), BackendError> {
        Err(BackendError::Other("delete_track not supported".into()))
    }
    async fn reorder_tracks(&self, _ordered_ids: Vec<EntityId>) -> Result<(), BackendError> {
        Err(BackendError::Other("reorder_tracks not supported".into()))
    }

    /// Open a named undo group. Mutations received between this call
    /// and a matching `undo_group_end` land in the same
    /// `UndoTransaction` so one undo step unwinds the whole batch.
    /// Default is a no-op so stubs + minimal backends keep
    /// compiling; the Ardour host implements this against
    /// `Session::begin_reversible_command`. See PLAN 177.
    async fn undo_group_begin(&self, _name: String) -> Result<(), BackendError> {
        Ok(())
    }
    async fn undo_group_end(&self) -> Result<(), BackendError> {
        Ok(())
    }
    async fn create_group(
        &self,
        _name: String,
        _color: Option<String>,
        _members: Vec<EntityId>,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other("create_group not supported".into()))
    }
    async fn update_group(
        &self,
        _id: EntityId,
        _patch: foyer_schema::GroupPatch,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other("update_group not supported".into()))
    }
    async fn delete_group(&self, _id: EntityId) -> Result<(), BackendError> {
        Err(BackendError::Other("delete_group not supported".into()))
    }
    /// Remove a region from its track. Returns the track id the region was
    /// on (so the server can emit `RegionRemoved { track_id, region_id }`).
    async fn delete_region(&self, _id: EntityId) -> Result<EntityId, BackendError> {
        Err(BackendError::Other("delete_region not supported".into()))
    }

    /// Duplicate an existing region onto the same track at a new time
    /// position. Used by the beat sequencer's arrangement "+" button.
    async fn duplicate_region(
        &self,
        _source_region_id: EntityId,
        _at_samples: u64,
        _length_samples: Option<u64>,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other("duplicate_region not supported".into()))
    }

    /// Create a brand-new empty region on the given track.
    /// Fire-and-forget: the host echoes a `RegionsList` once the
    /// playlist has committed.
    async fn create_region(
        &self,
        _track_id: EntityId,
        _at_samples: u64,
        _length_samples: Option<u64>,
        _kind: String,
        _name: Option<String>,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other("create_region not supported".into()))
    }

    // ─── MIDI note edits ────────────────────────────────────────────────
    //
    // The backend is fire-and-forget: it accepts the command and relies
    // on the host echoing a `RegionUpdated` event once the mutation has
    // been applied to the model. Returning `Ok(())` here means "the
    // command was dispatched", not "the model has committed" — callers
    // reconcile via the event stream. This matches the mackie / OSC
    // surface idiom: side-effect fire-and-forget, state ships over the
    // subscription.
    async fn add_midi_note(
        &self,
        _region_id: EntityId,
        _note: MidiNote,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other("add_midi_note not supported".into()))
    }
    async fn update_midi_note(
        &self,
        _region_id: EntityId,
        _note_id: EntityId,
        _patch: MidiNotePatch,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other("update_midi_note not supported".into()))
    }
    async fn delete_midi_note(
        &self,
        _region_id: EntityId,
        _note_id: EntityId,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other("delete_midi_note not supported".into()))
    }

    /// Replace every note in the region with `notes` in one atomic
    /// op. The shim bundles this as a single undo step.
    async fn replace_region_notes(
        &self,
        _region_id: EntityId,
        _notes: Vec<MidiNote>,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other(
            "replace_region_notes not supported".into(),
        ))
    }

    async fn add_patch_change(
        &self,
        _region_id: EntityId,
        _patch_change: PatchChange,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other("add_patch_change not supported".into()))
    }
    async fn update_patch_change(
        &self,
        _region_id: EntityId,
        _patch_change_id: EntityId,
        _patch: PatchChangePatch,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other(
            "update_patch_change not supported".into(),
        ))
    }
    async fn delete_patch_change(
        &self,
        _region_id: EntityId,
        _patch_change_id: EntityId,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other(
            "delete_patch_change not supported".into(),
        ))
    }

    async fn set_sequencer_layout(
        &self,
        _region_id: EntityId,
        _layout: SequencerLayout,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other(
            "set_sequencer_layout not supported".into(),
        ))
    }
    async fn clear_sequencer_layout(&self, _region_id: EntityId) -> Result<(), BackendError> {
        Err(BackendError::Other(
            "clear_sequencer_layout not supported".into(),
        ))
    }

    // ─── automation lanes ───────────────────────────────────────────────
    async fn set_automation_mode(
        &self,
        _lane_id: EntityId,
        _mode: foyer_schema::AutomationMode,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other(
            "set_automation_mode not supported".into(),
        ))
    }
    async fn add_automation_point(
        &self,
        _lane_id: EntityId,
        _point: foyer_schema::AutomationPoint,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other(
            "add_automation_point not supported".into(),
        ))
    }
    async fn update_automation_point(
        &self,
        _lane_id: EntityId,
        _original_time_samples: u64,
        _new_time_samples: u64,
        _value: f64,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other(
            "update_automation_point not supported".into(),
        ))
    }
    async fn delete_automation_point(
        &self,
        _lane_id: EntityId,
        _time_samples: u64,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other(
            "delete_automation_point not supported".into(),
        ))
    }
    async fn replace_automation_lane(
        &self,
        _lane_id: EntityId,
        _points: Vec<foyer_schema::AutomationPoint>,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other(
            "replace_automation_lane not supported".into(),
        ))
    }

    async fn set_loop_range(
        &self,
        _start_samples: u64,
        _end_samples: u64,
        _enabled: bool,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other("set_loop_range not supported".into()))
    }

    // ─── plugin presets ─────────────────────────────────────────────────
    async fn list_plugin_presets(
        &self,
        _plugin_id: EntityId,
    ) -> Result<Vec<PluginPreset>, BackendError> {
        Ok(Vec::new())
    }
    async fn load_plugin_preset(
        &self,
        _plugin_id: EntityId,
        _preset_id: EntityId,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other(
            "load_plugin_preset not supported".into(),
        ))
    }

    // ─── session undo / redo ────────────────────────────────────────────
    async fn undo(&self) -> Result<(), BackendError> {
        Err(BackendError::Other("undo not supported".into()))
    }
    async fn redo(&self) -> Result<(), BackendError> {
        Err(BackendError::Other("redo not supported".into()))
    }
    async fn load_waveform(
        &self,
        region_id: EntityId,
        samples_per_peak: u32,
    ) -> Result<WaveformPeaks, BackendError> {
        // Default: synthesize a deterministic placeholder waveform so the
        // timeline has SOMETHING to draw even when the shim hasn't yet
        // wired up real peak extraction. The shape is seeded by the
        // region id so every region looks unique but stable across
        // zoom-level changes. Real peaks land once a shim provides
        // `Region.source_path` + the sidecar reads audio with symphonia;
        // this fallback is purely cosmetic.
        //
        // Bucket count is arbitrary here (we don't know the region
        // length from this call), so we pick a fixed 240-bucket default.
        // That's enough to read as "waveform" at any zoom, and the
        // client's tier cache still rounds requests the normal way.
        Ok(synth_waveform(region_id, samples_per_peak, 240))
    }
    async fn clear_waveform_cache(
        &self,
        _region_id: Option<EntityId>,
    ) -> Result<u32, BackendError> {
        Ok(0)
    }

    // ─── audio ──────────────────────────────────────────────────────────

    async fn open_egress(
        &self,
        stream_id: u32,
        source: AudioSource,
        format: AudioFormat,
    ) -> Result<PcmRx, BackendError>;

    /// Tear down an egress stream opened with `open_egress`. Default:
    /// no-op (the sidecar's AudioHub also closes its fan-out side);
    /// the host backend forwards a shim command so the RT tap is
    /// actually removed from the master route.
    async fn close_egress(&self, _stream_id: u32) -> Result<(), BackendError> {
        Ok(())
    }

    /// Route a track's audio input to a named port (e.g. "foyer:ingress-123").
    /// `port_name = None` restores default auto-connect. Emits `TrackUpdated`
    /// so clients see the new `inputs` list.
    async fn set_track_input(
        &self,
        _track_id: EntityId,
        _port_name: Option<String>,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other("set_track_input not supported".into()))
    }

    /// Enumerate the engine-level ports the shim can see. `direction`:
    /// `Some("source")` = readable ports, `Some("sink")` = writable,
    /// `None` = both. Default returns an empty list so non-shim
    /// backends (stub) don't advertise ports they can't route to.
    async fn list_ports(
        &self,
        _direction: Option<String>,
    ) -> Result<Vec<EnginePort>, BackendError> {
        Ok(Vec::new())
    }

    /// Add an internal aux send from `track_id` → `target_track_id`
    /// (which must be a bus). `pre_fader` places the send before the
    /// track's own fader processor. Emits `TrackUpdated` so clients
    /// see the new `sends` entry.
    async fn add_send(
        &self,
        _track_id: EntityId,
        _target_track_id: EntityId,
        _pre_fader: bool,
    ) -> Result<(), BackendError> {
        Err(BackendError::Other("add_send not supported".into()))
    }
    /// Remove a previously-added aux send. Emits `TrackUpdated`.
    async fn remove_send(&self, _send_id: EntityId) -> Result<(), BackendError> {
        Err(BackendError::Other("remove_send not supported".into()))
    }
    /// Set an aux send's linear gain (0.0 .. ~2.0).
    async fn set_send_level(&self, _send_id: EntityId, _level: f64) -> Result<(), BackendError> {
        Err(BackendError::Other("set_send_level not supported".into()))
    }

    async fn open_ingress(
        &self,
        stream_id: u32,
        source: AudioSource,
        format: AudioFormat,
    ) -> Result<PcmTx, BackendError>;

    async fn measure_latency(&self, stream_id: u32) -> Result<LatencyReport, BackendError>;
}

/// Generate a deterministic placeholder waveform for a region. Used by the
/// default `Backend::load_waveform` so backends without real peak extraction
/// (host, pre-shim-wiring) still produce something the UI can render.
///
/// Algorithm: a sum of three sinusoids at different frequencies with amplitudes
/// that decay, plus a small quasi-random wiggle, all seeded by the region id's
/// FNV hash so each region looks distinct. Returns min/max pairs per bucket
/// (what the client expects). No unsafe, no `rand` dep — just deterministic
/// math, which is the invariant we actually want (same region → same shape).
pub fn synth_waveform(
    region_id: EntityId,
    samples_per_peak: u32,
    bucket_count: u32,
) -> WaveformPeaks {
    let seed = fnv1a(region_id.as_str().as_bytes());
    // Per-region parameters extracted from the seed.
    let freq_a = 0.12 + (seed as f32 / u64::MAX as f32) * 0.18;
    let freq_b = 0.03 + ((seed >> 16) as f32 / u64::MAX as f32) * 0.06;
    let phase = ((seed >> 32) as f32 / u64::MAX as f32) * std::f32::consts::TAU;
    let peak_amp = 0.55 + ((seed >> 8) as f32 / u64::MAX as f32) * 0.30;

    let mut peaks = Vec::with_capacity(bucket_count as usize * 2);
    for i in 0..bucket_count {
        let t = i as f32 / bucket_count as f32;
        // Envelope: quick attack, sustained body, soft decay.
        let env = (1.0 - (2.0 * t - 1.0).powi(6)).max(0.0);
        // Three harmonics so the shape doesn't look like a pure sine.
        let base = (t * bucket_count as f32 * freq_a + phase).sin() * 0.6
            + (t * bucket_count as f32 * freq_b + phase * 0.5).sin() * 0.25
            + ((i * 37 + 17) as f32).sin() * 0.10;
        let amp = env * peak_amp * base;
        // Bucket is (min, max) — fake a slight min/max spread.
        let spread = env * 0.05;
        let lo = (amp - spread).clamp(-1.0, 1.0);
        let hi = (amp + spread).clamp(-1.0, 1.0);
        peaks.push(lo);
        peaks.push(hi);
    }
    WaveformPeaks {
        region_id,
        channels: 1,
        samples_per_peak,
        peaks,
        bucket_count,
    }
}

/// FNV-1a 64-bit — simple hash with no dep. Used for deterministic seeding.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}
