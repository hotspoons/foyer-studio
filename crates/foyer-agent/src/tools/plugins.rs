// SPDX-License-Identifier: Apache-2.0
//! Plugin inventory + manipulation. Read-only subcommands (`catalog`,
//! `on_track`, `describe`) hit the session snapshot. Mutating
//! subcommands route through the Backend trait — same surface the FE
//! uses — so the agent can compose chains end-to-end.

use async_trait::async_trait;
use foyer_schema::id::EntityId;
use foyer_schema::ControlValue;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

pub struct PluginsTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    /// Browse installed plugins. Without a query, the catalog can run
    /// to ~900 entries — pass `query` (matches name / vendor / uri,
    /// case-insensitive) and / or `limit` to narrow it.
    Catalog {
        #[serde(default)]
        query: Option<String>,
        #[serde(default)]
        limit: Option<usize>,
    },
    OnTrack {
        track_id: String,
    },
    /// Full param list for an instantiated plugin — needed before
    /// `set_param` so the agent knows the param's `control_id` plus
    /// its range / scale / enum labels.
    Describe {
        plugin_id: String,
    },
    Insert {
        track_id: String,
        plugin_uri: String,
        #[serde(default)]
        index: Option<u32>,
    },
    Remove {
        plugin_id: String,
    },
    Move {
        plugin_id: String,
        new_index: u32,
    },
    SetBypass {
        plugin_id: String,
        bypassed: bool,
    },
    /// Set a single plugin parameter. `value` is in the parameter's
    /// natural scale (post-curve) — see `describe.params[i].range`
    /// and `scale` for what the model should pick from.
    SetParam {
        control_id: String,
        value: f64,
    },
    /// Enumerate factory + user presets available for a plugin
    /// INSTANCE. The agent supplies the plugin's instance id (from
    /// `on_track` / `describe`); the host queries the LV2/VST/AU
    /// preset bank registered for that plugin's URI and returns
    /// `{uri, name}` rows.
    ListPresets {
        plugin_id: String,
    },
    /// Apply a preset to a plugin instance. `preset_uri` is one of
    /// the values returned by `list_presets`. The host bumps every
    /// parameter the preset specifies; values not mentioned in the
    /// preset are left at whatever the agent / user set them to.
    LoadPreset {
        plugin_id: String,
        preset_uri: String,
    },
    /// Clone an existing plugin INSTANCE (URI + current parameter
    /// values + active preset) onto another track. The host's
    /// `add_plugin(_, _, _, clone_from)` does the heavy lifting —
    /// the new instance comes up with the same state as the source,
    /// so the agent doesn't have to set every parameter manually.
    /// Cross-track ONLY for now; cloning within the same track is
    /// equivalent to `insert` with the same URI.
    Duplicate {
        source_plugin_id: String,
        target_track_id: String,
        #[serde(default)]
        index: Option<u32>,
    },
}

#[async_trait]
impl Tool for PluginsTool {
    fn name(&self) -> &'static str {
        "plugins"
    }

    fn description(&self) -> &'static str {
        "Inspect AND modify the plugin chain. Subcommands: \
         catalog(query?, limit?) (search installed plugins by name / vendor / uri — \
         default cap is 50 results, raise `limit` or refine `query` to narrow), \
         on_track(track_id), \
         describe(plugin_id) (full param list with control_ids + ranges), \
         insert(track_id, plugin_uri, index?), \
         remove(plugin_id), \
         move(plugin_id, new_index), \
         set_bypass(plugin_id, bypassed), \
         set_param(control_id, value), \
         list_presets(plugin_id), \
         load_preset(plugin_id, preset_uri), \
         duplicate(source_plugin_id, target_track_id, index?) — \
         clones URI + current params + active preset to another track."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": { "type": "string",
                    "enum": ["catalog", "on_track", "describe", "insert",
                             "remove", "move", "set_bypass", "set_param",
                             "list_presets", "load_preset", "duplicate"] },
                "track_id": { "type": "string" },
                "plugin_id": { "type": "string" },
                "plugin_uri": { "type": "string" },
                "index": { "type": "integer", "minimum": 0 },
                "new_index": { "type": "integer", "minimum": 0 },
                "bypassed": { "type": "boolean" },
                "control_id": { "type": "string" },
                "value": { "type": "number" },
                "preset_uri": { "type": "string" },
                "source_plugin_id": { "type": "string" },
                "target_track_id": { "type": "string" },
                "query": { "type": "string", "description": "case-insensitive substring match against plugin name / vendor / uri (catalog only)" },
                "limit": { "type": "integer", "minimum": 1, "description": "max plugins returned by catalog (default 50)" }
            }
        })
    }

    fn destructive(&self) -> bool {
        // catalog / on_track / describe are read-only — but the gating
        // is per-call in the engine via the parsed args. Marking the
        // tool destructive errs on the side of asking when the agent
        // mode is `ask`. The destructive flag is a hint for the
        // autonomy gate; read-only callers see no UI prompt.
        true
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        // Catalog / on_track / describe / list_presets all read; the
        // rest mutate the project and need a loaded session.
        let backend = match &op {
            Op::Catalog { .. }
            | Op::OnTrack { .. }
            | Op::Describe { .. }
            | Op::ListPresets { .. } => ctx.backend()?,
            _ => ctx.backend_with_loaded_session().await?,
        };
        match op {
            Op::Catalog { query, limit } => {
                let entries = backend
                    .list_plugins()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                // Default cap — Ardour ships with ~900 installed LV2s
                // out of the box; an unfiltered dump exceeds typical
                // tool-result token budgets. The agent can lift the
                // cap by passing `limit` explicitly.
                const DEFAULT_LIMIT: usize = 50;
                let cap = limit.unwrap_or(DEFAULT_LIMIT).max(1);
                let q = query.as_deref().unwrap_or("").to_lowercase();
                let mut matches: Vec<_> = entries
                    .iter()
                    .filter(|p| {
                        if q.is_empty() {
                            return true;
                        }
                        let hay = format!(
                            "{} {} {}",
                            p.name.to_lowercase(),
                            p.vendor.as_deref().unwrap_or("").to_lowercase(),
                            p.uri.as_deref().unwrap_or("").to_lowercase(),
                        );
                        hay.contains(&q)
                    })
                    .collect();
                let total_matches = matches.len();
                matches.truncate(cap);
                let data: Vec<Value> = matches
                    .iter()
                    .map(|p| {
                        json!({
                            "uri": p.uri,
                            "name": p.name,
                            "format": format!("{:?}", p.format),
                            "vendor": p.vendor,
                        })
                    })
                    .collect();
                let total = entries.len();
                let summary = if q.is_empty() {
                    format!(
                        "showing {}/{} plugins (no query — pass `query` to filter)",
                        data.len(),
                        total
                    )
                } else if total_matches > data.len() {
                    format!(
                        "{} of {} matches for '{}' (refine with a more specific `query` or raise `limit`)",
                        data.len(),
                        total_matches,
                        q
                    )
                } else {
                    format!("{} matches for '{}'", data.len(), q)
                };
                Ok(ToolResult::ok(summary).with_data(json!({
                    "plugins": data,
                    "shown": data.len(),
                    "total_matches": total_matches,
                    "total_in_catalog": total,
                })))
            }
            Op::OnTrack { track_id } => {
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
                    .plugins
                    .iter()
                    .map(|p| {
                        json!({
                            "id": p.id.as_str(),
                            "name": p.name,
                            "uri": p.uri,
                            "bypassed": p.bypassed,
                            "param_count": p.params.len(),
                        })
                    })
                    .collect();
                Ok(
                    ToolResult::ok(format!("{} plugins on track {}", data.len(), t.name))
                        .with_data(json!({ "plugins": data })),
                )
            }
            Op::Describe { plugin_id } => {
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let (track_id, plugin) = snap
                    .tracks
                    .iter()
                    .find_map(|t| {
                        t.plugins
                            .iter()
                            .find(|p| p.id.as_str() == plugin_id)
                            .map(|p| (t.id.clone(), p))
                    })
                    .ok_or_else(|| {
                        ToolError::InvalidArgs(format!("unknown plugin: {plugin_id}"))
                    })?;
                let params: Vec<Value> = plugin
                    .params
                    .iter()
                    .map(|p| {
                        json!({
                            "control_id": p.id.as_str(),
                            "label": p.label,
                            "kind": format!("{:?}", p.kind),
                            "value": p.value,
                            "range": p.range,
                            "scale": format!("{:?}", p.scale),
                            "unit": p.unit,
                            "enum_labels": p.enum_labels,
                            "group": p.group,
                        })
                    })
                    .collect();
                Ok(
                    ToolResult::ok(format!("{} — {} params", plugin.name, params.len())).with_data(
                        json!({
                            "id": plugin.id.as_str(),
                            "track_id": track_id.as_str(),
                            "name": plugin.name,
                            "uri": plugin.uri,
                            "bypassed": plugin.bypassed,
                            "params": params,
                        }),
                    ),
                )
            }
            Op::Insert {
                track_id,
                plugin_uri,
                index,
            } => {
                backend
                    .add_plugin(
                        EntityId::new(track_id.clone()),
                        plugin_uri.clone(),
                        index,
                        None,
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "inserted {plugin_uri} on track {track_id}{}",
                    match index {
                        Some(i) => format!(" @ {i}"),
                        None => String::new(),
                    }
                )))
            }
            Op::Remove { plugin_id } => {
                backend
                    .remove_plugin(EntityId::new(plugin_id.clone()))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("removed plugin {plugin_id}")))
            }
            Op::Move {
                plugin_id,
                new_index,
            } => {
                backend
                    .move_plugin(EntityId::new(plugin_id.clone()), new_index)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "moved plugin {plugin_id} → index {new_index}"
                )))
            }
            Op::SetBypass {
                plugin_id,
                bypassed,
            } => {
                // The bypass switch lives as a normal control on the
                // plugin; the snapshot exposes it as a synthetic
                // `<plugin_id>.bypass` parameter on the host backend.
                // We look it up rather than hard-coding the suffix so
                // backends with a different convention still work.
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let plugin = snap
                    .tracks
                    .iter()
                    .flat_map(|t| t.plugins.iter())
                    .find(|p| p.id.as_str() == plugin_id)
                    .ok_or_else(|| {
                        ToolError::InvalidArgs(format!("unknown plugin: {plugin_id}"))
                    })?;
                // Mirror the snapshot's reported `bypassed` flag by
                // toggling the plugin's enable control. Ardour models
                // this as `Processor::ActiveChanged`: active=!bypassed.
                if let Some(active) = plugin.params.iter().find(|p| {
                    p.label.eq_ignore_ascii_case("enabled")
                        || p.label.eq_ignore_ascii_case("active")
                        || p.id.as_str().ends_with(".active")
                }) {
                    backend
                        .set_control(active.id.clone(), ControlValue::Bool(!bypassed))
                        .await
                        .map_err(|e| ToolError::Execution(e.to_string()))?;
                    Ok(ToolResult::ok(format!("{} bypass={bypassed}", plugin.name)))
                } else {
                    Err(ToolError::Execution(format!(
                        "plugin {plugin_id} has no enable/active control — \
                         backend doesn't expose bypass directly"
                    )))
                }
            }
            Op::SetParam { control_id, value } => {
                // Validate against the live snapshot — the shim
                // happily accepts set_control on bogus ids and drops
                // them silently. Surface that here as InvalidArgs so
                // the agent gets a real "no such param" instead of a
                // fake success. Also nudge into-range so we don't
                // send obvious garbage to Ardour.
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let mut found: Option<&foyer_schema::Parameter> = None;
                'outer: for t in &snap.tracks {
                    for p in &t.plugins {
                        for param in &p.params {
                            if param.id.as_str() == control_id {
                                found = Some(param);
                                break 'outer;
                            }
                        }
                    }
                }
                let param = found.ok_or_else(|| {
                    ToolError::InvalidArgs(format!(
                        "unknown control_id '{control_id}' — call plugins.describe to list \
                         valid control_ids for a given plugin"
                    ))
                })?;
                if let Some([lo, hi]) = param.range {
                    if value < lo || value > hi {
                        return Err(ToolError::InvalidArgs(format!(
                            "value {value} out of range for '{}' [{lo}, {hi}]",
                            param.label
                        )));
                    }
                }
                backend
                    .set_control(
                        EntityId::new(control_id.clone()),
                        ControlValue::Float(value),
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "{} ({}) ← {value}",
                    param.label, control_id
                )))
            }
            Op::ListPresets { plugin_id } => {
                let presets = backend
                    .list_plugin_presets(EntityId::new(plugin_id.clone()))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let data: Vec<Value> = presets
                    .iter()
                    .map(|p| {
                        json!({
                            "id": p.id.as_str(),
                            "name": p.name,
                            "bank": p.bank,
                            "is_factory": p.is_factory,
                        })
                    })
                    .collect();
                Ok(
                    ToolResult::ok(format!("{} presets for {plugin_id}", data.len()))
                        .with_data(json!({ "presets": data })),
                )
            }
            Op::LoadPreset {
                plugin_id,
                preset_uri,
            } => {
                backend
                    .load_plugin_preset(
                        EntityId::new(plugin_id.clone()),
                        EntityId::new(preset_uri.clone()),
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "loaded preset {preset_uri} on {plugin_id}"
                )))
            }
            Op::Duplicate {
                source_plugin_id,
                target_track_id,
                index,
            } => {
                // Resolve the source plugin's URI from the live snapshot so
                // the host's `add_plugin(..., clone_from)` can both spin up
                // the same plugin type AND copy its current params + active
                // preset off the source instance — exactly the "agent
                // doesn't have to set every param manually" workflow.
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let source = snap
                    .tracks
                    .iter()
                    .flat_map(|t| t.plugins.iter())
                    .find(|p| p.id.as_str() == source_plugin_id)
                    .ok_or_else(|| {
                        ToolError::InvalidArgs(format!("unknown source plugin: {source_plugin_id}"))
                    })?;
                let plugin_uri = source.uri.clone().ok_or_else(|| {
                    ToolError::Execution(format!(
                        "source plugin {source_plugin_id} has no URI exposed — \
                         host can't reconstruct it"
                    ))
                })?;
                let name = source.name.clone();
                backend
                    .add_plugin(
                        EntityId::new(target_track_id.clone()),
                        plugin_uri,
                        index,
                        Some(EntityId::new(source_plugin_id.clone())),
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "duplicated {source_plugin_id} ({name}) → track {target_track_id}"
                )))
            }
        }
    }
}
