// SPDX-License-Identifier: Apache-2.0
//! UI manager — drive the attached browser's window layout.
//!
//! The user might not know where a control is, or have a layout
//! that hides the panel they need. This tool lets the agent solve
//! those situations directly: open a window, focus an existing
//! one, swap the tile tree to a preset, or query what's currently
//! mounted so the agent can describe the state in plain English.
//!
//! Architecturally the tool dispatches through a server-side
//! `UiDirector` which broadcasts `Event::UiAction` and awaits the
//! browser's `Command::UiActionResult` reply. The whole effect
//! lives FE-side; the tool is just a typed RPC + safety surface
//! the agent can reason about.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

pub struct UiTool;

/// Window kinds the FE can spawn. Kept as a free-form string on the
/// wire so a future variant doesn't need a schema bump — the FE's
/// `registerWindowKind` table is the authoritative registry, and
/// the agent learns about new kinds from a `query` action.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    /// Report the FE's current layout: tile tree, open floating
    /// windows, available window kinds the agent can spawn. Use
    /// before any open/close decision so you act on real state.
    Query,
    /// Spawn a registered window kind. Examples (from a default
    /// ui-full mount): "console", "diagnostics", "scripts",
    /// "track-editor" (props: {trackId}), "midi-editor"
    /// (props: {regionId}), "beat-sequencer" (props: {regionId}),
    /// "plugin-panel" (props: {pluginId}). Idempotent — calling
    /// twice focuses the existing window rather than stacking
    /// duplicates.
    Open {
        kind: String,
        #[serde(default)]
        props: Value,
    },
    /// Close a foyer-window by its persisted storage key. Returns
    /// an error when the key isn't currently open.
    Close { storage_key: String },
    /// Bring the named foyer-window to the front of the stack.
    Focus { storage_key: String },
    /// Replace the entire tile tree (the docked surfaces — mixer,
    /// timeline, etc.). `tree` matches the `LayoutStore.setTree`
    /// shape: a leaf `{kind, id, view, props}` OR a split
    /// `{kind: "split", direction: "row"|"col", a, b}`.
    SetTileTree { tree: Value },
}

#[async_trait]
impl Tool for UiTool {
    fn name(&self) -> &'static str {
        "ui"
    }

    fn description(&self) -> &'static str {
        "Drive the user's UI: query layout, open/close/focus floating \
         windows (console, diagnostics, scripts, track-editor, \
         midi-editor, beat-sequencer, plugin-panel, …), swap the tile \
         tree to a preset. Subcommands: query, open, close, focus, \
         set_tile_tree. \
         The `query` response now returns: `available_kinds` (string \
         ids registered in THIS variant), `kinds` (same list enriched \
         with label/description/viz_fallback), `canonical_kinds` \
         (every kind Foyer recognizes globally), and `missing_kinds` \
         (canonical kinds NOT in this variant — use the per-entry \
         `viz_fallback` to render via `visualize.<that>` instead of \
         telling the user 'I can't open the piano roll here'). Pair \
         with `visualize.screen` (FE-attached only) or the more \
         specific viz subcommands to verify changes."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": {
                    "type": "string",
                    "enum": ["query", "open", "close", "focus", "set_tile_tree"]
                },
                "kind": {
                    "type": "string",
                    "description": "Window kind (from `query` → `available_kinds`)."
                },
                "props": {
                    "type": "object",
                    "description": "Per-kind launch props (e.g. trackId, regionId, pluginId)."
                },
                "storage_key": {
                    "type": "string",
                    "description": "Storage key from `query` → `windows[*].storage_key`."
                },
                "tree": {
                    "description": "Tile-tree node passed to `LayoutStore.setTree`. Leaf shape: `{kind:'leaf', id, view, props}`. Split: `{kind:'split', direction, a, b}`."
                }
            }
        })
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op = serde_json::from_value(args.clone())
            .map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        let director = ctx.ui_director.as_ref().ok_or_else(|| {
            ToolError::Execution(
                "no FE attached — ui actions only work against a live browser tab; \
                 fall back to explaining the layout in text"
                    .into(),
            )
        })?;
        // We hand the FE the same shape we just decoded. Serializing
        // the typed `Op` preserves the agent's call exactly, including
        // the discriminator field name.
        let action_json = serde_json::to_string(&op)
            .map_err(|e| ToolError::Execution(format!("encode ui action: {e}")))?;
        let reply = director.dispatch(action_json).await?;
        match op {
            Op::Query => {
                // Reply is the FE's UI state snapshot.
                let value: Value =
                    serde_json::from_str(&reply).unwrap_or(Value::String(reply.clone()));
                let summary = describe_state(&value);
                Ok(ToolResult::ok(summary).with_data(value))
            }
            Op::Open { kind, .. } => Ok(ToolResult::ok(format!("opened {kind}"))),
            Op::Close { storage_key } => Ok(ToolResult::ok(format!("closed {storage_key}"))),
            Op::Focus { storage_key } => Ok(ToolResult::ok(format!("focused {storage_key}"))),
            Op::SetTileTree { .. } => Ok(ToolResult::ok("tile tree updated")),
        }
    }
}

/// Short, human-friendly description of the FE state for the agent's
/// transcript — keeps a `query` result readable when the LLM only
/// sees the summary line and not the full JSON blob.
fn describe_state(state: &Value) -> String {
    let win_count = state
        .get("windows")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let kinds = state
        .get("available_kinds")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let tile = state
        .get("tile_tree")
        .map(|t| {
            if t.is_null() {
                "no tile tree"
            } else {
                "tile tree present"
            }
        })
        .unwrap_or("tile tree unknown");
    format!("{win_count} open window(s), {tile}, {kinds} spawnable kind(s)")
}
