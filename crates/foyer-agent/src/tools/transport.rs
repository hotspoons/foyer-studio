// SPDX-License-Identifier: Apache-2.0
//! Transport control — play, stop, record, locate, loop.

use async_trait::async_trait;
use foyer_schema::{ControlValue, EntityId};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

pub struct TransportTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    Play,
    Stop,
    Record {
        armed: bool,
    },
    Locate {
        samples: u64,
    },
    Loop {
        enabled: bool,
    },
    Get,
    /// Block the agent's turn for `seconds`, then return. Use this
    /// when an action needs to land before the next one (e.g. "start
    /// recording, wait 2 minutes, then stop") so the model doesn't
    /// fire-and-forget. Capped at 600 s so a hallucinated value can't
    /// strand a session. The model can split a longer wait into
    /// multiple `wait` calls, surveying state between them.
    Wait {
        seconds: u32,
    },
}

/// Upper bound for a single `transport.wait` invocation, in seconds.
/// Picked at 10 minutes — long enough for "wait through a take" but
/// short enough that a wrong value doesn't strand the session.
const MAX_WAIT_SECONDS: u32 = 600;

#[async_trait]
impl Tool for TransportTool {
    fn name(&self) -> &'static str {
        "transport"
    }

    fn description(&self) -> &'static str {
        "Drive the engine's transport. Subcommands: play, stop, \
         record(armed: bool), locate(samples: u64), loop(enabled: bool), \
         get (returns current position + state), wait(seconds: u32) — \
         block the current turn for a bounded delay (max 600 s) so a \
         multi-step plan like \"start recording, wait 2 minutes, stop\" \
         can sequence correctly. Always `get` after a wait to confirm \
         the transport is still in the state you expect."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": {
                    "type": "string",
                    "enum": ["play", "stop", "record", "locate", "loop", "get", "wait"]
                },
                "armed": { "type": "boolean" },
                "samples": { "type": "integer", "minimum": 0 },
                "enabled": { "type": "boolean" },
                "seconds": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_WAIT_SECONDS as i64,
                    "description": "Bounded delay in seconds for the `wait` subcommand."
                }
            }
        })
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        let backend = ctx.backend()?;
        match op {
            Op::Play => {
                backend
                    .set_control(EntityId::new("transport.playing"), ControlValue::Bool(true))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok("transport playing"))
            }
            Op::Stop => {
                backend
                    .set_control(
                        EntityId::new("transport.playing"),
                        ControlValue::Bool(false),
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok("transport stopped"))
            }
            Op::Record { armed } => {
                backend
                    .set_control(
                        EntityId::new("transport.recording"),
                        ControlValue::Bool(armed),
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(if armed {
                    "record armed"
                } else {
                    "record disarmed"
                }))
            }
            Op::Locate { samples } => {
                backend
                    .set_control(
                        EntityId::new("transport.position"),
                        ControlValue::Int(samples as i64),
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("transport located to {samples}")))
            }
            Op::Loop { enabled } => {
                backend
                    .set_control(
                        EntityId::new("transport.looping"),
                        ControlValue::Bool(enabled),
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(if enabled { "loop on" } else { "loop off" }))
            }
            Op::Get => {
                // Pull the full transport state from the snapshot so
                // the agent gets playing / recording / looping /
                // tempo / time signature alongside position — `get`
                // is the read-state primitive, returning only
                // position+sample_rate was effectively useless.
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let t = &snap.transport;
                let playing = matches!(t.playing.value, ControlValue::Bool(true));
                let recording = matches!(t.recording.value, ControlValue::Bool(true));
                let looping = matches!(t.looping.value, ControlValue::Bool(true));
                let tempo_bpm = t.tempo.value.as_f64();
                let ts_num = t.time_signature_num.value.as_f64().map(|v| v as i64);
                let ts_den = t.time_signature_den.value.as_f64().map(|v| v as i64);
                let pos_samples = backend.transport_position_samples();
                let sr = backend.sample_rate();
                let pos_seconds = if sr > 0 {
                    pos_samples as f64 / sr as f64
                } else {
                    0.0
                };
                let pos_beats = t.position_beats.value.as_f64().unwrap_or(0.0);
                let summary = format!(
                    "{} {} {} · {:.3}s ({} samples @ {} Hz) · {:.2} bpm{}",
                    if playing {
                        "▶ playing"
                    } else {
                        "⏹ stopped"
                    },
                    if recording { "● recording" } else { "" },
                    if looping { "↻ loop" } else { "" },
                    pos_seconds,
                    pos_samples,
                    sr,
                    tempo_bpm.unwrap_or(0.0),
                    match (ts_num, ts_den) {
                        (Some(n), Some(d)) => format!(" · {n}/{d}"),
                        _ => String::new(),
                    },
                );
                Ok(ToolResult::ok(summary).with_data(json!({
                    "playing": playing,
                    "recording": recording,
                    "looping": looping,
                    "position_samples": pos_samples,
                    "position_seconds": pos_seconds,
                    "position_beats": pos_beats,
                    "sample_rate": sr,
                    "tempo_bpm": tempo_bpm,
                    "time_signature": match (ts_num, ts_den) {
                        (Some(n), Some(d)) => json!([n, d]),
                        _ => Value::Null,
                    },
                })))
            }
            Op::Wait { seconds } => {
                if seconds == 0 {
                    return Err(ToolError::InvalidArgs("wait: seconds must be >= 1".into()));
                }
                if seconds > MAX_WAIT_SECONDS {
                    return Err(ToolError::InvalidArgs(format!(
                        "wait: seconds capped at {MAX_WAIT_SECONDS} (asked {seconds})"
                    )));
                }
                // Use tokio's timer so the engine's turn-level
                // cancellation token can interrupt us if the user
                // hits Stop mid-wait. Drops the future cleanly.
                tokio::time::sleep(std::time::Duration::from_secs(seconds as u64)).await;
                Ok(ToolResult::ok(format!("waited {seconds}s")))
            }
        }
    }
}
