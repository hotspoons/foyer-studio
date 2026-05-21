// SPDX-License-Identifier: Apache-2.0
//! AI agent schema — message shapes, tool-call records, autonomy modes,
//! and filesystem-backed skill/memory/template descriptors.
//!
//! The agent harness itself lives in `foyer-agent` and is Rust-first so
//! it can be projected to any UI (browser, TUI, headless CLI) — the
//! schema here is just the wire vocabulary that lets a thin client
//! render the conversation, surface tool calls, and manage the
//! filesystem-backed skill / memory / template stores under
//! `$XDG_DATA_HOME/foyer/agent/`.
//!
//! Wire framing follows the same `Event` / `Command` envelope shape
//! as the rest of the control plane — see [`crate::message`]. Per
//! DECISION 7 the in-browser agent FAB plumbs through the same WS
//! every other event uses; per the wishlist in `docs/TODO.md`, the
//! Rust core treats every LLM transport (Anthropic, OpenAI,
//! OpenRouter, local Ollama, in-browser WebLLM via the zip-ties
//! bridge) as a uniform OpenAI-compatible HTTP endpoint.
//!
//! Tools are deliberately POLYMORPHIC — one tool per domain (transport,
//! mixer, tracks, regions, automation, plugins, midi, session,
//! visualize) with a `subcommand` discriminator inside the arg blob.
//! Keeps the tool surface small and stable as Foyer grows; full
//! rationale in DECISION ?? once it lands.

use serde::{Deserialize, Serialize};

// ─── Role / autonomy taxonomy ────────────────────────────────────────

/// Who said it. Mirrors the OpenAI chat-completions role names so we
/// can round-trip transcripts straight to / from the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    /// The injected system prompt (skills, persona, session context).
    /// Usually invisible to the UI; surfaced behind a Debug toggle.
    System,
    /// The human typing in the FAB (or a TUI / external trigger).
    User,
    /// The LLM's reply text.
    Assistant,
    /// A tool's structured result, fed back into the model on the
    /// next turn. Rendered as a collapsible card in the FAB.
    Tool,
}

/// How much rope the user has handed the agent on this session.
/// Two modes — `Ask` pauses for confirmation on destructive tool
/// calls; `Auto` runs everything. Persisted server-side; the user
/// flips it via the settings modal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentAutonomy {
    /// Destructive tools (delete, replace, clear) emit an
    /// `AgentToolCall { status: AwaitingConfirm }` and pause until
    /// the user clicks Approve / Reject. Non-destructive tools run.
    #[default]
    Ask,
    /// All tool calls run. Ardour's undo stack is the safety net.
    Auto,
}

/// Lifecycle of one tool invocation, observed by the UI as a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentToolStatus {
    /// Model emitted the call but the harness hasn't dispatched yet
    /// (only briefly visible — usually transitions to Running or
    /// AwaitingConfirm within the same tick).
    Pending,
    /// Safe mode + destructive tool — UI shows Approve / Reject.
    AwaitingConfirm,
    /// User rejected (or autonomy gate denied). Terminal.
    Rejected,
    /// Tool is executing. Tool may emit progress events keyed on
    /// `call_id` while in this state.
    Running,
    /// Tool finished cleanly; result is on the matching `AgentToolResult`.
    Done,
    /// Tool errored; the message is on the matching `AgentToolResult`.
    Error,
}

// ─── Wire records ────────────────────────────────────────────────────

/// One turn in the transcript. `tool_calls` is populated when the
/// assistant invoked tools in this turn; `tool_call_id` is set when
/// this record is a tool reply (so the UI can match cards to their
/// origin turn).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentMessageRecord {
    /// Monotonically-assigned id (per-server). Lets clients dedupe and
    /// sort cheaply even when streaming chunks arrive out of order.
    pub id: u64,
    pub role: AgentRole,
    /// Markdown body. May be empty when the assistant emitted only
    /// tool calls (no narrative text on this turn).
    #[serde(default)]
    pub content: String,
    /// Tool calls emitted by the assistant on this turn (assistant
    /// role only). Empty otherwise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<AgentToolCallRecord>,
    /// When `role == Tool`, the call this is a reply to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Inline media attached to a user-role message (image paste / drop)
    /// for vision-capable models. Empty for other roles.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AgentAttachment>,
    /// Unix epoch milliseconds of server-side receipt.
    pub ts_ms: u64,
    /// Marks records the agent harness synthesizes for the LLM's
    /// own consumption — currently the introspective-vision context
    /// record (`Some("tool_vision_context")`) pushed after a media-
    /// producing tool call. These ride on the LLM wire as normal
    /// `user`-role multimodal messages (so the vision tower fires)
    /// but the FAB transcript and the OpenAI-proxy egress hide them
    /// so they don't masquerade as something the human typed.
    /// `None` (the default) on every record the user actually sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synthetic: Option<String>,
}

/// One inline media file attached to a user-role message. The bytes
/// are carried base64-encoded so the existing JSON-over-WS transport
/// doesn't need a binary side-channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentAttachment {
    /// Display name shown in the FAB chip and in tool traces. Not
    /// trusted for filesystem use — just for the user's eyeballs.
    pub name: String,
    /// MIME type (`image/png`, `image/jpeg`, …). Drives whether the
    /// engine maps this attachment to an OpenAI `image_url` content
    /// block; non-image types travel along in the record but are not
    /// forwarded to the LLM today.
    pub mime: String,
    /// Base64-encoded payload (standard, no data: prefix).
    pub b64: String,
}

/// One tool invocation as the model proposed it, paired with the
/// harness's view of where it is in the lifecycle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentToolCallRecord {
    /// Server-assigned id, surfaced to the LLM as the `tool_call_id`
    /// it'll quote on its tool-reply turn.
    pub call_id: String,
    /// Polymorphic tool name — `transport`, `mixer`, `visualize`, etc.
    pub tool_name: String,
    /// JSON-encoded args blob as the model emitted it. The harness
    /// parses + validates against the tool's schema before dispatch.
    pub args_json: String,
    pub status: AgentToolStatus,
    /// Optional human-readable preview shown in the UI card while
    /// the tool is `AwaitingConfirm` or `Running`. Markdown allowed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// Structured tool result, JSON-encoded. Populated by the harness
    /// once the call transitions to `Done` / `Error`. Persisted with
    /// the assistant record so a session reload restores the full
    /// card content (status + args + result) without having to chase
    /// the matching `Tool`-role reply.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub result_json: String,
}

// ─── Filesystem-backed stores ────────────────────────────────────────
//
// Skills / memory / templates all live under
// `$XDG_DATA_HOME/foyer/agent/{skills,memory,templates}/` as plain
// `.md` files (with optional YAML frontmatter for metadata). The Rust
// side scans the dirs at session start, injects skills into the
// system prompt, and exposes memory + templates as tools the agent
// can read / write.

/// One discoverable skill — a markdown file the user wrote (or the
/// agent saved) that teaches the model a task / persona / shortcut.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentSkillInfo {
    /// Filename stem (no `.md`). Stable id for enable / disable /
    /// load operations.
    pub name: String,
    /// First paragraph of the markdown body (or `description:` from
    /// frontmatter when present) — for the picker UI.
    pub summary: String,
    /// Approximate token count of the full body — surfaced so a user
    /// can keep their always-on skill budget under control.
    pub tokens_approx: u32,
    /// `true` when the user has enabled this skill in the current
    /// session (injected into the system prompt). Defaults to whatever
    /// is in `enabled:` frontmatter, else `false`.
    pub enabled: bool,
}

/// One memory snippet — short markdown blob the agent has saved with
/// the `memory.save` tool, or the user dropped into the memory dir
/// by hand. All memories are concatenated and injected at session
/// start.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentMemoryInfo {
    pub name: String,
    /// Full markdown body (memories are short — full body fits).
    pub body: String,
    /// Unix epoch millis when the file was last modified.
    pub modified_ms: u64,
}

/// One project template — saved Foyer session bundle the agent (or
/// the user) can spawn into a fresh session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentTemplateInfo {
    pub name: String,
    pub summary: String,
    /// Source path (jail-relative) so the picker can preview / open.
    pub path: String,
}

// ─── Live config snapshot ────────────────────────────────────────────

/// One stored chat session. Persisted under
/// `$XDG_DATA_HOME/foyer/agent/sessions/<id>.jsonl` (one
/// `AgentMessageRecord` per line); the sibling `index.json` carries
/// the metadata list + the active session pointer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentSessionInfo {
    pub id: String,
    pub title: String,
    pub created_ms: u64,
    pub updated_ms: u64,
    pub message_count: u32,
}

/// Public-facing view of the agent's current config — broadcast on
/// connect + on every mutation. API keys are NEVER on the wire; the
/// server keeps them in its in-memory state and writes them to the
/// user-local config file (sibling of `config.yaml`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentConfigPublic {
    /// OpenAI-compatible base URL (`https://api.anthropic.com/v1`,
    /// `https://api.openai.com/v1`, `http://127.0.0.1:11434/v1` for
    /// Ollama, `http://127.0.0.1:$PORT/llm/v1` for the WebLLM
    /// bridge).
    pub endpoint: String,
    /// Model name (`claude-sonnet-4-6`, `gpt-4o`, `llama3.2:3b`, etc.).
    pub model: String,
    /// `true` when an API key is set in the server's config — the
    /// value itself is never sent.
    pub has_api_key: bool,
    pub autonomy: AgentAutonomy,
}
