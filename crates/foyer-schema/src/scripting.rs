// SPDX-License-Identifier: Apache-2.0
//! DAW scripting surface.
//!
//! The shim advertises ScriptingCapabilities so the UI can render a
//! generic script manager + editor without baking in Ardour/Lua
//! specifics. A future Logic / Reaper / Pro Tools shim could declare
//! its own language list (e.g. JS, Python) and its own type taxonomy
//! (e.g. "Smart Tempo Helper", "Track Macro") and the same Script
//! Manager UI would render against it unchanged.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::id::EntityId;

/// Backend-advertised scripting surface. None when the active backend
/// has no scripting layer wired (currently the stub — until we hook
/// real execution into it).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ScriptingCapabilities {
    pub languages: Vec<ScriptLanguage>,
    pub script_types: Vec<ScriptTypeDescriptor>,
    pub features: ScriptingFeatures,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScriptLanguage {
    /// Stable identifier, e.g. `"lua"`. References match
    /// `Script.language`.
    pub id: String,
    /// Human label, e.g. `"Lua 5.4"`.
    pub label: String,
    /// `highlight.js` language id the FE editor should request. Empty
    /// when no highlighting is available (renders as plain text).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub highlight: String,
}

/// One script category exposed by the shim. A descriptor combines
/// taxonomy (label / description so the picker can render it) with
/// behavior flags (hookable, runnable, accepts args) so the editor
/// can offer the right controls.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScriptTypeDescriptor {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// True if scripts of this type fire from a host event; combine
    /// with `hooks`. Examples in Ardour: `editor_hook` and
    /// `session_init`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub hookable: bool,
    /// Available hook names if `hookable`. Free-form strings; the shim
    /// is the source of truth on what's actually wired.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hooks: Vec<String>,
    /// True if scripts of this type can be triggered manually (`run`
    /// command). Editor actions and snippets typically yes; DSP and
    /// hook scripts typically no.
    #[serde(default, skip_serializing_if = "is_false")]
    pub runnable: bool,
    /// True if scripts of this type take a `{name: value}` arg table.
    /// The editor surfaces a key/value input panel when set.
    #[serde(default, skip_serializing_if = "is_false")]
    pub takes_args: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ScriptingFeatures {
    /// Backend supports an enabled/disabled flag per script independent
    /// of deletion. When false the UI hides the enable toggle.
    #[serde(default, skip_serializing_if = "is_false")]
    pub can_disable: bool,
    /// Backend can list scripts that were disabled on upload (Ardour
    /// strips scripts from `.ardour` files uploaded to certain hosts
    /// for security; the base64 payload stays in the file and can be
    /// recovered) — drives the "Recover disabled scripts" affordance.
    #[serde(default, skip_serializing_if = "is_false")]
    pub can_recover_disabled: bool,
    /// True if `run_script` may be invoked manually (in addition to
    /// hook firing). Independent from per-type `runnable`: this
    /// permission gate applies across the whole surface.
    #[serde(default, skip_serializing_if = "is_false")]
    pub can_run_oneshot: bool,
}

/// A single named, persisted script.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Script {
    /// Stable id assigned by the backend on first save. Empty on a
    /// create-flow before round-trip.
    #[serde(default = "empty_entity_id")]
    pub id: EntityId,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// References a `ScriptTypeDescriptor.id` in the live caps.
    pub script_type: String,
    /// References a `ScriptLanguage.id` in the live caps.
    pub language: String,
    #[serde(default = "yes_bool")]
    pub enabled: bool,
    /// The raw source. Whatever the language is, this is the text the
    /// user sees in the editor. The shim is the only thing that knows
    /// how to compile / run it.
    pub body: String,
    /// Per-script positional arg table, used when `takes_args` is set
    /// on the type. Stored as strings; the shim is responsible for
    /// coercing to its own types at registration time.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub args: BTreeMap<String, String>,
    /// Hook binding when `script_type.hookable`. None = unbound.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook: Option<String>,
    /// True when the script was recovered from a disabled-on-upload
    /// payload and has NOT yet been confirmed for re-enable by the
    /// user. The UI surfaces a banner; the backend keeps the script
    /// dormant until `EnableScript` flips this.
    #[serde(default, skip_serializing_if = "is_false")]
    pub disabled_on_upload: bool,
    /// Backend-stamped last-modified — opaque RFC3339 string. Empty
    /// when never persisted.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub updated_at: String,
}

/// Result of a manual `RunScript` call. The shim captures the script's
/// stdout (via the Lua print hook, in Ardour's case) and surfaces any
/// raised error string. The UI logs both in the run-results pane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScriptRunResult {
    pub id: EntityId,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub stdout: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Elapsed time in milliseconds, when the shim measured it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u32>,
}

fn is_false(b: &bool) -> bool {
    !(*b)
}

fn yes_bool() -> bool {
    true
}

fn empty_entity_id() -> EntityId {
    EntityId::new("")
}
