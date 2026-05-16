// SPDX-License-Identifier: Apache-2.0
//! Visualization tool — render a Foyer view to PNG.
//!
//! Prefers an attached browser (FE renders the actual Lit component
//! and screenshots it via the visualize bridge over WS). Falls back
//! to the headless renderer when no FE is attached, which is what
//! lets external MCP consumers (Claude Code, TUI clients) get
//! visuals without a foyer browser tab open.

use async_trait::async_trait;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

pub struct VisualizeTool;

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
pub enum VisualizeRequest {
    Timeline {
        #[serde(default)]
        track_ids: Vec<String>,
    },
    Mixer {
        #[serde(default)]
        track_ids: Vec<String>,
    },
    Waveform {
        track_id: String,
        region_id: String,
    },
    Spectrogram {
        track_id: String,
        #[serde(default)]
        duration_ms: Option<u32>,
    },
    AutomationLane {
        track_id: String,
        control_id: String,
    },
    EventHeatmap {
        track_id: String,
    },
    MidiRoll {
        track_id: String,
        region_id: String,
    },
    BeatSequencer {
        track_id: String,
        region_id: String,
    },
}

#[async_trait]
impl Tool for VisualizeTool {
    fn name(&self) -> &'static str {
        "visualize"
    }

    fn description(&self) -> &'static str {
        "Render a Foyer visualization to PNG and return it inline. \
         Subcommands: timeline, mixer, waveform, spectrogram, \
         automation_lane, event_heatmap, midi_roll, beat_sequencer. \
         Prefers an attached browser; falls back to a headless renderer."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": {
                    "type": "string",
                    "enum": [
                        "timeline", "mixer", "waveform", "spectrogram",
                        "automation_lane", "event_heatmap",
                        "midi_roll", "beat_sequencer"
                    ]
                },
                "track_id": { "type": "string" },
                "track_ids": { "type": "array", "items": { "type": "string" } },
                "region_id": { "type": "string" },
                "control_id": { "type": "string" },
                "duration_ms": { "type": "integer", "minimum": 100 }
            }
        })
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        // Validate via the typed request shape but pass the original
        // args to whichever renderer ends up handling it — both speak
        // the same protocol.
        let _validated: VisualizeRequest = serde_json::from_value(args.clone())
            .map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        // Default order: FE first (faster — already has live data
        // and cached peaks), headless as fallback when no tab is
        // attached. The `prefer_headless_render` config flip is for
        // deterministic / repeatable runs (CI, batch, agent over MCP
        // without a UI tab) where the output shouldn't depend on
        // whether a human happens to be watching.
        let fe = ctx.fe_render.as_ref();
        let hl = ctx.headless_render.as_ref();
        let png = if ctx.prefer_headless_render {
            match (hl, fe) {
                (Some(a), Some(b)) => match a.render(args.clone()).await {
                    Ok(bytes) => bytes,
                    Err(a_err) => {
                        tracing::debug!(
                            "visualize: headless render failed ({a_err}); falling back to fe"
                        );
                        b.render(args).await.map_err(|b_err| {
                            ToolError::Execution(format!(
                                "both renderers failed.\nheadless: {a_err}\nfe: {b_err}"
                            ))
                        })?
                    }
                },
                (Some(a), None) => a.render(args).await?,
                (None, Some(b)) => b.render(args).await?,
                (None, None) => {
                    return Err(ToolError::Execution(
                        "no renderer wired into the agent runtime".into(),
                    ));
                }
            }
        } else {
            match (fe, hl) {
                (Some(a), Some(b)) => match a.render(args.clone()).await {
                    Ok(bytes) => bytes,
                    Err(a_err) => {
                        tracing::debug!(
                            "visualize: fe render failed ({a_err}); falling back to headless"
                        );
                        b.render(args).await.map_err(|b_err| {
                            ToolError::Execution(format!(
                                "both renderers failed.\nfe: {a_err}\nheadless: {b_err}"
                            ))
                        })?
                    }
                },
                (Some(a), None) => a.render(args).await?,
                (None, Some(b)) => b.render(args).await?,
                (None, None) => {
                    return Err(ToolError::Execution(
                        "no renderer wired into the agent runtime".into(),
                    ));
                }
            }
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
        Ok(ToolResult {
            summary: format!("rendered {} bytes", png.len()),
            data: json!({ "bytes": png.len() }),
            image_png_b64: Some(b64),
        })
    }
}
