// SPDX-License-Identifier: Apache-2.0
//! Foyer Studio CLI.
//!
//! `foyer serve` starts the WebSocket server. The backend is chosen from
//! `config.yaml` (see `foyer-config`) unless the caller passes `--backend`
//! on the command line. On first run the config is seeded with a stub
//! (no-DAW demo mode) and an Ardour entry — the user can add more later.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use foyer_backend::Backend;
use foyer_backend_host::{discovery, HostBackend};
use foyer_backend_stub::StubBackend;
use foyer_config::{self as cfg, BackendKind, Config};
use foyer_schema::BackendInfo;
use foyer_server::{BackendSpawner, Config as ServerConfig, Server};

mod ardour_xml;
mod docker_cmd;
mod shim_install;

use ardour_xml::{
    ardour_had_existing_session, ensure_foyer_shim_active, patch_ardour_session_sample_rate,
};

#[derive(Parser)]
#[command(name = "foyer", version, about = "Foyer Studio runtime")]
struct Cli {
    /// Override the config file location. Defaults to
    /// $XDG_DATA_HOME/foyer/config.yaml.
    #[arg(long, global = true)]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
// Each `Serve` flag surfaces as its own field per clap's derive idiom;
// boxing them to placate `large_enum_variant` would just push the
// fan-out one layer deeper. The Configure variant is small but rarely
// constructed, so the size delta vs. Serve is fine in practice.
#[allow(clippy::large_enum_variant)]
enum Command {
    /// Run the WebSocket server + UI.
    Serve {
        /// Pick a backend by its `id` from config.yaml. Defaults to
        /// `default_backend` (which is `stub` on a fresh install).
        #[arg(long)]
        backend: Option<String>,

        /// Project to open on launch. For Ardour this becomes an argv to
        /// the child process; for the stub it flips the session into
        /// "loaded" state. If omitted, the browser shows a picker.
        #[arg(long)]
        project: Option<PathBuf>,

        /// Address to listen on. Overrides `server.listen` from
        /// config.yaml when set; falls back to that value, else the
        /// built-in `127.0.0.1:3838` default.
        #[arg(long)]
        listen: Option<SocketAddr>,

        /// Explicit shim socket path. Only honored with `kind=ardour`.
        /// If omitted and `--project` is set, the configured executable
        /// is spawned and we wait for its shim to advertise.
        #[arg(long)]
        socket: Option<PathBuf>,

        /// Print discovered shims and exit.
        #[arg(long, default_value_t = false)]
        list_shims: bool,

        /// Directory of static web assets. Defaults to `./web`.
        #[arg(long)]
        web_root: Option<PathBuf>,

        /// Extra web-asset directories layered ON TOP of `--web-root`.
        /// Repeat to add more. Point this at a sibling dir holding
        /// your own UI variant(s) so you don't have to edit the main
        /// repo's `web/` to develop against Foyer. The server checks
        /// overlays first (earlier flag = higher priority), falls
        /// back to `--web-root`, and `/variants.json` scans every
        /// root so any `ui-*/package.js` under an overlay appears
        /// automatically in boot.js. See `DEVELOPMENT.md`.
        #[arg(long = "web-overlay", value_name = "PATH")]
        web_overlays: Vec<PathBuf>,

        /// Filesystem jail for the session picker. Overrides the config
        /// `launcher.jail`. Pass an empty string to opt out of jailing.
        #[arg(long)]
        jail: Option<PathBuf>,

        /// PEM-encoded TLS certificate (chain). Enables HTTPS / WSS
        /// when supplied together with `--tls-key`. Required for
        /// mobile browsers on LAN IPs — AudioWorklet (used by the
        /// mixer's Listen button) only loads in a secure context.
        /// Self-signed certs work; the browser shows a one-time
        /// warning that the user accepts.
        #[arg(long, requires = "tls_key")]
        tls_cert: Option<PathBuf>,

        /// PEM-encoded TLS private key matching `--tls-cert`.
        #[arg(long, requires = "tls_cert")]
        tls_key: Option<PathBuf>,

        /// Make the stub backend emit its 440 Hz reference test tone
        /// on egress streams. Off by default — without this flag the
        /// stub is silent until a real DAW backend takes over, which
        /// is what most users want when they hit "Listen" with no
        /// project loaded. When enabled here, also overrides
        /// `backends[id=stub].stub_test_tone` from config.yaml.
        #[arg(long, default_value_t = false)]
        stub_test_tone: bool,

        /// Engine sample rate, in Hz. Overrides `sample_rate` from the
        /// resolved backend config. Falls through to the schema
        /// default (`foyer_schema::DEFAULT_SAMPLE_RATE`, 48k) when
        /// nothing is set anywhere. The `FOYER_SAMPLE_RATE` env var
        /// is honored too — it slots in below this flag and above
        /// the config field. Today only the stub honors this; the
        /// Ardour shim reports whatever rate libardour negotiates
        /// with JACK.
        #[arg(long, value_name = "HZ")]
        sample_rate: Option<u32>,

        /// Override the Ardour executable path. Wins over `executable`
        /// in the backend config and the PATH probe. Useful when you
        /// have multiple Ardour versions installed and want a specific
        /// one (e.g., `--ardour-path /opt/Ardour-9.5/bin/ardour9`).
        /// Ignored when `--backend stub`.
        #[arg(long, value_name = "BIN")]
        ardour_path: Option<PathBuf>,

        /// Upstream OpenAI-compatible endpoint base for the agent
        /// (no trailing `/chat/completions`). Wins over
        /// `FOYER_AGENT_UPSTREAM_ENDPOINT`, `agent.upstream_endpoint`
        /// in `config.yaml`, and the persisted store. Non-persisting —
        /// the FAB-saved value is restored on the next boot when this
        /// flag is dropped.
        #[arg(long, value_name = "URL")]
        agent_upstream_endpoint: Option<String>,

        /// Upstream model id for the agent. Same precedence chain as
        /// `--agent-upstream-endpoint`.
        #[arg(long, value_name = "ID")]
        agent_upstream_model: Option<String>,

        /// API key for the agent's upstream endpoint. Prefer the
        /// `FOYER_AGENT_UPSTREAM_API_KEY` env var so the secret
        /// doesn't end up in shell history.
        #[arg(long, value_name = "KEY")]
        agent_upstream_api_key: Option<String>,

        /// API key REQUIRED on Foyer's exposed OpenAI-compatible
        /// endpoint at `/v1/*`. Leave unset (and unset the env /
        /// config field) to leave the surface open. Same precedence
        /// chain as the upstream fields.
        #[arg(long, value_name = "KEY")]
        agent_api_key: Option<String>,
    },
    /// Run Foyer Studio in a container. Wraps docker / podman /
    /// nerdctl behind a single command with audio-mode presets.
    /// Defaults from `config.yaml`'s `docker` section.
    Docker {
        /// Dummy-backend mode — container needs no host audio system.
        /// Default when no mode flag is set. Mutually exclusive with
        /// `--jack` / `--netjack`.
        #[arg(long, conflicts_with_all = ["jack", "netjack"])]
        integrated: bool,
        /// Bind-mount the host's JACK socket dir into the container.
        /// Linux only. Mutually exclusive with `--integrated` / `--netjack`.
        #[arg(long, conflicts_with_all = ["integrated", "netjack"])]
        jack: bool,
        /// Connect to a NetJACK server over TCP. Set
        /// `FOYER_NETJACK_HOST` + `FOYER_NETJACK_PORT` env vars to
        /// point at it. Mutually exclusive with `--integrated` / `--jack`.
        #[arg(long, conflicts_with_all = ["integrated", "jack"])]
        netjack: bool,
        /// Container image. Default `ghcr.io/hotspoons/foyer-studio:latest`.
        /// Pin to a specific snapshot tag (e.g.
        /// `ghcr.io/hotspoons/foyer-studio:snapshot-abc1234`) for
        /// reproducible runs.
        #[arg(long, value_name = "IMG")]
        image: Option<String>,
        /// Container runtime: `podman`, `docker`, or `nerdctl`. Auto-
        /// picked from PATH when unset.
        #[arg(long, value_name = "BIN")]
        runtime: Option<String>,
        /// Host port to publish the container's 3838 on. Default 3838.
        #[arg(long, value_name = "PORT")]
        host_port: Option<u16>,
        /// Detach instead of streaming logs.
        #[arg(short, long, default_value_t = false)]
        detach: bool,
        /// Print the assembled command without running it.
        #[arg(long, default_value_t = false)]
        dry_run: bool,
    },
    /// Print the resolved config and exit.
    Backends,
    /// Print the path to config.yaml (creating it if it doesn't exist).
    ConfigPath,
    /// Scan the host for DAW executables and write detected paths into
    /// config.yaml. Backends with an already-set executable are left alone
    /// unless `--force` is given. Today only the Ardour kind has a scanner.
    Configure {
        /// Only configure the named backend id (default: all ardour-kind
        /// entries).
        #[arg(long)]
        backend: Option<String>,
        /// Overwrite `executable` even if it's already set.
        #[arg(long, default_value_t = false)]
        force: bool,
        /// Print what would change without writing.
        #[arg(long, default_value_t = false)]
        dry_run: bool,
    },
    /// Snapshot an Ardour project into a reproducible OCI image.
    Snapshot {
        /// Path to the Ardour session directory (the folder containing
        /// the `.ardour` file).
        project_dir: PathBuf,

        /// Explicit DAW executable to snapshot. Auto-detected from
        /// $PATH when omitted.
        #[arg(long)]
        daw_exec: Option<PathBuf>,

        /// Output directory for the build context and plan JSON.
        #[arg(long, short = 'o', default_value = ".")]
        out_dir: PathBuf,

        /// OCI image tag (e.g. `my-project:latest`).
        #[arg(long, short = 't', default_value = "foyer-snapshot:latest")]
        tag: String,

        /// Build the image immediately with `docker buildx`.
        #[arg(long, default_value_t = false)]
        build: bool,

        /// Produce a `.tar.gz` loadable with `docker load`.
        #[arg(long, default_value_t = false)]
        tarball: bool,

        /// Push the built image to a registry.
        #[arg(long, default_value_t = false)]
        push: bool,

        /// Registry prefix (e.g. `ghcr.io/user`). The tag becomes
        /// `<registry>/<tag>` when this is set.
        #[arg(long)]
        registry: Option<String>,
    },
    /// Restore `<Script>` blocks that the upload-time scrubber
    /// quarantined into `<!-- foyer:scrubbed:... -->` comments.
    /// Re-introduces auto-executing Lua, so this is OFF by default
    /// over the network — operator must explicitly opt into it on a
    /// trusted desktop. Pass `-` for stdin / stdout streaming.
    ScrubRestore {
        /// Source `.ardour` file (or `-` for stdin).
        input: PathBuf,
        /// Destination — defaults to overwriting `input` in place.
        /// Pass `-` for stdout.
        #[arg(long, short = 'o')]
        output: Option<PathBuf>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                // Default: info for our crates, but mute the chatty
                // upstream libraries that flood the log without
                // surfacing anything actionable:
                //   - symphonia: "ignoring unknown chunk: tag=JUNK"
                //     fires at WARN per-chunk on multi-region zoom.
                //   - chromiumoxide: "WS Invalid message: data did
                //     not match any variant of untagged enum Message"
                //     — fires on every CDP event variant the SDK
                //     doesn't recognise. Harmless, just noise from
                //     headless-render's chromium driver.
                "info,symphonia_format_riff=warn,symphonia_core=warn,\
                 chromiumoxide::handler=error,\
                 chromiumoxide::conn=error"
                    .into()
            }),
        )
        .init();

    let cli = Cli::parse();

    let config = load_config(cli.config.as_deref())?;

    match cli.command {
        Command::Docker {
            integrated,
            jack,
            netjack,
            image,
            runtime,
            host_port,
            detach,
            dry_run,
        } => {
            let mode_override = if integrated {
                Some(cfg::DockerMode::Integrated)
            } else if jack {
                Some(cfg::DockerMode::Jack)
            } else if netjack {
                Some(cfg::DockerMode::Netjack)
            } else {
                None
            };
            docker_cmd::run(
                &config,
                docker_cmd::DockerCmdArgs {
                    mode_override,
                    image_override: image,
                    runtime_override: runtime,
                    host_port_override: host_port,
                    detach,
                    dry_run,
                },
            )
        }
        Command::Backends => {
            println!("config: {}", config_path(cli.config.as_deref())?.display());
            println!("default_backend: {}", config.default_backend);
            for b in &config.backends {
                let disabled = if b.enabled { "" } else { " (disabled)" };
                let exec = b
                    .executable
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "—".into());
                println!("  id={} kind={:?}{} exec={}", b.id, b.kind, disabled, exec);
            }
            Ok(())
        }
        Command::ConfigPath => {
            println!("{}", config_path(cli.config.as_deref())?.display());
            Ok(())
        }
        Command::Configure {
            backend,
            force,
            dry_run,
        } => configure(
            cli.config.as_deref(),
            config,
            backend.as_deref(),
            force,
            dry_run,
        ),
        Command::Snapshot {
            project_dir,
            daw_exec,
            out_dir,
            tag,
            build,
            tarball,
            push,
            registry,
        } => {
            let args = foyer_snapshot::cli::SnapshotArgs {
                project_dir,
                daw_exec,
                out_dir,
                tag,
                build,
                tarball,
                push,
                registry,
            };
            foyer_snapshot::cli::run(&args).await
        }
        Command::ScrubRestore { input, output } => scrub_restore(&input, output.as_deref()),
        Command::Serve {
            backend,
            project,
            listen,
            socket,
            list_shims,
            web_root,
            web_overlays,
            jail,
            tls_cert,
            tls_key,
            stub_test_tone,
            sample_rate,
            ardour_path,
            agent_upstream_endpoint,
            agent_upstream_model,
            agent_upstream_api_key,
            agent_api_key,
        } => {
            if list_shims {
                return list_available_shims();
            }
            // TLS: CLI pair > config.yaml pair > none. CLI flags
            // must appear together; clap's `requires` enforces that
            // at parse time. Config.yaml must supply both paths to
            // enable TLS; one without the other is a config error.
            let tls = match (tls_cert.clone(), tls_key.clone()) {
                (Some(cert), Some(key)) => Some(foyer_server::TlsConfig { cert, key }),
                (None, None) => match (&config.server.tls_cert, &config.server.tls_key) {
                    (Some(cert), Some(key)) => Some(foyer_server::TlsConfig {
                        cert: cert.clone(),
                        key: key.clone(),
                    }),
                    (None, None) => None,
                    _ => anyhow::bail!(
                        "config.yaml server.tls_cert and server.tls_key must be set together"
                    ),
                },
                _ => anyhow::bail!("--tls-cert and --tls-key must be passed together"),
            };
            // Listen: CLI flag > config.yaml server.listen > default.
            let listen = if let Some(l) = listen {
                l
            } else if let Some(cfg_listen) = config.server.listen.as_deref() {
                cfg_listen
                    .parse::<SocketAddr>()
                    .with_context(|| format!("config.yaml server.listen = {cfg_listen:?}"))?
            } else {
                "127.0.0.1:3838"
                    .parse()
                    .expect("hardcoded default socket addr is statically valid")
            };
            serve(
                config,
                backend,
                project,
                listen,
                socket,
                web_root,
                web_overlays,
                jail,
                tls,
                stub_test_tone,
                sample_rate,
                ardour_path,
                agent_upstream_endpoint,
                agent_upstream_model,
                agent_upstream_api_key,
                agent_api_key,
            )
            .await
        }
    }
}

/// Re-inflate `<!-- foyer:scrubbed:... -->` comments that the upload
/// scrubber emitted in place of `<Script>` blocks. Refuses to read
/// from `/dev/stdin` if it's a TTY — paste-by-accident isn't a
/// recovery flow we want to support, and a hung CLI waiting for
/// stdin in the wrong mode is a bad UX.
fn scrub_restore(input: &Path, output: Option<&Path>) -> Result<()> {
    use std::io::{Read, Write};
    let bytes = if input == Path::new("-") {
        let mut buf = Vec::new();
        std::io::stdin()
            .read_to_end(&mut buf)
            .context("read stdin")?;
        buf
    } else {
        std::fs::read(input).with_context(|| format!("read {}", input.display()))?
    };
    let restored = foyer_server::restore_quarantined_xml(&bytes)
        .map_err(|e| anyhow!("restore failed: {e}"))?;
    let dest = output.unwrap_or(input);
    let dest_label = if dest == Path::new("-") {
        std::io::stdout()
            .write_all(&restored)
            .context("write stdout")?;
        "<stdout>".to_string()
    } else {
        std::fs::write(dest, &restored).with_context(|| format!("write {}", dest.display()))?;
        dest.display().to_string()
    };
    eprintln!(
        "scrub-restore: wrote {} bytes to {dest_label}",
        restored.len()
    );
    Ok(())
}

fn configure(
    explicit_path: Option<&std::path::Path>,
    mut config: Config,
    only_backend: Option<&str>,
    force: bool,
    dry_run: bool,
) -> Result<()> {
    let path = config_path(explicit_path)?;
    let mut touched = 0usize;
    let mut missing = 0usize;

    for b in &mut config.backends {
        if let Some(id) = only_backend {
            if b.id != id {
                continue;
            }
        }
        if !matches!(b.kind, BackendKind::Ardour) {
            // No scanner for other kinds (yet). The stub doesn't need an
            // executable, and future DAWs will grow their own detection.
            continue;
        }
        if let Some(existing) = b.executable.as_ref().filter(|_| !force) {
            println!(
                "  id={} kind={:?} exec={} (kept — pass --force to re-detect)",
                b.id,
                b.kind,
                existing.display(),
            );
            continue;
        }
        // Pass the shim's compile-time target so a $PATH `/usr/bin/ardour`
        // that doesn't match the major.minor we built against gets
        // skipped in favor of an in-repo source-built binary. Without
        // this, an apt-installed 9.2 wrapper on a dev box wins over
        // the fresh 9.5 build the user just ran `just ardour ensure`
        // for, and the launched session ABI-mismatches the shim.
        // `FOYER_ARDOUR_VERSION` is set by `crates/foyer-cli/build.rs`
        // from the same env var the Ardour source clone uses.
        match cfg::detect_ardour_executable_for(Some(env!("FOYER_ARDOUR_VERSION"))) {
            Some(found) => {
                let prev = b.executable.as_ref().map(|p| p.display().to_string());
                b.executable = Some(found.clone());
                touched += 1;
                match prev {
                    Some(old) if old != found.display().to_string() => {
                        println!("  id={} exec={} → {}", b.id, old, found.display());
                    }
                    Some(_) => {
                        println!("  id={} exec={} (unchanged)", b.id, found.display());
                    }
                    None => {
                        println!("  id={} exec=— → {}", b.id, found.display());
                    }
                }
            }
            None => {
                missing += 1;
                println!(
                    "  id={} no Ardour binary found on $PATH, in /Applications, \
                     or in $FOYER_ARDOUR_BUILD_ROOT (default /workspaces/ardour)",
                    b.id,
                );
            }
        }
    }

    if touched == 0 && missing == 0 {
        println!("(nothing to configure — no matching backends)");
        return Ok(());
    }
    if dry_run {
        println!("dry-run: no changes written");
        return Ok(());
    }
    if touched > 0 {
        cfg::save_at(&config, &path)?;
        println!("wrote {}", path.display());
    }
    Ok(())
}

fn config_path(explicit: Option<&std::path::Path>) -> Result<PathBuf> {
    match explicit {
        Some(p) => Ok(p.to_path_buf()),
        None => cfg::config_path(),
    }
}

fn load_config(explicit: Option<&std::path::Path>) -> Result<Config> {
    let path = config_path(explicit)?;
    cfg::load_or_seed_at(&path).with_context(|| format!("load config from {}", path.display()))
}

fn list_available_shims() -> Result<()> {
    let shims = discovery::scan();
    if shims.is_empty() {
        println!(
            "no live shims found in {}",
            discovery::discovery_dir().display()
        );
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

// Too-many-arguments: these all surface as independent CLI flags and
// squashing them into a struct would just push the same fan-out one
// layer down. Handler fn is the natural call site — live with the
// count.
#[allow(clippy::too_many_arguments)]
async fn serve(
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
    // Resolve backend: CLI override wins, then config default.
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
    // embedded shim into the user's surfaces directory. Skipped when
    // an explicit `--socket` was passed (attach-to-running mode — the
    // shim is already loaded; Ardour binary is moot). Skipped for
    // `--backend stub`, of course. Override precedence:
    //   1. `--ardour-path`
    //   2. backend config `executable` field
    //   3. PATH probe / well-known paths
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

    // Resolve jail: --jail wins; empty-string opts out; fall back to config.
    let jail = match jail_override {
        Some(p) if p.as_os_str().is_empty() => None,
        Some(p) => Some(p),
        None => config.launcher.jail.clone(),
    };
    if let Some(j) = &jail {
        tracing::info!("session picker jailed to {}", j.display());
    }

    let web_root = resolve_web_root(web_root)?;
    // Overlays are taken literally — callers can stack any number of
    // sibling dirs on top of the base web_root to serve their own UI
    // variants without editing the main repo. We validate existence
    // up front so a typo fails fast instead of surfacing as a mystery
    // 404 on a specific asset.
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

    // Build the initial backend. For Ardour with an explicit --socket the
    // CLI can shortcut the spawner; for everything else we route through
    // the same CliSpawner the WS layer uses, so there's one code path.
    // Resolve the stub test-tone flag: CLI overrides config. The
    // CLI flag is always-on once specified; config is the per-user
    // persisted default. Plumbed into the spawner so every stub
    // instance (launcher mode + explicit `--backend stub` + runtime
    // backend swap to stub) sees the same answer.
    let stub_test_tone_resolved = stub_test_tone
        || config
            .backends
            .iter()
            .find(|b| b.id == "stub")
            .map(|b| b.stub_test_tone)
            .unwrap_or(false);

    // Resolve sample rate: CLI flag > FOYER_SAMPLE_RATE env > backend
    // config > schema default. We don't pull env via clap (would
    // require its `env` cargo feature) — std::env keeps the dep
    // surface tight and the precedence is the same. Picked from the
    // resolved backend so per-backend rate selection
    // (`--backend stub` while config sets a different rate per
    // backend) does the expected thing.
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

    // Launcher mode: the config default is Ardour, but we haven't been
    // given a project or a live shim socket. Boot an empty stub so the
    // picker UI is usable, then let the user's first project-click
    // drive `launch_project` — which spawns Ardour and swaps the backend
    // in place. The active_backend_id still reads as "ardour" so the
    // picker chip lights up accordingly.
    let is_launcher_mode =
        matches!(backend.kind, BackendKind::Ardour) && socket.is_none() && project.is_none();

    // Tracks the socket path of an auto-attached shim, when applicable.
    // Threaded into `Server::set_attached_socket` so `Command::ReattachOrphan`
    // knows the orphan's shim is already our implicit backend and can
    // adopt the existing connection instead of opening a duplicate
    // (the shim only services one IPC client at a time).
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
            // Prefer an already-running Ardour if its shim is advertised
            // — that lets `just run` attach to a DAW you launched by hand.
            // Fall through to launcher-mode stub if discovery finds nothing
            // OR if the advertised socket turns out to be stale (process
            // alive as a zombie, listener gone). `is_alive()` checks /proc
            // but can miss half-dead states; the connect attempt is the
            // authoritative liveness test.
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
                        // Sweep the broken pair so later discoveries don't
                        // keep tripping over it.
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
            // Bootstrap-time launch. The terminator (if any) is
            // dropped here — the initial backend lives outside the
            // SessionRegistry, so close-session escalation doesn't
            // apply. Subsequent `LaunchProject` commands go through
            // the swap path and DO register a terminator.
            //
            // No UI to prompt with at boot. If the session has a live
            // `.pending` (uncommitted crash state) we default to
            // Recover — the Ardour shim will auto-click the dialog
            // when it opens, so the user's unsaved work is preserved
            // without blocking the launch. The runtime `LaunchProject`
            // path lets the browser ask the user explicitly.
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
    // Attach the AI agent runtime. The store opens against
    // `$XDG_DATA_HOME/foyer/agent/`; if that path is unwritable we
    // surface a warning but keep the server up — the rest of Foyer
    // works without the agent.
    // Resolve agent config overrides: CLI > env > config.yaml. The
    // FAB-saved store value (loaded inside `attach_agent`) is the
    // baseline these layer ON TOP of via `apply_boot_overrides`, which
    // does NOT write back — pulling a flag or env var the next boot
    // restores the FAB-saved values.
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

    // Gate the exposed `/v1/*` surface regardless of whether the
    // agent runtime attached — the auth check needs to run even if
    // we end up serving a 503 inside.
    server.set_openai_proxy_api_key(agent_api_key.clone()).await;

    match server.attach_agent(config.mcp_proxies.clone()).await {
        Ok(runtime) => {
            runtime
                .set_prefer_headless_render(config.agent.prefer_headless_render)
                .await;
            // Apply the CLI/env/config-yaml chain — non-persisting so
            // a per-launch env-var override doesn't quietly rewrite
            // what the FAB user saved last.
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
            // When the operator has opted into headless rendering as
            // the preferred path, probe the host for chromium NOW so
            // a missing binary fires a loud, instructions-included
            // warning in the boot log instead of being a mystery the
            // user only discovers the first time the agent renders.
            if config.agent.prefer_headless_render {
                foyer_server::probe_headless_chromium_at_boot();
            }
        }
        Err(e) => tracing::warn!("agent attach failed ({e}) — FAB will be inert"),
    }
    // Load RBAC policy — seeded from the bundled default on first run.
    // Any IO error falls back to the bundled default so an ACL misfire
    // can't take the server down.
    match cfg::load_or_seed_roles() {
        Ok(roles) => server.load_roles_policy(roles).await,
        Err(e) => {
            tracing::warn!("could not load roles.yaml ({e}) — falling back to bundled defaults")
        }
    }
    // In launcher mode the backend that's actually running is the empty
    // stub, but the picker should treat the user's configured default as
    // the preferred target — so we report the config id as "active."
    server.set_active_backend(initial_backend_id).await;
    // Tell the server which shim socket the initial backend holds —
    // the orphan-reattach handler needs this to detect "this orphan
    // is the implicit backend you already auto-attached to" and adopt
    // the existing connection instead of opening a second IPC channel
    // (which would deadlock against the shim's single-client accept
    // loop). No-op when we didn't auto-attach (launcher / spawned
    // launches go through `swap_backend` which already populates the
    // sessions registry properly).
    if let Some(path) = attached_socket_path {
        server.set_attached_socket(path).await;
    }
    // Scan for orphaned shim sessions left behind by a previous Foyer
    // run that crashed (or was killed without closing its sessions).
    // The first client that connects will see these in their
    // SessionList/OrphansDetected payload and can offer reattach or
    // dismiss via the session switcher.
    server.scan_orphans().await;
    if is_launcher_mode {
        tracing::info!("launcher mode active — pick a project in the browser to launch Ardour");
    }
    server.run(server_cfg).await?;
    Ok(())
}

/// `BackendSpawner` impl — ties config, discovery, and child-process
/// spawning together so the WS layer can swap backends at runtime.
struct CliSpawner {
    config: Config,
    jail: Option<PathBuf>,
    /// Resolved value of CLI `--stub-test-tone` ORed with
    /// `backends[id=stub].stub_test_tone`. Stamped onto every stub
    /// instance the spawner builds.
    stub_test_tone: bool,
    /// Resolved engine sample rate (CLI / env > config > schema
    /// default). Stamped onto every stub instance. When launching an
    /// Ardour backend, `LaunchProject.sample_rate` (and optional per-
    /// backend `sample_rate` in config) patches **new** session XML only.
    sample_rate: u32,
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
        match cfg_backend.kind {
            BackendKind::Stub => {
                // Per-backend `sample_rate` config wins over the
                // CliSpawner-resolved rate when set, since this
                // launch path is per-id and the config field is
                // documented as a per-backend override. A per-launch
                // hint from `LaunchProject.sample_rate` wins over all
                // for stub/demo sessions.
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
                Ok(foyer_server::LaunchedBackend::new(Arc::new(b)))
            }
            BackendKind::Ardour => {
                let project = project_path
                    .ok_or_else(|| anyhow!("backend `{backend_id}` requires a project path"))?;
                let exec = cfg_backend.executable.clone().ok_or_else(|| {
                    anyhow!("backend `{backend_id}` has no executable in config.yaml")
                })?;
                // Resolve the (usually jail-relative) path that came in
                // over the wire into an absolute path so the spawner can
                // stat it + split `DIR SNAPSHOT_NAME` correctly.
                let abs = if project.is_absolute() {
                    project.to_path_buf()
                } else if let Some(root) = &self.jail {
                    root.join(project)
                } else {
                    project.to_path_buf()
                };
                let sr_hint = sample_rate.or(cfg_backend.sample_rate);
                let launch = launch_and_wait_for_shim(
                    &exec,
                    &cfg_backend.args,
                    &cfg_backend.env,
                    &abs,
                    sr_hint,
                    recover_crash,
                )
                .await?;
                let host = HostBackend::connect(launch.socket.clone())
                    .await
                    .with_context(|| format!("connect to shim at {}", launch.socket.display()))?;
                let mut launched = foyer_server::LaunchedBackend::with_process(
                    Arc::new(host),
                    Box::new(ChildProcess::new(launch.child)),
                );
                // MCP probe — fire-and-wait briefly. The MCPHttp surface
                // (Ardour ≥ post-9.2) starts its HTTP listener during
                // session-load, so the port is available within a few
                // seconds of the shim advertising. Builds that don't ship
                // mcp_http never bind the port; the probe times out and
                // we leave `mcp_endpoint = None`, which hides this
                // session from the `daw_proxy` tool's enumeration.
                if let Some(port) = launch.mcp_port {
                    let probe_timeout = std::time::Duration::from_secs(8);
                    if probe_mcp_http(port, probe_timeout).await {
                        let endpoint = format!("http://127.0.0.1:{port}/mcp");
                        tracing::info!("foyer: MCPHttp confirmed live at {endpoint}");
                        launched = launched.with_mcp_endpoint(endpoint);
                    } else {
                        tracing::info!(
                            "foyer: MCPHttp on port {port} didn't answer within {}s — \
                             treating this Ardour build as MCP-incapable",
                            probe_timeout.as_secs(),
                        );
                    }
                }
                Ok(launched)
            }
        }
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
        // Connect to the orphan's existing shim socket. No process
        // handle — Foyer didn't fork this Ardour. The session will
        // disconnect cleanly on close but Ardour stays alive; the
        // user can quit it themselves.
        let host = HostBackend::connect(socket.to_path_buf())
            .await
            .with_context(|| format!("reattach to shim at {} failed", socket.display()))?;
        Ok(foyer_server::LaunchedBackend::new(Arc::new(host)))
    }
}

/// Result of [`launch_and_wait_for_shim`] — the shim socket + child
/// handle (as before), plus the MCPHttp port we pinned this session
/// to (when one was successfully claimed) so callers can probe it
/// and stash the resulting endpoint on the session registry entry.
pub(crate) struct ShimLaunch {
    pub socket: PathBuf,
    pub child: tokio::process::Child,
    pub mcp_port: Option<u16>,
}

/// Spawn the configured DAW with the project as argv and poll the
/// discovery directory until its shim advertises. Returns the shim's
/// UDS path along with the spawned `Child` so the registry can later
/// drive a graceful → SIGTERM → SIGKILL escalation on session close.
/// Times out after ~30 seconds. The child is kept with
/// `kill_on_drop(false)` — sidecar shutdown does NOT kill the DAW
/// (preserves the orphan-reattach feature); explicit `CloseSession`
/// is what triggers the escalation.
///
/// Dev-build awareness: when `exec` lives inside an Ardour source
/// checkout (`<root>/build/gtk2_ardour/`), we source
/// `ardev_common_waf.sh` (LD_LIBRARY_PATH, ARDOUR_DATA_PATH, etc.) and
/// prepend the Foyer shim to `ARDOUR_SURFACES_PATH` so the shim
/// activates without manual XML surgery. System-installed Ardours
/// (on `$PATH` or in `/Applications/...`) are exec'd directly.
///
/// `sample_rate_hint`, when `Some`, rewrites the root `<Session>`
/// `sample-rate="…"` attribute **only if** both `.ardour` paths were
/// absent before bootstrap (brand-new session). Matches `LaunchProject`
/// plus optional per-backend config from the sidecar.
async fn launch_and_wait_for_shim(
    exec: &std::path::Path,
    extra_args: &[String],
    env: &std::collections::BTreeMap<String, String>,
    project: &std::path::Path,
    sample_rate_hint: Option<u32>,
    recover_crash: Option<bool>,
) -> Result<ShimLaunch> {
    use std::time::Duration;

    // Pre-allocate the MCPHttp listen port we'll pin this session to.
    // Each spawn gets its own free port so multiple Ardour instances
    // (e.g. two open sessions, or Foyer + a user-launched Ardour) don't
    // collide on the upstream default of 4820. The XML edit happens
    // inside `preflight_session`; the agent's `daw_proxy` tool reads
    // this back as the per-session MCP endpoint.
    let mcp_port = alloc_free_mcp_port();
    if let Some(p) = mcp_port {
        tracing::info!("foyer: allocated MCPHttp port {p} for this Ardour spawn");
    } else {
        tracing::warn!(
            "foyer: couldn't find a free TCP port in the MCPHttp range — \
             skipping per-session MCP enablement (daw_proxy will fall back to \
             whatever the session file already pins, if anything)"
        );
    }

    // Clean Ardour's atomic-save tempfiles BEFORE spawning the shim.
    // A previous foyer crash mid-save leaves `<name>.pending` /
    // `<name>.tmp` next to `<name>.ardour`; on the next open, Ardour
    // pops a recovery dialog (which our auto-dispatcher doesn't
    // always catch) or just stalls trying to disambiguate, blocking
    // the shim's advertisement past the spawn deadline. Wipe them
    // proactively — `.ardour` is the canonical state, the tempfiles
    // are intermediate save states that should never outlive the
    // process that wrote them.
    if let Some(parent) = project.parent() {
        let dir = if project.is_dir() { project } else { parent };
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                let Some(ext) = p.extension().and_then(|s| s.to_str()) else {
                    continue;
                };
                if ext == "pending" || ext == "tmp" {
                    if let Err(e) = std::fs::remove_file(&p) {
                        tracing::debug!(
                            "spawn pre-flight: couldn't unlink stale {}: {e}",
                            p.display()
                        );
                    } else {
                        tracing::info!(
                            "spawn pre-flight: cleaned stale {} (half-completed save)",
                            p.display()
                        );
                    }
                }
            }
        }
    }

    // Reuse an already-running shim for the SAME project if we have
    // one — otherwise the user's "open this existing project" gesture
    // would spawn a second Ardour that races the first one for the
    // session lock + then dies. The shim writes its project path in
    // the advert; we match on it before falling through to spawn.
    if let Some(ad) = discovery::find_for_project(project) {
        // Probe-connect once to be sure the shim is still reachable
        // (the JSON advert can outlive an unclean exit). On success,
        // hand the existing socket back to the caller — they'll wrap
        // it in a HostBackend and proceed as if we'd just spawned.
        if let Ok(stream) = std::os::unix::net::UnixStream::connect(&ad.socket) {
            drop(stream);
            tracing::info!(
                "reusing live shim at {} for already-open project {}",
                ad.socket.display(),
                project.display(),
            );
            // We didn't spawn a child for this — the caller's
            // `ProcessHandle` slot needs to be optional. Synthesize a
            // dummy child that's already dead so the existing
            // signature stays the same. (`tokio::process::Child` has
            // no public default constructor, so we keep the return
            // shape but document the gotcha at the call site.)
            // Spawn a /bin/true with kill_on_drop=false so the
            // returned Child is a real handle but exits instantly.
            // This lets the caller's existing teardown path (which
            // expects a Child) work without conditional logic. The
            // already-running Ardour is owned by whoever spawned it
            // first; closing the new session doesn't kill it.
            let dummy = tokio::process::Command::new("/bin/true")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()?;
            // Discover the live shim's MCP port via two backwards-
            // compatible paths:
            //   1. Advert JSON: 9.4+ shims with `mcp_http` compiled in
            //      write the bound port into their advert when they
            //      come up. JSON absent on 9.2; the field is `Option`.
            //   2. Session XML fallback: parse the project's `.ardour`
            //      file for `<Protocol name="MCPHttp" active="1"
            //      port="N"/>`. Reports the CONFIGURED port (what
            //      Ardour was told to bind), which on the common case
            //      matches the bound port. A hand-edited XML with no
            //      live process would mislead us; we mitigate by
            //      probing the endpoint right after (see `probe_mcp_http`
            //      in CliSpawner::launch — same path for spawned and
            //      reused sessions).
            let discovered_mcp = ad
                .mcp_port
                .or_else(|| read_mcp_port_from_session_file(project));
            return Ok(ShimLaunch {
                socket: ad.socket,
                child: dummy,
                mcp_port: discovered_mcp,
            });
        }
    }

    let before: std::collections::HashSet<PathBuf> =
        discovery::scan().into_iter().map(|s| s.socket).collect();

    // Resolve the actual binary to exec — redirect the install-wrapper
    // `ardour9` onto the versioned `ardour-<version>` ELF if we find one
    // in the same directory. Old configs that predate the scanner fix
    // will still have the wrapper path; this unblocks them without
    // forcing a re-configure.
    let mut resolved_exec = exec.to_path_buf();
    if let Some(alt) = redirect_short_wrapper(exec) {
        tracing::info!(
            "redirecting install-wrapper {} to dev binary {}",
            exec.display(),
            alt.display(),
        );
        resolved_exec = alt;
    }

    // Ardour's CLI takes `DIR SNAPSHOT_NAME` (two args) — the GUI binary
    // is forgiving about a single-path form, but `hardour` requires both.
    // Normalize whatever the picker handed us into that shape:
    //   · `<dir>/<name>.ardour`  → (<dir>, <name>)
    //   · `<dir>`  (contains *.ardour)  → (<dir>, <stem>)
    //   · anything else                  → (parent, basename)   (new-session case)
    let (session_dir, snapshot_name) = resolve_ardour_session_args(project);
    let had_session = ardour_had_existing_session(&session_dir, &snapshot_name);
    tracing::info!(
        "resolved project {} → DIR={} NAME={}",
        project.display(),
        session_dir.display(),
        snapshot_name,
    );

    // ONE launch path for both system + dev Ardour. The Rust path
    // owns:
    //   * `preflight_session` — bootstrap empty session if missing,
    //     ensure the Foyer Studio Shim is active="1" in the XML,
    //     pin the per-session MCPHttp port.
    //   * `patch_ardour_session_sample_rate` — rewrite the root
    //     `sample-rate=` attr on a fresh session.
    //   * For dev builds: source `ardev_common_waf.sh` via a
    //     short-lived bash invocation, capture the resulting env
    //     delta, and apply it to the spawn `Command`.
    //
    // Dev tree discovery: `FOYER_ARDOUR_DEV_TREE` (env, set by the
    // relevant `just` recipe) takes precedence; otherwise we infer
    // from `resolved_exec` sitting inside `<tree>/build/gtk2_ardour/`.
    // Externalising this means CI / contributors aren't tied to one
    // checkout path.
    let dev_root = std::env::var_os("FOYER_ARDOUR_DEV_TREE")
        .map(PathBuf::from)
        .filter(|p| p.join("build/gtk2_ardour/ardev_common_waf.sh").is_file())
        .or_else(|| foyer_config::ardour_dev_root(&resolved_exec));

    let (session_dir, snapshot_name) =
        preflight_session(&resolved_exec, &session_dir, &snapshot_name, mcp_port);
    if let Some(sr) = sample_rate_hint {
        if !had_session {
            let session_file = session_dir.join(format!("{snapshot_name}.ardour"));
            if session_file.is_file() {
                if let Err(e) = patch_ardour_session_sample_rate(&session_file, sr) {
                    tracing::warn!(
                        "foyer: failed to patch new session sample-rate in {}: {e:#}",
                        session_file.display(),
                    );
                }
            }
        }
    }
    tracing::info!(
        "spawning {} {} {} {}",
        resolved_exec.display(),
        extra_args.join(" "),
        session_dir.display(),
        snapshot_name,
    );
    let mut cmd = tokio::process::Command::new(&resolved_exec);
    if let Some(ref root) = dev_root {
        tracing::info!(
            "dev-build Ardour detected at {} — sourcing ardev env + foyer_shim surface",
            root.display()
        );
        // Apply the env delta from `ardev_common_waf.sh` (LD_LIBRARY_PATH,
        // ARDOUR_DLL_PATH, ARDOUR_DATA_PATH, ARDOUR_CONFIG_PATH,
        // ARDOUR_BACKEND_PATH, etc.).
        for (k, v) in load_ardour_dev_env(root) {
            cmd.env(k, v);
        }
        // Prepend the Foyer shim to ARDOUR_SURFACES_PATH. The shim
        // directory can be overridden via FOYER_ARDOUR_SHIM_DIR — see
        // the `just` recipe — so contributors with a non-default
        // build layout aren't blocked.
        let shim_dir = std::env::var_os("FOYER_ARDOUR_SHIM_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("build/libs/surfaces/foyer_shim"));
        let prior = std::env::var_os("ARDOUR_SURFACES_PATH").unwrap_or_default();
        let mut surfaces = std::ffi::OsString::from(&shim_dir);
        if !prior.is_empty() {
            surfaces.push(":");
            surfaces.push(&prior);
        }
        cmd.env("ARDOUR_SURFACES_PATH", surfaces);
        // Default to the Dummy backend for headless / containerised
        // hosts that lack JACK. Honors any pre-existing value
        // (user config.yaml `env:` block).
        if std::env::var_os("ARDOUR_BACKEND").is_none() {
            cmd.env("ARDOUR_BACKEND", "None (Dummy)");
        }
        // Suppress Ardour's "this screen is not tall enough" dialog
        // for short virtual screens.
        cmd.env("ARDOUR_LOVES_STUPID_TINY_SCREENS", "1");
    }
    // macOS `.app` bundles need `ARDOUR_BUNDLED=true` for the binary
    // to derive its DLL/DATA/CONFIG paths from the bundle layout
    // instead of exiting with "ARDOUR_DLL_PATH not set in environment".
    // LaunchServices would normally set this via Info.plist's
    // `LSEnvironment`, but a direct spawn bypasses that path. We set
    // it ourselves so we keep stdio piped to daw.log.
    if let Some(bundle) = macos_app_bundle(&resolved_exec) {
        tracing::info!(
            "macOS .app bundle detected at {}; setting ARDOUR_BUNDLED=true",
            bundle.display(),
        );
        tracing::info!(
            "Ardour's own stdio will land in ~/Library/Preferences/Ardour9/{{stdout,stderr}}.log"
        );
        cmd.env("ARDOUR_BUNDLED", "true");
    }
    for a in extra_args {
        cmd.arg(a);
    }
    cmd.arg(&session_dir);
    cmd.arg(&snapshot_name);
    // Apply any env overrides from config.yaml. These land on the bash
    // wrapper (or the direct exec) so the `:=` defaults in the script
    // pick them up instead of overriding.
    for (k, v) in env {
        cmd.env(k, v);
    }
    // FOYER_SESSION_SAMPLE_RATE is a vestige of the old bash heredoc —
    // patching landed inline via `patch_ardour_session_sample_rate`
    // above for both dev and system spawns, so the env var no longer
    // serves a runtime purpose. Left out intentionally; an out-of-tree
    // shim that reads the var would already have failed silently in
    // the system-Ardour branch.
    let _ = dev_root.as_ref();
    // The shim picks this up at library-constructor time and installs
    // a GTK toplevel watcher that auto-clicks Ardour's crash-recovery
    // dialog. `discard` is set for symmetry / logging only — the
    // server already deleted `.pending` before this spawn, so the
    // dialog won't actually open in that branch.
    if let Some(recover) = recover_crash {
        let v = if recover { "recover" } else { "discard" };
        cmd.env("FOYER_CRASH_RECOVERY", v);
        tracing::info!("Ardour spawn: FOYER_CRASH_RECOVERY={v}");
    }

    // Redirect the child's stdout+stderr to a per-launch log file so
    // Ardour's chatter (missing plugin warnings, backend init messages,
    // etc.) doesn't scroll foyer's own log off the screen. Missing
    // plugin references in a session are non-fatal — Ardour falls back
    // to Reasonable Synth. The user can tail this file to see what's
    // going on inside the DAW.
    let log_path = daw_log_path()?;
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .with_context(|| format!("open daw log {}", log_path.display()))?;
    let log_err = log_file
        .try_clone()
        .with_context(|| "clone daw log fd for stderr")?;
    cmd.stdout(std::process::Stdio::from(log_file));
    cmd.stderr(std::process::Stdio::from(log_err));
    tracing::info!("DAW stdout/stderr → {}", log_path.display());

    cmd.kill_on_drop(false);
    let child = cmd
        .spawn()
        .with_context(|| format!("spawn {}", resolved_exec.display()))?;

    // Ardour startup against an EXISTING session loads every plugin
    // instance + waveform peakfile + automation lane on the way to
    // `set_active(true)` (which is when the shim writes its advert).
    // On a Codespaces VM (shared CPU / network-backed disk) this can
    // easily exceed the old 30 s deadline for a session with a
    // half-dozen plugins. 90 s covers the slow path; the override env
    // lets fast hosts (or load-test rigs that don't want to babysit a
    // hung shim) tune it down.
    let timeout_secs: u64 = std::env::var("FOYER_SHIM_SPAWN_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(90);
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    // The helper invocation runs the shim with `FOYER_SHIM_NO_IPC=1`
    // (see `bootstrap_session_if_missing` and the bash branch above) so
    // it never advertises — the only advert we'll see is from the real
    // `ardour-9` we just spawned. A connect-probe filters stale advert
    // files left behind by a crashed prior shim that `is_alive()`
    // happened to miss.
    loop {
        for s in discovery::scan() {
            if before.contains(&s.socket) {
                continue;
            }
            match std::os::unix::net::UnixStream::connect(&s.socket) {
                Ok(stream) => {
                    drop(stream);
                    tracing::info!("shim advertised at {}", s.socket.display());
                    return Ok(ShimLaunch {
                        socket: s.socket,
                        child,
                        mcp_port,
                    });
                }
                Err(e) => {
                    tracing::debug!(
                        "advert {} present but connect failed ({e}); waiting for next advert",
                        s.socket.display()
                    );
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err(anyhow!(
                "timed out waiting for shim advertisement after spawn — \
                 see {} for Ardour's own log; common causes: \
                 libfoyer_shim.so missing from the surface search path \
                 (ARDOUR_SURFACES_PATH, $HOME/.config/ardour9/surfaces/, \
                 or /usr/lib/ardour9/surfaces/), or the session XML's \
                 <Protocol name=\"Foyer Studio Shim\"/> entry isn't active",
                daw_log_path()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|_| "the foyer state dir".into()),
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// `ProcessHandle` impl wrapping a `tokio::process::Child` for an
/// Ardour child spawned by `launch_and_wait_for_shim`. The shutdown
/// orchestration (graceful → SIGTERM → SIGKILL) lives in
/// `foyer_server::sessions::shutdown_child`; this struct only
/// provides the per-stage primitives.
///
/// `wait()` polls `Child::try_wait()` on a timer instead of a single
/// long `Child::wait()` so a SIGTERM landing mid-wait advances the
/// state machine without losing the prior wait window. Internal
/// `exited` flag short-circuits subsequent calls so the kernel only
/// reaps once.
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

    /// `Child::id()` only returns `Some` until the child has been
    /// reaped (a `wait`/`try_wait` that resolved to `Exited`). We
    /// capture the pid here and signal it directly so the SIGTERM /
    /// SIGKILL primitives keep working even after a successful reap
    /// from a prior `wait()` call (idempotent no-op in that case via
    /// the `exited` flag).
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
            // Use libc::kill rather than `Child::kill()` (which sends
            // SIGKILL on Unix). SIGTERM is what triggers Ardour's
            // own save-and-exit handler.
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
                // Windows / non-Unix: tokio's start_kill is the
                // closest analog (TerminateProcess). No SIGTERM
                // distinction so the escalation effectively skips
                // the gentle stage.
                let _ = self.child.start_kill();
                let _ = pid; // silence unused-warning on non-unix
            }
        }
    }

    async fn sigkill(&mut self) {
        if self.exited {
            return;
        }
        // start_kill is non-blocking; the eventual reap happens via
        // a follow-up wait() call. SIGKILL bypasses Ardour's signal
        // handlers — last-resort only.
        let _ = self.child.start_kill();
    }
}

/// Return the enclosing `.app` bundle for a Mach-O exec path, if any.
/// Recognizes the standard `<X>.app/Contents/MacOS/<bin>` layout and
/// returns `<X>.app`. Returns `None` on non-macOS targets, on non-bundle
/// layouts (system installs, dev builds), or when any segment is missing.
fn macos_app_bundle(exec: &std::path::Path) -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let macos = exec.parent()?;
    if macos.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let app = contents.parent()?;
    if app.extension().and_then(|s| s.to_str()) == Some("app") {
        Some(app.to_path_buf())
    } else {
        None
    }
}

/// Pick a path for the DAW's stdout+stderr log. Uses
/// `$XDG_STATE_HOME/foyer/daw.log` on Linux, falling back to
/// `<data_dir>/foyer/daw.log` and finally `/tmp/foyer-daw.log` if no
/// user dirs resolve. Appended across launches — if a session misfires
/// you can scroll back to see what happened on the previous attempt.
fn daw_log_path() -> Result<PathBuf> {
    // Prefer XDG_STATE_HOME (the right spot for persistent per-user logs).
    let base = dirs::state_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    Ok(base.join("foyer").join("daw.log"))
}

/// Normalize a picked project path into Ardour's expected
/// `DIR SNAPSHOT_NAME` argv pair.
///
///   · `<dir>/<name>.ardour`  → (<dir>, <name>)
///   · `<dir>` (contains *.ardour)  → (<dir>, stem of first match)
///   · `<dir>` (empty / new)  → (<parent>, <basename>)  so "create here"
///                               flows land on a brand new session dir.
fn resolve_ardour_session_args(project: &std::path::Path) -> (PathBuf, String) {
    // Direct hit: caller handed us an .ardour file.
    if project.extension().and_then(|e| e.to_str()) == Some("ardour") {
        let parent = project
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_default();
        let stem = project
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("session")
            .to_string();
        return (parent, stem);
    }

    // Directory: scan for a *.ardour file inside. If we find one, use
    // its stem as the snapshot name.
    if project.is_dir() {
        if let Ok(rd) = std::fs::read_dir(project) {
            for dent in rd.flatten() {
                let name = dent.file_name();
                let n = name.to_string_lossy();
                if let Some(stem) = n.strip_suffix(".ardour") {
                    return (project.to_path_buf(), stem.to_string());
                }
            }
        }
        // Directory exists but has no *.ardour — treat its basename as
        // the snapshot name (e.g. the user created an empty dir and
        // wants a new session inside).
        let name = project
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("session")
            .to_string();
        return (project.to_path_buf(), name);
    }

    // Non-existent path: this is the "create here" flow. Parent is the
    // chosen container dir; basename becomes the new snapshot name.
    let parent = project
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let name = project
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("session")
        .to_string();
    (parent, name)
}

/// If `exec` is a short-name install wrapper (e.g. `.../ardour9` or
/// `.../hardour9`) and the sibling dir contains the real versioned
/// binary (`ardour-<version>` / `hardour-<version>`), return the
/// versioned path. Callers use this to paper over old configs that
/// auto-detected a wrapper.
fn redirect_short_wrapper(exec: &std::path::Path) -> Option<PathBuf> {
    let dir = exec.parent()?;
    let stem = exec.file_name()?.to_str()?;
    // Accept both "ardour" and "hardour" prefixes.
    let prefix = if stem.starts_with("hardour") {
        "hardour"
    } else if stem.starts_with("ardour") {
        "ardour"
    } else {
        return None;
    };
    let is_short = stem.len() <= prefix.len() + 2
        && stem
            .as_bytes()
            .iter()
            .skip(prefix.len())
            .all(u8::is_ascii_digit);
    if !is_short {
        return None;
    }
    let dash = format!("{prefix}-");
    for dent in std::fs::read_dir(dir).ok()?.flatten() {
        let name = dent.file_name();
        let n = name.to_string_lossy();
        if n.starts_with(&dash) {
            return Some(dent.path());
        }
    }
    None
}

/// Minimal single-quote escape for bash. Only used when we build a `-c`
/// script; we don't need to handle all edge cases, just paths that might
/// contain spaces. Wraps the value in `'…'` and escapes any embedded
/// single quotes by closing/escaping/reopening: `'` → `'\''`.
/// Source of the web assets baked into this binary. The path is
/// resolved by [`../build.rs`](../build.rs) from the
/// `FOYER_BUNDLED_WEB` env var (falling back to the repo's
/// `web/`) and re-exported as a rustc env so `include_dir!` sees
/// the literal path at macro expansion.
///
/// To ship a binary with a different UI baked in, rebuild with
/// `FOYER_BUNDLED_WEB=/path/to/your/staged/web cargo build`. No
/// source edit required — see `docs/DEVELOPMENT.md`.
///
/// At runtime the bundled tree is extracted to
/// `$XDG_DATA_HOME/foyer/web/` on first run so end users can
/// further hack the UI in place; see `web/HACKING.md`.
static BUNDLED_WEB: include_dir::Dir<'static> = include_dir::include_dir!("$FOYER_BUNDLED_WEB");

/// Content hash of the bundled `web/` tree at build time. Written
/// alongside the extracted assets as `.foyer-bundle-version`; on
/// startup we compare the binary's stamp to the file. A mismatch
/// means the user upgraded the binary — re-extract so they don't
/// stay on yesterday's UI. Computed in `build.rs`.
const BUNDLED_WEB_STAMP: &str = env!("FOYER_BUNDLED_WEB_STAMP");
const BUNDLED_WEB_STAMP_FILE: &str = ".foyer-bundle-version";

/// Resolve the `web_root` the server should serve from.
///
/// Priority (first hit wins):
///   1. `--web-root <path>` on the CLI (explicit override — what
///      `just run` passes to serve the repo working copy for dev).
///   2. `$XDG_DATA_HOME/foyer/web` — the canonical user-facing path
///      where hackers drop new `ui-*` variants. Extracted from the
///      binary's bundled assets on first boot; edits survive
///      restarts and reinstalls.
///
/// There is deliberately no automatic `./web` fallback: two
/// different working directories shouldn't silently change where
/// Foyer serves from. If you want to hack the repo tree, pass
/// `--web-root web` (the `just run` recipe does this for you).
fn resolve_web_root(explicit: Option<PathBuf>) -> Result<Option<PathBuf>> {
    if let Some(p) = explicit {
        if !p.exists() {
            anyhow::bail!("--web-root {} does not exist", p.display());
        }
        return Ok(Some(p));
    }
    let data_dir = dirs::data_local_dir()
        .ok_or_else(|| anyhow!("cannot resolve $XDG_DATA_HOME"))?
        .join("foyer")
        .join("web");
    let stamp_path = data_dir.join(BUNDLED_WEB_STAMP_FILE);
    let needs_extract = if !data_dir.join("index.html").exists() {
        true
    } else {
        // Compare the stamp the previous extract wrote to whatever
        // this binary's bundle hashes to. Mismatch = the user upgraded
        // the binary and is otherwise stuck on the old UI. The empty
        // / debug stub stamp `0000000000000000` matches itself, so
        // dev builds don't churn.
        !matches!(
            std::fs::read_to_string(&stamp_path),
            Ok(existing) if existing.trim() == BUNDLED_WEB_STAMP,
        )
    };
    if needs_extract {
        extract_bundled_web(&data_dir)
            .with_context(|| format!("extracting bundled web/ to {}", data_dir.display()))?;
    }
    Ok(Some(data_dir))
}

/// Extract the binary's bundled `web/` to `dst`. Called both on
/// first run (no extracted tree yet) and on every upgrade where the
/// binary's `BUNDLED_WEB_STAMP` differs from the stamp file written
/// by the previous extract.
///
/// Upgrade path: if `dst` already exists with content, rotate it to
/// `dst.bak.<old-stamp>` first so any user edits aren't silently
/// blown away — they're recoverable from the rename. We don't try
/// to merge: the bundled tree is the source of truth, and the user
/// can copy specific files back if they want.
fn extract_bundled_web(dst: &Path) -> Result<()> {
    if dst.join("index.html").exists() {
        let old_stamp = std::fs::read_to_string(dst.join(BUNDLED_WEB_STAMP_FILE))
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| "unknown".into());
        let backup = dst.with_file_name(format!(
            "{}.bak.{old_stamp}",
            dst.file_name().and_then(|n| n.to_str()).unwrap_or("web"),
        ));
        // If a backup with the same stamp is already there (rare:
        // user upgraded twice without hitting the new bundle), drop
        // the older snapshot — the more recent edits are what they
        // care about.
        if backup.exists() {
            let _ = std::fs::remove_dir_all(&backup);
        }
        std::fs::rename(dst, &backup)
            .with_context(|| format!("rotate {} → {}", dst.display(), backup.display()))?;
        tracing::info!(
            "stale extracted web/ found (stamp {old_stamp}); rotated to {} \
             before re-extracting bundled assets",
            backup.display(),
        );
    }
    std::fs::create_dir_all(dst).with_context(|| format!("mkdir -p {}", dst.display()))?;
    tracing::info!(
        "extracting bundled web/ (stamp {}) to {}",
        BUNDLED_WEB_STAMP,
        dst.display(),
    );
    write_dir_contents(&BUNDLED_WEB, dst)?;
    // Stamp file lets the next launch detect a binary upgrade.
    let _ = std::fs::write(dst.join(BUNDLED_WEB_STAMP_FILE), BUNDLED_WEB_STAMP);
    // Drop a breadcrumb so users know where to hack and how to reset.
    let readme = dst.join("INSTALLED-HERE.txt");
    let _ = std::fs::write(
        &readme,
        "This directory was seeded from the Foyer binary's bundled web/.\n\
         You can edit anything here — refresh the browser to see changes.\n\
         See HACKING.md for recipes.\n\n\
         When you upgrade the foyer binary, this folder is re-extracted\n\
         from the new bundle. Your previous tree (if any) is rotated\n\
         to ./web.bak.<old-stamp>/ — copy custom edits back from there.\n\n\
         To force a fresh re-extract: delete this folder + the .foyer-\n\
         bundle-version sibling, then restart `foyer serve`.\n",
    );
    Ok(())
}

fn write_dir_contents(dir: &include_dir::Dir<'_>, dst: &Path) -> Result<()> {
    for entry in dir.entries() {
        match entry {
            include_dir::DirEntry::Dir(d) => {
                let sub = dst.join(d.path().file_name().unwrap_or_default());
                std::fs::create_dir_all(&sub)
                    .with_context(|| format!("mkdir -p {}", sub.display()))?;
                write_dir_contents(d, &sub)?;
            }
            include_dir::DirEntry::File(f) => {
                let name = f.path().file_name().unwrap_or_default();
                let out = dst.join(name);
                std::fs::write(&out, f.contents())
                    .with_context(|| format!("write {}", out.display()))?;
            }
        }
    }
    Ok(())
}

fn shell_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Pre-flight the Ardour session file on the released-binary path.
///
/// Ports the bootstrap and `<Protocol name="Foyer Studio Shim">` edit
/// from the dev-build bash branch at the top of
/// [`launch_and_wait_for_shim`] into Rust so the released binary gets
/// the same treatment. The dev-build path keeps its bash version
/// untouched — that runs in dev containers with GNU sed and isn't
/// worth re-litigating.
///
/// Two responsibilities:
///   1. If `<dir>/<name>.ardour` doesn't exist, locate
///      `ardour*-new_empty_session` next to the resolved exec and run
///      it to bootstrap a session under `<dir>/<name>/`. Returns the
///      adjusted `(dir, name)` if that succeeds.
///   2. Edit the session XML so `<Protocol name="Foyer Studio Shim"
///      active="1"/>` is present inside `<ControlProtocols>`.
///
/// Fails open: any I/O error, non-zero helper exit, or unparseable
/// XML shape just logs a warning and returns the inputs unchanged.
/// Mirrors the `|| true` semantics of the bash version.
fn preflight_session(
    resolved_exec: &Path,
    session_dir: &Path,
    snapshot_name: &str,
    mcp_port: Option<u16>,
) -> (PathBuf, String) {
    let (dir, name) = bootstrap_session_if_missing(resolved_exec, session_dir, snapshot_name);
    let session_file = dir.join(format!("{name}.ardour"));
    // `symlink_metadata` here mirrors the check inside
    // `ensure_foyer_shim_active`. We do it twice on purpose: this gate
    // skips the entire flow if the path is a symlink (no log spam),
    // and the inner check is the load-bearing one in case the path
    // changed type between the two calls.
    if let Ok(m) = std::fs::symlink_metadata(&session_file) {
        if m.file_type().is_file() {
            if let Err(e) = ensure_foyer_shim_active(&session_file) {
                tracing::warn!(
                    "foyer: failed to update Foyer Studio Shim entry in {}: {e:#}",
                    session_file.display(),
                );
            }
            // Pin the MCPHttp port if we allocated one. Idempotent on
            // a repeat open against the same session — same port stays
            // pinned, the XML doesn't get rewritten when it already
            // matches.
            if let Some(port) = mcp_port {
                if let Err(e) = crate::ardour_xml::ensure_mcp_http_on_port(&session_file, port) {
                    tracing::warn!(
                        "foyer: failed to pin MCPHttp port {port} in {}: {e:#}",
                        session_file.display(),
                    );
                }
            }
        } else {
            tracing::warn!(
                "foyer: session file {} is not a regular file — skipping shim activation",
                session_file.display(),
            );
        }
    }
    // Crash-recovery is no longer handled here — the WS layer
    // discards `.pending` before this call when the user picked
    // Discard, and the Ardour shim auto-clicks the recovery dialog
    // when `FOYER_CRASH_RECOVERY=recover` is set. The CLI bootstrap
    // path injects that env via `BackendSpawner::launch` based on a
    // pre-launch probe (see the `launch()` call in `start_command`).
    (dir, name)
}

/// Try to read the configured MCPHttp port out of `project`'s
/// `.ardour` file. Used by the reuse-existing-shim path when the
/// shim's advert JSON didn't carry a `mcp_port` (older shim builds,
/// Ardour 9.2 without `mcp_http` compiled in). Returns `None` if no
/// `.ardour` file is found or it doesn't list an active MCPHttp
/// protocol.
///
/// `project` can be either the project directory or the `.ardour`
/// file directly — mirrors how the launcher accepts both.
fn read_mcp_port_from_session_file(project: &Path) -> Option<u16> {
    let session_file = if project.is_file() {
        project.to_path_buf()
    } else if project.is_dir() {
        // Walk the directory for the first `.ardour` file. The shim
        // advertises `session().path()` which is the project dir; the
        // session file inside it has the same basename or one of the
        // session-snapshot names.
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

/// Allocate a free TCP port for an MCPHttp listener. We bias the
/// search to the [4820, 4900) range (4820 is Ardour's published
/// default; staying close keeps firewall rules and dev-tooling
/// muscle memory aligned) but fall through to a free ephemeral
/// port if every slot is taken.
///
/// Returns `None` if the OS can't hand us a port at all — extremely
/// unusual; the caller logs and skips the per-session pin in that
/// case (the session still works, the `daw_proxy` tool just doesn't
/// see this session as MCP-capable until the next open).
fn alloc_free_mcp_port() -> Option<u16> {
    use std::net::TcpListener;
    for port in 4820u16..4900 {
        // bind-then-close gives us a port we can hand to Ardour with
        // the (small) risk of a race against another process. The MCP
        // surface re-binds on session-load, so we accept that window.
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Some(port);
        }
    }
    // Fall through: let the kernel pick anything free.
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|addr| addr.port())
}

/// Probe an MCPHttp endpoint to see if it's up. Used post-spawn to
/// decide whether to register this session as MCP-capable. Returns
/// `true` when the endpoint answers an `initialize` within `deadline`.
/// Older Ardour builds without `mcp_http` compiled in just never bind
/// the port — the probe will time out and the session reports no MCP.
async fn probe_mcp_http(port: u16, deadline: std::time::Duration) -> bool {
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
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    false
}

/// Step 1 of `preflight_session`: if the session file is missing,
/// invoke `ardour*-new_empty_session` to create it under
/// `<session_dir>/<snapshot_name>/`. Returns the (possibly redirected)
/// `(dir, name)` to pass to Ardour as argv.
fn bootstrap_session_if_missing(
    resolved_exec: &Path,
    session_dir: &Path,
    snapshot_name: &str,
) -> (PathBuf, String) {
    let session_file = session_dir.join(format!("{snapshot_name}.ardour"));
    if session_file.is_file() {
        return (session_dir.to_path_buf(), snapshot_name.to_string());
    }
    let leaf_dir = session_dir.join(snapshot_name);
    // The helper refuses to run when the leaf dir already exists. If a
    // previous failed launch left an empty leaf, clean it up. A
    // populated leaf we leave alone — caller can `rm -rf` once they're
    // sure. Same policy as the bash version.
    if leaf_dir.is_dir() {
        if let Ok(mut it) = std::fs::read_dir(&leaf_dir) {
            if it.next().is_none() {
                let _ = std::fs::remove_dir(&leaf_dir);
            }
        }
    }
    let helper = match find_new_empty_session_helper(resolved_exec) {
        Some(h) => h,
        None => {
            tracing::warn!(
                "foyer: no ardour*-new_empty_session helper found near {} — Ardour will show its own session dialog",
                resolved_exec.display(),
            );
            return (session_dir.to_path_buf(), snapshot_name.to_string());
        }
    };
    tracing::info!(
        "foyer: bootstrapping new session {} via {}",
        leaf_dir.display(),
        helper.display(),
    );
    // Two scoped env tweaks for the helper child only:
    //
    //   * FOYER_SHIM_NO_IPC=1 — mirrors the bash branch above. Without
    //     it the helper loads the foyer surface .so and runs full IPC
    //     bring-up (advert + listener), exits ~2s later, and the parent
    //     foyer-cli can race-claim the dead socket. shims/ardour/src/ipc.cc
    //     short-circuits when this is set.
    //
    //   * ARDOUR_BACKEND_PATH stripped — the helper hardcodes
    //     `engine->set_backend("None (Dummy)", ...)` (upstream
    //     ardour/session_utils/common.cc::create_session) and never
    //     instantiates ours, but the mere presence of
    //     `libfoyer_audiobackend.so` in libardour's dlopen set during
    //     teardown causes glibc to abort with "corrupted size vs.
    //     prev_size while consolidating" inside `free()` from a static
    //     destructor — class-static members of `DummyAudioBackend`
    //     (which both upstream `libdummy_audiobackend.so` and our
    //     `libfoyer_audiobackend.so` define) collide on dlclose. The
    //     session XML still gets written before the abort fires (so
    //     bootstrap recovers in practice via the file-exists check
    //     below) but the helper takes ~3s to die instead of exiting
    //     cleanly, and the SIGABRT lands in foyer-cli's log as a
    //     misleading warning. The actual `ardour-9` we spawn next
    //     keeps ARDOUR_BACKEND_PATH set so it picks our patched
    //     "Foyer Dummy" (absolute-time-sleep variant required for
    //     non-RT containers); we just don't want it for this
    //     transient invocation.
    match std::process::Command::new(&helper)
        .env("FOYER_SHIM_NO_IPC", "1")
        .env_remove("ARDOUR_BACKEND_PATH")
        .arg(&leaf_dir)
        .arg(snapshot_name)
        .status()
    {
        Ok(s) if !s.success() => {
            tracing::warn!(
                "foyer: {} exited with status {} — letting Ardour show its own dialog",
                helper.display(),
                s,
            );
        }
        Err(e) => {
            tracing::warn!("foyer: failed to invoke {}: {e}", helper.display());
        }
        _ => {}
    }
    let leaf_session = leaf_dir.join(format!("{snapshot_name}.ardour"));
    if leaf_session.is_file() {
        (leaf_dir, snapshot_name.to_string())
    } else {
        (session_dir.to_path_buf(), snapshot_name.to_string())
    }
}

/// Look for `ardour*-new_empty_session` next to the resolved Ardour
/// exec. The bundled-app layout on macOS puts it at
/// `…/Ardour9.app/Contents/MacOS/ardour9-new_empty_session` (lowercase
/// even though the GUI binary is `Ardour9`); a Linux package install
/// puts it next to `ardour9` in `/usr/bin`. Scans the parent dir for a
/// case-insensitive `ardour*-new_empty_session` match and picks the
/// first regular-file hit.
fn find_new_empty_session_helper(resolved_exec: &Path) -> Option<PathBuf> {
    // Sibling check — system Ardour packages drop the helper next to
    // `ardour-9`.
    if let Some(dir) = resolved_exec.parent() {
        if let Some(hit) = scan_for_helper(dir) {
            return Some(hit);
        }
    }
    // Dev-build layout: `build/session_utils/ardour9-new_empty_session`
    // lives alongside `build/gtk2_ardour/ardour-9` (the binary). When
    // we're running a dev build, walk up to the dev tree root and
    // scan its `build/session_utils/` directory.
    if let Some(root) = foyer_config::ardour_dev_root(resolved_exec) {
        let session_utils = root.join("build/session_utils");
        if let Some(hit) = scan_for_helper(&session_utils) {
            return Some(hit);
        }
    }
    None
}

fn scan_for_helper(dir: &Path) -> Option<PathBuf> {
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name();
        let lower = name.to_string_lossy().to_lowercase();
        if lower.starts_with("ardour") && lower.ends_with("-new_empty_session") {
            let path = entry.path();
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

/// Source `ardev_common_waf.sh` from a dev tree root and return the
/// env vars it defines as a `(name, value)` list. The script wires up
/// the lib-path / data-path / config-path / backend-path env vars
/// needed for an in-tree Ardour binary to find its companion .so's
/// without an `install` step. We invoke bash to source it, then dump
/// the env back out — same effect as the previous bash heredoc, but
/// the env application happens in Rust so the rest of the spawn flow
/// stays in one place.
///
/// `FOYER_ARDOUR_DEV_TREE` (when set) overrides the auto-detected
/// dev root, so a `just` recipe can point us at any checkout without
/// having to plant the binary at a specific path.
fn load_ardour_dev_env(root: &Path) -> Vec<(String, String)> {
    let waf = root.join("build/gtk2_ardour/ardev_common_waf.sh");
    if !waf.is_file() {
        return Vec::new();
    }
    // `source <script> && env -0` (NUL-separated env) avoids quoting
    // issues for values that contain newlines. We compare against the
    // *current* process env and only return entries that actually
    // changed — keeps the spawn-side env minimal and audit-able.
    //
    // `TOP=<root>` is REQUIRED — `ardev_common_waf.sh` opens with
    // `[ -z $TOP ] && echo "ardev_common.sh: TOP var must be set" >&2 && exit 1`
    // and the previous incarnation of this function shipped without
    // it: bash would exit 1 silently (we routed stderr to /dev/null
    // for the dev-build noise), `load_ardour_dev_env` returned an
    // empty Vec, and the spawned Ardour died at dlopen on
    // `libardourcp.so` because no LD_LIBRARY_PATH ever got set.
    let out = match std::process::Command::new("bash")
        .env("TOP", root)
        .arg("-c")
        .arg(format!(
            "set -e; source {} >/dev/null 2>&1; env -0",
            shell_escape(waf.to_string_lossy().as_ref())
        ))
        .output()
    {
        Ok(o) if o.status.success() => o.stdout,
        Ok(o) => {
            tracing::warn!(
                "foyer: sourcing {} returned status {}; dev-build env may be incomplete",
                waf.display(),
                o.status
            );
            return Vec::new();
        }
        Err(e) => {
            tracing::warn!("foyer: bash for {} failed: {e}", waf.display());
            return Vec::new();
        }
    };
    let mut delta = Vec::new();
    for slice in out.split(|b| *b == 0) {
        if slice.is_empty() {
            continue;
        }
        let Ok(s) = std::str::from_utf8(slice) else {
            continue;
        };
        if let Some(eq) = s.find('=') {
            let key = &s[..eq];
            let val = &s[eq + 1..];
            // Skip transient bash internals — we only want the
            // ardour-specific vars.
            if matches!(key, "PWD" | "OLDPWD" | "SHLVL" | "_" | "PS1" | "PS4") {
                continue;
            }
            if std::env::var(key).map(|cur| cur != val).unwrap_or(true) {
                delta.push((key.to_string(), val.to_string()));
            }
        }
    }
    delta
}
