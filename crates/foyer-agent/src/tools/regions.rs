// SPDX-License-Identifier: Apache-2.0
//! Region inspection AND editing. Mutating subcommands route through
//! the Backend trait — same surface the FE uses for drag/resize/etc.

use async_trait::async_trait;
use foyer_schema::id::EntityId;
use foyer_schema::timeline::RegionPatch;
use foyer_schema::{FadeShape, TimeArg};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{tempo_map_from_snapshot, Tool, ToolContext, ToolError, ToolResult};

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
    ///
    /// Polymorphic time: `at` and `length` (both [`TimeArg`]) accept
    /// samples / seconds / BBT. If `at` is set it wins over
    /// `at_samples`; same for `length` over `length_samples`.
    Create {
        track_id: String,
        #[serde(default)]
        at_samples: Option<u64>,
        #[serde(default)]
        at: Option<TimeArg>,
        #[serde(default)]
        length_samples: Option<u64>,
        #[serde(default)]
        length: Option<TimeArg>,
        kind: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        source_path: Option<String>,
        /// MIDI-region bulk-note populate. When set, the region is
        /// created AND populated with these notes atomically — one
        /// undo entry, one round trip. Mirrors Ardour's
        /// `midi_note_import_json_to_new_region_*`. Ignored for
        /// audio regions.
        #[serde(default)]
        notes: Option<Vec<MidiNoteSpec>>,
    },
    Delete {
        region_id: String,
    },
    /// Slide a region to a new start time, optionally onto a different
    /// track. Negative `start_samples` is allowed (pre-roll regions).
    /// `start` (polymorphic) is preferred for new code — note that
    /// polymorphic BBT/seconds can't express negatives, so pre-roll
    /// regions must keep using `start_samples`.
    Move {
        region_id: String,
        #[serde(default)]
        start_samples: Option<i64>,
        #[serde(default)]
        start: Option<TimeArg>,
        #[serde(default)]
        target_track_id: Option<String>,
    },
    /// Resize the lozenge. `length_samples` is the new visible length;
    /// `source_offset_samples` is optional and lets a left-edge trim
    /// advance the content offset so the underlying material stays
    /// aligned. Setting `length_samples = 0` is rejected by the host —
    /// use `delete` instead. `length` (polymorphic) overrides
    /// `length_samples` when set.
    Trim {
        region_id: String,
        #[serde(default)]
        length_samples: Option<u64>,
        #[serde(default)]
        length: Option<TimeArg>,
        #[serde(default)]
        source_offset_samples: Option<u64>,
    },
    /// Set fade-in / fade-out length and optional shape. `samples = 0`
    /// clears the fade. `which` is `"in"` or `"out"`. `length`
    /// (polymorphic) overrides `samples` when set.
    SetFade {
        region_id: String,
        which: String,
        #[serde(default)]
        samples: Option<u64>,
        #[serde(default)]
        length: Option<TimeArg>,
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
    /// Split at an absolute timeline sample. `at` (polymorphic)
    /// overrides `at_samples` when set; negative pre-roll splits
    /// require the legacy `at_samples`.
    Split {
        region_id: String,
        #[serde(default)]
        at_samples: Option<i64>,
        #[serde(default)]
        at: Option<TimeArg>,
    },
    /// Duplicate at a new position; defaults to the source's own track.
    /// Polymorphic `at` / `length` override `at_samples` /
    /// `length_samples` when set.
    Duplicate {
        region_id: String,
        #[serde(default)]
        at_samples: Option<u64>,
        #[serde(default)]
        at: Option<TimeArg>,
        #[serde(default)]
        length_samples: Option<u64>,
        #[serde(default)]
        length: Option<TimeArg>,
        #[serde(default)]
        target_track_id: Option<String>,
    },
    /// Normalize audio region peaks to a target dBFS. Walks the
    /// region's source samples once, finds the absolute-peak
    /// magnitude, and sets `gain_linear` so the peak hits the target.
    /// Target defaults to -0.3 dBFS (industry-typical for mastering
    /// peaks). MIDI regions are rejected by the host (no audio
    /// samples to scan).
    Normalize {
        region_id: String,
        #[serde(default)]
        target_dbfs: Option<f64>,
    },
}

/// One MIDI note in a bulk-create payload. Mirrors
/// [`foyer_schema::MidiNote`] but lets the agent ship beats / seconds
/// instead of raw ticks. Exactly one of `start_ticks` / `start` is
/// required; same for `length_ticks` / `length`.
#[derive(Debug, Clone, Deserialize)]
pub struct MidiNoteSpec {
    pub pitch: u8,
    pub velocity: u8,
    #[serde(default)]
    pub channel: Option<u8>,
    #[serde(default)]
    pub start_ticks: Option<u64>,
    #[serde(default)]
    pub start: Option<TimeArg>,
    #[serde(default)]
    pub length_ticks: Option<u64>,
    #[serde(default)]
    pub length: Option<TimeArg>,
}

impl Op {
    /// Does this call carry any [`TimeArg`] field? Drives the lazy
    /// snapshot fetch in `call` — pure samples-only payloads skip
    /// the round trip entirely.
    fn needs_tempo_map(&self) -> bool {
        match self {
            Op::Create {
                at, length, notes, ..
            } => {
                at.is_some()
                    || length.is_some()
                    || notes.as_ref().is_some_and(|ns| {
                        ns.iter().any(|n| n.start.is_some() || n.length.is_some())
                    })
            }
            Op::Move { start, .. } => start.is_some(),
            Op::Trim { length, .. } => length.is_some(),
            Op::SetFade { length, .. } => length.is_some(),
            Op::Split { at, .. } => at.is_some(),
            Op::Duplicate { at, length, .. } => at.is_some() || length.is_some(),
            _ => false,
        }
    }
}

/// Resolve `Option<TimeArg>` falling back to a legacy samples field.
/// Returns `Ok(None)` only when both are unset and the caller has
/// declared it acceptable (used by Create when `length` is optional).
fn resolve_time_or_samples(
    time: Option<TimeArg>,
    legacy_samples: Option<u64>,
    tempo_map: Option<foyer_schema::TempoMap>,
    field: &str,
) -> Result<Option<u64>, ToolError> {
    match (time, legacy_samples) {
        (Some(t), _) => {
            let map = tempo_map
                .ok_or_else(|| ToolError::Execution(format!("{field}: tempo map missing (BUG)")))?;
            let s = t
                .to_samples(&map)
                .map_err(|e| ToolError::InvalidArgs(format!("{field}: {e}")))?;
            Ok(Some(s))
        }
        (None, Some(s)) => Ok(Some(s)),
        (None, None) => Ok(None),
    }
}

/// Same as [`resolve_time_or_samples`] but returns a signed `i64`.
fn resolve_time_or_samples_signed(
    time: Option<TimeArg>,
    legacy_samples: Option<i64>,
    tempo_map: Option<foyer_schema::TempoMap>,
    field: &str,
) -> Result<Option<i64>, ToolError> {
    match (time, legacy_samples) {
        (Some(t), _) => {
            let map = tempo_map
                .ok_or_else(|| ToolError::Execution(format!("{field}: tempo map missing (BUG)")))?;
            let s = t
                .to_samples_signed(&map)
                .map_err(|e| ToolError::InvalidArgs(format!("{field}: {e}")))?;
            Ok(Some(s))
        }
        (None, Some(s)) => Ok(Some(s)),
        (None, None) => Ok(None),
    }
}

#[async_trait]
impl Tool for RegionsTool {
    fn name(&self) -> &'static str {
        "regions"
    }

    fn description(&self) -> &'static str {
        "Inspect AND edit regions. Time fields are polymorphic: every \
         `at` / `start` / `length` accepts EITHER `_samples` (legacy \
         integer) OR a `{samples?, seconds?, bbt?{bar,beat,tick}}` \
         object — server picks the one set, resolves BBT/seconds via \
         the live tempo map. \
         Subcommands: \
         list(track_id?, track_ids?) — omit both for ALL tracks, \
         create(track_id, at|at_samples, length?|length_samples?, kind, \
            name?, source_path?, notes?[]) — `notes` populates a MIDI region \
            atomically (one undo entry), \
         delete(region_id), move(region_id, start|start_samples, target_track_id?), \
         trim(region_id, length|length_samples, source_offset_samples?), \
         set_fade(region_id, which='in'|'out', length|samples, shape?), \
         reverse(region_id), set_gain(region_id, gain_linear), \
         normalize(region_id, target_dbfs?) — audio peak normalize \
            (default target -0.3 dBFS), \
         split(region_id, at|at_samples), \
         duplicate(region_id, at|at_samples, length?|length_samples?, target_track_id?)."
    }

    fn schema(&self) -> Value {
        let time_schema = json!({
            "type": "object",
            "description": "Polymorphic time: provide EXACTLY one of `samples`, `seconds`, or `bbt`.",
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
                    "list", "create", "delete", "move", "trim", "set_fade",
                    "reverse", "set_gain", "split", "duplicate", "normalize"
                ]},
                "track_id": { "type": "string" },
                "track_ids": { "type": "array", "items": { "type": "string" } },
                "region_id": { "type": "string" },
                "at_samples": { "type": "integer", "minimum": 0 },
                "at": time_schema,
                "length_samples": { "type": "integer", "minimum": 0 },
                "length": time_schema,
                "kind": { "type": "string", "enum": ["audio", "midi"] },
                "name": { "type": "string" },
                "source_path": { "type": "string" },
                "start_samples": { "type": "integer" },
                "start": time_schema,
                "target_track_id": { "type": "string" },
                "source_offset_samples": { "type": "integer", "minimum": 0 },
                "which": { "type": "string", "enum": ["in", "out"] },
                "samples": { "type": "integer", "minimum": 0 },
                "shape": { "type": "string", "enum": [
                    "linear", "constant_power", "fast", "slow", "symmetric"
                ]},
                "gain_linear": { "type": "number", "minimum": 0 },
                "target_dbfs": { "type": "number", "maximum": 0 },
                "notes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["pitch", "velocity"],
                        "properties": {
                            "pitch": { "type": "integer", "minimum": 0, "maximum": 127 },
                            "velocity": { "type": "integer", "minimum": 1, "maximum": 127 },
                            "channel": { "type": "integer", "minimum": 0, "maximum": 15 },
                            "start_ticks": { "type": "integer", "minimum": 0 },
                            "start": time_schema,
                            "length_ticks": { "type": "integer", "minimum": 1 },
                            "length": time_schema
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
        // List is read-only and works fine on an empty / unloaded
        // session; every other subcommand mutates the project so we
        // gate on the loaded-session precondition.
        let backend = match &op {
            Op::List { .. } => ctx.backend()?,
            _ => ctx.backend_with_loaded_session().await?,
        };
        // Lazy tempo-map fetch — only paid when a polymorphic time
        // arg is actually present in the call.
        let snap_for_tempo = if op.needs_tempo_map() {
            Some(
                backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?,
            )
        } else {
            None
        };
        let tempo_map = snap_for_tempo.as_ref().map(tempo_map_from_snapshot);
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
                        // Include `track_name` alongside `track_id` so the
                        // model can group regions by track without having
                        // to cross-reference the tracks.list output by
                        // ID. Observed in the Kimi e2e drive: the agent
                        // got confused trying to match opaque numeric IDs
                        // and reported a phantom region/track swap.
                        all.push(json!({
                            "track_id": t.id.as_str(),
                            "track_name": t.name,
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
                at,
                length_samples,
                length,
                kind,
                name,
                source_path,
                notes,
            } => {
                let at_resolved = resolve_time_or_samples(at, at_samples, tempo_map, "at")?
                    .ok_or_else(|| {
                        ToolError::InvalidArgs("create: provide `at` or legacy `at_samples`".into())
                    })?;
                let length_resolved =
                    resolve_time_or_samples(length, length_samples, tempo_map, "length")?;
                // Reuse the same snapshot if we already fetched one for
                // tempo resolution; otherwise pay the round trip here
                // for the unknown-track-id guard.
                let snap = match snap_for_tempo {
                    Some(s) => s,
                    None => backend
                        .snapshot()
                        .await
                        .map_err(|e| ToolError::Execution(e.to_string()))?,
                };
                if !snap.tracks.iter().any(|t| t.id.as_str() == track_id) {
                    return Err(ToolError::InvalidArgs(format!(
                        "unknown track_id '{track_id}' — call tracks.list to see valid ids"
                    )));
                }
                backend
                    .create_region(
                        EntityId::new(track_id.clone()),
                        at_resolved,
                        length_resolved,
                        kind.clone(),
                        name.clone(),
                        source_path,
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                // Atomic-populate (bulk MIDI notes). The agent gets one
                // round-trip instead of insert-then-add_notes; the
                // backend wraps it in a single undo group via
                // `replace_region_notes`.
                let mut notes_written = 0usize;
                if let Some(notes) = notes {
                    if !matches!(kind.as_str(), "midi") {
                        return Err(ToolError::InvalidArgs(
                            "create.notes only supported for kind='midi'".into(),
                        ));
                    }
                    let map = tempo_map.ok_or_else(|| {
                        ToolError::Execution(
                            "create.notes: tempo map missing (BUG — needs_tempo_map should have set it)".into(),
                        )
                    })?;
                    // The host doesn't expose the just-created region's
                    // id directly; re-list and pick the most recent
                    // matching `at_samples` start. The shim emits a
                    // monotonic timestamp suffix on auto-generated names
                    // so a fresh region always sorts last.
                    let (_meta, regs) = backend
                        .list_regions(EntityId::new(track_id.clone()))
                        .await
                        .map_err(|e| ToolError::Execution(e.to_string()))?;
                    let region_id = regs
                        .iter()
                        .rev()
                        .find(|r| r.start_samples >= 0 && r.start_samples as u64 == at_resolved)
                        .map(|r| r.id.clone())
                        .ok_or_else(|| {
                            ToolError::Execution(
                                "create.notes: could not locate just-created region — \
                                 check shim emitted update_regions on create"
                                    .into(),
                            )
                        })?;
                    let resolved: Vec<foyer_schema::MidiNote> = notes
                        .iter()
                        .map(|n| resolve_midi_note(n, &map))
                        .collect::<Result<_, _>>()?;
                    notes_written = resolved.len();
                    backend
                        .replace_region_notes(region_id, resolved)
                        .await
                        .map_err(|e| ToolError::Execution(e.to_string()))?;
                }
                Ok(ToolResult::ok(format!(
                    "created {kind} region on {track_id} @ {at_resolved}{}",
                    if notes_written > 0 {
                        format!(" with {notes_written} notes")
                    } else {
                        String::new()
                    }
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
                start,
                target_track_id,
            } => {
                let start_resolved =
                    resolve_time_or_samples_signed(start, start_samples, tempo_map, "start")?
                        .ok_or_else(|| {
                            ToolError::InvalidArgs(
                                "move: provide `start` or legacy `start_samples`".into(),
                            )
                        })?;
                let patch = RegionPatch {
                    start_samples: Some(start_resolved),
                    track_id: target_track_id.as_deref().map(EntityId::new),
                    ..Default::default()
                };
                backend
                    .update_region(EntityId::new(region_id.clone()), patch)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "moved {region_id} → start={start_resolved}{}",
                    match target_track_id {
                        Some(t) => format!(" track={t}"),
                        None => String::new(),
                    }
                )))
            }
            Op::Trim {
                region_id,
                length_samples,
                length,
                source_offset_samples,
            } => {
                let length_resolved =
                    resolve_time_or_samples(length, length_samples, tempo_map, "length")?
                        .ok_or_else(|| {
                            ToolError::InvalidArgs(
                                "trim: provide `length` or legacy `length_samples`".into(),
                            )
                        })?;
                let patch = RegionPatch {
                    length_samples: Some(length_resolved),
                    source_offset_samples,
                    ..Default::default()
                };
                backend
                    .update_region(EntityId::new(region_id.clone()), patch)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "trimmed {region_id} → len={length_resolved}"
                )))
            }
            Op::SetFade {
                region_id,
                which,
                samples,
                length,
                shape,
            } => {
                let samples = resolve_time_or_samples(length, samples, tempo_map, "length")?
                    .ok_or_else(|| {
                        ToolError::InvalidArgs(
                            "set_fade: provide `length` or legacy `samples`".into(),
                        )
                    })?;
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
                at,
            } => {
                let at_resolved = resolve_time_or_samples_signed(at, at_samples, tempo_map, "at")?
                    .ok_or_else(|| {
                        ToolError::InvalidArgs("split: provide `at` or legacy `at_samples`".into())
                    })?;
                backend
                    .split_region(EntityId::new(region_id.clone()), at_resolved)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("split {region_id} @ {at_resolved}")))
            }
            Op::Duplicate {
                region_id,
                at_samples,
                at,
                length_samples,
                length,
                target_track_id,
            } => {
                let at_resolved = resolve_time_or_samples(at, at_samples, tempo_map, "at")?
                    .ok_or_else(|| {
                        ToolError::InvalidArgs(
                            "duplicate: provide `at` or legacy `at_samples`".into(),
                        )
                    })?;
                let length_resolved =
                    resolve_time_or_samples(length, length_samples, tempo_map, "length")?;
                backend
                    .duplicate_region(
                        EntityId::new(region_id.clone()),
                        at_resolved,
                        length_resolved,
                        target_track_id.as_deref().map(EntityId::new),
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "duplicated {region_id} → @ {at_resolved}"
                )))
            }
            Op::Normalize {
                region_id,
                target_dbfs,
            } => {
                let target = target_dbfs.unwrap_or(-0.3);
                if !target.is_finite() || target > 0.0 {
                    return Err(ToolError::InvalidArgs(format!(
                        "normalize: target_dbfs must be ≤ 0 and finite, got {target}"
                    )));
                }
                let new_gain = backend
                    .normalize_region(EntityId::new(region_id.clone()), target)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "normalized {region_id} → peak {target:.2} dBFS \
                     (gain={new_gain:.3}× / {:.2} dB)",
                    20.0 * new_gain.max(f64::EPSILON).log10()
                ))
                .with_data(json!({
                    "region_id": region_id,
                    "target_dbfs": target,
                    "gain_linear": new_gain,
                })))
            }
        }
    }
}

/// Convert a [`MidiNoteSpec`] (which may carry BBT / seconds for its
/// timing fields) into a [`foyer_schema::MidiNote`] suitable for the
/// backend. Used by `regions.create` bulk-populate. Tick fields are
/// region-relative — same convention as the existing midi tool.
fn resolve_midi_note(
    spec: &MidiNoteSpec,
    map: &foyer_schema::TempoMap,
) -> Result<foyer_schema::MidiNote, ToolError> {
    let start_ticks = match (spec.start_ticks, spec.start) {
        (Some(t), _) => t,
        (None, Some(t)) => {
            // Convert TimeArg → samples → ticks via tempo map. One
            // beat = seconds_per_quarter * quarters_per_beat;
            // one tick = beat / ticks_per_quarter.
            let samples = t
                .to_samples(map)
                .map_err(|e| ToolError::InvalidArgs(format!("note.start: {e}")))?;
            samples_to_ticks(samples, map)
        }
        (None, None) => {
            return Err(ToolError::InvalidArgs(
                "note: provide `start` or `start_ticks`".into(),
            ));
        }
    };
    let length_ticks = match (spec.length_ticks, spec.length) {
        (Some(t), _) => t,
        (None, Some(t)) => {
            let samples = t
                .to_samples(map)
                .map_err(|e| ToolError::InvalidArgs(format!("note.length: {e}")))?;
            samples_to_ticks(samples, map)
        }
        (None, None) => {
            return Err(ToolError::InvalidArgs(
                "note: provide `length` or `length_ticks`".into(),
            ));
        }
    };
    Ok(foyer_schema::MidiNote {
        id: foyer_schema::EntityId::new(""),
        channel: spec.channel.unwrap_or(0),
        pitch: spec.pitch,
        velocity: spec.velocity,
        start_ticks,
        length_ticks,
    })
}

fn samples_to_ticks(samples: u64, map: &foyer_schema::TempoMap) -> u64 {
    if map.sample_rate == 0 || map.bpm <= 0.0 {
        return 0;
    }
    let seconds = samples as f64 / map.sample_rate as f64;
    let quarters = seconds / map.seconds_per_quarter();
    (quarters * map.ticks_per_quarter as f64).round().max(0.0) as u64
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
