// SPDX-License-Identifier: Apache-2.0
//! Polymorphic tool registry + concrete tools.
//!
//! Per the TODO wishlist: a small set of tools, each with a
//! `subcommand` discriminator inside its args. Keeps the LLM's tool
//! list short (the model has to grok the shape, not just the count)
//! and means new operations are additive subcommands rather than new
//! tool names that have to be re-vetted on every prompt.

pub mod automation;
pub mod continue_working;
pub mod daw_proxy;
pub mod groups;
pub mod io;
pub mod midi;
pub mod mixer;
pub mod plugins;
pub mod regions;
pub mod scripts;
pub mod sections;
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

/// Live, shared handle to the *current* backend Weak ref. Wrapped in
/// a `std::sync::RwLock<Option<Weak>>` so the in-process agent's
/// `ToolContext` reads the LIVE value on every `backend()` call —
/// without this indirection, a session swap mid-turn (e.g. `session.new`
/// followed by `tracks.list` in the same turn) would leave subsequent
/// tool calls pointing at the previous session's shim. The runtime
/// owns one of these Arcs and clones it into every ToolContext it
/// builds; `attach_backend` updates the inner Weak so every active
/// ctx sees the new ref immediately.
pub type BackendRef = std::sync::Arc<std::sync::RwLock<Option<std::sync::Weak<dyn Backend>>>>;

/// Convenience constructor — builds a `BackendRef` seeded with the
/// given Weak. External call sites (MCP per-call, tests) can also
/// pass `BackendRef::default()` and update it post-construction.
pub fn make_backend_ref(weak: std::sync::Weak<dyn Backend>) -> BackendRef {
    std::sync::Arc::new(std::sync::RwLock::new(Some(weak)))
}

/// Build a [`foyer_schema::TempoMap`] from a session snapshot. Pulls
/// BPM, time signature, sample rate, and PPQN off the snapshot,
/// falling back to sensible defaults (4/4 @ 120 BPM @ 48 kHz, PPQN
/// 1920) when the backend hasn't populated those parameters yet
/// (legacy shims, cold-boot transient state). Used by `ToolContext::
/// tempo_map` and by tools that already hold a snapshot in hand.
pub fn tempo_map_from_snapshot(snap: &foyer_schema::Session) -> foyer_schema::TempoMap {
    let t = &snap.transport;
    let bpm = t.tempo.value.as_f64().unwrap_or(120.0);
    let num = t
        .time_signature_num
        .value
        .as_f64()
        .map(|v| v as u32)
        .unwrap_or(4)
        .max(1);
    let den = t
        .time_signature_den
        .value
        .as_f64()
        .map(|v| v as u32)
        .unwrap_or(4)
        .max(1);
    foyer_schema::TempoMap {
        sample_rate: if snap.sample_rate == 0 {
            foyer_schema::DEFAULT_SAMPLE_RATE
        } else {
            snap.sample_rate
        },
        bpm,
        time_sig_num: num,
        time_sig_den: den,
        ticks_per_quarter: snap.ppqn.unwrap_or(1920).max(1),
    }
}

/// Shared, per-turn budget handle. The `continue_working` tool grabs
/// this to extend the round cap mid-turn. Use `Arc<std::sync::Mutex>`
/// (not tokio's) so tools that don't touch async can read/write it
/// freely. Set by `AgentEngine::run_turn` on the ToolContext it
/// receives, so every flow that funnels through `run_turn` —
/// in-process FAB, `/v1/chat/completions` proxy, MCP `tools/call` —
/// shares the same per-turn budget machinery. `None` only on the
/// rare paths that dispatch a tool *outside* run_turn (mostly tests).
pub type TurnBudgetHandle = std::sync::Arc<std::sync::Mutex<crate::engine::TurnBudget>>;

/// Per-invocation context the tools receive.
pub struct ToolContext {
    pub backend: BackendRef,
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
    /// Live per-turn round budget. The hidden `continue_working`
    /// tool grabs this to extend the round cap mid-turn. Populated
    /// by `AgentEngine::run_turn` for every caller — FAB,
    /// `/v1/chat/completions`, MCP. `None` is only seen on the
    /// thin dispatch paths used in tests.
    pub turn_budget: Option<TurnBudgetHandle>,
}

impl ToolContext {
    /// Fetch the live tempo map (sample-rate + BPM + meter + PPQN)
    /// off the current session snapshot. Used by every tool that
    /// accepts a polymorphic [`foyer_schema::TimeArg`] — the resolver
    /// needs these four values to convert {seconds, BBT} to samples.
    ///
    /// One snapshot round-trip per tool call. That's the same cost
    /// every mutating tool already pays once (e.g. for
    /// `backend_with_loaded_session`); tools that need both should
    /// fetch the snapshot themselves and call the pure conversion
    /// on `foyer_schema::TempoMap` directly to avoid two round trips.
    pub async fn tempo_map(&self) -> Result<foyer_schema::TempoMap, ToolError> {
        let backend = self.backend()?;
        let snap = backend
            .snapshot()
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        Ok(tempo_map_from_snapshot(&snap))
    }

    pub fn backend(&self) -> Result<Arc<dyn Backend>, ToolError> {
        // Read the LIVE Weak each call so a session swap mid-turn is
        // picked up by every subsequent tool call. `expect`: the lock
        // only poisons if a panic occurred while it was held; we hold
        // it for a single clone so that's effectively impossible.
        let weak = {
            let guard = self
                .backend
                .read()
                .expect("ToolContext backend ref poisoned");
            guard.as_ref().ok_or(ToolError::BackendGone)?.clone()
        };
        let backend = weak.upgrade().ok_or(ToolError::BackendGone)?;
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
    /// Switch the sidecar's focused session. Subsequent untagged
    /// commands (transport, tracks, regions, …) route to this
    /// session's backend. Default impl errors out; the
    /// server-side `SessionDirectorImpl` overrides.
    async fn focus(&self, _session_id: &str) -> Result<(), SessionDirectorError> {
        Err(SessionDirectorError::Unsupported(
            "session.focus not wired in this director".into(),
        ))
    }

    /// Arm a track to receive browser-sourced audio — the same
    /// server-side handshake the "I" / Take chip runs when a user
    /// clicks it (browser-side mic capture still needs a real user
    /// gesture; the agent's job ends at preparing the track).
    /// Specifically: records the track→browser-source claim in
    /// `track_browser_sources`, forces `monitoring=off` (otherwise
    /// the 100-300 ms browser round-trip is audible as slap-back),
    /// and broadcasts `TrackBrowserSourceChanged` so any connected
    /// surfaces light up the affordance.
    ///
    /// `peer_id`:
    ///   - `Some(<peer>)`: lock the track to that specific peer
    ///     (their browser tab auto-engages when the user clicks).
    ///   - `None`: leave the assignee open — the next browser peer
    ///     to claim the track wins.
    ///
    /// Default impl errors out; server-side `SessionDirectorImpl`
    /// overrides with the real handshake.
    async fn arm_track_for_browser_audio(
        &self,
        _track_id: &str,
        _peer_id: Option<&str>,
    ) -> Result<ArmIngressOutcome, SessionDirectorError> {
        Err(SessionDirectorError::Unsupported(
            "arm_track_for_browser_audio not wired in this director".into(),
        ))
    }

    /// Release a prior `arm_track_for_browser_audio` claim — clears
    /// the browser-source assignment + lets monitoring fall back to
    /// the user's choice (no automatic re-enable; the agent can call
    /// `tracks.update(monitoring=…)` separately if it wants live
    /// monitoring back).
    async fn release_track_browser_audio(
        &self,
        _track_id: &str,
    ) -> Result<(), SessionDirectorError> {
        Err(SessionDirectorError::Unsupported(
            "release_track_browser_audio not wired in this director".into(),
        ))
    }

    /// Enumerate the MCP proxy targets the `daw_proxy` agent tool
    /// should consider. Two sources merge here:
    ///   1. **Live sessions** — every open session whose backend
    ///      registered an `mcp_endpoint` at spawn time
    ///      (Ardour ≥ 9.4 with `mcp_http` compiled in). Each session
    ///      gets a unique id derived from its session entry so the
    ///      agent can target a specific Ardour instance when more
    ///      than one is open.
    ///   2. **Static config** — `mcp_proxies:` entries from
    ///      config.yaml for upstream MCP servers Foyer didn't spawn
    ///      (e.g. a Reaper instance the operator manually started).
    ///
    /// Default impl returns an empty list — the in-process tool
    /// dispatchers used by tests don't have a session registry to
    /// read from.
    async fn list_mcp_proxies(&self) -> Result<Vec<McpProxyEntry>, SessionDirectorError> {
        Ok(Vec::new())
    }
}

/// One row returned by [`SessionDirector::list_mcp_proxies`]. Renamed
/// `McpProxyEntry` rather than reusing `foyer_config::McpProxyConfig`
/// so the runtime version (which knows about live sessions) doesn't
/// pretend to be a config-file record.
#[derive(Debug, Clone)]
pub struct McpProxyEntry {
    /// Stable id the agent passes back as `backend:` in subsequent
    /// `daw_proxy` calls. Either the config-file `id` for static
    /// entries or `session.<short-id>` for live sessions.
    pub id: String,
    /// Human-readable label shown in `daw_proxy.list_backends`.
    pub label: String,
    pub endpoint: String,
    pub enabled: bool,
    /// "session" for live-session entries, "config" for static.
    /// Surfaced so the agent + operator can tell which sessions
    /// support MCP vs. which are configured externally.
    pub source: &'static str,
    /// Optional API key (env-var override applied before this point).
    /// Not serialized out of the proxy registry — used by the client
    /// directly.
    pub api_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ArmIngressOutcome {
    pub track_id: String,
    /// The peer that's been bound — same string the WS layer broadcasts
    /// in `TrackBrowserSourceChanged.peer_id`. Empty string means
    /// "claimable by any peer".
    pub peer_id: String,
    /// Connected browser peers as of arm-time. Useful for the agent's
    /// reply ("waiting for a browser tab to open" vs. "peer XYZ is
    /// connected, ask them to click Take").
    pub connected_peer_count: usize,
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
        Arc::new(io::IoTool),
        Arc::new(sections::SectionsTool),
        Arc::new(continue_working::ContinueWorkingTool),
    ];
    ToolRegistry::from_tools(tools)
}
