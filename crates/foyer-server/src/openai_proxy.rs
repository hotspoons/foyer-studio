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
    let (rx, cancel) = foyer_agent::openai_proxy::run_external_chat(parts, request);
    let completion_id = format!("chatcmpl-{}", Uuid::new_v4().simple());

    if wants_stream {
        Sse::new(ChunkStream::new(rx, completion_id, echoed_model, cancel))
            .keep_alive(KeepAlive::default())
            .into_response()
    } else {
        collect_completion(rx, completion_id, echoed_model)
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
) -> (StatusCode, Json<Value>) {
    let mut buf = String::new();
    let mut attachments: Vec<AgentAttachment> = Vec::new();
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
    let body = json!({
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": content,
                // Non-standard echo of the structured attachments so
                // clients that don't grok block arrays can still
                // pull the bytes out cleanly.
                "foyer_attachments": attachments.iter().map(|a| json!({
                    "name": a.name,
                    "mime": a.mime,
                    "b64": a.b64,
                })).collect::<Vec<_>>(),
            },
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
    ) -> Self {
        Self {
            rx,
            completion_id,
            model,
            created: unix_ts(),
            state: ChunkState::NeedsRole,
            cancel,
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
                        // Single chunk carries both surfaces — a
                        // markdown reference inside `delta.content`
                        // (every OpenAI-shape client renders it) and
                        // a structured `delta.foyer_attachments`
                        // entry with the raw bytes (clients that
                        // grok our extension can pull the binary
                        // out without re-decoding the markdown data
                        // URL). Unknown delta fields are ignored
                        // gracefully by every chat-completions
                        // client we tested.
                        let md = attachment_markdown(&att);
                        let prefix = if md.starts_with('\n') {
                            md
                        } else {
                            format!("\n{md}")
                        };
                        let payload = json!({
                            "id": self.completion_id,
                            "object": "chat.completion.chunk",
                            "created": self.created,
                            "model": self.model,
                            "choices": [{
                                "index": 0,
                                "delta": {
                                    "content": prefix,
                                    "foyer_attachments": [{
                                        "name": att.name,
                                        "mime": att.mime,
                                        "b64": att.b64,
                                    }],
                                },
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
