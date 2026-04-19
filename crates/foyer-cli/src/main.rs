//! Foyer Studio CLI.
//!
//! `foyer serve` starts the WebSocket server with a selected backend. M2 only supports
//! the stub backend; the `host` backend ships in M3.

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use foyer_backend_host::{discovery, HostBackend};
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

        /// Path to the shim's Unix domain socket. If omitted with
        /// `--backend=host`, we scan `$XDG_RUNTIME_DIR/foyer/` (or
        /// `/tmp/foyer/`) for advertised shims and pick the single live one.
        /// Use `--list-shims` to see what's discovered without connecting.
        #[arg(long)]
        socket: Option<PathBuf>,

        /// Print discovered shims and exit without starting the server.
        /// Useful when multiple Ardour instances are running.
        #[arg(long, default_value_t = false)]
        list_shims: bool,

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
            list_shims,
            web_root,
            jail,
        } => {
            if list_shims {
                return list_available_shims();
            }
            serve(backend, listen, socket, web_root, jail).await
        }
    }
}

fn list_available_shims() -> Result<()> {
    let shims = discovery::scan();
    if shims.is_empty() {
        println!("no live shims found in {}", discovery::discovery_dir().display());
        return Ok(());
    }
    println!("Available shims (most recent first):");
    for s in shims {
        println!(
            "  {}  pid={} session={:?} started={}",
            s.socket.display(),
            s.pid,
            s.session,
            s.started,
        );
    }
    Ok(())
}

async fn serve(
    backend: Backend,
    listen: SocketAddr,
    socket: Option<PathBuf>,
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
            let resolved = match socket {
                Some(p) => p,
                None => discovery::pick_single()
                    .map_err(|e| anyhow!(e))
                    .with_context(|| "no --socket given and discovery failed")?
                    .socket,
            };
            let backend = HostBackend::connect(resolved.clone())
                .await
                .with_context(|| format!("connect to shim at {}", resolved.display()))?;
            tracing::info!("connected to shim at {}", resolved.display());
            let server = Server::new(backend);
            server.run(config).await?;
        }
    }
    Ok(())
}
