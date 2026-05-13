// SPDX-License-Identifier: Apache-2.0
//! Foyer Studio desktop shell.
//!
//! Three modes — picked once and persisted in `config.yaml`:
//!
//! **Host mode**: embeds `foyer-server` in-process (stub backend by
//! default; pass `--socket` for a live shim), opens a WebView on the
//! local URL.
//!
//! **Docker mode**: spawns `foyer docker` (modes inherited from
//! `docker:` config) and opens a WebView on the container's
//! published port. The container is killed on window close.
//!
//! **Connect mode** (`foyer-desktop connect <url>`): plain WebView
//! pointing at a remote Foyer URL. Doesn't read config.desktop.
//!
//! On first launch, an in-window picker asks "Host" vs "Docker"
//! and writes the choice back to `config.yaml` so subsequent
//! launches skip the prompt. Pass `--reset-mode` to re-prompt.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use foyer_backend_host::HostBackend;
use foyer_backend_stub::StubBackend;
use foyer_config::{self as cfg, DesktopMode};
use foyer_server::{Config, Server};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder};
use tao::window::{Fullscreen, WindowBuilder};
use wry::{http, WebViewBuilder};

#[derive(Parser)]
#[command(name = "foyer-desktop", version, about = "Foyer Studio native shell")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// Force the first-run mode picker even when `desktop.mode` is
    /// already set in `config.yaml`. Useful when you want to switch
    /// between host and docker runs without hand-editing the file.
    #[arg(long, default_value_t = false, global = true)]
    reset_mode: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Host mode: embed `foyer-server` in-process, open a WebView on it.
    Serve {
        /// Backend to attach.
        #[arg(long, value_enum, default_value_t = Backend::Stub)]
        backend: Backend,

        /// Shim UDS path (only meaningful for `--backend=host`). If omitted,
        /// discovery scans `$XDG_RUNTIME_DIR/foyer/` and picks the single
        /// live shim.
        #[arg(long)]
        socket: Option<PathBuf>,

        /// Address to bind the embedded server to. Default loopback-only;
        /// pass `0.0.0.0:<port>` to also accept browser/remote-client connections.
        #[arg(long, default_value = "127.0.0.1:0")]
        listen: SocketAddr,

        /// Launch fullscreen on startup.
        #[arg(long)]
        fullscreen: bool,
    },
    /// Client mode: open a WebView on a remote foyer-cli URL.
    Connect {
        /// Remote Foyer UI URL, e.g. `http://studio.local:3838/`.
        url: String,

        /// Launch fullscreen on startup.
        #[arg(long)]
        fullscreen: bool,
    },
    /// Spawn `foyer docker` and open a WebView on the container.
    Docker {
        /// Launch fullscreen on startup.
        #[arg(long)]
        fullscreen: bool,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum Backend {
    Stub,
    Host,
}

fn main() -> Result<()> {
    // WebKit2GTK 2.42+ defaults to GPU compositing via dmabuf, which
    // doesn't survive forwarding through xpra / nested X servers /
    // remote desktops — the user sees a blank window even though
    // the DOM is rendered. Force the software path by default so
    // `foyer-desktop` Just Works under a forwarded display.
    //
    // Native local sessions still benefit from compositing; set
    // `FOYER_DESKTOP_KEEP_COMPOSITING=1` (or simply pre-set any of
    // the named env vars yourself) to opt out of these defaults.
    if std::env::var_os("FOYER_DESKTOP_KEEP_COMPOSITING").is_none() {
        for (k, v) in [
            // dmabuf renderer is the WebKit 2.42+ default; xpra can't
            // forward the resulting GPU surface.
            ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
            ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
            // WebKit 2.42+ spins up a separate GPU process whose
            // output doesn't reach the parent window under nested
            // X servers. Force the in-process renderer.
            ("WEBKIT_DISABLE_GPU_PROCESS", "1"),
            // Software GL — when we can't escape compositing, at
            // least keep it CPU-bound so xpra sees the bits.
            ("LIBGL_ALWAYS_SOFTWARE", "1"),
            // Some WebKit sandbox setups require namespaces that
            // don't exist in dev containers; turning it off lets
            // the render path complete.
            ("WEBKIT_FORCE_SANDBOX", "0"),
            // Force the X11 GDK backend in case GTK auto-picks
            // Wayland (xpra is X11-only).
            ("GDK_BACKEND", "x11"),
        ] {
            if std::env::var_os(k).is_none() {
                // Safety: setting env at the start of `main` before
                // any thread spawns — std::env::set_var is sound here.
                unsafe { std::env::set_var(k, v) };
            }
        }
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,foyer_server=debug".into()),
        )
        .init();

    let cli = Cli::parse();
    match cli.command {
        Some(Command::Serve {
            backend,
            socket,
            listen,
            fullscreen,
        }) => run_host(backend, socket, listen, fullscreen),
        Some(Command::Connect { url, fullscreen }) => run_client(url, fullscreen),
        Some(Command::Docker { fullscreen }) => run_docker_mode(fullscreen),
        None => run_from_config(cli.reset_mode),
    }
}

/// Bare-invocation launch path. Reads `desktop.mode` from
/// `config.yaml`; if unset (or `--reset-mode`) opens the first-run
/// picker, persists the choice, and relaunches into the chosen
/// mode. Either way the user never has to remember `serve` /
/// `docker` subcommand names — `foyer-desktop` with no args Just
/// Works.
fn run_from_config(reset: bool) -> Result<()> {
    let config = cfg::load_or_seed().context("load config.yaml")?;
    let mode = if reset {
        None
    } else {
        config.desktop.as_ref().and_then(|d| d.mode)
    };
    let fullscreen = config
        .desktop
        .as_ref()
        .map(|d| d.fullscreen)
        .unwrap_or(false);
    match mode {
        Some(DesktopMode::Host) => run_host(Backend::Stub, None, "127.0.0.1:0".parse()?, fullscreen),
        Some(DesktopMode::Docker) => run_docker_mode(fullscreen),
        None => show_mode_picker(),
    }
}

fn run_host(
    backend: Backend,
    socket: Option<PathBuf>,
    listen: SocketAddr,
    fullscreen: bool,
) -> Result<()> {
    // Spin up a Tokio runtime for the server; bind and grab the real port before
    // starting the WebView so we can tell it where to connect.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    // Bind the listen socket synchronously to learn the real port when listen=:0.
    let listener = rt
        .block_on(async { tokio::net::TcpListener::bind(listen).await })
        .context("bind server listen address")?;
    let actual = listener.local_addr()?;
    drop(listener); // release before Server::run rebinds

    let config = Config {
        tls: None,
        listen: actual,
        web_root: std::env::current_dir().ok().map(|d| d.join("web")),
        web_overlays: Vec::new(),
        jail_root: None,
    };

    // Launch the server in the runtime; it keeps running until the process exits.
    let url = format!("http://{}/", actual);
    rt.spawn(async move {
        let err = match backend {
            Backend::Stub => {
                let server = Server::new(StubBackend::new());
                server.run(config).await
            }
            Backend::Host => {
                let resolved = match socket {
                    Some(p) => p,
                    None => match foyer_backend_host::discovery::pick_single() {
                        Ok(ad) => ad.socket,
                        Err(e) => {
                            tracing::error!("shim discovery failed: {e}");
                            return;
                        }
                    },
                };
                let b = match HostBackend::connect(resolved.clone()).await {
                    Ok(b) => b,
                    Err(e) => {
                        tracing::error!("connect to shim at {}: {e}", resolved.display());
                        return;
                    }
                };
                tracing::info!("connected to shim at {}", resolved.display());
                let server = Server::new(b);
                server.run(config).await
            }
        };
        if let Err(e) = err {
            tracing::error!("server exited: {e}");
        }
    });

    run_webview(url, fullscreen, Some(rt), None)
}

fn run_client(url: String, fullscreen: bool) -> Result<()> {
    run_webview(url, fullscreen, None, None)
}

/// Docker mode: spawn `foyer docker` as a child, poll the published
/// port until the sidecar inside is reachable, then open the
/// WebView on it. When the window closes we send SIGTERM to the
/// child; `--rm` on the container cleans up its filesystem.
fn run_docker_mode(fullscreen: bool) -> Result<()> {
    let config = cfg::load_or_seed().context("load config.yaml")?;
    let host_port = config
        .docker
        .as_ref()
        .and_then(|d| d.host_port)
        .unwrap_or(3838);
    // Resolve the foyer binary that should live next to ours after
    // `install.sh`. Falls back to PATH for `cargo run` dev launches.
    let foyer_bin = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("foyer")))
        .filter(|p| p.is_file())
        .or_else(|| which("foyer"))
        .ok_or_else(|| anyhow::anyhow!("`foyer` binary not found — install it first"))?;
    tracing::info!(
        "spawning `{} docker` for the embedded shell",
        foyer_bin.display()
    );
    let child = std::process::Command::new(&foyer_bin)
        .arg("docker")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .context("spawn `foyer docker`")?;
    let child = Arc::new(Mutex::new(Some(child)));

    // Poll until the container's port is reachable; max 30 s.
    let url = format!("http://127.0.0.1:{host_port}/");
    let probe_url = url.clone();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(async {
        for _ in 0..60 {
            if tokio::net::TcpStream::connect(format!("127.0.0.1:{host_port}"))
                .await
                .is_ok()
            {
                return Ok::<(), anyhow::Error>(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        Err(anyhow::anyhow!(
            "container never bound 127.0.0.1:{host_port} within 30 s — check `{}` output above",
            probe_url
        ))
    })?;
    run_webview(url, fullscreen, None, Some(child))
}

/// Common WebView event loop. `_rt` and `child` are held alive for
/// the duration of the loop — `_rt` runs the embedded server (host
/// mode); `child` is the `foyer docker` subprocess (docker mode).
/// On window close we drop both: dropping the runtime shuts down
/// tokio tasks, and the drop impl on `ChildGuard` (below) sends
/// SIGTERM to the docker child.
fn run_webview(
    url: String,
    fullscreen: bool,
    _rt: Option<tokio::runtime::Runtime>,
    child: Option<Arc<Mutex<Option<std::process::Child>>>>,
) -> Result<()> {
    let event_loop: EventLoop<()> = EventLoopBuilder::<()>::with_user_event().build();
    let mut wb = WindowBuilder::new()
        .with_title("Foyer Studio")
        .with_inner_size(tao::dpi::LogicalSize::new(1440.0, 900.0));
    if fullscreen {
        wb = wb.with_fullscreen(Some(Fullscreen::Borderless(None)));
    }
    let window = wb.build(&event_loop)?;

    let webview = WebViewBuilder::new().with_url(&url).build(&window)?;
    apply_linux_render_workarounds(&webview);

    tracing::info!("opened WebView at {url}");
    let _child_guard = child.map(ChildGuard);
    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            *control_flow = ControlFlow::Exit;
        }
    });
}

/// First-launch picker. Opens a small chromeless window with two
/// buttons — clicking either writes `desktop.mode` into config.yaml,
/// closes the picker, and relaunches `foyer-desktop` with the new
/// mode in effect.
fn show_mode_picker() -> Result<()> {
    let html = include_str!("./mode_picker.html");
    // Why a custom `foyer://` protocol instead of `with_html` /
    // `data:` / `file:///`:
    //
    //   · `with_html` silently renders white on some WebKit2GTK
    //     builds (Debian sid w/ webkit2gtk-4.1 2.52.3, 2026-05-13).
    //   · `data:` URIs paint, but wry's `script-message-received`
    //     trampoline parses the page URI as `http::Uri`, which
    //     rejects both `data:` and `file:///` (empty authority).
    //     The IPC handler panics on every event:
    //       wry-0.45/src/webkitgtk/mod.rs:532
    //
    // Custom protocols give us a real `scheme://host/path` URI
    // shape that `http::Uri` accepts, AND let us serve arbitrary
    // bytes from memory without writing temp files.
    let html_bytes = html.as_bytes().to_vec();
    let event_loop: EventLoop<PickResult> = EventLoopBuilder::<PickResult>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("Foyer Studio — first launch")
        .with_inner_size(tao::dpi::LogicalSize::new(640.0, 420.0))
        .with_resizable(false)
        .build(&event_loop)?;
    let webview = WebViewBuilder::new()
        // Enable devtools so a white-screen failure mode is
        // diagnosable from inside the window — right-click → Inspect
        // Element opens the WebKit inspector with the live DOM +
        // console. Harmless in shipped builds; the user can ignore.
        .with_devtools(true)
        .with_custom_protocol("foyer".into(), move |_id, request| {
            tracing::info!(
                "mode-picker custom-protocol request: {} {}",
                request.method(),
                request.uri()
            );
            // Always return the picker HTML — there's only one page
            // in this window. A 200 with `text/html; charset=utf-8`
            // is all webkit needs to render and run our inline
            // script.
            http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .body(std::borrow::Cow::Owned(html_bytes.clone()))
                .unwrap()
        })
        .with_url("foyer://localhost/picker.html")
        .with_ipc_handler(move |req| {
            let body = req.body();
            let choice = match body.as_str() {
                "host" => PickResult::Host,
                "docker" => PickResult::Docker,
                _ => return,
            };
            // Best-effort — if the event loop's gone there's nothing
            // we can do here anyway.
            let _ = proxy.send_event(choice);
        })
        .build(&window)?;
    apply_linux_render_workarounds(&webview);

    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            Event::UserEvent(choice) => {
                if let Err(e) = persist_and_relaunch(choice) {
                    tracing::error!("persist + relaunch failed: {e}");
                }
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

#[derive(Debug, Clone, Copy)]
enum PickResult {
    Host,
    Docker,
}

/// Write the chosen mode into config.yaml and exec a fresh
/// foyer-desktop process so the new mode is read by `run_from_config`.
fn persist_and_relaunch(pick: PickResult) -> Result<()> {
    let mut config = cfg::load_or_seed().context("load config.yaml")?;
    let desktop = config.desktop.get_or_insert_with(cfg::DesktopConfig::default);
    desktop.mode = Some(match pick {
        PickResult::Host => DesktopMode::Host,
        PickResult::Docker => DesktopMode::Docker,
    });
    cfg::save(&config).context("save config.yaml after mode pick")?;

    // Re-exec self with the new config in place. On Unix `exec`
    // replaces the current process so the user only ever sees one
    // window; on Windows we'd spawn + exit. For now `cfg!(unix)`
    // is fine — `foyer-desktop` doesn't target Windows yet.
    let exe = std::env::current_exe().context("locate current exe")?;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = std::process::Command::new(&exe).exec();
        Err(anyhow::anyhow!("exec failed: {err}"))
    }
    #[cfg(not(unix))]
    {
        let _ = std::process::Command::new(&exe).spawn()?;
        std::process::exit(0);
    }
}

/// Linux-only WebKit2GTK render workarounds applied to every
/// `WebView` we build. On webkit2gtk 2.50+ the env-var route for
/// disabling accelerated compositing is unreliable — the
/// `WEBKIT_DISABLE_*` family is silently ignored in some builds.
/// Setting `HardwareAccelerationPolicy::Never` on the WebKit
/// settings object directly is the documented, supported knob; this
/// helper applies it (plus the matching 2D-canvas disable) right
/// after `WebViewBuilder::build`.
///
/// No-op on macOS and Windows — those platforms use WKWebView /
/// WebView2 respectively, which don't share any rendering code
/// with WebKit2GTK and don't need this treatment.
#[allow(unused_variables)]
fn apply_linux_render_workarounds(webview: &wry::WebView) {
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::{HardwareAccelerationPolicy, SettingsExt, WebViewExt};
        use wry::WebViewExtUnix as _;
        let raw = webview.webview();
        if let Some(settings) = WebViewExt::settings(&raw) {
            settings.set_hardware_acceleration_policy(HardwareAccelerationPolicy::Never);
            // `set_enable_accelerated_2d_canvas` is deprecated since
            // webkit2gtk 2.32 but still functional and still load-
            // bearing for our use case (the 2D canvas backend can
            // commit to an unreachable surface even when AC policy
            // is Never). The deprecation is on the *property*, not
            // the behaviour.
            #[allow(deprecated)]
            settings.set_enable_accelerated_2d_canvas(false);
            tracing::info!(
                "applied linux render workarounds: hw_accel=Never, accel_2d_canvas=off",
            );
        }
    }
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Drop wrapper that sends SIGTERM to the held child on the way out,
/// then waits briefly so the container's `--rm` cleanup runs before
/// our process exits. Without this, closing the desktop window left
/// the container running and the next launch failed to bind 3838.
struct ChildGuard(Arc<Mutex<Option<std::process::Child>>>);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let Ok(mut guard) = self.0.lock() else { return };
        if let Some(mut child) = guard.take() {
            // Try graceful shutdown first.
            #[cfg(unix)]
            unsafe {
                libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
            }
            // Wait up to 5 s for the runtime to tear the container
            // down; if it doesn't, escalate to kill.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if std::time::Instant::now() < deadline => {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    Ok(None) => {
                        let _ = child.kill();
                        break;
                    }
                    Err(_) => break,
                }
            }
            let _ = child.wait();
        }
    }
}
