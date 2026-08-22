// SPDX-License-Identifier: Apache-2.0
//! Foyer Studio CLI.
//!
//! `foyer serve` starts the WebSocket server. The backend is chosen from
//! `config.yaml` (see `foyer-config`) unless the caller passes `--backend`
//! on the command line. On first run the config is seeded with a stub
//! (no-DAW demo mode) and an Ardour entry — the user can add more later.
//!
//! Source layout:
//!   * [`cli`]        — clap `Cli` + `Command` enum.
//!   * [`serve`]      — `foyer serve`: spawner + WS server boot.
//!   * [`runtime`]    — Per-DAW launch traits; today only Ardour.
//!   * [`web_bundle`] — `include_dir!`'d web tree + first-run extract.
//!   * [`mcp_probe`]  — MCPHttp port alloc + probe helpers.
//!   * [`docker_cmd`] — `foyer docker` subcommand.
//!   * [`shim_install`] / [`ardour_xml`] — Ardour shim install + XML edits.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use clap::Parser;
use foyer_backend_host::discovery;
use foyer_config::{self as cfg, BackendKind, Config};

mod acp_relay;
mod ardour_locate;
mod ardour_xml;
mod cli;
mod docker_cmd;
mod mcp_probe;
mod runtime;
mod serve;
mod shim_install;
mod web_bundle;

use cli::{Cli, Command};

#[tokio::main]
async fn main() -> Result<()> {
    // `foyer acp` speaks a line protocol on stdout — logs there
    // would corrupt it. Peek at argv before installing the
    // subscriber so that subcommand logs to stderr instead.
    let writer = if std::env::args().nth(1).as_deref() == Some("acp") {
        tracing_subscriber::fmt::writer::BoxMakeWriter::new(std::io::stderr)
    } else {
        tracing_subscriber::fmt::writer::BoxMakeWriter::new(std::io::stdout)
    };
    tracing_subscriber::fmt()
        .with_writer(writer)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                // Default: info for our crates, but mute chatty upstream
                // libraries that flood the log without surfacing anything
                // actionable:
                //   - symphonia: "ignoring unknown chunk: tag=JUNK" fires
                //     at WARN per-chunk on multi-region zoom.
                //   - chromiumoxide: "WS Invalid message" fires on every
                //     CDP event variant the SDK doesn't recognise.
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
            network,
            netjack_host,
            netjack_port,
            detach,
            dry_run,
            doctor,
            json,
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
            if doctor {
                let resolved_mode = mode_override
                    .or(config.docker.as_ref().and_then(|d| d.mode))
                    .unwrap_or(cfg::DockerMode::Integrated);
                docker_cmd::report_doctor(
                    &config,
                    resolved_mode,
                    runtime.as_deref(),
                    netjack_host.as_deref(),
                    json,
                );
                return Ok(());
            }
            docker_cmd::run(
                &config,
                docker_cmd::DockerCmdArgs {
                    mode_override,
                    image_override: image,
                    runtime_override: runtime,
                    host_port_override: host_port,
                    network_override: network,
                    netjack_host_override: netjack_host,
                    netjack_port_override: netjack_port,
                    detach,
                    dry_run,
                },
            )
        }
        Command::DoctorHost { json } => {
            let checks = docker_cmd::host_doctor();
            if json {
                println!(
                    "{{\n  \"os\": {os},\n  \"host\": {host}\n}}",
                    os = docker_cmd::os_to_json(),
                    host = docker_cmd::checks_to_json(&checks, "host"),
                );
            } else {
                println!("foyer doctor — mode=host");
                for c in &checks {
                    let marker = if c.ok { "✓" } else { "✗" };
                    let sev = match c.severity {
                        docker_cmd::CheckSeverity::Required => "required",
                        docker_cmd::CheckSeverity::Warning => "warning",
                    };
                    println!(
                        "  {marker} [{sev}] {label}: {detail}",
                        label = c.label,
                        detail = c.detail
                    );
                    if let Some(cmd) = &c.install_command {
                        println!("    install: {cmd}");
                    }
                }
            }
            Ok(())
        }
        Command::DoctorRuntimes => {
            let runtimes = docker_cmd::detect_runtimes();
            println!("{}", docker_cmd::runtimes_to_json(&runtimes));
            Ok(())
        }
        Command::DoctorArdour => {
            // Picker eats the failure path (no Ardour installed) as
            // `{"installed": false, ...}` rather than a non-zero
            // exit, so the wizard can render an install card
            // instead of crashing the doctor sweep.
            let loc = ardour_locate::locate(None).ok();
            println!("{}", ardour_locate::locate_to_json(loc.as_ref()));
            Ok(())
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
        Command::Acp { url } => {
            let url = url.unwrap_or_else(|| acp_relay::default_url(&config));
            acp_relay::run(url).await
        }
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
            // TLS: CLI pair > config.yaml pair > none.
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
            serve::serve(
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
/// scrubber emitted in place of `<Script>` blocks.
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
        // FOYER_ARDOUR_VERSION is set by build.rs from the same env var
        // the Ardour source clone uses.
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

/// Pick a path for the DAW's stdout+stderr log. Uses
/// `$XDG_STATE_HOME/foyer/daw.log` on Linux, falling back to
/// `<data_dir>/foyer/daw.log` and finally `/tmp/foyer-daw.log` if no
/// user dirs resolve. Appended across launches — if a session misfires
/// you can scroll back to see what happened on the previous attempt.
pub(crate) fn daw_log_path() -> Result<PathBuf> {
    let base = dirs::state_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    Ok(base.join("foyer").join("daw.log"))
}
