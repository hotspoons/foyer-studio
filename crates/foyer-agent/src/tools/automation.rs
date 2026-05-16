// SPDX-License-Identifier: Apache-2.0
//! Automation lane inspection, editing, and display.
//!
//! The lane is addressed by `control_id` (e.g. `track.<id>.gain`,
//! `plugin.<id>.<param>`), which the agent can find via the
//! `automation.list` or `plugins.describe` calls.

use async_trait::async_trait;
use base64::Engine;
use foyer_schema::id::EntityId;
use foyer_schema::{AutomationMode, AutomationPoint};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{render_visualization, Tool, ToolContext, ToolError, ToolResult};

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
        time_samples: u64,
        value: f64,
    },
    PointUpdate {
        control_id: String,
        original_time_samples: u64,
        new_time_samples: u64,
        value: f64,
    },
    PointDelete {
        control_id: String,
        time_samples: u64,
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
    time_samples: u64,
    value: f64,
}

#[async_trait]
impl Tool for AutomationTool {
    fn name(&self) -> &'static str {
        "automation"
    }

    fn description(&self) -> &'static str {
        "Inspect, edit, and display automation lanes. Subcommands: \
         list(track_id), set_mode(control_id, mode), \
         draw(control_id, points=[{time_samples,value}], mode?) — \
         atomically replace the lane with the given 2D curve, \
         point_add(control_id, time_samples, value), \
         point_update(control_id, original_time_samples, new_time_samples, value), \
         point_delete(control_id, time_samples), \
         show_value(track_id, control_id) — numeric point list, \
         show_viz(track_id, control_id) — PNG of the lane."
    }

    fn schema(&self) -> Value {
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
                        "required": ["time_samples", "value"],
                        "properties": {
                            "time_samples": { "type": "integer", "minimum": 0 },
                            "value": { "type": "number" }
                        }
                    }
                },
                "time_samples": { "type": "integer", "minimum": 0 },
                "original_time_samples": { "type": "integer", "minimum": 0 },
                "new_time_samples": { "type": "integer", "minimum": 0 },
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
                    .map(|p| AutomationPoint {
                        time_samples: p.time_samples,
                        value: p.value,
                    })
                    .collect();
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
                value,
            } => {
                backend
                    .add_automation_point(
                        EntityId::new(control_id.clone()),
                        AutomationPoint {
                            time_samples,
                            value,
                        },
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "{control_id}[{time_samples}] = {value}"
                )))
            }
            Op::PointUpdate {
                control_id,
                original_time_samples,
                new_time_samples,
                value,
            } => {
                backend
                    .update_automation_point(
                        EntityId::new(control_id.clone()),
                        original_time_samples,
                        new_time_samples,
                        value,
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "{control_id}: {original_time_samples} → {new_time_samples} = {value}"
                )))
            }
            Op::PointDelete {
                control_id,
                time_samples,
            } => {
                backend
                    .delete_automation_point(EntityId::new(control_id.clone()), time_samples)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "deleted {control_id}[{time_samples}]"
                )))
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
