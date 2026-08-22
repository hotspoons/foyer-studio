// SPDX-License-Identifier: Apache-2.0
//! Version-agnostic bridge plumbing shared by the v1 and v2 chains.
//!
//! Everything here works in Foyer's own vocabulary
//! (`AgentEvent` / `AgentToolStatus` / tool-name strings); the v1/v2
//! modules translate into their respective schema namespaces at the
//! edge.

use std::collections::HashMap;

/// ACP `ToolKind` hint derived from a Foyer tool invocation. Both
/// schema namespaces carry the same variant set; each module maps
/// this into its own enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KindHint {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Fetch,
    Other,
}

/// Classify a Foyer tool call for client iconography. Foyer tools
/// are polymorphic (`tool` + `subcommand`), so the subcommand does
/// most of the talking; the tool name settles a few whole-domain
/// cases (visualize/spectrum/media produce artifacts → Fetch,
/// scripts.run executes user code → Execute).
pub(crate) fn classify(tool_name: &str, subcommand: &str) -> KindHint {
    match tool_name {
        "visualize" | "spectrum" | "media" | "render" => return KindHint::Fetch,
        "scripts" if subcommand == "run" => return KindHint::Execute,
        _ => {}
    }
    // Read-shaped subcommands across the tool surface.
    const READ: &[&str] = &[
        "list",
        "get",
        "describe",
        "summary",
        "full",
        "show",
        "catalog",
        "capabilities",
        "recents",
        "browse",
        "backends",
        "query",
        "on_track",
        "patches_on_track",
        "channel_config",
        "list_open",
        "list_ports",
        "snapshot",
        "skills",
        "skill",
    ] as _;
    if READ.contains(&subcommand) {
        return KindHint::Read;
    }
    if subcommand.starts_with("search") || subcommand.starts_with("find") {
        return KindHint::Search;
    }
    if subcommand.starts_with("delete")
        || subcommand.starts_with("remove")
        || subcommand.starts_with("clear")
        || subcommand.starts_with("forget")
    {
        return KindHint::Delete;
    }
    if subcommand.starts_with("move") {
        return KindHint::Move;
    }
    if subcommand.is_empty() {
        return KindHint::Other;
    }
    KindHint::Edit
}

/// `"tracks.list"`-style human title for a tool call, plus the
/// parsed subcommand (empty when args aren't object-shaped).
pub(crate) fn call_title(tool_name: &str, args_json: &str) -> (String, String) {
    let subcommand = serde_json::from_str::<serde_json::Value>(args_json)
        .ok()
        .and_then(|v| {
            v.get("subcommand")
                .and_then(|s| s.as_str())
                .map(String::from)
        })
        .unwrap_or_default();
    let title = if subcommand.is_empty() {
        tool_name.to_string()
    } else {
        format!("{tool_name}.{subcommand}")
    };
    (title, subcommand)
}

/// Per-turn registry mapping the runtime's `call_id`s to the tool
/// name + args the assistant record carried. `AgentEvent::ToolUpdate`
/// events reference calls by id only; the assistant `Message` record
/// (which lands first) is where names and args live.
#[derive(Default)]
pub(crate) struct CallBook {
    calls: HashMap<String, CallMeta>,
    /// call_ids already announced to the client as a full ToolCall
    /// (subsequent events go out as updates).
    announced: HashMap<String, ()>,
}

#[derive(Clone)]
pub(crate) struct CallMeta {
    pub title: String,
    pub kind: KindHint,
    pub args_json: String,
}

impl CallBook {
    pub fn register_record(&mut self, record: &foyer_schema::agent::AgentMessageRecord) {
        for call in &record.tool_calls {
            let (title, subcommand) = call_title(&call.tool_name, &call.args_json);
            self.calls.insert(
                call.call_id.clone(),
                CallMeta {
                    title,
                    kind: classify(&call.tool_name, &subcommand),
                    args_json: call.args_json.clone(),
                },
            );
        }
    }

    pub fn meta(&self, call_id: &str) -> CallMeta {
        self.calls.get(call_id).cloned().unwrap_or(CallMeta {
            title: call_id.to_string(),
            kind: KindHint::Other,
            args_json: String::new(),
        })
    }

    /// True the first time a call_id is seen (caller should emit a
    /// full ToolCall); false afterwards (emit an update).
    pub fn announce(&mut self, call_id: &str) -> bool {
        self.announced.insert(call_id.to_string(), ()).is_none()
    }
}

/// Best-effort pretty rendering of a JSON blob for permission
/// descriptions and raw tool output. Falls back to the raw string.
pub(crate) fn pretty_json(raw: &str) -> String {
    serde_json::from_str::<serde_json::Value>(raw)
        .and_then(|v| serde_json::to_string_pretty(&v))
        .unwrap_or_else(|_| raw.to_string())
}
