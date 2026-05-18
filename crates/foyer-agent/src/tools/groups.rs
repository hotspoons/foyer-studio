// SPDX-License-Identifier: Apache-2.0
//! Group / submix management.
//!
//! Groups in Ardour (and Foyer) bundle multiple tracks under one
//! shared gesture: move the gain on one member, the whole group
//! moves; toggle mute on one, all members mute. Distinct from
//! routing-busses — a group doesn't sum audio, it just linksgestures
//! across members.
//!
//! Wire commands `CreateGroup` / `UpdateGroup` / `DeleteGroup` were
//! already plumbed through the server before this tool existed; this
//! file is the agent surface that maps onto them.

use async_trait::async_trait;
use foyer_schema::{session::GroupPatch, EntityId};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

pub struct GroupsTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    /// Enumerate all groups in the current session.
    List,
    /// Create a new group / submix. `members` is optional; tracks can
    /// be added later via `add_members` or by `tracks.update { group_id }`.
    Create {
        name: String,
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        members: Vec<String>,
    },
    /// Patch fields on an existing group. Pass only what should change;
    /// omitted fields are left alone. `members` replaces the list
    /// wholesale — for incremental changes use `add_members` /
    /// `remove_members`.
    Update {
        id: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        members: Option<Vec<String>>,
        #[serde(default)]
        active: Option<bool>,
        #[serde(default)]
        link_gain: Option<bool>,
        #[serde(default)]
        link_mute: Option<bool>,
        #[serde(default)]
        link_solo: Option<bool>,
        #[serde(default)]
        link_record: Option<bool>,
    },
    /// Convenience: append the given track ids to the group's current
    /// member list. Reads the live group, dedups, writes back.
    AddMembers { id: String, track_ids: Vec<String> },
    /// Convenience: remove the given track ids from the group.
    RemoveMembers { id: String, track_ids: Vec<String> },
    /// Delete the group. Members are NOT deleted; they revert to
    /// individual gesture behavior.
    Delete { id: String },
}

#[async_trait]
impl Tool for GroupsTool {
    fn name(&self) -> &'static str {
        "groups"
    }

    fn description(&self) -> &'static str {
        "Manage track GROUPS (gesture-linking, NOT audio summing). \
         Subcommands: list, create(name, color?, members?), \
         update(id, name?, color?, members?, active?, link_{gain,mute,solo,record}?), \
         add_members(id, track_ids), remove_members(id, track_ids), \
         delete(id). Use a group when the user wants several tracks to \
         act as one for gain rides / mute / solo. For audio summing \
         (drum bus, vocal bus), use a Bus track instead — that's a \
         different concept handled via `tracks` (kind=bus). Always \
         `list` first when modifying an existing group so you have its \
         current member list before sending Update."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": {
                    "type": "string",
                    "enum": [
                        "list", "create", "update",
                        "add_members", "remove_members", "delete",
                    ]
                },
                "id":         { "type": "string" },
                "name":       { "type": "string" },
                "color":      { "type": "string",
                    "description": "CSS hex color like #aa3939." },
                "members":    { "type": "array", "items": { "type": "string" } },
                "track_ids":  { "type": "array", "items": { "type": "string" } },
                "active":     { "type": "boolean" },
                "link_gain":  { "type": "boolean" },
                "link_mute":  { "type": "boolean" },
                "link_solo":  { "type": "boolean" },
                "link_record":{ "type": "boolean" }
            }
        })
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        let backend = ctx.backend()?;
        match op {
            Op::List => {
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let groups: Vec<Value> = snap
                    .groups
                    .iter()
                    .map(|g| {
                        json!({
                            "id": g.id.as_str(),
                            "name": g.name,
                            "color": g.color,
                            "members": g.members.iter().map(|m| m.as_str()).collect::<Vec<_>>(),
                            "active": g.active,
                            "link_gain": g.link_gain,
                            "link_mute": g.link_mute,
                            "link_solo": g.link_solo,
                            "link_record": g.link_record,
                        })
                    })
                    .collect();
                Ok(ToolResult::ok(format!("{} group(s)", groups.len()))
                    .with_data(json!({ "groups": groups })))
            }
            Op::Create {
                name,
                color,
                members,
            } => {
                let members: Vec<EntityId> = members.into_iter().map(EntityId::new).collect();
                backend
                    .create_group(name.clone(), color, members)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("created group '{name}'")))
            }
            Op::Update {
                id,
                name,
                color,
                members,
                active,
                link_gain,
                link_mute,
                link_solo,
                link_record,
            } => {
                let patch = GroupPatch {
                    name,
                    color,
                    members: members.map(|v| v.into_iter().map(EntityId::new).collect::<Vec<_>>()),
                    active,
                    link_gain,
                    link_mute,
                    link_solo,
                    link_record,
                };
                backend
                    .update_group(EntityId::new(id.clone()), patch)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("updated group {id}")))
            }
            Op::AddMembers { id, track_ids } => {
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let g = snap
                    .groups
                    .iter()
                    .find(|g| g.id.as_str() == id)
                    .ok_or_else(|| ToolError::InvalidArgs(format!("unknown group: {id}")))?;
                let mut members: Vec<EntityId> = g.members.clone();
                for t in track_ids {
                    let eid = EntityId::new(t);
                    if !members.iter().any(|m| m.as_str() == eid.as_str()) {
                        members.push(eid);
                    }
                }
                let patch = GroupPatch {
                    members: Some(members.clone()),
                    ..Default::default()
                };
                backend
                    .update_group(EntityId::new(id.clone()), patch)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "group {id} now has {} member(s)",
                    members.len()
                )))
            }
            Op::RemoveMembers { id, track_ids } => {
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let g = snap
                    .groups
                    .iter()
                    .find(|g| g.id.as_str() == id)
                    .ok_or_else(|| ToolError::InvalidArgs(format!("unknown group: {id}")))?;
                let drop: std::collections::HashSet<String> = track_ids.into_iter().collect();
                let members: Vec<EntityId> = g
                    .members
                    .iter()
                    .filter(|m| !drop.contains(m.as_str()))
                    .cloned()
                    .collect();
                let patch = GroupPatch {
                    members: Some(members.clone()),
                    ..Default::default()
                };
                backend
                    .update_group(EntityId::new(id.clone()), patch)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "group {id} now has {} member(s)",
                    members.len()
                )))
            }
            Op::Delete { id } => {
                backend
                    .delete_group(EntityId::new(id.clone()))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("deleted group {id}")))
            }
        }
    }
}
