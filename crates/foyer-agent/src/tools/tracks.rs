// SPDX-License-Identifier: Apache-2.0
//! Track inventory + light edits (rename, color, monitoring).

use async_trait::async_trait;
use foyer_schema::ControlValue;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

pub struct TracksTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    List,
    Describe { track_id: String },
}

#[async_trait]
impl Tool for TracksTool {
    fn name(&self) -> &'static str {
        "tracks"
    }

    fn description(&self) -> &'static str {
        "List or describe tracks in the current session. Subcommands: \
         list (returns id/name/kind for every track), \
         describe(track_id) (returns full track record + plugin chain)."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": { "type": "string", "enum": ["list", "describe"] },
                "track_id": { "type": "string" }
            }
        })
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        let backend = ctx.backend()?;
        let snap = backend
            .snapshot()
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        match op {
            Op::List => {
                // Include muted/soloed/gain_db so the agent can honour
                // the "respect solo state" rule from the system prompt
                // without round-tripping through mixer.get per track.
                let any_soloed = snap
                    .tracks
                    .iter()
                    .any(|t| matches!(t.solo.value, ControlValue::Bool(true)));
                let summary: Vec<Value> = snap
                    .tracks
                    .iter()
                    .map(|t| {
                        let linear = t.gain.value.as_f64().unwrap_or(1.0);
                        let gain_db = if linear > 1.0e-6 {
                            20.0 * linear.log10()
                        } else {
                            -120.0
                        };
                        let muted = matches!(t.mute.value, ControlValue::Bool(true));
                        let soloed = matches!(t.solo.value, ControlValue::Bool(true));
                        json!({
                            "id": t.id.as_str(),
                            "name": t.name,
                            "kind": format!("{:?}", t.kind),
                            "plugin_count": t.plugins.len(),
                            "group_id": t.group_id.as_ref().map(|g| g.as_str().to_string()),
                            "muted": muted,
                            "soloed": soloed,
                            "gain_db": (gain_db * 100.0).round() / 100.0,
                        })
                    })
                    .collect();
                Ok(ToolResult::ok(format!(
                    "{} tracks{}",
                    summary.len(),
                    if any_soloed { " (solo active)" } else { "" }
                ))
                .with_data(json!({ "tracks": summary, "any_soloed": any_soloed })))
            }
            Op::Describe { track_id } => {
                let t = snap
                    .tracks
                    .iter()
                    .find(|t| t.id.as_str() == track_id)
                    .ok_or_else(|| ToolError::InvalidArgs(format!("unknown track: {track_id}")))?;
                let data =
                    serde_json::to_value(t).map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("track {}", t.name)).with_data(data))
            }
        }
    }
}
