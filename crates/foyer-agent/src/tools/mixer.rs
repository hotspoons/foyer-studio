// SPDX-License-Identifier: Apache-2.0
//! Mixer control — fader / mute / solo / pan per track.
//!
//! Subcommands take a `track_id` (the `EntityId.as_str()` from a
//! session snapshot) plus an op-specific value. The tool resolves
//! the relevant control id from the snapshot under the hood — the
//! LLM doesn't have to memorize Foyer's `track.<n>.gain` naming.

use async_trait::async_trait;
use foyer_schema::ControlValue;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

pub struct MixerTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    SetGainDb { track_id: String, db: f64 },
    SetMute { track_id: String, muted: bool },
    SetSolo { track_id: String, soloed: bool },
    SetPan { track_id: String, pan: f64 },
    Get { track_id: String },
}

#[async_trait]
impl Tool for MixerTool {
    fn name(&self) -> &'static str {
        "mixer"
    }

    fn description(&self) -> &'static str {
        "Read or modify the mixer state of a single track. Subcommands: \
         set_gain_db(track_id, db), set_mute(track_id, muted), \
         set_solo(track_id, soloed), set_pan(track_id, pan in [-1, 1]), \
         get(track_id) returns a summary of current fader/mute/solo/pan."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand", "track_id"],
            "properties": {
                "subcommand": {
                    "type": "string",
                    "enum": ["set_gain_db", "set_mute", "set_solo", "set_pan", "get"]
                },
                "track_id": { "type": "string" },
                "db": { "type": "number" },
                "muted": { "type": "boolean" },
                "soloed": { "type": "boolean" },
                "pan": { "type": "number", "minimum": -1, "maximum": 1 }
            }
        })
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        // `get` is read-only; every other mixer subcommand writes a
        // control value and needs a real project loaded.
        let backend = match &op {
            Op::Get { .. } => ctx.backend()?,
            _ => ctx.backend_with_loaded_session().await?,
        };
        let snapshot = backend
            .snapshot()
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        let track_id_str = match &op {
            Op::SetGainDb { track_id, .. }
            | Op::SetMute { track_id, .. }
            | Op::SetSolo { track_id, .. }
            | Op::SetPan { track_id, .. }
            | Op::Get { track_id } => track_id,
        };
        let track = snapshot
            .tracks
            .iter()
            .find(|t| t.id.as_str() == track_id_str.as_str())
            .ok_or_else(|| ToolError::InvalidArgs(format!("unknown track_id: {track_id_str}")))?;
        match op {
            Op::SetGainDb { db, .. } => {
                let linear = 10f64.powf(db / 20.0);
                backend
                    .set_control(track.gain.id.clone(), ControlValue::Float(linear))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "track {} gain → {db:+.2} dB",
                    track.name
                )))
            }
            Op::SetMute { muted, .. } => {
                backend
                    .set_control(track.mute.id.clone(), ControlValue::Bool(muted))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("track {} mute={muted}", track.name)))
            }
            Op::SetSolo { soloed, .. } => {
                backend
                    .set_control(track.solo.id.clone(), ControlValue::Bool(soloed))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "track {} solo={soloed}",
                    track.name
                )))
            }
            Op::SetPan { pan, .. } => {
                backend
                    .set_control(track.pan.id.clone(), ControlValue::Float(pan))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "track {} pan → {pan:+.2}",
                    track.name
                )))
            }
            Op::Get { .. } => {
                let gain_linear = track.gain.value.as_f64().unwrap_or(1.0);
                // Match the dB conversion `set_gain_db` uses going the
                // other direction. `linear = 0` would produce `-inf`;
                // floor it at -120 dB which is well below anything
                // anyone would expect to see in a useful mix.
                let gain_db = if gain_linear > 1.0e-6 {
                    20.0 * gain_linear.log10()
                } else {
                    -120.0
                };
                let muted = matches!(track.mute.value, ControlValue::Bool(true));
                let soloed = matches!(track.solo.value, ControlValue::Bool(true));
                let pan = track.pan.value.as_f64().unwrap_or(0.0);
                let summary = format!(
                    "{}  {:+.2} dB{}{}  pan {:+.2}",
                    track.name,
                    gain_db,
                    if muted { "  MUTED" } else { "" },
                    if soloed { "  SOLO" } else { "" },
                    pan,
                );
                Ok(ToolResult::ok(summary).with_data(json!({
                    "id": track.id.as_str(),
                    "name": track.name,
                    "kind": format!("{:?}", track.kind).to_lowercase(),
                    "gain_db": gain_db,
                    "gain_linear": gain_linear,
                    "muted": muted,
                    "soloed": soloed,
                    "pan": pan,
                    "control_ids": {
                        "gain": track.gain.id.as_str(),
                        "mute": track.mute.id.as_str(),
                        "solo": track.solo.id.as_str(),
                        "pan": track.pan.id.as_str(),
                    }
                })))
            }
        }
    }
}
