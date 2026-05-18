// SPDX-License-Identifier: Apache-2.0
//! Sections — Foyer's unified primitive replacing markers, ranges,
//! auto-loop, and auto-punch. See `crates/foyer-schema/src/sections.rs`
//! for the data model and `docs/TODO.md` for the design rationale.

use async_trait::async_trait;
use foyer_schema::id::EntityId;
use foyer_schema::sections::SectionPatch;
use foyer_schema::{SectionFlags, TimeArg};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{tempo_map_from_snapshot, Tool, ToolContext, ToolError, ToolResult};

pub struct SectionsTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    List,
    /// Create a section. `end` (polymorphic) is optional — omit for a
    /// 0-length cue / nav marker. `flags.is_loop_target` /
    /// `flags.is_punch_target` are mutually exclusive across all
    /// sections; setting them here clears any other section that
    /// previously held the role.
    Create {
        name: String,
        #[serde(default)]
        start_samples: Option<i64>,
        #[serde(default)]
        start: Option<TimeArg>,
        /// Omit for a cue/marker, set for a range.
        #[serde(default)]
        end_samples: Option<i64>,
        #[serde(default)]
        end: Option<TimeArg>,
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        flags: Option<FlagsArg>,
    },
    Update {
        section_id: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        start_samples: Option<i64>,
        #[serde(default)]
        start: Option<TimeArg>,
        /// `Some(Some(...))` sets the end, `Some(None)` collapses to
        /// a cue, `None` leaves the end alone.
        #[serde(default)]
        end_samples: Option<Option<i64>>,
        #[serde(default)]
        end: Option<TimeArg>,
        #[serde(default)]
        color: Option<Option<String>>,
        #[serde(default)]
        flags: Option<FlagsArg>,
    },
    Delete {
        section_id: String,
    },
    /// Convenience: flip `is_loop_target` on this section, clearing it
    /// on every other section in one go. Doesn't toggle `transport.looping`
    /// — the agent picks whether to turn loop playback on separately.
    SetLoopTarget {
        section_id: String,
    },
    /// Same idea as `set_loop_target` for `is_punch_target`.
    SetPunchTarget {
        section_id: String,
    },
}

/// Mirrors [`SectionFlags`] for partial-update calls — every field
/// defaults to `None` so callers can flip just one role.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct FlagsArg {
    #[serde(default)]
    pub is_loop_target: Option<bool>,
    #[serde(default)]
    pub is_punch_target: Option<bool>,
    #[serde(default)]
    pub is_navigation: Option<bool>,
}

impl FlagsArg {
    fn merge_onto(self, base: SectionFlags) -> SectionFlags {
        SectionFlags {
            is_loop_target: self.is_loop_target.unwrap_or(base.is_loop_target),
            is_punch_target: self.is_punch_target.unwrap_or(base.is_punch_target),
            is_navigation: self.is_navigation.unwrap_or(base.is_navigation),
        }
    }
}

#[async_trait]
impl Tool for SectionsTool {
    fn name(&self) -> &'static str {
        "sections"
    }

    fn description(&self) -> &'static str {
        "Foyer's unified primitive for markers, ranges, auto-loop, and \
         auto-punch. A section is a named (optionally-bounded) span of \
         time with role flags: `is_loop_target` ↔ Ardour auto-loop, \
         `is_punch_target` ↔ Ardour auto-punch, `is_navigation` ↔ \
         appears in nav strip. Time fields accept `_samples` OR \
         polymorphic `start`/`end` (samples|seconds|bbt). Subcommands: \
         list, \
         create(name, start|start_samples, end|end_samples?, color?, flags?) \
            — omit `end`/`end_samples` for a cue (0-length marker), \
         update(section_id, name?, start?, end?, color?, flags?) \
            — for `end_samples` use `Some(null)` to collapse to a cue, \
         delete(section_id), \
         set_loop_target(section_id) — sets is_loop_target on this \
            section and clears it on every other (mutually exclusive role), \
         set_punch_target(section_id) — same shape for punch."
    }

    fn destructive(&self) -> bool {
        true
    }

    fn schema(&self) -> Value {
        let time_schema = json!({
            "type": "object",
            "description": "Polymorphic time — exactly one of samples / seconds / bbt.",
            "properties": {
                "samples": { "type": "integer" },
                "seconds": { "type": "number" },
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
                    "list", "create", "update", "delete",
                    "set_loop_target", "set_punch_target"
                ]},
                "section_id": { "type": "string" },
                "name": { "type": "string" },
                "start_samples": { "type": "integer" },
                "start": time_schema,
                "end_samples": { "type": ["integer", "null"] },
                "end": time_schema,
                "color": { "type": ["string", "null"] },
                "flags": {
                    "type": "object",
                    "properties": {
                        "is_loop_target":  { "type": "boolean" },
                        "is_punch_target": { "type": "boolean" },
                        "is_navigation":   { "type": "boolean" }
                    },
                    "additionalProperties": false
                }
            }
        })
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        let backend = match &op {
            Op::List => ctx.backend()?,
            _ => ctx.backend_with_loaded_session().await?,
        };
        let snap = backend
            .snapshot()
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        let tempo_map = tempo_map_from_snapshot(&snap);
        match op {
            Op::List => {
                let data: Vec<Value> = snap
                    .sections
                    .iter()
                    .map(|s| {
                        json!({
                            "id": s.id.as_str(),
                            "name": s.name,
                            "start_samples": s.start_samples,
                            "end_samples": s.end_samples,
                            "is_cue": s.is_cue(),
                            "length_samples": s.length_samples(),
                            "color": s.color,
                            "flags": {
                                "is_loop_target":  s.flags.is_loop_target,
                                "is_punch_target": s.flags.is_punch_target,
                                "is_navigation":   s.flags.is_navigation,
                            }
                        })
                    })
                    .collect();
                Ok(ToolResult::ok(format!("{} section(s)", data.len()))
                    .with_data(json!({ "sections": data })))
            }
            Op::Create {
                name,
                start_samples,
                start,
                end_samples,
                end,
                color,
                flags,
            } => {
                let start_resolved = match (start, start_samples) {
                    (Some(t), _) => t
                        .to_samples_signed(&tempo_map)
                        .map_err(|e| ToolError::InvalidArgs(format!("start: {e}")))?,
                    (None, Some(s)) => s,
                    (None, None) => {
                        return Err(ToolError::InvalidArgs(
                            "create: provide `start` or `start_samples`".into(),
                        ));
                    }
                };
                let end_resolved = match (end, end_samples) {
                    (Some(t), _) => Some(
                        t.to_samples_signed(&tempo_map)
                            .map_err(|e| ToolError::InvalidArgs(format!("end: {e}")))?,
                    ),
                    (None, Some(e)) => Some(e),
                    (None, None) => None,
                };
                let flags_resolved = flags
                    .map(|f| f.merge_onto(SectionFlags::navigation_only()))
                    .unwrap_or_else(SectionFlags::navigation_only);
                let section = backend
                    .create_section(name, start_resolved, end_resolved, color, flags_resolved)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "created section '{}' ({})",
                    section.name,
                    if section.is_cue() { "cue" } else { "range" }
                ))
                .with_data(
                    serde_json::to_value(&section)
                        .map_err(|e| ToolError::Execution(e.to_string()))?,
                ))
            }
            Op::Update {
                section_id,
                name,
                start_samples,
                start,
                end_samples,
                end,
                color,
                flags,
            } => {
                let start_patch = match (start, start_samples) {
                    (Some(t), _) => Some(
                        t.to_samples_signed(&tempo_map)
                            .map_err(|e| ToolError::InvalidArgs(format!("start: {e}")))?,
                    ),
                    (None, s @ Some(_)) => s,
                    (None, None) => None,
                };
                let end_patch = match (end, end_samples) {
                    (Some(t), _) => Some(Some(
                        t.to_samples_signed(&tempo_map)
                            .map_err(|e| ToolError::InvalidArgs(format!("end: {e}")))?,
                    )),
                    (None, e @ Some(_)) => e,
                    (None, None) => None,
                };
                let existing = snap
                    .sections
                    .iter()
                    .find(|s| s.id.as_str() == section_id)
                    .ok_or_else(|| {
                        ToolError::InvalidArgs(format!("unknown section_id: {section_id}"))
                    })?;
                let flags_patch = flags.map(|f| f.merge_onto(existing.flags));
                let patch = SectionPatch {
                    name,
                    start_samples: start_patch,
                    end_samples: end_patch,
                    color,
                    flags: flags_patch,
                };
                let section = backend
                    .update_section(EntityId::new(section_id.clone()), patch)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(
                    ToolResult::ok(format!("updated section '{}'", section.name)).with_data(
                        serde_json::to_value(&section)
                            .map_err(|e| ToolError::Execution(e.to_string()))?,
                    ),
                )
            }
            Op::Delete { section_id } => {
                backend
                    .delete_section(EntityId::new(section_id.clone()))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("deleted section {section_id}")))
            }
            Op::SetLoopTarget { section_id } => {
                let patch = SectionPatch {
                    flags: Some(SectionFlags {
                        is_loop_target: true,
                        is_punch_target: snap
                            .sections
                            .iter()
                            .find(|s| s.id.as_str() == section_id)
                            .map(|s| s.flags.is_punch_target)
                            .unwrap_or(false),
                        is_navigation: snap
                            .sections
                            .iter()
                            .find(|s| s.id.as_str() == section_id)
                            .map(|s| s.flags.is_navigation)
                            .unwrap_or(true),
                    }),
                    ..Default::default()
                };
                let section = backend
                    .update_section(EntityId::new(section_id.clone()), patch)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "section '{}' is now the loop target",
                    section.name
                )))
            }
            Op::SetPunchTarget { section_id } => {
                let patch = SectionPatch {
                    flags: Some(SectionFlags {
                        is_loop_target: snap
                            .sections
                            .iter()
                            .find(|s| s.id.as_str() == section_id)
                            .map(|s| s.flags.is_loop_target)
                            .unwrap_or(false),
                        is_punch_target: true,
                        is_navigation: snap
                            .sections
                            .iter()
                            .find(|s| s.id.as_str() == section_id)
                            .map(|s| s.flags.is_navigation)
                            .unwrap_or(true),
                    }),
                    ..Default::default()
                };
                let section = backend
                    .update_section(EntityId::new(section_id.clone()), patch)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "section '{}' is now the punch target",
                    section.name
                )))
            }
        }
    }
}
