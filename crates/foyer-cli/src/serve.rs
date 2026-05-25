// `foyer serve` — boot the WebSocket server + UI + backend.
//
// Owns:
//   * Resolving the initial backend (Ardour with --socket / --project,
//     stub launcher, etc.).
//   * The `BackendSpawner` impl (`CliSpawner`) the WS layer calls
//     into for runtime backend swaps + reattach.
//   * The `ProcessHandle` impl (`ChildProcess`) so session-close can
//     drive SIGTERM → SIGKILL escalation on the spawned DAW child.
//
// Backend-specific bootstrap (Ardour-only today) lives in
// [`crate::runtime::ardour`] behind the [`crate::runtime::Runtime`]
// trait, so this file stays kind-agnostic for the spawn-and-wait path.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use foyer_backend::Backend;
use foyer_backend_host::{discovery, HostBackend};
use foyer_backend_stub::StubBackend;
use foyer_config::{BackendKind, Config};
use foyer_schema::BackendInfo;
use foyer_server::{BackendSpawner, Config as ServerConfig, Server};

use crate::mcp_probe::probe_mcp_http;
use crate::runtime::{self, LaunchCtx};
use crate::shim_install;
use crate::web_bundle;

#[allow(clippy::too_many_arguments)]
pub async fn serve(
    config: Config,
    backend_override: Option<String>,
    project: Option<PathBuf>,
    listen: SocketAddr,
    socket: Option<PathBuf>,
    web_root: Option<PathBuf>,
    web_overlays: Vec<PathBuf>,
    jail_override: Option<PathBuf>,
    tls: Option<foyer_server::TlsConfig>,
    stub_test_tone: bool,
    sample_rate_override: Option<u32>,
    ardour_path_override: Option<PathBuf>,
    agent_upstream_endpoint_cli: Option<String>,
    agent_upstream_model_cli: Option<String>,
    agent_upstream_api_key_cli: Option<String>,
    agent_api_key_cli: Option<String>,
) -> Result<()> {
    let backend = match backend_override.as_deref() {
        Some(id) => config
            .backend(id)
            .ok_or_else(|| anyhow!("no backend with id `{id}` in config"))?,
        None => config
            .default_backend()
            .ok_or_else(|| anyhow!("no backends configured — edit config.yaml"))?,
    };
    if !backend.enabled {
        return Err(anyhow!(
            "backend `{}` is disabled in config — enable it or pick another with --backend",
            backend.id
        ));
    }
    tracing::info!("using backend id={} kind={:?}", backend.id, backend.kind);

    // Ardour preflight: when the resolved backend is Ardour, refuse to
    // boot until we've located the executable AND materialized the
    // embedded shim into the user's surfaces directory.
    if matches!(backend.kind, BackendKind::Ardour) && socket.is_none() {
        let override_path = ardour_path_override
            .as_deref()
            .or(backend.executable.as_deref());
        match shim_install::ensure_ardour_ready(override_path) {
            Ok(ready) => {
                tracing::info!("Ardour binary: {}", ready.binary.display());
                tracing::info!("shim installed: {}", ready.shim_installed_at.display());
            }
            Err(e) => {
                eprintln!("\n{e:#}\n");
                return Err(anyhow!("Ardour preflight failed — refusing to start"));
            }
        }
    }

    let jail = match jail_override {
        Some(p) if p.as_os_str().is_empty() => None,
        Some(p) => Some(p),
        None => config.launcher.jail.clone(),
    };
    if let Some(j) = &jail {
        tracing::info!("session picker jailed to {}", j.display());
    }

    let web_root = web_bundle::resolve_web_root(web_root)?;
    for overlay in &web_overlays {
        if !overlay.exists() {
            anyhow::bail!("--web-overlay {} does not exist", overlay.display());
        }
        tracing::info!("web overlay: {}", overlay.display());
    }
    let server_cfg = ServerConfig {
        listen,
        web_root,
        web_overlays,
        jail_root: jail.clone(),
        tls,
    };

    let stub_test_tone_resolved = stub_test_tone
        || config
            .backends
            .iter()
            .find(|b| b.id == "stub")
            .map(|b| b.stub_test_tone)
            .unwrap_or(false);

    let sr_from_env = std::env::var("FOYER_SAMPLE_RATE")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok());
    let sample_rate_resolved = sample_rate_override
        .or(sr_from_env)
        .or(backend.sample_rate)
        .unwrap_or(foyer_schema::DEFAULT_SAMPLE_RATE);
    if let Some(r) = sample_rate_override {
        tracing::info!("engine sample rate: {r} Hz (--sample-rate)");
    } else if let Some(r) = sr_from_env {
        tracing::info!("engine sample rate: {r} Hz (FOYER_SAMPLE_RATE)");
    } else if let Some(r) = backend.sample_rate {
        tracing::info!(
            "engine sample rate: {r} Hz (from backend `{}` config)",
            backend.id
        );
    } else {
        tracing::info!(
            "engine sample rate: {sample_rate_resolved} Hz (schema default — no override set)"
        );
    }

    let spawner = Arc::new(CliSpawner {
        config: config.clone(),
        jail: jail.clone(),
        stub_test_tone: stub_test_tone_resolved,
        sample_rate: sample_rate_resolved,
    });
    let initial_backend_id = backend.id.clone();

    let is_launcher_mode =
        matches!(backend.kind, BackendKind::Ardour) && socket.is_none() && project.is_none();

    let mut attached_socket_path: Option<PathBuf> = None;
    let initial_backend: Arc<dyn Backend> = match (backend.kind, socket.clone()) {
        (BackendKind::Ardour, Some(s)) => {
            let host = HostBackend::connect(s.clone())
                .await
                .with_context(|| format!("connect to shim at {}", s.display()))?;
            tracing::info!("connected to shim at {}", s.display());
            attached_socket_path = Some(s.clone());
            Arc::new(host)
        }
        (BackendKind::Ardour, None) if project.is_none() => {
            let mut connected: Option<HostBackend> = None;
            if let Ok(adv) = discovery::pick_single() {
                match HostBackend::connect(adv.socket.clone()).await {
                    Ok(host) => {
                        tracing::info!("connected to advertised shim at {}", adv.socket.display());
                        attached_socket_path = Some(adv.socket.clone());
                        connected = Some(host);
                    }
                    Err(e) => {
                        tracing::warn!(
                            "advertised shim at {} is stale ({e}); sweeping + booting launcher",
                            adv.socket.display()
                        );
                        let _ = std::fs::remove_file(&adv.advert_path);
                        let _ = std::fs::remove_file(&adv.socket);
                    }
                }
            }
            match connected {
                Some(host) => Arc::new(host),
                None => {
                    tracing::info!(
                        "no Ardour shim advertised — booting empty launcher; pick a project \
                         in the session view to spawn Ardour"
                    );
                    let mut b = StubBackend::launcher()
                        .with_test_tone(stub_test_tone_resolved)
                        .with_sample_rate(sample_rate_resolved);
                    if let Some(root) = &jail {
                        b = b.with_jail(root.clone());
                    }
                    Arc::new(b)
                }
            }
        }
        _ => {
            let recover = project
                .as_deref()
                .map(|p| !foyer_server::session_recovery::probe(p).is_empty())
                .unwrap_or(false)
                .then_some(true);
            if recover.is_some() {
                tracing::info!(
                    "bootstrap launch: live `.pending` crash state detected — defaulting to Recover"
                );
            }
            spawner
                .launch(&backend.id, project.as_deref(), None, recover)
                .await
                .with_context(|| format!("launch backend `{}`", backend.id))?
                .backend
        }
    };

    let server = Server::with_spawner(initial_backend, Some(spawner.clone()));
    server.load_tunnel_config(&config.tunnel).await;
    let agent_upstream_endpoint = agent_upstream_endpoint_cli
        .or_else(|| std::env::var("FOYER_AGENT_UPSTREAM_ENDPOINT").ok())
        .or_else(|| config.agent.upstream_endpoint.clone());
    let agent_upstream_model = agent_upstream_model_cli
        .or_else(|| std::env::var("FOYER_AGENT_UPSTREAM_MODEL").ok())
        .or_else(|| config.agent.upstream_model.clone());
    let agent_upstream_api_key = agent_upstream_api_key_cli
        .or_else(|| std::env::var("FOYER_AGENT_UPSTREAM_API_KEY").ok())
        .or_else(|| config.agent.upstream_api_key.clone());
    let agent_api_key = agent_api_key_cli
        .or_else(|| std::env::var("FOYER_AGENT_API_KEY").ok())
        .or_else(|| config.agent.api_key.clone());

    server.set_openai_proxy_api_key(agent_api_key.clone()).await;

    match server.attach_agent(config.mcp_proxies.clone()).await {
        Ok(runtime) => {
            runtime
                .set_prefer_headless_render(config.agent.prefer_headless_render)
                .await;
            runtime
                .apply_boot_overrides(
                    agent_upstream_endpoint.clone(),
                    agent_upstream_model.clone(),
                    agent_upstream_api_key.clone(),
                )
                .await;
            tracing::info!(
                "agent runtime attached (prefer_headless_render={}, upstream={}, model={})",
                config.agent.prefer_headless_render,
                agent_upstream_endpoint.as_deref().unwrap_or("<from store>"),
                agent_upstream_model.as_deref().unwrap_or("<from store>"),
            );
            if config.agent.prefer_headless_render {
                foyer_server::probe_headless_chromium_at_boot();
            }
        }
        Err(e) => tracing::warn!("agent attach failed ({e}) — FAB will be inert"),
    }
    match foyer_config::load_or_seed_roles() {
        Ok(roles) => server.load_roles_policy(roles).await,
        Err(e) => {
            tracing::warn!("could not load roles.yaml ({e}) — falling back to bundled defaults")
        }
    }
    server.set_active_backend(initial_backend_id).await;
    if let Some(path) = attached_socket_path {
        server.set_attached_socket(path).await;
    }
    server.scan_orphans().await;
    if is_launcher_mode {
        tracing::info!("launcher mode active — pick a project in the browser to launch Ardour");
    }
    server.run(server_cfg).await?;
    Ok(())
}

/// `BackendSpawner` impl — ties config, discovery, and child-process
/// spawning together so the WS layer can swap backends at runtime.
pub struct CliSpawner {
    pub config: Config,
    pub jail: Option<PathBuf>,
    /// Resolved value of CLI `--stub-test-tone` ORed with
    /// `backends[id=stub].stub_test_tone`.
    pub stub_test_tone: bool,
    /// Resolved engine sample rate (CLI / env > config > schema default).
    pub sample_rate: u32,
}

#[async_trait::async_trait]
impl BackendSpawner for CliSpawner {
    fn list(&self) -> Vec<BackendInfo> {
        self.config
            .backends
            .iter()
            .map(|b| BackendInfo {
                id: b.id.clone(),
                kind: match b.kind {
                    BackendKind::Stub => "stub".into(),
                    BackendKind::Ardour => "ardour".into(),
                },
                label: b.label.clone().unwrap_or_else(|| b.id.clone()),
                enabled: b.enabled,
                requires_project: matches!(b.kind, BackendKind::Ardour),
            })
            .collect()
    }

    async fn launch(
        &self,
        backend_id: &str,
        project_path: Option<&Path>,
        sample_rate: Option<u32>,
        recover_crash: Option<bool>,
    ) -> anyhow::Result<foyer_server::LaunchedBackend> {
        let cfg_backend = self
            .config
            .backend(backend_id)
            .ok_or_else(|| anyhow!("no backend with id `{backend_id}`"))?;
        if !cfg_backend.enabled {
            return Err(anyhow!("backend `{backend_id}` is disabled"));
        }
        // In-process stub has no external Runtime — build it here.
        if matches!(cfg_backend.kind, BackendKind::Stub) {
            let sr = sample_rate
                .or(cfg_backend.sample_rate)
                .unwrap_or(self.sample_rate);
            let mut b = StubBackend::new()
                .with_test_tone(self.stub_test_tone)
                .with_sample_rate(sr);
            if let Some(root) = &self.jail {
                b = b.with_jail(root.clone());
            }
            if let Some(p) = project_path {
                let _ = b.open_session(&p.display().to_string()).await;
            }
            return Ok(foyer_server::LaunchedBackend::new(Arc::new(b)));
        }

        // Everything else is a child-process backend; dispatch through
        // the runtime trait. Adding Reaper / Bitwig means a new
        // `runtime::*` module + a `for_kind` arm — no edits here.
        let project = project_path
            .ok_or_else(|| anyhow!("backend `{backend_id}` requires a project path"))?;
        let exec = cfg_backend
            .executable
            .clone()
            .ok_or_else(|| anyhow!("backend `{backend_id}` has no executable in config.yaml"))?;
        let abs = if project.is_absolute() {
            project.to_path_buf()
        } else if let Some(root) = &self.jail {
            root.join(project)
        } else {
            project.to_path_buf()
        };
        let sr_hint = sample_rate.or(cfg_backend.sample_rate);
        let runtime = runtime::for_kind(cfg_backend.kind).ok_or_else(|| {
            anyhow!(
                "no runtime registered for backend kind {:?} (backend id `{backend_id}`)",
                cfg_backend.kind
            )
        })?;
        let launch = runtime
            .launch(LaunchCtx {
                exec: &exec,
                extra_args: &cfg_backend.args,
                env: &cfg_backend.env,
                project: &abs,
                sample_rate_hint: sr_hint,
                recover_crash,
            })
            .await?;
        let host = HostBackend::connect(launch.socket.clone())
            .await
            .with_context(|| format!("connect to shim at {}", launch.socket.display()))?;
        let mut launched = foyer_server::LaunchedBackend::with_process(
            Arc::new(host),
            Box::new(ChildProcess::new(launch.child)),
        );
        // MCP probe — runtimes that don't surface MCP set `mcp_port =
        // None`, in which case the probe is skipped entirely.
        if let Some(port) = launch.mcp_port {
            let probe_timeout = std::time::Duration::from_secs(8);
            if probe_mcp_http(port, probe_timeout).await {
                let endpoint = format!("http://127.0.0.1:{port}/mcp");
                tracing::info!("foyer: MCPHttp confirmed live at {endpoint}");
                launched = launched.with_mcp_endpoint(endpoint);
            } else {
                tracing::info!(
                    "foyer: MCPHttp on port {port} didn't answer within {}s — \
                     treating this DAW build as MCP-incapable",
                    probe_timeout.as_secs(),
                );
            }
        }
        Ok(launched)
    }

    async fn reattach(
        &self,
        backend_id: &str,
        socket: &Path,
    ) -> anyhow::Result<foyer_server::LaunchedBackend> {
        let cfg_backend = self
            .config
            .backend(backend_id)
            .ok_or_else(|| anyhow!("no backend with id `{backend_id}`"))?;
        if !matches!(cfg_backend.kind, BackendKind::Ardour) {
            anyhow::bail!(
                "reattach only applies to host-process backends (ardour); `{backend_id}` is `{:?}`",
                cfg_backend.kind,
            );
        }
        let host = HostBackend::connect(socket.to_path_buf())
            .await
            .with_context(|| format!("reattach to shim at {} failed", socket.display()))?;
        Ok(foyer_server::LaunchedBackend::new(Arc::new(host)))
    }
}

/// `ProcessHandle` impl wrapping a `tokio::process::Child`. The
/// shutdown orchestration (graceful → SIGTERM → SIGKILL) lives in
/// `foyer_server::sessions::shutdown_child`; this struct only
/// provides the per-stage primitives.
struct ChildProcess {
    child: tokio::process::Child,
    exited: bool,
}

impl ChildProcess {
    fn new(child: tokio::process::Child) -> Self {
        Self {
            child,
            exited: false,
        }
    }

    fn pid(&self) -> Option<i32> {
        self.child.id().map(|p| p as i32)
    }
}

#[async_trait::async_trait]
impl foyer_server::ProcessHandle for ChildProcess {
    async fn wait(&mut self, timeout: std::time::Duration) -> bool {
        if self.exited {
            return true;
        }
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            match self.child.try_wait() {
                Ok(Some(_status)) => {
                    self.exited = true;
                    return true;
                }
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!("ChildProcess::wait try_wait error: {e}");
                    return false;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    async fn sigterm(&mut self) {
        if self.exited {
            return;
        }
        if let Some(pid) = self.pid() {
            #[cfg(unix)]
            {
                let rv = unsafe { libc::kill(pid, libc::SIGTERM) };
                if rv != 0 {
                    tracing::warn!(
                        "ChildProcess::sigterm kill({pid}, SIGTERM) failed: {}",
                        std::io::Error::last_os_error()
                    );
                }
            }
            #[cfg(not(unix))]
            {
                let _ = self.child.start_kill();
                let _ = pid;
            }
        }
    }

    async fn sigkill(&mut self) {
        if self.exited {
            return;
        }
        let _ = self.child.start_kill();
    }
}
