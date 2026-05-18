// SPDX-License-Identifier: Apache-2.0
//! Automation lane inspection, editing, and display.
//!
//! The lane is addressed by `control_id` (e.g. `track.<id>.gain`,
//! `plugin.<id>.<param>`), which the agent can find via the
//! `automation.list` or `plugins.describe` calls.

use async_trait::async_trait;
use base64::Engine;
use foyer_schema::id::EntityId;
use foyer_schema::{AutomationMode, AutomationPoint, TimeArg};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{
    render_visualization, tempo_map_from_snapshot, Tool, ToolContext, ToolError, ToolResult,
};

pub struct AutomationTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    List {
        track_id: String,
    },
    /// Switch a lane to a new playback mode (off/manual/play/write/touch/latch).
    SetMode {
        control_id: String,
        mode: String,
    },
    /// Atomically replace the entire lane with `points`. Use this to
    /// "draw" a curve in one call — the agent supplies (time_samples,
    /// value) tuples ordered by time. The value is in the parameter's
    /// natural scale; for `discrete` / `enum` controls it's clamped to
    /// the integer step set by the parameter's `range`.
    Draw {
        control_id: String,
        points: Vec<DrawPoint>,
        #[serde(default)]
        mode: Option<String>,
    },
    PointAdd {
        control_id: String,
        #[serde(default)]
        time_samples: Option<u64>,
        #[serde(default)]
        time: Option<TimeArg>,
        value: f64,
    },
    PointUpdate {
        control_id: String,
        #[serde(default)]
        original_time_samples: Option<u64>,
        #[serde(default)]
        original_time: Option<TimeArg>,
        #[serde(default)]
        new_time_samples: Option<u64>,
        #[serde(default)]
        new_time: Option<TimeArg>,
        value: f64,
    },
    PointDelete {
        control_id: String,
        #[serde(default)]
        time_samples: Option<u64>,
        #[serde(default)]
        time: Option<TimeArg>,
    },
    /// Return the raw numeric points for one lane — what the LLM
    /// needs to reason about a curve before editing it.
    ShowValue {
        track_id: String,
        control_id: String,
    },
    /// Render the lane as a PNG. Returns the image inline (same
    /// channel as `visualize.automation_lane`) so the agent can
    /// look at the curve without leaving its tool surface.
    ShowViz {
        track_id: String,
        control_id: String,
    },
}

#[derive(Debug, Deserialize)]
struct DrawPoint {
    #[serde(default)]
    time_samples: Option<u64>,
    #[serde(default)]
    time: Option<TimeArg>,
    value: f64,
}

#[async_trait]
impl Tool for AutomationTool {
    fn name(&self) -> &'static str {
        "automation"
    }

    fn description(&self) -> &'static str {
        "Inspect, edit, and display automation lanes. Every time field \
         accepts EITHER `_samples` (legacy) OR a polymorphic `time` \
         (samples|seconds|bbt). Subcommands: \
         list(track_id), set_mode(control_id, mode), \
         draw(control_id, points=[{time|time_samples,value}], mode?), \
         point_add(control_id, time|time_samples, value), \
         point_update(control_id, original_time|original_time_samples, \
                       new_time|new_time_samples, value), \
         point_delete(control_id, time|time_samples), \
         show_value(track_id, control_id) — numeric point list, \
         show_viz(track_id, control_id) — PNG of the lane."
    }

    fn schema(&self) -> Value {
        let time_schema = json!({
            "type": "object",
            "description": "Polymorphic time — exactly one of samples / seconds / bbt.",
            "properties": {
                "samples": { "type": "integer", "minimum": 0 },
                "seconds": { "type": "number", "minimum": 0 },
                "bbt": {
                    "type": "object",
                    "required": ["bar", "beat", "tick"],
                    "properties": {
                        "bar": { "type": "integer", "minimum": 1 },
                        "beat": { "type": "integer", "minimum": 1 },
                        "tick": { "type": "integer", "minimum": 0 }
                    }
                }
            },
            "additionalProperties": false
        });
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": { "type": "string", "enum": [
                    "list", "set_mode", "draw", "point_add", "point_update",
                    "point_delete", "show_value", "show_viz"
                ]},
                "track_id": { "type": "string" },
                "control_id": { "type": "string" },
                "mode": { "type": "string", "enum": [
                    "off", "manual", "play", "write", "touch", "latch"
                ]},
                "points": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["value"],
                        "properties": {
                            "time_samples": { "type": "integer", "minimum": 0 },
                            "time": time_schema,
                            "value": { "type": "number" }
                        }
                    }
                },
                "time_samples": { "type": "integer", "minimum": 0 },
                "time": time_schema,
                "original_time_samples": { "type": "integer", "minimum": 0 },
                "original_time": time_schema,
                "new_time_samples": { "type": "integer", "minimum": 0 },
                "new_time": time_schema,
                "value": { "type": "number" }
            }
        })
    }

    fn destructive(&self) -> bool {
        true
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        // Read-only paths (list, show_value, show_viz) tolerate an
        // unloaded session — they just return empty. Mutators need a
        // loaded project; gate them.
        let backend = match &op {
            Op::List { .. } | Op::ShowValue { .. } | Op::ShowViz { .. } => ctx.backend()?,
            _ => ctx.backend_with_loaded_session().await?,
        };
        let need_map = op_needs_tempo_map(&op);
        let tempo_map = if need_map {
            let snap = backend
                .snapshot()
                .await
                .map_err(|e| ToolError::Execution(e.to_string()))?;
            Some(tempo_map_from_snapshot(&snap))
        } else {
            None
        };
        let resolve =
            |time: Option<TimeArg>, legacy: Option<u64>, field: &str| -> Result<u64, ToolError> {
                match (time, legacy) {
                    (Some(t), _) => {
                        let map = tempo_map.ok_or_else(|| {
                            ToolError::Execution(format!("{field}: tempo map missing (BUG)"))
                        })?;
                        t.to_samples(&map)
                            .map_err(|e| ToolError::InvalidArgs(format!("{field}: {e}")))
                    }
                    (None, Some(s)) => Ok(s),
                    (None, None) => Err(ToolError::InvalidArgs(format!(
                    "{field}: provide `{field}` (samples/seconds/bbt) or legacy `{field}_samples`"
                ))),
                }
            };
        match op {
            Op::List { track_id } => {
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let t = snap
                    .tracks
                    .iter()
                    .find(|t| t.id.as_str() == track_id)
                    .ok_or_else(|| ToolError::InvalidArgs(format!("unknown track: {track_id}")))?;
                let lanes: Vec<Value> = t
                    .automation_lanes
                    .iter()
                    .map(|l| {
                        json!({
                            "control_id": l.control_id.as_str(),
                            "mode": format!("{:?}", l.mode),
                            "points": l.points.len(),
                        })
                    })
                    .collect();
                Ok(
                    ToolResult::ok(format!("{} lanes on track {}", lanes.len(), t.name))
                        .with_data(json!({ "lanes": lanes })),
                )
            }
            Op::SetMode { control_id, mode } => {
                let m = parse_mode(&mode)?;
                backend
                    .set_automation_mode(EntityId::new(control_id.clone()), m)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("{control_id} mode → {mode}")))
            }
            Op::Draw {
                control_id,
                points,
                mode,
            } => {
                let ps: Vec<AutomationPoint> = points
                    .into_iter()
                    .map(|p| {
                        let ts = resolve(p.time, p.time_samples, "time")?;
                        Ok(AutomationPoint {
                            time_samples: ts,
                            value: p.value,
                        })
                    })
                    .collect::<Result<Vec<_>, ToolError>>()?;
                let count = ps.len();
                backend
                    .replace_automation_lane(EntityId::new(control_id.clone()), ps)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                if let Some(mode) = mode {
                    let m = parse_mode(&mode)?;
                    backend
                        .set_automation_mode(EntityId::new(control_id.clone()), m)
                        .await
                        .map_err(|e| ToolError::Execution(e.to_string()))?;
                }
                Ok(ToolResult::ok(format!(
                    "drew {count} points on {control_id}"
                )))
            }
            Op::PointAdd {
                control_id,
                time_samples,
                time,
                value,
            } => {
                let ts = resolve(time, time_samples, "time")?;
                backend
                    .add_automation_point(
                        EntityId::new(control_id.clone()),
                        AutomationPoint {
                            time_samples: ts,
                            value,
                        },
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("{control_id}[{ts}] = {value}")))
            }
            Op::PointUpdate {
                control_id,
                original_time_samples,
                original_time,
                new_time_samples,
                new_time,
                value,
            } => {
                let original = resolve(original_time, original_time_samples, "original_time")?;
                let new = resolve(new_time, new_time_samples, "new_time")?;
                backend
                    .update_automation_point(
                        EntityId::new(control_id.clone()),
                        original,
                        new,
                        value,
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "{control_id}: {original} → {new} = {value}"
                )))
            }
            Op::PointDelete {
                control_id,
                time_samples,
                time,
            } => {
                let ts = resolve(time, time_samples, "time")?;
                backend
                    .delete_automation_point(EntityId::new(control_id.clone()), ts)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("deleted {control_id}[{ts}]")))
            }
            Op::ShowValue {
                track_id,
                control_id,
            } => {
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let t = snap
                    .tracks
                    .iter()
                    .find(|t| t.id.as_str() == track_id)
                    .ok_or_else(|| ToolError::InvalidArgs(format!("unknown track: {track_id}")))?;
                let lane = t
                    .automation_lanes
                    .iter()
                    .find(|l| l.control_id.as_str() == control_id)
                    .ok_or_else(|| {
                        ToolError::InvalidArgs(format!("no lane {control_id} on track {track_id}"))
                    })?;
                let points: Vec<Value> = lane
                    .points
                    .iter()
                    .map(|p| json!({"time_samples": p.time_samples, "value": p.value}))
                    .collect();
                let extent = lane
                    .points
                    .iter()
                    .fold((f64::INFINITY, f64::NEG_INFINITY), |(min, max), p| {
                        (min.min(p.value), max.max(p.value))
                    });
                Ok(ToolResult::ok(format!(
                    "{} pts; range [{:.4} .. {:.4}]",
                    points.len(),
                    if extent.0.is_finite() { extent.0 } else { 0.0 },
                    if extent.1.is_finite() { extent.1 } else { 0.0 }
                ))
                .with_data(json!({
                    "control_id": control_id,
                    "mode": format!("{:?}", lane.mode),
                    "points": points,
                })))
            }
            Op::ShowViz {
                track_id,
                control_id,
            } => {
                let req = json!({
                    "subcommand": "automation_lane",
                    "track_id": track_id,
                    "control_id": control_id,
                });
                let png = render_visualization(ctx, req).await?;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
                Ok(ToolResult {
                    summary: format!("rendered lane ({} bytes)", png.len()),
                    data: json!({
                        "track_id": track_id,
                        "control_id": control_id,
                        "bytes": png.len(),
                    }),
                    image_png_b64: Some(b64),
                })
            }
        }
    }
}

fn op_needs_tempo_map(op: &Op) -> bool {
    match op {
        Op::PointAdd { time, .. } | Op::PointDelete { time, .. } => time.is_some(),
        Op::PointUpdate {
            original_time,
            new_time,
            ..
        } => original_time.is_some() || new_time.is_some(),
        Op::Draw { points, .. } => points.iter().any(|p| p.time.is_some()),
        _ => false,
    }
}

fn parse_mode(s: &str) -> Result<AutomationMode, ToolError> {
    match s {
        "off" => Ok(AutomationMode::Off),
        "manual" => Ok(AutomationMode::Manual),
        "play" => Ok(AutomationMode::Play),
        "write" => Ok(AutomationMode::Write),
        "touch" => Ok(AutomationMode::Touch),
        "latch" => Ok(AutomationMode::Latch),
        other => Err(ToolError::InvalidArgs(format!(
            "unknown automation mode: {other}"
        ))),
    }
}
