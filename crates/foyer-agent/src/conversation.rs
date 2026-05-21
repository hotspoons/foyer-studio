// SPDX-License-Identifier: Apache-2.0
//! Transcript ring + id allocator.

use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

use foyer_schema::agent::{AgentMessageRecord, AgentRole, AgentToolCallRecord, AgentToolStatus};

/// Hard cap on transcript ring. Roughly the largest context we'd want
/// to round-trip on a model switch. Older messages drop off the head.
pub const TRANSCRIPT_RING_CAP: usize = 256;

pub struct Conversation {
    records: VecDeque<AgentMessageRecord>,
    next_id: u64,
}

impl Default for Conversation {
    fn default() -> Self {
        Self {
            records: VecDeque::with_capacity(TRANSCRIPT_RING_CAP),
            next_id: 1,
        }
    }
}

impl Conversation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn records(&self) -> impl DoubleEndedIterator<Item = &AgentMessageRecord> {
        self.records.iter()
    }

    pub fn records_mut(&mut self) -> impl DoubleEndedIterator<Item = &mut AgentMessageRecord> {
        self.records.iter_mut()
    }

    /// Import a pre-existing record (e.g. when reloading a session
    /// from JSONL). Bumps `next_id` past the imported one. If a record
    /// with the same id already exists (older JSONLs may have written
    /// the same record twice — empty initial push + populated re-emit
    /// after `attach_tool_calls`), this OVERWRITES that slot in place
    /// instead of producing a duplicate row.
    pub fn import_record(&mut self, record: AgentMessageRecord) {
        if record.id >= self.next_id {
            self.next_id = record.id + 1;
        }
        if let Some(existing) = self.records.iter_mut().find(|r| r.id == record.id) {
            *existing = record;
            return;
        }
        if self.records.len() >= TRANSCRIPT_RING_CAP {
            self.records.pop_front();
        }
        self.records.push_back(record);
    }

    pub fn snapshot(&self) -> Vec<AgentMessageRecord> {
        self.records.iter().cloned().collect()
    }

    pub fn clear(&mut self) {
        self.records.clear();
    }

    fn alloc_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    pub fn push_user(&mut self, content: String) -> AgentMessageRecord {
        self.push(AgentRole::User, content, vec![], None, vec![])
    }

    pub fn push_user_with_attachments(
        &mut self,
        content: String,
        attachments: Vec<foyer_schema::agent::AgentAttachment>,
    ) -> AgentMessageRecord {
        self.push(AgentRole::User, content, vec![], None, attachments)
    }

    /// Push a synthetic user-role record carrying media a tool just
    /// produced (visualizer PNG, render mixdown, …). Used right after
    /// `push_tool_result` so the next LLM round sees the bytes through
    /// the existing user-attachment → multi-modal-content-block path
    /// (`engine::record_to_llm`). Without this loop the VLM's vision
    /// tower never fires on its own renders — the bytes sit in the
    /// tool record as opaque base64 the model can't actually read.
    ///
    /// `media_ids` are the short ids the engine stamped on each
    /// attachment (parallel to `attachments`). They're embedded in
    /// the content text so the model learns the recall handles —
    /// after this turn the bytes will be redacted from older user
    /// records to keep vLLM's prefix cache stable, but a
    /// `media(subcommand="get", id="i3")` call can always pull them
    /// back. Pass an empty slice when the caller doesn't have IDs
    /// (test paths, library-less dispatch); the content text just
    /// omits the recall hint then.
    pub fn push_tool_vision_context(
        &mut self,
        tool_name: &str,
        attachments: Vec<foyer_schema::agent::AgentAttachment>,
        media_ids: &[String],
    ) -> AgentMessageRecord {
        let kinds = attachment_kinds(&attachments);
        let label = if tool_name.is_empty() {
            "tool".to_string()
        } else {
            tool_name.to_string()
        };
        let recall_hint = if media_ids.is_empty() {
            String::new()
        } else {
            let joined = media_ids.join(", ");
            let example = &media_ids[0];
            format!(
                " Stamped media id(s): {joined}. If you need to \
                 re-examine these later in the conversation (after \
                 they've scrolled out of the rolling context), call \
                 media(subcommand=\"get\", id=\"{example}\") to pull \
                 the bytes back into context."
            )
        };
        let content = format!(
            "[Tool vision context: {label} produced {kinds}. \
             Use the attached media to reason about the next step — \
             this is the rendered output of the just-completed tool \
             call, not a fresh user upload.{recall_hint}]"
        );
        // role=User so the LLM's vision encoder fires on the attached
        // image/audio blocks (multimodal OpenAI shape lands on user
        // turns), but `synthetic=Some("tool_vision_context")` tells
        // the FAB and any extension-aware client this is harness-
        // generated context, not something the human typed. The FAB
        // hides these rows; the OpenAI-proxy egress doesn't echo
        // them; clients that round-trip the field can render them
        // as a system note (or not at all) per their own UX.
        self.push_with_synthetic(
            AgentRole::User,
            content,
            vec![],
            None,
            attachments,
            Some("tool_vision_context".to_string()),
        )
    }

    pub fn push_system(&mut self, content: String) -> AgentMessageRecord {
        self.push(AgentRole::System, content, vec![], None, vec![])
    }

    pub fn push_assistant(
        &mut self,
        content: String,
        tool_calls: Vec<AgentToolCallRecord>,
    ) -> AgentMessageRecord {
        self.push(AgentRole::Assistant, content, tool_calls, None, vec![])
    }

    pub fn push_tool_result(
        &mut self,
        tool_call_id: String,
        content: String,
    ) -> AgentMessageRecord {
        self.push(AgentRole::Tool, content, vec![], Some(tool_call_id), vec![])
    }

    fn push(
        &mut self,
        role: AgentRole,
        content: String,
        tool_calls: Vec<AgentToolCallRecord>,
        tool_call_id: Option<String>,
        attachments: Vec<foyer_schema::agent::AgentAttachment>,
    ) -> AgentMessageRecord {
        self.push_with_synthetic(role, content, tool_calls, tool_call_id, attachments, None)
    }

    fn push_with_synthetic(
        &mut self,
        role: AgentRole,
        content: String,
        tool_calls: Vec<AgentToolCallRecord>,
        tool_call_id: Option<String>,
        attachments: Vec<foyer_schema::agent::AgentAttachment>,
        synthetic: Option<String>,
    ) -> AgentMessageRecord {
        let record = AgentMessageRecord {
            id: self.alloc_id(),
            role,
            content,
            tool_calls,
            tool_call_id,
            attachments,
            ts_ms: now_ms(),
            synthetic,
        };
        if self.records.len() >= TRANSCRIPT_RING_CAP {
            self.records.pop_front();
        }
        self.records.push_back(record.clone());
        record
    }

    /// In-place update of a tool call's status on an existing
    /// assistant record. Used when a call transitions through
    /// pending → awaiting_confirm → running → done.
    pub fn update_tool_status(
        &mut self,
        message_id: u64,
        call_id: &str,
        status: AgentToolStatus,
        preview: Option<String>,
        result_json: Option<&str>,
    ) -> bool {
        for r in self.records.iter_mut().rev() {
            if r.id != message_id {
                continue;
            }
            for call in r.tool_calls.iter_mut() {
                if call.call_id == call_id {
                    call.status = status;
                    if preview.is_some() {
                        call.preview = preview;
                    }
                    if let Some(rj) = result_json {
                        if !rj.is_empty() {
                            call.result_json = rj.to_string();
                        }
                    }
                    return true;
                }
            }
            return false;
        }
        false
    }

    /// Take a clone of a record by id, used by the runtime when it
    /// wants to re-enqueue the latest state for persistence.
    pub fn record_by_id(&self, id: u64) -> Option<AgentMessageRecord> {
        self.records.iter().rev().find(|r| r.id == id).cloned()
    }

    /// Append a token delta to the most recent assistant record's
    /// content. Returns the updated record id, or `None` if the tail
    /// isn't an assistant record (caller should have created one
    /// first via `push_assistant`).
    pub fn append_assistant_token(&mut self, delta: &str) -> Option<u64> {
        let tail = self.records.back_mut()?;
        if tail.role != AgentRole::Assistant {
            return None;
        }
        tail.content.push_str(delta);
        Some(tail.id)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn attachment_kinds(attachments: &[foyer_schema::agent::AgentAttachment]) -> String {
    let mut images = 0usize;
    let mut audio = 0usize;
    let mut other = 0usize;
    for a in attachments {
        if a.mime.starts_with("image/") {
            images += 1;
        } else if a.mime.starts_with("audio/") {
            audio += 1;
        } else {
            other += 1;
        }
    }
    let mut parts: Vec<String> = Vec::new();
    if images == 1 {
        parts.push("1 image".into());
    } else if images > 1 {
        parts.push(format!("{images} images"));
    }
    if audio == 1 {
        parts.push("1 audio clip".into());
    } else if audio > 1 {
        parts.push(format!("{audio} audio clips"));
    }
    if other == 1 {
        parts.push("1 attachment".into());
    } else if other > 1 {
        parts.push(format!("{other} attachments"));
    }
    if parts.is_empty() {
        "media".into()
    } else {
        parts.join(" + ")
    }
}
