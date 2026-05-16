//! The core [`HostClient`] — a connected, running IPC conversation with a shim.
//!
//! A `HostClient` is cheap to clone into the server because its real state lives
//! behind `Arc`s: one reader task, one writer task, a shared broadcast of events,
//! and a small registry of open audio streams.

// The pending-request maps intentionally spell out their full generic
// signatures (`Mutex<HashMap<EntityId, Vec<oneshot::Sender<(...)>>>>`).
// Factoring each into a `type` alias would scatter three-line definitions
// that are only used at one call site each and make the Shared struct
// harder to scan, not easier.
#![allow(clippy::type_complexity)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use foyer_backend::{AudioIngressAck, PcmFrame, PcmRx, PcmTx};
use foyer_ipc::{
    codec::{decode_control, encode_control, pack_audio, read_frame, unpack_audio, write_frame},
    frame::{Frame, FrameKind},
    Control,
};
use foyer_schema::{
    AudioFormat, AudioPoolSource, AudioSource, Command, EnginePort, EntityId, Envelope, Event,
    LatencyReport, MidiNote, MidiNotePatch, MidiPatchNames, PatchChange, PatchChangePatch,
    PluginCatalogEntry, PluginPreset, Region, RegionPatch, SequencerLayout, Session, TimelineMeta,
    Track, TrackPatch,
};
use futures::Stream;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::UnixStream;
use tokio::sync::{broadcast, mpsc, oneshot, Mutex, Notify};

const EVENT_BROADCAST_CAP: usize = 2048;
const COMMAND_QUEUE_CAP: usize = 256;
const INGRESS_QUEUE_CAP: usize = 64;
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("encode: {0}")]
    Encode(#[from] rmp_serde::encode::Error),
    #[error("decode: {0}")]
    Decode(#[from] rmp_serde::decode::Error),
    #[error("frame: {0}")]
    Frame(#[from] foyer_ipc::frame::FrameError),
    #[error("writer queue closed")]
    WriterClosed,
    #[error("timed out waiting for {0}")]
    Timeout(&'static str),
    #[error("shim reported: {0}: {1}")]
    ShimError(String, String),
    #[error("stream {0} has no open ingress sink")]
    NoIngressSink(u32),
}

#[derive(Debug, Clone)]
pub struct HostClientConfig {
    pub socket_path: PathBuf,
}

/// What the reader task forwards into per-stream registrants.
enum AudioRoute {
    /// Forward incoming audio frames for this stream to a consumer (egress).
    Egress(mpsc::Sender<PcmFrame>),
}

/// What the writer task accepts via its queue.
///
/// The `Control` variant wraps an `Envelope<Control>` that's much larger
/// than the `Audio` variant's `(u32, Vec<u8>)`. Boxing the big variant
/// is what clippy recommends (`large_enum_variant`); it keeps the
/// channel's queued-item size small on the audio hot path.
enum WriteItem {
    Control(Box<Envelope<Control>>),
    Audio(u32, Vec<u8>),
}

/// State shared with the reader/writer tasks.
struct Shared {
    next_seq: AtomicU64,
    out_tx: mpsc::Sender<WriteItem>,
    events: broadcast::Sender<Event>,
    /// Latest engine sample rate the shim has reported, mirrored
    /// off `Session::sample_rate` whenever a `SessionSnapshot` lands.
    /// Read by `HostBackend::sample_rate()` so callers don't have to
    /// `.await` a snapshot for what's a hot read (timeline pixel math
    /// and peak-cache decisions). Defaults to the schema constant
    /// until the first snapshot arrives.
    sample_rate: std::sync::atomic::AtomicU32,
    /// Latest `transport.position` value the shim has reported — in
    /// samples, mirrored off the control plane's tick stream. Read
    /// from `HostBackend::transport_position_samples()` so the audio
    /// egress encoder can stamp each outbound frame with timecode the
    /// browser uses to align playhead-to-stream. Stored as `u64`;
    /// updates lag the engine by one tick (~30 ms typical) which is
    /// fine for the polled fallback path. Once the shim attaches
    /// per-frame `transport_pos_samples` directly to `PcmFrame`, the
    /// encoder prefers that and ignores this cache.
    position_samples: std::sync::atomic::AtomicU64,
    /// For audio.* commands, which arrive asynchronously: a registry of in-flight
    /// requests keyed by stream_id, resolved when the matching event comes back.
    pending_egress: Mutex<HashMap<u32, oneshot::Sender<Result<(), ClientError>>>>,
    pending_ingress: Mutex<HashMap<u32, oneshot::Sender<Result<AudioIngressAck, ClientError>>>>,
    pending_latency: Mutex<HashMap<u32, oneshot::Sender<LatencyReport>>>,
    pending_snapshot: Mutex<Vec<oneshot::Sender<Session>>>,
    /// In-flight `list_regions` requests keyed by `track_id`. The shim
    /// answers with a `RegionsList` event whose `track_id` matches the
    /// request — that's how we route replies back to the right awaiter.
    pending_regions: Mutex<HashMap<EntityId, Vec<oneshot::Sender<(TimelineMeta, Vec<Region>)>>>>,
    pending_update_region: Mutex<HashMap<EntityId, Vec<oneshot::Sender<Region>>>>,
    pending_delete_region: Mutex<HashMap<EntityId, Vec<oneshot::Sender<EntityId>>>>,
    pending_update_track: Mutex<HashMap<EntityId, Vec<oneshot::Sender<Track>>>>,
    /// In-flight list_plugin_presets requests, keyed by plugin id.
    /// Resolved by the reader task on `Event::PluginPresetsListed`.
    pending_presets: Mutex<HashMap<EntityId, Vec<oneshot::Sender<Vec<PluginPreset>>>>>,
    /// In-flight list_midi_patch_names requests, keyed by
    /// "<track_id>:<channel>" so concurrent requests for different
    /// channels don't trample each other.
    pending_midi_patch_names: Mutex<HashMap<String, Vec<oneshot::Sender<MidiPatchNames>>>>,
    /// In-flight list_plugins requests. The shim's PluginsList event
    /// has no correlation id — every pending awaiter resolves to
    /// the same catalog. Concurrent requests just share the same
    /// answer, which is fine for a catalog query.
    pending_plugins_list: Mutex<Vec<oneshot::Sender<Vec<PluginCatalogEntry>>>>,
    /// In-flight `list_ports` requests. Same shared-answer pattern as
    /// `pending_plugins_list`: the shim's PortsListed event has no
    /// correlation id, so every concurrent awaiter resolves to the
    /// same snapshot.
    pending_ports_list: Mutex<Vec<oneshot::Sender<Vec<EnginePort>>>>,
    /// In-flight `list_audio_pool` requests — shared answer like plugins/ports.
    pending_audio_pool_list: Mutex<Vec<oneshot::Sender<Vec<AudioPoolSource>>>>,
    /// In-flight `list_scripts` requests. `Event::ScriptList` resolves
    /// every waiter with the same snapshot (no correlation id, same
    /// pattern as plugins/ports).
    pending_scripts_list: Mutex<Vec<oneshot::Sender<Vec<foyer_schema::Script>>>>,
    /// In-flight `save_script` requests. Resolved by the next
    /// `Event::ScriptSaved` from the shim — the typical save flow
    /// is serial (user clicks Save, waits for echo), and concurrent
    /// saves are extremely rare. Two-script races resolve in send
    /// order which is fine for the existing UI model.
    pending_save_script: Mutex<Vec<oneshot::Sender<foyer_schema::Script>>>,
    /// In-flight `enable_script` requests. Same pattern as save.
    pending_enable_script: Mutex<Vec<oneshot::Sender<foyer_schema::Script>>>,
    /// In-flight `run_script` requests keyed by script id so concurrent
    /// runs of different scripts don't collide.
    pending_run_script:
        Mutex<HashMap<EntityId, Vec<oneshot::Sender<foyer_schema::ScriptRunResult>>>>,
    /// Cached scripting capabilities — populated from every
    /// `SessionSnapshot` and from `ScriptingCapabilitiesChanged` events
    /// so the sync `scripting_capabilities()` call can answer without
    /// a round-trip. `None` until the first snapshot lands.
    cached_scripting_caps: Mutex<Option<foyer_schema::ScriptingCapabilities>>,
    /// Cache of known regions, keyed by region id. Populated from every
    /// `RegionsList` / `RegionUpdated` event; drained on `RegionRemoved`.
    /// Used to look up `source_path` when the sidecar needs to decode
    /// peaks for a region the client asked about.
    regions_cache: Mutex<HashMap<EntityId, Region>>,
    /// Where to route incoming audio frames, keyed by stream_id.
    audio_routes: Mutex<HashMap<u32, AudioRoute>>,
    /// Flipped true when the reader/writer task exits (shim crash,
    /// socket close, process gone). `subscribe()` streams watch this
    /// via `disconnected_notify` and terminate when it flips, so the
    /// sidecar's event pump can emit `BackendLost` instead of hanging
    /// on a broadcast that never closes (the broadcast Sender lives
    /// in this Shared — its existence keeps the channel open even
    /// after the reader task has dropped its clone).
    disconnected: AtomicBool,
    disconnected_notify: Notify,
}

pub struct HostClient {
    shared: Arc<Shared>,
}

impl HostClient {
    pub async fn connect(cfg: HostClientConfig) -> Result<Self, ClientError> {
        let sock = UnixStream::connect(&cfg.socket_path).await?;
        let (r, w) = tokio::io::split(sock);
        Ok(Self::from_halves(r, w))
    }

    /// Build a client over arbitrary async halves — used by integration tests that
    /// stand up an in-process fake shim over a duplex pair.
    pub fn from_halves<R, W>(r: R, w: W) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let (out_tx, out_rx) = mpsc::channel::<WriteItem>(COMMAND_QUEUE_CAP);
        let (events_tx, _) = broadcast::channel::<Event>(EVENT_BROADCAST_CAP);
        let shared = Arc::new(Shared {
            next_seq: AtomicU64::new(1),
            out_tx,
            events: events_tx,
            sample_rate: std::sync::atomic::AtomicU32::new(foyer_schema::DEFAULT_SAMPLE_RATE),
            position_samples: std::sync::atomic::AtomicU64::new(0),
            pending_egress: Mutex::new(HashMap::new()),
            pending_ingress: Mutex::new(HashMap::new()),
            pending_latency: Mutex::new(HashMap::new()),
            pending_snapshot: Mutex::new(Vec::new()),
            pending_regions: Mutex::new(HashMap::new()),
            pending_update_region: Mutex::new(HashMap::new()),
            pending_delete_region: Mutex::new(HashMap::new()),
            pending_update_track: Mutex::new(HashMap::new()),
            pending_presets: Mutex::new(HashMap::new()),
            pending_midi_patch_names: Mutex::new(HashMap::new()),
            pending_plugins_list: Mutex::new(Vec::new()),
            pending_ports_list: Mutex::new(Vec::new()),
            pending_audio_pool_list: Mutex::new(Vec::new()),
            pending_scripts_list: Mutex::new(Vec::new()),
            pending_save_script: Mutex::new(Vec::new()),
            pending_enable_script: Mutex::new(Vec::new()),
            pending_run_script: Mutex::new(HashMap::new()),
            cached_scripting_caps: Mutex::new(None),
            regions_cache: Mutex::new(HashMap::new()),
            audio_routes: Mutex::new(HashMap::new()),
            disconnected: AtomicBool::new(false),
            disconnected_notify: Notify::new(),
        });
        // Each task gets a clone; on exit, the LAST one to finish
        // flips `disconnected` and fires the Notify so pending
        // `subscribe()` streams terminate. We wrap the spawned
        // futures so the signaling happens no matter how the
        // task exits (clean, error, or panic — the wrapper's
        // drop is what counts).
        {
            let s = shared.clone();
            tokio::spawn(async move {
                writer_task(w, out_rx).await;
                signal_disconnect(&s, "writer task exited");
            });
        }
        {
            let s = shared.clone();
            tokio::spawn(async move {
                reader_task(r, s.clone()).await;
                signal_disconnect(&s, "reader task exited");
            });
        }
        Self { shared }
    }

    fn next_seq(&self) -> u64 {
        self.shared.next_seq.fetch_add(1, Ordering::Relaxed)
    }

    pub async fn send_command(&self, cmd: Command) -> Result<(), ClientError> {
        let env = Envelope::new(
            self.next_seq(),
            Some("sidecar".into()),
            None,
            Control::Command(cmd),
        );
        self.shared
            .out_tx
            .send(WriteItem::Control(Box::new(env)))
            .await
            .map_err(|_| ClientError::WriterClosed)
    }

    /// Latest engine sample rate the shim has reported. Updated on
    /// every `SessionSnapshot` event from the reader task; read
    /// without locking so it's safe to call from any thread.
    /// Defaults to the schema constant until the first snapshot
    /// arrives.
    /// Has the underlying shim connection dropped? Set when either
    /// reader or writer task exits. Useful so callers (the foyer
    /// server's tool dispatch) can fail fast with "backend went away"
    /// instead of letting every subsequent send_command bubble up
    /// `WriterClosed` strings.
    pub fn is_disconnected(&self) -> bool {
        self.shared
            .disconnected
            .load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn cached_sample_rate(&self) -> u32 {
        self.shared
            .sample_rate
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Latest known `transport.position` in samples. Updated whenever
    /// the reader task observes a `ControlUpdate` with the
    /// `transport.position` id, or when a fresh `SessionSnapshot`
    /// lands. Returns 0 before the first observation.
    pub fn cached_position_samples(&self) -> u64 {
        self.shared
            .position_samples
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub async fn request_snapshot(&self) -> Result<Session, ClientError> {
        let (tx, rx) = oneshot::channel();
        self.shared.pending_snapshot.lock().await.push(tx);
        self.send_command(Command::RequestSnapshot).await?;
        let session = timeout(rx, "snapshot").await?;
        // Mirror SR into the cached atomic — a direct snapshot
        // request bypasses the SessionSnapshot event-handling path
        // (the shim sends the response directly to the waiter), so
        // the cache update has to happen here too.
        self.shared
            .sample_rate
            .store(session.sample_rate, std::sync::atomic::Ordering::Relaxed);
        Ok(session)
    }

    pub async fn subscribe(
        &self,
    ) -> Result<Pin<Box<dyn Stream<Item = Event> + Send>>, ClientError> {
        // First emit a SessionSnapshot so subscribers can initialize.
        let initial = self.request_snapshot().await?;
        let snap_event = Event::SessionSnapshot {
            session: Box::new(initial),
        };

        // Now attach a broadcast subscriber for live events and send the Subscribe
        // command so the shim knows to flush its ongoing state to us.
        let mut rx = self.shared.events.subscribe();
        self.send_command(Command::Subscribe).await?;

        // Hold a reference to `Shared` for the disconnect flag + Notify.
        // When reader/writer tasks exit (shim died), they flip the flag
        // and wake `disconnected_notify`. We select! against both
        // `rx.recv()` and the Notify so the stream terminates instead
        // of hanging forever on a broadcast whose Sender (held in
        // `Shared`) never drops.
        let shared = self.shared.clone();

        let stream = async_stream::stream! {
            yield snap_event;
            // Already disconnected before we even started? Bail.
            if shared.disconnected.load(Ordering::Acquire) {
                return;
            }
            loop {
                tokio::select! {
                    res = rx.recv() => {
                        match res {
                            Ok(ev) => yield ev,
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                    }
                    _ = shared.disconnected_notify.notified() => {
                        tracing::debug!("subscribe stream: disconnected, terminating");
                        break;
                    }
                }
            }
        };
        Ok(Box::pin(stream))
    }

    pub async fn open_egress(
        &self,
        stream_id: u32,
        source: AudioSource,
        format: AudioFormat,
    ) -> Result<PcmRx, ClientError> {
        let (tx_pcm, rx_pcm) = mpsc::channel::<PcmFrame>(64);
        self.shared
            .audio_routes
            .lock()
            .await
            .insert(stream_id, AudioRoute::Egress(tx_pcm));

        let (ack_tx, ack_rx) = oneshot::channel();
        self.shared
            .pending_egress
            .lock()
            .await
            .insert(stream_id, ack_tx);
        self.send_command(Command::AudioEgressStart {
            stream_id,
            source,
            format,
        })
        .await?;
        timeout(ack_rx, "egress_start").await??;
        Ok(rx_pcm)
    }

    pub async fn open_ingress(
        &self,
        stream_id: u32,
        source: AudioSource,
        format: AudioFormat,
    ) -> Result<(PcmTx, AudioIngressAck), ClientError> {
        let (ack_tx, ack_rx) = oneshot::channel();
        self.shared
            .pending_ingress
            .lock()
            .await
            .insert(stream_id, ack_tx);
        self.send_command(Command::AudioIngressOpen {
            stream_id,
            source,
            format,
        })
        .await?;
        let ack = timeout(ack_rx, "ingress_open").await??;

        // Pipe a caller-facing sender to writer-bound audio frames.
        let (tx_pcm, mut rx_pcm) = mpsc::channel::<PcmFrame>(INGRESS_QUEUE_CAP);
        let out_tx = self.shared.out_tx.clone();
        tokio::spawn(async move {
            while let Some(frame) = rx_pcm.recv().await {
                let bytes = f32_to_le_bytes(&frame.samples);
                // Ingress (browser → DAW) doesn't have a meaningful
                // transport position to attach — the browser is
                // generating samples that haven't entered the
                // engine timeline yet. Pass `None` so the sentinel
                // is encoded.
                let payload = pack_audio(frame.stream_id, frame.transport_pos_samples, &bytes);
                if out_tx
                    .send(WriteItem::Audio(frame.stream_id, payload))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        Ok((tx_pcm, ack))
    }

    pub async fn measure_latency(&self, stream_id: u32) -> Result<LatencyReport, ClientError> {
        let (tx, rx) = oneshot::channel();
        self.shared
            .pending_latency
            .lock()
            .await
            .insert(stream_id, tx);
        self.send_command(Command::LatencyProbe { stream_id })
            .await?;
        timeout(rx, "latency_probe").await
    }

    pub async fn list_regions(
        &self,
        track_id: EntityId,
    ) -> Result<(TimelineMeta, Vec<Region>), ClientError> {
        let (tx, rx) = oneshot::channel();
        self.shared
            .pending_regions
            .lock()
            .await
            .entry(track_id.clone())
            .or_default()
            .push(tx);
        self.send_command(Command::ListRegions {
            track_id: track_id.clone(),
        })
        .await?;
        timeout(rx, "list_regions").await
    }

    pub async fn list_audio_pool(&self) -> Result<Vec<AudioPoolSource>, ClientError> {
        let (tx, rx) = oneshot::channel();
        self.shared.pending_audio_pool_list.lock().await.push(tx);
        self.send_command(Command::ListAudioPool).await?;
        timeout(rx, "list_audio_pool").await
    }

    pub async fn import_audio(&self, path: String) -> Result<(), ClientError> {
        self.send_command(Command::ImportAudio { path }).await
    }

    pub async fn update_region(
        &self,
        id: EntityId,
        patch: RegionPatch,
    ) -> Result<Region, ClientError> {
        let (tx, rx) = oneshot::channel();
        self.shared
            .pending_update_region
            .lock()
            .await
            .entry(id.clone())
            .or_default()
            .push(tx);
        self.send_command(Command::UpdateRegion {
            id: id.clone(),
            patch,
        })
        .await?;
        timeout(rx, "update_region").await
    }

    pub async fn duplicate_region(
        &self,
        source_region_id: EntityId,
        at_samples: u64,
        length_samples: Option<u64>,
        target_track_id: Option<EntityId>,
    ) -> Result<(), ClientError> {
        self.send_command(Command::DuplicateRegion {
            source_region_id,
            at_samples,
            length_samples,
            target_track_id,
        })
        .await
    }

    pub async fn duplicate_region_range(
        &self,
        source_region_id: EntityId,
        source_offset_samples: u64,
        length_samples: u64,
        at_samples: u64,
        target_track_id: Option<EntityId>,
    ) -> Result<(), ClientError> {
        self.send_command(Command::DuplicateRegionRange {
            source_region_id,
            source_offset_samples,
            length_samples,
            at_samples,
            target_track_id,
        })
        .await
    }

    pub async fn stretch_region(
        &self,
        id: EntityId,
        new_start_samples: i64,
        new_length_samples: u64,
        anchor: String,
        preserve_pitch: bool,
    ) -> Result<(), ClientError> {
        self.send_command(Command::StretchRegion {
            id,
            new_start_samples,
            new_length_samples,
            anchor,
            preserve_pitch,
        })
        .await
    }

    pub async fn split_region(&self, id: EntityId, at_samples: i64) -> Result<(), ClientError> {
        self.send_command(Command::SplitRegion { id, at_samples })
            .await
    }

    pub async fn reverse_region(&self, id: EntityId) -> Result<(), ClientError> {
        self.send_command(Command::ReverseRegion { id }).await
    }

    pub async fn combine_regions(&self, region_ids: Vec<EntityId>) -> Result<(), ClientError> {
        self.send_command(Command::CombineRegions { region_ids })
            .await
    }

    pub async fn strip_silence_region(
        &self,
        id: EntityId,
        threshold_db: f32,
        minimum_length_samples: u64,
        fade_length_samples: u64,
    ) -> Result<(), ClientError> {
        self.send_command(Command::StripSilenceRegion {
            id,
            threshold_db,
            minimum_length_samples,
            fade_length_samples,
        })
        .await
    }

    pub async fn pitch_shift_region(
        &self,
        id: EntityId,
        semitones: f32,
    ) -> Result<(), ClientError> {
        self.send_command(Command::PitchShiftRegion { id, semitones })
            .await
    }

    pub async fn create_region(
        &self,
        track_id: EntityId,
        at_samples: u64,
        length_samples: Option<u64>,
        kind: String,
        name: Option<String>,
        source_path: Option<String>,
    ) -> Result<(), ClientError> {
        self.send_command(Command::CreateRegion {
            track_id,
            at_samples,
            length_samples,
            kind,
            name,
            source_path,
        })
        .await
    }

    pub async fn delete_region(&self, id: EntityId) -> Result<EntityId, ClientError> {
        let (tx, rx) = oneshot::channel();
        self.shared
            .pending_delete_region
            .lock()
            .await
            .entry(id.clone())
            .or_default()
            .push(tx);
        self.send_command(Command::DeleteRegion { id: id.clone() })
            .await?;
        timeout(rx, "delete_region").await
    }

    /// Look up a cached region by id. Populated from every `RegionsList` /
    /// `RegionUpdated` event the reader task sees. Returns `None` if the
    /// region has never been fetched or was since removed — the caller
    /// should fall back to a placeholder in that case.
    pub async fn region_by_id(&self, id: &EntityId) -> Option<Region> {
        self.shared.regions_cache.lock().await.get(id).cloned()
    }

    // ─── MIDI note edits ────────────────────────────────────────────────
    //
    // Fire-and-forget: enqueue the command, return as soon as the writer
    // task accepts it. The shim applies the mutation to the Ardour
    // MidiModel and emits a `RegionUpdated` event that everyone
    // subscribed to the backend (including every browser client) sees.
    // We deliberately don't await a specific echo — multiple note
    // mutations on the same region can be in flight simultaneously and
    // matching them to responses would need a correlation id we don't
    // have (and don't really need: the UI reconciles on the event
    // stream).

    pub async fn add_midi_note(
        &self,
        region_id: EntityId,
        note: MidiNote,
    ) -> Result<(), ClientError> {
        self.send_command(Command::AddNote { region_id, note })
            .await
    }

    pub async fn update_midi_note(
        &self,
        region_id: EntityId,
        note_id: EntityId,
        patch: MidiNotePatch,
    ) -> Result<(), ClientError> {
        self.send_command(Command::UpdateNote {
            region_id,
            note_id,
            patch,
        })
        .await
    }

    pub async fn delete_midi_note(
        &self,
        region_id: EntityId,
        note_id: EntityId,
    ) -> Result<(), ClientError> {
        self.send_command(Command::DeleteNote { region_id, note_id })
            .await
    }

    pub async fn replace_region_notes(
        &self,
        region_id: EntityId,
        notes: Vec<MidiNote>,
    ) -> Result<(), ClientError> {
        self.send_command(Command::ReplaceRegionNotes { region_id, notes })
            .await
    }

    pub async fn undo(&self) -> Result<(), ClientError> {
        self.send_command(Command::Undo).await
    }
    pub async fn redo(&self) -> Result<(), ClientError> {
        self.send_command(Command::Redo).await
    }
    pub async fn undo_group_begin(&self, name: String) -> Result<(), ClientError> {
        self.send_command(Command::UndoGroupBegin { name }).await
    }
    pub async fn undo_group_end(&self) -> Result<(), ClientError> {
        self.send_command(Command::UndoGroupEnd).await
    }

    pub async fn list_plugins(&self) -> Result<Vec<PluginCatalogEntry>, ClientError> {
        let (tx, rx) = oneshot::channel();
        self.shared.pending_plugins_list.lock().await.push(tx);
        self.send_command(Command::ListPlugins).await?;
        timeout(rx, "list_plugins").await
    }

    pub async fn list_ports(
        &self,
        direction: Option<String>,
    ) -> Result<Vec<EnginePort>, ClientError> {
        let (tx, rx) = oneshot::channel();
        self.shared.pending_ports_list.lock().await.push(tx);
        self.send_command(Command::ListPorts { direction }).await?;
        timeout(rx, "list_ports").await
    }

    pub async fn add_send(
        &self,
        track_id: EntityId,
        target_track_id: EntityId,
        pre_fader: bool,
    ) -> Result<(), ClientError> {
        self.send_command(Command::AddSend {
            track_id,
            target_track_id,
            pre_fader,
        })
        .await
    }
    pub async fn remove_send(&self, send_id: EntityId) -> Result<(), ClientError> {
        self.send_command(Command::RemoveSend { send_id }).await
    }
    pub async fn set_send_level(&self, send_id: EntityId, level: f64) -> Result<(), ClientError> {
        self.send_command(Command::SetSendLevel { send_id, level })
            .await
    }

    pub async fn list_plugin_presets(
        &self,
        plugin_id: EntityId,
    ) -> Result<Vec<PluginPreset>, ClientError> {
        let (tx, rx) = oneshot::channel();
        self.shared
            .pending_presets
            .lock()
            .await
            .entry(plugin_id.clone())
            .or_default()
            .push(tx);
        self.send_command(Command::ListPluginPresets { plugin_id })
            .await?;
        timeout(rx, "list_plugin_presets").await
    }

    pub async fn list_midi_patch_names(
        &self,
        track_id: EntityId,
        channel: u8,
    ) -> Result<MidiPatchNames, ClientError> {
        let key = format!("{}:{channel}", track_id.as_str());
        let (tx, rx) = oneshot::channel();
        self.shared
            .pending_midi_patch_names
            .lock()
            .await
            .entry(key)
            .or_default()
            .push(tx);
        self.send_command(Command::ListMidiPatchNames { track_id, channel })
            .await?;
        timeout(rx, "list_midi_patch_names").await
    }

    pub async fn load_plugin_preset(
        &self,
        plugin_id: EntityId,
        preset_id: EntityId,
    ) -> Result<(), ClientError> {
        self.send_command(Command::LoadPluginPreset {
            plugin_id,
            preset_id,
        })
        .await
    }

    pub async fn add_patch_change(
        &self,
        region_id: EntityId,
        patch_change: PatchChange,
    ) -> Result<(), ClientError> {
        self.send_command(Command::AddPatchChange {
            region_id,
            patch_change,
        })
        .await
    }
    pub async fn update_patch_change(
        &self,
        region_id: EntityId,
        patch_change_id: EntityId,
        patch: PatchChangePatch,
    ) -> Result<(), ClientError> {
        self.send_command(Command::UpdatePatchChange {
            region_id,
            patch_change_id,
            patch,
        })
        .await
    }
    pub async fn delete_patch_change(
        &self,
        region_id: EntityId,
        patch_change_id: EntityId,
    ) -> Result<(), ClientError> {
        self.send_command(Command::DeletePatchChange {
            region_id,
            patch_change_id,
        })
        .await
    }

    pub async fn set_track_midi_patch(
        &self,
        track_id: EntityId,
        channel: u8,
        bank: i32,
        program: u8,
    ) -> Result<(), ClientError> {
        self.send_command(Command::SetTrackMidiPatch {
            track_id,
            channel,
            bank,
            program,
        })
        .await
    }

    pub async fn set_sequencer_layout(
        &self,
        region_id: EntityId,
        layout: SequencerLayout,
    ) -> Result<(), ClientError> {
        self.send_command(Command::SetSequencerLayout { region_id, layout })
            .await
    }
    pub async fn clear_sequencer_layout(&self, region_id: EntityId) -> Result<(), ClientError> {
        self.send_command(Command::ClearSequencerLayout { region_id })
            .await
    }

    // ── Scripting ────────────────────────────────────────────────────
    pub async fn list_scripts(&self) -> Result<Vec<foyer_schema::Script>, ClientError> {
        let (tx, rx) = oneshot::channel();
        self.shared.pending_scripts_list.lock().await.push(tx);
        self.send_command(Command::ListScripts).await?;
        timeout(rx, "list_scripts").await
    }

    pub async fn save_script(
        &self,
        script: foyer_schema::Script,
    ) -> Result<foyer_schema::Script, ClientError> {
        let (tx, rx) = oneshot::channel();
        self.shared.pending_save_script.lock().await.push(tx);
        self.send_command(Command::SaveScript { script }).await?;
        timeout(rx, "save_script").await
    }

    pub async fn delete_script(&self, id: EntityId) -> Result<(), ClientError> {
        // Fire-and-forget; `ScriptRemoved` fans out separately.
        self.send_command(Command::DeleteScript { id }).await
    }

    pub async fn enable_script(
        &self,
        id: EntityId,
        enabled: bool,
    ) -> Result<foyer_schema::Script, ClientError> {
        let (tx, rx) = oneshot::channel();
        self.shared.pending_enable_script.lock().await.push(tx);
        self.send_command(Command::EnableScript { id, enabled })
            .await?;
        timeout(rx, "enable_script").await
    }

    pub async fn run_script(
        &self,
        id: EntityId,
        args_override: Option<std::collections::BTreeMap<String, String>>,
    ) -> Result<foyer_schema::ScriptRunResult, ClientError> {
        let (tx, rx) = oneshot::channel();
        self.shared
            .pending_run_script
            .lock()
            .await
            .entry(id.clone())
            .or_default()
            .push(tx);
        self.send_command(Command::RunScript { id, args_override })
            .await?;
        timeout(rx, "run_script").await
    }

    pub async fn recover_disabled_scripts(&self) -> Result<Vec<foyer_schema::Script>, ClientError> {
        // The shim emits `ScriptList` after recovery so the regular
        // list waiter picks it up. Sequence: send Recover → wait for
        // the fresh ScriptList → return.
        let (tx, rx) = oneshot::channel();
        self.shared.pending_scripts_list.lock().await.push(tx);
        self.send_command(Command::RecoverDisabledScripts).await?;
        let all = timeout(rx, "recover_disabled_scripts").await?;
        Ok(all.into_iter().filter(|s| s.disabled_on_upload).collect())
    }

    /// Synchronous read from the cached caps. Populated by the snapshot
    /// reader; the shim refreshes via `ScriptingCapabilitiesChanged`.
    pub async fn scripting_capabilities(&self) -> Option<foyer_schema::ScriptingCapabilities> {
        self.shared.cached_scripting_caps.lock().await.clone()
    }

    pub async fn set_automation_mode(
        &self,
        lane_id: EntityId,
        mode: foyer_schema::AutomationMode,
    ) -> Result<(), ClientError> {
        self.send_command(Command::SetAutomationMode { lane_id, mode })
            .await
    }
    pub async fn add_automation_point(
        &self,
        lane_id: EntityId,
        point: foyer_schema::AutomationPoint,
    ) -> Result<(), ClientError> {
        self.send_command(Command::AddAutomationPoint { lane_id, point })
            .await
    }
    pub async fn update_automation_point(
        &self,
        lane_id: EntityId,
        original_time_samples: u64,
        new_time_samples: u64,
        value: f64,
    ) -> Result<(), ClientError> {
        self.send_command(Command::UpdateAutomationPoint {
            lane_id,
            original_time_samples,
            new_time_samples,
            value,
        })
        .await
    }
    pub async fn delete_automation_point(
        &self,
        lane_id: EntityId,
        time_samples: u64,
    ) -> Result<(), ClientError> {
        self.send_command(Command::DeleteAutomationPoint {
            lane_id,
            time_samples,
        })
        .await
    }
    pub async fn replace_automation_lane(
        &self,
        lane_id: EntityId,
        points: Vec<foyer_schema::AutomationPoint>,
    ) -> Result<(), ClientError> {
        self.send_command(Command::ReplaceAutomationLane { lane_id, points })
            .await
    }

    pub async fn set_track_input(
        &self,
        track_id: EntityId,
        port_name: Option<String>,
    ) -> Result<(), ClientError> {
        self.send_command(Command::SetTrackInput {
            track_id,
            port_name,
        })
        .await
    }

    pub async fn update_track(
        &self,
        id: EntityId,
        patch: TrackPatch,
    ) -> Result<Track, ClientError> {
        let (tx, rx) = oneshot::channel();
        self.shared
            .pending_update_track
            .lock()
            .await
            .entry(id.clone())
            .or_default()
            .push(tx);
        self.send_command(Command::UpdateTrack {
            id: id.clone(),
            patch,
        })
        .await?;
        timeout(rx, "update_track").await
    }

    pub async fn set_track_midi_channel_mode(
        &self,
        track_id: EntityId,
        direction: String,
        mode: String,
        mask: u16,
    ) -> Result<Track, ClientError> {
        let (tx, rx) = oneshot::channel();
        self.shared
            .pending_update_track
            .lock()
            .await
            .entry(track_id.clone())
            .or_default()
            .push(tx);
        self.send_command(Command::SetTrackMidiChannelMode {
            track_id: track_id.clone(),
            direction,
            mode,
            mask,
        })
        .await?;
        timeout(rx, "set_track_midi_channel_mode").await
    }
}

async fn timeout<T>(rx: oneshot::Receiver<T>, label: &'static str) -> Result<T, ClientError> {
    match tokio::time::timeout(DEFAULT_REQUEST_TIMEOUT, rx).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(_)) => Err(ClientError::WriterClosed),
        Err(_) => Err(ClientError::Timeout(label)),
    }
}

/// Pack an interleaved `f32` slice into little-endian bytes suitable for an audio
/// frame payload. Exposed for integration tests that stand up a fake shim.
pub fn f32_to_le_bytes(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// Mark the client as disconnected. Idempotent — multiple callers
/// (reader + writer task exits) all converging at the same state is
/// fine. The Notify wakes all currently-awaiting `subscribe` streams
/// so they can terminate; subsequent checks of the AtomicBool handle
/// the case where the Notify fired before a stream started watching.
fn signal_disconnect(shared: &Arc<Shared>, why: &str) {
    if !shared.disconnected.swap(true, Ordering::AcqRel) {
        tracing::info!("HostClient disconnected: {why}");
        shared.disconnected_notify.notify_waiters();
    }
}

/// Unpack a little-endian `f32` byte slice back into samples. Inverse of
/// [`f32_to_le_bytes`].
pub fn le_bytes_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

async fn writer_task<W>(mut w: W, mut rx: mpsc::Receiver<WriteItem>)
where
    W: AsyncWrite + Unpin,
{
    while let Some(item) = rx.recv().await {
        let res = match item {
            WriteItem::Control(env) => match encode_control(&env) {
                Ok(payload) => {
                    let f = Frame {
                        kind: FrameKind::Control,
                        payload,
                    };
                    write_frame(&mut w, &f).await
                }
                Err(e) => {
                    tracing::warn!("encode control failed: {e}");
                    continue;
                }
            },
            WriteItem::Audio(_stream_id, payload) => {
                let f = Frame {
                    kind: FrameKind::Audio,
                    payload,
                };
                write_frame(&mut w, &f).await
            }
        };
        if let Err(e) = res {
            tracing::warn!("writer loop: {e}");
            break;
        }
    }
}

async fn reader_task<R>(mut r: R, shared: Arc<Shared>)
where
    R: AsyncRead + Unpin,
{
    loop {
        let frame = match read_frame(&mut r).await {
            Ok(Some(f)) => f,
            Ok(None) => {
                tracing::info!("shim closed connection");
                break;
            }
            Err(e) => {
                tracing::warn!("frame read error: {e}");
                break;
            }
        };
        match frame.kind {
            FrameKind::Control => {
                let env = match decode_control(&frame.payload) {
                    Ok(e) => e,
                    Err(e) => {
                        tracing::warn!("bad control frame: {e}");
                        continue;
                    }
                };
                handle_incoming(&shared, env).await;
            }
            FrameKind::Audio => {
                if let Some((stream_id, transport_pos, pcm_bytes)) = unpack_audio(&frame.payload) {
                    let samples = le_bytes_to_f32(pcm_bytes);
                    if let Some(AudioRoute::Egress(tx)) =
                        shared.audio_routes.lock().await.get(&stream_id)
                    {
                        // `transport_pos = Some(_)` when the shim
                        // attached a sample-accurate position;
                        // `None` (sentinel `-1`) when it didn't and
                        // the egress encoder will fall back to the
                        // polled cache.
                        let _ = tx
                            .send(PcmFrame {
                                stream_id,
                                samples,
                                transport_pos_samples: transport_pos,
                            })
                            .await;
                    }
                }
            }
        }
    }
}

/// Mirror a `transport.position` ControlUpdate into the shared
/// position cache so `HostBackend::transport_position_samples()`
/// returns it without an extra snapshot round-trip. Silently
/// ignores other ids and non-float values.
fn cache_position_from_update(shared: &Arc<Shared>, update: &foyer_schema::ControlUpdate) {
    if update.id.as_str() != "transport.position" {
        return;
    }
    let foyer_schema::ControlValue::Float(p) = update.value else {
        return;
    };
    if !p.is_finite() || p < 0.0 {
        return;
    }
    shared
        .position_samples
        .store(p as u64, std::sync::atomic::Ordering::Relaxed);
}

async fn handle_incoming(shared: &Arc<Shared>, env: Envelope<Control>) {
    match env.body {
        Control::Event(ev) => {
            let skip_publish = matches!(&ev, Event::AudioIngressOpened { .. });
            match &ev {
                Event::SessionSnapshot { session } => {
                    // Mirror the snapshot's sample rate into the cached
                    // atomic so `HostBackend::sample_rate()` returns the
                    // shim's actual rate without a snapshot round-trip.
                    shared
                        .sample_rate
                        .store(session.sample_rate, std::sync::atomic::Ordering::Relaxed);
                    if let foyer_schema::ControlValue::Float(p) =
                        session.transport.position_beats.value
                    {
                        if p.is_finite() && p >= 0.0 {
                            shared
                                .position_samples
                                .store(p as u64, std::sync::atomic::Ordering::Relaxed);
                        }
                    }
                    // Hydrate the cached scripting caps from the
                    // snapshot so `scripting_capabilities()` answers
                    // without a round-trip after the first snapshot.
                    *shared.cached_scripting_caps.lock().await = session.scripting.clone();
                    let waiters = std::mem::take(&mut *shared.pending_snapshot.lock().await);
                    for w in waiters {
                        let _ = w.send((**session).clone());
                    }
                }
                Event::ControlUpdate { update } => {
                    cache_position_from_update(shared, update);
                }
                Event::MeterBatch { values } => {
                    for u in values {
                        cache_position_from_update(shared, u);
                    }
                }
                Event::AudioEgressStarted { stream_id } => {
                    if let Some(w) = shared.pending_egress.lock().await.remove(stream_id) {
                        let _ = w.send(Ok(()));
                    }
                }
                Event::AudioIngressOpened {
                    stream_id,
                    format,
                    port_name,
                    ..
                } => {
                    if let Some(w) = shared.pending_ingress.lock().await.remove(stream_id) {
                        let _ = w.send(Ok(AudioIngressAck {
                            format: *format,
                            port_name: port_name.clone(),
                        }));
                    }
                }
                Event::LatencyReport { stream_id, report } => {
                    if let Some(w) = shared.pending_latency.lock().await.remove(stream_id) {
                        let _ = w.send(*report);
                    }
                }
                Event::RegionsList {
                    track_id,
                    timeline,
                    regions,
                } => {
                    // Update the per-region cache + resolve any pending
                    // list_regions awaiter for this track.
                    {
                        let mut cache = shared.regions_cache.lock().await;
                        for r in regions {
                            cache.insert(r.id.clone(), r.clone());
                        }
                    }
                    if let Some(waiters) = shared.pending_regions.lock().await.remove(track_id) {
                        for w in waiters {
                            let _ = w.send((*timeline, regions.clone()));
                        }
                    }
                }
                Event::RegionUpdated { region } => {
                    shared
                        .regions_cache
                        .lock()
                        .await
                        .insert(region.id.clone(), region.as_ref().clone());
                    if let Some(waiters) =
                        shared.pending_update_region.lock().await.remove(&region.id)
                    {
                        for w in waiters {
                            let _ = w.send(region.as_ref().clone());
                        }
                    }
                }
                Event::TrackUpdated { track } => {
                    if let Some(waiters) =
                        shared.pending_update_track.lock().await.remove(&track.id)
                    {
                        for w in waiters {
                            let _ = w.send((**track).clone());
                        }
                    }
                }
                Event::RegionRemoved {
                    track_id,
                    region_id,
                } => {
                    shared.regions_cache.lock().await.remove(region_id);
                    if let Some(waiters) =
                        shared.pending_delete_region.lock().await.remove(region_id)
                    {
                        for w in waiters {
                            let _ = w.send(track_id.clone());
                        }
                    }
                }
                Event::PluginsList { entries } => {
                    let waiters: Vec<_> =
                        std::mem::take(&mut *shared.pending_plugins_list.lock().await);
                    for w in waiters {
                        let _ = w.send(entries.clone());
                    }
                }
                Event::PortsListed { ports } => {
                    let waiters: Vec<_> =
                        std::mem::take(&mut *shared.pending_ports_list.lock().await);
                    for w in waiters {
                        let _ = w.send(ports.clone());
                    }
                }
                Event::AudioPoolListed { sources } => {
                    let waiters: Vec<_> =
                        std::mem::take(&mut *shared.pending_audio_pool_list.lock().await);
                    for w in waiters {
                        let _ = w.send(sources.clone());
                    }
                }
                Event::ScriptList { scripts } => {
                    let waiters: Vec<_> =
                        std::mem::take(&mut *shared.pending_scripts_list.lock().await);
                    for w in waiters {
                        let _ = w.send(scripts.clone());
                    }
                }
                Event::ScriptSaved { script } => {
                    let waiters: Vec<_> =
                        std::mem::take(&mut *shared.pending_save_script.lock().await);
                    for w in waiters {
                        let _ = w.send(script.clone());
                    }
                    // The same event resolves enable_script too. The
                    // caller distinguishes by which command they sent;
                    // both flows just need to see the post-save shape.
                    let waiters: Vec<_> =
                        std::mem::take(&mut *shared.pending_enable_script.lock().await);
                    for w in waiters {
                        let _ = w.send(script.clone());
                    }
                }
                Event::ScriptRunResult { result } => {
                    if let Some(waiters) = shared.pending_run_script.lock().await.remove(&result.id)
                    {
                        for w in waiters {
                            let _ = w.send(result.clone());
                        }
                    }
                }
                Event::ScriptingCapabilitiesChanged { capabilities } => {
                    *shared.cached_scripting_caps.lock().await = capabilities.clone();
                }
                Event::PluginPresetsListed { plugin_id, presets } => {
                    if let Some(waiters) = shared.pending_presets.lock().await.remove(plugin_id) {
                        for w in waiters {
                            let _ = w.send(presets.clone());
                        }
                    }
                }
                Event::MidiPatchNamesListed { track_id, names } => {
                    let key = format!("{}:{}", track_id.as_str(), names.channel);
                    if let Some(waiters) = shared.pending_midi_patch_names.lock().await.remove(&key)
                    {
                        for w in waiters {
                            let _ = w.send(names.clone());
                        }
                    }
                }
                Event::Error { code, message, .. } => {
                    tracing::warn!("shim error: {code}: {message}");
                }
                _ => {}
            }
            if !skip_publish {
                let _ = shared.events.send(ev);
            }
        }
        Control::Command(cmd) => {
            // Shims shouldn't be sending commands; but if one does, log it.
            tracing::warn!("unexpected command from shim: {cmd:?}");
        }
    }
}

/// Helpers exposed for integration tests (fake shims that need to craft PCM payloads).
pub mod test_helpers {
    pub use super::{f32_to_le_bytes, le_bytes_to_f32};
}
