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
    /// Optional env vars to set before invoking the runtime binary.
    /// Currently only used by `runtime_kind=colima` to flip
    /// DOCKER_HOST onto Colima's socket so the shared `docker` CLI
    /// doesn't talk to Docker Desktop's daemon by mistake. `run()`
    /// applies these via `Command::env()` before spawn.
    pub envs: Vec<(String, String)>,
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
    let mut cmd = Command::new(&plan.runtime);
    cmd.args(&plan.args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    for (k, v) in &plan.envs {
        cmd.env(k, v);
    }
    let status = cmd
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
    // runtime_kind drives the DOCKER_HOST override — for Colima we
    // MUST point the docker CLI at `~/.colima/default/docker.sock`,
    // else it talks to whichever daemon happens to own
    // `/var/run/docker.sock` (Docker Desktop on a co-installed Mac).
    // Other kinds either have their own CLI shim (OrbStack) or use
    // the default socket (Docker Desktop, Engine, Podman). The user
    // can always set DOCKER_HOST manually in their shell to override.
    let mut envs: Vec<(String, String)> = Vec::new();
    if let Some(kind_id) = dcfg.runtime_kind.as_deref() {
        if let Some(kind) = RuntimeKind::from_id(kind_id) {
            if let Some(dh) = kind.docker_host_override() {
                envs.push(("DOCKER_HOST".into(), dh));
            }
        }
    }
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
        envs,
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
    /// A copy-pasteable shell command that resolves the failing
    /// check on the current OS, when we can derive one. `None`
    /// for `ok` checks and for failure modes the user has to
    /// hand-fix (e.g. "set FOYER_NETJACK_HOST in config").
    pub install_command: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckSeverity {
    /// Failure means the launch will fail. The wizard should block.
    Required,
    /// Failure degrades the experience but the launch still works.
    Warning,
}

/// Linux distribution family — controls which install one-liner we
/// suggest. `Unknown` falls through to a generic hint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsFamily {
    Debian,
    Fedora,
    Arch,
    Suse,
    Unknown,
}

impl OsFamily {
    fn as_str(self) -> &'static str {
        match self {
            OsFamily::Debian => "debian",
            OsFamily::Fedora => "fedora",
            OsFamily::Arch => "arch",
            OsFamily::Suse => "suse",
            OsFamily::Unknown => "unknown",
        }
    }
}

/// Snapshot of OS-level facts the picker uses to render install
/// hints + pretty labels. Cheap — reads `/etc/os-release` once and
/// runs `pgrep` against a couple of known audio daemons.
#[derive(Debug, Clone)]
pub struct OsProbe {
    pub family: OsFamily,
    pub pretty_name: String,
    /// True when a host-side PipeWire daemon is up. Used to pick
    /// `pipewire-jack` over plain `jack2` in the suggested install.
    pub pipewire_running: bool,
}

impl OsProbe {
    pub fn detect() -> Self {
        let (family, pretty_name) = parse_os_release();
        let pipewire_running = is_running("pipewire");
        Self {
            family,
            pretty_name,
            pipewire_running,
        }
    }
}

fn parse_os_release() -> (OsFamily, String) {
    let content = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
    let mut id = String::new();
    let mut id_like = String::new();
    let mut pretty = String::new();
    for line in content.lines() {
        if let Some(v) = line.strip_prefix("ID=") {
            id = v.trim_matches('"').to_string();
        } else if let Some(v) = line.strip_prefix("ID_LIKE=") {
            id_like = v.trim_matches('"').to_string();
        } else if let Some(v) = line.strip_prefix("PRETTY_NAME=") {
            pretty = v.trim_matches('"').to_string();
        }
    }
    let combined = format!("{id} {id_like}");
    let family = if combined.contains("debian") || combined.contains("ubuntu") {
        OsFamily::Debian
    } else if combined.contains("fedora")
        || combined.contains("rhel")
        || combined.contains("centos")
    {
        OsFamily::Fedora
    } else if combined.contains("arch") {
        OsFamily::Arch
    } else if combined.contains("suse") {
        OsFamily::Suse
    } else {
        OsFamily::Unknown
    };
    let pretty = if pretty.is_empty() {
        std::env::consts::OS.to_string()
    } else {
        pretty
    };
    (family, pretty)
}

fn is_running(name: &str) -> bool {
    Command::new("pgrep")
        .arg("-x")
        .arg(name)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Install-command lookup tables. The audio stack pick (pipewire-jack
/// vs jack2) is driven by whether PipeWire is already on the host:
///   * PipeWire active   → install `pipewire-jack` compat layer.
///   * No PipeWire       → install classic JACK 2.
fn install_runtime(family: OsFamily) -> Option<String> {
    Some(
        match family {
            OsFamily::Debian => "sudo apt update && sudo apt install -y podman",
            OsFamily::Fedora => "sudo dnf install -y podman",
            OsFamily::Arch => "sudo pacman -S --noconfirm podman",
            OsFamily::Suse => "sudo zypper install -y podman",
            OsFamily::Unknown => return None,
        }
        .into(),
    )
}

fn install_jack_stack(family: OsFamily, pipewire_present: bool) -> Option<String> {
    Some(if pipewire_present {
        match family {
            OsFamily::Debian => {
                "sudo apt install -y pipewire-jack pipewire-audio wireplumber && \
                 systemctl --user enable --now pipewire pipewire-pulse wireplumber"
            }
            OsFamily::Fedora => {
                "sudo dnf install -y pipewire-jack-audio-connection-kit wireplumber && \
                 systemctl --user enable --now pipewire pipewire-pulse wireplumber"
            }
            OsFamily::Arch => {
                "sudo pacman -S --noconfirm pipewire-jack wireplumber && \
                 systemctl --user enable --now pipewire pipewire-pulse wireplumber"
            }
            OsFamily::Suse => {
                "sudo zypper install -y pipewire-libjack-0_3 wireplumber && \
                 systemctl --user enable --now pipewire pipewire-pulse wireplumber"
            }
            OsFamily::Unknown => return None,
        }
        .to_string()
    } else {
        match family {
            OsFamily::Debian => {
                "sudo apt install -y jackd2 qjackctl && \
                 sudo usermod -aG audio $USER  # log out / back in to pick up the group"
            }
            OsFamily::Fedora => "sudo dnf install -y jack-audio-connection-kit qjackctl",
            OsFamily::Arch => "sudo pacman -S --noconfirm jack2 qjackctl",
            OsFamily::Suse => "sudo zypper install -y jack qjackctl",
            OsFamily::Unknown => return None,
        }
        .to_string()
    })
}

fn install_ardour(family: OsFamily) -> Option<String> {
    // Two install paths per OS, joined into a single multi-line
    // shell snippet the picker shows in a copy-pasteable block:
    //
    //   1. The fast distro path (apt/dnf/pacman/zypper). Gets
    //      whatever version the distro pinned; on Debian sid that's
    //      currently 9.2, which loads the shim fine via our 9.x ABI
    //      guards.
    //   2. The "demo" download from community.ardour.org. The
    //      unpaid binary is fully featured but nags you to donate
    //      and has limits on session save/export. Good enough for
    //      trying Foyer end-to-end. For unrestricted use the user
    //      donates at the same URL or builds from source.
    //
    // We don't pin a specific Ardour version in the URL — that
    // would rot. The hint points the user at the download page; on
    // headless installs they can curl + click-through manually.
    let community_blurb = "# OR — download the demo binary from community.ardour.org\n\
         # (fully featured, nags for donation, soft session save/export caps).\n\
         # For unrestricted use, donate at https://community.ardour.org/download\n\
         # or build from source.\n\
         xdg-open https://community.ardour.org/download \
         || open https://community.ardour.org/download \
         || echo 'open https://community.ardour.org/download in a browser'";
    Some(match family {
        OsFamily::Debian => format!(
            "# Distro path (Debian sid ships `ardour`, currently ~9.2):\n\
                 sudo apt update && sudo apt install -y ardour\n\n\
                 {community_blurb}"
        ),
        OsFamily::Fedora => format!(
            "# Distro path:\n\
                 sudo dnf install -y ardour\n\n\
                 {community_blurb}"
        ),
        OsFamily::Arch => format!(
            "# Distro path:\n\
                 sudo pacman -S --noconfirm ardour\n\n\
                 {community_blurb}"
        ),
        OsFamily::Suse => format!(
            "# Distro path:\n\
                 sudo zypper install -y ardour\n\n\
                 {community_blurb}"
        ),
        OsFamily::Unknown => community_blurb.to_string(),
    })
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
    let os = OsProbe::detect();

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
                install_command: None,
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
                install_command: install_runtime(os.family),
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
            install_command: if ok {
                None
            } else if rt.file_name().and_then(|s| s.to_str()) == Some("docker") {
                Some(
                    "sudo systemctl start docker && sudo usermod -aG docker $USER  \
                     # log out / back in to pick up the group"
                        .into(),
                )
            } else {
                None
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
                install_command: None,
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
                let jackd_running = is_running("jackd");
                let kind = match (os.pipewire_running, jackd_running) {
                    (true, _) => "PipeWire (with JACK compat)",
                    (false, true) => "jackd",
                    (false, false) => "neither pipewire nor jackd",
                };
                let ok = socket_present || os.pipewire_running || jackd_running;
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
                    install_command: if ok {
                        None
                    } else {
                        // Recommend the stack matching what's
                        // ALREADY on the host: pipewire-jack if
                        // PipeWire is running (any version), else
                        // the classic JACK 2 daemon.
                        install_jack_stack(os.family, os.pipewire_running)
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
                    install_command: None,
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
                        install_command: None,
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
                        install_command: None,
                    });
                }
            }
        }
    }

    out
}

/// Host-mode pre-flight: does this machine have a Foyer-compatible
/// Ardour install, and is there an audio path to drive it? Mirrors
/// the shape of `doctor()` so the picker's check-card UI can render
/// it with the same code.
pub fn host_doctor() -> Vec<CheckResult> {
    let mut out = Vec::new();
    let os = OsProbe::detect();

    // 1. Ardour binary on PATH. We accept the major-pinned name
    //    (`ardour9`), the bare `ardour`, or the headless variants —
    //    the foyer-cli launcher already knows how to bridge between
    //    them at run time.
    let ardour = ["ardour9", "ardour", "hardour9", "hardour"]
        .iter()
        .find_map(|n| which(n));
    match &ardour {
        Some(p) => out.push(CheckResult {
            id: "ardour".into(),
            label: "Ardour binary".into(),
            ok: true,
            severity: CheckSeverity::Required,
            detail: format!("found {} — will exec this from the launcher", p.display()),
            install_command: None,
        }),
        None => out.push(CheckResult {
            id: "ardour".into(),
            label: "Ardour binary".into(),
            ok: false,
            severity: CheckSeverity::Required,
            detail: "No `ardour9`/`ardour` on PATH. Host mode needs Ardour 9 \
                     installed locally so foyer-server can spawn it via the shim."
                .into(),
            install_command: install_ardour(os.family),
        }),
    }

    // 2. Foyer shim landed in Ardour's surfaces dir. install.sh's
    //    canonical location on Linux is `~/.config/ardour9/surfaces/`.
    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let shim = PathBuf::from(&home).join(".config/ardour9/surfaces/libfoyer_shim.so");
        let ok = shim.is_file();
        out.push(CheckResult {
            id: "shim".into(),
            label: "Foyer Studio shim plugin".into(),
            ok,
            severity: CheckSeverity::Warning,
            detail: if ok {
                format!("found {}", shim.display())
            } else {
                format!(
                    "Shim not at {} — Ardour won't see Foyer Studio under \
                     Preferences → Control Surfaces. Run `install.sh` (in your \
                     foyer bundle) to drop it in.",
                    shim.display()
                )
            },
            install_command: if ok {
                None
            } else {
                Some(
                    "curl -fsSL https://raw.githubusercontent.com/hotspoons/foyer-studio/main/install.sh \
                     | bash -s -- --latest-ci"
                        .into(),
                )
            },
        });
    }

    // 3. Audio server. Real audio path needs PipeWire-JACK, plain
    //    JACK 2, or — at minimum — Ardour's ALSA backend. We can
    //    only sniff the user-session daemons.
    let jackd_running = is_running("jackd");
    let server_kind = match (os.pipewire_running, jackd_running) {
        (true, _) => Some("PipeWire (JACK compat available)"),
        (false, true) => Some("jackd"),
        (false, false) => None,
    };
    match server_kind {
        Some(k) => out.push(CheckResult {
            id: "audio-server".into(),
            label: "Audio server (JACK / PipeWire)".into(),
            ok: true,
            severity: CheckSeverity::Warning,
            detail: format!("{k} is running on the host."),
            install_command: None,
        }),
        None => out.push(CheckResult {
            id: "audio-server".into(),
            label: "Audio server (JACK / PipeWire)".into(),
            ok: false,
            severity: CheckSeverity::Warning,
            detail: "Neither PipeWire nor jackd are running. Ardour will fall \
                     back to its ALSA / Dummy backends, but real low-latency \
                     monitoring needs one of these up."
                .into(),
            install_command: install_jack_stack(os.family, os.pipewire_running),
        }),
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
        println!("{}", checks_to_json(&checks, mode_label(mode)));
    } else {
        println!("foyer docker doctor — mode={}", mode_label(mode));
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

fn mode_label(mode: DockerMode) -> &'static str {
    match mode {
        DockerMode::Integrated => "integrated",
        DockerMode::Jack => "jack",
        DockerMode::Netjack => "netjack",
    }
}

/// Serialize a check list to the JSON shape the desktop picker
/// consumes. Exposed so the picker's refresh path (which spawns
/// `foyer docker --doctor --json`) and the standalone host doctor
/// share one formatter.
pub fn checks_to_json(checks: &[CheckResult], mode_name: &str) -> String {
    let entries: Vec<String> = checks
        .iter()
        .map(|c| {
            let sev = match c.severity {
                CheckSeverity::Required => "required",
                CheckSeverity::Warning => "warning",
            };
            let install = match &c.install_command {
                Some(s) => format!(", \"install_command\":{}", json_str(s)),
                None => String::new(),
            };
            format!(
                "    {{\"id\":{id}, \"label\":{label}, \"ok\":{ok}, \"severity\":\"{sev}\", \"detail\":{detail}{install}}}",
                id = json_str(&c.id),
                label = json_str(&c.label),
                ok = c.ok,
                sev = sev,
                detail = json_str(&c.detail),
                install = install,
            )
        })
        .collect();
    let any_required_failed = checks
        .iter()
        .any(|c| !c.ok && c.severity == CheckSeverity::Required);
    format!(
        "{{\n  \"mode\": \"{mode_name}\",\n  \"ok\": {ok},\n  \"checks\": [\n{checks}\n  ]\n}}",
        ok = !any_required_failed,
        checks = entries.join(",\n"),
    )
}

/// Probe the host once, return an `os: { family, pretty_name }` blob
/// shaped for `window.__doctor.os` on the picker side.
pub fn os_to_json() -> String {
    let probe = OsProbe::detect();
    format!(
        "{{\"family\":{family}, \"pretty_name\":{pretty}, \"pipewire_running\":{pw}}}",
        family = json_str(probe.family.as_str()),
        pretty = json_str(&probe.pretty_name),
        pw = probe.pipewire_running,
    )
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

// ───────────────────────── runtime detection ─────────────────────────
//
// The picker on macOS + Windows needs to show the user which container
// runtimes are installed AND running, defaulting to the right one for
// the OS:
//
//   * Docker Desktop on macOS — `/Applications/Docker.app` + the docker
//     CLI in `/usr/local/bin`. Uses the default unix socket.
//   * Colima on macOS — `which colima` + `~/.colima/default/docker.sock`
//     present. DOCKER_HOST must be set to point at that socket because
//     the system docker CLI looks at `/var/run/docker.sock` by default.
//   * OrbStack on macOS — `/Applications/OrbStack.app`. Bundles its
//     own docker CLI shim that picks up the OrbStack socket from
//     `~/.orbstack/run/docker.sock` automatically when called from
//     OrbStack's PATH-prefix install.
//   * Podman / Podman Desktop — `which podman`. Cross-platform.
//   * Docker Engine on Linux — `which docker` + `/var/run/docker.sock`,
//     no Docker Desktop wrapper. The classic linux-server install.
//
// We surface every detected runtime to the picker; the user picks the
// one they want. The choice writes a `runtime_kind` into config.yaml
// so the CLI's `assemble()` can set DOCKER_HOST appropriately at
// run time without re-probing.

/// Container-runtime flavor. Drives the picker's per-OS card UI and
/// determines whether `assemble()` needs to inject a DOCKER_HOST
/// override before invoking the docker CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeKind {
    /// Docker Desktop (macOS + Windows) — the GUI app from docker.com.
    DockerDesktop,
    /// Plain Docker Engine (Linux servers, devcontainers). No GUI.
    DockerEngine,
    /// Colima (macOS) — Lima VM + Docker socket.
    Colima,
    /// OrbStack (macOS) — fast modern Lima-style alternative.
    Orbstack,
    /// Podman CLI. No GUI. Linux / macOS.
    Podman,
    /// Podman Desktop (the GUI app from podman-desktop.io). Sits on
    /// top of `podman` but adds a tray icon and machine management.
    PodmanDesktop,
    /// nerdctl — Containerd's CLI shim. Linux-only in practice.
    Nerdctl,
}

impl RuntimeKind {
    pub fn label(self) -> &'static str {
        match self {
            RuntimeKind::DockerDesktop => "Docker Desktop",
            RuntimeKind::DockerEngine => "Docker Engine",
            RuntimeKind::Colima => "Colima",
            RuntimeKind::Orbstack => "OrbStack",
            RuntimeKind::Podman => "Podman",
            RuntimeKind::PodmanDesktop => "Podman Desktop",
            RuntimeKind::Nerdctl => "nerdctl",
        }
    }

    /// CLI binary name used to invoke this runtime. Multiple kinds
    /// share the same binary (Docker Desktop + Docker Engine both use
    /// `docker`; Podman + Podman Desktop both use `podman`).
    /// Unused today — the picker writes `runtime_kind` to config and
    /// the existing `resolve_runtime` path falls through to PATH
    /// probes — but kept for the eventual "the user picked kind X
    /// but only kind Y's binary is on PATH" reconciliation pass.
    #[allow(dead_code)]
    pub fn binary_name(self) -> &'static str {
        match self {
            RuntimeKind::DockerDesktop | RuntimeKind::DockerEngine => "docker",
            RuntimeKind::Colima | RuntimeKind::Orbstack => "docker",
            RuntimeKind::Podman | RuntimeKind::PodmanDesktop => "podman",
            RuntimeKind::Nerdctl => "nerdctl",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            RuntimeKind::DockerDesktop => "docker_desktop",
            RuntimeKind::DockerEngine => "docker_engine",
            RuntimeKind::Colima => "colima",
            RuntimeKind::Orbstack => "orbstack",
            RuntimeKind::Podman => "podman",
            RuntimeKind::PodmanDesktop => "podman_desktop",
            RuntimeKind::Nerdctl => "nerdctl",
        }
    }

    pub fn from_id(id: &str) -> Option<RuntimeKind> {
        Some(match id {
            "docker_desktop" => RuntimeKind::DockerDesktop,
            "docker_engine" => RuntimeKind::DockerEngine,
            "colima" => RuntimeKind::Colima,
            "orbstack" => RuntimeKind::Orbstack,
            "podman" => RuntimeKind::Podman,
            "podman_desktop" => RuntimeKind::PodmanDesktop,
            "nerdctl" => RuntimeKind::Nerdctl,
            _ => return None,
        })
    }

    /// DOCKER_HOST override the picker should bake into the env when
    /// invoking this runtime, if any. None means "use the binary's
    /// own default socket" (Docker Desktop's CLI auto-finds its own,
    /// OrbStack's CLI shim auto-finds its own, plain Docker Engine
    /// hits `/var/run/docker.sock`). Colima is the one runtime that
    /// shares the `docker` binary with Docker Desktop but ships its
    /// own socket — without this env override, `docker ps` would talk
    /// to Docker Desktop's daemon instead of Colima's.
    pub fn docker_host_override(self) -> Option<String> {
        match self {
            RuntimeKind::Colima => {
                // Default Colima profile socket. `colima start
                // --profile foo` ships at `~/.colima/foo/docker.sock`;
                // power users will hand-edit config.yaml in that case.
                let home = std::env::var("HOME").ok()?;
                Some(format!("unix://{home}/.colima/default/docker.sock"))
            }
            _ => None,
        }
    }
}

/// One row in the picker's runtime card list. `installed=true` means
/// the binary / app bundle / sentinel directory is present; `running`
/// means we can additionally confirm the daemon is responsive (socket
/// exists, etc.). The picker greys out cards that aren't installed,
/// shows a yellow "needs starting" banner on installed-but-not-running,
/// and lets the user click any installed card to make it the default.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RuntimeProbe {
    pub kind_id: String,
    pub label: String,
    pub installed: bool,
    pub running: bool,
    /// Hint we suggest if `installed=false`. macOS Homebrew, Windows
    /// winget, Linux distro pkg.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_command: Option<String>,
    /// Extra one-line context the picker shows under the label
    /// (path of the binary, path of the socket, error text from a
    /// probe). Empty when nothing to add.
    pub detail: String,
    /// Suggested default for this OS. The picker pre-selects the
    /// first installed-AND-default runtime in the list; if none of
    /// the defaults are installed it falls back to the first
    /// installed one regardless.
    pub default_on_this_os: bool,
}

/// Probe every container runtime we know about. Returns one
/// `RuntimeProbe` per kind, ordered so the OS-canonical default lands
/// first (picker uses the order for tab focus + initial selection).
///
/// Cheap — pure FS + PATH probes, no subprocesses. The picker calls
/// this on first render + on every "Re-check" click.
pub fn detect_runtimes() -> Vec<RuntimeProbe> {
    let mut out: Vec<RuntimeProbe> = Vec::new();
    // OS-canonical default order. macOS leads with Docker Desktop
    // (most common); Windows is Docker-Desktop-only in practice;
    // Linux defaults to plain Docker Engine. Podman is offered on
    // every OS as a non-default alternative.
    let order: &[RuntimeKind] = if cfg!(target_os = "macos") {
        &[
            RuntimeKind::DockerDesktop,
            RuntimeKind::Colima,
            RuntimeKind::Orbstack,
            RuntimeKind::PodmanDesktop,
            RuntimeKind::Podman,
        ]
    } else if cfg!(target_os = "windows") {
        &[RuntimeKind::DockerDesktop, RuntimeKind::Podman]
    } else {
        &[
            RuntimeKind::DockerEngine,
            RuntimeKind::Podman,
            RuntimeKind::Nerdctl,
            RuntimeKind::PodmanDesktop,
        ]
    };
    for (i, kind) in order.iter().enumerate() {
        out.push(probe_runtime(*kind, /* default_on_this_os = */ i == 0));
    }
    out
}

fn probe_runtime(kind: RuntimeKind, default_on_this_os: bool) -> RuntimeProbe {
    let home = std::env::var("HOME").ok();
    let (installed, running, detail) = match kind {
        RuntimeKind::DockerDesktop => probe_docker_desktop(home.as_deref()),
        RuntimeKind::DockerEngine => probe_docker_engine(),
        RuntimeKind::Colima => probe_colima(home.as_deref()),
        RuntimeKind::Orbstack => probe_orbstack(home.as_deref()),
        RuntimeKind::Podman => probe_podman(),
        RuntimeKind::PodmanDesktop => probe_podman_desktop(),
        RuntimeKind::Nerdctl => probe_nerdctl(),
    };
    RuntimeProbe {
        kind_id: kind.id().into(),
        label: kind.label().into(),
        installed,
        running,
        install_command: if installed {
            None
        } else {
            install_command_for_runtime(kind)
        },
        detail,
        default_on_this_os,
    }
}

fn probe_docker_desktop(_home: Option<&str>) -> (bool, bool, String) {
    // macOS: app bundle in /Applications.
    if cfg!(target_os = "macos") {
        let app = PathBuf::from("/Applications/Docker.app");
        if app.is_dir() {
            let running = PathBuf::from("/var/run/docker.sock").exists();
            return (
                true,
                running,
                if running {
                    "/Applications/Docker.app (daemon running)".into()
                } else {
                    "/Applications/Docker.app (daemon not running — open the app)".into()
                },
            );
        }
        return (
            false,
            false,
            "Not installed at /Applications/Docker.app".into(),
        );
    }
    // Windows: ProgramFiles install dir + the docker CLI on PATH.
    if cfg!(target_os = "windows") {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
        let app = PathBuf::from(format!("{pf}\\Docker\\Docker\\Docker Desktop.exe"));
        if app.is_file() {
            // Windows can't probe the unix socket; rely on docker CLI
            // existence as a weaker "running" signal. The user can
            // launch Docker Desktop from the picker if not running.
            let running = which("docker").is_some();
            return (
                true,
                running,
                "Docker Desktop installed in Program Files".into(),
            );
        }
        return (
            false,
            false,
            "Not installed — get it from docker.com".into(),
        );
    }
    // Linux: Docker Desktop is technically supported but unusual on
    // server distros. Probe the well-known install path but don't
    // surface as a default.
    let app = PathBuf::from("/opt/docker-desktop");
    if app.is_dir() {
        return (true, false, "/opt/docker-desktop installed".into());
    }
    (
        false,
        false,
        "Not installed (Linux servers usually use Docker Engine)".into(),
    )
}

fn probe_docker_engine() -> (bool, bool, String) {
    // Distinct from Docker Desktop: this is the open-source dockerd
    // running directly on the host. Only meaningful on Linux. We
    // detect it by `docker` on PATH AND the absence of a Docker
    // Desktop app bundle nearby — on macOS/Windows that's always
    // Docker Desktop, so we mark not-installed there to avoid
    // duplicate runtime cards.
    if !cfg!(target_os = "linux") {
        return (false, false, "Docker Engine is Linux-only".into());
    }
    match which("docker") {
        Some(p) => {
            let running = PathBuf::from("/var/run/docker.sock").exists()
                || PathBuf::from("/run/docker.sock").exists();
            (
                true,
                running,
                if running {
                    format!("{} (socket present)", p.display())
                } else {
                    format!("{} (no daemon socket)", p.display())
                },
            )
        }
        None => (false, false, "`docker` not on PATH".into()),
    }
}

fn probe_colima(home: Option<&str>) -> (bool, bool, String) {
    let Some(home) = home else {
        return (false, false, "$HOME not set".into());
    };
    let colima_bin = which("colima");
    let sock = PathBuf::from(format!("{home}/.colima/default/docker.sock"));
    match colima_bin {
        Some(p) => {
            let running = sock.exists();
            (
                true,
                running,
                if running {
                    format!("{} (socket at {})", p.display(), sock.display())
                } else {
                    format!("{} (not started — run `colima start`)", p.display())
                },
            )
        }
        None => (
            false,
            false,
            "`colima` not on PATH (brew install colima)".into(),
        ),
    }
}

fn probe_orbstack(home: Option<&str>) -> (bool, bool, String) {
    if !cfg!(target_os = "macos") {
        return (false, false, "OrbStack is macOS-only".into());
    }
    let app = PathBuf::from("/Applications/OrbStack.app");
    if !app.is_dir() {
        return (
            false,
            false,
            "Not installed — get it from orbstack.dev".into(),
        );
    }
    let Some(home) = home else {
        return (true, false, "OrbStack installed; $HOME unset".into());
    };
    let sock = PathBuf::from(format!("{home}/.orbstack/run/docker.sock"));
    let running = sock.exists();
    (
        true,
        running,
        if running {
            format!("/Applications/OrbStack.app (socket at {})", sock.display())
        } else {
            "/Applications/OrbStack.app (not running — open the app)".into()
        },
    )
}

fn probe_podman() -> (bool, bool, String) {
    match which("podman") {
        Some(p) => {
            // `podman` is rootless by default; treat "binary present"
            // as "running" because the CLI spins the daemon up on
            // demand. macOS / Windows needs `podman machine start`
            // first — we can't probe that cheaply without spawning.
            (true, true, format!("{} on PATH", p.display()))
        }
        None => (false, false, "`podman` not on PATH".into()),
    }
}

fn probe_podman_desktop() -> (bool, bool, String) {
    // Podman Desktop sits on top of plain `podman`. We probe the GUI
    // bundle to distinguish "user installed the GUI" from "user
    // installed the CLI only" — same `podman` binary either way.
    let candidates: Vec<PathBuf> = if cfg!(target_os = "macos") {
        vec![PathBuf::from("/Applications/Podman Desktop.app")]
    } else if cfg!(target_os = "windows") {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
        vec![PathBuf::from(format!("{pf}\\Podman Desktop"))]
    } else {
        vec![
            PathBuf::from("/opt/podman-desktop"),
            PathBuf::from("/usr/share/podman-desktop"),
        ]
    };
    let app = candidates.into_iter().find(|p| p.is_dir());
    match app {
        Some(p) => (
            true,
            which("podman").is_some(),
            format!(
                "{} (podman CLI {})",
                p.display(),
                if which("podman").is_some() {
                    "present"
                } else {
                    "missing"
                }
            ),
        ),
        None => (false, false, "Podman Desktop not installed".into()),
    }
}

fn probe_nerdctl() -> (bool, bool, String) {
    match which("nerdctl") {
        Some(p) => (true, true, format!("{} on PATH", p.display())),
        None => (false, false, "`nerdctl` not on PATH".into()),
    }
}

fn install_command_for_runtime(kind: RuntimeKind) -> Option<String> {
    if cfg!(target_os = "macos") {
        return Some(match kind {
            RuntimeKind::DockerDesktop => "brew install --cask docker".into(),
            RuntimeKind::Colima => "brew install colima docker  # then: colima start".into(),
            RuntimeKind::Orbstack => "brew install --cask orbstack".into(),
            RuntimeKind::Podman => {
                "brew install podman  # then: podman machine init && podman machine start".into()
            }
            RuntimeKind::PodmanDesktop => "brew install --cask podman-desktop".into(),
            RuntimeKind::Nerdctl => {
                "brew install lima-additional-guestagents nerdctl  # rare on macOS".into()
            }
            RuntimeKind::DockerEngine => return None,
        });
    }
    if cfg!(target_os = "windows") {
        return Some(match kind {
            RuntimeKind::DockerDesktop => "winget install -e --id Docker.DockerDesktop".into(),
            RuntimeKind::Podman => "winget install -e --id RedHat.Podman".into(),
            RuntimeKind::PodmanDesktop => "winget install -e --id RedHat.Podman-Desktop".into(),
            _ => return None,
        });
    }
    // Linux — generic family-aware suggestions. We don't have the
    // OsFamily here without re-detecting; defer to the existing
    // install_runtime() hint which the picker already shows under
    // the Docker doctor card.
    None
}

/// JSON serialization for the runtime probe list, consumed by the
/// mode-picker WebView via `window.__doctor.runtimes`.
pub fn runtimes_to_json(runtimes: &[RuntimeProbe]) -> String {
    serde_json::to_string(runtimes).unwrap_or_else(|_| "[]".into())
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
