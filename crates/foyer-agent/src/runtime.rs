// SPDX-License-Identifier: Apache-2.0
//! Public facade for the agent harness.
//!
//! `AgentRuntime` is what `foyer-server`'s `AppState` holds. It owns
//! the conversation, the config, the tool registry, the LLM client,
//! and the welcome context shared with external MCP clients.
//! Commands come in via async methods; events go out via a broadcast
//! channel any number of clients can subscribe to.

use std::sync::Arc;

use foyer_backend::Backend;
use foyer_schema::agent::{
    AgentAutonomy, AgentConfigPublic, AgentMemoryInfo, AgentMessageRecord, AgentSkillInfo,
    AgentTemplateInfo, AgentToolStatus,
};
use tokio::sync::{broadcast, oneshot, Mutex, RwLock};

use crate::config::AgentConfig;
use crate::conversation::Conversation;
use crate::engine::{AgentEngine, EngineError, EngineSink};
use crate::llm::{LlmClient, OpenAiHttpClient};
use crate::store::AgentStore;
use crate::tools::welcome::{WelcomeContext, WelcomeTool};
use crate::tools::{ToolContext, ToolRegistry};

/// What the OpenAI proxy needs to build a transient `AgentEngine`
/// against a fresh conversation. Returned by
/// [`AgentRuntime::external_engine_parts`].
pub struct ExternalEngineParts {
    pub llm: Arc<dyn LlmClient>,
    pub model: String,
    pub tools: ToolRegistry,
    pub ctx: ToolContext,
    pub system_prompt: String,
}

/// Events the runtime broadcasts. Subscribers translate these into
/// `foyer_schema::Event` over their own transport (WS, stdio, etc.).
#[derive(Debug, Clone)]
pub enum AgentEvent {
    Message(AgentMessageRecord),
    Token {
        message_id: u64,
        delta: String,
    },
    ToolUpdate {
        message_id: u64,
        call_id: String,
        status: AgentToolStatus,
        preview: Option<String>,
        result_json: String,
    },
    State {
        config: AgentConfigPublic,
        busy: bool,
        transcript_len: u32,
    },
    Skills(Vec<AgentSkillInfo>),
    Memories(Vec<AgentMemoryInfo>),
    Templates(Vec<AgentTemplateInfo>),
    SessionsListed {
        sessions: Vec<foyer_schema::AgentSessionInfo>,
        active_id: Option<String>,
    },
    SessionActivated {
        id: String,
        title: String,
    },
}

pub const DEFAULT_SYSTEM_PROMPT: &str = "\
You are the in-process agent for Foyer Studio, a web-native control \
surface for the Ardour DAW. The user is producing music and you can \
directly read AND modify the live session — they expect you to act, \
not narrate. Be concise; they're mid-session.\n\
\n\
SKILL-FIRST: the harness ships task-oriented playbooks under \
`scripts.skills` (list) / `scripts.skill { name }` (body). For ANY \
non-trivial request involving `plugins`, `midi`, `sequencer`, \
`automation`, `ui`, `visualize`, `session`, or `scripts` — load the \
relevant playbook FIRST. The playbooks document exact call shapes, \
the batch-vs-loop tradeoffs that matter for latency, and the gotchas \
(silent failures, jail-path stripping, solo hygiene) that are easy to \
trip on a cold start. The `welcome` payload's `skills` index lists \
every available playbook by name + one-line summary. ONE skill read \
saves several round-trip mistakes — especially on smaller models.\n\
\n\
Tools are polymorphic — one tool per domain with a `subcommand` \
field selecting the operation. Current surface (selected highlights, \
schema is authoritative):\n\
  * session — summary, full, save, save_as, open, new, close, \
list_open, recents, forget_recent, browse, backends. Save/save_as act \
on the currently-loaded project; open/new spawn / focus a project via \
the sidecar's backend launcher (same path as the user's project \
picker); browse lists directories inside the filesystem jail. If you \
need to know what backend ids the user has configured, call \
`backends` before `open`/`new` (`backend_id: \"auto\"` resolves to \
the currently-active one)\n\
  * transport — play, stop, record, locate, loop, get\n\
  * tracks — list, describe\n\
  * mixer — set_gain_db, set_mute, set_solo, set_pan, get\n\
  * regions — list, create, delete, move, trim, set_fade, reverse, \
set_gain, split, duplicate\n\
  * plugins — catalog, on_track, describe, insert, remove, move, \
set_bypass, set_param\n\
  * automation — list, set_mode, draw, point_add, point_update, \
point_delete\n\
  * midi — patches_on_track, channel_config, region_replace_notes, \
note_add, note_update, note_delete (note-level ops; for beat \
patterns use the sequencer tool below)\n\
  * sequencer — show, set_layout, set_cells, add_pattern, arrange, \
clear, show_viz (Hydrogen / Fruity-Loops-style cell + pattern + \
arrangement authoring — first-class in Foyer)\n\
  * scripts — capabilities, list, get, save, delete, enable, run, \
recover_disabled (host scripts — Lua under Ardour. Call `capabilities` \
FIRST to learn what types/languages/hooks the shim advertises). ALSO \
the agent-skill surface: `skills` (manifest of all enabled \
playbooks) + `skill { name }` (fetch one playbook body). Lua-authoring \
playbooks live there too — `ardour-lua-dsp`, `ardour-lua-action`, \
`ardour-lua-hook`, `ardour-lua-snippet` — load them BEFORE drafting a \
script so you don't trip the silent-instantiation-failure traps.\n\
  * ui — query, open, close, focus, set_tile_tree (drive the user's \
browser layout: spawn missing windows on their behalf, focus a \
buried panel, swap the tile tree to a preset. Always `query` first \
to learn what's open + the available window kinds. Pair with \
`visualize.screen` to confirm the change visually)\n\
  * visualize — timeline / mixer / waveform / spectrogram / \
automation_lane / event_heatmap / midi_roll\n\
  * spectrum — capabilities (probe what the host's FFT pipeline \
supports), snapshot (one-shot FFT frame on master / monitor / a \
specific track, returned as per-channel dBFS bins). Pair with \
`visualize.spectrogram` for a temporal waterfall PNG\n\
\n\
Operating principles:\n\
  * Always survey state first when the request is vague — \
session.summary + tracks.list / regions.list are cheap.\n\
  * **Batch whenever you can.** Each tool call is a WS round-trip; \
firing 30 of them sequentially is observable user latency. Prefer:\n\
      - `plugins.set_params { plugin_id, params: [{control_id, value}…] }` \
when programming a synth patch (one call instead of 30+ set_param calls).\n\
      - `mixer.apply { changes: [{track_id, gain_db?, muted?, soloed?, pan?}…] }` \
when tweaking the mix across multiple tracks.\n\
      - `tracks.describe_many { track_ids: [...] }` instead of N \
`tracks.describe` calls when surveying many tracks at once.\n\
      - `regions.list` with NO `track_id` to enumerate every region \
across every track in one call (the FE was firing 8 sequential per-track \
list calls — one call returns everything).\n\
      - `automation.draw { lane_id, points: [...] }` to swap a whole \
lane atomically instead of point-by-point.\n\
      - `midi.region_replace_notes` for bulk note edits — much cheaper \
than note-by-note `note_add` calls.\n\
    The model gets the same outcome and the user sees the change land \
in one beat instead of thirty.\n\
  * Beat / drum / repetitive patterns: use the `sequencer` tool, \
not hand-written note arrays. Define rows (one per drum or pitch), \
add patterns of cells (`{row, step, velocity}`), and slot patterns \
into bars via `arrange`. The shim regenerates the region's MIDI \
notes from the layout, so you never compute tick offsets for a \
4-on-the-floor kick.\n\
  * For melodic phrases and one-off note edits, `midi.note_add` / \
`midi.region_replace_notes` work in tick coordinates (regions are \
tick-relative; the host honors the session's ticks_per_quarter).\n\
  * `automation.draw` takes a list of `{time_samples, value}` points \
and atomically replaces a lane — ideal for sketching curves over a \
range.\n\
  * MIDI tracks need an instrument to make sound. After you create \
a new MIDI track or MIDI region, immediately insert a synth plugin \
on that track (e.g. `plugins.insert` with a softsynth URI from the \
catalog — gmsynth, fluidsynth-style soundfont player, drumkv1, \
synthv1, padthv1, etc.). A naked MIDI track is silent and the user \
will think you broke something. After the instrument lands, set its \
default preset / params so the notes actually play.\n\
  * Respect solo state. Before adding new tracks (audio or MIDI), \
check whether ANY track on the session is currently soloed via \
`tracks.list` / `mixer.get`. If yes, the new track will be muted by \
default while solo is active — solo the new track too (or warn the \
user) so they can hear what you just made. Same rule when restoring \
a track from a duplicate / template.\n\
  * Destructive operations may be gated by the operator's autonomy \
mode (`ask` pauses for approval; `auto` dispatches immediately). If \
a tool returns `Rejected`, explain that to the user and offer a \
narrower alternative.\n\
";

pub struct AgentRuntime {
    inner: Arc<Mutex<RuntimeInner>>,
    events_tx: broadcast::Sender<AgentEvent>,
    /// Pending tool-confirmation oneshots keyed by `call_id`. Inserted
    /// when the engine parks a Safe-mode destructive call, resolved by
    /// `AgentRuntime::confirm_tool`.
    confirms: Arc<Mutex<std::collections::HashMap<String, oneshot::Sender<bool>>>>,
    tools: ToolRegistry,
    welcome_ctx: Arc<RwLock<WelcomeContext>>,
    store: Arc<AgentStore>,
    backend: tokio::sync::RwLock<Option<std::sync::Weak<dyn Backend>>>,
    /// Live, shareable mirror of `backend`. Cloned into every
    /// `ToolContext` so tools read the *current* Weak — fixes the
    /// "session swap mid-turn → subsequent tools hit the previous
    /// shim" bug where `ToolContext.backend` used to be a one-shot
    /// snapshot captured at engine-build time.
    backend_ref: crate::tools::BackendRef,
    fe_render: tokio::sync::RwLock<Option<Arc<dyn crate::tools::FeRenderer>>>,
    headless_render: tokio::sync::RwLock<Option<Arc<dyn crate::tools::HeadlessRenderer>>>,
    ui_director: tokio::sync::RwLock<Option<Arc<dyn crate::tools::UiDirector>>>,
    session_director: tokio::sync::RwLock<Option<Arc<dyn crate::tools::SessionDirector>>>,
    spectrum_director: tokio::sync::RwLock<Option<Arc<dyn crate::tools::SpectrumDirector>>>,
    /// Active session id. Every record produced by the conversation
    /// is queued for batched JSONL append against this session.
    active_session_id: tokio::sync::RwLock<String>,
    /// Pending-write queue. Drained by the flusher task every
    /// `FLUSH_INTERVAL` (or on session switch / shutdown). Keyed by
    /// session id so a switch mid-flush still flushes the right
    /// session's tail before reading the new one.
    pending_writes:
        Arc<Mutex<std::collections::HashMap<String, Vec<foyer_schema::AgentMessageRecord>>>>,
    /// Cancellation token for the currently-running turn (if any).
    /// `send_user_message` installs a fresh one; `stop_current_turn`
    /// trips it so the engine can finalize the partial assistant
    /// content and return.
    current_cancel: tokio::sync::RwLock<Option<tokio_util::sync::CancellationToken>>,
    /// Serialises run_turn so a "stop + send" gesture waits for the
    /// prior turn to fully unwind before the new turn's
    /// `inner.busy = true` flips. Without this, two `send_user_message`
    /// tasks can run concurrently — the new one acquires the slot,
    /// the old one's deferred busy=false then clears the new turn's
    /// busy flag mid-flight and the UI shows the agent as idle while
    /// it's still working.
    turn_lock: tokio::sync::Mutex<()>,
}

const FLUSH_INTERVAL_MS: u64 = 1500;
const FLUSH_BATCH_HIGH_WATER: usize = 32;

struct RuntimeInner {
    config: AgentConfig,
    conversation: Arc<Mutex<Conversation>>,
    llm: Arc<OpenAiHttpClient>,
    busy: bool,
}

impl AgentRuntime {
    pub async fn new() -> Result<Arc<Self>, crate::store::StoreError> {
        let store = Arc::new(AgentStore::open_default().await?);
        Self::with_store(store).await
    }

    pub async fn with_store(store: Arc<AgentStore>) -> Result<Arc<Self>, crate::store::StoreError> {
        let mut config = AgentConfig::default();
        // Rehydrate any prior LLM transport / autonomy settings. Lets
        // a server restart pick up the operator's last-saved endpoint
        // without them having to re-open Settings → Save (and avoids
        // the much worse pitfall of localStorage-only config that
        // never propagates to other clients).
        if let Some(stored) = store.load_config().await {
            if let Some(e) = stored.endpoint {
                config.endpoint = e;
            }
            if let Some(m) = stored.model {
                config.model = m;
            }
            if stored.api_key.as_deref().is_some_and(|k| !k.is_empty()) {
                config.api_key = stored.api_key;
            }
            if let Some(a) = stored.autonomy {
                config.autonomy = a;
            }
        }
        let llm = Arc::new(OpenAiHttpClient::new(
            config.endpoint.clone(),
            config.api_key.clone(),
        ));
        let (events_tx, _) = broadcast::channel(256);
        let welcome_ctx = Arc::new(RwLock::new(WelcomeContext::default()));
        let mut tools_vec: Vec<Arc<dyn crate::tools::Tool>> =
            vec![Arc::new(WelcomeTool::new(welcome_ctx.clone()))];
        // Pass a weak ref to the agent store so the scripts tool's
        // `skills` / `skill` subcommands can load playbooks from the
        // harness's skill directory on demand.
        let store_weak = Arc::downgrade(&store);
        for t in crate::tools::default_registry_with_store(Some(store_weak)).iter() {
            tools_vec.push(t.clone());
        }
        let tools = ToolRegistry::from_tools(tools_vec);
        // Pick the active session: prefer the persisted one, else
        // create a fresh empty session so first-boot has something
        // to write to.
        let (sessions_at_boot, active_at_boot) = store.list_sessions().await;
        let active_id = match active_at_boot {
            Some(id) if sessions_at_boot.iter().any(|s| s.id == id) => id,
            _ => {
                let info = store.new_session(None).await?;
                info.id
            }
        };
        let initial_records = store
            .load_session_records(&active_id)
            .await
            .unwrap_or_default();
        let mut conv = Conversation::new();
        for rec in initial_records {
            conv.import_record(rec);
        }
        let runtime = Arc::new(Self {
            inner: Arc::new(Mutex::new(RuntimeInner {
                config,
                conversation: Arc::new(Mutex::new(conv)),
                llm,
                busy: false,
            })),
            events_tx,
            confirms: Arc::new(Mutex::new(Default::default())),
            tools,
            welcome_ctx: welcome_ctx.clone(),
            store: store.clone(),
            backend: tokio::sync::RwLock::new(None),
            backend_ref: crate::tools::BackendRef::default(),
            fe_render: tokio::sync::RwLock::new(None),
            headless_render: tokio::sync::RwLock::new(None),
            ui_director: tokio::sync::RwLock::new(None),
            session_director: tokio::sync::RwLock::new(None),
            spectrum_director: tokio::sync::RwLock::new(None),
            active_session_id: tokio::sync::RwLock::new(active_id),
            pending_writes: Arc::new(Mutex::new(Default::default())),
            current_cancel: tokio::sync::RwLock::new(None),
            turn_lock: tokio::sync::Mutex::new(()),
        });
        WelcomeTool::refresh_from_store(&welcome_ctx, &store, DEFAULT_SYSTEM_PROMPT.to_string())
            .await;
        // Background flusher: every ~1.5 s, drain pending writes per
        // session and append them in one batched JSONL write. Keeps
        // streaming-token churn off the disk hot path.
        runtime.spawn_session_flusher();
        Ok(runtime)
    }

    fn spawn_session_flusher(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut ticker =
                tokio::time::interval(std::time::Duration::from_millis(FLUSH_INTERVAL_MS));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticker.tick().await;
                let Some(rt) = weak.upgrade() else { break };
                rt.flush_pending_writes().await;
            }
        });
    }

    /// Drain the pending-writes queue into the store. Called by the
    /// flusher task and explicitly before every session switch /
    /// delete so JSONL state mirrors the live transcript.
    pub async fn flush_pending_writes(&self) {
        let drained = {
            let mut g = self.pending_writes.lock().await;
            std::mem::take(&mut *g)
        };
        for (sid, records) in drained {
            if records.is_empty() {
                continue;
            }
            if let Err(e) = self.store.append_records_batch(&sid, &records).await {
                tracing::warn!("agent session flush failed for {sid}: {e}");
            }
        }
    }

    async fn enqueue_record(&self, record: foyer_schema::AgentMessageRecord) {
        let sid = self.active_session_id.read().await.clone();
        let mut g = self.pending_writes.lock().await;
        let entry = g.entry(sid).or_insert_with(Vec::new);
        // Dedupe by id: the engine emits the same assistant record
        // multiple times per turn (initial empty push + after
        // attach_tool_calls + after each tool result). Persisting all
        // copies leaves the JSONL with stale snapshots (pending
        // statuses, empty content) that reload as duplicate / blank
        // rows. Keep only the latest version per id.
        if let Some(slot) = entry.iter_mut().find(|r| r.id == record.id) {
            *slot = record;
        } else {
            entry.push(record);
        }
        let _ = FLUSH_BATCH_HIGH_WATER;
        // High-water flush: if the queue is large, schedule an
        // immediate drain in a detached task so we don't unbounded-
        // grow on a chatty turn.
        if entry.len() >= FLUSH_BATCH_HIGH_WATER {
            let weak = std::sync::Arc::downgrade(&self.pending_writes);
            let store = self.store.clone();
            drop(g);
            tokio::spawn(async move {
                let Some(map) = weak.upgrade() else { return };
                let drained = {
                    let mut g = map.lock().await;
                    std::mem::take(&mut *g)
                };
                for (sid, records) in drained {
                    let _ = store.append_records_batch(&sid, &records).await;
                }
            });
        }
    }

    pub fn tools(&self) -> &ToolRegistry {
        &self.tools
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AgentEvent> {
        self.events_tx.subscribe()
    }

    pub async fn attach_backend(&self, backend: std::sync::Weak<dyn Backend>) {
        // Keep the tokio-locked field around for the
        // `external_engine_parts` early-bail check; the shared
        // `backend_ref` is what every in-flight ToolContext actually
        // reads, so update it too. The shared write is sync (std
        // RwLock); the contention window is microsecond-scale.
        *self.backend.write().await = Some(backend.clone());
        *self
            .backend_ref
            .write()
            .expect("agent backend_ref poisoned") = Some(backend);
    }

    /// Install (or replace) the visualize renderers. The runtime
    /// passes whatever is set into every `ToolContext` it builds, so
    /// `visualize` calls land on these implementations.
    pub async fn set_renderers(
        &self,
        fe: Option<Arc<dyn crate::tools::FeRenderer>>,
        headless: Option<Arc<dyn crate::tools::HeadlessRenderer>>,
    ) {
        *self.fe_render.write().await = fe;
        *self.headless_render.write().await = headless;
    }

    /// Read the currently installed FE renderer (if any). Used by
    /// the MCP server when it builds its own `ToolContext` for an
    /// external client — keeps the visualize tool reachable through
    /// MCP, not just through the in-process loop.
    pub async fn fe_renderer(&self) -> Option<Arc<dyn crate::tools::FeRenderer>> {
        self.fe_render.read().await.clone()
    }

    /// Read the currently installed headless renderer (if any).
    pub async fn headless_renderer(&self) -> Option<Arc<dyn crate::tools::HeadlessRenderer>> {
        self.headless_render.read().await.clone()
    }

    /// Install (or replace) the UI director — the broker the `ui`
    /// tool uses to dispatch window-manager directives to an attached
    /// FE. Wired in `attach_agent` on the server side.
    pub async fn set_ui_director(&self, ui: Option<Arc<dyn crate::tools::UiDirector>>) {
        *self.ui_director.write().await = ui;
    }

    /// Read the currently installed UI director (if any). Used by
    /// the MCP server when building a `ToolContext` for an external
    /// client.
    pub async fn ui_director(&self) -> Option<Arc<dyn crate::tools::UiDirector>> {
        self.ui_director.read().await.clone()
    }

    /// Install (or replace) the session director — the broker the
    /// `session` tool uses for multi-session ops (open/new/close/list/
    /// browse/recents). Wired in `attach_agent`.
    pub async fn set_session_director(
        &self,
        director: Option<Arc<dyn crate::tools::SessionDirector>>,
    ) {
        *self.session_director.write().await = director;
    }

    /// Read the currently installed session director (if any).
    pub async fn session_director(&self) -> Option<Arc<dyn crate::tools::SessionDirector>> {
        self.session_director.read().await.clone()
    }

    /// Install the spectrum director (drives transport for offline
    /// capture). See `SpectrumDirector` in `tools/mod.rs`.
    pub async fn set_spectrum_director(
        &self,
        director: Option<Arc<dyn crate::tools::SpectrumDirector>>,
    ) {
        *self.spectrum_director.write().await = director;
    }

    /// Read the currently installed spectrum director (if any).
    pub async fn spectrum_director(&self) -> Option<Arc<dyn crate::tools::SpectrumDirector>> {
        self.spectrum_director.read().await.clone()
    }

    /// Read the current "prefer headless renderer" flag — surfaced to
    /// MCP's `ToolContext` so external clients honor the same toggle
    /// the in-process agent does.
    pub async fn prefer_headless_render(&self) -> bool {
        let inner = self.inner.lock().await;
        inner.config.prefer_headless_render
    }

    pub async fn snapshot_state(&self) -> AgentEvent {
        let inner = self.inner.lock().await;
        let conv = inner.conversation.lock().await;
        AgentEvent::State {
            config: inner.config.public(),
            busy: inner.busy,
            transcript_len: conv.len() as u32,
        }
    }

    pub async fn history(&self) -> Vec<AgentMessageRecord> {
        let inner = self.inner.lock().await;
        let conv = inner.conversation.lock().await;
        conv.snapshot()
    }

    pub async fn clear_history(&self) {
        {
            let inner = self.inner.lock().await;
            let mut conv = inner.conversation.lock().await;
            conv.clear();
        }
        let _ = self.events_tx.send(self.snapshot_state().await);
    }

    pub async fn set_autonomy(&self, autonomy: AgentAutonomy) {
        {
            let mut inner = self.inner.lock().await;
            inner.config.autonomy = autonomy;
        }
        self.persist_config().await;
        let _ = self.events_tx.send(self.snapshot_state().await);
    }

    pub async fn set_config(
        &self,
        endpoint: Option<String>,
        model: Option<String>,
        api_key: Option<String>,
    ) {
        {
            let mut inner = self.inner.lock().await;
            if let Some(e) = endpoint {
                inner.config.endpoint = e;
            }
            if let Some(m) = model {
                inner.config.model = m;
            }
            if let Some(k) = api_key {
                inner.config.api_key = if k.is_empty() { None } else { Some(k) };
            }
            // Rebuild LLM client with new credentials.
            inner.llm = Arc::new(OpenAiHttpClient::new(
                inner.config.endpoint.clone(),
                inner.config.api_key.clone(),
            ));
        }
        self.persist_config().await;
        let _ = self.events_tx.send(self.snapshot_state().await);
    }

    async fn persist_config(&self) {
        let stored = {
            let inner = self.inner.lock().await;
            crate::store::StoredAgentConfig {
                endpoint: Some(inner.config.endpoint.clone()),
                model: Some(inner.config.model.clone()),
                api_key: inner.config.api_key.clone(),
                autonomy: Some(inner.config.autonomy),
            }
        };
        if let Err(e) = self.store.save_config(&stored).await {
            tracing::warn!("agent config save failed: {e}");
        }
    }

    /// Seed the prefer-headless-render bool from the server's
    /// `config.yaml`. Read-only from the wire surface — it's a
    /// deployment knob, not a per-session toggle.
    pub async fn set_prefer_headless_render(&self, prefer: bool) {
        let mut inner = self.inner.lock().await;
        inner.config.prefer_headless_render = prefer;
    }

    /// Apply boot-time overrides from CLI / env / config.yaml WITHOUT
    /// writing them to the persisted store. Keeps the FAB's saved
    /// config intact so a temporary env-var override doesn't quietly
    /// rewrite the user's last "Save" in the settings modal — they'd
    /// have no way to undo it once the env var vanishes. Each `Some`
    /// replaces the live value (and rebuilds the LLM client when
    /// transport-shape fields move); `None` leaves the post-store
    /// value alone.
    pub async fn apply_boot_overrides(
        &self,
        endpoint: Option<String>,
        model: Option<String>,
        api_key: Option<String>,
    ) {
        let mut transport_dirty = false;
        {
            let mut inner = self.inner.lock().await;
            if let Some(e) = endpoint {
                inner.config.endpoint = e;
                transport_dirty = true;
            }
            if let Some(m) = model {
                inner.config.model = m;
            }
            if let Some(k) = api_key {
                inner.config.api_key = if k.is_empty() { None } else { Some(k) };
                transport_dirty = true;
            }
            if transport_dirty {
                inner.llm = Arc::new(OpenAiHttpClient::new(
                    inner.config.endpoint.clone(),
                    inner.config.api_key.clone(),
                ));
            }
        }
        let _ = self.events_tx.send(self.snapshot_state().await);
    }

    /// Public snapshot of the live LLM-transport config. The HTTP
    /// proxy uses this to know which upstream model id to inject
    /// when an incoming OpenAI request specifies `foyer-agent`.
    pub async fn config_snapshot(&self) -> AgentConfigPublic {
        let inner = self.inner.lock().await;
        inner.config.public()
    }

    /// Borrow the welcome context for external surfaces (OpenAI
    /// proxy, MCP) that want the same skills/memory snapshot the
    /// in-process agent loads. Returns an `Arc` so the caller can
    /// hold it across awaits without contesting the runtime lock.
    pub fn welcome_context(&self) -> Arc<RwLock<WelcomeContext>> {
        self.welcome_ctx.clone()
    }

    /// Pull the parts the OpenAI proxy needs to build a transient
    /// `AgentEngine` without touching the persistent conversation.
    /// Returns `None` when no backend is attached — caller surfaces a
    /// 503 to the HTTP client.
    pub async fn external_engine_parts(&self) -> Option<ExternalEngineParts> {
        let inner = self.inner.lock().await;
        let llm = inner.llm.clone();
        let model = inner.config.model.clone();
        let prefer_headless = inner.config.prefer_headless_render;
        drop(inner);
        // Gate on "is a backend currently attached?" via the existing
        // tokio field, but pass the shared `backend_ref` so swaps
        // mid-turn (HTTP requests typically don't trigger them, but
        // the same fix shape applies) are picked up by every tool
        // call.
        self.backend.read().await.clone()?;
        let backend = self.backend_ref.clone();
        let fe_render = self.fe_render.read().await.clone();
        let headless_render = self.headless_render.read().await.clone();
        let ui_director = self.ui_director.read().await.clone();
        let session_director = self.session_director.read().await.clone();
        let spectrum_director = self.spectrum_director.read().await.clone();
        Some(ExternalEngineParts {
            llm,
            model,
            tools: self.tools.clone(),
            ctx: ToolContext {
                backend,
                fe_attached: fe_render.is_some(),
                fe_render,
                headless_render,
                ui_director,
                session_director,
                spectrum_director,
                prefer_headless_render: prefer_headless,
            },
            system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
        })
    }

    pub async fn confirm_tool(&self, call_id: &str, approve: bool) {
        let mut map = self.confirms.lock().await;
        if let Some(tx) = map.remove(call_id) {
            let _ = tx.send(approve);
        }
    }

    pub async fn send_user_message(
        self: &Arc<Self>,
        body: String,
        attachments: Vec<foyer_schema::agent::AgentAttachment>,
    ) -> Result<(), EngineError> {
        // Trip any prior turn's cancellation FIRST, BEFORE waiting on
        // the turn lock. Stop+Send works by firing `agent_stop`
        // followed immediately by `agent_send`; the stop alone cancels
        // the token but the send_user_message still has to wait for
        // the prior task to release the turn lock. Tripping cancel
        // here makes that wait short — the prior task's tool loop +
        // LLM stream both check the token and bail out quickly.
        if let Some(prev) = self.current_cancel.read().await.clone() {
            prev.cancel();
        }
        // Serialise concurrent turns. Without this, the second send's
        // `inner.busy = true` and the first send's
        // `inner.busy = false` race; the UI ends up flicking the busy
        // indicator off mid-turn. The lock is dropped at function end,
        // after the new turn finishes — so the next `send` only
        // proceeds once we're fully unwound.
        let _turn_guard = self.turn_lock.lock().await;

        let Some((engine, ctx)) = self.build_engine_and_ctx().await else {
            return Err(EngineError::Tool(crate::tools::ToolError::BackendGone));
        };
        let sink: Arc<dyn EngineSink> = Arc::new(RuntimeSink {
            events: self.events_tx.clone(),
            confirms: self.confirms.clone(),
            runtime: Arc::downgrade(self),
        });
        // Install a fresh cancellation token so `stop_current_turn`
        // can interrupt a runaway / unwanted stream while we're mid-
        // turn.
        let cancel = tokio_util::sync::CancellationToken::new();
        {
            let mut slot = self.current_cancel.write().await;
            // Belt-and-braces: cancel any token that snuck in between
            // our prior cancel call and acquiring the slot. Healthy
            // turn lifecycle clears it below.
            if let Some(prev) = slot.take() {
                prev.cancel();
            }
            *slot = Some(cancel.clone());
        }
        // Mark busy + broadcast.
        {
            let mut inner = self.inner.lock().await;
            inner.busy = true;
        }
        let _ = self.events_tx.send(self.snapshot_state().await);
        let result = engine.run_turn(body, attachments, ctx, sink, cancel).await;
        {
            let mut inner = self.inner.lock().await;
            inner.busy = false;
        }
        {
            let mut slot = self.current_cancel.write().await;
            *slot = None;
        }
        let _ = self.events_tx.send(self.snapshot_state().await);
        result
    }

    /// Cancel the in-flight engine turn. The engine's stream loop
    /// observes the cancellation token, finalises whatever partial
    /// assistant content it has buffered (so the transcript keeps
    /// the LLM's pre-interrupt output as context), and returns
    /// `Ok(())`. No-op when the harness is idle.
    pub async fn stop_current_turn(&self) {
        if let Some(tok) = self.current_cancel.read().await.clone() {
            tok.cancel();
        }
    }

    async fn build_engine_and_ctx(&self) -> Option<(AgentEngine, ToolContext)> {
        let inner = self.inner.lock().await;
        let llm = inner.llm.clone();
        let model = inner.config.model.clone();
        let autonomy = inner.config.autonomy;
        let conversation = inner.conversation.clone();
        let ui_locale = inner.config.ui_locale.clone();
        drop(inner);
        // Gate engine construction on "a backend is currently
        // attached" but pass the SHARED `backend_ref` into ToolContext
        // so every tool call inside the turn reads the LIVE Weak —
        // this is what lets a mid-turn `session.new` flow into
        // subsequent `tracks.list` against the NEW shim. Without this
        // the ctx held a one-shot snapshot and the agent kept hitting
        // the previously-active session even after a swap.
        self.backend.read().await.clone()?;
        let backend = self.backend_ref.clone();
        let fe_render = self.fe_render.read().await.clone();
        let headless_render = self.headless_render.read().await.clone();
        let ui_director = self.ui_director.read().await.clone();
        let session_director = self.session_director.read().await.clone();
        let prefer_headless = {
            let inner = self.inner.lock().await;
            inner.config.prefer_headless_render
        };
        let spectrum_director = self.spectrum_director.read().await.clone();
        let ctx = ToolContext {
            backend,
            fe_attached: fe_render.is_some(),
            fe_render,
            headless_render,
            ui_director,
            session_director,
            spectrum_director,
            prefer_headless_render: prefer_headless,
        };
        // The locale directive is short and goes at the *end* of the
        // system prompt so it overrides any baseline assumption about
        // English-default output. We deliberately don't translate the
        // directive itself — the model will recognize the language
        // name and respond in kind. `en` (or unset) skips the
        // directive entirely so English deployments stay identical.
        let mut system_prompt = DEFAULT_SYSTEM_PROMPT.to_string();
        if let Some(code) = ui_locale.as_deref() {
            let normalized = code.trim().to_ascii_lowercase();
            if !normalized.is_empty() && !normalized.starts_with("en") {
                let language_name = language_name_for(&normalized).unwrap_or(&normalized);
                system_prompt.push_str(&format!(
                    "\n\nUI LOCALE: the user's Foyer interface is set to {language_name} ({normalized}). \
                     Respond to the user in {language_name} unless they explicitly write in a different \
                     language; tool arguments and identifiers stay in their canonical form (English / \
                     code) regardless of conversation language."
                ));
            }
        }
        let engine = AgentEngine {
            conversation,
            tools: self.tools.clone(),
            llm: llm as Arc<dyn crate::llm::LlmClient>,
            model,
            autonomy,
            system_prompt,
        };
        Some((engine, ctx))
    }

    /// Update the live UI locale (BCP-47 code: `en`, `es`, `ja-JP`, …).
    /// Called from the WS handler when a client sends
    /// `Command::AgentSetConfig` with `ui_locale`. Persists alongside
    /// the rest of the agent config so a server restart keeps the
    /// last-set value.
    pub async fn set_ui_locale(&self, code: Option<String>) {
        {
            let mut inner = self.inner.lock().await;
            inner.config.ui_locale = code.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
        }
        self.persist_config().await;
    }

    // ─── Filesystem stores ─────────────────────────────────────────

    pub async fn list_skills(&self) -> Vec<AgentSkillInfo> {
        let skills = self.store.list_skills().await.unwrap_or_default();
        WelcomeTool::refresh_from_store(
            &self.welcome_ctx,
            &self.store,
            DEFAULT_SYSTEM_PROMPT.to_string(),
        )
        .await;
        let _ = self.events_tx.send(AgentEvent::Skills(skills.clone()));
        skills
    }

    pub async fn set_skill_enabled(&self, name: &str, enabled: bool) {
        let _ = self.store.set_skill_enabled(name, enabled).await;
        let _ = self.list_skills().await;
    }

    pub async fn upload_skill(&self, name: &str, body: &str) {
        let _ = self.store.upload_skill(name, body).await;
        let _ = self.list_skills().await;
    }

    pub async fn list_memories(&self) -> Vec<AgentMemoryInfo> {
        let memories = self.store.list_memories().await.unwrap_or_default();
        WelcomeTool::refresh_from_store(
            &self.welcome_ctx,
            &self.store,
            DEFAULT_SYSTEM_PROMPT.to_string(),
        )
        .await;
        let _ = self.events_tx.send(AgentEvent::Memories(memories.clone()));
        memories
    }

    pub async fn save_memory(&self, name: &str, body: &str) {
        let _ = self.store.save_memory(name, body).await;
        let _ = self.list_memories().await;
    }

    pub async fn forget_memory(&self, name: &str) {
        let _ = self.store.forget_memory(name).await;
        let _ = self.list_memories().await;
    }

    // ─── Chat sessions ─────────────────────────────────────────────

    pub async fn active_session_id(&self) -> String {
        self.active_session_id.read().await.clone()
    }

    pub async fn list_sessions_event(&self) -> AgentEvent {
        let (sessions, _) = self.store.list_sessions().await;
        let active_id = Some(self.active_session_id.read().await.clone());
        AgentEvent::SessionsListed {
            sessions,
            active_id,
        }
    }

    pub async fn broadcast_sessions(&self) {
        let _ = self.events_tx.send(self.list_sessions_event().await);
    }

    pub async fn new_session(&self, title: Option<String>) {
        // Flush any pending writes against the soon-to-be-old session.
        self.flush_pending_writes().await;
        let info = match self.store.new_session(title.as_deref()).await {
            Ok(i) => i,
            Err(e) => {
                tracing::warn!("agent: failed to create session: {e}");
                return;
            }
        };
        // Mark in store + swap conversation in-process.
        let _ = self.store.set_active_session(&info.id).await;
        *self.active_session_id.write().await = info.id.clone();
        {
            let inner = self.inner.lock().await;
            inner.conversation.lock().await.clear();
        }
        let _ = self.events_tx.send(AgentEvent::SessionActivated {
            id: info.id,
            title: info.title,
        });
        self.broadcast_sessions().await;
        self.broadcast_history().await;
        let _ = self.events_tx.send(self.snapshot_state().await);
    }

    pub async fn load_session(&self, id: String) {
        self.flush_pending_writes().await;
        let records = match self.store.load_session_records(&id).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("agent: load_session({id}) failed: {e}");
                return;
            }
        };
        let _ = self.store.set_active_session(&id).await;
        *self.active_session_id.write().await = id.clone();
        {
            let inner = self.inner.lock().await;
            let mut conv = inner.conversation.lock().await;
            conv.clear();
            for rec in records {
                conv.import_record(rec);
            }
        }
        // Find the title for the broadcast event.
        let title = self
            .store
            .list_sessions()
            .await
            .0
            .into_iter()
            .find(|s| s.id == id)
            .map(|s| s.title)
            .unwrap_or_default();
        let _ = self
            .events_tx
            .send(AgentEvent::SessionActivated { id, title });
        self.broadcast_sessions().await;
        self.broadcast_history().await;
        let _ = self.events_tx.send(self.snapshot_state().await);
    }

    pub async fn delete_session(&self, id: String) {
        self.flush_pending_writes().await;
        if let Err(e) = self.store.delete_session(&id).await {
            tracing::warn!("agent: delete_session({id}) failed: {e}");
            return;
        }
        // If we just deleted the active session the store rotates
        // to whichever was most recently updated; fall back to a
        // fresh one if none remain.
        let new_active = self.store.active_session_id().await;
        let chosen = match new_active {
            Some(next) => next,
            None => match self.store.new_session(None).await {
                Ok(i) => i.id,
                Err(_) => {
                    self.broadcast_sessions().await;
                    return;
                }
            },
        };
        if *self.active_session_id.read().await != chosen {
            self.load_session(chosen).await;
        } else {
            self.broadcast_sessions().await;
        }
    }

    pub async fn rename_session(&self, id: String, title: String) {
        let _ = self.store.rename_session(&id, &title).await;
        self.broadcast_sessions().await;
    }

    async fn broadcast_history(&self) {
        let records = self.history().await;
        for r in records.clone() {
            let _ = self.events_tx.send(AgentEvent::Message(r));
        }
        // We deliberately fan out as Messages (instead of a History
        // event) so the FE's transcript-rebuild path doesn't have to
        // distinguish. The active_session_id event tells the FE to
        // clear first; subsequent Messages refill it.
        let _ = records; // suppress unused warning if records is empty
    }

    pub async fn list_templates(&self) -> Vec<AgentTemplateInfo> {
        let templates = self.store.list_templates().await.unwrap_or_default();
        let _ = self
            .events_tx
            .send(AgentEvent::Templates(templates.clone()));
        templates
    }
}

// ─── Glue: EngineSink → broadcast channel ──────────────────────────

struct RuntimeSink {
    runtime: std::sync::Weak<AgentRuntime>,
    events: broadcast::Sender<AgentEvent>,
    confirms: Arc<Mutex<std::collections::HashMap<String, oneshot::Sender<bool>>>>,
}

#[async_trait::async_trait]
impl EngineSink for RuntimeSink {
    async fn on_record(&self, record: AgentMessageRecord) {
        // Persist before broadcasting so a crash between events_tx.send
        // and the flusher tick can't lose the record.
        if let Some(rt) = self.runtime.upgrade() {
            rt.enqueue_record(record.clone()).await;
        }
        let _ = self.events.send(AgentEvent::Message(record));
    }
    async fn on_token(&self, message_id: u64, delta: String) {
        let _ = self.events.send(AgentEvent::Token { message_id, delta });
    }
    async fn on_tool_update(
        &self,
        message_id: u64,
        call_id: String,
        status: AgentToolStatus,
        preview: Option<String>,
        result_json: String,
    ) {
        let _ = self.events.send(AgentEvent::ToolUpdate {
            message_id,
            call_id,
            status,
            preview,
            result_json,
        });
    }
    async fn await_confirm(&self, call_id: String) -> Result<bool, EngineError> {
        let (tx, rx) = oneshot::channel();
        self.confirms.lock().await.insert(call_id, tx);
        rx.await.map_err(|_| EngineError::ConfirmDropped)
    }
    async fn on_trace(&self, line: serde_json::Value) {
        let Some(rt) = self.runtime.upgrade() else {
            return;
        };
        let sid = rt.active_session_id.read().await.clone();
        if let Err(e) = rt.store.append_trace(&sid, &line).await {
            tracing::debug!("agent trace append failed: {e}");
        }
    }
}

/// Map a BCP-47 code (or its language root) to the English display
/// name of the language. Used by the locale-aware system-prompt
/// directive — every supported locale gets a hand-curated mapping so
/// the model sees an unambiguous language name instead of a code it
/// might mis-parse. Falls back to None when we don't ship a catalog
/// for the locale (the caller then uses the raw code).
fn language_name_for(code: &str) -> Option<&'static str> {
    let root = code.split('-').next().unwrap_or(code);
    match root {
        "en" => Some("English"),
        "de" => Some("German"),
        "es" => Some("Spanish"),
        "it" => Some("Italian"),
        "ja" => Some("Japanese"),
        "ko" => Some("Korean"),
        "zh" => Some("Chinese"),
        _ => None,
    }
}
