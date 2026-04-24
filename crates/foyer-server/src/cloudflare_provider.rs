//! Cloudflare tunnel provider — supports three operating modes.
//!
//! | mode           | trigger                          | behavior                                                                                  |
//! |----------------|----------------------------------|-------------------------------------------------------------------------------------------|
//! | auto-provision | `api_token + account_id + hostname` | Creates/reuses a Cloudflare Tunnel, configures ingress + DNS via API, runs `--token`.    |
//! | raw token      | `tunnel_token + hostname`        | Skips all API work; runs `cloudflared tunnel run --token <token>`. Dashboard-side config. |
//! | quick tunnel   | (everything else)                | Runs `cloudflared tunnel --url http://127.0.0.1:<auth-port>` → `*.trycloudflare.com` URL. |
//!
//! # Two-port architecture (see DECISION 37)
//!
//! The LAN-facing Foyer server runs in trusted mode — anyone on the
//! local network is the owner and every command is allowed. That would
//! be catastrophic to expose over a public tunnel, so **the tunnel is
//! pointed at a separate listener on a separate port** (the "auth
//! server" started here). Today both listeners serve an identical
//! router (`crate::build_http_router`) so tunnel guests see the real
//! Foyer UI + WS; RBAC + role-gating will land later as middleware
//! attached **only to the auth listener's router**, which keeps the
//! main LAN router untouched.
//!
//! **Do not** "fix" any auth issue by pointing cloudflared at the main
//! port — it would bypass the separation that makes LAN-open-by-
//! default safe. All three Cloudflare modes (auto-provision, raw
//! token, quick) route through the auth listener's port.
//!
//! Implementation note: cloudflared auto-downloads via `cloudflared_dl`
//! on first use, so neither mode requires the user to install anything.

use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{anyhow, bail, Context, Result};
use foyer_schema::{TunnelProviderConfig, TunnelProviderKind};
use tokio::io::AsyncBufReadExt;
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;

use crate::cloudflare_api;
use crate::cloudflared_dl;
use crate::tunnel_provider::{LocalTarget, TunnelProvider};

// ─── CloudflareProvider ──────────────────────────────────────────────

pub struct CloudflareProvider {
    // Config snapshot — captured at construction time. `start()` picks
    // a mode based on which combination of these is populated.
    api_token: Option<String>,
    account_id: Option<String>,
    zone_id: Option<String>,
    tunnel_name: Option<String>,
    hostname: Option<String>,
    tunnel_token: Option<String>,

    // Runtime state, populated on start.
    child: Option<Child>,
    active_hostname: Option<String>,
    /// Port cloudflared is pointed at. Always the secondary auth
    /// server — never the main Foyer port — see the module-level
    /// docs for why (LAN trust vs. tunnel RBAC).
    target_port: u16,
    auth_server: Option<AuthServerHandle>,
    log_task: Option<JoinHandle<()>>,
}

impl CloudflareProvider {
    pub fn new(cfg: &TunnelProviderConfig) -> Result<Self> {
        match cfg {
            TunnelProviderConfig::Cloudflare {
                api_token,
                account_id,
                zone_id,
                tunnel_name,
                hostname,
                tunnel_token,
            } => Ok(Self {
                api_token: api_token.clone(),
                account_id: account_id.clone(),
                zone_id: zone_id.clone(),
                tunnel_name: tunnel_name.clone(),
                hostname: hostname.clone(),
                tunnel_token: tunnel_token.clone(),
                child: None,
                active_hostname: None,
                target_port: 0,
                auth_server: None,
                log_task: None,
            }),
            _ => bail!("CloudflareProvider created with non-cloudflare config"),
        }
    }

    /// Which of the three modes this config selects. Priority is
    /// auto-provision > raw-token > quick, so partial configs fall
    /// forward to the next mode rather than erroring.
    fn mode(&self) -> Mode {
        if self.api_token.is_some() && self.account_id.is_some() && self.hostname.is_some() {
            Mode::AutoProvision
        } else if self.tunnel_token.is_some() && self.hostname.is_some() {
            Mode::RawToken
        } else {
            Mode::Quick
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    AutoProvision,
    RawToken,
    Quick,
}

#[async_trait::async_trait]
impl crate::tunnel_provider::TunnelProvider for CloudflareProvider {
    fn name(&self) -> &'static str {
        "cloudflare"
    }

    fn kind(&self) -> TunnelProviderKind {
        TunnelProviderKind::Cloudflare
    }

    async fn start(
        &mut self,
        target: LocalTarget,
        state: std::sync::Arc<crate::AppState>,
    ) -> Result<String> {
        let bin = cloudflared_dl::ensure()
            .await
            .context("cloudflared not available")?;

        match self.mode() {
            Mode::AutoProvision => self.start_auto_provision(&bin, target, state).await,
            Mode::RawToken => self.start_raw_token(&bin, target, state).await,
            Mode::Quick => self.start_quick(&bin, state).await,
        }
    }

    async fn stop(&mut self) {
        if let Some(t) = self.log_task.take() {
            t.abort();
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        if let Some(auth) = self.auth_server.take() {
            auth.shutdown.abort();
        }
        self.active_hostname = None;
        self.target_port = 0;
        tracing::info!("cloudflare tunnel stopped");
    }
}

// ─── Mode dispatchers ────────────────────────────────────────────────

impl CloudflareProvider {
    /// Start the tunnel-auth server and stash the handle. Shared by
    /// all three modes so cloudflared always points at a dedicated
    /// RBAC-enforcing surface instead of the trusted LAN-facing main
    /// server (see module docs).
    async fn boot_auth_server(
        &mut self,
        state: std::sync::Arc<crate::AppState>,
    ) -> Result<u16> {
        let auth = start_auth_server(state).await.context("start auth server")?;
        let port = auth.port;
        self.auth_server = Some(auth);
        self.target_port = port;
        Ok(port)
    }

    /// Auto-provision: talk to the Cloudflare API to create/reuse the
    /// tunnel, set its ingress rules, and upsert DNS. Then run cloudflared
    /// with the fetched run token.
    async fn start_auto_provision(
        &mut self,
        bin: &PathBuf,
        _target: LocalTarget,
        state: std::sync::Arc<crate::AppState>,
    ) -> Result<String> {
        let api_token = self.api_token.clone().expect("mode() gate");
        let account_id = self.account_id.clone().expect("mode() gate");
        let hostname = self.hostname.clone().expect("mode() gate");
        let zone_id = self.zone_id.clone();
        let tunnel_name = self.tunnel_name.clone();

        // Ingress targets the auth-server port, NOT the main Foyer
        // port — that's what keeps LAN-open-by-default safe. The auth
        // listener serves the same router as the main server today
        // (full Foyer UI + WS), and an RBAC middleware layer will
        // attach to it later. See DECISION 37.
        let auth_port = self.boot_auth_server(state).await?;
        let service_url = format!("http://127.0.0.1:{auth_port}");
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .context("build cloudflare http client")?;

        tracing::info!(
            "cloudflare: auto-provisioning tunnel for {hostname} -> {service_url}"
        );
        let provisioned = cloudflare_api::provision_tunnel(
            &http,
            &api_token,
            &account_id,
            zone_id.as_deref(),
            tunnel_name.as_deref(),
            &hostname,
            &service_url,
        )
        .await
        .context("cloudflare auto-provision")?;

        let child = spawn_cloudflared_with_token(bin, &provisioned.run_token).await?;
        self.attach_child_for_named(child, auth_port, hostname.clone());
        tracing::info!(
            "cloudflare named tunnel active: https://{hostname} (tunnel {})",
            provisioned.tunnel_id
        );
        Ok(hostname)
    }

    /// Raw-token: dashboard-configured tunnel. User pre-set the
    /// Cloudflare ingress rule — for this mode to route correctly
    /// into Foyer's RBAC surface, the user's dashboard rule must
    /// target the auth-server's address (default `127.0.0.1:3839`
    /// — see `AUTH_SERVER_ADDR`). We still spin up the auth server
    /// locally; the dashboard side is the user's responsibility.
    async fn start_raw_token(
        &mut self,
        bin: &PathBuf,
        _target: LocalTarget,
        state: std::sync::Arc<crate::AppState>,
    ) -> Result<String> {
        let token = self.tunnel_token.clone().expect("mode() gate");
        let hostname = self.hostname.clone().expect("mode() gate");
        let auth_port = self.boot_auth_server(state).await?;
        tracing::info!(
            "cloudflare: starting tunnel from user-supplied token for {hostname} \
             — dashboard ingress should target http://127.0.0.1:{auth_port}"
        );
        let child = spawn_cloudflared_with_token(bin, &token).await?;
        self.attach_child_for_named(child, auth_port, hostname.clone());
        tracing::info!("cloudflare named tunnel active: https://{hostname}");
        Ok(hostname)
    }

    /// Quick tunnel: no creds, random `*.trycloudflare.com` URL, URL is
    /// parsed out of cloudflared's stderr banner. cloudflared is
    /// pointed at the auth server, same as the named-tunnel modes.
    async fn start_quick(
        &mut self,
        bin: &PathBuf,
        state: std::sync::Arc<crate::AppState>,
    ) -> Result<String> {
        let local_port = self.boot_auth_server(state).await?;

        let mut child = spawn_cloudflared_quick(bin, local_port).await?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("cloudflared stdout not captured"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("cloudflared stderr not captured"))?;
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        let task = tokio::spawn(parse_quick_output(stdout, stderr, tx));
        self.log_task = Some(task);
        self.child = Some(child);

        let hostname = match tokio::time::timeout(
            std::time::Duration::from_secs(30),
            rx,
        )
        .await
        {
            Ok(Ok(h)) => h,
            Ok(Err(e)) => {
                self.stop().await;
                return Err(anyhow!("cloudflared failed to start: {e}"));
            }
            Err(_) => {
                self.stop().await;
                return Err(anyhow!(
                    "cloudflared did not report a tunnel URL within 30s — check logs"
                ));
            }
        };
        self.active_hostname = Some(hostname.clone());
        tracing::info!(
            "cloudflare quick tunnel active: https://{} -> localhost:{}",
            hostname,
            local_port
        );
        Ok(hostname)
    }

    /// Shared hookup for both named modes. No URL-parsing needed (the
    /// hostname is already known from config), so we just drain output
    /// at INFO so the user can see cloudflared connect + register.
    fn attach_child_for_named(&mut self, mut child: Child, port: u16, hostname: String) {
        self.target_port = port;
        self.active_hostname = Some(hostname);
        if let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) {
            self.log_task = Some(tokio::spawn(drain_output(stdout, stderr)));
        }
        self.child = Some(child);
    }
}

// ─── Subprocess helpers ──────────────────────────────────────────────

async fn spawn_cloudflared_quick(bin: &PathBuf, local_port: u16) -> Result<Child> {
    let mut cmd = Command::new(bin);
    cmd.arg("tunnel")
        .arg("--url")
        .arg(format!("http://127.0.0.1:{local_port}"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let child = cmd
        .spawn()
        .with_context(|| format!("spawn cloudflared from {}", bin.display()))?;
    tracing::info!(
        "cloudflared quick-tunnel process spawned (pid {:?})",
        child.id()
    );
    Ok(child)
}

async fn spawn_cloudflared_with_token(bin: &PathBuf, token: &str) -> Result<Child> {
    let mut cmd = Command::new(bin);
    // `--no-autoupdate` keeps cloudflared from trying to self-update
    // while we're running — we manage the binary via `cloudflared_dl`.
    cmd.arg("tunnel")
        .arg("--no-autoupdate")
        .arg("run")
        .arg("--token")
        .arg(token)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = cmd
        .spawn()
        .with_context(|| format!("spawn cloudflared from {}", bin.display()))?;
    tracing::info!(
        "cloudflared named-tunnel process spawned (pid {:?})",
        child.id()
    );
    Ok(child)
}

/// Quick-tunnel output parser: logs every line at INFO *and* scans both
/// streams for the `*.trycloudflare.com` URL. Keeps draining after the
/// URL is found so cloudflared doesn't block on a full pipe.
async fn parse_quick_output(
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
    tx: tokio::sync::oneshot::Sender<String>,
) {
    let mut out_lines = tokio::io::BufReader::new(stdout).lines();
    let mut err_lines = tokio::io::BufReader::new(stderr).lines();
    let mut tx = Some(tx);
    let mut out_done = false;
    let mut err_done = false;

    while !(out_done && err_done) {
        tokio::select! {
            r = out_lines.next_line(), if !out_done => match r {
                Ok(Some(line)) => {
                    tracing::info!("cloudflared[out]: {line}");
                    try_extract_hostname(&line, &mut tx);
                }
                _ => out_done = true,
            },
            r = err_lines.next_line(), if !err_done => match r {
                Ok(Some(line)) => {
                    tracing::info!("cloudflared[err]: {line}");
                    try_extract_hostname(&line, &mut tx);
                }
                _ => err_done = true,
            },
        }
    }
}

/// Named-tunnel output drainer: same INFO-level logging, but no URL
/// parsing (the hostname is already known from config).
async fn drain_output(
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
) {
    let mut out_lines = tokio::io::BufReader::new(stdout).lines();
    let mut err_lines = tokio::io::BufReader::new(stderr).lines();
    let mut out_done = false;
    let mut err_done = false;
    while !(out_done && err_done) {
        tokio::select! {
            r = out_lines.next_line(), if !out_done => match r {
                Ok(Some(line)) => tracing::info!("cloudflared[out]: {line}"),
                _ => out_done = true,
            },
            r = err_lines.next_line(), if !err_done => match r {
                Ok(Some(line)) => tracing::info!("cloudflared[err]: {line}"),
                _ => err_done = true,
            },
        }
    }
}

fn try_extract_hostname(
    line: &str,
    tx: &mut Option<tokio::sync::oneshot::Sender<String>>,
) {
    if tx.is_none() {
        return;
    }
    // Anchor on `.trycloudflare.com` — cloudflared's banner prints
    // several unrelated https:// URLs (TOS, docs) before the real
    // quick-tunnel URL. Matching the domain specifically avoids
    // latching onto the wrong one.
    let Some(tc_idx) = line.find(".trycloudflare.com") else { return };
    let prefix = &line[..tc_idx];
    let Some(https_idx) = prefix.rfind("https://") else { return };
    let rest = &line[https_idx..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '|')
        .unwrap_or(rest.len());
    let url = &rest[..end];
    if let Ok(parsed) = url::Url::parse(url) {
        if let Some(host) = parsed.host_str() {
            if host.ends_with(".trycloudflare.com") {
                tracing::info!("discovered cloudflare tunnel hostname: {host}");
                if let Some(t) = tx.take() {
                    let _ = t.send(host.to_string());
                }
            }
        }
    }
}

// ─── Auth server (tunnel-side surface — serves the full Foyer app) ───
//
// This is the ONLY surface exposed to the public internet via the
// tunnel. It runs on a separate port from the main LAN-trusted Foyer
// server so the main server can stay open by default on LAN (owner =
// anyone on the network) while remote tunnel traffic flows through a
// surface that can be independently gated.
//
// Today the listener serves the same router as the main server
// (`crate::build_http_router`) — tunnel guests see the real Foyer UI
// and the real WebSocket bus, same as a LAN client. That's the end
// state we want for the happy path; the RBAC + role-gating layer will
// land later as a middleware attached *only to this listener's
// router*, keeping the main LAN router untouched. See DECISION 37.
//
// Binding at a stable port (`AUTH_SERVER_ADDR`) lets raw-token mode
// (where the user's Cloudflare dashboard has a baked-in ingress URL)
// reference a known address. The other two modes (auto-provision,
// quick) would tolerate a random port but use the same fixed address
// for consistency.

/// Where the tunnel-auth server binds. Must be reachable from the
/// same machine cloudflared runs on (it always is — cloudflared is
/// spawned by the same process). Exposed publicly via the tunnel,
/// never via the LAN listener.
const AUTH_SERVER_ADDR: &str = "127.0.0.1:3839";

struct AuthServerHandle {
    port: u16,
    shutdown: JoinHandle<()>,
}

async fn start_auth_server(
    state: std::sync::Arc<crate::AppState>,
) -> Result<AuthServerHandle> {
    use std::net::SocketAddr;

    let listener = tokio::net::TcpListener::bind(AUTH_SERVER_ADDR)
        .await
        .with_context(|| {
            format!(
                "bind tunnel auth server at {AUTH_SERVER_ADDR} — is another \
                 foyer / cloudflared instance already running?"
            )
        })?;
    let local_addr: SocketAddr = listener.local_addr()?;
    let port = local_addr.port();

    // Share the main router, but wrap it in an `Extension(TunnelOrigin)`
    // layer so the WS handler can tell that this request arrived via
    // the tunnel listener (as opposed to the LAN listener — both peer
    // addresses look like `127.0.0.1` when cloudflared forwards, so
    // peer-based detection is unreliable). The RBAC gate keys on this
    // extension: present → enforce policy; absent → trusted LAN.
    let router = crate::build_http_router(state).await
        .layer(axum::Extension(crate::ws::TunnelOrigin));
    let service = router.into_make_service_with_connect_info::<SocketAddr>();

    let shutdown = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, service).await {
            tracing::warn!("tunnel auth server exited: {e}");
        }
    });

    tracing::info!(
        "tunnel auth server listening on 127.0.0.1:{port} (serves full Foyer UI + WS)"
    );
    Ok(AuthServerHandle { port, shutdown })
}
