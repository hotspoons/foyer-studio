// SPDX-License-Identifier: Apache-2.0
//! Model Context Protocol bridge for Foyer Studio.
//!
//! Wraps the live `foyer-agent::tools::ToolRegistry` as an MCP server
//! using the official [`rmcp`] SDK. Only ever invoked from external
//! clients (Claude Code, Codex, etc.) — the in-process agent keeps
//! calling the registry directly with zero MCP ceremony in its prompt
//! or transcript.
//!
//! Wire it up by mounting [`mcp_router`] into the foyer-server's
//! axum app; the streamable-HTTP transport handles all protocol
//! framing (initialize / tools/list / tools/call / cancellation /
//! progress) inside rmcp.

#![forbid(unsafe_code)]

mod server;

pub use server::{mcp_router, FoyerMcpServer};
