// SPDX-License-Identifier: Apache-2.0
//! WebLLM bridge — relays OpenAI-format requests to the browser
//! running WebLLM via WebGPU.
//!
//! Port of the zip-ties pattern (see DECISIONS 49, and
//! `ext/zip-ties/zip-ties-web/zip_ties_web/webllm_bridge.py`).
//!
//! Layout:
//!
//!   * `POST /llm/v1/chat/completions` (foyer's main port) accepts a
//!     standard OpenAI chat-completions request, relays it over WS
//!     to the browser by uuid, and returns either a single JSON
//!     response or an SSE stream.
//!   * `GET  /llm/v1/models` returns the loaded WebLLM model id.
//!   * `WS   /ws/webllm` is the long-lived connection from the
//!     browser tab. The browser announces itself with
//!     `{type: "model_info", model_id, status}` and then handles
//!     `{id, messages, ...}` payloads with either a single
//!     `{id, choices: [...]}` reply or a stream of
//!     `{id, type: "chunk", choices: [...]}` followed by
//!     `{id, type: "done"}`.
//!
//! The agent harness in `foyer-agent` sees this as a plain
//! OpenAI-compatible endpoint — point `agent_set_config` at
//! `http://127.0.0.1:<port>/llm/v1` with no api_key.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::Json;
use futures::stream::Stream;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Mutex};
use uuid::Uuid;

use crate::AppState;

pub struct WebLlmBridge {
    inner: Mutex<BridgeInner>,
}

#[derive(Default)]
struct BridgeInner {
    /// Outbound channel into the connected browser's WS. `None` when
    /// no browser is attached.
    ws_tx: Option<mpsc::UnboundedSender<String>>,
    /// Pending non-streaming requests keyed by request id.
    pending: HashMap<String, oneshot::Sender<Value>>,
    /// Pending streaming requests keyed by request id.
    streams: HashMap<String, mpsc::UnboundedSender<StreamItem>>,
    /// Last `model_info` payload from the browser.
    model_id: String,
    status: String,
}

pub enum StreamItem {
    Chunk(Value),
    Done,
    Err(String),
}

impl Default for WebLlmBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl WebLlmBridge {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(BridgeInner::default()),
        }
    }

    pub async fn is_ready(&self) -> bool {
        let g = self.inner.lock().await;
        g.ws_tx.is_some() && g.status == "ready"
    }

    pub async fn model_info(&self) -> (String, String) {
        let g = self.inner.lock().await;
        (g.model_id.clone(), g.status.clone())
    }

    /// Send a request and wait for the single non-streaming reply.
    pub async fn send_request(self: &Arc<Self>, mut body: Value) -> Result<Value, BridgeError> {
        let req_id = Uuid::new_v4().to_string();
        body.as_object_mut()
            .ok_or_else(|| BridgeError::BadRequest("body must be a JSON object".into()))?
            .insert("id".into(), Value::String(req_id.clone()));
        let (tx, rx) = oneshot::channel();
        {
            let mut g = self.inner.lock().await;
            let Some(ws_tx) = g.ws_tx.as_ref() else {
                return Err(BridgeError::Disconnected);
            };
            let frame =
                serde_json::to_string(&body).map_err(|e| BridgeError::Encode(e.to_string()))?;
            ws_tx.send(frame).map_err(|_| BridgeError::Disconnected)?;
            g.pending.insert(req_id.clone(), tx);
        }
        match tokio::time::timeout(Duration::from_secs(180), rx).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(_)) => Err(BridgeError::Disconnected),
            Err(_) => {
                self.inner.lock().await.pending.remove(&req_id);
                Err(BridgeError::Timeout)
            }
        }
    }

    /// Send a streaming request; returns a receiver yielding chunk
    /// values until the stream finishes or errors.
    pub async fn send_streaming_request(
        self: &Arc<Self>,
        mut body: Value,
    ) -> Result<mpsc::UnboundedReceiver<StreamItem>, BridgeError> {
        let req_id = Uuid::new_v4().to_string();
        body.as_object_mut()
            .ok_or_else(|| BridgeError::BadRequest("body must be a JSON object".into()))?
            .insert("id".into(), Value::String(req_id.clone()));
        let (tx, rx) = mpsc::unbounded_channel();
        {
            let mut g = self.inner.lock().await;
            let Some(ws_tx) = g.ws_tx.as_ref() else {
                return Err(BridgeError::Disconnected);
            };
            let frame =
                serde_json::to_string(&body).map_err(|e| BridgeError::Encode(e.to_string()))?;
            ws_tx.send(frame).map_err(|_| BridgeError::Disconnected)?;
            g.streams.insert(req_id, tx);
        }
        Ok(rx)
    }

    /// Handle a single JSON message from the browser side.
    async fn handle_browser_message(&self, data: Value) {
        let msg_type = data.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if msg_type == "model_info" {
            let mut g = self.inner.lock().await;
            g.model_id = data
                .get("model_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            g.status = data
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            tracing::info!(
                "webllm bridge: model_info id={} status={}",
                g.model_id,
                g.status
            );
            return;
        }
        let Some(req_id) = data.get("id").and_then(|v| v.as_str()).map(String::from) else {
            return;
        };
        match msg_type {
            "chunk" => {
                let g = self.inner.lock().await;
                if let Some(tx) = g.streams.get(&req_id) {
                    let mut chunk = data;
                    if let Some(obj) = chunk.as_object_mut() {
                        obj.remove("id");
                        obj.remove("type");
                    }
                    let _ = tx.send(StreamItem::Chunk(chunk));
                }
            }
            "done" => {
                let mut g = self.inner.lock().await;
                if let Some(tx) = g.streams.remove(&req_id) {
                    let _ = tx.send(StreamItem::Done);
                }
            }
            _ => {
                let mut g = self.inner.lock().await;
                if let Some(err) = data.get("error").and_then(|v| v.as_str()) {
                    if let Some(tx) = g.pending.remove(&req_id) {
                        let _ = tx.send(json!({"error": err}));
                    }
                    if let Some(tx) = g.streams.remove(&req_id) {
                        let _ = tx.send(StreamItem::Err(err.into()));
                    }
                    return;
                }
                if let Some(tx) = g.pending.remove(&req_id) {
                    let mut payload = data;
                    if let Some(obj) = payload.as_object_mut() {
                        obj.remove("id");
                    }
                    let _ = tx.send(payload);
                }
            }
        }
    }

    async fn on_disconnect(&self) {
        let mut g = self.inner.lock().await;
        g.ws_tx = None;
        g.status = "disconnected".into();
        let pending: Vec<_> = g.pending.drain().collect();
        let streams: Vec<_> = g.streams.drain().collect();
        drop(g);
        for (_id, tx) in pending {
            let _ = tx.send(json!({"error": "browser disconnected"}));
        }
        for (_id, tx) in streams {
            let _ = tx.send(StreamItem::Err("browser disconnected".into()));
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("WebLLM browser not connected")]
    Disconnected,
    #[error("WebLLM request timed out")]
    Timeout,
    #[error("encode: {0}")]
    Encode(String),
    #[error("bad request: {0}")]
    BadRequest(String),
}

// ─── HTTP routes ──────────────────────────────────────────────────

pub async fn chat_completions(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let bridge = state.webllm_bridge.clone();
    if !bridge.is_ready().await {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": {"message": "WebLLM not ready — open a browser tab to load a model", "type": "server_error"}
            })),
        )
            .into_response();
    }
    let wants_stream = body
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if wants_stream {
        match bridge.send_streaming_request(body).await {
            Ok(rx) => Sse::new(SseStream::new(rx))
                .keep_alive(KeepAlive::default())
                .into_response(),
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error": {"message": e.to_string(), "type": "server_error"}})),
            )
                .into_response(),
        }
    } else {
        match bridge.send_request(body).await {
            Ok(value) => (StatusCode::OK, Json(value)).into_response(),
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error": {"message": e.to_string(), "type": "server_error"}})),
            )
                .into_response(),
        }
    }
}

pub async fn list_models(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let (id, _status) = state.webllm_bridge.model_info().await;
    let data = if id.is_empty() {
        Vec::new()
    } else {
        vec![json!({"id": id, "object": "model", "owned_by": "webllm"})]
    };
    (
        StatusCode::OK,
        Json(json!({"object": "list", "data": data})),
    )
}

/// Reject the Responses API so SapientResponses-style clients fall
/// back to chat completions.
pub async fn responses_unsupported() -> impl IntoResponse {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "error": {
                "message": "WebLLM bridge supports /chat/completions only.",
                "type": "invalid_request_error"
            }
        })),
    )
}

pub async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(socket: WebSocket, state: Arc<AppState>) {
    let bridge = state.webllm_bridge.clone();
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    {
        let mut g = bridge.inner.lock().await;
        if g.ws_tx.is_some() {
            tracing::warn!("webllm bridge: replacing prior browser connection");
        }
        g.ws_tx = Some(tx);
        g.status = "connected".into();
    }
    // Writer task — drains outbound queue into the WS sink.
    let writer = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if sink.send(Message::Text(frame)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    // Reader loop — parse browser messages and route them.
    while let Some(msg) = stream.next().await {
        let Ok(msg) = msg else { break };
        match msg {
            Message::Text(text) => match serde_json::from_str::<Value>(&text) {
                Ok(value) => bridge.handle_browser_message(value).await,
                Err(e) => tracing::warn!("webllm bridge: bad json from browser: {e}"),
            },
            Message::Close(_) => break,
            _ => {}
        }
    }
    bridge.on_disconnect().await;
    writer.abort();
}

// ─── SSE adapter ──────────────────────────────────────────────────

struct SseStream {
    rx: mpsc::UnboundedReceiver<StreamItem>,
    done: bool,
}

impl SseStream {
    fn new(rx: mpsc::UnboundedReceiver<StreamItem>) -> Self {
        Self { rx, done: false }
    }
}

impl Stream for SseStream {
    type Item = Result<SseEvent, std::convert::Infallible>;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        if self.done {
            return std::task::Poll::Ready(None);
        }
        match self.rx.poll_recv(cx) {
            std::task::Poll::Pending => std::task::Poll::Pending,
            std::task::Poll::Ready(None) => {
                self.done = true;
                std::task::Poll::Ready(None)
            }
            std::task::Poll::Ready(Some(StreamItem::Chunk(value))) => {
                let data = serde_json::to_string(&value).unwrap_or_default();
                std::task::Poll::Ready(Some(Ok(SseEvent::default().data(data))))
            }
            std::task::Poll::Ready(Some(StreamItem::Done)) => {
                self.done = true;
                std::task::Poll::Ready(Some(Ok(SseEvent::default().data("[DONE]"))))
            }
            std::task::Poll::Ready(Some(StreamItem::Err(e))) => {
                self.done = true;
                let payload = json!({"error": {"message": e, "type": "server_error"}});
                let data = serde_json::to_string(&payload).unwrap_or_default();
                std::task::Poll::Ready(Some(Ok(SseEvent::default().data(data))))
            }
        }
    }
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
struct ModelInfoMsg {
    model_id: String,
    status: String,
}
