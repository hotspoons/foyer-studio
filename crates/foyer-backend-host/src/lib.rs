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

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use foyer_backend::{Backend, BackendError, EventStream, PcmRx, PcmTx};
use foyer_schema::{
    AudioFormat, AudioSource, Command, ControlValue, EntityId, LatencyReport, Session,
};

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
}

pub use client::test_helpers;
