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
mod spectrum;
mod state;
mod stub_media_pool;
mod waveform;

pub use jail::Jail;

use std::f32::consts::TAU;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use std::path::PathBuf;

use async_trait::async_trait;
use foyer_backend::{
    AudioIngressAck, Backend, BackendError, EventStream, PcmFrame, PcmRx, PcmTx, ProgressFn,
};
use foyer_schema::{
    Action, AudioFormat, AudioPoolSource, AudioSource, ControlValue, EnginePort, EntityId, Event,
    LatencyReport, PathListing, PluginCatalogEntry, PluginFormat, PluginRole, Region, RegionPatch,
    RenderBitDepth, RenderCapabilities, RenderFormat, RenderOptions, RenderOutput, RenderRange,
    RenderTarget, Session, TimelineMeta, Track, TrackPatch, WaveformPeaks,
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
    /// Active spectrum-subscription pump. Spawns a per-hub task only
    /// while subscriptions exist; idle sessions pay nothing.
    spectrum: spectrum::SpectrumHub,
    /// Monotonic seed for `regions::fresh_region_id` — bumped on every
    /// duplicate so concurrent paste batches don't collide.
    dup_seed: std::sync::atomic::AtomicU64,
    /// Mirror of `Session::sample_rate` — kept on the backend so the
    /// sync `Backend::sample_rate()` call doesn't need to acquire
    /// the state mutex for what's a hot read (timeline pixel math
    /// and peak-cache decisions hit it on every render). Stays in
    /// sync with the session because there's no API to change SR
    /// after construction.
    sample_rate: std::sync::atomic::AtomicU32,
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
        let sr = foyer_schema::DEFAULT_SAMPLE_RATE;
        let mut backend = Self {
            state,
            tx,
            ingress_capture: Arc::new(Mutex::new(Vec::new())),
            jail: None,
            regions: Arc::new(Mutex::new(regions::RegionStore::new())),
            waveforms: Arc::new(Mutex::new(waveform::WaveformCache::new())),
            dup_seed: std::sync::atomic::AtomicU64::new(1),
            sample_rate: std::sync::atomic::AtomicU32::new(sr),
            meter_handle: None,
            test_tone: false,
            spectrum: spectrum::SpectrumHub::new(),
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
            dup_seed: std::sync::atomic::AtomicU64::new(1),
            sample_rate: std::sync::atomic::AtomicU32::new(foyer_schema::DEFAULT_SAMPLE_RATE),
            meter_handle: None,
            test_tone: false,
            spectrum: spectrum::SpectrumHub::new(),
        }
    }

    fn next_dup_seed(&self) -> u64 {
        self.dup_seed
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    /// Find the track owning an automation lane and broadcast its
    /// fresh state to every subscriber. Called after any automation
    /// mutation (set_mode / add / update / delete / replace point) so
    /// every client sees the change land — previously the stub
    /// mutated silently and the UI never refreshed past the
    /// optimistic local apply, which made plugin-param automation
    /// look broken even though the wire round-trip worked.
    async fn broadcast_track_for_lane(&self, lane_id: &EntityId) {
        let updated_track = {
            let st = self.state.lock().await;
            let session = st.session_clone();
            session
                .tracks
                .into_iter()
                .find(|t| t.automation_lanes.iter().any(|l| &l.control_id == lane_id))
        };
        if let Some(track) = updated_track {
            let _ = self.tx.send(Event::TrackUpdated {
                track: Box::new(track),
            });
        }
    }

    /// Reject a cross-track paste when source and destination track
    /// kinds disagree (audio↔midi). Returns `Ok(())` for same-track
    /// pastes and same-kind cross-track pastes; an error containing
    /// both track ids otherwise. Caller must hold the regions store
    /// lock to ensure the track lookup is consistent.
    async fn validate_cross_track_paste(
        &self,
        source_track_id: &EntityId,
        dest_track_id: &EntityId,
    ) -> Result<(), BackendError> {
        if source_track_id == dest_track_id {
            return Ok(());
        }
        let session = self.state.lock().await.session_clone();
        let source_kind = session
            .tracks
            .iter()
            .find(|t| &t.id == source_track_id)
            .map(|t| t.kind);
        let dest_kind = session
            .tracks
            .iter()
            .find(|t| &t.id == dest_track_id)
            .map(|t| t.kind);
        match (source_kind, dest_kind) {
            (Some(a), Some(b)) if a == b => Ok(()),
            (Some(a), Some(b)) => Err(BackendError::Other(format!(
                "cross-kind paste not supported: source is {a:?}, target is {b:?}"
            ))),
            (None, _) => Err(BackendError::Other(format!(
                "duplicate_region: unknown source track {source_track_id}"
            ))),
            (_, None) => Err(BackendError::Other(format!(
                "duplicate_region: unknown target track {dest_track_id}"
            ))),
        }
    }

    /// `TimelineMeta` snapshot for the stub's fake 60-second timeline.
    /// Sample rate comes from the live atomic so future "switch SR
    /// at runtime" wiring (whenever it lands) doesn't have to hunt
    /// every event-emit site. Keeping the length scaled by SR keeps
    /// the timeline a constant 60 wall-clock seconds regardless of
    /// rate.
    fn timeline_meta(&self) -> TimelineMeta {
        let sr = self.sample_rate();
        TimelineMeta {
            sample_rate: sr,
            length_samples: u64::from(sr) * 60,
        }
    }

    /// Enable the 440 Hz reference test tone on egress streams.
    /// Off by default — the stub is silent until a real DAW backend
    /// takes over. Useful for end-to-end audio path debugging.
    pub fn with_test_tone(mut self, on: bool) -> Self {
        self.test_tone = on;
        self
    }

    /// Pin the engine sample rate. Updates both the cached atomic
    /// and the underlying `Session::sample_rate` so subsequent
    /// snapshot calls + region-list events agree. Resolution chain
    /// for callers (CLI > env > config > schema default) lives in
    /// the binary; this method is just a typed setter so each
    /// construction site can take whatever value the resolver
    /// settled on.
    pub fn with_sample_rate(self, sr: u32) -> Self {
        let sr = sr.max(8_000);
        self.sample_rate
            .store(sr, std::sync::atomic::Ordering::Relaxed);
        // Mutating via a blocking lock is fine here — `with_*`
        // builders are called pre-spawn before any task subscribes.
        // Use try_lock so the helper stays non-async; in the rare
        // race where the meter tick already grabbed the mutex we
        // skip and let the next snapshot reflect the new SR via the
        // atomic mirror.
        if let Ok(mut state) = self.state.try_lock() {
            state.set_sample_rate(sr);
        }
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
    fn sample_rate(&self) -> u32 {
        self.sample_rate.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn engine_is_dummy(&self) -> Option<bool> {
        // Stub generates audio entirely in-process (test tone +
        // pre-roll synthesizers). There is no host audio path; if
        // the user wants to hear anything, browser monitoring is
        // the only route. The client's master-bus Listen toggle
        // uses this to decide the cold-start default.
        Some(true)
    }

    fn transport_position_samples(&self) -> u64 {
        // Read the latest position the meter tick wrote into
        // `transport.position_beats` — same value the WS layer would
        // ship as a `ControlUpdate`. Try-lock so this stays a hot,
        // sync read; if the meter tick is mid-update we just return 0
        // for one frame (sub-millisecond latency miss, inaudible).
        // Stored as a Float in `position_beats` despite the name —
        // see `state.rs::tick_meters`.
        if let Ok(state) = self.state.try_lock() {
            return state.position_samples_now().unwrap_or_default();
        }
        0
    }

    async fn snapshot(&self) -> Result<Session, BackendError> {
        Ok(self.state.lock().await.session_clone())
    }

    /// Test-only reset — wipes the mutable caches so each Playwright
    /// spec starts from the same seeded fixture. We don't try to be
    /// surgical: the goal is "looks exactly like a freshly-booted
    /// stub", so we reset everything that accumulates across a
    /// process lifetime. The synthesized region fixture, the
    /// waveform cache, and the duplicate-id seed all re-build lazily
    /// on the first read after this returns.
    ///
    /// We deliberately DO NOT touch `state` (the session itself —
    /// tracks, plugins, transport, sections) since recreating those
    /// here would require rebroadcasting the snapshot and breaking
    /// every connected client's references. The fixture's track
    /// list is immutable for the life of the stub anyway; only the
    /// region store and its waveform cache leak across specs in a
    /// way that matters. If we ever start mutating tracks /
    /// plugins via tool calls, extend this.
    async fn reset_test_state(&self) -> Result<(), BackendError> {
        // Replace the region store wholesale; `regions_for` will
        // re-seed via `synthesize_for` on the next list_regions
        // call, matching the original fixture exactly.
        *self.regions.lock().await = regions::RegionStore::new();
        *self.waveforms.lock().await = waveform::WaveformCache::new();
        self.dup_seed.store(1, std::sync::atomic::Ordering::Relaxed);
        // Emit an empty RegionsList for every track so any client
        // still holding a stale `_regionsByTrack[trackId]` cache
        // drops it. The client then re-requests via `list_regions`
        // when the timeline view next paints, which triggers fresh
        // `synthesize_for` calls on the server.
        //
        // We could fire a single global "everything's stale" event,
        // but the existing wire schema already carries per-track
        // `RegionsList` granularity and clients dedupe by id — so
        // reusing it keeps the surface tiny.
        let snap = self.state.lock().await.session_clone();
        for track in &snap.tracks {
            let _ = self.tx.send(Event::RegionsList {
                track_id: track.id.clone(),
                regions: Vec::new(),
                timeline: self.timeline_meta(),
            });
        }
        Ok(())
    }

    /// Synthesize a port graph so agent + UI workflows that depend on
    /// `Backend::list_ports` (record-arm, port-matrix, input-source
    /// dropdowns) have something realistic to chew on in the
    /// devcontainer. Covers the four port categories any backend DAW
    /// would expose:
    ///   * **Physical audio** — `system:capture_1/2`, `system:playback_1/2`
    ///   * **Physical MIDI** — `system:midi/capture_1`, `system:midi/playback_1`
    ///     (think: USB MIDI keyboard + DIN-out)
    ///   * **Virtual / app-to-app audio** — `foyer:ingress-stub`,
    ///     `bus:reverb_return`, `bus:headphone_mix` (representative of
    ///     internal bus endpoints in Ardour, Bitwig, Reaper, etc.)
    ///   * **Virtual MIDI** — `foyer:midi-bridge` (browser MIDI ingress)
    /// `direction` filters source/sink as the real backend does.
    async fn list_ports(&self, direction: Option<String>) -> Result<Vec<EnginePort>, BackendError> {
        let want_source = matches!(direction.as_deref(), Some("source") | None | Some(""));
        let want_sink = matches!(direction.as_deref(), Some("sink") | None | Some(""));
        let mut out = Vec::new();
        let port = |name: &str, dir: &str, is_physical: bool, is_midi: bool| EnginePort {
            name: name.into(),
            direction: dir.into(),
            is_physical,
            is_midi,
        };
        if want_source {
            // Physical audio inputs (mic / line in, mono-each).
            out.push(port("system:capture_1", "source", true, false));
            out.push(port("system:capture_2", "source", true, false));
            // Physical MIDI keyboard input.
            out.push(port("system:midi/capture_1", "source", true, true));
            // Virtual audio sources — browser ingress + bus returns.
            // Same shape any backend would expose: not hardware, but
            // still routable as a track input.
            out.push(port("foyer:ingress-stub", "source", false, false));
            out.push(port("bus:reverb_return", "source", false, false));
            // Virtual MIDI source — the browser MIDI bridge a user
            // sees when they want a remote keyboard to feed a track.
            out.push(port("foyer:midi-bridge", "source", false, true));
        }
        if want_sink {
            // Physical audio outputs (speakers / interface out).
            out.push(port("system:playback_1", "sink", true, false));
            out.push(port("system:playback_2", "sink", true, false));
            // Physical MIDI hardware out (DIN to a synth, USB to a controller).
            out.push(port("system:midi/playback_1", "sink", true, true));
            // Virtual audio sinks — internal bus inputs, headphone mix.
            out.push(port("bus:reverb_send", "sink", false, false));
            out.push(port("bus:headphone_mix", "sink", false, false));
        }
        Ok(out)
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
        // `set_control_with_fanout` returns the primary update plus
        // any sibling updates produced by an active group link, so
        // the UI's optimistic-pin layer sees every echo it expects.
        let updates = st.set_control_with_fanout(&id, value)?;
        for update in updates {
            let _ = self.tx.send(Event::ControlUpdate { update });
        }
        Ok(())
    }

    async fn send_midi_input(
        &self,
        data: Vec<u8>,
        track_id: Option<EntityId>,
        _echo_server_mono_ns: Option<i64>,
    ) -> Result<(), BackendError> {
        // Stub has no engine to feed; record the call so tests can
        // assert that browser-side Web MIDI plumbing reaches the
        // backend. Counter is bumped under the same lock that protects
        // the rest of stub state for a coherent observation in tests.
        let mut st = self.state.lock().await;
        st.midi_input_count = st.midi_input_count.saturating_add(1);
        st.last_midi_input = Some(data);
        st.last_midi_input_track = track_id;
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
                if tx
                    .send(PcmFrame::untimed(stream_id, samples))
                    .await
                    .is_err()
                {
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
    ) -> Result<(PcmTx, AudioIngressAck), BackendError> {
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
        let ack = AudioIngressAck {
            format,
            port_name: None,
        };
        Ok((tx, ack))
    }

    async fn measure_latency(&self, _stream_id: u32) -> Result<LatencyReport, BackendError> {
        // Fixed synthetic number for the stub: ~100ms round-trip at
        // whatever the configured rate is (4800 samples at 48k).
        let sr = self.sample_rate();
        Ok(LatencyReport {
            round_trip_samples: (sr / 10) as u64,
            sample_rate: sr,
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
        let meta = self.timeline_meta();
        let regions = self
            .regions
            .lock()
            .await
            .regions_for(&track_id, self.sample_rate())
            .clone();
        Ok((meta, regions))
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
        // The stub only models MIDI region creation for now — audio
        // would need a source-pool lookup that the launcher backend
        // doesn't carry. Audio creates are silently no-op'd today
        // by the default trait impl, so reject explicitly here so
        // the caller knows. (The Sprunki demo + every other
        // sequencer-style flow only needs MIDI, so this is fine.)
        if kind != "midi" {
            return Err(BackendError::Other(format!(
                "stub create_region: only midi is implemented (got {kind:?})"
            )));
        }
        let sr = self.sample_rate();
        // Fallback length: 4 bars at 120 BPM (sane MIDI clip size).
        let length = length_samples.unwrap_or_else(|| {
            (sr as u64) * 4 * 60 / 120 // 4 beats × 60s / 120 BPM = 2s, × 4 bars = 8s
        });
        // Generate a fresh id. The track-slug + timestamp suffix
        // gives us stability across the test's regions_for call,
        // which is keyed by track_id.
        let slug = track_id.as_str().rsplit('.').next().unwrap_or("x");
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let region_id = EntityId::new(format!("region.{slug}.new.{nanos:08x}"));
        let region = foyer_schema::Region {
            id: region_id.clone(),
            track_id: track_id.clone(),
            name: name.unwrap_or_else(|| format!("{slug} region")),
            start_samples: at_samples as i64,
            length_samples: length,
            color: None,
            muted: false,
            source_path,
            source_offset_samples: None,
            source_segments: vec![],
            notes: vec![],
            patch_changes: vec![],
            foyer_sequencer: None,
            gain_linear: None,
            fade_in_samples: None,
            fade_out_samples: None,
            fade_in_shape: None,
            fade_out_shape: None,
            ingress_latency_ms: None,
            group_id: None,
            layer: None,
        };
        // Lazy-init the synthesized regions for this track, then
        // append ours. `regions_for` synthesizes a default 4-region
        // set on first read; subsequent inserts land alongside.
        // Sprunki provisions on a freshly-created track (no
        // synthesized stubs since we never call regions_for on it),
        // so inserts cleanly.
        let regions = {
            let mut store = self.regions.lock().await;
            store.insert(region);
            store.regions_for(&track_id, sr).clone()
        };
        let _ = self.tx.send(Event::RegionsList {
            track_id,
            regions,
            timeline: self.timeline_meta(),
        });
        Ok(())
    }

    async fn delete_region(&self, id: EntityId) -> Result<EntityId, BackendError> {
        let track_id = {
            let mut store = self.regions.lock().await;
            store.delete(&id)
        }
        .ok_or_else(|| BackendError::Other(format!("unknown region {id}")))?;
        self.waveforms.lock().await.clear_region(&id);
        // Emit a fresh `RegionsList` for the affected track so the
        // client's view reflects the post-delete state. The server
        // also broadcasts `RegionRemoved` via `broadcast_event` (its
        // own state.tx channel), but that event races with the
        // `RegionsList` that `duplicate_region` emits — both go
        // through different async tasks before reaching the WS
        // writer, and on a busy stub the snapshot from duplicate
        // can land AFTER the granular remove, leaving the just-
        // deleted source ressurrected (Rich's CI failure on
        // `cut + paste removes the original`, 2026-04-27). Emitting
        // a settled snapshot from the same backend pump that
        // duplicate uses guarantees ordering — pump_session
        // serializes events from `self.tx` into `reg.tx` in send
        // order, so duplicate's snapshot can never overwrite this
        // post-delete one.
        let regions = {
            let mut store = self.regions.lock().await;
            store.regions_for(&track_id, self.sample_rate()).clone()
        };
        let _ = self.tx.send(Event::RegionsList {
            track_id: track_id.clone(),
            regions,
            timeline: self.timeline_meta(),
        });
        Ok(track_id)
    }

    async fn duplicate_region(
        &self,
        source_region_id: EntityId,
        at_samples: u64,
        length_samples: Option<u64>,
        target_track_id: Option<EntityId>,
    ) -> Result<(), BackendError> {
        let (track_id, regions) = {
            let mut store = self.regions.lock().await;
            let (source_track_id, source) = store
                .find(&source_region_id)
                .ok_or_else(|| BackendError::Other(format!("unknown region {source_region_id}")))?;
            let dest_track_id = match &target_track_id {
                Some(t) => t.clone(),
                None => source_track_id.clone(),
            };
            self.validate_cross_track_paste(&source_track_id, &dest_track_id)
                .await?;
            let id = crate::regions::fresh_region_id(self.next_dup_seed());
            let mut clone = source.clone();
            clone.id = id;
            clone.track_id = dest_track_id.clone();
            clone.start_samples = at_samples as i64;
            clone.length_samples = length_samples.unwrap_or(source.length_samples).max(4_800);
            // A cross-track paste lands in a fresh group context, so
            // drop the source's group_id — preserving it would link
            // the clone to siblings on a different track which is
            // not what users expect.
            if target_track_id.is_some() {
                clone.group_id = None;
            }
            // Keep the same source-media offset so MIDI / audio
            // duplicates point at the same content as the source.
            store.insert(clone);
            let regions = store
                .regions_for(&dest_track_id, self.sample_rate())
                .clone();
            (dest_track_id, regions)
        };
        let _ = self.tx.send(Event::RegionsList {
            track_id,
            regions,
            timeline: self.timeline_meta(),
        });
        Ok(())
    }

    async fn duplicate_region_range(
        &self,
        source_region_id: EntityId,
        source_offset_samples: u64,
        length_samples: u64,
        at_samples: u64,
        target_track_id: Option<EntityId>,
    ) -> Result<(), BackendError> {
        if length_samples == 0 {
            return Err(BackendError::Other(
                "duplicate_region_range: length_samples must be > 0".into(),
            ));
        }
        let (track_id, regions) = {
            let mut store = self.regions.lock().await;
            let (source_track_id, source) = store
                .find(&source_region_id)
                .ok_or_else(|| BackendError::Other(format!("unknown region {source_region_id}")))?;
            let dest_track_id = match &target_track_id {
                Some(t) => t.clone(),
                None => source_track_id.clone(),
            };
            self.validate_cross_track_paste(&source_track_id, &dest_track_id)
                .await?;
            // Clamp the slice to the source's actual length so a
            // range that runs past the end gets truncated, not
            // negative-clamped to a zero-length region.
            let max_offset = source.length_samples.saturating_sub(1);
            let offset = source_offset_samples.min(max_offset);
            let max_len = source.length_samples.saturating_sub(offset);
            let len = length_samples.min(max_len).max(4_800);
            let id = crate::regions::fresh_region_id(self.next_dup_seed());
            let mut clone = source.clone();
            clone.id = id;
            clone.track_id = dest_track_id.clone();
            clone.start_samples = at_samples as i64;
            clone.length_samples = len;
            if target_track_id.is_some() {
                clone.group_id = None;
            }
            // For sliced duplicates we shift the source-media offset
            // forward by `offset` so the new region's content aligns
            // with what the user grabbed.
            clone.source_offset_samples = Some(
                source
                    .source_offset_samples
                    .unwrap_or(0)
                    .saturating_add(offset),
            );
            // MIDI note slicing in the stub is intentionally unsliced —
            // notes use tick coordinates and slicing them by sample
            // requires tempo + ppqn translation which the stub doesn't
            // model precisely. The Ardour shim slices notes correctly
            // because it has the live tempo map; the stub keeps the
            // full source-region note list so the timeline still
            // renders something sensible. Acceptable for tests since
            // the audio cut/copy/paste path is what users care about.
            store.insert(clone);
            let regions = store
                .regions_for(&dest_track_id, self.sample_rate())
                .clone();
            (dest_track_id, regions)
        };
        let _ = self.tx.send(Event::RegionsList {
            track_id,
            regions,
            timeline: self.timeline_meta(),
        });
        Ok(())
    }

    async fn stretch_region(
        &self,
        id: EntityId,
        new_start_samples: i64,
        new_length_samples: u64,
        anchor: String,
        _preserve_pitch: bool,
    ) -> Result<(), BackendError> {
        const MIN_LEN: u64 = 4_800;
        let (track_id, _region) = {
            let mut store = self.regions.lock().await;
            store
                .stretch_content(&id, new_start_samples, new_length_samples, &anchor, MIN_LEN)
                .map_err(BackendError::Other)?
        };
        self.waveforms.lock().await.clear_region(&id);
        let regions = {
            let mut store = self.regions.lock().await;
            store.regions_for(&track_id, self.sample_rate()).clone()
        };
        let _ = self.tx.send(Event::RegionsList {
            track_id,
            regions,
            timeline: self.timeline_meta(),
        });
        Ok(())
    }

    async fn split_region(&self, id: EntityId, at_samples: i64) -> Result<(), BackendError> {
        const MIN_LEN: u64 = 4_800;
        let left = crate::regions::fresh_region_id(self.next_dup_seed());
        let right = crate::regions::fresh_region_id(self.next_dup_seed());
        let track_id = {
            let mut store = self.regions.lock().await;
            store
                .split_at(&id, at_samples, MIN_LEN, left, right)
                .map_err(BackendError::Other)?
        };
        self.waveforms.lock().await.clear_region(&id);
        let regions = {
            let mut store = self.regions.lock().await;
            store.regions_for(&track_id, self.sample_rate()).clone()
        };
        let _ = self.tx.send(Event::RegionsList {
            track_id,
            regions,
            timeline: self.timeline_meta(),
        });
        Ok(())
    }

    async fn reverse_region(&self, _id: EntityId) -> Result<(), BackendError> {
        Ok(())
    }

    async fn normalize_region(&self, id: EntityId, target_dbfs: f64) -> Result<f64, BackendError> {
        // Stub has no real audio buffer to scan; assume the source
        // peak is at -3 dBFS so the agent gets a sane gain back
        // (real backends will actually scan). gain = 10^((target-peak)/20).
        let assumed_peak_dbfs = -3.0;
        let gain = 10f64.powf((target_dbfs - assumed_peak_dbfs) / 20.0);
        let patch = foyer_schema::timeline::RegionPatch {
            gain_linear: Some(gain),
            ..Default::default()
        };
        self.update_region(id, patch).await?;
        Ok(gain)
    }

    async fn combine_regions(&self, _region_ids: Vec<EntityId>) -> Result<(), BackendError> {
        Ok(())
    }

    async fn strip_silence_region(
        &self,
        _id: EntityId,
        _threshold_db: f32,
        _minimum_length_samples: u64,
        _fade_length_samples: u64,
    ) -> Result<(), BackendError> {
        Ok(())
    }

    async fn pitch_shift_region(&self, _id: EntityId, _semitones: f32) -> Result<(), BackendError> {
        Ok(())
    }

    async fn create_track(
        &self,
        name: String,
        kind: foyer_schema::TrackKind,
        color: Option<String>,
        after_id: Option<EntityId>,
    ) -> Result<Track, BackendError> {
        let track = self
            .state
            .lock()
            .await
            .create_track(name, kind, color, after_id.as_ref())?;
        // Stub doesn't currently emit per-track Created events; force a
        // snapshot reload so every client repaints with the new track.
        let _ = self.tx.send(Event::SessionPatch {
            patch: foyer_schema::Patch::Reload,
        });
        Ok(track)
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

    async fn create_group(
        &self,
        name: String,
        color: Option<String>,
        members: Vec<EntityId>,
    ) -> Result<(), BackendError> {
        let group = self.state.lock().await.create_group(name, color, members);
        // Per-event `GroupUpdated` doesn't currently have a store-side
        // reducer, so we emit a `Patch::Reload` to force the UI to
        // re-fetch the snapshot — that's also what the Ardour shim
        // does after `RouteGroup` mutations (`encode_patch_reload`),
        // so backends behave the same way on the wire.
        let _ = self.tx.send(Event::SessionPatch {
            patch: foyer_schema::Patch::Reload,
        });
        let _ = self.tx.send(Event::GroupUpdated { group });
        Ok(())
    }

    async fn update_group(
        &self,
        id: EntityId,
        patch: foyer_schema::GroupPatch,
    ) -> Result<(), BackendError> {
        self.state.lock().await.update_group(&id, &patch)?;
        let _ = self.tx.send(Event::SessionPatch {
            patch: foyer_schema::Patch::Reload,
        });
        Ok(())
    }

    async fn delete_group(&self, id: EntityId) -> Result<(), BackendError> {
        self.state.lock().await.delete_group(&id)?;
        let _ = self.tx.send(Event::SessionPatch {
            patch: foyer_schema::Patch::Reload,
        });
        Ok(())
    }

    async fn set_track_midi_channel_mode(
        &self,
        track_id: EntityId,
        direction: String,
        mode: String,
        mask: u16,
    ) -> Result<Track, BackendError> {
        let updated = self
            .state
            .lock()
            .await
            .set_track_midi_channel_mode(&track_id, &direction, &mode, mask)
            .ok_or_else(|| BackendError::Other(format!("unknown track {track_id}")))?;
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
        {
            let mut st = self.state.lock().await;
            st.set_automation_mode(&lane_id, mode)?;
        }
        self.broadcast_track_for_lane(&lane_id).await;
        Ok(())
    }
    async fn add_automation_point(
        &self,
        lane_id: EntityId,
        point: foyer_schema::AutomationPoint,
    ) -> Result<(), BackendError> {
        {
            let mut st = self.state.lock().await;
            st.add_automation_point(&lane_id, point)?;
        }
        self.broadcast_track_for_lane(&lane_id).await;
        Ok(())
    }
    async fn update_automation_point(
        &self,
        lane_id: EntityId,
        original_time_samples: u64,
        new_time_samples: u64,
        value: f64,
    ) -> Result<(), BackendError> {
        {
            let mut st = self.state.lock().await;
            st.update_automation_point(&lane_id, original_time_samples, new_time_samples, value)?;
        }
        self.broadcast_track_for_lane(&lane_id).await;
        Ok(())
    }
    async fn delete_automation_point(
        &self,
        lane_id: EntityId,
        time_samples: u64,
    ) -> Result<(), BackendError> {
        {
            let mut st = self.state.lock().await;
            st.delete_automation_point(&lane_id, time_samples)?;
        }
        self.broadcast_track_for_lane(&lane_id).await;
        Ok(())
    }
    async fn replace_automation_lane(
        &self,
        lane_id: EntityId,
        points: Vec<foyer_schema::AutomationPoint>,
    ) -> Result<(), BackendError> {
        {
            let mut st = self.state.lock().await;
            st.replace_automation_lane(&lane_id, points)?;
        }
        self.broadcast_track_for_lane(&lane_id).await;
        Ok(())
    }

    async fn update_region(
        &self,
        id: EntityId,
        patch: RegionPatch,
    ) -> Result<Region, BackendError> {
        // Cross-track move: when the patch carries a different
        // `track_id`, validate kind compatibility, relocate the
        // region between the store's per-track buckets, AND emit a
        // `RegionRemoved` for the source track so every client clears
        // it from the old lane (the `RegionUpdated` below adds it to
        // the new lane). Pure same-track patches skip all of this.
        let mut prior_track_id: Option<EntityId> = None;
        if let Some(new_track_id) = patch.track_id.clone() {
            let current_track_id = {
                let store = self.regions.lock().await;
                store.find(&id).map(|(tid, _)| tid)
            };
            if let Some(cur) = current_track_id {
                if cur != new_track_id {
                    self.validate_cross_track_paste(&cur, &new_track_id).await?;
                    let mut store = self.regions.lock().await;
                    store.move_to_track(&id, &new_track_id)?;
                    prior_track_id = Some(cur);
                }
            }
        }
        let updated = self
            .regions
            .lock()
            .await
            .update(&id, &patch)
            .ok_or_else(|| BackendError::Other(format!("unknown region {id}")))?;
        // Moving or resizing invalidates the cached peaks for that region.
        self.waveforms.lock().await.clear_region(&id);
        if let Some(old_track) = prior_track_id {
            let _ = self.tx.send(Event::RegionRemoved {
                track_id: old_track,
                region_id: id.clone(),
            });
        }
        // Broadcast so every other subscriber repaints.
        let _ = self.tx.send(Event::RegionUpdated {
            region: Box::new(updated.clone()),
        });
        Ok(updated)
    }

    async fn load_waveform(
        &self,
        region_id: EntityId,
        samples_per_peak: u32,
    ) -> Result<WaveformPeaks, BackendError> {
        // Look up the region across all tracks.
        let sr = self.sample_rate();
        let maybe_region = {
            let mut store = self.regions.lock().await;
            // We need to scan all known tracks; eagerly materialize known
            // tracks from the session so refs survive.
            let session = self.state.lock().await.session_clone();
            for t in &session.tracks {
                store.regions_for(&t.id, sr);
            }
            // Find the region anywhere.
            let mut found: Option<Region> = None;
            for t in &session.tracks {
                for r in store.regions_for(&t.id, sr) {
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

    async fn list_audio_pool(
        &self,
        session_id: &EntityId,
    ) -> Result<Vec<AudioPoolSource>, BackendError> {
        let Some(jail) = self.jail.as_ref() else {
            return Ok(Vec::new());
        };
        let root = jail
            .root()
            .canonicalize()
            .map_err(|e| BackendError::Other(format!("jail root: {e}")))?;
        let pool = stub_media_pool::pool_dir_abs(&root, session_id);
        stub_media_pool::list_stub_pool_entries(&pool, &root, self.sample_rate())
            .map_err(BackendError::Other)
    }

    async fn media_import_staging_dir_abs(
        &self,
        session_id: &EntityId,
        _project_file_abs: &str,
    ) -> Result<Option<PathBuf>, BackendError> {
        let Some(jail) = self.jail.as_ref() else {
            return Ok(None);
        };
        let root = jail
            .root()
            .canonicalize()
            .map_err(|e| BackendError::Other(format!("jail root: {e}")))?;
        Ok(Some(stub_media_pool::pool_dir_abs(&root, session_id)))
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

    fn render_capabilities(&self) -> Option<RenderCapabilities> {
        Some(RenderCapabilities {
            formats: vec![
                RenderFormat {
                    id: "wav".into(),
                    label: "WAV (PCM)".into(),
                    extension: "wav".into(),
                    mime: "audio/wav".into(),
                    lossy: false,
                },
                // Stub only encodes WAV — listing additional formats
                // here would mislead the FE picker. Real backends
                // advertise FLAC / OGG / MP3 as their encoders allow;
                // the Ardour shim will populate this from
                // `ExportFormat`'s registered codecs.
            ],
            sample_rates: vec![44_100, 48_000, 88_200, 96_000],
            bit_depths: vec![
                RenderBitDepth::Int16,
                RenderBitDepth::Int24,
                RenderBitDepth::Float32,
            ],
            max_channels: 2,
            supports_range: true,
            supports_stems: false,
        })
    }

    async fn render_session(
        &self,
        opts: RenderOptions,
        progress: Option<ProgressFn>,
    ) -> Result<Vec<RenderOutput>, BackendError> {
        // The stub backend has no real audio engine; it manufactures
        // a stereo sine sweep at the requested sample rate so the
        // wire / UI / agent path can be exercised end-to-end before
        // the Ardour shim's `ExportHandler` integration lands. The
        // sweep is intentionally short so a Playwright round-trip
        // stays under a second.
        if opts.format_id != "wav" {
            return Err(BackendError::Other(format!(
                "stub backend only supports format_id=\"wav\" (asked for {})",
                opts.format_id
            )));
        }
        if matches!(opts.target, RenderTarget::Tracks { .. }) {
            return Err(BackendError::Other(
                "stub backend does not support stem renders (set target.kind = master)".into(),
            ));
        }
        let sample_rate = opts.sample_rate.unwrap_or(48_000);
        if !(8_000..=192_000).contains(&sample_rate) {
            return Err(BackendError::Other(format!(
                "stub render: sample_rate {sample_rate} out of range"
            )));
        }
        let channels: u16 = match opts.channels.unwrap_or(2) {
            0 => return Err(BackendError::Other("stub render: channels=0".into())),
            n if n > 2 => 2, // stub clamps anything above stereo
            n => n as u16,
        };
        let bit_depth = opts.bit_depth.unwrap_or(RenderBitDepth::Int16);
        let (duration_samples, _start_sample) = match &opts.range {
            RenderRange::Session => (sample_rate as u64 * 4, 0u64), // 4 seconds
            RenderRange::Range {
                start_samples,
                end_samples,
            } => {
                if end_samples <= start_samples {
                    return Err(BackendError::Other(
                        "stub render: range end must exceed start".into(),
                    ));
                }
                (end_samples - start_samples, *start_samples)
            }
            RenderRange::Loop => (sample_rate as u64 * 4, 0u64),
        };
        // Synthesize: two-tone stereo (440 Hz L, 660 Hz R) at -12 dB
        // peak, gentle 50ms fade-in/out so the file doesn't click.
        let total_samples = duration_samples as usize;
        let fade_samples = ((sample_rate as f64) * 0.050) as usize;
        let mut left = Vec::with_capacity(total_samples);
        let mut right = Vec::with_capacity(total_samples);
        for n in 0..total_samples {
            let t = n as f64 / sample_rate as f64;
            let envelope = if n < fade_samples {
                n as f64 / fade_samples.max(1) as f64
            } else if total_samples - n < fade_samples {
                (total_samples - n) as f64 / fade_samples.max(1) as f64
            } else {
                1.0
            };
            let amp = 0.25 * envelope; // ~-12 dBFS
            left.push((amp * (2.0 * std::f64::consts::PI * 440.0 * t).sin()) as f32);
            right.push((amp * (2.0 * std::f64::consts::PI * 660.0 * t).sin()) as f32);
            // Tick progress at every 10% boundary.
            if let Some(cb) = progress.as_ref() {
                if total_samples >= 10 && n % (total_samples / 10) == 0 {
                    let pct = ((n as f64 / total_samples as f64) * 100.0) as u8;
                    cb(pct);
                }
            }
        }
        if let Some(cb) = progress.as_ref() {
            cb(100);
        }
        let bytes = encode_wav(&left, &right, sample_rate, channels, bit_depth)?;
        let size_bytes = bytes.len() as u64;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let path = opts
            .target_path
            .clone()
            .unwrap_or_else(|| format!("exports/stub-render-{stamp}.wav"));
        let bytes_b64 = if opts.inline_bytes {
            use base64::Engine;
            Some(base64::engine::general_purpose::STANDARD.encode(&bytes))
        } else {
            None
        };
        Ok(vec![RenderOutput {
            path,
            size_bytes,
            format_id: "wav".into(),
            mime: "audio/wav".into(),
            track_id: None,
            bytes_b64,
        }])
    }

    async fn snapshot_session(&self, name: Option<String>) -> Result<String, BackendError> {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let basename = name.unwrap_or_else(|| format!("snapshot-{stamp}"));
        Ok(format!("snapshots/{basename}.ardour"))
    }

    async fn store_mixer_scene(
        &self,
        name: String,
        color: Option<String>,
    ) -> Result<foyer_schema::MixerScene, BackendError> {
        let (scene, session) = {
            let mut st = self.state.lock().await;
            let scene = st.store_mixer_scene(name, color);
            (scene, st.session_clone())
        };
        let _ = self.tx.send(Event::SessionSnapshot {
            session: Box::new(session),
        });
        Ok(scene)
    }

    async fn recall_mixer_scene(
        &self,
        id: EntityId,
    ) -> Result<foyer_schema::MixerScene, BackendError> {
        let (scene, updates, session) = {
            let mut st = self.state.lock().await;
            let (scene, updates) = st.recall_mixer_scene(&id)?;
            let session = st.session_clone();
            (scene, updates, session)
        };
        for u in updates {
            let _ = self.tx.send(Event::ControlUpdate { update: u });
        }
        let _ = self.tx.send(Event::SessionSnapshot {
            session: Box::new(session),
        });
        Ok(scene)
    }

    async fn delete_mixer_scene(&self, id: EntityId) -> Result<(), BackendError> {
        let session = {
            let mut st = self.state.lock().await;
            st.delete_mixer_scene(&id)?;
            st.session_clone()
        };
        let _ = self.tx.send(Event::SessionSnapshot {
            session: Box::new(session),
        });
        Ok(())
    }

    async fn rename_mixer_scene(
        &self,
        id: EntityId,
        name: String,
    ) -> Result<foyer_schema::MixerScene, BackendError> {
        let (scene, session) = {
            let mut st = self.state.lock().await;
            let scene = st.rename_mixer_scene(&id, name)?;
            (scene, st.session_clone())
        };
        let _ = self.tx.send(Event::SessionSnapshot {
            session: Box::new(session),
        });
        Ok(scene)
    }

    async fn create_section(
        &self,
        name: String,
        start_samples: i64,
        end_samples: Option<i64>,
        color: Option<String>,
        flags: foyer_schema::SectionFlags,
    ) -> Result<foyer_schema::Section, BackendError> {
        let (section, session) = {
            let mut st = self.state.lock().await;
            let section = st.create_section(name, start_samples, end_samples, color, flags);
            (section, st.session_clone())
        };
        let _ = self.tx.send(Event::SessionSnapshot {
            session: Box::new(session),
        });
        Ok(section)
    }

    async fn update_section(
        &self,
        id: EntityId,
        patch: foyer_schema::SectionPatch,
    ) -> Result<foyer_schema::Section, BackendError> {
        let (section, session) = {
            let mut st = self.state.lock().await;
            let section = st.update_section(&id, patch)?;
            (section, st.session_clone())
        };
        let _ = self.tx.send(Event::SessionSnapshot {
            session: Box::new(session),
        });
        Ok(section)
    }

    async fn delete_section(&self, id: EntityId) -> Result<(), BackendError> {
        let session = {
            let mut st = self.state.lock().await;
            st.delete_section(&id)?;
            st.session_clone()
        };
        let _ = self.tx.send(Event::SessionSnapshot {
            session: Box::new(session),
        });
        Ok(())
    }

    // ── Spectrum ───────────────────────────────────────────────────
    async fn spectrum_capabilities(
        &self,
    ) -> Result<Option<foyer_schema::SpectrumCapabilities>, BackendError> {
        Ok(Some(foyer_schema::SpectrumCapabilities::stub()))
    }

    async fn subscribe_spectrum(
        &self,
        target: foyer_schema::SpectrumTarget,
        opts: foyer_schema::SpectrumOpts,
    ) -> Result<foyer_schema::SpectrumOpts, BackendError> {
        let applied = self
            .spectrum
            .subscribe(
                target,
                opts,
                self.tx.clone(),
                self.state.clone(),
                self.sample_rate(),
            )
            .await;
        Ok(applied)
    }

    async fn unsubscribe_spectrum(
        &self,
        target: foyer_schema::SpectrumTarget,
    ) -> Result<(), BackendError> {
        self.spectrum.unsubscribe(target, self.tx.clone()).await;
        Ok(())
    }

    async fn snapshot_spectrum(
        &self,
        target: foyer_schema::SpectrumTarget,
        opts: foyer_schema::SpectrumOpts,
    ) -> Result<foyer_schema::SpectrumFrame, BackendError> {
        Ok(self
            .spectrum
            .snapshot(target, opts, &self.state, self.sample_rate())
            .await)
    }

    // ── Scripting ──────────────────────────────────────────────────
    async fn scripting_capabilities(
        &self,
    ) -> Result<Option<foyer_schema::ScriptingCapabilities>, BackendError> {
        Ok(Some(fixtures::stub_scripting_capabilities()))
    }

    async fn list_scripts(&self) -> Result<Vec<foyer_schema::Script>, BackendError> {
        Ok(self.state.lock().await.list_scripts())
    }

    async fn save_script(
        &self,
        script: foyer_schema::Script,
    ) -> Result<foyer_schema::Script, BackendError> {
        let saved = self.state.lock().await.save_script(script)?;
        let _ = self.tx.send(Event::ScriptSaved {
            script: saved.clone(),
        });
        Ok(saved)
    }

    async fn delete_script(&self, id: foyer_schema::EntityId) -> Result<(), BackendError> {
        let removed = self.state.lock().await.delete_script(&id);
        if removed {
            let _ = self.tx.send(Event::ScriptRemoved { id });
        }
        Ok(())
    }

    async fn enable_script(
        &self,
        id: foyer_schema::EntityId,
        enabled: bool,
    ) -> Result<foyer_schema::Script, BackendError> {
        let saved = self.state.lock().await.enable_script(&id, enabled)?;
        let _ = self.tx.send(Event::ScriptSaved {
            script: saved.clone(),
        });
        Ok(saved)
    }

    async fn run_script(
        &self,
        id: foyer_schema::EntityId,
        args_override: Option<std::collections::BTreeMap<String, String>>,
    ) -> Result<foyer_schema::ScriptRunResult, BackendError> {
        let result = self.state.lock().await.run_script_stub(&id, args_override);
        let _ = self.tx.send(Event::ScriptRunResult {
            result: result.clone(),
        });
        Ok(result)
    }
}

/// Minimal WAV (RIFF) encoder for the stub render path. Supports
/// PCM-16, PCM-24, and IEEE-float-32. No FLAC / OGG / MP3 — those
/// land when a real backend (Ardour shim) wires its own encoders
/// through `Backend::render_session`. Kept self-contained (no `hound`
/// dep) so the stub's surface stays small.
fn encode_wav(
    left: &[f32],
    right: &[f32],
    sample_rate: u32,
    channels: u16,
    bit_depth: RenderBitDepth,
) -> Result<Vec<u8>, BackendError> {
    let frame_count = left.len();
    if channels == 2 && right.len() != frame_count {
        return Err(BackendError::Other(
            "encode_wav: stereo with mismatched L/R buffer lengths".into(),
        ));
    }
    let bits_per_sample: u16 = match bit_depth {
        RenderBitDepth::Int16 => 16,
        RenderBitDepth::Int24 => 24,
        RenderBitDepth::Int32 => 32,
        RenderBitDepth::Float32 => 32,
    };
    // PCM = 1, IEEE float = 3.
    let format_tag: u16 = if matches!(bit_depth, RenderBitDepth::Float32) {
        3
    } else {
        1
    };
    let bytes_per_sample = (bits_per_sample / 8) as usize;
    let block_align = channels * (bits_per_sample / 8);
    let byte_rate = sample_rate * (block_align as u32);
    let data_bytes = frame_count * (channels as usize) * bytes_per_sample;
    let total_size: usize = 36 + data_bytes;
    let mut buf: Vec<u8> = Vec::with_capacity(8 + total_size);
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&(total_size as u32).to_le_bytes());
    buf.extend_from_slice(b"WAVE");
    // fmt chunk
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&16u32.to_le_bytes());
    buf.extend_from_slice(&format_tag.to_le_bytes());
    buf.extend_from_slice(&channels.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.extend_from_slice(&byte_rate.to_le_bytes());
    buf.extend_from_slice(&block_align.to_le_bytes());
    buf.extend_from_slice(&bits_per_sample.to_le_bytes());
    // data chunk
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&(data_bytes as u32).to_le_bytes());
    for i in 0..frame_count {
        let l = left[i].clamp(-1.0, 1.0);
        let r = if channels == 2 {
            right[i].clamp(-1.0, 1.0)
        } else {
            l
        };
        let chans: &[f32] = if channels == 2 { &[l, r] } else { &[l] };
        for &s in chans {
            match bit_depth {
                RenderBitDepth::Int16 => {
                    let q = (s * i16::MAX as f32) as i16;
                    buf.extend_from_slice(&q.to_le_bytes());
                }
                RenderBitDepth::Int24 => {
                    // 24-bit little-endian signed, scale to ±(2^23 - 1).
                    let q = (s * 8_388_607.0) as i32;
                    let bytes = q.to_le_bytes();
                    buf.extend_from_slice(&bytes[..3]);
                }
                RenderBitDepth::Int32 => {
                    let q = (s * i32::MAX as f32) as i32;
                    buf.extend_from_slice(&q.to_le_bytes());
                }
                RenderBitDepth::Float32 => {
                    buf.extend_from_slice(&s.to_le_bytes());
                }
            }
        }
    }
    Ok(buf)
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
        let (tx, _) = b
            .open_ingress(
                2,
                AudioSource::VirtualInput {
                    name: "remote-1".into(),
                },
                fmt,
            )
            .await
            .unwrap();
        tx.send(PcmFrame::untimed(2, vec![0.1; 64])).await.unwrap();
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
