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

/// Initial budget for the model→tool→model loop per turn. The agent
/// can extend this mid-turn by calling the hidden `continue_working`
/// tool when it's genuinely in the middle of something — that bumps
/// the live cap by `ROUND_BUDGET_EXTENSION` instead of failing out.
/// Without an extension the agent gets a gentle "you've used your
/// budget; consider following up with the user" nudge well before
/// the cliff, and a hard truncation only after it actively ignored
/// the suggestion.
pub const INITIAL_TOOL_ROUND_BUDGET: u32 = 32;
/// How many extra rounds each call to `continue_working` grants.
pub const ROUND_BUDGET_EXTENSION: u32 = 32;
/// Rounds before the current budget at which the engine starts
/// nudging. On `current_budget - SOFT_LIMIT_WARN_WINDOW` we hint
/// "you've used most of your tool budget — consider wrapping up,
/// or call `continue_working` if you're genuinely mid-task". On the
/// last round we tell it "this is your last round before truncation".
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

/// Per-turn mutable state the engine threads through tool calls so a
/// tool can request a budget extension and the loop picks it up on
/// the very next round. Wrapped in an Arc<Mutex<…>> so tool
/// implementations (in particular the hidden `continue_working`
/// tool) can mutate it without going through the engine.
#[derive(Debug, Default)]
pub struct TurnBudget {
    /// Current cap on tool rounds. Starts at INITIAL_TOOL_ROUND_BUDGET
    /// and grows by ROUND_BUDGET_EXTENSION each time the agent calls
    /// `continue_working`.
    pub cap: u32,
    /// How many times the agent has extended the budget in this turn.
    /// Surfaced in subsequent nudges so the operator can see the
    /// pattern in the trace.
    pub extensions: u32,
}

impl TurnBudget {
    pub fn new() -> Self {
        Self {
            cap: INITIAL_TOOL_ROUND_BUDGET,
            extensions: 0,
        }
    }
    pub fn extend(&mut self) {
        self.cap = self.cap.saturating_add(ROUND_BUDGET_EXTENSION);
        self.extensions = self.extensions.saturating_add(1);
    }
}

impl AgentEngine {
    /// Run one user turn — adds the user message, then loops over
    /// assistant turns until the model stops calling tools.
    pub async fn run_turn(
        &self,
        user_body: String,
        attachments: Vec<foyer_schema::agent::AgentAttachment>,
        mut ctx: ToolContext,
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

        // Per-turn extendable budget. Tools (specifically the hidden
        // `continue_working`) mutate this Arc<Mutex<>> mid-turn to
        // grant the model another batch of rounds.
        let budget: crate::tools::TurnBudgetHandle =
            std::sync::Arc::new(std::sync::Mutex::new(TurnBudget::new()));
        ctx.turn_budget = Some(budget.clone());

        let mut rounds = 0u32;
        loop {
            rounds += 1;
            // Read the LIVE cap each round — `continue_working` may
            // have bumped it during the previous round's tool spree.
            let (current_cap, extensions) = {
                let g = budget.lock().expect("turn budget mutex poisoned");
                (g.cap, g.extensions)
            };
            // Soft wrap-up nudges. Framing matters: a model that
            // panics about running out of rounds will stop mid-task
            // and the user has to re-prompt. The new copy reminds the
            // model of the *available* options (wrap up cleanly OR
            // extend via `continue_working`) rather than threatening
            // a hard stop. The cliff messaging only kicks in on the
            // final round, and even then we suggest the extension.
            let remaining = current_cap.saturating_sub(rounds);
            let wrap_up_nudge = if remaining == 0 {
                Some(format!(
                    "Heads-up: this is round {rounds}/{current_cap}, your last \
                     before the harness will trim any further tool calls. \
                     Two paths from here:\n\
                     · If you're at a natural checkpoint, give the user a short \
                       summary of what you finished + what you'd suggest next.\n\
                     · If you're genuinely mid-task and stopping now would leave \
                       things half-done, call `continue_working` with a short \
                       reason — that grants {ROUND_BUDGET_EXTENSION} more rounds \
                       (already extended {extensions} time(s) this turn).\n\
                     No pressure either way — pick whatever serves the user best."
                ))
            } else if remaining < SOFT_LIMIT_WARN_WINDOW {
                Some(format!(
                    "You're on round {rounds}/{current_cap} ({remaining} left). \
                     If you're close to a natural stopping point, wrap up + \
                     surface a summary; if you're genuinely mid-task, you can \
                     call `continue_working` for another batch of rounds. \
                     Otherwise carry on — this is a friendly reminder, not a \
                     stop sign."
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
            let mut stream = match self.llm.stream(request).await {
                Ok(s) => s,
                Err(crate::llm::LlmError::Server { status: 400, body })
                    if is_context_overflow(&body) =>
                {
                    // Context window blown — common when the model's
                    // tool spree filled up the conversation. Compact
                    // the prefix into a summary system message and
                    // retry this round. The compaction is best-effort:
                    // if it ALSO 400s (e.g. summary call had no
                    // budget either), we give up and propagate.
                    sink.on_trace(serde_json::json!({
                        "ts_ms": now_ms(),
                        "kind": "context_overflow",
                        "round": rounds,
                        "body": body,
                    }))
                    .await;
                    match self.compact_conversation_inline(&sink).await {
                        Ok(()) => continue,
                        Err(e) => {
                            tracing::warn!(
                                "context compaction failed after 400; \
                                 propagating original error: {e}"
                            );
                            return Err(crate::llm::LlmError::Server { status: 400, body }.into());
                        }
                    }
                }
                Err(e) => return Err(e.into()),
            };
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

            // Truncation guard: the model already saw the
            // last-round nudge and didn't pick either path (wrap up
            // OR extend via `continue_working`), and now wants
            // another batch of tool calls. We trim them and append
            // an explanatory assistant note. Re-read the cap because
            // `continue_working` might have extended it DURING this
            // round's tool dispatch — in that case we should NOT
            // truncate, the agent did the right thing.
            let live_cap = budget.lock().expect("turn budget mutex poisoned").cap;
            if rounds >= live_cap {
                for c in &calls {
                    let msg = format!(
                        "tool round budget ({live_cap}) reached — call not dispatched. \
                         Call `continue_working` next turn if you need more rounds."
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
                // Friendly transcript note. We avoid framing this as
                // an error — it's a natural stopping point and the
                // user can keep going by re-prompting or by the
                // model calling `continue_working` next turn.
                let extensions_used = budget
                    .lock()
                    .expect("turn budget mutex poisoned")
                    .extensions;
                let note = if extensions_used > 0 {
                    format!(
                        "_(Pausing here — used the full tool budget for this turn ({live_cap} \
                         rounds, extended {extensions_used} time(s)). Reply 'continue' if you'd \
                         like me to keep going from where I left off.)_"
                    )
                } else {
                    format!(
                        "_(Pausing here — that was {live_cap} rounds of tool calls. Reply \
                         'continue' or give me a more specific direction and I'll pick \
                         back up.)_"
                    )
                };
                let rec = {
                    let mut conv = self.conversation.lock().await;
                    conv.push_assistant(note, Vec::new())
                };
                sink.on_record(rec).await;
                return Ok(());
            }

            // Run each tool, honoring autonomy gate. The cancel check
            // runs BEFORE every call AND races each tool.call so a
            // user-pressed Stop interrupts the batch promptly. Without
            // this, a model that emitted N tool calls in one round
            // would tie up the harness for N×tool-latency milliseconds
            // before the cancel could land (the next cancel check only
            // happened in the NEXT LLM stream — irrelevant for a
            // batch-of-tools round).
            for call in calls {
                if cancel.is_cancelled() {
                    // Mark remaining as rejected so the FE doesn't show
                    // them indefinitely pending.
                    self.record_tool_result(
                        &sink,
                        assistant_id,
                        &call.call_id,
                        AgentToolStatus::Rejected,
                        "interrupted by stop",
                        "interrupted",
                    )
                    .await;
                    interrupted = true;
                    continue;
                }
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
                    // Race confirmation with cancel so the user can
                    // bail out of "awaiting confirm" with the Stop
                    // button instead of having to reject every call.
                    let approved = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => {
                            self.record_tool_result(
                                &sink,
                                assistant_id,
                                &call.call_id,
                                AgentToolStatus::Rejected,
                                "interrupted by stop",
                                "interrupted",
                            )
                            .await;
                            interrupted = true;
                            continue;
                        }
                        approved = sink.await_confirm(call.call_id.clone()) => approved?,
                    };
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
                // Race the tool against the cancel token. Most tools
                // are short-lived (msgpack round-trip to the shim) but
                // a few (visualize.spectrogram with chromium headless,
                // a long script run) can take seconds, and we don't
                // want Stop to be a no-op while one of those is in
                // flight. The tool task is dropped on cancel; tools
                // that need to clean up resources do so via the
                // backend's own Drop impls.
                let result = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => {
                        self.record_tool_result(
                            &sink,
                            assistant_id,
                            &call.call_id,
                            AgentToolStatus::Rejected,
                            "interrupted by stop",
                            "interrupted",
                        )
                        .await;
                        interrupted = true;
                        continue;
                    }
                    r = tool.call(&ctx, args) => r,
                };
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
            // If cancel fired during tool execution, exit before
            // looping back into another LLM call. Without this, the
            // engine would happily kick off the NEXT round (the model
            // would see "interrupted" tool results and keep going)
            // and the user's Stop would feel like it only delayed
            // things by one tool.
            if interrupted {
                return Ok(());
            }
            // Loop to let the model see the tool results.
        }
    }

    #[allow(dead_code)]
    fn build_request(&self) -> LlmRequest {
        self.build_request_with_nudge(None)
    }

    /// Compact the conversation in-place after a context-window 400.
    ///
    /// Strategy: ask the LLM to summarise everything BEFORE the last
    /// user message (the one that triggered the current turn), then
    /// replace those records with a single system message containing
    /// the summary. The last user message and any partial assistant
    /// turn from this round stay intact so the upcoming retry has the
    /// full prompt context.
    ///
    /// Emphasis on big-picture + recent events per the user's ask —
    /// the prompt explicitly tells the summariser to bias toward
    /// recent activity and the user's headline goal.
    async fn compact_conversation_inline(
        &self,
        sink: &Arc<dyn EngineSink>,
    ) -> Result<(), EngineError> {
        // Split point: keep ONE final assistant/tool round and the
        // last user message intact as the "live" tail. Everything
        // earlier is fair game for summarisation. We use the last
        // user message as the anchor; if there's no user message,
        // the second-to-last record. The tail still gets its own
        // redaction pass before re-entry into the conversation so a
        // single huge tool result can't keep the live tail in the
        // overflow zone.
        let (older_records, anchor_idx, conv_len) = {
            let conv = self.conversation.lock().await;
            let snap = conv.snapshot();
            let len = snap.len();
            let anchor = snap
                .iter()
                .rposition(|r| matches!(r.role, AgentRole::User))
                .unwrap_or_else(|| len.saturating_sub(1));
            let older: Vec<_> = snap.iter().take(anchor).cloned().collect();
            (older, anchor, len)
        };
        // Even if we have <4 older records, we still attempt
        // compaction when the live tail itself is the bloat — the
        // tail-redact path below shrinks it via base64 elision so the
        // next round has a fighting chance. The summary call is only
        // needed if there's enough history to lose info on.
        let mut summary_banner: Option<String> = None;
        if older_records.len() >= 4 {
            let summary = self.summarise_records(sink, &older_records).await?;
            summary_banner = Some(format!(
                "[Earlier conversation ({} messages of {}) was compacted to keep within the \
                 context window. Summary follows.]\n\n{}",
                older_records.len(),
                conv_len,
                summary.trim(),
            ));
        }
        // Now rebuild the conversation: optional summary, then the
        // tail with any base64 / attachments redacted. The tail
        // redaction handles the case where the live tool result was
        // the actual cause of the overflow (huge visualize PNG, etc.).
        let mut tail_redacted = {
            let conv = self.conversation.lock().await;
            let tail: Vec<_> = conv.snapshot().into_iter().skip(anchor_idx).collect();
            tail
        };
        redact_records_for_llm(&mut tail_redacted);
        // If after redaction the tail STILL holds a single record
        // with > 200kB of content (e.g. a custom tool that dumped
        // structured JSON), truncate it in place so the next round
        // can run. The model loses fidelity but the conversation
        // keeps moving — better than a hard stall.
        const TAIL_TRUNCATE_CHARS: usize = 200 * 1024;
        for rec in tail_redacted.iter_mut() {
            if rec.content.len() > TAIL_TRUNCATE_CHARS {
                let original = rec.content.len();
                rec.content.truncate(TAIL_TRUNCATE_CHARS);
                rec.content.push_str(&format!(
                    "\n\n[truncated: {} chars elided to fit context]",
                    original - TAIL_TRUNCATE_CHARS
                ));
            }
        }
        // No-op guard: if there's nothing to summarise AND no tail
        // bytes were stripped, the overflow is structural (system
        // prompt + tools schema + tiny live tail > model window).
        // Propagate the original 400 so the user sees the real error.
        if summary_banner.is_none() {
            let any_redaction = tail_redacted
                .iter()
                .any(|r| r.content.contains("[base64 elided") || r.content.contains("[truncated"));
            if !any_redaction {
                return Err(EngineError::Llm(crate::llm::LlmError::Server {
                    status: 400,
                    body: "context overflow with no summarisable prefix and no large blobs to \
                           strip — reduce the system prompt / live message"
                        .into(),
                }));
            }
        }
        {
            let mut conv = self.conversation.lock().await;
            conv.clear();
            if let Some(ref banner) = summary_banner {
                conv.push_system(banner.clone());
            }
            for rec in tail_redacted {
                conv.import_record(rec);
            }
        }
        sink.on_trace(serde_json::json!({
            "ts_ms": now_ms(),
            "kind": "compaction_applied",
            "older_messages": older_records.len(),
            "summary_emitted": summary_banner.is_some(),
        }))
        .await;
        // Surface a visible notice in the transcript so the user can
        // see what happened. Append as a system record (the FE already
        // renders system rows distinctly).
        let banner_record = {
            let mut conv = self.conversation.lock().await;
            let msg = match (summary_banner.is_some(), older_records.len()) {
                (true, n) => format!(
                    "(Compacted {n} earlier messages to fit the context window; \
                     continuing with summary as preamble.)"
                ),
                (false, _) => "(Tightened context by stripping large attachments / tool blobs \
                     from earlier messages; continuing.)"
                    .to_string(),
            };
            conv.push_system(msg)
        };
        sink.on_record(banner_record).await;
        Ok(())
    }

    /// Ask the LLM to summarise a slice of records. Wraps the
    /// compaction prompt; when the slice itself is too big for the
    /// model's window, recursively chunks it (binary split) so we
    /// can compact arbitrarily long histories without a single
    /// monster request.
    async fn summarise_records(
        &self,
        sink: &Arc<dyn EngineSink>,
        records: &[AgentMessageRecord],
    ) -> Result<String, EngineError> {
        // Redact base64 / attachments out of the slice before
        // serializing — without this a 1 MB screenshot would ride
        // INTO the summariser and re-trigger the overflow we're
        // trying to escape.
        let mut redacted: Vec<AgentMessageRecord> = records.to_vec();
        redact_records_for_llm(&mut redacted);
        let payload = serde_json::to_string(&redacted).unwrap_or_default();
        // Cap on chars we'll hand to the summariser in one shot.
        // 600kB ≈ 150k tokens for English text, well clear of the
        // 256k window we're typically running into. If the payload
        // exceeds this we recurse: summarise each half, concatenate
        // the two summaries.
        const ONE_SHOT_CHAR_CAP: usize = 600 * 1024;
        if payload.len() > ONE_SHOT_CHAR_CAP && redacted.len() > 1 {
            let mid = redacted.len() / 2;
            let (left, right) = redacted.split_at(mid);
            sink.on_trace(serde_json::json!({
                "ts_ms": now_ms(),
                "kind": "compaction_chunked",
                "total_records": redacted.len(),
                "left_records": left.len(),
                "right_records": right.len(),
            }))
            .await;
            // Recurse with the raw slices (not the already-redacted
            // copies) so we don't double-redact identical fields.
            let left_summary = Box::pin(self.summarise_records(sink, left)).await?;
            let right_summary = Box::pin(self.summarise_records(sink, right)).await?;
            return Ok(format!(
                "Earlier half:\n{}\n\nLater half:\n{}",
                left_summary.trim(),
                right_summary.trim()
            ));
        }
        sink.on_trace(serde_json::json!({
            "ts_ms": now_ms(),
            "kind": "compaction_request",
            "older_messages": redacted.len(),
            "payload_chars": payload.len(),
        }))
        .await;
        let summary_messages: Vec<LlmMessage> = vec![
            LlmMessage {
                role: "system".into(),
                content: Value::String(
                    "You are condensing an AI-agent transcript so the conversation can \
                     keep going within the LLM's context window. \
                     OUTPUT REQUIREMENTS:\n\
                     - Open with one sentence stating the user's overall goal.\n\
                     - Follow with a short bullet list of what has been done so far \
                       (the key decisions and tool calls — not every tool name).\n\
                     - Then a bullet list of OPEN questions, blockers, and recent \
                       events from the last few turns. Bias toward RECENT events; \
                       they're what the assistant needs to keep momentum.\n\
                     - Keep the whole summary under ~1500 tokens. No preamble like \
                       \"Here is a summary\" — just the summary itself."
                        .into(),
                ),
                tool_calls: vec![],
                tool_call_id: None,
            },
            LlmMessage {
                role: "user".into(),
                content: Value::String(payload),
                tool_calls: vec![],
                tool_call_id: None,
            },
        ];
        let compact_req = LlmRequest {
            model: self.model.clone(),
            messages: summary_messages,
            tools: vec![],
            temperature: Some(0.2),
            stream: false,
        };
        let summary = match self.llm.complete(compact_req).await {
            Ok(r) => r
                .choices
                .into_iter()
                .next()
                .map(|c| c.message.content)
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or_default(),
            Err(e) => return Err(EngineError::Llm(e)),
        };
        if summary.trim().is_empty() {
            return Err(EngineError::Llm(crate::llm::LlmError::Server {
                status: 400,
                body: "compaction returned empty summary".into(),
            }));
        }
        Ok(summary)
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
        let mut records = match self.conversation.try_lock() {
            Ok(g) => g.snapshot(),
            Err(_) => {
                // Fall back: build with an empty conversation. This
                // path should never hit in practice because the only
                // other lockers are this same engine's accumulators.
                Vec::new()
            }
        };
        // Strip giant base64 from older records before serializing.
        // Without this, every visualize.* / screenshot tool result
        // re-rides on every subsequent round and the context window
        // fills up in a handful of turns. The canonical conversation
        // ring (rendered in the FAB transcript) keeps the originals;
        // only the wire payload is slimmed.
        redact_records_for_llm(&mut records);
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

/// Heuristic match for "your prompt exceeded the model's context
/// window" 400s. Different providers word this differently — match on
/// the common substrings rather than a structured error code, which
/// not every provider populates.
fn is_context_overflow(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    lower.contains("maximum context length")
        || lower.contains("context_length_exceeded")
        || lower.contains("context window")
        || lower.contains("too long")
        || lower.contains("input_tokens") && (lower.contains("exceed") || lower.contains("maximum"))
        || lower.contains("reduce the length")
}

/// Replace large base64-like string values inside a JSON tree with a
/// short placeholder. Used to keep older tool results in the
/// conversation (so the model sees they happened + what their summary
/// was) without re-sending megabytes of image bytes every round.
///
/// We match on string values longer than `max_chars` that look like
/// base64 (only ASCII letters / digits / `+ / =`). The placeholder
/// preserves the original byte count so the model can reason about
/// "the screenshot was 142kB" without seeing the bytes.
fn redact_large_b64_in_value(v: &mut Value, max_chars: usize) {
    match v {
        Value::String(s) if s.len() > max_chars && looks_like_b64(s) => {
            let n = s.len();
            *s = format!("[base64 elided: {n} chars]");
        }
        Value::String(_) => {}
        Value::Array(arr) => {
            for item in arr.iter_mut() {
                redact_large_b64_in_value(item, max_chars);
            }
        }
        Value::Object(map) => {
            for (_, val) in map.iter_mut() {
                redact_large_b64_in_value(val, max_chars);
            }
        }
        _ => {}
    }
}

/// Cheap heuristic for "this string is base64-encoded payload, not
/// natural text." Skips the cost of a real decoder; we only need a
/// good-enough match to spot embedded images / audio.
fn looks_like_b64(s: &str) -> bool {
    // Require a minimum length so we don't trigger on short ascii
    // identifiers.
    if s.len() < 64 {
        return false;
    }
    // Inspect the first 256 bytes — base64 payloads are uniform from
    // any window, but ad-hoc text usually fails within the first ~64
    // chars.
    let sample = &s[..s.len().min(256)];
    sample.bytes().all(|b| {
        b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=' || b == b'\n' || b == b'\r'
    })
}

/// Redact a tool-result content blob (assumed to be a serialized
/// `ToolResult` JSON). On parse failure we just leave it alone — the
/// content could be a plain string from an older record format, in
/// which case the only way to bloat is via a giant single string and
/// the raw-content check at the call site already handles that.
fn redact_tool_result_content(content: &str, max_chars: usize) -> String {
    let mut v: Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(_) => return content.to_string(),
    };
    redact_large_b64_in_value(&mut v, max_chars);
    serde_json::to_string(&v).unwrap_or_else(|_| content.to_string())
}

/// Strip inline attachments from a record clone, leaving a stub line
/// in the content so the model still sees "an image was here" but
/// without the bytes. Used on records older than the most recent
/// user message — by then the model has already responded to the
/// attachment and doesn't need the bytes again.
fn strip_record_attachments(rec: &mut AgentMessageRecord) {
    if rec.attachments.is_empty() {
        return;
    }
    let mut images = 0usize;
    let mut audio = 0usize;
    let mut other = 0usize;
    for a in &rec.attachments {
        if a.mime.starts_with("image/") {
            images += 1;
        } else if a.mime.starts_with("audio/") {
            audio += 1;
        } else {
            other += 1;
        }
    }
    let mut bits: Vec<String> = Vec::new();
    if images > 0 {
        bits.push(format!("{images} image(s)"));
    }
    if audio > 0 {
        bits.push(format!("{audio} audio clip(s)"));
    }
    if other > 0 {
        bits.push(format!("{other} attachment(s)"));
    }
    let note = format!(
        "[earlier attachments elided: {} — bytes discarded]",
        bits.join(", ")
    );
    if rec.content.is_empty() {
        rec.content = note;
    } else {
        rec.content = format!("{}\n\n{note}", rec.content);
    }
    rec.attachments.clear();
}

/// Apply redaction to a snapshot of records before they're handed to
/// `record_to_llm`. The rule: the LAST `Tool` role record stays
/// intact (the most recent tool output that the model is about to
/// reason over); every older Tool record gets its large base64 fields
/// elided. The LAST user record's attachments stay intact; everything
/// older has its attachments stripped to a stub line.
///
/// Applied OUTSIDE `compact_conversation_inline` — this keeps the
/// happy-path request small without changing the canonical
/// conversation that the FAB renders. The transcript ring keeps the
/// originals; only the wire-format payload is slimmed down.
fn redact_records_for_llm(records: &mut [AgentMessageRecord]) {
    // 24kB threshold matches the 'one screen of base64' break-even —
    // smaller payloads cost almost nothing to keep; larger ones blow
    // the budget after a handful of round trips.
    const B64_MAX_CHARS: usize = 24 * 1024;
    // Find indices we should NOT redact.
    let last_tool_idx = records
        .iter()
        .rposition(|r| matches!(r.role, AgentRole::Tool));
    let last_user_idx = records
        .iter()
        .rposition(|r| matches!(r.role, AgentRole::User));
    for (idx, rec) in records.iter_mut().enumerate() {
        match rec.role {
            AgentRole::Tool => {
                if Some(idx) == last_tool_idx {
                    continue;
                }
                rec.content = redact_tool_result_content(&rec.content, B64_MAX_CHARS);
            }
            AgentRole::User | AgentRole::Assistant | AgentRole::System => {
                // Old attachments are no longer needed after the next
                // user turn — strip from anything older than the most
                // recent user record.
                if let Some(last) = last_user_idx {
                    if idx < last {
                        strip_record_attachments(rec);
                    }
                } else {
                    strip_record_attachments(rec);
                }
                // Also redact embedded base64 inside assistant
                // content (rare, but tools sometimes echo the data
                // URL in their preview text).
                if rec.content.len() > B64_MAX_CHARS {
                    let mut v = Value::String(std::mem::take(&mut rec.content));
                    redact_large_b64_in_value(&mut v, B64_MAX_CHARS);
                    rec.content = v.as_str().map(|s| s.to_string()).unwrap_or_default();
                }
            }
        }
    }
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
