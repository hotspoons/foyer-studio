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
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            endpoint: DEFAULT_ENDPOINT.to_string(),
            model: DEFAULT_MODEL.to_string(),
            api_key: None,
            autonomy: AgentAutonomy::default(),
            prefer_headless_render: false,
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
