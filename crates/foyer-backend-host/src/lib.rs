// SPDX-License-Identifier: Apache-2.0
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
mod media_staging;

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use foyer_backend::{AudioIngressAck, Backend, BackendError, EventStream, PcmRx, PcmTx};
use foyer_schema::{
    AudioFormat, AudioSource, AutomationMode, AutomationPoint, Command, ControlValue, EnginePort,
    EntityId, LatencyReport, MidiNote, MidiNotePatch, MidiPatchNames, PatchChange,
    PatchChangePatch, PluginCatalogEntry, PluginPreset, Region, RegionPatch, SequencerLayout,
    Session, TimelineMeta, Track, TrackPatch, WaveformPeaks,
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
    fn sample_rate(&self) -> u32 {
        self.client.cached_sample_rate()
    }

    fn transport_position_samples(&self) -> u64 {
        self.client.cached_position_samples()
    }

    fn is_alive(&self) -> bool {
        !self.client.is_disconnected()
    }

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

    async fn set_ingress_capture_latency(
        &self,
        stream_id: u32,
        samples: u32,
    ) -> Result<(), BackendError> {
        self.client
            .send_command(Command::SetIngressCaptureLatency { stream_id, samples })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn set_ingress_ring_prime_ms(&self, ms: u32) -> Result<(), BackendError> {
        self.client
            .send_command(Command::SetIngressRingPrimeMs { ms })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn set_midi_capture_latency(
        &self,
        track_id: EntityId,
        samples: u32,
    ) -> Result<(), BackendError> {
        self.client
            .send_command(Command::SetMidiCaptureLatency { track_id, samples })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn send_midi_input(
        &self,
        data: Vec<u8>,
        track_id: Option<EntityId>,
        echo_server_mono_ns: Option<i64>,
    ) -> Result<(), BackendError> {
        // Fire-and-forget: live MIDI is a real-time stream, dropping
        // a packet under WS backpressure is preferable to queueing
        // (a stale note-on after the user already lifted the key
        // sounds worse than a silent gap).
        self.client
            .send_command(Command::MidiInput {
                data,
                track_id,
                echo_server_mono_ns,
            })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn request_quit(&self) -> Result<(), BackendError> {
        self.client
            .send_command(Command::ShimQuit)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn spectrum_capabilities(
        &self,
    ) -> Result<Option<foyer_schema::SpectrumCapabilities>, BackendError> {
        // Reuse whatever the most-recent snapshot carried — the shim
        // emits the caps inline with the session, and the client
        // caches the latest under `cached_spectrum_caps`.
        Ok(self.client.cached_spectrum_caps())
    }

    async fn subscribe_spectrum(
        &self,
        target: foyer_schema::SpectrumTarget,
        opts: foyer_schema::SpectrumOpts,
    ) -> Result<foyer_schema::SpectrumOpts, BackendError> {
        // Fire-and-forget command + return the requested opts as-is;
        // the shim echoes the actually-applied opts via
        // `Event::SpectrumSubscribed` which the WS layer fans out to
        // clients. Mirrors the AddPlugin pattern (command goes out,
        // event comes back, no synchronous reply).
        self.client
            .send_command(Command::SubscribeSpectrum {
                target,
                opts: opts.clone(),
            })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))?;
        Ok(opts)
    }

    async fn unsubscribe_spectrum(
        &self,
        target: foyer_schema::SpectrumTarget,
    ) -> Result<(), BackendError> {
        self.client
            .send_command(Command::UnsubscribeSpectrum { target })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn add_plugin(
        &self,
        track_id: EntityId,
        plugin_uri: String,
        index: Option<u32>,
        clone_from: Option<EntityId>,
    ) -> Result<(), BackendError> {
        // Shim applies on the event loop + emits a TrackUpdated event
        // when the plugin lands on the route. Fire-and-forget. When
        // `clone_from` is set, the shim copies the source plugin's
        // params into the new instance before the TrackUpdated fires.
        self.client
            .send_command(Command::AddPlugin {
                track_id,
                plugin_uri,
                index,
                clone_from,
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

    async fn move_plugin(&self, plugin_id: EntityId, new_index: u32) -> Result<(), BackendError> {
        // Shim reorders on the event loop and emits a TrackUpdated when
        // the new processor order lands. Fire-and-forget.
        self.client
            .send_command(Command::MovePlugin {
                plugin_id,
                new_index,
            })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn show_plugin_gui(&self, plugin_id: EntityId) -> Result<(), BackendError> {
        self.client
            .send_command(Command::OpenPluginGui { plugin_id })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn hide_plugin_gui(&self, plugin_id: EntityId) -> Result<(), BackendError> {
        self.client
            .send_command(Command::ClosePluginGui { plugin_id })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn toggle_plugin_gui(&self, plugin_id: EntityId) -> Result<(), BackendError> {
        // Schema doesn't carry a Toggle command yet — synthesize one
        // by always sending Open. The shim's Processor::ShowUI signal
        // is mapped onto gtk2_ardour's window proxy which already
        // toggles open/close on its own when re-invoked. If a future
        // refactor demands explicit open vs close semantics, add
        // Command::TogglePluginGui to the schema and wire it here.
        self.client
            .send_command(Command::OpenPluginGui { plugin_id })
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

    fn render_capabilities(&self) -> Option<foyer_schema::RenderCapabilities> {
        // The host client caches the most recent snapshot's `render`
        // field; surface that synchronously so the server can gate
        // the menu entry / agent tool without a round trip.
        self.client.cached_render_caps()
    }

    async fn render_session(
        &self,
        opts: foyer_schema::RenderOptions,
        progress: Option<foyer_backend::ProgressFn>,
    ) -> Result<Vec<foyer_schema::RenderOutput>, BackendError> {
        // The shim demuxes by handle — mint a fresh one per call so
        // parallel renders don't cross wires.
        let handle = uuid::Uuid::new_v4().simple().to_string();
        // The Backend trait's progress is `Box<dyn Fn(u8) + Send + Sync>`
        // and the host client expects the same shape. Just forward.
        self.client
            .render_session(handle, opts, progress)
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
    ) -> Result<(PcmTx, AudioIngressAck), BackendError> {
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

    async fn list_audio_pool(
        &self,
        _session_id: &foyer_schema::EntityId,
    ) -> Result<Vec<foyer_schema::AudioPoolSource>, BackendError> {
        self.client
            .list_audio_pool()
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn import_audio(&self, path: String) -> Result<(), BackendError> {
        self.client
            .import_audio(path)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn media_import_staging_dir_abs(
        &self,
        _session_id: &foyer_schema::EntityId,
        project_file_abs: &str,
    ) -> Result<Option<PathBuf>, BackendError> {
        Ok(Some(media_staging::staging_dir_abs(project_file_abs)))
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
        target_track_id: Option<EntityId>,
    ) -> Result<(), BackendError> {
        self.client
            .duplicate_region(
                source_region_id,
                at_samples,
                length_samples,
                target_track_id,
            )
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn duplicate_region_range(
        &self,
        source_region_id: EntityId,
        source_offset_samples: u64,
        length_samples: u64,
        at_samples: u64,
        target_track_id: Option<EntityId>,
    ) -> Result<(), BackendError> {
        self.client
            .duplicate_region_range(
                source_region_id,
                source_offset_samples,
                length_samples,
                at_samples,
                target_track_id,
            )
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn stretch_region(
        &self,
        id: EntityId,
        new_start_samples: i64,
        new_length_samples: u64,
        anchor: String,
        preserve_pitch: bool,
    ) -> Result<(), BackendError> {
        self.client
            .stretch_region(
                id,
                new_start_samples,
                new_length_samples,
                anchor,
                preserve_pitch,
            )
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn split_region(&self, id: EntityId, at_samples: i64) -> Result<(), BackendError> {
        self.client
            .split_region(id, at_samples)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn reverse_region(&self, id: EntityId) -> Result<(), BackendError> {
        self.client
            .reverse_region(id)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn combine_regions(&self, region_ids: Vec<EntityId>) -> Result<(), BackendError> {
        self.client
            .combine_regions(region_ids)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn strip_silence_region(
        &self,
        id: EntityId,
        threshold_db: f32,
        minimum_length_samples: u64,
        fade_length_samples: u64,
    ) -> Result<(), BackendError> {
        self.client
            .strip_silence_region(
                id,
                threshold_db,
                minimum_length_samples,
                fade_length_samples,
            )
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn pitch_shift_region(&self, id: EntityId, semitones: f32) -> Result<(), BackendError> {
        self.client
            .pitch_shift_region(id, semitones)
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
        source_path: Option<String>,
    ) -> Result<(), BackendError> {
        self.client
            .create_region(
                track_id,
                at_samples,
                length_samples,
                kind,
                name,
                source_path,
            )
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn create_track(
        &self,
        name: String,
        kind: foyer_schema::TrackKind,
        color: Option<String>,
        _after_id: Option<EntityId>,
    ) -> Result<Track, BackendError> {
        // The Ardour shim doesn't have a single CreateTrack command;
        // it expects `invoke_action` with `track.add_audio` /
        // `track.add_midi` / `track.add_bus`. After invocation we
        // poll the snapshot for the newly added track id (the one
        // that wasn't there before), then patch name + color in one
        // follow-up update_track call.
        let action_id: EntityId = match kind {
            foyer_schema::TrackKind::Audio => "track.add_audio".into(),
            foyer_schema::TrackKind::Midi => "track.add_midi".into(),
            foyer_schema::TrackKind::Bus => "track.add_bus".into(),
            foyer_schema::TrackKind::Master | foyer_schema::TrackKind::Monitor => {
                return Err(BackendError::Other(format!(
                    "cannot create a {kind:?} track — master/monitor are immutable on the engine"
                )));
            }
        };
        // Snapshot the pre-create track ids so we can diff after.
        let before: std::collections::HashSet<EntityId> = self
            .snapshot()
            .await?
            .tracks
            .into_iter()
            .map(|t| t.id)
            .collect();
        self.client
            .send_command(Command::InvokeAction { id: action_id })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))?;
        // Poll for the new track. The shim creates the route on its
        // session thread and emits a SessionPatch::Reload + per-track
        // update; rather than wire a new dedicated event channel we
        // poll the snapshot. 30 attempts × 50 ms = 1.5 s budget,
        // which comfortably covers a healthy session-thread tick.
        let mut new_track: Option<Track> = None;
        for _ in 0..30 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let snap = match self.snapshot().await {
                Ok(s) => s,
                Err(_) => continue,
            };
            if let Some(t) = snap.tracks.into_iter().find(|t| !before.contains(&t.id)) {
                new_track = Some(t);
                break;
            }
        }
        let mut track = new_track.ok_or_else(|| {
            BackendError::Other(
                "shim accepted invoke_action but the new track never appeared in the snapshot \
                 within 1.5s — Ardour may have rejected the request"
                    .into(),
            )
        })?;
        // Apply the user-chosen name / color if either differs from
        // Ardour's default. Empty string clears nothing — we only
        // patch when the user actually supplied a value.
        let needs_name = !name.is_empty() && name != track.name;
        let needs_color = color.is_some();
        if needs_name || needs_color {
            let patch = TrackPatch {
                name: needs_name.then(|| name.clone()),
                color: color.clone(),
                ..Default::default()
            };
            match self.client.update_track(track.id.clone(), patch).await {
                Ok(updated) => track = updated,
                Err(e) => {
                    // The track exists; we just couldn't rename it.
                    // Surface a warning but return the created track so
                    // the caller can keep going.
                    tracing::warn!(
                        "create_track: track {} created but rename/recolor failed: {e}",
                        track.id
                    );
                }
            }
        }
        Ok(track)
    }

    async fn update_track(&self, id: EntityId, patch: TrackPatch) -> Result<Track, BackendError> {
        self.client
            .update_track(id, patch)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn delete_track(&self, id: EntityId) -> Result<(), BackendError> {
        self.client
            .send_command(Command::DeleteTrack { id })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn reorder_tracks(&self, ordered_ids: Vec<EntityId>) -> Result<(), BackendError> {
        self.client
            .send_command(Command::ReorderTracks { ordered_ids })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn set_track_midi_channel_mode(
        &self,
        track_id: EntityId,
        direction: String,
        mode: String,
        mask: u16,
    ) -> Result<Track, BackendError> {
        self.client
            .set_track_midi_channel_mode(track_id, direction, mode, mask)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn create_group(
        &self,
        name: String,
        color: Option<String>,
        members: Vec<EntityId>,
    ) -> Result<(), BackendError> {
        self.client
            .send_command(Command::CreateGroup {
                name,
                color,
                members,
            })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn update_group(
        &self,
        id: EntityId,
        patch: foyer_schema::GroupPatch,
    ) -> Result<(), BackendError> {
        self.client
            .send_command(Command::UpdateGroup { id, patch })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn delete_group(&self, id: EntityId) -> Result<(), BackendError> {
        self.client
            .send_command(Command::DeleteGroup { id })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn set_track_input(
        &self,
        track_id: EntityId,
        port_name: Option<String>,
    ) -> Result<(), BackendError> {
        self.client
            .set_track_input(track_id, port_name)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn list_ports(&self, direction: Option<String>) -> Result<Vec<EnginePort>, BackendError> {
        self.client
            .list_ports(direction)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn add_send(
        &self,
        track_id: EntityId,
        target_track_id: EntityId,
        pre_fader: bool,
    ) -> Result<(), BackendError> {
        self.client
            .add_send(track_id, target_track_id, pre_fader)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn remove_send(&self, send_id: EntityId) -> Result<(), BackendError> {
        self.client
            .remove_send(send_id)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn set_send_level(&self, send_id: EntityId, level: f64) -> Result<(), BackendError> {
        self.client
            .set_send_level(send_id, level)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn add_midi_note(&self, region_id: EntityId, note: MidiNote) -> Result<(), BackendError> {
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
        self.client
            .undo()
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn redo(&self) -> Result<(), BackendError> {
        self.client
            .redo()
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn undo_group_begin(&self, name: String) -> Result<(), BackendError> {
        self.client
            .undo_group_begin(name)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn undo_group_end(&self) -> Result<(), BackendError> {
        self.client
            .undo_group_end()
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn list_plugins(&self) -> Result<Vec<PluginCatalogEntry>, BackendError> {
        self.client
            .list_plugins()
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn list_plugin_presets(
        &self,
        plugin_id: EntityId,
    ) -> Result<Vec<PluginPreset>, BackendError> {
        self.client
            .list_plugin_presets(plugin_id)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn list_midi_patch_names(
        &self,
        track_id: EntityId,
        channel: u8,
    ) -> Result<MidiPatchNames, BackendError> {
        self.client
            .list_midi_patch_names(track_id, channel)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn load_plugin_preset(
        &self,
        plugin_id: EntityId,
        preset_id: EntityId,
    ) -> Result<(), BackendError> {
        self.client
            .load_plugin_preset(plugin_id, preset_id)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn add_patch_change(
        &self,
        region_id: EntityId,
        patch_change: PatchChange,
    ) -> Result<(), BackendError> {
        self.client
            .add_patch_change(region_id, patch_change)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn update_patch_change(
        &self,
        region_id: EntityId,
        patch_change_id: EntityId,
        patch: PatchChangePatch,
    ) -> Result<(), BackendError> {
        self.client
            .update_patch_change(region_id, patch_change_id, patch)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn delete_patch_change(
        &self,
        region_id: EntityId,
        patch_change_id: EntityId,
    ) -> Result<(), BackendError> {
        self.client
            .delete_patch_change(region_id, patch_change_id)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn set_track_midi_patch(
        &self,
        track_id: EntityId,
        channel: u8,
        bank: i32,
        program: u8,
    ) -> Result<(), BackendError> {
        self.client
            .set_track_midi_patch(track_id, channel, bank, program)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn set_sequencer_layout(
        &self,
        region_id: EntityId,
        layout: SequencerLayout,
    ) -> Result<(), BackendError> {
        self.client
            .set_sequencer_layout(region_id, layout)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn clear_sequencer_layout(&self, region_id: EntityId) -> Result<(), BackendError> {
        self.client
            .clear_sequencer_layout(region_id)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn set_automation_mode(
        &self,
        lane_id: EntityId,
        mode: AutomationMode,
    ) -> Result<(), BackendError> {
        self.client
            .set_automation_mode(lane_id, mode)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn add_automation_point(
        &self,
        lane_id: EntityId,
        point: AutomationPoint,
    ) -> Result<(), BackendError> {
        self.client
            .add_automation_point(lane_id, point)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn update_automation_point(
        &self,
        lane_id: EntityId,
        original_time_samples: u64,
        new_time_samples: u64,
        value: f64,
    ) -> Result<(), BackendError> {
        self.client
            .update_automation_point(lane_id, original_time_samples, new_time_samples, value)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn delete_automation_point(
        &self,
        lane_id: EntityId,
        time_samples: u64,
    ) -> Result<(), BackendError> {
        self.client
            .delete_automation_point(lane_id, time_samples)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn replace_automation_lane(
        &self,
        lane_id: EntityId,
        points: Vec<AutomationPoint>,
    ) -> Result<(), BackendError> {
        self.client
            .replace_automation_lane(lane_id, points)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
    async fn set_loop_range(
        &self,
        start_samples: u64,
        end_samples: u64,
        enabled: bool,
    ) -> Result<(), BackendError> {
        self.client
            .send_command(Command::SetLoopRange {
                start_samples,
                end_samples,
                enabled,
            })
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn load_waveform(
        &self,
        region_id: EntityId,
        samples_per_peak: u32,
    ) -> Result<WaveformPeaks, BackendError> {
        // Symphonia decoding is CPU-bound: parsing RIFF/MP4 headers
        // and running the codec executes synchronously and routinely
        // burns 100s of ms on a real take. Running it on the same
        // tokio worker that drives the audio encode loop and the
        // shim IPC reader starves both — when the user scroll-zooms
        // a timeline, the resulting flurry of `list_waveform`
        // requests blocks the executor long enough that the
        // browser's audio-frame idle watchdog trips, then the
        // listener's `open_egress` reconnect can't get through
        // either (`/ws/audio/<id> requested but hub has no such
        // stream after 6 s wait`). Move every symphonia call to the
        // blocking pool so the async runtime stays responsive.
        let region = self.client.region_by_id(&region_id).await;
        if let Some(region) = region {
            if !region.source_segments.is_empty() {
                let segments = region.source_segments.clone();
                let region_id_for_decode = region_id.clone();
                let result = tokio::task::spawn_blocking(move || {
                    waveform::decode_peaks_merged(&segments, region_id_for_decode, samples_per_peak)
                })
                .await
                .map_err(|e| BackendError::Other(format!("blocking pool: {e}")))?;
                match result {
                    Ok(peaks) => return Ok(peaks),
                    Err(e) => {
                        tracing::warn!(
                            "symphonia merged decode failed for {region_id:?}: {e} — \
                             falling back to single-file or synthesized peaks"
                        );
                    }
                }
            }
            if let Some(path) = region.source_path.as_deref() {
                let path = std::path::PathBuf::from(path);
                let region_id_for_decode = region_id.clone();
                let source_offset = region.source_offset_samples.unwrap_or(0);
                let length_samples = region.length_samples;
                let result = tokio::task::spawn_blocking(move || {
                    waveform::decode_peaks(
                        &path,
                        region_id_for_decode,
                        samples_per_peak,
                        source_offset,
                        length_samples,
                    )
                })
                .await
                .map_err(|e| BackendError::Other(format!("blocking pool: {e}")))?;
                match result {
                    Ok(peaks) => return Ok(peaks),
                    Err(e) => {
                        tracing::warn!(
                            "symphonia decode failed for {region_id:?}: {e} — \
                             falling back to synthesized peaks"
                        );
                    }
                }
            }
        }
        Ok(foyer_backend::synth_waveform(
            region_id,
            samples_per_peak,
            240,
        ))
    }

    // ── DAW scripting ──────────────────────────────────────────────
    async fn scripting_capabilities(
        &self,
    ) -> Result<Option<foyer_schema::ScriptingCapabilities>, BackendError> {
        Ok(self.client.scripting_capabilities().await)
    }

    async fn list_scripts(&self) -> Result<Vec<foyer_schema::Script>, BackendError> {
        self.client
            .list_scripts()
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn save_script(
        &self,
        script: foyer_schema::Script,
    ) -> Result<foyer_schema::Script, BackendError> {
        self.client
            .save_script(script)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn delete_script(&self, id: EntityId) -> Result<(), BackendError> {
        self.client
            .delete_script(id)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn enable_script(
        &self,
        id: EntityId,
        enabled: bool,
    ) -> Result<foyer_schema::Script, BackendError> {
        self.client
            .enable_script(id, enabled)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn run_script(
        &self,
        id: EntityId,
        args_override: Option<std::collections::BTreeMap<String, String>>,
    ) -> Result<foyer_schema::ScriptRunResult, BackendError> {
        self.client
            .run_script(id, args_override)
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }

    async fn recover_disabled_scripts(&self) -> Result<Vec<foyer_schema::Script>, BackendError> {
        self.client
            .recover_disabled_scripts()
            .await
            .map_err(|e| BackendError::Other(e.to_string()))
    }
}

pub use client::test_helpers;
