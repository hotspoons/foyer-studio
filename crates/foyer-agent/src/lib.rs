// SPDX-License-Identifier: Apache-2.0
//! AI agent harness for Foyer Studio.
//!
//! Rust-first: every interaction surface (browser FAB, TUI, headless
//! CLI, MCP-over-HTTP for external Claude) is a thin client over the
//! same `AgentRuntime`. The harness owns:
//!
//!   * Conversation state (transcript ring + streaming reassembly).
//!   * LLM transport — uniform OpenAI-compatible HTTP behind
//!     [`LlmClient`], whether the endpoint is Anthropic, OpenAI,
//!     OpenRouter, local Ollama, or the in-browser WebLLM bridge.
//!   * Tool registry + dispatch with polymorphic subcommand-shaped
//!     tools (`transport`, `mixer`, `tracks`, ...).
//!   * Filesystem-backed skills / memory / templates under
//!     `$XDG_DATA_HOME/foyer/agent/`.
//!   * Autonomy gate (`ask` / `auto`) for destructive tool calls.
//!
//! Per the wishlist in `docs/TODO.md`: the same tool registry is
//! exposed externally via `foyer-mcp` (stdio / Unix socket /
//! streamable HTTP) so external agents like Claude Code can drive
//! Foyer through MCP. Tools dispatch directly into `AppState` for the
//! in-process agent — no IPC overhead when the harness is local.

#![forbid(unsafe_code)]

pub mod config;
pub mod conversation;
pub mod engine;
pub mod llm;
pub mod mcp_proxy;
pub mod openai_proxy;
pub mod runtime;
pub mod store;
pub mod tools;

pub use config::AgentConfig;
pub use conversation::Conversation;
pub use engine::AgentEngine;
pub use llm::{LlmClient, LlmMessage, LlmRequest, LlmResponse, LlmStreamChunk, OpenAiHttpClient};
pub use openai_proxy::{run_external_chat, ExternalChatRequest, ExternalChatStreamEvent};
pub use runtime::{AgentEvent, AgentRuntime, ExternalEngineParts};
pub use store::AgentStore;
pub use tools::{Tool, ToolContext, ToolError, ToolRegistry, ToolResult};
