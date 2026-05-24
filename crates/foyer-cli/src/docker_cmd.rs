// `foyer docker` — orchestrate a Foyer Studio container.
//
// One subcommand wraps docker / podman / nerdctl behind a single
// `foyer docker [--integrated|--jack|--netjack] [--image IMG]
//  [--host-port PORT] [--network host|bridge]` interface. Mode +
// image + runtime + network fall through to `config.yaml`'s `docker`
// section when not passed on the CLI.
//
// Modes:
//
//   · integrated (default) — container runs Foyer with its dummy
//     audio backend. We grant `SYS_NICE` + `IPC_LOCK` so the
//     in-container audio graph keeps real-time priority + can lock
//     memory. No external sound system needed.
//
//   · jack — bind-mount the host's JACK socket directory
//     (`/run/user/$UID/jack-*`) plus `/dev/shm` (registry) and
//     `/dev/snd` (ALSA fallback) into the container. Works against
//     real `jackd` AND PipeWire's `pipewire-jack` compat layer —
//     both expose the same socket shapes. Linux-only.
//
//   · netjack — pure TCP path to a NetJACK server. Works
//     cross-platform but pays network jitter. Sets
//     `FOYER_RUNTIME_MODE=jack-headless` + `FOYER_JACK_MODE=netjack`
//     in the container so the entrypoint actually wires the net
//     driver instead of falling back to gui-dummy.

use anyhow::{anyhow, Context, Result};
use foyer_config::{Config, DockerMode, DockerNetwork};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const DEFAULT_IMAGE: &str = "ghcr.io/hotspoons/foyer-studio:latest";
const DEFAULT_HOST_PORT: u16 = 3838;
const DEFAULT_NETJACK_PORT: u16 = 19000;
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
    /// User-supplied container network model.
    pub network_override: Option<DockerNetwork>,
    /// NetJACK target host (only meaningful with `--netjack`).
    pub netjack_host_override: Option<String>,
    /// NetJACK target port (only meaningful with `--netjack`).
    pub netjack_port_override: Option<u16>,
    /// Detach (`-d`) vs foreground (default).
    pub detach: bool,
    /// Print the assembled command without running it.
    pub dry_run: bool,
}

/// Structured result of [`assemble_args`] — kept separate from `run`
/// so the desktop wrapper's dependency-check wizard can preview the
/// exact `docker run` invocation without spawning it.
#[derive(Debug, Clone)]
pub struct PlannedInvocation {
    pub runtime: PathBuf,
    pub args: Vec<String>,
    /// One-line human-readable form (`podman run --rm -it …`) for
    /// logs and the dry-run path.
    pub pretty: String,
}

pub fn run(config: &Config, args: DockerCmdArgs) -> Result<()> {
    let plan = assemble(config, &args)?;

    if args.dry_run {
        println!("{}", plan.pretty);
        return Ok(());
    }

    tracing::info!("launching container: {}", plan.pretty);
    let status = Command::new(&plan.runtime)
        .args(&plan.args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .with_context(|| format!("spawn {}", plan.runtime.display()))?;
    if !status.success() {
        return Err(anyhow!(
            "{} exited with status {}",
            plan.runtime.display(),
            status
        ));
    }
    Ok(())
}

/// Resolve every input source — CLI args, `config.yaml`, env-var
/// fallbacks — into the exact `runtime + argv` we'd hand to
/// `Command::new`. Exposed so callers (notably the desktop mode
/// picker) can preview the command for the user before launching
/// without re-implementing the layering precedence.
pub fn assemble(config: &Config, args: &DockerCmdArgs) -> Result<PlannedInvocation> {
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
    let network = args
        .network_override
        .or(dcfg.network)
        .unwrap_or(DockerNetwork::Bridge);

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
    // libardour reserves ~107 MB of POSIX shm during session load.
    // Docker's default 64 MB tmpfs ENOMEMs the open; bump to 1 GB.
    cmd_args.push("--shm-size".into());
    cmd_args.push("1g".into());
    // Audio benefits from the host's ulimits — most distros ship
    // `@audio - rtprio 95`. Mirror the limits inside the container.
    cmd_args.push("--ulimit".into());
    cmd_args.push("rtprio=95".into());
    cmd_args.push("--ulimit".into());
    cmd_args.push("memlock=-1".into());

    // Networking. `host` shares the host's net namespace (no `-p`
    // mapping needed, lower latency, mandatory for some NetJACK /
    // mDNS setups). `bridge` publishes the sidecar's port through
    // docker-proxy.
    match network {
        DockerNetwork::Host => {
            if cfg!(not(target_os = "linux")) {
                tracing::warn!(
                    "--network=host requested on a non-Linux host — Docker Desktop's VM \
                     intercepts host networking and silently falls back to bridge. \
                     Use --network=bridge for explicit port mapping."
                );
            }
            cmd_args.push("--network".into());
            cmd_args.push("host".into());
            // The container still binds 3838 internally; on Linux host
            // networking that's directly reachable on the host as
            // 127.0.0.1:3838. Set PORT explicitly so the entrypoint
            // doesn't conflict with anything else the user's running.
            cmd_args.push("-e".into());
            cmd_args.push(format!("PORT={host_port}"));
        }
        DockerNetwork::Bridge => {
            // Publish the sidecar's HTTP/WS port to the host.
            cmd_args.push("-p".into());
            cmd_args.push(format!("{host_port}:3838"));
        }
    }

    // Mode-specific wiring.
    match mode {
        DockerMode::Integrated => {
            // gui-dummy is the entrypoint default. Set it explicitly
            // so a stale env var or config can't sneak the container
            // into jack-headless without us asking.
            cmd_args.push("-e".into());
            cmd_args.push("FOYER_RUNTIME_MODE=gui-dummy".into());
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
                    "expected JACK / PipeWire-JACK socket dir at {} — bind-mounting anyway, \
                     but the container may fail to connect if no JACK-compatible server is running",
                    jack_dir.display()
                );
            }
            // FOYER_RUNTIME_MODE=jack-headless flips the entrypoint
            // away from the dummy AMS seed and into the
            // hardour + jackd code path. FOYER_JACK_MODE=shm tells
            // it to consume the host's running jackd / pipewire-jack
            // server via the shared /dev/shm registry.
            cmd_args.push("-e".into());
            cmd_args.push("FOYER_RUNTIME_MODE=jack-headless".into());
            cmd_args.push("-e".into());
            cmd_args.push("FOYER_JACK_MODE=shm".into());
            // Real-time scheduling and IPC: --ipc=host plus the
            // shm/jack tmp bind mounts let libjack reach the host's
            // POSIX shm registry and the JACK socket files.
            cmd_args.push("--ipc=host".into());
            cmd_args.push("-v".into());
            cmd_args.push("/dev/shm:/dev/shm".into());
            cmd_args.push("-v".into());
            cmd_args.push("/tmp:/tmp:rw".into());
            cmd_args.push("--device".into());
            cmd_args.push("/dev/snd".into());
            cmd_args.push("-v".into());
            cmd_args.push(format!("{xdg_runtime}:{xdg_runtime}"));
            cmd_args.push("-e".into());
            cmd_args.push(format!("XDG_RUNTIME_DIR={xdg_runtime}"));
            // Pass through the user's uid so socket perms line up.
            cmd_args.push("--user".into());
            cmd_args.push(format!("{uid}:{uid}"));
            cmd_args.push("--group-add".into());
            cmd_args.push("audio".into());
        }
        DockerMode::Netjack => {
            // NetJACK uses TCP — no socket bind-mounts. The container
            // entrypoint spawns its own `jackd -d net` pointed at the
            // remote master; we pass the target via env so the
            // entrypoint's existing netjack code path can take it.
            cmd_args.push("-e".into());
            cmd_args.push("FOYER_RUNTIME_MODE=jack-headless".into());
            cmd_args.push("-e".into());
            cmd_args.push("FOYER_JACK_MODE=netjack".into());
            let host = args
                .netjack_host_override
                .clone()
                .or_else(|| dcfg.netjack_host.clone())
                .or_else(|| std::env::var("FOYER_NETJACK_HOST").ok())
                .ok_or_else(|| {
                    anyhow!(
                        "--netjack requires a NetJACK target — pass --netjack-host=<host>, \
                         set docker.netjack_host in config.yaml, or export FOYER_NETJACK_HOST"
                    )
                })?;
            let port = args
                .netjack_port_override
                .or(dcfg.netjack_port)
                .or_else(|| {
                    std::env::var("FOYER_NETJACK_PORT")
                        .ok()
                        .and_then(|v| v.parse().ok())
                })
                .unwrap_or(DEFAULT_NETJACK_PORT);
            cmd_args.push("-e".into());
            cmd_args.push(format!("FOYER_NETJACK_HOST={host}"));
            cmd_args.push("-e".into());
            cmd_args.push(format!("FOYER_NETJACK_PORT={port}"));
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

    Ok(PlannedInvocation {
        runtime,
        args: cmd_args,
        pretty,
    })
}

/// Outcome of one dependency / readiness probe. `ok = false` does NOT
/// always mean the launch will fail — see `severity`.
#[derive(Debug, Clone)]
pub struct CheckResult {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub severity: CheckSeverity,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckSeverity {
    /// Failure means the launch will fail. The wizard should block.
    Required,
    /// Failure degrades the experience but the launch still works.
    Warning,
}

/// Run the pre-flight dependency checks the desktop wrapper renders
/// in its docker-mode wizard. Static — never spawns the container.
///
/// The result list is ordered: runtime detection first (because
/// every other check depends on it), then mode-specific probes.
pub fn doctor(
    config: &Config,
    mode: DockerMode,
    runtime_override: Option<&str>,
    netjack_host_override: Option<&str>,
) -> Vec<CheckResult> {
    let mut out = Vec::new();
    let dcfg = config.docker.clone().unwrap_or_default();

    // 1. Container runtime.
    let runtime_pref = runtime_override.or(dcfg.runtime.as_deref());
    let runtime = match resolve_runtime(runtime_pref, dcfg.runtime.as_deref()) {
        Ok(p) => {
            out.push(CheckResult {
                id: "runtime".into(),
                label: "Container runtime".into(),
                ok: true,
                severity: CheckSeverity::Required,
                detail: format!("found {} — will use this", p.display()),
            });
            Some(p)
        }
        Err(e) => {
            out.push(CheckResult {
                id: "runtime".into(),
                label: "Container runtime".into(),
                ok: false,
                severity: CheckSeverity::Required,
                detail: format!(
                    "{e}\nInstall podman (recommended), docker, or nerdctl and re-run."
                ),
            });
            None
        }
    };

    // 2. Image pull-ability — cheap "is the daemon up?" probe.
    if let Some(rt) = runtime.as_ref() {
        let ok = Command::new(rt)
            .arg("info")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        out.push(CheckResult {
            id: "runtime-daemon".into(),
            label: "Runtime daemon reachable".into(),
            ok,
            severity: CheckSeverity::Required,
            detail: if ok {
                format!("`{} info` succeeded", rt.display())
            } else {
                format!(
                    "`{} info` failed — daemon not running, or the current user isn't in the runtime's group.\n\
                     · docker:  sudo systemctl start docker && sudo usermod -aG docker $USER (then log out / back in)\n\
                     · podman:  rootless mode normally works without a daemon — check `podman info` directly",
                    rt.display()
                )
            },
        });
    }

    // 3. Mode-specific probes.
    match mode {
        DockerMode::Integrated => {
            out.push(CheckResult {
                id: "mode".into(),
                label: "Integrated mode (no host audio)".into(),
                ok: true,
                severity: CheckSeverity::Warning,
                detail: "Dummy backend runs entirely inside the container. \
                         No host JACK / PipeWire needed."
                    .into(),
            });
        }
        DockerMode::Jack => {
            #[cfg(target_os = "linux")]
            {
                let uid = unsafe { libc::geteuid() };
                let xdg =
                    std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| format!("/run/user/{uid}"));
                let jack_dir = PathBuf::from(&xdg);
                let socket_present = jack_dir
                    .read_dir()
                    .map(|it| {
                        it.flatten()
                            .any(|e| e.file_name().to_string_lossy().starts_with("jack"))
                    })
                    .unwrap_or(false);
                let pipewire_running = Command::new("pgrep")
                    .arg("-x")
                    .arg("pipewire")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                let jackd_running = Command::new("pgrep")
                    .arg("-x")
                    .arg("jackd")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                let kind = match (pipewire_running, jackd_running) {
                    (true, _) => "PipeWire (with JACK compat)",
                    (false, true) => "jackd",
                    (false, false) => "neither pipewire nor jackd",
                };
                let ok = socket_present || pipewire_running || jackd_running;
                out.push(CheckResult {
                    id: "jack-server".into(),
                    label: "JACK / PipeWire-JACK server on host".into(),
                    ok,
                    severity: CheckSeverity::Required,
                    detail: if ok {
                        format!(
                            "{kind} is running; socket dir = {} (mount = {})",
                            jack_dir.display(),
                            if socket_present { "ok" } else { "no jack-* yet" }
                        )
                    } else {
                        format!(
                            "No JACK-compatible server detected. Start one:\n\
                             · PipeWire (most modern distros): install `pipewire-jack` and ensure \
                               `systemctl --user status pipewire pipewire-pulse wireplumber` are active.\n\
                             · classic JACK 2:  jackd -R -d alsa -d hw:0 -r 48000 -p 1024 &\n\
                             Socket dir checked: {}",
                            jack_dir.display()
                        )
                    },
                });
            }
            #[cfg(not(target_os = "linux"))]
            {
                out.push(CheckResult {
                    id: "jack-server".into(),
                    label: "JACK / PipeWire-JACK server on host".into(),
                    ok: false,
                    severity: CheckSeverity::Required,
                    detail: "--jack mode is Linux-only (Docker on macOS/Windows runs a VM, \
                             host JACK sockets don't reach into it). Use NetJACK instead."
                        .into(),
                });
            }
        }
        DockerMode::Netjack => {
            let host = netjack_host_override
                .map(|s| s.to_string())
                .or_else(|| dcfg.netjack_host.clone())
                .or_else(|| std::env::var("FOYER_NETJACK_HOST").ok());
            let port = dcfg
                .netjack_port
                .or_else(|| {
                    std::env::var("FOYER_NETJACK_PORT")
                        .ok()
                        .and_then(|v| v.parse().ok())
                })
                .unwrap_or(DEFAULT_NETJACK_PORT);
            match host {
                Some(h) => {
                    let addr = format!("{h}:{port}");
                    let reachable = std::net::ToSocketAddrs::to_socket_addrs(&addr)
                        .ok()
                        .and_then(|mut it| it.next())
                        .map(|sock| {
                            std::net::TcpStream::connect_timeout(
                                &sock,
                                std::time::Duration::from_millis(800),
                            )
                            .is_ok()
                        })
                        .unwrap_or(false);
                    out.push(CheckResult {
                        id: "netjack-target".into(),
                        label: "NetJACK target reachable".into(),
                        ok: reachable,
                        severity: CheckSeverity::Warning,
                        detail: if reachable {
                            format!("TCP connect to {addr} succeeded")
                        } else {
                            format!(
                                "TCP connect to {addr} failed — the container will still launch and \
                                 retry, but check the master is running and the port is open."
                            )
                        },
                    });
                }
                None => {
                    out.push(CheckResult {
                        id: "netjack-target".into(),
                        label: "NetJACK target reachable".into(),
                        ok: false,
                        severity: CheckSeverity::Required,
                        detail: "No NetJACK host configured. Set `docker.netjack_host` in \
                                 config.yaml or export FOYER_NETJACK_HOST."
                            .into(),
                    });
                }
            }
        }
    }

    out
}

/// Human / JSON report for `foyer docker --doctor`. Spawned by the
/// desktop wrapper's mode-picker wizard (JSON form) to render the
/// pre-flight check list before launching.
pub fn report_doctor(
    config: &Config,
    mode: DockerMode,
    runtime_override: Option<&str>,
    netjack_host_override: Option<&str>,
    json: bool,
) {
    let checks = doctor(config, mode, runtime_override, netjack_host_override);
    if json {
        let entries: Vec<String> = checks
            .iter()
            .map(|c| {
                let sev = match c.severity {
                    CheckSeverity::Required => "required",
                    CheckSeverity::Warning => "warning",
                };
                format!(
                    "    {{\"id\":{id}, \"label\":{label}, \"ok\":{ok}, \"severity\":\"{sev}\", \"detail\":{detail}}}",
                    id = json_str(&c.id),
                    label = json_str(&c.label),
                    ok = c.ok,
                    sev = sev,
                    detail = json_str(&c.detail),
                )
            })
            .collect();
        let any_required_failed = checks
            .iter()
            .any(|c| !c.ok && c.severity == CheckSeverity::Required);
        println!(
            "{{\n  \"mode\": \"{mode}\",\n  \"ok\": {ok},\n  \"checks\": [\n{checks}\n  ]\n}}",
            mode = match mode {
                DockerMode::Integrated => "integrated",
                DockerMode::Jack => "jack",
                DockerMode::Netjack => "netjack",
            },
            ok = !any_required_failed,
            checks = entries.join(",\n"),
        );
    } else {
        let mode_label = match mode {
            DockerMode::Integrated => "integrated",
            DockerMode::Jack => "jack",
            DockerMode::Netjack => "netjack",
        };
        println!("foyer docker doctor — mode={mode_label}");
        for c in &checks {
            let marker = if c.ok { "✓" } else { "✗" };
            let sev = match c.severity {
                CheckSeverity::Required => "required",
                CheckSeverity::Warning => "warning",
            };
            println!(
                "  {marker} [{sev}] {label}: {detail}",
                label = c.label,
                detail = c.detail
            );
        }
        let any_required_failed = checks
            .iter()
            .any(|c| !c.ok && c.severity == CheckSeverity::Required);
        if any_required_failed {
            println!("\nblocked: one or more required checks failed");
        } else {
            println!("\nready to launch");
        }
    }
}

/// Minimal JSON string escaper — enough for the field shapes
/// `report_doctor` produces. Pulling in `serde_json` for one call
/// site isn't worth the build-time cost; this handles every byte
/// `CheckResult` puts in user-facing strings.
fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
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
