// SPDX-License-Identifier: Apache-2.0
//! Transport-agnostic core of the OpenAI-compatible proxy.
//!
//! The HTTP routes live in `foyer-server::openai_proxy`; the parsing,
//! the transient `Conversation` build-up, and the engine wiring all
//! sit here so we can unit-test the conversion without spinning up
//! axum. Each incoming request runs in its own ephemeral
//! [`Conversation`] so the FAB's persistent transcript stays untouched.
//!
//! The agent loop drives whatever upstream LLM is configured on the
//! runtime, executes Foyer tools internally, and forwards the
//! assistant's text deltas back to the caller as standard
//! `delta.content` chunks. Tool calls + tool results never leak to
//! the caller — from their perspective Foyer is a smarter chat model.

use std::sync::Arc;

use async_trait::async_trait;
use foyer_schema::agent::{
    AgentAttachment, AgentAutonomy, AgentMessageRecord, AgentRole, AgentToolStatus,
};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{mpsc, Mutex};

use crate::conversation::Conversation;
use crate::engine::{AgentEngine, EngineError, EngineSink};
use crate::runtime::ExternalEngineParts;
use crate::tools::ToolResult;

/// Parsed view of the OpenAI `POST /v1/chat/completions` body. The
/// caller's `model` field is captured but ignored — the agent uses
/// whatever upstream model the runtime is configured for.
#[derive(Debug, Clone)]
pub struct ExternalChatRequest {
    /// The new user prompt — last user message in the request's
    /// `messages[]`, with any text-content blocks concatenated.
    pub final_user_body: String,
    /// Inline attachments (image / audio) carried on the final user
    /// message.
    pub final_user_attachments: Vec<AgentAttachment>,
    /// Prior conversation, in order. Already split into the wire
    /// records the conversation ring expects.
    pub prior: Vec<AgentMessageRecord>,
    /// Original model string the caller asked for. Surfaced in the
    /// response envelope so OpenAI-shaped clients see what they
    /// sent come back.
    pub model: String,
    /// `true` when the caller asked for SSE streaming.
    pub stream: bool,
}

/// One event the proxy emits while a request is in flight.
#[derive(Debug, Clone)]
pub enum ExternalChatStreamEvent {
    /// Assistant content delta.
    Content(String),
    /// A tool produced inline media (image / audio render / …) on
    /// this turn. The HTTP layer surfaces these as content blocks on
    /// the assistant message AND as a markdown snippet in the text
    /// stream so plain-text clients still see something.
    Attachment(AgentAttachment),
    /// Engine finished cleanly. No more events follow.
    End,
    /// Engine errored mid-turn. No more events follow.
    Error(String),
}

#[derive(Debug, Deserialize)]
struct RawMessage {
    role: String,
    #[serde(default)]
    content: Value,
    #[serde(default, rename = "tool_call_id")]
    tool_call_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawBody {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    messages: Vec<RawMessage>,
    #[serde(default)]
    stream: bool,
}

/// Parse an OpenAI `chat/completions` body. Returns an error string
/// (suitable for a `400` response body) when the request is unusable.
pub fn parse_request(body: Value) -> Result<ExternalChatRequest, String> {
    let parsed: RawBody = serde_json::from_value(body)
        .map_err(|e| format!("invalid OpenAI chat-completions body: {e}"))?;
    if parsed.messages.is_empty() {
        return Err("`messages` is empty".into());
    }
    // Find the index of the trailing user message — that's the
    // request's prompt. Everything before it gets imported as
    // history; anything after (rare — usually the caller appends
    // their fresh user message last) is appended to the prompt body
    // so we don't silently drop it.
    let last_user_idx = parsed
        .messages
        .iter()
        .rposition(|m| m.role == "user")
        .ok_or_else(|| "no user message in `messages`".to_string())?;

    let mut prior: Vec<AgentMessageRecord> = Vec::with_capacity(last_user_idx);
    let mut next_id: u64 = 1;
    for msg in parsed.messages.iter().take(last_user_idx) {
        let role = match msg.role.as_str() {
            "system" => AgentRole::System,
            "user" => AgentRole::User,
            "assistant" => AgentRole::Assistant,
            "tool" => AgentRole::Tool,
            // Strict OpenAI servers reject unknown roles; we ignore
            // them so a `function` (deprecated legacy role) doesn't
            // sink the whole request.
            _ => continue,
        };
        let (text, atts) = parse_content(&msg.content);
        let record = AgentMessageRecord {
            id: next_id,
            role,
            content: text,
            tool_calls: Vec::new(),
            tool_call_id: msg.tool_call_id.clone(),
            attachments: atts,
            ts_ms: 0,
        };
        next_id += 1;
        prior.push(record);
    }

    let final_msg = &parsed.messages[last_user_idx];
    let (mut final_text, final_atts) = parse_content(&final_msg.content);
    // Anything after the final user turn — usually nothing, but
    // defensive: if a client appends a system or tool tail, fold its
    // text into the prompt so it isn't silently lost.
    for msg in parsed.messages.iter().skip(last_user_idx + 1) {
        let (text, _atts) = parse_content(&msg.content);
        if !text.is_empty() {
            if !final_text.is_empty() {
                final_text.push_str("\n\n");
            }
            final_text.push_str(&text);
        }
    }

    Ok(ExternalChatRequest {
        final_user_body: final_text,
        final_user_attachments: final_atts,
        prior,
        model: parsed.model.unwrap_or_else(|| "foyer-agent".to_string()),
        stream: parsed.stream,
    })
}

/// Pull text + attachments out of an OpenAI content value. Accepts
/// both the classic `"content": "string"` shape and the multi-modal
/// `"content": [{type:..., ...}]` block array. Unknown block types
/// are dropped (forward-compat with newer OpenAI shapes).
fn parse_content(value: &Value) -> (String, Vec<AgentAttachment>) {
    match value {
        Value::String(s) => (s.clone(), Vec::new()),
        Value::Array(arr) => {
            let mut text = String::new();
            let mut atts = Vec::new();
            for block in arr {
                let Some(obj) = block.as_object() else {
                    continue;
                };
                let kind = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match kind {
                    "text" => {
                        if let Some(t) = obj.get("text").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(t);
                        }
                    }
                    "image_url" => {
                        let url = obj.get("image_url").and_then(|v| match v {
                            Value::String(s) => Some(s.as_str()),
                            Value::Object(o) => o.get("url").and_then(|u| u.as_str()),
                            _ => None,
                        });
                        if let Some(url) = url {
                            if let Some(att) = data_url_to_attachment(url, "image") {
                                atts.push(att);
                            }
                        }
                    }
                    "input_audio" => {
                        let audio = obj.get("input_audio").and_then(|v| v.as_object());
                        if let Some(audio) = audio {
                            let data = audio.get("data").and_then(|v| v.as_str()).unwrap_or("");
                            let format = audio
                                .get("format")
                                .and_then(|v| v.as_str())
                                .unwrap_or("wav");
                            if !data.is_empty() {
                                atts.push(AgentAttachment {
                                    name: format!("audio.{format}"),
                                    mime: format!("audio/{format}"),
                                    b64: data.to_string(),
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
            (text, atts)
        }
        _ => (String::new(), Vec::new()),
    }
}

fn data_url_to_attachment(url: &str, default_stem: &str) -> Option<AgentAttachment> {
    // Accept `data:<mime>;base64,<b64>` AND fall through to a plain
    // `https://…` URL by ignoring it (we can't inline-forward a
    // remote URL without fetching it; out of scope for now).
    let rest = url.strip_prefix("data:")?;
    let (header, b64) = rest.split_once(',')?;
    let mime = header.strip_suffix(";base64").unwrap_or(header).to_string();
    let ext = mime.rsplit('/').next().unwrap_or("bin");
    Some(AgentAttachment {
        name: format!("{default_stem}.{ext}"),
        mime,
        b64: b64.to_string(),
    })
}

/// Spawn the agent loop against a fresh `Conversation` seeded with
/// the caller's prior turns. Returns a receiver streaming
/// `ExternalChatStreamEvent`s — the HTTP layer adapts these into
/// either an SSE stream or a single non-streaming response. The
/// returned cancel token can be tripped (e.g. on connection drop)
/// to interrupt the engine.
pub fn run_external_chat(
    parts: ExternalEngineParts,
    request: ExternalChatRequest,
) -> (
    mpsc::UnboundedReceiver<ExternalChatStreamEvent>,
    tokio_util::sync::CancellationToken,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    let cancel = tokio_util::sync::CancellationToken::new();
    let cancel_for_task = cancel.clone();
    tokio::spawn(async move {
        let conv = Arc::new(Mutex::new(Conversation::new()));
        {
            let mut g = conv.lock().await;
            for rec in request.prior {
                g.import_record(rec);
            }
        }
        // External callers can't approve a parked tool — force
        // `Auto` so destructive calls dispatch immediately. The
        // operator gates this behind their api_key + network
        // exposure choice; if they don't want auto-execute they
        // shouldn't expose the endpoint.
        let engine = AgentEngine {
            conversation: conv,
            tools: parts.tools,
            llm: parts.llm,
            model: parts.model,
            autonomy: AgentAutonomy::Auto,
            system_prompt: parts.system_prompt,
        };
        let sink: Arc<dyn EngineSink> = Arc::new(ProxySink { tx: tx.clone() });
        let result = engine
            .run_turn(
                request.final_user_body,
                request.final_user_attachments,
                parts.ctx,
                sink,
                cancel_for_task,
            )
            .await;
        match result {
            Ok(()) => {
                let _ = tx.send(ExternalChatStreamEvent::End);
            }
            Err(EngineError::Interrupted) => {
                // Cancellation is a clean end from the proxy's view —
                // either the client dropped the connection or the
                // server is shutting down. Either way, no error to
                // surface.
                let _ = tx.send(ExternalChatStreamEvent::End);
            }
            Err(e) => {
                let _ = tx.send(ExternalChatStreamEvent::Error(e.to_string()));
            }
        }
    });
    (rx, cancel)
}

struct ProxySink {
    tx: mpsc::UnboundedSender<ExternalChatStreamEvent>,
}

#[async_trait]
impl EngineSink for ProxySink {
    async fn on_record(&self, _record: AgentMessageRecord) {
        // Records carry the full assistant snapshot AND tool-call
        // metadata; the proxy only forwards assistant text deltas,
        // which arrive via on_token. Ignored here.
    }
    async fn on_token(&self, _message_id: u64, delta: String) {
        let _ = self.tx.send(ExternalChatStreamEvent::Content(delta));
    }
    async fn on_tool_update(
        &self,
        _message_id: u64,
        call_id: String,
        status: AgentToolStatus,
        _preview: Option<String>,
        result_json: String,
    ) {
        // Surface only completed tool runs — the same tool is updated
        // multiple times per call (Pending → Running → Done) and we
        // only want to harvest media once at the end.
        if !matches!(status, AgentToolStatus::Done) || result_json.is_empty() {
            return;
        }
        if let Ok(parsed) = serde_json::from_str::<ToolResult>(&result_json) {
            // Convention 1: ToolResult.image_png_b64 — set by
            // `visualize` and any future tool that produces a PNG.
            if let Some(b64) = parsed.image_png_b64.as_ref() {
                if !b64.is_empty() {
                    let _ = self
                        .tx
                        .send(ExternalChatStreamEvent::Attachment(AgentAttachment {
                            name: format!("{call_id}.png"),
                            mime: "image/png".to_string(),
                            b64: b64.clone(),
                        }));
                }
            }
            // Convention 2: ToolResult.data carries one or more
            // attachment-shaped entries — a forward-compatible hook
            // so tools that produce audio renders, MIDI snippets,
            // etc. can surface them without a schema bump every
            // time. Shape: `data.attachments: [{name, mime, b64}]`
            // matches `AgentAttachment` exactly so the JSON
            // deserializes 1:1.
            if let Some(arr) = parsed.data.get("attachments").and_then(|v| v.as_array()) {
                for item in arr {
                    if let Ok(att) = serde_json::from_value::<AgentAttachment>(item.clone()) {
                        if !att.b64.is_empty() {
                            let _ = self.tx.send(ExternalChatStreamEvent::Attachment(att));
                        }
                    }
                }
            }
        }
    }
    async fn await_confirm(&self, _call_id: String) -> Result<bool, EngineError> {
        // Forced `Trust` autonomy on the proxy engine means this
        // path is only reachable if a tool's `destructive()` impl
        // changes mid-flight or the autonomy gate flips between
        // construction and dispatch. Auto-approve so a stuck
        // confirm doesn't hang the HTTP response forever.
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_simple_text() {
        let req = parse_request(json!({
            "model": "foyer-agent",
            "messages": [
                {"role": "user", "content": "hi"}
            ]
        }))
        .unwrap();
        assert_eq!(req.final_user_body, "hi");
        assert!(req.final_user_attachments.is_empty());
        assert!(req.prior.is_empty());
        assert!(!req.stream);
    }

    #[test]
    fn parse_history_with_image() {
        let req = parse_request(json!({
            "model": "foyer-agent",
            "stream": true,
            "messages": [
                {"role": "system", "content": "be terse"},
                {"role": "user", "content": "look at this"},
                {"role": "assistant", "content": "ok"},
                {"role": "user", "content": [
                    {"type": "text", "text": "what is it"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}}
                ]}
            ]
        }))
        .unwrap();
        assert!(req.stream);
        assert_eq!(req.prior.len(), 3);
        assert_eq!(req.prior[0].role, AgentRole::System);
        assert_eq!(req.prior[1].role, AgentRole::User);
        assert_eq!(req.prior[2].role, AgentRole::Assistant);
        assert_eq!(req.final_user_body, "what is it");
        assert_eq!(req.final_user_attachments.len(), 1);
        assert_eq!(req.final_user_attachments[0].mime, "image/png");
        assert_eq!(req.final_user_attachments[0].b64, "AAA");
    }

    #[test]
    fn rejects_no_user() {
        let err = parse_request(json!({
            "messages": [
                {"role": "system", "content": "x"}
            ]
        }))
        .unwrap_err();
        assert!(err.contains("no user"));
    }
}
