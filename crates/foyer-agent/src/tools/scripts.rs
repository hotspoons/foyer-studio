// SPDX-License-Identifier: Apache-2.0
//! DAW scripting — list / get / save / delete / run scripts.
//!
//! Surfaces whatever the active backend advertises. The shim
//! advertises the type taxonomy (DSP, EditorAction, EditorHook, …)
//! and the language list (`lua`, …) in `Session.scripting`; this
//! tool is host-agnostic and the agent can call `capabilities` first
//! to see what's available before authoring.

use std::collections::BTreeMap;
use std::sync::Weak;

use async_trait::async_trait;
use foyer_schema::{EntityId, Script};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::store::AgentStore;
use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

/// Surfaces both the backend's scripting catalog AND the harness's
/// agent-skill store (authoring playbooks for plugins, MIDI, regions,
/// Lua DSP, etc.). Skills live in the agent store; bodies are loaded
/// on demand so they don't bloat every external client's context the
/// way they did when welcome shipped them inline.
pub struct ScriptsTool {
    store: Option<Weak<AgentStore>>,
}

impl ScriptsTool {
    /// Default constructor used by `default_registry()` for unit tests
    /// and the stub MCP. Skills subcommands return an empty manifest
    /// when no store is attached.
    pub fn without_store() -> Self {
        Self { store: None }
    }

    /// Constructor used by the live runtime. The weak ref drops cleanly
    /// when the runtime shuts down, so the tool registry doesn't keep
    /// the store alive past its natural lifetime.
    pub fn with_store(store: Weak<AgentStore>) -> Self {
        Self { store: Some(store) }
    }
}

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
    /// List the harness's agent-skill manifest (name + summary +
    /// approx token count for each enabled playbook). Skill bodies
    /// document the recommended call shapes for each domain — read
    /// the relevant one BEFORE driving an unfamiliar tool. Bodies are
    /// fetched separately via `skill { name }` to keep the manifest
    /// cheap.
    Skills,
    /// Fetch one skill's full body from the harness store. Pair with
    /// `skills` to discover names. The body is markdown with an
    /// `enabled: true|false` frontmatter line.
    Skill { name: String },
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
        "Author + run DAW scripts AND fetch agent-skill playbooks. \
         Two surfaces: \
         (1) DAW scripts (Lua in Ardour; other shims may advertise other \
         languages): capabilities, list, get(id), save(...), delete(id), \
         enable(id, enabled), run(id, args_override?), recover_disabled. \
         Always call `capabilities` first when authoring — DSP-type scripts \
         produce Lua plugins that show up alongside native plugins. \
         (2) Agent skills (task-oriented playbooks the harness ships for \
         small models): `skills` lists every enabled playbook (name + \
         one-line summary + token count); `skill { name }` returns the full \
         markdown body. READ THE RELEVANT SKILL FIRST before driving an \
         unfamiliar tool (plugins, midi, sequencer, automation, ui, \
         visualize, session) — playbooks document the exact call shapes \
         and the batch-vs-loop tradeoffs that small models otherwise miss."
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
                        "skills", "skill",
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
        // Skill subcommands hit the harness's agent-skill store, NOT
        // the backend's script catalog — they should still work when
        // no DAW is loaded (e.g. the agent has been asked "what skills
        // do you have?" before opening a project).
        match &op {
            Op::Skills => {
                let store = self
                    .store
                    .as_ref()
                    .and_then(|w| w.upgrade())
                    .ok_or_else(|| {
                        ToolError::Execution(
                            "agent skill store is not attached to this runtime".into(),
                        )
                    })?;
                let infos = store
                    .list_skills()
                    .await
                    .map_err(|e| ToolError::Execution(format!("listing skills failed: {e}")))?;
                let enabled: Vec<Value> = infos
                    .into_iter()
                    .filter(|s| s.enabled)
                    .map(|s| {
                        json!({
                            "name": s.name,
                            "summary": s.summary,
                            "tokens_approx": s.tokens_approx,
                        })
                    })
                    .collect();
                return Ok(
                    ToolResult::ok(format!("{} enabled skill(s)", enabled.len()))
                        .with_data(json!({ "skills": enabled })),
                );
            }
            Op::Skill { name } => {
                let store = self
                    .store
                    .as_ref()
                    .and_then(|w| w.upgrade())
                    .ok_or_else(|| {
                        ToolError::Execution(
                            "agent skill store is not attached to this runtime".into(),
                        )
                    })?;
                let body = store
                    .read_skill_body(name)
                    .await
                    .map_err(|e| ToolError::Execution(format!("reading skill '{name}': {e}")))?;
                return Ok(ToolResult::ok(format!("{name} ({} bytes)", body.len()))
                    .with_data(json!({ "name": name, "body": body })));
            }
            _ => {}
        }
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
            // Handled in the pre-backend dispatch above.
            Op::Skills | Op::Skill { .. } => unreachable!(),
        }
    }
}
