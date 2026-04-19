//! The `Backend` trait is the sidecar's view of the world. Implementations:
//!
//! - `foyer-backend-stub` — in-memory fake session for development and demo mode.
//! - `foyer-backend-host` — IPC client that talks to any shim speaking `foyer-ipc`.
//!
//! Nothing above this trait knows which kind of backend is attached.

#![forbid(unsafe_code)]

use std::pin::Pin;

use async_trait::async_trait;
use foyer_schema::{
    Action, AudioFormat, AudioSource, ControlValue, EntityId, Event, LatencyReport, PathListing,
    PluginCatalogEntry, Region, RegionPatch, Session, TimelineMeta, WaveformPeaks,
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

    async fn snapshot(&self) -> Result<Session, BackendError>;
    async fn subscribe(&self) -> Result<EventStream, BackendError>;
    async fn set_control(&self, id: EntityId, value: ControlValue) -> Result<(), BackendError>;

    // ─── introspection ──────────────────────────────────────────────────
    //
    // Default implementations return empty results so a backend that hasn't
    // implemented these yet (early shim, or a minimal port of a second DAW)
    // still compiles and runs.

    async fn list_actions(&self) -> Result<Vec<Action>, BackendError> {
        Ok(Vec::new())
    }
    async fn invoke_action(&self, id: EntityId) -> Result<(), BackendError> {
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
    /// Remove a region from its track. Returns the track id the region was
    /// on (so the server can emit `RegionRemoved { track_id, region_id }`).
    async fn delete_region(&self, _id: EntityId) -> Result<EntityId, BackendError> {
        Err(BackendError::Other("delete_region not supported".into()))
    }
    async fn load_waveform(
        &self,
        _region_id: EntityId,
        _samples_per_peak: u32,
    ) -> Result<WaveformPeaks, BackendError> {
        Err(BackendError::Other("load_waveform not supported".into()))
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

    async fn open_ingress(
        &self,
        stream_id: u32,
        source: AudioSource,
        format: AudioFormat,
    ) -> Result<PcmTx, BackendError>;

    async fn measure_latency(&self, stream_id: u32) -> Result<LatencyReport, BackendError>;
}
