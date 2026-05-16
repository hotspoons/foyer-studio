// SPDX-License-Identifier: Apache-2.0
//! Beat-sequencer authoring — Hydrogen / Fruity-Loops style.
//!
//! The sequencer is a first-class Foyer concept: every MIDI region
//! optionally carries a `SequencerLayout` of named patterns (cell
//! grids) plus an arrangement that slots patterns into bars. The
//! shim regenerates the region's notes from the layout on every
//! `set_layout`, so the agent never has to compute tick offsets for
//! a kick-on-1-and-3 pattern — it just toggles cells.
//!
//! Tool surface:
//!   * `show` — read the current layout (rows, patterns w/ cells,
//!     arrangement, expanded note count).
//!   * `set_layout` — atomic full replace. Typed shape; the
//!     agent should prefer the more targeted ops below.
//!   * `set_cells(pattern_id, cells)` — overwrite one pattern's
//!     cells without touching rows / arrangement.
//!   * `add_pattern(name, cells?)` — append a pattern. Returns the
//!     assigned id so the agent can slot it.
//!   * `arrange(slots)` — replace the arrangement (which pattern
//!     plays at which bar).
//!   * `clear` — wipe the layout entirely; region falls back to
//!     plain editable MIDI.
//!   * `show_viz` — render the host's beat-sequencer view to PNG.
//!
//! Anywhere the agent supplies cells / patterns / rows, the typed
//! schema mirrors `foyer_schema::midi::SequencerLayout`.

use async_trait::async_trait;
use base64::Engine;
use foyer_schema::id::EntityId;
use foyer_schema::midi::{
    ArrangementSlot, SequencerCell, SequencerLayout, SequencerPattern, SequencerRow,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{render_visualization, Tool, ToolContext, ToolError, ToolResult};

pub struct SequencerTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    /// Read the current layout (and the expanded notes the shim
    /// produced from it). Returns an empty layout if the region has
    /// none.
    Show { region_id: String },
    /// Replace the entire layout. Use for first-time setup or full
    /// rewrites — for tweaks, prefer the targeted ops below so the
    /// agent doesn't have to re-spec rows + arrangement every time.
    SetLayout {
        region_id: String,
        layout: SequencerLayout,
    },
    /// Overwrite one pattern's cells in-place. Rows + arrangement
    /// are left untouched. If `pattern_id` doesn't exist on the
    /// region, returns InvalidArgs.
    SetCells {
        region_id: String,
        pattern_id: String,
        cells: Vec<SequencerCell>,
    },
    /// Append a new pattern. `id` is optional — when omitted the
    /// tool assigns the next free `pNN` slug. Returns the id used
    /// so the agent can slot it via `arrange`.
    AddPattern {
        region_id: String,
        name: String,
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        cells: Vec<SequencerCell>,
        #[serde(default)]
        color: Option<String>,
    },
    /// Replace the arrangement (the per-bar pattern playlist).
    /// Slots reference patterns by `pattern_id`.
    Arrange {
        region_id: String,
        slots: Vec<ArrangementSlot>,
    },
    /// Drop the layout entirely. The region keeps any expanded
    /// notes but the piano-roll flips back to fully editable.
    Clear { region_id: String },
    /// Render the host's beat-sequencer view for the region (the
    /// Fruity-Loops-style grid). Returns inline PNG.
    ShowViz { track_id: String, region_id: String },
}

#[async_trait]
impl Tool for SequencerTool {
    fn name(&self) -> &'static str {
        "sequencer"
    }

    fn description(&self) -> &'static str {
        "Beat-sequencer authoring (Hydrogen / Fruity-Loops style). A \
         layout has `rows` (one per drum / pitch), `patterns` (named \
         cell grids), and an `arrangement` (which pattern plays at \
         which bar). The shim regenerates the region's MIDI notes from \
         the layout every set, so cells are the right level of \
         abstraction for drum / boring repetitive parts. Subcommands: \
         show(region_id), set_layout(region_id, layout), \
         set_cells(region_id, pattern_id, cells=[{row,step,velocity,length_steps?}]), \
         add_pattern(region_id, name, cells?, id?, color?), \
         arrange(region_id, slots=[{pattern_id,bar,arrangement_row?}]), \
         clear(region_id), show_viz(track_id, region_id)."
    }

    fn schema(&self) -> Value {
        // Reusable shapes — pulled out of the per-subcommand schemas
        // so the agent can see them as named definitions in the tool
        // surface. Defined inline because the MCP layer wants one
        // self-contained JSON Schema per tool.
        let cell = json!({
            "type": "object",
            "required": ["row", "step"],
            "properties": {
                "row": { "type": "integer", "minimum": 0,
                    "description": "0-based index into the layout's rows array" },
                "step": { "type": "integer", "minimum": 0,
                    "description": "0-based step within a pattern; valid range is [0, pattern_steps)" },
                "velocity": { "type": "integer", "minimum": 0, "maximum": 127, "default": 100 },
                "length_steps": { "type": "integer", "minimum": 0, "default": 1,
                    "description": "How many consecutive steps the cell spans. Drum mode usually 1; pitched mode uses >1 for long notes." }
            }
        });
        let row = json!({
            "type": "object",
            "required": ["pitch", "label"],
            "properties": {
                "pitch": { "type": "integer", "minimum": 0, "maximum": 127,
                    "description": "MIDI pitch. GM drums: 36=kick, 38=snare, 42=closed hh, 46=open hh, 49=crash, 51=ride." },
                "label": { "type": "string" },
                "channel": { "type": "integer", "minimum": 0, "maximum": 15, "default": 0,
                    "description": "MIDI channel; channel 9 is the GM drum channel." },
                "color": { "type": "string", "description": "Optional CSS color." }
            }
        });
        let pattern = json!({
            "type": "object",
            "required": ["id", "name"],
            "properties": {
                "id": { "type": "string", "description": "Stable id within the region." },
                "name": { "type": "string" },
                "color": { "type": "string" },
                "cells": { "type": "array", "items": cell.clone() },
                "free_notes": { "type": "array",
                    "description": "Pitched-mode free notes (Alt-drag). Empty for drum mode." }
            }
        });
        let arrangement_slot = json!({
            "type": "object",
            "required": ["pattern_id", "bar"],
            "properties": {
                "pattern_id": { "type": "string" },
                "bar": { "type": "integer", "minimum": 0 },
                "arrangement_row": { "type": "integer", "minimum": 0, "default": 0 }
            }
        });
        let layout = json!({
            "type": "object",
            "properties": {
                "version": { "type": "integer", "default": 2 },
                "mode": { "type": "string", "enum": ["drum", "pitched"], "default": "drum" },
                "resolution": { "type": "integer", "minimum": 1, "default": 4,
                    "description": "Steps per beat. 1=1/4, 2=1/8, 4=1/16, 8=1/32." },
                "pattern_steps": { "type": "integer", "minimum": 1, "default": 16,
                    "description": "Cells per pattern. At resolution=4, pattern_steps=16 is one bar of 4/4." },
                "rows": { "type": "array", "items": row.clone() },
                "patterns": { "type": "array", "items": pattern.clone() },
                "arrangement": { "type": "array", "items": arrangement_slot.clone() },
                "active": { "type": "boolean", "default": true,
                    "description": "When false the layout is archived but inactive — region's MIDI becomes the source of truth." }
            }
        });
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": { "type": "string", "enum": [
                    "show", "set_layout", "set_cells",
                    "add_pattern", "arrange", "clear", "show_viz"
                ]},
                "region_id": { "type": "string" },
                "track_id": { "type": "string", "description": "show_viz only" },
                "pattern_id": { "type": "string", "description": "set_cells only" },
                "name": { "type": "string", "description": "add_pattern: human label" },
                "id": { "type": "string", "description": "add_pattern: optional explicit id; auto-assigned when absent" },
                "color": { "type": "string", "description": "add_pattern: optional CSS color" },
                "cells": { "type": "array", "items": cell,
                    "description": "set_cells / add_pattern: per-cell array" },
                "slots": { "type": "array", "items": arrangement_slot,
                    "description": "arrange: per-bar pattern playlist" },
                "layout": layout
            }
        })
    }

    fn destructive(&self) -> bool {
        true
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        // `show` is read-only; everything else mutates the region.
        let backend = match &op {
            Op::Show { .. } => ctx.backend()?,
            _ => ctx.backend_with_loaded_session().await?,
        };
        match op {
            Op::Show { region_id } => show_impl(&backend, &region_id).await,
            Op::SetLayout { region_id, layout } => {
                let events: usize = layout
                    .patterns
                    .iter()
                    .map(|p| p.cells.len() + p.free_notes.len())
                    .sum();
                backend
                    .set_sequencer_layout(EntityId::new(region_id.clone()), layout)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "set sequencer layout on {region_id} ({events} cell+note events)"
                )))
            }
            Op::SetCells {
                region_id,
                pattern_id,
                cells,
            } => {
                let mut layout = load_layout(&backend, &region_id).await?;
                let pat = layout
                    .patterns
                    .iter_mut()
                    .find(|p| p.id == pattern_id)
                    .ok_or_else(|| {
                        ToolError::InvalidArgs(format!(
                            "no pattern with id '{pattern_id}' on {region_id} — call \
                             sequencer.show to list available pattern ids"
                        ))
                    })?;
                let count = cells.len();
                pat.cells = cells;
                backend
                    .set_sequencer_layout(EntityId::new(region_id.clone()), layout)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "set {count} cells on pattern '{pattern_id}' of {region_id}"
                )))
            }
            Op::AddPattern {
                region_id,
                name,
                id,
                cells,
                color,
            } => {
                let mut layout = load_layout(&backend, &region_id).await?;
                let pid = id.unwrap_or_else(|| {
                    let mut n = layout.patterns.len() + 1;
                    loop {
                        let candidate = format!("p{n}");
                        if !layout.patterns.iter().any(|p| p.id == candidate) {
                            break candidate;
                        }
                        n += 1;
                    }
                });
                if layout.patterns.iter().any(|p| p.id == pid) {
                    return Err(ToolError::InvalidArgs(format!(
                        "pattern id '{pid}' already exists — pick another or omit `id`"
                    )));
                }
                let cell_count = cells.len();
                layout.patterns.push(SequencerPattern {
                    id: pid.clone(),
                    name: name.clone(),
                    color,
                    cells,
                    free_notes: Vec::new(),
                });
                backend
                    .set_sequencer_layout(EntityId::new(region_id.clone()), layout)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "added pattern '{name}' ({pid}) with {cell_count} cells on {region_id}"
                ))
                .with_data(json!({ "pattern_id": pid })))
            }
            Op::Arrange { region_id, slots } => {
                let mut layout = load_layout(&backend, &region_id).await?;
                // Catch dangling references early — the shim would
                // accept them but the slot wouldn't play anything.
                for s in &slots {
                    if !layout.patterns.iter().any(|p| p.id == s.pattern_id) {
                        return Err(ToolError::InvalidArgs(format!(
                            "arrangement slot references unknown pattern_id '{}' — \
                             call sequencer.show to list ids",
                            s.pattern_id
                        )));
                    }
                }
                let n = slots.len();
                layout.arrangement = slots;
                backend
                    .set_sequencer_layout(EntityId::new(region_id.clone()), layout)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "set arrangement on {region_id} ({n} slots)"
                )))
            }
            Op::Clear { region_id } => {
                backend
                    .clear_sequencer_layout(EntityId::new(region_id.clone()))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("cleared sequencer on {region_id}")))
            }
            Op::ShowViz {
                track_id,
                region_id,
            } => {
                let req = json!({
                    "subcommand": "beat_sequencer",
                    "track_id": track_id,
                    "region_id": region_id,
                });
                let png = render_visualization(ctx, req).await?;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
                Ok(ToolResult {
                    summary: format!("rendered sequencer view ({} bytes)", png.len()),
                    data: json!({
                        "track_id": track_id,
                        "region_id": region_id,
                        "bytes": png.len(),
                    }),
                    image_png_b64: Some(b64),
                })
            }
        }
    }
}

/// Walk the snapshot for `region_id` and return its current layout —
/// or a fresh default when the region doesn't have one yet (so the
/// agent can start composing from an empty grid).
async fn load_layout(
    backend: &std::sync::Arc<dyn foyer_backend::Backend>,
    region_id: &str,
) -> Result<SequencerLayout, ToolError> {
    let snap = backend
        .snapshot()
        .await
        .map_err(|e| ToolError::Execution(e.to_string()))?;
    for t in &snap.tracks {
        let (_meta, regions) = backend
            .list_regions(t.id.clone())
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        if let Some(r) = regions.iter().find(|r| r.id.as_str() == region_id) {
            return Ok(r.foyer_sequencer.clone().unwrap_or_else(default_layout));
        }
    }
    Err(ToolError::InvalidArgs(format!(
        "unknown region_id '{region_id}' — call regions.list to see valid ids"
    )))
}

/// A sensible starter layout for the empty case: drum mode, 1/16
/// resolution, one bar of 16 steps, GM drum rows, one empty
/// pattern named "Pattern 1" slotted at bar 0.
fn default_layout() -> SequencerLayout {
    let rows: Vec<SequencerRow> = [
        (36u8, "Kick"),
        (38, "Snare"),
        (42, "HH closed"),
        (46, "HH open"),
        (49, "Crash"),
        (51, "Ride"),
    ]
    .into_iter()
    .map(|(p, l)| SequencerRow {
        pitch: p,
        label: l.into(),
        channel: 9,
        color: None,
        muted: false,
        soloed: false,
    })
    .collect();
    SequencerLayout {
        version: 2,
        mode: "drum".into(),
        resolution: 4,
        pattern_steps: 16,
        rows,
        patterns: vec![SequencerPattern {
            id: "p1".into(),
            name: "Pattern 1".into(),
            color: None,
            cells: Vec::new(),
            free_notes: Vec::new(),
        }],
        arrangement: vec![ArrangementSlot {
            pattern_id: "p1".into(),
            bar: 0,
            arrangement_row: 0,
        }],
        cells: Vec::new(),
        free_notes: Vec::new(),
        active: true,
    }
}

async fn show_impl(
    backend: &std::sync::Arc<dyn foyer_backend::Backend>,
    region_id: &str,
) -> Result<ToolResult, ToolError> {
    let snap = backend
        .snapshot()
        .await
        .map_err(|e| ToolError::Execution(e.to_string()))?;
    for t in &snap.tracks {
        let (_meta, regions) = backend
            .list_regions(t.id.clone())
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        if let Some(r) = regions.iter().find(|r| r.id.as_str() == region_id) {
            let layout = r.foyer_sequencer.clone();
            let has_layout = layout.is_some();
            let body = match layout {
                Some(l) => {
                    serde_json::to_value(&l).map_err(|e| ToolError::Execution(e.to_string()))?
                }
                None => serde_json::to_value(default_layout())
                    .map_err(|e| ToolError::Execution(e.to_string()))?,
            };
            let note_count = r.notes.len();
            let summary = if has_layout {
                format!(
                    "{}/{} ({} notes from sequencer)",
                    t.name, r.name, note_count
                )
            } else {
                format!(
                    "{}/{} has no sequencer layout — returning a default starter you can edit",
                    t.name, r.name
                )
            };
            return Ok(ToolResult::ok(summary).with_data(json!({
                "region_id": region_id,
                "track_id": t.id.as_str(),
                "has_layout": has_layout,
                "note_count": note_count,
                "layout": body,
            })));
        }
    }
    Err(ToolError::InvalidArgs(format!(
        "unknown region_id '{region_id}' — call regions.list to see valid ids"
    )))
}
