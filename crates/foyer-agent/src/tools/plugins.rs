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

/// One entry in a `set_params` / `insert.params` batch. Address the
/// target param by EITHER `control_id` (stable, fully-qualified —
/// e.g. `plugin.<id>.cutoff`), OR `name` (display label or symbol,
/// case-insensitive — what a user would type), OR `index` (positional
/// — survives plugin renames). The resolver picks the first one set;
/// supplying more than one is rejected as ambiguous.
#[derive(Debug, Deserialize)]
pub struct ParamChange {
    #[serde(default)]
    pub control_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub index: Option<u32>,
    pub value: f64,
}

impl ParamChange {
    /// How many addressing fields are set. The validator wants exactly 1.
    fn populated(&self) -> usize {
        usize::from(self.control_id.is_some())
            + usize::from(self.name.is_some())
            + usize::from(self.index.is_some())
    }
}

/// Resolve a [`ParamChange`] to the live `control_id` on a specific
/// plugin instance. Returns `InvalidArgs` if zero / multiple fields
/// are set, or if the lookup misses.
fn resolve_param_id(
    change: &ParamChange,
    plugin: &foyer_schema::PluginInstance,
) -> Result<EntityId, ToolError> {
    match change.populated() {
        0 => {
            return Err(ToolError::InvalidArgs(
                "param: provide one of `control_id`, `name`, or `index`".into(),
            ));
        }
        n if n > 1 => {
            return Err(ToolError::InvalidArgs(format!(
                "param: provide exactly one of {{control_id, name, index}} — got {n}"
            )));
        }
        _ => {}
    };
    if let Some(cid) = change.control_id.as_deref() {
        // Verify the control_id actually belongs to this plugin —
        // otherwise the shim would silently drop the set_control.
        if !plugin.params.iter().any(|p| p.id.as_str() == cid) {
            return Err(ToolError::InvalidArgs(format!(
                "param control_id '{cid}' is not on plugin '{}' — \
                 call plugins.describe for the live param list",
                plugin.id.as_str()
            )));
        }
        return Ok(EntityId::new(cid.to_string()));
    }
    if let Some(name) = change.name.as_deref() {
        // Match against label first (most common — that's what the
        // user sees in the UI), then the id's last segment as a
        // fallback for plugins that expose param symbols.
        let n = name.to_lowercase();
        let hit = plugin.params.iter().find(|p| {
            p.label.eq_ignore_ascii_case(name)
                || p.label.to_lowercase().contains(&n)
                || p.id
                    .as_str()
                    .split('.')
                    .next_back()
                    .is_some_and(|s| s.eq_ignore_ascii_case(name))
        });
        return hit.map(|p| p.id.clone()).ok_or_else(|| {
            ToolError::InvalidArgs(format!(
                "param '{name}' not found on plugin '{}' — \
                 call plugins.describe for valid labels",
                plugin.id.as_str()
            ))
        });
    }
    if let Some(idx) = change.index {
        return plugin
            .params
            .get(idx as usize)
            .map(|p| p.id.clone())
            .ok_or_else(|| {
                ToolError::InvalidArgs(format!(
                    "param index {idx} out of range — plugin '{}' has {} params",
                    plugin.id.as_str(),
                    plugin.params.len()
                ))
            });
    }
    unreachable!()
}

/// Server-side cap on a single `set_params` batch. 256 is generous
/// enough for any realistic synth patch (synthv1 / amsynth top out
/// around 80) while still bounded enough that a runaway model can't
/// flood the WS with one tool call.
const MAX_SET_PARAMS_BATCH: usize = 256;

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
    /// Insert a plugin onto a track, optionally pre-loading parameter
    /// values + a preset in one atomic call. The `params` array lets
    /// the agent ship a fully-configured plugin in one round-trip
    /// instead of insert → describe → set_param × N. Param addressing
    /// is polymorphic (control_id | name | index). If both `params`
    /// and `preset_uri` are set, the preset is applied FIRST then the
    /// explicit params layer on top — same semantics as the UI's
    /// "load preset, then tweak" flow.
    Insert {
        track_id: String,
        plugin_uri: String,
        #[serde(default)]
        index: Option<u32>,
        #[serde(default)]
        params: Option<Vec<ParamChange>>,
        #[serde(default)]
        preset_uri: Option<String>,
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
    /// and `scale` for what the model should pick from. Address the
    /// param by `control_id` (legacy / fully-qualified) OR by
    /// `plugin_id` + (`name` | `index`).
    SetParam {
        #[serde(default)]
        control_id: Option<String>,
        #[serde(default)]
        plugin_id: Option<String>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        index: Option<u32>,
        value: f64,
    },
    /// Bulk parameter set against ONE plugin. Equivalent to N
    /// `set_param` calls but with a single tool round-trip + a single
    /// validation snapshot lookup. Hit this when programming a synth
    /// patch by hand — Rich's session log showed an agent firing
    /// ~30 set_param calls in a row to dial in a synthv1 sound.
    /// Capped at 256 params per call (the same backend can only push
    /// so many ControlSet messages per WS frame before back-pressure
    /// kicks in; chunk further client-side if you need more).
    /// All params must belong to `plugin_id` — the validator rejects
    /// the whole batch if any control_id doesn't resolve to a
    /// parameter on that plugin instance.
    SetParams {
        plugin_id: String,
        params: Vec<ParamChange>,
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
        "Inspect AND modify the plugin chain. Param addressing is \
         polymorphic — every param-targeting field accepts {control_id} \
         OR {plugin_id + name} OR {plugin_id + index}. Subcommands: \
         catalog(query?, limit?) (search installed plugins; default cap 50), \
         on_track(track_id), \
         describe(plugin_id) — full param list with control_ids + ranges + \
            scales + enum labels + current values, \
         insert(track_id, plugin_uri, index?, params?:[…], preset_uri?) — \
            atomic insert + preset + per-param set in one undo group, \
         remove(plugin_id), \
         move(plugin_id, new_index), \
         set_bypass(plugin_id, bypassed), \
         set_param(control_id | (plugin_id + name|index), value), \
         set_params(plugin_id, params:[{control_id|name|index, value}…]) — \
            BATCHED, prefer this when programming a synth patch, \
         list_presets(plugin_id), \
         load_preset(plugin_id, preset_uri), \
         duplicate(source_plugin_id, target_track_id, index?)."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": { "type": "string",
                    "enum": ["catalog", "on_track", "describe", "insert",
                             "remove", "move", "set_bypass", "set_param",
                             "set_params",
                             "list_presets", "load_preset", "duplicate"] },
                "params": {
                    "type": "array",
                    "description": "set_params / insert.params: list of {address, value} pairs against one plugin. Address EACH entry by exactly one of `control_id`, `name`, or `index`.",
                    "items": {
                        "type": "object",
                        "required": ["value"],
                        "properties": {
                            "control_id": { "type": "string" },
                            "name": { "type": "string", "description": "Display label or symbol — case-insensitive." },
                            "index": { "type": "integer", "minimum": 0, "description": "Positional index in the plugin's param list." },
                            "value": { "type": "number" }
                        }
                    }
                },
                "track_id": { "type": "string" },
                "plugin_id": { "type": "string" },
                "plugin_uri": { "type": "string" },
                "index": { "type": "integer", "minimum": 0 },
                "new_index": { "type": "integer", "minimum": 0 },
                "bypassed": { "type": "boolean" },
                "control_id": { "type": "string" },
                "name": { "type": "string", "description": "set_param: param label/symbol when addressing by name." },
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
                params,
                preset_uri,
            } => {
                // Wrap the whole insert + preset + params batch in one
                // undo group so a Ctrl-Z unwinds the entire configured
                // plugin instead of just the params layer.
                let _ = backend
                    .undo_group_begin(format!("Insert {plugin_uri}"))
                    .await;
                let insert_res = backend
                    .add_plugin(
                        EntityId::new(track_id.clone()),
                        plugin_uri.clone(),
                        index,
                        None,
                    )
                    .await;
                if let Err(e) = insert_res {
                    let _ = backend.undo_group_end().await;
                    return Err(ToolError::Execution(e.to_string()));
                }
                // Locate the just-inserted plugin id by re-snapshotting
                // and finding the last plugin on the track that matches
                // the URI — host doesn't return the id from add_plugin
                // directly.
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let track = snap
                    .tracks
                    .iter()
                    .find(|t| t.id.as_str() == track_id)
                    .ok_or_else(|| {
                        ToolError::Execution(format!(
                            "track {track_id} disappeared between insert and snapshot"
                        ))
                    })?;
                let plugin = track
                    .plugins
                    .iter()
                    .rev()
                    .find(|p| p.uri.as_deref() == Some(plugin_uri.as_str()))
                    .ok_or_else(|| {
                        ToolError::Execution(format!(
                            "could not locate inserted plugin '{plugin_uri}' on track {track_id} \
                             — check the host's plugins_list echo"
                        ))
                    })?;
                let pid = plugin.id.clone();
                // Optional preset application — first, so the explicit
                // `params` overlay always wins.
                if let Some(preset) = preset_uri.as_deref() {
                    backend
                        .load_plugin_preset(pid.clone(), EntityId::new(preset.to_string()))
                        .await
                        .map_err(|e| ToolError::Execution(e.to_string()))?;
                }
                let mut applied = 0usize;
                if let Some(params) = params {
                    if params.len() > MAX_SET_PARAMS_BATCH {
                        let _ = backend.undo_group_end().await;
                        return Err(ToolError::InvalidArgs(format!(
                            "insert.params batch size {} exceeds cap of {}",
                            params.len(),
                            MAX_SET_PARAMS_BATCH,
                        )));
                    }
                    for change in &params {
                        let cid = match resolve_param_id(change, plugin) {
                            Ok(c) => c,
                            Err(e) => {
                                let _ = backend.undo_group_end().await;
                                return Err(e);
                            }
                        };
                        if let Err(e) = backend
                            .set_control(cid, ControlValue::Float(change.value))
                            .await
                        {
                            let _ = backend.undo_group_end().await;
                            return Err(ToolError::Execution(e.to_string()));
                        }
                        applied += 1;
                    }
                }
                let _ = backend.undo_group_end().await;
                Ok(ToolResult::ok(format!(
                    "inserted {plugin_uri} on track {track_id}{}{}{}",
                    match index {
                        Some(i) => format!(" @ {i}"),
                        None => String::new(),
                    },
                    if let Some(p) = preset_uri.as_deref() {
                        format!(" · preset '{p}'")
                    } else {
                        String::new()
                    },
                    if applied > 0 {
                        format!(" · {applied} params set")
                    } else {
                        String::new()
                    },
                ))
                .with_data(json!({
                    "plugin_id": pid.as_str(),
                    "params_applied": applied,
                })))
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
            Op::SetParam {
                control_id,
                plugin_id,
                name,
                index,
                value,
            } => {
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
                let (resolved_id, label, range) = if let Some(cid) = control_id.as_deref() {
                    // Legacy path — direct control_id; locate the
                    // parameter on whatever plugin owns it.
                    let mut found: Option<&foyer_schema::Parameter> = None;
                    'outer: for t in &snap.tracks {
                        for p in &t.plugins {
                            for param in &p.params {
                                if param.id.as_str() == cid {
                                    found = Some(param);
                                    break 'outer;
                                }
                            }
                        }
                    }
                    let param = found.ok_or_else(|| {
                        ToolError::InvalidArgs(format!(
                            "unknown control_id '{cid}' — call plugins.describe to list \
                             valid control_ids for a given plugin"
                        ))
                    })?;
                    (
                        EntityId::new(cid.to_string()),
                        param.label.clone(),
                        param.range,
                    )
                } else {
                    // New path — address by plugin_id + (name | index).
                    let pid = plugin_id.as_deref().ok_or_else(|| {
                        ToolError::InvalidArgs(
                            "set_param: provide `control_id`, or `plugin_id` + (`name`|`index`)"
                                .into(),
                        )
                    })?;
                    let plugin = snap
                        .tracks
                        .iter()
                        .flat_map(|t| t.plugins.iter())
                        .find(|p| p.id.as_str() == pid)
                        .ok_or_else(|| {
                            ToolError::InvalidArgs(format!("unknown plugin_id '{pid}'"))
                        })?;
                    let change = ParamChange {
                        control_id: None,
                        name: name.clone(),
                        index,
                        value,
                    };
                    let cid = resolve_param_id(&change, plugin)?;
                    let param = plugin
                        .params
                        .iter()
                        .find(|p| p.id.as_str() == cid.as_str())
                        .expect("resolve_param_id returned id not on plugin (BUG)");
                    (cid, param.label.clone(), param.range)
                };
                if let Some([lo, hi]) = range {
                    if value < lo || value > hi {
                        return Err(ToolError::InvalidArgs(format!(
                            "value {value} out of range for '{label}' [{lo}, {hi}]",
                        )));
                    }
                }
                backend
                    .set_control(resolved_id.clone(), ControlValue::Float(value))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "{label} ({}) ← {value}",
                    resolved_id.as_str()
                )))
            }
            Op::SetParams { plugin_id, params } => {
                if params.is_empty() {
                    return Err(ToolError::InvalidArgs(
                        "set_params requires at least one entry in `params`".into(),
                    ));
                }
                if params.len() > MAX_SET_PARAMS_BATCH {
                    return Err(ToolError::InvalidArgs(format!(
                        "set_params batch size {} exceeds cap of {}",
                        params.len(),
                        MAX_SET_PARAMS_BATCH,
                    )));
                }
                // One snapshot for the whole batch — saves the
                // N round-trips through `set_param` (which each
                // re-fetched the snapshot for its own validation).
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
                        ToolError::InvalidArgs(format!(
                            "unknown plugin_id '{plugin_id}' — call plugins.on_track to list \
                             plugins on each track"
                        ))
                    })?;
                // Pre-validate everything BEFORE issuing any
                // set_controls. Half-applying a patch leaves the
                // plugin in a worse state than not touching it,
                // which is the opposite of what Stop-and-retry
                // expects. Address can be `control_id`, `name`, or
                // `index` (mutually exclusive).
                let mut resolved = Vec::with_capacity(params.len());
                for change in &params {
                    let cid = resolve_param_id(change, plugin)?;
                    let param = plugin
                        .params
                        .iter()
                        .find(|p| p.id == cid)
                        .expect("resolve_param_id returned id not on plugin (BUG)");
                    if let Some([lo, hi]) = param.range {
                        if change.value < lo || change.value > hi {
                            return Err(ToolError::InvalidArgs(format!(
                                "value {} out of range for '{}' [{lo}, {hi}]",
                                change.value, param.label,
                            )));
                        }
                    }
                    resolved.push((cid.as_str().to_string(), change.value, param.label.clone()));
                }
                // Apply. We could parallelise with `join_all` here,
                // but most backends serialise set_control on the
                // shim's event loop anyway — concurrent dispatch
                // wouldn't reduce wall time. Sequential keeps the
                // error reporting tractable too (we know which one
                // failed).
                let mut applied = Vec::with_capacity(resolved.len());
                for (control_id, value, label) in &resolved {
                    backend
                        .set_control(
                            EntityId::new(control_id.clone()),
                            ControlValue::Float(*value),
                        )
                        .await
                        .map_err(|e| {
                            ToolError::Execution(format!(
                                "set_control failed for '{control_id}' (after {} of {} \
                                 already applied): {e}",
                                applied.len(),
                                resolved.len(),
                            ))
                        })?;
                    applied.push(json!({
                        "control_id": control_id,
                        "label": label,
                        "value": value,
                    }));
                }
                Ok(
                    ToolResult::ok(format!("{} ← {} params", plugin.name, applied.len()))
                        .with_data(json!({
                            "plugin_id": plugin_id,
                            "applied": applied,
                        })),
                )
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
