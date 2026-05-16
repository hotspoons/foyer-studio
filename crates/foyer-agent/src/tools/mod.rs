// SPDX-License-Identifier: Apache-2.0
//! Polymorphic tool registry + concrete tools.
//!
//! Per the TODO wishlist: a small set of tools, each with a
//! `subcommand` discriminator inside its args. Keeps the LLM's tool
//! list short (the model has to grok the shape, not just the count)
//! and means new operations are additive subcommands rather than new
//! tool names that have to be re-vetted on every prompt.

pub mod automation;
pub mod midi;
pub mod mixer;
pub mod plugins;
pub mod regions;
pub mod sequencer;
pub mod session;
pub mod tracks;
pub mod transport;
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
    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(transport::TransportTool),
        Arc::new(mixer::MixerTool),
        Arc::new(tracks::TracksTool),
        Arc::new(regions::RegionsTool),
        Arc::new(automation::AutomationTool),
        Arc::new(plugins::PluginsTool),
        Arc::new(midi::MidiTool),
        Arc::new(sequencer::SequencerTool),
        Arc::new(session::SessionTool),
        Arc::new(visualize::VisualizeTool),
    ];
    ToolRegistry::from_tools(tools)
}
