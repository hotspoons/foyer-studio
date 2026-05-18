// SPDX-License-Identifier: Apache-2.0
//! `SpectrumDirector` impl: bridges the agent's `spectrum.capture_*`
//! subcommands into the in-sidecar `SpectrumService`. The service
//! drives transport (locate + play + stop), optionally mutes the
//! master bus while capturing, and aggregates FFT bins — see
//! `spectrum.rs` for the meat.

use std::sync::{Arc, Weak};

use async_trait::async_trait;
use foyer_agent::tools::{SpectrumDirector, SpectrumDirectorError};
use foyer_schema::{SpectrumOpts, SpectrumTarget};
use serde_json::Value;

use crate::AppState;

pub struct SpectrumDirectorImpl {
    state: Weak<AppState>,
}

impl SpectrumDirectorImpl {
    pub fn new(state: Weak<AppState>) -> Arc<Self> {
        Arc::new(Self { state })
    }

    fn parse_target(t: Value) -> Result<SpectrumTarget, SpectrumDirectorError> {
        serde_json::from_value(t)
            .map_err(|e| SpectrumDirectorError::Execution(format!("invalid spectrum target: {e}")))
    }

    fn parse_opts(o: Value) -> Result<SpectrumOpts, SpectrumDirectorError> {
        serde_json::from_value(o)
            .map_err(|e| SpectrumDirectorError::Execution(format!("invalid spectrum opts: {e}")))
    }

    async fn resolve(
        &self,
    ) -> Result<(Arc<AppState>, Arc<dyn foyer_backend::Backend>, u32), SpectrumDirectorError> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| SpectrumDirectorError::Execution("sidecar state dropped".into()))?;
        let backend = state.backend().await;
        let snap = backend.snapshot().await.map_err(|e| {
            SpectrumDirectorError::Execution(format!("backend snapshot failed: {e}"))
        })?;
        Ok((state, backend, snap.sample_rate))
    }
}

#[async_trait]
impl SpectrumDirector for SpectrumDirectorImpl {
    async fn capture_at(
        &self,
        target: Value,
        opts: Value,
        at_samples: u64,
        mute_master: bool,
    ) -> Result<Value, SpectrumDirectorError> {
        let target = Self::parse_target(target)?;
        let opts = Self::parse_opts(opts)?;
        let (state, backend, sample_rate) = self.resolve().await?;
        let frame = state
            .spectrum_svc
            .capture_at(backend, target, opts, at_samples, sample_rate, mute_master)
            .await
            .map_err(SpectrumDirectorError::Execution)?;
        serde_json::to_value(frame)
            .map_err(|e| SpectrumDirectorError::Execution(format!("encode frame: {e}")))
    }

    async fn capture_window(
        &self,
        target: Value,
        opts: Value,
        start_samples: u64,
        end_samples: u64,
        decay: f32,
        mute_master: bool,
    ) -> Result<Value, SpectrumDirectorError> {
        let target = Self::parse_target(target)?;
        let opts = Self::parse_opts(opts)?;
        let (state, backend, sample_rate) = self.resolve().await?;
        let frame = state
            .spectrum_svc
            .capture_window(
                backend,
                target,
                opts,
                start_samples,
                end_samples,
                decay,
                sample_rate,
                mute_master,
            )
            .await
            .map_err(SpectrumDirectorError::Execution)?;
        serde_json::to_value(frame)
            .map_err(|e| SpectrumDirectorError::Execution(format!("encode frame: {e}")))
    }
}
