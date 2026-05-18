// SPDX-License-Identifier: Apache-2.0
//! `rmcp` server that re-exports Foyer's `foyer-agent::tools::ToolRegistry`
//! over the Model Context Protocol.
//!
//! Architecture: one `ServerHandler` impl, `FoyerMcpServer`, forwards
//! every `tools/list` and `tools/call` request to the live runtime's
//! registry. The Foyer tool definitions are NOT decorated with rmcp
//! `#[tool]` macros — keeping them rmcp-agnostic means the in-process
//! agent (and Rust unit tests) never pull in MCP types or surface
//! MCP-style schemas. External MCP clients only see this bridge.
//!
//! Mount via [`mcp_router`] into the foyer-server axum app. The
//! streamable-HTTP transport (rmcp's `StreamableHttpService`) handles
//! the protocol framing — `POST /mcp` is the initialize / call entry
//! point, `GET /mcp` upgrades to SSE for streaming notifications.

use std::borrow::Cow;
use std::sync::Arc;

use axum::Router;
use foyer_agent::tools::{ToolContext, ToolError};
use foyer_agent::AgentRuntime;
use foyer_backend::Backend;
use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CallToolRequestParams, CallToolResult, Content, ErrorData as McpError, Implementation,
    InitializeRequestParams, InitializeResult, JsonObject, ListToolsResult, Meta,
    PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::RoleServer;

/// Shared state for the MCP bridge. One per server. Cloned cheaply
/// into each request-scoped `ServerHandler` instance the streamable-
/// HTTP transport spins up.
#[derive(Clone)]
pub struct FoyerMcpServer {
    runtime: Arc<AgentRuntime>,
    backend: Arc<tokio::sync::RwLock<Option<std::sync::Weak<dyn Backend>>>>,
}

impl FoyerMcpServer {
    pub fn new(runtime: Arc<AgentRuntime>) -> Self {
        Self {
            runtime,
            backend: Arc::new(tokio::sync::RwLock::new(None)),
        }
    }

    /// Plug the live backend in. Called by foyer-server after the
    /// initial backend Arc is wired into AppState; re-called on every
    /// `swap_backend` so the MCP surface tracks the same backend the
    /// in-process agent does.
    pub async fn attach_backend(&self, backend: std::sync::Weak<dyn Backend>) {
        *self.backend.write().await = Some(backend);
    }
}

impl ServerHandler for FoyerMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "foyer-studio",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(
                "Call the `welcome` tool first — it returns Foyer's system \
                 prompt, the user's enabled skills, and saved memory. Without \
                 that priming you'll match the in-process agent's behaviour \
                 noticeably worse on every other tool.",
            )
    }

    async fn initialize(
        &self,
        _params: InitializeRequestParams,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, McpError> {
        Ok(self.get_info())
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let mut tools: Vec<Tool> = Vec::new();
        for t in self.runtime.tools().iter() {
            let schema_obj: JsonObject = match t.schema() {
                serde_json::Value::Object(map) => map,
                other => {
                    // MCP spec requires input_schema be an object — wrap
                    // any non-object schema defensively. Our own tools
                    // all return objects.
                    let mut map = JsonObject::new();
                    map.insert("schema".into(), other);
                    map
                }
            };
            tools.push(Tool::new(
                Cow::Owned(t.name().to_string()),
                Cow::Owned(prefixed_description(t.name(), t.description())),
                Arc::new(schema_obj),
            ));
        }
        Ok(ListToolsResult {
            tools,
            next_cursor: None,
            meta: None,
        })
    }

    async fn call_tool(
        &self,
        params: CallToolRequestParams,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let name = params.name.as_ref();
        let tool = match self.runtime.tools().get(name) {
            Some(t) => t,
            None => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "unknown tool: {name}"
                ))]));
            }
        };
        let backend = match self.backend.read().await.clone().and_then(|w| w.upgrade()) {
            Some(b) => b,
            None => {
                return Ok(CallToolResult::error(vec![Content::text(
                    "foyer backend not attached",
                )]));
            }
        };
        let fe_render = self.runtime.fe_renderer().await;
        let headless_render = self.runtime.headless_renderer().await;
        let ui_director = self.runtime.ui_director().await;
        let session_director = self.runtime.session_director().await;
        let prefer_headless = self.runtime.prefer_headless_render().await;
        let spectrum_director = self.runtime.spectrum_director().await;
        let ctx_tool = ToolContext {
            // MCP builds a fresh ToolContext per call, so a stable
            // single-Weak in a fresh RwLock is fine — the same shape
            // the in-process agent uses, just without the
            // session-swap mid-call concern (each MCP call is its
            // own request).
            backend: foyer_agent::tools::make_backend_ref(Arc::downgrade(&backend)),
            fe_attached: fe_render.is_some(),
            // MCP calls don't run inside the in-process agent's
            // `run_turn`, so there's no per-turn budget to extend.
            // `continue_working` no-ops cleanly when this is None.
            turn_budget: None,
            fe_render,
            headless_render,
            ui_director,
            session_director,
            spectrum_director,
            prefer_headless_render: prefer_headless,
        };
        // Keep the strong ref alive across the tool call so the Weak
        // inside ToolContext can upgrade for the duration of dispatch.
        let _backend_strong = backend;
        let args = params
            .arguments
            .map(serde_json::Value::Object)
            .unwrap_or(serde_json::Value::Null);
        match tool.call(&ctx_tool, args).await {
            Ok(result) => {
                let header = if result.data.is_null() {
                    result.summary.clone()
                } else {
                    format!(
                        "{}\n\n{}",
                        result.summary,
                        serde_json::to_string_pretty(&result.data).unwrap_or_default()
                    )
                };
                let mut content: Vec<Content> = vec![Content::text(header)];
                if let Some(b64) = result.image_png_b64 {
                    content.push(Content::image(b64, "image/png".to_string()));
                }
                let mut out = CallToolResult::success(content);
                if matches!(result.data, serde_json::Value::Object(_)) {
                    out.structured_content = Some(result.data);
                }
                Ok(out)
            }
            Err(err) => {
                let kind = match &err {
                    ToolError::InvalidArgs(_) => "invalid_args",
                    _ => "execution",
                };
                let mut out = CallToolResult::error(vec![Content::text(err.to_string())]);
                let mut meta = Meta::new();
                meta.0.insert(
                    "foyerKind".to_string(),
                    serde_json::Value::String(kind.to_string()),
                );
                out.meta = Some(meta);
                Ok(out)
            }
        }
    }
}

/// Every non-welcome tool description gets a one-line prefix telling
/// the external agent to call `welcome` first. The in-process agent
/// learns about `welcome` via its system prompt; external clients
/// only read the tool descriptions, so we surface it here.
fn prefixed_description(name: &str, description: &str) -> String {
    if name == "welcome" {
        description.to_string()
    } else {
        format!(
            "[Foyer MCP] Call `welcome` first to load Foyer's system \
             prompt, skills, and memory. — {description}"
        )
    }
}

/// Build an `axum::Router` that mounts the streamable-HTTP MCP
/// transport. Caller is responsible for nesting at `/mcp` (or
/// whatever prefix); the router itself accepts both `POST /` (JSON-RPC
/// requests) and `GET /` (SSE upgrade for notifications).
pub fn mcp_router(server: FoyerMcpServer) -> Router {
    // Stateless mode: foyer restarts wipe in-memory session tables,
    // and Claude Code / Codex MCP clients do not auto re-initialize
    // when they hit `Session not found`. Our tools are pure request-
    // response (no server-initiated notifications), so stateful
    // sessions buy us nothing and cost us every bounce.
    let config = StreamableHttpServerConfig::default().with_stateful_mode(false);
    let service = StreamableHttpService::new(
        move || Ok::<_, std::io::Error>(server.clone()),
        Arc::new(LocalSessionManager::default()),
        config,
    );
    Router::new().fallback_service(service)
}
