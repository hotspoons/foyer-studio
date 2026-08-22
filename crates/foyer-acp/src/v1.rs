// SPDX-License-Identifier: Apache-2.0
//! ACP **v1** chain: classic turn semantics.
//!
//! `session/update` notifications flow only while this client's own
//! `session/prompt` is in flight — the v1 contract. The autonomy
//! gate surfaces as session modes (`ask` / `auto`) and as
//! `session/request_permission` round-trips when a destructive tool
//! parks in `AwaitingConfirm`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use agent_client_protocol::schema::v1::{
    AgentCapabilities, CancelNotification, ContentBlock, ContentChunk, CurrentModeUpdate,
    Implementation, InitializeRequest, InitializeResponse, LoadSessionRequest, LoadSessionResponse,
    MessageId, NewSessionRequest, NewSessionResponse, PermissionOption, PermissionOptionKind,
    PromptCapabilities, PromptRequest, PromptResponse, RequestPermissionOutcome,
    RequestPermissionRequest, SessionId, SessionMode, SessionModeId, SessionModeState,
    SessionNotification, SessionUpdate, SetSessionModeRequest, SetSessionModeResponse, StopReason,
    TextContent, ToolCall, ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields, ToolKind,
};
use agent_client_protocol::{self as acp, ConnectionTo};
use foyer_agent::{AgentEvent, AgentRuntime};
use foyer_schema::agent::{AgentAttachment, AgentAutonomy, AgentRole, AgentToolStatus};

use crate::common::{pretty_json, CallBook, KindHint};

/// Build one v1 handler chain. One per connection — the builder is
/// consumed by `connect_to`.
pub(crate) fn chain(runtime: Arc<AgentRuntime>) -> impl acp::ConnectTo<acp::Client> {
    // Set by `session/cancel`, read when the in-flight prompt
    // resolves so it can answer `stop_reason: cancelled` as the spec
    // requires. One flag per connection is enough: the runtime holds
    // a single active turn.
    let cancelled = Arc::new(AtomicBool::new(false));

    acp::Agent
        .builder()
        .name("foyer-acp-v1")
        .on_receive_request(
            async move |req: InitializeRequest, responder, _cx| {
                responder.respond(
                    InitializeResponse::new(req.protocol_version)
                        .agent_capabilities(
                            AgentCapabilities::new()
                                .load_session(true)
                                .prompt_capabilities(
                                    PromptCapabilities::new()
                                        .image(true)
                                        .audio(true)
                                        .embedded_context(true),
                                ),
                        )
                        .agent_info(Implementation::new(
                            "foyer-studio",
                            env!("CARGO_PKG_VERSION"),
                        )),
                )
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |_req: NewSessionRequest, responder, _cx| {
                    runtime.new_session(None).await;
                    let id = runtime.active_session_id().await;
                    let autonomy = runtime.config_snapshot().await.autonomy;
                    responder.respond(
                        NewSessionResponse::new(SessionId::new(id)).modes(mode_state(autonomy)),
                    )
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |req: LoadSessionRequest, responder, cx| {
                    let sid = req.session_id.clone();
                    runtime.load_session(sid.0.to_string()).await;
                    // v1 contract: replay the conversation as
                    // session/update notifications BEFORE responding.
                    for record in runtime.history().await {
                        for update in replay_updates(&record) {
                            let _ =
                                cx.send_notification(SessionNotification::new(sid.clone(), update));
                        }
                    }
                    let autonomy = runtime.config_snapshot().await.autonomy;
                    responder.respond(LoadSessionResponse::new().modes(mode_state(autonomy)))
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |req: SetSessionModeRequest, responder, cx| {
                    let autonomy = match req.mode_id.0.as_ref() {
                        "auto" => AgentAutonomy::Auto,
                        _ => AgentAutonomy::Ask,
                    };
                    runtime.set_autonomy(autonomy).await;
                    let _ = cx.send_notification(SessionNotification::new(
                        req.session_id.clone(),
                        SessionUpdate::CurrentModeUpdate(CurrentModeUpdate::new(mode_id(autonomy))),
                    ));
                    responder.respond(SetSessionModeResponse::new())
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                let cancelled = cancelled.clone();
                async move |req: PromptRequest, responder, cx| {
                    let runtime = runtime.clone();
                    let cancelled = cancelled.clone();
                    let connection = cx.clone();
                    cx.spawn(async move {
                        run_prompt(runtime, cancelled, req, responder, connection).await;
                        Ok(())
                    })
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_notification(
            {
                let runtime = runtime.clone();
                let cancelled = cancelled.clone();
                async move |_notif: CancelNotification, _cx| {
                    cancelled.store(true, Ordering::SeqCst);
                    runtime.stop_current_turn().await;
                    Ok(())
                }
            },
            acp::on_receive_notification!(),
        )
}

fn mode_id(autonomy: AgentAutonomy) -> SessionModeId {
    match autonomy {
        AgentAutonomy::Ask => SessionModeId::new("ask"),
        AgentAutonomy::Auto => SessionModeId::new("auto"),
    }
}

fn mode_state(current: AgentAutonomy) -> SessionModeState {
    SessionModeState::new(
        mode_id(current),
        vec![
            SessionMode::new(SessionModeId::new("ask"), "Ask before edits")
                .description("Destructive DAW operations wait for permission"),
            SessionMode::new(SessionModeId::new("auto"), "Auto")
                .description("All tool calls run; the DAW undo stack is the safety net"),
        ],
    )
}

fn kind(hint: KindHint) -> ToolKind {
    match hint {
        KindHint::Read => ToolKind::Read,
        KindHint::Edit => ToolKind::Edit,
        KindHint::Delete => ToolKind::Delete,
        KindHint::Move => ToolKind::Move,
        KindHint::Search => ToolKind::Search,
        KindHint::Execute => ToolKind::Execute,
        KindHint::Fetch => ToolKind::Fetch,
        KindHint::Other => ToolKind::Other,
    }
}

/// Split an ACP prompt into the text body + attachments Foyer's
/// runtime takes. Non-text blocks that aren't images/audio degrade
/// to their textual representation.
fn prompt_parts(blocks: Vec<ContentBlock>) -> (String, Vec<AgentAttachment>) {
    let mut text = String::new();
    let mut attachments = Vec::new();
    for block in blocks {
        match block {
            ContentBlock::Text(t) => {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&t.text);
            }
            ContentBlock::Image(img) => attachments.push(AgentAttachment {
                name: format!("image-{}", attachments.len() + 1),
                mime: img.mime_type.clone(),
                b64: img.data.clone(),
            }),
            ContentBlock::Audio(audio) => attachments.push(AgentAttachment {
                name: format!("audio-{}", attachments.len() + 1),
                mime: audio.mime_type.clone(),
                b64: audio.data.clone(),
            }),
            ContentBlock::ResourceLink(link) => {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&format!("[resource: {}]", link.uri));
            }
            ContentBlock::Resource(res) => {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&format!("[embedded resource: {:?}]", res.resource));
            }
            _ => {}
        }
    }
    (text, attachments)
}

/// Replay one transcript record as v1 updates (used by
/// `session/load`).
fn replay_updates(record: &foyer_schema::agent::AgentMessageRecord) -> Vec<SessionUpdate> {
    let mut out = Vec::new();
    if record.synthetic.is_some() {
        return out;
    }
    let mid = MessageId::new(record.id.to_string());
    match record.role {
        AgentRole::User => {
            if !record.content.is_empty() {
                out.push(SessionUpdate::UserMessageChunk(
                    ContentChunk::new(ContentBlock::Text(TextContent::new(record.content.clone())))
                        .message_id(mid),
                ));
            }
        }
        AgentRole::Assistant => {
            if !record.content.is_empty() {
                out.push(SessionUpdate::AgentMessageChunk(
                    ContentChunk::new(ContentBlock::Text(TextContent::new(record.content.clone())))
                        .message_id(mid),
                ));
            }
            for call in &record.tool_calls {
                let (title, subcommand) =
                    crate::common::call_title(&call.tool_name, &call.args_json);
                let status = match call.status {
                    AgentToolStatus::Done => ToolCallStatus::Completed,
                    AgentToolStatus::Error | AgentToolStatus::Rejected => ToolCallStatus::Failed,
                    AgentToolStatus::Running => ToolCallStatus::InProgress,
                    _ => ToolCallStatus::Pending,
                };
                out.push(SessionUpdate::ToolCall(
                    ToolCall::new(call.call_id.clone(), title)
                        .kind(kind(crate::common::classify(&call.tool_name, &subcommand)))
                        .status(status),
                ));
            }
        }
        _ => {}
    }
    out
}

/// Drive one `session/prompt` turn: forward runtime events as
/// notifications while `send_user_message` runs, bridge
/// `AwaitingConfirm` into `session/request_permission`, and resolve
/// the responder with the final stop reason.
async fn run_prompt(
    runtime: Arc<AgentRuntime>,
    cancelled: Arc<AtomicBool>,
    req: PromptRequest,
    responder: acp::Responder<PromptResponse>,
    cx: ConnectionTo<acp::Client>,
) {
    let sid = req.session_id.clone();
    if runtime.active_session_id().await != sid.0.as_ref() {
        runtime.load_session(sid.0.to_string()).await;
    }
    let (text, attachments) = prompt_parts(req.prompt);

    cancelled.store(false, Ordering::SeqCst);
    let mut rx = runtime.subscribe();
    let mut book = CallBook::default();

    let turn_runtime = runtime.clone();
    let turn = turn_runtime.send_user_message(text, attachments);
    tokio::pin!(turn);

    let result = loop {
        tokio::select! {
            result = &mut turn => break result,
            ev = rx.recv() => match ev {
                Ok(ev) => forward_event(&runtime, &cx, &sid, &mut book, ev).await,
                // Lagged: the 256-slot ring wrapped (pathological —
                // the engine paused on a confirm we never answered).
                // Skip and keep forwarding what's current.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break Ok(()),
            }
        }
    };

    // Drain anything the engine broadcast in its final moments so
    // tool completions aren't dropped on the floor.
    while let Ok(ev) = rx.try_recv() {
        forward_event(&runtime, &cx, &sid, &mut book, ev).await;
    }

    let response = match result {
        Ok(()) if cancelled.load(Ordering::SeqCst) => {
            Ok(PromptResponse::new(StopReason::Cancelled))
        }
        Ok(()) => Ok(PromptResponse::new(StopReason::EndTurn)),
        Err(foyer_agent::engine::EngineError::Interrupted) => {
            Ok(PromptResponse::new(StopReason::Cancelled))
        }
        Err(foyer_agent::engine::EngineError::RoundLimit(_)) => {
            Ok(PromptResponse::new(StopReason::MaxTurnRequests))
        }
        Err(e) => Err(agent_client_protocol::util::internal_error(e)),
    };
    let _ = responder.respond_with_result(response);
}

/// Translate one runtime event into v1 notifications on `cx`.
async fn forward_event(
    runtime: &Arc<AgentRuntime>,
    cx: &ConnectionTo<acp::Client>,
    sid: &SessionId,
    book: &mut CallBook,
    ev: AgentEvent,
) {
    match ev {
        AgentEvent::Token { message_id, delta } => {
            if delta.is_empty() {
                return;
            }
            let _ = cx.send_notification(SessionNotification::new(
                sid.clone(),
                SessionUpdate::AgentMessageChunk(
                    ContentChunk::new(ContentBlock::Text(TextContent::new(delta)))
                        .message_id(MessageId::new(message_id.to_string())),
                ),
            ));
        }
        AgentEvent::Message(record) => {
            book.register_record(&record);
        }
        AgentEvent::ToolUpdate {
            call_id,
            status,
            preview,
            result_json,
            ..
        } => {
            let meta = book.meta(&call_id);
            match status {
                AgentToolStatus::AwaitingConfirm => {
                    announce_call(cx, sid, book, &call_id, &meta, ToolCallStatus::Pending);
                    request_permission(runtime, cx, sid, &call_id, &meta).await;
                }
                AgentToolStatus::Pending | AgentToolStatus::Running => {
                    announce_call(cx, sid, book, &call_id, &meta, ToolCallStatus::InProgress);
                    let _ = preview; // args already shipped as raw_input
                }
                AgentToolStatus::Done => {
                    finish_call(
                        cx,
                        sid,
                        book,
                        &call_id,
                        &meta,
                        ToolCallStatus::Completed,
                        result_json,
                    );
                }
                AgentToolStatus::Error | AgentToolStatus::Rejected => {
                    finish_call(
                        cx,
                        sid,
                        book,
                        &call_id,
                        &meta,
                        ToolCallStatus::Failed,
                        result_json,
                    );
                }
            }
        }
        _ => {}
    }
}

/// First sighting → full ToolCall; later sightings → status update.
fn announce_call(
    cx: &ConnectionTo<acp::Client>,
    sid: &SessionId,
    book: &mut CallBook,
    call_id: &str,
    meta: &crate::common::CallMeta,
    status: ToolCallStatus,
) {
    let update = if book.announce(call_id) {
        let mut call = ToolCall::new(call_id.to_string(), meta.title.clone())
            .kind(kind(meta.kind))
            .status(status);
        if let Ok(args) = serde_json::from_str::<serde_json::Value>(&meta.args_json) {
            call = call.raw_input(args);
        }
        SessionUpdate::ToolCall(call)
    } else {
        SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            call_id.to_string(),
            ToolCallUpdateFields::new().status(status),
        ))
    };
    let _ = cx.send_notification(SessionNotification::new(sid.clone(), update));
}

fn finish_call(
    cx: &ConnectionTo<acp::Client>,
    sid: &SessionId,
    book: &mut CallBook,
    call_id: &str,
    meta: &crate::common::CallMeta,
    status: ToolCallStatus,
    result_json: String,
) {
    // A call can complete without ever being announced (e.g. the
    // subscription started mid-flight) — announce first so clients
    // have a card to update.
    if book.announce(call_id) {
        let mut call = ToolCall::new(call_id.to_string(), meta.title.clone())
            .kind(kind(meta.kind))
            .status(ToolCallStatus::InProgress);
        if let Ok(args) = serde_json::from_str::<serde_json::Value>(&meta.args_json) {
            call = call.raw_input(args);
        }
        let _ = cx.send_notification(SessionNotification::new(
            sid.clone(),
            SessionUpdate::ToolCall(call),
        ));
    }
    let mut fields = ToolCallUpdateFields::new().status(status);
    if let Ok(out) = serde_json::from_str::<serde_json::Value>(&result_json) {
        fields = fields.raw_output(out);
    }
    let _ = cx.send_notification(SessionNotification::new(
        sid.clone(),
        SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(call_id.to_string(), fields)),
    ));
}

/// Bridge the autonomy gate: ask the client, route the answer to
/// `confirm_tool`. A client that cancels (or errors) rejects the
/// call — never silently approves.
async fn request_permission(
    runtime: &Arc<AgentRuntime>,
    cx: &ConnectionTo<acp::Client>,
    sid: &SessionId,
    call_id: &str,
    meta: &crate::common::CallMeta,
) {
    let update = ToolCallUpdate::new(
        call_id.to_string(),
        ToolCallUpdateFields::new()
            .status(ToolCallStatus::Pending)
            .title(meta.title.clone()),
    );
    let request = RequestPermissionRequest::new(
        sid.clone(),
        update,
        vec![
            PermissionOption::new("allow", "Allow", PermissionOptionKind::AllowOnce),
            PermissionOption::new("reject", "Reject", PermissionOptionKind::RejectOnce),
        ],
    );
    let approve = match cx.send_request(request).block_task().await {
        Ok(resp) => matches!(
            resp.outcome,
            RequestPermissionOutcome::Selected(ref sel) if sel.option_id.0.as_ref() == "allow"
        ),
        Err(e) => {
            tracing::warn!("acp-v1: permission request failed ({e}); rejecting tool call");
            false
        }
    };
    let _ = pretty_json(&meta.args_json); // description reserved for v2's subject
    runtime.confirm_tool(call_id, approve).await;
}
