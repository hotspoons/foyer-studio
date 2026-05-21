// SPDX-License-Identifier: Apache-2.0
//! HTTP surface for the in-process agent at `/v1/*`.
//!
//! Lets external apps treat Foyer as an OpenAI-compatible upstream:
//! point any client (Cursor, OpenWebUI, a custom Python script, …)
//! at `http://<foyer-host>:<port>/v1` and they get the full agent —
//! tool registry, system prompt, skills/memory — with their own
//! conversation history. Each request runs in a transient
//! [`foyer_agent::Conversation`] so the FAB's persistent transcript
//! stays untouched.
//!
//! Routes:
//!
//!   * `POST /v1/chat/completions` — OpenAI chat-completions, with
//!     SSE streaming + non-streaming. Forwards assistant text deltas
//!     as standard `delta.content` chunks. Tool calls + tool results
//!     happen inside Foyer and are invisible to the caller.
//!   * `GET  /v1/models` — single entry: `{id: "foyer-agent", ...}`.
//!
//! Media handling sticks to the OpenAI multimodal shape — assistant
//! attachments ride as `{type:"image_url"|"input_audio", ...}` content
//! blocks inside `delta.content` (streaming) or `message.content`
//! (non-streaming). Any OpenAI-compatible client (Open WebUI,
//! LibreChat, Cursor, …) sees the same shape vLLM / OpenAI itself
//! emits.
//!
//! Tool-call surface: tool dispatch + results travel on a single
//! additive extension field, `foyer_tool_calls`, attached to the
//! assistant `delta` (streaming) or `message` (non-streaming). Strict
//! OpenAI clients ignore unknown fields and see the assistant text
//! alone; extension-aware clients (the FAB, a tool-trail-rendering
//! LibreChat fork, etc.) parse the field directly and render a chip /
//! card per call without having to scrape markdown out of the
//! content stream. Set `FOYER_OPENAI_PROXY_SHOW_TOOL_CALLS=1` to
//! ALSO interleave a `> 🔧 …` / `> ✅ …` line into `delta.content`
//! so plain-text clients (curl, terminal chat front-ends without an
//! extension hook) see what fired without parsing JSON.
//!
//! Auth: when `AppState.openai_proxy_api_key` is set, every `/v1/*`
//! request must carry `Authorization: Bearer <key>` or it's rejected
//! with `401`. Unset = open (operator is on the hook for network
//! exposure).

use std::convert::Infallible;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::Json;
use foyer_agent::openai_proxy::{parse_request, ExternalChatStreamEvent};
use foyer_schema::agent::AgentAttachment;
use futures::stream::Stream;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::AppState;

/// Model id advertised on `/v1/models` and echoed on response
/// envelopes. The actual upstream model is whatever the agent
/// runtime is configured for; this is purely the public label.
pub const FOYER_MODEL_ID: &str = "foyer-agent";

pub async fn list_models(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    if let Err(resp) = check_auth(&state, &HeaderMap::new()).await {
        return resp.into_response();
    }
    let now = unix_ts();
    let data = vec![json!({
        "id": FOYER_MODEL_ID,
        "object": "model",
        "created": now,
        "owned_by": "foyer-studio",
    })];
    (
        StatusCode::OK,
        Json(json!({"object": "list", "data": data})),
    )
        .into_response()
}

pub async fn chat_completions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    if let Err(resp) = check_auth(&state, &headers).await {
        return resp.into_response();
    }
    let agent = match state.agent.read().await.clone() {
        Some(a) => a,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "error": {
                        "message": "agent runtime not attached",
                        "type": "server_error",
                    }
                })),
            )
                .into_response();
        }
    };

    let request = match parse_request(body) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": { "message": e, "type": "invalid_request_error" }
                })),
            )
                .into_response();
        }
    };

    let Some(parts) = agent.external_engine_parts().await else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": {
                    "message": "backend not attached — open a project first",
                    "type": "server_error",
                }
            })),
        )
            .into_response();
    };

    let wants_stream = request.stream;
    let echoed_model = request.model.clone();
    let expose_tool_calls = state
        .openai_proxy_expose_tool_calls
        .load(std::sync::atomic::Ordering::Relaxed);
    let (rx, cancel) = foyer_agent::openai_proxy::run_external_chat(parts, request);
    let completion_id = format!("chatcmpl-{}", Uuid::new_v4().simple());

    if wants_stream {
        Sse::new(ChunkStream::new(
            rx,
            completion_id,
            echoed_model,
            cancel,
            expose_tool_calls,
        ))
        .keep_alive(KeepAlive::default())
        .into_response()
    } else {
        collect_completion(rx, completion_id, echoed_model, expose_tool_calls)
            .await
            .into_response()
    }
}

async fn check_auth(
    state: &Arc<AppState>,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<Value>)> {
    let key = state.openai_proxy_api_key.read().await.clone();
    let Some(expected) = key else {
        return Ok(()); // open endpoint
    };
    let supplied = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if supplied == Some(expected.as_str()) {
        Ok(())
    } else {
        Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error": {
                    "message": "missing or invalid Authorization: Bearer <key>",
                    "type": "invalid_request_error",
                    "code": "invalid_api_key",
                }
            })),
        ))
    }
}

async fn collect_completion(
    mut rx: mpsc::UnboundedReceiver<ExternalChatStreamEvent>,
    completion_id: String,
    model: String,
    expose_tool_calls: bool,
) -> (StatusCode, Json<Value>) {
    let mut buf = String::new();
    let mut attachments: Vec<AgentAttachment> = Vec::new();
    // Insertion-ordered accumulator for the synthetic field. The
    // OpenAI proxy emits ToolStart at dispatch time and ToolEnd at
    // terminal-status time; we merge by call_id so a single entry
    // ends up with both args (from start) and result (from end).
    // IndexMap-style with a Vec + helper keeps the order deterministic
    // without dragging in a new dep.
    let mut synthetic: Vec<SyntheticToolCall> = Vec::new();
    let mut error: Option<String> = None;
    while let Some(ev) = rx.recv().await {
        match ev {
            ExternalChatStreamEvent::Content(s) => buf.push_str(&s),
            ExternalChatStreamEvent::Attachment(att) => {
                // Inline a markdown reference so plain-text clients
                // see something; the structured copy goes into the
                // content-block array below.
                if !buf.is_empty() && !buf.ends_with('\n') {
                    buf.push('\n');
                }
                buf.push_str(&attachment_markdown(&att));
                attachments.push(att);
            }
            ExternalChatStreamEvent::ToolStart {
                call_id,
                tool_name,
                args_json,
            } => {
                upsert_synthetic_start(&mut synthetic, &call_id, &tool_name, &args_json);
                if expose_tool_calls {
                    if !buf.is_empty() && !buf.ends_with('\n') {
                        buf.push('\n');
                    }
                    buf.push_str(&tool_start_markdown(&tool_name, &args_json));
                    buf.push('\n');
                }
            }
            ExternalChatStreamEvent::ToolEnd {
                call_id,
                tool_name,
                ok,
                summary,
                result_json,
            } => {
                upsert_synthetic_end(
                    &mut synthetic,
                    &call_id,
                    &tool_name,
                    ok,
                    &summary,
                    &result_json,
                );
                if expose_tool_calls {
                    if !buf.is_empty() && !buf.ends_with('\n') {
                        buf.push('\n');
                    }
                    buf.push_str(&tool_end_markdown(&tool_name, ok, &summary));
                    buf.push('\n');
                }
            }
            ExternalChatStreamEvent::End => break,
            ExternalChatStreamEvent::Error(e) => {
                error = Some(e);
                break;
            }
        }
    }
    if let Some(e) = error {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": { "message": e, "type": "server_error" }
            })),
        );
    }
    let created = unix_ts();
    // Content shape: plain string when no attachments came back
    // (broadest compatibility); content-block array when at least
    // one attachment rode along (OpenAI's vision/audio convention).
    // No foyer-specific extension field — every OpenAI-compatible
    // client reads the block array natively; the markdown reference
    // we splice into the leading text block keeps plain-text consumers
    // visually whole.
    let content = if attachments.is_empty() {
        Value::String(buf.clone())
    } else {
        let mut blocks = Vec::with_capacity(attachments.len() + 1);
        if !buf.is_empty() {
            blocks.push(json!({ "type": "text", "text": buf }));
        }
        for att in &attachments {
            blocks.push(attachment_content_block(att));
        }
        Value::Array(blocks)
    };
    let mut message = json!({
        "role": "assistant",
        "content": content,
    });
    if !synthetic.is_empty() {
        message["foyer_tool_calls"] =
            Value::Array(synthetic.iter().map(SyntheticToolCall::to_json).collect());
    }
    let body = json!({
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": "stop",
        }],
        // Usage isn't tracked through the transient engine yet —
        // emit zeros so OpenAI-shape clients that read this field
        // don't NPE.
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }
    });
    (StatusCode::OK, Json(body))
}

/// Markdown line shown when a tool starts dispatching. Plain-text
/// clients see "🔧 tool(args)"; markdown clients render the same
/// thing as a blockquote so it's visually distinct from the
/// assistant's narrative. Args are inlined as code; very long arg
/// blobs are truncated so a single tool call doesn't paint a wall
/// of JSON. Empty args render as `tool()`.
fn tool_start_markdown(tool_name: &str, args_json: &str) -> String {
    let args = args_preview(args_json);
    if args.is_empty() {
        format!("> 🔧 `{tool_name}()`")
    } else {
        format!("> 🔧 `{tool_name}({args})`")
    }
}

/// Markdown line shown when a tool finishes. Success uses ✅,
/// failure uses ❌; an empty summary collapses to just the icon and
/// name (callers that want full data can read structured tool events
/// — this line is the human-readable surface).
fn tool_end_markdown(tool_name: &str, ok: bool, summary: &str) -> String {
    let icon = if ok { "✅" } else { "❌" };
    let label = if tool_name.is_empty() {
        "tool".to_string()
    } else {
        format!("`{tool_name}`")
    };
    if summary.is_empty() {
        format!("> {icon} {label}")
    } else {
        format!("> {icon} {label} → {summary}")
    }
}

/// Compact args preview — strips outer braces, collapses whitespace,
/// truncates over 120 chars. Pure-cosmetic; the structured event
/// still carries the full args JSON for clients that want it.
fn args_preview(args_json: &str) -> String {
    let trimmed = args_json.trim();
    if trimmed.is_empty() || trimmed == "{}" {
        return String::new();
    }
    let inner = trimmed
        .strip_prefix('{')
        .and_then(|s| s.strip_suffix('}'))
        .unwrap_or(trimmed);
    let collapsed: String = inner
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.chars().count() > 120 {
        let head: String = collapsed.chars().take(120).collect();
        format!("{head}…")
    } else {
        collapsed
    }
}

/// Markdown rendering for an attachment that can be appended to a
/// plain-string `content` field. Images use the standard
/// `![](data:…)` form so any markdown-rendering client paints them
/// inline; audio falls back to an HTML5 `<audio>` tag which most
/// chat UIs (Open WebUI, LibreChat, etc.) honor. Unknown MIME types
/// degrade to a labeled link with a truncated data URL preview.
fn attachment_markdown(att: &AgentAttachment) -> String {
    let url = format!("data:{};base64,{}", att.mime, att.b64);
    if att.mime.starts_with("image/") {
        format!("![{}]({})", att.name, url)
    } else if att.mime.starts_with("audio/") {
        format!(
            "<audio controls src=\"{}\" title=\"{}\"></audio>",
            url, att.name
        )
    } else {
        format!("[{}]({})", att.name, url)
    }
}

/// Structured content-block representation for one attachment. Used
/// in non-streaming `message.content` arrays AND streamed as a
/// content-array `delta` for clients that grok the multi-modal
/// streaming shape.
fn attachment_content_block(att: &AgentAttachment) -> Value {
    if att.mime.starts_with("image/") {
        let url = format!("data:{};base64,{}", att.mime, att.b64);
        json!({
            "type": "image_url",
            "image_url": { "url": url },
        })
    } else if att.mime.starts_with("audio/") {
        // gpt-4o-audio convention — same shape we'd accept on the
        // way IN; matches OpenAI's documented `input_audio` block.
        let format = att.mime.strip_prefix("audio/").unwrap_or("wav");
        json!({
            "type": "input_audio",
            "input_audio": { "data": att.b64, "format": format },
        })
    } else {
        // Generic fallback — non-standard but lossless. Lets a
        // forward-thinking client recover the bytes for a MIME the
        // OpenAI block schema doesn't cover (PDF, MIDI render,
        // session archive, …).
        json!({
            "type": "file",
            "file": {
                "name": att.name,
                "mime": att.mime,
                "b64": att.b64,
            },
        })
    }
}

/// Adapter: drains the proxy's `ExternalChatStreamEvent` channel and
/// emits OpenAI-shaped SSE chunks (`chat.completion.chunk`). Tripping
/// the cancellation token on drop interrupts the engine if the
/// client hangs up mid-stream.
struct ChunkStream {
    rx: mpsc::UnboundedReceiver<ExternalChatStreamEvent>,
    completion_id: String,
    model: String,
    created: u64,
    state: ChunkState,
    cancel: tokio_util::sync::CancellationToken,
    /// When `true`, ToolStart/ToolEnd events also inject a
    /// `> 🔧 …` / `> ✅ …` markdown line into `delta.content` so
    /// plain-text clients see the call without parsing the
    /// `foyer_tool_calls` extension field. When `false`, only the
    /// synthetic field carries the lifecycle — extension-aware
    /// clients render natively, everyone else sees only assistant
    /// content.
    expose_tool_calls: bool,
}

#[derive(Debug, Clone, Copy)]
enum ChunkState {
    /// Initial role chunk hasn't been sent yet.
    NeedsRole,
    /// Streaming content; pull from the channel.
    Streaming,
    /// Emit a `finish_reason: "stop"` chunk on the next poll.
    NeedsFinish,
    /// Emit `[DONE]` on the next poll, then terminate.
    NeedsDone,
    /// Stream closed — return `None` on every poll.
    Done,
}

impl ChunkStream {
    fn new(
        rx: mpsc::UnboundedReceiver<ExternalChatStreamEvent>,
        completion_id: String,
        model: String,
        cancel: tokio_util::sync::CancellationToken,
        expose_tool_calls: bool,
    ) -> Self {
        Self {
            rx,
            completion_id,
            model,
            created: unix_ts(),
            state: ChunkState::NeedsRole,
            cancel,
            expose_tool_calls,
        }
    }

    fn role_chunk(&self) -> SseEvent {
        let payload = json!({
            "id": self.completion_id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{
                "index": 0,
                "delta": { "role": "assistant" },
                "finish_reason": Value::Null,
            }],
        });
        SseEvent::default().data(payload.to_string())
    }

    fn content_chunk(&self, content: &str) -> SseEvent {
        let payload = json!({
            "id": self.completion_id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{
                "index": 0,
                "delta": { "content": content },
                "finish_reason": Value::Null,
            }],
        });
        SseEvent::default().data(payload.to_string())
    }

    fn finish_chunk(&self) -> SseEvent {
        let payload = json!({
            "id": self.completion_id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": "stop",
            }],
        });
        SseEvent::default().data(payload.to_string())
    }
}

impl Stream for ChunkStream {
    type Item = Result<SseEvent, Infallible>;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        use std::task::Poll;
        loop {
            match self.state {
                ChunkState::Done => return Poll::Ready(None),
                ChunkState::NeedsRole => {
                    let ev = self.role_chunk();
                    self.state = ChunkState::Streaming;
                    return Poll::Ready(Some(Ok(ev)));
                }
                ChunkState::NeedsFinish => {
                    let ev = self.finish_chunk();
                    self.state = ChunkState::NeedsDone;
                    return Poll::Ready(Some(Ok(ev)));
                }
                ChunkState::NeedsDone => {
                    self.state = ChunkState::Done;
                    return Poll::Ready(Some(Ok(SseEvent::default().data("[DONE]"))));
                }
                ChunkState::Streaming => match self.rx.poll_recv(cx) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(None) => {
                        self.state = ChunkState::NeedsFinish;
                        continue;
                    }
                    Poll::Ready(Some(ExternalChatStreamEvent::Content(s))) => {
                        if s.is_empty() {
                            continue;
                        }
                        return Poll::Ready(Some(Ok(self.content_chunk(&s))));
                    }
                    Poll::Ready(Some(ExternalChatStreamEvent::Attachment(att))) => {
                        // Emit `delta.content` as an OpenAI content-
                        // block array: a leading text block with the
                        // markdown reference (so plain-text consumers
                        // still see *something* — the markdown link
                        // resolves to the data URL inline below) and
                        // then the structured `image_url` /
                        // `input_audio` / `file` block carrying the
                        // bytes. Every OpenAI-compatible client we
                        // tested (Open WebUI, LibreChat, Cursor,
                        // OpenRouter passthrough) accumulates content-
                        // block arrays from streaming deltas and
                        // renders the rich block natively. Pure text
                        // chunks still ship as plain strings (above)
                        // for maximum compatibility with the
                        // concat-strings-on-every-chunk clients.
                        let md = attachment_markdown(&att);
                        let prefix = if md.starts_with('\n') {
                            md
                        } else {
                            format!("\n{md}")
                        };
                        let blocks = vec![
                            json!({ "type": "text", "text": prefix }),
                            attachment_content_block(&att),
                        ];
                        let payload = json!({
                            "id": self.completion_id,
                            "object": "chat.completion.chunk",
                            "created": self.created,
                            "model": self.model,
                            "choices": [{
                                "index": 0,
                                "delta": { "content": Value::Array(blocks) },
                                "finish_reason": Value::Null,
                            }],
                        });
                        return Poll::Ready(Some(
                            Ok(SseEvent::default().data(payload.to_string())),
                        ));
                    }
                    Poll::Ready(Some(ExternalChatStreamEvent::ToolStart {
                        call_id,
                        tool_name,
                        args_json,
                    })) => {
                        let entry = SyntheticToolCall::running(&call_id, &tool_name, &args_json);
                        let mut delta = serde_json::Map::new();
                        delta.insert(
                            "foyer_tool_calls".to_string(),
                            Value::Array(vec![entry.to_json()]),
                        );
                        if self.expose_tool_calls {
                            let line =
                                format!("\n{}\n", tool_start_markdown(&tool_name, &args_json));
                            delta.insert("content".to_string(), Value::String(line));
                        }
                        let payload = json!({
                            "id": self.completion_id,
                            "object": "chat.completion.chunk",
                            "created": self.created,
                            "model": self.model,
                            "choices": [{
                                "index": 0,
                                "delta": Value::Object(delta),
                                "finish_reason": Value::Null,
                            }],
                        });
                        return Poll::Ready(Some(
                            Ok(SseEvent::default().data(payload.to_string())),
                        ));
                    }
                    Poll::Ready(Some(ExternalChatStreamEvent::ToolEnd {
                        call_id,
                        tool_name,
                        ok,
                        summary,
                        result_json,
                    })) => {
                        let entry = SyntheticToolCall::finished(
                            &call_id,
                            &tool_name,
                            ok,
                            &summary,
                            &result_json,
                        );
                        let mut delta = serde_json::Map::new();
                        delta.insert(
                            "foyer_tool_calls".to_string(),
                            Value::Array(vec![entry.to_json()]),
                        );
                        if self.expose_tool_calls {
                            let line =
                                format!("\n{}\n", tool_end_markdown(&tool_name, ok, &summary));
                            delta.insert("content".to_string(), Value::String(line));
                        }
                        let payload = json!({
                            "id": self.completion_id,
                            "object": "chat.completion.chunk",
                            "created": self.created,
                            "model": self.model,
                            "choices": [{
                                "index": 0,
                                "delta": Value::Object(delta),
                                "finish_reason": Value::Null,
                            }],
                        });
                        return Poll::Ready(Some(
                            Ok(SseEvent::default().data(payload.to_string())),
                        ));
                    }
                    Poll::Ready(Some(ExternalChatStreamEvent::End)) => {
                        self.state = ChunkState::NeedsFinish;
                        continue;
                    }
                    Poll::Ready(Some(ExternalChatStreamEvent::Error(e))) => {
                        self.state = ChunkState::Done;
                        let payload = json!({
                            "error": { "message": e, "type": "server_error" }
                        });
                        return Poll::Ready(Some(
                            Ok(SseEvent::default().data(payload.to_string())),
                        ));
                    }
                },
            }
        }
    }
}

impl Drop for ChunkStream {
    fn drop(&mut self) {
        // Client hung up (or stream finalized) — cancel the engine so
        // a long tool round doesn't keep burning upstream tokens.
        self.cancel.cancel();
    }
}

fn unix_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// One row of the synthetic `foyer_tool_calls` field — additive
/// extension on `delta`/`message` that mirrors the tool calls Foyer
/// dispatched internally. Strict OpenAI clients ignore unknown
/// fields; extension-aware clients (the FAB, a tool-trail-rendering
/// LibreChat fork, etc.) parse this directly and render rich UI
/// without having to scrape the `> 🔧 …` markdown out of
/// `delta.content`.
///
/// Schema (per call_id, merged across lifecycle chunks):
///
/// ```jsonc
/// {
///   "call_id":   "call_…",       // matches OpenAI's tool_call_id
///   "name":      "visualize",    // foyer tool name
///   "args_json": "{…}",          // raw args the model emitted
///   "status":    "running"       // or "done" | "error"
///   "ok":        true,           // present on terminal status
///   "summary":   "rendered …",   // truncated one-liner
///   "result_json": "{…}"         // raw ToolResult JSON with large
///                                // b64 elided (the bytes already
///                                // ride in the standard image_url /
///                                // input_audio content blocks)
/// }
/// ```
#[derive(Debug, Clone)]
struct SyntheticToolCall {
    call_id: String,
    name: String,
    args_json: Option<String>,
    status: SyntheticStatus,
    ok: Option<bool>,
    summary: Option<String>,
    result_json: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum SyntheticStatus {
    Running,
    Done,
    Error,
}

impl SyntheticStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Done => "done",
            Self::Error => "error",
        }
    }
}

impl SyntheticToolCall {
    fn running(call_id: &str, tool_name: &str, args_json: &str) -> Self {
        Self {
            call_id: call_id.to_string(),
            name: tool_name.to_string(),
            args_json: Some(args_json.to_string()),
            status: SyntheticStatus::Running,
            ok: None,
            summary: None,
            result_json: None,
        }
    }

    fn finished(
        call_id: &str,
        tool_name: &str,
        ok: bool,
        summary: &str,
        result_json: &str,
    ) -> Self {
        let sanitized = sanitize_result_json_for_synthetic(result_json);
        Self {
            call_id: call_id.to_string(),
            name: tool_name.to_string(),
            args_json: None,
            status: if ok {
                SyntheticStatus::Done
            } else {
                SyntheticStatus::Error
            },
            ok: Some(ok),
            summary: Some(summary.to_string()),
            result_json: Some(sanitized),
        }
    }

    fn to_json(&self) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert("call_id".into(), Value::String(self.call_id.clone()));
        obj.insert("name".into(), Value::String(self.name.clone()));
        if let Some(args) = &self.args_json {
            obj.insert("args_json".into(), Value::String(args.clone()));
        }
        obj.insert(
            "status".into(),
            Value::String(self.status.as_str().to_string()),
        );
        if let Some(ok) = self.ok {
            obj.insert("ok".into(), Value::Bool(ok));
        }
        if let Some(summary) = &self.summary {
            obj.insert("summary".into(), Value::String(summary.clone()));
        }
        if let Some(rj) = &self.result_json {
            obj.insert("result_json".into(), Value::String(rj.clone()));
        }
        Value::Object(obj)
    }
}

/// Merge a `ToolStart` event into the accumulator used by
/// `collect_completion`. New call_id → append; existing → fill in
/// args + flip status back to `running` (defensive; ToolStart should
/// only fire once per call_id).
fn upsert_synthetic_start(
    out: &mut Vec<SyntheticToolCall>,
    call_id: &str,
    tool_name: &str,
    args_json: &str,
) {
    if let Some(slot) = out.iter_mut().find(|c| c.call_id == call_id) {
        slot.args_json = Some(args_json.to_string());
        if !slot.name.is_empty() {
            // keep the existing name; only fill if missing
        } else {
            slot.name = tool_name.to_string();
        }
        return;
    }
    out.push(SyntheticToolCall::running(call_id, tool_name, args_json));
}

/// Merge a `ToolEnd` event into the accumulator — preserves any
/// args_json captured at ToolStart time so the synthetic entry ends
/// up with the full lifecycle.
fn upsert_synthetic_end(
    out: &mut Vec<SyntheticToolCall>,
    call_id: &str,
    tool_name: &str,
    ok: bool,
    summary: &str,
    result_json: &str,
) {
    let sanitized = sanitize_result_json_for_synthetic(result_json);
    if let Some(slot) = out.iter_mut().find(|c| c.call_id == call_id) {
        slot.status = if ok {
            SyntheticStatus::Done
        } else {
            SyntheticStatus::Error
        };
        slot.ok = Some(ok);
        slot.summary = Some(summary.to_string());
        slot.result_json = Some(sanitized);
        if slot.name.is_empty() {
            slot.name = tool_name.to_string();
        }
        return;
    }
    out.push(SyntheticToolCall::finished(
        call_id,
        tool_name,
        ok,
        summary,
        result_json,
    ));
}

/// Strip large base64 payloads (image_png_b64, audio attachments)
/// from a tool's serialized [`ToolResult`] before it lands on the
/// synthetic `foyer_tool_calls` field. The bytes are already emitted
/// as standard `image_url` / `input_audio` content blocks elsewhere
/// in the same response — including them HERE too would double the
/// wire cost for the same payload (an 80 KB PNG is ~110 KB of b64,
/// each round). The structured `summary` + `data` minus attachment
/// payloads are what an extension renderer actually needs to draw a
/// chip / card; the bytes ride the OpenAI-standard channel.
///
/// Threshold matches the LLM-side redactor in
/// [`foyer_agent::engine::redact_records_for_llm`] so the wire
/// payload and the model's view stay consistent.
fn sanitize_result_json_for_synthetic(result_json: &str) -> String {
    const B64_MAX_CHARS: usize = 24 * 1024;
    let mut v: Value = match serde_json::from_str(result_json) {
        Ok(v) => v,
        Err(_) => return result_json.to_string(),
    };
    elide_large_b64(&mut v, B64_MAX_CHARS);
    serde_json::to_string(&v).unwrap_or_else(|_| result_json.to_string())
}

/// Recursively walk a JSON value and replace any base64-shaped
/// string longer than `max_chars` with a short placeholder. Mirrors
/// `foyer_agent::engine::redact_large_b64_in_value` — duplicated here
/// to avoid pulling a private function across the crate boundary.
fn elide_large_b64(v: &mut Value, max_chars: usize) {
    match v {
        Value::String(s) if s.len() > max_chars && looks_like_b64(s) => {
            let n = s.len();
            *s = format!("[base64 elided: {n} chars]");
        }
        Value::Array(arr) => {
            for item in arr.iter_mut() {
                elide_large_b64(item, max_chars);
            }
        }
        Value::Object(map) => {
            for (_, val) in map.iter_mut() {
                elide_large_b64(val, max_chars);
            }
        }
        _ => {}
    }
}

fn looks_like_b64(s: &str) -> bool {
    if s.len() < 64 {
        return false;
    }
    let sample = &s[..s.len().min(256)];
    sample.bytes().all(|b| {
        b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=' || b == b'\n' || b == b'\r'
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn upsert_start_then_end_merges() {
        let mut acc: Vec<SyntheticToolCall> = Vec::new();
        upsert_synthetic_start(&mut acc, "c1", "visualize", "{\"subcommand\":\"mixer\"}");
        upsert_synthetic_end(
            &mut acc,
            "c1",
            "visualize",
            true,
            "rendered 1234 bytes",
            r#"{"summary":"rendered 1234 bytes","data":{"size":1234}}"#,
        );
        assert_eq!(acc.len(), 1);
        let row = acc[0].to_json();
        assert_eq!(row["call_id"], "c1");
        assert_eq!(row["name"], "visualize");
        assert_eq!(row["status"], "done");
        assert_eq!(row["ok"], true);
        assert_eq!(row["summary"], "rendered 1234 bytes");
        assert!(row["args_json"].as_str().unwrap().contains("\"mixer\""));
        assert!(row["result_json"].as_str().unwrap().contains("1234"));
    }

    #[test]
    fn sanitize_strips_large_image_b64() {
        let big = "A".repeat(30_000);
        let input = json!({
            "summary": "rendered",
            "image_png_b64": big,
            "data": {"attachments": [{"name":"x.png","mime":"image/png","b64": "A".repeat(30_000)}]}
        });
        let cleaned = sanitize_result_json_for_synthetic(&input.to_string());
        assert!(cleaned.contains("base64 elided"));
        // The summary should be preserved (small string)
        assert!(cleaned.contains("rendered"));
        // Total length should be drastically smaller than original
        assert!(cleaned.len() < 5_000);
    }

    #[test]
    fn finished_emits_error_status() {
        let entry = SyntheticToolCall::finished("c2", "render", false, "boom", "boom");
        let j = entry.to_json();
        assert_eq!(j["status"], "error");
        assert_eq!(j["ok"], false);
    }
}
