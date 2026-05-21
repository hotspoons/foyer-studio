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
    /// Quick named snapshot — Ardour's "Quick Snapshot". Writes a copy
    /// of the current `.ardour` file alongside the session so users
    /// can A/B without leaving the project. Returns the new file's
    /// jail-relative path. `name` defaults to a timestamp.
    Snapshot {
        #[serde(default)]
        name: Option<String>,
    },
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
        /// Crash-recovery decision. **Omit on the first call** — the
        /// tool probes the path for `.pending` artifacts and, if any
        /// are present, returns a `recovery_decision_required`
        /// result listing them so you can decide. Then re-call this
        /// subcommand with the same `path` plus:
        ///
        ///   - `true`  → Recover. The shim auto-clicks Ardour's
        ///     recovery dialog and reloads uncommitted dirty state.
        ///   - `false` → Discard. The `.pending` file is deleted
        ///     before launch; no dialog opens.
        ///
        /// A truly fresh project (no artifacts on disk) launches
        /// normally without this field.
        #[serde(default)]
        recover_crash: Option<bool>,
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
        /// Same as `Op::Open.recover_crash` — only meaningful when
        /// the `path` you specify happens to ALREADY exist on disk
        /// with crash artifacts (rare for `new`, but possible if you
        /// reuse a previously-deleted project's directory name).
        #[serde(default)]
        recover_crash: Option<bool>,
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
         snapshot(name?) — Ardour-style quick snapshot, writes a named \
         copy of the .ardour file alongside the session for A/B work · \
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
                        "save", "save_as", "snapshot",
                        "open", "new", "close", "focus",
                        "list_open", "recents", "forget_recent",
                        "browse", "backends"
                    ]
                },
                "path":        { "type": "string" },
                "name":        { "type": "string" },
                "session_id":  { "type": "string" },
                "backend_id":  { "type": "string" },
                "sample_rate": { "type": "integer", "minimum": 8000, "maximum": 384000 },
                "show_hidden": { "type": "boolean" },
                "recover_crash": {
                    "type": "boolean",
                    "description": "Used with subcommand=open/new. Omit on first call; if the project has crash-recovery artifacts the tool returns recovery_decision_required with the artifact list. Re-call with true (recover dirty state) or false (discard pending file)."
                }
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
                // Signal "no session loaded" to the agent on the
                // cheapest inspection call so it can pivot to
                // session.open / session.new BEFORE trying to mutate.
                // The presence of a Master bus is the cleanest "real
                // session" tell — the launcher stub backend reports
                // zero tracks and no Master.
                let session_loaded = !snap.tracks.is_empty()
                    && snap
                        .tracks
                        .iter()
                        .any(|t| matches!(t.kind, foyer_schema::TrackKind::Master));
                let summary = if session_loaded {
                    format!("{track_count} tracks · {plugin_count} plugins · pos={pos} sr={sr}")
                } else {
                    "no project loaded — call session(subcommand=\"recents\") or \
                     session(subcommand=\"new\") before editing"
                        .to_string()
                };
                Ok(ToolResult::ok(summary).with_data(json!({
                    "track_count": track_count,
                    "plugin_count": plugin_count,
                    "sample_rate": sr,
                    "position_samples": pos,
                    "session_loaded": session_loaded,
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
            Op::Snapshot { name } => {
                let backend = ctx.backend_with_loaded_session().await?;
                let path = backend
                    .snapshot_session(name.clone())
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "snapshot{} → {path}",
                    name.as_deref()
                        .map(|n| format!(" '{n}'"))
                        .unwrap_or_default()
                ))
                .with_data(json!({ "path": path, "name": name })))
            }
            Op::Open {
                path,
                backend_id,
                recover_crash,
            } => {
                let director = require_director(ctx)?;
                let resolved_backend = backend_id.as_deref().unwrap_or("auto");
                // Probe BEFORE the launcher fires when the model hasn't
                // already made a recovery decision. If any artifacts
                // are on disk, bail with a structured ToolResult that
                // lists them and asks the model to re-call with
                // `recover_crash: true|false`. This mirrors the
                // FAB's blocking modal flow over the wire — the LLM
                // gets the same chance to choose that a human user
                // would, instead of the shim silently auto-opening a
                // dialog the agent can't see.
                if recover_crash.is_none() {
                    let artifacts = director.probe_recovery(resolved_backend, &path).await?;
                    if !artifacts.is_empty() {
                        return Ok(recovery_decision_required(&path, &artifacts));
                    }
                }
                let outcome = director
                    .launch_project(resolved_backend, Some(&path), None, recover_crash)
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
                recover_crash,
            } => {
                let director = require_director(ctx)?;
                let resolved_backend = backend_id.as_deref().unwrap_or("auto");
                // Same probe-first guard as `Op::Open`: a `session.new`
                // pointed at a path that ALREADY exists on disk (and
                // has crashed artifacts) deserves the same recovery
                // decision. For a truly fresh path, `probe_recovery`
                // returns empty and we fall through to the launcher
                // normally.
                if let (Some(p), None) = (path.as_deref(), recover_crash) {
                    let artifacts = director.probe_recovery(resolved_backend, p).await?;
                    if !artifacts.is_empty() {
                        return Ok(recovery_decision_required(p, &artifacts));
                    }
                }
                let outcome = director
                    .launch_project(
                        resolved_backend,
                        path.as_deref(),
                        sample_rate,
                        recover_crash,
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

/// Build the `ToolResult` returned by `session.open` / `session.new`
/// when the backend's `probe_recovery` finds crash artifacts on disk
/// and the caller hasn't already supplied a `recover_crash` choice.
///
/// Wire shape (intentionally rich — the model gets enough to reason
/// about whether the dirty state is worth keeping):
///
/// ```jsonc
/// {
///   "summary": "recovery decision required at <path>",
///   "data": {
///     "status":        "recovery_decision_required",
///     "project_path":  "<jail-relative path>",
///     "artifacts":     [{ name, kind, size_bytes, mtime_unix_ms, archived }, …],
///     "next_action":   "Re-call session(subcommand=\"open\", path=\"...\", recover_crash=true|false)",
///     "recover_means": "leave the .pending file in place; the shim auto-clicks Ardour's recovery dialog and the dirty pre-crash state is reloaded",
///     "discard_means": "delete the .pending file before launch; the shim opens the project as last saved (uncommitted edits are lost)"
///   }
/// }
/// ```
///
/// We deliberately surface this as a *successful* `ToolResult` rather
/// than a `ToolError` — it's not a failure, it's a checkpoint that
/// needs a decision. The model sees the artifact list in `data` and
/// can chain a follow-up call cleanly without the harness having to
/// special-case error recovery.
fn recovery_decision_required(
    project_path: &str,
    artifacts: &[foyer_schema::SessionRecoveryArtifact],
) -> ToolResult {
    let total = artifacts.len();
    let pending_count = artifacts.iter().filter(|a| a.kind == "pending").count();
    let history_count = artifacts.iter().filter(|a| a.kind == "history").count();
    let archived_count = artifacts.iter().filter(|a| a.archived).count();
    let live_pending_count = pending_count.saturating_sub(
        artifacts
            .iter()
            .filter(|a| a.kind == "pending" && a.archived)
            .count(),
    );
    let kind_summary = if archived_count == total && total > 0 {
        format!(
            "{archived_count} archived recovery sweep(s) from a previous foyer run — \
             you can restore the highest-stamped one or move on"
        )
    } else if live_pending_count > 0 {
        format!(
            "{live_pending_count} uncommitted dirty .pending file(s){}",
            if history_count > 0 {
                format!(" + {history_count} .history undo snapshot(s)")
            } else {
                String::new()
            }
        )
    } else {
        format!("{total} recovery artifact(s)")
    };
    ToolResult::ok(format!(
        "recovery decision required at {project_path}: {kind_summary}. \
         Re-call this subcommand with recover_crash=true (preserve the \
         dirty state) or recover_crash=false (discard it) to proceed."
    ))
    .with_data(json!({
        "status":        "recovery_decision_required",
        "project_path":  project_path,
        "artifacts":     artifacts,
        "next_action":   format!(
            "session(subcommand=\"open\", path=\"{project_path}\", recover_crash=true|false)"
        ),
        "recover_means": "leave the .pending file in place; the shim auto-clicks \
                          Ardour's recovery dialog so the dirty pre-crash state is reloaded",
        "discard_means": "delete the .pending file before launch; the shim opens the \
                          project as last saved (uncommitted edits are lost)",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use foyer_schema::SessionRecoveryArtifact;

    fn pending(name: &str, size: u64) -> SessionRecoveryArtifact {
        SessionRecoveryArtifact {
            name: name.into(),
            kind: "pending".into(),
            size_bytes: size,
            mtime_unix_ms: 0,
            archived: false,
        }
    }

    #[test]
    fn decision_required_payload_lists_artifacts_with_next_action() {
        let res = recovery_decision_required(
            "Mixdown/Mixdown.ardour",
            &[pending("Mixdown.pending", 2048)],
        );
        assert!(res.summary.contains("recovery decision required"));
        assert_eq!(res.data["status"], "recovery_decision_required");
        assert_eq!(res.data["project_path"], "Mixdown/Mixdown.ardour");
        let arts = res.data["artifacts"].as_array().expect("array");
        assert_eq!(arts.len(), 1);
        assert_eq!(arts[0]["kind"], "pending");
        let next = res.data["next_action"].as_str().unwrap();
        assert!(next.contains("recover_crash=true|false"));
        assert!(next.contains("Mixdown/Mixdown.ardour"));
    }

    #[test]
    fn decision_required_distinguishes_archived_sweeps() {
        let archived = SessionRecoveryArtifact {
            name: "Mixdown.pending.bak.20260518".into(),
            kind: "pending".into(),
            size_bytes: 1024,
            mtime_unix_ms: 0,
            archived: true,
        };
        let res = recovery_decision_required("Mixdown/Mixdown.ardour", &[archived]);
        assert!(
            res.summary.contains("archived recovery sweep"),
            "summary was: {}",
            res.summary
        );
    }
}
