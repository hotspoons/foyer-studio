// SPDX-License-Identifier: Apache-2.0
//! MCP proxy client + on-disk catalog cache.
//!
//! Foyer's high-level agent tools cover the common DAW workflow
//! (transport, tracks, regions, MIDI, plugins, …). A backend DAW like
//! Ardour ships its own MCP server that exposes a much larger surface
//! — Ardour's `mcp_http` alone advertises ~70+ tools at the time of
//! writing. Loading every upstream tool's full schema into every
//! prompt would burn ~50–100 k tokens per turn before the agent
//! reads the user's question.
//!
//! This module is the thin client that powers the `daw_proxy` agent
//! tool. It implements just enough of the MCP wire protocol
//! (`initialize` → `tools/list` → `tools/call`) to talk to a
//! streamable-HTTP MCP endpoint, plus a per-backend-version JSON
//! cache so repeated `discover` calls don't re-walk the upstream
//! every time.
//!
//! Cache layout:
//!   $XDG_DATA_HOME/foyer/mcp-proxy-cache/<id>-<version>.json
//!
//! The cache key includes the upstream's reported `serverInfo.version`
//! so a DAW upgrade gets a fresh discovery automatically. Stale-cache
//! is a non-issue at the protocol layer (tools/list is cheap), but a
//! cache hit avoids the round-trip when the agent runs `list_tools`
//! every turn.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One MCP tool as the upstream advertises it. Mirror of the
/// `Tool` struct in `rmcp::model` — we keep our own shape so the
/// cache file is stable across rmcp upgrades.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpstreamTool {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The full JSON-schema input shape as the upstream emits it.
    /// Kept verbatim so `daw_proxy.get_tool_details` can return it
    /// unchanged.
    #[serde(default = "default_input_schema")]
    pub input_schema: Value,
}

fn default_input_schema() -> Value {
    serde_json::json!({ "type": "object" })
}

/// One discovery result: the upstream's identity + its full tool
/// catalog at that version. Serialised to disk verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyCatalog {
    /// Foyer's stable id for this upstream (matches `McpProxyConfig.id`).
    pub backend_id: String,
    /// The endpoint URL the catalog was discovered against.
    pub endpoint: String,
    /// MCP `serverInfo.name` as the upstream identifies itself.
    pub server_name: String,
    /// MCP `serverInfo.version` — the cache key suffix.
    pub server_version: String,
    /// Server-supplied free-text guidance (the rmcp
    /// `ServerInfo.instructions` field). Useful for the agent to read
    /// before working with the proxy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// Discovery timestamp (unix seconds) — informational; agent uses
    /// it to phrase "discovered 5 min ago".
    pub discovered_at_unix: u64,
    pub tools: Vec<UpstreamTool>,
}

#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("upstream MCP error: {0}")]
    Upstream(String),
    #[error("transport error: {0}")]
    Transport(String),
    #[error("decode error: {0}")]
    Decode(String),
    #[error("no upstream registered with id `{0}` — check `mcp_proxies` in config.yaml")]
    UnknownBackend(String),
    #[error("upstream `{0}` is disabled in config.yaml")]
    Disabled(String),
}

/// Resolve the per-backend cache file path. We honour
/// `XDG_DATA_HOME` then fall back to `dirs::data_local_dir` so the
/// path matches every other Foyer state file.
pub fn cache_path(backend_id: &str, server_version: &str) -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(dirs::data_local_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("foyer")
        .join("mcp-proxy-cache")
        .join(format!("{backend_id}-{server_version}.json"))
}

/// Load a previously-discovered catalog from disk, if any. Returns
/// `Ok(None)` for "no cache yet" — a fresh `discover` call will
/// populate it.
pub async fn load_cached(
    backend_id: &str,
    server_version: &str,
) -> Result<Option<ProxyCatalog>, ProxyError> {
    let path = cache_path(backend_id, server_version);
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(ProxyError::Transport(format!("cache read {path:?}: {e}"))),
    };
    let cat: ProxyCatalog = serde_json::from_slice(&bytes)
        .map_err(|e| ProxyError::Decode(format!("cache parse {path:?}: {e}")))?;
    Ok(Some(cat))
}

/// Persist a freshly-discovered catalog. Atomic write via tempfile +
/// rename so a partial write doesn't leave a half-parsed cache for
/// the next run.
pub async fn store_cached(cat: &ProxyCatalog) -> Result<(), ProxyError> {
    let path = cache_path(&cat.backend_id, &cat.server_version);
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| ProxyError::Transport(format!("mkdir {dir:?}: {e}")))?;
    }
    let bytes = serde_json::to_vec_pretty(cat)
        .map_err(|e| ProxyError::Decode(format!("cache encode: {e}")))?;
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| ProxyError::Transport(format!("cache write {tmp:?}: {e}")))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| ProxyError::Transport(format!("cache rename {tmp:?} → {path:?}: {e}")))?;
    Ok(())
}

/// Minimal MCP client over reqwest. We hand-roll JSON-RPC plus
/// streamable-HTTP framing (server may answer either as a single JSON
/// body OR as text/event-stream with `data:` lines) because the
/// alternative — turning on rmcp's client features — pulls in the
/// SSE transport stack just to make three calls.
pub struct McpClient {
    endpoint: String,
    api_key: Option<String>,
    http: reqwest::Client,
    next_id: std::sync::atomic::AtomicU64,
}

impl McpClient {
    pub fn new(endpoint: impl Into<String>, api_key: Option<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            api_key,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .expect("reqwest builds with rustls"),
            next_id: std::sync::atomic::AtomicU64::new(1),
        }
    }

    fn next_id(&self) -> u64 {
        self.next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    async fn jsonrpc(&self, method: &str, params: Option<Value>) -> Result<Value, ProxyError> {
        let id = self.next_id();
        let mut body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
        });
        if let Some(p) = params {
            body["params"] = p;
        }
        let mut req = self
            .http
            .post(&self.endpoint)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .json(&body);
        if let Some(key) = &self.api_key {
            req = req.bearer_auth(key);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| ProxyError::Transport(format!("POST {method}: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| ProxyError::Transport(format!("read body: {e}")))?;
        if !status.is_success() {
            return Err(ProxyError::Upstream(format!(
                "{method}: HTTP {status}: {}",
                truncate(&text, 400)
            )));
        }
        // The server can answer with either a plain JSON-RPC envelope
        // OR an SSE stream whose first `data:` line is the response.
        // Try plain JSON first; on parse failure, walk the SSE shape.
        let envelope: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => parse_sse_first_data(&text).ok_or_else(|| {
                ProxyError::Decode(format!("unrecognised body shape: {}", truncate(&text, 200)))
            })?,
        };
        if let Some(err) = envelope.get("error") {
            return Err(ProxyError::Upstream(format!("{method}: {err}")));
        }
        envelope
            .get("result")
            .cloned()
            .ok_or_else(|| ProxyError::Decode(format!("{method}: no `result` in response")))
    }

    /// Run the MCP `initialize` handshake. Returns the
    /// `(server_name, server_version, instructions?)` triple.
    pub async fn initialize(&self) -> Result<(String, String, Option<String>), ProxyError> {
        let params = serde_json::json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "foyer-daw-proxy", "version": env!("CARGO_PKG_VERSION") },
        });
        let result = self.jsonrpc("initialize", Some(params)).await?;
        // Send the post-init notification per the spec. Best-effort —
        // some servers ignore it.
        let _ = self.jsonrpc_notification("notifications/initialized").await;
        let server_info = result.get("serverInfo").cloned().unwrap_or_default();
        let name = server_info
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let version = server_info
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let instructions = result
            .get("instructions")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        Ok((name, version, instructions))
    }

    async fn jsonrpc_notification(&self, method: &str) -> Result<(), ProxyError> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
        });
        let mut req = self
            .http
            .post(&self.endpoint)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .json(&body);
        if let Some(key) = &self.api_key {
            req = req.bearer_auth(key);
        }
        // Notifications have no response body to parse — fire and
        // forget. We still want a connect failure to surface so the
        // caller knows the endpoint is unreachable.
        let _ = req
            .send()
            .await
            .map_err(|e| ProxyError::Transport(format!("notification {method}: {e}")))?;
        Ok(())
    }

    /// Enumerate every tool the upstream exposes. The MCP spec
    /// paginates via `nextCursor`; we walk all pages here so callers
    /// see the full catalog in one Vec.
    pub async fn list_tools(&self) -> Result<Vec<UpstreamTool>, ProxyError> {
        let mut out: Vec<UpstreamTool> = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let params = match &cursor {
                Some(c) => Some(serde_json::json!({ "cursor": c })),
                None => None,
            };
            let result = self.jsonrpc("tools/list", params).await?;
            let tools = result
                .get("tools")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for t in tools {
                let parsed: UpstreamTool = serde_json::from_value(t.clone()).map_err(|e| {
                    ProxyError::Decode(format!(
                        "tool entry parse: {e} (raw: {})",
                        truncate(&t.to_string(), 200)
                    ))
                })?;
                out.push(parsed);
            }
            cursor = result
                .get("nextCursor")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(out)
    }

    /// Invoke an upstream tool. The result is the MCP `CallToolResult`
    /// — content array + optional `structuredContent` + `isError`
    /// flag. The caller forwards it to the agent as-is.
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<Value, ProxyError> {
        let params = serde_json::json!({ "name": name, "arguments": arguments });
        self.jsonrpc("tools/call", Some(params)).await
    }
}

/// Pull the first `data: …` payload out of an SSE response body.
/// Returns the parsed JSON value or None when no `data:` line is
/// present. Used as the fallback when an MCP server answers with
/// `Content-Type: text/event-stream` instead of plain JSON.
fn parse_sse_first_data(body: &str) -> Option<Value> {
    for line in body.lines() {
        if let Some(rest) = line
            .strip_prefix("data: ")
            .or_else(|| line.strip_prefix("data:"))
        {
            let trimmed = rest.trim_start();
            if trimmed == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                return Some(v);
            }
        }
    }
    None
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}

/// Run discovery against a configured upstream, persist the result
/// to the cache, and return it. If `force=false` and a valid cache
/// exists for this backend's reported version, the cache is
/// returned without contacting the upstream (a cheap fast-path the
/// agent hits on every `list_tools`).
///
/// Takes [`crate::tools::McpProxyEntry`] rather than the raw config
/// type so both static-config entries and per-session live entries
/// (from `Session.mcp_endpoint`) route through the same discovery
/// + cache path.
pub async fn discover(
    cfg: &crate::tools::McpProxyEntry,
    force: bool,
) -> Result<ProxyCatalog, ProxyError> {
    if !cfg.enabled {
        return Err(ProxyError::Disabled(cfg.id.clone()));
    }
    let client = McpClient::new(cfg.endpoint.clone(), cfg.api_key.clone());
    let (server_name, server_version, instructions) = client.initialize().await?;

    if !force {
        if let Ok(Some(cached)) = load_cached(&cfg.id, &server_version).await {
            // Cache key is keyed by (backend_id, server_version) so a
            // hit means schema-stable. Still re-verify endpoint
            // matches — if the operator pointed the same id at a new
            // host we'd otherwise hand back stale tool names.
            if cached.endpoint == cfg.endpoint {
                return Ok(cached);
            }
        }
    }

    let tools = client.list_tools().await?;
    let cat = ProxyCatalog {
        backend_id: cfg.id.clone(),
        endpoint: cfg.endpoint.clone(),
        server_name,
        server_version,
        instructions,
        discovered_at_unix: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        tools,
    };
    store_cached(&cat).await?;
    Ok(cat)
}

/// Convenience: build a client from a resolved entry. Doesn't run
/// the init handshake — caller decides when to spend the round-trip.
pub fn client_for(cfg: &crate::tools::McpProxyEntry) -> McpClient {
    McpClient::new(cfg.endpoint.clone(), cfg.api_key.clone())
}
