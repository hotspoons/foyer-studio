// SPDX-License-Identifier: Apache-2.0
//! End-to-end ACP bridge tests: a real `AgentRuntime` (stub backend,
//! scripted OpenAI-shape LLM on loopback) served through the real
//! protocol router to a real SDK client — connected in-process, no
//! sockets. The version router is exercised for real: the v1 client
//! negotiates into the v1 chain, the v2 client into the v2 chain.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use agent_client_protocol::{self as acp, ConnectionTo};
use foyer_acp::FoyerAcpServer;
use foyer_agent::{store::AgentStore, AgentRuntime};
use foyer_backend::Backend;
use foyer_backend_stub::StubBackend;
use foyer_schema::agent::AgentAutonomy;

// ─── scripted LLM (OpenAI chat-completions SSE shape) ───────────────

fn sse_tool_call(name: &str, args: &str) -> String {
    let call = serde_json::json!({
        "choices": [{
            "delta": {
                "role": "assistant",
                "tool_calls": [{
                    "index": 0,
                    "id": "call_1",
                    "function": { "name": name, "arguments": args }
                }]
            },
            "finish_reason": null
        }]
    });
    let finish = serde_json::json!({
        "choices": [{ "delta": {}, "finish_reason": "tool_calls" }]
    });
    format!("data: {call}\n\ndata: {finish}\n\ndata: [DONE]\n\n")
}

fn sse_text(text: &str) -> String {
    let chunk = serde_json::json!({
        "choices": [{ "delta": { "content": text }, "finish_reason": null }]
    });
    let finish = serde_json::json!({
        "choices": [{ "delta": {}, "finish_reason": "stop" }]
    });
    format!("data: {chunk}\n\ndata: {finish}\n\ndata: [DONE]\n\n")
}

/// Serve the scripted responses in order (last one repeats) at a
/// loopback port. Returns the endpoint base URL the runtime's
/// OpenAI client expects (it appends `/chat/completions`).
async fn spawn_mock_llm(scripts: Vec<String>) -> String {
    use axum::extract::State;
    type S = (Arc<Vec<String>>, Arc<AtomicUsize>);
    async fn handler(State((scripts, counter)): State<S>) -> impl axum::response::IntoResponse {
        let i = counter
            .fetch_add(1, Ordering::SeqCst)
            .min(scripts.len() - 1);
        (
            [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
            scripts[i].clone(),
        )
    }
    let state: S = (Arc::new(scripts), Arc::new(AtomicUsize::new(0)));
    let app = axum::Router::new()
        .route("/chat/completions", axum::routing::post(handler))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}")
}

// ─── runtime under test ──────────────────────────────────────────────

async fn mk_runtime(
    llm_endpoint: &str,
    autonomy: AgentAutonomy,
) -> (Arc<AgentRuntime>, Arc<dyn Backend>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(AgentStore::open_at(dir.path().to_path_buf()).await.unwrap());
    let runtime = AgentRuntime::with_store(store).await.unwrap();
    // Keep the strong Arc alive for the test's duration — the
    // runtime only holds a Weak.
    let backend: Arc<dyn Backend> = Arc::new(StubBackend::new());
    runtime.attach_backend(Arc::downgrade(&backend)).await;
    runtime
        .set_config(
            Some(llm_endpoint.to_string()),
            Some("scripted".to_string()),
            None,
        )
        .await;
    runtime.set_autonomy(autonomy).await;
    (runtime, backend, dir)
}

/// Discriminant of a session update ("agent_message_chunk",
/// "tool_call", …) — both schema versions tag with `sessionUpdate`.
fn update_kind(update: &impl serde::Serialize) -> String {
    serde_json::to_value(update)
        .ok()
        .and_then(|v| {
            v.get("sessionUpdate")
                .and_then(|k| k.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| "?".into())
}

// ─── v1: classic turn ────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn v1_prompt_streams_tool_calls_and_ends_turn() {
    use agent_client_protocol::schema::v1::{
        ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest, SessionNotification,
        StopReason, TextContent,
    };
    use agent_client_protocol::schema::ProtocolVersion;

    let llm = spawn_mock_llm(vec![
        sse_tool_call("transport", r#"{"subcommand":"play"}"#),
        sse_text("Playing now."),
    ])
    .await;
    let (runtime, _backend, _dir) = mk_runtime(&llm, AgentAutonomy::Auto).await;
    let bridge = FoyerAcpServer::new(runtime);

    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen_in_handler = seen.clone();

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        acp::Client
            .builder()
            .name("test-v1-client")
            .on_receive_notification(
                async move |n: SessionNotification, _cx| {
                    seen_in_handler.lock().unwrap().push(update_kind(&n.update));
                    Ok(())
                },
                acp::on_receive_notification!(),
            )
            .connect_with(bridge.connector(), async |cx: ConnectionTo<acp::Agent>| {
                let init = cx
                    .send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;
                assert!(init.agent_capabilities.load_session);

                let session = cx
                    .send_request(NewSessionRequest::new(std::env::current_dir().unwrap()))
                    .block_task()
                    .await?;
                assert!(session.modes.is_some(), "autonomy exposed as modes");

                let resp = cx
                    .send_request(PromptRequest::new(
                        session.session_id.clone(),
                        vec![ContentBlock::Text(TextContent::new("play the session"))],
                    ))
                    .block_task()
                    .await?;
                assert_eq!(resp.stop_reason, StopReason::EndTurn);
                Ok(())
            }),
    )
    .await
    .expect("test timed out");
    result.expect("v1 conversation succeeds");

    let kinds = seen.lock().unwrap().clone();
    assert!(
        kinds.iter().any(|k| k == "tool_call"),
        "tool call announced: {kinds:?}"
    );
    assert!(
        kinds.iter().any(|k| k == "tool_call_update"),
        "tool completion streamed: {kinds:?}"
    );
    assert!(
        kinds.iter().any(|k| k == "agent_message_chunk"),
        "assistant text streamed: {kinds:?}"
    );
}

// ─── v2: decoupled updates + permission gate ─────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn v2_permission_gate_and_state_updates() {
    use agent_client_protocol::schema::v2::{
        ContentBlock, Implementation, InitializeRequest, ListSessionsRequest, NewSessionRequest,
        PromptRequest, RequestPermissionOutcome, RequestPermissionRequest,
        RequestPermissionResponse, SelectedPermissionOutcome, TextContent,
        UpdateSessionNotification,
    };
    use agent_client_protocol::schema::ProtocolVersion;

    let llm = spawn_mock_llm(vec![
        // `regions` is destructive → autonomy=ask parks it on the
        // permission gate until the ACP client answers.
        sse_tool_call("regions", r#"{"subcommand":"list"}"#),
        sse_text("Listed."),
    ])
    .await;
    let (runtime, _backend, _dir) = mk_runtime(&llm, AgentAutonomy::Ask).await;
    let bridge = FoyerAcpServer::new(runtime);

    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen_in_handler = seen.clone();
    let permission_asked = Arc::new(AtomicBool::new(false));
    let permission_flag = permission_asked.clone();

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        acp::Client
            .v2()
            .name("test-v2-client")
            .on_receive_notification(
                async move |n: UpdateSessionNotification, _cx| {
                    seen_in_handler.lock().unwrap().push(update_kind(&n.update));
                    Ok(())
                },
                acp::on_receive_notification!(),
            )
            .on_receive_request(
                async move |req: RequestPermissionRequest, responder, _cx| {
                    permission_flag.store(true, Ordering::SeqCst);
                    assert!(!req.options.is_empty());
                    responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new("allow")),
                    ))
                },
                acp::on_receive_request!(),
            )
            .connect_with(bridge.connector(), async |cx: ConnectionTo<acp::Agent>| {
                cx.send_request(InitializeRequest::new(
                    ProtocolVersion::V2,
                    Implementation::new("test-v2-client", "0.0.0"),
                ))
                .block_task()
                .await?;
                let session = cx
                    .send_request(NewSessionRequest::new(std::env::current_dir().unwrap()))
                    .block_task()
                    .await?;
                cx.send_request(PromptRequest::new(
                    session.session_id.clone(),
                    vec![ContentBlock::Text(TextContent::new("list the regions"))],
                ))
                .block_task()
                .await?;
                // v2 session lifecycle: the store lists what we made.
                let listed = cx
                    .send_request(ListSessionsRequest::new())
                    .block_task()
                    .await?;
                assert!(!listed.sessions.is_empty());
                Ok(())
            }),
    )
    .await
    .expect("test timed out");
    result.expect("v2 conversation succeeds");

    assert!(
        permission_asked.load(Ordering::SeqCst),
        "destructive tool routed through session/request_permission"
    );
    let kinds = seen.lock().unwrap().clone();
    assert!(
        kinds.iter().any(|k| k == "state_update"),
        "running/idle state updates streamed: {kinds:?}"
    );
    assert!(
        kinds.iter().any(|k| k == "tool_call_update"),
        "tool call patches streamed: {kinds:?}"
    );
    assert!(
        kinds.iter().any(|k| k == "agent_message_chunk"),
        "assistant text streamed: {kinds:?}"
    );
}

// ─── v1: session/cancel mid-turn ─────────────────────────────────────

/// An LLM that streams one text delta then trickles forever — the
/// turn never ends on its own, so only `session/cancel` can end it.
async fn spawn_stalling_llm() -> String {
    async fn handler() -> impl axum::response::IntoResponse {
        let first = serde_json::json!({
            "choices": [{ "delta": { "content": "thinking…" }, "finish_reason": null }]
        });
        let stream = futures::stream::unfold(0u64, move |i| {
            let first = first.clone();
            async move {
                if i > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
                let chunk = if i == 0 {
                    format!("data: {first}\n\n")
                } else {
                    // SSE comment lines keep the connection alive
                    // without emitting deltas.
                    ": keepalive\n\n".to_string()
                };
                Some((
                    Ok::<_, std::io::Error>(axum::body::Bytes::from(chunk)),
                    i + 1,
                ))
            }
        });
        (
            [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
            axum::body::Body::from_stream(stream),
        )
    }
    let app = axum::Router::new().route("/chat/completions", axum::routing::post(handler));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn v1_cancel_resolves_prompt_with_cancelled() {
    use agent_client_protocol::schema::v1::{
        CancelNotification, ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest,
        SessionNotification, StopReason, TextContent,
    };
    use agent_client_protocol::schema::ProtocolVersion;

    let llm = spawn_stalling_llm().await;
    let (runtime, _backend, _dir) = mk_runtime(&llm, AgentAutonomy::Auto).await;
    let bridge = FoyerAcpServer::new(runtime);

    // Resolved once the first streamed chunk arrives — proof the
    // turn is genuinely in flight before we cancel.
    let (streaming_tx, streaming_rx) = tokio::sync::oneshot::channel::<()>();
    let streaming_tx = Arc::new(Mutex::new(Some(streaming_tx)));

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        acp::Client
            .builder()
            .name("test-v1-cancel")
            .on_receive_notification(
                async move |_n: SessionNotification, _cx| {
                    if let Some(tx) = streaming_tx.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                    Ok(())
                },
                acp::on_receive_notification!(),
            )
            .connect_with(bridge.connector(), async |cx: ConnectionTo<acp::Agent>| {
                cx.send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;
                let session = cx
                    .send_request(NewSessionRequest::new(std::env::current_dir().unwrap()))
                    .block_task()
                    .await?;
                let pending = cx.send_request(PromptRequest::new(
                    session.session_id.clone(),
                    vec![ContentBlock::Text(TextContent::new("never finishes"))],
                ));
                // Wait until the turn demonstrably streams, then cancel.
                let _ = streaming_rx.await;
                cx.send_notification(CancelNotification::new(session.session_id.clone()))?;
                let resp = pending.block_task().await?;
                assert_eq!(resp.stop_reason, StopReason::Cancelled);
                Ok(())
            }),
    )
    .await
    .expect("test timed out");
    result.expect("v1 cancel flow succeeds");
}
