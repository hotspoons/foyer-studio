// SPDX-License-Identifier: Apache-2.0
//! Polymorphic tool registry + concrete tools.
//!
//! Per the TODO wishlist: a small set of tools, each with a
//! `subcommand` discriminator inside its args. Keeps the LLM's tool
//! list short (the model has to grok the shape, not just the count)
//! and means new operations are additive subcommands rather than new
//! tool names that have to be re-vetted on every prompt.

pub mod automation;
pub mod groups;
pub mod midi;
pub mod mixer;
pub mod plugins;
pub mod regions;
pub mod scripts;
pub mod sequencer;
pub mod session;
pub mod spectrum;
pub mod tracks;
pub mod transport;
pub mod ui;
pub mod visualize;
pub mod welcome;

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use foyer_backend::Backend;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("unknown tool: {0}")]
    Unknown(String),
    #[error("invalid args: {0}")]
    InvalidArgs(String),
    #[error("backend unavailable")]
    BackendGone,
    #[error("execution failed: {0}")]
    Execution(String),
    #[error("rejected by autonomy gate")]
    Rejected,
}

/// What a tool returns. `summary` is a short human-readable status
/// shown in the FAB card; `data` is the structured result fed back
/// to the model. `image_png_b64` optionally carries a rendered visual.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolResult {
    pub summary: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub data: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_png_b64: Option<String>,
}

impl ToolResult {
    pub fn ok(summary: impl Into<String>) -> Self {
        Self {
            summary: summary.into(),
            data: Value::Null,
            image_png_b64: None,
        }
    }
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = data;
        self
    }
}

/// Per-invocation context the tools receive.
pub struct ToolContext {
    pub backend: std::sync::Weak<dyn Backend>,
    pub fe_attached: bool,
    pub fe_render: Option<Arc<dyn FeRenderer>>,
    pub headless_render: Option<Arc<dyn HeadlessRenderer>>,
    /// Round-trips UI directives through any attached browser tab.
    /// Wired in `attach_agent` (foyer-server) when the FE WS is up.
    /// None when there's no FE (TUI-only MCP sessions); the `ui`
    /// tool reports that to the agent so it can fall back to
    /// explaining the layout in text.
    pub ui_director: Option<Arc<dyn UiDirector>>,
    /// Sidecar-state ops for `session.{open,new,close,list_open,
    /// recents,browse,...}`. The active-backend Save/Save-As path
    /// goes through `Backend::save_session` instead so it works
    /// without a director attached (in-process tests, etc.).
    pub session_director: Option<Arc<dyn SessionDirector>>,
    /// Server-side spectrum analyser. Lets the `spectrum` agent tool
    /// drive transport and capture FFT frames offline when the
    /// backend's native spectrum is unavailable. None during the
    /// stub-MCP tests and the in-process agent's first turn (the
    /// director is attached during `attach_agent`).
    pub spectrum_director: Option<Arc<dyn SpectrumDirector>>,
    /// Snapshot of `AgentConfig.prefer_headless_render` at the
    /// moment this turn started. Read by the `visualize` tool to
    /// flip the renderer priority.
    pub prefer_headless_render: bool,
}

impl ToolContext {
    pub fn backend(&self) -> Result<Arc<dyn Backend>, ToolError> {
        let backend = self.backend.upgrade().ok_or(ToolError::BackendGone)?;
        // The Weak upgraded, but the underlying IPC may have died
        // since (Ardour crash, shim killed, network blip). Probe
        // before handing back the Arc so callers get a clean
        // BackendGone instead of a stream of cryptic "writer queue
        // closed" execution errors on every subsequent tool.
        if !backend.is_alive() {
            return Err(ToolError::BackendGone);
        }
        Ok(backend)
    }

    /// Same as `backend()` but ALSO refuses to dispatch when the
    /// session looks unloaded — no Master bus or zero tracks at all.
    /// Use this for tools that mutate session state (`regions.create`,
    /// `plugins.insert`, MIDI edits, automation, etc.); inspection-
    /// only tools that should still work on an empty session
    /// (`session.summary`, `tracks.list`) keep using bare `backend()`.
    ///
    /// The user often opens the FAB / MCP connection BEFORE picking a
    /// project; without this guard the agent fires off requests that
    /// the shim either drops silently or answers with a cryptic IPC
    /// error. Surfacing a plain-English precondition lets the model
    /// tell the user "open a project first" instead of muddling on.
    pub async fn backend_with_loaded_session(&self) -> Result<Arc<dyn Backend>, ToolError> {
        let backend = self.backend()?;
        let snap = backend
            .snapshot()
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        // A real Ardour session always has a Master bus; the launcher
        // stub has zero tracks. Either signal counts as "nothing
        // loaded" — inspection tools (session.summary, tracks.list)
        // still work without a loaded project; mutating tools error
        // out with the message below.
        let loaded = !snap.tracks.is_empty()
            && snap
                .tracks
                .iter()
                .any(|t| matches!(t.kind, foyer_schema::TrackKind::Master));
        if !loaded {
            return Err(ToolError::Execution(
                "no project is currently loaded — ask the user to open a session \
                 in the Foyer UI (session picker → pick a project) before issuing \
                 edits. Inspection tools like session.summary / tracks.list still \
                 work without a loaded project."
                    .into(),
            ));
        }
        Ok(backend)
    }
}

#[async_trait]
pub trait FeRenderer: Send + Sync {
    async fn render(&self, request: Value) -> Result<Vec<u8>, ToolError>;
}

#[async_trait]
pub trait HeadlessRenderer: Send + Sync {
    async fn render(&self, request: Value) -> Result<Vec<u8>, ToolError>;
}

/// Server-side broker for UI actions. The `ui` agent tool calls
/// `dispatch(action_json)`; the implementation broadcasts an
/// `Event::UiAction` over the control plane, awaits the first FE
/// reply via `Command::UiActionResult`, and returns the JSON
/// payload back (state snapshot on a `query`, empty on mutations).
#[async_trait]
pub trait UiDirector: Send + Sync {
    async fn dispatch(&self, action_json: String) -> Result<String, UiDirectorError>;
}

/// Error type for `UiDirector::dispatch`. Mirrors `ToolError::Execution`
/// shape but lives in its own type so a future director impl can
/// distinguish "no FE attached" from "FE rejected the action".
#[derive(Debug, thiserror::Error)]
pub enum UiDirectorError {
    #[error("{0}")]
    Execution(String),
}

/// Server-side spectrum analyser surface. Lets the agent's
/// `spectrum.capture_at` / `spectrum.capture_window` subcommands
/// drive transport, mute master, and aggregate FFT bins without
/// needing the backend to implement an offline spectrum natively.
#[async_trait]
pub trait SpectrumDirector: Send + Sync {
    /// One FFT window at `at_samples`. Locates transport, plays
    /// briefly, captures, and restores prior state. Returns the
    /// frame as JSON-able SpectrumFrame.
    async fn capture_at(
        &self,
        target: serde_json::Value,
        opts: serde_json::Value,
        at_samples: u64,
        mute_master: bool,
    ) -> Result<serde_json::Value, SpectrumDirectorError>;
    /// Time-slice EMA capture across [start, end]. Same restore
    /// semantics. `decay` 0..1 weights the running average.
    async fn capture_window(
        &self,
        target: serde_json::Value,
        opts: serde_json::Value,
        start_samples: u64,
        end_samples: u64,
        decay: f32,
        mute_master: bool,
    ) -> Result<serde_json::Value, SpectrumDirectorError>;
}

#[derive(Debug, thiserror::Error)]
pub enum SpectrumDirectorError {
    #[error("{0}")]
    Execution(String),
}

impl From<SpectrumDirectorError> for ToolError {
    fn from(e: SpectrumDirectorError) -> Self {
        match e {
            SpectrumDirectorError::Execution(m) => ToolError::Execution(m),
        }
    }
}

impl From<UiDirectorError> for ToolError {
    fn from(e: UiDirectorError) -> Self {
        match e {
            UiDirectorError::Execution(m) => ToolError::Execution(m),
        }
    }
}

/// Sidecar session-management surface. Distinct from the `Backend`
/// trait (which acts on the CURRENTLY-OPEN session) — this is the
/// agent's hook into the sidecar's multi-session registry, the project
/// launcher, recents, and filesystem browsing inside the jail.
///
/// Implemented by `foyer-server::session_director::SessionDirectorImpl`.
/// Tools call through here; the impl reaches back into `AppState` to
/// invoke the same launch + close + recents helpers the WS dispatcher
/// uses, so the agent's "open this project" goes through the same
/// pipeline as a click on the project picker.
#[async_trait]
pub trait SessionDirector: Send + Sync {
    /// Sessions currently open in the sidecar registry.
    async fn list_open(&self) -> Result<Vec<foyer_schema::SessionInfo>, SessionDirectorError>;
    /// Close (and quit shim of) a session by id.
    async fn close(&self, session_id: &str) -> Result<(), SessionDirectorError>;
    /// Launch a project. `backend_id` of "" / "auto" resolves to the
    /// currently-active backend (or the default if none is up yet).
    /// `project_path` of None launches a fresh in-memory project (stub
    /// backends only; Ardour requires a path).
    async fn launch_project(
        &self,
        backend_id: &str,
        project_path: Option<&str>,
        sample_rate: Option<u32>,
    ) -> Result<LaunchOutcome, SessionDirectorError>;
    /// Recents list (canonical order: most-recently-touched first).
    async fn list_recents(&self) -> Result<Vec<foyer_schema::RecentEntry>, SessionDirectorError>;
    /// Forget a single recents entry (jail-relative path).
    async fn forget_recent(&self, path: &str) -> Result<(), SessionDirectorError>;
    /// Directory listing inside the jail. `path = ""` lists the jail root.
    async fn browse_path(
        &self,
        path: &str,
        show_hidden: bool,
    ) -> Result<foyer_schema::PathListing, SessionDirectorError>;
    /// Configured backend adapters + which is currently live.
    async fn list_backends(&self) -> Result<BackendsListing, SessionDirectorError>;
}

#[derive(Debug, Clone)]
pub struct LaunchOutcome {
    pub session_id: String,
    pub backend_id: String,
    pub project_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BackendsListing {
    pub backends: Vec<foyer_schema::BackendInfo>,
    pub active: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionDirectorError {
    #[error("{0}")]
    Execution(String),
    #[error("not supported in this deployment: {0}")]
    Unsupported(String),
}

impl From<SessionDirectorError> for ToolError {
    fn from(e: SessionDirectorError) -> Self {
        match e {
            SessionDirectorError::Execution(m) => ToolError::Execution(m),
            SessionDirectorError::Unsupported(m) => ToolError::Execution(m),
        }
    }
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn schema(&self) -> Value;
    fn destructive(&self) -> bool {
        false
    }
    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError>;
}

/// Render a visualize request through whichever renderer the runtime
/// has installed, honoring the `prefer_headless_render` flip. Shared
/// helper so `automation` / `midi` tools can offer their own
/// `show_viz` subcommands without duplicating the FE / headless
/// fallback ladder that lives in `VisualizeTool`.
pub(crate) async fn render_visualization(
    ctx: &ToolContext,
    request: Value,
) -> Result<Vec<u8>, ToolError> {
    let fe = ctx.fe_render.as_ref();
    let hl = ctx.headless_render.as_ref();
    if ctx.prefer_headless_render {
        match (hl, fe) {
            (Some(a), Some(b)) => match a.render(request.clone()).await {
                Ok(bytes) => Ok(bytes),
                Err(_) => b.render(request).await,
            },
            (Some(a), None) => a.render(request).await,
            (None, Some(b)) => b.render(request).await,
            (None, None) => Err(ToolError::Execution(
                "no renderer wired into the agent runtime".into(),
            )),
        }
    } else {
        match (fe, hl) {
            (Some(a), Some(b)) => match a.render(request.clone()).await {
                Ok(bytes) => Ok(bytes),
                Err(_) => b.render(request).await,
            },
            (Some(a), None) => a.render(request).await,
            (None, Some(b)) => b.render(request).await,
            (None, None) => Err(ToolError::Execution(
                "no renderer wired into the agent runtime".into(),
            )),
        }
    }
}

#[derive(Default, Clone)]
pub struct ToolRegistry {
    tools: Arc<HashMap<&'static str, Arc<dyn Tool>>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_tools(tools: Vec<Arc<dyn Tool>>) -> Self {
        let map: HashMap<&'static str, Arc<dyn Tool>> =
            tools.into_iter().map(|t| (t.name(), t)).collect();
        Self {
            tools: Arc::new(map),
        }
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    pub fn names(&self) -> Vec<&'static str> {
        self.tools.keys().copied().collect()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Arc<dyn Tool>> {
        self.tools.values()
    }

    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }
}

pub fn default_registry() -> ToolRegistry {
    default_registry_with_store(None)
}

/// Build the registry threading an `AgentStore` weak ref through the
/// scripts tool so its `skills` / `skill` subcommands can read the
/// harness's playbook library. Pass `None` from tests / external MCP
/// runners that don't have an agent store; those callers will see
/// "agent skill store is not attached" when calling the skill ops.
pub fn default_registry_with_store(
    store: Option<std::sync::Weak<crate::store::AgentStore>>,
) -> ToolRegistry {
    let scripts_tool = match store {
        Some(s) => scripts::ScriptsTool::with_store(s),
        None => scripts::ScriptsTool::without_store(),
    };
    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(transport::TransportTool),
        Arc::new(mixer::MixerTool),
        Arc::new(tracks::TracksTool),
        Arc::new(regions::RegionsTool),
        Arc::new(automation::AutomationTool),
        Arc::new(plugins::PluginsTool),
        Arc::new(midi::MidiTool),
        Arc::new(sequencer::SequencerTool),
        Arc::new(scripts_tool),
        Arc::new(session::SessionTool),
        Arc::new(spectrum::SpectrumTool),
        Arc::new(ui::UiTool),
        Arc::new(visualize::VisualizeTool),
        Arc::new(groups::GroupsTool),
    ];
    ToolRegistry::from_tools(tools)
}
