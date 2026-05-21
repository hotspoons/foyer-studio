// SPDX-License-Identifier: Apache-2.0
//! Foyer Studio user config.
//!
//! Lives at `$XDG_DATA_HOME/foyer/config.yaml` (defaults to
//! `~/.local/share/foyer/config.yaml` on Linux, `~/Library/Application
//! Support/foyer/config.yaml` on macOS). Seeded on first run with a
//! stub backend (always safe, renders dummy data) plus an Ardour
//! backend with an auto-detected executable path. Users can add more
//! backends by hand (Reaper, Bitwig, …) once shims land for them.
//!
//! The config is intentionally small — it's the bootstrap step before
//! a real DAW process comes up. Runtime state (open projects, recent
//! sessions, layouts) lives elsewhere.
//!
//! ## Schema
//!
//! ```yaml
//! version: 1
//! default_backend: stub
//! launcher:
//!   jail: ~/Music         # optional — restricts the project picker
//!   recent: []            # populated as the user opens projects
//! backends:
//!   - id: stub
//!     kind: stub
//!     enabled: true
//!     label: "Dummy (no DAW)"
//!   - id: ardour
//!     kind: ardour
//!     enabled: true
//!     label: "Ardour"
//!     executable: /usr/bin/ardour8
//!     args: []            # extra args passed before the project path
//!     env: {}             # env vars injected into the child process
//! ```

#![forbid(unsafe_code)]

pub mod roles;

pub use roles::{load_or_seed_roles, load_or_seed_roles_at, roles_path, RoleDef, RolesConfig};

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub const CONFIG_FILENAME: &str = "config.yaml";
pub const CONFIG_SCHEMA_VERSION: u32 = 1;

/// Top-level config file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_version")]
    pub version: u32,
    /// The backend `id` to launch with when `--backend` isn't given on
    /// the CLI. The matching entry must exist in `backends` and be
    /// `enabled: true`.
    #[serde(default = "default_backend_id")]
    pub default_backend: String,
    #[serde(default)]
    pub launcher: LauncherConfig,
    /// Optional server settings — listen address + TLS pair. CLI flags
    /// still win when present; this is the "I always want LAN-HTTPS
    /// when I launch this install" fallback.
    #[serde(default)]
    pub server: ServerConfig,
    /// Tunnel provider configuration (ngrok, cloudflare, etc.)
    #[serde(default)]
    pub tunnel: TunnelConfig,
    #[serde(default)]
    pub backends: Vec<BackendConfig>,
    /// Container-launch settings used by `foyer docker`. None means
    /// `foyer docker` falls back to its built-in defaults (latest
    /// image, integrated mode, podman if available else docker).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docker: Option<DockerConfig>,
    /// `foyer-desktop` runtime preferences. Persisted by the first-
    /// run mode picker so subsequent launches skip the prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<DesktopConfig>,
    /// AI agent harness server-side settings. The user-facing
    /// model / key / autonomy live on the live runtime (and the
    /// settings modal); only deployment-level knobs land here.
    #[serde(default)]
    pub agent: AgentConfig,
    /// Upstream MCP servers Foyer's `daw_proxy` agent tool will speak
    /// to. Each entry is a backend DAW's MCP HTTP endpoint (e.g.
    /// Ardour's `mcp_http` surface at `http://127.0.0.1:4820/mcp`).
    /// The proxy advertises the upstream's tools as subcommands of a
    /// single Foyer tool, with on-demand schema fetch — see
    /// [`McpProxyConfig`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_proxies: Vec<McpProxyConfig>,
}

/// One entry in the `mcp_proxies:` config block — a backend DAW (or
/// other MCP server) Foyer's `daw_proxy` tool will reach into.
///
/// **Why a single proxy tool instead of registering each upstream
/// tool as its own Foyer tool?** Ardour's MCP surface alone is 70+
/// tools; loading their full schemas into every prompt would eat
/// thousands of tokens before the agent even reads the user's
/// question. The proxy advertises only the AGGREGATE surface
/// (1 tool), and lets the agent fetch detailed schemas for the
/// specific upstream tools it actually intends to call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpProxyConfig {
    /// Stable id (e.g. `ardour`, `bitwig`). Used as the proxy
    /// subcommand selector + the cache filename prefix.
    pub id: String,
    /// Human-readable label shown in `daw_proxy.list_backends`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Full URL of the upstream MCP streamable-HTTP endpoint,
    /// including the `/mcp` path. e.g. `http://127.0.0.1:4820/mcp`.
    pub endpoint: String,
    /// Optional Bearer token for `Authorization`. Same precedence as
    /// the agent config: env var override wins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Skip this entry without removing it from the config.
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// Deployment-level agent settings, set in `config.yaml`. None of
/// these are user-facing — the in-app settings modal handles the
/// per-session LLM transport (endpoint / key / model) and autonomy
/// mode.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// When `true`, the `visualize` tool prefers the headless
    /// chromium renderer over an attached browser tab. **Defaults to
    /// `true`** — the FE-attached path can only render views that are
    /// currently mounted in the user's browser (mixer, midi-roll,
    /// etc. fail when those panels aren't open), whereas the headless
    /// renderer loads each view fresh into its own offscreen page
    /// and always succeeds for every supported subcommand. Set to
    /// `false` if you specifically want to reuse the live tab's cached
    /// peaks and have accepted the mount-state dependency. Requires
    /// the `headless-render` cargo feature (default on) and chromium
    /// on PATH (`apt install chromium` on Debian/Ubuntu).
    #[serde(default = "default_prefer_headless_render")]
    pub prefer_headless_render: bool,
    /// Upstream OpenAI-compatible endpoint base (no trailing
    /// `/chat/completions`). When set, seeds the agent's LLM transport
    /// at boot — wins over the persisted store but loses to a CLI flag
    /// or matching env var. Leave unset to let the FAB-saved value
    /// (or built-in WebLLM-bridge default) win.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_endpoint: Option<String>,
    /// Upstream model id passed in the chat-completions body. Same
    /// precedence chain as `upstream_endpoint`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_model: Option<String>,
    /// Optional API key for the upstream endpoint (`Authorization:
    /// Bearer …` for OpenAI-shape providers; `x-api-key` is also set
    /// when the URL looks Anthropic). Same precedence chain. Prefer
    /// the `FOYER_AGENT_UPSTREAM_API_KEY` env var on shared hosts so
    /// the secret doesn't end up in config.yaml.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_api_key: Option<String>,
    /// API key REQUIRED on the OpenAI-compatible endpoint Foyer
    /// exposes at `/v1/*`. When unset the surface is open (operator
    /// must keep it loopback-only or behind their own auth proxy);
    /// when set, every `/v1/*` request must carry
    /// `Authorization: Bearer <key>`. Same precedence chain as the
    /// other agent fields — `FOYER_AGENT_API_KEY` env var or
    /// `--agent-api-key` CLI flag win over this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            prefer_headless_render: default_prefer_headless_render(),
            upstream_endpoint: None,
            upstream_model: None,
            upstream_api_key: None,
            api_key: None,
        }
    }
}

fn default_prefer_headless_render() -> bool {
    true
}

/// Behaviour of the `foyer-desktop` native shell.
///
/// First launch shows an in-window picker (no terminal needed) for
/// `mode` and saves the user's choice. Subsequent launches read
/// `mode` and skip the prompt; pass `--reset-mode` (or delete the
/// `desktop` block from config.yaml) to re-prompt.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DesktopConfig {
    /// `"host"` runs `foyer-server` in-process inside the desktop
    /// shell. `"docker"` spawns `foyer docker` (modes inherited
    /// from `docker:` config) and points the WebView at the
    /// container's published port. Unset = first-launch picker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<DesktopMode>,
    /// Open the WebView fullscreen by default. Off by default — the
    /// native shell starts at 1440×900 so the user can keep working
    /// in other apps; flip to `true` on a kiosk / studio rig.
    #[serde(default, skip_serializing_if = "is_default_false")]
    pub fullscreen: bool,
}

/// Run mode for `foyer-desktop`. The picker dialog writes this back
/// into config.yaml after the user clicks one of the two buttons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopMode {
    /// Embed `foyer-server` in-process; the sidecar lives in the same
    /// binary as the WebView. No container runtime needed.
    Host,
    /// Spawn `foyer docker` (using `docker:` config defaults) and
    /// open the WebView on the container's exposed port.
    Docker,
}

/// Defaults for the `foyer docker` orchestration command.
///
/// `mode` picks audio-engine integration:
///   · `integrated` (default) — runs Foyer's dummy/stub backend with
///     SYS_NICE + IPC_LOCK so the in-container audio graph still has
///     real-time priority. No external JACK needed; usable on hosts
///     without a sound server at all (Cloud Run, headless CI).
///   · `jack` — bind-mounts the host's JACK socket dir into the
///     container so the in-container Ardour talks to the host's
///     JACK daemon. Linux only; Docker-on-Mac's VM breaks this.
///   · `netjack` — connects to a NetJACK server over TCP. Works
///     cross-platform but adds network jitter.
///
/// `image` defaults to `ghcr.io/hotspoons/foyer-studio:latest`. Set
/// to a per-commit tag (`snapshot-abc1234`) to pin.
///
/// `runtime` lets the user force a specific container runtime when
/// multiple are installed (`podman`, `docker`, `nerdctl`); auto-
/// picks based on PATH otherwise.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DockerConfig {
    /// Which container runtime to use. Auto-picked from PATH when
    /// unset (preference: podman → docker → nerdctl). Set explicitly
    /// for hosts with multiple runtimes installed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    /// Container image reference. Default
    /// `ghcr.io/hotspoons/foyer-studio:latest`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// Default audio mode for `foyer docker` invocations without an
    /// explicit `--integrated`/`--jack`/`--netjack` flag. Defaults
    /// to `integrated`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<DockerMode>,
    /// Host port to publish the container's 3838 on. Defaults to
    /// 3838 (same as the host-mode sidecar) — flip this when the
    /// host already has a foyer sidecar running and you want to
    /// run the container alongside.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_port: Option<u16>,
    /// Extra command-line arguments appended to the runtime's `run`
    /// invocation, before the image name. Use for host-specific
    /// flags `foyer docker` doesn't know about (e.g.,
    /// `["--gpus", "all"]` on a CUDA box). Order: foyer-managed
    /// flags first, then these, then `image` last.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_args: Vec<String>,
}

/// Audio-engine integration mode for `foyer docker`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DockerMode {
    /// No external audio system — container runs Foyer's dummy
    /// backend with elevated caps so low-latency processing still
    /// works. Smallest setup; default.
    #[default]
    Integrated,
    /// Bind-mount the host's JACK socket dir. Linux only.
    Jack,
    /// Connect to a NetJACK server over TCP. Cross-platform.
    Netjack,
}

/// Network config for the sidecar's HTTP/WS surface. Both fields
/// optional; unset leaves the CLI defaults (`127.0.0.1:3838`, no TLS).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServerConfig {
    /// Bind address like `"0.0.0.0:3838"`. Overrides the CLI default
    /// but is still overridable with `--listen` on the command line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen: Option<String>,
    /// Path to a PEM-encoded TLS certificate chain. When set together
    /// with `tls_key`, the server runs HTTPS / WSS. Self-signed certs
    /// work for LAN use — see `just run-lan-tls`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_cert: Option<PathBuf>,
    /// Path to a PEM-encoded TLS private key matching `tls_cert`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_key: Option<PathBuf>,
}

fn default_version() -> u32 {
    CONFIG_SCHEMA_VERSION
}
fn default_backend_id() -> String {
    "ardour".to_string()
}

/// Tunnel provider configuration stored in config.yaml.
/// Both `ngrok` and `cloudflare` sections can coexist — the user picks
/// which one to activate via the UI or CLI.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TunnelConfig {
    /// Ngrok-specific settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ngrok: Option<NgrokTunnelConfig>,
    /// Cloudflare-specific settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloudflare: Option<CloudflareTunnelConfig>,
    /// Secondary server bind address for Cloudflare tunnel auth.
    /// Defaults to 127.0.0.1:3839 (main server + 1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NgrokTunnelConfig {
    /// Ngrok auth token. Stored here so no env var is required.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub auth_token: Option<String>,
    /// Region to request (us, eu, ap, au, sa, jp, in).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub region: Option<String>,
    /// Subdomain for paid plans.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub subdomain: Option<String>,
    /// Custom domain (paid feature).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub domain: Option<String>,
}

/// Tunnel credentials for Cloudflare. Three usable shapes, checked in
/// priority order when the user clicks "enable":
///
///   1. **Auto-provision** — `api_token` + `account_id` + `hostname`
///      (+ optional `zone_id`, `tunnel_name`). Server creates/reuses a
///      Cloudflare Tunnel via the REST API, configures ingress, and
///      upserts the DNS CNAME record. No manual dashboard steps needed.
///   2. **Raw tunnel token** — `tunnel_token` + `hostname`. User pastes
///      the connector token from the Zero Trust dashboard; ingress/DNS
///      must already be set up there. Useful when the user won't hand
///      over an API token.
///   3. **Quick tunnel** — everything empty. Falls through to
///      cloudflared's `--url` quick tunnel on `*.trycloudflare.com`. No
///      account required, no persistence, URL rotates each launch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloudflareTunnelConfig {
    /// API token (Account:Cloudflare Tunnel:Edit + Zone:DNS:Edit).
    /// Triggers auto-provision mode when set alongside `account_id` and
    /// `hostname`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub api_token: Option<String>,
    /// Account ID — copy from Cloudflare dashboard sidebar.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub account_id: Option<String>,
    /// DNS zone ID. Optional — server auto-discovers via `GET /zones`
    /// and longest-suffix match on `hostname` when omitted.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub zone_id: Option<String>,
    /// Tunnel name for create-or-reuse. Defaults to a slug derived from
    /// `hostname`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tunnel_name: Option<String>,
    /// Public hostname to serve on (e.g. `studio.example.com`). Required
    /// for the two named-tunnel modes; omit for a quick tunnel.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub hostname: Option<String>,
    /// Raw Tunnel token pasted from the dashboard. Skips the API flow —
    /// use this when you don't want to hand over an API token and are
    /// happy configuring ingress/DNS on the dashboard yourself.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tunnel_token: Option<String>,
}

/// Picker + recent-files behavior.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LauncherConfig {
    /// When set, the project picker restricts browsing to this path and
    /// its descendants. Leave unset to allow browsing the whole FS
    /// (trusted-local mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jail: Option<PathBuf>,
    /// Recently opened project paths, most recent first. Capped at 20.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recent: Vec<PathBuf>,
}

/// One backend entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendConfig {
    pub id: String,
    pub kind: BackendKind,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Human-facing label for UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Path to the DAW executable. Not required for `kind: stub`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<PathBuf>,
    /// Extra args passed to the child BEFORE the project path argument.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// Env vars to inject into the child process.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub env: std::collections::BTreeMap<String, String>,
    /// Stub-only: emit a 440 Hz reference tone on egress streams.
    /// Off by default — the stub is silent so a launcher-mode user
    /// hitting "Listen" doesn't get a sine in their headphones
    /// before they've connected a DAW. Useful for end-to-end audio
    /// path debugging. CLI `--stub-test-tone` overrides this.
    #[serde(default, skip_serializing_if = "is_default_false")]
    pub stub_test_tone: bool,
    /// Engine sample rate, in Hz. Used by the stub backend (sets
    /// [`foyer_schema::Session::sample_rate`] and every fabricated
    /// `TimelineMeta`); a future hook for Ardour spawns where the
    /// launcher needs to pin a rate before the session opens.
    ///
    /// `None` falls through to [`foyer_schema::DEFAULT_SAMPLE_RATE`].
    /// Override priority is CLI flag > `FOYER_SAMPLE_RATE` env > this
    /// field > schema default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<u32>,
}

fn is_default_false(b: &bool) -> bool {
    !*b
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendKind {
    /// In-memory fake session — no child process, canned data. Always
    /// safe to launch, useful for UI dev and demos.
    Stub,
    /// Ardour via our Control-Surface shim (libfoyer_shim.so).
    Ardour,
}

/// Return the directory where Foyer stores user data — typically
/// `$XDG_DATA_HOME/foyer` on Linux, `~/Library/Application
/// Support/foyer` on macOS, `%APPDATA%\foyer` on Windows. Errors if we
/// can't resolve a data-dir for the current user (very rare).
pub fn data_dir() -> Result<PathBuf> {
    let base = dirs::data_dir().context("no data dir for this user (HOME not set?)")?;
    Ok(base.join("foyer"))
}

/// Absolute path to the config file (may not yet exist).
pub fn config_path() -> Result<PathBuf> {
    Ok(data_dir()?.join(CONFIG_FILENAME))
}

/// Read the config if it exists, otherwise write a seeded default and
/// return that. Errors only on genuine IO / parse failures.
pub fn load_or_seed() -> Result<Config> {
    load_or_seed_at(&config_path()?)
}

/// Same as [`load_or_seed`] but with an explicit path — used by tests
/// and by `--config` overrides on the CLI.
pub fn load_or_seed_at(path: &Path) -> Result<Config> {
    if path.exists() {
        let raw = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        let cfg: Config =
            serde_yaml::from_str(&raw).with_context(|| format!("parse {}", path.display()))?;
        return Ok(cfg);
    }
    let cfg = seed_default();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let yaml = serde_yaml::to_string(&cfg).context("serialize default config")?;
    let header = "# Foyer Studio config — see crates/foyer-config/src/lib.rs for schema.\n\
                  # Edit this file to add more backends or change the launcher jail.\n";
    fs::write(path, format!("{header}{yaml}"))
        .with_context(|| format!("write seed config to {}", path.display()))?;
    tracing::info!("seeded default config at {}", path.display());
    Ok(cfg)
}

/// Save the config back to its canonical location.
pub fn save(cfg: &Config) -> Result<()> {
    save_at(cfg, &config_path()?)
}

pub fn save_at(cfg: &Config, path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let yaml = serde_yaml::to_string(cfg).context("serialize config")?;
    fs::write(path, yaml).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

/// Build a seeded default config. Exposed so tests and first-run
/// tooling can call it without hitting the filesystem.
pub fn seed_default() -> Config {
    let mut backends = vec![BackendConfig {
        id: "stub".into(),
        kind: BackendKind::Stub,
        enabled: true,
        label: Some("Dummy (no DAW)".into()),
        executable: None,
        args: Vec::new(),
        env: Default::default(),
        stub_test_tone: false,
        sample_rate: None,
    }];
    backends.push(BackendConfig {
        id: "ardour".into(),
        kind: BackendKind::Ardour,
        enabled: true,
        label: Some("Ardour".into()),
        executable: detect_ardour_executable(),
        args: Vec::new(),
        env: Default::default(),
        stub_test_tone: false,
        sample_rate: None,
    });
    Config {
        version: CONFIG_SCHEMA_VERSION,
        default_backend: "ardour".into(),
        launcher: LauncherConfig {
            jail: default_launcher_jail(),
            recent: Vec::new(),
        },
        server: ServerConfig::default(),
        tunnel: TunnelConfig::default(),
        backends,
        docker: None,
        desktop: None,
        agent: AgentConfig::default(),
        mcp_proxies: Vec::new(),
    }
}

/// Pick a sensible default jail for the session picker. Order:
///   1. `~/Music`            — standard DAW-session location on Linux/macOS
///   2. `~/Documents`        — common Windows / casual-user location
///   3. `~/Desktop`          — fallback for users who dump projects there
///   4. `/workspaces`        — devcontainer / Codespaces layout
///   5. `~/`                 — absolute last resort
///
/// The home-dir fallback is workable but noisy (it's mostly dotfiles on
/// a fresh system, which the jail filters out — so the picker looks
/// empty). Users can override by editing `launcher.jail` in config.yaml.
fn default_launcher_jail() -> Option<PathBuf> {
    if let Some(music) = dirs::audio_dir() {
        if music.exists() {
            return Some(music);
        }
    }
    if let Some(docs) = dirs::document_dir() {
        if docs.exists() {
            return Some(docs);
        }
    }
    if let Some(desktop) = dirs::desktop_dir() {
        if desktop.exists() {
            return Some(desktop);
        }
    }
    let workspaces = PathBuf::from("/workspaces");
    if workspaces.is_dir() {
        return Some(workspaces);
    }
    dirs::home_dir()
}

/// Try the usual Ardour binary names on `$PATH`, macOS app bundles, and
/// common dev-box layouts (`/workspaces/ardour/build/...` for the sibling
/// source checkout used by this repo). Returns `None` if nothing is found
/// — the caller decides whether that's a fatal config error.
///
/// Equivalent to [`detect_ardour_executable_for`] with no version
/// preference; kept as the zero-arg entry point for code paths
/// (config seeding, tests) that don't have a build-time target to
/// match against.
pub fn detect_ardour_executable() -> Option<PathBuf> {
    detect_ardour_executable_for(None)
}

/// Version-aware variant: when `target_version` is `Some("9.5")` (or
/// any `major.minor`-shaped string), a `$PATH` candidate is only
/// accepted if its `--version` output matches that major+minor.
/// Otherwise we fall through to the source-build scans, so a dev box
/// with an apt-installed Ardour 9.2 alongside a freshly-built
/// `ext/ardour/build/gtk2_ardour/ardour-9.5.0` picks the 9.5 binary
/// — avoiding the ABI mismatch where the shim was built against 9.5
/// libs but `/usr/bin/ardour` loads 9.2 ones at runtime.
///
/// Probing the candidate with `--version` is one short subprocess
/// per name in the search list; the cost is negligible compared to
/// any subsequent Ardour launch. If the probe fails (binary refuses
/// `--version`, output unparseable), we accept the candidate anyway
/// — better to launch and let the operator see a clearer downstream
/// error than to fall through silently.
pub fn detect_ardour_executable_for(target_version: Option<&str>) -> Option<PathBuf> {
    let target_mm = target_version.and_then(parse_major_minor);
    // 1. $PATH — preferred when Ardour is system-installed AND its
    //    major.minor matches our shim build target (when one is
    //    provided). On mismatch, fall through so the source-build
    //    scans below get a chance.
    for name in ["ardour9", "ardour8", "ardour7", "ardour6", "ardour"] {
        if let Some(p) = which_on_path(name) {
            if let Some(target) = target_mm {
                match probe_ardour_major_minor(&p) {
                    Some(installed) if installed != target => continue,
                    _ => {}
                }
            }
            return Some(p);
        }
    }
    // 2. macOS app bundles. Same version filter as the PATH branch.
    for candidate in [
        "/Applications/Ardour9.app/Contents/MacOS/Ardour9",
        "/Applications/Ardour8.app/Contents/MacOS/Ardour8",
        "/Applications/Ardour7.app/Contents/MacOS/Ardour7",
        "/Applications/Ardour.app/Contents/MacOS/Ardour",
    ] {
        let p = PathBuf::from(candidate);
        if !p.exists() {
            continue;
        }
        if let Some(target) = target_mm {
            match probe_ardour_major_minor(&p) {
                Some(installed) if installed != target => continue,
                _ => {}
            }
        }
        return Some(p);
    }
    // 3. Sibling dev-box Ardour build tree. `$FOYER_ARDOUR_BUILD_ROOT`
    // overrides the default `/workspaces/ardour` path so CI / non-Codespaces
    // dev environments can point at a different checkout.
    let build_root = std::env::var("FOYER_ARDOUR_BUILD_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/workspaces/ardour"));
    if let Some(p) = scan_ardour_build_tree(&build_root) {
        return Some(p);
    }
    // 3b. In-repo convention (repo/ext/ardour) — used by this project's
    //     `just run` and `just run-jack` recipes.
    let in_repo = std::env::var("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .map(|p| {
            p.parent()
                .unwrap_or(&p)
                .parent()
                .unwrap_or(&p)
                .join("ext/ardour")
        })
        .unwrap_or_else(|_| PathBuf::from("./ext/ardour"));
    if let Some(p) = scan_ardour_build_tree(&in_repo) {
        return Some(p);
    }
    None
}

/// Scan an Ardour source checkout for a built binary. Always picks
/// the GUI tree (`<root>/build/gtk2_ardour/`) — Foyer depends on X11
/// for plugin / instrument GUI projection (xpra in the container,
/// host X on dev / studio machines), so the headless `hardour` binary
/// at `<root>/build/headless/` is intentionally NOT considered. A
/// container with no DISPLAY should still run GUI Ardour against an
/// in-container Xvfb (which `seed-ardour-config.sh` + the entrypoint
/// already arrange); falling back to headless silently would just
/// mask a misconfigured X surface and leave the operator wondering
/// why plugin windows never paint.
///
/// Picks `ardour-<version>` (the real ELF) over `ardour{N}` (the
/// install wrapper) — the wrapper's `exec` target
/// `/usr/local/lib/ardour.../...` doesn't exist on dev boxes.
pub fn scan_ardour_build_tree(root: &Path) -> Option<PathBuf> {
    scan_build_dir(&root.join("build/gtk2_ardour"), "ardour")
}

fn scan_build_dir(dir: &Path, prefix: &str) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    let mut short = None;
    let mut versioned = None;
    let short_max_len = prefix.len() + 2; // "ardour" + up to two digits
    let Ok(rd) = std::fs::read_dir(dir) else {
        return None;
    };
    for entry in rd.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let path = entry.path();
        if !is_executable(&path) {
            continue;
        }
        // Versioned binary — e.g. "ardour-9.2.583" or "hardour-9.2.583".
        let dash = format!("{prefix}-");
        if name.starts_with(&dash) && versioned.is_none() {
            versioned = Some(path);
            continue;
        }
        // Install wrapper — e.g. "ardour9" or "hardour9".
        if name.starts_with(prefix)
            && name.len() <= short_max_len
            && name
                .as_bytes()
                .iter()
                .skip(prefix.len())
                .all(u8::is_ascii_digit)
            && short.is_none()
        {
            short = Some(path);
        }
    }
    versioned.or(short)
}

/// If `exec` is an Ardour binary inside a source checkout's
/// `build/gtk2_ardour/` or `build/headless/` dir, return the checkout
/// root (the dir containing `build/`). Used by the spawner to source
/// `ardev_common_waf.sh` before exec so the lib paths resolve.
pub fn ardour_dev_root(exec: &Path) -> Option<PathBuf> {
    let dir = exec.parent()?;
    let dir_name = dir.file_name()?.to_str()?;
    if dir_name != "gtk2_ardour" && dir_name != "headless" {
        return None;
    }
    let build = dir.parent()?;
    if !build.ends_with("build") {
        return None;
    }
    let root = build.parent()?;
    if root.join("build/gtk2_ardour/ardev_common_waf.sh").is_file() {
        Some(root.to_path_buf())
    } else {
        None
    }
}

fn is_executable(p: &Path) -> bool {
    if !p.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    true
}

/// Parse a `major.minor`-shaped string into a `(u32, u32)` tuple.
/// Accepts trailing tokens (`"9.5.0"`, `"9.5-pre1"`, `"9.5"` all
/// resolve to `(9, 5)`) so it copes with whatever shape `--version`
/// happens to print across Ardour minor releases.
fn parse_major_minor(s: &str) -> Option<(u32, u32)> {
    // Find a version-shaped token if the input is a sentence (e.g.
    // `ardour9 9.5.0`); otherwise treat the whole string as the token.
    let token = s
        .split_whitespace()
        .find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()) && t.contains('.'))
        .unwrap_or(s);
    let mut parts = token.split(['.', '-', '+', '~']);
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// Run `<bin> --version` and extract the major.minor of the
/// installed Ardour. Used by [`detect_ardour_executable_for`] to
/// reject a $PATH candidate that disagrees with the shim's compile
/// target. Returns `None` if the probe failed (binary refused
/// `--version`, output unparseable) — the caller defaults to
/// accepting the candidate in that case, since "we couldn't tell"
/// is a softer signal than "definitely wrong".
fn probe_ardour_major_minor(bin: &Path) -> Option<(u32, u32)> {
    let out = std::process::Command::new(bin)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    parse_major_minor(&stdout)
}

/// Minimal `which`: walk $PATH, return the first hit. We don't pull in
/// the `which` crate because this is one call at startup and we'd
/// rather keep the dep graph small.
fn which_on_path(binary: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            // Best-effort exec check — on non-unix we accept any file.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&candidate) {
                    if meta.permissions().mode() & 0o111 != 0 {
                        return Some(candidate);
                    }
                    continue;
                }
            }
            #[cfg(not(unix))]
            return Some(candidate);
        }
    }
    None
}

impl Config {
    /// Look up a backend by id. Disabled backends are still returned —
    /// callers decide whether to honor `enabled`.
    pub fn backend(&self, id: &str) -> Option<&BackendConfig> {
        self.backends.iter().find(|b| b.id == id)
    }

    /// Return the backend named by `default_backend`, or fall back to
    /// the first enabled entry, or the first entry.
    pub fn default_backend(&self) -> Option<&BackendConfig> {
        self.backend(&self.default_backend)
            .or_else(|| self.backends.iter().find(|b| b.enabled))
            .or_else(|| self.backends.first())
    }

    /// Record a project path in the launcher's recent list. MRU order,
    /// capped at 20. Call [`save`] to persist.
    pub fn record_recent(&mut self, path: PathBuf) {
        self.launcher.recent.retain(|p| p != &path);
        self.launcher.recent.insert(0, path);
        self.launcher.recent.truncate(20);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn parse_major_minor_accepts_common_shapes() {
        assert_eq!(parse_major_minor("9.5"), Some((9, 5)));
        assert_eq!(parse_major_minor("9.5.0"), Some((9, 5)));
        assert_eq!(parse_major_minor("9.5-pre1"), Some((9, 5)));
        assert_eq!(parse_major_minor("ardour9 9.5.0"), Some((9, 5)));
        assert_eq!(parse_major_minor("Ardour 9.2"), Some((9, 2)));
        // Debian-epoch form `1:9.2.0+ds-1` deliberately not supported
        // — we only feed this parser `--version` stdout, not dpkg
        // output (shim_install.rs has its own check_version_compat
        // for that surface).
        assert_eq!(parse_major_minor("not-a-version"), None);
        assert_eq!(parse_major_minor("9"), None);
    }

    #[test]
    fn seed_roundtrip_parses() {
        let cfg = seed_default();
        let yaml = serde_yaml::to_string(&cfg).unwrap();
        let back: Config = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(back.default_backend, "ardour");
        assert!(back.backend("stub").is_some());
        assert!(back.backend("ardour").is_some());
    }

    #[test]
    fn load_or_seed_creates_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.yaml");
        assert!(!path.exists());
        let cfg = load_or_seed_at(&path).unwrap();
        assert!(path.exists());
        assert_eq!(cfg.default_backend, "ardour");
        // Second call should re-read, not re-seed.
        let again = load_or_seed_at(&path).unwrap();
        assert_eq!(again.default_backend, cfg.default_backend);
    }

    #[test]
    fn default_backend_fallback() {
        let mut cfg = seed_default();
        cfg.default_backend = "nope".into();
        // Falls through to the first enabled entry (stub, which is listed first).
        assert_eq!(cfg.default_backend().map(|b| b.id.as_str()), Some("stub"));
    }
}
