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
    #[serde(default)]
    pub backends: Vec<BackendConfig>,
}

fn default_version() -> u32 { CONFIG_SCHEMA_VERSION }
fn default_backend_id() -> String { "ardour".to_string() }

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
}

fn yes() -> bool { true }

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
        let raw = fs::read_to_string(path)
            .with_context(|| format!("read {}", path.display()))?;
        let cfg: Config = serde_yaml::from_str(&raw)
            .with_context(|| format!("parse {}", path.display()))?;
        return Ok(cfg);
    }
    let cfg = seed_default();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create {}", parent.display()))?;
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
    }];
    backends.push(BackendConfig {
        id: "ardour".into(),
        kind: BackendKind::Ardour,
        enabled: true,
        label: Some("Ardour".into()),
        executable: detect_ardour_executable(),
        args: Vec::new(),
        env: Default::default(),
    });
    Config {
        version: CONFIG_SCHEMA_VERSION,
        // Default to Ardour — Foyer Studio is an Ardour control surface
        // first and foremost. The stub exists for UI development and is
        // selected explicitly via `--backend stub` (or `just run-stub`).
        default_backend: "ardour".into(),
        launcher: LauncherConfig {
            // Seed the picker jail at the user's audio/Music dir so the
            // session picker "just works" on first launch. Users who want
            // to browse more broadly can edit this to `/` or another root.
            jail: default_launcher_jail(),
            recent: Vec::new(),
        },
        backends,
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
pub fn detect_ardour_executable() -> Option<PathBuf> {
    // 1. $PATH — preferred when Ardour is system-installed.
    for name in ["ardour9", "ardour8", "ardour7", "ardour6", "ardour"] {
        if let Some(p) = which_on_path(name) {
            return Some(p);
        }
    }
    // 2. macOS app bundles.
    for candidate in [
        "/Applications/Ardour9.app/Contents/MacOS/Ardour9",
        "/Applications/Ardour8.app/Contents/MacOS/Ardour8",
        "/Applications/Ardour7.app/Contents/MacOS/Ardour7",
        "/Applications/Ardour.app/Contents/MacOS/Ardour",
    ] {
        let p = PathBuf::from(candidate);
        if p.exists() {
            return Some(p);
        }
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
    None
}

/// Scan an Ardour source checkout for a built binary. Checks both the
/// GUI tree (`<root>/build/gtk2_ardour/`) and the headless tree
/// (`<root>/build/headless/`), preferring headless when `$DISPLAY` is
/// unset (typical for devcontainers / CI — the GUI binary fails at
/// startup with "cannot open display"). An explicit preference can be
/// forced via `$FOYER_ARDOUR_PREFER_HEADLESS=1`.
///
/// In each dir, picks `ardour-<version>` / `hardour-<version>` (the real
/// ELF) over `ardour{N}` (the install wrapper) — the wrapper's `exec`
/// target `/usr/local/lib/ardour.../...` doesn't exist on dev boxes.
pub fn scan_ardour_build_tree(root: &Path) -> Option<PathBuf> {
    let prefer_headless = headless_preferred();
    let gui = scan_build_dir(&root.join("build/gtk2_ardour"), "ardour");
    let headless = scan_build_dir(&root.join("build/headless"), "hardour");

    if prefer_headless {
        headless.or(gui)
    } else {
        gui.or(headless)
    }
}

/// True when we should prefer the headless Ardour binary over the GUI
/// one. Driven by `$DISPLAY` (empty = no X available) with an override
/// via `$FOYER_ARDOUR_PREFER_HEADLESS` (`1`/`true` force-on, `0`/`false`
/// force-off).
fn headless_preferred() -> bool {
    if let Ok(force) = std::env::var("FOYER_ARDOUR_PREFER_HEADLESS") {
        let v = force.to_ascii_lowercase();
        if matches!(v.as_str(), "1" | "true" | "yes" | "on") {
            return true;
        }
        if matches!(v.as_str(), "0" | "false" | "no" | "off") {
            return false;
        }
    }
    std::env::var("DISPLAY")
        .map(|d| d.is_empty())
        .unwrap_or(true)
}

fn scan_build_dir(dir: &Path, prefix: &str) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    let mut short = None;
    let mut versioned = None;
    let short_max_len = prefix.len() + 2; // "ardour" + up to two digits
    let Ok(rd) = std::fs::read_dir(dir) else { return None; };
    for entry in rd.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue; };
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
            && name.as_bytes().iter().skip(prefix.len()).all(u8::is_ascii_digit)
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
