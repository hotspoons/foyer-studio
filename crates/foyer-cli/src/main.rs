//! Foyer Studio CLI.
//!
//! `foyer serve` starts the WebSocket server with a selected backend. M2 only supports
//! the stub backend; the `host` backend ships in M3.

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use foyer_backend_host::HostBackend;
use foyer_backend_stub::StubBackend;
use foyer_server::{Config, Server};

#[derive(Parser)]
#[command(name = "foyer", version, about = "Foyer Studio runtime")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the WebSocket server + UI.
    Serve {
        /// Backend to attach. `stub` is in-memory; `host` connects to a shim via UDS.
        #[arg(long, value_enum, default_value_t = Backend::Stub)]
        backend: Backend,

        /// Address to listen on.
        #[arg(long, default_value = "127.0.0.1:3838")]
        listen: SocketAddr,

        /// Path to the shim's Unix domain socket (required for `--backend=host`).
        #[arg(long, default_value = "/tmp/foyer.sock")]
        socket: PathBuf,

        /// Directory of static web assets. Defaults to `./web` if it exists.
        #[arg(long)]
        web_root: Option<PathBuf>,

        /// Filesystem jail for the session picker. When set, clients can
        /// browse only under this directory. When unset, browsing is disabled.
        #[arg(long)]
        jail: Option<PathBuf>,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum Backend {
    Stub,
    Host,
}

#[tokio::main]
async fn main() -> Result<()> {
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
            listen,
            socket,
            web_root,
            jail,
        } => serve(backend, listen, socket, web_root, jail).await,
    }
}

async fn serve(
    backend: Backend,
    listen: SocketAddr,
    socket: PathBuf,
    web_root: Option<PathBuf>,
    jail: Option<PathBuf>,
) -> Result<()> {
    let web_root = web_root.or_else(|| {
        let candidate = PathBuf::from("./web");
        candidate.exists().then_some(candidate)
    });
    let config = Config {
        listen,
        web_root,
        jail_root: jail.clone(),
    };

    match backend {
        Backend::Stub => {
            let mut b = StubBackend::new();
            if let Some(root) = jail {
                b = b.with_jail(root);
            }
            let server = Server::new(b);
            server.run(config).await?;
        }
        Backend::Host => {
            let backend = HostBackend::connect(socket.clone())
                .await
                .with_context(|| format!("connect to shim at {}", socket.display()))?;
            let server = Server::new(backend);
            server.run(config).await?;
        }
    }
    Ok(())
}
