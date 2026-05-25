// Per-backend launch runtimes.
//
// A `Runtime` owns everything backend-specific that needs to happen
// between "user picked a project" and "we have a working IPC socket
// to the DAW":
//
//   * Bootstrap session files (Ardour writes a fresh project XML on
//     first open; another DAW might create a *.proj/ dir, or import
//     a template, …).
//   * Reconcile host configs (Ardour pins an audio backend in
//     `~/.config/ardour9/config`; if that name has no corresponding
//     `.so` in the resolved tree's `libs/backends/`, autostart fails
//     with "Cannot create Audio/MIDI engine" and the AMS dialog hangs.
//     Other DAWs have their own equivalent — Reaper's `ReaperConfig`,
//     Bitwig's `audio-engine.json`, etc.).
//   * Set up the spawn environment (LD_LIBRARY_PATH overrides,
//     surface-search paths, headless-display tweaks).
//   * Wait for the shim to advertise an IPC channel.
//
// The stub backend doesn't go through this trait at all — it's an
// in-process fake constructed directly by `CliSpawner::launch`. Only
// runtimes that fork an external DAW child need a Runtime impl.
//
// Adding a new DAW: write a module under `runtime/` that implements
// `Runtime`, then map your `BackendKind` variant to it in `for_kind`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::Result;
use foyer_config::BackendKind;

pub mod ardour;

/// Inputs handed to `Runtime::launch`. Everything the runtime needs to
/// know to spawn the DAW for a given project. Owned outside the trait
/// so `serve.rs` can build it once and pass by reference.
pub struct LaunchCtx<'a> {
    /// Resolved executable path (the install wrapper has already been
    /// redirected to the versioned ELF where applicable; runtimes that
    /// want a different resolution rule can override).
    pub exec: &'a Path,
    /// Additional argv to forward (`backends[].args` from config.yaml).
    pub extra_args: &'a [String],
    /// Env overrides (`backends[].env` from config.yaml). Applied on
    /// top of whatever the runtime sets up itself.
    pub env: &'a BTreeMap<String, String>,
    /// Absolute project path the user picked. The runtime is free to
    /// interpret this — Ardour splits it into `DIR SNAPSHOT_NAME`;
    /// another DAW might just exec it as a single argv.
    pub project: &'a Path,
    /// Optional sample-rate hint. When `Some`, runtimes that own a
    /// per-session config file may stamp it during bootstrap; ignored
    /// when the session already exists.
    pub sample_rate_hint: Option<u32>,
    /// Crash-recovery preference for the shim's dialog auto-dispatcher.
    /// `Some(true)` = recover, `Some(false)` = discard, `None` = leave
    /// the dialog to the user.
    pub recover_crash: Option<bool>,
}

/// What `Runtime::launch` returns to the caller — same shape regardless
/// of runtime so `CliSpawner::launch` can stay generic.
pub struct ShimLaunch {
    /// The IPC socket path the shim is advertising on.
    pub socket: PathBuf,
    /// Child process handle. Held by `ChildProcess` in the spawner so
    /// session-close can drive SIGTERM → SIGKILL escalation.
    pub child: tokio::process::Child,
    /// MCPHttp port we pinned for this session, if the runtime
    /// negotiated one. Used by `daw_proxy` to discover per-session
    /// MCP endpoints. `None` on runtimes (or older builds) that don't
    /// surface an MCP layer.
    pub mcp_port: Option<u16>,
}

/// External-process backend abstraction.
#[async_trait::async_trait]
pub trait Runtime: Send + Sync {
    /// Spawn the DAW, do whatever pre-flight is needed, and resolve
    /// once the shim is reachable.
    async fn launch(&self, ctx: LaunchCtx<'_>) -> Result<ShimLaunch>;
}

/// Pick the runtime for a given backend kind. Returns `None` for kinds
/// that don't go through this trait (today: `Stub`, which is built in
/// process).
pub fn for_kind(kind: BackendKind) -> Option<Box<dyn Runtime>> {
    match kind {
        BackendKind::Ardour => Some(Box::new(ardour::ArdourRuntime::new())),
        BackendKind::Stub => None,
    }
}
