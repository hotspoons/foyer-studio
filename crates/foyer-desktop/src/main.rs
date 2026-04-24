//! Foyer Studio desktop shell.
//!
//! Two modes, one binary:
//!
//! **Host mode** (on the DAW machine): starts `foyer-server` in-process with
//! either the stub backend or a live shim connection, then opens a system
//! WebView pointing at the embedded UI.
//!
//!   `foyer-desktop serve --backend=host --socket=/tmp/foyer.sock`
//!   `foyer-desktop serve --backend=stub`
//!
//! **Client mode** (remote control surface): opens a WebView pointing at a
//! remote `foyer-cli` over WebSocket. Does not start a server of its own.
//!
//!   `foyer-desktop connect --url=ws://studio.local:3838/`
//!
//! Full-screen-first UX: resizable window, frameless toggle, no menubar.

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use foyer_backend_host::HostBackend;
use foyer_backend_stub::StubBackend;
use foyer_server::{Config, Server};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::{Fullscreen, WindowBuilder};
use wry::WebViewBuilder;

#[derive(Parser)]
#[command(name = "foyer-desktop", version, about = "Foyer Studio native shell")]
struct Cli {
    #[command(subcommand)]
    command: Command,
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
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum Backend {
    Stub,
    Host,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,foyer_server=debug".into()),
        )
        .init();

    let cli = Cli::parse();
    match cli.command {
        Command::Serve {
            backend,
            socket,
            listen,
            fullscreen,
        } => run_host(backend, socket, listen, fullscreen),
        Command::Connect { url, fullscreen } => run_client(url, fullscreen),
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

    run_webview(url, fullscreen, Some(rt))
}

fn run_client(url: String, fullscreen: bool) -> Result<()> {
    run_webview(url, fullscreen, None)
}

fn run_webview(url: String, fullscreen: bool, _rt: Option<tokio::runtime::Runtime>) -> Result<()> {
    let event_loop = EventLoopBuilder::<()>::with_user_event().build();
    let mut wb = WindowBuilder::new()
        .with_title("Foyer Studio")
        .with_inner_size(tao::dpi::LogicalSize::new(1440.0, 900.0));
    if fullscreen {
        wb = wb.with_fullscreen(Some(Fullscreen::Borderless(None)));
    }
    let window = wb.build(&event_loop)?;

    let _webview = WebViewBuilder::new(&window).with_url(&url).build()?;

    tracing::info!("opened WebView at {url}");
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
