// SPDX-License-Identifier: Apache-2.0
//! OpenAI-compatible LLM transport.
//!
//! One trait, one HTTP implementation. Anthropic, OpenAI, OpenRouter,
//! Ollama, vLLM, and the in-process WebLLM bridge all expose
//! `/v1/chat/completions` — so a single `OpenAiHttpClient` is the
//! complete LLM surface from the harness's perspective. Swap the
//! `endpoint` + `api_key` and you've switched provider.

use async_trait::async_trait;
use futures::Stream;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::pin::Pin;

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("transport error: {0}")]
    Transport(String),
    #[error("decode error: {0}")]
    Decode(String),
    #[error("server returned {status}: {body}")]
    Server { status: u16, body: String },
    #[error("stream aborted: {0}")]
    StreamAborted(String),
}

/// One turn as sent to the OpenAI chat-completions API. Mirrors the
/// wire shape so we can pass `Vec<LlmMessage>` straight into the
/// request body.
///
/// `content` is `serde_json::Value` to accommodate BOTH classic
/// `content: "string"` and multi-modal `content: [{type: "text"...},
/// {type: "image_url"...}]` shapes that vision-capable models use.
/// The engine sets a string when there's no media, an array of
/// content blocks when there's at least one image attachment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmMessage {
    pub role: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub content: Value,
    /// Tool calls the assistant emitted on this turn.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<LlmToolCall>,
    /// For tool replies — the call this is a response to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmToolCall {
    pub id: String,
    #[serde(rename = "type", default = "default_tool_type")]
    pub kind: String,
    pub function: LlmFunctionCall,
}

fn default_tool_type() -> String {
    "function".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmFunctionCall {
    pub name: String,
    /// JSON-encoded args, exactly as the model emitted them.
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LlmRequest {
    pub model: String,
    pub messages: Vec<LlmMessage>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<LlmToolDef>,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LlmToolDef {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub function: LlmFunctionDef,
}

#[derive(Debug, Clone, Serialize)]
pub struct LlmFunctionDef {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

/// Single non-streaming response.
#[derive(Debug, Clone, Deserialize)]
pub struct LlmResponse {
    pub choices: Vec<LlmChoice>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LlmChoice {
    pub message: LlmMessage,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

/// One streaming chunk parsed from the SSE feed.
#[derive(Debug, Clone, Deserialize)]
pub struct LlmStreamChunk {
    pub choices: Vec<LlmStreamChoice>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LlmStreamChoice {
    #[serde(default)]
    pub delta: LlmDelta,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct LlmDelta {
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    /// Out-of-band reasoning trace from OpenAI-compat reasoner
    /// endpoints. Different providers ship the same payload under
    /// different field names — vLLM's `--enable-reasoning` mode uses
    /// `reasoning_content`, DeepSeek's native API uses `reasoning`,
    /// OpenRouter has been seen with both, and some proxies bury it
    /// inside `delta.reasoning.content`. We accept all of them
    /// (`alias`) and the engine folds whatever lands here into the
    /// assistant content stream wrapped in `<think>...</think>` so
    /// the UI's single parser handles tagged AND separate-field
    /// shapes.
    #[serde(default, alias = "reasoning")]
    pub reasoning_content: Option<String>,
    /// Tool calls in this delta. Indices are stable across deltas;
    /// arguments concatenate.
    #[serde(default)]
    pub tool_calls: Vec<LlmDeltaToolCall>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LlmDeltaToolCall {
    pub index: u32,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub function: Option<LlmDeltaFunction>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LlmDeltaFunction {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arguments: Option<String>,
}

pub type LlmStream = Pin<Box<dyn Stream<Item = Result<LlmStreamChunk, LlmError>> + Send>>;

/// Transport-agnostic LLM client.
#[async_trait]
pub trait LlmClient: Send + Sync {
    async fn complete(&self, request: LlmRequest) -> Result<LlmResponse, LlmError>;
    async fn stream(&self, request: LlmRequest) -> Result<LlmStream, LlmError>;
}

/// HTTP client that speaks OpenAI's `/v1/chat/completions` shape.
pub struct OpenAiHttpClient {
    http: reqwest::Client,
    endpoint: String,
    api_key: Option<String>,
}

impl OpenAiHttpClient {
    pub fn new(endpoint: String, api_key: Option<String>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(180))
                .build()
                .expect("reqwest client builds with defaults"),
            endpoint,
            api_key,
        }
    }

    pub fn update(&mut self, endpoint: String, api_key: Option<String>) {
        self.endpoint = endpoint;
        self.api_key = api_key;
    }

    fn url(&self) -> String {
        let base = self.endpoint.trim_end_matches('/');
        format!("{base}/chat/completions")
    }

    fn auth(&self, mut req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(key) = self.api_key.as_ref() {
            if !key.is_empty() {
                req = req.bearer_auth(key);
            }
            // Anthropic native shape: `x-api-key` header. We ALSO set
            // bearer so a single key works against both auth styles —
            // Anthropic's `/v1/chat/completions` ignores Authorization,
            // OpenAI ignores `x-api-key`. Belt and braces.
            if self.endpoint.contains("anthropic") {
                req = req
                    .header("x-api-key", key)
                    .header("anthropic-version", "2023-06-01");
            }
        }
        req
    }
}

#[async_trait]
impl LlmClient for OpenAiHttpClient {
    async fn complete(&self, mut request: LlmRequest) -> Result<LlmResponse, LlmError> {
        request.stream = false;
        let resp = self
            .auth(self.http.post(self.url()).json(&request))
            .send()
            .await
            .map_err(|e| LlmError::Transport(e.to_string()))?;
        let status = resp.status();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| LlmError::Transport(e.to_string()))?;
        if !status.is_success() {
            return Err(LlmError::Server {
                status: status.as_u16(),
                body: String::from_utf8_lossy(&bytes).into_owned(),
            });
        }
        serde_json::from_slice(&bytes).map_err(|e| LlmError::Decode(e.to_string()))
    }

    async fn stream(&self, mut request: LlmRequest) -> Result<LlmStream, LlmError> {
        use eventsource_stream::Eventsource;
        use futures::StreamExt;
        request.stream = true;
        let resp = self
            .auth(self.http.post(self.url()).json(&request))
            .send()
            .await
            .map_err(|e| LlmError::Transport(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp
                .text()
                .await
                .unwrap_or_else(|e| format!("<body read failed: {e}>"));
            return Err(LlmError::Server {
                status: status.as_u16(),
                body,
            });
        }
        let stream = resp
            .bytes_stream()
            .eventsource()
            .filter_map(|item| async move {
                match item {
                    Ok(ev) => {
                        if ev.data == "[DONE]" {
                            return None;
                        }
                        match serde_json::from_str::<LlmStreamChunk>(&ev.data) {
                            Ok(chunk) => Some(Ok(chunk)),
                            Err(e) => Some(Err(LlmError::Decode(format!(
                                "stream chunk: {e}: {}",
                                ev.data
                            )))),
                        }
                    }
                    Err(e) => Some(Err(LlmError::StreamAborted(e.to_string()))),
                }
            });
        Ok(Box::pin(stream))
    }
}
