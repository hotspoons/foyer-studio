// SPDX-License-Identifier: Apache-2.0
//! MIDI inspection, note editing, and display.
//!
//! The agent addresses notes by `region_id` + `note_id` (both stable
//! per-region). For Hydrogen-style beat / pattern authoring use the
//! sibling `sequencer` tool — these note-level ops are the right
//! level for melodic phrases and one-off note edits.

use async_trait::async_trait;
use base64::Engine;
use foyer_schema::id::EntityId;
use foyer_schema::midi::{MidiNote, MidiNotePatch};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{render_visualization, Tool, ToolContext, ToolError, ToolResult};

pub struct MidiTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    PatchesOnTrack {
        track_id: String,
    },
    ChannelConfig {
        track_id: String,
    },
    /// Add one note. `note_id` is optional — backend assigns one when
    /// absent. Tick coordinates are RELATIVE to the region start.
    NoteAdd {
        region_id: String,
        pitch: u8,
        velocity: u8,
        start_ticks: u64,
        length_ticks: u64,
        #[serde(default)]
        channel: Option<u8>,
        #[serde(default)]
        note_id: Option<String>,
    },
    NoteUpdate {
        region_id: String,
        note_id: String,
        #[serde(default)]
        pitch: Option<u8>,
        #[serde(default)]
        velocity: Option<u8>,
        #[serde(default)]
        start_ticks: Option<u64>,
        #[serde(default)]
        length_ticks: Option<u64>,
        #[serde(default)]
        channel: Option<u8>,
    },
    NoteDelete {
        region_id: String,
        note_id: String,
    },
    /// Replace every note in a region atomically — single undo step
    /// on the host. Good for "redraw this melody" operations.
    RegionReplaceNotes {
        region_id: String,
        notes: Vec<NoteSpec>,
    },
    /// Return the structured note list for a region — what the agent
    /// needs to reason about before editing.
    ShowValue {
        region_id: String,
    },
    /// Render the region's piano roll / sequencer view as PNG.
    ShowViz {
        track_id: String,
        region_id: String,
    },
}

#[derive(Debug, Deserialize)]
struct NoteSpec {
    #[serde(default)]
    note_id: Option<String>,
    pitch: u8,
    velocity: u8,
    start_ticks: u64,
    length_ticks: u64,
    #[serde(default)]
    channel: Option<u8>,
}

#[async_trait]
impl Tool for MidiTool {
    fn name(&self) -> &'static str {
        "midi"
    }

    fn description(&self) -> &'static str {
        "Inspect, edit, and display MIDI notes on a region. Subcommands: \
         patches_on_track(track_id), channel_config(track_id), \
         note_add(region_id, pitch, velocity, start_ticks, length_ticks, channel?, note_id?), \
         note_update(region_id, note_id, ...patch), \
         note_delete(region_id, note_id), \
         region_replace_notes(region_id, notes=[...]) — atomic, single undo, \
         show_value(region_id) — note list, \
         show_viz(track_id, region_id) — piano roll PNG. \
         For drum / beat-pattern authoring use the dedicated `sequencer` tool \
         instead — it's higher-leverage than hand-writing note tick offsets."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": { "type": "string", "enum": [
                    "patches_on_track", "channel_config",
                    "note_add", "note_update", "note_delete",
                    "region_replace_notes",
                    "show_value", "show_viz"
                ]},
                "track_id": { "type": "string" },
                "region_id": { "type": "string" },
                "note_id": { "type": "string" },
                "pitch": { "type": "integer", "minimum": 0, "maximum": 127 },
                "velocity": { "type": "integer", "minimum": 0, "maximum": 127 },
                "start_ticks": { "type": "integer", "minimum": 0 },
                "length_ticks": { "type": "integer", "minimum": 0 },
                "channel": { "type": "integer", "minimum": 0, "maximum": 15 },
                "notes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["pitch", "velocity", "start_ticks", "length_ticks"],
                        "properties": {
                            "note_id": { "type": "string" },
                            "pitch": { "type": "integer", "minimum": 0, "maximum": 127 },
                            "velocity": { "type": "integer", "minimum": 0, "maximum": 127 },
                            "start_ticks": { "type": "integer", "minimum": 0 },
                            "length_ticks": { "type": "integer", "minimum": 0 },
                            "channel": { "type": "integer", "minimum": 0, "maximum": 15 }
                        }
                    }
                }
            }
        })
    }

    fn destructive(&self) -> bool {
        true
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        // Inspection / display paths tolerate an unloaded session;
        // every mutator needs a project.
        let backend = match &op {
            Op::PatchesOnTrack { .. }
            | Op::ChannelConfig { .. }
            | Op::ShowValue { .. }
            | Op::ShowViz { .. } => ctx.backend()?,
            _ => ctx.backend_with_loaded_session().await?,
        };
        match op {
            Op::PatchesOnTrack { track_id } => {
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let t = snap
                    .tracks
                    .iter()
                    .find(|t| t.id.as_str() == track_id)
                    .ok_or_else(|| ToolError::InvalidArgs(format!("unknown track: {track_id}")))?;
                let data: Vec<Value> = t
                    .midi_patches
                    .iter()
                    .map(|p| json!({ "channel": p.channel, "bank": p.bank, "program": p.program }))
                    .collect();
                Ok(
                    ToolResult::ok(format!("{} patches on {}", data.len(), t.name))
                        .with_data(json!({ "patches": data })),
                )
            }
            Op::ChannelConfig { track_id } => {
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let t = snap
                    .tracks
                    .iter()
                    .find(|t| t.id.as_str() == track_id)
                    .ok_or_else(|| ToolError::InvalidArgs(format!("unknown track: {track_id}")))?;
                Ok(
                    ToolResult::ok(format!("channel config for {}", t.name)).with_data(json!({
                        "capture_mode": t.capture_channel_mode,
                        "capture_mask": t.capture_channel_mask,
                        "playback_mode": t.playback_channel_mode,
                        "playback_mask": t.playback_channel_mask,
                    })),
                )
            }
            Op::NoteAdd {
                region_id,
                pitch,
                velocity,
                start_ticks,
                length_ticks,
                channel,
                note_id,
            } => {
                let note = MidiNote {
                    id: note_id
                        .map(EntityId::new)
                        .unwrap_or_else(|| EntityId::new("")),
                    pitch,
                    velocity,
                    start_ticks,
                    length_ticks,
                    channel: channel.unwrap_or(0),
                };
                backend
                    .add_midi_note(EntityId::new(region_id.clone()), note)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "added pitch {pitch} @ {start_ticks} on {region_id}"
                )))
            }
            Op::NoteUpdate {
                region_id,
                note_id,
                pitch,
                velocity,
                start_ticks,
                length_ticks,
                channel,
            } => {
                let patch = MidiNotePatch {
                    pitch,
                    velocity,
                    start_ticks,
                    length_ticks,
                    channel,
                };
                backend
                    .update_midi_note(
                        EntityId::new(region_id.clone()),
                        EntityId::new(note_id.clone()),
                        patch,
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("updated {region_id}/{note_id}")))
            }
            Op::NoteDelete { region_id, note_id } => {
                backend
                    .delete_midi_note(
                        EntityId::new(region_id.clone()),
                        EntityId::new(note_id.clone()),
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("deleted {region_id}/{note_id}")))
            }
            Op::RegionReplaceNotes { region_id, notes } => {
                let count = notes.len();
                let ns: Vec<MidiNote> = notes
                    .into_iter()
                    .map(|n| MidiNote {
                        id: n
                            .note_id
                            .map(EntityId::new)
                            .unwrap_or_else(|| EntityId::new("")),
                        pitch: n.pitch,
                        velocity: n.velocity,
                        start_ticks: n.start_ticks,
                        length_ticks: n.length_ticks,
                        channel: n.channel.unwrap_or(0),
                    })
                    .collect();
                backend
                    .replace_region_notes(EntityId::new(region_id.clone()), ns)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "replaced {count} notes on {region_id}"
                )))
            }
            Op::ShowValue { region_id } => {
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
                        return Ok(midi_value_payload(t.clone(), r.clone()));
                    }
                }
                Err(ToolError::InvalidArgs(format!(
                    "no region {region_id} in any track"
                )))
            }
            Op::ShowViz {
                track_id,
                region_id,
            } => {
                let req = json!({
                    "subcommand": "midi_roll",
                    "track_id": track_id,
                    "region_id": region_id,
                });
                let png = render_visualization(ctx, req).await?;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
                Ok(ToolResult {
                    summary: format!("rendered MIDI roll ({} bytes)", png.len()),
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

fn midi_value_payload(track: foyer_schema::Track, region: foyer_schema::Region) -> ToolResult {
    let notes: Vec<Value> = region
        .notes
        .iter()
        .map(|n| {
            json!({
                "id": n.id.as_str(),
                "pitch": n.pitch,
                "velocity": n.velocity,
                "start_ticks": n.start_ticks,
                "length_ticks": n.length_ticks,
                "channel": n.channel,
            })
        })
        .collect();
    let summary = format!(
        "{} notes on {}/{}{}",
        notes.len(),
        track.name,
        region.name,
        region
            .foyer_sequencer
            .as_ref()
            .map(|_| " (+ sequencer layout)")
            .unwrap_or("")
    );
    ToolResult::ok(summary).with_data(json!({
        "track_id": track.id.as_str(),
        "region_id": region.id.as_str(),
        "name": region.name,
        "start_samples": region.start_samples,
        "length_samples": region.length_samples,
        "notes": notes,
        "has_sequencer_layout": region.foyer_sequencer.is_some(),
    }))
}
