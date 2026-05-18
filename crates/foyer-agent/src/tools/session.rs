// SPDX-License-Identifier: Apache-2.0
//! Session lifecycle + inspection.
//!
//! Splits cleanly into two surfaces:
//!
//!   - **Currently-loaded session** (Backend trait): `summary`, `full`,
//!     `save`, `save_as`. These act on whatever's open in the live shim.
//!
//!   - **Sidecar registry / filesystem** (SessionDirector): `open`,
//!     `new`, `close`, `list_open`, `recents`, `forget_recent`,
//!     `browse`, `backends`. These let the agent manage *which*
//!     project is open without round-tripping through the user.
//!
//! Subcommands are gated on whichever surface they need. A tool call
//! that needs a director but the deployment hasn't wired one (no FE,
//! pure unit tests, etc.) errors with a plain-English explanation
//! rather than panicking — the model can adapt.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

pub struct SessionTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    /// Track / region / plugin counts + transport state. Cheap snapshot.
    Summary,
    /// Entire session snapshot. Large — use only when you need the
    /// full graph (port routing, plugin params, etc.).
    Full,
    /// Save the currently-loaded session in place. No path argument.
    Save,
    /// Save the currently-loaded session as a new file. `path` is
    /// jail-relative. The backend re-points the active session at the
    /// new path (matches the WS save-as behavior).
    SaveAs { path: String },
    /// Open a project by jail-relative path. Spawns a fresh backend
    /// instance (or focuses the existing one if it's already in the
    /// sidecar registry), then makes it the active session.
    Open {
        path: String,
        /// Defaults to the currently-active backend (or the sidecar's
        /// default if no backend is up yet). Pass "stub" to open in
        /// the demo backend regardless.
        #[serde(default)]
        backend_id: Option<String>,
    },
    /// Create a new project at the given path. For the Ardour backend
    /// this generates a fresh `.ardour` file at the path; for the stub
    /// it just opens an empty session.
    New {
        /// Jail-relative path for the new project. Required for Ardour;
        /// the stub backend accepts `None` for an in-memory project.
        #[serde(default)]
        path: Option<String>,
        /// Optional engine sample rate (44100 / 48000 / 96000 etc).
        /// Only applied when the project file doesn't already exist.
        #[serde(default)]
        sample_rate: Option<u32>,
        /// Defaults to the currently-active backend.
        #[serde(default)]
        backend_id: Option<String>,
    },
    /// Close a session by its sidecar id. Quits the shim host process
    /// and removes the entry from the registry. Destructive.
    Close { session_id: String },
    /// Switch the sidecar's focused session. Subsequent commands
    /// without an explicit session_id route to this backend; the
    /// FE's switcher mirrors the focus too. Use after `list_open`
    /// when more than one project is loaded so the agent's edits
    /// hit the user's intended target. (`session.open` already
    /// focuses the just-opened project — this is for switching
    /// between projects that are ALREADY loaded.)
    Focus { session_id: String },
    /// List open sessions in the sidecar registry.
    ListOpen,
    /// List recent projects the sidecar has touched.
    Recents,
    /// Drop a single recents entry by path.
    ForgetRecent { path: String },
    /// Directory listing inside the filesystem jail. `path = ""` lists
    /// the jail root. Hidden entries (dotfiles) are omitted unless
    /// `show_hidden = true`.
    Browse {
        #[serde(default)]
        path: String,
        #[serde(default)]
        show_hidden: bool,
    },
    /// List configured backend adapters + which is currently active.
    /// Useful before calling `open`/`new` if you need a specific
    /// backend.
    Backends,
}

#[async_trait]
impl Tool for SessionTool {
    fn name(&self) -> &'static str {
        "session"
    }

    fn description(&self) -> &'static str {
        "Session lifecycle + inspection. Subcommands: \
         summary (cheap counters) · full (whole snapshot) · \
         save / save_as (write the current project) · \
         open / new / close / focus (manage which project is live) · \
         list_open / recents / forget_recent · \
         browse (filesystem inside the jail) · \
         backends (list adapter ids)."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": {
                    "type": "string",
                    "enum": [
                        "summary", "full",
                        "save", "save_as",
                        "open", "new", "close", "focus",
                        "list_open", "recents", "forget_recent",
                        "browse", "backends"
                    ]
                },
                "path":        { "type": "string" },
                "session_id":  { "type": "string" },
                "backend_id":  { "type": "string" },
                "sample_rate": { "type": "integer", "minimum": 8000, "maximum": 384000 },
                "show_hidden": { "type": "boolean" }
            }
        })
    }

    fn destructive(&self) -> bool {
        // Subcommand-level destructive flag is more accurate, but the
        // engine uses a tool-level gate today. `close`, `open`, and
        // `new` close the current project; `save_as` writes a new
        // file. Mark the tool destructive so the autonomy layer
        // confirms before any of them fires. The pure read paths
        // (summary/full/list_open/recents/browse/backends) take the
        // hit too, but cheap-read confirmation is rarely the bottleneck.
        true
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;

        match op {
            Op::Summary => {
                let backend = ctx.backend()?;
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let track_count = snap.tracks.len();
                let plugin_count: usize = snap.tracks.iter().map(|t| t.plugins.len()).sum();
                let sr = backend.sample_rate();
                let pos = backend.transport_position_samples();
                Ok(ToolResult::ok(format!(
                    "{track_count} tracks · {plugin_count} plugins · pos={pos} sr={sr}"
                ))
                .with_data(json!({
                    "track_count": track_count,
                    "plugin_count": plugin_count,
                    "sample_rate": sr,
                    "position_samples": pos,
                })))
            }
            Op::Full => {
                let backend = ctx.backend()?;
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let data =
                    serde_json::to_value(&snap).map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok("full snapshot").with_data(data))
            }
            Op::Save => {
                let backend = ctx.backend()?;
                backend
                    .save_session(None)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok("saved"))
            }
            Op::SaveAs { path } => {
                let backend = ctx.backend()?;
                backend
                    .save_session(Some(&path))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("saved as {path}")).with_data(json!({ "path": path })))
            }
            Op::Open { path, backend_id } => {
                let director = require_director(ctx)?;
                let outcome = director
                    .launch_project(backend_id.as_deref().unwrap_or("auto"), Some(&path), None)
                    .await?;
                Ok(ToolResult::ok(format!(
                    "opened {} (session {})",
                    outcome.project_path.as_deref().unwrap_or("(unknown path)"),
                    outcome.session_id,
                ))
                .with_data(json!({
                    "session_id":   outcome.session_id,
                    "backend_id":   outcome.backend_id,
                    "project_path": outcome.project_path,
                })))
            }
            Op::New {
                path,
                sample_rate,
                backend_id,
            } => {
                let director = require_director(ctx)?;
                let outcome = director
                    .launch_project(
                        backend_id.as_deref().unwrap_or("auto"),
                        path.as_deref(),
                        sample_rate,
                    )
                    .await?;
                Ok(ToolResult::ok(format!(
                    "new project at {} (session {})",
                    outcome.project_path.as_deref().unwrap_or("(in-memory)"),
                    outcome.session_id,
                ))
                .with_data(json!({
                    "session_id":   outcome.session_id,
                    "backend_id":   outcome.backend_id,
                    "project_path": outcome.project_path,
                })))
            }
            Op::Close { session_id } => {
                let director = require_director(ctx)?;
                director.close(&session_id).await?;
                Ok(ToolResult::ok(format!("closed session {session_id}")))
            }
            Op::Focus { session_id } => {
                let director = require_director(ctx)?;
                director.focus(&session_id).await?;
                Ok(ToolResult::ok(format!("focused session {session_id}"))
                    .with_data(json!({ "session_id": session_id })))
            }
            Op::ListOpen => {
                let director = require_director(ctx)?;
                let sessions = director.list_open().await?;
                let summary = format!("{} session(s) open", sessions.len());
                Ok(ToolResult::ok(summary).with_data(
                    serde_json::to_value(&sessions)
                        .map_err(|e| ToolError::Execution(e.to_string()))?,
                ))
            }
            Op::Recents => {
                let director = require_director(ctx)?;
                let recents = director.list_recents().await?;
                Ok(
                    ToolResult::ok(format!("{} recent project(s)", recents.len())).with_data(
                        serde_json::to_value(&recents)
                            .map_err(|e| ToolError::Execution(e.to_string()))?,
                    ),
                )
            }
            Op::ForgetRecent { path } => {
                let director = require_director(ctx)?;
                director.forget_recent(&path).await?;
                Ok(ToolResult::ok(format!("forgot {path}")))
            }
            Op::Browse { path, show_hidden } => {
                let director = require_director(ctx)?;
                let listing = director.browse_path(&path, show_hidden).await?;
                let entry_count = listing.entries.len();
                Ok(ToolResult::ok(format!("{entry_count} entries")).with_data(
                    serde_json::to_value(&listing)
                        .map_err(|e| ToolError::Execution(e.to_string()))?,
                ))
            }
            Op::Backends => {
                let director = require_director(ctx)?;
                let listing = director.list_backends().await?;
                let summary = match &listing.active {
                    Some(a) => format!("{} backend(s), active={}", listing.backends.len(), a),
                    None => format!("{} backend(s), none active", listing.backends.len()),
                };
                Ok(ToolResult::ok(summary).with_data(json!({
                    "backends": listing.backends,
                    "active":   listing.active,
                })))
            }
        }
    }
}

fn require_director(
    ctx: &ToolContext,
) -> Result<&std::sync::Arc<dyn crate::tools::SessionDirector>, ToolError> {
    ctx.session_director.as_ref().ok_or_else(|| {
        ToolError::Execution(
            "session director not attached — this Foyer deployment doesn't expose \
             multi-session / filesystem ops to the agent. The save / save_as / summary \
             / full subcommands still work."
                .into(),
        )
    })
}
