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
        let record = AgentMessageRecord {
            id: self.alloc_id(),
            role,
            content,
            tool_calls,
            tool_call_id,
            attachments,
            ts_ms: now_ms(),
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
