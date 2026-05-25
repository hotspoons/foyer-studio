// MCPHttp port + endpoint helpers used by both the launch path
// (allocate a free port before spawning Ardour) and the registry-
// attach path (probe the endpoint once the shim is up).

use std::path::Path;
use std::time::Duration;

/// Allocate a free TCP port for an MCPHttp listener. Biased to the
/// [4820, 4900) range (4820 is Ardour's published default) so firewall
/// rules and dev tooling muscle memory stay aligned; falls through to
/// a kernel-picked ephemeral port if every slot is taken.
pub fn alloc_free_mcp_port() -> Option<u16> {
    use std::net::TcpListener;
    for port in 4820u16..4900 {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Some(port);
        }
    }
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|addr| addr.port())
}

/// Probe an MCPHttp endpoint to see if it's up. Used post-spawn to
/// decide whether to register this session as MCP-capable.
pub async fn probe_mcp_http(port: u16, deadline: Duration) -> bool {
    let url = format!("http://127.0.0.1:{port}/mcp");
    let client = match reqwest::Client::builder().timeout(deadline).build() {
        Ok(c) => c,
        Err(_) => return false,
    };
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "foyer-mcp-probe", "version": "0.1" }
        }
    });
    let deadline_at = tokio::time::Instant::now() + deadline;
    while tokio::time::Instant::now() < deadline_at {
        let r = client
            .post(&url)
            .header("Accept", "application/json, text/event-stream")
            .json(&body)
            .send()
            .await;
        if matches!(r, Ok(ref resp) if resp.status().is_success()) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    false
}

/// Try to read the configured MCPHttp port out of `project`'s
/// `.ardour` file. Used by the reuse-existing-shim path when the
/// advert JSON didn't carry a `mcp_port` (older shim builds).
pub fn read_mcp_port_from_session_file(project: &Path) -> Option<u16> {
    let session_file = if project.is_file() {
        project.to_path_buf()
    } else if project.is_dir() {
        std::fs::read_dir(project)
            .ok()?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| {
                p.extension().and_then(|s| s.to_str()) == Some("ardour")
                    && !p
                        .file_name()
                        .and_then(|s| s.to_str())
                        .is_some_and(|s| s.ends_with(".bak") || s.starts_with("."))
            })?
    } else {
        return None;
    };
    crate::ardour_xml::read_mcp_http_port(&session_file)
}
