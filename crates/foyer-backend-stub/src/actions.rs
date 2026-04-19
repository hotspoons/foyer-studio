//! Canned action catalog the stub backend serves up.

use foyer_schema::{Action, ActionCategory, EntityId};

pub(crate) fn catalog() -> Vec<Action> {
    vec![
        // Transport
        mk("transport.play", "Play", ActionCategory::Transport, Some("play"), Some("Space")),
        mk("transport.stop", "Stop", ActionCategory::Transport, Some("stop"), Some("Space")),
        mk("transport.record", "Record", ActionCategory::Transport, Some("record"), Some("R")),
        mk("transport.loop", "Toggle Loop", ActionCategory::Transport, Some("loop"), Some("L")),
        mk("transport.goto_start", "Locate to Start", ActionCategory::Transport, Some("backward"), Some("Home")),
        mk("transport.return_on_stop", "Return to start on stop", ActionCategory::Transport, Some("arrow-path"), None),
        // Session
        mk("session.new", "New Session…", ActionCategory::Session, Some("document-plus"), Some("Cmd+N")),
        mk("session.open", "Open Session…", ActionCategory::Session, Some("folder-open"), Some("Cmd+O")),
        mk("session.save", "Save Session", ActionCategory::Session, Some("document-save"), Some("Cmd+S")),
        mk("session.export", "Export…", ActionCategory::Session, Some("arrow-down-tray"), None),
        // Edit
        mk("edit.undo", "Undo", ActionCategory::Edit, Some("arrow-uturn-left"), Some("Cmd+Z")),
        mk("edit.redo", "Redo", ActionCategory::Edit, Some("arrow-uturn-right"), Some("Cmd+Shift+Z")),
        mk("edit.cut", "Cut", ActionCategory::Edit, Some("scissors"), Some("Cmd+X")),
        mk("edit.copy", "Copy", ActionCategory::Edit, Some("document-duplicate"), Some("Cmd+C")),
        mk("edit.paste", "Paste", ActionCategory::Edit, Some("clipboard"), Some("Cmd+V")),
        // Track
        mk("track.add_audio", "Add Audio Track", ActionCategory::Track, Some("plus"), None),
        mk("track.add_bus", "Add Bus", ActionCategory::Track, Some("plus"), None),
        mk("track.freeze", "Freeze Track", ActionCategory::Track, Some("snowflake"), None),
        // View
        mk("view.mixer", "Mixer", ActionCategory::View, Some("adjustments-horizontal"), Some("F3")),
        mk("view.timeline", "Timeline", ActionCategory::View, Some("list-bullet"), Some("F4")),
        mk("view.plugins", "Plugins", ActionCategory::View, Some("puzzle-piece"), Some("F5")),
        // Plugin
        mk("plugin.rescan", "Rescan Plugins", ActionCategory::Plugin, Some("arrow-path"), None),
        // Settings
        mk("settings.preferences", "Preferences…", ActionCategory::Settings, Some("cog-6-tooth"), Some("Cmd+,")),
    ]
}

fn mk(
    id: &str,
    label: &str,
    category: ActionCategory,
    icon: Option<&str>,
    shortcut: Option<&str>,
) -> Action {
    Action {
        id: EntityId::new(id),
        label: label.into(),
        category,
        icon: icon.map(str::to_string),
        shortcut: shortcut.map(str::to_string),
        enabled: true,
        description: None,
    }
}
