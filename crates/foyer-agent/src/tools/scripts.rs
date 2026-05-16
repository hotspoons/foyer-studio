// SPDX-License-Identifier: Apache-2.0
//! DAW scripting — list / get / save / delete / run scripts.
//!
//! Surfaces whatever the active backend advertises. The shim
//! advertises the type taxonomy (DSP, EditorAction, EditorHook, …)
//! and the language list (`lua`, …) in `Session.scripting`; this
//! tool is host-agnostic and the agent can call `capabilities` first
//! to see what's available before authoring.

use std::collections::BTreeMap;

use async_trait::async_trait;
use foyer_schema::{EntityId, Script};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

pub struct ScriptsTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    /// Report the backend's advertised scripting surface — script
    /// types, languages, hooks, and feature flags. Always call this
    /// first when authoring a new script.
    Capabilities,
    /// List every persisted script. Returns name, type, language,
    /// enabled, hook, and metadata — NOT the body (use `get` for
    /// that, to keep large bodies out of the agent's prompt unless
    /// asked for).
    List,
    /// Fetch one script's full record including the source body.
    Get { id: String },
    /// Insert or update a script. Pass `id` empty (or omit it) to
    /// create. Returns the canonical post-save shape.
    Save {
        #[serde(default)]
        id: String,
        name: String,
        #[serde(default)]
        description: String,
        script_type: String,
        language: String,
        #[serde(default = "yes_bool")]
        enabled: bool,
        body: String,
        #[serde(default)]
        args: BTreeMap<String, String>,
        #[serde(default)]
        hook: Option<String>,
    },
    /// Delete a script by id. Idempotent.
    Delete { id: String },
    /// Flip the enabled flag without touching the body. Use to
    /// confirm a `disabled_on_upload` script after audit.
    Enable { id: String, enabled: bool },
    /// Manually invoke a runnable script.
    Run {
        id: String,
        #[serde(default)]
        args_override: Option<BTreeMap<String, String>>,
    },
    /// Scan the project file for scripts that were stripped to
    /// disabled state on upload (recovered with the
    /// `disabled_on_upload` flag set so the user can re-confirm).
    RecoverDisabled,
}

fn yes_bool() -> bool {
    true
}

#[async_trait]
impl Tool for ScriptsTool {
    fn name(&self) -> &'static str {
        "scripts"
    }

    fn description(&self) -> &'static str {
        "Author and run DAW scripts (Lua in Ardour; other shims may \
         advertise other languages). Subcommands: capabilities (advertised \
         types/languages/hooks), list, get(id), save(...), delete(id), \
         enable(id, enabled), run(id, args_override?), recover_disabled. \
         Always call `capabilities` first when authoring — the backend \
         picks the type taxonomy and hook names; do not assume Ardour \
         names without confirming. DSP-type scripts produce Lua-authored \
         audio plugins that show up alongside native plugins."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": {
                    "type": "string",
                    "enum": [
                        "capabilities", "list", "get", "save",
                        "delete", "enable", "run", "recover_disabled",
                    ]
                },
                "id": { "type": "string" },
                "name": { "type": "string" },
                "description": { "type": "string" },
                "script_type": {
                    "type": "string",
                    "description": "Must match a `ScriptTypeDescriptor.id` from `capabilities` (e.g. `editor_action`, `dsp`)."
                },
                "language": {
                    "type": "string",
                    "description": "Must match a `ScriptLanguage.id` from `capabilities` (e.g. `lua`)."
                },
                "enabled": { "type": "boolean" },
                "body": { "type": "string" },
                "hook": {
                    "type": ["string", "null"],
                    "description": "Hook name when `script_type.hookable`; pick from `capabilities.script_types[*].hooks`."
                },
                "args": {
                    "type": "object",
                    "additionalProperties": { "type": "string" }
                },
                "args_override": {
                    "type": ["object", "null"],
                    "additionalProperties": { "type": "string" }
                }
            }
        })
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        let backend = ctx.backend()?;
        match op {
            Op::Capabilities => {
                let caps = backend
                    .scripting_capabilities()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                match caps {
                    Some(c) => Ok(ToolResult::ok(format!(
                        "{} languages, {} script types",
                        c.languages.len(),
                        c.script_types.len()
                    ))
                    .with_data(serde_json::to_value(c).unwrap_or(Value::Null))),
                    None => Ok(ToolResult::ok(
                        "active backend does not advertise a scripting surface",
                    )),
                }
            }
            Op::List => {
                let scripts = backend
                    .list_scripts()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                // Strip bodies so listings stay compact.
                let summary: Vec<Value> = scripts
                    .iter()
                    .map(|s| {
                        json!({
                            "id": s.id,
                            "name": s.name,
                            "script_type": s.script_type,
                            "language": s.language,
                            "enabled": s.enabled,
                            "hook": s.hook,
                            "disabled_on_upload": s.disabled_on_upload,
                            "description": s.description,
                            "body_bytes": s.body.len(),
                        })
                    })
                    .collect();
                Ok(ToolResult::ok(format!("{} scripts", scripts.len()))
                    .with_data(json!({ "scripts": summary })))
            }
            Op::Get { id } => {
                let scripts = backend
                    .list_scripts()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let s = scripts
                    .into_iter()
                    .find(|s| s.id.as_str() == id)
                    .ok_or_else(|| ToolError::InvalidArgs(format!("unknown script: {id}")))?;
                Ok(ToolResult::ok(format!(
                    "{} ({}, {} bytes)",
                    s.name,
                    s.script_type,
                    s.body.len()
                ))
                .with_data(serde_json::to_value(s).unwrap_or(Value::Null)))
            }
            Op::Save {
                id,
                name,
                description,
                script_type,
                language,
                enabled,
                body,
                args,
                hook,
            } => {
                // Validate against the live caps so a typo doesn't get
                // silently saved. The shim is the source of truth.
                let caps = backend
                    .scripting_capabilities()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?
                    .ok_or_else(|| {
                        ToolError::Execution("active backend has no scripting surface".into())
                    })?;
                if !caps.languages.iter().any(|l| l.id == language) {
                    return Err(ToolError::InvalidArgs(format!(
                        "unknown language: {language}. Available: {}",
                        caps.languages
                            .iter()
                            .map(|l| l.id.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )));
                }
                let td = caps
                    .script_types
                    .iter()
                    .find(|t| t.id == script_type)
                    .ok_or_else(|| {
                        ToolError::InvalidArgs(format!(
                            "unknown script_type: {script_type}. Available: {}",
                            caps.script_types
                                .iter()
                                .map(|t| t.id.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        ))
                    })?;
                if let Some(ref h) = hook {
                    if !td.hookable {
                        return Err(ToolError::InvalidArgs(format!(
                            "script_type {script_type} is not hookable; drop `hook`",
                        )));
                    }
                    if !td.hooks.iter().any(|x| x == h) {
                        return Err(ToolError::InvalidArgs(format!(
                            "unknown hook for {script_type}: {h}. Available: {}",
                            td.hooks.join(", ")
                        )));
                    }
                }
                let script = Script {
                    id: EntityId::new(id),
                    name,
                    description,
                    script_type,
                    language,
                    enabled,
                    body,
                    args,
                    hook,
                    disabled_on_upload: false,
                    updated_at: 0,
                };
                let saved = backend
                    .save_script(script)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("saved {}", saved.id))
                    .with_data(serde_json::to_value(saved).unwrap_or(Value::Null)))
            }
            Op::Delete { id } => {
                backend
                    .delete_script(EntityId::new(id.clone()))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("deleted {id}")))
            }
            Op::Enable { id, enabled } => {
                let saved = backend
                    .enable_script(EntityId::new(id), enabled)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "{} {}",
                    if enabled { "enabled" } else { "disabled" },
                    saved.id
                ))
                .with_data(serde_json::to_value(saved).unwrap_or(Value::Null)))
            }
            Op::Run { id, args_override } => {
                let result = backend
                    .run_script(EntityId::new(id), args_override)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let summary = if result.ok {
                    format!("ran {} ({} ms)", result.id, result.elapsed_ms.unwrap_or(0))
                } else {
                    format!(
                        "run failed: {}",
                        result.error.clone().unwrap_or_else(|| "unknown".into())
                    )
                };
                Ok(ToolResult::ok(summary)
                    .with_data(serde_json::to_value(result).unwrap_or(Value::Null)))
            }
            Op::RecoverDisabled => {
                let recovered = backend
                    .recover_disabled_scripts()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "recovered {} disabled-on-upload script(s)",
                    recovered.len()
                ))
                .with_data(json!({
                    "recovered_ids": recovered.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
                })))
            }
        }
    }
}
