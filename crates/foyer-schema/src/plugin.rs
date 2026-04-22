//! Plugin catalog — what plugins are installed/available on the host.
//!
//! Separate from [`crate::PluginInstance`], which describes a plugin already
//! inserted on a track. This catalog type describes plugins the user can choose
//! to insert.

use serde::{Deserialize, Serialize};

use crate::EntityId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginFormat {
    Lv2,
    Vst2,
    Vst3,
    Au,
    Ladspa,
    Lua,
    Internal,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginRole {
    Effect,
    Instrument,
    Generator,
    Analyzer,
    Utility,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginCatalogEntry {
    pub id: EntityId,
    pub name: String,
    pub format: PluginFormat,
    pub role: PluginRole,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub vendor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub uri: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub tags: Vec<String>,
}

/// One preset a plugin instance knows about. The `id` is opaque to the
/// sidecar — only the host (or the plugin itself) knows how to apply it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginPreset {
    pub id: EntityId,
    pub name: String,
    /// Optional bank or category ("Factory" / "User" / "Pads").
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub bank: Option<String>,
    /// True when this is the plugin's built-in / factory preset, as
    /// opposed to a user-saved one. UIs usually render these separately.
    #[serde(default)]
    pub is_factory: bool,
}
