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
use foyer_config::{self as cfg, DesktopMode, DockerMode, DockerNetwork};
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
    // Clean baseline — we previously stacked half a dozen
    // `WEBKIT_DISABLE_*` env vars + `HardwareAccelerationPolicy::Never`
    // in pursuit of xpra compatibility, and the WebView still rendered
    // as a solid white surface (DOM populated, devtools work,
    // context menus paint — only the page content area is blank).
    // Those layered workarounds were the *cause*, not the cure: with
    // hardware acceleration policy forced to Never on webkit2gtk 2.4x,
    // the page rendering surface allocates but never commits, while
    // peripheral GTK widgets (inspector, menu) keep painting through
    // their own paths. See [docs/DECISIONS.md] follow-up.
    //
    // Strategy: trust WebKit's default acceleration pipeline. The
    // only env var we still want is `GDK_BACKEND=x11` because GTK
    // auto-pick of Wayland fails hard under xpra.
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
            run_host(Backend::Stub, None, "127.0.0.1:0".parse()?, fullscreen)
        }
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
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("Foyer Studio — first launch")
        .with_inner_size(tao::dpi::LogicalSize::new(640.0, 420.0))
        .with_resizable(false)
        .build(&event_loop)?;
    let builder = WebViewBuilder::new()
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
    let _ = webview; // hold the webview alive for the event loop

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

#[derive(Debug, Clone)]
enum PickResult {
    Host,
    Docker(DockerWizardChoice),
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
}

fn default_host_port() -> u16 {
    3838
}

/// Translate the raw IPC body the WebView's `window.ipc.postMessage`
/// hands us into one of the discrete picker outcomes. Anything
/// unrecognised returns `None` so the IPC handler can log it.
fn parse_ipc_pick(body: &str) -> Option<PickResult> {
    if body == "host" {
        return Some(PickResult::Host);
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
        PickResult::Host => {
            desktop.mode = Some(DesktopMode::Host);
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
            if matches!(choice.mode, DockerMode::Netjack) {
                dcfg.netjack_host = choice.netjack_host.clone();
                dcfg.netjack_port = choice.netjack_port;
            }
            config.docker = Some(dcfg);
        }
    }
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

/// Build the `window.__doctor = {...}` JSON blob the picker page
/// reads to render its three audio-mode cards. We shell out to
/// `foyer docker --<mode> --doctor --json` once per mode in
/// parallel; if `foyer` itself isn't on PATH or fails, we emit a
/// stub blob with every mode flagged as `ok: false` and the error
/// inlined so the user sees what went wrong without a console.
fn build_doctor_payload() -> String {
    let foyer_bin = find_foyer_binary();
    let modes = ["integrated", "jack", "netjack"];
    let handles: Vec<_> = modes
        .iter()
        .map(|m| {
            let bin = foyer_bin.clone();
            let mode = (*m).to_string();
            std::thread::spawn(move || (mode.clone(), doctor_one(bin.as_deref(), &mode)))
        })
        .collect();

    let mut pairs: Vec<String> = Vec::with_capacity(3);
    for h in handles {
        let (mode, json) = h
            .join()
            .unwrap_or_else(|_| ("?".into(), "{\"ok\":false,\"checks\":[]}".into()));
        pairs.push(format!("\"{mode}\": {json}"));
    }
    format!("{{ {} }}", pairs.join(", "))
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
