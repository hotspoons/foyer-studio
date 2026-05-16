// SPDX-License-Identifier: Apache-2.0
//! Single-turn agent loop. Builds the LLM request from the
//! conversation + skills, streams the response, dispatches any tool
//! calls back through the registry, and loops until the model emits a
//! turn with no tool calls.
//!
//! Owned by [`crate::runtime::AgentRuntime`]; never invoked directly
//! from outside the crate.

use std::sync::Arc;

use foyer_schema::agent::{
    AgentAutonomy, AgentMessageRecord, AgentRole, AgentToolCallRecord, AgentToolStatus,
};
use futures::StreamExt;
use serde_json::Value;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::conversation::Conversation;
use crate::llm::{
    LlmClient, LlmDeltaToolCall, LlmFunctionDef, LlmMessage, LlmRequest, LlmStreamChunk,
    LlmToolCall, LlmToolDef,
};
use crate::tools::{Tool, ToolContext, ToolError, ToolRegistry};

/// Soft cap on the model→tool→model loop. Stops a runaway agent
/// from burning tokens forever, but instead of hard-erroring at the
/// boundary we inject escalating wrap-up nudges so the model can
/// finalise. The hard cap (below) only fires if the model keeps
/// emitting tool calls AFTER the explicit "no more tools" warning.
pub const MAX_TOOL_ROUNDS: u32 = 32;
/// Rounds before the limit at which the engine starts nudging.
/// On round MAX_TOOL_ROUNDS - SOFT_LIMIT_WARN_WINDOW we tell the
/// model "you have N rounds left, start wrapping up"; on the
/// last round we tell it "no more tools — final answer now".
const SOFT_LIMIT_WARN_WINDOW: u32 = 4;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("llm: {0}")]
    Llm(#[from] crate::llm::LlmError),
    #[error("tool: {0}")]
    Tool(#[from] ToolError),
    #[error("interrupted")]
    Interrupted,
    #[error("autonomy gate: confirm channel closed before answer")]
    ConfirmDropped,
    #[error("tool round limit ({0}) exceeded")]
    RoundLimit(u32),
}

/// Callbacks the runtime gives the engine so it can publish progress.
#[async_trait::async_trait]
pub trait EngineSink: Send + Sync {
    /// New record persisted; broadcast `AgentMessage`.
    async fn on_record(&self, record: AgentMessageRecord);
    /// Streaming delta on the in-flight assistant turn.
    async fn on_token(&self, message_id: u64, delta: String);
    /// Tool status changed.
    async fn on_tool_update(
        &self,
        message_id: u64,
        call_id: String,
        status: AgentToolStatus,
        preview: Option<String>,
        result_json: String,
    );
    /// Block until the user approves or rejects a parked tool call.
    /// Returns true to approve, false to reject.
    async fn await_confirm(&self, call_id: String) -> Result<bool, EngineError>;
    /// Append a JSONL trace line to the current session's debug
    /// log. The runtime decides where it lands — typically
    /// `~/.local/share/foyer/agent/trace/<session>.jsonl`. Used to
    /// capture full LLM request / response / tool-call context for
    /// fine-tuning. Default impl is a no-op so non-tracing sinks
    /// don't have to think about it.
    async fn on_trace(&self, _line: serde_json::Value) {}
}

pub struct AgentEngine {
    pub conversation: Arc<Mutex<Conversation>>,
    pub tools: ToolRegistry,
    pub llm: Arc<dyn LlmClient>,
    pub model: String,
    pub autonomy: AgentAutonomy,
    pub system_prompt: String,
}

impl AgentEngine {
    /// Run one user turn — adds the user message, then loops over
    /// assistant turns until the model stops calling tools.
    pub async fn run_turn(
        &self,
        user_body: String,
        attachments: Vec<foyer_schema::agent::AgentAttachment>,
        ctx: ToolContext,
        sink: Arc<dyn EngineSink>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<(), EngineError> {
        // Record + broadcast the user message (with any image
        // attachments — record_to_llm folds these into a multi-modal
        // content array when emitting the OpenAI request).
        let user_record = {
            let mut conv = self.conversation.lock().await;
            conv.push_user_with_attachments(user_body, attachments)
        };
        sink.on_record(user_record).await;

        let mut rounds = 0u32;
        loop {
            rounds += 1;
            // Soft wrap-up nudges. The cap exists so a confused
            // model can't loop forever burning tokens; but a model
            // that's mid-task on a legitimately large operation just
            // needs to know it has to start packing up. The nudge is
            // a system message slipped into THIS round's request only
            // (not persisted to the transcript), so the model sees
            // it the same way it sees the regular system prompt.
            let remaining = MAX_TOOL_ROUNDS.saturating_sub(rounds);
            let wrap_up_nudge = if remaining == 0 {
                Some(format!(
                    "You've hit the tool-round cap ({MAX_TOOL_ROUNDS}). This MUST \
                     be your final reply — do NOT emit any more tool calls; \
                     summarise what you accomplished and what's still pending \
                     so the user can re-prompt if they want you to continue."
                ))
            } else if remaining < SOFT_LIMIT_WARN_WINDOW {
                Some(format!(
                    "Heads-up: you've used {rounds}/{MAX_TOOL_ROUNDS} tool rounds. \
                     Only {remaining} left before the harness forces a stop. \
                     Start wrapping up — finish your highest-priority pending \
                     work, then give the user a status summary instead of \
                     chaining more tools."
                ))
            } else {
                None
            };
            let request = self.build_request_with_nudge(wrap_up_nudge.as_deref());
            // Capture the outgoing context for the trace log. Trace
            // is best-effort — we never propagate errors out.
            sink.on_trace(serde_json::json!({
                "ts_ms": now_ms(),
                "kind": "llm_request",
                "round": rounds,
                "model": &request.model,
                "messages": &request.messages,
                "tools": &request.tools,
            }))
            .await;
            let mut stream = self.llm.stream(request).await?;
            // Pre-allocate the assistant record so streaming deltas
            // have a target id to refer to.
            let assistant_id = {
                let mut conv = self.conversation.lock().await;
                let rec = conv.push_assistant(String::new(), Vec::new());
                rec.id
            };
            sink.on_record(AgentMessageRecord {
                id: assistant_id,
                role: AgentRole::Assistant,
                content: String::new(),
                tool_calls: Vec::new(),
                tool_call_id: None,
                attachments: Vec::new(),
                ts_ms: now_ms(),
            })
            .await;

            let mut tool_accum: Vec<AccumTool> = Vec::new();
            let mut finish_reason: Option<String> = None;
            // Reasoner-endpoint streams (vLLM `--enable-reasoning`,
            // DeepSeek native API) deliver chain-of-thought in a
            // separate `reasoning_content` field rather than inline
            // `<think>` tags. Fold it into the assistant content
            // stream with `<think>...</think>` markers — the FE only
            // has one parser for both shapes.
            let mut in_reasoning = false;
            let mut interrupted = false;

            loop {
                let item = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => {
                        // User hit Stop (or queued a new message via
                        // "Stop and send now"). Drop the stream;
                        // whatever assistant content we've already
                        // buffered on the conversation record stays as
                        // context for the next turn.
                        interrupted = true;
                        break;
                    }
                    next = stream.next() => next,
                };
                let Some(item) = item else { break };
                let chunk: LlmStreamChunk = item?;
                let Some(choice) = chunk.choices.into_iter().next() else {
                    continue;
                };
                if let Some(text) = choice.delta.reasoning_content {
                    if !text.is_empty() {
                        let mut to_emit = String::new();
                        if !in_reasoning {
                            to_emit.push_str("<think>");
                            in_reasoning = true;
                        }
                        to_emit.push_str(&text);
                        let mut conv = self.conversation.lock().await;
                        let _ = conv.append_assistant_token(&to_emit);
                        drop(conv);
                        sink.on_token(assistant_id, to_emit).await;
                    }
                }
                if let Some(text) = choice.delta.content {
                    if !text.is_empty() {
                        let mut to_emit = String::new();
                        if in_reasoning {
                            to_emit.push_str("</think>");
                            in_reasoning = false;
                        }
                        to_emit.push_str(&text);
                        let mut conv = self.conversation.lock().await;
                        let _ = conv.append_assistant_token(&to_emit);
                        drop(conv);
                        sink.on_token(assistant_id, to_emit).await;
                    }
                }
                for delta in choice.delta.tool_calls {
                    Self::accumulate_tool(&mut tool_accum, delta);
                }
                if let Some(reason) = choice.finish_reason {
                    finish_reason = Some(reason);
                }
            }
            // Stream ended mid-reasoning (rare, but possible if the
            // server cuts the connection) — close the open tag so the
            // FE doesn't render a perpetual spinner.
            if in_reasoning {
                let close = "</think>".to_string();
                let mut conv = self.conversation.lock().await;
                let _ = conv.append_assistant_token(&close);
                drop(conv);
                sink.on_token(assistant_id, close).await;
            }

            let calls = Self::finalize_tool_accum(tool_accum);

            // Stamp the finalized tool calls onto the assistant record.
            self.attach_tool_calls(&sink, assistant_id, &calls).await;

            // If the user interrupted (Stop / Stop-and-send), drop
            // out NOW — don't dispatch tool calls the LLM may have
            // started constructing mid-stream, and don't loop into
            // another LLM round. The conversation already has the
            // partial assistant content + whatever tool_calls we
            // managed to finalize.
            if interrupted {
                return Ok(());
            }

            // Trace the response side of this round.
            let final_content = {
                let conv = self.conversation.lock().await;
                let mut out = String::new();
                for r in conv.records().rev() {
                    if r.id == assistant_id {
                        out = r.content.clone();
                        break;
                    }
                }
                out
            };
            sink.on_trace(serde_json::json!({
                "ts_ms": now_ms(),
                "kind": "llm_response",
                "round": rounds,
                "assistant_id": assistant_id,
                "content": final_content,
                "tool_calls": calls.iter().map(|c| serde_json::json!({
                    "call_id": c.call_id,
                    "name": c.tool_name,
                    "args_json": c.args_json,
                })).collect::<Vec<_>>(),
                "finish_reason": finish_reason,
            }))
            .await;

            if calls.is_empty() {
                // No tools requested. Final assistant message is the
                // current tail; we're done.
                return Ok(());
            }

            // Hard stop: we already told the model "no more tools" on
            // this round via the wrap-up nudge, and it still emitted
            // tool calls. Rather than hard-error, drop the unexecuted
            // calls, append a synthetic assistant note explaining the
            // truncation, and exit. The user can re-prompt with
            // "continue" if they want the agent to keep going. Each
            // dropped call gets marked `error` on the existing
            // assistant record so the UI shows it as truncated rather
            // than indefinitely-pending.
            if rounds >= MAX_TOOL_ROUNDS {
                for c in &calls {
                    let msg = format!(
                        "harness round limit ({MAX_TOOL_ROUNDS}) reached — call not dispatched"
                    );
                    self.record_tool_result(
                        &sink,
                        assistant_id,
                        &c.call_id,
                        AgentToolStatus::Error,
                        &msg,
                        &msg,
                    )
                    .await;
                }
                // Append a fresh assistant note so the user sees a
                // human-readable explanation in the transcript instead
                // of silent truncation.
                let note = format!(
                    "_(Reached the {MAX_TOOL_ROUNDS}-round tool cap. Re-prompt with \
                     \"continue\" to keep going, or ask me to summarise what's left.)_"
                );
                let rec = {
                    let mut conv = self.conversation.lock().await;
                    conv.push_assistant(note, Vec::new())
                };
                sink.on_record(rec).await;
                return Ok(());
            }

            // Run each tool, honoring autonomy gate.
            for call in calls {
                let tool = match self.tools.get(&call.tool_name) {
                    Some(t) => t,
                    None => {
                        let msg = format!("unknown tool: {}", call.tool_name);
                        self.record_tool_result(
                            &sink,
                            assistant_id,
                            &call.call_id,
                            AgentToolStatus::Error,
                            &msg,
                            &msg,
                        )
                        .await;
                        continue;
                    }
                };
                if self.requires_confirm(&*tool) {
                    self.broadcast_tool_status(
                        &sink,
                        assistant_id,
                        &call.call_id,
                        AgentToolStatus::AwaitingConfirm,
                        Some(call.args_json.clone()),
                        String::new(),
                    )
                    .await;
                    let approved = sink.await_confirm(call.call_id.clone()).await?;
                    if !approved {
                        self.record_tool_result(
                            &sink,
                            assistant_id,
                            &call.call_id,
                            AgentToolStatus::Rejected,
                            "user rejected this tool call",
                            "rejected",
                        )
                        .await;
                        continue;
                    }
                }
                self.broadcast_tool_status(
                    &sink,
                    assistant_id,
                    &call.call_id,
                    AgentToolStatus::Running,
                    None,
                    String::new(),
                )
                .await;
                let args: Value = serde_json::from_str(&call.args_json).unwrap_or(Value::Null);
                let result = tool.call(&ctx, args).await;
                match result {
                    Ok(res) => {
                        let result_json = serde_json::to_string(&res).unwrap_or_default();
                        self.record_tool_result(
                            &sink,
                            assistant_id,
                            &call.call_id,
                            AgentToolStatus::Done,
                            &res.summary.clone(),
                            &result_json,
                        )
                        .await;
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        self.record_tool_result(
                            &sink,
                            assistant_id,
                            &call.call_id,
                            AgentToolStatus::Error,
                            &msg,
                            &msg,
                        )
                        .await;
                    }
                }
            }
            // Loop to let the model see the tool results.
        }
    }

    #[allow(dead_code)]
    fn build_request(&self) -> LlmRequest {
        self.build_request_with_nudge(None)
    }

    /// Build the chat-completions payload for the current turn.
    /// `extra_system` is an optional one-shot system message appended
    /// AFTER the standard system prompt and any conversation history —
    /// used by `run_turn` to inject the round-limit wrap-up nudge
    /// without persisting it to the transcript.
    fn build_request_with_nudge(&self, extra_system: Option<&str>) -> LlmRequest {
        // We snapshot the conversation under the lock then drop it
        // before the network call — keeps the lock fine-grained even
        // when streaming takes seconds.
        // SAFETY: this is sync access on a Mutex inside an async fn,
        // so we use try_lock + a blocking wait. The conversation
        // lock is held only briefly elsewhere.
        let records = match self.conversation.try_lock() {
            Ok(g) => g.snapshot(),
            Err(_) => {
                // Fall back: build with an empty conversation. This
                // path should never hit in practice because the only
                // other lockers are this same engine's accumulators.
                Vec::new()
            }
        };
        let mut messages = Vec::with_capacity(records.len() + 2);
        if !self.system_prompt.is_empty() {
            messages.push(LlmMessage {
                role: "system".into(),
                content: Value::String(self.system_prompt.clone()),
                tool_calls: Vec::new(),
                tool_call_id: None,
            });
        }
        for rec in records {
            messages.push(record_to_llm(rec));
        }
        // Append the wrap-up nudge AFTER conversation history so the
        // model treats it as the freshest instruction. We send it as
        // a `system` role; every OpenAI-compatible endpoint honors a
        // mid-conversation system message as a directive.
        if let Some(nudge) = extra_system {
            messages.push(LlmMessage {
                role: "system".into(),
                content: Value::String(nudge.to_string()),
                tool_calls: Vec::new(),
                tool_call_id: None,
            });
        }
        let tools = self
            .tools
            .iter()
            .map(|t| LlmToolDef {
                kind: "function",
                function: LlmFunctionDef {
                    name: t.name().to_string(),
                    description: t.description().to_string(),
                    parameters: t.schema(),
                },
            })
            .collect();
        LlmRequest {
            model: self.model.clone(),
            messages,
            tools,
            stream: true,
            temperature: None,
        }
    }

    fn requires_confirm(&self, tool: &dyn Tool) -> bool {
        matches!(self.autonomy, AgentAutonomy::Ask) && tool.destructive()
    }

    async fn attach_tool_calls(
        &self,
        sink: &Arc<dyn EngineSink>,
        assistant_id: u64,
        calls: &[AccumTool],
    ) {
        let updated_record = {
            let mut conv = self.conversation.lock().await;
            let mut updated: Option<AgentMessageRecord> = None;
            for rec in conv.records_mut().rev() {
                if rec.id == assistant_id {
                    rec.tool_calls = calls
                        .iter()
                        .map(|c| AgentToolCallRecord {
                            call_id: c.call_id.clone(),
                            tool_name: c.tool_name.clone(),
                            args_json: c.args_json.clone(),
                            status: AgentToolStatus::Pending,
                            preview: None,
                            result_json: String::new(),
                        })
                        .collect();
                    updated = Some(rec.clone());
                    break;
                }
            }
            updated
        };
        // Re-emit the assistant record so clients learn about the
        // tool calls in real time. Without this the FE only sees a
        // text-only message and ignores the subsequent
        // `AgentToolUpdate` events (there's nothing to update).
        if let Some(rec) = updated_record {
            sink.on_record(rec).await;
        }
    }

    async fn broadcast_tool_status(
        &self,
        sink: &Arc<dyn EngineSink>,
        message_id: u64,
        call_id: &str,
        status: AgentToolStatus,
        preview: Option<String>,
        result_json: String,
    ) {
        // Mirror the new status onto the assistant record so a session
        // reload picks up a populated card (status + args + result_json
        // bundled with the assistant turn) instead of stuck-pending
        // stubs. Then re-enqueue the record so the persisted JSONL
        // catches the post-update state — without this, the JSONL
        // keeps the original `pending` snapshot from `attach_tool_calls`.
        let updated_record = {
            let mut conv = self.conversation.lock().await;
            let result_ref = if result_json.is_empty() {
                None
            } else {
                Some(result_json.as_str())
            };
            conv.update_tool_status(message_id, call_id, status, preview.clone(), result_ref);
            conv.record_by_id(message_id)
        };
        sink.on_tool_update(
            message_id,
            call_id.to_string(),
            status,
            preview,
            result_json,
        )
        .await;
        if let Some(rec) = updated_record {
            sink.on_record(rec).await;
        }
    }

    async fn record_tool_result(
        &self,
        sink: &Arc<dyn EngineSink>,
        message_id: u64,
        call_id: &str,
        status: AgentToolStatus,
        summary: &str,
        result_json: &str,
    ) {
        self.broadcast_tool_status(
            sink,
            message_id,
            call_id,
            status,
            Some(summary.to_string()),
            result_json.to_string(),
        )
        .await;
        // Also push a `tool` role record so the next round-trip
        // shows the result to the model.
        let rec = {
            let mut conv = self.conversation.lock().await;
            conv.push_tool_result(call_id.to_string(), result_json.to_string())
        };
        sink.on_record(rec).await;
        sink.on_trace(serde_json::json!({
            "ts_ms": now_ms(),
            "kind": "tool_result",
            "message_id": message_id,
            "call_id": call_id,
            "status": format!("{status:?}"),
            "summary": summary,
            "result_json": result_json,
        }))
        .await;
    }

    fn accumulate_tool(accum: &mut Vec<AccumTool>, delta: LlmDeltaToolCall) {
        let idx = delta.index as usize;
        while accum.len() <= idx {
            accum.push(AccumTool::default());
        }
        let slot = &mut accum[idx];
        if let Some(id) = delta.id {
            slot.call_id = id;
        }
        if let Some(f) = delta.function {
            if let Some(name) = f.name {
                slot.tool_name.push_str(&name);
            }
            if let Some(args) = f.arguments {
                slot.args_json.push_str(&args);
            }
        }
    }

    fn finalize_tool_accum(accum: Vec<AccumTool>) -> Vec<AccumTool> {
        accum
            .into_iter()
            .filter(|t| !t.tool_name.is_empty())
            .map(|mut t| {
                if t.call_id.is_empty() {
                    t.call_id = format!("call_{}", Uuid::new_v4().simple());
                }
                if t.args_json.is_empty() {
                    t.args_json = "{}".into();
                }
                t
            })
            .collect()
    }
}

#[derive(Debug, Default, Clone)]
pub(crate) struct AccumTool {
    pub call_id: String,
    pub tool_name: String,
    pub args_json: String,
}

fn record_to_llm(rec: AgentMessageRecord) -> LlmMessage {
    let role = match rec.role {
        AgentRole::System => "system",
        AgentRole::User => "user",
        AgentRole::Assistant => "assistant",
        AgentRole::Tool => "tool",
    };
    // Build the `content` field. With no media attachments we emit
    // the classic string shape every OpenAI-compatible endpoint
    // expects. When at least one image or audio attachment rides
    // along we switch to the multi-modal content-block array — every
    // VLM / multi-modal provider (Kimi-VL, GPT-4o, GPT-4o-audio,
    // Claude, Gemini, Qwen-VL, OpenRouter passthrough) parses this
    // shape; models that don't support a given modality just drop
    // the unrecognized block and see the text.
    let image_count = rec
        .attachments
        .iter()
        .filter(|a| a.mime.starts_with("image/"))
        .count();
    let audio_count = rec
        .attachments
        .iter()
        .filter(|a| a.mime.starts_with("audio/"))
        .count();
    let content = if image_count > 0 || audio_count > 0 {
        // The text block always carries an attachment announcement
        // so non-multimodal models still know media was sent — they
        // can acknowledge it ("I can't view images yet, can you
        // describe what's in them?") instead of silently ignoring
        // the user's upload, which reads as broken UX.
        let announcement = attachment_announcement(image_count, audio_count);
        let text = if rec.content.is_empty() {
            announcement
        } else {
            format!("{}\n\n{announcement}", rec.content)
        };
        let mut blocks: Vec<Value> = Vec::with_capacity(rec.attachments.len() + 1);
        blocks.push(serde_json::json!({
            "type": "text",
            "text": text,
        }));
        for a in &rec.attachments {
            if a.mime.starts_with("image/") {
                // OpenAI image_url accepts data:<mime>;base64,<b64>
                // URIs; every provider speaking the multi-modal
                // shape honors the data: form.
                let url = format!("data:{};base64,{}", a.mime, a.b64);
                blocks.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": url },
                }));
            } else if a.mime.starts_with("audio/") {
                // OpenAI gpt-4o-audio convention: `input_audio`
                // block with raw base64 + format suffix (no data:
                // wrapper). Format is the MIME subtype — `wav`,
                // `mp3`, `flac`, `ogg`, `webm`, etc.
                let format = a.mime.strip_prefix("audio/").unwrap_or("wav").to_string();
                blocks.push(serde_json::json!({
                    "type": "input_audio",
                    "input_audio": { "data": a.b64, "format": format },
                }));
            }
        }
        Value::Array(blocks)
    } else if rec.content.is_empty() {
        Value::Null
    } else {
        Value::String(rec.content)
    };
    LlmMessage {
        role: role.into(),
        content,
        tool_calls: rec
            .tool_calls
            .into_iter()
            .map(|c| LlmToolCall {
                id: c.call_id,
                kind: "function".into(),
                function: crate::llm::LlmFunctionCall {
                    name: c.tool_name,
                    arguments: c.args_json,
                },
            })
            .collect(),
        tool_call_id: rec.tool_call_id,
    }
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Build the text line that announces image/audio attachments to the
/// model. Always emitted alongside the multi-modal content blocks so
/// non-VLM / non-audio models still know media was sent and can ask
/// the user to describe it instead of silently dropping the upload.
fn attachment_announcement(image_count: usize, audio_count: usize) -> String {
    fn pluralize(n: usize, singular: &str) -> String {
        if n == 1 {
            format!("1 {singular}")
        } else {
            format!("{n} {singular}s")
        }
    }
    let mut parts: Vec<String> = Vec::with_capacity(2);
    if image_count > 0 {
        parts.push(pluralize(image_count, "image"));
    }
    if audio_count > 0 {
        parts.push(pluralize(audio_count, "audio clip"));
    }
    let list = parts.join(" and ");
    format!(
        "[Foyer attachments: {list} included with this message. \
         If your model can't process the {} block(s), acknowledge \
         that to the user and ask them to describe or transcribe \
         the content so you can still help.]",
        if image_count > 0 && audio_count > 0 {
            "image/audio"
        } else if image_count > 0 {
            "image"
        } else {
            "audio"
        }
    )
}
