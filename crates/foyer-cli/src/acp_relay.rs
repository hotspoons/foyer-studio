// SPDX-License-Identifier: Apache-2.0
//! `foyer acp` — stdio↔WebSocket relay for the ACP bridge.
//!
//! ACP clients (Zed, JetBrains, …) speak the protocol to a
//! subprocess over stdio: one JSON-RPC message per line. Foyer's
//! actual ACP agent lives inside the running `foyer serve` process
//! (it needs the live `AgentRuntime`), exposed as ACP-over-WebSocket
//! at `/acp/ws` — one JSON-RPC message per text frame. This relay
//! pipes the two together without parsing a byte of protocol:
//!
//! ```text
//! editor ── stdio lines ── foyer acp ── WS frames ── /acp/ws
//! ```
//!
//! stdout is the protocol channel; all logging goes to stderr (the
//! caller routes our tracing there before dispatching).

use anyhow::{Context, Result};
use futures::{SinkExt, StreamExt};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_tungstenite::tungstenite::Message;

/// Derive the default endpoint from config: `server.listen`'s port
/// on loopback (a `0.0.0.0` bind answers there; a pinned LAN IP is
/// used as-is). TLS config flips the scheme to `wss`.
pub fn default_url(config: &foyer_config::Config) -> String {
    let listen = config.server.listen.as_deref().unwrap_or("127.0.0.1:3838");
    let (host, port) = match listen.rsplit_once(':') {
        Some((h, p)) => (h, p),
        None => (listen, "3838"),
    };
    let host = match host {
        "0.0.0.0" | "::" | "[::]" | "" => "127.0.0.1",
        h => h,
    };
    let scheme = if config.server.tls_cert.is_some() {
        "wss"
    } else {
        "ws"
    };
    format!("{scheme}://{host}:{port}/acp/ws")
}

/// Run the relay until either side hangs up.
pub async fn run(url: String) -> Result<()> {
    tracing::info!("foyer acp: connecting to {url}");
    let (ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .with_context(|| {
            format!(
                "connect to the Foyer ACP endpoint at {url} — is `foyer serve` running? \
                 (pass --url to point at a different server)"
            )
        })?;
    tracing::info!("foyer acp: connected — relaying stdio ⇄ {url}");
    let (mut ws_tx, mut ws_rx) = ws.split();

    // stdin → WS. Ends when the editor closes our stdin (EOF), which
    // is the ACP shutdown signal for a subprocess agent.
    let stdin_to_ws = async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            ws_tx
                .send(Message::Text(line))
                .await
                .context("forward stdin line to WS")?;
        }
        // Polite close so the server tears the connection down now
        // rather than at TCP timeout.
        let _ = ws_tx.send(Message::Close(None)).await;
        Ok::<(), anyhow::Error>(())
    };

    // WS → stdout.
    let ws_to_stdout = async move {
        let mut stdout = tokio::io::stdout();
        while let Some(msg) = ws_rx.next().await {
            let text = match msg.context("read WS frame")? {
                Message::Text(s) => s,
                Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                Message::Close(_) => break,
                // tungstenite answers pings internally.
                _ => continue,
            };
            stdout.write_all(text.as_bytes()).await?;
            stdout.write_all(b"\n").await?;
            stdout.flush().await?;
        }
        Ok::<(), anyhow::Error>(())
    };

    // Either direction ending ends the relay: stdin EOF = editor is
    // done with us; WS close = server went away.
    tokio::select! {
        r = stdin_to_ws => r,
        r = ws_to_stdout => r,
    }
}
