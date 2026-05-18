// SPDX-License-Identifier: Apache-2.0
//! Mixer control — fader / mute / solo / pan per track.
//!
//! Subcommands take a `track_id` (the `EntityId.as_str()` from a
//! session snapshot) plus an op-specific value. The tool resolves
//! the relevant control id from the snapshot under the hood — the
//! LLM doesn't have to memorize Foyer's `track.<n>.gain` naming.

use async_trait::async_trait;
use foyer_schema::{ControlValue, EntityId};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

pub struct MixerTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    SetGainDb {
        track_id: String,
        db: f64,
    },
    SetMute {
        track_id: String,
        muted: bool,
    },
    SetSolo {
        track_id: String,
        soloed: bool,
    },
    SetPan {
        track_id: String,
        pan: f64,
    },
    Get {
        track_id: String,
    },
    /// Bulk mixer changes — one tool call applies any mix of
    /// gain / mute / solo / pan deltas across many tracks. Each entry
    /// in `changes` specifies a `track_id` plus exactly one of
    /// `gain_db` | `muted` | `soloed` | `pan`. Cap is 256 changes
    /// per call.
    Apply {
        changes: Vec<MixerChange>,
    },
    /// Snapshot the entire mix state (every track's fader, pan, mute,
    /// solo, send levels) under `name` for later recall. Common live
    /// + production use: "save the chorus mix" / "snapshot before
    /// touching anything." Returns the canonical scene record.
    StoreScene {
        name: String,
        #[serde(default)]
        color: Option<String>,
    },
    /// Recall a previously-stored scene. Resolves by `id` first; if
    /// `id` is unset and `name` matches exactly one scene, recalls
    /// that one (ambiguous name = error). Sets `active_scene_id` on
    /// the session.
    RecallScene {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        name: Option<String>,
    },
    ListScenes,
    DeleteScene {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        name: Option<String>,
    },
    RenameScene {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        old_name: Option<String>,
        new_name: String,
    },
}

#[derive(Debug, Deserialize)]
pub struct MixerChange {
    pub track_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gain_db: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub soloed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pan: Option<f64>,
}

const MAX_MIXER_BATCH: usize = 256;

#[async_trait]
impl Tool for MixerTool {
    fn name(&self) -> &'static str {
        "mixer"
    }

    fn description(&self) -> &'static str {
        "Read or modify the mixer state. Subcommands: \
         set_gain_db(track_id, db), set_mute(track_id, muted), \
         set_solo(track_id, soloed), set_pan(track_id, pan in [-1, 1]), \
         get(track_id) returns a summary of current fader/mute/solo/pan, \
         apply(changes:[{track_id, gain_db?, muted?, soloed?, pan?}…]) \
         — BATCHED mix change in a single round-trip; prefer this when \
         tweaking multiple tracks at once (e.g. balancing a mix). Capped \
         at 256 changes per call. \
         store_scene(name, color?) — snapshot every track's mix state \
         (fader/pan/mute/solo/sends) under `name`. \
         recall_scene(id?|name?) — flip the entire mix back to a stored \
         scene; faster than per-track restoration. \
         list_scenes — enumerate stored scenes. \
         delete_scene(id?|name?), rename_scene(id?|old_name?, new_name)."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": {
                    "type": "string",
                    "enum": ["set_gain_db", "set_mute", "set_solo", "set_pan",
                            "get", "apply",
                            "store_scene", "recall_scene", "list_scenes",
                            "delete_scene", "rename_scene"]
                },
                "track_id": { "type": "string" },
                "db": { "type": "number" },
                "muted": { "type": "boolean" },
                "soloed": { "type": "boolean" },
                "pan": { "type": "number", "minimum": -1, "maximum": 1 },
                "name": { "type": "string" },
                "old_name": { "type": "string" },
                "new_name": { "type": "string" },
                "id": { "type": "string" },
                "color": { "type": "string" },
                "changes": {
                    "type": "array",
                    "description": "apply: list of per-track mixer changes. Each entry needs `track_id` and at least one of gain_db/muted/soloed/pan.",
                    "items": {
                        "type": "object",
                        "required": ["track_id"],
                        "properties": {
                            "track_id": { "type": "string" },
                            "gain_db": { "type": "number" },
                            "muted":   { "type": "boolean" },
                            "soloed":  { "type": "boolean" },
                            "pan":     { "type": "number", "minimum": -1, "maximum": 1 }
                        }
                    }
                }
            }
        })
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        // `get` is read-only; every other mixer subcommand writes a
        // control value and needs a real project loaded.
        let backend = match &op {
            Op::Get { .. } | Op::ListScenes => ctx.backend()?,
            _ => ctx.backend_with_loaded_session().await?,
        };
        let snapshot = backend
            .snapshot()
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        // Scene ops route through their own subhandler so they can
        // resolve by id-or-name.
        if let Op::StoreScene { name, color } = &op {
            let scene = backend
                .store_mixer_scene(name.clone(), color.clone())
                .await
                .map_err(|e| ToolError::Execution(e.to_string()))?;
            return Ok(ToolResult::ok(format!(
                "stored scene '{}' ({} tracks)",
                scene.name,
                scene.snapshots.len()
            ))
            .with_data(
                serde_json::to_value(&scene).map_err(|e| ToolError::Execution(e.to_string()))?,
            ));
        }
        if let Op::RecallScene { id, name } = &op {
            let scene_id = resolve_scene_id(&snapshot, id.as_deref(), name.as_deref())?;
            let scene = backend
                .recall_mixer_scene(scene_id)
                .await
                .map_err(|e| ToolError::Execution(e.to_string()))?;
            return Ok(ToolResult::ok(format!(
                "recalled scene '{}' ({} tracks restored)",
                scene.name,
                scene.snapshots.len()
            ))
            .with_data(
                serde_json::to_value(&scene).map_err(|e| ToolError::Execution(e.to_string()))?,
            ));
        }
        if let Op::ListScenes = &op {
            let data: Vec<Value> = snapshot
                .mixer_scenes
                .iter()
                .map(|s| {
                    json!({
                        "id": s.id.as_str(),
                        "name": s.name,
                        "color": s.color,
                        "created_at_unix": s.created_at_unix,
                        "track_count": s.snapshots.len(),
                        "is_active": snapshot.active_scene_id.as_ref() == Some(&s.id),
                    })
                })
                .collect();
            return Ok(ToolResult::ok(format!("{} scene(s) stored", data.len()))
                .with_data(json!({ "scenes": data })));
        }
        if let Op::DeleteScene { id, name } = &op {
            let scene_id = resolve_scene_id(&snapshot, id.as_deref(), name.as_deref())?;
            backend
                .delete_mixer_scene(scene_id.clone())
                .await
                .map_err(|e| ToolError::Execution(e.to_string()))?;
            return Ok(ToolResult::ok(format!(
                "deleted scene {}",
                scene_id.as_str()
            )));
        }
        if let Op::RenameScene {
            id,
            old_name,
            new_name,
        } = &op
        {
            let scene_id = resolve_scene_id(&snapshot, id.as_deref(), old_name.as_deref())?;
            let scene = backend
                .rename_mixer_scene(scene_id, new_name.clone())
                .await
                .map_err(|e| ToolError::Execution(e.to_string()))?;
            return Ok(
                ToolResult::ok(format!("renamed → '{}'", scene.name)).with_data(
                    serde_json::to_value(&scene)
                        .map_err(|e| ToolError::Execution(e.to_string()))?,
                ),
            );
        }
        // `Apply` resolves track_ids per-entry below; everything else
        // works against a single track.
        if let Op::Apply { changes } = &op {
            return apply_mixer_changes(backend.as_ref(), &snapshot, changes).await;
        }
        let track_id_str = match &op {
            Op::SetGainDb { track_id, .. }
            | Op::SetMute { track_id, .. }
            | Op::SetSolo { track_id, .. }
            | Op::SetPan { track_id, .. }
            | Op::Get { track_id } => track_id,
            Op::Apply { .. }
            | Op::StoreScene { .. }
            | Op::RecallScene { .. }
            | Op::ListScenes
            | Op::DeleteScene { .. }
            | Op::RenameScene { .. } => unreachable!("handled above"),
        };
        let track = snapshot
            .tracks
            .iter()
            .find(|t| t.id.as_str() == track_id_str.as_str())
            .ok_or_else(|| ToolError::InvalidArgs(format!("unknown track_id: {track_id_str}")))?;
        match op {
            Op::SetGainDb { db, .. } => {
                let linear = 10f64.powf(db / 20.0);
                backend
                    .set_control(track.gain.id.clone(), ControlValue::Float(linear))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "track {} gain → {db:+.2} dB",
                    track.name
                )))
            }
            Op::SetMute { muted, .. } => {
                backend
                    .set_control(track.mute.id.clone(), ControlValue::Bool(muted))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("track {} mute={muted}", track.name)))
            }
            Op::SetSolo { soloed, .. } => {
                backend
                    .set_control(track.solo.id.clone(), ControlValue::Bool(soloed))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "track {} solo={soloed}",
                    track.name
                )))
            }
            Op::SetPan { pan, .. } => {
                backend
                    .set_control(track.pan.id.clone(), ControlValue::Float(pan))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "track {} pan → {pan:+.2}",
                    track.name
                )))
            }
            Op::Get { .. } => {
                let gain_linear = track.gain.value.as_f64().unwrap_or(1.0);
                // Match the dB conversion `set_gain_db` uses going the
                // other direction. `linear = 0` would produce `-inf`;
                // floor it at -120 dB which is well below anything
                // anyone would expect to see in a useful mix.
                let gain_db = if gain_linear > 1.0e-6 {
                    20.0 * gain_linear.log10()
                } else {
                    -120.0
                };
                let muted = matches!(track.mute.value, ControlValue::Bool(true));
                let soloed = matches!(track.solo.value, ControlValue::Bool(true));
                let pan = track.pan.value.as_f64().unwrap_or(0.0);
                let summary = format!(
                    "{}  {:+.2} dB{}{}  pan {:+.2}",
                    track.name,
                    gain_db,
                    if muted { "  MUTED" } else { "" },
                    if soloed { "  SOLO" } else { "" },
                    pan,
                );
                Ok(ToolResult::ok(summary).with_data(json!({
                    "id": track.id.as_str(),
                    "name": track.name,
                    "kind": format!("{:?}", track.kind).to_lowercase(),
                    "gain_db": gain_db,
                    "gain_linear": gain_linear,
                    "muted": muted,
                    "soloed": soloed,
                    "pan": pan,
                    "control_ids": {
                        "gain": track.gain.id.as_str(),
                        "mute": track.mute.id.as_str(),
                        "solo": track.solo.id.as_str(),
                        "pan": track.pan.id.as_str(),
                    }
                })))
            }
            Op::Apply { .. }
            | Op::StoreScene { .. }
            | Op::RecallScene { .. }
            | Op::ListScenes
            | Op::DeleteScene { .. }
            | Op::RenameScene { .. } => unreachable!("handled before the match above"),
        }
    }
}

/// Resolve a scene reference to its `EntityId`. Accepts `id` or
/// unique `name`; returns `InvalidArgs` on miss / ambiguity.
fn resolve_scene_id(
    snap: &foyer_schema::Session,
    id: Option<&str>,
    name: Option<&str>,
) -> Result<EntityId, ToolError> {
    if let Some(id) = id {
        if !snap.mixer_scenes.iter().any(|s| s.id.as_str() == id) {
            return Err(ToolError::InvalidArgs(format!("unknown scene id '{id}'")));
        }
        return Ok(EntityId::new(id.to_string()));
    }
    if let Some(name) = name {
        let matches: Vec<_> = snap
            .mixer_scenes
            .iter()
            .filter(|s| s.name.eq_ignore_ascii_case(name))
            .collect();
        match matches.len() {
            0 => Err(ToolError::InvalidArgs(format!(
                "no scene named '{name}' — call mixer.list_scenes"
            ))),
            1 => Ok(matches[0].id.clone()),
            n => Err(ToolError::InvalidArgs(format!(
                "scene name '{name}' is ambiguous ({n} matches) — pass `id` instead"
            ))),
        }
    } else {
        Err(ToolError::InvalidArgs(
            "scene reference: provide `id` or `name`".into(),
        ))
    }
}

/// Walk a batched `apply` payload, validate every track + value, then
/// dispatch each `set_control` against the backend. Pre-validates so a
/// typo in one change doesn't leave the mixer half-applied — same
/// invariant `plugins.set_params` honours.
async fn apply_mixer_changes(
    backend: &dyn foyer_backend::Backend,
    snapshot: &foyer_schema::Session,
    changes: &[MixerChange],
) -> Result<ToolResult, ToolError> {
    if changes.is_empty() {
        return Err(ToolError::InvalidArgs(
            "mixer.apply requires at least one entry in `changes`".into(),
        ));
    }
    if changes.len() > MAX_MIXER_BATCH {
        return Err(ToolError::InvalidArgs(format!(
            "mixer.apply batch size {} exceeds cap of {}",
            changes.len(),
            MAX_MIXER_BATCH,
        )));
    }
    // Resolve every track up front; collect the (control_id, value)
    // pairs we'll actually dispatch.
    let mut planned: Vec<(foyer_schema::EntityId, ControlValue, String)> = Vec::new();
    for ch in changes {
        let track = snapshot
            .tracks
            .iter()
            .find(|t| t.id.as_str() == ch.track_id)
            .ok_or_else(|| ToolError::InvalidArgs(format!("unknown track_id: {}", ch.track_id)))?;
        if ch.gain_db.is_none() && ch.muted.is_none() && ch.soloed.is_none() && ch.pan.is_none() {
            return Err(ToolError::InvalidArgs(format!(
                "mixer.apply change for track '{}' has no fields set — supply at least one \
                 of gain_db, muted, soloed, pan",
                ch.track_id,
            )));
        }
        if let Some(db) = ch.gain_db {
            let linear = 10f64.powf(db / 20.0);
            planned.push((
                track.gain.id.clone(),
                ControlValue::Float(linear),
                format!("{} gain → {db:+.2} dB", track.name),
            ));
        }
        if let Some(m) = ch.muted {
            planned.push((
                track.mute.id.clone(),
                ControlValue::Bool(m),
                format!("{} mute={m}", track.name),
            ));
        }
        if let Some(s) = ch.soloed {
            planned.push((
                track.solo.id.clone(),
                ControlValue::Bool(s),
                format!("{} solo={s}", track.name),
            ));
        }
        if let Some(p) = ch.pan {
            if !(-1.0..=1.0).contains(&p) {
                return Err(ToolError::InvalidArgs(format!(
                    "pan {p} out of range [-1, 1] for track '{}'",
                    ch.track_id,
                )));
            }
            planned.push((
                track.pan.id.clone(),
                ControlValue::Float(p),
                format!("{} pan → {p:+.2}", track.name),
            ));
        }
    }
    let mut applied = Vec::with_capacity(planned.len());
    for (control_id, value, label) in &planned {
        backend
            .set_control(control_id.clone(), value.clone())
            .await
            .map_err(|e| {
                ToolError::Execution(format!(
                    "set_control failed for '{}' (after {} of {} applied): {e}",
                    control_id.as_str(),
                    applied.len(),
                    planned.len(),
                ))
            })?;
        applied.push(label.clone());
    }
    Ok(
        ToolResult::ok(format!("applied {} mix change(s)", applied.len()))
            .with_data(json!({ "applied": applied })),
    )
}
