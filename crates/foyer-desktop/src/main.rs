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
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use foyer_backend_host::HostBackend;
use foyer_backend_stub::StubBackend;
use foyer_config::{self as cfg, DesktopMode, DockerMode, DockerNetwork, HostSubMode};
use foyer_server::{Config, Server};
use serde::Deserialize;
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
    // Linux-only env priming. Clean baseline — we previously stacked
    // half a dozen `WEBKIT_DISABLE_*` env vars +
    // `HardwareAccelerationPolicy::Never` in pursuit of xpra
    // compatibility, and the WebView still rendered as a solid white
    // surface (DOM populated, devtools work, context menus paint —
    // only the page content area is blank). Those layered workarounds
    // were the *cause*, not the cure: with hardware acceleration
    // policy forced to Never on webkit2gtk 2.4x, the page rendering
    // surface allocates but never commits, while peripheral GTK
    // widgets (inspector, menu) keep painting through their own
    // paths. See [docs/DECISIONS.md] follow-up.
    //
    // Strategy: trust WebKit's default acceleration pipeline. The
    // only env var we still want is `GDK_BACKEND=x11` because GTK
    // auto-pick of Wayland fails hard under xpra. macOS uses WKWebView
    // (no GDK), Windows uses WebView2 — neither reads this.
    #[cfg(target_os = "linux")]
    if std::env::var_os("GDK_BACKEND").is_none() {
        // Safety: pre-thread-spawn env mutation.
        unsafe { std::env::set_var("GDK_BACKEND", "x11") };
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
        Some(DesktopMode::Host) => {
            // Sub-mode controls whether we just spin up the stub
            // (demo / no audio) or additionally launch the local
            // Ardour install for a real low-latency audio path.
            let sub = config.desktop.as_ref().and_then(|d| d.host_sub_mode);
            match sub {
                Some(HostSubMode::NativeArdour) => {
                    run_host_native_ardour("127.0.0.1:0".parse()?, fullscreen)
                }
                _ => run_host(Backend::Stub, None, "127.0.0.1:0".parse()?, fullscreen),
            }
        }
        Some(DesktopMode::Docker) => run_docker_mode(fullscreen),
        None => show_mode_picker(),
    }
}

/// Host mode + native Ardour. The desktop shell launches Ardour as a
/// child (so foyer-desktop owns its lifecycle), waits for the
/// Foyer shim's UDS to appear in `$XDG_RUNTIME_DIR/foyer/` (Linux)
/// or `~/Library/Caches/foyer/` (macOS), then attaches the in-
/// process foyer-server to it via HostBackend and points the
/// WebView at the bound port.
///
/// macOS native-Ardour rendering note: Ardour on macOS is a native
/// Cocoa app — its plugin UIs are NSView windows that pop up on
/// the user's desktop, NOT through xpra. See `docs/DECISIONS.md`
/// entry on the cross-OS desktop split.
fn run_host_native_ardour(listen: SocketAddr, fullscreen: bool) -> Result<()> {
    use std::process::Stdio;

    // Resolve Ardour up front so we can surface a clean error before
    // burning a Tokio runtime.
    let foyer_bin = find_foyer_binary()
        .ok_or_else(|| anyhow::anyhow!("`foyer` CLI not found alongside foyer-desktop"))?;
    // Walk PATH + macOS app bundles via the foyer CLI's doctor so we
    // don't duplicate the lookup logic here. The CLI prints a JSON
    // blob; we just check the `installed`/`binary` fields. (Tiny
    // subprocess, ~50 ms even on macOS.)
    let ardour_json = std::process::Command::new(&foyer_bin)
        .args(["doctor-ardour"])
        .output()
        .context("spawn `foyer doctor-ardour`")?;
    if !ardour_json.status.success() {
        return Err(anyhow::anyhow!("foyer doctor-ardour failed"));
    }
    let parsed: serde_json::Value =
        serde_json::from_slice(&ardour_json.stdout).context("parse doctor-ardour JSON")?;
    if !parsed
        .get("installed")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Err(anyhow::anyhow!(
            "no local Ardour install found — use the picker's Re-check after installing"
        ));
    }
    let ardour_binary = parsed
        .get("binary")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("doctor-ardour: missing `binary` in JSON"))?
        .to_string();

    // Spawn Ardour. The shim, dropped by `foyer serve --backend
    // ardour` on a prior run (or by install.sh), advertises a UDS
    // in $XDG_RUNTIME_DIR/foyer or $HOME/Library/Caches/foyer that
    // foyer-backend-host's `pick_single` knows how to find. We
    // don't need to pass any env to Ardour — the shim is loaded by
    // Ardour itself the moment the control-surface plugin slot is
    // active in Ardour's prefs.
    tracing::info!("spawning Ardour: {ardour_binary}");
    let ardour_child = std::process::Command::new(&ardour_binary)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| format!("spawn Ardour at {ardour_binary}"))?;
    let child_guard = Arc::new(Mutex::new(Some(ardour_child)));

    // Tokio runtime for foyer-server. Bind the listener first so we
    // know the picked port before the WebView opens.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let listener = rt
        .block_on(async { tokio::net::TcpListener::bind(listen).await })
        .context("bind server listen address")?;
    let actual = listener.local_addr()?;
    drop(listener);
    let url = format!("http://{}/", actual);

    let server_cfg = Config {
        tls: None,
        listen: actual,
        web_root: std::env::current_dir().ok().map(|d| d.join("web")),
        web_overlays: Vec::new(),
        jail_root: None,
    };

    rt.spawn(async move {
        // Wait for the shim socket — Ardour takes 2-15 s to finish
        // its boot + load our surface plugin. pick_single retries
        // internally; we cap with a deadline so a broken install
        // surfaces as a server-side error in the WebView.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let socket = loop {
            match foyer_backend_host::discovery::pick_single() {
                Ok(ad) => break ad.socket,
                Err(e) => {
                    if std::time::Instant::now() >= deadline {
                        tracing::error!("shim discovery timed out: {e}");
                        return;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }
        };
        let b = match HostBackend::connect(socket.clone()).await {
            Ok(b) => b,
            Err(e) => {
                tracing::error!("connect to shim at {}: {e}", socket.display());
                return;
            }
        };
        tracing::info!("attached to shim at {}", socket.display());
        let server = Server::new(b);
        if let Err(e) = server.run(server_cfg).await {
            tracing::error!("server exited: {e}");
        }
    });

    run_webview(url, fullscreen, Some(rt), Some(child_guard))
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

    // Use `build_gtk` instead of `build` on Linux: the latter goes
    // through wry's `new_x11` path which creates a *foreign* GTK
    // window attached to tao's raw X11 handle. On webkit2gtk 2.4x
    // that foreign-window setup renders the page surface to a
    // pixmap that's never committed back to the X11 parent — DOM
    // populated, inspector/context menus paint via their own GTK
    // paths, but the page area stays solid white. Wry's official
    // examples all use `build_gtk(window.default_vbox())` on Linux
    // (see wry/examples/custom_protocol.rs); tao's default_vbox is
    // the GtkBox it already mounted as a direct child of the
    // window's gtk_window, so wry adds the webview into the real
    // widget tree and skips the foreign-window indirection.
    #[cfg(target_os = "linux")]
    let _webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window
            .default_vbox()
            .ok_or_else(|| anyhow::anyhow!("tao window missing default_vbox"))?;
        WebViewBuilder::new().with_url(&url).build_gtk(vbox)?
    };
    #[cfg(not(target_os = "linux"))]
    let _webview = WebViewBuilder::new().with_url(&url).build(&window)?;

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

/// First-launch picker. Opens a chromeless window with a two-page
/// wizard:
///
///   1. Host vs Docker.
///   2. (Docker only) Audio mode picker pre-decorated with the
///      result of `foyer docker --doctor --json` for each mode,
///      then a networking-model + (NetJACK only) host/port form.
///
/// Clicking through writes `desktop.mode` + (if Docker) the full
/// `docker:` block into config.yaml, closes the picker, and
/// relaunches `foyer-desktop` with the new mode in effect.
fn show_mode_picker() -> Result<()> {
    let template = include_str!("./mode_picker.html");
    // Run the pre-flight checks for all three docker modes BEFORE
    // opening the window, so the audio-mode page renders with full
    // state on first paint. Each spawn is fast (<200 ms on a warm
    // host); doing it in parallel via threads keeps cold-start
    // perception under half a second.
    let doctor_json = build_doctor_payload();
    let html = template.replace(
        "<head>",
        &format!("<head>\n    <script>window.__doctor = {doctor_json};</script>"),
    );
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
    let html_bytes = html.into_bytes();
    let event_loop: EventLoop<PickResult> =
        EventLoopBuilder::<PickResult>::with_user_event().build();
    // Two proxy handles: one for the IPC trampoline (synchronous
    // events dispatched by the page) and one for the event-loop
    // closure itself (so the DMG-install worker thread can fire a
    // Refresh when it completes).
    let proxy = event_loop.create_proxy();
    let proxy_outer = proxy.clone();
    // Picker default: 980×640 so the dependency-check list, install
    // hints, and three audio-mode cards have room to breathe; the
    // user can grab any window edge to shrink it. `resizable(false)`
    // is removed because some window managers (xpra-html5 in
    // particular) ignore the flag and present the user with a
    // resize handle anyway, leaving a fixed-content layout
    // mismatched to the actual frame. Min 720×480 keeps the
    // actions row visible even when squished.
    let window = WindowBuilder::new()
        .with_title("Foyer Studio — first launch")
        .with_inner_size(tao::dpi::LogicalSize::new(980.0, 640.0))
        .with_min_inner_size(tao::dpi::LogicalSize::new(720.0, 480.0))
        .build(&event_loop)?;
    // The Ardour-download flow lives on a separate `foyer://ardour-
    // download/` host inside the same custom protocol so we can
    // route URI host segments to different inline HTML bodies.
    // Compiled in via include_str! at the same site as the picker
    // template so a single binary is fully self-contained.
    let ardour_download_html = include_str!("./ardour_download.html");
    let ardour_download_bytes = ardour_download_html.as_bytes().to_vec();
    let builder = WebViewBuilder::new()
        // Enable devtools so a white-screen failure mode is
        // diagnosable from inside the window — right-click → Inspect
        // Element opens the WebKit inspector with the live DOM +
        // console. Harmless in shipped builds; the user can ignore.
        .with_devtools(true)
        .with_custom_protocol("foyer".into(), move |_id, request| {
            tracing::info!(
                "picker custom-protocol request: {} {}",
                request.method(),
                request.uri()
            );
            // Route by URI host segment. `foyer://localhost/...`
            // serves the mode picker; `foyer://ardour-download/...`
            // serves the Ardour-download flow. Anything else
            // defaults to the picker.
            let host = request.uri().host().unwrap_or("localhost");
            let body = match host {
                "ardour-download" => ardour_download_bytes.clone(),
                _ => html_bytes.clone(),
            };
            http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .body(std::borrow::Cow::Owned(body))
                .unwrap()
        })
        .with_url("foyer://localhost/picker.html")
        .with_ipc_handler(move |req| {
            let body = req.body();
            let pick = parse_ipc_pick(body.as_str());
            if let Some(p) = pick {
                // Best-effort — if the event loop's gone there's
                // nothing we can do here anyway.
                let _ = proxy.send_event(p);
            } else {
                tracing::warn!("mode-picker: unrecognized IPC payload: {body}");
            }
        });
    // Same rationale as `run_webview`: on Linux we must `build_gtk`
    // into tao's GtkBox rather than going through wry's `new_x11`
    // foreign-window path, which renders the page surface white.
    #[cfg(target_os = "linux")]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window
            .default_vbox()
            .ok_or_else(|| anyhow::anyhow!("tao window missing default_vbox"))?;
        builder.build_gtk(vbox)?
    };
    #[cfg(not(target_os = "linux"))]
    let webview = builder.build(&window)?;

    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            Event::UserEvent(PickResult::Refresh) => {
                // Re-run all doctors and push the result back into
                // the page via `window.applyDoctor(...)`. We embed
                // the JSON directly in the script string — the JSON
                // is already valid JS, and `evaluate_script` runs
                // synchronously on the WebKit thread so the page
                // sees fresh data before any further user click.
                let json = build_doctor_payload();
                let script = format!("window.applyDoctor({json});");
                if let Err(e) = webview.evaluate_script(&script) {
                    tracing::warn!("mode-picker refresh: evaluate_script failed: {e}");
                }
            }
            Event::UserEvent(PickResult::DownloadArdour) => {
                // Open the Ardour-download flow in the SAME window
                // by navigating it at the dedicated `foyer://ardour-
                // download/` host. The custom-protocol handler
                // routes requests to either the picker HTML or the
                // download landing page. After install the user
                // navigates back via the breadcrumb (or hits "Re-
                // check"), which re-loads the picker.
                if let Err(e) = webview.load_url("foyer://ardour-download/index.html") {
                    tracing::warn!("ardour-download: load_url failed: {e}");
                }
            }
            Event::UserEvent(PickResult::ArdourDownloadBack) => {
                if let Err(e) = webview.load_url("foyer://localhost/picker.html") {
                    tracing::warn!("ardour-download back: load_url failed: {e}");
                }
            }
            Event::UserEvent(PickResult::OpenExternal(url)) => {
                if let Err(e) = open_in_browser(&url) {
                    tracing::warn!("open external {url}: {e}");
                }
            }
            Event::UserEvent(PickResult::ArdourDmgUrl(url)) => {
                // Hand the DMG URL to a worker thread so the event
                // loop stays responsive. The worker downloads,
                // mounts, copies the .app into /Applications, then
                // pushes a synthetic Refresh back into the picker
                // via the existing proxy.
                let proxy_clone = proxy_outer.clone();
                std::thread::spawn(move || match install_ardour_dmg(&url) {
                    Ok(_) => {
                        let _ = proxy_clone.send_event(PickResult::Refresh);
                    }
                    Err(e) => tracing::error!("ardour-dmg install failed: {e}"),
                });
            }
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

#[derive(Debug, Clone)]
enum PickResult {
    Host(HostWizardChoice),
    Docker(DockerWizardChoice),
    /// Re-run all dependency probes and push the new doctor JSON
    /// into the page via `window.applyDoctor(...)`. Fired by the
    /// "Re-check" button on every picker page. Does not exit the
    /// picker.
    Refresh,
    /// Open the Ardour download flow in the same window. macOS
    /// only. Does NOT exit the picker — the user finishes the
    /// install, navigates back, then hits Re-check on the host
    /// page.
    DownloadArdour,
    /// User clicked "Back" on the Ardour-download page — navigate
    /// the WebView back to the picker without exiting.
    ArdourDownloadBack,
    /// Open `url` in the user's default browser. Sent from the
    /// download page's "Donate & download" / "Just the free demo"
    /// buttons. Doesn't exit the picker.
    OpenExternal(String),
    /// User got past the community.ardour.org form and we
    /// captured the resulting .dmg URL. Rust downloads, mounts,
    /// installs into /Applications, then bounces back to the
    /// picker with a Refresh.
    ArdourDmgUrl(String),
}

/// Host-page submit payload. Mirrors the JS:
///   pick("host:" + JSON.stringify({ sub_mode: "native_ardour" }))
#[derive(Debug, Clone, Deserialize)]
struct HostWizardChoice {
    #[serde(default)]
    sub_mode: Option<String>,
}

/// Wizard output — everything the docker page collected from the
/// user. Mirrors the JS payload shape verbatim so the picker's HTML
/// and this struct can be eyeballed side-by-side.
#[derive(Debug, Clone, Deserialize)]
struct DockerWizardChoice {
    mode: DockerMode,
    network: DockerNetwork,
    #[serde(default = "default_host_port")]
    host_port: u16,
    #[serde(default)]
    netjack_host: Option<String>,
    #[serde(default)]
    netjack_port: Option<u16>,
    /// Runtime flavor (`docker_desktop` | `colima` | `orbstack` |
    /// `podman` | `podman_desktop` | `docker_engine` | `nerdctl`).
    /// macOS + Windows pickers always set this; Linux pickers may
    /// omit (the existing PATH-probe fallback picks one).
    #[serde(default)]
    runtime_kind: Option<String>,
}

fn default_host_port() -> u16 {
    3838
}

/// Translate the raw IPC body the WebView's `window.ipc.postMessage`
/// hands us into one of the discrete picker outcomes. Anything
/// unrecognised returns `None` so the IPC handler can log it.
fn parse_ipc_pick(body: &str) -> Option<PickResult> {
    if body == "host" {
        // Legacy host pick — no sub-mode. Default to stub so the
        // user still gets *some* host-mode launch path. (Pre-M3
        // picker only knew "host" or "docker:".)
        return Some(PickResult::Host(HostWizardChoice { sub_mode: None }));
    }
    if body == "refresh" {
        return Some(PickResult::Refresh);
    }
    if body == "download-ardour" {
        return Some(PickResult::DownloadArdour);
    }
    if body == "ardour-download-back" {
        return Some(PickResult::ArdourDownloadBack);
    }
    if let Some(url) = body.strip_prefix("open-external:") {
        return Some(PickResult::OpenExternal(url.into()));
    }
    if let Some(url) = body.strip_prefix("ardour-dmg-url:") {
        return Some(PickResult::ArdourDmgUrl(url.into()));
    }
    if let Some(rest) = body.strip_prefix("host:") {
        match serde_json::from_str::<HostWizardChoice>(rest) {
            Ok(c) => return Some(PickResult::Host(c)),
            Err(e) => {
                tracing::warn!("mode-picker: host payload failed to parse: {e} (body={rest})");
            }
        }
    }
    if let Some(rest) = body.strip_prefix("docker:") {
        match serde_json::from_str::<DockerWizardChoice>(rest) {
            Ok(c) => return Some(PickResult::Docker(c)),
            Err(e) => {
                tracing::warn!("mode-picker: docker payload failed to parse: {e} (body={rest})");
            }
        }
    }
    None
}

/// Write the chosen mode into config.yaml and exec a fresh
/// foyer-desktop process so the new mode is read by `run_from_config`.
fn persist_and_relaunch(pick: PickResult) -> Result<()> {
    let mut config = cfg::load_or_seed().context("load config.yaml")?;
    let desktop = config
        .desktop
        .get_or_insert_with(cfg::DesktopConfig::default);
    match &pick {
        PickResult::Host(c) => {
            desktop.mode = Some(DesktopMode::Host);
            // Persist the sub-mode choice so the next bare launch
            // picks the right host path without re-prompting. Unknown
            // strings fall back to stub for safety.
            desktop.host_sub_mode = Some(match c.sub_mode.as_deref() {
                Some("native_ardour") => cfg::HostSubMode::NativeArdour,
                _ => cfg::HostSubMode::Stub,
            });
        }
        PickResult::Docker(choice) => {
            desktop.mode = Some(DesktopMode::Docker);
            // Replace any previous docker block — the wizard always
            // collects every field we care about, so a partial
            // merge would leave stale values from an earlier run.
            let mut dcfg = config.docker.take().unwrap_or_default();
            dcfg.mode = Some(choice.mode);
            dcfg.network = Some(choice.network);
            dcfg.host_port = Some(choice.host_port);
            // Runtime kind: macOS / Windows pickers always submit
            // one (the user clicked a card). Linux pickers may
            // submit None, in which case we leave `runtime_kind`
            // unset and the CLI falls back to PATH probes.
            dcfg.runtime_kind = choice.runtime_kind.clone();
            if matches!(choice.mode, DockerMode::Netjack) {
                dcfg.netjack_host = choice.netjack_host.clone();
                dcfg.netjack_port = choice.netjack_port;
            }
            config.docker = Some(dcfg);
        }
        PickResult::Refresh => {
            // Refresh never reaches persist_and_relaunch — the event
            // loop intercepts it earlier. Defensive arm so a future
            // refactor that funnels everything through here doesn't
            // accidentally write config + exit on a refresh click.
            return Ok(());
        }
        PickResult::DownloadArdour
        | PickResult::ArdourDownloadBack
        | PickResult::OpenExternal(_)
        | PickResult::ArdourDmgUrl(_) => {
            // Handled in the event loop, never reaches here.
            // Defensive arm only — keeps the picker from
            // exiting + writing config if a future refactor
            // funnels these through `persist_and_relaunch`.
            return Ok(());
        }
    }
    cfg::save(&config).context("save config.yaml after mode pick")?;

    // Re-exec self with the new config in place. On Unix `exec`
    // replaces the current process so the user only ever sees one
    // window. On Windows there is no exec — spawn a fresh child and
    // exit; the window briefly closes and re-opens, but
    // CreateProcess inherits the same console / stdio shape so the
    // user sees a single window flicker, not a stuck zombie.
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

/// Build the `window.__doctor = {...}` JSON blob the picker page
/// reads to render its dependency-check cards.
///
/// Spawns the following in parallel:
///   - `foyer doctor-host --json` (returns `{os, host}`)
///   - `foyer doctor-runtimes` (returns the runtime-kind array)
///   - `foyer docker --integrated --doctor --json`
///   - `foyer docker --jack       --doctor --json`
///   - `foyer docker --netjack    --doctor --json`
///
/// Stub failure blobs replace anything that errors out so the
/// picker UI renders an actionable card instead of going blank.
fn build_doctor_payload() -> String {
    let foyer_bin = find_foyer_binary();

    // Host probe in its own thread — emits an outer
    // `{"os": ..., "host": ...}` object.
    let host_bin = foyer_bin.clone();
    let host_handle = std::thread::spawn(move || host_doctor_json(host_bin.as_deref()));

    // Runtime probe — emits a JSON array of {kind_id, label,
    // installed, running, ...} that the picker renders as runtime
    // cards on macOS / Windows. Cheap (pure FS probes), so we run it
    // every time the picker re-renders.
    let runtimes_bin = foyer_bin.clone();
    let runtimes_handle = std::thread::spawn(move || runtimes_doctor_json(runtimes_bin.as_deref()));

    // Three docker-mode probes.
    let modes = ["integrated", "jack", "netjack"];
    let mode_handles: Vec<_> = modes
        .iter()
        .map(|m| {
            let bin = foyer_bin.clone();
            let mode = (*m).to_string();
            std::thread::spawn(move || (mode.clone(), doctor_one(bin.as_deref(), &mode)))
        })
        .collect();

    // Splice host JSON open, append docker-mode fields, close.
    let host_blob = host_handle
        .join()
        .unwrap_or_else(|_| "{\"os\":{},\"host\":{\"ok\":false,\"checks\":[]}}".into());
    let runtimes_blob = runtimes_handle.join().unwrap_or_else(|_| "[]".into());
    let mut pairs: Vec<String> = Vec::with_capacity(4);
    pairs.push(format!("\"runtimes\": {runtimes_blob}"));
    // Surface the host platform so the picker can branch UI on it
    // (windows hides the host card, macOS shows native-Ardour sub-
    // mode, linux mirrors today's flow). We avoid relying on
    // navigator.platform because the WebView's UA isn't always
    // representative of the host — webkit2gtk reports linux even
    // when xpra'd to a remote display.
    let host_os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    pairs.push(format!("\"host_os\": \"{host_os}\""));
    for h in mode_handles {
        let (mode, json) = h
            .join()
            .unwrap_or_else(|_| ("?".into(), "{\"ok\":false,\"checks\":[]}".into()));
        pairs.push(format!("\"{mode}\": {json}"));
    }
    // The host blob looks like `{"os": {...}, "host": {...}}`. Strip
    // the trailing brace and splice the extra fields inside so the
    // result is a single flat object the picker can index by name.
    let host_trimmed = host_blob.trim();
    let host_trimmed = host_trimmed
        .strip_suffix('}')
        .unwrap_or(host_trimmed)
        .trim_end()
        .trim_end_matches('\n');
    format!("{}, {}\n}}", host_trimmed, pairs.join(", "))
}

fn runtimes_doctor_json(foyer_bin: Option<&Path>) -> String {
    let Some(bin) = foyer_bin else {
        return "[]".into();
    };
    let out = std::process::Command::new(bin)
        .args(["doctor-runtimes"])
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8(o.stdout).unwrap_or_else(|_| "[]".into()),
        _ => "[]".into(),
    }
}

fn host_doctor_json(foyer_bin: Option<&Path>) -> String {
    let Some(bin) = foyer_bin else {
        return format!(
            "{{\"os\":{{}},\"host\":{}}}",
            synth_failure(
                "`foyer` binary not found",
                "Install it (or rebuild the bundle) so the desktop shell can run \
                 pre-flight checks. Looked next to foyer-desktop and on PATH.",
            )
        );
    };
    let out = std::process::Command::new(bin)
        .args(["doctor-host", "--json"])
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8(o.stdout).unwrap_or_else(|e| {
            format!(
                "{{\"os\":{{}},\"host\":{}}}",
                synth_failure("doctor-host returned non-UTF8 output", &e.to_string())
            )
        }),
        Ok(o) => format!(
            "{{\"os\":{{}},\"host\":{}}}",
            synth_failure(
                "foyer doctor-host exited non-zero",
                &String::from_utf8_lossy(&o.stderr),
            )
        ),
        Err(e) => format!(
            "{{\"os\":{{}},\"host\":{}}}",
            synth_failure("failed to spawn foyer doctor-host", &e.to_string())
        ),
    }
}

fn doctor_one(foyer_bin: Option<&Path>, mode: &str) -> String {
    let Some(bin) = foyer_bin else {
        return synth_failure(
            "`foyer` binary not found",
            "Install it (or rebuild the bundle) so the desktop shell can run \
             pre-flight checks. Looked next to foyer-desktop and on PATH.",
        );
    };
    let flag = match mode {
        "integrated" => "--integrated",
        "jack" => "--jack",
        "netjack" => "--netjack",
        _ => return synth_failure("unknown mode", mode),
    };
    let out = std::process::Command::new(bin)
        .args(["docker", flag, "--doctor", "--json"])
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8(o.stdout).unwrap_or_else(|e| {
            synth_failure(
                "foyer docker --doctor returned non-UTF8 output",
                &e.to_string(),
            )
        }),
        Ok(o) => synth_failure(
            "foyer docker --doctor exited non-zero",
            &String::from_utf8_lossy(&o.stderr),
        ),
        Err(e) => synth_failure("failed to spawn foyer docker --doctor", &e.to_string()),
    }
}

/// Emit a synthetic JSON blob shaped like a real doctor result so
/// the picker UI doesn't have to special-case "no data". One
/// required-severity failure → the card renders disabled with the
/// detail string the user can act on.
fn synth_failure(label: &str, detail: &str) -> String {
    let label_json = json_escape(label);
    let detail_json = json_escape(detail);
    format!(
        "{{\"ok\":false,\"checks\":[{{\"id\":\"foyer-cli\",\"label\":\"{label_json}\",\"ok\":false,\"severity\":\"required\",\"detail\":\"{detail_json}\"}}]}}"
    )
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Locate the `foyer` CLI binary, preferring the sibling next to
/// our own executable (which is how install.sh lays things out)
/// and falling back to PATH for `cargo run` dev launches.
fn find_foyer_binary() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("foyer")))
        .filter(|p| p.is_file())
        .or_else(|| which("foyer"))
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

/// Open a URL in the user's default browser. Cross-platform best-
/// effort wrapper around the OS's open command. Errors propagate so
/// the caller can log them but we don't surface them to the user —
/// the picker already shows the URL plainly so they can copy-paste.
fn open_in_browser(url: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    let cmd = ("open", vec![url]);
    #[cfg(target_os = "windows")]
    let cmd = ("cmd", vec!["/C", "start", "", url]);
    #[cfg(all(unix, not(target_os = "macos")))]
    let cmd = ("xdg-open", vec![url]);
    let status = std::process::Command::new(cmd.0)
        .args(&cmd.1)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .with_context(|| format!("spawn {} for url", cmd.0))?;
    if !status.success() {
        return Err(anyhow::anyhow!("{} exited {status}", cmd.0));
    }
    Ok(())
}

/// Download an Ardour .dmg, mount it, copy the contained .app into
/// `~/Applications/`, eject the disk image. macOS-only; on any other
/// OS this returns an error.
///
/// Scaffolding: the iframe-based extraction in `ardour_download.html`
/// is best-effort and silently no-ops when Ardour changes their
/// download flow. When that scaffolding works the URL lands here;
/// when it doesn't the user falls back to "Just the free demo"
/// (default-browser route) and does the drag-into-Applications by
/// hand. Either way the picker's "Re-check after installing" button
/// reruns the doctor + flips the host page back into the
/// native-Ardour ready state.
fn install_ardour_dmg(url: &str) -> Result<()> {
    if !cfg!(target_os = "macos") {
        return Err(anyhow::anyhow!(".dmg install is macOS-only"));
    }
    // Save to a temp file. We can't pull `reqwest` into foyer-desktop
    // without a non-trivial dep churn (it's a workspace-level dep but
    // the desktop binary doesn't link it today); curl is on every
    // Mac and gives us a progress bar + redirect handling for free.
    let tmp_dir = tempdir_for_download()?;
    let dmg_path = tmp_dir.join("ardour.dmg");
    tracing::info!("downloading {url} → {}", dmg_path.display());
    let status = std::process::Command::new("curl")
        .args(["-fL", "--retry", "3", "-o"])
        .arg(&dmg_path)
        .arg(url)
        .status()
        .context("spawn curl for dmg download")?;
    if !status.success() {
        return Err(anyhow::anyhow!("curl exited {status} downloading {url}"));
    }

    // Mount the dmg. hdiutil's `-mountpoint` lets us pin where it
    // lands so the copy step is deterministic.
    let mount_dir = tmp_dir.join("mnt");
    std::fs::create_dir_all(&mount_dir)?;
    let status = std::process::Command::new("hdiutil")
        .args(["attach", "-nobrowse", "-mountpoint"])
        .arg(&mount_dir)
        .arg(&dmg_path)
        .status()
        .context("hdiutil attach")?;
    if !status.success() {
        return Err(anyhow::anyhow!("hdiutil attach exited {status}"));
    }

    // Find the .app inside. Most Ardour DMGs ship a single .app at
    // the root, occasionally beside an "Applications" symlink. We
    // pick the first .app we see.
    let app_src = std::fs::read_dir(&mount_dir)?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().and_then(|s| s.to_str()) == Some("app"))
        .ok_or_else(|| anyhow::anyhow!("no .app found inside DMG"))?;

    // Copy to ~/Applications (no sudo, no system-wide). The user can
    // drag into /Applications later if they want it global.
    let home = dirs_home().ok_or_else(|| anyhow::anyhow!("no $HOME"))?;
    let target_parent = home.join("Applications");
    std::fs::create_dir_all(&target_parent)?;
    let target = target_parent.join(
        app_src
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("dmg .app has no file name"))?,
    );
    // ditto preserves the bundle's resource forks + extended attrs;
    // a plain cp -R drops them and Gatekeeper refuses to launch the
    // resulting bundle.
    let status = std::process::Command::new("ditto")
        .arg(&app_src)
        .arg(&target)
        .status()
        .context("ditto for app copy")?;
    if !status.success() {
        return Err(anyhow::anyhow!("ditto exited {status}"));
    }

    // Detach the dmg. If it fails (eject is rejected by Finder
    // sometimes), best-effort — the temp dir will be cleaned up on
    // reboot and the .app is already in place.
    let _ = std::process::Command::new("hdiutil")
        .args(["detach", "-force"])
        .arg(&mount_dir)
        .status();

    tracing::info!("installed Ardour at {}", target.display());
    Ok(())
}

fn tempdir_for_download() -> Result<std::path::PathBuf> {
    let base = std::env::temp_dir();
    let dir = base.join(format!("foyer-ardour-dl-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
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
            //
            // * **macOS (native-Ardour mode)**: Ardour is a Cocoa
            //   app — SIGTERM works, but `osascript … quit` routes
            //   through Cocoa's NSApplication terminate handler so
            //   the unsaved-changes dialog still appears if the
            //   user has edits. We try AppleScript first, then
            //   SIGTERM as a fallback if Ardour hasn't gone away.
            //   Best-effort: if Ardour is hung in a save dialog
            //   the wait loop below catches the leak and escalates.
            // * **Linux / docker child**: SIGTERM. `foyer docker`
            //   traps it, sends SIGTERM into the container's PID 1,
            //   and the runtime's `--rm` cleans up.
            // * **Windows**: no SIGTERM equivalent for arbitrary
            //   children (CTRL_BREAK_EVENT only crosses console
            //   groups, which we don't share). Fall back to the
            //   std Child::kill (TerminateProcess) immediately.
            //   Docker Desktop reaps the container's --rm out of
            //   band, so abrupt termination of the `foyer docker`
            //   shim is OK.
            #[cfg(target_os = "macos")]
            {
                // Best-effort polite quit. `osascript` is on the
                // path of every Mac. If Ardour isn't actually the
                // bundle name (user installed Ardour10.app, future
                // version), the script no-ops and we fall through
                // to SIGTERM below.
                let _ = std::process::Command::new("osascript")
                    .args(["-e", "tell application \"Ardour9\" to quit"])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
                // Give Ardour a beat to wind down before we SIGTERM.
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            #[cfg(unix)]
            unsafe {
                libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
            }
            #[cfg(windows)]
            {
                let _ = child.kill();
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
