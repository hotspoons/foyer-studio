// SPDX-License-Identifier: Apache-2.0
//! Spectrum / FFT tool.
//!
//! Two subcommands the agent reaches for:
//!
//!   - `capabilities` — what the active backend can do (FFT sizes,
//!     windows, max frame rate). Agents call this BEFORE `snapshot`
//!     so they don't ask for parameters the host can't honour.
//!
//!   - `snapshot` — capture a single FFT frame against the named
//!     target (master / monitor / track id) and return its bin
//!     magnitudes as structured data. This is the "instant"
//!     analysis path; for "temporal" the agent uses
//!     `visualize.spectrogram` which renders a waterfall PNG.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

pub struct SpectrumTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    /// Probe what the live backend supports.
    Capabilities,
    /// One-shot snapshot at the CURRENT transport position. Returns
    /// silence frames if transport is stopped — for offline analysis
    /// at a specific time use `capture_at` instead.
    Snapshot {
        #[serde(default)]
        target: TargetArg,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fft_size: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_bins: Option<u32>,
        #[serde(default = "default_per_channel")]
        per_channel: bool,
    },
    /// Offline capture at a specific transport position. The director
    /// locates transport to `at_samples`, optionally mutes master so
    /// the user doesn't hear the scrub, plays briefly, captures one
    /// FFT window, and restores prior state. Multi-client warning:
    /// mutates SHARED playback state for ~100ms; other connected
    /// clients will see transport move.
    CaptureAt {
        at_samples: u64,
        #[serde(default)]
        target: TargetArg,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fft_size: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_bins: Option<u32>,
        #[serde(default = "default_per_channel")]
        per_channel: bool,
        #[serde(default = "default_true")]
        mute_master: bool,
    },
    /// Offline capture across a time window. The director sweeps
    /// transport from `start_samples` to `end_samples`, accumulating
    /// FFT hops with exponential-moving-average smoothing (`decay`
    /// 0..1; default 0.85 = smooth). Returns the final aggregated
    /// frame — perfect for "what does this section sound like on
    /// average?" without the LLM having to make sense of N raw
    /// snapshots. Same multi-client transport-mutation caveat as
    /// `capture_at`.
    CaptureWindow {
        start_samples: u64,
        end_samples: u64,
        #[serde(default)]
        target: TargetArg,
        #[serde(default = "default_decay")]
        decay: f32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fft_size: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_bins: Option<u32>,
        #[serde(default = "default_per_channel")]
        per_channel: bool,
        #[serde(default = "default_true")]
        mute_master: bool,
    },
}

fn default_true() -> bool {
    true
}

fn default_decay() -> f32 {
    0.85
}

fn default_per_channel() -> bool {
    true
}

#[derive(Debug, Default, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum TargetArg {
    #[default]
    Master,
    Monitor,
    Track {
        id: String,
    },
}

impl From<TargetArg> for foyer_schema::SpectrumTarget {
    fn from(value: TargetArg) -> Self {
        match value {
            TargetArg::Master => foyer_schema::SpectrumTarget::Master,
            TargetArg::Monitor => foyer_schema::SpectrumTarget::Monitor,
            TargetArg::Track { id } => foyer_schema::SpectrumTarget::Track {
                id: foyer_schema::EntityId::new(id),
            },
        }
    }
}

#[async_trait]
impl Tool for SpectrumTool {
    fn name(&self) -> &'static str {
        "spectrum"
    }

    fn description(&self) -> &'static str {
        "Spectrum analysis (FFT) against master / monitor / a track. \
         Subcommands: capabilities (host support), snapshot (instant \
         at the CURRENT transport position — returns silence if \
         transport stopped), capture_at(at_samples, ...) (offline: \
         locate transport, briefly play, capture one FFT window, \
         restore — mute_master defaults true so the user doesn't \
         hear the scrub), capture_window(start_samples, end_samples, \
         decay?, ...) (offline: sweep through window, EMA-aggregate \
         hops; ideal for 'what does this section average?'). \
         capture_* MUTATE shared transport state for the duration of \
         the capture (multi-client warning). For a streaming waterfall \
         PNG use `visualize.spectrogram`."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": {
                    "type": "string",
                    "enum": ["capabilities", "snapshot", "capture_at", "capture_window"]
                },
                "target": {
                    "type": "object",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": ["master", "monitor", "track"]
                        },
                        "id":   { "type": "string" }
                    },
                    "required": ["kind"]
                },
                "at_samples":    { "type": "integer", "minimum": 0 },
                "start_samples": { "type": "integer", "minimum": 0 },
                "end_samples":   { "type": "integer", "minimum": 0 },
                "decay":         { "type": "number", "minimum": 0, "maximum": 1,
                    "description": "EMA decay 0..1. 0 = each hop overwrites; 0.85 = smooth." },
                "fft_size":      { "type": "integer", "minimum": 256, "maximum": 16384 },
                "max_bins":      { "type": "integer", "minimum": 16, "maximum": 8192 },
                "per_channel":   { "type": "boolean" },
                "mute_master":   { "type": "boolean",
                    "description": "Default true — mute master output for the duration of the capture." }
            }
        })
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        let backend = ctx.backend()?;
        match op {
            Op::Capabilities => {
                let caps = backend
                    .spectrum_capabilities()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let summary = match &caps {
                    Some(c) if c.available => format!(
                        "spectrum available — {} fft size(s), {} window(s), max {} Hz",
                        c.fft_sizes.len(),
                        c.windows.len(),
                        c.max_frame_rate_hz,
                    ),
                    Some(_) | None => "spectrum unavailable on this backend".to_string(),
                };
                Ok(ToolResult::ok(summary).with_data(
                    serde_json::to_value(&caps).map_err(|e| ToolError::Execution(e.to_string()))?,
                ))
            }
            Op::Snapshot {
                target,
                fft_size,
                max_bins,
                per_channel,
            } => {
                let target: foyer_schema::SpectrumTarget = target.into();
                let opts = foyer_schema::SpectrumOpts {
                    fft_size: fft_size.unwrap_or(2048),
                    hop_size: None,
                    window: foyer_schema::SpectrumWindow::Hann,
                    min_db: -100.0,
                    max_bins,
                    per_channel,
                };
                let frame = backend
                    .snapshot_spectrum(target.clone(), opts)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let summary = format!(
                    "{} · {} bins · {} channel(s) @ {} Hz",
                    target.slug(),
                    frame.bins,
                    frame.channels.len(),
                    frame.sample_rate,
                );
                let data = serde_json::to_value(&frame)
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(summary).with_data(data))
            }
            Op::CaptureAt {
                at_samples,
                target,
                fft_size,
                max_bins,
                per_channel,
                mute_master,
            } => {
                let director = ctx.spectrum_director.as_ref().ok_or_else(|| {
                    ToolError::Execution(
                        "spectrum director not attached — offline capture requires the runtime's spectrum service"
                            .into(),
                    )
                })?;
                let target_json =
                    serde_json::to_value(Into::<foyer_schema::SpectrumTarget>::into(target))
                        .map_err(|e| ToolError::Execution(e.to_string()))?;
                let opts = foyer_schema::SpectrumOpts {
                    fft_size: fft_size.unwrap_or(2048),
                    hop_size: None,
                    window: foyer_schema::SpectrumWindow::Hann,
                    min_db: -100.0,
                    max_bins,
                    per_channel,
                };
                let opts_json =
                    serde_json::to_value(&opts).map_err(|e| ToolError::Execution(e.to_string()))?;
                let frame = director
                    .capture_at(target_json, opts_json, at_samples, mute_master)
                    .await?;
                Ok(ToolResult::ok(format!(
                    "captured frame at sample {at_samples}{}",
                    if mute_master { " (master muted)" } else { "" }
                ))
                .with_data(frame))
            }
            Op::CaptureWindow {
                start_samples,
                end_samples,
                target,
                decay,
                fft_size,
                max_bins,
                per_channel,
                mute_master,
            } => {
                if end_samples < start_samples {
                    return Err(ToolError::InvalidArgs(
                        "end_samples must be >= start_samples".into(),
                    ));
                }
                let director = ctx.spectrum_director.as_ref().ok_or_else(|| {
                    ToolError::Execution(
                        "spectrum director not attached — offline capture requires the runtime's spectrum service"
                            .into(),
                    )
                })?;
                let target_json =
                    serde_json::to_value(Into::<foyer_schema::SpectrumTarget>::into(target))
                        .map_err(|e| ToolError::Execution(e.to_string()))?;
                let opts = foyer_schema::SpectrumOpts {
                    fft_size: fft_size.unwrap_or(2048),
                    hop_size: None,
                    window: foyer_schema::SpectrumWindow::Hann,
                    min_db: -100.0,
                    max_bins,
                    per_channel,
                };
                let opts_json =
                    serde_json::to_value(&opts).map_err(|e| ToolError::Execution(e.to_string()))?;
                let frame = director
                    .capture_window(
                        target_json,
                        opts_json,
                        start_samples,
                        end_samples,
                        decay,
                        mute_master,
                    )
                    .await?;
                Ok(ToolResult::ok(format!(
                    "aggregated spectrum over [{start_samples}..{end_samples}] (decay {decay})"
                ))
                .with_data(frame))
            }
        }
    }
}
