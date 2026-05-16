// SPDX-License-Identifier: Apache-2.0
//! Session-level inspection. Cheap reads — the snapshot already
//! carries everything; this tool just sparsifies it for the model.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

pub struct SessionTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    Summary,
    Full,
}

#[async_trait]
impl Tool for SessionTool {
    fn name(&self) -> &'static str {
        "session"
    }

    fn description(&self) -> &'static str {
        "Inspect the live session. Subcommands: \
         summary (track / region / plugin counts + transport state), \
         full (entire session snapshot — large; use sparingly)."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": { "type": "string", "enum": ["summary", "full"] }
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
            Op::Summary => {
                let track_count = snap.tracks.len();
                let plugin_count: usize = snap.tracks.iter().map(|t| t.plugins.len()).sum();
                let sr = backend.sample_rate();
                let pos = backend.transport_position_samples();
                Ok(ToolResult::ok(format!(
                    "{track_count} tracks · {plugin_count} plugins · pos={pos} sr={sr}"
                ))
                .with_data(json!({
                    "track_count": track_count,
                    "plugin_count": plugin_count,
                    "sample_rate": sr,
                    "position_samples": pos,
                })))
            }
            Op::Full => {
                let data =
                    serde_json::to_value(&snap).map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok("full snapshot").with_data(data))
            }
        }
    }
}
