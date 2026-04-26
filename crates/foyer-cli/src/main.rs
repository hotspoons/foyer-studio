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
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cli = Cli::parse();

    let config = load_config(cli.config.as_deref())?;

    match cli.command {
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
                "127.0.0.1:3838".parse().unwrap()
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
            )
            .await
        }
    }
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
        match cfg::detect_ardour_executable() {
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
    let spawner = Arc::new(CliSpawner {
        config: config.clone(),
        jail: jail.clone(),
        stub_test_tone: stub_test_tone_resolved,
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

    let initial_backend: Arc<dyn Backend> = match (backend.kind, socket.clone()) {
        (BackendKind::Ardour, Some(s)) => {
            let host = HostBackend::connect(s.clone())
                .await
                .with_context(|| format!("connect to shim at {}", s.display()))?;
            tracing::info!("connected to shim at {}", s.display());
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
                    let mut b = StubBackend::launcher().with_test_tone(stub_test_tone_resolved);
                    if let Some(root) = &jail {
                        b = b.with_jail(root.clone());
                    }
                    Arc::new(b)
                }
            }
        }
        _ => spawner
            .launch(&backend.id, project.as_deref())
            .await
            .with_context(|| format!("launch backend `{}`", backend.id))?,
    };

    let server = Server::with_spawner(initial_backend, Some(spawner.clone()));
    server.load_tunnel_config(&config.tunnel).await;
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
    ) -> anyhow::Result<Arc<dyn Backend>> {
        let cfg_backend = self
            .config
            .backend(backend_id)
            .ok_or_else(|| anyhow!("no backend with id `{backend_id}`"))?;
        if !cfg_backend.enabled {
            return Err(anyhow!("backend `{backend_id}` is disabled"));
        }
        match cfg_backend.kind {
            BackendKind::Stub => {
                let mut b = StubBackend::new().with_test_tone(self.stub_test_tone);
                if let Some(root) = &self.jail {
                    b = b.with_jail(root.clone());
                }
                if let Some(p) = project_path {
                    let _ = b.open_session(&p.display().to_string()).await;
                }
                Ok(Arc::new(b))
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
                let socket =
                    launch_and_wait_for_shim(&exec, &cfg_backend.args, &cfg_backend.env, &abs)
                        .await?;
                let host = HostBackend::connect(socket.clone())
                    .await
                    .with_context(|| format!("connect to shim at {}", socket.display()))?;
                Ok(Arc::new(host))
            }
        }
    }
}

/// Spawn the configured DAW with the project as argv and poll the
/// discovery directory until its shim advertises. Returns the shim's
/// UDS path. Times out after ~30 seconds. We intentionally DON'T kill
/// the child on drop — the user may want Ardour to outlive the
/// sidecar if they reconnect later.
///
/// Dev-build awareness: when `exec` lives inside an Ardour source
/// checkout (`<root>/build/gtk2_ardour/`), we wrap the spawn in a bash
/// shell that first sources `ardev_common_waf.sh` (sets LD_LIBRARY_PATH,
/// ARDOUR_DATA_PATH, etc. — the same env you'd get from `just
/// ardour-hardev`) and prepends the Foyer shim to `ARDOUR_SURFACES_PATH`
/// so the shim activates without manual XML surgery on the session file.
/// System-installed Ardours (on `$PATH` or in `/Applications/...`) are
/// exec'd directly — they don't need the wrapper.
async fn launch_and_wait_for_shim(
    exec: &std::path::Path,
    extra_args: &[String],
    env: &std::collections::BTreeMap<String, String>,
    project: &std::path::Path,
) -> Result<PathBuf> {
    use std::time::Duration;

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
    tracing::info!(
        "resolved project {} → DIR={} NAME={}",
        project.display(),
        session_dir.display(),
        snapshot_name,
    );

    let dev_root = foyer_config::ardour_dev_root(&resolved_exec);
    let mut cmd = if let Some(ref root) = dev_root {
        let shim = root.join("build/libs/surfaces/foyer_shim");
        // Script does four things before handing off to Ardour:
        //   1. Source `ardev_common_waf.sh` so lib paths resolve.
        //   2. Default `ARDOUR_BACKEND` to "None (Dummy)" for devcontainer
        //      / CI hosts that don't have JACK running. User can override
        //      via config.yaml `env`.
        //   3. Prepend the Foyer shim to ARDOUR_SURFACES_PATH.
        //   4. Pre-flight the session file:
        //      · If <DIR>/<NAME>.ardour doesn't exist, bootstrap it via
        //        `ardour<N>-new_empty_session`.
        //      · If the Protocols block doesn't list Foyer Studio Shim
        //        with active="1", insert that line. Without this, Ardour
        //        loads the surface library but never instantiates the
        //        shim — no advertisement is written and the sidecar
        //        times out waiting.
        // NOTE on quoting: the `{shim}` / `{dir}` / `{name}` etc. come
        // from `shell_escape()` which wraps them in single quotes so
        // they're safe as STANDALONE arguments (e.g. `VAR='...'`).
        // Inside a double-quoted string those single quotes become
        // literal. So we first assign each path to a bash var (where
        // bash strips the surrounding quotes), then interpolate the
        // var inside double-quoted compound strings.
        let script = format!(
            r#"set -e
export TOP={top}
source "$TOP/build/gtk2_ardour/ardev_common_waf.sh"
: "${{ARDOUR_BACKEND:=None (Dummy)}}"
export ARDOUR_BACKEND
FOYER_SHIM_DIR={shim}
export ARDOUR_SURFACES_PATH="$FOYER_SHIM_DIR${{ARDOUR_SURFACES_PATH:+:$ARDOUR_SURFACES_PATH}}"

DIR={dir}
NAME={name}
SESSION_DIR="$DIR"
SESSION_FILE="$SESSION_DIR/$NAME.ardour"

if [ ! -f "$SESSION_FILE" ]; then
    # `ardour9-new_empty_session <leaf-dir> <name>` CREATES <leaf-dir>
    # and writes <leaf-dir>/<name>.ardour inside. It refuses to run
    # when <leaf-dir> already exists ("Session folder already exists",
    # then throws SessionException). Earlier versions of this script
    # `mkdir -p`'d the dir first and then wondered why the helper
    # always failed — kicking $DIR/$NAME directly without
    # pre-creating it is the working pattern.
    LEAF_DIR="$DIR/$NAME"
    # If a previous failed run left an empty $LEAF_DIR, clean it up
    # so the helper can mkdir it itself. A non-empty dir we leave
    # alone — caller can rm -rf manually once they're sure.
    if [ -d "$LEAF_DIR" ] && [ -z "$(ls -A "$LEAF_DIR" 2>/dev/null)" ]; then
        rmdir "$LEAF_DIR" 2>/dev/null || true
    fi
    for HELPER in "$TOP"/build/session_utils/ardour*-new_empty_session; do
        if [ -x "$HELPER" ]; then
            echo "foyer: bootstrapping new session $LEAF_DIR via $HELPER" >&2
            "$HELPER" "$LEAF_DIR" "$NAME" || true
            if [ -f "$LEAF_DIR/$NAME.ardour" ]; then
                SESSION_DIR="$LEAF_DIR"
                SESSION_FILE="$SESSION_DIR/$NAME.ardour"
            fi
            break
        fi
    done
fi

if [ ! -f "$SESSION_FILE" ]; then
    echo "foyer: ERROR failed to create session file $SESSION_FILE" >&2
    echo "foyer: hint: run '$TOP/build/session_utils/ardour9-new_empty_session \"$DIR/$NAME\" \"$NAME\"' manually" >&2
    echo "foyer: hint: also remove any leftover dir: rm -rf \"$DIR/$NAME\"" >&2
    exit 1
fi

if [ -f "$SESSION_FILE" ] && ! grep -q 'name="Foyer Studio Shim" active="1"' "$SESSION_FILE"; then
    if grep -q 'name="Foyer Studio Shim"' "$SESSION_FILE"; then
        # Already listed but inactive — flip active="0" to "1".
        echo "foyer: flipping Foyer Studio Shim to active=\"1\" in $SESSION_FILE" >&2
        sed -i 's|<Protocol name="Foyer Studio Shim" active="0"\([^/]*\)/>|<Protocol name="Foyer Studio Shim" active="1"\1/>|' "$SESSION_FILE"
    elif grep -q '</ControlProtocols>' "$SESSION_FILE"; then
        # Not listed yet — insert before the closing </ControlProtocols>.
        # Universal anchor that doesn't depend on which protocols Ardour
        # happens to ship with in this build.
        echo "foyer: inserting Foyer Studio Shim into $SESSION_FILE" >&2
        sed -i 's|  </ControlProtocols>|    <Protocol name="Foyer Studio Shim" active="1"/>\n  </ControlProtocols>|' "$SESSION_FILE"
    else
        echo "foyer: WARNING no <ControlProtocols> block found in $SESSION_FILE — add Foyer Studio Shim by hand" >&2
    fi
fi

exec {exec} "$@" "$SESSION_DIR" "$NAME""#,
            top = shell_escape(root.to_string_lossy().as_ref()),
            shim = shell_escape(shim.to_string_lossy().as_ref()),
            exec = shell_escape(resolved_exec.to_string_lossy().as_ref()),
            dir = shell_escape(session_dir.to_string_lossy().as_ref()),
            name = shell_escape(&snapshot_name),
        );
        tracing::info!(
            "dev-build Ardour detected at {} — sourcing ardev env + foyer_shim surface",
            root.display()
        );
        let mut c = tokio::process::Command::new("bash");
        c.arg("-c").arg(script).arg("bash"); // $0
        for a in extra_args {
            c.arg(a);
        }
        // DIR + NAME are baked into the script via $DIR/$NAME so the
        // pre-flight can use them. They're appended to argv via the
        // `exec ... "$@" "$DIR" "$NAME"` line in the script.
        c
    } else {
        tracing::info!(
            "spawning {} {} {} {}",
            resolved_exec.display(),
            extra_args.join(" "),
            session_dir.display(),
            snapshot_name,
        );
        let mut c = tokio::process::Command::new(&resolved_exec);
        for a in extra_args {
            c.arg(a);
        }
        c.arg(&session_dir);
        c.arg(&snapshot_name);
        c
    };
    // Apply any env overrides from config.yaml. These land on the bash
    // wrapper (or the direct exec) so the `:=` defaults in the script
    // pick them up instead of overriding.
    for (k, v) in env {
        cmd.env(k, v);
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
    let _child = cmd
        .spawn()
        .with_context(|| format!("spawn {}", resolved_exec.display()))?;

    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        for s in discovery::scan() {
            if !before.contains(&s.socket) {
                tracing::info!("shim advertised at {}", s.socket.display());
                return Ok(s.socket);
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err(anyhow!(
                "timed out waiting for shim advertisement after spawn (did you run `just shim-build`?)"
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
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
    if !data_dir.join("index.html").exists() {
        extract_bundled_web(&data_dir)
            .with_context(|| format!("extracting bundled web/ to {}", data_dir.display()))?;
    }
    Ok(Some(data_dir))
}

/// First-run extract: write every file in `BUNDLED_WEB` to `dst`.
/// Creates parent directories as needed and overwrites nothing (the
/// existence check in `resolve_web_root` already guaranteed this is
/// a fresh extract).
fn extract_bundled_web(dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst).with_context(|| format!("mkdir -p {}", dst.display()))?;
    tracing::info!("extracting bundled web/ to {}", dst.display());
    write_dir_contents(&BUNDLED_WEB, dst)?;
    // Drop a breadcrumb so users know where to hack and how to reset.
    let readme = dst.join("INSTALLED-HERE.txt");
    let _ = std::fs::write(
        &readme,
        "This directory was seeded from the Foyer binary's bundled web/ on\n\
         first run. You can edit anything here — refresh the browser to see\n\
         changes. See HACKING.md for recipes.\n\n\
         To reset to the shipped assets: delete this folder and restart `foyer serve`.\n",
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
