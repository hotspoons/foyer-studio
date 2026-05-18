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
    /// Set the session tempo in BPM. Clamped to 20–300; the Ardour
    /// shim re-clamps independently so out-of-range values land at
    /// the boundary instead of bouncing. Single-point change at the
    /// current playhead — for a full tempo-map authoring pass, use
    /// `automation` on `transport.tempo` instead.
    SetTempo {
        bpm: f64,
    },
    /// Set the time signature. `numerator` is beats-per-bar (1–32),
    /// `denominator` is the note-value (1, 2, 4, 8, 16, 32). Same
    /// "single-point at the playhead" semantics as set_tempo.
    SetTimeSignature {
        numerator: u32,
        denominator: u32,
    },
    /// Toggle the metronome / click track and optionally set its gain.
    /// `enabled`: turn the click on (true) or off (false). `gain_db`
    /// (optional): click level in dB, clamped to [-60, +6]; leave
    /// unset to keep the current gain. Both controls round-trip
    /// through the same path the UI's metronome chip uses.
    SetMetronome {
        enabled: bool,
        #[serde(default)]
        gain_db: Option<f64>,
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
         get (returns current position + state including tempo/time \
         signature), wait(seconds: u32) — block the current turn for a \
         bounded delay (max 600 s) so a multi-step plan like \
         \"start recording, wait 2 minutes, stop\" can sequence correctly \
         (always `get` after a wait to confirm state), \
         set_tempo(bpm) — set session tempo (clamped 20–300 BPM), \
         set_time_signature(numerator, denominator) — set the meter \
         (numerator 1–32; denominator one of 1/2/4/8/16/32), \
         set_metronome(enabled, gain_db?) — click on/off and gain in \
         dB (clamped -60…+6, leave unset to keep current gain). The \
         metronome is on the engine's master out, so users hear it \
         through their main speakers / headphones."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": {
                    "type": "string",
                    "enum": ["play", "stop", "record", "locate", "loop", "get",
                            "wait", "set_tempo", "set_time_signature",
                            "set_metronome"]
                },
                "armed": { "type": "boolean" },
                "samples": { "type": "integer", "minimum": 0 },
                "enabled": { "type": "boolean" },
                "seconds": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_WAIT_SECONDS as i64,
                    "description": "Bounded delay in seconds for the `wait` subcommand."
                },
                "bpm": {
                    "type": "number",
                    "minimum": 20,
                    "maximum": 300,
                    "description": "set_tempo: target BPM."
                },
                "numerator": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 32,
                    "description": "set_time_signature: beats per bar."
                },
                "denominator": {
                    "type": "integer",
                    "enum": [1, 2, 4, 8, 16, 32],
                    "description": "set_time_signature: note value (must be a power of 2)."
                },
                "enabled": { "type": "boolean" },
                "gain_db": {
                    "type": "number",
                    "minimum": -60,
                    "maximum": 6,
                    "description": "set_metronome: click gain in dB."
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
            Op::SetTempo { bpm } => {
                // Clamp at the agent boundary to match the shim's own
                // 20–300 BPM clamp and give the model a clear error
                // instead of a silent server-side cap.
                if !bpm.is_finite() {
                    return Err(ToolError::InvalidArgs(format!(
                        "set_tempo: bpm must be finite, got {bpm}"
                    )));
                }
                let clamped = bpm.clamp(20.0, 300.0);
                backend
                    .set_control(
                        EntityId::new("transport.tempo"),
                        ControlValue::Float(clamped),
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let note = if (clamped - bpm).abs() > f64::EPSILON {
                    format!(" (clamped from {bpm})")
                } else {
                    String::new()
                };
                Ok(
                    ToolResult::ok(format!("tempo set to {clamped:.2} BPM{note}"))
                        .with_data(json!({ "bpm": clamped })),
                )
            }
            Op::SetTimeSignature {
                numerator,
                denominator,
            } => {
                if !(1..=32).contains(&numerator) {
                    return Err(ToolError::InvalidArgs(format!(
                        "set_time_signature: numerator must be 1–32, got {numerator}"
                    )));
                }
                // Powers of two only — meter denominators are note
                // values (1, 2, 4, 8, 16, 32). Mirrors what the schema
                // enum allows + what every DAW UI actually offers.
                if !matches!(denominator, 1 | 2 | 4 | 8 | 16 | 32) {
                    return Err(ToolError::InvalidArgs(format!(
                        "set_time_signature: denominator must be one of 1/2/4/8/16/32, \
                         got {denominator}"
                    )));
                }
                // Two ControlSet round-trips. The shim handler (when
                // Ardour grows one) reads both, builds a `Meter`, and
                // installs at the playhead via TempoMap::change_meter.
                // Stub backends already store both Parameters so the
                // state round-trips in those.
                backend
                    .set_control(
                        EntityId::new("transport.ts.num"),
                        ControlValue::Int(numerator as i64),
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                backend
                    .set_control(
                        EntityId::new("transport.ts.den"),
                        ControlValue::Int(denominator as i64),
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(
                    ToolResult::ok(format!("time signature set to {numerator}/{denominator}"))
                        .with_data(json!({
                            "numerator": numerator,
                            "denominator": denominator,
                        })),
                )
            }
            Op::SetMetronome { enabled, gain_db } => {
                // Toggle the click; the shim handles `transport.metronome`
                // by flipping `RCConfiguration::clicking`.
                backend
                    .set_control(
                        EntityId::new("transport.metronome"),
                        ControlValue::Bool(enabled),
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let mut gain_summary = String::new();
                if let Some(db) = gain_db {
                    if !db.is_finite() {
                        return Err(ToolError::InvalidArgs(format!(
                            "set_metronome: gain_db must be finite, got {db}"
                        )));
                    }
                    let clamped = db.clamp(-60.0, 6.0);
                    // Shim writes `metronome.gain` straight into
                    // `RCConfiguration::click_gain` (dB → coefficient
                    // happens shim-side).
                    backend
                        .set_control(
                            EntityId::new("metronome.gain"),
                            ControlValue::Float(clamped),
                        )
                        .await
                        .map_err(|e| ToolError::Execution(e.to_string()))?;
                    gain_summary = format!(" @ {clamped:.1} dB");
                }
                Ok(ToolResult::ok(format!(
                    "metronome {}{}",
                    if enabled { "on" } else { "off" },
                    gain_summary
                ))
                .with_data(json!({
                    "enabled": enabled,
                    "gain_db": gain_db,
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
