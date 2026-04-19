//! DAW-agnostic action catalog.
//!
//! Actions are the unit behind menus, command palettes, keyboard shortcuts, and
//! the agent's tool surface. Every host DAW maps its native menu/command system
//! into [`Action`] records; Foyer then renders them however makes sense
//! (menu bar, command-K palette, MCP tool, etc.).

use serde::{Deserialize, Serialize};

use crate::EntityId;

/// Top-level grouping. Clients render categories as menus or palette sections.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionCategory {
    Session,   // open, save, export, new
    Edit,      // undo, redo, cut, copy, paste
    Transport, // play, stop, record, loop, locate
    View,      // switch surfaces, toggle panels
    Track,     // add/remove tracks, freeze, bounce
    Plugin,    // manage plugins
    Settings,  // preferences
    Agent,     // agent-only actions (MCP-invokable)
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Action {
    pub id: EntityId,
    pub label: String,
    pub category: ActionCategory,
    /// Heroicons-style name (matches Patapsco's icon set) or None.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub icon: Option<String>,
    /// Display-only hint, e.g. "Cmd+S". The shim doesn't enforce this.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub shortcut: Option<String>,
    /// Whether this action can currently be invoked (transport-state dependent,
    /// etc.). UIs should gray out disabled actions.
    pub enabled: bool,
    /// Free-text tooltip / description.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_round_trips() {
        let a = Action {
            id: EntityId::new("transport.play"),
            label: "Play".into(),
            category: ActionCategory::Transport,
            icon: Some("play".into()),
            shortcut: Some("Space".into()),
            enabled: true,
            description: None,
        };
        let j = serde_json::to_string(&a).unwrap();
        let back: Action = serde_json::from_str(&j).unwrap();
        assert_eq!(a, back);
    }
}
