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
use foyer_schema::TimeArg;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{
    render_visualization, tempo_map_from_snapshot, Tool, ToolContext, ToolError, ToolResult,
};

pub struct MidiTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    PatchesOnTrack {
        track_id: String,
    },
    /// Enumerate the GM program map (0..=127 → human-readable name).
    /// Optionally filter by case-insensitive substring against the
    /// program name. Use this when the user says "make this sound
    /// like a honky tonk piano" — match by name rather than program
    /// number.
    ListGmPrograms {
        #[serde(default)]
        query: Option<String>,
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
        #[serde(default)]
        start_ticks: Option<u64>,
        #[serde(default)]
        start: Option<TimeArg>,
        #[serde(default)]
        length_ticks: Option<u64>,
        #[serde(default)]
        length: Option<TimeArg>,
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
        start: Option<TimeArg>,
        #[serde(default)]
        length_ticks: Option<u64>,
        #[serde(default)]
        length: Option<TimeArg>,
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
    #[serde(default)]
    start_ticks: Option<u64>,
    #[serde(default)]
    start: Option<TimeArg>,
    #[serde(default)]
    length_ticks: Option<u64>,
    #[serde(default)]
    length: Option<TimeArg>,
    #[serde(default)]
    channel: Option<u8>,
}

#[async_trait]
impl Tool for MidiTool {
    fn name(&self) -> &'static str {
        "midi"
    }

    fn description(&self) -> &'static str {
        "Inspect, edit, and display MIDI notes on a region. Tick fields \
         accept EITHER `_ticks` (legacy integer, region-relative) OR \
         a polymorphic `start` / `length` (samples|seconds|bbt) which \
         the server converts to ticks via the live tempo map. \
         Subcommands: \
         patches_on_track(track_id) — returns per-channel patch with \
            `gm_program_name` decoded + `is_gm_drum_kit` hint for ch9, \
         channel_config(track_id), \
         list_gm_programs(query?) — enumerate the 128 GM program names \
            so you can match by name (e.g. 'honky tonk') instead of \
            memorizing GM program numbers, \
         note_add(region_id, pitch, velocity, start|start_ticks, length|length_ticks, channel?, note_id?), \
         note_update(region_id, note_id, ...patch — same time-field rules), \
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
                    "patches_on_track", "channel_config", "list_gm_programs",
                    "note_add", "note_update", "note_delete",
                    "region_replace_notes",
                    "show_value", "show_viz"
                ]},
                "query": { "type": "string" },
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
            | Op::ListGmPrograms { .. }
            | Op::ShowValue { .. }
            | Op::ShowViz { .. } => ctx.backend()?,
            _ => ctx.backend_with_loaded_session().await?,
        };
        // `list_gm_programs` is a pure lookup against a const table —
        // short-circuit before bothering with the snapshot.
        if let Op::ListGmPrograms { query } = &op {
            let q = query.as_deref().unwrap_or("").to_lowercase();
            let rows: Vec<Value> = (0u8..=127)
                .map(|p| (p, crate::tools::tracks::gm_program_name(p)))
                .filter_map(|(p, n)| n.map(|name| (p, name)))
                .filter(|(_, name)| q.is_empty() || name.to_lowercase().contains(&q))
                .map(|(p, name)| {
                    json!({
                        "program": p,
                        "name": name,
                    })
                })
                .collect();
            return Ok(ToolResult::ok(format!(
                "{} GM programs{}",
                rows.len(),
                if q.is_empty() { "" } else { " (filtered)" }
            ))
            .with_data(json!({ "programs": rows })));
        }
        let need_map = midi_op_needs_tempo_map(&op);
        let tempo_map = if need_map {
            let snap = backend
                .snapshot()
                .await
                .map_err(|e| ToolError::Execution(e.to_string()))?;
            Some(tempo_map_from_snapshot(&snap))
        } else {
            None
        };
        // Region-relative `TimeArg` resolves to ticks (not samples)
        // because the MIDI model is tick-native — converting through
        // samples would lose precision. The conversion uses meter +
        // ppqn only; tempo doesn't matter for tick offsets.
        let to_ticks = |t: TimeArg| -> Result<u64, ToolError> {
            let map =
                tempo_map.ok_or_else(|| ToolError::Execution("tempo map missing (BUG)".into()))?;
            // Reuse to_samples then convert; cleaner than re-deriving.
            // Tempo cancels out: ticks = (samples / sample_rate) *
            // (bpm/60) * ppqn. The intermediate samples value is
            // fine for the precision we care about (1 tick at 1920
            // ppqn @ 120 BPM is ~13 samples @ 48 kHz).
            let s = t
                .to_samples(&map)
                .map_err(|e| ToolError::InvalidArgs(format!("note time: {e}")))?;
            if map.sample_rate == 0 || map.bpm <= 0.0 {
                return Ok(0);
            }
            let seconds = s as f64 / map.sample_rate as f64;
            let quarters = seconds / map.seconds_per_quarter();
            Ok((quarters * map.ticks_per_quarter as f64).round().max(0.0) as u64)
        };
        let resolve_ticks =
            |time: Option<TimeArg>, legacy: Option<u64>, field: &str| -> Result<u64, ToolError> {
                match (time, legacy) {
                    (Some(t), _) => to_ticks(t),
                    (None, Some(s)) => Ok(s),
                    (None, None) => Err(ToolError::InvalidArgs(format!(
                        "{field}: provide `{field}` or legacy `{field}_ticks`"
                    ))),
                }
            };
        // For NoteUpdate / NoteSpec where the field is optional, we
        // return Option<u64>: None means "leave unchanged".
        let resolve_ticks_opt =
            |time: Option<TimeArg>, legacy: Option<u64>| -> Result<Option<u64>, ToolError> {
                match (time, legacy) {
                    (Some(t), _) => Ok(Some(to_ticks(t)?)),
                    (None, Some(s)) => Ok(Some(s)),
                    (None, None) => Ok(None),
                }
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
                    .map(|p| {
                        let gm_name = crate::tools::tracks::gm_program_name(p.program);
                        // Channel 9 is the GM drum kit by convention —
                        // surface that as a hint so the agent doesn't
                        // misread a snare hit as middle-C piano.
                        let is_gm_drum_kit = p.channel == 9;
                        json!({
                            "channel": p.channel,
                            "bank": p.bank,
                            "program": p.program,
                            "gm_program_name": gm_name,
                            "is_gm_drum_kit": is_gm_drum_kit,
                        })
                    })
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
                start,
                length_ticks,
                length,
                channel,
                note_id,
            } => {
                let start_resolved = resolve_ticks(start, start_ticks, "start")?;
                let length_resolved = resolve_ticks(length, length_ticks, "length")?;
                let note = MidiNote {
                    id: note_id
                        .map(EntityId::new)
                        .unwrap_or_else(|| EntityId::new("")),
                    pitch,
                    velocity,
                    start_ticks: start_resolved,
                    length_ticks: length_resolved,
                    channel: channel.unwrap_or(0),
                };
                backend
                    .add_midi_note(EntityId::new(region_id.clone()), note)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "added pitch {pitch} @ {start_resolved} on {region_id}"
                )))
            }
            Op::NoteUpdate {
                region_id,
                note_id,
                pitch,
                velocity,
                start_ticks,
                start,
                length_ticks,
                length,
                channel,
            } => {
                let patch = MidiNotePatch {
                    pitch,
                    velocity,
                    start_ticks: resolve_ticks_opt(start, start_ticks)?,
                    length_ticks: resolve_ticks_opt(length, length_ticks)?,
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
                    .map(|n| {
                        let st = resolve_ticks(n.start, n.start_ticks, "start")?;
                        let ln = resolve_ticks(n.length, n.length_ticks, "length")?;
                        Ok(MidiNote {
                            id: n
                                .note_id
                                .map(EntityId::new)
                                .unwrap_or_else(|| EntityId::new("")),
                            pitch: n.pitch,
                            velocity: n.velocity,
                            start_ticks: st,
                            length_ticks: ln,
                            channel: n.channel.unwrap_or(0),
                        })
                    })
                    .collect::<Result<Vec<_>, ToolError>>()?;
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
            Op::ListGmPrograms { .. } => unreachable!("handled in early-return above"),
        }
    }
}

fn midi_op_needs_tempo_map(op: &Op) -> bool {
    match op {
        Op::NoteAdd { start, length, .. } => start.is_some() || length.is_some(),
        Op::NoteUpdate { start, length, .. } => start.is_some() || length.is_some(),
        Op::RegionReplaceNotes { notes, .. } => notes
            .iter()
            .any(|n| n.start.is_some() || n.length.is_some()),
        _ => false,
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
