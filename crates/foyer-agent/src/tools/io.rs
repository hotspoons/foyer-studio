// SPDX-License-Identifier: Apache-2.0
//! Engine-level audio/MIDI port enumeration.
//!
//! Exposes the backend's view of physical hardware (mic inputs, line
//! outs, MIDI controllers) and virtual graph endpoints (foyer ingress
//! streams, other apps' ports) so the agent can answer "what can I
//! connect this track's input to?" Returns the same `EnginePort`
//! shape the WS layer ships, so the model sees JACK-style names
//! like `system:capture_1` or `foyer:ingress-stub` that it can pass
//! verbatim back to `tracks.update(input_port=…)`.
//!
//! The stub backend synthesizes a tiny fake graph (2× physical
//! capture, 2× playback, 1× MIDI device, 1× foyer ingress) so the
//! agent can walk the full record-arm workflow inside the
//! devcontainer; the Ardour shim returns the live JACK graph.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

pub struct IoTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    /// Enumerate engine ports the shim can see. `direction`:
    /// `"source"` = readable (mic / instrument inputs — what a track's
    /// input connects to); `"sink"` = writable (speakers / other apps —
    /// what a track's output connects to); omit for both. `filter`:
    /// `"physical"` keeps only hardware ports; omit for everything.
    ListPorts {
        #[serde(default)]
        direction: Option<String>,
        #[serde(default)]
        filter: Option<String>,
    },
}

#[async_trait]
impl Tool for IoTool {
    fn name(&self) -> &'static str {
        "io"
    }

    fn description(&self) -> &'static str {
        "Audio / MIDI engine I/O. Subcommands: \
         list_ports(direction?, filter?) — enumerate engine-level ports \
         (mic inputs, line outs, MIDI controllers, foyer ingress \
         endpoints). direction='source' for readable inputs you'd \
         route a track INPUT to, 'sink' for outputs you'd route a track \
         OUTPUT to, omit for both. filter='physical' restricts to \
         hardware (drops virtual / app-to-app ports). \
         Use this BEFORE `tracks.update(input_port=…)` so the port \
         names you pass actually exist; otherwise the routing silently \
         no-ops on the shim."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": { "type": "string", "enum": ["list_ports"] },
                "direction": { "type": "string",
                    "enum": ["source", "sink"],
                    "description": "Omit for both directions." },
                "filter": { "type": "string",
                    "enum": ["physical", "all"],
                    "description": "physical = hardware ports only; default = all." }
            }
        })
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        let backend = ctx.backend()?;
        match op {
            Op::ListPorts { direction, filter } => {
                let ports = backend
                    .list_ports(direction.clone())
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let physical_only = matches!(filter.as_deref(), Some("physical"));
                let mut rows = Vec::with_capacity(ports.len());
                for p in &ports {
                    if physical_only && !p.is_physical {
                        continue;
                    }
                    rows.push(json!({
                        "name": p.name,
                        "direction": p.direction,
                        "is_physical": p.is_physical,
                        "is_midi": p.is_midi,
                    }));
                }
                let summary = match direction.as_deref() {
                    Some("source") => format!("{} source ports", rows.len()),
                    Some("sink") => format!("{} sink ports", rows.len()),
                    _ => format!("{} ports", rows.len()),
                };
                Ok(ToolResult::ok(summary).with_data(json!({ "ports": rows })))
            }
        }
    }
}
