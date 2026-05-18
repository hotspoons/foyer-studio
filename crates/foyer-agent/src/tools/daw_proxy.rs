// SPDX-License-Identifier: Apache-2.0
//! `daw_proxy` — single-tool window onto a backend DAW's MCP server.
//!
//! Foyer's high-level tools cover the everyday DAW workflow. Backend
//! DAWs (Ardour, eventually Reaper / Bitwig / etc.) ship their own
//! native MCP servers with much wider tool surfaces — Ardour's
//! `mcp_http` alone advertises ~70+ tools. Registering each upstream
//! tool as its own Foyer tool would blow the agent's prompt budget
//! and overwhelm context with overlapping vocabulary (we already do
//! "save the session"; Ardour does it too).
//!
//! Instead, `daw_proxy` is ONE Foyer tool that lets the agent:
//!
//!   1. `list_backends` — see which DAW MCP endpoints Foyer knows about.
//!   2. `discover(backend?)` — cache the upstream's tool catalog at
//!      its current version. Persisted under
//!      `$XDG_DATA_HOME/foyer/mcp-proxy-cache/<id>-<version>.json` so
//!      repeat runs skip the round-trip.
//!   3. `list_tools(backend?, filter?)` — terse one-line-per-tool view
//!      (name + title + first 120 chars of description). The agent
//!      browses this without loading any schemas.
//!   4. `get_tool_details(backend?, names: [...])` — the full MCP
//!      tool definitions for the specific upstream tools the agent
//!      has decided to use. Pulled from cache; no upstream round trip.
//!   5. `call(backend?, name, args)` — proxy a tools/call to the
//!      upstream and forward its result.
//!
//! When the user asks for something Foyer covers natively (transport,
//! tracks, regions, MIDI authoring), the agent uses Foyer's own
//! tools. When the user needs something only the backend DAW knows
//! how to do (mixer scenes, marker ranges, native session features),
//! the agent reaches in through this proxy without bloating the
//! permanent tool surface.

use async_trait::async_trait;
use foyer_config::McpProxyConfig;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::mcp_proxy::{self, ProxyError};
use crate::tools::{McpProxyEntry, Tool, ToolContext, ToolError, ToolResult};

pub struct DawProxyTool {
    /// Boot-time fallback list — used only when the ToolContext has no
    /// `session_director` (test paths, in-process dispatchers). In
    /// production the director's `list_mcp_proxies` returns this list
    /// PLUS per-session entries from live `Session.mcp_endpoint` —
    /// the same Ardour instance shows up once per open session with
    /// its dedicated MCPHttp port.
    backends: Vec<McpProxyConfig>,
}

impl DawProxyTool {
    pub fn new(backends: Vec<McpProxyConfig>) -> Self {
        Self { backends }
    }

    async fn live_backends(&self, ctx: &ToolContext) -> Vec<McpProxyEntry> {
        // Director-backed path: production. Merges static config with
        // live `Session.mcp_endpoint` entries so each open Ardour
        // shows up under its session-specific port.
        if let Some(dir) = ctx.session_director.as_ref() {
            if let Ok(rows) = dir.list_mcp_proxies().await {
                return rows;
            }
        }
        // Fallback for thin dispatch paths (tests, MCP without a
        // session director attached). Static config only — no live
        // per-session entries.
        self.backends
            .iter()
            .map(|cfg| McpProxyEntry {
                id: cfg.id.clone(),
                label: cfg.label.clone().unwrap_or_else(|| cfg.id.clone()),
                endpoint: cfg.endpoint.clone(),
                enabled: cfg.enabled,
                source: "config",
                api_key: std::env::var(format!(
                    "FOYER_MCP_PROXY_{}_API_KEY",
                    cfg.id.to_uppercase()
                ))
                .ok()
                .or_else(|| cfg.api_key.clone()),
            })
            .collect()
    }

    async fn resolve_backend(
        &self,
        ctx: &ToolContext,
        id: Option<&str>,
    ) -> Result<McpProxyEntry, ToolError> {
        let backends = self.live_backends(ctx).await;
        let enabled: Vec<&McpProxyEntry> = backends.iter().filter(|b| b.enabled).collect();
        match id {
            Some(want) => backends
                .iter()
                .find(|b| b.id == want)
                .cloned()
                .ok_or_else(|| {
                    ToolError::InvalidArgs(format!(
                        "unknown DAW MCP backend `{want}` — try `list_backends` to see live ids"
                    ))
                }),
            None => {
                if enabled.len() == 1 {
                    Ok(enabled[0].clone())
                } else if enabled.is_empty() {
                    Err(ToolError::Execution(
                        "no DAW MCP backends available — no open session reported an mcp_endpoint and \
                         `mcp_proxies:` in config.yaml is empty/disabled"
                            .into(),
                    ))
                } else {
                    let ids: Vec<&str> = enabled.iter().map(|b| b.id.as_str()).collect();
                    Err(ToolError::InvalidArgs(format!(
                        "multiple DAW MCP backends available ({}) — pass `backend` to pick one",
                        ids.join(", ")
                    )))
                }
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    /// List configured upstream MCP backends. Useful first call when
    /// the agent doesn't yet know what's available.
    ListBackends,
    /// Connect to the upstream, walk `tools/list`, and cache the
    /// result under the upstream's reported version. `force=true`
    /// bypasses any existing cache; otherwise a fresh discovery only
    /// happens when the server version moves.
    Discover {
        #[serde(default)]
        backend: Option<String>,
        #[serde(default)]
        force: bool,
    },
    /// Terse one-line-per-tool view. Pulls from the cache (calls
    /// `discover` lazily if no cache exists). Optional `filter` does
    /// case-insensitive substring matching on tool name + title.
    ListTools {
        #[serde(default)]
        backend: Option<String>,
        #[serde(default)]
        filter: Option<String>,
    },
    /// Full MCP tool schemas for a specific subset, so the agent can
    /// build a valid `arguments` object before calling. Returns 404-
    /// style stubs for unknown names so a typo doesn't fail the batch.
    GetToolDetails {
        #[serde(default)]
        backend: Option<String>,
        names: Vec<String>,
    },
    /// Invoke an upstream tool through the proxy. `name` matches the
    /// upstream's exact tool name (use `list_tools` to confirm
    /// canonical spelling). `args` is forwarded verbatim.
    Call {
        #[serde(default)]
        backend: Option<String>,
        name: String,
        #[serde(default)]
        args: Value,
    },
}

#[async_trait]
impl Tool for DawProxyTool {
    fn name(&self) -> &'static str {
        "daw_proxy"
    }

    fn description(&self) -> &'static str {
        "Reach into the backend DAW's own MCP surface (e.g. Ardour's \
         mcp_http) without loading every upstream tool's schema into \
         your prompt. Subcommands: \
         list_backends — show configured upstream MCP endpoints; \
         discover(backend?, force?) — cache the upstream's tool catalog \
         at its current version (idempotent — re-runs the cheap \
         tools/list call when version changes); \
         list_tools(backend?, filter?) — terse `name · title · brief` \
         per upstream tool (pull from cache, no schemas); \
         get_tool_details(backend?, names:[…]) — full MCP schemas for \
         specific upstream tools so you can build valid `arguments`; \
         call(backend?, name, args) — proxy a tools/call to the \
         upstream and return its result. \
         Use Foyer's own tools (transport, tracks, regions, midi, …) \
         for the everyday workflow; reach into this proxy only when \
         you need something Foyer doesn't cover natively (markers, \
         mixer scenes, native session features)."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": { "type": "string",
                    "enum": ["list_backends", "discover", "list_tools",
                            "get_tool_details", "call"] },
                "backend": { "type": "string",
                    "description": "Backend id (e.g. \"ardour\"). Optional when only one backend is configured." },
                "force": { "type": "boolean",
                    "description": "discover: bypass the cache even if the upstream's version is unchanged." },
                "filter": { "type": "string",
                    "description": "list_tools: case-insensitive substring filter on tool name + title." },
                "names": { "type": "array", "items": { "type": "string" },
                    "description": "get_tool_details: tool names to expand schemas for." },
                "name": { "type": "string",
                    "description": "call: upstream tool name (exact, as reported by list_tools)." },
                "args": {
                    "description": "call: arguments object forwarded verbatim to the upstream tool. Match the schema returned by get_tool_details."
                }
            }
        })
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        match op {
            Op::ListBackends => {
                let live = self.live_backends(ctx).await;
                let rows: Vec<Value> = live
                    .iter()
                    .map(|b| {
                        json!({
                            "id": b.id,
                            "label": b.label,
                            "endpoint": b.endpoint,
                            "enabled": b.enabled,
                            // "session" for entries derived from a live
                            // open Ardour (per-session MCP port);
                            // "config" for static `mcp_proxies:` entries.
                            "source": b.source,
                        })
                    })
                    .collect();
                let count = rows.len();
                let enabled = rows.iter().filter(|b| b["enabled"] == json!(true)).count();
                let summary = if count == 0 {
                    "no DAW MCP backends available (no open session reports an mcp_endpoint, \
                     and `mcp_proxies:` in config.yaml is empty) — this tool is a no-op until \
                     an MCP-capable session opens"
                        .to_string()
                } else {
                    format!("{count} DAW MCP backend(s) available ({enabled} enabled)")
                };
                Ok(ToolResult::ok(summary).with_data(json!({ "backends": rows })))
            }
            Op::Discover { backend, force } => {
                let cfg = self.resolve_backend(ctx, backend.as_deref()).await?;
                let cat = mcp_proxy::discover(&cfg, force)
                    .await
                    .map_err(into_tool_err)?;
                Ok(ToolResult::ok(format!(
                    "discovered {} v{}: {} tools (cached)",
                    cat.server_name,
                    cat.server_version,
                    cat.tools.len()
                ))
                .with_data(json!({
                    "backend": cat.backend_id,
                    "server_name": cat.server_name,
                    "server_version": cat.server_version,
                    "instructions": cat.instructions,
                    "tool_count": cat.tools.len(),
                    "discovered_at_unix": cat.discovered_at_unix,
                })))
            }
            Op::ListTools { backend, filter } => {
                let cfg = self.resolve_backend(ctx, backend.as_deref()).await?;
                let cat = mcp_proxy::discover(&cfg, false)
                    .await
                    .map_err(into_tool_err)?;
                let needle = filter.as_deref().map(str::to_lowercase);
                let mut rows: Vec<Value> = Vec::new();
                for t in &cat.tools {
                    let title = t.title.clone().unwrap_or_else(|| t.name.clone());
                    let desc = t
                        .description
                        .as_deref()
                        .map(brief_summary)
                        .unwrap_or_default();
                    if let Some(needle) = &needle {
                        let hay = format!("{} {}", t.name.to_lowercase(), title.to_lowercase());
                        if !hay.contains(needle) {
                            continue;
                        }
                    }
                    rows.push(json!({
                        "name": t.name,
                        "title": title,
                        "brief": desc,
                    }));
                }
                let summary = match (filter.as_ref(), rows.len()) {
                    (Some(f), n) => format!(
                        "{}: {} tool(s) matching `{}` (of {} total)",
                        cat.server_name,
                        n,
                        f,
                        cat.tools.len()
                    ),
                    (None, n) => format!("{}: {} tool(s) available", cat.server_name, n),
                };
                Ok(ToolResult::ok(summary).with_data(json!({
                    "backend": cat.backend_id,
                    "server_version": cat.server_version,
                    "tools": rows,
                    "next_step": "Call `get_tool_details` with a list of names to see input schemas, then `call` to invoke."
                })))
            }
            Op::GetToolDetails { backend, names } => {
                let cfg = self.resolve_backend(ctx, backend.as_deref()).await?;
                let cat = mcp_proxy::discover(&cfg, false)
                    .await
                    .map_err(into_tool_err)?;
                let mut details: Vec<Value> = Vec::with_capacity(names.len());
                for want in &names {
                    match cat.tools.iter().find(|t| &t.name == want) {
                        Some(t) => {
                            details.push(json!({
                                "name": t.name,
                                "title": t.title.clone().unwrap_or_else(|| t.name.clone()),
                                "description": t.description,
                                "input_schema": t.input_schema,
                            }));
                        }
                        None => {
                            // Be forgiving so the agent gets useful
                            // feedback on the typo without losing
                            // the rest of the batch.
                            details.push(json!({
                                "name": want,
                                "error": format!(
                                    "no upstream tool named `{want}` — try `list_tools` to see available names"
                                ),
                            }));
                        }
                    }
                }
                Ok(
                    ToolResult::ok(format!("{} tool detail entries", details.len()))
                        .with_data(json!({ "details": details })),
                )
            }
            Op::Call {
                backend,
                name,
                args,
            } => {
                let cfg = self.resolve_backend(ctx, backend.as_deref()).await?;
                let client = mcp_proxy::client_for(&cfg);
                // Always run the handshake before a call — the upstream
                // may have restarted since the cache was written, in
                // which case its session-id state is fresh.
                client.initialize().await.map_err(into_tool_err)?;
                let result = client.call_tool(&name, args).await.map_err(into_tool_err)?;
                let is_error = result
                    .get("isError")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let mut content_texts: Vec<String> = Vec::new();
                if let Some(arr) = result.get("content").and_then(|v| v.as_array()) {
                    for c in arr {
                        if let Some(t) = c.get("text").and_then(|v| v.as_str()) {
                            content_texts.push(t.to_string());
                        }
                    }
                }
                let summary = if is_error {
                    format!("{name}: upstream error · {}", content_texts.join(" | "))
                } else {
                    let head = content_texts
                        .first()
                        .map(|s| brief_summary(s))
                        .unwrap_or_else(|| format!("{name}: ok"));
                    head
                };
                Ok(ToolResult::ok(summary).with_data(result))
            }
        }
    }
}

/// Truncate descriptions to a fixed-ish budget so `list_tools` stays
/// scannable. Cuts on a word boundary when one is reachable, falls
/// back to a hard slice otherwise. Marker is `…` so the agent
/// recognises "this was truncated, fetch details for the full text."
fn brief_summary(s: &str) -> String {
    const MAX: usize = 120;
    let one_line: String = s
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if one_line.len() <= MAX {
        return one_line;
    }
    let cut = one_line
        .char_indices()
        .take_while(|(i, _)| *i <= MAX)
        .last()
        .map(|(i, _)| i)
        .unwrap_or(MAX);
    let mut out = one_line[..cut].to_string();
    if let Some(sp) = out.rfind(' ') {
        if sp > MAX / 2 {
            out.truncate(sp);
        }
    }
    out.push('…');
    out
}

fn into_tool_err(e: ProxyError) -> ToolError {
    match e {
        ProxyError::UnknownBackend(_) | ProxyError::Disabled(_) => {
            ToolError::InvalidArgs(e.to_string())
        }
        _ => ToolError::Execution(e.to_string()),
    }
}
