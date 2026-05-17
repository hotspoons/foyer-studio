// SPDX-License-Identifier: Apache-2.0
//! Region inspection AND editing. Mutating subcommands route through
//! the Backend trait — same surface the FE uses for drag/resize/etc.

use async_trait::async_trait;
use foyer_schema::id::EntityId;
use foyer_schema::timeline::RegionPatch;
use foyer_schema::FadeShape;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

pub struct RegionsTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    List {
        /// Single-track filter. Omit to enumerate regions on EVERY
        /// track in one call (preferred when surveying — Rich's
        /// transcript showed an agent firing 8 sequential
        /// `regions.list { track_id }` calls instead of one
        /// `regions.list` with no filter).
        #[serde(default)]
        track_id: Option<String>,
        /// Multi-track filter. Cheaper than calling `list` once per
        /// id when you only want a subset.
        #[serde(default)]
        track_ids: Option<Vec<String>>,
    },
    /// Spawn a new region. `kind` is `"audio"` or `"midi"`; audio
    /// regions also need `source_path` (an existing pool entry) — see
    /// the backend's `create_region` doc. `length_samples` is optional:
    /// MIDI regions default to one bar at the session tempo.
    Create {
        track_id: String,
        at_samples: u64,
        #[serde(default)]
        length_samples: Option<u64>,
        kind: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        source_path: Option<String>,
    },
    Delete {
        region_id: String,
    },
    /// Slide a region to a new start time, optionally onto a different
    /// track. Negative `start_samples` is allowed (pre-roll regions).
    Move {
        region_id: String,
        start_samples: i64,
        #[serde(default)]
        target_track_id: Option<String>,
    },
    /// Resize the lozenge. `length_samples` is the new visible length;
    /// `source_offset_samples` is optional and lets a left-edge trim
    /// advance the content offset so the underlying material stays
    /// aligned. Setting `length_samples = 0` is rejected by the host —
    /// use `delete` instead.
    Trim {
        region_id: String,
        length_samples: u64,
        #[serde(default)]
        source_offset_samples: Option<u64>,
    },
    /// Set fade-in / fade-out length and optional shape. `samples = 0`
    /// clears the fade. `which` is `"in"` or `"out"`.
    SetFade {
        region_id: String,
        which: String,
        samples: u64,
        #[serde(default)]
        shape: Option<String>,
    },
    /// Reverse an audio region in time. MIDI regions are rejected by
    /// the host (use `region_replace_notes` + arithmetic to flip).
    Reverse {
        region_id: String,
    },
    /// Per-region linear gain (Ardour `scale_amplitude`). 1.0 = unity,
    /// 0.5 ≈ -6 dB. Audio regions only.
    SetGain {
        region_id: String,
        gain_linear: f64,
    },
    /// Split at an absolute timeline sample.
    Split {
        region_id: String,
        at_samples: i64,
    },
    /// Duplicate at a new position; defaults to the source's own track.
    Duplicate {
        region_id: String,
        at_samples: u64,
        #[serde(default)]
        length_samples: Option<u64>,
        #[serde(default)]
        target_track_id: Option<String>,
    },
}

#[async_trait]
impl Tool for RegionsTool {
    fn name(&self) -> &'static str {
        "regions"
    }

    fn description(&self) -> &'static str {
        "Inspect AND edit regions. Subcommands: \
         list(track_id?, track_ids?) — omit both for ALL tracks (single round-trip — \
         prefer this when surveying); pass `track_ids` for a subset, \
         create(track_id, at_samples, length_samples?, kind, name?, source_path?), \
         delete(region_id), move(region_id, start_samples, target_track_id?), \
         trim(region_id, length_samples, source_offset_samples?), \
         set_fade(region_id, which='in'|'out', samples, shape?), \
         reverse(region_id), set_gain(region_id, gain_linear), \
         split(region_id, at_samples), \
         duplicate(region_id, at_samples, length_samples?, target_track_id?)."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": { "type": "string", "enum": [
                    "list", "create", "delete", "move", "trim", "set_fade",
                    "reverse", "set_gain", "split", "duplicate"
                ]},
                "track_id": { "type": "string" },
                "track_ids": { "type": "array", "items": { "type": "string" } },
                "region_id": { "type": "string" },
                "at_samples": { "type": "integer", "minimum": 0 },
                "length_samples": { "type": "integer", "minimum": 0 },
                "kind": { "type": "string", "enum": ["audio", "midi"] },
                "name": { "type": "string" },
                "source_path": { "type": "string" },
                "start_samples": { "type": "integer" },
                "target_track_id": { "type": "string" },
                "source_offset_samples": { "type": "integer", "minimum": 0 },
                "which": { "type": "string", "enum": ["in", "out"] },
                "samples": { "type": "integer", "minimum": 0 },
                "shape": { "type": "string", "enum": [
                    "linear", "constant_power", "fast", "slow", "symmetric"
                ]},
                "gain_linear": { "type": "number", "minimum": 0 }
            }
        })
    }

    fn destructive(&self) -> bool {
        true
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        // List is read-only and works fine on an empty / unloaded
        // session; every other subcommand mutates the project so we
        // gate on the loaded-session precondition.
        let backend = match &op {
            Op::List { .. } => ctx.backend()?,
            _ => ctx.backend_with_loaded_session().await?,
        };
        match op {
            Op::List {
                track_id,
                track_ids,
            } => {
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let mut all = Vec::new();
                for t in &snap.tracks {
                    if let Some(ref tid) = track_id {
                        if t.id.as_str() != tid {
                            continue;
                        }
                    }
                    if let Some(ref ids) = track_ids {
                        if !ids.iter().any(|x| x == t.id.as_str()) {
                            continue;
                        }
                    }
                    let (_meta, regions) = backend
                        .list_regions(t.id.clone())
                        .await
                        .map_err(|e| ToolError::Execution(e.to_string()))?;
                    for r in regions {
                        all.push(json!({
                            "track_id": t.id.as_str(),
                            "id": r.id.as_str(),
                            "name": r.name,
                            "start_samples": r.start_samples,
                            "length_samples": r.length_samples,
                            "muted": r.muted,
                            "gain_linear": r.gain_linear,
                            "fade_in_samples": r.fade_in_samples,
                            "fade_out_samples": r.fade_out_samples,
                            "kind": region_kind(&r),
                        }));
                    }
                }
                Ok(ToolResult::ok(format!("{} regions", all.len()))
                    .with_data(json!({ "regions": all })))
            }
            Op::Create {
                track_id,
                at_samples,
                length_samples,
                kind,
                name,
                source_path,
            } => {
                // The Ardour shim is happy to accept create_region
                // calls for tracks that don't exist (and silently
                // drops them on the floor) — surface that here as a
                // clear InvalidArgs so the agent can recover instead
                // of believing the region landed.
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                if !snap.tracks.iter().any(|t| t.id.as_str() == track_id) {
                    return Err(ToolError::InvalidArgs(format!(
                        "unknown track_id '{track_id}' — call tracks.list to see valid ids"
                    )));
                }
                backend
                    .create_region(
                        EntityId::new(track_id.clone()),
                        at_samples,
                        length_samples,
                        kind.clone(),
                        name.clone(),
                        source_path,
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "created {kind} region on {track_id} @ {at_samples}"
                )))
            }
            Op::Delete { region_id } => {
                backend
                    .delete_region(EntityId::new(region_id.clone()))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("deleted region {region_id}")))
            }
            Op::Move {
                region_id,
                start_samples,
                target_track_id,
            } => {
                let patch = RegionPatch {
                    start_samples: Some(start_samples),
                    track_id: target_track_id.as_deref().map(EntityId::new),
                    ..Default::default()
                };
                backend
                    .update_region(EntityId::new(region_id.clone()), patch)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "moved {region_id} → start={start_samples}{}",
                    match target_track_id {
                        Some(t) => format!(" track={t}"),
                        None => String::new(),
                    }
                )))
            }
            Op::Trim {
                region_id,
                length_samples,
                source_offset_samples,
            } => {
                let patch = RegionPatch {
                    length_samples: Some(length_samples),
                    source_offset_samples,
                    ..Default::default()
                };
                backend
                    .update_region(EntityId::new(region_id.clone()), patch)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "trimmed {region_id} → len={length_samples}"
                )))
            }
            Op::SetFade {
                region_id,
                which,
                samples,
                shape,
            } => {
                let shape_parsed = match shape.as_deref() {
                    None => None,
                    Some("linear") => Some(FadeShape::Linear),
                    Some("constant_power") => Some(FadeShape::ConstantPower),
                    Some("fast") => Some(FadeShape::Fast),
                    Some("slow") => Some(FadeShape::Slow),
                    Some("symmetric") => Some(FadeShape::Symmetric),
                    Some(other) => {
                        return Err(ToolError::InvalidArgs(format!(
                            "unknown fade shape: {other}"
                        )))
                    }
                };
                let mut patch = RegionPatch::default();
                match which.as_str() {
                    "in" => {
                        patch.fade_in_samples = Some(samples);
                        patch.fade_in_shape = shape_parsed;
                    }
                    "out" => {
                        patch.fade_out_samples = Some(samples);
                        patch.fade_out_shape = shape_parsed;
                    }
                    other => {
                        return Err(ToolError::InvalidArgs(format!(
                            "which must be 'in' or 'out', got '{other}'"
                        )))
                    }
                };
                backend
                    .update_region(EntityId::new(region_id.clone()), patch)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "{which}-fade of {region_id} → {samples} samples"
                )))
            }
            Op::Reverse { region_id } => {
                backend
                    .reverse_region(EntityId::new(region_id.clone()))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("reversed {region_id}")))
            }
            Op::SetGain {
                region_id,
                gain_linear,
            } => {
                let patch = RegionPatch {
                    gain_linear: Some(gain_linear),
                    ..Default::default()
                };
                backend
                    .update_region(EntityId::new(region_id.clone()), patch)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "{region_id} gain → {gain_linear:.3} ({:.2} dB)",
                    20.0 * gain_linear.log10()
                )))
            }
            Op::Split {
                region_id,
                at_samples,
            } => {
                backend
                    .split_region(EntityId::new(region_id.clone()), at_samples)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("split {region_id} @ {at_samples}")))
            }
            Op::Duplicate {
                region_id,
                at_samples,
                length_samples,
                target_track_id,
            } => {
                backend
                    .duplicate_region(
                        EntityId::new(region_id.clone()),
                        at_samples,
                        length_samples,
                        target_track_id.as_deref().map(EntityId::new),
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "duplicated {region_id} → @ {at_samples}"
                )))
            }
        }
    }
}

/// Best-effort kind tag inferred from the snapshot record. The schema
/// doesn't carry an explicit enum on `Region` — we infer from which
/// fields are populated. Audio regions carry `source_path`; MIDI
/// regions carry `notes` (or a sequencer layout).
fn region_kind(r: &foyer_schema::Region) -> &'static str {
    if r.foyer_sequencer.is_some() {
        "sequencer"
    } else if !r.notes.is_empty() || !r.patch_changes.is_empty() {
        "midi"
    } else if r.source_path.is_some() || !r.source_segments.is_empty() {
        "audio"
    } else {
        "unknown"
    }
}
