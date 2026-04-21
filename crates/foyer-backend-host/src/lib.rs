//! Generic host backend: implements [`Backend`] by speaking [`foyer-ipc`] to a shim.
//!
//! The sidecar doesn't care what's on the other end of the socket — it could be the
//! Ardour shim, a future Reaper shim, or the `fake_shim` used in our integration
//! tests. A correct implementation of the foyer-ipc protocol is the only contract.
//!
//! Architecture:
//! - One reader task pulls frames off the socket, decodes control envelopes into a
//!   broadcast of `Event`s, and routes audio-frame payloads into per-stream mpscs.
//! - One writer task serializes commands (and outgoing ingress audio) onto the socket.
//! - The `Backend` impl itself is a thin facade: each method sends the right command
//!   via the writer channel and, where necessary, waits for the corresponding event.

#![forbid(unsafe_code)]

mod client;
pub mod discovery;

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use foyer_backend::{Backend, BackendError, EventStream, PcmRx, PcmTx};
use foyer_schema::{
    AudioFormat, AudioSource, Command, ControlValue, EntityId, LatencyReport, MidiNote,
    MidiNotePatch, PatchChange, PatchChangePatch, PluginCatalogEntry, PluginPreset, Region,
    RegionPatch, SequencerLayout, Session, TimelineMeta, Track, TrackPatch, WaveformPeaks,
};

mod waveform;

pub use client::{HostClient, HostClientConfig};

/// Backend that proxies to a connected shim over foyer-ipc.
pub struct HostBackend {
    client: Arc<HostClient>,
}

impl HostBackend {
    /// Connect to the shim at `socket_path` (a Unix domain socket). Returns a backend
    /// ready to be handed to the server.
    pub async fn connect(socket_path: PathBuf) -> Result<Self, BackendError> {
        let cfg = HostClientConfig { socket_path };
        let client = HostClient::connect(cfg)
            .await
            .map_err(|e| BackendError::Other(format!("connect: {e}")))?;
        Ok(Self {
            client: Arc::new(client),
        })
    }

    /// For tests / callers who already built a client (e.g. in-memory duplex).
    pub fn from_client(client: HostClient) -> Self {
        Self {
            client: Arc::new(client),
        }
    }
}

#[async_trait]
impl Backend for HostBackend {
    async fn snapshot(&self) -> Result<Session, BackendError> {
        self.client
            .request_snapshot()
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn subscribe(&self) -> Result<EventStream, BackendError> {
        self.client
            .subscribe()
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn set_control(&self, id: EntityId, value: ControlValue) -> Result<(), BackendError> {
        self.client
            .send_command(Command::ControlSet { id, value })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn add_plugin(
        &self,
        track_id: EntityId,
        plugin_uri: String,
        index: Option<u32>,
    ) -> Result<(), BackendError> {
        // Shim applies on the event loop + emits a TrackUpdated event
        // when the plugin lands on the route. Fire-and-forget.
        self.client
            .send_command(Command::AddPlugin {
                track_id,
                plugin_uri,
                index,
            })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn remove_plugin(&self, plugin_id: EntityId) -> Result<(), BackendError> {
        self.client
            .send_command(Command::RemovePlugin { plugin_id })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn save_session(&self, as_path: Option<&str>) -> Result<(), BackendError> {
        // Empty `as_path` means save-in-place (matches the shim's
        // `session.save_state("")` convention).
        self.client
            .send_command(Command::SaveSession {
                as_path: as_path.map(str::to_string),
            })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn invoke_action(&self, id: EntityId) -> Result<(), BackendError> {
        // Forward the whole action id as-is to the shim. The shim's
        // InvokeAction dispatch handles transport.*, edit.*, session.*,
        // track.add_* etc. directly and logs a warning for anything it
        // doesn't recognize. We deliberately don't fall back to the
        // trait-default `set_control` translation: that would race the
        // shim's own transport handling (and a real DAW knows how to
        // dispatch its own verbs better than we can by synthesis).
        self.client
            .send_command(Command::InvokeAction { id })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn open_egress(
        &self,
        stream_id: u32,
        source: AudioSource,
        format: AudioFormat,
    ) -> Result<PcmRx, BackendError> {
        self.client
            .open_egress(stream_id, source, format)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn close_egress(&self, stream_id: u32) -> Result<(), BackendError> {
        // Fire-and-forget — the shim's audio_egress_stopped event
        // will land via the event stream too, but we don't need to
        // wait for it. If the send fails (pipe broken) we just
        // swallow since the session's about to tear down anyway.
        let _ = self
            .client
            .send_command(foyer_schema::Command::AudioEgressStop { stream_id })
            .await;
        Ok(())
    }

    async fn open_ingress(
        &self,
        stream_id: u32,
        source: AudioSource,
        format: AudioFormat,
    ) -> Result<PcmTx, BackendError> {
        self.client
            .open_ingress(stream_id, source, format)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn measure_latency(&self, stream_id: u32) -> Result<LatencyReport, BackendError> {
        self.client
            .measure_latency(stream_id)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn list_regions(
        &self,
        track_id: EntityId,
    ) -> Result<(TimelineMeta, Vec<Region>), BackendError> {
        self.client
            .list_regions(track_id)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn update_region(
        &self,
        id: EntityId,
        patch: RegionPatch,
    ) -> Result<Region, BackendError> {
        self.client
            .update_region(id, patch)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn delete_region(&self, id: EntityId) -> Result<EntityId, BackendError> {
        self.client
            .delete_region(id)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn duplicate_region(
        &self,
        source_region_id: EntityId,
        at_samples: u64,
        length_samples: Option<u64>,
    ) -> Result<(), BackendError> {
        self.client
            .duplicate_region(source_region_id, at_samples, length_samples)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn create_region(
        &self,
        track_id: EntityId,
        at_samples: u64,
        length_samples: Option<u64>,
        kind: String,
        name: Option<String>,
    ) -> Result<(), BackendError> {
        self.client
            .create_region(track_id, at_samples, length_samples, kind, name)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn update_track(
        &self,
        id: EntityId,
        patch: TrackPatch,
    ) -> Result<Track, BackendError> {
        self.client
            .update_track(id, patch)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn add_midi_note(
        &self,
        region_id: EntityId,
        note: MidiNote,
    ) -> Result<(), BackendError> {
        self.client
            .add_midi_note(region_id, note)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn update_midi_note(
        &self,
        region_id: EntityId,
        note_id: EntityId,
        patch: MidiNotePatch,
    ) -> Result<(), BackendError> {
        self.client
            .update_midi_note(region_id, note_id, patch)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn delete_midi_note(
        &self,
        region_id: EntityId,
        note_id: EntityId,
    ) -> Result<(), BackendError> {
        self.client
            .delete_midi_note(region_id, note_id)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn replace_region_notes(
        &self,
        region_id: EntityId,
        notes: Vec<MidiNote>,
    ) -> Result<(), BackendError> {
        self.client
            .replace_region_notes(region_id, notes)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn undo(&self) -> Result<(), BackendError> {
        self.client.undo().await.map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn redo(&self) -> Result<(), BackendError> {
        self.client.redo().await.map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn list_plugins(&self) -> Result<Vec<PluginCatalogEntry>, BackendError> {
        self.client.list_plugins().await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn list_plugin_presets(
        &self,
        plugin_id: EntityId,
    ) -> Result<Vec<PluginPreset>, BackendError> {
        self.client.list_plugin_presets(plugin_id).await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn load_plugin_preset(
        &self,
        plugin_id: EntityId,
        preset_id: EntityId,
    ) -> Result<(), BackendError> {
        self.client.load_plugin_preset(plugin_id, preset_id).await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn add_patch_change(
        &self,
        region_id: EntityId,
        patch_change: PatchChange,
    ) -> Result<(), BackendError> {
        self.client.add_patch_change(region_id, patch_change).await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn update_patch_change(
        &self,
        region_id: EntityId,
        patch_change_id: EntityId,
        patch: PatchChangePatch,
    ) -> Result<(), BackendError> {
        self.client.update_patch_change(region_id, patch_change_id, patch).await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn delete_patch_change(
        &self,
        region_id: EntityId,
        patch_change_id: EntityId,
    ) -> Result<(), BackendError> {
        self.client.delete_patch_change(region_id, patch_change_id).await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn set_sequencer_layout(
        &self,
        region_id: EntityId,
        layout: SequencerLayout,
    ) -> Result<(), BackendError> {
        self.client.set_sequencer_layout(region_id, layout).await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn clear_sequencer_layout(
        &self,
        region_id: EntityId,
    ) -> Result<(), BackendError> {
        self.client.clear_sequencer_layout(region_id).await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn load_waveform(
        &self,
        region_id: EntityId,
        samples_per_peak: u32,
    ) -> Result<WaveformPeaks, BackendError> {
        // If the shim fed us a `source_path` for this region, decode the
        // file with symphonia and decimate to the requested tier. The
        // cache lookup is populated by the reader task as it sees
        // `RegionsList` / `RegionUpdated` events — so a `load_waveform`
        // call for a region the client hasn't listed yet falls through
        // to the placeholder, which is fine.
        if let Some(region) = self.client.region_by_id(&region_id).await {
            if let Some(path) = region.source_path.as_deref() {
                match waveform::decode_peaks(
                    std::path::Path::new(path),
                    region_id.clone(),
                    samples_per_peak,
                    region.source_offset_samples.unwrap_or(0),
                    region.length_samples,
                ) {
                    Ok(peaks) => return Ok(peaks),
                    Err(e) => {
                        tracing::warn!(
                            "symphonia decode failed for {region_id:?} ({path}): {e} — \
                             falling back to synthesized peaks"
                        );
                    }
                }
            }
        }
        Ok(foyer_backend::synth_waveform(region_id, samples_per_peak, 240))
    }
}

pub use client::test_helpers;
