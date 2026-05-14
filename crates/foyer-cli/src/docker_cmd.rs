// `foyer docker` — orchestrate a Foyer Studio container.
//
// One subcommand wraps docker / podman / nerdctl behind a single
// `foyer docker [--integrated|--jack|--netjack] [--image IMG]
//  [--host-port PORT]` interface. Mode + image + runtime fall through
// to `config.yaml`'s `docker` section when not passed on the CLI.
//
// Modes:
//
//   · integrated (default) — container runs Foyer with its dummy
//     audio backend. We grant `SYS_NICE` + `IPC_LOCK` so the
//     in-container audio graph keeps real-time priority + can lock
//     memory. No external sound system needed.
//
//   · jack — bind-mount the host's JACK socket directory
//     (`/run/user/$UID/jack-*`) into the container, plus
//     `/dev/snd` for ALSA fallback. Linux-only; Docker-on-Mac
//     runs a VM and these paths don't exist.
//
//   · netjack — pure TCP path to a NetJACK server. Works
//     cross-platform but pays network jitter.

use anyhow::{anyhow, Context, Result};
use foyer_config::{Config, DockerMode};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const DEFAULT_IMAGE: &str = "ghcr.io/hotspoons/foyer-studio:latest";
const DEFAULT_HOST_PORT: u16 = 3838;
/// Runtime preference order when nothing is configured. Podman first
/// because it's rootless by default — safer when we ask for
/// `SYS_NICE`/`IPC_LOCK` caps. Docker second. nerdctl third for
/// k3s / containerd-native hosts.
const RUNTIME_PROBE_ORDER: &[&str] = &["podman", "docker", "nerdctl"];

/// Resolved command-line + config inputs for one `foyer docker` run.
#[derive(Debug, Clone)]
pub struct DockerCmdArgs {
    /// User-supplied override of `mode`. `None` = use config or
    /// `integrated` default.
    pub mode_override: Option<DockerMode>,
    /// User-supplied image, e.g. `ghcr.io/hotspoons/foyer-studio:snapshot-abc1234`.
    pub image_override: Option<String>,
    /// User-supplied runtime: `podman` / `docker` / `nerdctl`.
    pub runtime_override: Option<String>,
    /// User-supplied host port.
    pub host_port_override: Option<u16>,
    /// Detach (`-d`) vs foreground (default).
    pub detach: bool,
    /// Print the assembled command without running it.
    pub dry_run: bool,
}

pub fn run(config: &Config, args: DockerCmdArgs) -> Result<()> {
    let dcfg = config.docker.clone().unwrap_or_default();
    let runtime = resolve_runtime(args.runtime_override.as_deref(), dcfg.runtime.as_deref())
        .context("no container runtime found")?;
    let image = args
        .image_override
        .clone()
        .or(dcfg.image.clone())
        .unwrap_or_else(|| DEFAULT_IMAGE.to_string());
    let mode = args
        .mode_override
        .or(dcfg.mode)
        .unwrap_or(DockerMode::Integrated);
    let host_port = args
        .host_port_override
        .or(dcfg.host_port)
        .unwrap_or(DEFAULT_HOST_PORT);

    let mut cmd_args: Vec<String> = vec!["run".into(), "--rm".into()];
    if args.detach {
        cmd_args.push("-d".into());
    } else {
        cmd_args.push("-it".into());
    }
    cmd_args.push("--name".into());
    cmd_args.push(format!("foyer-studio-{}", suffix()));

    // Capabilities + niceness — same for every mode. SYS_NICE lets
    // the in-container Ardour / dummy backend raise its thread
    // priorities; IPC_LOCK lets it `mlock` its audio buffers so
    // they don't page out under memory pressure.
    cmd_args.push("--cap-add".into());
    cmd_args.push("SYS_NICE".into());
    cmd_args.push("--cap-add".into());
    cmd_args.push("IPC_LOCK".into());
    // Audio benefits from the host's ulimits — most distros ship
    // `@audio - rtprio 95`. Mirror the limits inside the container.
    cmd_args.push("--ulimit".into());
    cmd_args.push("rtprio=95".into());
    cmd_args.push("--ulimit".into());
    cmd_args.push("memlock=-1".into());

    // Publish the sidecar's HTTP/WS port to the host.
    cmd_args.push("-p".into());
    cmd_args.push(format!("{host_port}:3838"));

    // Mode-specific wiring.
    match mode {
        DockerMode::Integrated => {
            // Nothing extra — dummy backend, no host audio needed.
        }
        DockerMode::Jack => {
            if cfg!(not(target_os = "linux")) {
                return Err(anyhow!(
                    "--jack mode requires Linux (Docker on macOS/Windows uses a VM, \
                     and JACK socket bind-mounts don't reach the host's audio system).\n\
                     Try --netjack for cross-platform JACK, or --integrated for no host audio."
                ));
            }
            let uid = unsafe { libc::geteuid() };
            let xdg_runtime =
                std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| format!("/run/user/{uid}"));
            let jack_dir = PathBuf::from(&xdg_runtime);
            if !jack_dir.is_dir() {
                tracing::warn!(
                    "expected JACK socket dir at {} — bind-mounting anyway, \
                     but the container may fail to connect if JACK isn't running yet",
                    jack_dir.display()
                );
            }
            cmd_args.push("--device".into());
            cmd_args.push("/dev/snd".into());
            cmd_args.push("-v".into());
            cmd_args.push(format!("{xdg_runtime}:{xdg_runtime}"));
            cmd_args.push("-e".into());
            cmd_args.push(format!("XDG_RUNTIME_DIR={xdg_runtime}"));
            // Pass through the user's uid so socket perms line up.
            cmd_args.push("--user".into());
            cmd_args.push(format!("{uid}:{uid}"));
        }
        DockerMode::Netjack => {
            // NetJACK uses TCP — no socket bind-mounts. The
            // container's JACK config still needs to know where to
            // dial; pass it through via env so the image's entrypoint
            // can wire `jackd -d netone` or similar without us
            // re-implementing the whole NetJACK boot.
            if let Ok(host) = std::env::var("FOYER_NETJACK_HOST") {
                cmd_args.push("-e".into());
                cmd_args.push(format!("FOYER_NETJACK_HOST={host}"));
            }
            if let Ok(port) = std::env::var("FOYER_NETJACK_PORT") {
                cmd_args.push("-e".into());
                cmd_args.push(format!("FOYER_NETJACK_PORT={port}"));
            }
        }
    }

    // Anything the user added via config.docker.extra_args.
    for extra in &dcfg.extra_args {
        cmd_args.push(extra.clone());
    }

    cmd_args.push(image.clone());

    let pretty = format!(
        "{} {}",
        runtime.display(),
        cmd_args
            .iter()
            .map(|a| if a.contains(' ') {
                format!("\"{a}\"")
            } else {
                a.clone()
            })
            .collect::<Vec<_>>()
            .join(" ")
    );

    if args.dry_run {
        println!("{pretty}");
        return Ok(());
    }

    tracing::info!("launching container: {pretty}");
    let status = Command::new(&runtime)
        .args(&cmd_args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .with_context(|| format!("spawn {}", runtime.display()))?;
    if !status.success() {
        return Err(anyhow!(
            "{} exited with status {}",
            runtime.display(),
            status
        ));
    }
    Ok(())
}

/// Resolve which container runtime to invoke. Explicit override wins;
/// then config setting; then PATH probe over `RUNTIME_PROBE_ORDER`.
fn resolve_runtime(
    override_runtime: Option<&str>,
    config_runtime: Option<&str>,
) -> Result<PathBuf> {
    let preferred = override_runtime.or(config_runtime);
    if let Some(name) = preferred {
        if let Some(p) = which(name) {
            return Ok(p);
        }
        return Err(anyhow!(
            "configured container runtime `{name}` not found on PATH"
        ));
    }
    for name in RUNTIME_PROBE_ORDER {
        if let Some(p) = which(name) {
            return Ok(p);
        }
    }
    Err(anyhow!(
        "no container runtime found on PATH (tried: {})\n\
         install podman, docker, or nerdctl and try again, \
         or set `docker.runtime` in config.yaml.",
        RUNTIME_PROBE_ORDER.join(", ")
    ))
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

/// 8-char nonce for the container name. Avoids collision when the
/// user runs `foyer docker` repeatedly without cleaning up; we pass
/// `--rm` so the previous one is already gone, but a clearer name
/// is nicer in `docker ps` listings.
fn suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{nanos:08x}")
}

#[allow(dead_code)]
fn _check_paths_exist(paths: &[&Path]) -> Vec<PathBuf> {
    paths
        .iter()
        .filter(|p| p.exists())
        .map(|p| p.to_path_buf())
        .collect()
}
