// Ardour-specific launch runtime.
//
// Lifts the pre-flight + spawn-and-wait dance for Ardour out of the
// generic CLI plumbing so the in-process stub backend (and any future
// DAW) doesn't run any of this. The Stub goes straight to
// `StubBackend::new()` in the spawner; Reaper / Bitwig / etc. would
// each grow their own `runtime::*` module mirroring this file.
//
// What lives here:
//   * Bootstrapping the Ardour session XML if the project is new
//     (`bootstrap_session_if_missing`).
//   * Pinning `<Protocol name="Foyer Studio Shim" active="1"/>` and
//     the per-session MCPHttp port (`preflight_session`).
//   * Rewriting `~/.config/ardour9/config`'s EngineStates block so
//     the autostart backend matches a `lib*_audiobackend.so` that
//     actually exists in the resolved tree (`ensure_user_config_backend_available`).
//   * Sourcing `ardev_common_waf.sh` for in-tree dev builds.
//   * The `tokio::process::Command` setup (ARDOUR_SURFACES_PATH,
//     ARDOUR_BACKEND, macOS bundle envs, daw.log redirection) and
//     the poll loop that waits for the shim to advertise.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use foyer_backend_host::discovery;

use crate::ardour_xml::{
    ardour_had_existing_session, ensure_foyer_shim_active, patch_ardour_session_sample_rate,
};
use crate::mcp_probe::{alloc_free_mcp_port, read_mcp_port_from_session_file};

use super::{LaunchCtx, Runtime, ShimLaunch};

/// Default implementation of the `Runtime` trait for Ardour. Stateless
/// — every call recomputes from the inputs so multiple sessions in a
/// single Foyer process don't share mutable state.
pub struct ArdourRuntime;

impl ArdourRuntime {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ArdourRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl Runtime for ArdourRuntime {
    async fn launch(&self, ctx: LaunchCtx<'_>) -> Result<ShimLaunch> {
        launch_and_wait_for_shim(ctx).await
    }
}

/// Result of [`launch_and_wait_for_shim`] — the shim socket + child
/// handle (as before), plus the MCPHttp port we pinned this session
/// to (when one was successfully claimed) so callers can probe it
/// and stash the resulting endpoint on the session registry entry.
async fn launch_and_wait_for_shim(ctx: LaunchCtx<'_>) -> Result<ShimLaunch> {
    let LaunchCtx {
        exec,
        extra_args,
        env,
        project,
        sample_rate_hint,
        recover_crash,
    } = ctx;

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
        if let Ok(stream) = std::os::unix::net::UnixStream::connect(&ad.socket) {
            drop(stream);
            tracing::info!(
                "reusing live shim at {} for already-open project {}",
                ad.socket.display(),
                project.display(),
            );
            // Synthesize an already-dead child handle so the caller's
            // existing teardown path (which expects a `Child`) works
            // without conditional logic. The Ardour we're reusing is
            // owned by whoever spawned it first; closing the new
            // session doesn't kill it.
            let dummy = tokio::process::Command::new("/bin/true")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()?;
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

    let before: HashSet<PathBuf> = discovery::scan().into_iter().map(|s| s.socket).collect();

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
    let (session_dir, snapshot_name) = resolve_ardour_session_args(project);
    let had_session = ardour_had_existing_session(&session_dir, &snapshot_name);
    tracing::info!(
        "resolved project {} → DIR={} NAME={}",
        project.display(),
        session_dir.display(),
        snapshot_name,
    );

    // Dev tree discovery: `FOYER_ARDOUR_DEV_TREE` (env, set by the
    // relevant `just` recipe) takes precedence; otherwise we infer
    // from `resolved_exec` sitting inside `<tree>/build/gtk2_ardour/`.
    let dev_root = std::env::var_os("FOYER_ARDOUR_DEV_TREE")
        .map(PathBuf::from)
        .filter(|p| p.join("build/gtk2_ardour/ardev_common_waf.sh").is_file())
        .or_else(|| foyer_config::ardour_dev_root(&resolved_exec));

    let (session_dir, snapshot_name) =
        preflight_session(&resolved_exec, &session_dir, &snapshot_name, mcp_port);
    // Ardour autostart-engine reads the user-config's EngineStates
    // block to pick a backend. The container's entrypoint pins
    // "Foyer Dummy" there, but a dev-build checkout doesn't
    // necessarily have `libfoyer_audiobackend.so` compiled — Ardour
    // then fails with "Cannot create Audio/MIDI engine" and we
    // hang on the AMS dialog forever. Sweep the config so it only
    // references backends that exist in the resolved Ardour's
    // `libs/backends/`, falling back to "None (Dummy)" (universal).
    if let Err(e) = ensure_user_config_backend_available(&resolved_exec) {
        tracing::warn!("foyer: backend availability sweep failed: {e:#}");
    }
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
        for (k, v) in load_ardour_dev_env(root) {
            cmd.env(k, v);
        }
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
        if std::env::var_os("ARDOUR_BACKEND").is_none() {
            cmd.env("ARDOUR_BACKEND", "None (Dummy)");
        }
        // Suppress Ardour's "this screen is not tall enough" dialog
        // for short virtual screens.
        cmd.env("ARDOUR_LOVES_STUPID_TINY_SCREENS", "1");
    }
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
    for (k, v) in env {
        cmd.env(k, v);
    }
    let _ = dev_root.as_ref();
    if let Some(recover) = recover_crash {
        let v = if recover { "recover" } else { "discard" };
        cmd.env("FOYER_CRASH_RECOVERY", v);
        tracing::info!("Ardour spawn: FOYER_CRASH_RECOVERY={v}");
    }

    // Redirect the child's stdout+stderr to a per-launch log file so
    // Ardour's chatter (missing plugin warnings, backend init messages,
    // etc.) doesn't scroll foyer's own log off the screen.
    let log_path = crate::daw_log_path()?;
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

    // 90 s default covers slow Codespaces cold-starts; env override
    // for fast hosts.
    let timeout_secs: u64 = std::env::var("FOYER_SHIM_SPAWN_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(90);
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
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
                crate::daw_log_path()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|_| "the foyer state dir".into()),
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Return the enclosing `.app` bundle for a Mach-O exec path, if any.
fn macos_app_bundle(exec: &Path) -> Option<PathBuf> {
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

/// Normalize a picked project path into Ardour's expected
/// `DIR SNAPSHOT_NAME` argv pair.
fn resolve_ardour_session_args(project: &Path) -> (PathBuf, String) {
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
        let name = project
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("session")
            .to_string();
        return (project.to_path_buf(), name);
    }

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

/// If `exec` is a short-name install wrapper (e.g. `.../ardour9`) and
/// the sibling dir contains the real versioned binary, return the
/// versioned path.
fn redirect_short_wrapper(exec: &Path) -> Option<PathBuf> {
    let dir = exec.parent()?;
    let stem = exec.file_name()?.to_str()?;
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

/// Minimal single-quote escape for bash. Wraps the value in `'…'` and
/// escapes any embedded single quotes by closing/escaping/reopening.
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

/// Pre-flight the Ardour session file. Bootstraps if missing, ensures
/// the Foyer shim is `active="1"`, and pins the MCPHttp port.
fn preflight_session(
    resolved_exec: &Path,
    session_dir: &Path,
    snapshot_name: &str,
    mcp_port: Option<u16>,
) -> (PathBuf, String) {
    let (dir, name) = bootstrap_session_if_missing(resolved_exec, session_dir, snapshot_name);
    let session_file = dir.join(format!("{name}.ardour"));
    if let Ok(m) = std::fs::symlink_metadata(&session_file) {
        if m.file_type().is_file() {
            if let Err(e) = ensure_foyer_shim_active(&session_file) {
                tracing::warn!(
                    "foyer: failed to update Foyer Studio Shim entry in {}: {e:#}",
                    session_file.display(),
                );
            }
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
    (dir, name)
}

/// If the session file is missing, invoke `ardour*-new_empty_session`
/// to create it under `<session_dir>/<snapshot_name>/`. Returns the
/// (possibly redirected) `(dir, name)` to pass to Ardour as argv.
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
    // Scoped env tweaks for the helper child only:
    //
    //   * FOYER_SHIM_NO_IPC=1 — without it the helper loads the foyer
    //     surface .so and runs full IPC bring-up (advert + listener),
    //     exits ~2 s later, and the parent foyer-cli can race-claim
    //     the dead socket.
    //   * DISPLAY="" — block any GTK dialog from opening on engine-
    //     init failure. The helper has historically hung in
    //     `futex_wait_queue` after printing "Cannot create Audio/MIDI
    //     engine" because it pops an interactive AMS dialog through
    //     xpra and nothing is there to dismiss it.
    //   * `available_audio_backend_names` decides whether stripping
    //     ARDOUR_BACKEND_PATH is safe. The strip was added to dodge
    //     a static-destructor double-free that fires when both
    //     `libdummy_audiobackend.so` and `libfoyer_audiobackend.so`
    //     define `DummyAudioBackend` symbols and tear down in the
    //     same dlclose batch. Dev-tree checkouts that don't compile
    //     `libfoyer_audiobackend.so` (i.e. the conflict can't happen)
    //     need the path KEPT so the helper can find the stock dummy
    //     backend — otherwise "Cannot create Audio/MIDI engine"
    //     fires and the helper hangs.
    let available = available_audio_backend_names(resolved_exec);
    let foyer_backend_present = available.iter().any(|n| n == "Foyer Dummy");
    let mut helper_cmd = std::process::Command::new(&helper);
    helper_cmd
        .env("FOYER_SHIM_NO_IPC", "1")
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY");
    if foyer_backend_present {
        helper_cmd.env_remove("ARDOUR_BACKEND_PATH");
    }
    if let Some(root) = foyer_config::ardour_dev_root(resolved_exec) {
        for (k, v) in load_ardour_dev_env(&root) {
            // Skip ARDOUR_BACKEND_PATH when stripping was requested
            // above; otherwise apply the dev-env value so the helper
            // can dlopen `libdummy_audiobackend.so`.
            if k == "ARDOUR_BACKEND_PATH" && foyer_backend_present {
                continue;
            }
            helper_cmd.env(k, v);
        }
    }
    // Hard-cap the helper at 30 s. Past failures hung in futex_wait
    // (engine init blocking on a worker thread). The new env tweaks
    // above should prevent that, but a stuck helper holds up the
    // entire launch flow and is worth aborting cleanly.
    helper_cmd.stdin(std::process::Stdio::null());
    let helper_label = helper.display().to_string();
    let mut child = match helper_cmd.arg(&leaf_dir).arg(snapshot_name).spawn() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("foyer: failed to spawn {}: {e}", helper_label);
            // Fall through to file-exists check below.
            return finalize_bootstrap(session_dir, snapshot_name, &leaf_dir);
        }
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        match child.try_wait() {
            Ok(Some(s)) => {
                if !s.success() {
                    tracing::warn!(
                        "foyer: {} exited with status {} — letting Ardour show its own dialog",
                        helper_label,
                        s,
                    );
                }
                break;
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    tracing::warn!(
                        "foyer: {} hung past 30 s — killing helper. Session bootstrap may be incomplete.",
                        helper_label
                    );
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => {
                tracing::warn!("foyer: try_wait on {} failed: {e}", helper_label);
                break;
            }
        }
    }
    finalize_bootstrap(session_dir, snapshot_name, &leaf_dir)
}

/// File-exists check after the helper has either exited or timed out.
/// Returns the leaf-dir / snapshot pair if the helper actually wrote
/// `<leaf>/<name>.ardour`, otherwise the original (parent, name) so
/// Ardour itself can fall back to showing the session dialog.
fn finalize_bootstrap(
    session_dir: &Path,
    snapshot_name: &str,
    leaf_dir: &Path,
) -> (PathBuf, String) {
    let leaf_session = leaf_dir.join(format!("{snapshot_name}.ardour"));
    if leaf_session.is_file() {
        (leaf_dir.to_path_buf(), snapshot_name.to_string())
    } else {
        (session_dir.to_path_buf(), snapshot_name.to_string())
    }
}

/// Scan the resolved Ardour for the audio backends it actually ships,
/// then rewrite `~/.config/ardour9/config`'s `<EngineStates>` so every
/// pinned backend name maps to a real .so on disk.
fn ensure_user_config_backend_available(resolved_exec: &Path) -> Result<()> {
    let available = available_audio_backend_names(resolved_exec);
    if available.is_empty() {
        return Ok(());
    }
    let cfg_dir = match dirs::config_dir() {
        Some(d) => d.join("ardour9"),
        None => return Ok(()),
    };
    let cfg_path = cfg_dir.join("config");
    if !cfg_path.is_file() {
        return Ok(());
    }
    let body = std::fs::read_to_string(&cfg_path)
        .with_context(|| format!("read {}", cfg_path.display()))?;
    let fallback = if available.iter().any(|n| n == "Foyer Dummy") {
        "Foyer Dummy"
    } else if available.iter().any(|n| n == "None (Dummy)") {
        "None (Dummy)"
    } else {
        available
            .first()
            .map(String::as_str)
            .unwrap_or("None (Dummy)")
    };
    let mut changed = false;
    let rewritten = rewrite_engine_state_backends(&body, &available, fallback, &mut changed);
    if !changed {
        return Ok(());
    }
    let tmp_path = cfg_path.with_extension("foyer-tmp");
    std::fs::write(&tmp_path, &rewritten)
        .with_context(|| format!("write {}", tmp_path.display()))?;
    std::fs::rename(&tmp_path, &cfg_path)
        .with_context(|| format!("rename {} -> {}", tmp_path.display(), cfg_path.display()))?;
    tracing::info!(
        "foyer: rewrote unavailable backend entries in {} to {:?}",
        cfg_path.display(),
        fallback,
    );
    Ok(())
}

fn available_audio_backend_names(resolved_exec: &Path) -> Vec<String> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(dev) = foyer_config::ardour_dev_root(resolved_exec) {
        roots.push(dev.join("build/libs/backends"));
    }
    if let Ok(env_path) = std::env::var("ARDOUR_BACKEND_PATH") {
        for p in std::env::split_paths(&env_path) {
            roots.push(p);
        }
    }
    if let Some(parent) = resolved_exec.parent() {
        roots.push(parent.join("../lib/ardour9/backends"));
    }
    let mut names: Vec<String> = Vec::new();
    for root in roots {
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in rd.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let Some(fname) = path.file_name().and_then(|s| s.to_str()) else {
                    continue;
                };
                if !fname.ends_with("_audiobackend.so") {
                    continue;
                }
                let stem = fname
                    .strip_prefix("lib")
                    .and_then(|s| s.strip_suffix("_audiobackend.so"))
                    .unwrap_or("");
                if let Some(display) = backend_kind_to_display_name(stem) {
                    if !names.iter().any(|n| n == display) {
                        names.push(display.to_string());
                    }
                }
            }
        }
    }
    names
}

fn backend_kind_to_display_name(kind: &str) -> Option<&'static str> {
    match kind {
        "dummy" => Some("None (Dummy)"),
        "foyer" => Some("Foyer Dummy"),
        "jack" => Some("JACK"),
        "alsa" => Some("ALSA"),
        "pulse" => Some("PulseAudio"),
        "coreaudio" => Some("CoreAudio"),
        "portaudio" => Some("PortAudio"),
        _ => None,
    }
}

fn rewrite_engine_state_backends(
    body: &str,
    available: &[String],
    fallback: &str,
    changed: &mut bool,
) -> String {
    let needle = "backend=\"";
    let mut out = String::with_capacity(body.len());
    let mut cursor = 0;
    while let Some(rel) = body[cursor..].find(needle) {
        let start = cursor + rel + needle.len();
        let Some(end_rel) = body[start..].find('"') else {
            break;
        };
        let end = start + end_rel;
        let current = &body[start..end];
        out.push_str(&body[cursor..start]);
        if available.iter().any(|n| n == current) {
            out.push_str(current);
        } else {
            out.push_str(fallback);
            *changed = true;
        }
        out.push_str(&body[end..end + 1]);
        cursor = end + 1;
    }
    out.push_str(&body[cursor..]);
    out
}

/// Look for `ardour*-new_empty_session` next to the resolved Ardour
/// exec, or in the dev tree's `build/session_utils/`.
fn find_new_empty_session_helper(resolved_exec: &Path) -> Option<PathBuf> {
    if let Some(dir) = resolved_exec.parent() {
        if let Some(hit) = scan_for_helper(dir) {
            return Some(hit);
        }
    }
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
/// env vars it defines as a `(name, value)` list.
fn load_ardour_dev_env(root: &Path) -> Vec<(String, String)> {
    let waf = root.join("build/gtk2_ardour/ardev_common_waf.sh");
    if !waf.is_file() {
        return Vec::new();
    }
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
