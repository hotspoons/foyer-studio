// SPDX-License-Identifier: Apache-2.0
//! ACP **v2** (draft) chain: decoupled update semantics.
//!
//! Where v1 scopes updates to the requesting client's in-flight
//! turn, v2 lets `session/update` flow at any point — so this chain
//! runs one continuous per-connection pump that mirrors *everything*
//! the runtime broadcasts (FAB-driven turns included) with
//! `StateUpdate` running/idle transitions and stable `MessageId`s
//! from the runtime's monotonic record ids. `session/prompt` itself
//! is a bare ack in v2; the stop reason rides `StateUpdate::Idle`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use agent_client_protocol::schema::v2::{
    AbsolutePath, AgentCapabilities, AgentMessage, CancelSessionNotification, ContentBlock,
    ContentChunk, IdleStateUpdate, Implementation, InitializeRequest, InitializeResponse,
    ListSessionsRequest, ListSessionsResponse, MessageId, NewSessionRequest, NewSessionResponse,
    PermissionOption, PermissionOptionKind, PromptAudioCapabilities, PromptCapabilities,
    PromptEmbeddedContextCapabilities, PromptImageCapabilities, PromptRequest, PromptResponse,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionSubject,
    ResumeSessionRequest, ResumeSessionResponse, RunningStateUpdate, SessionCapabilities,
    SessionDeleteCapabilities, SessionId, SessionInfo, SessionUpdate, StateUpdate, StopReason,
    TextContent, ToolCallPermissionSubject, ToolCallStatus, ToolCallUpdate, ToolKind,
    UpdateSessionNotification, UserMessage,
};
use agent_client_protocol::{self as acp, ConnectionTo};
use foyer_agent::{AgentEvent, AgentRuntime};
use foyer_schema::agent::{AgentAttachment, AgentRole, AgentToolStatus};

use crate::common::{pretty_json, CallBook, KindHint};

/// Build one v2 handler chain. One per connection.
pub(crate) fn chain(runtime: Arc<AgentRuntime>) -> impl acp::ConnectTo<acp::Client> {
    let cancelled = Arc::new(AtomicBool::new(false));
    // The continuous pump starts on the first session/new or
    // session/resume (that's when the client knows a session id to
    // attribute updates to).
    let pump_started = Arc::new(AtomicBool::new(false));

    acp::Agent
        .v2()
        .name("foyer-acp-v2")
        .on_receive_request(
            async move |req: InitializeRequest, responder, _cx| {
                responder.respond(
                    InitializeResponse::new(
                        req.protocol_version,
                        Implementation::new("foyer-studio", env!("CARGO_PKG_VERSION")),
                    )
                    .capabilities(
                        AgentCapabilities::new().session(
                            SessionCapabilities::new()
                                .prompt(
                                    PromptCapabilities::new()
                                        .image(PromptImageCapabilities::new())
                                        .audio(PromptAudioCapabilities::new())
                                        .embedded_context(PromptEmbeddedContextCapabilities::new()),
                                )
                                .delete(SessionDeleteCapabilities::new()),
                        ),
                    ),
                )
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                let pump_started = pump_started.clone();
                let cancelled = cancelled.clone();
                async move |_req: NewSessionRequest, responder, cx| {
                    runtime.new_session(None).await;
                    let id = runtime.active_session_id().await;
                    ensure_pump(&runtime, &cx, &pump_started, &cancelled)?;
                    responder.respond(NewSessionResponse::new(SessionId::new(id)))
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                let pump_started = pump_started.clone();
                let cancelled = cancelled.clone();
                async move |req: ResumeSessionRequest, responder, cx| {
                    runtime.load_session(req.session_id.0.to_string()).await;
                    ensure_pump(&runtime, &cx, &pump_started, &cancelled)?;
                    responder.respond(ResumeSessionResponse::new())
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |_req: ListSessionsRequest, responder, _cx| {
                    let sessions = match runtime.list_sessions_event().await {
                        AgentEvent::SessionsListed { sessions, .. } => sessions,
                        _ => Vec::new(),
                    };
                    let sessions = sessions
                        .into_iter()
                        .map(|s| {
                            // Foyer agent sessions aren't cwd-bound;
                            // the jail root is a server-side secret
                            // (CLAUDE.md wire rule), so advertise the
                            // filesystem-neutral root.
                            SessionInfo::new(
                                SessionId::new(s.id),
                                AbsolutePath::new(PathBuf::from("/")),
                            )
                            .title(s.title)
                        })
                        .collect();
                    responder.respond(ListSessionsResponse::new(sessions))
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |req: agent_client_protocol::schema::v2::DeleteSessionRequest,
                            responder,
                            _cx| {
                    runtime.delete_session(req.session_id.0.to_string()).await;
                    responder
                        .respond(agent_client_protocol::schema::v2::DeleteSessionResponse::new())
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            async move |_req: agent_client_protocol::schema::v2::CloseSessionRequest,
                        responder,
                        _cx| {
                // Foyer sessions persist server-side; closing the
                // client's handle is a no-op.
                responder.respond(agent_client_protocol::schema::v2::CloseSessionResponse::new())
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
                async move |_notif: CancelSessionNotification, _cx| {
                    cancelled.store(true, Ordering::SeqCst);
                    runtime.stop_current_turn().await;
                    Ok(())
                }
            },
            acp::on_receive_notification!(),
        )
}

/// Start the per-connection event pump exactly once.
fn ensure_pump(
    runtime: &Arc<AgentRuntime>,
    cx: &ConnectionTo<acp::Client>,
    started: &Arc<AtomicBool>,
    cancelled: &Arc<AtomicBool>,
) -> Result<(), acp::Error> {
    if started.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let runtime = runtime.clone();
    let connection = cx.clone();
    let cancelled = cancelled.clone();
    cx.spawn(async move {
        pump(runtime, connection, cancelled).await;
        Ok(())
    })
}

/// Mirror the runtime's broadcast onto this connection for its whole
/// lifetime — v2's "updates proceed freely" model. Also owns the
/// permission round-trip so gates fire even for turns started from
/// another surface (the FAB's Approve button races us; first
/// `confirm_tool` wins, the loser is a no-op).
async fn pump(
    runtime: Arc<AgentRuntime>,
    cx: ConnectionTo<acp::Client>,
    cancelled: Arc<AtomicBool>,
) {
    let mut rx = runtime.subscribe();
    let mut book = CallBook::default();
    let mut sid = SessionId::new(runtime.active_session_id().await);
    let mut busy = false;
    loop {
        match rx.recv().await {
            Ok(ev) => {
                forward_event(
                    &runtime, &cx, &mut sid, &mut book, &mut busy, &cancelled, ev,
                )
                .await
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn forward_event(
    runtime: &Arc<AgentRuntime>,
    cx: &ConnectionTo<acp::Client>,
    sid: &mut SessionId,
    book: &mut CallBook,
    busy: &mut bool,
    cancelled: &Arc<AtomicBool>,
    ev: AgentEvent,
) {
    match ev {
        AgentEvent::SessionActivated { id, .. } => {
            *sid = SessionId::new(id);
        }
        AgentEvent::State { busy: now, .. } => {
            if now != *busy {
                *busy = now;
                let update = if now {
                    StateUpdate::Running(RunningStateUpdate::new())
                } else {
                    // Stop reason unknown at this layer; the prompt
                    // handler follows up with a reasoned Idle for
                    // turns it owns.
                    StateUpdate::Idle(IdleStateUpdate::new())
                };
                let _ = cx.send_notification(UpdateSessionNotification::new(
                    sid.clone(),
                    SessionUpdate::StateUpdate(update),
                ));
            }
        }
        AgentEvent::Token { message_id, delta } => {
            if delta.is_empty() {
                return;
            }
            let _ = cx.send_notification(UpdateSessionNotification::new(
                sid.clone(),
                SessionUpdate::AgentMessageChunk(ContentChunk::new(
                    ContentBlock::Text(TextContent::new(delta)),
                    MessageId::new(message_id.to_string()),
                )),
            ));
        }
        AgentEvent::Message(record) => {
            book.register_record(&record);
            if record.synthetic.is_some() {
                return;
            }
            let mid = MessageId::new(record.id.to_string());
            match record.role {
                // Cross-surface visibility: a prompt typed into the
                // browser FAB shows up in the ACP client too.
                AgentRole::User if !record.content.is_empty() => {
                    let _ =
                        cx.send_notification(UpdateSessionNotification::new(
                            sid.clone(),
                            SessionUpdate::UserMessage(UserMessage::new(mid).content(vec![
                                ContentBlock::Text(TextContent::new(record.content)),
                            ])),
                        ));
                }
                // Final patch: the complete assistant text replaces
                // the streamed chunks under the same message id.
                AgentRole::Assistant if !record.content.is_empty() => {
                    let _ =
                        cx.send_notification(UpdateSessionNotification::new(
                            sid.clone(),
                            SessionUpdate::AgentMessage(AgentMessage::new(mid).content(vec![
                                ContentBlock::Text(TextContent::new(record.content)),
                            ])),
                        ));
                }
                _ => {}
            }
        }
        AgentEvent::ToolUpdate {
            call_id,
            status,
            result_json,
            ..
        } => {
            let meta = book.meta(&call_id);
            match status {
                AgentToolStatus::AwaitingConfirm => {
                    send_call_update(
                        cx,
                        sid,
                        book,
                        &call_id,
                        &meta,
                        ToolCallStatus::Pending,
                        None,
                    );
                    request_permission(runtime, cx, sid, &call_id, &meta, cancelled).await;
                }
                AgentToolStatus::Pending | AgentToolStatus::Running => {
                    send_call_update(
                        cx,
                        sid,
                        book,
                        &call_id,
                        &meta,
                        ToolCallStatus::InProgress,
                        None,
                    );
                }
                AgentToolStatus::Done => {
                    send_call_update(
                        cx,
                        sid,
                        book,
                        &call_id,
                        &meta,
                        ToolCallStatus::Completed,
                        Some(result_json),
                    );
                }
                AgentToolStatus::Error | AgentToolStatus::Rejected => {
                    send_call_update(
                        cx,
                        sid,
                        book,
                        &call_id,
                        &meta,
                        ToolCallStatus::Failed,
                        Some(result_json),
                    );
                }
            }
        }
        _ => {}
    }
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

/// v2 unifies create/update into `ToolCallUpdate` patches: the first
/// patch for a call carries title + kind + raw_input, later ones
/// only what changed.
fn send_call_update(
    cx: &ConnectionTo<acp::Client>,
    sid: &SessionId,
    book: &mut CallBook,
    call_id: &str,
    meta: &crate::common::CallMeta,
    status: ToolCallStatus,
    result_json: Option<String>,
) {
    let mut update = ToolCallUpdate::new(call_id.to_string()).status(status);
    if book.announce(call_id) {
        update = update.title(meta.title.clone()).kind(kind(meta.kind));
        if let Ok(args) = serde_json::from_str::<serde_json::Value>(&meta.args_json) {
            update = update.raw_input(args);
        }
    }
    if let Some(raw) = result_json {
        if let Ok(out) = serde_json::from_str::<serde_json::Value>(&raw) {
            update = update.raw_output(out);
        }
    }
    let _ = cx.send_notification(UpdateSessionNotification::new(
        sid.clone(),
        SessionUpdate::ToolCallUpdate(update),
    ));
}

/// v2 permission request: title + args description + a typed
/// tool-call subject.
async fn request_permission(
    runtime: &Arc<AgentRuntime>,
    cx: &ConnectionTo<acp::Client>,
    sid: &SessionId,
    call_id: &str,
    meta: &crate::common::CallMeta,
    cancelled: &Arc<AtomicBool>,
) {
    let subject = RequestPermissionSubject::ToolCall(Box::new(ToolCallPermissionSubject::new(
        ToolCallUpdate::new(call_id.to_string()).title(meta.title.clone()),
    )));
    let request = RequestPermissionRequest::new(
        sid.clone(),
        meta.title.clone(),
        vec![
            PermissionOption::new("allow", "Allow", PermissionOptionKind::AllowOnce),
            PermissionOption::new("reject", "Reject", PermissionOptionKind::RejectOnce),
        ],
    )
    .description(pretty_json(&meta.args_json))
    .subject(subject);
    let approve = match cx.send_request(request).block_task().await {
        Ok(resp) => matches!(
            resp.outcome,
            RequestPermissionOutcome::Selected(ref sel) if sel.option_id.0.as_ref() == "allow"
        ),
        Err(e) => {
            tracing::warn!("acp-v2: permission request failed ({e}); rejecting tool call");
            false
        }
    };
    if !approve {
        // A rejected gate shouldn't read as "cancelled turn".
        let _ = cancelled;
    }
    runtime.confirm_tool(call_id, approve).await;
}

/// Split a v2 prompt into text + attachments.
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
                mime: img.mime_type.0.to_string(),
                b64: img.data.clone(),
            }),
            ContentBlock::Audio(audio) => attachments.push(AgentAttachment {
                name: format!("audio-{}", attachments.len() + 1),
                mime: audio.mime_type.0.to_string(),
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

/// v2 prompt: run the turn, close with a reasoned Idle state, then
/// ack. Updates themselves flow through the connection's pump.
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

    let result = runtime.send_user_message(text, attachments).await;

    let stop_reason = match &result {
        Ok(()) if cancelled.load(Ordering::SeqCst) => StopReason::Cancelled,
        Ok(()) => StopReason::EndTurn,
        Err(foyer_agent::engine::EngineError::Interrupted) => StopReason::Cancelled,
        Err(foyer_agent::engine::EngineError::RoundLimit(_)) => StopReason::MaxTurnRequests,
        Err(_) => StopReason::EndTurn,
    };
    let _ = cx.send_notification(UpdateSessionNotification::new(
        sid.clone(),
        SessionUpdate::StateUpdate(StateUpdate::Idle(
            IdleStateUpdate::new().stop_reason(stop_reason),
        )),
    ));
    let response = match result {
        Ok(()) => Ok(PromptResponse::new()),
        Err(e) => Err(agent_client_protocol::util::internal_error(e)),
    };
    let _ = responder.respond_with_result(response);
}
