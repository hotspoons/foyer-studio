// Clap definitions for `foyer`. Kept apart from `main.rs` so the
// dispatcher stays readable — the type+attribute fan-out for clap
// derives is most of the bulk of either file.

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::{Parser, Subcommand};
use foyer_config as cfg;

#[derive(Parser)]
#[command(name = "foyer", version, about = "Foyer Studio runtime")]
pub struct Cli {
    /// Override the config file location. Defaults to
    /// $XDG_DATA_HOME/foyer/config.yaml.
    #[arg(long, global = true)]
    pub config: Option<PathBuf>,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
// Each `Serve` flag surfaces as its own field per clap's derive idiom;
// boxing them to placate `large_enum_variant` would just push the
// fan-out one layer deeper. The Configure variant is small but rarely
// constructed, so the size delta vs. Serve is fine in practice.
#[allow(clippy::large_enum_variant)]
pub enum Command {
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
        /// Bind-mount the host's JACK / PipeWire-JACK socket dir
        /// into the container. Linux only. Mutually exclusive with
        /// `--integrated` / `--netjack`.
        #[arg(long, conflicts_with_all = ["integrated", "netjack"])]
        jack: bool,
        /// Connect to a NetJACK server over TCP. Set `--netjack-host`
        /// / `--netjack-port` (or `FOYER_NETJACK_HOST` /
        /// `FOYER_NETJACK_PORT`) to point at it. Mutually exclusive
        /// with `--integrated` / `--jack`.
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
        /// Ignored when `--network=host`.
        #[arg(long, value_name = "PORT")]
        host_port: Option<u16>,
        /// Container networking mode. `bridge` (default) publishes
        /// the sidecar port through Docker's bridge driver; `host`
        /// shares the host's network namespace directly (Linux only,
        /// lower latency, required for mDNS / NetJACK auto-discovery).
        #[arg(long, value_enum, value_name = "MODE")]
        network: Option<cfg::DockerNetwork>,
        /// NetJACK target host. Only meaningful with `--netjack`.
        #[arg(long, value_name = "HOST")]
        netjack_host: Option<String>,
        /// NetJACK target port. Default 19000.
        #[arg(long, value_name = "PORT")]
        netjack_port: Option<u16>,
        /// Detach instead of streaming logs.
        #[arg(short, long, default_value_t = false)]
        detach: bool,
        /// Print the assembled command without running it.
        #[arg(long, default_value_t = false)]
        dry_run: bool,
        /// Run the pre-flight dependency checks for the selected
        /// mode and print results, then exit. Combine with `--json`
        /// to get machine-readable output (used by the desktop
        /// wrapper's setup wizard).
        #[arg(long, default_value_t = false)]
        doctor: bool,
        /// Emit `--doctor` output as JSON instead of human-readable
        /// lines. No-op without `--doctor`.
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// Pre-flight check for host mode (the embedded foyer-server
    /// plus local Ardour path). Symmetric with `foyer docker
    /// --doctor`. Exits cleanly after printing the result so the
    /// desktop wrapper's setup wizard can spawn it without
    /// orphaning a long-lived process. Use `--json` for
    /// machine-readable output.
    DoctorHost {
        /// Emit JSON instead of human-readable lines. The desktop
        /// picker uses this to render the dependency-check cards.
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// Probe every container runtime we know about (Docker Desktop,
    /// Colima, OrbStack, Podman, Podman Desktop, nerdctl) and report
    /// which are installed + running. Drives the desktop mode
    /// picker's runtime-selection page on macOS / Windows. Always
    /// emits JSON — the picker is the only consumer.
    DoctorRuntimes,
    /// Discover a locally-installed Ardour and probe its version
    /// against the embedded shim's ABI target. Always emits JSON.
    /// Drives the desktop picker's macOS native-Ardour sub-mode
    /// card; the picker uses it to show "found 9.5.0 ✓" /
    /// "found 9.4.2 — ABI mismatch" / "not installed" with an
    /// actionable download button.
    DoctorArdour,
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
