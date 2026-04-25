// SPDX-License-Identifier: Apache-2.0
//! In-memory stub backend.
//!
//! A small fake session (transport + a handful of tracks) with:
//!
//! - Live meter values that drift so the UI has something moving to render.
//! - Accepts `set_control` writes and echoes `ControlUpdate` events to subscribers.
//! - Produces a synthetic egress audio stream (a sine wave) when asked.
//! - Captures an ingress audio stream into a ring buffer that tests can inspect.
//! - Returns a synthetic fixed latency report on probe.
//!
//! This is the backend that powers demo mode and exercises the whole pipeline without
//! needing a DAW attached.

#![forbid(unsafe_code)]

mod actions;
mod fixtures;
mod jail;
mod regions;
mod state;
mod waveform;

pub use jail::Jail;

use std::f32::consts::TAU;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use std::path::PathBuf;

use async_trait::async_trait;
use foyer_backend::{Backend, BackendError, EventStream, PcmFrame, PcmRx, PcmTx};
use foyer_schema::{
    Action, AudioFormat, AudioSource, ControlUpdate, ControlValue, EntityId, Event, LatencyReport,
    PathListing, PluginCatalogEntry, PluginFormat, PluginRole, Region, RegionPatch, Session,
    TimelineMeta, Track, TrackPatch, WaveformPeaks,
};
use futures::{Stream, StreamExt};
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio_stream::wrappers::BroadcastStream;

use state::StubState;

const EVENT_CHANNEL_CAP: usize = 1024;

pub struct StubBackend {
    state: Arc<Mutex<StubState>>,
    tx: broadcast::Sender<Event>,
    /// Most-recently captured ingress frames, for test inspection.
    ingress_capture: Arc<Mutex<Vec<PcmFrame>>>,
    jail: Option<Arc<Jail>>,
    regions: Arc<Mutex<regions::RegionStore>>,
    waveforms: Arc<Mutex<waveform::WaveformCache>>,
    /// Handle to the meter-tick task — aborted on drop so repeated
    /// backend-swaps don't leak a tick task per swap.
    meter_handle: Option<tokio::task::JoinHandle<()>>,
    /// When true, `open_egress` emits a 440 Hz reference sine. When
    /// false (the default) the stub refuses egress with a typed
    /// `AudioEgressUnavailable` error so the WS layer doesn't fall
    /// back to its sidecar test tone either — silent until a real
    /// DAW backend takes over. Opt-in via CLI `--stub-test-tone`
    /// or `backends[id=stub].stub_test_tone: true` in config.
    test_tone: bool,
}

impl Drop for StubBackend {
    fn drop(&mut self) {
        if let Some(h) = self.meter_handle.take() {
            h.abort();
        }
    }
}

impl StubBackend {
    pub fn new() -> Self {
        let state = Arc::new(Mutex::new(StubState::new()));
        let (tx, _) = broadcast::channel(EVENT_CHANNEL_CAP);
        let mut backend = Self {
            state,
            tx,
            ingress_capture: Arc::new(Mutex::new(Vec::new())),
            jail: None,
            regions: Arc::new(Mutex::new(regions::RegionStore::new())),
            waveforms: Arc::new(Mutex::new(waveform::WaveformCache::new())),
            meter_handle: None,
            test_tone: false,
        };
        backend.meter_handle = Some(backend.spawn_meter_tick());
        backend
    }

    /// Launcher-mode stub: empty Session (no tracks, regions, or plugins),
    /// transport still present so the toolbar renders. Use this when the
    /// sidecar boots in "picker-only" mode — the user hasn't opened a
    /// project yet, so the mixer/timeline should render their empty-state
    /// rather than showing the demo fixtures. No meter tick is spawned
    /// since there are no tracks to meter.
    pub fn launcher() -> Self {
        let state = Arc::new(Mutex::new(StubState::empty()));
        let (tx, _) = broadcast::channel(EVENT_CHANNEL_CAP);
        Self {
            state,
            tx,
            ingress_capture: Arc::new(Mutex::new(Vec::new())),
            jail: None,
            regions: Arc::new(Mutex::new(regions::RegionStore::new())),
            waveforms: Arc::new(Mutex::new(waveform::WaveformCache::new())),
            meter_handle: None,
            test_tone: false,
        }
    }

    /// Enable the 440 Hz reference test tone on egress streams.
    /// Off by default — the stub is silent until a real DAW backend
    /// takes over. Useful for end-to-end audio path debugging.
    pub fn with_test_tone(mut self, on: bool) -> Self {
        self.test_tone = on;
        self
    }

    /// Attach a jail so filesystem browsing works against the given root.
    /// Without this, `browse_path` returns an error.
    pub fn with_jail(mut self, root: PathBuf) -> Self {
        self.jail = Some(Arc::new(Jail::new(root)));
        self
    }

    /// Read-only access to captured ingress frames — for tests.
    pub async fn captured_ingress(&self) -> Vec<PcmFrame> {
        self.ingress_capture.lock().await.clone()
    }

    fn spawn_meter_tick(&self) -> tokio::task::JoinHandle<()> {
        let state = self.state.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(33));
            loop {
                ticker.tick().await;
                let updates = state.lock().await.tick_meters();
                // No subscribers is fine — broadcast::send returns err, ignore it.
                let _ = tx.send(Event::MeterBatch { values: updates });
            }
        })
    }
}

impl Default for StubBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Backend for StubBackend {
    async fn snapshot(&self) -> Result<Session, BackendError> {
        Ok(self.state.lock().await.session_clone())
    }

    async fn subscribe(&self) -> Result<EventStream, BackendError> {
        let snapshot = self.snapshot().await?;
        let rx = self.tx.subscribe();
        let live = BroadcastStream::new(rx).filter_map(|r| async move { r.ok() });
        let initial = futures::stream::once(async move {
            Event::SessionSnapshot {
                session: Box::new(snapshot),
            }
        });
        let combined = initial.chain(live);
        let boxed: Pin<Box<dyn Stream<Item = Event> + Send>> = Box::pin(combined);
        Ok(boxed)
    }

    async fn set_control(&self, id: EntityId, value: ControlValue) -> Result<(), BackendError> {
        let mut st = self.state.lock().await;
        st.set_control(&id, value.clone())?;
        let _ = self.tx.send(Event::ControlUpdate {
            update: ControlUpdate { id, value },
        });
        Ok(())
    }

    async fn open_egress(
        &self,
        stream_id: u32,
        _source: AudioSource,
        format: AudioFormat,
    ) -> Result<PcmRx, BackendError> {
        // Default behavior: silent. Returning the typed
        // `AudioEgressUnavailable` error tells the WS layer NOT to
        // fall back to its sidecar test tone — the user hears
        // nothing, which is what they want when no DAW is connected
        // and they're just sitting on the stub launcher. Flip
        // `--stub-test-tone` on the CLI (or set `stub_test_tone:
        // true` under the stub backend in config.yaml) to opt in.
        if !self.test_tone {
            return Err(BackendError::AudioEgressUnavailable);
        }
        let (tx, rx) = mpsc::channel::<PcmFrame>(64);
        // Emit a 440 Hz sine at the negotiated rate until the receiver
        // closes. Frequency + amplitude match the sidecar's
        // `spawn_test_tone_source` in [audio.rs] so a listener can't
        // tell "backend is the stub (launcher mode)" from "backend
        // errored and fell back to the sidecar test tone" by ear —
        // both produce the same reference signal. This saves half a
        // day of debugging vs. the previous 220 Hz / 0.2 amp picks
        // which looked EXACTLY like "Chrome's Opus decoder is
        // halving the signal" and sent us on a long goose chase.
        tokio::spawn(async move {
            let mut phase: f32 = 0.0;
            let dphase = TAU * 440.0 / format.sample_rate as f32;
            let frame_period = Duration::from_micros(
                (format.frame_size as u64 * 1_000_000) / format.sample_rate as u64,
            );
            let mut ticker = tokio::time::interval(frame_period);
            loop {
                ticker.tick().await;
                let mut samples =
                    Vec::with_capacity(format.frame_size as usize * format.channels as usize);
                for _ in 0..format.frame_size {
                    let s = (phase).sin() * 0.2;
                    phase = (phase + dphase) % TAU;
                    for _ in 0..format.channels {
                        samples.push(s);
                    }
                }
                if tx.send(PcmFrame { stream_id, samples }).await.is_err() {
                    break;
                }
            }
        });
        Ok(rx)
    }

    async fn open_ingress(
        &self,
        stream_id: u32,
        _source: AudioSource,
        format: AudioFormat,
    ) -> Result<PcmTx, BackendError> {
        let (tx, mut rx) = mpsc::channel::<PcmFrame>(64);
        let capture = self.ingress_capture.clone();
        tokio::spawn(async move {
            while let Some(mut frame) = rx.recv().await {
                frame.stream_id = stream_id;
                capture.lock().await.push(frame);
            }
        });
        // sanity: enforce a known format at least shape-wise
        if format.channels == 0 {
            return Err(BackendError::UnsupportedFormat("zero channels".into()));
        }
        Ok(tx)
    }

    async fn measure_latency(&self, _stream_id: u32) -> Result<LatencyReport, BackendError> {
        // Fixed synthetic number for the stub: 4800 samples @ 48k = 100ms round-trip.
        Ok(LatencyReport {
            round_trip_samples: 4800,
            sample_rate: 48_000,
            jitter_samples: 8,
        })
    }

    async fn list_actions(&self) -> Result<Vec<Action>, BackendError> {
        Ok(actions::catalog())
    }

    async fn invoke_action(&self, id: EntityId) -> Result<(), BackendError> {
        let catalog = actions::catalog();
        if !catalog.iter().any(|a| a.id == id) {
            return Err(BackendError::UnknownAction(id));
        }
        // Map a handful of actions onto our existing controls so agent/palette
        // invocations actually move things on screen.
        match id.as_str() {
            "transport.play" => {
                self.set_control(EntityId::new("transport.playing"), ControlValue::Bool(true))
                    .await?;
            }
            "transport.stop" => {
                self.set_control(
                    EntityId::new("transport.playing"),
                    ControlValue::Bool(false),
                )
                .await?;
            }
            "transport.record" => {
                let cur = self
                    .state
                    .lock()
                    .await
                    .session_clone()
                    .transport
                    .recording
                    .value;
                let next = !matches!(cur, ControlValue::Bool(true));
                self.set_control(
                    EntityId::new("transport.recording"),
                    ControlValue::Bool(next),
                )
                .await?;
            }
            "transport.loop" => {
                let cur = self
                    .state
                    .lock()
                    .await
                    .session_clone()
                    .transport
                    .looping
                    .value;
                let next = !matches!(cur, ControlValue::Bool(true));
                self.set_control(EntityId::new("transport.looping"), ControlValue::Bool(next))
                    .await?;
            }
            _ => {
                // Other actions are no-ops in the stub but accepted so UIs can
                // exercise the dispatch path.
            }
        }
        Ok(())
    }

    async fn list_regions(
        &self,
        track_id: EntityId,
    ) -> Result<(TimelineMeta, Vec<Region>), BackendError> {
        let meta = TimelineMeta {
            sample_rate: 48_000,
            length_samples: 48_000 * 60, // 60 seconds of timeline
        };
        let regions = self.regions.lock().await.regions_for(&track_id).clone();
        Ok((meta, regions))
    }

    async fn delete_region(&self, id: EntityId) -> Result<EntityId, BackendError> {
        let track_id = {
            let mut store = self.regions.lock().await;
            store.delete(&id)
        }
        .ok_or_else(|| BackendError::Other(format!("unknown region {id}")))?;
        self.waveforms.lock().await.clear_region(&id);
        Ok(track_id)
    }

    async fn update_track(&self, id: EntityId, patch: TrackPatch) -> Result<Track, BackendError> {
        let updated = self
            .state
            .lock()
            .await
            .update_track(&id, &patch)
            .ok_or_else(|| BackendError::Other(format!("unknown track {id}")))?;
        // Echo to all subscribers so every browser repaints, not just the caller.
        let _ = self.tx.send(Event::TrackUpdated {
            track: Box::new(updated.clone()),
        });
        Ok(updated)
    }

    async fn set_automation_mode(
        &self,
        lane_id: EntityId,
        mode: foyer_schema::AutomationMode,
    ) -> Result<(), BackendError> {
        self.state.lock().await.set_automation_mode(&lane_id, mode)
    }
    async fn add_automation_point(
        &self,
        lane_id: EntityId,
        point: foyer_schema::AutomationPoint,
    ) -> Result<(), BackendError> {
        self.state
            .lock()
            .await
            .add_automation_point(&lane_id, point)
    }
    async fn update_automation_point(
        &self,
        lane_id: EntityId,
        original_time_samples: u64,
        new_time_samples: u64,
        value: f64,
    ) -> Result<(), BackendError> {
        self.state.lock().await.update_automation_point(
            &lane_id,
            original_time_samples,
            new_time_samples,
            value,
        )
    }
    async fn delete_automation_point(
        &self,
        lane_id: EntityId,
        time_samples: u64,
    ) -> Result<(), BackendError> {
        self.state
            .lock()
            .await
            .delete_automation_point(&lane_id, time_samples)
    }
    async fn replace_automation_lane(
        &self,
        lane_id: EntityId,
        points: Vec<foyer_schema::AutomationPoint>,
    ) -> Result<(), BackendError> {
        self.state
            .lock()
            .await
            .replace_automation_lane(&lane_id, points)
    }

    async fn update_region(
        &self,
        id: EntityId,
        patch: RegionPatch,
    ) -> Result<Region, BackendError> {
        let updated = self
            .regions
            .lock()
            .await
            .update(&id, &patch)
            .ok_or_else(|| BackendError::Other(format!("unknown region {id}")))?;
        // Moving or resizing invalidates the cached peaks for that region.
        self.waveforms.lock().await.clear_region(&id);
        // Broadcast so every other subscriber repaints.
        let _ = self.tx.send(Event::RegionUpdated {
            region: updated.clone(),
        });
        Ok(updated)
    }

    async fn load_waveform(
        &self,
        region_id: EntityId,
        samples_per_peak: u32,
    ) -> Result<WaveformPeaks, BackendError> {
        // Look up the region across all tracks.
        let maybe_region = {
            let mut store = self.regions.lock().await;
            // We need to scan all known tracks; eagerly materialize known
            // tracks from the session so refs survive.
            let session = self.state.lock().await.session_clone();
            for t in &session.tracks {
                store.regions_for(&t.id);
            }
            // Find the region anywhere.
            let mut found: Option<Region> = None;
            for t in &session.tracks {
                for r in store.regions_for(&t.id) {
                    if r.id == region_id {
                        found = Some(r.clone());
                        break;
                    }
                }
                if found.is_some() {
                    break;
                }
            }
            found
        };
        let region = maybe_region
            .ok_or_else(|| BackendError::Other(format!("unknown region {region_id}")))?;
        let peaks = self
            .waveforms
            .lock()
            .await
            .get_or_compute(&region, samples_per_peak.max(1));
        Ok(peaks)
    }

    async fn clear_waveform_cache(&self, region_id: Option<EntityId>) -> Result<u32, BackendError> {
        let mut cache = self.waveforms.lock().await;
        let dropped = match region_id {
            Some(id) => cache.clear_region(&id),
            None => cache.clear_all(),
        };
        Ok(dropped)
    }

    async fn list_plugins(&self) -> Result<Vec<PluginCatalogEntry>, BackendError> {
        let mk = |id: &str, name: &str, format: PluginFormat, role: PluginRole, vendor: &str| {
            PluginCatalogEntry {
                id: EntityId::new(id),
                name: name.into(),
                format,
                role,
                vendor: Some(vendor.into()),
                uri: None,
                tags: Vec::new(),
            }
        };
        Ok(vec![
            mk(
                "lv2:eq",
                "x42 EQ",
                PluginFormat::Lv2,
                PluginRole::Effect,
                "x42",
            ),
            mk(
                "lv2:comp",
                "x42 Compressor",
                PluginFormat::Lv2,
                PluginRole::Effect,
                "x42",
            ),
            mk(
                "lv2:reverb",
                "Calf Reverb",
                PluginFormat::Lv2,
                PluginRole::Effect,
                "Calf Studio Gear",
            ),
            mk(
                "lv2:limiter",
                "TDR Limiter",
                PluginFormat::Lv2,
                PluginRole::Effect,
                "Tokyo Dawn Labs",
            ),
            mk(
                "lv2:synth",
                "Helm",
                PluginFormat::Lv2,
                PluginRole::Instrument,
                "Matt Tytel",
            ),
            mk(
                "vst3:saturator",
                "Klevgränd Squasher",
                PluginFormat::Vst3,
                PluginRole::Effect,
                "Klevgränd",
            ),
        ])
    }

    async fn browse_path(
        &self,
        path: &str,
        show_hidden: bool,
    ) -> Result<PathListing, BackendError> {
        let jail = self
            .jail
            .as_ref()
            .ok_or_else(|| BackendError::Other("no jail configured".into()))?;
        jail.browse(path, show_hidden)
    }

    async fn open_session(&self, path: &str) -> Result<(), BackendError> {
        // Stub doesn't actually load — just emits SessionChanged for UX.
        let _ = self.tx.send(Event::SessionChanged {
            path: Some(path.to_string()),
        });
        Ok(())
    }

    async fn save_session(&self, as_path: Option<&str>) -> Result<(), BackendError> {
        if let Some(p) = as_path {
            let _ = self.tx.send(Event::SessionChanged {
                path: Some(p.to_string()),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use foyer_schema::SCHEMA_VERSION;
    use std::time::Duration;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_is_well_formed() {
        let b = StubBackend::new();
        let s = b.snapshot().await.unwrap();
        assert_eq!(s.schema_version, SCHEMA_VERSION);
        assert!(!s.tracks.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_control_echoes_event() {
        let b = StubBackend::new();
        let mut stream = b.subscribe().await.unwrap();
        // first event is the snapshot
        let first = stream.next().await.unwrap();
        assert!(matches!(first, Event::SessionSnapshot { .. }));
        let id = EntityId::new("transport.tempo");
        b.set_control(id.clone(), ControlValue::Float(144.0))
            .await
            .unwrap();

        // Pull events for up to 250ms looking for our update; meter batches are noise.
        let deadline = tokio::time::sleep(Duration::from_millis(250));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => panic!("no control update observed"),
                ev = stream.next() => {
                    match ev {
                        Some(Event::ControlUpdate { update }) if update.id == id => {
                            assert_eq!(update.value, ControlValue::Float(144.0));
                            break;
                        }
                        Some(_) => continue,
                        None => panic!("stream ended"),
                    }
                }
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn egress_stream_produces_frames_when_test_tone_enabled() {
        // The default stub is silent (`AudioEgressUnavailable`); the
        // test tone is opt-in via `with_test_tone(true)`. The
        // generator behavior we're checking — frame size, channel
        // count, stream id round-trip — is what the test exercises.
        let b = StubBackend::new().with_test_tone(true);
        let fmt = AudioFormat::new(48_000, 2, 128);
        let mut rx = b.open_egress(1, AudioSource::Master, fmt).await.unwrap();
        let f = tokio::time::timeout(Duration::from_millis(200), rx.recv())
            .await
            .expect("timed out")
            .expect("closed");
        assert_eq!(f.stream_id, 1);
        assert_eq!(f.samples.len(), 128 * 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn egress_default_is_silent() {
        // Without `with_test_tone(true)`, the stub declines egress
        // with the typed `AudioEgressUnavailable` error so the WS
        // layer knows not to fall back to its sidecar test tone.
        let b = StubBackend::new();
        let fmt = AudioFormat::new(48_000, 2, 128);
        let res = b.open_egress(1, AudioSource::Master, fmt).await;
        assert!(matches!(res, Err(BackendError::AudioEgressUnavailable)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ingress_is_captured() {
        let b = StubBackend::new();
        let fmt = AudioFormat::new(48_000, 1, 64);
        let tx = b
            .open_ingress(
                2,
                AudioSource::VirtualInput {
                    name: "remote-1".into(),
                },
                fmt,
            )
            .await
            .unwrap();
        tx.send(PcmFrame {
            stream_id: 2,
            samples: vec![0.1; 64],
        })
        .await
        .unwrap();
        // wait a scheduling beat
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(tx);
        let captured = b.captured_ingress().await;
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].samples.len(), 64);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn latency_probe_returns_sensible_number() {
        let b = StubBackend::new();
        let r = b.measure_latency(0).await.unwrap();
        assert!(r.one_way_ms() > 0.0);
    }
}
