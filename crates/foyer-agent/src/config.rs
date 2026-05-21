// SPDX-License-Identifier: Apache-2.0
//! Live agent config — endpoint, model, API key, autonomy mode.
//!
//! The API key never leaves the server. The public-facing view sent
//! over the WS ([`foyer_schema::agent::AgentConfigPublic`]) only flags
//! whether one is set.

use foyer_schema::agent::{AgentAutonomy, AgentConfigPublic};

/// Default endpoint when nothing else is configured — points at the
/// in-process WebLLM bridge so a fresh server can be agent-poked
/// from the browser without any setup, as long as a WebLLM model is
/// loaded in the FAB. Replaced by user config on first save.
pub const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:0/llm/v1";
pub const DEFAULT_MODEL: &str = "Llama-3.2-3B-Instruct-q4f32_1-MLC";

/// Live, mutable agent config.
#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
    pub autonomy: AgentAutonomy,
    /// When `true` the `visualize` tool tries the headless renderer
    /// before the attached browser. Useful for deterministic agent
    /// runs (CI, batch transcription, etc.) where the output
    /// shouldn't depend on whether a human has a tab open.
    pub prefer_headless_render: bool,
    /// BCP-47 code of the language the most-recently-active UI client
    /// is set to (`en`, `es`, `ja`, …). The engine appends a one-line
    /// directive to the system prompt so the assistant answers in the
    /// same language the user is reading the rest of the UI in. None
    /// (or `en`) leaves the system prompt alone.
    pub ui_locale: Option<String>,
    /// Multimodal feedback policy — controls whether the engine
    /// splices a tool's image/audio output back into the next-turn
    /// model context so the VLM's vision tower (and on omni models,
    /// the audio encoder) can reason over its own renders.
    pub media_feedback: MediaFeedback,
}

/// How aggressively the engine should re-inject tool-produced media
/// into the next round's LLM context. Image feedback is on by default
/// — the whole point of a vision-capable model is to reason over
/// renders. Audio feedback is off by default because even a single
/// 30-second omni-format clip burns ~30k tokens; users opt in per
/// deployment via `config.yaml` or the OpenAI proxy env var.
#[derive(Debug, Clone)]
pub struct MediaFeedback {
    /// When `true` the engine pushes a synthetic user record with
    /// `image_url` content blocks after any tool whose result carries
    /// images. The vision tower then fires on the next round —
    /// without this, the bytes only ride alongside the egress stream
    /// to the chat client and the model is blind to its own visuals.
    pub image_enabled: bool,
    /// Sibling policy for audio renders. Off by default — see
    /// [`AudioFeedback`] for the per-clip and per-turn budgets the
    /// engine enforces when this is on.
    pub audio: AudioFeedback,
}

impl Default for MediaFeedback {
    fn default() -> Self {
        Self {
            image_enabled: true,
            audio: AudioFeedback::default(),
        }
    }
}

/// Knobs for re-injecting audio renders into the model context on
/// omni-capable backends. Off by default because audio in the
/// context window is *expensive* — gpt-4o-audio bills ~1k tokens
/// per second of mono 24 kHz audio; a 30-second clip is ~30k tokens
/// before anything else in the turn.
#[derive(Debug, Clone)]
pub struct AudioFeedback {
    pub enabled: bool,
    /// Hard cap on a single attached clip. Anything longer is dropped
    /// from the feedback path with a one-line assistant note so the
    /// user knows the model is reasoning blind on that turn.
    pub max_seconds: u32,
    /// Cumulative cap across all audio clips in a single turn. Once
    /// exceeded, the rest of the turn's audio is dropped with the
    /// same kind of explicit note.
    pub max_total_seconds: u32,
}

impl Default for AudioFeedback {
    fn default() -> Self {
        Self {
            enabled: false,
            max_seconds: 30,
            max_total_seconds: 90,
        }
    }
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            endpoint: DEFAULT_ENDPOINT.to_string(),
            model: DEFAULT_MODEL.to_string(),
            api_key: None,
            autonomy: AgentAutonomy::default(),
            prefer_headless_render: false,
            ui_locale: None,
            media_feedback: MediaFeedback::default(),
        }
    }
}

impl AgentConfig {
    pub fn public(&self) -> AgentConfigPublic {
        AgentConfigPublic {
            endpoint: self.endpoint.clone(),
            model: self.model.clone(),
            has_api_key: self
                .api_key
                .as_ref()
                .map(|k| !k.is_empty())
                .unwrap_or(false),
            autonomy: self.autonomy,
        }
    }
}
